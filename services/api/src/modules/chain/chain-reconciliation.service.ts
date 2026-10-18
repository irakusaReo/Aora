import { Inject, Injectable } from '@nestjs/common';
import { erc20Abi } from 'viem';
import { Database } from '../../platform/database.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { ReconciliationService } from '../payments/reconciliation.service.js';
import { exactInteger } from './amounts.js';
import { ChainService } from './chain.service.js';
import { BASE_SEPOLIA } from './config.js';

export interface ChainReconciliationResult {
  readonly skipped: boolean;
  readonly block: bigint | null;
  readonly chain_balance_minor: bigint | null;
  readonly ledger_wallet_minor: bigint | null;
  readonly exceptions_opened: number;
}

/**
 * Three-way reconciliation for USDC on Base Sepolia (phase-5 plan 5C, J10):
 * the chain (the wallet's on-chain balance), the operation records (observed
 * transfers and AORA's own transactions) and the ledger. Each difference opens
 * an exception for an operator; nothing is ever corrected automatically.
 *
 * Runs only when the inbound scan has caught up, and reads the on-chain balance
 * at the scan's last block, so the three sides describe the same moment.
 */
@Injectable()
export class ChainReconciliationService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ChainService) private readonly chain: ChainService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
  ) {}

  async run(): Promise<ChainReconciliationResult> {
    await this.chain.ready();
    const wallet = await this.chain.walletAddress();
    const head = await this.chain.rpc.client.getBlockNumber();
    const cursor = await this.db.asPlatform((tx) =>
      tx.scan_cursor.findUnique({ where: { name: 'wallet_inbound' } }),
    );
    if (!cursor || cursor.last_block < head) {
      return {
        skipped: true,
        block: cursor?.last_block ?? null,
        chain_balance_minor: null,
        ledger_wallet_minor: null,
        exceptions_opened: 0,
      };
    }
    const block = cursor.last_block;
    const chainBalance = await this.chain.rpc.client.readContract({
      address: BASE_SEPOLIA.usdc.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [wallet],
      blockNumber: block,
    });
    const walletKey = wallet.toLowerCase();

    return this.db.asPlatform(async (tx) => {
      const [sums] = await tx.$queryRaw<
        { inbound: string; outbound: string; credited: string; completed: string }[]
      >`
        select
          (select coalesce(sum(amount), 0)::text from chain.observed_transfer
            where asset_code = 'USDC' and status <> 'dropped' and block_number <= ${block}) as inbound,
          (select coalesce(sum(amount), 0)::text from chain.operation
            where kind = 'usdc_transfer' and from_address = ${walletKey}
              and status in ('pending_confirmation', 'confirmed')
              and block_number is not null and block_number <= ${block}) as outbound,
          (select coalesce(sum(amount), 0)::text from chain.observed_transfer
            where status = 'credited') as credited,
          (select coalesce(sum(amount), 0)::text from chain.withdrawal
            where status = 'completed') as completed`;
      const inbound = BigInt(sums?.inbound ?? '0');
      const outbound = BigInt(sums?.outbound ?? '0');
      const credited = BigInt(sums?.credited ?? '0');
      const completed = BigInt(sums?.completed ?? '0');
      const walletAccount = await this.ledger.findAccount(tx, {
        tenantId: null,
        type: 'chain_wallet_usdc',
        assetCode: BASE_SEPOLIA.usdc.assetCode,
      });
      const ledgerWallet = await this.ledger.balanceOf(tx, walletAccount);
      let opened = 0;
      const open = async (
        type: 'chain_balance_mismatch' | 'ledger_mismatch' | 'chain_operation_mismatch',
        subjectType: string,
        subjectRef: string,
        detail: Record<string, string>,
      ): Promise<void> => {
        const created = await this.reconciliation.openException(tx, {
          runId: null,
          tenantId: null,
          type,
          subjectType,
          subjectRef,
          detail,
        });
        if (created) opened += 1;
      };

      // 1. Chain against records: the wallet holds what was observed coming in,
      //    less what AORA's mined transactions sent out.
      if (chainBalance !== inbound - outbound) {
        await open('chain_balance_mismatch', 'wallet', `wallet:${walletKey}`, {
          block: block.toString(),
          on_chain: chainBalance.toString(),
          expected_from_records: (inbound - outbound).toString(),
        });
      }
      // 2. Ledger against records: the wallet account holds what was credited,
      //    less what completed withdrawals sent.
      if (ledgerWallet !== credited - completed) {
        await open('ledger_mismatch', 'ledger_account', 'chain_wallet_usdc', {
          ledger: ledgerWallet.toString(),
          expected_from_records: (credited - completed).toString(),
        });
      }
      // 3. Each record against its counterpart.
      const creditedRows = await tx.observed_transfer.findMany({
        where: { status: 'credited' },
        select: { id: true, amount: true, journal_entry_id: true },
      });
      for (const row of creditedRows) {
        const [posting] = row.journal_entry_id
          ? await tx.$queryRaw<{ amount: bigint }[]>`
              select p.amount from ledger.posting p join ledger.account a on a.id = p.account_id
              where p.entry_id = ${row.journal_entry_id}::uuid and a.type = 'chain_wallet_usdc'
                and p.direction = 'debit'`
          : [];
        if (!posting || posting.amount !== exactInteger(row.amount)) {
          await open('chain_operation_mismatch', 'observed_transfer', row.id, {
            problem: 'credited without a matching journal entry',
          });
        }
      }
      const completedRows = await tx.withdrawal.findMany({ where: { status: 'completed' } });
      for (const row of completedRows) {
        const operation = row.operation_id
          ? await tx.operation.findUnique({ where: { id: row.operation_id } })
          : null;
        const matches =
          operation?.status === 'confirmed' &&
          operation.amount !== null &&
          exactInteger(operation.amount) === row.amount &&
          operation.recipient_address === row.destination;
        if (!matches) {
          await open('chain_operation_mismatch', 'withdrawal', row.id, {
            problem: 'completed without a confirmed matching transaction',
          });
        }
      }
      return {
        skipped: false,
        block,
        chain_balance_minor: chainBalance,
        ledger_wallet_minor: ledgerWallet,
        exceptions_opened: opened,
      };
    });
  }
}
