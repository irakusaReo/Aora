-- Phase 5, checkpoint 5A: chain records for Base Sepolia (ADRs 0004, 0005,
-- 0009 interim ruling; phase-5 plan). Expand-only: one asset row, a new
-- schema and new tables. Base Sepolia is the only network a row may name.

-- ---------------------------------------------------------------------------
-- Native USDC as a ledger asset. The exponent must equal the decimals in the
-- chain module's verified config and the contract's decimals(); the API refuses
-- to use the chain if any of the three differ (ADR 0005 point 4).
-- ---------------------------------------------------------------------------

insert into ledger.asset (code, kind, exponent) values ('USDC', 'token', 6);

create schema chain;
grant usage on schema chain to aora_app, aora_platform;

create function chain.reject_change() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'chain history is append-only' using errcode = 'restrict_violation';
end
$$;

-- ---------------------------------------------------------------------------
-- Confirmation policy, versioned data (P5-6). Seed values follow Base's
-- "Transaction Finality" page (docs.base.org, read 2026-10-18) and the block
-- time measured on Base Sepolia (2 s): 60 blocks is about two minutes, the
-- "L1 batch inclusion" stage; 600 blocks is about twenty minutes, the "L1 batch
-- finality" stage, required above the high-value threshold. SANDBOX values.
-- ---------------------------------------------------------------------------

create table chain.confirmation_policy (
  id uuid primary key default gen_random_uuid(),
  asset_code text not null references ledger.asset (code),
  version integer not null check (version > 0),
  effective_from timestamptz not null,
  effective_to timestamptz,
  min_confirmations integer not null check (min_confirmations >= 1),
  high_value_threshold numeric(78, 0) not null check (high_value_threshold > 0),
  high_value_confirmations integer not null,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  unique (asset_code, version),
  check (high_value_confirmations >= min_confirmations),
  check (effective_to is null or effective_to > effective_from)
);

insert into chain.confirmation_policy
  (asset_code, version, effective_from, min_confirmations, high_value_threshold, high_value_confirmations)
values ('USDC', 1, '2026-01-01T00:00:00Z', 60, 1000000000, 600);

-- ---------------------------------------------------------------------------
-- Where each scanner has read up to. A repeated or missed run is harmless:
-- observations are unique per log.
-- ---------------------------------------------------------------------------

create table chain.scan_cursor (
  name text primary key check (name ~ '^[a-z_]{3,40}$'),
  network text not null default 'base-sepolia' check (network = 'base-sepolia'),
  last_block bigint not null check (last_block >= 0),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Inbound token transfers to AORA's sandbox wallet, as observed on chain. An
-- observation is evidence, not money: only a confirmed, attributed USDC
-- transfer is ever credited (5C), by exactly one journal entry.
-- ---------------------------------------------------------------------------

create table chain.observed_transfer (
  id uuid primary key default gen_random_uuid(),
  network text not null default 'base-sepolia' check (network = 'base-sepolia'),
  tx_hash text not null check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer not null check (log_index >= 0),
  block_number bigint not null check (block_number >= 0),
  block_hash text not null check (block_hash ~ '^0x[0-9a-f]{64}$'),
  token_address text not null check (token_address ~ '^0x[0-9a-f]{40}$'),
  from_address text not null check (from_address ~ '^0x[0-9a-f]{40}$'),
  to_address text not null check (to_address ~ '^0x[0-9a-f]{40}$'),
  amount numeric(78, 0) not null check (amount >= 0),
  -- Null for any token other than the configured native USDC.
  asset_code text references ledger.asset (code),
  status text not null default 'observed' check (status in (
    'observed', 'confirmed', 'credited', 'unattributed', 'unexpected_asset', 'dropped')),
  confirmations integer not null default 0 check (confirmations >= 0),
  tenant_id uuid references tenancy.workspace (id),
  journal_entry_id uuid references ledger.journal_entry (id),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  observed_at timestamptz not null default now(),
  confirmed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (tx_hash, log_index),
  check ((asset_code is null) = (status = 'unexpected_asset'))
);

create index observed_transfer_pending on chain.observed_transfer (status) where status = 'observed';

-- What was observed never changes; only its status moves forward.
create function chain.protect_observed_transfer() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or new.tx_hash <> old.tx_hash or new.log_index <> old.log_index
     or new.token_address <> old.token_address or new.from_address <> old.from_address
     or new.to_address <> old.to_address or new.amount <> old.amount
     or new.asset_code is distinct from old.asset_code then
    raise exception 'an observed transfer''s facts are immutable' using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger observed_transfer_protect before update or delete on chain.observed_transfer
  for each row execute function chain.protect_observed_transfer();

-- ---------------------------------------------------------------------------
-- Transactions AORA sends (brief §3.4, §3.5). The signed transaction, its hash
-- and nonce are committed before it is broadcast, so a crash can always be
-- recovered by query; nothing in status_unknown is ever sent again.
-- ---------------------------------------------------------------------------

create table chain.operation (
  id uuid primary key default gen_random_uuid(),
  network text not null default 'base-sepolia' check (network = 'base-sepolia'),
  tenant_id uuid references tenancy.workspace (id),
  kind text not null check (kind in (
    'usdc_transfer', 'contract_deploy', 'anchor_commit', 'vault_deposit', 'vault_redeem')),
  idempotency_key text not null unique check (length(idempotency_key) between 1 and 200),
  status text not null default 'prepared' check (status in (
    'prepared', 'authorization_pending', 'submitted', 'pending_confirmation', 'confirmed',
    'failed', 'reverted', 'status_unknown', 'reconciliation_required')),
  from_address text not null check (from_address ~ '^0x[0-9a-f]{40}$'),
  -- The transaction's `to`: the token or contract called. Null for a deployment.
  to_address text check (to_address ~ '^0x[0-9a-f]{40}$'),
  -- For a token transfer: who receives it, and how much (exact base units).
  recipient_address text check (recipient_address ~ '^0x[0-9a-f]{40}$'),
  asset_code text references ledger.asset (code),
  amount numeric(78, 0) check (amount > 0),
  call_data text not null check (call_data ~ '^0x([0-9a-f]{2})*$'),
  nonce bigint check (nonce >= 0),
  tx_hash text unique check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  raw_transaction text check (raw_transaction ~ '^0x([0-9a-f]{2})+$'),
  submitted_at timestamptz,
  block_number bigint,
  block_hash text check (block_hash ~ '^0x[0-9a-f]{64}$'),
  confirmations integer not null default 0 check (confirmations >= 0),
  -- Network fees, recorded but not ledgered in the sandbox (P5-7).
  gas_used numeric(78, 0),
  effective_gas_price numeric(78, 0),
  contract_address text check (contract_address ~ '^0x[0-9a-f]{40}$'),
  failure_reason text,
  related_entry_ids uuid[] not null default '{}',
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((tx_hash is null) = (raw_transaction is null)),
  check ((tx_hash is null) = (nonce is null)),
  check (status in ('prepared', 'authorization_pending', 'failed') or tx_hash is not null)
);

create index operation_open on chain.operation (status)
  where status in ('submitted', 'pending_confirmation', 'status_unknown');
create unique index operation_sender_nonce on chain.operation (from_address, nonce)
  where nonce is not null;

-- What an operation does never changes once prepared; the signed transaction is
-- written once.
create function chain.protect_operation() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or new.kind <> old.kind or new.idempotency_key <> old.idempotency_key
     or new.from_address <> old.from_address or new.to_address is distinct from old.to_address
     or new.recipient_address is distinct from old.recipient_address
     or new.asset_code is distinct from old.asset_code or new.amount is distinct from old.amount
     or new.call_data <> old.call_data or new.tenant_id is distinct from old.tenant_id
     or (old.tx_hash is not null and (new.tx_hash is distinct from old.tx_hash
         or new.raw_transaction is distinct from old.raw_transaction
         or new.nonce is distinct from old.nonce)) then
    raise exception 'a chain operation''s contents and signed transaction are immutable'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger operation_protect before update or delete on chain.operation
  for each row execute function chain.protect_operation();

create table chain.transition (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references chain.operation (id),
  tenant_id uuid references tenancy.workspace (id),
  from_status text,
  to_status text not null,
  source text not null check (source in ('api', 'submitter', 'monitor', 'operator')),
  reason text,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now()
);
create index chain_transition_operation
  on chain.transition (operation_id, created_at);
create trigger transition_immutable before update or delete on chain.transition
  for each row execute function chain.reject_change();

-- ---------------------------------------------------------------------------
-- Nonces are allocated here, under a row lock, so two submitters never sign
-- two transactions with the same nonce.
-- ---------------------------------------------------------------------------

create table chain.signer_nonce (
  address text primary key check (address ~ '^0x[0-9a-f]{40}$'),
  network text not null default 'base-sepolia' check (network = 'base-sepolia'),
  next_nonce bigint not null check (next_nonce >= 0),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- New exception types for operators: a token other than native USDC arrived at
-- AORA's wallet (ADR 0005 point 6), and a chain operation that only a person can
-- resolve (reconciliation_required). Widening the list is expand-only.
-- ---------------------------------------------------------------------------

alter table payments.reconciliation_exception drop constraint reconciliation_exception_type_check;
alter table payments.reconciliation_exception add constraint reconciliation_exception_type_check
  check (type in (
    'missing_internal', 'missing_at_provider', 'amount_mismatch', 'duplicate_reference',
    'state_mismatch', 'stuck_status_unknown', 'ledger_mismatch', 'provider_result_conflict',
    'unexpected_asset', 'chain_operation_unresolved'));

-- ---------------------------------------------------------------------------
-- Access: the platform role runs the chain module. Tenants read only their own
-- rows (from 5C); the second barrier is row-level security.
-- ---------------------------------------------------------------------------

alter table chain.observed_transfer enable row level security;
alter table chain.observed_transfer force row level security;
alter table chain.operation enable row level security;
alter table chain.operation force row level security;
alter table chain.transition enable row level security;
alter table chain.transition force row level security;

create policy tenant_read on chain.observed_transfer for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy tenant_read on chain.operation for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy tenant_read on chain.transition for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy platform_access on chain.observed_transfer to aora_platform using (true) with check (true);
create policy platform_access on chain.operation to aora_platform using (true) with check (true);
create policy platform_access on chain.transition to aora_platform using (true) with check (true);

grant select on chain.observed_transfer, chain.operation, chain.transition to aora_app;
grant select on chain.confirmation_policy to aora_app, aora_platform;
grant select, insert on chain.observed_transfer, chain.operation, chain.transition
  to aora_platform;
grant update (status, confirmations, block_number, block_hash, confirmed_at, tenant_id, journal_entry_id)
  on chain.observed_transfer to aora_platform;
grant update (status, nonce, tx_hash, raw_transaction, submitted_at, block_number, block_hash,
              confirmations, gas_used, effective_gas_price, contract_address, failure_reason,
              related_entry_ids)
  on chain.operation to aora_platform;
grant select, insert, update on chain.scan_cursor, chain.signer_nonce to aora_platform;
