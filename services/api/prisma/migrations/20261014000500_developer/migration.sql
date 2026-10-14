-- Phase 3, checkpoint 3D: developer API (ADR 0023). Expand-only.
--
-- API keys are stored only as SHA-256 hashes (M-2): a key is shown once and
-- cannot be recovered. Outbound webhooks are signed with one platform key held
-- in the secret store, so no per-merchant secret is stored either.

create schema developer;
grant usage on schema developer to aora_app, aora_platform;

create table developer.api_key (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenancy.workspace (id),
  name text not null check (length(btrim(name)) between 1 and 60),
  -- The first characters of the key, shown so a person can tell keys apart.
  prefix text not null check (length(prefix) between 8 and 24),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  scope text not null check (scope in ('collect', 'full')),
  created_by uuid not null references identity.user_account (id),
  revoked_at timestamptz,
  revoked_by uuid references identity.user_account (id),
  last_used_at timestamptz,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now()
);

create function developer.protect_api_key() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or new.key_hash <> old.key_hash or new.tenant_id <> old.tenant_id
     or new.scope <> old.scope or new.created_by <> old.created_by
     or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) then
    raise exception 'an API key never changes, and a revoked key stays revoked'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

create trigger api_key_protect before update or delete on developer.api_key
  for each row execute function developer.protect_api_key();

create table developer.webhook_endpoint (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenancy.workspace (id),
  url text not null check (length(url) between 10 and 500),
  event_types text[] not null check (cardinality(event_types) > 0),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_by uuid not null references identity.user_account (id),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now()
);

-- An event is written once; its body is stored as sent, so a replay is byte for byte the same.
create table developer.webhook_event (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenancy.workspace (id),
  type text not null check (type ~ '^[a-z_]+\.[a-z_]+$'),
  -- What happened, once: the same subject never emits the same event type twice.
  dedupe_key text not null unique,
  body text not null,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now()
);

create table developer.webhook_delivery (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references developer.webhook_event (id),
  endpoint_id uuid not null references developer.webhook_endpoint (id),
  tenant_id uuid not null references tenancy.workspace (id),
  status text not null default 'pending' check (status in ('pending', 'delivered', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  last_response_status integer,
  replay_of uuid references developer.webhook_delivery (id),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);

create index webhook_delivery_tenant on developer.webhook_delivery (tenant_id, created_at desc);

create trigger webhook_event_immutable before update or delete on developer.webhook_event
  for each row execute function payments.reject_change();

alter table developer.api_key enable row level security;
alter table developer.api_key force row level security;
alter table developer.webhook_endpoint enable row level security;
alter table developer.webhook_endpoint force row level security;
alter table developer.webhook_event enable row level security;
alter table developer.webhook_event force row level security;
alter table developer.webhook_delivery enable row level security;
alter table developer.webhook_delivery force row level security;

create policy tenant_read on developer.api_key for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy tenant_read on developer.webhook_endpoint for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy tenant_read on developer.webhook_delivery for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy platform_access on developer.api_key to aora_platform using (true) with check (true);
create policy platform_access on developer.webhook_endpoint to aora_platform using (true) with check (true);
create policy platform_access on developer.webhook_event to aora_platform using (true) with check (true);
create policy platform_access on developer.webhook_delivery to aora_platform using (true) with check (true);

grant select on developer.api_key, developer.webhook_endpoint, developer.webhook_delivery to aora_app;
grant select, insert on developer.api_key, developer.webhook_endpoint, developer.webhook_event,
  developer.webhook_delivery to aora_platform;
grant update (revoked_at, revoked_by, last_used_at) on developer.api_key to aora_platform;
grant update (status) on developer.webhook_endpoint to aora_platform;
grant update (status, attempts, last_response_status, delivered_at) on developer.webhook_delivery to aora_platform;
