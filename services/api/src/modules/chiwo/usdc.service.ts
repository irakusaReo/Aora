import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Database, type Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { RateLimiter } from '../../platform/rate-limit.js';
import { AuditService } from '../audit/audit.service.js';
import { BASE_SEPOLIA } from '../chain/config.js';
import {
  type PersonalUsdcView,
  TreasuryService,
  type WithdrawalView,
} from '../chain/treasury.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { maskPhone } from '../notifications/templates.js';

const USDC = BASE_SEPOLIA.usdc.assetCode;

export interface RecipientView {
  readonly id: string;
  /** Enough to recognise a person, never their full name or number (O-11 c). */
  readonly display_name: string;
  readonly confirmed: boolean;
}

export interface TransferView {
  readonly id: string;
  readonly kind: 'transfer';
  readonly direction: 'in' | 'out';
  readonly status: 'posted';
  readonly amount_minor: string;
  readonly fee_minor: string;
  readonly currency: string;
  readonly counterparty: string;
  readonly note: string | null;
  readonly request_id: string | null;
  readonly created_at: string;
}

type TransferRow = {
  id: string;
  sender_account_id: string;
  recipient_account_id: string;
  amount: bigint;
  asset_code: string;
  note: string | null;
  request_id: string | null;
  created_at: Date;
};

/** "Baraka Otieno" → "B•••a O."; with no name, the last three digits of the number. */
export function maskName(name: string | null, phone: string | null): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first) return `CHIWO user ${maskPhone(phone)}`.trim();
  const shown =
    first.length <= 2 ? `${first.charAt(0)}•••` : `${first.charAt(0)}•••${first.slice(-1)}`;
  const last = words.length > 1 ? ` ${(words[words.length - 1] ?? '').charAt(0)}.` : '';
  return `${shown}${last}`;
}

/**
 * Personal USDC (phase-7 P7-8 to P7-11). A transfer between CHIWO consumers is
 * a ledger move on AORA's books: no chain transaction, so nothing to confirm.
 * On-chain receiving and sending go through the chain module's treasury.
 */
@Injectable()
export class UsdcService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(RateLimiter) private readonly rateLimiter: RateLimiter,
    @Inject(TreasuryService) private readonly treasury: TreasuryService,
  ) {}

  overview(accountId: string): Promise<PersonalUsdcView> {
    return this.treasury.personalView(accountId);
  }

  async withdraw(
    actor: { accountId: string; requestId: string },
    input: { idempotencyKey: string; amount: bigint; addressId: string },
  ): Promise<{ withdrawal: WithdrawalView; replayed: boolean }> {
    const limit = await this.db.asPlatform((tx) => this.limitFor(tx, 'usdc_withdrawal'));
    return this.treasury.createPersonalWithdrawal(actor, {
      ...input,
      limits: { perTransactionMax: limit.per_payment_max, perDayMax: limit.per_day_max },
    });
  }

  // --- recipients (O-11 c) ---

  /** Finds a CHIWO consumer by phone number and records them as the sender's recipient, unconfirmed. */
  async addRecipient(
    accountId: string,
    phone: string,
  ): Promise<{ view: RecipientView; created: boolean }> {
    await this.rateLimiter.consume('chiwo_recipient_lookup', accountId);
    return this.db.asPlatform(async (tx) => {
      const target = await tx.user_account.findFirst({
        where: { phone_e164: phone, status: 'active' },
        select: { id: true, display_name: true, phone_e164: true },
      });
      if (target?.id === accountId) {
        throw new AppError('invalid_request', 'You cannot send to yourself.');
      }
      const consumer = target
        ? await tx.consumer.findUnique({ where: { account_id: target.id } })
        : null;
      if (!target || consumer?.status !== 'active') {
        throw new AppError('not_found', 'No CHIWO account has that number.');
      }
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        insert into chiwo.recipient (sender_account_id, recipient_account_id)
        values (${accountId}::uuid, ${target.id}::uuid)
        on conflict (sender_account_id, recipient_account_id) do nothing
        returning id`;
      const row = await tx.recipient.findFirstOrThrow({
        where: { sender_account_id: accountId, recipient_account_id: target.id },
      });
      return {
        view: {
          id: row.id,
          display_name: maskName(target.display_name, target.phone_e164),
          confirmed: row.confirmed_at !== null,
        },
        created: inserted.length > 0,
      };
    });
  }

  /** The sender confirms the person shown, with a PIN step-up (checked by the route). */
  async confirmRecipient(
    actor: { accountId: string; requestId: string },
    id: string,
  ): Promise<RecipientView> {
    return this.db.asPlatform(async (tx) => {
      const row = await tx.recipient.findFirst({
        where: { id, sender_account_id: actor.accountId },
      });
      if (!row) throw new AppError('not_found', 'Recipient not found.');
      const confirmed =
        row.confirmed_at ??
        (await tx.recipient.update({ where: { id }, data: { confirmed_at: new Date() } }))
          .confirmed_at;
      if (!row.confirmed_at) {
        await this.audit.record(tx, {
          tenantId: null,
          actorKind: 'user',
          actorAccountId: actor.accountId,
          action: 'chiwo.recipient.confirmed',
          subjectType: 'chiwo_recipient',
          subjectId: id,
          outcome: 'success',
          requestId: actor.requestId,
        });
      }
      return {
        id,
        display_name: await this.nameOf(tx, row.recipient_account_id),
        confirmed: confirmed !== null,
      };
    });
  }

  async listRecipients(accountId: string): Promise<RecipientView[]> {
    const rows = await this.db.withConsumer(accountId, (tx) =>
      tx.recipient.findMany({
        where: { sender_account_id: accountId },
        orderBy: { created_at: 'desc' },
      }),
    );
    return this.db.asPlatform(async (tx) =>
      Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          display_name: await this.nameOf(tx, row.recipient_account_id),
          confirmed: row.confirmed_at !== null,
        })),
      ),
    );
  }

  // --- transfers ---

  async send(
    actor: { accountId: string; requestId: string },
    input: { idempotencyKey: string; recipientId: string; amount: bigint; note: string | null },
  ): Promise<{ transfer: TransferView; replayed: boolean }> {
    const requestHash = createHash('sha256')
      .update(JSON.stringify([input.recipientId, input.amount.toString(), input.note]))
      .digest('hex');
    return this.db.asPlatform(async (tx) => {
      await this.lockConsumer(tx, actor.accountId);
      const replay = await this.replay(tx, actor.accountId, input.idempotencyKey, requestHash);
      if (replay) return { transfer: replay, replayed: true };
      const recipient = await tx.recipient.findFirst({
        where: { id: input.recipientId, sender_account_id: actor.accountId },
      });
      if (!recipient) throw new AppError('not_found', 'Recipient not found.');
      if (!recipient.confirmed_at) {
        throw new AppError(
          'recipient_not_confirmed',
          'Confirm this person before sending to them.',
        );
      }
      const row = await this.postTransfer(tx, {
        actor,
        senderId: actor.accountId,
        recipientId: recipient.recipient_account_id,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        amount: input.amount,
        note: input.note,
        paymentRequestId: null,
      });
      return { transfer: await this.view(tx, actor.accountId, row), replayed: false };
    });
  }

  /** Serialises one consumer's sends, so limits and balances count what is committed. */
  async lockConsumer(tx: Tx, accountId: string): Promise<void> {
    await tx.$queryRaw`select account_id from chiwo.consumer where account_id = ${accountId}::uuid for update`;
  }

  /** A transfer already made with this key, or a refusal if the key was used differently. */
  async replay(
    tx: Tx,
    senderId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<TransferView | null> {
    const earlier = await tx.transfer.findUnique({
      where: {
        sender_account_id_idempotency_key: {
          sender_account_id: senderId,
          idempotency_key: idempotencyKey,
        },
      },
    });
    if (!earlier) return null;
    if (earlier.request_hash !== requestHash) {
      throw new AppError(
        'idempotency_key_reused',
        'This Idempotency-Key was already used with a different request.',
      );
    }
    return this.view(tx, senderId, earlier);
  }

  /**
   * The ledger move and its record, in the caller's transaction (which holds the
   * sender's lock). Limits are data; the balance cannot go below zero.
   */
  async postTransfer(
    tx: Tx,
    input: {
      actor: { accountId: string; requestId: string };
      senderId: string;
      recipientId: string;
      idempotencyKey: string;
      requestHash: string;
      amount: bigint;
      note: string | null;
      paymentRequestId: string | null;
    },
  ): Promise<TransferRow> {
    const limit = await this.limitFor(tx, 'usdc_transfer');
    if (input.amount > limit.per_payment_max) {
      throw new AppError('limit_exceeded', 'This amount is above your limit for one transfer.');
    }
    const [today] = await tx.$queryRaw<{ total: bigint | null }[]>`
      select sum(amount)::bigint as total from chiwo.transfer
       where sender_account_id = ${input.senderId}::uuid
         and created_at >= date_trunc('day', now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi'`;
    if ((today?.total ?? 0n) + input.amount > limit.per_day_max) {
      throw new AppError('limit_exceeded', 'This transfer would take you over your daily limit.');
    }
    const from = await this.ledger.consumerAccount(tx, {
      accountId: input.senderId,
      type: 'consumer_usdc_available',
      assetCode: USDC,
    });
    const to = await this.ledger.consumerAccount(tx, {
      accountId: input.recipientId,
      type: 'consumer_usdc_available',
      assetCode: USDC,
    });
    if ((await this.ledger.balanceOf(tx, from)) < input.amount) {
      throw new AppError('insufficient_funds', 'Not enough USDC is available.');
    }
    const id = randomUUID();
    const entry = await this.ledger.post(tx, {
      idempotencyKey: `chiwo_transfer:${id}`,
      tenantId: null,
      entryType: 'chiwo_usdc_transfer',
      operationType: 'chiwo_transfer',
      operationId: id,
      postings: [
        { accountId: from, direction: 'debit', amount: input.amount },
        { accountId: to, direction: 'credit', amount: input.amount },
      ],
    });
    const row = await tx.transfer.create({
      data: {
        id,
        sender_account_id: input.senderId,
        recipient_account_id: input.recipientId,
        idempotency_key: input.idempotencyKey,
        request_hash: input.requestHash,
        amount: input.amount,
        asset_code: USDC,
        note: input.note,
        request_id: input.paymentRequestId,
        journal_entry_id: entry.entryId,
      },
    });
    await this.audit.record(tx, {
      tenantId: null,
      actorKind: 'user',
      actorAccountId: input.actor.accountId,
      action: 'chiwo.transfer.posted',
      subjectType: 'chiwo_transfer',
      subjectId: id,
      outcome: 'success',
      requestId: input.actor.requestId,
      detail: { amount: input.amount.toString(), asset: USDC },
    });
    await this.notifications.notify(tx, {
      dedupeKey: `chiwo.usdc.received:${id}`,
      accountId: input.recipientId,
      tenantId: null,
      type: 'chiwo.usdc.received',
      params: {
        amount_minor: input.amount.toString(),
        currency: USDC,
        exponent: BASE_SEPOLIA.usdc.decimals,
        sender: await this.nameOf(tx, input.senderId),
        reference: id,
      },
    });
    return row;
  }

  async transfer(accountId: string, id: string): Promise<TransferView> {
    const row = await this.db.withConsumer(accountId, (tx) =>
      tx.transfer.findFirst({
        where: {
          id,
          OR: [{ sender_account_id: accountId }, { recipient_account_id: accountId }],
        },
      }),
    );
    if (!row) throw new AppError('not_found', 'Transfer not found.');
    return this.db.asPlatform((tx) => this.view(tx, accountId, row));
  }

  async listTransfers(accountId: string): Promise<TransferView[]> {
    const rows = await this.db.withConsumer(accountId, (tx) =>
      tx.transfer.findMany({
        where: { OR: [{ sender_account_id: accountId }, { recipient_account_id: accountId }] },
        orderBy: { created_at: 'desc' },
        take: 100,
      }),
    );
    return this.db.asPlatform((tx) =>
      Promise.all(rows.map((row) => this.view(tx, accountId, row))),
    );
  }

  withdrawal(accountId: string, id: string): Promise<WithdrawalView> {
    return this.treasury.personalWithdrawal(accountId, id);
  }

  chainActivity(accountId: string): ReturnType<TreasuryService['personalTransfers']> {
    return this.treasury.personalTransfers(accountId);
  }

  async nameOf(tx: Tx, accountId: string): Promise<string> {
    const account = await tx.user_account.findUniqueOrThrow({
      where: { id: accountId },
      select: { display_name: true, phone_e164: true },
    });
    return maskName(account.display_name, account.phone_e164);
  }

  private async view(tx: Tx, viewer: string, row: TransferRow): Promise<TransferView> {
    const outgoing = row.sender_account_id === viewer;
    return {
      id: row.id,
      kind: 'transfer',
      direction: outgoing ? 'out' : 'in',
      status: 'posted',
      amount_minor: row.amount.toString(),
      fee_minor: '0',
      currency: row.asset_code,
      counterparty: await this.nameOf(
        tx,
        outgoing ? row.recipient_account_id : row.sender_account_id,
      ),
      note: row.note,
      request_id: row.request_id,
      created_at: row.created_at.toISOString(),
    };
  }

  private async limitFor(
    tx: Tx,
    operation: 'usdc_transfer' | 'usdc_withdrawal',
  ): Promise<{ per_payment_max: bigint; per_day_max: bigint }> {
    const limit = await tx.consumer_limit.findFirst({
      where: { operation, asset_code: USDC, effective_from: { lte: new Date() } },
      orderBy: { effective_from: 'desc' },
    });
    // With no limit configured, nothing is allowed.
    if (!limit) throw new AppError('limit_exceeded', 'No limit is configured for this operation.');
    return limit;
  }
}
