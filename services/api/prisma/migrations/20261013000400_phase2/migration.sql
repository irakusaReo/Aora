-- Phase 2: PIN step-up, membership management, consent records, rate limiting,
-- job leases and the simulated SMS outbox.

-- ---------------------------------------------------------------------------
-- identity: transaction PIN. Only a slow salted hash is stored.
-- ---------------------------------------------------------------------------

alter table identity.user_account
  add column pin_hash text,
  add column pin_set_at timestamptz,
  add column pin_failed_attempts integer not null default 0 check (pin_failed_attempts >= 0),
  add column pin_locked_until timestamptz;

grant update (pin_hash, pin_set_at, pin_failed_attempts, pin_locked_until)
  on identity.user_account to aora_platform;

alter table identity.auth_challenge drop constraint auth_challenge_purpose_check;
alter table identity.auth_challenge
  add constraint auth_challenge_purpose_check check (purpose in ('sign_in', 'step_up', 'pin_setup'));

-- ---------------------------------------------------------------------------
-- tenancy: members can change role or be removed, but a workspace always keeps
-- at least one active admin. Enforced here, not only in the application.
-- ---------------------------------------------------------------------------

alter table tenancy.membership
  add column status text not null default 'active' check (status in ('active', 'removed'));

grant update (role, status) on tenancy.membership to aora_platform;

-- The check below runs as the owner, which FORCE row-level security also binds.
create policy trigger_access on tenancy.membership for select to aora_owner using (true);

create function tenancy.assert_active_admin() returns trigger
  language plpgsql
  security definer
  set search_path = ''
  as $$
begin
  if not exists (
    select from tenancy.membership m
    where m.tenant_id = new.tenant_id and m.role = 'admin' and m.status = 'active'
  ) then
    raise exception 'a workspace must keep at least one active admin'
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

create constraint trigger membership_keeps_admin after update on tenancy.membership
  deferrable initially deferred
  for each row execute function tenancy.assert_active_admin();

-- ---------------------------------------------------------------------------
-- consent: versioned terms and append-only consent records (brief §7.4).
-- ---------------------------------------------------------------------------

create schema consent;
grant usage on schema consent to aora_platform;

create table consent.terms_document (
  id uuid primary key default gen_random_uuid(),
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,60}$'),
  version text not null check (length(version) between 1 and 40),
  language text not null check (language ~ '^[a-z]{2}$'),
  title text not null,
  body text not null,
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  effective_from timestamptz not null,
  effective_to timestamptz,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  unique (key, version, language),
  check (effective_to is null or effective_to > effective_from)
);

create table consent.consent_record (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references identity.person (id),
  account_id uuid not null references identity.user_account (id),
  -- Whether the person acted for themselves or on behalf of a business.
  capacity text not null check (capacity in ('personal', 'business')),
  tenant_id uuid references tenancy.workspace (id),
  action text not null check (action ~ '^[a-z][a-z0-9_.]{1,80}$'),
  terms_document_id uuid not null references consent.terms_document (id),
  request_id text,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  check ((capacity = 'business') = (tenant_id is not null))
);

create index consent_record_account on consent.consent_record (account_id, created_at);

create function consent.reject_change() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'consent records are append-only and published terms are immutable (%.%)',
    tg_table_schema, tg_table_name using errcode = 'restrict_violation';
end
$$;

-- A terms version may be closed (effective_to set once), never otherwise changed.
create function consent.protect_terms() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or old.effective_to is not null
     or (to_jsonb(new) - 'effective_to') <> (to_jsonb(old) - 'effective_to') then
    raise exception 'consent records are append-only and published terms are immutable (%.%)',
      tg_table_schema, tg_table_name using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

create trigger terms_document_protect before update or delete on consent.terms_document
  for each row execute function consent.protect_terms();
create trigger consent_record_immutable before update or delete on consent.consent_record
  for each row execute function consent.reject_change();
create trigger consent_record_no_truncate before truncate on consent.consent_record
  for each statement execute function consent.reject_change();

alter table consent.consent_record enable row level security;
alter table consent.consent_record force row level security;
create policy platform_access on consent.consent_record to aora_platform
  using (true) with check (true);

grant select, insert on consent.terms_document, consent.consent_record to aora_platform;
grant update (effective_to) on consent.terms_document to aora_platform;

-- ---------------------------------------------------------------------------
-- ops: shared operational state for serverless instances. Platform role only.
-- ---------------------------------------------------------------------------

create schema ops;
grant usage on schema ops to aora_platform;

-- Fixed-window counters. bucket is a SHA-256 of the limit name and its key, so
-- no phone number or network address is stored.
create table ops.rate_limit (
  bucket text not null check (bucket ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  count integer not null check (count > 0),
  primary key (bucket, window_start)
);

create index rate_limit_window on ops.rate_limit (window_start);

-- One row per named job while it runs; expires so a crashed run cannot block for ever.
create table ops.job_lease (
  name text primary key,
  holder uuid not null,
  expires_at timestamptz not null
);

grant select, insert, update, delete on ops.rate_limit, ops.job_lease to aora_platform;

-- ---------------------------------------------------------------------------
-- sim: outbox of the simulated SMS sender (sandbox only).
-- ---------------------------------------------------------------------------

create table sim.sim_sms (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null,
  body text not null,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now()
);

create index sim_sms_phone on sim.sim_sms (phone_e164, created_at);

grant select, insert on sim.sim_sms to aora_platform;
