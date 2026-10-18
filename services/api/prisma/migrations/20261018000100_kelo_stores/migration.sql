-- Phase 4, checkpoint 4A-1: KELO store enlistment, vetting and KELO-to-KONY
-- provisioning (ADRs 0008 and 0017). Expand-only: a new schema, new tables.

create schema kelo;
grant usage on schema kelo to aora_app, aora_platform;

-- ---------------------------------------------------------------------------
-- Taxonomy is data (ADR 0017). Versioned with effective dates; a change is a
-- new version, never an edit. The twelve rows below are SANDBOX seed data
-- (open question O-15). Vetting requirement keys are sandbox placeholders for
-- an operator to attest: they are not verified legal requirements.
-- ---------------------------------------------------------------------------

create table kelo.category (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references kelo.category (id),
  slug text not null check (slug ~ '^[a-z][a-z0-9-]{1,60}$'),
  name text not null check (length(btrim(name)) between 1 and 80),
  version integer not null check (version > 0),
  effective_from timestamptz not null,
  effective_to timestamptz,
  listing_types text[] not null
    check (cardinality(listing_types) > 0
           and listing_types <@ array['stock_item', 'scheduled_service', 'quote_service']),
  vetting_requirements text[] not null default '{}',
  -- A change to a published listing's price or description sends it back to review.
  restricted boolean not null default false,
  fulfilment_evidence text not null
    check (fulfilment_evidence in ('consumer_confirmation', 'merchant_proof', 'session_start')),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  unique (slug, version),
  check (effective_to is null or effective_to > effective_from)
);

create trigger category_immutable before update or delete on kelo.category
  for each row execute function business.reject_change();

grant select on kelo.category to aora_app, aora_platform;

insert into kelo.category
  (slug, name, version, effective_from, listing_types, vetting_requirements, restricted, fulfilment_evidence)
values
  ('electronics', 'Electronics and phones', 1, '2026-10-01', array['stock_item'],
   array['sandbox_kyb_checked'], false, 'consumer_confirmation'),
  ('home-appliances', 'Home appliances', 1, '2026-10-01', array['stock_item'],
   array['sandbox_kyb_checked'], false, 'consumer_confirmation'),
  ('furniture', 'Furniture', 1, '2026-10-01', array['stock_item'],
   array['sandbox_kyb_checked'], false, 'consumer_confirmation'),
  ('solar-home-systems', 'Solar home systems', 1, '2026-10-01', array['stock_item'],
   array['sandbox_kyb_checked', 'sandbox_installer_capability_sighted'], false, 'merchant_proof'),
  ('motorbikes', 'Motorbikes', 1, '2026-10-01', array['stock_item'],
   array['sandbox_kyb_checked', 'sandbox_dealer_licence_sighted'], true, 'merchant_proof'),
  ('holidays', 'Holidays and travel', 1, '2026-10-01', array['scheduled_service'],
   array['sandbox_kyb_checked', 'sandbox_tour_operator_licence_sighted'], false, 'session_start'),
  ('courses-and-exams', 'Courses and exams', 1, '2026-10-01', array['scheduled_service'],
   array['sandbox_kyb_checked', 'sandbox_institution_registration_sighted'], false, 'session_start'),
  ('optical', 'Optical', 1, '2026-10-01', array['stock_item', 'scheduled_service'],
   array['sandbox_kyb_checked', 'sandbox_practice_licence_sighted'], true, 'consumer_confirmation'),
  ('dental', 'Dental', 1, '2026-10-01', array['scheduled_service'],
   array['sandbox_kyb_checked', 'sandbox_practice_licence_sighted'], true, 'session_start'),
  ('medical-cosmetic', 'Medical-cosmetic', 1, '2026-10-01', array['scheduled_service'],
   array['sandbox_kyb_checked', 'sandbox_practice_licence_sighted'], true, 'session_start'),
  ('moving', 'Moving', 1, '2026-10-01', array['quote_service'],
   array['sandbox_kyb_checked'], false, 'consumer_confirmation'),
  ('home-repairs', 'Home repairs and installation', 1, '2026-10-01', array['quote_service'],
   array['sandbox_kyb_checked'], false, 'consumer_confirmation');

-- ---------------------------------------------------------------------------
-- A store enlistment. It exists before any workspace (a new merchant) or names
-- an existing KONY workspace whose admin enlists it. Platform access until it
-- is provisioned; then its workspace's members may read it.
-- ---------------------------------------------------------------------------

create table kelo.store (
  id uuid primary key default gen_random_uuid(),
  applicant_account_id uuid not null references identity.user_account (id),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request_hash text not null,
  display_name text not null check (length(btrim(display_name)) between 1 and 80),
  category_slugs text[] not null check (cardinality(category_slugs) between 1 and 12),
  -- Either an existing workspace, or the business details to resolve (ADR 0012).
  existing_tenant_id uuid references tenancy.workspace (id),
  kind text check (kind in ('registered', 'unregistered')),
  name text check (length(btrim(name)) between 1 and 120),
  country text check (country ~ '^[A-Z]{2}$'),
  registration_type text,
  registration_value text,
  location jsonb,
  -- SANDBOX ONLY: the scripted answer of the sandbox verification adapter (D-8).
  verification text check (verification in ('verified', 'unverified')),
  status text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected')),
  restrictions text[] not null default '{}'
    check (restrictions <@ array['payouts_suspended', 'listing_suspended']),
  business_id uuid references business.business (id),
  -- Set by provisioning once the store is linked to its workspace.
  tenant_id uuid references tenancy.workspace (id),
  decided_by uuid references identity.user_account (id),
  decision_reason text,
  decided_at timestamptz,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (applicant_account_id, idempotency_key),
  check ((existing_tenant_id is null) = (kind is not null)),
  check (existing_tenant_id is not null
         or (name is not null and country is not null and verification is not null)),
  check (kind is distinct from 'registered'
         or (registration_type is not null and registration_value is not null)),
  check (kind is distinct from 'unregistered' or location is not null),
  check ((status = 'submitted') = (decided_at is null)),
  check (tenant_id is null or status = 'approved')
);

-- One KELO link per workspace (ADR 0008).
create unique index store_one_per_workspace on kelo.store (tenant_id) where tenant_id is not null;
create index store_status on kelo.store (status, created_at);
create index store_applicant on kelo.store (applicant_account_id, created_at);

create function kelo.protect_store() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE'
     or (to_jsonb(new) - array['status', 'restrictions', 'business_id', 'tenant_id', 'decided_by',
                               'decision_reason', 'decided_at', 'updated_at'])
        <> (to_jsonb(old) - array['status', 'restrictions', 'business_id', 'tenant_id', 'decided_by',
                                  'decision_reason', 'decided_at', 'updated_at'])
     -- A decision is final, and is taken once.
     or (old.status <> 'submitted'
         and (new.status <> old.status or new.restrictions <> old.restrictions
              or new.decided_by is distinct from old.decided_by
              or new.decision_reason is distinct from old.decision_reason
              or new.decided_at is distinct from old.decided_at))
     -- The business and the workspace are linked once and never re-pointed.
     or (old.business_id is not null and new.business_id is distinct from old.business_id)
     or (old.tenant_id is not null and new.tenant_id is distinct from old.tenant_id) then
    raise exception 'a store''s enlistment is immutable, its decision final, and its links permanent'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger store_protect before update or delete on kelo.store
  for each row execute function kelo.protect_store();

alter table kelo.store enable row level security;
alter table kelo.store force row level security;
create policy tenant_isolation on kelo.store for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy platform_access on kelo.store to aora_platform using (true) with check (true);

grant select on kelo.store to aora_app;
grant select, insert on kelo.store to aora_platform;
grant update (status, restrictions, business_id, tenant_id, decided_by, decision_reason, decided_at)
  on kelo.store to aora_platform;

-- What the operator attested for each category at approval. Written once.
create table kelo.store_category (
  store_id uuid not null references kelo.store (id),
  category_slug text not null,
  category_version integer not null,
  attested text[] not null,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  primary key (store_id, category_slug),
  foreign key (category_slug, category_version) references kelo.category (slug, version)
);

create trigger store_category_immutable before update or delete on kelo.store_category
  for each row execute function business.reject_change();

grant select, insert on kelo.store_category to aora_platform;

-- ---------------------------------------------------------------------------
-- Provisioning (ADR 0008): one record per store, one step per transaction.
-- ---------------------------------------------------------------------------

create table kelo.provisioning (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null unique references kelo.store (id),
  status text not null default 'requested'
    check (status in ('requested', 'business_resolved', 'workspace_linked', 'admin_assigned',
                      'completed', 'failed_retryable', 'failed_needs_review',
                      'reconciliation_required')),
  -- The last step that committed; a retry resumes after it.
  last_step text not null default 'requested'
    check (last_step in ('requested', 'business_resolved', 'workspace_linked', 'admin_assigned',
                         'completed')),
  business_id uuid references business.business (id),
  tenant_id uuid references tenancy.workspace (id),
  admin_account_id uuid references identity.user_account (id),
  attempts integer not null default 0,
  -- A reason code, never free text from a request: it is shown to operators.
  reason text check (reason ~ '^[a-z][a-z0-9_]{2,60}$'),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'completed') = (last_step = 'completed')),
  check (status <> 'completed' or (business_id is not null and tenant_id is not null
                                   and admin_account_id is not null))
);

create index provisioning_status on kelo.provisioning (status, updated_at);

create function kelo.protect_provisioning() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or old.status = 'completed'
     or new.store_id <> old.store_id
     or (old.business_id is not null and new.business_id is distinct from old.business_id)
     or (old.tenant_id is not null and new.tenant_id is distinct from old.tenant_id)
     or (old.admin_account_id is not null
         and new.admin_account_id is distinct from old.admin_account_id) then
    raise exception 'completed provisioning is final, and its links are permanent'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger provisioning_protect before update or delete on kelo.provisioning
  for each row execute function kelo.protect_provisioning();

alter table kelo.provisioning enable row level security;
alter table kelo.provisioning force row level security;
create policy tenant_isolation on kelo.provisioning for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy platform_access on kelo.provisioning to aora_platform using (true) with check (true);

grant select on kelo.provisioning to aora_app;
grant select, insert on kelo.provisioning to aora_platform;
grant update (status, last_step, business_id, tenant_id, admin_account_id, attempts, reason)
  on kelo.provisioning to aora_platform;

-- ---------------------------------------------------------------------------
-- Workspace restrictions: a closed list, copied from KELO vetting and lifted
-- only by an operator with a reason (brief §13.4).
-- ---------------------------------------------------------------------------

create table tenancy.workspace_restriction (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenancy.workspace (id),
  kind text not null check (kind in ('payouts_suspended', 'listing_suspended')),
  source text not null check (source ~ '^[a-z][a-z0-9_.]{2,60}$'),
  source_id uuid,
  lifted_at timestamptz,
  lifted_by uuid references identity.user_account (id),
  lift_reason text,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  check ((lifted_at is null) = (lifted_by is null)),
  check ((lifted_at is null) = (lift_reason is null))
);

create unique index workspace_restriction_active on tenancy.workspace_restriction (tenant_id, kind)
  where lifted_at is null;

create function tenancy.protect_restriction() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or old.lifted_at is not null
     or (to_jsonb(new) - array['lifted_at', 'lifted_by', 'lift_reason'])
        <> (to_jsonb(old) - array['lifted_at', 'lifted_by', 'lift_reason']) then
    raise exception 'a restriction never changes except to be lifted, once'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

create trigger workspace_restriction_protect before update or delete
  on tenancy.workspace_restriction for each row execute function tenancy.protect_restriction();

alter table tenancy.workspace_restriction enable row level security;
alter table tenancy.workspace_restriction force row level security;
create policy tenant_isolation on tenancy.workspace_restriction for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy platform_access on tenancy.workspace_restriction to aora_platform
  using (true) with check (true);

grant select on tenancy.workspace_restriction to aora_app;
grant select, insert on tenancy.workspace_restriction to aora_platform;
grant update (lifted_at, lifted_by, lift_reason) on tenancy.workspace_restriction to aora_platform;
