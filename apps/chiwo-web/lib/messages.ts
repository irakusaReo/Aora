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
  'nav.usdc': 'USDC',
  'nav.send': 'Send',
  'nav.requests': 'Requests',
  'nav.security': 'PIN',
  'security.title': 'Your PIN',
  'security.confirm_title': 'Confirm with your PIN',
  'security.confirm_help':
    'Sending money, confirming a person and withdrawing need a recent PIN confirmation. It lasts a few minutes.',
  'security.confirm': 'Confirm',
  'security.set_title': 'Set or change your PIN',
  'security.set_help':
    'Six digits, not all the same and not a straight run. You must have signed in within the last ten minutes.',
  'security.save': 'Save PIN',
  'security.ok_pin': 'Your PIN is set.',
  'security.ok_step_up': 'Confirmed. For the next few minutes you can send and withdraw.',
  'security.pin': 'PIN',
  'step_up.needed': 'Confirm with your PIN first, then try again.',
  'usdc.title': 'Your USDC (testnet)',
  'usdc.explain':
    'Testnet USDC on Base Sepolia. AORA holds it in its sandbox testnet wallet; your balance is a record in AORA’s books. It has no value.',
  'usdc.available': 'Available: {amount}',
  'usdc.in_flight': 'Being withdrawn: {amount}',
  'usdc.chain_off':
    'Receiving and withdrawing on chain are switched off here for now. Sending to people still works.',
  'usdc.receive_title': 'Receive on chain',
  'usdc.receive_help':
    'Register your own address first. Then send testnet USDC from it to the AORA wallet below. It counts after enough confirmations.',
  'usdc.wallet': 'AORA sandbox wallet: {address}',
  'usdc.register': 'Register an address',
  'usdc.sign_help':
    'Sign this message in your wallet (a personal signature). Signing moves no funds.',
  'usdc.address': 'Your address',
  'usdc.signature': 'Signature',
  'usdc.save_address': 'Register address',
  'usdc.addresses': 'Your addresses',
  'usdc.withdraw_title': 'Withdraw to your address',
  'usdc.withdraw_help': 'Completes only once confirmed on chain. Never sent twice.',
  'usdc.amount': 'Amount in USDC',
  'usdc.withdraw': 'Withdraw',
  'usdc.withdraw_started': 'Withdrawal started.',
  'send.title': 'Send USDC to a person',
  'send.find': 'Their phone number',
  'send.find_button': 'Find',
  'send.confirm_who': 'Is this the person? {name}',
  'send.confirm_button': 'Yes, confirm with my PIN',
  'send.people': 'People you can send to',
  'send.none': 'Nobody yet. Find someone by phone number.',
  'send.amount': 'Amount in USDC',
  'send.note': 'Note (optional)',
  'send.button': 'Send',
  'send.free': 'Free and instant, on AORA’s books. No chain transaction.',
  'send.sent': 'Sent.',
  'requests.title': 'Payment requests',
  'requests.new': 'Ask for USDC',
  'requests.payer': 'Their phone number (leave empty for a link anyone can pay)',
  'requests.create': 'Create request',
  'requests.empty': 'No requests yet.',
  'requests.from': 'From {name}',
  'requests.to': 'To {name}',
  'requests.anyone': 'Anyone with the link',
  'requests.link': 'Link: {link}',
  'requests.pay': 'Pay {amount}',
  'requests.cancel': 'Cancel',
  'requests.expires': 'Expires {date}',
  'requests.status.open': 'Open',
  'requests.status.paid': 'Paid',
  'requests.status.cancelled': 'Cancelled',
  'requests.status.expired': 'Expired',
  'activity.kind.merchant_payment': 'Shop payment',
  'activity.kind.transfer': 'Transfer',
  'activity.kind.deposit': 'Deposit',
  'activity.kind.withdrawal': 'Withdrawal',
  'nav.nam': 'NAM Vault',
  'nam.title': 'NAM Vault',
  'nam.position': 'Your position',
  'nam.position_help':
    'Three separate things: money set aside, orders on chain, and what you hold.',
  'nam.funding': 'Set aside (not yet in the vault)',
  'nam.shares': 'Vault shares held for you',
  'nam.value_now': 'What the vault would give back for them now',
  'nam.cost': 'What you put in, still held',
  'nam.about': 'About this product',
  'nam.control': 'Who controls the assets',
  'nam.owns': 'What you own',
  'nam.fees': 'Fees',
  'nam.fees_none': 'None',
  'nam.withdrawals': 'Taking money out',
  'nam.contract': 'Vault contract',
  'nam.add': 'Add USDC from your balance',
  'nam.accept': 'I have read this disclosure (version {version}) and act for myself.',
  'nam.accept_first': 'Read and confirm the disclosure first.',
  'nam.order': 'Place order',
  'nam.ok_order':
    'Order placed. The amount is set aside now; your holding appears once the vault deposit is confirmed on chain.',
  'nam.ok_redemption':
    'Redemption requested. The USDC returns to your balance once it is confirmed on chain.',
  'nam.redeem_title': 'Take USDC out',
  'nam.redeem_shares': 'Shares (leave empty for all)',
  'nam.redeem': 'Redeem',
  'nam.history': 'Orders and redemptions',
  'nam.order_row': 'Order',
  'nam.redemption_row': 'Redemption',
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
