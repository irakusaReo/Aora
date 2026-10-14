-- Phase 3, checkpoint 3C: settlement, payout recipients, payouts and refunds
-- (ADR 0021; ADR 0022 for Daraja B2C). Expand-only.

-- ---------------------------------------------------------------------------
-- Ledger: a per-provider payout float. In the sandbox the provider's
-- disbursement account is funded outside the ledger (assumption M-4); its
-- balance going below zero records float used, not an overdraft.
-- ---------------------------------------------------------------------------

alter table ledger.account drop constraint account_type_check;
alter table ledger.account add constraint account_type_check check (type in (
  'provider_clearing', 'merchant_collections_pending', 'fee_revenue',
  'merchant_available', 'merchant_payouts_in_flight', 'provider_payout_float'));

insert into ledger.account (tenant_id, asset_code, type, qualifier, normal_side, allow_negative)
values (null, 'KES', 'provider_payout_float', 'sandbox_sim', 'debit', true),
       (null, 'KES', 'provider_payout_float', 'daraja', 'debit', true);

-- Every existing workspace gets the two balances settlement and payouts use.
insert into ledger.account (tenant_id, asset_code, type, qualifier, normal_side, allow_negative)
select w.id, 'KES', t.type, '', 'credit', false
from tenancy.workspace w
cross join (values ('merchant_available'), ('merchant_payouts_in_flight')) as t(type)
on conflict do nothing;

-- SANDBOX tariffs, deliberately fake (X-4): a flat KES 15.00 per payout; refunds free.
with payout as (
  insert into pricing.tariff_version (operation, rail, country, asset_code, version, name, effective_from)
  values ('payout', 'mpesa', 'KE', 'KES', 1, 'SANDBOX payout fee (not a real tariff)', '2026-01-01T00:00:00Z')
  returning id
), refund as (
  insert into pricing.tariff_version (operation, rail, country, asset_code, version, name, effective_from)
  values ('refund', 'mpesa', 'KE', 'KES', 1, 'SANDBOX refund fee (not a real tariff)', '2026-01-01T00:00:00Z')
  returning id
)
insert into pricing.tariff_band (tariff_version_id, min_amount, flat_amount)
select id, 0, 1500 from payout
union all
select id, 0, 0 from refund;

-- ---------------------------------------------------------------------------
-- Simulator: which kind of operation a simulated transaction is.
-- ---------------------------------------------------------------------------

alter table sim.sim_transaction
  add column kind text not null default 'collection' check (kind in ('collection', 'payout', 'refund'));

-- ---------------------------------------------------------------------------
-- Settlement batches: collections moved from "pending" to "available".
-- ---------------------------------------------------------------------------

create table payments.settlement_batch (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenancy.workspace (id),
  asset_code text not null references ledger.asset (code),
  gross_amount bigint not null check (gross_amount > 0),
  fee_amount bigint not null check (fee_amount >= 0),
  net_amount bigint not null check (net_amount >= 0 and net_amount = gross_amount - fee_amount),
  intent_count integer not null check (intent_count > 0),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now()
);

create trigger settlement_batch_immutable before update or delete on payments.settlement_batch
  for each row execute function payments.reject_change();

alter table payments.settlement_batch enable row level security;
alter table payments.settlement_batch force row level security;
create policy tenant_read on payments.settlement_batch for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy platform_access on payments.settlement_batch to aora_platform using (true) with check (true);
grant select on payments.settlement_batch to aora_app;
grant select, insert on payments.settlement_batch to aora_platform;

alter table payments.payment_intent add column settlement_batch_id uuid references payments.settlement_batch (id);
grant update (settlement_batch_id) on payments.payment_intent to aora_platform;

create or replace function payments.protect_intent() returns trigger
  language plpgsql
  as $$
begin
  if new.tenant_id <> old.tenant_id or new.amount <> old.amount
     or new.asset_code <> old.asset_code or new.idempotency_key <> old.idempotency_key
     or new.request_hash <> old.request_hash or new.created_by <> old.created_by
     or new.provider <> old.provider
     or new.fee_amount <> old.fee_amount or new.rail <> old.rail
     or new.tariff_version_id is distinct from old.tariff_version_id
     or new.branch_id is distinct from old.branch_id
     or new.reference is distinct from old.reference
     -- Settled once, never moved to another batch or unsettled.
     or (old.settlement_batch_id is not null
         and new.settlement_batch_id is distinct from old.settlement_batch_id) then
    raise exception 'payment intent amount, fee, asset, tenant, identity and settlement are immutable'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Payout policy: the first payout to a newly confirmed recipient waits out a
-- cooling-off period and is capped (owner decision on O-11). Versioned data.
-- ---------------------------------------------------------------------------

create table payments.payout_policy (
  id uuid primary key default gen_random_uuid(),
  asset_code text not null references ledger.asset (code),
  version integer not null check (version > 0),
  effective_from timestamptz not null,
  cooling_off_seconds integer not null check (cooling_off_seconds >= 0),
  first_payout_cap bigint not null check (first_payout_cap > 0),
  min_amount bigint not null check (min_amount > 0),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  unique (asset_code, version)
);

create trigger payout_policy_immutable before update or delete on payments.payout_policy
  for each row execute function payments.reject_change();
grant select on payments.payout_policy to aora_app, aora_platform;
grant insert on payments.payout_policy to aora_platform;

-- SANDBOX defaults: 10 minutes, KES 1,000.00 for the first payout, KES 10.00 minimum
-- (Daraja's B2C page gives KES 10 as its minimum; kept here as data).
insert into payments.payout_policy (asset_code, version, effective_from, cooling_off_seconds, first_payout_cap, min_amount)
values ('KES', 1, '2026-01-01T00:00:00Z', 600, 100000, 1000);

-- ---------------------------------------------------------------------------
-- Payout recipients. Confirming one proves the user's intent (the number was
-- typed twice, with a PIN), not that they own the number (O-11).
-- ---------------------------------------------------------------------------

create table payments.payout_recipient (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenancy.workspace (id),
  rail text not null check (rail ~ '^[a-z][a-z0-9_]{1,30}$'),
  label text not null check (length(btrim(label)) between 1 and 60),
  msisdn text not null check (msisdn ~ '^[1-9][0-9]{7,14}$'),
  status text not null default 'unconfirmed' check (status in ('unconfirmed', 'confirmed', 'disabled')),
  created_by uuid not null references identity.user_account (id),
  confirmed_by uuid references identity.user_account (id),
  confirmed_at timestamptz,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  unique (tenant_id, rail, msisdn),
  check ((status = 'confirmed') = (confirmed_at is not null and confirmed_by is not null) or status = 'disabled')
);

alter table payments.payout_recipient enable row level security;
alter table payments.payout_recipient force row level security;
-- Platform only: the number is personal data; the API returns it masked.
create policy platform_access on payments.payout_recipient to aora_platform using (true) with check (true);
grant select, insert on payments.payout_recipient to aora_platform;
grant update (status, confirmed_by, confirmed_at) on payments.payout_recipient to aora_platform;

-- ---------------------------------------------------------------------------
-- Payouts and refunds. Status changes only through the application's
-- transition tables; every change is recorded.
-- ---------------------------------------------------------------------------

create table payments.payout (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenancy.workspace (id),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request_hash text not null,
  recipient_id uuid not null references payments.payout_recipient (id),
  amount bigint not null check (amount > 0),
  fee_amount bigint not null check (fee_amount >= 0),
  tariff_version_id uuid not null references pricing.tariff_version (id),
  asset_code text not null references ledger.asset (code),
  provider text not null,
  status text not null default 'created' check (status in (
    'created', 'submitting', 'pending_provider', 'succeeded', 'failed',
    'status_unknown', 'reconciliation_required')),
  failure_code text,
  provider_reference text,
  receipt text,
  status_inquiries integer not null default 0 check (status_inquiries >= 0),
  sandbox_scenario text,
  created_by uuid not null references identity.user_account (id),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create table payments.refund (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenancy.workspace (id),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request_hash text not null,
  intent_id uuid not null references payments.payment_intent (id),
  amount bigint not null check (amount > 0),
  asset_code text not null references ledger.asset (code),
  provider text not null,
  status text not null default 'created' check (status in (
    'created', 'submitting', 'pending_provider', 'succeeded', 'failed',
    'status_unknown', 'reconciliation_required')),
  failure_code text,
  provider_reference text,
  status_inquiries integer not null default 0 check (status_inquiries >= 0),
  sandbox_scenario text,
  created_by uuid not null references identity.user_account (id),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create index payout_tenant_created on payments.payout (tenant_id, created_at desc);
create index refund_intent on payments.refund (intent_id);

create table payments.operation_transition (
  id uuid primary key default gen_random_uuid(),
  operation_type text not null check (operation_type in ('payout', 'refund')),
  operation_id uuid not null,
  tenant_id uuid not null references tenancy.workspace (id),
  from_status text,
  to_status text not null,
  source text not null check (source in ('api', 'adapter', 'webhook', 'inquiry')),
  reason text,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now()
);
create index operation_transition_operation on payments.operation_transition (operation_id, created_at);
create trigger operation_transition_immutable before update or delete on payments.operation_transition
  for each row execute function payments.reject_change();

-- Financial facts of a payout or refund never change after creation.
create function payments.protect_operation() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or new.tenant_id <> old.tenant_id or new.amount <> old.amount
     or new.asset_code <> old.asset_code or new.idempotency_key <> old.idempotency_key
     or new.request_hash <> old.request_hash or new.created_by <> old.created_by
     or new.provider <> old.provider
     or (to_jsonb(new) ? 'fee_amount' and to_jsonb(new) -> 'fee_amount' <> to_jsonb(old) -> 'fee_amount')
     or (to_jsonb(new) ? 'recipient_id' and to_jsonb(new) -> 'recipient_id' <> to_jsonb(old) -> 'recipient_id')
     or (to_jsonb(new) ? 'intent_id' and to_jsonb(new) -> 'intent_id' <> to_jsonb(old) -> 'intent_id') then
    raise exception 'amount, fee, asset, tenant and identity of a payout or refund are immutable'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger payout_protect before update or delete on payments.payout
  for each row execute function payments.protect_operation();
create trigger refund_protect before update or delete on payments.refund
  for each row execute function payments.protect_operation();

-- A collection can never be refunded beyond its amount: counted over every
-- refund that has not failed, with the collection locked so concurrent
-- requests take turns.
create function payments.assert_refund_within_collection() returns trigger
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  collected bigint;
  refunded bigint;
begin
  select amount into collected from payments.payment_intent where id = new.intent_id for update;
  if collected is null then
    raise exception 'refund refers to a collection that cannot be checked'
      using errcode = 'check_violation';
  end if;
  select coalesce(sum(amount), 0) into refunded from payments.refund
    where intent_id = new.intent_id and status <> 'failed' and id <> new.id;
  if refunded + new.amount > collected then
    raise exception 'refunds would exceed the collection'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger refund_within_collection before insert on payments.refund
  for each row execute function payments.assert_refund_within_collection();

-- The cap trigger runs as the owner and locks the collection (FOR UPDATE), which
-- row-level security checks against update policies as well as select policies.
create policy trigger_access on payments.payment_intent for select to aora_owner using (true);
create policy trigger_lock on payments.payment_intent for update to aora_owner using (true);
create policy trigger_access on payments.refund for select to aora_owner using (true);

alter table payments.payout enable row level security;
alter table payments.payout force row level security;
alter table payments.refund enable row level security;
alter table payments.refund force row level security;
alter table payments.operation_transition enable row level security;
alter table payments.operation_transition force row level security;

create policy tenant_read on payments.payout for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy tenant_read on payments.refund for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy tenant_read on payments.operation_transition for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy platform_access on payments.payout to aora_platform using (true) with check (true);
create policy platform_access on payments.refund to aora_platform using (true) with check (true);
create policy platform_access on payments.operation_transition to aora_platform using (true) with check (true);

grant select on payments.payout, payments.refund, payments.operation_transition to aora_app;
grant select, insert on payments.payout, payments.refund, payments.operation_transition to aora_platform;
grant update (status, failure_code, provider_reference, receipt, status_inquiries)
  on payments.payout to aora_platform;
grant update (status, failure_code, provider_reference, status_inquiries)
  on payments.refund to aora_platform;

-- Daraja's adapter record now also covers payouts.
alter table payments.provider_operation drop constraint provider_operation_operation_type_check;
alter table payments.provider_operation add constraint provider_operation_operation_type_check
  check (operation_type in ('payment_intent', 'payout'));
