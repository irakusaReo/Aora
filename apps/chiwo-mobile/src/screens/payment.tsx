import type { ChiwoReceipt } from '@aora/api-client';
import {
  Body,
  Button,
  Card,
  exponentOf,
  money,
  Muted,
  ResourceView,
  Row,
  Screen,
  useAssets,
  useResource,
} from '@aora/mobile';
import { t } from '../messages';

/** A shop payment's state in plain words, and its receipt once final. Unknown is shown as "being checked". */
export function PaymentScreen({ paymentId }: { paymentId: string }): React.JSX.Element {
  const assets = useAssets();
  const receipt = useResource(`chiwo.receipt:${paymentId}`, (api) =>
    api.get<ChiwoReceipt>(`/v1/chiwo/receipts/merchant_payment/${paymentId}`),
  );
  return (
    <ResourceView resource={assets}>
      {(list) => (
        <ResourceView resource={receipt}>
          {(data) => {
            const show = (minor: string): string =>
              money(minor, data.currency, exponentOf(list, data.currency));
            return (
              <Screen title={t('payment.title', { merchant: data.merchant.trading_name })}>
                <Card>
                  <Body strong>{t(`payment.status.${data.status}`)}</Body>
                  <Muted>{t(`payment.explain.${data.status}`)}</Muted>
                  <Row label={t('pay.amount')} value={show(data.amount_minor)} />
                  <Row
                    label={t('pay.fee')}
                    value={data.fee_minor === '0' ? t('pay.fee_none') : show(data.fee_minor)}
                  />
                  <Row label={t('pay.total')} value={show(data.total_minor)} />
                  <Row label={t('receipt.reference')} value={data.reference} />
                  <Row label={t('receipt.code')} value={data.merchant.code} />
                  <Row
                    label={t('receipt.when')}
                    value={new Date(data.created_at).toLocaleString('en-KE', {
                      timeZone: 'Africa/Nairobi',
                    })}
                  />
                  <Button label={t('payment.refresh')} onPress={receipt.reload} secondary />
                </Card>
              </Screen>
            );
          }}
        </ResourceView>
      )}
    </ResourceView>
  );
}
