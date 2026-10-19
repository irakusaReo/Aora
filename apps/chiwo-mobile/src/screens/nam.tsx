import type { NamOverview } from '@aora/api-client';
import {
  Card,
  Heading,
  money,
  Muted,
  ResourceView,
  Row,
  Screen,
  useResource,
  WebOnly,
} from '@aora/mobile';
import { t } from '../messages';

/** The personal NAM position: funding, shares and holding kept apart (J13). No yield figure anywhere. */
export function NamScreen(): React.JSX.Element {
  const nam = useResource('chiwo.nam', (api) => api.get<NamOverview>('/v1/chiwo/nam'));
  const usdc = useResource('chiwo.usdc', (api) =>
    api.get<{ asset: { code: string; decimals: number } }>('/v1/chiwo/usdc'),
  );
  return (
    <Screen title={t('nam.title')}>
      <ResourceView resource={usdc}>
        {(balance) => (
          <ResourceView resource={nam}>
            {(data) => {
              const show = (minor: string): string =>
                money(minor, balance.asset.code, balance.asset.decimals);
              return (
                <>
                  <Card>
                    <Muted>{t('nam.position_help')}</Muted>
                    <Row label={t('nam.funding')} value={show(data.funding_pending_minor)} />
                    <Row label={t('nam.shares')} value={data.holding.shares} />
                    <Row
                      label={t('nam.value_now')}
                      value={show(data.holding.current_value_minor)}
                    />
                    <Row label={t('nam.cost')} value={show(data.holding.cost_minor)} />
                  </Card>
                  <Card>
                    <Heading>{t('nam.about')}</Heading>
                    <Muted>{data.product.name}</Muted>
                    <Row label={t('nam.control')} value={data.product.asset_control} />
                    <Row label={t('nam.owns')} value={data.product.customer_owns} />
                    <Row
                      label={t('nam.fees')}
                      value={
                        data.product.fee_bps === 0
                          ? t('nam.fees_none')
                          : `${String(data.product.fee_bps)} bps`
                      }
                    />
                    <Row label={t('nam.withdrawals')} value={data.product.withdrawal_terms} />
                  </Card>
                  <WebOnly what={t('nam.web_only')} />
                </>
              );
            }}
          </ResourceView>
        )}
      </ResourceView>
    </Screen>
  );
}
