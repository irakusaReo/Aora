import type { List } from '@aora/api-client';
import { redirect } from 'next/navigation';
import { api, field, messageOf } from '../../../../lib/api';
import { CreateKeyForm } from './create-key-form';

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scope: string;
  last_used_at: string | null;
  revoked_at: string | null;
}
interface Endpoint {
  id: string;
  url: string;
  event_types: string[];
  status: string;
}
interface Delivery {
  id: string;
  event_type: string;
  status: string;
  attempts: number;
  last_response_status: number | null;
  created_at: string;
}

const EVENTS = [
  'payment_intent.succeeded',
  'payment_intent.failed',
  'payout.succeeded',
  'payout.failed',
  'refund.succeeded',
  'refund.failed',
];

const back = (workspaceId: string, query: Record<string, string>): string =>
  `/w/${workspaceId}/developers?${new URLSearchParams(query).toString()}`;

async function revokeKey(form: FormData): Promise<void> {
  'use server';
  const workspaceId = field(form, 'workspace_id');
  let target = back(workspaceId, {});
  try {
    await (await api(workspaceId)).delete(`/v1/api-keys/${field(form, 'id')}`);
  } catch (error) {
    target = back(workspaceId, { error: messageOf(error) });
  }
  redirect(target);
}

async function addEndpoint(form: FormData): Promise<void> {
  'use server';
  const workspaceId = field(form, 'workspace_id');
  let target = back(workspaceId, {});
  try {
    await (
      await api(workspaceId)
    ).post('/v1/webhook-endpoints', {
      url: field(form, 'url'),
      event_types: form.getAll('event_types').filter((value) => typeof value === 'string'),
    });
  } catch (error) {
    target = back(workspaceId, { error: messageOf(error) });
  }
  redirect(target);
}

async function replay(form: FormData): Promise<void> {
  'use server';
  const workspaceId = field(form, 'workspace_id');
  let target = back(workspaceId, {});
  try {
    await (await api(workspaceId)).post(`/v1/webhook-deliveries/${field(form, 'id')}/replay`);
  } catch (error) {
    target = back(workspaceId, { error: messageOf(error) });
  }
  redirect(target);
}

export default async function Developers({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params;
  const query = await searchParams;
  const client = await api(workspaceId);
  const [keys, endpoints, deliveries] = await Promise.all([
    client.get<List<ApiKey>>('/v1/api-keys').catch(() => ({ data: [] as ApiKey[] })),
    client.get<List<Endpoint>>('/v1/webhook-endpoints'),
    client.get<List<Delivery>>('/v1/webhook-deliveries'),
  ]);
  return (
    <>
      <h1>Developers</h1>
      {query['error'] && <p className="error">{query['error']}</p>}
      <div className="card">
        <h2>API keys</h2>
        <p className="muted">
          Send a key as <code>Authorization: Bearer …</code> with <code>Aora-Workspace-Id</code>. A
          key can never pay out, refund, invite or manage keys: those need a person and a PIN.
        </p>
        <table>
          <tbody>
            {keys.data.map((key) => (
              <tr key={key.id}>
                <td>{key.name}</td>
                <td>
                  <code>{key.prefix}…</code>
                </td>
                <td>{key.scope}</td>
                <td>{key.revoked_at ? 'revoked' : key.last_used_at ? 'used' : 'unused'}</td>
                <td>
                  {!key.revoked_at && (
                    <form action={revokeKey}>
                      <input type="hidden" name="workspace_id" value={workspaceId} />
                      <input type="hidden" name="id" value={key.id} />
                      <button type="submit" className="secondary">
                        Revoke
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <CreateKeyForm workspaceId={workspaceId} />
      </div>
      <div className="card">
        <h2>Webhooks</h2>
        <p className="muted">
          Every webhook is signed with Ed25519. Verify it with the public key at{' '}
          <code>/v1/webhook-signing-key</code>; deduplicate on <code>Aora-Event-Id</code>.
        </p>
        <ul>
          {endpoints.data.map((endpoint) => (
            <li key={endpoint.id}>
              <code>{endpoint.url}</code> {endpoint.event_types.join(', ')}
            </li>
          ))}
        </ul>
        <form action={addEndpoint} className="stack">
          <input type="hidden" name="workspace_id" value={workspaceId} />
          <label>
            HTTPS URL
            <input name="url" type="url" required />
          </label>
          {EVENTS.map((event) => (
            <label key={event} style={{ display: 'flex', gap: 8 }}>
              <input type="checkbox" name="event_types" value={event} defaultChecked /> {event}
            </label>
          ))}
          <button type="submit">Add endpoint</button>
        </form>
      </div>
      <div className="card">
        <h2>Delivery log</h2>
        <table>
          <tbody>
            {deliveries.data.map((delivery) => (
              <tr key={delivery.id}>
                <td>{new Date(delivery.created_at).toLocaleString('en-KE')}</td>
                <td>{delivery.event_type}</td>
                <td>
                  <span className="pill">{delivery.status}</span>
                </td>
                <td>
                  {delivery.attempts} attempt(s), last{' '}
                  {delivery.last_response_status ?? 'no answer'}
                </td>
                <td>
                  <form action={replay}>
                    <input type="hidden" name="workspace_id" value={workspaceId} />
                    <input type="hidden" name="id" value={delivery.id} />
                    <button type="submit" className="secondary">
                      Replay
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
