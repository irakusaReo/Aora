import 'server-only';
import { auth } from '@clerk/nextjs/server';
import { AoraApi, AoraApiError } from '@aora/api-client';

const BASE_URL = process.env['AORA_API_URL'] ?? 'http://127.0.0.1:3000';

/** The API without a session: published listings and the taxonomy only. */
export function publicApi(): AoraApi {
  return new AoraApi({ baseUrl: BASE_URL, token: null });
}

/** The API as the signed-in buyer, from the server side only. */
export async function api(): Promise<AoraApi> {
  // Each page checks the session where it uses data, and the API checks the
  // token again on every request (ADR 0019).
  const session = await auth();
  if (!session.userId) return session.redirectToSignIn();
  return new AoraApi({ baseUrl: BASE_URL, token: await session.getToken() });
}

/** A message safe to show: the API's own words, or a generic one. */
export function messageOf(error: unknown, fallback: string): string {
  return error instanceof AoraApiError ? error.message : fallback;
}

export function exponentOf(assets: { code: string; exponent: number }[], code: string): number {
  const asset = assets.find((entry) => entry.code === code);
  if (!asset) throw new Error(`Unknown asset ${code}`);
  return asset.exponent;
}

/** A text field of a submitted form, trimmed; anything else (a file) counts as empty. */
export function field(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

export function isNotFound(error: unknown): boolean {
  return error instanceof AoraApiError && error.code === 'not_found';
}
