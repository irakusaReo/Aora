import { z } from 'zod';
import { isDeployed, sandboxAuthAllowed } from './deployment.js';

/** The only Daraja environment this codebase may call (CLAUDE.md rule 10). */
export const DARAJA_SANDBOX_URL = 'https://sandbox.safaricom.co.ke';

// Sandbox is the only mode this codebase can run in (CLAUDE.md rule 10).
const schema = z.object({
  AORA_MODE: z.literal('sandbox'),
  DATABASE_URL_APP: z.string().min(1),
  DATABASE_URL_PLATFORM: z.string().min(1),
  SANDBOX_SIM_WEBHOOK_SECRET: z.string().min(16),
  PIN_PEPPER: z.string().min(32),
  AUTH_PROVIDER: z.enum(['clerk', 'sandbox']).default('clerk'),
  CLERK_SECRET_KEY: z.string().min(1).optional(),
  CLERK_PUBLISHABLE_KEY: z.string().min(1).optional(),
  CLERK_JWT_KEY: z.string().min(1).optional(),
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().min(1).optional(),
  CLERK_AUTHORIZED_PARTIES: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(3).default('AORA Sandbox <onboarding@resend.dev>'),
  CRON_SECRET: z.string().min(32).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_API_URL: z.url().default('http://127.0.0.1:3000'),
  DARAJA_BASE_URL: z.url().default(DARAJA_SANDBOX_URL),
  DARAJA_CONSUMER_KEY: z.string().min(1).optional(),
  DARAJA_CONSUMER_SECRET: z.string().min(1).optional(),
  DARAJA_SHORTCODE: z
    .string()
    .regex(/^[0-9]{5,7}$/)
    .optional(),
  DARAJA_PASSKEY: z.string().min(1).optional(),
  DARAJA_TEST_MSISDN: z
    .string()
    .regex(/^254[0-9]{9}$/)
    .optional(),
  DARAJA_CALLBACK_SECRET: z.string().min(32).optional(),
  // Ed25519 private key, PKCS #8 DER, base64 (pnpm secrets:generate). Signs outbound webhooks.
  WEBHOOK_SIGNING_PRIVATE_KEY: z.string().min(40).optional(),
  // Vercel Blob for KELO listing images (O-7). Absent: the image simulator.
  BLOB_READ_WRITE_TOKEN: z.string().min(20).optional(),
  DARAJA_B2C_SHORTCODE: z
    .string()
    .regex(/^[0-9]{5,7}$/)
    .optional(),
  DARAJA_INITIATOR_NAME: z.string().min(1).optional(),
  DARAJA_INITIATOR_PASSWORD: z.string().min(1).optional(),
  // Comma-separated source addresses Daraja callbacks must come from. Empty: not enforced
  // (Safaricom's published list is not yet confirmed for the sandbox; docs/providers/daraja.md).
  DARAJA_CALLBACK_ALLOWED_IPS: z.string().optional(),
});

const DARAJA_REQUIRED = [
  'DARAJA_CONSUMER_KEY',
  'DARAJA_CONSUMER_SECRET',
  'DARAJA_SHORTCODE',
  'DARAJA_PASSKEY',
  'DARAJA_TEST_MSISDN',
  'DARAJA_CALLBACK_SECRET',
] as const;

/** Safaricom Daraja SANDBOX settings (ADR 0022). Null: the mpesa rail uses the simulator. */
export interface DarajaConfig {
  readonly baseUrl: string;
  readonly consumerKey: string;
  readonly consumerSecret: string;
  readonly shortcode: string;
  readonly passkey: string;
  /** The Daraja test number: in the sandbox, the only payer an STK push may go to. */
  readonly testMsisdn: string;
  readonly callbackSecret: string;
  readonly requestTimeoutMs: number;
  readonly callbackAllowedIps?: readonly string[];
  /** B2C payouts; null when the B2C test credentials are not configured. */
  readonly b2c?: {
    readonly shortcode: string;
    readonly initiatorName: string;
    readonly initiatorPassword: string;
  } | null;
}

export type RateLimitName = 'pin_step_up_account';

export interface AppConfig {
  readonly mode: 'sandbox';
  readonly databaseUrlApp: string;
  readonly databaseUrlPlatform: string;
  readonly simWebhookSecret: string;
  readonly pinPepper: string;
  /** 'sandbox' is the test-only authenticator; it cannot be selected on a deployed environment. */
  readonly authProvider: 'clerk' | 'sandbox';
  readonly deployed: boolean;
  readonly clerk: {
    readonly secretKey: string | null;
    readonly publishableKey: string | null;
    /** PEM public key of the instance: lets session tokens be verified without a network call. */
    readonly jwtKey: string | null;
    readonly webhookSigningSecret: string;
    /** Origins allowed to mint session tokens for this API (the `azp` claim). */
    readonly authorizedParties: readonly string[];
  };
  readonly email: {
    readonly resendApiKey: string | null;
    readonly webhookSecret: string | null;
    readonly from: string;
  };
  readonly cronSecret: string | null;
  readonly port: number;
  readonly publicApiUrl: string;
  readonly daraja: DarajaConfig | null;
  readonly webhooks: { readonly signingPrivateKey: string | null; readonly maxAttempts: number };
  /** Vercel Blob read-write token; null selects the image simulator. */
  readonly blob: { readonly readWriteToken: string | null };
  readonly auth: {
    readonly stepUpTtlSeconds: number;
    readonly maxPinAttempts: number;
    readonly pinLockSeconds: number;
    /** A PIN may be set or changed only if the sign-in factor was verified this recently. */
    readonly pinSetupMaxFactorAgeMinutes: number;
  };
  readonly rateLimits: Readonly<Record<RateLimitName, { limit: number; windowSeconds: number }>>;
  readonly jobs: { readonly budgetMs: number; readonly leaseSeconds: number };
  readonly invitations: { readonly ttlHours: number };
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

function missing(name: string): never {
  // Names only: values may be secrets and must never reach a log.
  throw new Error(`Invalid or missing configuration: ${name}`);
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    missing(parsed.error.issues.map((issue) => issue.path.join('.')).join(', '));
  }
  const value = parsed.data;
  const deployed = isDeployed(env);

  if (value.AUTH_PROVIDER === 'sandbox' && !sandboxAuthAllowed(env)) {
    throw new Error(
      'The sandbox authenticator is forbidden here: it is allowed only on a developer machine with a local database.',
    );
  }
  // Only development-instance (test) keys are ever accepted (CLAUDE.md rule 10).
  for (const [name, key] of [
    ['CLERK_SECRET_KEY', value.CLERK_SECRET_KEY],
    ['CLERK_PUBLISHABLE_KEY', value.CLERK_PUBLISHABLE_KEY],
  ] as const) {
    if (key && /^(sk|pk)_live_/.test(key)) {
      throw new Error(`${name} looks like a live or production key. Only test keys are allowed.`);
    }
  }
  if (value.AUTH_PROVIDER === 'clerk') {
    if (!value.CLERK_SECRET_KEY) missing('CLERK_SECRET_KEY');
    if (!value.CLERK_PUBLISHABLE_KEY) missing('CLERK_PUBLISHABLE_KEY');
    if (!value.CLERK_WEBHOOK_SIGNING_SECRET) missing('CLERK_WEBHOOK_SIGNING_SECRET');
    if (!/^sk_test_/.test(value.CLERK_SECRET_KEY))
      missing('CLERK_SECRET_KEY (expected a test key)');
    if (!/^pk_test_/.test(value.CLERK_PUBLISHABLE_KEY)) {
      missing('CLERK_PUBLISHABLE_KEY (expected a test key)');
    }
  }
  const daraja = darajaConfig(value, deployed);
  if (deployed) {
    if (!value.CRON_SECRET) missing('CRON_SECRET');
    if (!value.CLERK_AUTHORIZED_PARTIES) missing('CLERK_AUTHORIZED_PARTIES');
    if (!value.CLERK_JWT_KEY) missing('CLERK_JWT_KEY');
    if (!value.RESEND_API_KEY) missing('RESEND_API_KEY');
    if (!value.RESEND_WEBHOOK_SECRET) missing('RESEND_WEBHOOK_SECRET');
    if (!value.WEBHOOK_SIGNING_PRIVATE_KEY) missing('WEBHOOK_SIGNING_PRIVATE_KEY');
  }

  return {
    mode: value.AORA_MODE,
    databaseUrlApp: value.DATABASE_URL_APP,
    databaseUrlPlatform: value.DATABASE_URL_PLATFORM,
    simWebhookSecret: value.SANDBOX_SIM_WEBHOOK_SECRET,
    pinPepper: value.PIN_PEPPER,
    authProvider: value.AUTH_PROVIDER,
    deployed,
    clerk: {
      secretKey: value.CLERK_SECRET_KEY ?? null,
      publishableKey: value.CLERK_PUBLISHABLE_KEY ?? null,
      jwtKey: value.CLERK_JWT_KEY?.replaceAll('\\n', '\n') ?? null,
      webhookSigningSecret: value.CLERK_WEBHOOK_SIGNING_SECRET ?? '',
      authorizedParties: (value.CLERK_AUTHORIZED_PARTIES ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    },
    email: {
      resendApiKey: value.RESEND_API_KEY ?? null,
      webhookSecret: value.RESEND_WEBHOOK_SECRET ?? null,
      from: value.EMAIL_FROM,
    },
    cronSecret: value.CRON_SECRET ?? null,
    port: value.PORT,
    publicApiUrl: value.PUBLIC_API_URL,
    daraja,
    webhooks: { signingPrivateKey: value.WEBHOOK_SIGNING_PRIVATE_KEY ?? null, maxAttempts: 6 },
    blob: { readWriteToken: value.BLOB_READ_WRITE_TOKEN ?? null },
    auth: {
      stepUpTtlSeconds: 300,
      maxPinAttempts: 5,
      pinLockSeconds: 15 * 60,
      pinSetupMaxFactorAgeMinutes: 10,
    },
    rateLimits: { pin_step_up_account: { limit: 10, windowSeconds: 15 * 60 } },
    jobs: { budgetMs: 45_000, leaseSeconds: 120 },
    invitations: { ttlHours: 7 * 24 },
    payments: {
      statusInquiryDelaySeconds: 30,
      maxStatusInquiries: 5,
      stuckUnknownAfterSeconds: 15 * 60,
    },
    outbox: { maxAttempts: 8, retryDelaySeconds: 5 },
  };
}

function darajaConfig(value: z.infer<typeof schema>, deployed: boolean): DarajaConfig | null {
  const given = DARAJA_REQUIRED.filter((name) => value[name] !== undefined);
  if (given.length === 0) return null;
  const absent = DARAJA_REQUIRED.filter((name) => value[name] === undefined);
  if (absent.length > 0) missing(absent.join(', '));
  const url = new URL(value.DARAJA_BASE_URL);
  const sandbox = url.origin === DARAJA_SANDBOX_URL;
  // A loopback address is a test stand-in on a developer machine, never on a deployed environment.
  const loopback = !deployed && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (!sandbox && !loopback) {
    throw new Error(
      'DARAJA_BASE_URL must be the Daraja sandbox. Production Daraja is never called.',
    );
  }
  return {
    baseUrl: url.origin,
    consumerKey: value.DARAJA_CONSUMER_KEY ?? '',
    consumerSecret: value.DARAJA_CONSUMER_SECRET ?? '',
    shortcode: value.DARAJA_SHORTCODE ?? '',
    passkey: value.DARAJA_PASSKEY ?? '',
    testMsisdn: value.DARAJA_TEST_MSISDN ?? '',
    callbackSecret: value.DARAJA_CALLBACK_SECRET ?? '',
    requestTimeoutMs: 15_000,
    b2c: b2cConfig(value),
    callbackAllowedIps: (value.DARAJA_CALLBACK_ALLOWED_IPS ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  };
}

function b2cConfig(value: z.infer<typeof schema>): NonNullable<DarajaConfig['b2c']> | null {
  const names = [
    'DARAJA_B2C_SHORTCODE',
    'DARAJA_INITIATOR_NAME',
    'DARAJA_INITIATOR_PASSWORD',
  ] as const;
  const given = names.filter((name) => value[name] !== undefined);
  if (given.length === 0) return null;
  const absent = names.filter((name) => value[name] === undefined);
  if (absent.length > 0) missing(absent.join(', '));
  return {
    shortcode: value.DARAJA_B2C_SHORTCODE ?? '',
    initiatorName: value.DARAJA_INITIATOR_NAME ?? '',
    initiatorPassword: value.DARAJA_INITIATOR_PASSWORD ?? '',
  };
}
