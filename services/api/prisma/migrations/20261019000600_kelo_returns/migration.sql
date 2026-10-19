-- Phase 8, checkpoint 8C: returns and disputes (ADR 0017 "Returns and
-- disputes"; journey K7). Expand-only: a new table, a new column, wider checks
-- and replaced trigger functions.

-- ---------------------------------------------------------------------------
-- The order machine gains ADR 0017's return and dispute states.
-- ---------------------------------------------------------------------------

alter table kelo.purchase drop constraint purchase_status_check;
alter table kelo.purchase add constraint purchase_status_check check (status in (
  'placed', 'payment_ready', 'merchant_confirmed', 'fulfilled', 'completed', 'cancelled',
  'return_requested', 'returned', 'disputed'));

-- A purchase's terms never change; it is closed once cancelled or returned and refunded.
create or replace function kelo.protect_purchase() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or old.status in ('cancelled', 'returned') and old.plan_status = 'refunded'
     or (to_jsonb(new) - array['status', 'plan_status', 'paid_minor', 'fulfilment_evidence', 'updated_at'])
        <> (to_jsonb(old) - array['status', 'plan_status', 'paid_minor', 'fulfilment_evidence', 'updated_at'])
     or new.paid_minor < old.paid_minor and new.plan_status <> 'refunded' then
    raise exception 'a purchase''s terms never change, and a closed purchase stays closed'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- A claim: a return (decided by the merchant) or a dispute (decided by an
-- operator). While open it pauses the schedule; it remembers what it paused.
-- ---------------------------------------------------------------------------

create table kelo.purchase_claim (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  purchase_id uuid not null,
  consumer_account_id uuid not null references identity.user_account (id),
  agreement_id uuid references kelo.credit_agreement (id),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  kind text not null check (kind in ('return', 'dispute')),
  reason_code text not null
    check (reason_code in ('not_delivered', 'not_as_described', 'faulty', 'changed_mind', 'other')),
  -- Purchase data only; never health information (kelo-experience §5).
  details text check (details is null or length(details) between 1 and 500),
  status text not null default 'open' check (status in ('open', 'accepted', 'rejected', 'withdrawn')),
  prior_purchase_status text not null,
  prior_agreement_status text,
  -- [{seq, status}] of the parts it paused.
  paused_lines jsonb not null default '[]',
  decided_by uuid references identity.user_account (id),
  decided_as text check (decided_as in ('merchant', 'operator', 'buyer')),
  decision_reason text check (decision_reason is null or length(decision_reason) between 3 and 300),
  decided_at timestamptz,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (purchase_id, tenant_id) references kelo.purchase (id, tenant_id),
  unique (consumer_account_id, idempotency_key),
  check ((status = 'open') = (decided_at is null))
);

-- At most one open claim per purchase (an expression index, so the ORM sees no one-to-one link).
create unique index purchase_claim_open on kelo.purchase_claim (purchase_id, (status = 'open')) where status = 'open';
create index purchase_claim_tenant on kelo.purchase_claim (tenant_id, created_at desc);

create function kelo.protect_claim() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or old.status <> 'open'
     or (to_jsonb(new) - array['status', 'decided_by', 'decided_as', 'decision_reason', 'decided_at', 'updated_at'])
        <> (to_jsonb(old) - array['status', 'decided_by', 'decided_as', 'decision_reason', 'decided_at', 'updated_at']) then
    raise exception 'a claim is decided once and never changes afterwards'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger purchase_claim_protect before update or delete on kelo.purchase_claim
  for each row execute function kelo.protect_claim();

alter table kelo.purchase_claim enable row level security;
alter table kelo.purchase_claim force row level security;
create policy tenant_isolation on kelo.purchase_claim for select to aora_app
  using (tenant_id = tenancy.current_tenant_id());
create policy consumer_isolation on kelo.purchase_claim for select to aora_app
  using (consumer_account_id = identity.current_account_id());
create policy platform_access on kelo.purchase_claim to aora_platform using (true) with check (true);
grant select on kelo.purchase_claim to aora_app;
grant select, insert on kelo.purchase_claim to aora_platform;
grant update (status, decided_by, decided_as, decision_reason, decided_at) on kelo.purchase_claim
  to aora_platform;

-- ---------------------------------------------------------------------------
-- A part resumed after a pause gets its full grace from the day it resumed.
-- ---------------------------------------------------------------------------

alter table kelo.credit_instalment add column grace_from date;

create or replace function kelo.protect_credit_instalment() returns trigger
  language plpgsql
  as $$
declare
  movable text[] := array['status', 'payment_intent_id', 'paid_at', 'claim_key', 'claimed_at',
                          'paid_principal_minor', 'paid_interest_minor', 'late_charges_minor',
                          'interest_waived_minor', 'paid_charges_minor', 'repayment_id', 'late_on',
                          'grace_from', 'updated_at'];
begin
  if tg_op = 'DELETE' or old.status in ('paid', 'cancelled')
     or (to_jsonb(new) - movable) <> (to_jsonb(old) - movable)
     or new.paid_principal_minor < old.paid_principal_minor
     or new.paid_interest_minor < old.paid_interest_minor
     or new.late_charges_minor < old.late_charges_minor
     or new.interest_waived_minor < old.interest_waived_minor
     or new.paid_charges_minor < old.paid_charges_minor then
    raise exception 'an instalment''s amounts and date never change, what was paid, charged or waived never goes down, and a paid one stays paid'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

grant update (grace_from) on kelo.credit_instalment to aora_platform;

-- ---------------------------------------------------------------------------
-- Ledger: money clawed back from a merchant for an accepted return, owed by
-- the merchant until netted from their next KELO settlement (ADR 0017).
--   merchant_kelo_clawback_receivable  workspace asset (debit)
-- ---------------------------------------------------------------------------

alter table ledger.account drop constraint account_type_check;
alter table ledger.account add constraint account_type_check check (type in (
  'provider_clearing', 'merchant_collections_pending', 'fee_revenue',
  'merchant_available', 'merchant_payouts_in_flight', 'provider_payout_float',
  'kelo_layaway_funds_held', 'kelo_fee_revenue', 'kelo_refunds_payable',
  'chain_wallet_usdc', 'platform_usdc_funding',
  'merchant_usdc_available', 'merchant_usdc_withdrawals_in_flight',
  'nam_vault_usdc', 'nam_vault_rounding',
  'merchant_nam_funding_pending', 'merchant_nam_holding',
  'consumer_usdc_available', 'consumer_usdc_withdrawals_in_flight',
  'consumer_nam_funding_pending', 'consumer_nam_holding',
  'consumer_kelo_credit_receivable', 'kelo_merchant_payable_pending',
  'kelo_credit_repayments_unapplied', 'kelo_interest_income', 'kelo_late_charge_income',
  'merchant_kelo_clawback_receivable'));
