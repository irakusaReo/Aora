import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { concat, encodeFunctionData, type Hex, keccak256, toBytes, toHex } from 'viem';
import { Database, type Tx } from '../../platform/database.js';
import { AuditService } from '../audit/audit.service.js';
import { ReconciliationService } from '../payments/reconciliation.service.js';
import { anchorRegistryAbi } from './abi/AnchorRegistry.js';
import { ChainService } from './chain.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A day is closed only this long after it ends, so late commits are inside it. */
const CLOSE_GRACE_MS = 15 * 60 * 1000;

/**
 * Anchoring of ledger periods (ADR 0015, phase-5 plan P5-10). Each UTC day's
 * journal entries become a salted Merkle tree; only the root, a hash of the
 * period label and the entry count go on chain. The salt stays in the
 * database, so a leaf cannot be confirmed by guessing an entry. No tenant
 * identifier, name or phone number enters a leaf (CLAUDE.md rule 8).
 */
@Injectable()
export class AnchoringService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ChainService) private readonly chain: ChainService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
  ) {}

  /** Closes every finished day that has entries and no period yet. Safe to run twice. */
  async closePeriods(asOf = new Date(), limit = 5): Promise<{ closed: number }> {
    const cutoff = new Date(asOf.getTime() - CLOSE_GRACE_MS);
    const cutoffDay = new Date(
      Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), cutoff.getUTCDate()),
    );
    const days = await this.db.asPlatform(
      (tx) =>
        tx.$queryRaw<{ day: string }[]>`
        select distinct to_char(e.posted_at at time zone 'UTC', 'YYYY-MM-DD') as day
        from ledger.journal_entry e
        where e.posted_at < ${cutoffDay}
          and not exists (
            select 1 from chain.anchor_period p
            where p.label = 'ledger-day:' || to_char(e.posted_at at time zone 'UTC', 'YYYY-MM-DD'))
        order by day
        limit ${limit}`,
    );
    let closed = 0;
    for (const { day } of days) {
      const label = `ledger-day:${day}`;
      const salt = randomBytes(32);
      await this.db.asPlatform(async (tx) => {
        const leaves = await leavesFor(tx, day, salt);
        if (leaves.length === 0) return;
        const inserted = await tx.$queryRaw<{ label: string }[]>`
          insert into chain.anchor_period (label, period_hash, salt, root, entry_count)
          values (${label}, ${keccak256(toBytes(label))}, ${salt}, ${merkleRoot(leaves.map((l) => l.leaf))},
                  ${leaves.length})
          on conflict (label) do nothing
          returning label`;
        if (inserted.length === 0) return;
        for (const leaf of leaves) {
          await tx.anchor_leaf.create({ data: { label, entry_id: leaf.entryId, leaf: leaf.leaf } });
        }
        await this.audit.record(tx, {
          actorKind: 'system',
          action: 'chain.anchor.closed',
          subjectType: 'anchor_period',
          subjectId: label,
          outcome: 'success',
          detail: { entries: leaves.length },
        });
        closed += 1;
      });
    }
    return { closed };
  }

  /**
   * Sends each closed period's root to the AnchorRegistry (once; idempotent per
   * period) and marks it committed when the transaction is confirmed. Off when
   * no registry is deployed.
   */
  async commitPeriods(): Promise<{ submitted: number; committed: number; skipped?: true }> {
    const registry = this.chain.anchorRegistry();
    if (!registry) return { submitted: 0, committed: 0, skipped: true };
    const periods = await this.db.asPlatform((tx) =>
      tx.anchor_period.findMany({
        where: { status: 'closed' },
        orderBy: { label: 'asc' },
        take: 10,
      }),
    );
    let submitted = 0;
    let committed = 0;
    for (const period of periods) {
      const operation = await this.chain.prepareContractCall({
        idempotencyKey: `anchor:${period.label}`,
        kind: 'anchor_commit',
        to: registry,
        data: encodeFunctionData({
          abi: anchorRegistryAbi,
          functionName: 'anchor',
          args: [period.period_hash as Hex, period.root as Hex, BigInt(period.entry_count)],
        }),
      });
      if (period.operation_id === null) {
        await this.db.asPlatform((tx) =>
          tx.anchor_period.update({
            where: { label: period.label },
            data: { operation_id: operation.id },
          }),
        );
      }
      if (operation.status === 'prepared') {
        await this.chain.submit(operation.id);
        submitted += 1;
      } else if (operation.status === 'confirmed') {
        await this.db.asPlatform(async (tx) => {
          await tx.anchor_period.update({
            where: { label: period.label },
            data: { status: 'committed' },
          });
          await this.audit.record(tx, {
            actorKind: 'system',
            action: 'chain.anchor.committed',
            subjectType: 'anchor_period',
            subjectId: period.label,
            outcome: 'success',
            detail: { tx_hash: operation.tx_hash },
          });
        });
        committed += 1;
      } else if (operation.status === 'reverted' || operation.status === 'failed') {
        await this.db.asPlatform((tx) =>
          this.reconciliation.openException(tx, {
            runId: null,
            tenantId: null,
            type: 'anchor_mismatch',
            subjectType: 'anchor_period',
            subjectRef: period.label,
            detail: { problem: `the anchoring transaction ${operation.status}` },
          }),
        );
      }
    }
    return { submitted, committed };
  }

  /**
   * Recomputes each period's root from the ledger with its stored salt, and
   * compares it with the stored root and, once committed, with the root on
   * chain. A difference opens `anchor_mismatch`; nothing is rewritten.
   */
  async verifyPeriods(limit = 10): Promise<{ checked: number; mismatched: number }> {
    const registry = this.chain.anchorRegistry();
    const periods = await this.db.asPlatform((tx) =>
      tx.anchor_period.findMany({ orderBy: { label: 'desc' }, take: limit }),
    );
    let mismatched = 0;
    for (const period of periods) {
      const day = period.label.slice('ledger-day:'.length);
      const recomputed = await this.db.asPlatform(async (tx) =>
        merkleRoot((await leavesFor(tx, day, Buffer.from(period.salt))).map((l) => l.leaf)),
      );
      let onChain: string | null = null;
      if (period.status === 'committed' && registry) {
        const anchor = await this.chain.rpc.client.readContract({
          address: registry,
          abi: anchorRegistryAbi,
          functionName: 'anchorOf',
          args: [period.period_hash as Hex],
        });
        onChain = anchor.root.toLowerCase();
      }
      const ok = recomputed === period.root && (onChain === null || onChain === period.root);
      if (!ok) {
        mismatched += 1;
        await this.db.asPlatform((tx) =>
          this.reconciliation.openException(tx, {
            runId: null,
            tenantId: null,
            type: 'anchor_mismatch',
            subjectType: 'anchor_period',
            subjectRef: period.label,
            detail: { problem: 'the root does not recompute from the ledger or match the chain' },
          }),
        );
      }
    }
    return { checked: periods.length, mismatched };
  }
}

/**
 * One leaf per journal entry of a UTC day: keccak256(salt ‖ entry id ‖ digest),
 * where the digest covers each posting's account type, direction, amount and
 * asset only, in a fixed order. No tenant, person or free text.
 */
async function leavesFor(
  tx: Tx,
  day: string,
  salt: Buffer,
): Promise<{ entryId: string; leaf: string }[]> {
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(start.getTime() + DAY_MS);
  const rows = await tx.$queryRaw<
    { entry_id: string; type: string; direction: string; amount: bigint; asset_code: string }[]
  >`
    select e.id as entry_id, a.type, p.direction, p.amount, p.asset_code
    from ledger.journal_entry e
    join ledger.posting p on p.entry_id = e.id
    join ledger.account a on a.id = p.account_id
    where e.posted_at >= ${start} and e.posted_at < ${end}
    order by e.id, a.type, p.direction, p.amount, p.asset_code`;
  const byEntry = new Map<string, string[]>();
  for (const row of rows) {
    const line = `${row.type}|${row.direction}|${row.amount.toString()}|${row.asset_code}`;
    byEntry.set(row.entry_id, [...(byEntry.get(row.entry_id) ?? []), line]);
  }
  return [...byEntry.entries()].map(([entryId, lines]) => ({
    entryId,
    leaf: keccak256(
      concat([
        toHex(salt),
        toHex(Buffer.from(entryId.replaceAll('-', ''), 'hex')),
        keccak256(toBytes(lines.join('\n'))),
      ]),
    ).toLowerCase(),
  }));
}

/** Merkle root over sorted leaves with sorted-pair hashing; an odd node is carried up. */
export function merkleRoot(leaves: readonly string[]): string {
  if (leaves.length === 0) throw new Error('A period has at least one leaf.');
  let level = [...leaves].map((l) => l.toLowerCase()).sort();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i] as string;
      const b = level[i + 1];
      if (b === undefined) {
        next.push(a);
        continue;
      }
      const [x, y] = a < b ? [a, b] : [b, a];
      next.push(keccak256(concat([x as Hex, y as Hex])).toLowerCase());
    }
    level = next;
  }
  return level[0] as string;
}
