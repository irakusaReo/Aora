import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LISTING_TRANSITIONS } from '../src/modules/kelo/catalogue.service.js';
import { IMAGE_STORE, SimulatedImageStore } from '../src/modules/kelo/images.js';
import { type Harness, startHarness } from './support/harness.js';
import { newUser } from './support/users.js';

/**
 * KELO catalogue and moderation (ADR 0017; journey K1's second half). Written
 * before the code.
 */

let h: Harness;
let operator: string;
let merchant: { token: string; workspace: string };
let images: SimulatedImageStore;

const as = (who: { token: string; workspace?: string }) => ({
  get: (path: string) => {
    const r = h.http().get(path).set('Authorization', `Bearer ${who.token}`);
    return who.workspace ? r.set('Aora-Workspace-Id', who.workspace) : r;
  },
  post: (path: string, body: object = {}) => {
    const r = h.http().post(path).set('Authorization', `Bearer ${who.token}`);
    return (who.workspace ? r.set('Aora-Workspace-Id', who.workspace) : r).send(body);
  },
  patch: (path: string, body: object) => {
    const r = h.http().patch(path).set('Authorization', `Bearer ${who.token}`);
    return (who.workspace ? r.set('Aora-Workspace-Id', who.workspace) : r).send(body);
  },
});

/** A merchant with a provisioned KELO store allowed in the given categories. */
async function storeIn(
  categories: string[],
  restrictions: string[] = [],
): Promise<{ token: string; workspace: string }> {
  const owner = await newUser(h, 'Merchant');
  const created = await h
    .http()
    .post('/v1/kelo/stores')
    .set('Authorization', `Bearer ${owner.token}`)
    .set('Idempotency-Key', randomUUID())
    .send({
      display_name: 'Catalogue Test Store',
      categories,
      business: {
        kind: 'registered',
        name: `Catalogue ${randomUUID().slice(0, 8)} Ltd`,
        country: 'KE',
        registration: { type: 'sandbox_registration_number', value: randomUUID().slice(0, 12) },
      },
    });
  expect(created.status).toBe(201);
  const detail = await as({ token: operator }).get(
    `/v1/ops/kelo/stores/${created.body.id as string}`,
  );
  const attestations = Object.fromEntries(
    (detail.body.categories as { slug: string; requirements: string[] }[]).map((c) => [
      c.slug,
      c.requirements,
    ]),
  );
  const decided = await as({ token: operator }).post(
    `/v1/ops/kelo/stores/${created.body.id as string}/decision`,
    { outcome: 'approved', reason: 'Sandbox vetting completed.', attestations, restrictions },
  );
  expect(decided.status).toBe(200);
  await h.settle();
  const store = await as(owner).get(`/v1/kelo/stores/${created.body.id as string}`);
  expect(store.body.provisioning_status).toBe('completed');
  return { token: owner.token, workspace: store.body.workspace_id as string };
}

async function draft(
  who: { token: string; workspace: string },
  body: Record<string, unknown> = {},
): Promise<string> {
  const response = await as(who).post('/v1/workspace/kelo/listings', {
    category: 'electronics',
    type: 'stock_item',
    title: 'Sandbox phone 64 GB',
    description: 'A sandbox smartphone with 64 GB of storage and a two-day battery.',
    currency: 'KES',
    ...body,
  });
  expect(response.status).toBe(201);
  return response.body.id as string;
}

async function withVariant(
  who: { token: string; workspace: string },
  listing: string,
  price = '1200000',
  stock = 5,
): Promise<string> {
  const response = await as(who).post(`/v1/workspace/kelo/listings/${listing}/variants`, {
    name: 'Black',
    price_minor: price,
    stock_on_hand: stock,
  });
  expect(response.status).toBe(201);
  return response.body.id as string;
}

const submit = (who: { token: string; workspace: string }, listing: string): Promise<Response> =>
  as(who).post(`/v1/workspace/kelo/listings/${listing}/submit`);

const moderate = (listing: string, outcome: string): Promise<Response> =>
  as({ token: operator }).post(`/v1/ops/kelo/listings/${listing}/decision`, {
    outcome,
    reason: 'Sandbox moderation decision.',
  });

async function published(
  who: { token: string; workspace: string },
  body: Record<string, unknown> = {},
): Promise<string> {
  const listing = await draft(who, body);
  await withVariant(who, listing);
  expect((await submit(who, listing)).status).toBe(200);
  expect((await moderate(listing, 'approved')).status).toBe(200);
  return listing;
}

const search = (q: string): Promise<Response> =>
  h.http().get(`/v1/kelo/marketplace/listings?q=${encodeURIComponent(q)}`);

const statusOf = async (listing: string): Promise<string> =>
  (await as(merchant).get(`/v1/workspace/kelo/listings/${listing}`)).body.status as string;

beforeAll(async () => {
  h = await startHarness();
  operator = await h.signIn('operator');
  images = h.app.get<SimulatedImageStore>(IMAGE_STORE);
  merchant = await storeIn(['electronics', 'motorbikes', 'holidays', 'moving']);
});
afterAll(() => h.close());

describe('listing state machine', () => {
  it('allows exactly the transitions of ADR 0017', () => {
    expect(LISTING_TRANSITIONS).toEqual({
      draft: ['in_review'],
      in_review: ['published', 'rejected'],
      rejected: ['draft'],
      published: ['suspended', 'in_review'],
      suspended: ['in_review'],
    });
  });
});

describe('the workspace store', () => {
  it("shows a workspace's members its store and the categories it may list in", async () => {
    const response = await as(merchant).get('/v1/workspace/kelo/store');
    expect(response.status).toBe(200);
    expect(response.body.store).toMatchObject({ display_name: 'Catalogue Test Store' });
    expect(
      (response.body.store.categories as { slug: string }[]).map((c) => c.slug).sort(),
    ).toEqual(['electronics', 'holidays', 'motorbikes', 'moving']);
    const none = await as({ token: await h.signIn('adminA'), workspace: h.seed.tenantA }).get(
      '/v1/workspace/kelo/store',
    );
    expect(none.body).toMatchObject({ store: null });
  });
});

describe('creating listings', () => {
  it('creates a draft in a category the store was vetted for', async () => {
    const listing = await draft(merchant);
    const view = await as(merchant).get(`/v1/workspace/kelo/listings/${listing}`);
    expect(view.body).toMatchObject({
      status: 'draft',
      category: 'electronics',
      type: 'stock_item',
      currency: 'KES',
      mode: 'sandbox',
    });
  });

  it('refuses a category the store was not vetted for, and a type the category does not allow', async () => {
    const other = await as(merchant).post('/v1/workspace/kelo/listings', {
      category: 'dental',
      type: 'scheduled_service',
      title: 'Check-up',
      description: 'A sandbox dental appointment.',
      currency: 'KES',
    });
    expect(other.status).toBe(403);
    const wrongType = await as(merchant).post('/v1/workspace/kelo/listings', {
      category: 'electronics',
      type: 'scheduled_service',
      title: 'Phone repair session',
      description: 'A sandbox session.',
      currency: 'KES',
    });
    expect(wrongType.status).toBe(400);
  });

  it('is for workspace admins of a KELO store only', async () => {
    const cashier = { token: await h.signIn('cashierA'), workspace: h.seed.tenantA };
    const refused = await as(cashier).post('/v1/workspace/kelo/listings', {
      category: 'electronics',
      type: 'stock_item',
      title: 'Phone',
      description: 'A phone.',
      currency: 'KES',
    });
    expect(refused.status).toBe(403);
    // Tenant A has no KELO store at all.
    const admin = { token: await h.signIn('adminA'), workspace: h.seed.tenantA };
    const noStore = await as(admin).post('/v1/workspace/kelo/listings', {
      category: 'electronics',
      type: 'stock_item',
      title: 'Phone',
      description: 'A phone.',
      currency: 'KES',
    });
    expect(noStore.status).toBe(403);
  });

  it("never shows one merchant another merchant's listing", async () => {
    const listing = await draft(merchant);
    const adminB = { token: await h.signIn('adminB'), workspace: h.seed.tenantB };
    expect((await as(adminB).get(`/v1/workspace/kelo/listings/${listing}`)).status).toBe(404);
    const seen = await h.db.withTenant(
      h.seed.tenantB,
      (tx) =>
        tx.$queryRaw<
          { n: bigint }[]
        >`select count(*) n from kelo.listing where id = ${listing}::uuid`,
    );
    expect(Number(seen[0]?.n)).toBe(0);
  });
});

describe('submission and moderation', () => {
  it('needs a priced variant before a stock item can be submitted', async () => {
    const listing = await draft(merchant);
    const response = await submit(merchant, listing);
    expect(response.status).toBe(400);
    await withVariant(merchant, listing);
    expect((await submit(merchant, listing)).status).toBe(200);
    expect(await statusOf(listing)).toBe('in_review');
  });

  it('blocks a prohibited item at submission', async () => {
    const listing = await draft(merchant, {
      title: 'Sandbox counterfeit phone',
      description: 'Not a real item.',
    });
    await withVariant(merchant, listing);
    const response = await submit(merchant, listing);
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('prohibited_item');
    expect(await statusOf(listing)).toBe('draft');
  });

  it('keeps a listing invisible to the marketplace until an operator approves it', async () => {
    const word = `zebrafone${randomUUID().slice(0, 6)}`;
    const listing = await draft(merchant, { title: `Sandbox ${word}` });
    await withVariant(merchant, listing);
    await submit(merchant, listing);
    expect((await search(word)).body.data).toEqual([]);
    expect((await h.http().get(`/v1/kelo/marketplace/listings/${listing}`)).status).toBe(404);

    expect((await moderate(listing, 'approved')).status).toBe(200);
    const found = await search(word);
    expect((found.body.data as { id: string }[]).map((row) => row.id)).toEqual([listing]);
    const page = await h.http().get(`/v1/kelo/marketplace/listings/${listing}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ id: listing, title: `Sandbox ${word}`, mode: 'sandbox' });
    expect(page.body.variants).toEqual([
      expect.objectContaining({ name: 'Black', price_minor: '1200000', in_stock: true }),
    ]);
  });

  it('is operator-only, audited, and a rejected listing goes back to draft when edited', async () => {
    const listing = await draft(merchant);
    await withVariant(merchant, listing);
    await submit(merchant, listing);
    const byMerchant = await as({ token: merchant.token }).post(
      `/v1/ops/kelo/listings/${listing}/decision`,
      { outcome: 'approved', reason: 'Approving my own listing.' },
    );
    expect(byMerchant.status).toBe(403);
    expect((await moderate(listing, 'rejected')).status).toBe(200);
    expect(await statusOf(listing)).toBe('rejected');
    const edited = await as(merchant).patch(`/v1/workspace/kelo/listings/${listing}`, {
      description: 'A clearer description of the sandbox phone.',
    });
    expect(edited.status).toBe(200);
    expect(edited.body.status).toBe('draft');
    const decisions = await h.owner((client) =>
      client.query(`select outcome from kelo.moderation_decision where listing_id = $1`, [listing]),
    );
    expect(decisions.rows).toEqual([{ outcome: 'rejected' }]);
  });

  it('lists what waits for review, oldest first, for operators only', async () => {
    const listing = await draft(merchant);
    await withVariant(merchant, listing);
    await submit(merchant, listing);
    const queue = await as({ token: operator }).get('/v1/ops/kelo/listings?status=in_review');
    expect(queue.status).toBe(200);
    expect((queue.body.data as { id: string }[]).map((row) => row.id)).toContain(listing);
    expect((await as({ token: merchant.token }).get('/v1/ops/kelo/listings')).status).toBe(403);
  });

  it('sends a published listing in a restricted category back to review when its price changes', async () => {
    const listing = await draft(merchant, {
      category: 'motorbikes',
      title: 'Sandbox motorbike 150cc',
      description: 'A sandbox motorbike.',
    });
    const variant = await withVariant(merchant, listing, '15000000', 2);
    await submit(merchant, listing);
    await moderate(listing, 'approved');
    expect(await statusOf(listing)).toBe('published');
    const changed = await as(merchant).patch(
      `/v1/workspace/kelo/listings/${listing}/variants/${variant}`,
      { price_minor: '14000000' },
    );
    expect(changed.status).toBe(200);
    expect(await statusOf(listing)).toBe('in_review');
    expect((await h.http().get(`/v1/kelo/marketplace/listings/${listing}`)).status).toBe(404);
  });

  it('keeps an unrestricted listing published through a price change', async () => {
    const listing = await published(merchant);
    const variants = await as(merchant).get(`/v1/workspace/kelo/listings/${listing}`);
    const variant = (variants.body.variants as { id: string }[])[0]?.id ?? '';
    await as(merchant).patch(`/v1/workspace/kelo/listings/${listing}/variants/${variant}`, {
      price_minor: '1100000',
    });
    expect(await statusOf(listing)).toBe('published');
  });

  it('refuses an edit that adds a prohibited term to a published listing', async () => {
    const listing = await published(merchant);
    const edited = await as(merchant).patch(`/v1/workspace/kelo/listings/${listing}`, {
      description: 'Now with counterfeit accessories.',
    });
    expect(edited.status).toBe(422);
    expect(await statusOf(listing)).toBe('published');
  });

  it('hides a suspended listing until it is resubmitted and approved', async () => {
    const listing = await published(merchant);
    expect((await moderate(listing, 'suspended')).status).toBe(200);
    expect((await h.http().get(`/v1/kelo/marketplace/listings/${listing}`)).status).toBe(404);
    expect((await submit(merchant, listing)).status).toBe(200);
    expect(await statusOf(listing)).toBe('in_review');
  });

  it('refuses submission while the workspace has listing suspended', async () => {
    const restricted = await storeIn(['electronics'], ['listing_suspended']);
    const listing = await draft(restricted);
    await withVariant(restricted, listing);
    const response = await submit(restricted, listing);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('workspace_restricted');
  });
});

describe('stock and capacity', () => {
  it('cannot set stock below what is already reserved', async () => {
    const listing = await draft(merchant);
    const variant = await withVariant(merchant, listing, '1200000', 5);
    await h.owner((client) =>
      client.query(`update kelo.listing_variant set stock_reserved = 3 where id = $1`, [variant]),
    );
    const lowered = await as(merchant).patch(
      `/v1/workspace/kelo/listings/${listing}/variants/${variant}`,
      { stock_on_hand: 2 },
    );
    expect(lowered.status).toBe(409);
    expect(lowered.body.error.code).toBe('conflict');
  });

  it('holds sessions with a date and a capacity for a scheduled service', async () => {
    const listing = await draft(merchant, {
      category: 'holidays',
      type: 'scheduled_service',
      title: 'Sandbox coast weekend',
      description: 'Two nights at a sandbox resort.',
    });
    const session = await as(merchant).post(`/v1/workspace/kelo/listings/${listing}/sessions`, {
      starts_at: '2027-03-01T08:00:00Z',
      price_minor: '4500000',
      capacity: 20,
    });
    expect(session.status).toBe(201);
    expect(session.body).toMatchObject({ capacity: 20, reserved: 0, price_minor: '4500000' });
    expect((await submit(merchant, listing)).status).toBe(200);
  });

  it('lets a quote-based service be submitted without a price', async () => {
    const listing = await draft(merchant, {
      category: 'moving',
      type: 'quote_service',
      title: 'Sandbox house move',
      description: 'A quote for moving a household within Nairobi.',
    });
    expect((await submit(merchant, listing)).status).toBe(200);
  });
});

describe('images (bytes never pass through the API)', () => {
  it('issues an upload token bound to one path, image types and 4 MB', async () => {
    const listing = await draft(merchant);
    const refusedType = await as(merchant).post(
      `/v1/workspace/kelo/listings/${listing}/images/upload-token`,
      { content_type: 'text/html', size_bytes: 1000 },
    );
    expect(refusedType.status).toBe(400);
    const tooBig = await as(merchant).post(
      `/v1/workspace/kelo/listings/${listing}/images/upload-token`,
      { content_type: 'image/png', size_bytes: 4 * 1024 * 1024 + 1 },
    );
    expect(tooBig.status).toBe(400);
    const issued = await as(merchant).post(
      `/v1/workspace/kelo/listings/${listing}/images/upload-token`,
      { content_type: 'image/png', size_bytes: 200_000 },
    );
    expect(issued.status).toBe(201);
    expect(issued.body.pathname).toMatch(
      new RegExp(`^kelo/${merchant.workspace}/${listing}/[0-9a-f-]{36}\\.png$`),
    );
    expect(issued.body).toMatchObject({ access: 'public', provider: 'simulator' });
    expect(images.constraintsFor(issued.body.pathname as string)).toEqual({
      allowedContentTypes: ['image/png'],
      maximumSizeInBytes: 4 * 1024 * 1024,
    });
  });

  it('attaches an uploaded image only after checking its path, type and size', async () => {
    const listing = await draft(merchant);
    const issued = await as(merchant).post(
      `/v1/workspace/kelo/listings/${listing}/images/upload-token`,
      { content_type: 'image/jpeg', size_bytes: 300_000 },
    );
    const pathname = issued.body.pathname as string;
    const notYet = await as(merchant).post(`/v1/workspace/kelo/listings/${listing}/images`, {
      pathname,
    });
    expect(notYet.status).toBe(404);
    images.simulateUpload(pathname, 'image/jpeg', 300_000);
    const attached = await as(merchant).post(`/v1/workspace/kelo/listings/${listing}/images`, {
      pathname,
    });
    expect(attached.status).toBe(201);
    expect(attached.body).toMatchObject({ content_type: 'image/jpeg', size_bytes: 300_000 });
    expect(attached.body.url).toEqual(expect.stringContaining(pathname));

    const elsewhere = `kelo/${merchant.workspace}/${randomUUID()}/${randomUUID()}.jpg`;
    images.simulateUpload(elsewhere, 'image/jpeg', 1000);
    const wrongPath = await as(merchant).post(`/v1/workspace/kelo/listings/${listing}/images`, {
      pathname: elsewhere,
    });
    expect(wrongPath.status).toBe(400);
  });
});

describe('taxonomy is data', () => {
  it('lists the current categories from the database', async () => {
    const response = await h.http().get('/v1/kelo/categories');
    expect(response.status).toBe(200);
    expect((response.body.data as unknown[]).length).toBe(12);
    expect(response.body.data).toContainEqual(
      expect.objectContaining({ slug: 'holidays', listing_types: ['scheduled_service'] }),
    );
  });

  it('names no category in application code', () => {
    const root = fileURLToPath(new URL('../src/modules', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.ts')) files.push(path);
      }
    };
    walk(root);
    const slugs = ['solar-home-systems', 'medical-cosmetic', 'courses-and-exams', 'motorbikes'];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const slug of slugs)
        expect(text.includes(`'${slug}'`), `${file} names ${slug}`).toBe(false);
    }
  });
});
