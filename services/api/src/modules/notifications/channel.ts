import { Inject, Injectable } from '@nestjs/common';
import { Database } from '../../platform/database.js';

export interface EmailMessage {
  /** The same key never sends twice, however often it is retried. */
  readonly idempotencyKey: string;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/**
 * `unknown` means the provider may or may not have sent the message (timeout,
 * server error). The caller retries with the SAME idempotency key.
 */
export type SendOutcome =
  | { readonly kind: 'sent'; readonly providerMessageId: string }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'unknown' };

/** A way of reaching a person. Email now; SMS and push can implement the same shape later. */
export interface EmailChannel {
  readonly name: string;
  send(message: EmailMessage): Promise<SendOutcome>;
}

export const EMAIL_CHANNEL = Symbol('EMAIL_CHANNEL');

/** SANDBOX ONLY. Sends nothing; stores the message for tests and local development. */
@Injectable()
export class SimulatedEmailChannel implements EmailChannel {
  readonly name = 'simulated';

  constructor(@Inject(Database) private readonly db: Database) {}

  async send(message: EmailMessage): Promise<SendOutcome> {
    await this.db.asPlatform(
      (tx) => tx.$executeRaw`
        insert into sim.sim_email (idempotency_key, to_address, subject, html, body_text)
        values (${message.idempotencyKey}, ${message.to}, ${message.subject}, ${message.html}, ${message.text})
        on conflict (idempotency_key) do nothing`,
    );
    return { kind: 'sent', providerMessageId: `sim_${message.idempotencyKey}` };
  }
}
