import { BusinessService } from './modules/business/business.service.js';
import { TenancyService } from './modules/tenancy/tenancy.service.js';
import type { Database, Tx } from './platform/database.js';

/**
 * SANDBOX seed data. Phone numbers use the unassigned +999 country code so
 * they can never belong to a real person.
 */
export const SEED_PHONES = {
  adminA: '+99900000001',
  financeA: '+99900000002',
  cashierA: '+99900000003',
  adminB: '+99900000004',
  operator: '+99900000009',
} as const;

export interface SeedResult {
  readonly tenantA: string;
  readonly tenantB: string;
  readonly accounts: Record<keyof typeof SEED_PHONES, string>;
}

async function createAccount(
  tx: Tx,
  phone: string,
  operator = false,
): Promise<{ id: string; personId: string }> {
  const person = await tx.person.create({ data: {} });
  const account = await tx.user_account.create({
    data: { person_id: person.id, phone_e164: phone, is_platform_operator: operator },
  });
  return { id: account.id, personId: person.id };
}

export type WorkspaceHook = (tx: Tx, tenantId: string) => Promise<void>;

/** Creates two unrelated merchants, their staff, and one platform operator. */
export async function seedSandbox(
  db: Database,
  onWorkspace: WorkspaceHook = () => Promise.resolve(),
): Promise<SeedResult> {
  const businesses = new BusinessService();
  const tenancy = new TenancyService();
  return db.asPlatform(async (tx) => {
    const adminA = await createAccount(tx, SEED_PHONES.adminA);
    const financeA = await createAccount(tx, SEED_PHONES.financeA);
    const cashierA = await createAccount(tx, SEED_PHONES.cashierA);
    const adminB = await createAccount(tx, SEED_PHONES.adminB);
    const operator = await createAccount(tx, SEED_PHONES.operator, true);

    const businessA = await businesses.createRegistered(tx, {
      name: 'Sandbox Hardware Ltd',
      country: 'KE',
      registrationType: 'sandbox_registration_number',
      registrationValue: 'SANDBOX-0001',
    });
    const businessB = await businesses.createUnregistered(tx, {
      name: 'Sandbox Vegetable Stall',
      ownerPersonId: adminB.personId,
      location: {
        country: 'KE',
        area: 'Sandbox County',
        locality: 'Sandbox Town',
        place: 'Stall 1',
      },
    });

    const tenantA = await tenancy.createWorkspace(tx, businessA);
    const tenantB = await tenancy.createWorkspace(tx, businessB);
    await onWorkspace(tx, tenantA);
    await onWorkspace(tx, tenantB);

    await tenancy.addMember(tx, tenantA, adminA.id, 'admin');
    await tenancy.addMember(tx, tenantA, financeA.id, 'finance');
    await tenancy.addMember(tx, tenantA, cashierA.id, 'cashier');
    await tenancy.addMember(tx, tenantB, adminB.id, 'admin');

    return {
      tenantA,
      tenantB,
      accounts: {
        adminA: adminA.id,
        financeA: financeA.id,
        cashierA: cashierA.id,
        adminB: adminB.id,
        operator: operator.id,
      },
    };
  });
}
