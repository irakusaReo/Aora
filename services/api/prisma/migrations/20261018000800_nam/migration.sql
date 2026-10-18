-- Phase 6, checkpoint 6A: NAM Vault (phase-6 plan). Expand-only: a new schema,
-- new tables, new account types, one terms document, wider check lists.
-- Testnet only; no yield is offered, stated or implied (brief §6.1).

create schema nam;
grant usage on schema nam to aora_app, aora_platform;

create function nam.reject_change() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'NAM history is append-only' using errcode = 'restrict_violation';
end
$$;

-- ---------------------------------------------------------------------------
-- The product's facts, as data (P6-1).
-- ---------------------------------------------------------------------------

create table nam.product (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z_]{3,40}$'),
  name text not null,
  kind text not null check (kind in (
    'usdc_holding', 'smart_contract_vault', 'regulated_investment', 'managed_fund', 'third_party_product')),
  asset_code text not null references ledger.asset (code),
  fee_bps integer not null check (fee_bps between 0 and 10000),
  returns_claimed boolean not null default false check (returns_claimed = false),
  asset_control text not null,
  customer_owns text not null,
  withdrawal_terms text not null,
  terms_key text not null,
  mode text not null default 'sandbox' check (mode = 'sandbox')
);

insert into nam.product
  (code, name, kind, asset_code, fee_bps, asset_control, customer_owns, withdrawal_terms, terms_key)
values (
  'nam_usdc_vault', 'NAM USDC Vault (sandbox)', 'smart_contract_vault', 'USDC', 0,
  'Vault shares are held by the AORA sandbox testnet wallet on Base Sepolia.',
  'A record in AORA''s ledger of the shares held for your workspace. Testnet USDC has no value.',
  'Redeem at any time. Deposits can be paused by the vault guardian; redemptions cannot be paused.',
  'nam_vault_disclosure');

-- SANDBOX disclosure, version 1 (P6-8). No yield, rate or return is offered.
insert into consent.terms_document (key, version, language, title, body, body_sha256, effective_from)
select 'nam_vault_disclosure', '1', 'en', 'NAM USDC Vault (sandbox): what it is and is not', body,
       encode(sha256(convert_to(body, 'UTF8')), 'hex'), '2026-01-01T00:00:00Z'
from (values (
  'SANDBOX ONLY. This is a demonstration on Base Sepolia, a test network. Testnet USDC has no value.' || E'\n' ||
  'What it is: your workspace''s testnet USDC is deposited into AORA''s NamUsdcVault contract. The vault holds only USDC and does not lend, stake or invest it.' || E'\n' ||
  'Who controls it: the AORA sandbox testnet wallet holds the vault shares. Your workspace holds a record of them in AORA''s ledger.' || E'\n' ||
  'Returns: none. This product does not pay or promise any return. The value of your shares can be slightly lower than what you deposited because of rounding.' || E'\n' ||
  'Fees: none.' || E'\n' ||
  'Withdrawals: you can redeem at any time; a redemption completes only after it is confirmed on chain. New deposits can be paused; redemptions cannot.' || E'\n' ||
  'Risks: the contract has had no independent review and is a testnet demonstration only.'
)) as t(body);

-- ---------------------------------------------------------------------------
-- Investor profiles (P6-2): business now, personal from Phase 7.
-- ---------------------------------------------------------------------------

create table nam.investor_profile (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('business', 'personal')),
  tenant_id uuid unique references tenancy.workspace (id),
  person_id uuid unique references identity.person (id),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  check ((kind = 'business') = (tenant_id is not null and person_id is null)),
  check ((kind = 'personal') = (person_id is not null and tenant_id is null))
);

-- ---------------------------------------------------------------------------
-- Orders, redemptions and holdings (P6-4).
-- ---------------------------------------------------------------------------

create table nam.vault_order (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references nam.investor_profile (id),
  tenant_id uuid references tenancy.workspace (id),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request_hash text not null,
  amount bigint not null check (amount > 0),
  asset_code text not null default 'USDC' references ledger.asset (code),
  status text not null default 'funding_reserved' check (status in (
    'funding_reserved', 'depositing', 'holding_confirmed', 'failed', 'reconciliation_required')),
  consent_id uuid not null references consent.consent_record (id),
  operation_id uuid unique references chain.operation (id),
  shares numeric(78, 0) check (shares > 0),
  failure_reason text,
  created_by uuid not null references identity.user_account (id),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, idempotency_key),
  check ((status = 'holding_confirmed') = (shares is not null))
);

create table nam.redemption (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references nam.investor_profile (id),
  tenant_id uuid references tenancy.workspace (id),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request_hash text not null,
  shares numeric(78, 0) not null check (shares > 0),
  status text not null default 'requested' check (status in (
    'requested', 'redeeming', 'completed', 'failed', 'reconciliation_required')),
  operation_id uuid unique references chain.operation (id),
  assets bigint check (assets >= 0),
  failure_reason text,
  created_by uuid not null references identity.user_account (id),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, idempotency_key),
  check ((status = 'completed') = (assets is not null))
);

create table nam.holding (
  profile_id uuid primary key references nam.investor_profile (id),
  tenant_id uuid references tenancy.workspace (id),
  shares numeric(78, 0) not null default 0 check (shares >= 0),
  cost_basis bigint not null default 0 check (cost_basis >= 0),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  updated_at timestamptz not null default now(),
  check ((shares = 0) = (cost_basis = 0) or shares > 0)
);

-- Every change to a holding, from a confirmed contract event only.
create table nam.holding_change (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references nam.investor_profile (id),
  tenant_id uuid references tenancy.workspace (id),
  source_type text not null check (source_type in ('order', 'redemption')),
  source_id uuid not null,
  tx_hash text not null check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer not null check (log_index >= 0),
  shares_delta numeric(78, 0) not null,
  cost_delta bigint not null,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  unique (tx_hash, log_index),
  unique (source_type, source_id)
);
create trigger holding_change_immutable before update or delete on nam.holding_change
  for each row execute function nam.reject_change();

create function nam.protect_request() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or new.profile_id <> old.profile_id
     or new.tenant_id is distinct from old.tenant_id
     or new.idempotency_key <> old.idempotency_key or new.request_hash <> old.request_hash
     or new.created_by <> old.created_by
     or (to_jsonb(new) ? 'amount' and to_jsonb(new) -> 'amount' <> to_jsonb(old) -> 'amount')
     or (tg_table_name = 'redemption' and to_jsonb(new) -> 'shares' <> to_jsonb(old) -> 'shares') then
    raise exception 'a NAM order''s or redemption''s request is immutable'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger vault_order_protect before update or delete on nam.vault_order
  for each row execute function nam.protect_request();
create trigger redemption_protect before update or delete on nam.redemption
  for each row execute function nam.protect_request();

-- ---------------------------------------------------------------------------
-- Ledger accounts (P6-5) and the chain operation for the one-time approval.
-- ---------------------------------------------------------------------------

alter table ledger.account drop constraint account_type_check;
alter table ledger.account add constraint account_type_check check (type in (
  'provider_clearing', 'merchant_collections_pending', 'fee_revenue',
  'merchant_available', 'merchant_payouts_in_flight', 'provider_payout_float',
  'kelo_layaway_funds_held', 'kelo_fee_revenue', 'kelo_refunds_payable',
  'chain_wallet_usdc', 'platform_usdc_funding',
  'merchant_usdc_available', 'merchant_usdc_withdrawals_in_flight',
  'nam_vault_usdc', 'nam_vault_rounding',
  'merchant_nam_funding_pending', 'merchant_nam_holding'));

insert into ledger.account (tenant_id, asset_code, type, qualifier, normal_side, allow_negative)
values (null, 'USDC', 'nam_vault_usdc', '', 'debit', false),
       -- Rounding between holders' cost and what the vault returns (P6-5). A
       -- holder can get back dust others left behind, so this may go below zero.
       (null, 'USDC', 'nam_vault_rounding', '', 'credit', true);

insert into ledger.account (tenant_id, asset_code, type, qualifier, normal_side, allow_negative)
select w.id, 'USDC', t.type, '', 'credit', false
from tenancy.workspace w
cross join (values ('merchant_nam_funding_pending'), ('merchant_nam_holding')) as t(type)
on conflict do nothing;

-- USDC the vault returns to AORA's wallet on a redemption is internal: never a deposit.
alter table chain.observed_transfer drop constraint observed_transfer_status_check;
alter table chain.observed_transfer add constraint observed_transfer_status_check check (status in (
  'observed', 'confirmed', 'credited', 'unattributed', 'unexpected_asset', 'dropped', 'internal'));

alter table chain.operation drop constraint operation_kind_check;
alter table chain.operation add constraint operation_kind_check check (kind in (
  'usdc_transfer', 'usdc_approve', 'contract_deploy', 'anchor_commit', 'vault_deposit', 'vault_redeem'));

alter table payments.reconciliation_exception drop constraint reconciliation_exception_type_check;
alter table payments.reconciliation_exception add constraint reconciliation_exception_type_check
  check (type in (
    'missing_internal', 'missing_at_provider', 'amount_mismatch', 'duplicate_reference',
    'state_mismatch', 'stuck_status_unknown', 'ledger_mismatch', 'provider_result_conflict',
    'unexpected_asset', 'chain_operation_unresolved', 'unattributed_deposit',
    'chain_balance_mismatch', 'chain_operation_mismatch', 'anchor_mismatch', 'nam_mismatch'));

-- ---------------------------------------------------------------------------
-- Access: members read their workspace's rows; the platform role writes.
-- ---------------------------------------------------------------------------

alter table nam.investor_profile enable row level security;
alter table nam.investor_profile force row level security;
alter table nam.vault_order enable row level security;
alter table nam.vault_order force row level security;
alter table nam.redemption enable row level security;
alter table nam.redemption force row level security;
alter table nam.holding enable row level security;
alter table nam.holding force row level security;
alter table nam.holding_change enable row level security;
alter table nam.holding_change force row level security;

create policy tenant_read on nam.investor_profile for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy tenant_read on nam.vault_order for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy tenant_read on nam.redemption for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy tenant_read on nam.holding for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy tenant_read on nam.holding_change for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy platform_access on nam.investor_profile to aora_platform using (true) with check (true);
create policy platform_access on nam.vault_order to aora_platform using (true) with check (true);
create policy platform_access on nam.redemption to aora_platform using (true) with check (true);
create policy platform_access on nam.holding to aora_platform using (true) with check (true);
create policy platform_access on nam.holding_change to aora_platform using (true) with check (true);

grant select on nam.product to aora_app, aora_platform;
grant select on nam.investor_profile, nam.vault_order, nam.redemption, nam.holding, nam.holding_change
  to aora_app;
grant select, insert on nam.investor_profile, nam.vault_order, nam.redemption, nam.holding,
  nam.holding_change to aora_platform;
grant update (status, operation_id, shares, failure_reason) on nam.vault_order to aora_platform;
grant update (status, operation_id, assets, failure_reason) on nam.redemption to aora_platform;
grant update (shares, cost_basis, updated_at) on nam.holding to aora_platform;
