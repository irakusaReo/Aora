import type { Call } from '@aora/mobile/testing';

export const assets = { data: [{ code: 'KES', exponent: 2 }] };

export const listing = {
  id: 'li_1',
  title: 'Solar home kit',
  description: 'Panel, battery and four lights.',
  category: 'solar',
  type: 'stock_item',
  currency: 'KES',
  store: { display_name: 'Jua Shop' },
  from_price_minor: '2400000',
  variants: [{ id: 'va_1', name: 'Standard', price_minor: '2400000', in_stock: true }],
  sessions: [],
  images: [],
};

export const layaway = {
  template_key: 'sandbox_layaway_3',
  name: 'Layaway in 3',
  plan_type: 'layaway',
  instalments: [
    { seq: 1, due_on: '2026-10-19', amount_minor: '800000' },
    { seq: 2, due_on: '2026-11-19', amount_minor: '800000' },
    { seq: 3, due_on: '2026-12-19', amount_minor: '800000' },
  ],
  total_minor: '2400000',
  fees_minor: '0',
  currency: 'KES',
  receive_after_last_payment: true,
  cancellation: { fee_bps: 500, fee_cap_minor: '100000', after_start_returned_bps: 5000 },
  terms: { key: 'kelo_layaway_terms', version: '3' },
};

export const creditPlan = {
  template_key: 'sandbox_monthly_6',
  name: 'Monthly over 6 months',
  plan_type: 'monthly_financing',
  pricing_model: 'daily_interest',
  instalments: [
    {
      seq: 0,
      due_on: '2026-10-19',
      principal_minor: '240000',
      interest_minor: '0',
      amount_minor: '240000',
    },
    {
      seq: 1,
      due_on: '2026-11-19',
      principal_minor: '360000',
      interest_minor: '21600',
      amount_minor: '381600',
    },
  ],
  total_minor: '2400000',
  deposit_minor: '240000',
  financed_minor: '2160000',
  interest_total_minor: '75600',
  total_payable_minor: '2475600',
  fees_minor: '0',
  currency: 'KES',
  daily_rate_text: '0.0667%',
  apr_text: '24.35%',
  checkout_seq: 0,
  receive_after_last_payment: false,
  needs_decision: true,
  lender_of_record: 'KELO simulated book (not licensed)',
  late_charges: { fee_minor: '50000', total_cap_minor: '200000', grace_days: 3 },
  kid: { key: 'kelo_credit_kid_sandbox_monthly_6', version: '1' },
  terms: { key: 'kelo_credit_agreement', version: '1' },
};

export function routes(rest: (call: Call) => unknown): (call: Call) => unknown {
  return (call) => {
    if (call.method === 'GET' && call.path === '/v1/assets') return assets;
    if (call.method === 'GET' && call.path === '/v1/terms/kelo_bureau_check_consent')
      return { version: '2' };
    return rest(call);
  };
}
