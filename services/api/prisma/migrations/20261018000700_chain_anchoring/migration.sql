-- Phase 5, checkpoint 5C: anchoring tables. Expand-only.

-- ---------------------------------------------------------------------------
-- Anchoring (ADR 0015, phase-5 plan P5-10). One period per UTC day: a salted
-- Merkle root of that day's journal entries. The salt never leaves the
-- database; only the root, a period hash and a count go on chain.
-- ---------------------------------------------------------------------------

create table chain.anchor_period (
  label text primary key check (label ~ '^ledger-day:[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  network text not null default 'base-sepolia' check (network = 'base-sepolia'),
  period_hash text not null unique check (period_hash ~ '^0x[0-9a-f]{64}$'),
  salt bytea not null check (length(salt) = 32),
  root text not null check (root ~ '^0x[0-9a-f]{64}$'),
  entry_count integer not null check (entry_count > 0),
  status text not null default 'closed' check (status in ('closed', 'committed')),
  operation_id uuid unique references chain.operation (id),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A closed period's salt, root and count never change.
create function chain.protect_anchor_period() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or new.label <> old.label or new.period_hash <> old.period_hash
     or new.salt <> old.salt or new.root <> old.root or new.entry_count <> old.entry_count then
    raise exception 'an anchored period''s contents are immutable' using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger anchor_period_protect before update or delete on chain.anchor_period
  for each row execute function chain.protect_anchor_period();

create table chain.anchor_leaf (
  label text not null references chain.anchor_period (label),
  entry_id uuid not null references ledger.journal_entry (id),
  leaf text not null check (leaf ~ '^0x[0-9a-f]{64}$'),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  primary key (label, entry_id)
);
create trigger anchor_leaf_immutable before update or delete on chain.anchor_leaf
  for each row execute function chain.reject_change();

-- Operators and the anchoring job only: salts are never readable by tenants.
grant select, insert on chain.anchor_period, chain.anchor_leaf to aora_platform;
grant update (status, operation_id) on chain.anchor_period to aora_platform;
