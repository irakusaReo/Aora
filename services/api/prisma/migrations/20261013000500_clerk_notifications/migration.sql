-- Phase 2, checkpoints 2E and 2F: Clerk identities and the notifications module.
--
-- Expand only (ADR 0013): this migration adds and loosens. The tables it makes
-- redundant (identity.auth_challenge, identity.session, sim.sim_sms) are left in
-- place and dropped in a later release, once no deployed code can touch them.

-- ---------------------------------------------------------------------------
-- identity: accounts are linked to the identity provider's user (ADR 0019).
-- AORA keeps a copy of email, phone and name so payments and notifications work
-- without calling the provider. Nothing else about a user lives outside AORA.
-- ---------------------------------------------------------------------------

alter table identity.user_account
  add column clerk_user_id text unique,
  add column email text,
  add column display_name text,
  add column phone_verified_at timestamptz,
  add column status text not null default 'active' check (status in ('active', 'closed')),
  add column closed_at timestamptz,
  -- The provider's own "last updated" time for this user, so an old webhook cannot overwrite a newer one.
  add column provider_updated_at bigint not null default 0,
  alter column phone_e164 drop not null;

create unique index user_account_email_unique on identity.user_account (lower(email))
  where email is not null;

grant update (clerk_user_id, email, display_name, phone_e164, phone_verified_at, status, closed_at,
              provider_updated_at)
  on identity.user_account to aora_platform;

-- A PIN step-up belongs to one provider session and expires.
create table identity.step_up (
  session_ref text primary key check (length(session_ref) between 1 and 200),
  account_id uuid not null references identity.user_account (id),
  until timestamptz not null,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now()
);

create index step_up_account on identity.step_up (account_id);

-- Every provider webhook delivery handled, so a repeat has no further effect.
create table identity.provider_event (
  id text primary key check (length(id) between 1 and 200),
  provider text not null,
  type text not null,
  received_at timestamptz not null default now()
);

grant select, insert, update, delete on identity.step_up to aora_platform;
grant select, insert on identity.provider_event to aora_platform;

-- ---------------------------------------------------------------------------
-- notifications (ADR 0020). A row records that a message was sent to an
-- account and what became of it. It never holds a sign-in code, a credential
-- or a full phone or account number; the recipient address is read from the
-- account at send time and stored here only in masked form.
-- ---------------------------------------------------------------------------

create schema notifications;
grant usage on schema notifications to aora_platform;

create table notifications.notification (
  id uuid primary key default gen_random_uuid(),
  -- Identifies the reason for the message; the same reason never sends twice.
  dedupe_key text not null unique check (length(dedupe_key) between 1 and 300),
  account_id uuid not null references identity.user_account (id),
  tenant_id uuid references tenancy.workspace (id),
  channel text not null check (channel in ('email')),
  type text not null check (type ~ '^[a-z][a-z0-9_.]{1,80}$'),
  params jsonb not null default '{}'::jsonb,
  locale text not null default 'en' check (locale ~ '^[a-z]{2}$'),
  status text not null default 'queued' check (status in (
    'queued', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'status_unknown')),
  recipient_masked text,
  subject text,
  provider text,
  provider_message_id text unique,
  failure_code text,
  attempts integer not null default 0 check (attempts >= 0),
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  last_event_at timestamptz
);

create index notification_account on notifications.notification (account_id, created_at);

create table notifications.delivery_event (
  id text primary key check (length(id) between 1 and 200),
  notification_id uuid references notifications.notification (id),
  type text not null,
  received_at timestamptz not null default now()
);

create function notifications.protect_notification() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' or new.dedupe_key <> old.dedupe_key or new.account_id <> old.account_id
     or new.type <> old.type or new.channel <> old.channel then
    raise exception 'a notification''s reason, recipient and type are immutable'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

create trigger notification_protect before update or delete on notifications.notification
  for each row execute function notifications.protect_notification();

alter table notifications.notification enable row level security;
alter table notifications.notification force row level security;
create policy platform_access on notifications.notification to aora_platform
  using (true) with check (true);

grant select, insert, update on notifications.notification to aora_platform;
grant select, insert on notifications.delivery_event to aora_platform;

-- sim: outbox of the simulated email channel, for tests and local development.
create table sim.sim_email (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  to_address text not null,
  subject text not null,
  html text not null,
  body_text text not null,
  mode text not null default 'sandbox' check (mode = 'sandbox'),
  created_at timestamptz not null default now()
);

grant select, insert on sim.sim_email to aora_platform;
