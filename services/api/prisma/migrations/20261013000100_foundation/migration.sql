-- Phase 1, checkpoint 1A: identity, business, tenancy, audit.
-- Prerequisite: prisma/bootstrap.sql has created roles aora_owner, aora_app, aora_platform.
--
-- Access model (ADR 0002, open question E-1):
--   aora_app       sees tenant-owned rows only, and only for the tenant named by the
--                  transaction-local setting app.tenant_id. No setting, no rows.
--   aora_platform  cross-tenant, for sign-in, workers, reconciliation and operators.
-- Every tenant and financial table carries mode, and only 'sandbox' is permitted (E-2).

revoke all on schema public from public;

create schema identity;
create schema business;
create schema tenancy;
create schema audit;

grant usage on schema identity to aora_platform;
grant usage on schema business to aora_platform;
grant usage on schema tenancy to aora_app, aora_platform;
grant usage on schema audit to aora_app, aora_platform;

-- The tenant for the current transaction, or null when none has been set.
create function tenancy.current_tenant_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

grant execute on function tenancy.current_tenant_id() to aora_app, aora_platform;

-- ---------------------------------------------------------------------------
-- identity: platform access only. A signed-in request reaches it through the
-- session lookup, never through the tenant-scoped role.
-- ---------------------------------------------------------------------------

create table identity.person (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table identity.user_account (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references identity.person (id),
  phone_e164 text not null unique check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  is_platform_operator boolean not null default false,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now()
);

create table identity.auth_challenge (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references identity.user_account (id),
  purpose text not null check (purpose in ('sign_in', 'step_up')),
  code_hash text not null,
  attempts integer not null default 0 check (attempts >= 0),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table identity.session (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references identity.user_account (id),
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  step_up_until timestamptz,
  created_at timestamptz not null default now()
);

grant select, insert on identity.person, identity.user_account to aora_platform;
grant select, insert, update on identity.auth_challenge, identity.session to aora_platform;

-- ---------------------------------------------------------------------------
-- business: canonical business identity (ADR 0012). Platform access only in Phase 1.
-- ---------------------------------------------------------------------------

create table business.business (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('registered', 'unregistered')),
  name text not null check (length(btrim(name)) > 0),
  name_normalised text not null check (length(name_normalised) > 0),
  country text not null check (country ~ '^[A-Z]{2}$'),
  owner_person_id uuid references identity.person (id),
  location jsonb,
  location_key text,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  -- An unregistered business is identified by owner, name and location.
  check (kind = 'registered' or (owner_person_id is not null and location_key is not null))
);

create unique index business_unregistered_identity
  on business.business (owner_person_id, name_normalised, location_key)
  where kind = 'unregistered';

create table business.business_identifier (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.business (id),
  type text not null check (length(type) > 0),
  country text not null check (country ~ '^[A-Z]{2}$'),
  value_normalised text not null check (length(value_normalised) > 0),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (type, country, value_normalised)
);

grant select, insert on business.business, business.business_identifier to aora_platform;

-- ---------------------------------------------------------------------------
-- tenancy: the tenant is the workspace.
-- ---------------------------------------------------------------------------

create table tenancy.workspace (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business.business (id),
  product text not null check (product in ('kony')),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  unique (business_id, product)
);

create table tenancy.membership (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenancy.workspace (id),
  account_id uuid not null references identity.user_account (id),
  role text not null check (role in ('admin', 'finance', 'cashier')),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  unique (tenant_id, account_id)
);

alter table tenancy.workspace enable row level security;
alter table tenancy.workspace force row level security;
alter table tenancy.membership enable row level security;
alter table tenancy.membership force row level security;

create policy tenant_isolation on tenancy.workspace for select to aora_app
  using (id = tenancy.current_tenant_id());
create policy platform_access on tenancy.workspace to aora_platform
  using (true) with check (true);

create policy tenant_isolation on tenancy.membership for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy platform_access on tenancy.membership to aora_platform
  using (true) with check (true);

grant select on tenancy.workspace, tenancy.membership to aora_app;
grant select, insert on tenancy.workspace, tenancy.membership to aora_platform;

-- ---------------------------------------------------------------------------
-- audit: append-only.
-- ---------------------------------------------------------------------------

create table audit.audit_event (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  tenant_id uuid references tenancy.workspace (id),
  actor_kind text not null check (actor_kind in ('user', 'system', 'provider')),
  actor_account_id uuid references identity.user_account (id),
  action text not null check (length(action) > 0),
  subject_type text not null,
  subject_id text not null,
  outcome text not null check (outcome in ('success', 'denied', 'failure')),
  request_id text,
  detail jsonb not null default '{}'::jsonb,
  mode text not null default 'sandbox' check (mode = 'sandbox')
);

create index audit_event_tenant_time on audit.audit_event (tenant_id, occurred_at);

create function audit.reject_change() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'audit events are append-only' using errcode = 'restrict_violation';
end
$$;

create trigger audit_event_immutable
  before update or delete on audit.audit_event
  for each row execute function audit.reject_change();

create trigger audit_event_no_truncate
  before truncate on audit.audit_event
  for each statement execute function audit.reject_change();

alter table audit.audit_event enable row level security;
alter table audit.audit_event force row level security;

create policy tenant_read on audit.audit_event for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy tenant_write on audit.audit_event for insert to aora_app
  with check (tenant_id = tenancy.current_tenant_id());
create policy platform_access on audit.audit_event to aora_platform
  using (true) with check (true);

grant select, insert on audit.audit_event to aora_app, aora_platform;
