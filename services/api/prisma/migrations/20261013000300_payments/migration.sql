-- Phase 1, checkpoint 1C: payment intents, webhook intake, reconciliation,
-- and the AORA simulator provider's own records.

create schema payments;
create schema sim;

grant usage on schema payments to aora_app, aora_platform;
grant usage on schema sim to aora_platform;

-- ---------------------------------------------------------------------------
-- Payment intents. Status changes only through the application's transition
-- table; every change is recorded in payment_intent_transition.
-- ---------------------------------------------------------------------------

create table payments.payment_intent (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenancy.workspace (id),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request_hash text not null,
  amount bigint not null check (amount > 0),
  asset_code text not null references ledger.asset (code),
  status text not null default 'created' check (status in (
    'created', 'submitting', 'pending_provider', 'succeeded', 'failed',
    'status_unknown', 'reconciliation_required')),
  provider text not null,
  provider_reference text,
  sandbox_scenario text,
  failure_code text,
  status_inquiries integer not null default 0 check (status_inquiries >= 0),
  created_by uuid not null references identity.user_account (id),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create index payment_intent_status on payments.payment_intent (status, updated_at);

create table payments.payment_intent_transition (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid not null references payments.payment_intent (id),
  tenant_id uuid not null references tenancy.workspace (id),
  from_status text,
  to_status text not null,
  source text not null check (source in ('api', 'adapter', 'webhook', 'inquiry')),
  reason text,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now()
);

create index payment_intent_transition_intent
  on payments.payment_intent_transition (intent_id, created_at);

create function payments.reject_change() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'record is append-only (%.%)', tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end
$$;

create trigger payment_intent_transition_immutable
  before update or delete on payments.payment_intent_transition
  for each row execute function payments.reject_change();

-- Financial facts of an intent never change after creation.
create function payments.protect_intent() returns trigger
  language plpgsql
  as $$
begin
  if new.tenant_id <> old.tenant_id or new.amount <> old.amount
     or new.asset_code <> old.asset_code or new.idempotency_key <> old.idempotency_key
     or new.request_hash <> old.request_hash or new.created_by <> old.created_by
     or new.provider <> old.provider then
    raise exception 'payment intent amount, asset, tenant and identity are immutable'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger payment_intent_protect before update on payments.payment_intent
  for each row execute function payments.protect_intent();
create trigger payment_intent_no_delete before delete on payments.payment_intent
  for each row execute function payments.reject_change();

alter table payments.payment_intent enable row level security;
alter table payments.payment_intent force row level security;
alter table payments.payment_intent_transition enable row level security;
alter table payments.payment_intent_transition force row level security;

create policy tenant_read on payments.payment_intent for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy tenant_create on payments.payment_intent for insert to aora_app
  with check (tenant_id = tenancy.current_tenant_id() and status = 'created');
create policy platform_access on payments.payment_intent to aora_platform
  using (true) with check (true);

create policy tenant_read on payments.payment_intent_transition for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy tenant_create on payments.payment_intent_transition for insert to aora_app
  with check (tenant_id = tenancy.current_tenant_id() and from_status is null and to_status = 'created');
create policy platform_access on payments.payment_intent_transition to aora_platform
  using (true) with check (true);

grant select, insert on payments.payment_intent, payments.payment_intent_transition to aora_app;
grant select, insert on payments.payment_intent_transition to aora_platform;
grant select, insert, update on payments.payment_intent to aora_platform;

-- ---------------------------------------------------------------------------
-- Webhook intake. Raw payloads are kept exactly as received. Platform only:
-- the tenant is not known until the payload has been verified and parsed.
-- ---------------------------------------------------------------------------

create table payments.webhook_event (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  payload_raw text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  outcome text,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  unique (provider, provider_event_id)
);

create function payments.protect_webhook_payload() returns trigger
  language plpgsql
  as $$
begin
  if new.payload_raw <> old.payload_raw or new.provider <> old.provider
     or new.provider_event_id <> old.provider_event_id then
    raise exception 'webhook payloads are stored as received and never changed'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

create trigger webhook_event_protect before update on payments.webhook_event
  for each row execute function payments.protect_webhook_payload();
create trigger webhook_event_no_delete before delete on payments.webhook_event
  for each row execute function payments.reject_change();

grant select, insert, update on payments.webhook_event to aora_platform;

-- ---------------------------------------------------------------------------
-- Reconciliation. Detect and record only; nothing here corrects anything.
-- ---------------------------------------------------------------------------

create table payments.reconciliation_run (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  lines_checked integer not null default 0,
  intents_checked integer not null default 0,
  exceptions_opened integer not null default 0,
  mode text not null default 'sandbox' check (mode = 'sandbox')
);

create table payments.reconciliation_exception (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references payments.reconciliation_run (id),
  tenant_id uuid references tenancy.workspace (id),
  type text not null check (type in (
    'missing_internal', 'missing_at_provider', 'amount_mismatch', 'duplicate_reference',
    'state_mismatch', 'stuck_status_unknown', 'ledger_mismatch', 'provider_result_conflict')),
  subject_type text not null,
  subject_ref text not null,
  detail jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open')),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now()
);

-- Re-running reconciliation must not open the same exception twice.
create unique index reconciliation_exception_open
  on payments.reconciliation_exception (type, subject_ref) where status = 'open';

alter table payments.reconciliation_exception enable row level security;
alter table payments.reconciliation_exception force row level security;

-- Operators only: no policy and no grant for the tenant role.
create policy platform_access on payments.reconciliation_exception to aora_platform
  using (true) with check (true);

grant select, insert, update on payments.reconciliation_run to aora_platform;
grant select, insert on payments.reconciliation_exception to aora_platform;

-- ---------------------------------------------------------------------------
-- sim: the AORA simulator provider's side of the world. These tables stand in
-- for an external provider's systems. They are not AORA's books.
-- ---------------------------------------------------------------------------

create table sim.sim_transaction (
  id uuid primary key default gen_random_uuid(),
  operation_ref text not null unique,
  amount bigint not null check (amount > 0),
  asset_code text not null,
  scenario text not null,
  status text not null check (status in ('pending', 'succeeded', 'failed')),
  -- How many lines the settlement report shows for this transaction (0 = missing, 2 = duplicated).
  report_copies integer not null default 1 check (report_copies between 0 and 2),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now()
);

create table sim.sim_webhook_delivery (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references sim.sim_transaction (id),
  sequence bigint generated always as identity,
  body text not null,
  deliver_after timestamptz not null default now(),
  delivered_at timestamptz
);

grant select, insert, update on sim.sim_transaction, sim.sim_webhook_delivery to aora_platform;
