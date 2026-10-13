import {
  Controller,
  Get,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Prisma } from '../../generated/prisma/client.js';
import { Database, type Tx } from '../../platform/database.js';
import { sessionOf } from '../../platform/http.js';
import { SessionGuard } from '../identity/guards.js';
import { type OutboxEvent, OutboxService } from '../outbox/outbox.service.js';
import { EMAIL_CHANNEL, type EmailChannel } from './channel.js';
import { maskEmail, renderNotification, renderSignInEmail } from './templates.js';

export const EVENT_DELIVER = 'notifications.deliver';

/** Later delivery events never move a notification backwards from these. */
const FINAL = new Set(['delivered', 'bounced', 'complained', 'failed']);
const EVENT_STATUS: Record<string, string> = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
};

/**
 * Sends messages to people and records what happened (ADR 0020). Business code
 * calls `notify` inside its own transaction; delivery happens through the
 * outbox, once per reason, however often it is requested or retried.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger('Notifications');

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(EMAIL_CHANNEL) private readonly email: EmailChannel,
  ) {}

  onModuleInit(): void {
    this.outbox.register(EVENT_DELIVER, (event) => this.deliver(event));
  }

  /**
   * Records that an account should be told something. `dedupeKey` names the
   * reason; asking again with the same key returns the first notification.
   * `params` feed the template and must never hold a secret, a code or a full
   * phone or account number.
   */
  async notify(
    tx: Tx,
    input: {
      dedupeKey: string;
      accountId: string;
      tenantId: string | null;
      type: string;
      params: Prisma.InputJsonObject;
    },
  ): Promise<string> {
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      insert into notifications.notification (dedupe_key, account_id, tenant_id, channel, type, params)
      values (${input.dedupeKey}, ${input.accountId}::uuid, ${input.tenantId}::uuid, 'email',
              ${input.type}, ${JSON.stringify(input.params)}::jsonb)
      on conflict (dedupe_key) do nothing
      returning id`;
    const created = inserted[0];
    if (!created) {
      const existing = await tx.notification.findUniqueOrThrow({
        where: { dedupe_key: input.dedupeKey },
        select: { id: true },
      });
      return existing.id;
    }
    await this.outbox.enqueue(tx, {
      tenantId: input.tenantId,
      type: EVENT_DELIVER,
      payload: { notification_id: created.id },
    });
    return created.id;
  }

  /** Outbox handler. Safe to run more than once: the provider deduplicates on the notification id. */
  private async deliver(event: OutboxEvent): Promise<void> {
    const payload = event.payload as { notification_id?: unknown };
    const id = typeof payload.notification_id === 'string' ? payload.notification_id : '';
    const row = await this.db.asPlatform((tx) => tx.notification.findUnique({ where: { id } }));
    if (!row || (row.status !== 'queued' && row.status !== 'status_unknown')) return;

    const account = await this.db.asPlatform((tx) =>
      tx.user_account.findUnique({
        where: { id: row.account_id },
        select: { email: true, status: true },
      }),
    );
    if (!account?.email || account.status !== 'active') {
      await this.update(id, { status: 'failed', failure_code: 'no_recipient' });
      return;
    }

    const rendered = renderNotification(
      row.type,
      row.params as Record<string, unknown>,
      row.locale,
    );
    const outcome = await this.email.send({
      idempotencyKey: row.id,
      to: account.email,
      ...rendered,
    });
    const common = {
      attempts: { increment: 1 },
      provider: this.email.name,
      recipient_masked: maskEmail(account.email),
      subject: rendered.subject,
    };
    if (outcome.kind === 'sent') {
      await this.update(id, {
        ...common,
        status: 'sent',
        provider_message_id: outcome.providerMessageId,
        sent_at: new Date(),
        failure_code: null,
      });
    } else if (outcome.kind === 'rejected') {
      await this.update(id, { ...common, status: 'failed', failure_code: outcome.reason });
    } else {
      await this.update(id, { ...common, status: 'status_unknown' });
      // Retried by the outbox with the same idempotency key, so it cannot send twice.
      throw new DeliveryUnknown();
    }
  }

  /**
   * Delivers a sign-in message prepared by the identity provider, immediately:
   * a code that arrives late is useless. It is sent and never stored: no
   * notification row, no outbox payload, no log line carries its content.
   */
  async sendSignInEmail(input: {
    deliveryId: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<void> {
    const rendered = renderSignInEmail(input);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await this.email.send({
        idempotencyKey: input.deliveryId,
        to: input.to,
        ...rendered,
      });
      if (outcome.kind === 'sent') return;
      if (outcome.kind === 'rejected') {
        this.logger.warn(
          `sign-in email ${input.deliveryId} was rejected by the email provider (${outcome.reason})`,
        );
        throw new SignInEmailFailed();
      }
    }
    this.logger.warn(`sign-in email ${input.deliveryId} could not be confirmed as sent`);
    throw new SignInEmailFailed();
  }

  /** Applies a delivery event from the provider. Returns false if this delivery was already handled. */
  async applyDeliveryEvent(
    deliveryId: string,
    type: string,
    providerMessageId: string,
  ): Promise<boolean> {
    return this.db.asPlatform(async (tx) => {
      const row = await tx.notification.findUnique({
        where: { provider_message_id: providerMessageId },
      });
      const fresh = await tx.$queryRaw<{ id: string }[]>`
        insert into notifications.delivery_event (id, notification_id, type)
        values (${deliveryId}, ${row?.id ?? null}::uuid, ${type})
        on conflict (id) do nothing returning id`;
      if (fresh.length === 0) return false;
      const status = EVENT_STATUS[type];
      if (row && status && !FINAL.has(row.status)) {
        await tx.notification.update({
          where: { id: row.id },
          data: { status, last_event_at: new Date() },
        });
      }
      return true;
    });
  }

  async listFor(accountId: string): Promise<NotificationView[]> {
    const rows = await this.db.asPlatform((tx) =>
      tx.notification.findMany({
        where: { account_id: accountId },
        orderBy: { created_at: 'desc' },
        take: 100,
      }),
    );
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      channel: row.channel,
      status: row.status,
      subject: row.subject,
      sent_to: row.recipient_masked,
      created_at: row.created_at.toISOString(),
      sent_at: row.sent_at?.toISOString() ?? null,
    }));
  }

  private async update(id: string, data: Prisma.notificationUpdateInput): Promise<void> {
    await this.db.asPlatform((tx) => tx.notification.update({ where: { id }, data }));
  }
}

export interface NotificationView {
  readonly id: string;
  readonly type: string;
  readonly channel: string;
  readonly status: string;
  readonly subject: string | null;
  /** Masked: `j•••@example.com`. */
  readonly sent_to: string | null;
  readonly created_at: string;
  readonly sent_at: string | null;
}

class DeliveryUnknown extends Error {}
export class SignInEmailFailed extends Error {}

@Controller('v1/notifications')
@UseGuards(SessionGuard)
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  /** What AORA has sent the signed-in person, and what became of it. */
  @Get()
  async list(@Req() request: Request): Promise<{ data: NotificationView[] }> {
    return { data: await this.notifications.listFor(sessionOf(request).accountId) };
  }
}
