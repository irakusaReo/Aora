-- Phase 8, checkpoint 8A: KELO credit behind the `kelo_credit` flag (phase-8
-- plan P8-1 to P8-12; ADRs 0017, 0018; CBK Non-Deposit Taking Credit Providers
-- Regulations, 2026, read in docs/compliance/kenya-credit-conduct.md).
-- SANDBOX: the lender of record is the simulated KELO book, not licensed.
-- Expand-only: new tables, new defaulted columns, wider or relaxed checks.

-- ---------------------------------------------------------------------------
-- Feature flags are data (P8-1): an operator switches them, audited. Off by default.
-- ---------------------------------------------------------------------------

create table ops.feature_flag (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{2,60}$'),
  enabled boolean not null default false,
  reason text check (reason is null or length(reason) between 3 and 300),
  changed_by uuid references identity.user_account (id),
  changed_at timestamptz not null default now()
);

grant select, update (enabled, reason, changed_by, changed_at) on ops.feature_flag to aora_platform;

insert into ops.feature_flag (key, enabled) values ('kelo_credit', false);

-- ---------------------------------------------------------------------------
-- Credit terms on plan templates (P8-2 to P8-4). Layaway rows keep the defaults.
-- ---------------------------------------------------------------------------

alter table kelo.plan_template
  add column pricing_model text not null default 'none'
    check (pricing_model in ('none', 'daily_interest')),
  -- Simple interest per day on the principal still owed, in parts per million.
  add column daily_rate_ppm integer not null default 0 check (daily_rate_ppm between 0 and 100000),
  add column deposit_bps integer not null default 0 check (deposit_bps between 0 and 9000),
  add column first_payment_at_checkout boolean not null default false,
  add column grace_days integer not null default 0 check (grace_days between 0 and 30),
  add column late_fee_minor bigint not null default 0 check (late_fee_minor >= 0),
  add column late_fee_total_cap_minor bigint not null default 0 check (late_fee_total_cap_minor >= 0),
  add column default_after_days integer check (default_after_days is null or default_after_days between 1 and 365),
  add column lender_of_record text;

alter table kelo.plan_template
  add constraint plan_template_pricing check (
    (pricing_model = 'none') = (daily_rate_ppm = 0)),
  -- Layaway extends no credit: no price beyond the item, no late charge, no deposit.
  add constraint plan_template_layaway_no_credit check (
    plan_type <> 'layaway'
    or (pricing_model = 'none' and deposit_bps = 0 and not first_payment_at_checkout
        and late_fee_minor = 0 and late_fee_total_cap_minor = 0 and lender_of_record is null)),
  -- A credit plan takes exactly one payment at checkout: a deposit or the first part.
  add constraint plan_template_credit_shape check (
    plan_type = 'layaway'
    or ((deposit_bps > 0) <> first_payment_at_checkout
        and lender_of_record is not null and default_after_days is not null
        and late_fee_minor <= late_fee_total_cap_minor)),
  -- r. 29 (P8-4): the most interest the terms can charge plus the late-charge cap
  -- stays within the principal for every order from the minimum up. Mirrors
  -- withinRecoveryCap() in services/api/src/modules/kelo/schedule.ts.
  add constraint plan_template_recovery_cap check (
    plan_type = 'layaway'
    or (daily_rate_ppm::numeric * instalment_count * interval_days < 1000000
        and (min_order_minor - round(min_order_minor * deposit_bps / 10000.0))
              * (1000000 - daily_rate_ppm::numeric * instalment_count * interval_days)
            >= (late_fee_total_cap_minor + instalment_count) * 1000000.0));

insert into kelo.plan_template
  (key, version, name, plan_type, instalment_count, interval_days, merchant_fee_bps,
   min_order_minor, max_order_minor, currency, effective_from,
   pricing_model, daily_rate_ppm, deposit_bps, first_payment_at_checkout, grace_days,
   late_fee_minor, late_fee_total_cap_minor, default_after_days, lender_of_record)
values
  ('sandbox_pay_in_4', 1, 'SANDBOX Pay in 4: four parts, every 2 weeks, no interest', 'pay_in_n',
   4, 14, 400, 200000, 10000000, 'KES', '2026-10-01',
   'none', 0, 0, true, 3, 5000, 20000, 60,
   'KELO sandbox book (simulated lender, not licensed)'),
  ('sandbox_monthly_6', 1, 'SANDBOX monthly financing: 10% deposit, six monthly parts', 'monthly_financing',
   6, 30, 500, 1000000, 30000000, 'KES', '2026-10-01',
   'daily_interest', 500, 1000, false, 5, 10000, 60000, 90,
   'KELO sandbox book (simulated lender, not licensed)');

insert into kelo.category_plan_rule (category_slug, template_key, effective_from)
values ('electronics', 'sandbox_pay_in_4', '2026-10-01'),
       ('home-appliances', 'sandbox_pay_in_4', '2026-10-01'),
       ('solar-home-systems', 'sandbox_monthly_6', '2026-10-01'),
       ('solar-home-systems', 'sandbox_pay_in_4', '2026-10-01');

-- ---------------------------------------------------------------------------
-- Eligibility rules and the limit policy are data (P8-5, P8-6). Versioned, immutable.
-- ---------------------------------------------------------------------------

create table kelo.eligibility_rule_set (
  version integer primary key check (version > 0),
  -- require_phone, max_open_agreements, max_instalment_income_bps,
  -- decline_on_adverse_bureau, decision_ttl_minutes.
  rules jsonb not null check (jsonb_typeof(rules) = 'object'),
  effective_from timestamptz not null,
  effective_to timestamptz,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from)
);

create table kelo.limit_policy (
  version integer primary key check (version > 0),
  currency text not null references ledger.asset (code),
  start_minor bigint not null check (start_minor > 0),
  step_minor bigint not null check (step_minor >= 0),
  max_minor bigint not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  check (max_minor >= start_minor),
  check (effective_to is null or effective_to > effective_from)
);

create trigger eligibility_rule_set_immutable before update or delete on kelo.eligibility_rule_set
  for each row execute function business.reject_change();
create trigger limit_policy_immutable before update or delete on kelo.limit_policy
  for each row execute function business.reject_change();

grant select on kelo.eligibility_rule_set, kelo.limit_policy to aora_platform;

insert into kelo.eligibility_rule_set (version, rules, effective_from)
values (1, '{"require_phone": true, "max_open_agreements": 2, "max_instalment_income_bps": 3000,
             "decline_on_adverse_bureau": true, "decision_ttl_minutes": 30}', '2026-10-01');

insert into kelo.limit_policy (version, currency, start_minor, step_minor, max_minor, effective_from)
values (1, 'KES', 5000000, 2500000, 20000000, '2026-10-01');

-- ---------------------------------------------------------------------------
-- Credit documents (P8-12): the key information document per template, the
-- agreement, and the bureau-check consent, kept separate from the credit terms (r. 58).
-- ---------------------------------------------------------------------------

insert into consent.terms_document (key, version, language, title, body, body_sha256, effective_from)
select key, '2026-10-19', 'en', title, body, encode(sha256(convert_to(body, 'UTF8')), 'hex'), '2026-10-01'
from (values
  ('kelo_credit_agreement', 'KELO credit agreement (SANDBOX)',
   'SANDBOX: these are test terms, not a real agreement, and no real credit is extended. The lender of record is the KELO sandbox book, a simulated lender that is not licensed. You receive the item before you have paid for all of it. You agree to pay the deposit or first part now and the remaining parts on the dates shown, each made of principal and any interest shown. Interest is simple, charged per day only on the principal you still owe, at the daily rate shown; the annual rate shown is that daily rate times 365. You may repay early at any time, without a fee, and then pay interest only up to that day. Each payment goes first to principal, then to charges, then to interest. A late charge, if shown, is added only after the grace period, and the total of interest and charges can never exceed the principal. Reminders are sent only to you. Nothing is reported to a credit bureau in the sandbox.'),
  ('kelo_credit_kid_sandbox_pay_in_4', 'Key information: SANDBOX Pay in 4',
   'SANDBOX key information document. Lender: KELO sandbox book (simulated lender, not licensed). Product: Pay in 4. You pay the price in four equal parts, the first now and then every two weeks. Interest: none (0.00% a year). Fees to you: none, except a late charge of KES 50 if a part is unpaid three days after its due date, never more than KES 200 in total. Early repayment: free at any time. The exact amounts and dates for your order are shown with this document before you agree.'),
  ('kelo_credit_kid_sandbox_monthly_6', 'Key information: SANDBOX monthly financing',
   'SANDBOX key information document. Lender: KELO sandbox book (simulated lender, not licensed). Product: monthly financing. You pay a deposit of 10% now, then six parts every 30 days. Each part repays an equal share of the principal plus simple interest of 0.0500% a day on the principal still owed (18.25% a year, nominal). Fees to you: no fee, except a late charge of KES 100 if a part is unpaid five days after its due date, never more than KES 600 in total. Early repayment: free at any time, with interest only up to that day. The exact amounts, dates and total cost of credit for your order are shown with this document before you agree.'),
  ('kelo_bureau_check_consent', 'Consent to a credit bureau check (SANDBOX)',
   'SANDBOX: you allow KELO to ask a credit bureau about your repayment history for this one decision. In the sandbox the bureau is a simulator and no real bureau is contacted. This consent is separate from the credit agreement; you may decline it, and KELO then decides without a bureau check. Nothing about you is reported to a bureau.')
) as t(key, title, body);

-- ---------------------------------------------------------------------------
-- Decisions (P8-5): approved or declined, final, with reasons and an input
-- snapshot. The consumer's alone: no tenant, so no merchant can read one.
-- ---------------------------------------------------------------------------

create table kelo.credit_decision (
  id uuid primary key default gen_random_uuid(),
  consumer_account_id uuid not null references identity.user_account (id),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request_hash text not null,
  listing_id uuid not null references kelo.listing (id),
  variant_id uuid references kelo.listing_variant (id),
  session_id uuid references kelo.listing_session (id),
  template_id uuid not null references kelo.plan_template (id),
  price_minor bigint not null check (price_minor > 0),
  financed_minor bigint not null check (financed_minor > 0),
  currency text not null references ledger.asset (code),
  outcome text not null check (outcome in ('approved', 'declined')),
  reason_codes text[] not null,
  inputs jsonb not null,
  rule_set_version integer not null references kelo.eligibility_rule_set (version),
  limit_policy_version integer not null references kelo.limit_policy (version),
  bureau_consent_id uuid references consent.consent_record (id),
  expires_at timestamptz not null,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  unique (consumer_account_id, idempotency_key),
  check ((variant_id is null) <> (session_id is null)),
  check ((outcome = 'approved') = (cardinality(reason_codes) = 0))
);

create index credit_decision_consumer on kelo.credit_decision (consumer_account_id, created_at desc);

create trigger credit_decision_immutable before update or delete on kelo.credit_decision
  for each row execute function business.reject_change();

-- ---------------------------------------------------------------------------
-- Agreements and their instalments. Every term is snapshotted from the
-- template, so a later template version changes nothing (P8-12).
-- ---------------------------------------------------------------------------

alter table kelo.purchase drop constraint purchase_plan_type_check;
alter table kelo.purchase add constraint purchase_plan_type_check
  check (plan_type in ('layaway', 'pay_in_n', 'monthly_financing'));
-- A credit purchase has no layaway refund rule and is fulfilled before it is paid off.
alter table kelo.purchase alter column refund_rule_id drop not null;
alter table kelo.purchase add constraint purchase_layaway_refund_rule
  check (plan_type <> 'layaway' or refund_rule_id is not null);
alter table kelo.purchase drop constraint purchase_check3;
alter table kelo.purchase add constraint purchase_layaway_paid_before_fulfilment
  check (plan_type <> 'layaway' or status not in ('fulfilled', 'completed') or paid_minor = total_minor);

create table kelo.credit_agreement (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  consumer_account_id uuid not null references identity.user_account (id),
  purchase_id uuid not null,
  decision_id uuid not null unique references kelo.credit_decision (id),
  template_id uuid not null references kelo.plan_template (id),
  agreement_terms_id uuid not null references consent.terms_document (id),
  kid_terms_id uuid not null references consent.terms_document (id),
  consent_id uuid not null references consent.consent_record (id),
  lender_of_record text not null,
  plan_type text not null check (plan_type in ('pay_in_n', 'monthly_financing')),
  price_minor bigint not null check (price_minor > 0),
  deposit_minor bigint not null check (deposit_minor >= 0),
  principal_minor bigint not null check (principal_minor > 0),
  interest_total_minor bigint not null check (interest_total_minor >= 0),
  daily_rate_ppm integer not null check (daily_rate_ppm >= 0),
  grace_days integer not null,
  late_fee_minor bigint not null check (late_fee_minor >= 0),
  late_fee_total_cap_minor bigint not null check (late_fee_total_cap_minor >= 0),
  default_after_days integer not null,
  currency text not null references ledger.asset (code),
  status text not null default 'pending_first_payment'
    check (status in ('pending_first_payment', 'active', 'paid_off', 'cancelled', 'defaulted', 'paused')),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (purchase_id, tenant_id) references kelo.purchase (id, tenant_id),
  -- One agreement per purchase (the purchase fixes the tenant).
  unique (purchase_id, tenant_id),
  check (deposit_minor + principal_minor = price_minor),
  -- r. 29, per agreement: interest and late charges never exceed the principal.
  check (interest_total_minor + late_fee_total_cap_minor <= principal_minor)
);

create function kelo.protect_agreement() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or old.status in ('paid_off', 'cancelled')
     or (to_jsonb(new) - array['status', 'updated_at']) <> (to_jsonb(old) - array['status', 'updated_at']) then
    raise exception 'an agreement''s terms never change, and a closed agreement stays closed'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger credit_agreement_protect before update or delete on kelo.credit_agreement
  for each row execute function kelo.protect_agreement();

create table kelo.credit_agreement_event (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references kelo.credit_agreement (id),
  consumer_account_id uuid not null references identity.user_account (id),
  from_status text,
  to_status text not null,
  actor_kind text not null check (actor_kind in ('user', 'system', 'provider')),
  actor_account_id uuid references identity.user_account (id),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now()
);

create trigger credit_agreement_event_immutable before update or delete on kelo.credit_agreement_event
  for each row execute function business.reject_change();

create table kelo.credit_instalment (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references kelo.credit_agreement (id),
  consumer_account_id uuid not null references identity.user_account (id),
  -- 0 is the deposit; 1 to N are the instalments.
  seq integer not null check (seq >= 0),
  due_on date not null,
  principal_minor bigint not null check (principal_minor > 0),
  interest_minor bigint not null check (interest_minor >= 0),
  paid_principal_minor bigint not null default 0,
  paid_interest_minor bigint not null default 0,
  late_charges_minor bigint not null default 0 check (late_charges_minor >= 0),
  status text not null default 'due'
    check (status in ('due', 'submitting', 'pending', 'paid', 'late', 'paused', 'cancelled')),
  claim_key text check (claim_key ~ '^[0-9a-f]{64}$'),
  claimed_at timestamptz,
  payment_intent_id uuid unique references payments.payment_intent (id),
  paid_at timestamptz,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agreement_id, seq),
  check (paid_principal_minor between 0 and principal_minor),
  check (paid_interest_minor between 0 and interest_minor),
  check ((status = 'paid') = (paid_at is not null)),
  check (status not in ('pending', 'paid') or payment_intent_id is not null),
  check (status <> 'submitting' or (claim_key is not null and claimed_at is not null))
);

create function kelo.protect_credit_instalment() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or old.status in ('paid', 'cancelled')
     or (to_jsonb(new) - array['status', 'payment_intent_id', 'paid_at', 'claim_key', 'claimed_at',
                               'paid_principal_minor', 'paid_interest_minor', 'late_charges_minor', 'updated_at'])
        <> (to_jsonb(old) - array['status', 'payment_intent_id', 'paid_at', 'claim_key', 'claimed_at',
                                  'paid_principal_minor', 'paid_interest_minor', 'late_charges_minor', 'updated_at'])
     or new.paid_principal_minor < old.paid_principal_minor
     or new.paid_interest_minor < old.paid_interest_minor then
    raise exception 'an instalment''s amounts and date never change, what was paid never goes down, and a paid one stays paid'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger credit_instalment_protect before update or delete on kelo.credit_instalment
  for each row execute function kelo.protect_credit_instalment();

-- An agreement's principal lines always sum to the price (ADR 0018).
create function kelo.check_credit_schedule() returns trigger
  language plpgsql
  as $$
declare
  scheduled bigint;
  interest bigint;
  agreement kelo.credit_agreement;
begin
  select * into agreement from kelo.credit_agreement where id = new.agreement_id;
  select coalesce(sum(principal_minor), 0), coalesce(sum(interest_minor), 0) into scheduled, interest
    from kelo.credit_instalment where agreement_id = new.agreement_id;
  if scheduled <> agreement.price_minor or interest <> agreement.interest_total_minor then
    raise exception 'instalments of agreement % do not sum to its price and interest', new.agreement_id
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

create constraint trigger credit_schedule_sums after insert on kelo.credit_instalment
  deferrable initially deferred for each row execute function kelo.check_credit_schedule();

-- Consumer isolation only (P8-9): a merchant sees the order, never the credit.
do $$
declare
  t text;
begin
  foreach t in array array['credit_decision', 'credit_agreement', 'credit_agreement_event', 'credit_instalment'] loop
    execute format('alter table kelo.%I enable row level security', t);
    execute format('alter table kelo.%I force row level security', t);
    execute format('create policy consumer_isolation on kelo.%I for select to aora_app
                      using (consumer_account_id = identity.current_account_id())', t);
    execute format('create policy platform_access on kelo.%I to aora_platform
                      using (true) with check (true)', t);
    execute format('grant select on kelo.%I to aora_app', t);
    execute format('grant select, insert on kelo.%I to aora_platform', t);
  end loop;
end
$$;

grant update (status) on kelo.credit_agreement to aora_platform;
grant update (status, payment_intent_id, paid_at, claim_key, claimed_at, paid_principal_minor,
              paid_interest_minor, late_charges_minor) on kelo.credit_instalment to aora_platform;

-- ---------------------------------------------------------------------------
-- Payments: a credit repayment is the buyer's money owed to KELO, never a
-- collection for the merchant (P8-8). Like layaway, it carries no collection fee.
-- ---------------------------------------------------------------------------

alter table payments.payment_intent drop constraint payment_intent_purpose_check;
alter table payments.payment_intent add constraint payment_intent_purpose_check
  check (purpose in ('collection', 'kelo_layaway', 'kelo_credit'));

-- ---------------------------------------------------------------------------
-- Ledger (P8-8, cash-basis interest):
--   consumer_kelo_credit_receivable   consumer asset: principal the buyer still owes
--   kelo_merchant_payable_pending     platform liability: owed to merchants on fulfilment
--   kelo_credit_repayments_unapplied  platform liability: a repayment received, before allocation
--   kelo_interest_income              platform income: interest received
--   kelo_late_charge_income           platform income: late charges received (8B)
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
  'kelo_credit_repayments_unapplied', 'kelo_interest_income', 'kelo_late_charge_income'));

insert into ledger.account (tenant_id, asset_code, type, qualifier, normal_side, allow_negative)
values (null, 'KES', 'kelo_merchant_payable_pending', '', 'credit', false),
       (null, 'KES', 'kelo_credit_repayments_unapplied', '', 'credit', false),
       (null, 'KES', 'kelo_interest_income', '', 'credit', false),
       (null, 'KES', 'kelo_late_charge_income', '', 'credit', false);
