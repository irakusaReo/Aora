import { z } from 'zod';
import { fixedCodeAllowed, isDeployed } from './deployment.js';

// Sandbox is the only mode this codebase can run in (CLAUDE.md rule 10).
const schema = z.object({
  AORA_MODE: z.literal('sandbox'),
  DATABASE_URL_APP: z.string().min(1),
  DATABASE_URL_PLATFORM: z.string().min(1),
  SANDBOX_SIM_WEBHOOK_SECRET: z.string().min(16),
  PIN_PEPPER: z.string().min(32),
  AUTH_PROVIDER: z.enum(['otp', 'fixed']).default('otp'),
  CRON_SECRET: z.string().min(32).optional(),
  SMS_PROVIDER_USERNAME: z.string().min(1).optional(),
  SMS_PROVIDER_API_KEY: z.string().min(1).optional(),
  SANDBOX_SMS_INBOX_TOKEN: z.string().min(32).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_API_URL: z.url().default('http://127.0.0.1:3000'),
});

export interface AppConfig {
  readonly mode: 'sandbox';
  readonly databaseUrlApp: string;
  readonly databaseUrlPlatform: string;
  readonly simWebhookSecret: string;
  readonly pinPepper: string;
  /** 'fixed' is the development-only fixed code; it cannot be selected on a deployed environment. */
  readonly authProvider: 'otp' | 'fixed';
  readonly deployed: boolean;
  readonly cronSecret: string | null;
  readonly sms: { readonly username: string; readonly apiKey: string } | null;
  readonly smsInboxToken: string | null;
  readonly port: number;
  readonly publicApiUrl: string;
  readonly auth: {
    readonly challengeTtlSeconds: number;
    readonly maxChallengeAttempts: number;
    readonly sessionTtlSeconds: number;
    readonly stepUpTtlSeconds: number;
    readonly maxPinAttempts: number;
    readonly pinLockSeconds: number;
  };
  readonly rateLimits: Readonly<Record<RateLimitName, { limit: number; windowSeconds: number }>>;
  readonly jobs: { readonly budgetMs: number; readonly leaseSeconds: number };
  readonly payments: {
    readonly statusInquiryDelaySeconds: number;
    readonly maxStatusInquiries: number;
    readonly stuckUnknownAfterSeconds: number;
  };
  readonly outbox: {
    readonly maxAttempts: number;
    readonly retryDelaySeconds: number;
  };
}

export type RateLimitName =
  | 'sign_in_start_phone'
  | 'sign_in_start_address'
  | 'sign_in_verify_address'
  | 'pin_step_up_account'
  | 'pin_code_account';

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Names only: values may be secrets and must never reach a log.
    const names = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid or missing configuration: ${names}`);
  }
  const value = parsed.data;
  if (value.AUTH_PROVIDER === 'fixed' && !fixedCodeAllowed(env)) {
    throw new Error(
      'The fixed sign-in code is forbidden here: it is allowed only on a developer machine with a local database.',
    );
  }
  const deployed = isDeployed(env);
  if (deployed && !value.CRON_SECRET) {
    throw new Error('Invalid or missing configuration: CRON_SECRET');
  }
  const window = 15 * 60;
  return {
    mode: value.AORA_MODE,
    databaseUrlApp: value.DATABASE_URL_APP,
    databaseUrlPlatform: value.DATABASE_URL_PLATFORM,
    simWebhookSecret: value.SANDBOX_SIM_WEBHOOK_SECRET,
    pinPepper: value.PIN_PEPPER,
    authProvider: value.AUTH_PROVIDER,
    deployed,
    cronSecret: value.CRON_SECRET ?? null,
    sms:
      value.SMS_PROVIDER_USERNAME && value.SMS_PROVIDER_API_KEY
        ? { username: value.SMS_PROVIDER_USERNAME, apiKey: value.SMS_PROVIDER_API_KEY }
        : null,
    smsInboxToken: value.SANDBOX_SMS_INBOX_TOKEN ?? null,
    port: value.PORT,
    publicApiUrl: value.PUBLIC_API_URL,
    auth: {
      challengeTtlSeconds: 300,
      maxChallengeAttempts: 5,
      sessionTtlSeconds: 12 * 60 * 60,
      stepUpTtlSeconds: 300,
      maxPinAttempts: 5,
      pinLockSeconds: 15 * 60,
    },
    rateLimits: {
      sign_in_start_phone: { limit: 5, windowSeconds: window },
      sign_in_start_address: { limit: 30, windowSeconds: window },
      sign_in_verify_address: { limit: 30, windowSeconds: window },
      pin_step_up_account: { limit: 10, windowSeconds: window },
      pin_code_account: { limit: 5, windowSeconds: window },
    },
    jobs: { budgetMs: 45_000, leaseSeconds: 120 },
    payments: {
      statusInquiryDelaySeconds: 30,
      maxStatusInquiries: 5,
      stuckUnknownAfterSeconds: 15 * 60,
    },
    outbox: { maxAttempts: 8, retryDelaySeconds: 5 },
  };
}
