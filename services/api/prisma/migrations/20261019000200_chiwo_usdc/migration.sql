-- Phase 7, checkpoint 7B: personal USDC on Base Sepolia, transfers between
-- CHIWO consumers and payment requests (phase-7 plan P7-2, P7-8 to P7-13).
-- Expand-only: new columns (nullable or defaulted), relaxed NOT NULLs, new
-- tables, wider check lists, new policies.

-- ---------------------------------------------------------------------------
-- Ledger: a consumer's own accounts (P7-2). A consumer account has no tenant;
-- its owner is in consumer_account_id and repeated in qualifier, so the
-- existing platform uniqueness (type, qualifier, asset) keeps one per consumer.
--   consumer_usdc_available              consumer liability: USDC they may send or withdraw
--   consumer_usdc_withdrawals_in_flight  consumer liability: reserved for withdrawals
-- ---------------------------------------------------------------------------

alter table ledger.account
  add column consumer_account_id uuid references identity.user_account (id),
  add constraint account_one_owner check (tenant_id is null or consumer_account_id is null),
  add constraint account_consumer_qualifier
    check (consumer_account_id is null or qualifier = consumer_account_id::text);

alter table ledger.account drop constraint account_type_check;
alter table ledger.account add constraint account_type_check check (type in (
  'provider_clearing', 'merchant_collections_pending', 'fee_revenue',
  'merchant_available', 'merchant_payouts_in_flight', 'provider_payout_float',
  'kelo_layaway_funds_held', 'kelo_fee_revenue', 'kelo_refunds_payable',
  'chain_wallet_usdc', 'platform_usdc_funding',
  'merchant_usdc_available', 'merchant_usdc_withdrawals_in_flight',
  'nam_vault_usdc', 'nam_vault_rounding',
  'merchant_nam_funding_pending', 'merchant_nam_holding',
  'consumer_usdc_available', 'consumer_usdc_withdrawals_in_flight'));

-- Consumer types only ever belong to a consumer, and a consumer only ever owns consumer types.
alter table ledger.account add constraint account_consumer_types check (
  (consumer_account_id is not null) = (type like 'consumer\_%'));

-- ---------------------------------------------------------------------------
-- Chain: deposit addresses, deposits and withdrawals may belong to a consumer.
-- ---------------------------------------------------------------------------

alter table chain.address_challenge
  alter column tenant_id drop not null,
  add column consumer_account_id uuid references identity.user_account (id),
  add constraint address_challenge_one_owner check ((tenant_id is null) <> (consumer_account_id is null));

alter table chain.registered_address
  alter column tenant_id drop not null,
  add column consumer_account_id uuid references identity.user_account (id),
  add constraint registered_address_one_owner check ((tenant_id is null) <> (consumer_account_id is null));

alter table chain.observed_transfer
  add column consumer_account_id uuid references identity.user_account (id),
  add constraint observed_transfer_one_owner check (tenant_id is null or consumer_account_id is null);

alter table chain.withdrawal
  alter column tenant_id drop not null,
  add column consumer_account_id uuid references identity.user_account (id),
  add constraint withdrawal_one_owner check ((tenant_id is null) <> (consumer_account_id is null)),
  add constraint withdrawal_consumer_key unique (consumer_account_id, idempotency_key);

create or replace function chain.protect_withdrawal() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or new.tenant_id is distinct from old.tenant_id
     or new.consumer_account_id is distinct from old.consumer_account_id
     or new.amount <> old.amount
     or new.destination <> old.destination or new.idempotency_key <> old.idempotency_key
     or new.request_hash <> old.request_hash or new.created_by <> old.created_by then
    raise exception 'a withdrawal''s amount, destination and requester are immutable'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create policy consumer_read on chain.address_challenge for select to aora_app
  using (consumer_account_id = identity.current_account_id());
create policy consumer_read on chain.registered_address for select to aora_app
  using (consumer_account_id = identity.current_account_id());
create policy consumer_read on chain.withdrawal for select to aora_app
  using (consumer_account_id = identity.current_account_id());

grant update (consumer_account_id) on chain.observed_transfer to aora_platform;

-- ---------------------------------------------------------------------------
-- Recipients confirmed by a sender (P7-10), transfers (P7-8) and requests (P7-12).
-- ---------------------------------------------------------------------------

create table chiwo.recipient (
  id uuid primary key default gen_random_uuid(),
  sender_account_id uuid not null references chiwo.consumer (account_id),
  recipient_account_id uuid not null references chiwo.consumer (account_id),
  confirmed_at timestamptz,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  unique (sender_account_id, recipient_account_id),
  check (sender_account_id <> recipient_account_id)
);

create table chiwo.request_policy (
  id uuid primary key default gen_random_uuid(),
  ttl_hours integer not null check (ttl_hours between 1 and 2160),
  effective_from timestamptz not null unique,
  mode text not null default 'sandbox' check (mode = 'sandbox')
);

-- SANDBOX: a payment request stays open for 7 days.
insert into chiwo.request_policy (ttl_hours, effective_from) values (168, '2026-01-01T00:00:00Z');

create trigger request_policy_immutable before update or delete on chiwo.request_policy
  for each row execute function chiwo.reject_change();

create table chiwo.payment_request (
  id uuid primary key default gen_random_uuid(),
  requester_account_id uuid not null references chiwo.consumer (account_id),
  -- Null: anyone with the link may pay it.
  payer_account_id uuid references chiwo.consumer (account_id),
  amount bigint not null check (amount > 0),
  asset_code text not null references ledger.asset (code),
  note text check (length(btrim(note)) between 1 and 140),
  status text not null default 'open' check (status in ('open', 'paid', 'cancelled', 'expired')),
  expires_at timestamptz not null,
  paid_transfer_id uuid unique,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (payer_account_id is null or payer_account_id <> requester_account_id),
  check ((status = 'paid') = (paid_transfer_id is not null))
);

create index payment_request_requester on chiwo.payment_request (requester_account_id, created_at desc);
create index payment_request_payer on chiwo.payment_request (payer_account_id, created_at desc);

-- Only the status moves, and only out of `open`.
create function chiwo.protect_payment_request() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or old.status <> 'open'
     or (to_jsonb(new) - array['status', 'paid_transfer_id', 'updated_at'])
        <> (to_jsonb(old) - array['status', 'paid_transfer_id', 'updated_at']) then
    raise exception 'a payment request''s terms never change, and a closed request stays closed'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger payment_request_protect before update or delete on chiwo.payment_request
  for each row execute function chiwo.protect_payment_request();

create table chiwo.transfer (
  id uuid primary key default gen_random_uuid(),
  sender_account_id uuid not null references chiwo.consumer (account_id),
  recipient_account_id uuid not null references chiwo.consumer (account_id),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request_hash text not null,
  amount bigint not null check (amount > 0),
  asset_code text not null references ledger.asset (code),
  note text check (length(btrim(note)) between 1 and 140),
  -- A request is paid by at most one transfer (P7-12).
  request_id uuid unique references chiwo.payment_request (id),
  status text not null default 'posted' check (status = 'posted'),
  journal_entry_id uuid not null references ledger.journal_entry (id),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  unique (sender_account_id, idempotency_key),
  check (sender_account_id <> recipient_account_id)
);

create index transfer_sender on chiwo.transfer (sender_account_id, created_at desc);
create index transfer_recipient on chiwo.transfer (recipient_account_id, created_at desc);

alter table chiwo.payment_request
  add constraint payment_request_paid_transfer foreign key (paid_transfer_id) references chiwo.transfer (id);

create trigger transfer_immutable before update or delete on chiwo.transfer
  for each row execute function chiwo.reject_change();

alter table chiwo.recipient enable row level security;
alter table chiwo.recipient force row level security;
alter table chiwo.payment_request enable row level security;
alter table chiwo.payment_request force row level security;
alter table chiwo.transfer enable row level security;
alter table chiwo.transfer force row level security;

-- A recipient row is the sender's own; requests and transfers are visible to both parties.
create policy consumer_isolation on chiwo.recipient for select to aora_app
  using (sender_account_id = identity.current_account_id());
create policy consumer_isolation on chiwo.payment_request for select to aora_app
  using (requester_account_id = identity.current_account_id()
         or payer_account_id = identity.current_account_id());
create policy consumer_isolation on chiwo.transfer for select to aora_app
  using (sender_account_id = identity.current_account_id()
         or recipient_account_id = identity.current_account_id());
create policy platform_access on chiwo.recipient to aora_platform using (true) with check (true);
create policy platform_access on chiwo.payment_request to aora_platform using (true) with check (true);
create policy platform_access on chiwo.transfer to aora_platform using (true) with check (true);

grant select on chiwo.recipient, chiwo.payment_request, chiwo.transfer to aora_app;
grant select, insert on chiwo.recipient, chiwo.payment_request, chiwo.transfer to aora_platform;
grant update (confirmed_at) on chiwo.recipient to aora_platform;
grant update (status, paid_transfer_id) on chiwo.payment_request to aora_platform;
grant select on chiwo.request_policy to aora_app, aora_platform;

-- SANDBOX USDC limits in base units (6 decimals): transfers 1,000 per transfer and
-- 2,000 a day; on-chain withdrawals 500 per withdrawal and 1,000 a day.
insert into chiwo.consumer_limit (operation, asset_code, per_payment_max, per_day_max, effective_from)
values ('usdc_transfer', 'USDC', 1000000000, 2000000000, '2026-01-01T00:00:00Z'),
       ('usdc_withdrawal', 'USDC', 500000000, 1000000000, '2026-01-01T00:00:00Z');
