import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Webhook } from 'svix';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';
import { ResendEmailChannel } from '../src/modules/notifications/resend-channel.js';
import { maskEmail, maskPhone } from '../src/modules/notifications/templates.js';
import { OutboxService } from '../src/modules/outbox/outbox.service.js';
import { type Harness, startHarness } from './support/harness.js';
import { type Caller, createIntent } from './support/payments.js';

let h: Harness;
let notifications: NotificationsService;

beforeAll(async () => {
  h = await startHarness();
  notifications = h.app.get(NotificationsService);
});
afterAll(() => h.close());

const emails = (to: string) =>
  h.owner(async (client) => {
    const result = await client.query<{
      idempotency_key: string;
      subject: string;
      html: string;
      body_text: string;
    }>(
      `select idempotency_key, subject, html, body_text from sim.sim_email where to_address = $1 order by created_at`,
      [to],
    );
    return result.rows;
  });

const notify = (key: string, accountId = h.seed.accounts.financeA) =>
  h.db.asPlatform((tx) =>
    notifications.notify(tx, {
      dedupeKey: key,
      accountId,
      tenantId: h.seed.tenantA,
      type: 'payment.received',
      params: { amount_minor: '15000', currency: 'KES', reference: 'ref-1' },
    }),
  );

describe('sending through the outbox', () => {
  it('sends once per reason, however often it is requested or delivered', async () => {
    const key = `test:${randomUUID()}`;
    const first = await notify(key);
    const second = await notify(key);
    expect(second).toBe(first);
    await h.settle();

    // Deliver the same outbox event again, as an at-least-once queue may.
    await h.db.asPlatform((tx) =>
      h.app.get(OutboxService).enqueue(tx, {
        tenantId: null,
        type: 'notifications.deliver',
        payload: { notification_id: first },
      }),
    );
    await h.settle();

    const sent = await emails('financeA@sandbox.aora.test');
    expect(sent.filter((email) => email.idempotency_key === first)).toHaveLength(1);
    const row = await h.owner((client) =>
      client.query(
        `select status, attempts, provider, recipient_masked from notifications.notification where id = $1`,
        [first],
      ),
    );
    expect(row.rows[0]).toMatchObject({ status: 'sent', provider: 'simulated' });
  });

  it('does not exist if the transaction that asked for it rolls back', async () => {
    const key = `rollback:${randomUUID()}`;
    await expect(
      h.db.asPlatform(async (tx) => {
        await notifications.notify(tx, {
          dedupeKey: key,
          accountId: h.seed.accounts.financeA,
          tenantId: null,
          type: 'payment.received',
          params: { amount_minor: '1', currency: 'KES', reference: 'x' },
        });
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    const rows = await h.owner((client) =>
      client.query(`select count(*) as n from notifications.notification where dedupe_key = $1`, [
        key,
      ]),
    );
    expect(rows.rows[0]?.n).toBe('0');
  });

  it('marks a notification failed, without retrying for ever, when the account has no email address', async () => {
    const id = await notify(`noemail:${randomUUID()}`, h.seed.accounts.operator);
    await h.owner((client) =>
      client.query(`update identity.user_account set email = null where id = $1`, [
        h.seed.accounts.operator,
      ]),
    );
    await h.settle();
    const row = await h.owner((client) =>
      client.query(`select status, failure_code from notifications.notification where id = $1`, [
        id,
      ]),
    );
    expect(row.rows[0]).toEqual({ status: 'failed', failure_code: 'no_recipient' });
  });
});

describe('email content', () => {
  it('alerts the person who took a payment, marked sandbox, with nothing that authorises an action', async () => {
    const cashier: Caller = { token: await h.signIn('cashierA'), workspace: h.seed.tenantA };
    await createIntent(h, cashier, { amount_minor: '15000', currency: 'KES' });
    await h.settle();
    const sent = await emails('cashierA@sandbox.aora.test');
    expect(sent).toHaveLength(1);
    const email = sent[0];
    expect(email?.subject).toMatch(/^\[SANDBOX\] /);
    expect(email?.body_text).toContain('KES 150.00');
    expect(email?.body_text).toMatch(/sandbox/i);
    expect(email?.html).toMatch(/SANDBOX/);
    for (const part of [email?.html ?? '', email?.body_text ?? '']) {
      expect(part).not.toMatch(/https?:\/\/[^\s"]*(token|code|key|sig)=/i);
      expect(part).not.toContain(cashier.token);
      expect(part).not.toContain(h.seed.tenantA);
    }
  });

  it('masks email addresses and phone numbers', () => {
    expect(maskEmail('jane.doe@example.com')).toBe('j•••@example.com');
    expect(maskEmail('a@b.co')).toBe('a•••@b.co');
    expect(maskPhone('+254712345678')).toBe('•••678');
    expect(maskPhone(null)).toBe('');
  });

  it('stores the recipient only in masked form', async () => {
    const rows = await h.owner((client) =>
      client.query<{ row: string; recipient_masked: string }>(
        `select notification::text as row, recipient_masked from notifications.notification where recipient_masked is not null`,
      ),
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row.recipient_masked).toMatch(/^.•••@/);
      expect(row.row).not.toMatch(/[a-zA-Z]{3,}@sandbox\.aora\.test/);
    }
  });
});

describe('delivery status from the email provider', () => {
  function resendEvent(type: string, emailId: string, id = `msg_${randomUUID()}`) {
    const payload = JSON.stringify({
      type,
      created_at: new Date().toISOString(),
      data: { email_id: emailId },
    });
    const timestamp = new Date();
    return h
      .http()
      .post('/v1/webhooks/resend')
      .set('Content-Type', 'application/json')
      .set('svix-id', id)
      .set('svix-timestamp', String(Math.floor(timestamp.getTime() / 1000)))
      .set(
        'svix-signature',
        new Webhook(h.config.email.webhookSecret ?? '').sign(id, timestamp, payload),
      )
      .send(payload);
  }

  const sentNotification = async () => {
    const id = await notify(`status:${randomUUID()}`);
    await h.settle();
    const row = await h.owner((client) =>
      client.query<{ provider_message_id: string }>(
        `select provider_message_id from notifications.notification where id = $1`,
        [id],
      ),
    );
    return { id, messageId: row.rows[0]?.provider_message_id ?? '' };
  };
  const statusOf = async (id: string) =>
    (
      await h.owner((client) =>
        client.query(`select status from notifications.notification where id = $1`, [id]),
      )
    ).rows[0]?.status as string;

  it('moves to delivered on a signed event, once', async () => {
    const { id, messageId } = await sentNotification();
    const delivery = `msg_${randomUUID()}`;
    expect((await resendEvent('email.delivered', messageId, delivery)).status).toBe(200);
    expect((await resendEvent('email.delivered', messageId, delivery)).status).toBe(200);
    expect(await statusOf(id)).toBe('delivered');
    const events = await h.owner((client) =>
      client.query(
        `select count(*) as n from notifications.delivery_event where notification_id = $1`,
        [id],
      ),
    );
    expect(events.rows[0]?.n).toBe('1');
  });

  it('records a bounce, and a late "sent" event does not overwrite it', async () => {
    const { id, messageId } = await sentNotification();
    await resendEvent('email.bounced', messageId);
    await resendEvent('email.sent', messageId);
    expect(await statusOf(id)).toBe('bounced');
  });

  it('rejects an unsigned or forged event', async () => {
    const { id, messageId } = await sentNotification();
    const payload = JSON.stringify({ type: 'email.delivered', data: { email_id: messageId } });
    const response = await h
      .http()
      .post('/v1/webhooks/resend')
      .set('Content-Type', 'application/json')
      .set('svix-id', 'msg_x')
      .set('svix-timestamp', String(Math.floor(Date.now() / 1000)))
      .set('svix-signature', 'v1,' + Buffer.from('forged').toString('base64'))
      .send(payload);
    expect(response.status).toBe(401);
    expect(await statusOf(id)).toBe('sent');
  });

  it('acknowledges an event for a message it does not know', async () => {
    expect((await resendEvent('email.delivered', `unknown-${randomUUID()}`)).status).toBe(200);
  });
});

describe('what people can see', () => {
  it('lists a person their own notifications and nobody else’s', async () => {
    const finance = await h.signIn('financeA');
    const other = await h.signIn('adminB');
    const mine = await h.http().get('/v1/notifications').set('Authorization', `Bearer ${finance}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data.length).toBeGreaterThan(0);
    expect(mine.body.data[0]).toMatchObject({
      type: 'payment.received',
      channel: 'email',
      status: expect.any(String),
    });
    expect(JSON.stringify(mine.body)).not.toContain('financeA@');
    expect(mine.body.data[0].sent_to).toMatch(/^f•••@/);
    const theirs = await h.http().get('/v1/notifications').set('Authorization', `Bearer ${other}`);
    expect(theirs.body.data).toEqual([]);
    expect((await h.http().get('/v1/notifications')).status).toBe(401);
  });
});

describe('sign-in emails handed over by Clerk', () => {
  it('are delivered through the email channel and the code is stored nowhere', async () => {
    const code = '918273';
    const to = `signin.${randomUUID().slice(0, 8)}@sandbox.aora.test`;
    const id = `msg_${randomUUID()}`;
    const payload = JSON.stringify({
      type: 'email.created',
      object: 'event',
      data: {
        id: `ema_${randomUUID()}`,
        slug: 'verification_code',
        to_email_address: to,
        subject: `${code} is your verification code`,
        body: `<p>Your code is <b>${code}</b></p>`,
        body_plain: `Your code is ${code}`,
        data: { otp_code: code },
        user_id: null,
      },
    });
    const timestamp = new Date();
    const response = await h
      .http()
      .post('/v1/webhooks/clerk')
      .set('Content-Type', 'application/json')
      .set('svix-id', id)
      .set('svix-timestamp', String(Math.floor(timestamp.getTime() / 1000)))
      .set(
        'svix-signature',
        new Webhook(h.config.clerk.webhookSigningSecret).sign(id, timestamp, payload),
      )
      .send(payload);
    expect(response.status).toBe(200);

    const sent = await emails(to);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toMatch(/^\[SANDBOX\] /);
    expect(sent[0]?.body_text).toContain(code);
    expect(sent[0]?.idempotency_key).toBe(id);

    const leaks = await h.owner((client) =>
      client.query(
        `select
           (select count(*) from notifications.notification where notification::text like '%' || $1 || '%') as notifications,
           (select count(*) from outbox.outbox_event where outbox_event::text like '%' || $1 || '%') as outbox,
           (select count(*) from audit.audit_event where audit_event::text like '%' || $1 || '%') as audit,
           (select count(*) from identity.provider_event where provider_event::text like '%' || $1 || '%') as events`,
        [code],
      ),
    );
    expect(leaks.rows[0]).toEqual({ notifications: '0', outbox: '0', audit: '0', events: '0' });
    expect(h.logs.join('\n')).not.toContain(code);

    // The same delivery again sends nothing more.
    await h
      .http()
      .post('/v1/webhooks/clerk')
      .set('Content-Type', 'application/json')
      .set('svix-id', id)
      .set('svix-timestamp', String(Math.floor(timestamp.getTime() / 1000)))
      .set(
        'svix-signature',
        new Webhook(h.config.clerk.webhookSigningSecret).sign(id, timestamp, payload),
      )
      .send(payload);
    expect(await emails(to)).toHaveLength(1);
  });
});

describe('Resend adapter', () => {
  const requests: { headers: IncomingMessage['headers']; body: string }[] = [];
  let reply: { status: number; body: string; delayMs?: number } = {
    status: 200,
    body: '{"id":"re_123"}',
  };
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      requests.push({ headers: request.headers, body });
      setTimeout(() => {
        response.writeHead(reply.status, { 'content-type': 'application/json' });
        response.end(reply.body);
      }, reply.delayMs ?? 0);
    });
  });
  let channel: ResendEmailChannel;
  const message = {
    idempotencyKey: 'key-1',
    to: 'delivered@resend.dev',
    subject: '[SANDBOX] Hi',
    html: '<p>Hi</p>',
    text: 'Hi',
  };

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    channel = new ResendEmailChannel({
      apiKey: 're_test_key',
      from: 'AORA Sandbox <onboarding@resend.dev>',
      baseUrl: `http://127.0.0.1:${String(port)}`,
      timeoutMs: 300,
    });
  });
  afterAll(
    () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  );

  it('sends the idempotency key and bearer key, and returns the provider id', async () => {
    reply = { status: 200, body: '{"id":"re_123"}' };
    expect(await channel.send(message)).toEqual({ kind: 'sent', providerMessageId: 're_123' });
    const last = requests.at(-1);
    expect(last?.headers['idempotency-key']).toBe('key-1');
    expect(last?.headers.authorization).toBe('Bearer re_test_key');
    expect(JSON.parse(last?.body ?? '{}')).toMatchObject({
      to: ['delivered@resend.dev'],
      subject: '[SANDBOX] Hi',
      from: 'AORA Sandbox <onboarding@resend.dev>',
    });
  });

  it('reports a refusal as rejected and a timeout or server error as unknown', async () => {
    reply = {
      status: 403,
      body: '{"name":"validation_error","message":"You can only send testing emails to your own email address"}',
    };
    expect(await channel.send(message)).toEqual({ kind: 'rejected', reason: 'http_403' });
    reply = { status: 500, body: '{}' };
    expect(await channel.send(message)).toEqual({ kind: 'unknown' });
    reply = { status: 200, body: '{"id":"late"}', delayMs: 1000 };
    expect(await channel.send(message)).toEqual({ kind: 'unknown' });
    reply = { status: 409, body: '{"name":"concurrent_idempotent_requests"}' };
    expect(await channel.send(message)).toEqual({ kind: 'unknown' });
  });
});
