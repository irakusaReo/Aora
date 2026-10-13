import { z } from 'zod';

// Sandbox is the only mode this codebase can run in (CLAUDE.md rule 10).
const schema = z.object({
  AORA_MODE: z.literal('sandbox'),
  DATABASE_URL_APP: z.string().min(1),
  DATABASE_URL_PLATFORM: z.string().min(1),
  SANDBOX_SIM_WEBHOOK_SECRET: z.string().min(16),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_API_URL: z.url().default('http://127.0.0.1:3000'),
});

export interface AppConfig {
  readonly mode: 'sandbox';
  readonly databaseUrlApp: string;
  readonly databaseUrlPlatform: string;
  readonly simWebhookSecret: string;
  readonly port: number;
  readonly publicApiUrl: string;
  readonly auth: {
    readonly challengeTtlSeconds: number;
    readonly maxChallengeAttempts: number;
    readonly sessionTtlSeconds: number;
    readonly stepUpTtlSeconds: number;
  };
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

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Names only: values may be secrets and must never reach a log.
    const names = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid or missing configuration: ${names}`);
  }
  const value = parsed.data;
  return {
    mode: value.AORA_MODE,
    databaseUrlApp: value.DATABASE_URL_APP,
    databaseUrlPlatform: value.DATABASE_URL_PLATFORM,
    simWebhookSecret: value.SANDBOX_SIM_WEBHOOK_SECRET,
    port: value.PORT,
    publicApiUrl: value.PUBLIC_API_URL,
    auth: {
      challengeTtlSeconds: 300,
      maxChallengeAttempts: 5,
      sessionTtlSeconds: 12 * 60 * 60,
      stepUpTtlSeconds: 300,
    },
    payments: {
      statusInquiryDelaySeconds: 30,
      maxStatusInquiries: 5,
      stuckUnknownAfterSeconds: 15 * 60,
    },
    outbox: { maxAttempts: 8, retryDelaySeconds: 5 },
  };
}
