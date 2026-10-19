import { formatMinorUnits } from '../../platform/money.js';

// Email templates (ADR 0020). Copy lives in the dictionary below, keyed by
// locale, as whole sentences with named placeholders: no sentence is built by
// joining fragments, so it can be translated (English now, Swahili-ready).

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

type Copy = Record<string, string>;
const COPY: Record<string, Copy> = {
  en: {
    'sandbox.banner':
      'SANDBOX — this is a test message from AORA. No real money has moved and no real account is involved.',
    'sandbox.subject_prefix': '[SANDBOX]',
    'footer.no_action':
      'AORA will never ask you to reply with a code or PIN, and no link in an AORA email can approve a payment.',
    'payment.received.subject': 'Payment received: {amount}',
    'payment.received.body': 'A payment of {amount} was received. Reference ending {reference}.',
    'payment.received.where': 'Open AORA and sign in to see the details.',
    'workspace.invitation.subject': 'You have been invited to {workspace}',
    'workspace.invitation.body':
      'You have been invited to join {workspace} on AORA as {role}. Open AORA and sign in with this email address to accept or ignore the invitation.',
    'kelo.store.ready.subject': 'Your KELO store {store} is ready',
    'kelo.store.ready.body':
      'Your KELO store {store} has been approved and is linked to your KONY workspace. Open KONY and sign in to add your first listing. Being an administrator of the workspace does not by itself let anyone pay out money.',
    'chiwo.payment.receipt.subject': 'You paid {amount} to {merchant}',
    'chiwo.payment.receipt.body':
      'Your payment of {amount} to {merchant} was confirmed by the provider. Receipt reference ending {reference}.',
    'chiwo.payment.receipt.where': 'Open CHIWO and sign in to see the receipt.',
    'chiwo.usdc.received.subject': 'You received {amount}',
    'chiwo.usdc.received.body':
      '{sender} sent you {amount} (testnet USDC) in CHIWO. Reference ending {reference}.',
    'chiwo.usdc.received.where': 'Open CHIWO and sign in to see it.',
    'kelo.credit.reminder.upcoming.subject': 'KELO: {amount} due on {date}',
    'kelo.credit.reminder.upcoming.body':
      'Your KELO payment {seq} for {item} is {amount}, due on {date}. You can pay early at any time, with no penalty.',
    'kelo.credit.reminder.overdue.subject': 'KELO: a payment of {amount} is overdue',
    'kelo.credit.reminder.overdue.body':
      'Your KELO payment {seq} for {item}, due on {date}, has not been paid. It is now {amount}, including a late charge of {charge}. Late charges on this plan can never be more than {cap} in total.',
    'kelo.credit.reminder.help':
      'Open KELO and sign in to pay, or to get help if you cannot pay on time. SANDBOX: the lender is simulated and not licensed.',
    'kelo.credit.receipt.subject': 'KELO: payment of {amount} received',
    'kelo.credit.receipt.body':
      'We received your payment of {amount} for {item}: {principal} towards the price, {charges} in late charges and {interest} in interest. Receipt reference ending {reference}.',
    'kelo.credit.receipt.where': 'Open KELO and sign in to see your statement.',
    'sign_in.footer': 'If you did not try to sign in, you can ignore this email.',
  },
};

function copy(locale: string, key: string, values: Record<string, string> = {}): string {
  const template = COPY[locale]?.[key] ?? COPY['en']?.[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => values[name] ?? '');
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** `jane.doe@example.com` → `j•••@example.com`. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 1 ? '•••' : `${email.charAt(0)}•••${email.slice(at)}`;
}

/** Last three digits only. */
export function maskPhone(phone: string | null | undefined): string {
  return phone ? `•••${phone.slice(-3)}` : '';
}

function layout(
  locale: string,
  subject: string,
  bodyHtml: string,
  bodyText: string,
): RenderedEmail {
  const banner = copy(locale, 'sandbox.banner');
  const footer = copy(locale, 'footer.no_action');
  return {
    // Every message from a non-live environment says so, in the subject and the body.
    subject: `${copy(locale, 'sandbox.subject_prefix')} ${subject}`,
    html: [
      '<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto">',
      `<p style="background:#fff3cd;color:#664d03;padding:12px;border-radius:6px;font-weight:600">${escapeHtml(banner)}</p>`,
      bodyHtml,
      `<p style="color:#666;font-size:13px">${escapeHtml(footer)}</p>`,
      '</div>',
    ].join(''),
    text: `${banner}\n\n${bodyText}\n\n${footer}`,
  };
}

type Params = Record<string, unknown>;
const text = (params: Params, key: string): string =>
  typeof params[key] === 'string' ? params[key] : '';

const TEMPLATES: Record<string, (params: Params, locale: string) => RenderedEmail> = {
  // Transaction alert. Params: amount_minor, currency, exponent, reference.
  'payment.received': (params, locale) => {
    const exponent = typeof params['exponent'] === 'number' ? params['exponent'] : 2;
    const amount = `${text(params, 'currency')} ${formatMinorUnits(BigInt(text(params, 'amount_minor') || '0'), exponent)}`;
    const values = { amount, reference: text(params, 'reference').slice(-6) };
    const body = copy(locale, 'payment.received.body', values);
    const where = copy(locale, 'payment.received.where');
    return layout(
      locale,
      copy(locale, 'payment.received.subject', values),
      `<p>${escapeHtml(body)}</p><p>${escapeHtml(where)}</p>`,
      `${body}\n${where}`,
    );
  },
  // CHIWO receipt for a confirmed payment to a merchant (phase-7 P7-13).
  // Params: amount_minor, currency, exponent, merchant, reference.
  'chiwo.payment.receipt': (params, locale) => {
    const exponent = typeof params['exponent'] === 'number' ? params['exponent'] : 2;
    const amount = `${text(params, 'currency')} ${formatMinorUnits(BigInt(text(params, 'amount_minor') || '0'), exponent)}`;
    const values = {
      amount,
      merchant: text(params, 'merchant'),
      reference: text(params, 'reference').slice(-6),
    };
    const body = copy(locale, 'chiwo.payment.receipt.body', values);
    const where = copy(locale, 'chiwo.payment.receipt.where');
    return layout(
      locale,
      copy(locale, 'chiwo.payment.receipt.subject', values),
      `<p>${escapeHtml(body)}</p><p>${escapeHtml(where)}</p>`,
      `${body}\n${where}`,
    );
  },
  // CHIWO: USDC received from another consumer (phase 7B). Params: amount_minor,
  // currency, exponent, sender (already masked), reference.
  'chiwo.usdc.received': (params, locale) => {
    const exponent = typeof params['exponent'] === 'number' ? params['exponent'] : 6;
    const amount = `${text(params, 'currency')} ${formatMinorUnits(BigInt(text(params, 'amount_minor') || '0'), exponent)}`;
    const values = {
      amount,
      sender: text(params, 'sender'),
      reference: text(params, 'reference').slice(-6),
    };
    const body = copy(locale, 'chiwo.usdc.received.body', values);
    const where = copy(locale, 'chiwo.usdc.received.where');
    return layout(
      locale,
      copy(locale, 'chiwo.usdc.received.subject', values),
      `<p>${escapeHtml(body)}</p><p>${escapeHtml(where)}</p>`,
      `${body}\n${where}`,
    );
  },
  // KELO credit reminder (phase 8B, P8-11; r. 30(1)): to the borrower only, no
  // link that acts, no threat. Params: kind, item, seq, due_on, amount_minor,
  // currency, exponent, and for overdue late_charge_minor, late_charge_cap_minor.
  'kelo.credit.reminder': (params, locale) => {
    const exponent = typeof params['exponent'] === 'number' ? params['exponent'] : 2;
    const money = (key: string): string =>
      `${text(params, 'currency')} ${formatMinorUnits(BigInt(text(params, key) || '0'), exponent)}`;
    const kind = text(params, 'kind') === 'overdue' ? 'overdue' : 'upcoming';
    const values = {
      amount: money('amount_minor'),
      date: text(params, 'due_on'),
      item: text(params, 'item'),
      seq: typeof params['seq'] === 'number' ? String(params['seq']) : '',
      charge: money('late_charge_minor'),
      cap: money('late_charge_cap_minor'),
    };
    const body = copy(locale, `kelo.credit.reminder.${kind}.body`, values);
    const help = copy(locale, 'kelo.credit.reminder.help');
    return layout(
      locale,
      copy(locale, `kelo.credit.reminder.${kind}.subject`, values),
      `<p>${escapeHtml(body)}</p><p>${escapeHtml(help)}</p>`,
      `${body}\n${help}`,
    );
  },
  // KELO credit repayment receipt (r. 39). Params: item, amount_minor,
  // principal_minor, charges_minor, interest_minor, currency, exponent, reference.
  'kelo.credit.receipt': (params, locale) => {
    const exponent = typeof params['exponent'] === 'number' ? params['exponent'] : 2;
    const money = (key: string): string =>
      `${text(params, 'currency')} ${formatMinorUnits(BigInt(text(params, key) || '0'), exponent)}`;
    const values = {
      amount: money('amount_minor'),
      principal: money('principal_minor'),
      charges: money('charges_minor'),
      interest: money('interest_minor'),
      item: text(params, 'item'),
      reference: text(params, 'reference').slice(-6),
    };
    const body = copy(locale, 'kelo.credit.receipt.body', values);
    const where = copy(locale, 'kelo.credit.receipt.where');
    return layout(
      locale,
      copy(locale, 'kelo.credit.receipt.subject', values),
      `<p>${escapeHtml(body)}</p><p>${escapeHtml(where)}</p>`,
      `${body}\n${where}`,
    );
  },
  // Staff invitation. Params: workspace_name, role. Carries nothing that could accept it.
  'workspace.invitation': (params, locale) => {
    const values = { workspace: text(params, 'workspace_name'), role: text(params, 'role') };
    const body = copy(locale, 'workspace.invitation.body', values);
    return layout(
      locale,
      copy(locale, 'workspace.invitation.subject', values),
      `<p>${escapeHtml(body)}</p>`,
      body,
    );
  },
  // KELO store provisioned (ADR 0008, last step). Params: store_name.
  'kelo.store.ready': (params, locale) => {
    const values = { store: text(params, 'store_name') };
    const body = copy(locale, 'kelo.store.ready.body', values);
    return layout(
      locale,
      copy(locale, 'kelo.store.ready.subject', values),
      `<p>${escapeHtml(body)}</p>`,
      body,
    );
  },
};

export function renderNotification(type: string, params: Params, locale: string): RenderedEmail {
  const template = TEMPLATES[type];
  if (!template) throw new Error(`No email template for notification type ${type}.`);
  return template(params, locale);
}

/**
 * Wraps a sign-in message prepared by the identity provider in AORA's sandbox
 * layout. The provider's content is passed through as-is; it contains the
 * one-time code, which is why this result is sent and never stored.
 */
export function renderSignInEmail(
  provided: { subject: string; html: string; text: string },
  locale = 'en',
): RenderedEmail {
  const footer = copy(locale, 'sign_in.footer');
  return layout(
    locale,
    provided.subject,
    `${provided.html}<p>${escapeHtml(footer)}</p>`,
    `${provided.text}\n\n${footer}`,
  );
}
