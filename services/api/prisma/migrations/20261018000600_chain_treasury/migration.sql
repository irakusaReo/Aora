-- Phase 5, checkpoint 5C: KONY USDC treasury on Base Sepolia (phase-5 plan
-- P5-4, P5-5, P5-9). Expand-only: new account types and accounts, new tables,
-- wider check lists. USDC never shares an account with KES (CLAUDE.md rule 5).

-- ---------------------------------------------------------------------------
-- Ledger accounts.
--   chain_wallet_usdc            platform asset: USDC held in AORA's sandbox wallet
--   platform_usdc_funding        platform: AORA's own sandbox funding of that wallet
--   merchant_usdc_available      tenant liability: USDC the workspace may withdraw
--   merchant_usdc_withdrawals_in_flight  tenant liability: reserved for withdrawals
-- ---------------------------------------------------------------------------

alter table ledger.account drop constraint account_type_check;
alter table ledger.account add constraint account_type_check check (type in (
  'provider_clearing', 'merchant_collections_pending', 'fee_revenue',
  'merchant_available', 'merchant_payouts_in_flight', 'provider_payout_float',
  'kelo_layaway_funds_held', 'kelo_fee_revenue', 'kelo_refunds_payable',
  'chain_wallet_usdc', 'platform_usdc_funding',
  'merchant_usdc_available', 'merchant_usdc_withdrawals_in_flight'));

insert into ledger.account (tenant_id, asset_code, type, qualifier, normal_side, allow_negative)
values (null, 'USDC', 'chain_wallet_usdc', '', 'debit', false),
       (null, 'USDC', 'platform_usdc_funding', '', 'credit', false);

insert into ledger.account (tenant_id, asset_code, type, qualifier, normal_side, allow_negative)
select w.id, 'USDC', t.type, '', 'credit', false
from tenancy.workspace w
cross join (values ('merchant_usdc_available'), ('merchant_usdc_withdrawals_in_flight')) as t(type)
on conflict do nothing;

-- SANDBOX withdrawal limits in USDC base units (6 decimals): data, not code.
insert into tenancy.tier_limit
  (tier, asset_code, version, effective_from, per_transaction_max, daily_collection_max, daily_payout_max)
values
  ('tier_0', 'USDC', 1, '2026-01-01T00:00:00Z', 1000000000, 5000000000, 2000000000),
  ('tier_1', 'USDC', 1, '2026-01-01T00:00:00Z', 10000000000, 50000000000, 20000000000);

-- ---------------------------------------------------------------------------
-- Deposit addresses, proved by a signature over a one-time challenge.
-- ---------------------------------------------------------------------------

create table chain.address_challenge (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenancy.workspace (id),
  nonce text not null check (nonce ~ '^[0-9a-f]{32}$'),
  message text not null,
  created_by uuid not null references identity.user_account (id),
  expires_at timestamptz not null,
  used_at timestamptz,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now()
);

create table chain.registered_address (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenancy.workspace (id),
  network text not null default 'base-sepolia' check (network = 'base-sepolia'),
  address text not null check (address ~ '^0x[0-9a-f]{40}$'),
  label text check (length(label) <= 60),
  challenge_id uuid not null unique references chain.address_challenge (id),
  status text not null default 'active' check (status in ('active', 'revoked')),
  registered_by uuid not null references identity.user_account (id),
  registered_at timestamptz not null default now(),
  revoked_by uuid references identity.user_account (id),
  revoked_at timestamptz,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  check ((status = 'revoked') = (revoked_at is not null and revoked_by is not null))
);

-- One active registration per address across every workspace.
create unique index registered_address_active on chain.registered_address (address)
  where status = 'active';

-- ---------------------------------------------------------------------------
-- Withdrawals: requested by one member, approved by a different admin.
-- ---------------------------------------------------------------------------

create table chain.withdrawal (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenancy.workspace (id),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request_hash text not null,
  amount bigint not null check (amount > 0),
  asset_code text not null default 'USDC' references ledger.asset (code),
  destination text not null check (destination ~ '^0x[0-9a-f]{40}$'),
  status text not null default 'requested' check (status in (
    'requested', 'rejected', 'submitted', 'completed', 'failed', 'reconciliation_required')),
  created_by uuid not null references identity.user_account (id),
  decided_by uuid references identity.user_account (id),
  decided_at timestamptz,
  decision_reason text,
  operation_id uuid unique references chain.operation (id),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  -- The person who asked can never be the person who approves (rule 12, J9).
  check (decided_by is null or decided_by <> created_by)
);

create function chain.protect_withdrawal() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or new.tenant_id <> old.tenant_id or new.amount <> old.amount
     or new.destination <> old.destination or new.idempotency_key <> old.idempotency_key
     or new.request_hash <> old.request_hash or new.created_by <> old.created_by then
    raise exception 'a withdrawal''s amount, destination and requester are immutable'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger withdrawal_protect before update or delete on chain.withdrawal
  for each row execute function chain.protect_withdrawal();

-- ---------------------------------------------------------------------------
-- Exception types for the treasury and three-way reconciliation.
-- ---------------------------------------------------------------------------

alter table payments.reconciliation_exception drop constraint reconciliation_exception_type_check;
alter table payments.reconciliation_exception add constraint reconciliation_exception_type_check
  check (type in (
    'missing_internal', 'missing_at_provider', 'amount_mismatch', 'duplicate_reference',
    'state_mismatch', 'stuck_status_unknown', 'ledger_mismatch', 'provider_result_conflict',
    'unexpected_asset', 'chain_operation_unresolved', 'unattributed_deposit',
    'chain_balance_mismatch', 'chain_operation_mismatch', 'anchor_mismatch'));

-- ---------------------------------------------------------------------------
-- Access. Members read their own workspace's rows; the platform role writes.
-- ---------------------------------------------------------------------------

alter table chain.address_challenge enable row level security;
alter table chain.address_challenge force row level security;
alter table chain.registered_address enable row level security;
alter table chain.registered_address force row level security;
alter table chain.withdrawal enable row level security;
alter table chain.withdrawal force row level security;

create policy tenant_read on chain.address_challenge for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy tenant_read on chain.registered_address for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy tenant_read on chain.withdrawal for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy platform_access on chain.address_challenge to aora_platform using (true) with check (true);
create policy platform_access on chain.registered_address to aora_platform using (true) with check (true);
create policy platform_access on chain.withdrawal to aora_platform using (true) with check (true);

grant select on chain.address_challenge, chain.registered_address, chain.withdrawal to aora_app;
grant select, insert on chain.address_challenge, chain.registered_address, chain.withdrawal
  to aora_platform;
grant update (used_at) on chain.address_challenge to aora_platform;
grant update (status, revoked_by, revoked_at) on chain.registered_address to aora_platform;
grant update (status, decided_by, decided_at, decision_reason, operation_id)
  on chain.withdrawal to aora_platform;
