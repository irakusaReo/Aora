import { Controller, HttpCode, Inject, Logger, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Webhook } from 'svix';
import { APP_CONFIG, type AppConfig } from '../../platform/config.js';
import { Database } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { IdentityService } from '../identity/identity.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';

interface Verified {
  readonly id: string;
  readonly event: { type?: unknown; data?: unknown };
}

/**
 * Clerk and Resend both sign webhooks with Svix: the signature covers the raw
 * request body and the `svix-id` and `svix-timestamp` headers. `svix-id`
 * identifies the delivery and is what makes handling idempotent.
 */
function verify(request: Request, secret: string | null): Verified {
  const headers = {
    'svix-id': request.header('svix-id') ?? '',
    'svix-timestamp': request.header('svix-timestamp') ?? '',
    'svix-signature': request.header('svix-signature') ?? '',
  };
  try {
    if (!secret || !request.rawBody) throw new Error('not configured');
    const raw = request.rawBody.toString('utf8');
    // Verification throws on a bad signature or a stale timestamp. The body is
    // parsed only after it has been authenticated.
    new Webhook(secret).verify(raw, headers);
    return { id: headers['svix-id'], event: JSON.parse(raw) as Verified['event'] };
  } catch {
    throw new AppError('invalid_signature', 'Webhook signature is missing or invalid.');
  }
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

@Controller('v1/webhooks')
export class ProviderWebhooksController {
  private readonly logger = new Logger('ProviderWebhooks');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(Database) private readonly db: Database,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  /** Identity provider events: user sync, and sign-in emails handed to AORA for delivery. */
  @Post('clerk')
  @HttpCode(200)
  async clerk(@Req() request: Request): Promise<{ received: true }> {
    const { id, event } = verify(request, this.config.clerk.webhookSigningSecret);
    const type = str(event.type) ?? 'unknown';
    const data = (event.data ?? {}) as Record<string, unknown>;

    // Sign-in emails are time-critical and must not be recorded: handled first, stored nowhere.
    if (type === 'email.created' || type === 'emails.created') {
      const to = str(data['to_email_address']);
      const subject = str(data['subject']);
      const html = str(data['body']);
      if (!to || !subject || !html) {
        this.logger.warn(`email event ${id} did not have the expected fields`);
        throw new AppError('invalid_request', 'Unrecognised email event.');
      }
      await this.notifications.sendSignInEmail({
        deliveryId: id,
        to,
        subject,
        html,
        text: str(data['body_plain']) ?? subject,
      });
      return { received: true };
    }

    // Everything else is processed once per delivery. The delivery is recorded
    // only after its work succeeds, so a failure is retried by the provider; the
    // work itself is idempotent, so a repeat before the record lands is harmless.
    if (await this.seen(id)) return { received: true };
    const subjectId = str(data['id']);
    if (!subjectId) return { received: true };

    if (type === 'user.created' || type === 'user.updated') {
      const emails = (data['email_addresses'] ?? []) as { id?: unknown; email_address?: unknown }[];
      const phones = (data['phone_numbers'] ?? []) as { id?: unknown; phone_number?: unknown }[];
      const email =
        emails.find((entry) => entry.id === data['primary_email_address_id']) ?? emails[0];
      const phone =
        phones.find((entry) => entry.id === data['primary_phone_number_id']) ?? phones[0];
      const name = [str(data['first_name']), str(data['last_name'])].filter(Boolean).join(' ');
      // Only email, phone and name are read. Provider metadata is deliberately ignored.
      await this.identity.upsertFromProvider({
        subject: subjectId,
        updatedAt: typeof data['updated_at'] === 'number' ? data['updated_at'] : Date.now(),
        email: str(email?.email_address),
        phoneE164: str(phone?.phone_number),
        displayName: name === '' ? null : name,
      });
    } else if (type === 'user.deleted') {
      await this.identity.closeFromProvider(subjectId);
    }
    await this.record(id, 'clerk', type);
    return { received: true };
  }

  /** Email provider events: delivery status of notifications. */
  @Post('resend')
  @HttpCode(200)
  async resend(@Req() request: Request): Promise<{ received: true }> {
    const { id, event } = verify(request, this.config.email.webhookSecret);
    const data = (event.data ?? {}) as Record<string, unknown>;
    const messageId = str(data['email_id']);
    if (messageId) {
      await this.notifications.applyDeliveryEvent(id, str(event.type) ?? 'unknown', messageId);
    }
    return { received: true };
  }

  private async seen(id: string): Promise<boolean> {
    const row = await this.db.asPlatform((tx) => tx.provider_event.findUnique({ where: { id } }));
    return row !== null;
  }

  private async record(id: string, provider: string, type: string): Promise<void> {
    await this.db.asPlatform(
      (tx) => tx.$executeRaw`
        insert into identity.provider_event (id, provider, type) values (${id}, ${provider}, ${type})
        on conflict (id) do nothing`,
    );
  }
}
