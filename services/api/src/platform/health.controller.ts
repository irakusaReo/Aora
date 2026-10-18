import { Controller, Get, Inject } from '@nestjs/common';
import { Database } from './database.js';

/** What health needs from the chain module, bound in AppModule (platform imports no module). */
export interface ChainHealthSource {
  status(): string;
  ready(): Promise<unknown>;
}
export const CHAIN_HEALTH = Symbol('CHAIN_HEALTH');

@Controller('v1')
export class HealthController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CHAIN_HEALTH) private readonly chain: ChainHealthSource,
  ) {}

  /**
   * `chain` reports the Base Sepolia startup verification (ADR 0004): `verified`,
   * `failed:<reason>` (every chain feature refuses), or `not_configured`.
   */
  @Get('health')
  async health(): Promise<{ status: 'ok'; database: 'ok'; chain: string }> {
    await this.db.asPlatform((tx) => tx.$queryRaw`select 1`);
    if (this.chain.status() !== 'not_configured') await this.chain.ready().catch(() => undefined);
    return { status: 'ok', database: 'ok', chain: this.chain.status() };
  }
}
