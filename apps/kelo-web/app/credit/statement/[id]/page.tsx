import {
  formatMinor,
  type KeloCreditStatement,
  type KeloPurchase,
  type List,
} from '@aora/api-client';
import { notFound } from 'next/navigation';
import { api, exponentOf, isNotFound } from '../../../../lib/api';
import { formatDate, t } from '../../../../lib/messages';

/** A free statement of one credit plan, always available to the borrower (r. 39, r. 47(2)). */
export default async function CreditStatementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const client = await api();
  let statement: KeloCreditStatement;
  let purchase: KeloPurchase;
  try {
    [statement, purchase] = await Promise.all([
      client.get<KeloCreditStatement>(
        `/v1/kelo/me/purchases/${encodeURIComponent(id)}/credit/statement`,
      ),
      client.get<KeloPurchase>(`/v1/kelo/me/purchases/${encodeURIComponent(id)}`),
    ]);
  } catch (error) {
    if (isNotFound(error)) notFound();
    throw error;
  }
  const assets = await client.get<List<{ code: string; exponent: number }>>('/v1/assets');
  const money = (minor: string): string =>
    `${statement.currency} ${formatMinor(minor, exponentOf(assets.data, statement.currency))}`;
  const agreement = statement.agreement;
  return (
    <>
      <h1>{t('credit.statement_title', { item: purchase.listing_title })}</h1>
      <div className="card">
        <p>
          <span className="pill">{t(`credit.status.${agreement.status}`)}</span>
        </p>
        <p className="muted">
          {t('credit.sandbox_lender', { lender: agreement.lender_of_record })}
        </p>
        <p>{t('plan.price', { amount: money(agreement.price_minor) })}</p>
        <p>
          <strong>{t('credit.total', { amount: money(agreement.total_payable_minor) })}</strong>
        </p>
        <p>
          {t('credit.statement_paid', {
            principal: money(statement.totals.paid_principal_minor),
            charges: money(statement.totals.paid_charges_minor),
            interest: money(statement.totals.paid_interest_minor),
          })}
        </p>
        <p>
          {t('credit.statement_saved', { amount: money(statement.totals.waived_interest_minor) })}
        </p>
        <p>
          <strong>
            {t('credit.statement_left', { amount: money(statement.totals.outstanding_minor) })}
          </strong>
        </p>
      </div>
      <div className="card">
        <ol style={{ listStyle: 'none', padding: 0 }}>
          {agreement.instalments.map((line) => (
            <li key={line.seq}>
              {line.due_on}: {money(line.amount_minor)}{' '}
              <span className="pill">{t(`instalment.status.${line.status}`)}</span>
              {line.late_charges_minor !== '0' && (
                <> {t('credit.late_charge', { amount: money(line.late_charges_minor) })}</>
              )}
            </li>
          ))}
        </ol>
      </div>
      <div className="card">
        <ul>
          {statement.repayments.map((repayment) => (
            <li key={repayment.id}>
              {t('credit.statement_repayment', {
                date: formatDate(repayment.created_at),
                amount: money(repayment.amount_minor),
                status: repayment.status,
              })}
            </li>
          ))}
        </ul>
        <p className="muted">
          <a href={`/terms/${agreement.documents.agreement.key}`}>
            {t('credit.agreement', { version: agreement.documents.agreement.version })}
          </a>
          {' · '}
          <a href={`/terms/${agreement.documents.kid.key}`}>
            {t('credit.kid', { version: agreement.documents.kid.version })}
          </a>
        </p>
      </div>
    </>
  );
}
