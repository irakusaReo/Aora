import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Database, type Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { RateLimiter } from '../../platform/rate-limit.js';
import { AuditService } from '../audit/audit.service.js';
import { BASE_SEPOLIA } from '../chain/config.js';
import { type TransferView, UsdcService } from './usdc.service.js';

const USDC = BASE_SEPOLIA.usdc.assetCode;

export type PaymentRequestStatus = 'open' | 'paid' | 'cancelled' | 'expired';

/** A request is paid at most once and never reopens (P7-12). */
export const PAYMENT_REQUEST_TRANSITIONS: Readonly<
  Record<PaymentRequestStatus, readonly PaymentRequestStatus[]>
> = {
  open: ['paid', 'cancelled', 'expired'],
  paid: [],
  cancelled: [],
  expired: [],
};

export interface PaymentRequestView {
  readonly id: string;
  /** The viewer's part in it: who asked, the named payer, or anyone holding an open link. */
  readonly role: 'requester' | 'payer' | 'link';
  readonly status: PaymentRequestStatus;
  readonly amount_minor: string;
  readonly currency: string;
  readonly note: string | null;
  readonly requester: { readonly display_name: string };
  readonly payer: { readonly display_name: string } | null;
  readonly expires_at: string;
  readonly paid_transfer_id: string | null;
  readonly created_at: string;
}

type Row = {
  id: string;
  requester_account_id: string;
  payer_account_id: string | null;
  amount: bigint;
  asset_code: string;
  note: string | null;
  status: string;
  expires_at: Date;
  paid_transfer_id: string | null;
  created_at: Date;
};

@Injectable()
export class RequestsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RateLimiter) private readonly rateLimiter: RateLimiter,
    @Inject(UsdcService) private readonly usdc: UsdcService,
  ) {}

  async create(
    actor: { accountId: string; requestId: string },
    input: { amount: bigint; note: string | null; payerPhone: string | null },
  ): Promise<PaymentRequestView> {
    if (input.payerPhone) await this.rateLimiter.consume('chiwo_recipient_lookup', actor.accountId);
    return this.db.asPlatform(async (tx) => {
      let payer: string | null = null;
      if (input.payerPhone) {
        const account = await tx.user_account.findFirst({
          where: { phone_e164: input.payerPhone, status: 'active' },
          select: { id: true },
        });
        if (account?.id === actor.accountId) {
          throw new AppError('invalid_request', 'You cannot ask yourself for money.');
        }
        const consumer = account
          ? await tx.consumer.findUnique({ where: { account_id: account.id } })
          : null;
        if (!account || consumer?.status !== 'active') {
          throw new AppError('not_found', 'No CHIWO account has that number.');
        }
        payer = account.id;
      }
      const policy = await tx.request_policy.findFirst({
        where: { effective_from: { lte: new Date() } },
        orderBy: { effective_from: 'desc' },
      });
      if (!policy) throw new AppError('capability_not_supported', 'Requests are not available.');
      const row = await tx.payment_request.create({
        data: {
          requester_account_id: actor.accountId,
          payer_account_id: payer,
          amount: input.amount,
          asset_code: USDC,
          note: input.note,
          expires_at: new Date(Date.now() + policy.ttl_hours * 3_600_000),
        },
      });
      await this.audit.record(tx, {
        tenantId: null,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'chiwo.request.created',
        subjectType: 'chiwo_payment_request',
        subjectId: row.id,
        outcome: 'success',
        requestId: actor.requestId,
      });
      return this.view(tx, actor.accountId, row);
    });
  }

  async list(accountId: string): Promise<PaymentRequestView[]> {
    const rows = await this.db.withConsumer(accountId, (tx) =>
      tx.payment_request.findMany({
        where: { OR: [{ requester_account_id: accountId }, { payer_account_id: accountId }] },
        orderBy: { created_at: 'desc' },
        take: 100,
      }),
    );
    return this.db.asPlatform((tx) =>
      Promise.all(rows.map((row) => this.view(tx, accountId, row))),
    );
  }

  /** The requester, the named payer, or anyone if the request names no payer (a link). */
  async get(accountId: string, id: string): Promise<PaymentRequestView> {
    return this.db.asPlatform(async (tx) =>
      this.view(tx, accountId, await this.visible(tx, accountId, id)),
    );
  }

  async cancel(
    actor: { accountId: string; requestId: string },
    id: string,
  ): Promise<PaymentRequestView> {
    const outcome = await this.db.asPlatform(async (tx) => {
      const row = await this.lock(tx, id);
      if (!row || row.requester_account_id !== actor.accountId) {
        throw new AppError('not_found', 'Request not found.');
      }
      const closed = await this.closeIfExpired(tx, row);
      if (closed) return closed;
      if (row.status !== 'open') {
        throw new AppError('invalid_state_transition', `This request is ${row.status}.`);
      }
      const updated = await tx.payment_request.update({
        where: { id },
        data: { status: 'cancelled' },
      });
      await this.audit.record(tx, {
        tenantId: null,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'chiwo.request.cancelled',
        subjectType: 'chiwo_payment_request',
        subjectId: id,
        outcome: 'success',
        requestId: actor.requestId,
      });
      return updated;
    });
    if (outcome.status === 'expired') {
      throw new AppError('invalid_state_transition', 'This request has expired.');
    }
    return this.get(actor.accountId, id);
  }

  /**
   * Pays a request with a transfer. The request row is locked and must be open,
   * and a transfer can name a request only once, so it can never be paid twice
   * (P7-12). A repeat of the same request with the same key replays.
   */
  async pay(
    actor: { accountId: string; requestId: string },
    id: string,
    idempotencyKey: string,
  ): Promise<{ request: PaymentRequestView; transfer: TransferView; replayed: boolean }> {
    const requestHash = createHash('sha256')
      .update(JSON.stringify(['request', id]))
      .digest('hex');
    const outcome = await this.db.asPlatform(async (tx) => {
      await this.usdc.lockConsumer(tx, actor.accountId);
      const replay = await this.usdc.replay(tx, actor.accountId, idempotencyKey, requestHash);
      if (replay) return { replay };
      const row = await this.lock(tx, id);
      if (
        !row ||
        (row.payer_account_id !== null &&
          row.payer_account_id !== actor.accountId &&
          row.requester_account_id !== actor.accountId)
      ) {
        throw new AppError('not_found', 'Request not found.');
      }
      if (row.requester_account_id === actor.accountId) {
        throw new AppError('invalid_request', 'You cannot pay your own request.');
      }
      const closed = await this.closeIfExpired(tx, row);
      if (closed) return { expired: true as const };
      if (row.status !== 'open') {
        throw new AppError('invalid_state_transition', `This request is ${row.status}.`);
      }
      const transfer = await this.usdc.postTransfer(tx, {
        actor,
        senderId: actor.accountId,
        recipientId: row.requester_account_id,
        idempotencyKey,
        requestHash,
        amount: row.amount,
        note: row.note,
        paymentRequestId: row.id,
      });
      await tx.payment_request.update({
        where: { id },
        data: { status: 'paid', paid_transfer_id: transfer.id },
      });
      await this.audit.record(tx, {
        tenantId: null,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'chiwo.request.paid',
        subjectType: 'chiwo_payment_request',
        subjectId: id,
        outcome: 'success',
        requestId: actor.requestId,
      });
      return { transferId: transfer.id };
    });
    if ('expired' in outcome) {
      throw new AppError('invalid_state_transition', 'This request has expired.');
    }
    const transfer =
      'replay' in outcome
        ? outcome.replay
        : await this.usdc.transfer(actor.accountId, outcome.transferId);
    if ('replay' in outcome && transfer.request_id !== id) {
      throw new AppError(
        'idempotency_key_reused',
        'This Idempotency-Key was already used with a different request.',
      );
    }
    return {
      request: await this.get(actor.accountId, id),
      transfer,
      replayed: 'replay' in outcome,
    };
  }

  private async lock(tx: Tx, id: string): Promise<Row | null> {
    await tx.$queryRaw`select id from chiwo.payment_request where id = ${id}::uuid for update`;
    return tx.payment_request.findUnique({ where: { id } });
  }

  /** Marks an open request past its time as expired; the caller lets that commit, then refuses. */
  private async closeIfExpired(tx: Tx, row: Row): Promise<Row | null> {
    if (row.status !== 'open' || row.expires_at.getTime() > Date.now()) return null;
    return tx.payment_request.update({ where: { id: row.id }, data: { status: 'expired' } });
  }

  private async visible(tx: Tx, accountId: string, id: string): Promise<Row> {
    const row = await tx.payment_request.findUnique({ where: { id } });
    if (
      !row ||
      (row.requester_account_id !== accountId &&
        row.payer_account_id !== null &&
        row.payer_account_id !== accountId)
    ) {
      throw new AppError('not_found', 'Request not found.');
    }
    return row;
  }

  private async view(tx: Tx, viewer: string, row: Row): Promise<PaymentRequestView> {
    // An open request past its time reads as expired even before anything closes it.
    const status =
      row.status === 'open' && row.expires_at.getTime() <= Date.now()
        ? 'expired'
        : (row.status as PaymentRequestStatus);
    return {
      id: row.id,
      role:
        row.requester_account_id === viewer
          ? 'requester'
          : row.payer_account_id === viewer
            ? 'payer'
            : 'link',
      status,
      amount_minor: row.amount.toString(),
      currency: row.asset_code,
      note: row.note,
      requester: { display_name: await this.usdc.nameOf(tx, row.requester_account_id) },
      payer: row.payer_account_id
        ? { display_name: await this.usdc.nameOf(tx, row.payer_account_id) }
        : null,
      expires_at: row.expires_at.toISOString(),
      paid_transfer_id: row.paid_transfer_id,
      created_at: row.created_at.toISOString(),
    };
  }
}
