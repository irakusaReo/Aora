-- Phase 3, checkpoint 3A-2: merchant onboarding with duplicate detection
-- (ADR 0012), staff invitations by email, and resolution of reconciliation
-- exceptions by an operator.
--
-- Expand-only: new tables, new nullable columns, wider check constraints.

-- ---------------------------------------------------------------------------
-- Identifier types are data, per country (ADR 0012). Kenya's real registration
-- identifiers are not yet verified (open question D-7), so only a sandbox type exists.
-- ---------------------------------------------------------------------------

create table business.identifier_type (
  type text not null check (type ~ '^[a-z][a-z0-9_]{2,40}$'),
  country text not null check (country ~ '^[A-Z]{2}$'),
  label text not null,
  primary key (type, country)
);

insert into business.identifier_type (type, country, label)
values ('sandbox_registration_number', 'KE', 'SANDBOX registration number (not a real registry)');

grant select on business.identifier_type to aora_platform;

-- ---------------------------------------------------------------------------
-- Onboarding applications. Platform access only: an applicant is not yet a
-- member of any workspace, so there is no tenant to scope by.
-- ---------------------------------------------------------------------------

create table business.onboarding_application (
  id uuid primary key default gen_random_uuid(),
  applicant_account_id uuid not null references identity.user_account (id),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request_hash text not null,
  kind text not null check (kind in ('registered', 'unregistered')),
  name text not null check (length(btrim(name)) between 1 and 120),
  country text not null check (country ~ '^[A-Z]{2}$'),
  registration_type text,
  registration_value text,
  location jsonb,
  -- What the sandbox verification adapter said about the applicant's evidence (open question D-8).
  verification text not null check (verification in ('verified', 'unverified')),
  status text not null default 'submitted'
    check (status in ('submitted', 'needs_review', 'approved', 'rejected')),
  business_id uuid references business.business (id),
  tenant_id uuid references tenancy.workspace (id),
  decided_by uuid references identity.user_account (id),
  decision_reason text,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (applicant_account_id, idempotency_key),
  check ((kind = 'registered') = (registration_type is not null and registration_value is not null)),
  check ((kind = 'unregistered') = (location is not null)),
  -- A workspace exists exactly when the application was approved.
  check ((status = 'approved') = (tenant_id is not null))
);

create index onboarding_application_status on business.onboarding_application (status, created_at);

create function business.reject_change() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'record is append-only (%.%)', tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end
$$;

-- What was applied for never changes; a decision is final.
create function business.protect_application() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or old.status in ('approved', 'rejected')
     or (to_jsonb(new) - array['status', 'business_id', 'tenant_id', 'decided_by', 'decision_reason', 'updated_at'])
        <> (to_jsonb(old) - array['status', 'business_id', 'tenant_id', 'decided_by', 'decision_reason', 'updated_at']) then
    raise exception 'an onboarding application''s contents are immutable and a decision is final'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger onboarding_application_protect
  before update or delete on business.onboarding_application
  for each row execute function business.protect_application();

-- Every match decision, with the inputs and rule that produced it (ADR 0012).
create table business.match_decision (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references business.onboarding_application (id),
  rule text not null check (rule ~ '^[a-z][a-z0-9_]{2,60}$'),
  normalisation_version integer not null,
  inputs jsonb not null,
  outcome text not null check (outcome in ('same', 'new', 'review')),
  matched_business_id uuid references business.business (id),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now()
);

create index match_decision_application on business.match_decision (application_id);

create trigger match_decision_immutable before update or delete on business.match_decision
  for each row execute function business.reject_change();
create trigger match_decision_no_truncate before truncate on business.match_decision
  for each statement execute function business.reject_change();

-- The application names the workspace it produced, so it carries the same
-- guard as every table with a tenant_id: no policy for the tenant role at all.
alter table business.onboarding_application enable row level security;
alter table business.onboarding_application force row level security;
create policy platform_access on business.onboarding_application to aora_platform
  using (true) with check (true);

grant select, insert on business.onboarding_application, business.match_decision to aora_platform;
grant update (status, business_id, tenant_id, decided_by, decision_reason)
  on business.onboarding_application to aora_platform;

-- ---------------------------------------------------------------------------
-- Staff invitations, by email address. The invitee accepts after signing in
-- with that address; nothing in an email can accept on their behalf.
-- ---------------------------------------------------------------------------

create table tenancy.invitation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenancy.workspace (id),
  email_lower text not null check (email_lower = lower(email_lower) and email_lower ~ '^[^@\s]+@[^@\s]+$'),
  role text not null check (role in ('admin', 'finance', 'cashier')),
  branch_id uuid,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  invited_by uuid not null references identity.user_account (id),
  accepted_by uuid references identity.user_account (id),
  expires_at timestamptz not null,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (branch_id, tenant_id) references tenancy.branch (id, tenant_id),
  check ((status = 'accepted') = (accepted_by is not null))
);

-- One open invitation per workspace and address.
create unique index invitation_open_unique on tenancy.invitation (tenant_id, email_lower)
  where status = 'pending';
create index invitation_email on tenancy.invitation (email_lower) where status = 'pending';

create function tenancy.protect_invitation() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or old.status <> 'pending'
     or new.tenant_id <> old.tenant_id or new.email_lower <> old.email_lower
     or new.role <> old.role or new.invited_by <> old.invited_by
     or new.branch_id is distinct from old.branch_id then
    raise exception 'an invitation''s terms are immutable and its outcome is final'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger invitation_protect before update or delete on tenancy.invitation
  for each row execute function tenancy.protect_invitation();

alter table tenancy.invitation enable row level security;
alter table tenancy.invitation force row level security;

create policy tenant_isolation on tenancy.invitation for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy platform_access on tenancy.invitation to aora_platform
  using (true) with check (true);

grant select on tenancy.invitation to aora_app;
grant select, insert on tenancy.invitation to aora_platform;
grant update (status, accepted_by, expires_at) on tenancy.invitation to aora_platform;

-- ---------------------------------------------------------------------------
-- Reconciliation exceptions can be resolved by an operator, with a reason.
-- Resolving records a judgement; it never changes an intent, a balance or an entry.
-- ---------------------------------------------------------------------------

alter table payments.reconciliation_exception
  add column resolved_at timestamptz,
  add column resolved_by uuid references identity.user_account (id),
  add column resolution text check (resolution in ('corrected', 'accepted', 'false_positive')),
  add column resolution_reason text check (resolution_reason is null or length(btrim(resolution_reason)) >= 10);

alter table payments.reconciliation_exception drop constraint reconciliation_exception_status_check;
alter table payments.reconciliation_exception add constraint reconciliation_exception_status_check
  check (status in ('open', 'resolved'));
alter table payments.reconciliation_exception add constraint reconciliation_exception_resolved_fully
  check ((status = 'resolved') = (resolved_at is not null and resolved_by is not null
         and resolution is not null and resolution_reason is not null));

create function payments.protect_exception() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or old.status = 'resolved' then
    raise exception 'a resolved exception is final and no exception can be deleted'
      using errcode = 'restrict_violation';
  end if;
  if new.type <> old.type or new.subject_ref <> old.subject_ref or new.subject_type <> old.subject_type
     or new.detail <> old.detail or new.tenant_id is distinct from old.tenant_id then
    raise exception 'what a reconciliation exception reports is immutable'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

create trigger reconciliation_exception_protect
  before update or delete on payments.reconciliation_exception
  for each row execute function payments.protect_exception();

grant update (status, resolved_at, resolved_by, resolution, resolution_reason)
  on payments.reconciliation_exception to aora_platform;
