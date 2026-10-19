import type { Balance, List, Settlement } from '@aora/api-client';
import {
  Card,
  exponentOf,
  Heading,
  money,
  Muted,
  ResourceView,
  Row,
  Screen,
  useAssets,
  useResource,
} from '@aora/mobile';
import { EN, t } from '../messages';

/** KES balances by type, never added together (CLAUDE.md rule 5), and settlements. */
export function MoneyScreen({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const assets = useAssets();
  const balances = useResource(
    `balances:${workspaceId}`,
    (api) => api.get<List<Balance>>('/v1/ledger/balances'),
    workspaceId,
  );
  const settlements = useResource(
    `settlements:${workspaceId}`,
    (api) => api.get<List<Settlement>>('/v1/settlements'),
    workspaceId,
  );
  return (
    <Screen title={t('money.title')}>
      <ResourceView resource={assets}>
        {(list) => {
          const show = (minor: string, code: string): string =>
            money(minor, code, exponentOf(list, code));
          return (
            <>
              <Heading>{t('money.balances')}</Heading>
              <ResourceView resource={balances}>
                {(data) => (
                  <Card>
                    {data.data
                      .filter((row) => `balance.${row.account_type}` in EN)
                      .map((row) => (
                        <Row
                          key={`${row.account_type}:${row.currency}`}
                          label={t(`balance.${row.account_type}`)}
                          value={show(row.balance_minor, row.currency)}
                        />
                      ))}
                    <Muted>{t('money.separate')}</Muted>
                  </Card>
                )}
              </ResourceView>
              <Heading>{t('money.settlements')}</Heading>
              <ResourceView resource={settlements}>
                {(data) =>
                  data.data.length === 0 ? (
                    <Muted>{t('money.no_settlements')}</Muted>
                  ) : (
                    data.data.map((batch) => (
                      <Card key={batch.id}>
                        <Muted>
                          {new Date(batch.created_at).toLocaleString('en-KE')} ·{' '}
                          {t('money.settlement_item', { count: String(batch.collections) })}
                        </Muted>
                        <Row
                          label={t('collection.gross')}
                          value={show(batch.gross_minor, batch.currency)}
                        />
                        <Row
                          label={t('collection.fee')}
                          value={show(batch.fee_minor, batch.currency)}
                        />
                        <Row
                          label={t('collection.net')}
                          value={show(batch.net_minor, batch.currency)}
                        />
                      </Card>
                    ))
                  )
                }
              </ResourceView>
            </>
          );
        }}
      </ResourceView>
    </Screen>
  );
}
