import { formatMinor, type KeloListing, type List, type Me } from '@aora/api-client';
import Link from 'next/link';
import { api, exponentOf } from '../../../../../lib/api';
import { LISTING_STATUS, LISTING_TYPE } from '../copy';
import { addSession, addVariant, submitListing, updateListing, updateVariant } from './actions';
import { ImageUpload } from './image-upload';

export default async function ListingPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; listingId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const { workspaceId, listingId } = await params;
  const query = await searchParams;
  const client = await api(workspaceId);
  const [me, listing, assets] = await Promise.all([
    client.get<Me>('/v1/me'),
    client.get<KeloListing>(`/v1/workspace/kelo/listings/${listingId}`),
    client.get<List<{ code: string; exponent: number }>>('/v1/assets'),
  ]);
  const exponent = exponentOf(assets.data, listing.currency);
  const money = (minor: string): string => `${listing.currency} ${formatMinor(minor, exponent)}`;
  const major = (minor: string): string => formatMinor(minor, exponent).replaceAll(',', '');
  const isAdmin =
    me.memberships.find((entry) => entry.workspace_id === workspaceId)?.role === 'admin';
  const canSubmit = isAdmin && (listing.status === 'draft' || listing.status === 'suspended');
  const hidden = (
    <>
      <input type="hidden" name="workspace_id" value={workspaceId} />
      <input type="hidden" name="listing_id" value={listing.id} />
    </>
  );

  return (
    <>
      <p>
        <Link href={`/w/${workspaceId}/kelo`}>← All listings</Link>
      </p>
      <h1>{listing.title}</h1>
      <p>
        <span className="pill">{LISTING_STATUS[listing.status]}</span>{' '}
        <span className="pill">{LISTING_TYPE[listing.type]}</span>{' '}
        <span className="pill">{listing.category}</span>
      </p>
      {query['error'] && <p className="error">{query['error']}</p>}
      {listing.status === 'in_review' && (
        <p className="muted">AORA is reviewing this listing. Buyers cannot see it yet.</p>
      )}

      <div className="card">
        <h2>Description</h2>
        {isAdmin ? (
          <form action={updateListing} className="stack">
            {hidden}
            <label>
              Title
              <input
                name="title"
                defaultValue={listing.title}
                required
                minLength={3}
                maxLength={120}
              />
            </label>
            <label>
              Description
              <textarea
                name="description"
                defaultValue={listing.description}
                required
                minLength={3}
                maxLength={4000}
                rows={5}
              />
            </label>
            <button type="submit" className="secondary">
              Save
            </button>
          </form>
        ) : (
          <p>{listing.description}</p>
        )}
      </div>

      {listing.type === 'stock_item' && (
        <div className="card">
          <h2>Variants and stock</h2>
          <table>
            <thead>
              <tr>
                <th>Variant</th>
                <th>Price</th>
                <th>In stock</th>
                <th>Reserved by orders</th>
                {isAdmin && <th />}
              </tr>
            </thead>
            <tbody>
              {listing.variants.map((variant) => (
                <tr key={variant.id}>
                  <td>{variant.name}</td>
                  <td>{money(variant.price_minor)}</td>
                  <td>{variant.stock_on_hand}</td>
                  <td>{variant.stock_reserved}</td>
                  {isAdmin && (
                    <td>
                      <form action={updateVariant} style={{ display: 'flex', gap: 8 }}>
                        {hidden}
                        <input type="hidden" name="variant_id" value={variant.id} />
                        <input
                          name="price"
                          defaultValue={major(variant.price_minor)}
                          size={10}
                          aria-label="Price"
                        />
                        <input
                          name="stock"
                          type="number"
                          min={variant.stock_reserved}
                          defaultValue={variant.stock_on_hand}
                          aria-label="Stock"
                        />
                        <button type="submit" className="secondary">
                          Update
                        </button>
                      </form>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {isAdmin && (
            <form action={addVariant} className="stack">
              {hidden}
              <label>
                Variant name
                <input name="name" required maxLength={80} />
              </label>
              <label>
                Price ({listing.currency})
                <input name="price" required inputMode="decimal" />
              </label>
              <label>
                Stock
                <input name="stock" type="number" min={0} defaultValue={1} required />
              </label>
              <button type="submit">Add variant</button>
            </form>
          )}
        </div>
      )}

      {listing.type === 'scheduled_service' && (
        <div className="card">
          <h2>Dates and places</h2>
          <table>
            <thead>
              <tr>
                <th>Starts</th>
                <th>Price</th>
                <th>Places</th>
                <th>Reserved</th>
              </tr>
            </thead>
            <tbody>
              {listing.sessions.map((session) => (
                <tr key={session.id}>
                  <td>
                    {new Date(session.starts_at).toLocaleString('en-KE', {
                      timeZone: 'Africa/Nairobi',
                    })}
                  </td>
                  <td>{money(session.price_minor)}</td>
                  <td>{session.capacity}</td>
                  <td>{session.reserved}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {isAdmin && (
            <form action={addSession} className="stack">
              {hidden}
              <label>
                Starts (Nairobi time)
                <input name="starts_at" type="datetime-local" required />
              </label>
              <label>
                Price ({listing.currency})
                <input name="price" required inputMode="decimal" />
              </label>
              <label>
                Places
                <input name="capacity" type="number" min={1} defaultValue={10} required />
              </label>
              <button type="submit">Add date</button>
            </form>
          )}
        </div>
      )}

      {listing.type === 'quote_service' && (
        <div className="card">
          <p className="muted">
            Buyers ask for a quote; you reply with a price and an expiry. Quotes arrive with the
            marketplace.
          </p>
        </div>
      )}

      <div className="card">
        <h2>Photos</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {listing.images.map((image) => (
            // Sized to the slot so a slow connection is not asked for more than it shows.
            <img
              key={image.id}
              src={image.url}
              alt=""
              width={120}
              height={120}
              style={{ objectFit: 'cover' }}
            />
          ))}
        </div>
        {isAdmin && <ImageUpload workspaceId={workspaceId} listingId={listing.id} />}
      </div>

      {canSubmit && (
        <div className="card">
          <form action={submitListing}>
            {hidden}
            <button type="submit">Send for review</button>
          </form>
        </div>
      )}
    </>
  );
}
