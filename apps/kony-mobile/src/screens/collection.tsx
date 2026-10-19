import { type Me, type PaymentIntent, toMinorUnits } from '@aora/api-client';
import {
  Body,
  Button,
  Card,
  ErrorText,
  exponentOf,
  Heading,
  money,
  MoneyActionView,
  Muted,
  ResourceView,
  Row,
  Screen,
  TextField,
  useAssets,
  useMoneyAction,
  useResource,
} from '@aora/mobile';
import { useState } from 'react';
import { EN, statusLabel, t } from '../messages';

/** One collection: its state in plain words, gross, fee and net, and a refund for finance and admin. */
export function CollectionScreen({
  workspaceId,
  intentId,
}: {
  workspaceId: string;
  intentId: string;
}): React.JSX.Element {
  const assets = useAssets();
  const me = useResource('me', (api) => api.get<Me>('/v1/me'));
  const intent = useResource(
    `payment-intent:${intentId}`,
    (api) => api.get<PaymentIntent>(`/v1/payment-intents/${intentId}`),
    workspaceId,
  );
  const role =
    me.status === 'ready'
      ? me.data.memberships.find((entry) => entry.workspace_id === workspaceId)?.role
      : undefined;
  return (
    <Screen title={t('collection.title')}>
      <ResourceView resource={assets}>
        {(list) => (
          <ResourceView resource={intent}>
            {(data) => {
              const exponent = exponentOf(list, data.currency);
              const show = (minor: string): string => money(minor, data.currency, exponent);
              const explain = `explain.${data.status}`;
              return (
                <>
                  <Card>
                    <Body strong>{statusLabel(data.status)}</Body>
                    {explain in EN ? <Muted>{t(explain)}</Muted> : null}
                    <Row label={t('collection.gross')} value={show(data.amount_minor)} />
                    <Row label={t('collection.fee')} value={show(data.fee_minor)} />
                    <Row label={t('collection.net')} value={show(data.net_minor)} />
                    {data.reference ? (
                      <Row label={t('collection.reference')} value={data.reference} />
                    ) : null}
                    <Row
                      label={t('collection.when')}
                      value={new Date(data.created_at).toLocaleString('en-KE')}
                    />
                    <Button label={t('collection.refresh')} onPress={intent.reload} secondary />
                  </Card>
                  {role !== undefined &&
                    role !== 'cashier' &&
                    data.status === 'succeeded' &&
                    data.provider === 'sandbox_sim' && (
                      <RefundForm workspaceId={workspaceId} intent={data} exponent={exponent} />
                    )}
                </>
              );
            }}
          </ResourceView>
        )}
      </ResourceView>
    </Screen>
  );
}

function RefundForm({
  workspaceId,
  intent,
  exponent,
}: {
  workspaceId: string;
  intent: PaymentIntent;
  exponent: number;
}): React.JSX.Element {
  const [amount, setAmount] = useState('');
  const minor = toMinorUnits(amount, exponent);
  const refund = useMoneyAction({
    slot: minor ? `kony.refund:${intent.id}:${minor}` : null,
    workspaceId,
    run: (api, key) =>
      api.post(
        `/v1/payment-intents/${intent.id}/refunds`,
        { amount_minor: minor, sandbox_scenario: 'success' },
        key,
      ),
  });
  return (
    <Card>
      <Heading>{t('collection.refund_title')}</Heading>
      <Muted>{t('collection.refund_help')}</Muted>
      <TextField
        label={t('collection.refund_amount', { currency: intent.currency })}
        value={amount}
        onChangeText={setAmount}
        numeric
      />
      {amount !== '' && !minor ? <ErrorText>{t('collect.bad_amount')}</ErrorText> : null}
      {refund.state === 'done' ? (
        <Body>{t('collection.refunded')}</Body>
      ) : (
        <Button
          label={t('collection.refund', {
            amount: minor ? money(minor, intent.currency, exponent) : intent.currency,
          })}
          onPress={refund.start}
          disabled={!minor || refund.state === 'working'}
        />
      )}
      <MoneyActionView action={refund} />
    </Card>
  );
}
