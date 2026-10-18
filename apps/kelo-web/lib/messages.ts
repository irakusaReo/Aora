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
  'listing.ways_to_pay_soon':
    'Ways to pay will show here, each with every payment and the total you will pay, before you agree to anything.',
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
