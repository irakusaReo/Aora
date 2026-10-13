import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './support/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

describe('audit trail', () => {
  it('records PIN events and account creation, without the PIN or the token', async () => {
    const token = await h.signIn('adminA');
    await h
      .http()
      .put('/v1/auth/pin')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '482915' });
    await h
      .http()
      .post('/v1/auth/step-up')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '424242' });

    const events = await h.owner((client) =>
      client.query<{ action: string; outcome: string; row: string }>(
        `select action, outcome, audit_event::text as row from audit.audit_event
         where actor_account_id = $1 order by occurred_at`,
        [h.seed.accounts.adminA],
      ),
    );
    expect(events.rows.map((row) => [row.action, row.outcome])).toEqual([
      ['identity.pin.set', 'success'],
      ['identity.pin.rejected', 'denied'],
    ]);
    for (const row of events.rows) {
      expect(row.row).not.toContain(token);
      expect(row.row).not.toContain('424242');
      expect(row.row).not.toContain('482915');
    }
  });

  it('cannot be updated, deleted or truncated, even by the schema owner', async () => {
    await h
      .http()
      .put('/v1/auth/pin')
      .set('Authorization', `Bearer ${await h.signIn('adminB')}`)
      .send({ pin: '482915' });
    const attempt = (sql: string): Promise<unknown> => h.owner((client) => client.query(sql));
    await expect(attempt(`update audit.audit_event set outcome = 'failure'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(attempt(`delete from audit.audit_event`)).rejects.toThrow(/append-only/);
    await expect(attempt(`truncate audit.audit_event`)).rejects.toThrow(/append-only/);
  });

  it('gives the application roles no update or delete privilege', async () => {
    const grants = await h.owner((client) =>
      client.query(
        `select grantee, privilege_type from information_schema.role_table_grants
         where table_schema = 'audit' and privilege_type not in ('SELECT', 'INSERT')
           and grantee in ('aora_app', 'aora_platform')`,
      ),
    );
    expect(grants.rows).toEqual([]);
  });
});
