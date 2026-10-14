import type { List, ReconciliationException } from '@aora/api-client';
import { redirect } from 'next/navigation';
import { api, field, messageOf } from '../lib/api';

async function resolve(form: FormData): Promise<void> {
  'use server';
  let target = '/?ok=1';
  try {
    await (
      await api()
    ).post(`/v1/ops/reconciliation-exceptions/${field(form, 'id')}/resolution`, {
      resolution: field(form, 'resolution'),
      reason: field(form, 'reason'),
    });
  } catch (error) {
    target = `/?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

async function runReconciliation(): Promise<void> {
  'use server';
  let target = '/?ok=run';
  try {
    await (await api()).post('/v1/ops/reconciliation-runs');
  } catch (error) {
    target = `/?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

export default async function Exceptions({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const query = await searchParams;
  const status = query['status'] === 'resolved' ? 'resolved' : 'open';
  const list = await (
    await api()
  ).get<List<ReconciliationException>>('/v1/ops/reconciliation-exceptions', { status });
  return (
    <>
      <h1>Reconciliation exceptions ({status})</h1>
      {query['error'] && <p className="error">{query['error']}</p>}
      {query['ok'] === 'run' && <p className="ok">Reconciliation run finished.</p>}
      <p>
        <a href="/?status=open">Open</a> · <a href="/?status=resolved">Resolved</a>
      </p>
      <form action={runReconciliation}>
        <button type="submit" className="secondary">
          Run reconciliation now
        </button>
      </form>
      {list.data.length === 0 && <p className="muted">Nothing here.</p>}
      {list.data.map((row) => (
        <div className="card" key={row.id}>
          <p>
            <span className="pill">{row.type}</span> {row.subject_type}{' '}
            <code>{row.subject_ref}</code>
          </p>
          <p className="muted">
            Workspace {row.workspace_id ?? '(none)'} · opened{' '}
            {new Date(row.created_at).toLocaleString('en-KE')}
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
            {JSON.stringify(row.detail, null, 2)}
          </pre>
          {row.status === 'open' ? (
            <form action={resolve} className="stack">
              <input type="hidden" name="id" value={row.id} />
              <label>
                Resolution
                <select name="resolution" defaultValue="accepted">
                  <option value="accepted">Accepted: the difference is understood</option>
                  <option value="corrected">Corrected: a compensating entry was made</option>
                  <option value="false_positive">False positive</option>
                </select>
              </label>
              <label>
                Reason (at least 10 characters; recorded in the audit trail)
                <textarea name="reason" required minLength={10} maxLength={500} />
              </label>
              <button type="submit">Resolve</button>
            </form>
          ) : (
            <p>
              Resolved as <strong>{row.resolution}</strong>: {row.resolution_reason}
            </p>
          )}
        </div>
      ))}
    </>
  );
}
