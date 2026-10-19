import {
  AoraApiError,
  type ChiwoMerchantPayment,
  type ChiwoPaymentQuote,
  toMinorUnits,
} from '@aora/api-client';
import {
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
  useServices,
} from '@aora/mobile';
import { useState } from 'react';
import { t } from '../messages';

const CURRENCY = 'KES';

/** Pay a KONY shop by its pay code, with the fee and timing shown before paying (J12). */
export function PayScreen({ go }: { go: (path: string) => void }): React.JSX.Element {
  const assets = useAssets();
  return (
    <Screen title={t('pay.title')}>
      <ResourceView resource={assets}>
        {(list) => (
          <PayForm
            exponent={exponentOf(list, CURRENCY)}
            onPaid={(payment) => {
              go(`/payments/${payment.id}`);
            }}
          />
        )}
      </ResourceView>
    </Screen>
  );
}

function PayForm({
  exponent,
  onPaid,
}: {
  exponent: number;
  onPaid: (payment: ChiwoMerchantPayment) => void;
}): React.JSX.Element {
  const services = useServices();
  const [code, setCode] = useState('');
  const [amount, setAmount] = useState('');
  const [rail, setRail] = useState<'mpesa' | 'simulator' | null>(null);
  const [quote, setQuote] = useState<ChiwoPaymentQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const show = (minor: string): string => money(minor, CURRENCY, exponent);

  const pay = useMoneyAction<ChiwoMerchantPayment>({
    slot:
      quote && rail
        ? `chiwo.pay:${quote.pay_code}:${quote.amount_minor}:${quote.total_minor}:${rail}`
        : null,
    run: (api, key) =>
      api.post<ChiwoMerchantPayment>(
        '/v1/chiwo/payments',
        {
          pay_code: quote?.pay_code,
          amount_minor: quote?.amount_minor,
          currency: CURRENCY,
          // What the person was shown goes back with the payment; a changed fee is refused.
          expected_fee_minor: quote?.fee_minor,
          expected_total_minor: quote?.total_minor,
          ...(rail === 'simulator' ? { sandbox_scenario: 'success' } : {}),
        },
        key,
      ),
    onDone: onPaid,
  });

  const review = (): void => {
    const minor = toMinorUnits(amount, exponent);
    if (!minor) {
      setError(t('pay.bad_amount'));
      return;
    }
    setError(null);
    void (async () => {
      try {
        const api = await services.api();
        setQuote(
          await api.post<ChiwoPaymentQuote>('/v1/chiwo/payments/quote', {
            pay_code: code.toUpperCase().replaceAll(' ', ''),
            amount_minor: minor,
            currency: CURRENCY,
          }),
        );
      } catch (caught) {
        setError(caught instanceof AoraApiError ? caught.message : t('pay.bad_amount'));
      }
    })();
  };

  if (quote) {
    return (
      <Card>
        <Heading>{t('pay.to', { merchant: quote.merchant.trading_name })}</Heading>
        <Row label={t('pay.amount')} value={show(quote.amount_minor)} />
        <Row
          label={t('pay.fee')}
          value={quote.fee_minor === '0' ? t('pay.fee_none') : show(quote.fee_minor)}
        />
        <Row label={t('pay.total')} value={show(quote.total_minor)} />
        <Muted>{t('pay.timing', { timing: quote.timing })}</Muted>
        <Muted>{t('pay.rail_label')}</Muted>
        <Choice
          label={t('pay.rail_mpesa')}
          selected={rail === 'mpesa'}
          onSelect={() => {
            setRail('mpesa');
          }}
        />
        <Choice
          label={t('pay.rail_simulator')}
          selected={rail === 'simulator'}
          onSelect={() => {
            setRail('simulator');
          }}
        />
        <Button
          label={t('pay.confirm', { amount: show(quote.total_minor) })}
          onPress={pay.start}
          disabled={rail === null || pay.state === 'working' || pay.state === 'unknown'}
        />
        <MoneyActionView action={pay} />
        <Button
          label={t('pay.change')}
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
        label={t('pay.code_label')}
        value={code}
        onChangeText={setCode}
        maxLength={9}
        autoCapitalize="characters"
      />
      <TextField
        label={t('pay.amount_label', { currency: CURRENCY })}
        value={amount}
        onChangeText={setAmount}
        numeric
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Button label={t('pay.review')} onPress={review} disabled={code.trim() === ''} />
    </Card>
  );
}
