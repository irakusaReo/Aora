import { AoraApiError, type PaymentIntent, type Quote, toMinorUnits } from '@aora/api-client';
import {
  Button,
  Card,
  Choice,
  ErrorText,
  exponentOf,
  money,
  MoneyActionView,
  Muted,
  ResourceView,
  Row,
  Screen,
  TextField,
  useAssets,
  useMoneyAction,
  useServices,
} from '@aora/mobile';
import { useState } from 'react';
import { t } from '../messages';

const CURRENCY = 'KES';
// Safaricom's published sandbox test number (docs/providers/daraja.md): never a real person.
export const DARAJA_TEST_NUMBER = '+254708374149';
const SCENARIOS = [
  'success',
  'decline',
  'timeout_then_success',
  'timeout_then_failure',
  'late_webhook',
];

export function CollectScreen({
  workspaceId,
  go,
}: {
  workspaceId: string;
  go: (path: string) => void;
}): React.JSX.Element {
  const assets = useAssets();
  return (
    <Screen title={t('collect.title')}>
      <ResourceView resource={assets}>
        {(list) => (
          <CollectForm
            workspaceId={workspaceId}
            exponent={exponentOf(list, CURRENCY)}
            onCollected={(intent) => {
              go(`/w/${workspaceId}/collection/${intent.id}`);
            }}
          />
        )}
      </ResourceView>
    </Screen>
  );
}

function CollectForm({
  workspaceId,
  exponent,
  onCollected,
}: {
  workspaceId: string;
  exponent: number;
  onCollected: (intent: PaymentIntent) => void;
}): React.JSX.Element {
  const services = useServices();
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [scenario, setScenario] = useState<string | null>(null);
  const [payerPhone, setPayerPhone] = useState(DARAJA_TEST_NUMBER);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const show = (minor: string): string => money(minor, CURRENCY, exponent);

  const collect = useMoneyAction<PaymentIntent>({
    slot: quote
      ? `kony.collect:${workspaceId}:${quote.amount_minor}:${reference}:${scenario ?? 'daraja'}`
      : null,
    workspaceId,
    run: (api, key) =>
      api.post<PaymentIntent>(
        '/v1/payment-intents',
        {
          amount_minor: quote?.amount_minor,
          currency: CURRENCY,
          rail: 'mpesa',
          ...(reference ? { reference } : {}),
          // The payer's number goes only to Daraja; a simulator scenario needs none.
          ...(scenario ? { sandbox_scenario: scenario } : { payer_phone: payerPhone }),
        },
        key,
      ),
    onDone: onCollected,
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
          await api.get<Quote>('/v1/tariffs/quote', {
            operation: 'collection',
            rail: 'mpesa',
            currency: CURRENCY,
            amount_minor: minor,
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
        <Row label={t('collect.customer_pays')} value={show(quote.amount_minor)} />
        <Row
          label={t('collect.fee', { version: String(quote.tariff_version) })}
          value={show(quote.fee_minor)}
        />
        <Row label={t('collect.you_receive')} value={show(quote.net_minor)} />
        <Muted>{t('collect.sandbox_fees')}</Muted>
        {scenario === null && (
          <TextField
            label={t('collect.payer_phone')}
            value={payerPhone}
            onChangeText={setPayerPhone}
          />
        )}
        <Button
          label={t('collect.confirm', { amount: show(quote.amount_minor) })}
          onPress={collect.start}
          disabled={collect.state === 'working' || collect.state === 'unknown'}
        />
        <MoneyActionView action={collect} />
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
      <TextField
        label={t('collect.amount', { currency: CURRENCY })}
        value={amount}
        onChangeText={setAmount}
        numeric
      />
      <TextField
        label={t('collect.reference')}
        value={reference}
        onChangeText={setReference}
        maxLength={64}
      />
      <Muted>{t('collect.provider')}</Muted>
      <Choice
        label={t('collect.daraja')}
        selected={scenario === null}
        onSelect={() => {
          setScenario(null);
        }}
      />
      {SCENARIOS.map((name) => (
        <Choice
          key={name}
          label={t('collect.scenario', { scenario: name.replaceAll('_', ' ') })}
          selected={scenario === name}
          onSelect={() => {
            setScenario(name);
          }}
        />
      ))}
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Button label={t('collect.see_fee')} onPress={seeFee} />
    </Card>
  );
}
