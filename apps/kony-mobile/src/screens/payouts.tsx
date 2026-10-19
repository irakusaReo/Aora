import {
  AoraApiError,
  type List,
  type Payout,
  type PayoutQuote,
  type PayoutRecipient,
  toMinorUnits,
} from '@aora/api-client';
import {
  Body,
  Button,
  Card,
  Choice,
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
  useServices,
  WebOnly,
} from '@aora/mobile';
import { useState } from 'react';
import { statusLabel, t } from '../messages';

const CURRENCY = 'KES';

/** Pay out with the fee shown first (J6). The API requires a PIN and the finance or admin role. */
export function PayoutsScreen({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const assets = useAssets();
  const recipients = useResource(
    `payout-recipients:${workspaceId}`,
    (api) => api.get<List<PayoutRecipient>>('/v1/payout-recipients'),
    workspaceId,
  );
  const payouts = useResource(
    `payouts:${workspaceId}`,
    (api) => api.get<List<Payout>>('/v1/payouts'),
    workspaceId,
  );
  return (
    <Screen title={t('payouts.title')}>
      <ResourceView resource={assets}>
        {(list) => (
          <ResourceView resource={recipients}>
            {(people) => {
              const exponent = exponentOf(list, CURRENCY);
              const name = new Map(people.data.map((r) => [r.id, `${r.label} (${r.phone_hint})`]));
              const confirmed = people.data.filter((r) => r.status === 'confirmed');
              return (
                <>
                  {confirmed.length === 0 ? (
                    <WebOnly what={t('payouts.no_recipient')} />
                  ) : (
                    <PayoutForm
                      workspaceId={workspaceId}
                      recipients={confirmed}
                      exponent={exponent}
                      onSent={payouts.reload}
                    />
                  )}
                  <Heading>{t('payouts.history')}</Heading>
                  <ResourceView resource={payouts}>
                    {(data) =>
                      data.data.length === 0 ? (
                        <Muted>{t('payouts.empty')}</Muted>
                      ) : (
                        data.data.map((payout) => (
                          <Card key={payout.id}>
                            <Body>
                              {t('payouts.item', {
                                amount: money(payout.amount_minor, payout.currency, exponent),
                                recipient: name.get(payout.recipient_id) ?? '',
                                status: statusLabel(payout.status),
                              })}
                            </Body>
                            <Muted>{new Date(payout.created_at).toLocaleString('en-KE')}</Muted>
                          </Card>
                        ))
                      )
                    }
                  </ResourceView>
                </>
              );
            }}
          </ResourceView>
        )}
      </ResourceView>
    </Screen>
  );
}

function PayoutForm({
  workspaceId,
  recipients,
  exponent,
  onSent,
}: {
  workspaceId: string;
  recipients: PayoutRecipient[];
  exponent: number;
  onSent: () => void;
}): React.JSX.Element {
  const services = useServices();
  const [recipientId, setRecipientId] = useState(recipients[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<PayoutQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const show = (minor: string): string => money(minor, CURRENCY, exponent);
  const recipient = recipients.find((r) => r.id === recipientId);

  const send = useMoneyAction<Payout>({
    slot: quote
      ? `kony.payout:${recipientId}:${quote.amount_minor}:${quote.tariff_version_id}`
      : null,
    workspaceId,
    run: (api, key) =>
      api.post<Payout>(
        '/v1/payouts',
        {
          recipient_id: recipientId,
          amount_minor: quote?.amount_minor,
          currency: CURRENCY,
          // What the person was shown goes back with the payout; a changed fee is refused.
          expected_fee_minor: quote?.fee_minor,
          tariff_version_id: quote?.tariff_version_id,
        },
        key,
      ),
    onDone: onSent,
  });

  const seeFee = (): void => {
    const minor = toMinorUnits(amount, exponent);
    if (!minor) {
      setError(t('collect.bad_amount'));
      return;
    }
    setError(null);
    void (async () => {
      try {
        const api = await services.api(workspaceId);
        setQuote(
          await api.post<PayoutQuote>('/v1/payouts/preview', {
            recipient_id: recipientId,
            amount_minor: minor,
            currency: CURRENCY,
          }),
        );
      } catch (caught) {
        setError(caught instanceof AoraApiError ? caught.message : t('collect.bad_amount'));
      }
    })();
  };

  if (quote) {
    return (
      <Card>
        <Row
          label={t('payouts.to')}
          value={recipient ? `${recipient.label} (${recipient.phone_hint})` : ''}
        />
        <Row label={t('payouts.amount_row')} value={show(quote.amount_minor)} />
        <Row
          label={t('payouts.fee_row', { version: String(quote.tariff_version) })}
          value={show(quote.fee_minor)}
        />
        <Row label={t('payouts.total_row')} value={show(quote.total_minor)} />
        {send.state === 'done' ? (
          <Body>{t('payouts.sent')}</Body>
        ) : (
          <Button
            label={t('payouts.confirm', { amount: show(quote.amount_minor) })}
            onPress={send.start}
            disabled={send.state === 'working' || send.state === 'unknown'}
          />
        )}
        <MoneyActionView action={send} />
        <Button
          label={t('collect.change')}
          onPress={() => {
            setQuote(null);
          }}
          secondary
        />
      </Card>
    );
  }

  return (
    <Card>
      <Muted>{t('payouts.recipient')}</Muted>
      {recipients.map((r) => (
        <Choice
          key={r.id}
          label={`${r.label} (${r.phone_hint})`}
          selected={r.id === recipientId}
          onSelect={() => {
            setRecipientId(r.id);
          }}
        />
      ))}
      <TextField
        label={t('payouts.amount', { currency: CURRENCY })}
        value={amount}
        onChangeText={setAmount}
        numeric
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Button label={t('payouts.see_fee')} onPress={seeFee} />
    </Card>
  );
}
