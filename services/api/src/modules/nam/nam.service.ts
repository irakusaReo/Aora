import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Database, type Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { exactInteger } from '../chain/amounts.js';
import { ChainService } from '../chain/chain.service.js';
import { NamVaultGateway } from '../chain/nam-vault.gateway.js';
import { BASE_SEPOLIA } from '../chain/config.js';
import { ConsentService } from '../consent/consent.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { ReconciliationService } from '../payments/reconciliation.service.js';

const USDC = BASE_SEPOLIA.usdc.assetCode;
const DISCLOSURE = 'nam_vault_disclosure';

export interface Actor {
  readonly tenantId: string;
  readonly accountId: string;
  readonly requestId: string;
}

export interface NamView {
  readonly product: {
    readonly name: string;
    readonly kind: string;
    readonly asset: string;
    readonly fee_bps: number;
    readonly returns_claimed: false;
    readonly asset_control: string;
    readonly customer_owns: string;
    readonly withdrawal_terms: string;
    readonly vault_address: string;
    readonly network: string;
  };
  readonly disclosure: {
    readonly key: string;
    readonly version: string;
    readonly title: string;
    readonly body: string;
  };
  readonly holding: {
    readonly shares: string;
    /** What the vault would return for these shares now (convertToAssets). Not a rate. */
    readonly current_value_minor: string;
    readonly cost_minor: string;
  };
  readonly funding_pending_minor: string;
  readonly note: string;
}

export interface OrderView {
  readonly id: string;
  readonly amount_minor: string;
  readonly status: string;
  readonly shares: string | null;
  readonly tx_hash: string | null;
  readonly created_at: string;
}

export interface RedemptionView {
  readonly id: string;
  readonly shares: string;
  readonly status: string;
  readonly assets_minor: string | null;
  readonly tx_hash: string | null;
  readonly created_at: string;
}

/**
 * The NAM Vault for KONY workspaces (phase-6 plan). Funding, order and holding
 * are separate states (J11): the funding is a ledger reservation, the order is
 * a vault deposit made by AORA's sandbox wallet, and the holding changes only
 * from the vault's own `Deposit` and `Withdraw` events in a confirmed receipt.
 * No return is offered or shown (brief §6.1).
 */
@Injectable()
export class NamService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ChainService) private readonly chain: ChainService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(ConsentService) private readonly consent: ConsentService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
    @Inject(NamVaultGateway) private readonly gateway: NamVaultGateway,
  ) {}

  async view(tenantId: string): Promise<NamView> {
    const vault = await this.gateway.vault();
    const [product, terms] = await Promise.all([
      this.db.asPlatform((tx) =>
        tx.product.findUniqueOrThrow({ where: { code: 'nam_usdc_vault' } }),
      ),
      this.consent.currentTerms(DISCLOSURE),
    ]);
    const { holding, pending } = await this.db.asPlatform(async (tx) => {
      const profile = await tx.investor_profile.findUnique({ where: { tenant_id: tenantId } });
      const row = profile
        ? await tx.holding.findUnique({ where: { profile_id: profile.id } })
        : null;
      return {
        holding: row,
        pending: await this.ledger.balanceOf(
          tx,
          await this.ledger.findAccount(tx, {
            tenantId,
            type: 'merchant_nam_funding_pending',
            assetCode: USDC,
          }),
        ),
      };
    });
    const shares = holding ? exactInteger(holding.shares) : 0n;
    const value = await this.gateway.convertToAssets(shares);
    return {
      product: {
        name: product.name,
        kind: product.kind,
        asset: product.asset_code,
        fee_bps: product.fee_bps,
        returns_claimed: false,
        asset_control: product.asset_control,
        customer_owns: product.customer_owns,
        withdrawal_terms: product.withdrawal_terms,
        vault_address: vault,
        network: BASE_SEPOLIA.label,
      },
      disclosure: { key: terms.key, version: terms.version, title: terms.title, body: terms.body },
      holding: {
        shares: shares.toString(),
        current_value_minor: value.toString(),
        cost_minor: (holding?.cost_basis ?? 0n).toString(),
      },
      funding_pending_minor: pending.toString(),
      note: 'SANDBOX: testnet USDC on Base Sepolia only. This product pays and promises no return.',
    };
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  async createOrder(
    actor: Actor,
    input: { idempotencyKey: string; amount: bigint; disclosureVersion: string },
  ): Promise<{ order: OrderView; replayed: boolean }> {
    await this.gateway.vault();
    const terms = await this.consent.currentTerms(DISCLOSURE);
    const requestHash = createHash('sha256')
      .update(`${input.amount.toString()}|${input.disclosureVersion}`)
      .digest('hex');
    try {
      return await this.db.asPlatform(async (tx) => {
        const profile = await this.profile(tx, actor.tenantId);
        const existing = await tx.vault_order.findUnique({
          where: {
            profile_id_idempotency_key: {
              profile_id: profile,
              idempotency_key: input.idempotencyKey,
            },
          },
        });
        if (existing) {
          if (existing.request_hash !== requestHash) {
            throw new AppError(
              'idempotency_key_reused',
              'This Idempotency-Key was used for a different order.',
            );
          }
          return { order: await this.orderView(tx, existing), replayed: true };
        }
        if (input.disclosureVersion !== terms.version) {
          throw new AppError(
            'conflict',
            'The NAM disclosure has changed. Read the current version and confirm it again.',
          );
        }
        const available = await this.ledger.findAccount(tx, {
          tenantId: actor.tenantId,
          type: 'merchant_usdc_available',
          assetCode: USDC,
        });
        if ((await this.ledger.balanceOf(tx, available)) < input.amount) {
          throw new AppError('insufficient_funds', 'Not enough USDC is available in the treasury.');
        }
        const consent = await this.consent.recordIn(tx, actor.accountId, actor.requestId, {
          termsKey: DISCLOSURE,
          termsVersion: terms.version,
          action: 'nam.order',
          capacity: 'business',
          tenantId: actor.tenantId,
        });
        const row = await tx.vault_order.create({
          data: {
            profile_id: profile,
            tenant_id: actor.tenantId,
            idempotency_key: input.idempotencyKey,
            request_hash: requestHash,
            amount: input.amount,
            consent_id: consent.id,
            created_by: actor.accountId,
          },
        });
        await this.post(
          tx,
          `nam_order:${row.id}:reserve`,
          'nam_funding_reserved',
          'nam_order',
          row.id,
          actor.tenantId,
          [
            ['merchant_usdc_available', actor.tenantId, 'debit', input.amount],
            ['merchant_nam_funding_pending', actor.tenantId, 'credit', input.amount],
          ],
        );
        await this.audit.record(tx, {
          tenantId: actor.tenantId,
          actorKind: 'user',
          actorAccountId: actor.accountId,
          action: 'nam.order.created',
          subjectType: 'nam_order',
          subjectId: row.id,
          outcome: 'success',
          requestId: actor.requestId,
          detail: { amount: input.amount.toString(), disclosure_version: terms.version },
        });
        return { order: await this.orderView(tx, row), replayed: false };
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (String(error).includes('insufficient balance')) {
        throw new AppError('insufficient_funds', 'Not enough USDC is available in the treasury.');
      }
      throw error;
    }
  }

  listOrders(tenantId: string): Promise<OrderView[]> {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx.vault_order.findMany({
        where: { tenant_id: tenantId },
        orderBy: { created_at: 'desc' },
        take: 100,
      });
      return Promise.all(rows.map((row) => this.orderView(tx, row)));
    });
  }

  /**
   * Moves orders on (cron): the one-time approval when needed (P6-6), then the
   * deposit; a confirmed deposit becomes a holding only from the vault's own
   * `Deposit` event for AORA's wallet with exactly the order's amount.
   */
  async processOrders(limit = 50): Promise<{ confirmed: number; failed: number }> {
    if (!this.gateway.configured()) return { confirmed: 0, failed: 0 };
    const wallet = (await this.gateway.wallet()).toLowerCase();
    const rows = await this.db.asPlatform((tx) =>
      tx.vault_order.findMany({
        where: { status: { in: ['funding_reserved', 'depositing'] } },
        orderBy: { created_at: 'asc' },
        take: limit,
      }),
    );
    let confirmed = 0;
    let failed = 0;
    for (const row of rows) {
      if (row.status === 'funding_reserved') {
        if (!(await this.gateway.ensureApproval(row.amount))) continue;
        const operation = await this.gateway.prepareDeposit(
          `nam_order:${row.id}`,
          row.tenant_id,
          row.amount,
        );
        await this.db.asPlatform((tx) =>
          tx.vault_order.updateMany({
            where: { id: row.id, status: 'funding_reserved' },
            data: { status: 'depositing', operation_id: operation.id },
          }),
        );
        if (operation.status === 'prepared') await this.chain.submit(operation.id);
        continue;
      }
      const operation = row.operation_id
        ? await this.db.asPlatform((tx) =>
            tx.operation.findUnique({ where: { id: row.operation_id ?? '' } }),
          )
        : null;
      if (!operation) continue;
      if (operation.status === 'prepared') {
        await this.chain.submit(operation.id).catch(() => undefined); // retried next run
      } else if (operation.status === 'confirmed') {
        const event = await this.gateway.event(operation.tx_hash ?? '', 'Deposit');
        const matches =
          event !== null &&
          event.owner === wallet &&
          event.sender === wallet &&
          event.assets === row.amount;
        if (!event || !matches) {
          await this.unresolved(
            'nam_order',
            row.id,
            row.tenant_id,
            'The confirmed deposit has no matching vault event.',
          );
          continue;
        }
        await this.db.asPlatform(async (tx) => {
          const updated = await tx.vault_order.updateMany({
            where: { id: row.id, status: 'depositing' },
            data: { status: 'holding_confirmed', shares: event.shares.toString() },
          });
          if (updated.count !== 1) return;
          await this.changeHolding(
            tx,
            row.profile_id,
            row.tenant_id,
            'order',
            row.id,
            operation.tx_hash ?? '',
            event.logIndex,
            event.shares,
            row.amount,
          );
          await this.post(
            tx,
            `nam_order:${row.id}:confirmed`,
            'nam_order_confirmed',
            'nam_order',
            row.id,
            row.tenant_id,
            [
              ['nam_vault_usdc', null, 'debit', row.amount],
              ['chain_wallet_usdc', null, 'credit', row.amount],
              ['merchant_nam_funding_pending', row.tenant_id, 'debit', row.amount],
              ['merchant_nam_holding', row.tenant_id, 'credit', row.amount],
            ],
          );
          await this.audit.record(tx, {
            tenantId: row.tenant_id,
            actorKind: 'system',
            action: 'nam.order.holding_confirmed',
            subjectType: 'nam_order',
            subjectId: row.id,
            outcome: 'success',
            detail: { shares: event.shares.toString(), tx_hash: operation.tx_hash },
          });
        });
        confirmed += 1;
      } else if (operation.status === 'reverted' || operation.status === 'failed') {
        await this.db.asPlatform(async (tx) => {
          const updated = await tx.vault_order.updateMany({
            where: { id: row.id, status: 'depositing' },
            data: { status: 'failed', failure_reason: `The deposit ${operation.status}.` },
          });
          if (updated.count !== 1) return;
          await this.post(
            tx,
            `nam_order:${row.id}:release`,
            'nam_funding_released',
            'nam_order',
            row.id,
            row.tenant_id,
            [
              ['merchant_nam_funding_pending', row.tenant_id, 'debit', row.amount],
              ['merchant_usdc_available', row.tenant_id, 'credit', row.amount],
            ],
          );
        });
        failed += 1;
      } else if (operation.status === 'reconciliation_required') {
        await this.unresolved(
          'nam_order',
          row.id,
          row.tenant_id,
          'The deposit transaction needs a person.',
        );
      }
    }
    return { confirmed, failed };
  }

  // -------------------------------------------------------------------------
  // Redemptions
  // -------------------------------------------------------------------------

  async createRedemption(
    actor: Actor,
    input: { idempotencyKey: string; shares: bigint | 'all' },
  ): Promise<{ redemption: RedemptionView; replayed: boolean }> {
    await this.gateway.vault();
    const requestHash = createHash('sha256').update(input.shares.toString()).digest('hex');
    return this.db.asPlatform(async (tx) => {
      const profile = await this.profile(tx, actor.tenantId);
      const existing = await tx.redemption.findUnique({
        where: {
          profile_id_idempotency_key: {
            profile_id: profile,
            idempotency_key: input.idempotencyKey,
          },
        },
      });
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new AppError(
            'idempotency_key_reused',
            'This Idempotency-Key was used for a different redemption.',
          );
        }
        return { redemption: await this.redemptionView(tx, existing), replayed: true };
      }
      // Serialise redemptions of one holding, so two requests cannot spend the same shares.
      await tx.$queryRaw`select profile_id from nam.holding where profile_id = ${profile}::uuid for update`;
      const holding = await tx.holding.findUnique({ where: { profile_id: profile } });
      const [open] = await tx.$queryRaw<{ shares: string }[]>`
        select coalesce(sum(shares), 0)::text as shares from nam.redemption
        where profile_id = ${profile}::uuid and status in ('requested', 'redeeming')`;
      const free = (holding ? exactInteger(holding.shares) : 0n) - BigInt(open?.shares ?? '0');
      const shares = input.shares === 'all' ? free : input.shares;
      if (shares <= 0n || shares > free) {
        throw new AppError(
          'insufficient_funds',
          'That is more than the shares available to redeem.',
        );
      }
      const row = await tx.redemption.create({
        data: {
          profile_id: profile,
          tenant_id: actor.tenantId,
          idempotency_key: input.idempotencyKey,
          request_hash: requestHash,
          shares: shares.toString(),
          created_by: actor.accountId,
        },
      });
      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'nam.redemption.requested',
        subjectType: 'nam_redemption',
        subjectId: row.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { shares: shares.toString() },
      });
      return { redemption: await this.redemptionView(tx, row), replayed: false };
    });
  }

  listRedemptions(tenantId: string): Promise<RedemptionView[]> {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx.redemption.findMany({
        where: { tenant_id: tenantId },
        orderBy: { created_at: 'desc' },
        take: 100,
      });
      return Promise.all(rows.map((row) => this.redemptionView(tx, row)));
    });
  }

  /**
   * Moves redemptions on (cron). Completed only from the vault's `Withdraw`
   * event in a confirmed receipt, for exactly the requested shares. The holder
   * receives what the vault returned; the cost released is proportional, and
   * the difference is rounding (P6-5).
   */
  async processRedemptions(limit = 50): Promise<{ completed: number; failed: number }> {
    if (!this.gateway.configured()) return { completed: 0, failed: 0 };
    const wallet = (await this.gateway.wallet()).toLowerCase();
    const rows = await this.db.asPlatform((tx) =>
      tx.redemption.findMany({
        where: { status: { in: ['requested', 'redeeming'] } },
        orderBy: { created_at: 'asc' },
        take: limit,
      }),
    );
    let completed = 0;
    let failed = 0;
    for (const row of rows) {
      const shares = exactInteger(row.shares);
      if (row.status === 'requested') {
        const operation = await this.gateway.prepareRedeem(
          `nam_redemption:${row.id}`,
          row.tenant_id,
          shares,
        );
        await this.db.asPlatform((tx) =>
          tx.redemption.updateMany({
            where: { id: row.id, status: 'requested' },
            data: { status: 'redeeming', operation_id: operation.id },
          }),
        );
        if (operation.status === 'prepared') await this.chain.submit(operation.id);
        continue;
      }
      const operation = row.operation_id
        ? await this.db.asPlatform((tx) =>
            tx.operation.findUnique({ where: { id: row.operation_id ?? '' } }),
          )
        : null;
      if (!operation) continue;
      if (operation.status === 'prepared') {
        await this.chain.submit(operation.id).catch(() => undefined);
      } else if (operation.status === 'confirmed') {
        const event = await this.gateway.event(operation.tx_hash ?? '', 'Withdraw');
        const matches =
          event !== null &&
          event.owner === wallet &&
          event.receiver === wallet &&
          event.shares === shares;
        if (!event || !matches) {
          await this.unresolved(
            'nam_redemption',
            row.id,
            row.tenant_id,
            'The confirmed redemption has no matching vault event.',
          );
          continue;
        }
        const assets = event.assets;
        await this.db.asPlatform(async (tx) => {
          const holding = await tx.holding.findUniqueOrThrow({
            where: { profile_id: row.profile_id },
          });
          const held = exactInteger(holding.shares);
          const cost = shares >= held ? holding.cost_basis : (holding.cost_basis * shares) / held;
          const updated = await tx.redemption.updateMany({
            where: { id: row.id, status: 'redeeming' },
            data: { status: 'completed', assets },
          });
          if (updated.count !== 1) return;
          await this.changeHolding(
            tx,
            row.profile_id,
            row.tenant_id,
            'redemption',
            row.id,
            operation.tx_hash ?? '',
            event.logIndex,
            -shares,
            -cost,
          );
          const rounding = cost - assets;
          await this.post(
            tx,
            `nam_redemption:${row.id}:completed`,
            'nam_redemption_completed',
            'nam_redemption',
            row.id,
            row.tenant_id,
            [
              ['chain_wallet_usdc', null, 'debit', assets],
              ['nam_vault_usdc', null, 'credit', assets],
              ['merchant_nam_holding', row.tenant_id, 'debit', cost],
              ['merchant_usdc_available', row.tenant_id, 'credit', assets],
              ...(rounding > 0n
                ? [['nam_vault_rounding', null, 'credit', rounding] as const]
                : rounding < 0n
                  ? [['nam_vault_rounding', null, 'debit', -rounding] as const]
                  : []),
            ],
          );
          await this.audit.record(tx, {
            tenantId: row.tenant_id,
            actorKind: 'system',
            action: 'nam.redemption.completed',
            subjectType: 'nam_redemption',
            subjectId: row.id,
            outcome: 'success',
            detail: { shares: shares.toString(), assets: assets.toString() },
          });
        });
        completed += 1;
      } else if (operation.status === 'reverted' || operation.status === 'failed') {
        await this.db.asPlatform((tx) =>
          tx.redemption.updateMany({
            where: { id: row.id, status: 'redeeming' },
            data: { status: 'failed', failure_reason: `The redemption ${operation.status}.` },
          }),
        );
        failed += 1;
      } else if (operation.status === 'reconciliation_required') {
        await this.unresolved(
          'nam_redemption',
          row.id,
          row.tenant_id,
          'The redemption transaction needs a person.',
        );
      }
    }
    return { completed, failed };
  }

  // -------------------------------------------------------------------------
  // Reconciliation against the vault (P6-10)
  // -------------------------------------------------------------------------

  async reconcile(): Promise<{ skipped: boolean; exceptions_opened: number }> {
    if (!this.gateway.configured()) return { skipped: true, exceptions_opened: 0 };
    const { walletShares: onChainShares, accountedAssets: accounted } =
      await this.gateway.positions();
    return this.db.asPlatform(async (tx) => {
      const [sums] = await tx.$queryRaw<{ shares: string; in_flight: string }[]>`
        select
          (select coalesce(sum(shares), 0)::text from nam.holding) as shares,
          (select count(*)::text from nam.vault_order where status = 'depositing') as in_flight`;
      const vaultLedger = await this.ledger.balanceOf(
        tx,
        await this.ledger.findAccount(tx, {
          tenantId: null,
          type: 'nam_vault_usdc',
          assetCode: USDC,
        }),
      );
      let opened = 0;
      const open = async (ref: string, detail: Record<string, string>): Promise<void> => {
        const created = await this.reconciliation.openException(tx, {
          runId: null,
          tenantId: null,
          type: 'nam_mismatch',
          subjectType: 'nam_vault',
          subjectRef: ref,
          detail,
        });
        if (created) opened += 1;
      };
      // Only a settled moment can be compared: skip while a deposit is in flight.
      if ((sums?.in_flight ?? '0') !== '0') return { skipped: true, exceptions_opened: 0 };
      if (onChainShares !== BigInt(sums?.shares ?? '0')) {
        await open('vault_shares', {
          on_chain: onChainShares.toString(),
          holdings: sums?.shares ?? '0',
        });
      }
      if (accounted !== vaultLedger) {
        await open('vault_assets', {
          on_chain: accounted.toString(),
          ledger: vaultLedger.toString(),
        });
      }
      return { skipped: false, exceptions_opened: opened };
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async profile(tx: Tx, tenantId: string): Promise<string> {
    await tx.$executeRaw`
      insert into nam.investor_profile (kind, tenant_id) values ('business', ${tenantId}::uuid)
      on conflict (tenant_id) do nothing`;
    const row = await tx.investor_profile.findUniqueOrThrow({ where: { tenant_id: tenantId } });
    return row.id;
  }

  private async changeHolding(
    tx: Tx,
    profileId: string,
    tenantId: string | null,
    sourceType: 'order' | 'redemption',
    sourceId: string,
    txHash: string,
    logIndex: number,
    sharesDelta: bigint,
    costDelta: bigint,
  ): Promise<void> {
    await tx.holding_change.create({
      data: {
        profile_id: profileId,
        tenant_id: tenantId,
        source_type: sourceType,
        source_id: sourceId,
        tx_hash: txHash.toLowerCase(),
        log_index: logIndex,
        shares_delta: sharesDelta.toString(),
        cost_delta: costDelta,
      },
    });
    // A redemption only ever reduces an existing holding; an insert would be
    // checked (shares >= 0) before any conflict is resolved.
    if (sharesDelta < 0n) {
      await tx.$executeRaw`
        update nam.holding
        set shares = shares + ${sharesDelta.toString()}::numeric,
            cost_basis = cost_basis + ${costDelta}, updated_at = now()
        where profile_id = ${profileId}::uuid`;
      return;
    }
    await tx.$executeRaw`
      insert into nam.holding (profile_id, tenant_id, shares, cost_basis)
      values (${profileId}::uuid, ${tenantId}::uuid, ${sharesDelta.toString()}::numeric, ${costDelta})
      on conflict (profile_id) do update
        set shares = nam.holding.shares + excluded.shares,
            cost_basis = nam.holding.cost_basis + excluded.cost_basis,
            updated_at = now()`;
  }

  private async unresolved(
    subjectType: 'nam_order' | 'nam_redemption',
    id: string,
    tenantId: string | null,
    reason: string,
  ): Promise<void> {
    await this.db.asPlatform(async (tx) => {
      if (subjectType === 'nam_order') {
        await tx.vault_order.updateMany({
          where: { id, status: 'depositing' },
          data: { status: 'reconciliation_required', failure_reason: reason },
        });
      } else {
        await tx.redemption.updateMany({
          where: { id, status: 'redeeming' },
          data: { status: 'reconciliation_required', failure_reason: reason },
        });
      }
      await this.reconciliation.openException(tx, {
        runId: null,
        tenantId,
        type: 'nam_mismatch',
        subjectType,
        subjectRef: id,
        detail: { reason },
      });
    });
  }

  private async post(
    tx: Tx,
    key: string,
    entryType: string,
    operationType: string,
    operationId: string,
    tenantId: string | null,
    lines: readonly (readonly [
      (
        | 'merchant_usdc_available'
        | 'merchant_nam_funding_pending'
        | 'merchant_nam_holding'
        | 'nam_vault_usdc'
        | 'nam_vault_rounding'
        | 'chain_wallet_usdc'
      ),
      string | null,
      'debit' | 'credit',
      bigint,
    ])[],
  ): Promise<void> {
    const postings = [];
    for (const [type, owner, direction, amount] of lines) {
      if (amount === 0n) continue;
      postings.push({
        accountId: await this.ledger.findAccount(tx, { tenantId: owner, type, assetCode: USDC }),
        direction,
        amount,
      });
    }
    await this.ledger.post(tx, {
      idempotencyKey: key,
      tenantId,
      entryType,
      operationType,
      operationId,
      postings,
    });
  }

  private async orderView(
    tx: Tx,
    row: {
      id: string;
      amount: bigint;
      status: string;
      shares: { toString(): string } | null;
      operation_id: string | null;
      created_at: Date;
    },
  ): Promise<OrderView> {
    const operation = row.operation_id
      ? await tx.operation.findUnique({ where: { id: row.operation_id } })
      : null;
    return {
      id: row.id,
      amount_minor: row.amount.toString(),
      status: row.status,
      shares: row.shares === null ? null : exactInteger(row.shares).toString(),
      tx_hash: operation?.tx_hash ?? null,
      created_at: row.created_at.toISOString(),
    };
  }

  private async redemptionView(
    tx: Tx,
    row: {
      id: string;
      shares: { toString(): string };
      status: string;
      assets: bigint | null;
      operation_id: string | null;
      created_at: Date;
    },
  ): Promise<RedemptionView> {
    const operation = row.operation_id
      ? await tx.operation.findUnique({ where: { id: row.operation_id } })
      : null;
    return {
      id: row.id,
      shares: exactInteger(row.shares).toString(),
      status: row.status,
      assets_minor: row.assets === null ? null : row.assets.toString(),
      tx_hash: operation?.tx_hash ?? null,
      created_at: row.created_at.toISOString(),
    };
  }
}
