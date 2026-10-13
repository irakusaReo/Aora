-- Phase 3, checkpoint 3A-1: versioned tariffs, tier limits, branches, and the
-- fee, net and attribution fields of a collection (ADR 0021).
--
-- Expand-only: new schema, new tables, new nullable or defaulted columns, and
-- wider check constraints. Code from before this migration keeps working.

create schema pricing;
grant usage on schema pricing to aora_app, aora_platform;

-- ---------------------------------------------------------------------------
-- Tariffs. A version applies to one operation on one rail, in one country and
-- asset, from effective_from until effective_to. Fee values are data: nothing
-- about a price lives in code.
-- ---------------------------------------------------------------------------

create table pricing.tariff_version (
  id uuid primary key default gen_random_uuid(),
  operation text not null check (operation in ('collection', 'payout', 'refund')),
  rail text not null check (rail ~ '^[a-z][a-z0-9_]{1,30}$'),
  country text not null check (country ~ '^[A-Z]{2}$'),
  asset_code text not null references ledger.asset (code),
  version integer not null check (version > 0),
  name text not null check (length(btrim(name)) > 0),
  rounding text not null default 'half_up' check (rounding in ('half_up', 'down')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  -- The transaction that created the version; its bands must come from the same one.
  created_txid bigint not null default txid_current(),
  unique (operation, rail, country, asset_code, version),
  check (effective_to is null or effective_to > effective_from)
);

create index tariff_version_lookup
  on pricing.tariff_version (operation, rail, country, asset_code, effective_from);

-- A band starts at min_amount and runs to the next band's min_amount, so bands
-- of one version can neither overlap nor leave a gap above the lowest one.
--   fee = clamp(flat_amount + amount * bps / 10000, min_fee, max_fee)
create table pricing.tariff_band (
  id uuid primary key default gen_random_uuid(),
  tariff_version_id uuid not null references pricing.tariff_version (id),
  min_amount bigint not null check (min_amount >= 0),
  bps integer not null default 0 check (bps between 0 and 10000),
  flat_amount bigint not null default 0 check (flat_amount >= 0),
  min_fee bigint not null default 0 check (min_fee >= 0),
  max_fee bigint check (max_fee is null or max_fee >= min_fee),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  unique (tariff_version_id, min_amount)
);

create function pricing.reject_change() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'published tariffs are immutable (%.%)', tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end
$$;

-- No two versions of the same tariff may be in effect at the same instant.
-- The advisory lock makes two concurrent publications queue instead of both passing.
create function pricing.assert_no_overlap() returns trigger
  language plpgsql
  as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('pricing.tariff:' || new.operation || ':' || new.rail || ':'
      || new.country || ':' || new.asset_code, 0));
  if exists (
    select from pricing.tariff_version v
    where v.id <> new.id
      and v.operation = new.operation and v.rail = new.rail
      and v.country = new.country and v.asset_code = new.asset_code
      and tstzrange(v.effective_from, v.effective_to) && tstzrange(new.effective_from, new.effective_to)
  ) then
    raise exception 'tariff versions for % on % overlap in time', new.operation, new.rail
      using errcode = 'exclusion_violation';
  end if;
  return new;
end
$$;

-- A published version never changes, except that an open-ended one may be closed once.
create function pricing.protect_version() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or old.effective_to is not null
     or (to_jsonb(new) - 'effective_to') <> (to_jsonb(old) - 'effective_to') then
    raise exception 'published tariffs are immutable (%.%)', tg_table_schema, tg_table_name
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

create function pricing.protect_band() returns trigger
  language plpgsql
  as $$
declare
  version_txid bigint;
begin
  select created_txid into version_txid from pricing.tariff_version where id = new.tariff_version_id;
  if version_txid is distinct from txid_current() then
    raise exception 'bands cannot be added to a published tariff version'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

create trigger tariff_version_protect before update or delete on pricing.tariff_version
  for each row execute function pricing.protect_version();
create trigger tariff_version_no_overlap after insert or update on pricing.tariff_version
  for each row execute function pricing.assert_no_overlap();
create trigger tariff_version_no_truncate before truncate on pricing.tariff_version
  for each statement execute function pricing.reject_change();
create trigger tariff_band_protect before insert on pricing.tariff_band
  for each row execute function pricing.protect_band();
create trigger tariff_band_immutable before update or delete on pricing.tariff_band
  for each row execute function pricing.reject_change();
create trigger tariff_band_no_truncate before truncate on pricing.tariff_band
  for each statement execute function pricing.reject_change();

grant select on pricing.tariff_version, pricing.tariff_band to aora_app, aora_platform;
grant insert on pricing.tariff_version, pricing.tariff_band to aora_platform;
grant update (effective_to) on pricing.tariff_version to aora_platform;

-- SANDBOX reference tariffs. The values are deliberately fake (real tariffs are
-- unverified, open question X-4) and are replaced by publishing a new version.
with collection as (
  insert into pricing.tariff_version (operation, rail, country, asset_code, version, name, effective_from)
  values ('collection', 'mpesa', 'KE', 'KES', 1, 'SANDBOX collection fee (not a real tariff)',
          '2026-01-01T00:00:00Z')
  returning id
)
insert into pricing.tariff_band (tariff_version_id, min_amount, bps, max_fee)
select id, 0, 0, 0 from collection          -- free below KES 100.00
union all
select id, 10000, 100, 20000 from collection; -- 1.00 %, capped at KES 200.00

-- ---------------------------------------------------------------------------
-- Tiers. What a workspace may do grows with verification (lessons §7). The
-- limits are data, versioned like tariffs.
-- ---------------------------------------------------------------------------

alter table tenancy.workspace
  add column tier text not null default 'tier_0' check (tier ~ '^tier_[0-9]$');

create table tenancy.tier_limit (
  id uuid primary key default gen_random_uuid(),
  tier text not null check (tier ~ '^tier_[0-9]$'),
  asset_code text not null references ledger.asset (code),
  version integer not null check (version > 0),
  effective_from timestamptz not null,
  per_transaction_max bigint not null check (per_transaction_max > 0),
  -- Over any rolling 24 hours, so that no time zone has to be assumed.
  daily_collection_max bigint not null check (daily_collection_max > 0),
  daily_payout_max bigint not null check (daily_payout_max >= 0),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  unique (tier, asset_code, version)
);

create function tenancy.reject_change() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'record is append-only (%.%)', tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end
$$;

-- A limit is changed by adding a version; the newest one in effect applies.
create trigger tier_limit_immutable before update or delete on tenancy.tier_limit
  for each row execute function tenancy.reject_change();

grant select on tenancy.tier_limit to aora_app, aora_platform;
grant insert on tenancy.tier_limit to aora_platform;

-- SANDBOX values, not derived from any regulation or provider (open question D-8).
insert into tenancy.tier_limit
  (tier, asset_code, version, effective_from, per_transaction_max, daily_collection_max, daily_payout_max)
values
  ('tier_0', 'KES', 1, '2026-01-01T00:00:00Z', 5000000, 20000000, 5000000),
  ('tier_1', 'KES', 1, '2026-01-01T00:00:00Z', 25000000, 100000000, 50000000);

-- ---------------------------------------------------------------------------
-- Branches. A cashier belongs to one branch and sees only its collections.
-- ---------------------------------------------------------------------------

create table tenancy.branch (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenancy.workspace (id),
  name text not null check (length(btrim(name)) between 1 and 80),
  status text not null default 'active' check (status in ('active', 'closed')),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  -- Lets other tables prove that a branch belongs to the same workspace.
  unique (id, tenant_id)
);

create unique index branch_name_unique on tenancy.branch (tenant_id, lower(btrim(name)));

alter table tenancy.branch enable row level security;
alter table tenancy.branch force row level security;

create policy tenant_isolation on tenancy.branch for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy platform_access on tenancy.branch to aora_platform
  using (true) with check (true);

grant select on tenancy.branch to aora_app;
grant select, insert on tenancy.branch to aora_platform;
grant update (name, status) on tenancy.branch to aora_platform;

alter table tenancy.membership
  add column branch_id uuid,
  add constraint membership_branch_same_workspace
    foreign key (branch_id, tenant_id) references tenancy.branch (id, tenant_id);
grant update (branch_id) on tenancy.membership to aora_platform;

-- ---------------------------------------------------------------------------
-- Collections: fee, net, the tariff version applied, and attribution.
-- ---------------------------------------------------------------------------

alter table payments.payment_intent
  add column rail text not null default 'simulator' check (rail ~ '^[a-z][a-z0-9_]{1,30}$'),
  add column fee_amount bigint not null default 0 check (fee_amount >= 0),
  add column tariff_version_id uuid references pricing.tariff_version (id),
  add column branch_id uuid,
  add column reference text check (reference is null or length(reference) between 1 and 64),
  add constraint payment_intent_fee_within_amount check (fee_amount <= amount),
  add constraint payment_intent_branch_same_workspace
    foreign key (branch_id, tenant_id) references tenancy.branch (id, tenant_id);

-- Net is derived, so gross − fee = net can never be violated.
alter table payments.payment_intent
  add column net_amount bigint generated always as (amount - fee_amount) stored;

create index payment_intent_tenant_created on payments.payment_intent (tenant_id, created_at desc, id);

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
     or new.reference is distinct from old.reference then
    raise exception 'payment intent amount, fee, asset, tenant and identity are immutable'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Ledger: fee revenue, and the two merchant balances that settlement and
-- payouts use from checkpoint 3C. Each stays a distinct balance type.
-- ---------------------------------------------------------------------------

alter table ledger.account drop constraint account_type_check;
alter table ledger.account add constraint account_type_check check (type in (
  'provider_clearing', 'merchant_collections_pending', 'fee_revenue',
  'merchant_available', 'merchant_payouts_in_flight'));

-- Platform account for AORA's fees in KES. Created once, here, like the asset itself.
insert into ledger.account (tenant_id, asset_code, type, qualifier, normal_side, allow_negative)
values (null, 'KES', 'fee_revenue', '', 'credit', false);
