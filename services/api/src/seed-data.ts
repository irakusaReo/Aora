import { AuditService } from './modules/audit/audit.service.js';
import { BusinessService } from './modules/business/business.service.js';
import { LedgerService } from './modules/ledger/ledger.service.js';
import { TenancyService } from './modules/tenancy/tenancy.service.js';
import type { Database, Tx } from './platform/database.js';

/**
 * SANDBOX seed data. Phone numbers use the unassigned +999 country code so
 * they can never belong to a real person.
 */
/** Name of the AORA simulator provider; also the qualifier of its clearing account. */
export const SANDBOX_PROVIDER = 'sandbox_sim';

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
  readonly clerkIds: Record<keyof typeof SEED_PHONES, string>;
  /** Platform ledger account for money held by the sandbox simulator provider. */
  readonly providerClearingAccount: string;
}

/** The identity-provider id each seeded account is linked to (sandbox authenticator only). */
export function seedSubject(who: keyof typeof SEED_PHONES): string {
  return `user_sandbox_${who}`;
}

async function createAccount(
  tx: Tx,
  who: keyof typeof SEED_PHONES,
  operator = false,
): Promise<{ id: string; personId: string }> {
  const person = await tx.person.create({ data: {} });
  const account = await tx.user_account.create({
    data: {
      person_id: person.id,
      phone_e164: SEED_PHONES[who],
      clerk_user_id: seedSubject(who),
      // .test is a reserved top-level domain: these addresses can never receive mail.
      email: `${who}@sandbox.aora.test`,
      display_name: `Sandbox ${who}`,
      is_platform_operator: operator,
    },
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
  const tenancy = new TenancyService(db, new AuditService());
  return db.asPlatform(
    async (tx) => {
      const adminA = await createAccount(tx, 'adminA');
      const financeA = await createAccount(tx, 'financeA');
      const cashierA = await createAccount(tx, 'cashierA');
      const adminB = await createAccount(tx, 'adminB');
      const operator = await createAccount(tx, 'operator', true);

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

      const providerClearingAccount = await new LedgerService().openAccount(tx, {
        tenantId: null,
        type: 'provider_clearing',
        assetCode: 'KES',
        qualifier: SANDBOX_PROVIDER,
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
        providerClearingAccount,
        clerkIds: {
          adminA: seedSubject('adminA'),
          financeA: seedSubject('financeA'),
          cashierA: seedSubject('cashierA'),
          adminB: seedSubject('adminB'),
          operator: seedSubject('operator'),
        },
        accounts: {
          adminA: adminA.id,
          financeA: financeA.id,
          cashierA: cashierA.id,
          adminB: adminB.id,
          operator: operator.id,
        },
      };
    },
    { timeoutMs: 120_000 },
  );
}
