import { Inject, Injectable } from '@nestjs/common';
import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  maxUint256,
  parseEventLogs,
} from 'viem';
import { AppError } from '../../platform/errors.js';
import { namUsdcVaultAbi } from './abi/NamUsdcVault.js';
import { ChainService, type ChainOperationView } from './chain.service.js';
import { BASE_SEPOLIA } from './config.js';

/** A vault event read from a confirmed receipt, with addresses lowercased. */
export interface VaultEvent {
  readonly sender: string;
  readonly receiver: string | null;
  readonly owner: string;
  readonly assets: bigint;
  readonly shares: bigint;
  readonly logIndex: number;
}

/**
 * Everything the NAM module needs from the NamUsdcVault contract (ADR 0004: only
 * the chain module talks to Base). Addresses come from verified config; the vault
 * is checked once against the chain before first use (phase-6 plan P6-9).
 */
@Injectable()
export class NamVaultGateway {
  private checked: string | null = null;

  constructor(@Inject(ChainService) private readonly chain: ChainService) {}

  /** The configured vault, verified: its asset is native USDC, its guardian AORA's wallet. */
  async vault(): Promise<string> {
    const vault = this.chain.namVault();
    if (!vault) throw new AppError('chain_unavailable', 'The NAM vault is not deployed here.');
    if (this.checked === vault) return vault;
    const wallet = await this.chain.walletAddress();
    const client = this.chain.rpc.client;
    const [asset, guardian] = await Promise.all([
      client.readContract({ address: vault, abi: namUsdcVaultAbi, functionName: 'asset' }),
      client.readContract({ address: vault, abi: namUsdcVaultAbi, functionName: 'guardian' }),
    ]);
    if (
      getAddress(asset) !== getAddress(BASE_SEPOLIA.usdc.address) ||
      getAddress(guardian) !== wallet
    ) {
      throw new AppError(
        'chain_unavailable',
        'The NAM vault does not match its verified configuration.',
      );
    }
    this.checked = vault;
    return vault;
  }

  configured(): boolean {
    return this.chain.namVault() !== null;
  }

  wallet(): Promise<string> {
    return this.chain.walletAddress();
  }

  async convertToAssets(shares: bigint): Promise<bigint> {
    if (shares === 0n) return 0n;
    return this.chain.rpc.client.readContract({
      address: getAddress(await this.vault()),
      abi: namUsdcVaultAbi,
      functionName: 'convertToAssets',
      args: [shares],
    });
  }

  /** Shares AORA's wallet holds in the vault, and the vault's accounted assets. */
  async positions(): Promise<{ walletShares: bigint; accountedAssets: bigint }> {
    const vault = getAddress(await this.vault());
    const wallet = await this.chain.walletAddress();
    const client = this.chain.rpc.client;
    const [walletShares, accountedAssets] = await Promise.all([
      client.readContract({
        address: vault,
        abi: namUsdcVaultAbi,
        functionName: 'balanceOf',
        args: [wallet],
      }),
      client.readContract({
        address: vault,
        abi: namUsdcVaultAbi,
        functionName: 'accountedAssets',
      }),
    ]);
    return { walletShares, accountedAssets };
  }

  /**
   * True once AORA's wallet allows the vault at least `amount`. Otherwise
   * prepares and submits the one-time maximum approval (P6-6) and returns false
   * until it is confirmed.
   */
  async ensureApproval(amount: bigint): Promise<boolean> {
    const vault = getAddress(await this.vault());
    const wallet = await this.chain.walletAddress();
    const allowance = await this.chain.rpc.client.readContract({
      address: BASE_SEPOLIA.usdc.address,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [wallet, vault],
    });
    if (allowance >= amount) return true;
    const operation = await this.chain.prepareContractCall({
      idempotencyKey: `nam_approve:${vault.toLowerCase()}`,
      kind: 'usdc_approve',
      to: BASE_SEPOLIA.usdc.address,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [vault, maxUint256],
      }),
    });
    if (operation.status === 'prepared') await this.chain.submit(operation.id);
    return false;
  }

  /** A deposit of `assets` by AORA's wallet, shares to the wallet. Idempotent per key. */
  async prepareDeposit(
    key: string,
    tenantId: string | null,
    assets: bigint,
  ): Promise<ChainOperationView> {
    const vault = getAddress(await this.vault());
    const wallet = await this.chain.walletAddress();
    return this.chain.prepareContractCall({
      idempotencyKey: key,
      kind: 'vault_deposit',
      tenantId,
      to: vault,
      data: encodeFunctionData({
        abi: namUsdcVaultAbi,
        functionName: 'deposit',
        args: [assets, wallet],
      }),
    });
  }

  /** A redemption of `shares` owned by AORA's wallet, USDC to the wallet. Idempotent per key. */
  async prepareRedeem(
    key: string,
    tenantId: string | null,
    shares: bigint,
  ): Promise<ChainOperationView> {
    const vault = getAddress(await this.vault());
    const wallet = await this.chain.walletAddress();
    return this.chain.prepareContractCall({
      idempotencyKey: key,
      kind: 'vault_redeem',
      tenantId,
      to: vault,
      data: encodeFunctionData({
        abi: namUsdcVaultAbi,
        functionName: 'redeem',
        args: [shares, wallet, wallet],
      }),
    });
  }

  /**
   * The single `Deposit` or `Withdraw` event the vault emitted in a confirmed
   * transaction, or null if there is not exactly one.
   */
  async event(txHash: string, name: 'Deposit' | 'Withdraw'): Promise<VaultEvent | null> {
    const vault = getAddress(await this.vault());
    const receipt = await this.chain.rpc.client.getTransactionReceipt({ hash: txHash as Hex });
    const logs = receipt.logs.filter((log) => getAddress(log.address) === vault);
    if (name === 'Deposit') {
      const events = parseEventLogs({ abi: namUsdcVaultAbi, eventName: 'Deposit', logs });
      const event = events.length === 1 ? events[0] : undefined;
      return event
        ? {
            sender: event.args.sender.toLowerCase(),
            receiver: null,
            owner: event.args.owner.toLowerCase(),
            assets: event.args.assets,
            shares: event.args.shares,
            logIndex: event.logIndex,
          }
        : null;
    }
    const events = parseEventLogs({ abi: namUsdcVaultAbi, eventName: 'Withdraw', logs });
    const event = events.length === 1 ? events[0] : undefined;
    return event
      ? {
          sender: event.args.sender.toLowerCase(),
          receiver: event.args.receiver.toLowerCase(),
          owner: event.args.owner.toLowerCase(),
          assets: event.args.assets,
          shares: event.args.shares,
          logIndex: event.logIndex,
        }
      : null;
  }
}
