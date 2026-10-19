import type { KeloListing, KeloWorkspaceStore, List, Me } from '@aora/api-client';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { api, field, messageOf } from '../../../../lib/api';
import { LISTING_STATUS, LISTING_TYPE } from './copy';

async function createListing(form: FormData): Promise<void> {
  'use server';
  const workspaceId = field(form, 'workspace_id');
  let target: string;
  try {
    const [category, type] = field(form, 'category_type').split('|');
    const created = await (
      await api(workspaceId)
    ).post<KeloListing>('/v1/workspace/kelo/listings', {
      category,
      type,
      title: field(form, 'title'),
      description: field(form, 'description'),
      currency: 'KES',
    });
    target = `/w/${workspaceId}/kelo/${created.id}`;
  } catch (error) {
    target = `/w/${workspaceId}/kelo?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

export default async function Kelo({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params;
  const query = await searchParams;
  const client = await api(workspaceId);
  const [me, store] = await Promise.all([
    client.get<Me>('/v1/me'),
    client.get<KeloWorkspaceStore>('/v1/workspace/kelo/store'),
  ]);
  if (!store.store) {
    return (
      <>
        <h1>KELO</h1>
        <div className="card">
          <p>This workspace has no KELO store yet.</p>
          <p>
            <Link href="/kelo">Enlist a store</Link> to list goods and services on the KELO
            marketplace.
          </p>
        </div>
      </>
    );
  }
  const listings = await client.get<List<KeloListing>>('/v1/workspace/kelo/listings');
  const isAdmin =
    me.memberships.find((entry) => entry.workspace_id === workspaceId)?.role === 'admin';
  return (
    <>
      <h1>KELO: {store.store.display_name}</h1>
      <p>
        <Link href={`/w/${workspaceId}/kelo/dashboard`}>Dashboard</Link> ·{' '}
        <Link href={`/w/${workspaceId}/kelo/purchases`}>Orders</Link>
      </p>
      <p className="muted">
        A listing is visible to buyers only after AORA has reviewed it. Being an administrator here
        does not by itself let anyone pay out money.
      </p>
      {query['error'] && <p className="error">{query['error']}</p>}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Listing</th>
              <th>Kind</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {listings.data.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  No listings yet.
                </td>
              </tr>
            )}
            {listings.data.map((listing) => (
              <tr key={listing.id}>
                <td>
                  <Link href={`/w/${workspaceId}/kelo/${listing.id}`}>{listing.title}</Link>
                </td>
                <td>{LISTING_TYPE[listing.type]}</td>
                <td>
                  <span className="pill">{LISTING_STATUS[listing.status]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {isAdmin && (
        <div className="card">
          <h2>New listing</h2>
          <form action={createListing} className="stack">
            <input type="hidden" name="workspace_id" value={workspaceId} />
            <label>
              Category and kind
              <select name="category_type" required defaultValue="">
                <option value="" disabled>
                  Choose
                </option>
                {store.store.categories.flatMap((category) =>
                  category.listing_types.map((type) => (
                    <option key={`${category.slug}|${type}`} value={`${category.slug}|${type}`}>
                      {category.name}: {LISTING_TYPE[type]}
                    </option>
                  )),
                )}
              </select>
            </label>
            <label>
              Title
              <input name="title" required minLength={3} maxLength={120} />
            </label>
            <label>
              Description (what it is and what is included; never a buyer&apos;s health details)
              <textarea name="description" required minLength={3} maxLength={4000} rows={4} />
            </label>
            <button type="submit">Create draft</button>
          </form>
        </div>
      )}
    </>
  );
}
