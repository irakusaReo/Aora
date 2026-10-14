import { constants, createHmac, publicEncrypt, timingSafeEqual } from 'node:crypto';
import type { DarajaConfig } from '../../platform/config.js';
import type { CapabilityDeclaration, MoneyOutcome, ProviderAdapter } from './adapter.js';
import { DARAJA_SANDBOX_CERTIFICATE } from './daraja-sandbox-certificate.js';

/** Name of the Daraja provider; also the qualifier of its clearing account. */
export const DARAJA_PROVIDER = 'daraja';

/** What a Daraja STK push callback says (docs/providers/daraja.md). */
export interface DarajaCallback {
  readonly checkoutId: string;
  readonly merchantId: string | null;
  readonly resultCode: string;
  /** The `Amount` item exactly as sent, as decimal text; null when absent. */
  readonly amountText: string | null;
  readonly receipt: string | null;
}

/** A B2C result, or a Transaction Status result, reduced to what AORA decides on. */
export interface DarajaPayoutResult {
  /** The payout id AORA sent as OriginatorConversationID. */
  readonly payoutId: string;
  readonly outcome: 'succeeded' | 'failed' | 'pending';
  /** Decimal text exactly as sent; null when absent. */
  readonly amountText: string | null;
  readonly receipt: string | null;
  readonly resultCode: string;
}

/** Each kind of callback URL has its own token, so one cannot be used for another. */
export type CallbackPurpose = 'stk' | 'b2c' | 'b2c_status';

export type DarajaQueryResult =
  | { readonly kind: 'succeeded' }
  | { readonly kind: 'failed'; readonly resultCode: string }
  | { readonly kind: 'pending'; readonly resultCode: string | null }
  | { readonly kind: 'unknown' };

/**
 * The part of a fetch reply this adapter reads. Typed structurally because the
 * hosting platform's build resolves the global `Response` type differently from
 * a local build (the same reason as in jobs.ts).
 */
interface Reply {
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

interface CachedToken {
  readonly value: string;
  readonly expiresAt: number;
}

/** A refusal Daraja documents as happening before anything is processed: safe to call again once. */
const INVALID_TOKEN = '404.001.03';

/**
 * SANDBOX ONLY. Safaricom Daraja M-Pesa Express (STK push) and its status
 * query, as documented on the Daraja portal and recorded with sources in
 * docs/providers/daraja.md. Never retries a money-moving call, except once
 * after Daraja's documented "Invalid Access Token" refusal, which happens at
 * the gateway before the request is processed (ADR 0022).
 */
export class DarajaAdapter implements ProviderAdapter {
  readonly declaration: CapabilityDeclaration = {
    provider: DARAJA_PROVIDER,
    rail: 'mpesa',
    country: 'KE',
    assets: ['KES'],
    capabilities: ['collect', 'status_inquiry', 'webhook'],
  };

  private token: CachedToken | null = null;
  private pendingToken: Promise<string> | null = null;

  constructor(private readonly config: DarajaConfig) {}

  /** The unguessable part of a callback URL for one operation. */
  callbackToken(operationId: string, purpose: CallbackPurpose = 'stk'): string {
    return createHmac('sha256', this.config.callbackSecret)
      .update(`${purpose}:${operationId}`)
      .digest('hex');
  }

  verifyCallbackToken(
    operationId: string,
    token: string,
    purpose: CallbackPurpose = 'stk',
  ): boolean {
    const expected = Buffer.from(this.callbackToken(operationId, purpose));
    const given = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /**
   * True if a callback may come from this address. With no allow-list configured
   * every address is accepted: the token and the status query are the controls,
   * and the published list is not yet confirmed for the sandbox.
   */
  allowedSource(ip: string | null): boolean {
    const list = this.config.callbackAllowedIps ?? [];
    return list.length === 0 || (ip !== null && list.includes(ip));
  }

  /** The Daraja test number in AORA's E.164 form: in the sandbox, the only payer allowed. */
  get testPayer(): string {
    return `+${this.config.testMsisdn}`;
  }

  async stkPush(input: {
    operationId: string;
    amount: bigint;
    exponent: number;
    msisdn: string;
    callbackUrl: string;
  }): Promise<MoneyOutcome & { merchantRequestId?: string }> {
    const unit = 10n ** BigInt(input.exponent);
    if (input.amount % unit !== 0n) {
      return { kind: 'rejected', reason: 'amount_not_whole_units' };
    }
    const timestamp = nairobiTimestamp();
    const body = {
      BusinessShortCode: this.config.shortcode,
      Password: this.password(timestamp),
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: (input.amount / unit).toString(),
      PartyA: input.msisdn,
      PartyB: this.config.shortcode,
      PhoneNumber: input.msisdn,
      CallBackURL: input.callbackUrl,
      // At most 12 characters, shown to the customer.
      AccountReference: `AORA${input.operationId.replaceAll('-', '').slice(0, 8).toUpperCase()}`,
      // At most 13 characters.
      TransactionDesc: 'AORA sandbox',
    };
    const reply = await this.call('/mpesa/stkpush/v1/processrequest', body);
    if (reply.kind === 'unreachable') return { kind: 'unknown' };
    const { status, json } = reply;
    if (
      status === 200 &&
      json['ResponseCode'] === '0' &&
      typeof json['CheckoutRequestID'] === 'string'
    ) {
      return {
        kind: 'accepted',
        providerReference: json['CheckoutRequestID'],
        ...(typeof json['MerchantRequestID'] === 'string'
          ? { merchantRequestId: json['MerchantRequestID'] }
          : {}),
      };
    }
    // Refusals the gateway documents (or was observed to give) before processing anything.
    if (status === 429) return { kind: 'rejected', reason: 'provider_busy' };
    if (status === 200 || status === 400 || status === 404) {
      return { kind: 'rejected', reason: 'provider_rejected' };
    }
    if (status === 500 && json['errorCode'] === '500.001.1001') {
      return { kind: 'rejected', reason: 'provider_rejected' };
    }
    // Anything else (other 5xx, an unrecognised body) may or may not have been processed.
    return { kind: 'unknown' };
  }

  get payoutsEnabled(): boolean {
    return Boolean(this.config.b2c);
  }

  /**
   * A B2C payment to a customer. `OriginatorConversationID` is AORA's payout
   * id, so Daraja refuses a second request with the same id ("Duplicate
   * OriginatorConversationID"); that refusal means an earlier request exists,
   * so it is treated as unknown, never as a failure.
   */
  async b2cPayment(input: {
    payoutId: string;
    amount: bigint;
    exponent: number;
    msisdn: string;
    resultUrl: string;
  }): Promise<MoneyOutcome> {
    const b2c = this.config.b2c;
    if (!b2c) return { kind: 'rejected', reason: 'provider_not_configured' };
    const unit = 10n ** BigInt(input.exponent);
    if (input.amount % unit !== 0n) return { kind: 'rejected', reason: 'amount_not_whole_units' };
    const reply = await this.call('/mpesa/b2c/v3/paymentrequest', {
      OriginatorConversationID: input.payoutId,
      InitiatorName: b2c.initiatorName,
      SecurityCredential: this.securityCredential(),
      CommandID: 'BusinessPayment',
      Amount: (input.amount / unit).toString(),
      PartyA: b2c.shortcode,
      PartyB: input.msisdn,
      Remarks: 'AORA sandbox payout',
      QueueTimeOutURL: input.resultUrl,
      ResultURL: input.resultUrl,
    });
    if (reply.kind === 'unreachable') return { kind: 'unknown' };
    const { status, json } = reply;
    if (status === 200 && json['ResponseCode'] === '0') {
      const conversation = json['ConversationID'];
      return {
        kind: 'accepted',
        providerReference: typeof conversation === 'string' ? conversation : input.payoutId,
      };
    }
    if (json['errorCode'] === '500.002.1001') return { kind: 'unknown' };
    if (status === 429) return { kind: 'rejected', reason: 'provider_busy' };
    if (status === 400 || status === 404) return { kind: 'rejected', reason: 'provider_rejected' };
    return { kind: 'unknown' };
  }

  /** Asks for a payout's status. Asynchronous: the answer arrives at `resultUrl`. */
  async transactionStatus(input: { payoutId: string; resultUrl: string }): Promise<boolean> {
    const b2c = this.config.b2c;
    if (!b2c) return false;
    const reply = await this.call('/mpesa/transactionstatus/v1/query', {
      Initiator: b2c.initiatorName,
      SecurityCredential: this.securityCredential(),
      CommandID: 'TransactionStatusQuery',
      OriginalConversationID: input.payoutId,
      PartyA: b2c.shortcode,
      IdentifierType: '4',
      ResultURL: input.resultUrl,
      QueueTimeOutURL: input.resultUrl,
      Remarks: 'AORA status',
    });
    return reply.kind === 'reply' && reply.status === 200 && reply.json['ResponseCode'] === '0';
  }

  /** Reads a B2C result body. Amounts are taken as decimal text from the raw body. */
  parseB2cResult(raw: string): DarajaPayoutResult {
    const result = (JSON.parse(raw) as { Result?: Record<string, unknown> }).Result;
    const payoutId = result?.['OriginatorConversationID'];
    const code = result?.['ResultCode'];
    if (typeof payoutId !== 'string' || (typeof code !== 'string' && typeof code !== 'number')) {
      throw new Error('Not a B2C result.');
    }
    const resultCode = String(code);
    return {
      payoutId,
      outcome: resultCode === '0' ? 'succeeded' : 'failed',
      amountText: parameterText(raw, 'TransactionAmount'),
      receipt: parameterText(raw, 'TransactionReceipt'),
      resultCode,
    };
  }

  /** Reads a Transaction Status result body for a payout. */
  parseStatusResult(raw: string): DarajaPayoutResult {
    const result = (JSON.parse(raw) as { Result?: Record<string, unknown> }).Result;
    const code = result?.['ResultCode'];
    const payoutId = parameterText(raw, 'OriginatorConversationID');
    if (!payoutId || (typeof code !== 'string' && typeof code !== 'number')) {
      throw new Error('Not a status result.');
    }
    const status = parameterText(raw, 'TransactionStatus');
    // Final statuses per the documentation: Completed; Cancelled, Declined or Expired.
    const outcome =
      String(code) !== '0'
        ? 'pending'
        : status === 'Completed'
          ? 'succeeded'
          : status === 'Cancelled' || status === 'Declined' || status === 'Expired'
            ? 'failed'
            : 'pending';
    return {
      payoutId,
      outcome,
      amountText: parameterText(raw, 'Amount'),
      receipt: parameterText(raw, 'ReceiptNo'),
      resultCode: String(code),
    };
  }

  /** The initiator password encrypted with the sandbox certificate: RSA, PKCS #1 v1.5, base64. */
  private securityCredential(): string {
    const password = this.config.b2c?.initiatorPassword ?? '';
    return publicEncrypt(
      { key: DARAJA_SANDBOX_CERTIFICATE, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(password),
    ).toString('base64');
  }

  async queryStk(checkoutId: string): Promise<DarajaQueryResult> {
    const timestamp = nairobiTimestamp();
    const reply = await this.call('/mpesa/stkpushquery/v1/query', {
      BusinessShortCode: this.config.shortcode,
      Password: this.password(timestamp),
      Timestamp: timestamp,
      CheckoutRequestID: checkoutId,
    });
    if (reply.kind === 'unreachable' || reply.status !== 200) return { kind: 'unknown' };
    // Result codes were observed as strings although documented as numeric.
    const code = reply.json['ResultCode'];
    const resultCode = typeof code === 'string' || typeof code === 'number' ? String(code) : null;
    if (resultCode === '0') return { kind: 'succeeded' };
    // 4999 "still under processing" was observed in the sandbox; it is not a failure.
    if (resultCode === null || resultCode === '4999') return { kind: 'pending', resultCode };
    return /^[0-9]+$/.test(resultCode)
      ? { kind: 'failed', resultCode }
      : { kind: 'pending', resultCode };
  }

  /**
   * Reads a callback body. The amount is taken from the raw text with a pattern,
   * so a decimal such as `150.00` is never turned into a floating-point number.
   */
  parseCallback(raw: string): DarajaCallback {
    const parsed = JSON.parse(raw) as { Body?: { stkCallback?: Record<string, unknown> } };
    const callback = parsed.Body?.stkCallback;
    const checkoutId = callback?.['CheckoutRequestID'];
    const code = callback?.['ResultCode'];
    if (typeof checkoutId !== 'string' || (typeof code !== 'number' && typeof code !== 'string')) {
      throw new Error('Not an STK callback.');
    }
    const items = (
      (
        callback?.['CallbackMetadata'] as
          { Item?: { Name?: unknown; Value?: unknown }[] } | undefined
      )?.Item ?? []
    ).filter((item) => typeof item.Name === 'string');
    const receipt = items.find((item) => item.Name === 'MpesaReceiptNumber')?.Value;
    const amountText = /"Name"\s*:\s*"Amount"\s*,\s*"Value"\s*:\s*"?([0-9]+(?:\.[0-9]+)?)"?/.exec(
      raw,
    )?.[1];
    const merchant = callback?.['MerchantRequestID'];
    return {
      checkoutId,
      merchantId: typeof merchant === 'string' ? merchant : null,
      resultCode: String(code),
      amountText: amountText ?? null,
      receipt: typeof receipt === 'string' ? receipt : null,
    };
  }

  private password(timestamp: string): string {
    return Buffer.from(`${this.config.shortcode}${this.config.passkey}${timestamp}`).toString(
      'base64',
    );
  }

  private async call(
    path: string,
    body: Record<string, unknown>,
  ): Promise<
    { kind: 'reply'; status: number; json: Record<string, unknown> } | { kind: 'unreachable' }
  > {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let token: string;
      try {
        token = await this.accessToken(attempt > 0);
      } catch {
        // No token means no request was sent: nothing can have happened.
        return { kind: 'reply', status: 503, json: {} };
      }
      let status: number;
      let json: Record<string, unknown>;
      try {
        const response = (await fetch(`${this.config.baseUrl}${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        })) as unknown as Reply;
        status = response.status;
        const text = await response.text();
        try {
          json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        } catch {
          json = {};
        }
      } catch {
        // A timeout or a dropped connection: the provider may or may not have acted.
        return { kind: 'unreachable' };
      }
      if (status === 404 && json['errorCode'] === INVALID_TOKEN && attempt === 0) {
        this.token = null;
        continue;
      }
      return { kind: 'reply', status, json };
    }
    return { kind: 'reply', status: 404, json: { errorCode: INVALID_TOKEN } };
  }

  /**
   * One token per process, shared by concurrent calls. Daraja documents that
   * a new token invalidates the previous one, and token requests count towards
   * its rate limit, so tokens are fetched as rarely as possible.
   */
  private async accessToken(refresh: boolean): Promise<string> {
    if (!refresh && this.token && this.token.expiresAt > Date.now()) return this.token.value;
    if (this.pendingToken) return this.pendingToken;
    this.pendingToken = (async () => {
      try {
        const basic = Buffer.from(
          `${this.config.consumerKey}:${this.config.consumerSecret}`,
        ).toString('base64');
        const response = (await fetch(
          `${this.config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
          {
            headers: { authorization: `Basic ${basic}` },
            signal: AbortSignal.timeout(this.config.requestTimeoutMs),
          },
        )) as unknown as Reply;
        const json = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
        if (!response.ok || typeof json.access_token !== 'string') {
          throw new Error('Daraja access token request failed.');
        }
        const given = json.expires_in;
        const seconds =
          typeof given === 'string' || typeof given === 'number'
            ? Number.parseInt(String(given), 10) || 3599
            : 3599;
        // Renewed a minute early so a token never expires mid-request.
        this.token = { value: json.access_token, expiresAt: Date.now() + (seconds - 60) * 1000 };
        return json.access_token;
      } finally {
        this.pendingToken = null;
      }
    })();
    return this.pendingToken;
  }
}

/** The value of a `{"Key": name, "Value": …}` parameter, as text, read from the raw body. */
function parameterText(raw: string, name: string): string | null {
  const pattern = new RegExp(`"Key"\\s*:\\s*"${name}"\\s*,\\s*"Value"\\s*:\\s*"?([^",}]*)"?`);
  return pattern.exec(raw)?.[1]?.trim() ?? null;
}

/** YYYYMMDDHHmmss in Kenya time (UTC+3, no daylight saving); accepted by the sandbox (2026-10-14). */
export function nairobiTimestamp(now: Date = new Date()): string {
  return new Date(now.getTime() + 3 * 3_600_000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}
