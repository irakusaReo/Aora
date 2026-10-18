-- Phase 4, checkpoint 4C: layaway (ADRs 0017, 0018; journey K4). No credit is
-- extended. Expand-only: new tables, a new column with a default, wider checks.

-- ---------------------------------------------------------------------------
-- Plan terms are data (ADR 0018). Versioned, immutable; a change is a new
-- version. SANDBOX values below, visibly fake.
-- ---------------------------------------------------------------------------

create table kelo.plan_template (
  id uuid primary key default gen_random_uuid(),
  key text not null check (key ~ '^[a-z][a-z0-9_]{2,60}$'),
  version integer not null check (version > 0),
  name text not null,
  plan_type text not null check (plan_type in ('pay_in_n', 'monthly_financing', 'layaway', 'asset_financing')),
  instalment_count integer not null check (instalment_count between 1 and 60),
  interval_days integer not null check (interval_days between 1 and 62),
  -- What the merchant pays KELO on settlement, in basis points of the order value.
  merchant_fee_bps integer not null check (merchant_fee_bps between 0 and 10000),
  min_order_minor bigint not null check (min_order_minor > 0),
  max_order_minor bigint not null,
  currency text not null references ledger.asset (code),
  effective_from timestamptz not null,
  effective_to timestamptz,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  unique (key, version),
  check (max_order_minor >= min_order_minor),
  check (effective_to is null or effective_to > effective_from)
);

create trigger plan_template_immutable before update or delete on kelo.plan_template
  for each row execute function business.reject_change();

-- Which templates a category allows (ADR 0018 category_plan_rule).
create table kelo.category_plan_rule (
  id uuid primary key default gen_random_uuid(),
  category_slug text not null,
  template_key text not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  unique (category_slug, template_key, effective_from)
);

create trigger category_plan_rule_immutable before update or delete on kelo.category_plan_rule
  for each row execute function business.reject_change();

-- Cancellation refund rule per category (ADR 0018): a fee in basis points of
-- what was paid, capped; once a session has started, only a share is returned.
create table kelo.refund_rule (
  id uuid primary key default gen_random_uuid(),
  category_slug text not null,
  version integer not null check (version > 0),
  fee_bps integer not null check (fee_bps between 0 and 10000),
  fee_cap_minor bigint not null check (fee_cap_minor >= 0),
  after_start_returned_bps integer not null check (after_start_returned_bps between 0 and 10000),
  currency text not null references ledger.asset (code),
  effective_from timestamptz not null,
  effective_to timestamptz,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  unique (category_slug, version)
);

create trigger refund_rule_immutable before update or delete on kelo.refund_rule
  for each row execute function business.reject_change();

grant select on kelo.plan_template, kelo.category_plan_rule, kelo.refund_rule to aora_app, aora_platform;

insert into kelo.plan_template
  (key, version, name, plan_type, instalment_count, interval_days, merchant_fee_bps,
   min_order_minor, max_order_minor, currency, effective_from)
values
  ('sandbox_layaway_4x2w', 1, 'SANDBOX layaway: 4 payments, every 2 weeks', 'layaway', 4, 14, 300,
   100000, 50000000, 'KES', '2026-10-01'),
  ('sandbox_layaway_6x30d', 1, 'SANDBOX layaway: 6 payments, every 30 days', 'layaway', 6, 30, 300,
   600000, 100000000, 'KES', '2026-10-01');

insert into kelo.category_plan_rule (category_slug, template_key, effective_from)
select c.slug, t.key, '2026-10-01'
from (values ('electronics'), ('home-appliances'), ('furniture'), ('solar-home-systems'),
             ('motorbikes'), ('holidays'), ('courses-and-exams')) as c(slug)
cross join (values ('sandbox_layaway_4x2w'), ('sandbox_layaway_6x30d')) as t(key);

insert into kelo.refund_rule
  (category_slug, version, fee_bps, fee_cap_minor, after_start_returned_bps, currency, effective_from)
select slug, 1, 500, 100000, 0, 'KES', '2026-10-01'
from (values ('electronics'), ('home-appliances'), ('furniture'), ('solar-home-systems'),
             ('motorbikes'), ('holidays'), ('courses-and-exams')) as c(slug);

-- Layaway terms the buyer agrees to (versioned; consent names the version).
insert into consent.terms_document (key, version, language, title, body, body_sha256, effective_from)
select 'kelo_layaway_terms', '2026-10-18', 'en', 'KELO layaway terms (SANDBOX)', body,
       encode(sha256(convert_to(body, 'UTF8')), 'hex'), '2026-10-01'
from (values ('SANDBOX: these are test terms, not a real agreement. You pay for the item in the instalments shown, on the dates shown. You receive it after the last payment. KELO holds your payments and does not pass them to the merchant until the item is delivered. No credit is extended and no interest or fee is charged to you. If you cancel before delivery, you get back what you paid, less the cancellation fee shown before you agreed, which is capped.')) as t(body);

-- ---------------------------------------------------------------------------
-- A merchant's choice of plans per listing (unticked by default).
-- ---------------------------------------------------------------------------

create table kelo.listing_plan_offer (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  listing_id uuid not null,
  template_key text not null,
  created_by uuid not null references identity.user_account (id),
  withdrawn_at timestamptz,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  foreign key (listing_id, tenant_id) references kelo.listing (id, tenant_id)
);

create unique index listing_plan_offer_active on kelo.listing_plan_offer (listing_id, template_key)
  where withdrawn_at is null;

-- ---------------------------------------------------------------------------
-- A purchase (the order) and its layaway plan: separate state machines on
-- one row, linked to, never driven by, payments (ADR 0017).
-- ---------------------------------------------------------------------------

create table kelo.purchase (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  consumer_account_id uuid not null references identity.user_account (id),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request_hash text not null,
  listing_id uuid not null,
  variant_id uuid references kelo.listing_variant (id),
  session_id uuid references kelo.listing_session (id),
  plan_type text not null check (plan_type = 'layaway'),
  template_id uuid not null references kelo.plan_template (id),
  refund_rule_id uuid not null references kelo.refund_rule (id),
  consent_id uuid not null references consent.consent_record (id),
  total_minor bigint not null check (total_minor > 0),
  merchant_fee_minor bigint not null check (merchant_fee_minor >= 0),
  currency text not null references ledger.asset (code),
  status text not null default 'placed'
    check (status in ('placed', 'payment_ready', 'merchant_confirmed', 'fulfilled', 'completed', 'cancelled')),
  plan_status text not null default 'active'
    check (plan_status in ('active', 'paid_in_full', 'settled', 'cancelled', 'refunded')),
  paid_minor bigint not null default 0,
  fulfilment_evidence text,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (listing_id, tenant_id) references kelo.listing (id, tenant_id),
  unique (consumer_account_id, idempotency_key),
  unique (id, tenant_id),
  check ((variant_id is null) <> (session_id is null)),
  check (merchant_fee_minor <= total_minor),
  check (paid_minor between 0 and total_minor),
  -- Fulfilment waits for the last payment.
  check (status not in ('fulfilled', 'completed') or paid_minor = total_minor)
);

create index purchase_tenant on kelo.purchase (tenant_id, created_at desc);
create index purchase_consumer on kelo.purchase (consumer_account_id, created_at desc);

create function kelo.protect_purchase() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or old.status in ('completed', 'cancelled') and old.plan_status in ('settled', 'refunded')
     or (to_jsonb(new) - array['status', 'plan_status', 'paid_minor', 'fulfilment_evidence', 'updated_at'])
        <> (to_jsonb(old) - array['status', 'plan_status', 'paid_minor', 'fulfilment_evidence', 'updated_at'])
     or new.paid_minor < old.paid_minor and new.plan_status <> 'refunded' then
    raise exception 'a purchase''s terms never change, and a closed purchase stays closed'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger purchase_protect before update or delete on kelo.purchase
  for each row execute function kelo.protect_purchase();

create table kelo.purchase_event (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  purchase_id uuid not null,
  field text not null check (field in ('status', 'plan_status')),
  from_value text,
  to_value text not null,
  actor_kind text not null check (actor_kind in ('user', 'system', 'provider')),
  actor_account_id uuid references identity.user_account (id),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  foreign key (purchase_id, tenant_id) references kelo.purchase (id, tenant_id)
);

create trigger purchase_event_immutable before update or delete on kelo.purchase_event
  for each row execute function business.reject_change();

create table kelo.layaway_instalment (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  consumer_account_id uuid not null references identity.user_account (id),
  purchase_id uuid not null,
  seq integer not null check (seq > 0),
  due_on date not null,
  amount_minor bigint not null check (amount_minor > 0),
  status text not null default 'due'
    check (status in ('due', 'submitting', 'pending', 'paid', 'cancelled')),
  -- `submitting` claims the instalment for one request (its Idempotency-Key, hashed)
  -- before the payment exists, so two requests can never both push a payment.
  claim_key text check (claim_key ~ '^[0-9a-f]{64}$'),
  claimed_at timestamptz,
  -- The payment in flight or that paid it; a declined one is replaced by a new one.
  payment_intent_id uuid unique references payments.payment_intent (id),
  paid_at timestamptz,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (purchase_id, tenant_id) references kelo.purchase (id, tenant_id),
  unique (purchase_id, seq),
  check ((status = 'paid') = (paid_at is not null)),
  check (status not in ('pending', 'paid') or payment_intent_id is not null),
  check (status <> 'submitting' or (claim_key is not null and claimed_at is not null))
);

create function kelo.protect_instalment() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or old.status in ('paid', 'cancelled')
     or (to_jsonb(new) - array['status', 'payment_intent_id', 'paid_at', 'claim_key', 'claimed_at', 'updated_at'])
        <> (to_jsonb(old) - array['status', 'payment_intent_id', 'paid_at', 'claim_key', 'claimed_at', 'updated_at']) then
    raise exception 'an instalment''s amount and date never change, and a paid one stays paid'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger layaway_instalment_protect before update or delete on kelo.layaway_instalment
  for each row execute function kelo.protect_instalment();

-- A schedule always sums exactly to the purchase total (ADR 0018).
create function kelo.check_schedule() returns trigger
  language plpgsql
  as $$
declare
  scheduled bigint;
  expected bigint;
begin
  select coalesce(sum(amount_minor), 0) into scheduled
    from kelo.layaway_instalment where purchase_id = new.purchase_id;
  select total_minor into expected from kelo.purchase where id = new.purchase_id;
  if scheduled <> expected then
    raise exception 'instalments of purchase % sum to %, not %', new.purchase_id, scheduled, expected
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

create constraint trigger layaway_schedule_sums after insert on kelo.layaway_instalment
  deferrable initially deferred for each row execute function kelo.check_schedule();

-- A cancellation refund to the buyer: its own state machine.
create table kelo.layaway_refund (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  consumer_account_id uuid not null references identity.user_account (id),
  purchase_id uuid not null,
  paid_minor bigint not null check (paid_minor >= 0),
  fee_minor bigint not null check (fee_minor >= 0),
  refund_minor bigint not null check (refund_minor >= 0),
  currency text not null references ledger.asset (code),
  status text not null default 'requested'
    check (status in ('requested', 'pending_provider', 'succeeded', 'failed', 'status_unknown',
                      'reconciliation_required')),
  provider text not null default 'sandbox_sim',
  provider_reference text,
  inquiries integer not null default 0,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (purchase_id, tenant_id) references kelo.purchase (id, tenant_id),
  -- One refund per purchase.
  unique (purchase_id, tenant_id),
  check (fee_minor + refund_minor = paid_minor)
);

create function kelo.protect_refund() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or old.status in ('succeeded', 'failed')
     or (to_jsonb(new) - array['status', 'provider_reference', 'inquiries', 'updated_at'])
        <> (to_jsonb(old) - array['status', 'provider_reference', 'inquiries', 'updated_at']) then
    raise exception 'a refund''s amounts never change, and a final refund stays final'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger layaway_refund_protect before update or delete on kelo.layaway_refund
  for each row execute function kelo.protect_refund();

do $$
declare
  t text;
begin
  foreach t in array array['purchase', 'layaway_instalment', 'layaway_refund'] loop
    execute format('alter table kelo.%I enable row level security', t);
    execute format('alter table kelo.%I force row level security', t);
    execute format('create policy tenant_isolation on kelo.%I for select to aora_app
                      using (tenant_id = tenancy.current_tenant_id())', t);
    execute format('create policy consumer_isolation on kelo.%I for select to aora_app
                      using (consumer_account_id = identity.current_account_id())', t);
    execute format('create policy platform_access on kelo.%I to aora_platform
                      using (true) with check (true)', t);
    execute format('grant select on kelo.%I to aora_app', t);
    execute format('grant select, insert on kelo.%I to aora_platform', t);
  end loop;
  foreach t in array array['listing_plan_offer', 'purchase_event'] loop
    execute format('alter table kelo.%I enable row level security', t);
    execute format('alter table kelo.%I force row level security', t);
    execute format('create policy tenant_isolation on kelo.%I for select to aora_app
                      using (tenant_id = tenancy.current_tenant_id())', t);
    execute format('create policy platform_access on kelo.%I to aora_platform
                      using (true) with check (true)', t);
    execute format('grant select on kelo.%I to aora_app', t);
    execute format('grant select, insert on kelo.%I to aora_platform', t);
  end loop;
end
$$;

grant update (withdrawn_at) on kelo.listing_plan_offer to aora_platform;
grant update (status, plan_status, paid_minor, fulfilment_evidence) on kelo.purchase to aora_platform;
grant update (status, payment_intent_id, paid_at, claim_key, claimed_at) on kelo.layaway_instalment
  to aora_platform;
grant update (status, provider_reference, inquiries) on kelo.layaway_refund to aora_platform;

-- ---------------------------------------------------------------------------
-- Payments: what a collection is for. A layaway instalment is routed and
-- limited as the merchant's, but its money is held for the buyer (P4-9).
-- ---------------------------------------------------------------------------

alter table payments.payment_intent
  add column purpose text not null default 'collection' check (purpose in ('collection', 'kelo_layaway'));

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
     or new.purpose <> old.purpose
     -- Settled once, never moved to another batch or unsettled.
     or (old.settlement_batch_id is not null
         and new.settlement_batch_id is distinct from old.settlement_batch_id) then
    raise exception 'payment intent amount, fee, asset, tenant, identity, purpose and settlement are immutable'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

-- A layaway instalment carries no collection fee: KELO charges the merchant on settlement.
alter table payments.payment_intent
  add constraint payment_intent_layaway_no_fee check (purpose = 'collection' or fee_amount = 0);

-- ---------------------------------------------------------------------------
-- Ledger: KELO's platform accounts (ADR 0017), per asset.
-- ---------------------------------------------------------------------------

alter table ledger.account drop constraint account_type_check;
alter table ledger.account add constraint account_type_check check (type in (
  'provider_clearing', 'merchant_collections_pending', 'fee_revenue',
  'merchant_available', 'merchant_payouts_in_flight', 'provider_payout_float',
  'kelo_layaway_funds_held', 'kelo_fee_revenue', 'kelo_refunds_payable'));

insert into ledger.account (tenant_id, asset_code, type, qualifier, normal_side, allow_negative)
values (null, 'KES', 'kelo_layaway_funds_held', '', 'credit', false),
       (null, 'KES', 'kelo_fee_revenue', '', 'credit', false),
       (null, 'KES', 'kelo_refunds_payable', '', 'credit', false);
