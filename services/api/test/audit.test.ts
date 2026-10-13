import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './support/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

describe('audit trail', () => {
  it('records sign-in and rejected codes, without the code or token', async () => {
    const token = await h.signIn('adminA');
    const challenge = await h.http().post('/v1/auth/challenges').send({ phone: '+99900000001' });
    await h
      .http()
      .post('/v1/auth/sessions')
      .send({ challenge_id: challenge.body.challenge_id, code: '424242' });

    const events = await h.owner((client) =>
      client.query<{ action: string; outcome: string; detail: unknown; row: string }>(
        `select action, outcome, detail, audit_event::text as row from audit.audit_event
         where actor_account_id = $1 order by occurred_at`,
        [h.seed.accounts.adminA],
      ),
    );
    expect(events.rows.map((row) => [row.action, row.outcome])).toEqual([
      ['identity.session.created', 'success'],
      ['identity.sign_in.code_rejected', 'denied'],
    ]);
    for (const row of events.rows) {
      expect(row.row).not.toContain(token);
      expect(row.row).not.toContain('424242');
    }
  });

  it('cannot be updated, deleted or truncated, even by the schema owner', async () => {
    await h.signIn('adminA');
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
