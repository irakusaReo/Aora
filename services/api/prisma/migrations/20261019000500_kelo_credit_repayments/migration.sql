-- Phase 8, checkpoint 8B: KELO credit repayments and collections (phase-8 plan;
-- r. 29, r. 30, r. 56 of the CBK Non-Deposit Taking Credit Providers
-- Regulations, 2026). Expand-only: a new table, new defaulted columns, a
-- relaxed check and a replaced trigger function.

-- ---------------------------------------------------------------------------
-- A repayment: one payment covering one or more parts, with its allocation
-- fixed when it is started (r. 56(1): credited as of the day it is made).
-- ---------------------------------------------------------------------------

create table kelo.credit_repayment (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references kelo.credit_agreement (id),
  consumer_account_id uuid not null references identity.user_account (id),
  -- A hash of the request's Idempotency-Key: a repeat adopts this repayment.
  claim_key text not null check (claim_key ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('instalment', 'next', 'payoff')),
  quoted_on date not null,
  amount_minor bigint not null check (amount_minor > 0),
  principal_minor bigint not null check (principal_minor >= 0),
  charges_minor bigint not null check (charges_minor >= 0),
  interest_minor bigint not null check (interest_minor >= 0),
  waived_minor bigint not null check (waived_minor >= 0),
  -- [{seq, principal_minor, charges_minor, interest_minor, waived_minor, prior_status}]
  allocation jsonb not null check (jsonb_typeof(allocation) = 'array'),
  status text not null default 'submitting'
    check (status in ('submitting', 'pending', 'succeeded', 'failed')),
  payment_intent_id uuid unique references payments.payment_intent (id),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agreement_id, claim_key),
  check (amount_minor = principal_minor + charges_minor + interest_minor),
  check (status not in ('pending', 'succeeded') or payment_intent_id is not null)
);

-- At most one repayment in flight per agreement.
create unique index credit_repayment_in_flight on kelo.credit_repayment (agreement_id)
  where status in ('submitting', 'pending');

create function kelo.protect_repayment() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or old.status in ('succeeded', 'failed')
     or (to_jsonb(new) - array['status', 'payment_intent_id', 'updated_at'])
        <> (to_jsonb(old) - array['status', 'payment_intent_id', 'updated_at']) then
    raise exception 'a repayment''s amounts and allocation never change, and a final one stays final'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger credit_repayment_protect before update or delete on kelo.credit_repayment
  for each row execute function kelo.protect_repayment();

alter table kelo.credit_repayment enable row level security;
alter table kelo.credit_repayment force row level security;
create policy consumer_isolation on kelo.credit_repayment for select to aora_app
  using (consumer_account_id = identity.current_account_id());
create policy platform_access on kelo.credit_repayment to aora_platform using (true) with check (true);
grant select on kelo.credit_repayment to aora_app;
grant select, insert on kelo.credit_repayment to aora_platform;
grant update (status, payment_intent_id) on kelo.credit_repayment to aora_platform;

-- ---------------------------------------------------------------------------
-- Instalments: interest waived on early repayment, charges paid, and the
-- repayment in flight. What was paid, charged or waived only ever goes up.
-- ---------------------------------------------------------------------------

alter table kelo.credit_instalment
  add column interest_waived_minor bigint not null default 0 check (interest_waived_minor >= 0),
  add column paid_charges_minor bigint not null default 0 check (paid_charges_minor >= 0),
  add column repayment_id uuid references kelo.credit_repayment (id),
  add column late_on date,
  add constraint credit_instalment_interest_settled
    check (paid_interest_minor + interest_waived_minor <= interest_minor),
  add constraint credit_instalment_charges_paid check (paid_charges_minor <= late_charges_minor),
  add constraint credit_instalment_late_on check ((status = 'late') <= (late_on is not null));

-- A part in flight or paid names its payment (8A) or its repayment (8B).
alter table kelo.credit_instalment drop constraint credit_instalment_check3;
alter table kelo.credit_instalment add constraint credit_instalment_paid_by
  check (status not in ('pending', 'paid') or payment_intent_id is not null or repayment_id is not null);

create or replace function kelo.protect_credit_instalment() returns trigger
  language plpgsql
  as $$
declare
  movable text[] := array['status', 'payment_intent_id', 'paid_at', 'claim_key', 'claimed_at',
                          'paid_principal_minor', 'paid_interest_minor', 'late_charges_minor',
                          'interest_waived_minor', 'paid_charges_minor', 'repayment_id', 'late_on',
                          'updated_at'];
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

grant update (interest_waived_minor, paid_charges_minor, repayment_id, late_on)
  on kelo.credit_instalment to aora_platform;

-- r. 29 per agreement: the late charges on all its parts never exceed its cap.
create function kelo.check_late_charge_cap() returns trigger
  language plpgsql
  as $$
declare
  charged bigint;
  cap bigint;
begin
  select coalesce(sum(late_charges_minor), 0) into charged
    from kelo.credit_instalment where agreement_id = new.agreement_id;
  select late_fee_total_cap_minor into cap from kelo.credit_agreement where id = new.agreement_id;
  if charged > cap then
    raise exception 'late charges on agreement % would exceed its cap', new.agreement_id
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

create constraint trigger credit_late_charge_cap after update of late_charges_minor on kelo.credit_instalment
  deferrable initially deferred for each row execute function kelo.check_late_charge_cap();

-- ---------------------------------------------------------------------------
-- Reminders (P8-11): to the borrower only, by email, inside a contact window
-- in Nairobi time. Policy is data, versioned.
-- ---------------------------------------------------------------------------

create table kelo.reminder_policy (
  version integer primary key check (version > 0),
  days_before integer[] not null,
  window_start_hour integer not null check (window_start_hour between 0 and 23),
  window_end_hour integer not null check (window_end_hour between 1 and 24),
  time_zone text not null default 'Africa/Nairobi',
  effective_from timestamptz not null,
  effective_to timestamptz,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  check (window_end_hour > window_start_hour),
  check (effective_to is null or effective_to > effective_from)
);

create trigger reminder_policy_immutable before update or delete on kelo.reminder_policy
  for each row execute function business.reject_change();

grant select on kelo.reminder_policy to aora_platform;

insert into kelo.reminder_policy (version, days_before, window_start_hour, window_end_hour, effective_from)
values (1, array[3, 0], 8, 19, '2026-10-01');
