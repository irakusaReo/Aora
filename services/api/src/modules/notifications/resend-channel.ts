import type { EmailChannel, EmailMessage, SendOutcome } from './channel.js';

/**
 * Resend, the email provider (ADR 0020). The only code that knows it exists.
 *
 * The notification's id is sent as the `Idempotency-Key` header: Resend keeps a
 * key for 24 hours and returns the original result for a repeat instead of
 * sending again. Source: https://resend.com/docs/dashboard/emails/idempotency-keys
 * (read 2026-10-13).
 */
export class ResendEmailChannel implements EmailChannel {
  readonly name = 'resend';

  constructor(
    private readonly options: {
      apiKey: string;
      from: string;
      baseUrl?: string;
      timeoutMs?: number;
    },
  ) {}

  async send(message: EmailMessage): Promise<SendOutcome> {
    let status: number;
    let body: unknown;
    try {
      const response = (await fetch(`${this.options.baseUrl ?? 'https://api.resend.com'}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.options.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      })) as unknown as { status: number; json(): Promise<unknown> };
      status = response.status;
      body = await response.json().catch(() => null);
    } catch {
      // Timeout or connection failure: the message may or may not have been accepted.
      return { kind: 'unknown' };
    }
    const id = typeof body === 'object' && body !== null ? (body as { id?: unknown }).id : null;
    if (status >= 200 && status < 300 && typeof id === 'string') {
      return { kind: 'sent', providerMessageId: id };
    }
    // 409 means the same key is still being processed; 429 and 5xx are transient.
    if (status === 409 || status === 429 || status >= 500 || (status >= 200 && status < 300)) {
      return { kind: 'unknown' };
    }
    return { kind: 'rejected', reason: `http_${String(status)}` };
  }
}
