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
