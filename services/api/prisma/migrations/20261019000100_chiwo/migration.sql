-- Phase 7, checkpoint 7A: CHIWO consumer sign-up and paying a KONY merchant
-- (phase-7 plan P7-1 to P7-7). Expand-only: a new schema, new tables, one new
-- column with a default, one terms document.

create schema chiwo;
grant usage on schema chiwo to aora_app, aora_platform;

-- ---------------------------------------------------------------------------
-- The personal context (P7-1): one CHIWO consumer per user account.
-- ---------------------------------------------------------------------------

create table chiwo.consumer (
  account_id uuid primary key references identity.user_account (id),
  consent_id uuid not null references consent.consent_record (id),
  status text not null default 'active' check (status in ('active', 'closed')),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Merchant pay codes (P7-3). Readable by the platform role for lookups only.
-- ---------------------------------------------------------------------------

create table tenancy.pay_code (
  code text primary key check (code ~ '^[2-9A-HJ-NP-Z]{8}$'),
  tenant_id uuid not null references tenancy.workspace (id),
  branch_id uuid,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_by uuid not null references identity.user_account (id),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  foreign key (branch_id, tenant_id) references tenancy.branch (id, tenant_id)
);

create index pay_code_tenant on tenancy.pay_code (tenant_id, created_at);

alter table tenancy.pay_code enable row level security;
alter table tenancy.pay_code force row level security;
create policy tenant_isolation on tenancy.pay_code for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy platform_access on tenancy.pay_code to aora_platform using (true) with check (true);
grant select on tenancy.pay_code to aora_app;
grant select, insert on tenancy.pay_code to aora_platform;
grant update (status) on tenancy.pay_code to aora_platform;

-- ---------------------------------------------------------------------------
-- Consumer limits and timing notes, as versioned data (P7-5, P7-7).
-- ---------------------------------------------------------------------------

create table chiwo.consumer_limit (
  id uuid primary key default gen_random_uuid(),
  operation text not null check (operation ~ '^[a-z][a-z0-9_]{2,40}$'),
  asset_code text not null references ledger.asset (code),
  per_payment_max bigint not null check (per_payment_max > 0),
  per_day_max bigint not null check (per_day_max > 0),
  effective_from timestamptz not null,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  unique (operation, asset_code, effective_from),
  check (per_payment_max <= per_day_max)
);

-- SANDBOX limits for paying a merchant: KES 150,000 per payment, KES 300,000 per day.
insert into chiwo.consumer_limit (operation, asset_code, per_payment_max, per_day_max, effective_from)
values ('merchant_payment', 'KES', 15000000, 30000000, '2026-01-01T00:00:00Z');

create table chiwo.timing_note (
  id uuid primary key default gen_random_uuid(),
  rail text not null check (rail ~ '^[a-z][a-z0-9_]{1,30}$'),
  body text not null check (length(btrim(body)) between 10 and 300),
  effective_from timestamptz not null,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  unique (rail, effective_from)
);

insert into chiwo.timing_note (rail, body, effective_from) values
  ('mpesa', 'An M-Pesa prompt appears on the paying phone, usually within a minute. Approve it there with the M-Pesa PIN. The result shows here as soon as M-Pesa confirms it.',
   '2026-01-01T00:00:00Z');

create function chiwo.reject_change() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'CHIWO reference data is append-only' using errcode = 'restrict_violation';
end
$$;

create trigger consumer_limit_immutable before update or delete on chiwo.consumer_limit
  for each row execute function chiwo.reject_change();
create trigger timing_note_immutable before update or delete on chiwo.timing_note
  for each row execute function chiwo.reject_change();

-- ---------------------------------------------------------------------------
-- Payments to a merchant (P7-4). The money moves as the merchant's collection;
-- this row is the consumer's side of it.
-- ---------------------------------------------------------------------------

alter table payments.payment_intent
  add column channel text not null default 'kony' check (channel in ('kony', 'chiwo'));

create table chiwo.merchant_payment (
  id uuid primary key default gen_random_uuid(),
  consumer_account_id uuid not null references chiwo.consumer (account_id),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request_hash text not null,
  pay_code text not null references tenancy.pay_code (code),
  tenant_id uuid not null references tenancy.workspace (id),
  amount bigint not null check (amount > 0),
  fee_minor bigint not null default 0 check (fee_minor >= 0),
  asset_code text not null references ledger.asset (code),
  rail text not null check (rail ~ '^[a-z][a-z0-9_]{1,30}$'),
  intent_id uuid unique references payments.payment_intent (id),
  status text not null default 'submitted' check (status in (
    'submitted', 'being_checked', 'succeeded', 'failed', 'reconciliation_required')),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (consumer_account_id, idempotency_key)
);

create index merchant_payment_consumer on chiwo.merchant_payment (consumer_account_id, created_at desc);

create function chiwo.protect_merchant_payment() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE'
     or (to_jsonb(new) - array['status', 'intent_id', 'updated_at'])
        <> (to_jsonb(old) - array['status', 'intent_id', 'updated_at'])
     or old.intent_id is not null and new.intent_id is distinct from old.intent_id then
    raise exception 'a payment''s terms never change' using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger merchant_payment_protect before update or delete on chiwo.merchant_payment
  for each row execute function chiwo.protect_merchant_payment();

-- Consumer isolation (P7-2): the tenant role sees only the signed-in consumer's
-- rows and never a merchant's; no tenant policy exists on these tables.
do $$
declare
  t text;
begin
  foreach t in array array['consumer', 'merchant_payment'] loop
    execute format('alter table chiwo.%I enable row level security', t);
    execute format('alter table chiwo.%I force row level security', t);
    execute format('create policy platform_access on chiwo.%I to aora_platform
                      using (true) with check (true)', t);
    execute format('grant select on chiwo.%I to aora_app', t);
    execute format('grant select, insert on chiwo.%I to aora_platform', t);
  end loop;
end
$$;

create policy consumer_isolation on chiwo.consumer for select to aora_app
  using (account_id = identity.current_account_id());
create policy consumer_isolation on chiwo.merchant_payment for select to aora_app
  using (consumer_account_id = identity.current_account_id());

grant update (status) on chiwo.consumer to aora_platform;
grant update (status, intent_id) on chiwo.merchant_payment to aora_platform;
grant select on chiwo.consumer_limit, chiwo.timing_note to aora_app, aora_platform;

-- ---------------------------------------------------------------------------
-- SANDBOX CHIWO terms, version 1.
-- ---------------------------------------------------------------------------

insert into consent.terms_document (key, version, language, title, body, body_sha256, effective_from)
select 'chiwo_terms', '1', 'en', 'CHIWO (sandbox): terms of use', body,
       encode(sha256(convert_to(body, 'UTF8')), 'hex'), '2026-01-01T00:00:00Z'
from (values (
  'SANDBOX ONLY. CHIWO is a demonstration. No real money moves and no real service is provided.' || E'\n' ||
  'Your CHIWO account is personal. It is separate from any business workspace you belong to: nothing you do in CHIWO acts for a business, and a business role gives you nothing in CHIWO.' || E'\n' ||
  'Payments to merchants go through the M-Pesa sandbox. In the sandbox, the payment prompt goes to Safaricom''s test number, not to your phone.' || E'\n' ||
  'Before you pay, CHIWO shows the amount, any fee you pay and the expected timing. A payment is final only when the provider confirms it.' || E'\n' ||
  'Limits apply to each payment and to each day.'
)) as t(body);
