import 'server-only';
import { auth } from '@clerk/nextjs/server';
import { AoraApi, AoraApiError } from '@aora/api-client';

/** The API as the signed-in person, from the server side only. */
export async function api(workspaceId?: string): Promise<AoraApi> {
  // Each page checks the session where it uses data (resource-based checks, as
  // Clerk recommends), and the API checks the token again on every request.
  const session = await auth();
  if (!session.userId) return session.redirectToSignIn();
  const { getToken } = session;
  const base = new AoraApi({
    baseUrl: process.env['AORA_API_URL'] ?? 'http://127.0.0.1:3000',
    token: await getToken(),
  });
  return workspaceId ? base.forWorkspace(workspaceId) : base;
}

/** A message safe to show: the API's own words, or a generic one. */
export function messageOf(error: unknown): string {
  if (error instanceof AoraApiError) {
    if (error.code === 'step_up_required')
      return 'Confirm with your PIN first (Security page), then try again.';
    return error.message;
  }
  return 'Something went wrong. Please try again.';
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
