import type { KeloCreditStatement } from '@aora/api-client';
import {
  Body,
  Card,
  exponentOf,
  money,
  Muted,
  ResourceView,
  Screen,
  useAssets,
  useResource,
} from '@aora/mobile';
import { formatDate, t } from '../messages';

/** A credit agreement's statement: every figure from the API's ledger-backed totals. */
export function StatementScreen({ purchaseId }: { purchaseId: string }): React.JSX.Element {
  const assets = useAssets();
  const statement = useResource(`kelo.statement:${purchaseId}`, (api) =>
    api.get<KeloCreditStatement>(`/v1/kelo/me/purchases/${purchaseId}/credit/statement`),
  );
  return (
    <Screen title={t('statement.back')}>
      <ResourceView resource={assets}>
        {(list) => (
          <ResourceView resource={statement}>
            {(data) => {
              const show = (minor: string): string =>
                money(minor, data.currency, exponentOf(list, data.currency));
              return (
                <>
                  <Card>
                    <Body>
                      {t('credit.statement_paid', {
                        principal: show(data.totals.paid_principal_minor),
                        charges: show(data.totals.paid_charges_minor),
                        interest: show(data.totals.paid_interest_minor),
                      })}
                    </Body>
                    <Body>
                      {t('credit.statement_saved', {
                        amount: show(data.totals.waived_interest_minor),
                      })}
                    </Body>
                    <Body strong>
                      {t('credit.statement_left', { amount: show(data.totals.outstanding_minor) })}
                    </Body>
                    <Muted>
                      {t('credit.sandbox_lender', { lender: data.agreement.lender_of_record })}
                    </Muted>
                  </Card>
                  {data.repayments.map((row) => (
                    <Muted key={row.id}>
                      {t('credit.statement_repayment', {
                        date: formatDate(row.created_at),
                        amount: show(row.amount_minor),
                        status: row.status,
                      })}
                    </Muted>
                  ))}
                </>
              );
            }}
          </ResourceView>
        )}
      </ResourceView>
    </Screen>
  );
}
