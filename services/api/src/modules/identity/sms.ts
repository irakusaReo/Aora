import { Inject, Injectable } from '@nestjs/common';
import { Database } from '../../platform/database.js';
import type { SmsSender } from './auth-provider.js';

/**
 * SANDBOX ONLY. Sends nothing; stores the message so tests, and an operator
 * holding the inbox token, can read it. Used until an SMS provider's sandbox
 * is connected.
 */
@Injectable()
export class SimulatedSmsSender implements SmsSender {
  readonly name = 'simulated';

  constructor(@Inject(Database) private readonly db: Database) {}

  async send(phoneE164: string, body: string): Promise<void> {
    await this.db.asPlatform((tx) => tx.sim_sms.create({ data: { phone_e164: phoneE164, body } }));
  }
}
