-- Cluster-level prerequisites. Run once per PostgreSQL cluster by a superuser,
-- before any migration. Migrations never create roles and never set passwords.
--
--   aora_owner     owns every object; used only to run migrations
--   aora_app       API requests for a signed-in user; tenant rows only, through row-level security
--   aora_platform  worker, webhook intake, reconciliation, operator endpoints
--
-- This file sets no passwords. Local development and CI use trust authentication
-- on a throwaway cluster. Any shared environment sets credentials through its
-- secret store, outside this repository.
do $$
begin
  if not exists (select from pg_roles where rolname = 'aora_owner') then
    create role aora_owner login createdb;
  end if;
  if not exists (select from pg_roles where rolname = 'aora_app') then
    create role aora_app login;
  end if;
  if not exists (select from pg_roles where rolname = 'aora_platform') then
    create role aora_platform login;
  end if;
end
$$;

-- No session state is ever set by the application (the runtime connection is a
-- transaction-mode pooler), so the time zone is a property of the roles.
alter role aora_owner set timezone = 'UTC';
alter role aora_app set timezone = 'UTC';
alter role aora_platform set timezone = 'UTC';
