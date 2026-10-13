import { randomUUID } from 'node:crypto';
import type { Harness } from './harness.js';

let counter = 100;

/**
 * A brand-new person, as the identity provider would hand them over: an email
 * address and a name. Returns a token; the account is created on first use.
 */
export async function newUser(
  h: Harness,
  name: string,
  options: { phone?: boolean; email?: string } = {},
): Promise<{ token: string; email: string; accountId: string }> {
  const subject = `user_test_${randomUUID()}`;
  // .test is a reserved top-level domain: these addresses can never receive mail.
  const email = options.email ?? `${name.toLowerCase()}.${subject.slice(-6)}@people.aora.test`;
  h.sandboxAuth.setProfile(subject, { email, phoneE164: null, displayName: name });
  const token = h.sandboxAuth.issue(subject);
  const me = await h.http().get('/v1/me').set('Authorization', `Bearer ${token}`);
  if (me.status !== 200) throw new Error(`new user could not sign in: ${String(me.status)}`);
  if (options.phone !== false) {
    counter += 1;
    const phone = await h
      .http()
      .put('/v1/me/phone')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: `+999000${String(counter).padStart(5, '0')}` });
    if (phone.status !== 200) throw new Error(`setting phone failed: ${String(phone.status)}`);
  }
  return { token, email, accountId: me.body.account_id as string };
}
