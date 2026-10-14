import type { AuditEvent, List } from '@aora/api-client';
import { api } from '../../lib/api';

export default async function Audit({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const query = await searchParams;
  const events = await (
    await api()
  ).get<List<AuditEvent>>('/v1/ops/audit-events', {
    workspace_id: query['workspace_id'],
    subject_id: query['subject_id'],
    limit: 100,
  });
  return (
    <>
      <h1>Audit trail</h1>
      <form className="stack" method="get">
        <label>
          Workspace id
          <input name="workspace_id" defaultValue={query['workspace_id'] ?? ''} />
        </label>
        <label>
          Subject id
          <input name="subject_id" defaultValue={query['subject_id'] ?? ''} />
        </label>
        <button type="submit">Filter</button>
      </form>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Actor</th>
              <th>Subject</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {events.data.map((event) => (
              <tr key={event.id}>
                <td>{new Date(event.occurred_at).toLocaleString('en-KE')}</td>
                <td>{event.action}</td>
                <td>{event.actor_kind}</td>
                <td>
                  {event.subject_type} <code>{event.subject_id}</code>
                </td>
                <td>{event.outcome}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
