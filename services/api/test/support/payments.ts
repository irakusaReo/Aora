import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import type { Harness } from './harness.js';

export interface Caller {
  readonly token: string;
  readonly workspace: string;
}

export function createIntent(
  h: Harness,
  caller: Caller,
  body: Record<string, unknown>,
  key: string = randomUUID(),
): Promise<Response> {
  return h
    .http()
    .post('/v1/payment-intents')
    .set('Authorization', `Bearer ${caller.token}`)
    .set('Aora-Workspace-Id', caller.workspace)
    .set('Idempotency-Key', key)
    .send(body);
}

/** The ids of a list response, in the order returned. */
export function ids(response: Response): string[] {
  return (response.body.data as { id: string }[]).map((row) => row.id);
}

export function getIntent(h: Harness, caller: Caller, id: string): Promise<Response> {
  return h
    .http()
    .get(`/v1/payment-intents/${id}`)
    .set('Authorization', `Bearer ${caller.token}`)
    .set('Aora-Workspace-Id', caller.workspace);
}

export async function statusOf(h: Harness, caller: Caller, id: string): Promise<string> {
  return (await getIntent(h, caller, id)).body.status as string;
}

/** Journal entries and merchant credit recorded for an intent, read past row-level security. */
export async function ledgerFor(
  h: Harness,
  intentId: string,
): Promise<{ entries: number; credited: string }> {
  return h.owner(async (client) => {
    const result = await client.query<{ entries: string; credited: string }>(
      `select count(distinct e.id) as entries,
              coalesce(sum(p.amount) filter (where p.direction = 'credit'), 0) as credited
       from ledger.journal_entry e join ledger.posting p on p.entry_id = e.id
       where e.operation_type = 'payment_intent' and e.operation_id = $1`,
      [intentId],
    );
    return { entries: Number(result.rows[0]?.entries), credited: result.rows[0]?.credited ?? '' };
  });
}

export async function transitionsOf(h: Harness, intentId: string): Promise<string[]> {
  return h.owner(async (client) => {
    const result = await client.query<{ to_status: string }>(
      `select to_status from payments.payment_intent_transition where intent_id = $1 order by created_at, id`,
      [intentId],
    );
    return result.rows.map((row) => row.to_status);
  });
}

export async function exceptionTypes(h: Harness, subjectRef?: string): Promise<string[]> {
  return h.owner(async (client) => {
    const result = await client.query<{ type: string }>(
      `select type from payments.reconciliation_exception
       where $1::text is null or subject_ref = $1 order by type`,
      [subjectRef ?? null],
    );
    return result.rows.map((row) => row.type);
  });
}
