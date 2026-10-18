import type { KeloCategory, KeloStore, List, Me } from '@aora/api-client';
import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { api, field, messageOf } from '../../lib/api';

const PROVISIONING: Record<string, string> = {
  requested: 'Setting up your KONY workspace',
  business_resolved: 'Setting up your KONY workspace',
  workspace_linked: 'Setting up your KONY workspace',
  admin_assigned: 'Setting up your KONY workspace',
  completed: 'Ready',
  failed_retryable: 'Setting up your KONY workspace (retrying)',
  failed_needs_review: 'Waiting for AORA support to check a detail',
  reconciliation_required: 'Waiting for AORA support to check a detail',
};

async function enlist(form: FormData): Promise<void> {
  'use server';
  const categories = form.getAll('categories').filter((v): v is string => typeof v === 'string');
  const workspaceId = field(form, 'workspace_id');
  const kind = field(form, 'kind');
  const business = workspaceId
    ? { workspace_id: workspaceId }
    : kind === 'registered'
      ? {
          kind,
          name: field(form, 'name'),
          country: 'KE',
          registration: {
            type: 'sandbox_registration_number',
            value: field(form, 'registration'),
          },
        }
      : {
          kind: 'unregistered',
          name: field(form, 'name'),
          country: 'KE',
          location: {
            area: field(form, 'area'),
            locality: field(form, 'locality'),
            place: field(form, 'place'),
          },
        };
  let target = '/kelo?ok=1';
  try {
    await (
      await api()
    ).post(
      '/v1/kelo/stores',
      { display_name: field(form, 'display_name'), categories, business },
      field(form, 'idempotency_key'),
    );
  } catch (error) {
    target = `/kelo?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

export default async function SellOnKelo({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const query = await searchParams;
  const client = await api();
  const [me, stores, categories] = await Promise.all([
    client.get<Me>('/v1/me'),
    client.get<List<KeloStore>>('/v1/kelo/stores'),
    client.get<List<KeloCategory>>('/v1/kelo/categories'),
  ]);
  const adminOf = me.memberships.filter((entry) => entry.role === 'admin');
  return (
    <>
      <h1>Sell on KELO</h1>
      <p className="muted">
        List your goods and services on the KELO marketplace. Every store is checked by AORA before
        it can list. Your store comes with a KONY workspace, or is linked to the one you already
        run. Sandbox: no real money and no real customers.
      </p>
      {query['error'] && <p className="error">{query['error']}</p>}
      {query['ok'] && <p className="muted">Received. AORA will check your store.</p>}

      {stores.data.length > 0 && (
        <div className="card">
          <h2>Your stores</h2>
          <table>
            <thead>
              <tr>
                <th>Store</th>
                <th>Check</th>
                <th>Workspace</th>
              </tr>
            </thead>
            <tbody>
              {stores.data.map((store) => (
                <tr key={store.id}>
                  <td>{store.display_name}</td>
                  <td>
                    <span className="pill">{store.status}</span>
                    {store.decision_reason && <div className="muted">{store.decision_reason}</div>}
                  </td>
                  <td>
                    {store.provisioning_status === 'completed' && store.workspace_id ? (
                      <Link href={`/w/${store.workspace_id}/kelo`}>Open the KELO section</Link>
                    ) : (
                      (PROVISIONING[store.provisioning_status ?? ''] ?? 'Not started')
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>Enlist a store</h2>
        <form action={enlist} className="stack">
          <input type="hidden" name="idempotency_key" value={randomUUID()} />
          <label>
            Store name, as buyers will see it
            <input name="display_name" required maxLength={80} />
          </label>
          <fieldset>
            <legend>What you sell (each category has its own checks)</legend>
            {categories.data.map((category) => (
              <label key={category.slug} style={{ display: 'block' }}>
                <input type="checkbox" name="categories" value={category.slug} /> {category.name}
              </label>
            ))}
          </fieldset>
          {adminOf.length > 0 && (
            <label>
              Use a KONY workspace you already run
              <select name="workspace_id" defaultValue="">
                <option value="">No, register a new business below</option>
                {adminOf.map((entry) => (
                  <option key={entry.workspace_id} value={entry.workspace_id}>
                    {entry.workspace_id}
                  </option>
                ))}
              </select>
            </label>
          )}
          <fieldset>
            <legend>A new business</legend>
            <label>
              Business name
              <input name="name" maxLength={120} />
            </label>
            <label>
              Kind
              <select name="kind" defaultValue="registered">
                <option value="registered">Registered company</option>
                <option value="unregistered">Unregistered sole trader</option>
              </select>
            </label>
            <label>
              Registration number (sandbox registry; registered only)
              <input name="registration" maxLength={60} />
            </label>
            <label>
              Area, locality and place (unregistered only)
              <input name="area" maxLength={80} placeholder="Area" />
              <input name="locality" maxLength={80} placeholder="Locality" />
              <input name="place" maxLength={120} placeholder="Place" />
            </label>
          </fieldset>
          <button type="submit">Send for checking</button>
        </form>
      </div>
    </>
  );
}
