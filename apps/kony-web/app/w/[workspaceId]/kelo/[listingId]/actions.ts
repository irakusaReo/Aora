'use server';

import { type AoraApi, type KeloUploadGrant, type List, toMinorUnits } from '@aora/api-client';
import { redirect } from 'next/navigation';
import { api, exponentOf, field, messageOf } from '../../../../../lib/api';

// Listings in this section are priced in KES; its exponent comes from the API, never assumed.
const CURRENCY = 'KES';

function back(form: FormData, error?: unknown): never {
  const base = `/w/${field(form, 'workspace_id')}/kelo/${field(form, 'listing_id')}`;
  redirect(error === undefined ? base : `${base}?error=${encodeURIComponent(messageOf(error))}`);
}

async function call(form: FormData, work: (path: string) => Promise<unknown>): Promise<never> {
  const path = `/v1/workspace/kelo/listings/${field(form, 'listing_id')}`;
  try {
    await work(path);
  } catch (error) {
    back(form, error);
  }
  back(form);
}

async function minor(client: AoraApi, form: FormData, key: string): Promise<string> {
  const assets = await client.get<List<{ code: string; exponent: number }>>('/v1/assets');
  const value = toMinorUnits(field(form, key), exponentOf(assets.data, CURRENCY));
  if (!value) redirectWith(form, 'Enter an amount in shillings, for example 1,250.00.');
  return value;
}

function redirectWith(form: FormData, message: string): never {
  const base = `/w/${field(form, 'workspace_id')}/kelo/${field(form, 'listing_id')}`;
  redirect(`${base}?error=${encodeURIComponent(message)}`);
}

export async function updateListing(form: FormData): Promise<void> {
  const client = await api(field(form, 'workspace_id'));
  await call(form, (path) =>
    client.patch(path, { title: field(form, 'title'), description: field(form, 'description') }),
  );
}

export async function addVariant(form: FormData): Promise<void> {
  const client = await api(field(form, 'workspace_id'));
  const price = await minor(client, form, 'price');
  await call(form, (path) =>
    client.post(`${path}/variants`, {
      name: field(form, 'name'),
      price_minor: price,
      stock_on_hand: Number.parseInt(field(form, 'stock'), 10),
    }),
  );
}

export async function updateVariant(form: FormData): Promise<void> {
  const client = await api(field(form, 'workspace_id'));
  const price = await minor(client, form, 'price');
  await call(form, (path) =>
    client.patch(`${path}/variants/${field(form, 'variant_id')}`, {
      price_minor: price,
      stock_on_hand: Number.parseInt(field(form, 'stock'), 10),
    }),
  );
}

export async function addSession(form: FormData): Promise<void> {
  const client = await api(field(form, 'workspace_id'));
  const price = await minor(client, form, 'price');
  await call(form, (path) =>
    client.post(`${path}/sessions`, {
      // The form asks for Nairobi time (UTC+3 all year, no daylight saving).
      starts_at: `${field(form, 'starts_at')}:00+03:00`,
      price_minor: price,
      capacity: Number.parseInt(field(form, 'capacity'), 10),
    }),
  );
}

export async function submitListing(form: FormData): Promise<void> {
  const client = await api(field(form, 'workspace_id'));
  await call(form, (path) => client.post(`${path}/submit`));
}

/** Step 1 of an image upload: a token for one pathname. The bytes go straight to the store. */
export async function grantUpload(
  workspaceId: string,
  listingId: string,
  contentType: string,
  sizeBytes: number,
): Promise<{ grant: KeloUploadGrant | null; error: string | null }> {
  try {
    const grant = await (
      await api(workspaceId)
    ).post<KeloUploadGrant>(`/v1/workspace/kelo/listings/${listingId}/images/upload-token`, {
      content_type: contentType,
      size_bytes: sizeBytes,
    });
    return { grant, error: null };
  } catch (error) {
    return { grant: null, error: messageOf(error) };
  }
}

/** Step 3: the API checks what arrived, then attaches it. */
export async function attachImage(
  workspaceId: string,
  listingId: string,
  pathname: string,
): Promise<{ error: string | null }> {
  try {
    await (
      await api(workspaceId)
    ).post(`/v1/workspace/kelo/listings/${listingId}/images`, {
      pathname,
    });
    return { error: null };
  } catch (error) {
    return { error: messageOf(error) };
  }
}
