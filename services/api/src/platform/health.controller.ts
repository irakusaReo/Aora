import { Controller, Get, Inject } from '@nestjs/common';
import { Database } from './database.js';

@Controller('v1')
export class HealthController {
  constructor(@Inject(Database) private readonly db: Database) {}

  @Get('health')
  async health(): Promise<{ status: 'ok'; database: 'ok' }> {
    await this.db.asPlatform((tx) => tx.$queryRaw`select 1`);
    return { status: 'ok', database: 'ok' };
  }
}
