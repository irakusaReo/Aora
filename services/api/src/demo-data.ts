import { randomUUID } from 'node:crypto';
import { AppError } from './platform/errors.js';
import { CatalogueService } from './modules/kelo/catalogue.service.js';
import { LayawayService } from './modules/kelo/layaway.service.js';
import { ProvisioningService } from './modules/kelo/provisioning.service.js';
import { StoresService } from './modules/kelo/stores.service.js';
import { Database } from './platform/database.js';

/**
 * SANDBOX demo catalogue for the MVP gate (phase-10 10A): stores vetted for all
 * twelve KELO categories, each with published listings and every plan its
 * category allows. Everything goes through the API's own services, so every
 * domain rule and audit event applies; no session is minted and no ledger
 * entry is written. Every record is found by a fixed key, so a second run
 * changes nothing (P10-3).
 *
 * The demo identities are synthetic (P10-2): `+999` phone numbers, `.test`
 * emails and a `demo_` subject that no Clerk user id can ever equal.
 */

interface DemoListing {
  readonly category: string;
  readonly title: string;
  readonly description: string;
  readonly type: 'stock_item' | 'scheduled_service' | 'quote_service';
  /** Price in KES minor units. */
  readonly variants?: readonly { name: string; price: string; stock: number }[];
  readonly sessions?: readonly { daysAhead: number; price: string; capacity: number }[];
}

interface DemoStore {
  readonly key: string;
  readonly phone: string;
  readonly name: string;
  readonly categories: readonly string[];
  readonly listings: readonly DemoListing[];
}

const DESCRIPTION = 'SANDBOX demo listing: nothing is sold or delivered.';

export const DEMO_STORES: readonly DemoStore[] = [
  {
    key: 'duka',
    phone: '+99900000101',
    name: 'Duka Electronics (demo)',
    categories: ['electronics', 'home-appliances', 'furniture'],
    listings: [
      {
        category: 'electronics',
        type: 'stock_item',
        title: 'Smartphone 128 GB (demo)',
        description: `A mid-range smartphone. ${DESCRIPTION}`,
        variants: [
          { name: 'Black', price: '2400000', stock: 25 },
          { name: 'Blue', price: '2400000', stock: 10 },
        ],
      },
      {
        category: 'electronics',
        type: 'stock_item',
        title: 'Laptop 14-inch (demo)',
        description: `A student laptop. ${DESCRIPTION}`,
        variants: [{ name: 'Standard', price: '6500000', stock: 8 }],
      },
      {
        category: 'home-appliances',
        type: 'stock_item',
        title: 'Two-door fridge (demo)',
        description: `A 200-litre fridge. ${DESCRIPTION}`,
        variants: [{ name: 'Silver', price: '4800000', stock: 5 }],
      },
      {
        category: 'furniture',
        type: 'stock_item',
        title: 'Three-seater sofa (demo)',
        description: `A fabric sofa. ${DESCRIPTION}`,
        variants: [{ name: 'Grey', price: '3500000', stock: 4 }],
      },
    ],
  },
  {
    key: 'jua',
    phone: '+99900000102',
    name: 'Jua Solar and Bikes (demo)',
    categories: ['solar-home-systems', 'motorbikes'],
    listings: [
      {
        category: 'solar-home-systems',
        type: 'stock_item',
        title: 'Solar home kit, 4 lights and a radio (demo)',
        description: `Panel, battery, four lights and a radio. ${DESCRIPTION}`,
        variants: [
          { name: 'Basic', price: '2400000', stock: 30 },
          { name: 'With TV', price: '5200000', stock: 12 },
        ],
      },
      {
        category: 'motorbikes',
        type: 'stock_item',
        title: 'Commuter motorbike 150 cc (demo)',
        description: `A commuter motorbike. ${DESCRIPTION}`,
        variants: [{ name: 'Red', price: '15500000', stock: 3 }],
      },
    ],
  },
  {
    key: 'safari',
    phone: '+99900000103',
    name: 'Safari Holidays and Courses (demo)',
    categories: ['holidays', 'courses-and-exams'],
    listings: [
      {
        category: 'holidays',
        type: 'scheduled_service',
        title: 'Diani beach, 4 nights (demo)',
        description: `A coastal holiday for two. ${DESCRIPTION}`,
        sessions: [
          { daysAhead: 60, price: '4500000', capacity: 10 },
          { daysAhead: 120, price: '4800000', capacity: 10 },
        ],
      },
      {
        category: 'courses-and-exams',
        type: 'scheduled_service',
        title: 'Bookkeeping course, 6 weeks (demo)',
        description: `An evening course. ${DESCRIPTION}`,
        sessions: [{ daysAhead: 45, price: '1800000', capacity: 30 }],
      },
    ],
  },
  {
    key: 'afya',
    phone: '+99900000104',
    name: 'Afya Clinic and Optical (demo)',
    categories: ['dental', 'medical-cosmetic', 'optical'],
    listings: [
      {
        category: 'dental',
        type: 'scheduled_service',
        title: 'Dental cleaning appointment (demo)',
        description: `A routine appointment. ${DESCRIPTION}`,
        sessions: [{ daysAhead: 30, price: '600000', capacity: 8 }],
      },
      {
        category: 'medical-cosmetic',
        type: 'scheduled_service',
        title: 'Skin care consultation (demo)',
        description: `A consultation appointment. ${DESCRIPTION}`,
        sessions: [{ daysAhead: 30, price: '800000', capacity: 8 }],
      },
      {
        category: 'optical',
        type: 'stock_item',
        title: 'Prescription glasses (demo)',
        description: `Frames and standard lenses. ${DESCRIPTION}`,
        variants: [{ name: 'Standard frames', price: '1200000', stock: 20 }],
      },
    ],
  },
  {
    key: 'fundi',
    phone: '+99900000105',
    name: 'Fundi Home Services (demo)',
    categories: ['home-repairs', 'moving'],
    listings: [
      {
        category: 'home-repairs',
        type: 'quote_service',
        title: 'Plumbing repair, priced by quote (demo)',
        description: `Describe the job for a price. ${DESCRIPTION}`,
      },
      {
        category: 'moving',
        type: 'quote_service',
        title: 'House move within Nairobi, priced by quote (demo)',
        description: `Describe the move for a price. ${DESCRIPTION}`,
      },
    ],
  },
];

const OPERATOR = { key: 'operator', phone: '+99900000100' };

/** Resolves a service from the application (Nest's `app.get`). */
export type Resolve = <T>(type: abstract new (...args: never[]) => T) => T;

export interface DemoResult {
  readonly stores: number;
  readonly listings: number;
}

export async function seedDemo(get: Resolve): Promise<DemoResult> {
  const db = get(Database);
  const stores = get(StoresService);
  const provisioning = get(ProvisioningService);
  const catalogue = get(CatalogueService);
  const layaway = get(LayawayService);

  const operatorId = await demoAccount(db, OPERATOR.key, OPERATOR.phone, true);
  const operator = { accountId: operatorId, requestId: `demo-seed-${randomUUID()}` };
  let listings = 0;

  for (const spec of DEMO_STORES) {
    const accountId = await demoAccount(db, spec.key, spec.phone, false);
    const actor = { accountId, requestId: operator.requestId };
    const { store } = await stores.enlist(actor, `demo-store-${spec.key}`, {
      displayName: spec.name,
      categories: spec.categories,
      business: {
        kind: 'registered',
        name: `${spec.name} Ltd`,
        country: 'KE',
        registration: {
          type: 'sandbox_registration_number',
          value: `DEMO-${spec.key.toUpperCase()}`,
        },
        location: null,
        verification: 'verified',
      },
    });
    if (store.status === 'submitted') {
      const detail = await stores.operatorGet(store.id);
      await stores.decide(operator, store.id, {
        outcome: 'approved',
        reason: 'SANDBOX demo store, vetted by the demo seed.',
        attestations: Object.fromEntries(detail.categories.map((c) => [c.slug, c.requirements])),
        restrictions: [],
      });
    }
    // Provisioning normally runs from the outbox; here it is stepped until it stops.
    for (let step = 0; step < 20 && !(await provisioning.stepByStore(store.id)); step++);
    const provisioned = await stores.get(accountId, store.id);
    if (!provisioned.workspace_id) {
      throw new Error(
        `Demo store ${spec.key} was not provisioned (${String(provisioned.provisioning_status)}).`,
      );
    }
    const merchant = { ...actor, tenantId: provisioned.workspace_id };

    const existing = await catalogue.list(merchant.tenantId);
    for (const item of spec.listings) {
      let listing = existing.find((row) => row.title === item.title);
      listing ??= await catalogue.create(merchant, {
        category: item.category,
        type: item.type,
        title: item.title,
        description: item.description,
        currency: 'KES',
      });
      if (listing.status === 'draft') {
        for (const variant of item.variants ?? []) {
          await catalogue.addVariant(merchant, listing.id, {
            name: variant.name,
            priceMinor: BigInt(variant.price),
            stockOnHand: variant.stock,
          });
        }
        for (const session of item.sessions ?? []) {
          await catalogue.addSession(merchant, listing.id, {
            startsAt: daysFromNow(session.daysAhead),
            priceMinor: BigInt(session.price),
            capacity: session.capacity,
          });
        }
        listing = await catalogue.submit(merchant, listing.id);
      }
      if (listing.status === 'in_review') {
        await catalogue.moderate(operator, listing.id, {
          outcome: 'approved',
          reason: 'SANDBOX demo listing, approved by the demo seed.',
        });
      }
      if (item.type !== 'quote_service') {
        for (const option of await layaway.planOptions(merchant.tenantId, listing.id)) {
          if (!option.offered) await layaway.offerPlan(merchant, listing.id, option.template_key);
        }
      }
      listings += 1;
    }
  }
  return { stores: DEMO_STORES.length, listings };
}

/** A demo account found by its fixed subject, or created once. */
async function demoAccount(
  db: Database,
  key: string,
  phone: string,
  operator: boolean,
): Promise<string> {
  const subject = `demo_${key}`;
  return db.asPlatform(async (tx) => {
    const found = await tx.user_account.findFirst({ where: { clerk_user_id: subject } });
    if (found) return found.id;
    const taken = await tx.user_account.findFirst({ where: { phone_e164: phone } });
    if (taken) throw new AppError('conflict', `Demo phone ${phone} belongs to another account.`);
    const person = await tx.person.create({ data: {} });
    const account = await tx.user_account.create({
      data: {
        person_id: person.id,
        phone_e164: phone,
        clerk_user_id: subject,
        // .test is a reserved top-level domain: these addresses can never receive mail.
        email: `${key}@demo.aora.test`,
        display_name: `Demo ${key}`,
        is_platform_operator: operator,
      },
    });
    return account.id;
  });
}

/** A session date at 09:00 UTC (12:00 in Nairobi), `days` from today. */
function daysFromNow(days: number): Date {
  const date = new Date();
  date.setUTCHours(9, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}
