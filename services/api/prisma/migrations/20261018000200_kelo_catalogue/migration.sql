-- Phase 4, checkpoint 4A-2: KELO catalogue, stock and capacity, images and
-- moderation (ADR 0017). Expand-only: new tables.

-- ---------------------------------------------------------------------------
-- Prohibited items: configuration with effective dates. A term blocks
-- submission of a listing whose title or description contains it as a word or
-- phrase. NULL category = every category. SANDBOX seed terms below; the real
-- list is a policy decision (to verify with counsel).
-- ---------------------------------------------------------------------------

create table kelo.prohibited_term (
  id uuid primary key default gen_random_uuid(),
  term text not null check (term = lower(btrim(term)) and length(term) between 2 and 60),
  category_slug text,
  reason text not null check (reason ~ '^[a-z][a-z0-9_]{2,60}$'),
  effective_from timestamptz not null,
  effective_to timestamptz,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from)
);

create trigger prohibited_term_immutable before update or delete on kelo.prohibited_term
  for each row execute function business.reject_change();

grant select on kelo.prohibited_term to aora_platform;

insert into kelo.prohibited_term (term, category_slug, reason, effective_from)
values
  ('counterfeit', null, 'counterfeit_goods', '2026-10-01'),
  ('replica', null, 'counterfeit_goods', '2026-10-01'),
  ('firearm', null, 'weapons', '2026-10-01'),
  ('ammunition', null, 'weapons', '2026-10-01'),
  ('stolen', null, 'stolen_goods', '2026-10-01'),
  ('ivory', null, 'protected_wildlife', '2026-10-01'),
  -- Medical-cosmetic, dental and optical listings describe a product or a
  -- service, never a person's health (ADR 0017).
  ('diagnosis', 'medical-cosmetic', 'health_information', '2026-10-01'),
  ('medical history', 'medical-cosmetic', 'health_information', '2026-10-01'),
  ('diagnosis', 'dental', 'health_information', '2026-10-01'),
  ('medical history', 'dental', 'health_information', '2026-10-01');

-- ---------------------------------------------------------------------------
-- Listings. One table with a type and type-specific children (ADR 0017).
-- Tenant-owned: members read through row-level security; writes go through
-- the platform role with the tenant named in every statement.
-- ---------------------------------------------------------------------------

create table kelo.listing (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenancy.workspace (id),
  store_id uuid not null references kelo.store (id),
  category_slug text not null,
  category_version integer not null,
  type text not null check (type in ('stock_item', 'scheduled_service', 'quote_service')),
  title text not null check (length(btrim(title)) between 3 and 120),
  description text not null check (length(btrim(description)) between 3 and 4000),
  currency text not null references ledger.asset (code),
  status text not null default 'draft'
    check (status in ('draft', 'in_review', 'published', 'rejected', 'suspended')),
  -- Bumped on every change, so a moderation decision names what it saw.
  revision integer not null default 1,
  search tsvector generated always as
    (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, ''))) stored,
  published_at timestamptz,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (category_slug, category_version) references kelo.category (slug, version),
  unique (id, tenant_id)
);

create index listing_tenant on kelo.listing (tenant_id, created_at desc);
create index listing_status on kelo.listing (status, updated_at);
create index listing_search on kelo.listing using gin (search) where status = 'published';
create index listing_category on kelo.listing (category_slug, published_at desc)
  where status = 'published';

create function kelo.protect_listing() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or new.tenant_id <> old.tenant_id or new.store_id <> old.store_id
     or new.type <> old.type or new.currency <> old.currency
     or new.category_slug <> old.category_slug then
    raise exception 'a listing''s owner, store, type, category and currency never change'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger listing_protect before update or delete on kelo.listing
  for each row execute function kelo.protect_listing();

create table kelo.listing_variant (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  listing_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 80),
  price_minor bigint not null check (price_minor > 0),
  stock_on_hand integer not null check (stock_on_hand >= 0),
  -- Reserved by orders in the same transaction as the order (ADR 0017).
  stock_reserved integer not null default 0,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (listing_id, tenant_id) references kelo.listing (id, tenant_id),
  -- Available stock can never go below zero.
  check (stock_reserved between 0 and stock_on_hand)
);

create index listing_variant_listing on kelo.listing_variant (listing_id);

create table kelo.listing_session (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  listing_id uuid not null,
  starts_at timestamptz not null,
  price_minor bigint not null check (price_minor > 0),
  capacity integer not null check (capacity > 0),
  reserved integer not null default 0,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (listing_id, tenant_id) references kelo.listing (id, tenant_id),
  check (reserved between 0 and capacity)
);

create index listing_session_listing on kelo.listing_session (listing_id, starts_at);

create function kelo.protect_offer() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or new.tenant_id <> old.tenant_id or new.listing_id <> old.listing_id then
    raise exception 'a variant or session belongs to one listing for good'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger listing_variant_protect before update or delete on kelo.listing_variant
  for each row execute function kelo.protect_offer();
create trigger listing_session_protect before update or delete on kelo.listing_session
  for each row execute function kelo.protect_offer();

-- An image the API checked after the browser uploaded it to the store.
create table kelo.listing_image (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  listing_id uuid not null,
  pathname text not null unique check (length(pathname) between 10 and 300),
  url text not null check (url ~ '^https?://'),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 4194304),
  position integer not null default 0,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  foreign key (listing_id, tenant_id) references kelo.listing (id, tenant_id)
);

create index listing_image_listing on kelo.listing_image (listing_id, position);

create trigger listing_image_immutable before update or delete on kelo.listing_image
  for each row execute function business.reject_change();

-- Every moderation decision, with the revision it saw. Append-only.
create table kelo.moderation_decision (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  listing_id uuid not null,
  listing_revision integer not null,
  outcome text not null check (outcome in ('approved', 'rejected', 'suspended')),
  reason text not null check (length(btrim(reason)) between 10 and 500),
  decided_by uuid not null references identity.user_account (id),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  foreign key (listing_id, tenant_id) references kelo.listing (id, tenant_id)
);

create index moderation_decision_listing on kelo.moderation_decision (listing_id, created_at);

create trigger moderation_decision_immutable before update or delete on kelo.moderation_decision
  for each row execute function business.reject_change();
create trigger moderation_decision_no_truncate before truncate on kelo.moderation_decision
  for each statement execute function business.reject_change();

-- Row-level security on every tenant-owned table.
do $$
declare
  t text;
begin
  foreach t in array array['listing', 'listing_variant', 'listing_session', 'listing_image',
                           'moderation_decision'] loop
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

grant update (title, description, status, revision, published_at) on kelo.listing to aora_platform;
grant update (name, price_minor, stock_on_hand, stock_reserved) on kelo.listing_variant
  to aora_platform;
grant update (price_minor, capacity, reserved) on kelo.listing_session to aora_platform;
