import type { KeloPurchase } from '@aora/api-client';
import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { t } from '../../lib/messages';

/**
 * A credit purchase in the purchases hub: its parts paid and to come, what is
 * left, and the next due part. Paying early and reporting a return arrive in 8B and 8C.
 */
export function CreditPurchaseCard({
  purchase,
  money,
  act,
  today,
}: {
  purchase: KeloPurchase & { credit: NonNullable<KeloPurchase['credit']> };
  money: (minor: string) => string;
  act: (form: FormData) => Promise<void>;
  today: string;
}): React.JSX.Element {
  const credit = purchase.credit;
  const open = credit.instalments.filter(
    (line) => line.status !== 'paid' && line.status !== 'cancelled',
  );
  const next = open[0];
  // Each part's amount less what was paid on it: figures from the API, summed exactly.
  const left = open
    .reduce((sum, line) => sum + BigInt(line.amount_minor) - BigInt(line.paid_minor), 0n)
    .toString();
  const payable =
    next !== undefined &&
    next.status !== 'pending' &&
    (credit.status === 'pending_first_payment' ||
      (credit.status === 'active' && next.due_on <= today));
  const hidden = <input type="hidden" name="purchase_id" value={purchase.id} />;
  return (
    <div className="card">
      <p>
        <Link href={`/l/${purchase.listing_id}`}>
          <strong>{purchase.listing_title}</strong>
        </Link>{' '}
        <span className="pill">{t(`credit.status.${credit.status}`)}</span>{' '}
        <span className="pill">{t(`purchases.status.${purchase.status}`)}</span>
      </p>
      <p className="muted">{t('credit.sandbox_lender', { lender: credit.lender_of_record })}</p>
      <ol style={{ listStyle: 'none', padding: 0 }}>
        {credit.instalments.map((line) => (
          <li key={line.seq}>
            {line.due_on}: {money(line.amount_minor)}{' '}
            <span className="pill">{t(`instalment.status.${line.status}`)}</span>
          </li>
        ))}
      </ol>
      <p>
        <strong>{t('credit.total', { amount: money(credit.total_payable_minor) })}</strong>
      </p>
      {next && <p className="muted">{t('credit.left', { amount: money(left) })}</p>}
      {next?.status === 'pending' && <p className="muted">{t('purchases.checking')}</p>}
      {payable && (
        <form action={act} className="stack">
          {hidden}
          <input type="hidden" name="action" value="pay_credit" />
          <input type="hidden" name="seq" value={next.seq} />
          <input type="hidden" name="pay_key" value={randomUUID()} />
          <fieldset>
            <legend>{t('checkout.rail_label')}</legend>
            <label style={{ display: 'block' }}>
              <input type="radio" name="rail" value="simulator" required />{' '}
              {t('checkout.rail_simulator')}
            </label>
            <label style={{ display: 'block' }}>
              <input type="radio" name="rail" value="mpesa" required /> {t('checkout.rail_mpesa')}
            </label>
          </fieldset>
          <button type="submit">{t('credit.pay_due', { amount: money(next.amount_minor) })}</button>
        </form>
      )}
      {credit.status === 'active' && <p className="muted">{t('credit.early_soon')}</p>}
      {credit.status === 'active' && purchase.status === 'merchant_confirmed' && (
        <form action={act}>
          {hidden}
          <input type="hidden" name="action" value="confirm_delivery" />
          <button type="submit">{t('purchases.confirm_delivery')}</button>
        </form>
      )}
      {purchase.refund && (
        <p>
          {t('purchases.refund', {
            refund: money(purchase.refund.refund_minor),
            paid: money(purchase.refund.paid_minor),
            fee: money(purchase.refund.fee_minor),
            status: purchase.refund.status,
          })}
        </p>
      )}
      {['placed', 'payment_ready', 'merchant_confirmed'].includes(purchase.status) && (
        <form action={act}>
          {hidden}
          <input type="hidden" name="action" value="cancel" />
          <button type="submit" className="secondary">
            {t('purchases.cancel')}
          </button>
        </form>
      )}
    </div>
  );
}
