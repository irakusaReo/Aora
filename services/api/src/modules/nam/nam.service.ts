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

export interface Actor {
  readonly accountId: string;
  readonly requestId: string;
}

/**
 * Whose investment it is: a workspace (business investor profile, KONY) or one
 * CHIWO consumer (personal investor profile). The two never share a profile, a
 * holding or a ledger account (J13, phase-7 P7-14).
 */
export type NamOwner =
  | { readonly kind: 'workspace'; readonly tenantId: string }
  | { readonly kind: 'consumer'; readonly accountId: string };

/** An owner's account, by what it is for; the type follows the owner (rule 5). */
type OwnerRole = 'available' | 'funding_pending' | 'holding';
type PlatformType = 'nam_vault_usdc' | 'nam_vault_rounding' | 'chain_wallet_usdc';

const ROLE_TYPES = {
  workspace: {
    available: 'merchant_usdc_available',
    funding_pending: 'merchant_nam_funding_pending',
    holding: 'merchant_nam_holding',
  },
  consumer: {
    available: 'consumer_usdc_available',
    funding_pending: 'consumer_nam_funding_pending',
    holding: 'consumer_nam_holding',
  },
} as const;

function ownerColumns(owner: NamOwner): {
  tenant_id: string | null;
  consumer_account_id: string | null;
} {
  return owner.kind === 'workspace'
    ? { tenant_id: owner.tenantId, consumer_account_id: null }
    : { tenant_id: null, consumer_account_id: owner.accountId };
}

function ownerOf(row: { tenant_id: string | null; consumer_account_id: string | null }): NamOwner {
  if (row.tenant_id) return { kind: 'workspace', tenantId: row.tenant_id };
  if (row.consumer_account_id) return { kind: 'consumer', accountId: row.consumer_account_id };
  throw new Error('A NAM record has no owner.');
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

  async view(owner: NamOwner): Promise<NamView> {
    const vault = await this.gateway.vault();
    const product = await this.db.asPlatform((tx) =>
      tx.product.findUniqueOrThrow({ where: { code: 'nam_usdc_vault' } }),
    );
    const terms = await this.consent.currentTerms(this.disclosureKey(owner, product));
    const { holding, pending } = await this.db.asPlatform(async (tx) => {
      const profile = await this.findProfile(tx, owner);
      const row = profile ? await tx.holding.findUnique({ where: { profile_id: profile } }) : null;
      return {
        holding: row,
        pending: await this.ledger.balanceOf(tx, await this.account(tx, owner, 'funding_pending')),
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
        customer_owns:
          owner.kind === 'consumer'
            ? (product.customer_owns_personal ?? product.customer_owns)
            : product.customer_owns,
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
    owner: NamOwner,
    actor: Actor,
    input: { idempotencyKey: string; amount: bigint; disclosureVersion: string },
  ): Promise<{ order: OrderView; replayed: boolean }> {
    await this.gateway.vault();
    const product = await this.db.asPlatform((tx) =>
      tx.product.findUniqueOrThrow({ where: { code: 'nam_usdc_vault' } }),
    );
    const terms = await this.consent.currentTerms(this.disclosureKey(owner, product));
    const tenantId = owner.kind === 'workspace' ? owner.tenantId : null;
    const requestHash = createHash('sha256')
      .update(`${input.amount.toString()}|${input.disclosureVersion}`)
      .digest('hex');
    try {
      return await this.db.asPlatform(async (tx) => {
        const profile = await this.profile(tx, owner);
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
        const available = await this.account(tx, owner, 'available');
        if ((await this.ledger.balanceOf(tx, available)) < input.amount) {
          throw new AppError('insufficient_funds', 'Not enough USDC is available.');
        }
        const consent = await this.consent.recordIn(tx, actor.accountId, actor.requestId, {
          termsKey: terms.key,
          termsVersion: terms.version,
          action: 'nam.order',
          capacity: owner.kind === 'workspace' ? 'business' : 'personal',
          tenantId,
        });
        const row = await tx.vault_order.create({
          data: {
            profile_id: profile,
            ...ownerColumns(owner),
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
          tenantId,
          [
            ['available', owner, 'debit', input.amount],
            ['funding_pending', owner, 'credit', input.amount],
          ],
        );
        await this.audit.record(tx, {
          tenantId,
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
        throw new AppError('insufficient_funds', 'Not enough USDC is available.');
      }
      throw error;
    }
  }

  listOrders(owner: NamOwner): Promise<OrderView[]> {
    return this.scoped(owner, async (tx) => {
      const rows = await tx.vault_order.findMany({
        where: ownerColumns(owner),
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
            ownerOf(row),
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
              ['funding_pending', ownerOf(row), 'debit', row.amount],
              ['holding', ownerOf(row), 'credit', row.amount],
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
              ['funding_pending', ownerOf(row), 'debit', row.amount],
              ['available', ownerOf(row), 'credit', row.amount],
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
    owner: NamOwner,
    actor: Actor,
    input: { idempotencyKey: string; shares: bigint | 'all' },
  ): Promise<{ redemption: RedemptionView; replayed: boolean }> {
    await this.gateway.vault();
    const tenantId = owner.kind === 'workspace' ? owner.tenantId : null;
    const requestHash = createHash('sha256').update(input.shares.toString()).digest('hex');
    return this.db.asPlatform(async (tx) => {
      const profile = await this.profile(tx, owner);
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
          ...ownerColumns(owner),
          idempotency_key: input.idempotencyKey,
          request_hash: requestHash,
          shares: shares.toString(),
          created_by: actor.accountId,
        },
      });
      await this.audit.record(tx, {
        tenantId,
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

  listRedemptions(owner: NamOwner): Promise<RedemptionView[]> {
    return this.scoped(owner, async (tx) => {
      const rows = await tx.redemption.findMany({
        where: ownerColumns(owner),
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
            ownerOf(row),
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
              ['holding', ownerOf(row), 'debit', cost],
              ['available', ownerOf(row), 'credit', assets],
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

  /** The owner's investor profile, created on first use: business for a workspace, personal for a person. */
  private async profile(tx: Tx, owner: NamOwner): Promise<string> {
    if (owner.kind === 'workspace') {
      await tx.$executeRaw`
        insert into nam.investor_profile (kind, tenant_id) values ('business', ${owner.tenantId}::uuid)
        on conflict (tenant_id) do nothing`;
    } else {
      const person = await this.personOf(tx, owner.accountId);
      await tx.$executeRaw`
        insert into nam.investor_profile (kind, person_id) values ('personal', ${person}::uuid)
        on conflict (person_id) do nothing`;
    }
    const id = await this.findProfile(tx, owner);
    if (!id) throw new Error('Investor profile was not created.');
    return id;
  }

  private async findProfile(tx: Tx, owner: NamOwner): Promise<string | null> {
    const row =
      owner.kind === 'workspace'
        ? await tx.investor_profile.findUnique({ where: { tenant_id: owner.tenantId } })
        : await tx.investor_profile.findUnique({
            where: { person_id: await this.personOf(tx, owner.accountId) },
          });
    return row?.id ?? null;
  }

  private async personOf(tx: Tx, accountId: string): Promise<string> {
    const account = await tx.user_account.findUniqueOrThrow({
      where: { id: accountId },
      select: { person_id: true },
    });
    return account.person_id;
  }

  private disclosureKey(
    owner: NamOwner,
    product: { terms_key: string; personal_terms_key: string | null },
  ): string {
    return owner.kind === 'consumer'
      ? (product.personal_terms_key ?? product.terms_key)
      : product.terms_key;
  }

  private account(tx: Tx, owner: NamOwner, role: OwnerRole): Promise<string> {
    return owner.kind === 'consumer'
      ? this.ledger.consumerAccount(tx, {
          accountId: owner.accountId,
          type: ROLE_TYPES.consumer[role],
          assetCode: USDC,
        })
      : this.ledger.findAccount(tx, {
          tenantId: owner.tenantId,
          type: ROLE_TYPES.workspace[role],
          assetCode: USDC,
        });
  }

  /** Reads as the owner sees them: the tenant role for a workspace, the consumer barrier for a person. */
  private scoped<T>(owner: NamOwner, work: (tx: Tx) => Promise<T>): Promise<T> {
    return owner.kind === 'workspace'
      ? this.db.withTenant(owner.tenantId, work)
      : this.db.withConsumer(owner.accountId, work);
  }

  private async changeHolding(
    tx: Tx,
    profileId: string,
    owner: NamOwner,
    sourceType: 'order' | 'redemption',
    sourceId: string,
    txHash: string,
    logIndex: number,
    sharesDelta: bigint,
    costDelta: bigint,
  ): Promise<void> {
    const { tenant_id: tenantId, consumer_account_id: consumerId } = ownerColumns(owner);
    await tx.holding_change.create({
      data: {
        profile_id: profileId,
        tenant_id: tenantId,
        consumer_account_id: consumerId,
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
      insert into nam.holding (profile_id, tenant_id, consumer_account_id, shares, cost_basis)
      values (${profileId}::uuid, ${tenantId}::uuid, ${consumerId}::uuid,
              ${sharesDelta.toString()}::numeric, ${costDelta})
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
    // Each line is a platform account (owner null) or the owner's account for a role.
    lines: readonly (
      | readonly [PlatformType, null, 'debit' | 'credit', bigint]
      | readonly [OwnerRole, NamOwner, 'debit' | 'credit', bigint]
    )[],
  ): Promise<void> {
    const postings = [];
    for (const line of lines) {
      const [, , direction, amount] = line;
      if (amount === 0n) continue;
      const accountId =
        line[1] === null
          ? await this.ledger.findAccount(tx, { tenantId: null, type: line[0], assetCode: USDC })
          : await this.account(tx, line[1], line[0]);
      postings.push({ accountId, direction, amount });
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
