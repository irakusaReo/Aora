-- Phase 3, checkpoint 3B: Safaricom Daraja (M-Pesa) as the first real provider
-- (ADR 0022). Expand-only.

-- ---------------------------------------------------------------------------
-- Adapter-owned record of an operation at a provider (ADR 0007): the
-- provider's references, what its callback said, and the payer's number. The
-- payment intent never holds any of these.
-- ---------------------------------------------------------------------------

create table payments.provider_operation (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  operation_type text not null check (operation_type in ('payment_intent')),
  operation_id uuid not null,
  tenant_id uuid not null references tenancy.workspace (id),
  -- The payer's mobile number: personal data, readable by the platform role only.
  msisdn text check (msisdn is null or msisdn ~ '^[1-9][0-9]{7,14}$'),
  -- Daraja: CheckoutRequestID and MerchantRequestID.
  external_ref text,
  external_ref_2 text,
  callback_result_code text,
  -- Kept as the decimal text the provider sent, never as a floating-point number.
  callback_amount text check (callback_amount is null or callback_amount ~ '^[0-9]+(\.[0-9]+)?$'),
  receipt text,
  last_query_result_code text,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, operation_type, operation_id)
);

create unique index provider_operation_external_ref
  on payments.provider_operation (provider, external_ref) where external_ref is not null;

create function payments.protect_provider_operation() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or new.provider <> old.provider or new.operation_type <> old.operation_type
     or new.operation_id <> old.operation_id or new.tenant_id <> old.tenant_id
     or new.msisdn is distinct from old.msisdn
     or (old.external_ref is not null and new.external_ref is distinct from old.external_ref) then
    raise exception 'a provider operation''s identity and references never change once set'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger provider_operation_protect before update or delete on payments.provider_operation
  for each row execute function payments.protect_provider_operation();

alter table payments.provider_operation enable row level security;
alter table payments.provider_operation force row level security;

-- The tenant role may record the operation when it creates the intent, and never read it back.
create policy tenant_create on payments.provider_operation for insert to aora_app
  with check (tenant_id = tenancy.current_tenant_id());
create policy platform_access on payments.provider_operation to aora_platform
  using (true) with check (true);

grant insert on payments.provider_operation to aora_app;
grant select, insert on payments.provider_operation to aora_platform;
grant update (external_ref, external_ref_2, callback_result_code, callback_amount, receipt,
              last_query_result_code)
  on payments.provider_operation to aora_platform;

-- Money the Daraja sandbox holds for AORA (sandbox assumption M-4), like the simulator's.
insert into ledger.account (tenant_id, asset_code, type, qualifier, normal_side, allow_negative)
values (null, 'KES', 'provider_clearing', 'daraja', 'debit', false);
