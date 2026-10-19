// Every word CHIWO shows, keyed by locale. Whole sentences with named
// placeholders, so each can be translated into Swahili as written.

type Messages = Record<string, string>;

const EN: Messages = {
  'app.name': 'CHIWO',
  'app.tagline': 'Pay shops and people from your phone number.',
  'nav.home': 'Activity',
  'nav.pay': 'Pay a shop',
  'home.signed_out':
    'Sign in with your email to try CHIWO. This is a sandbox: no real money moves.',
  'home.activity': 'Your activity',
  'home.empty': 'Nothing yet. Pay a shop to see it here.',
  'signup.title': 'Open your CHIWO account',
  'signup.personal':
    'CHIWO is personal. It is separate from any business you work for: your role at a business gives you nothing here, and nothing you do here acts for a business.',
  'signup.phone_title': 'Your phone number',
  'signup.phone_help':
    'Your phone number is your payment identity. It is not used to sign in. Use a made-up number in the sandbox.',
  'signup.phone_save': 'Save phone number',
  'signup.terms': 'I have read and accept the CHIWO terms, version {version}.',
  'signup.read_terms': 'Read the terms',
  'signup.agree': 'Open my account',
  'pay.title': 'Pay a shop',
  'pay.code_label': 'Shop pay code (8 characters, shown at the till)',
  'pay.amount_label': 'Amount in {currency}',
  'pay.review': 'Review payment',
  'pay.to': 'You are paying {merchant}',
  'pay.amount': 'Amount: {amount}',
  'pay.fee_none': 'Fee you pay: none',
  'pay.fee': 'Fee you pay: {amount}',
  'pay.total': 'Total: {amount}',
  'pay.timing': 'When: {timing}',
  'pay.rail_label': 'Pay with',
  'pay.rail_mpesa':
    "M-Pesa sandbox (the prompt goes to Safaricom's test number, not your phone, and is cancelled there)",
  'pay.rail_simulator': 'AORA simulator (sandbox: the payment succeeds; no real money)',
  'pay.confirm': 'Pay {amount}',
  'pay.change': 'Change',
  'pay.bad_amount': 'Enter an amount such as 150 or 150.50.',
  'payment.title': 'Payment to {merchant}',
  'payment.refresh': 'Refresh',
  'payment.status.submitted': 'Waiting for M-Pesa',
  'payment.status.being_checked': 'Being checked with M-Pesa',
  'payment.status.succeeded': 'Paid',
  'payment.status.failed': 'Not paid',
  'payment.status.reconciliation_required': 'Being checked by AORA',
  'payment.explain.submitted':
    'Approve the prompt on the paying phone. This page shows the result.',
  'payment.explain.being_checked':
    'M-Pesa has not answered yet. We are asking it; the payment will not be sent twice.',
  'payment.explain.succeeded': 'M-Pesa confirmed the payment. A receipt was emailed to you.',
  'payment.explain.failed': 'The payment did not go through. No money was taken.',
  'payment.explain.reconciliation_required':
    'The results we received disagree. Our team is checking it; nothing more is needed from you.',
  'receipt.reference': 'Reference: {reference}',
  'receipt.when': 'Date: {date}',
  'receipt.code': 'Pay code: {code}',
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
