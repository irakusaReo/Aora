/**
 * Where is this process running? Derived from the platform's own environment
 * and from the databases it is configured to use, never from an AORA flag.
 */

type Env = Record<string, string | undefined>;

const VERCEL_VARIABLES = ['VERCEL', 'VERCEL_ENV', 'VERCEL_URL'] as const;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isDeployed(env: Env): boolean {
  return VERCEL_VARIABLES.some((name) => (env[name] ?? '') !== '');
}

export function isLocalDatabaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return /^postgres(ql)?:$/.test(url.protocol) && LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * The fixed sign-in code is a development convenience. It is allowed only when
 * the process is not on a hosting platform AND every database it uses is on
 * this machine. A deployed environment can satisfy neither.
 */
export function fixedCodeAllowed(env: Env): boolean {
  return (
    !isDeployed(env) &&
    isLocalDatabaseUrl(env['DATABASE_URL_APP']) &&
    isLocalDatabaseUrl(env['DATABASE_URL_PLATFORM'])
  );
}
