-- Phase 4, checkpoint 4B: quotes for quote-based services, and the consumer
-- row-level barrier (phase-4 P4-6). Expand-only: a function and new tables.

-- The signed-in consumer, set with transaction scope by Database.withConsumer.
create function identity.current_account_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.account_id', true), '')::uuid $$;

grant execute on function identity.current_account_id() to aora_app, aora_platform;

-- A buyer's request for a quote. Owned by the buyer and visible to the
-- merchant whose listing it is: two separate select policies.
create table kelo.quote_request (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  listing_id uuid not null,
  consumer_account_id uuid not null references identity.user_account (id),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request_hash text not null,
  details text not null check (length(btrim(details)) between 10 and 1000),
  status text not null default 'open'
    check (status in ('open', 'quoted', 'accepted', 'withdrawn')),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (listing_id, tenant_id) references kelo.listing (id, tenant_id),
  unique (consumer_account_id, idempotency_key),
  unique (id, tenant_id)
);

create index quote_request_tenant on kelo.quote_request (tenant_id, created_at desc);
create index quote_request_consumer on kelo.quote_request (consumer_account_id, created_at desc);

-- A merchant's priced answer. "Expired" is computed from expires_at at read
-- time, so nothing has to run for a quote to expire.
create table kelo.quote (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  request_id uuid not null,
  consumer_account_id uuid not null references identity.user_account (id),
  price_minor bigint not null check (price_minor > 0),
  currency text not null references ledger.asset (code),
  expires_at timestamptz not null,
  status text not null default 'offered' check (status in ('offered', 'accepted', 'declined')),
  created_by uuid not null references identity.user_account (id),
  decided_at timestamptz,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  foreign key (request_id, tenant_id) references kelo.quote_request (id, tenant_id),
  check (expires_at > created_at),
  check ((status = 'offered') = (decided_at is null))
);

create index quote_request_quotes on kelo.quote (request_id, created_at);

create function kelo.protect_quote() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or old.status <> 'offered'
     or (to_jsonb(new) - array['status', 'decided_at']) <> (to_jsonb(old) - array['status', 'decided_at']) then
    raise exception 'a quote never changes, except to be accepted or declined once'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

create trigger quote_protect before update or delete on kelo.quote
  for each row execute function kelo.protect_quote();

create function kelo.protect_quote_request() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE'
     or (to_jsonb(new) - array['status', 'updated_at']) <> (to_jsonb(old) - array['status', 'updated_at']) then
    raise exception 'a quote request never changes except its status'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger quote_request_protect before update or delete on kelo.quote_request
  for each row execute function kelo.protect_quote_request();

do $$
declare
  t text;
begin
  foreach t in array array['quote_request', 'quote'] loop
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
end
$$;

grant update (status) on kelo.quote_request to aora_platform;
grant update (status, decided_at) on kelo.quote to aora_platform;
