import type {
  KeloListing,
  KeloProvisioning,
  KeloStore,
  KeloStoreForVetting,
  List,
} from '@aora/api-client';
import { redirect } from 'next/navigation';
import { api, field, messageOf } from '../../lib/api';

async function vet(form: FormData): Promise<void> {
  'use server';
  // Each attested requirement arrives as "category:requirement".
  const attestations: Record<string, string[]> = {};
  for (const value of form.getAll('attested')) {
    if (typeof value !== 'string') continue;
    const [slug, requirement] = value.split(':');
    if (!slug || !requirement) continue;
    (attestations[slug] ??= []).push(requirement);
  }
  const restrictions = form
    .getAll('restrictions')
    .filter((v): v is string => typeof v === 'string');
  let target = '/kelo?ok=1';
  try {
    await (
      await api()
    ).post(`/v1/ops/kelo/stores/${field(form, 'id')}/decision`, {
      outcome: field(form, 'outcome'),
      reason: field(form, 'reason'),
      attestations,
      restrictions,
    });
  } catch (error) {
    target = `/kelo?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

async function retry(form: FormData): Promise<void> {
  'use server';
  let target = '/kelo?ok=1';
  try {
    await (
      await api()
    ).post(`/v1/ops/kelo/provisioning/${field(form, 'id')}/retry`, {
      reason: field(form, 'reason'),
    });
  } catch (error) {
    target = `/kelo?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

async function moderate(form: FormData): Promise<void> {
  'use server';
  let target = '/kelo?ok=1';
  try {
    await (
      await api()
    ).post(`/v1/ops/kelo/listings/${field(form, 'id')}/decision`, {
      outcome: field(form, 'outcome'),
      reason: field(form, 'reason'),
    });
  } catch (error) {
    target = `/kelo?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

export default async function Kelo({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const query = await searchParams;
  const client = await api();
  const [submitted, stuck, reconcile, listings] = await Promise.all([
    client.get<List<KeloStore>>('/v1/ops/kelo/stores?status=submitted'),
    client.get<List<KeloProvisioning>>('/v1/ops/kelo/provisioning?status=failed_needs_review'),
    client.get<List<KeloProvisioning>>('/v1/ops/kelo/provisioning?status=reconciliation_required'),
    client.get<List<KeloListing>>('/v1/ops/kelo/listings?status=in_review'),
  ]);
  const stores = await Promise.all(
    submitted.data.map((store) =>
      client.get<KeloStoreForVetting>(`/v1/ops/kelo/stores/${store.id}`),
    ),
  );
  const needsOperator = [...stuck.data, ...reconcile.data];

  return (
    <>
      <h1>KELO</h1>
      {query['error'] && <p className="error">{query['error']}</p>}
      {query['ok'] && <p className="ok">Recorded.</p>}

      <h2>Stores waiting for vetting</h2>
      <p className="muted">
        Sandbox: there is no verification provider. Tick a requirement only after you have checked
        it. Approval links or creates exactly one KONY workspace and grants no payout authority.
      </p>
      {stores.length === 0 && <p className="muted">None.</p>}
      {stores.map((store) => (
        <div className="card" key={store.id}>
          <p>
            <strong>{store.display_name}</strong>{' '}
            {store.existing_workspace_id ? (
              <span className="pill">existing workspace {store.existing_workspace_id}</span>
            ) : (
              <span className="pill">
                new {store.business.kind} business: {store.business.name}
              </span>
            )}{' '}
            <span className="pill">verification: {store.verification ?? 'n/a'}</span>
          </p>
          <form action={vet} className="stack">
            <input type="hidden" name="id" value={store.id} />
            {store.categories.map((category) => (
              <fieldset key={category.slug}>
                <legend>
                  {category.name} (version {category.version})
                </legend>
                {category.requirements.map((requirement) => (
                  <label key={requirement} style={{ display: 'block' }}>
                    <input
                      type="checkbox"
                      name="attested"
                      value={`${category.slug}:${requirement}`}
                    />{' '}
                    {requirement}
                  </label>
                ))}
              </fieldset>
            ))}
            <fieldset>
              <legend>Restrictions copied to the workspace</legend>
              <label style={{ display: 'block' }}>
                <input type="checkbox" name="restrictions" value="payouts_suspended" /> Payouts
                suspended
              </label>
              <label style={{ display: 'block' }}>
                <input type="checkbox" name="restrictions" value="listing_suspended" /> Listing
                suspended
              </label>
            </fieldset>
            <label>
              Decision
              <select name="outcome" defaultValue="approved">
                <option value="approved">Approve</option>
                <option value="rejected">Reject</option>
              </select>
            </label>
            <label>
              Reason (recorded in the audit trail; shown to the merchant if rejected)
              <textarea name="reason" required minLength={10} maxLength={500} />
            </label>
            <button type="submit">Decide</button>
          </form>
        </div>
      ))}

      <h2>Provisioning that needs an operator</h2>
      {needsOperator.length === 0 && <p className="muted">None.</p>}
      {needsOperator.map((record) => (
        <div className="card" key={record.id}>
          <p>
            Store {record.store_id} <span className="pill">{record.status}</span>{' '}
            <span className="pill">reason: {record.reason ?? 'n/a'}</span>{' '}
            <span className="pill">after: {record.last_step}</span>
          </p>
          <p className="muted">
            Retrying changes no facts: the same rules decide again. Resolve the cause first (for
            example, the workspace admin invites the applicant).
          </p>
          <form action={retry} className="stack">
            <input type="hidden" name="id" value={record.id} />
            <label>
              Reason
              <textarea name="reason" required minLength={10} maxLength={500} />
            </label>
            <button type="submit" className="secondary">
              Retry
            </button>
          </form>
        </div>
      ))}

      <h2>Listings waiting for review</h2>
      {listings.data.length === 0 && <p className="muted">None.</p>}
      {listings.data.map((listing) => (
        <div className="card" key={listing.id}>
          <p>
            <strong>{listing.title}</strong> <span className="pill">{listing.category}</span>{' '}
            <span className="pill">revision {listing.revision}</span>
          </p>
          <p>{listing.description}</p>
          <form action={moderate} className="stack">
            <input type="hidden" name="id" value={listing.id} />
            <label>
              Decision
              <select name="outcome" defaultValue="approved">
                <option value="approved">Publish</option>
                <option value="rejected">Reject</option>
              </select>
            </label>
            <label>
              Reason (recorded in the audit trail)
              <textarea name="reason" required minLength={10} maxLength={500} />
            </label>
            <button type="submit">Decide</button>
          </form>
        </div>
      ))}
    </>
  );
}
