-- Fix-forward for 20261014000300: its backfill of workspace accounts ran as the
-- schema owner, which row-level security on tenancy.workspace hid every
-- workspace from, so existing workspaces got no "available" or "payouts in
-- flight" account. Expand-only.

-- The owner may read workspaces, as it already may read memberships for triggers.
create policy owner_read on tenancy.workspace for select to aora_owner using (true);

insert into ledger.account (tenant_id, asset_code, type, qualifier, normal_side, allow_negative)
select w.id, 'KES', t.type, '', 'credit', false
from tenancy.workspace w
cross join (values ('merchant_collections_pending'), ('merchant_available'),
                   ('merchant_payouts_in_flight')) as t(type)
where not exists (
  select from ledger.account a
  where a.tenant_id = w.id and a.type = t.type and a.asset_code = 'KES' and a.qualifier = '');

-- Fail the migration, rather than leave a workspace that settlement or payouts cannot serve.
do $$
declare
  missing integer;
begin
  select count(*) into missing
  from tenancy.workspace w
  cross join (values ('merchant_collections_pending'), ('merchant_available'),
                     ('merchant_payouts_in_flight')) as t(type)
  where not exists (
    select from ledger.account a
    where a.tenant_id = w.id and a.type = t.type and a.asset_code = 'KES' and a.qualifier = '');
  if missing > 0 then
    raise exception '% workspace accounts are still missing after the backfill', missing;
  end if;
end
$$;
