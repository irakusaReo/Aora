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
