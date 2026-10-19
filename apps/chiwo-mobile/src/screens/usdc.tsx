import type { ChiwoUsdc } from '@aora/api-client';
import {
  Body,
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

/** The person's USDC balance, with the token's own decimals; on-chain set-up stays on the web. */
export function UsdcScreen(): React.JSX.Element {
  const usdc = useResource('chiwo.usdc', (api) => api.get<ChiwoUsdc>('/v1/chiwo/usdc'));
  return (
    <Screen title={t('usdc.title')}>
      <ResourceView resource={usdc}>
        {(data) => {
          const show = (minor: string): string =>
            money(minor, data.asset.code, data.asset.decimals);
          return (
            <>
              <Card>
                <Muted>{t('usdc.explain')}</Muted>
                <Row label={t('usdc.available')} value={show(data.balances.available_minor)} />
                <Row
                  label={t('usdc.in_flight')}
                  value={show(data.balances.withdrawals_in_flight_minor)}
                />
              </Card>
              {data.deposit_address === null ? (
                <Muted>{t('usdc.chain_off')}</Muted>
              ) : (
                <Card>
                  <Heading>{t('usdc.wallet')}</Heading>
                  <Body>{data.deposit_address}</Body>
                  <Muted>{data.network.label}</Muted>
                </Card>
              )}
              {data.addresses.length > 0 && (
                <Card>
                  <Heading>{t('usdc.addresses')}</Heading>
                  {data.addresses.map((address) => (
                    <Muted key={address.id}>
                      {address.label ? `${address.label}: ` : ''}
                      {address.address}
                    </Muted>
                  ))}
                </Card>
              )}
              <WebOnly what={t('usdc.web_only')} />
            </>
          );
        }}
      </ResourceView>
    </Screen>
  );
}
