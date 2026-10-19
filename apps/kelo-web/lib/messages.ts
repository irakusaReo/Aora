// Every word KELO shows a buyer, keyed by locale (kelo-experience.md §4).
// Whole sentences with named placeholders: nothing is built by joining
// fragments, so each can be translated into Swahili as written.

type Messages = Record<string, string>;

const EN: Messages = {
  'app.name': 'KELO',
  'app.tagline': 'Buy what you need and pay in a way that suits you.',
  'nav.browse': 'Browse',
  'nav.quotes': 'Your quotes',
  'nav.purchases': 'Your purchases',
  'browse.title': 'Browse KELO',
  'browse.search_label': 'Search',
  'browse.search_button': 'Search',
  'browse.all_categories': 'All categories',
  'browse.empty': 'Nothing matches yet. Try another word or category.',
  'browse.more': 'Show more',
  'listing.from': 'From {amount}',
  'listing.by_quote': 'Price by quote',
  'listing.sold_by': 'Sold by {store}',
  'listing.in_stock': 'In stock',
  'listing.out_of_stock': 'Out of stock',
  'listing.places_left': 'Places available',
  'listing.full': 'Full',
  'listing.ways_to_pay': 'Ways to pay',
  'listing.not_found': 'This listing is not available.',
  'quote.title': 'Ask for a quote',
  'quote.details_label':
    'What do you need? Give enough detail for an accurate price. Do not include health information.',
  'quote.send': 'Send request',
  'quote.sent':
    'Your request was sent. The merchant will reply with a price and how long it is valid.',
  'quote.sign_in': 'Sign in to ask for a quote.',
  'quotes.title': 'Your quotes',
  'quotes.empty': 'You have not asked for any quotes yet.',
  'quotes.waiting': 'Waiting for the merchant to reply.',
  'quotes.price': '{amount}, valid until {date}',
  'quotes.status.offered': 'Offered',
  'quotes.status.accepted': 'Accepted',
  'quotes.status.declined': 'Declined',
  'quotes.status.expired': 'Expired',
  'quotes.decline': 'Decline',
  'purchases.title': 'Your purchases',
  'purchases.empty': 'You have no purchases yet.',

  'plan.title': '{name}',
  'plan.price': 'Price: {amount}',
  'plan.first_payment': 'First payment: {amount} today',
  'plan.instalment': 'Payment {seq} on {date}: {amount}',
  'plan.fees_none': 'No fees: layaway costs nothing on top of the price.',
  'plan.total': 'Total you will pay: {amount}',
  'plan.receive_after': 'You receive it after the last payment.',
  'plan.late':
    'If a payment is late, nothing is charged. You receive the item once everything is paid.',
  'plan.cancel_rule':
    'If you cancel before you receive it, you get back what you paid, less {percent}% (at most {cap}).',
  'plan.cancel_after_start':
    'Once the date has passed, cancelling returns {percent}% of what you paid.',
  'plan.choose_option': 'Choose an option to see ways to pay.',
  'plan.none': 'This listing has no ways to pay by instalments. You can come back later.',
  'checkout.terms': 'By agreeing you accept the KELO layaway terms, version {version}.',
  'checkout.rail_label': 'Pay with',
  'checkout.rail_simulator': 'AORA simulator (sandbox: the payment succeeds; no real money)',
  'checkout.rail_mpesa':
    "M-Pesa sandbox (sends a prompt to Safaricom's test number, which always cancels it)",
  'checkout.agree': 'Agree and pay {amount} now',
  'checkout.sign_in': 'Sign in to buy.',
  'checkout.sold_out': 'This is no longer available.',
  'purchases.paid_of': '{paid} paid of {total}',
  'purchases.next': 'Next payment: {amount} on {date}',
  'purchases.left': 'Left to pay: {amount}',
  'purchases.pay_next': 'Pay {amount} now',
  'purchases.checking': 'We are checking a payment. You can pay again once it has a result.',
  'purchases.receive': 'Paid in full. The merchant will deliver it.',
  'purchases.confirm_delivery': 'I have received it',
  'purchases.cancel': 'Cancel this purchase',
  'purchases.refund':
    'Refund: {refund} of {paid} paid ({fee} kept under the cancellation rule). Status: {status}.',
  'purchases.status.placed': 'Waiting for your first payment',
  'purchases.status.payment_ready': 'Payments under way',
  'purchases.status.merchant_confirmed': 'Confirmed by the merchant',
  'purchases.status.fulfilled': 'Delivered',
  'purchases.status.completed': 'Complete',
  'purchases.status.cancelled': 'Cancelled',
  'instalment.status.due': 'To pay',
  'instalment.status.pending': 'Being checked',
  'instalment.status.paid': 'Paid',
  'instalment.status.cancelled': 'Cancelled',
  'credit.sandbox_lender':
    'Lender: {lender}. SANDBOX: no real credit is given and nothing is reported to a credit bureau.',
  'credit.receive_first': 'You receive it first and pay over time.',
  'credit.first_payment': 'First payment today: {amount}',
  'credit.deposit': 'Deposit today: {amount}',
  'credit.part':
    'Payment {seq} on {date}: {amount} ({principal} towards the price, {interest} interest)',
  'credit.part_no_interest': 'Payment {seq} on {date}: {amount}',
  'credit.cost_none': 'No interest and no fees if you pay on time.',
  'credit.cost':
    'Interest: {amount} in total, charged only on what you still owe, at {daily} a day.',
  'credit.apr':
    'Annual percentage rate (APR): {apr}. The law asks us to show it; it is the daily rate times 365.',
  'credit.total': 'Total you will pay: {amount}',
  'credit.late':
    'If a payment is more than {days} days late, a late charge of {fee} is added, never more than {cap} in total.',
  'credit.early': 'You can pay early at any time, free, and then pay interest only up to that day.',
  'credit.kid': 'Key information document, version {version}',
  'credit.agreement': 'Credit agreement, version {version}',
  'credit.check_title': 'Check if you can use this plan',
  'credit.income_label': 'Your monthly income, in {currency}',
  'credit.income_why':
    'We ask so that no single payment is more than a fair share of your income. It is used for this decision only.',
  'credit.bureau_label':
    'Also check my repayment history with a credit bureau (optional; SANDBOX: a simulator).',
  'credit.bureau_terms': 'What this check means, version {version}',
  'credit.check_button': 'Check this plan',
  'credit.sign_in': 'Sign in to check this plan.',
  'credit.approved': 'You can use this plan.',
  'credit.declined': 'You cannot use this plan right now. Nothing was charged.',
  'credit.declined_other_ways':
    'You can still buy this item another way: on layaway if the listing offers it, or by paying in full.',
  'credit.expires': 'This answer is valid until {date}.',
  'credit.spread_up_to': 'You can spread up to {amount} across your KELO plans.',
  'credit.spread_in_use': '{amount} of it is in use by plans you are paying off.',
  'credit.grows': 'It grows each time you repay a plan on time.',
  'credit.limit_title': 'How much you can spread',
  'credit.agree': 'Agree and pay {amount} now',
  'credit.agree_terms':
    'By agreeing you accept the credit agreement and the key information document above.',
  'credit.status.pending_first_payment': 'Waiting for your first payment',
  'credit.status.active': 'In progress',
  'credit.status.paid_off': 'Paid off',
  'credit.status.cancelled': 'Cancelled',
  'credit.status.defaulted': 'Overdue',
  'credit.status.paused': 'Paused',
  'credit.left': 'Left to pay: {amount}',
  'credit.pay_due': 'Pay {amount} now',
  'credit.pay_early_title': 'Pay early',
  'credit.pay_off': 'Pay everything now: {amount}',
  'credit.pay_off_detail':
    'That is {principal} still owed on the price, {charges} in late charges and {interest} in interest so far. You save {saved} in interest, and there is no penalty.',
  'credit.pay_next_early': 'Pay the next payment now: {amount}',
  'credit.statement': 'See the statement',
  'credit.statement_title': 'Statement: {item}',
  'credit.statement_paid':
    'Paid so far: {principal} towards the price, {charges} in late charges, {interest} in interest.',
  'credit.statement_saved': 'Interest you did not pay because you paid early: {amount}',
  'credit.statement_left': 'Still to pay: {amount}',
  'credit.statement_repayment': '{date}: {amount} ({status})',
  'credit.late_charge': 'Late charge: {amount}',
  'instalment.status.late': 'Late',
  'claim.title': 'Something wrong?',
  'claim.return': 'Ask to return it',
  'claim.dispute': 'Report a problem with this purchase',
  'claim.reason_label': 'What happened',
  'claim.details_label':
    'Tell us more (optional). Describe the item or delivery only; do not include health information.',
  'claim.send': 'Send',
  'claim.paused':
    'Your plan is paused while this is looked at: no payments are due, no reminders are sent and no late charges are added.',
  'claim.withdraw': 'Withdraw this request',
  'claim.status.open': 'Open',
  'claim.status.accepted': 'Accepted: everything you paid is being refunded',
  'claim.status.rejected': 'Not accepted: {reason}',
  'claim.status.withdrawn': 'Withdrawn',
  'claim.reason.not_delivered': 'It has not arrived',
  'claim.reason.not_as_described': 'It is not as described',
  'claim.reason.faulty': 'It is faulty',
  'claim.reason.changed_mind': 'I changed my mind',
  'claim.reason.other': 'Something else',
  'purchases.status.return_requested': 'Return requested',
  'purchases.status.returned': 'Returned',
  'purchases.status.disputed': 'Being looked at',
  'instalment.status.paused': 'Paused',
  'error.generic': 'Something went wrong. Please try again.',
};

const LOCALES: Record<string, Messages> = { en: EN };

/** The message for a key, with `{name}` placeholders filled in. */
export function t(key: string, values: Record<string, string> = {}, locale = 'en'): string {
  const template = LOCALES[locale]?.[key] ?? EN[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => values[name] ?? '');
}

/** Dates in Nairobi time, formatted by the locale, never by hand. */
export function formatDate(iso: string, locale = 'en-KE'): string {
  return new Date(iso).toLocaleString(locale, {
    timeZone: 'Africa/Nairobi',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
