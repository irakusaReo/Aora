-- Phase 1, checkpoint 1B: ledger core (ADR 0003) and transactional outbox (ADR 0008).
--
-- The ledger's invariants are enforced here, in the database, so that no
-- application bug can post an unbalanced, mutated or cross-tenant entry:
--   1. per entry and asset, debits equal credits, with at least two postings (checked at commit)
--   2. entries, postings and accounts are never updated, deleted or truncated
--   3. postings can only be added in the transaction that created their entry
--   4. a posting's asset and tenant must agree with its account and its entry
--   5. running balances are maintained only by trigger, and may not go negative
--      on an account that forbids it
--   6. an idempotency key identifies exactly one entry

create schema ledger;
create schema outbox;

grant usage on schema ledger to aora_app, aora_platform;
grant usage on schema outbox to aora_app, aora_platform;

-- ---------------------------------------------------------------------------
-- Assets. The exponent (minor-unit digits) is data, never an assumption.
-- ---------------------------------------------------------------------------

create table ledger.asset (
  code text primary key check (code ~ '^[A-Z0-9]{3,10}$'),
  kind text not null check (kind in ('fiat', 'token')),
  exponent smallint not null check (exponent between 0 and 18)
);

-- Reference data: Kenyan shilling, minor unit per ISO 4217.
insert into ledger.asset (code, kind, exponent) values ('KES', 'fiat', 2);

grant select on ledger.asset to aora_app, aora_platform;

-- ---------------------------------------------------------------------------
-- Accounts. One account holds one asset and has one type from a closed list.
-- tenant_id null means a platform account.
-- ---------------------------------------------------------------------------

create table ledger.account (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenancy.workspace (id),
  asset_code text not null references ledger.asset (code),
  type text not null check (type in ('provider_clearing', 'merchant_collections_pending')),
  qualifier text not null default '',
  normal_side text not null check (normal_side in ('debit', 'credit')),
  allow_negative boolean not null default false,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now()
);

create unique index account_tenant_unique
  on ledger.account (tenant_id, type, qualifier, asset_code) where tenant_id is not null;
create unique index account_platform_unique
  on ledger.account (type, qualifier, asset_code) where tenant_id is null;

create table ledger.journal_entry (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenancy.workspace (id),
  idempotency_key text not null unique check (length(idempotency_key) between 1 and 200),
  entry_type text not null check (length(entry_type) > 0),
  operation_type text not null check (length(operation_type) > 0),
  operation_id text not null check (length(operation_id) > 0),
  reverses_entry_id uuid unique references ledger.journal_entry (id),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  posted_at timestamptz not null default now(),
  -- The transaction that created the entry; postings must come from the same one.
  created_txid bigint not null default txid_current()
);

create index journal_entry_operation on ledger.journal_entry (operation_type, operation_id);

create table ledger.posting (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references ledger.journal_entry (id),
  account_id uuid not null references ledger.account (id),
  tenant_id uuid references tenancy.workspace (id),
  direction text not null check (direction in ('debit', 'credit')),
  amount bigint not null check (amount > 0),
  asset_code text not null references ledger.asset (code),
  mode text not null default 'sandbox' check (mode = 'sandbox')
);

create index posting_entry on ledger.posting (entry_id);
create index posting_account on ledger.posting (account_id);

create table ledger.account_balance (
  account_id uuid primary key references ledger.account (id),
  tenant_id uuid references tenancy.workspace (id),
  -- Expressed on the account's normal side: positive is the usual state.
  balance bigint not null,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Immutability
-- ---------------------------------------------------------------------------

create function ledger.reject_change() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'ledger records are immutable (%.%)', tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end
$$;

create trigger account_immutable before update or delete on ledger.account
  for each row execute function ledger.reject_change();
create trigger account_no_truncate before truncate on ledger.account
  for each statement execute function ledger.reject_change();
create trigger journal_entry_immutable before update or delete on ledger.journal_entry
  for each row execute function ledger.reject_change();
create trigger journal_entry_no_truncate before truncate on ledger.journal_entry
  for each statement execute function ledger.reject_change();
create trigger posting_immutable before update or delete on ledger.posting
  for each row execute function ledger.reject_change();
create trigger posting_no_truncate before truncate on ledger.posting
  for each statement execute function ledger.reject_change();
create trigger account_balance_no_delete before delete on ledger.account_balance
  for each row execute function ledger.reject_change();
create trigger account_balance_no_truncate before truncate on ledger.account_balance
  for each statement execute function ledger.reject_change();

-- ---------------------------------------------------------------------------
-- Posting validation and running balance. SECURITY DEFINER so that the rules
-- see every row regardless of the caller's row-level security, and so that only
-- this function can write account_balance.
-- ---------------------------------------------------------------------------

create function ledger.apply_posting() returns trigger
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  entry ledger.journal_entry%rowtype;
  acct ledger.account%rowtype;
  delta bigint;
  new_balance bigint;
begin
  select * into entry from ledger.journal_entry where id = new.entry_id;
  if entry.created_txid <> txid_current() then
    raise exception 'postings cannot be added to an existing journal entry'
      using errcode = 'restrict_violation';
  end if;
  if new.tenant_id is distinct from entry.tenant_id then
    raise exception 'posting tenant does not match its journal entry'
      using errcode = 'check_violation';
  end if;

  select * into acct from ledger.account where id = new.account_id;
  if acct.asset_code <> new.asset_code then
    raise exception 'posting asset % does not match account asset %', new.asset_code, acct.asset_code
      using errcode = 'check_violation';
  end if;
  if acct.tenant_id is not null and acct.tenant_id is distinct from new.tenant_id then
    raise exception 'posting to an account of another tenant'
      using errcode = 'check_violation';
  end if;

  delta := case when new.direction = acct.normal_side then new.amount else -new.amount end;
  insert into ledger.account_balance as b (account_id, tenant_id, balance)
    values (acct.id, acct.tenant_id, delta)
    on conflict (account_id) do update
      set balance = b.balance + excluded.balance, updated_at = now()
    returning b.balance into new_balance;
  if new_balance < 0 and not acct.allow_negative then
    raise exception 'insufficient balance on account %', acct.id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger posting_apply after insert on ledger.posting
  for each row execute function ledger.apply_posting();

-- Balance check, deferred to commit so an entry's postings can be inserted one by one.
create function ledger.assert_entry_balanced() returns trigger
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  target uuid;
  posting_count integer;
  unbalanced text;
begin
  if tg_table_name = 'posting' then
    target := new.entry_id;
  else
    target := new.id;
  end if;
  select count(*) into posting_count from ledger.posting where entry_id = target;
  if posting_count < 2 then
    raise exception 'journal entry % has fewer than two postings', target
      using errcode = 'check_violation';
  end if;
  select p.asset_code into unbalanced
  from ledger.posting p
  where p.entry_id = target
  group by p.asset_code
  having sum(case when p.direction = 'debit' then p.amount else -p.amount end) <> 0
  limit 1;
  if unbalanced is not null then
    raise exception 'journal entry % does not balance for asset %', target, unbalanced
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

create constraint trigger journal_entry_balanced after insert on ledger.journal_entry
  deferrable initially deferred
  for each row execute function ledger.assert_entry_balanced();
create constraint trigger posting_balanced after insert on ledger.posting
  deferrable initially deferred
  for each row execute function ledger.assert_entry_balanced();

-- ---------------------------------------------------------------------------
-- Access. In Phase 1 only the platform role posts; the tenant role reads its own.
-- ---------------------------------------------------------------------------

alter table ledger.account enable row level security;
alter table ledger.account force row level security;
alter table ledger.journal_entry enable row level security;
alter table ledger.journal_entry force row level security;
alter table ledger.posting enable row level security;
alter table ledger.posting force row level security;
alter table ledger.account_balance enable row level security;
alter table ledger.account_balance force row level security;

create policy tenant_read on ledger.account for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy tenant_read on ledger.journal_entry for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy tenant_read on ledger.posting for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy tenant_read on ledger.account_balance for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());

create policy platform_access on ledger.account to aora_platform using (true) with check (true);
create policy platform_access on ledger.journal_entry to aora_platform using (true) with check (true);
create policy platform_access on ledger.posting to aora_platform using (true) with check (true);
create policy platform_access on ledger.account_balance to aora_platform using (true);

-- The trigger functions run as the owner, which FORCE row-level security also binds.
create policy trigger_access on ledger.account to aora_owner using (true);
create policy trigger_access on ledger.journal_entry to aora_owner using (true);
create policy trigger_access on ledger.posting to aora_owner using (true);
create policy trigger_access on ledger.account_balance to aora_owner using (true) with check (true);

grant select on ledger.account, ledger.journal_entry, ledger.posting, ledger.account_balance
  to aora_app, aora_platform;
grant insert on ledger.account, ledger.journal_entry, ledger.posting to aora_platform;

-- ---------------------------------------------------------------------------
-- Outbox: written in the same transaction as the change it announces.
-- ---------------------------------------------------------------------------

create table outbox.outbox_event (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenancy.workspace (id),
  type text not null check (length(type) > 0),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index outbox_event_due on outbox.outbox_event (available_at, created_at)
  where status = 'pending';
create index outbox_event_processing on outbox.outbox_event (locked_at)
  where status = 'processing';

alter table outbox.outbox_event enable row level security;
alter table outbox.outbox_event force row level security;

-- A tenant-scoped request may announce events for its own tenant, and nothing else.
create policy tenant_enqueue on outbox.outbox_event for insert to aora_app
  with check (tenant_id = tenancy.current_tenant_id());
create policy platform_access on outbox.outbox_event to aora_platform
  using (true) with check (true);

grant insert on outbox.outbox_event to aora_app;
grant select, insert, update on outbox.outbox_event to aora_platform;
