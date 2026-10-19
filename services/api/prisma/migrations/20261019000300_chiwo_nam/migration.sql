-- Phase 7, checkpoint 7C: the NAM Vault inside CHIWO, with a personal investor
-- profile (phase-7 plan P7-14). Expand-only: new nullable columns, new account
-- types, one new terms document, new policies. No yield is offered (brief §6.1).

-- ---------------------------------------------------------------------------
-- Ledger: a consumer's NAM funding and holding, apart from any workspace's.
--   consumer_nam_funding_pending  consumer liability: set aside for an order not yet confirmed
--   consumer_nam_holding          consumer liability: their principal in the vault, at cost
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
  'consumer_nam_funding_pending', 'consumer_nam_holding'));

-- ---------------------------------------------------------------------------
-- NAM rows may belong to a consumer. The profile already says personal or
-- business; the consumer's account is repeated on each row for row-level security.
-- ---------------------------------------------------------------------------

alter table nam.vault_order
  add column consumer_account_id uuid references identity.user_account (id),
  add constraint vault_order_one_owner check ((tenant_id is null) <> (consumer_account_id is null));
alter table nam.redemption
  add column consumer_account_id uuid references identity.user_account (id),
  add constraint redemption_one_owner check ((tenant_id is null) <> (consumer_account_id is null));
alter table nam.holding
  add column consumer_account_id uuid references identity.user_account (id),
  add constraint holding_one_owner check ((tenant_id is null) <> (consumer_account_id is null));
alter table nam.holding_change
  add column consumer_account_id uuid references identity.user_account (id),
  add constraint holding_change_one_owner check ((tenant_id is null) <> (consumer_account_id is null));

create policy consumer_read on nam.vault_order for select to aora_app
  using (consumer_account_id = identity.current_account_id());
create policy consumer_read on nam.redemption for select to aora_app
  using (consumer_account_id = identity.current_account_id());
create policy consumer_read on nam.holding for select to aora_app
  using (consumer_account_id = identity.current_account_id());
create policy consumer_read on nam.holding_change for select to aora_app
  using (consumer_account_id = identity.current_account_id());

-- ---------------------------------------------------------------------------
-- Personal wording, as data: the business text speaks of a workspace.
-- ---------------------------------------------------------------------------

alter table nam.product
  add column customer_owns_personal text,
  add column personal_terms_key text;

update nam.product
   set customer_owns_personal =
         'A record in AORA''s ledger of the shares held for you. Testnet USDC has no value.',
       personal_terms_key = 'nam_vault_disclosure_personal'
 where code = 'nam_usdc_vault';

-- SANDBOX personal disclosure, version 1 (P7-14). No yield, rate or return is offered.
insert into consent.terms_document (key, version, language, title, body, body_sha256, effective_from)
select 'nam_vault_disclosure_personal', '1', 'en', 'NAM USDC Vault (sandbox): what it is and is not', body,
       encode(sha256(convert_to(body, 'UTF8')), 'hex'), '2026-01-01T00:00:00Z'
from (values (
  'SANDBOX ONLY. This is a demonstration on Base Sepolia, a test network. Testnet USDC has no value.' || E'\n' ||
  'What it is: your personal testnet USDC in CHIWO is deposited into AORA''s NamUsdcVault contract. The vault holds only USDC and does not lend, stake or invest it.' || E'\n' ||
  'Who controls it: the AORA sandbox testnet wallet holds the vault shares. You hold a record of them in AORA''s ledger.' || E'\n' ||
  'This is personal: it is separate from any business you work for, and a business role gives no one access to it.' || E'\n' ||
  'Returns: none. This product does not pay or promise any return. The value of your shares can be slightly lower than what you deposited because of rounding.' || E'\n' ||
  'Fees: none.' || E'\n' ||
  'Withdrawals: you can redeem at any time; a redemption completes only after it is confirmed on chain. New deposits can be paused; redemptions cannot.' || E'\n' ||
  'Risks: the contract has had no independent review and is a testnet demonstration only.'
)) as t(body);
