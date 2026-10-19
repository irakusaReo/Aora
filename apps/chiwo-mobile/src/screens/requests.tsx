import {
  type ChiwoPaymentRequest,
  type ChiwoUsdc,
  type List,
  toMinorUnits,
} from '@aora/api-client';
import {
  Body,
  Button,
  Card,
  ErrorText,
  Heading,
  money,
  MoneyActionView,
  Muted,
  ResourceView,
  Screen,
  TextField,
  useAction,
  useMoneyAction,
  useResource,
} from '@aora/mobile';
import { useState } from 'react';
import { t } from '../messages';

/** Ask for USDC, and pay or cancel requests. A request cannot be paid twice: the API decides (J12). */
export function RequestsScreen(): React.JSX.Element {
  const usdc = useResource('chiwo.usdc', (api) => api.get<ChiwoUsdc>('/v1/chiwo/usdc'));
  const requests = useResource('chiwo.requests', (api) =>
    api.get<List<ChiwoPaymentRequest>>('/v1/chiwo/requests'),
  );
  return (
    <Screen title={t('requests.title')}>
      <ResourceView resource={usdc}>
        {(balance) => {
          const show = (minor: string): string =>
            money(minor, balance.asset.code, balance.asset.decimals);
          return (
            <>
              <NewRequest decimals={balance.asset.decimals} onCreated={requests.reload} />
              <ResourceView resource={requests}>
                {(list) =>
                  list.data.length === 0 ? (
                    <Muted>{t('requests.empty')}</Muted>
                  ) : (
                    list.data.map((request) => (
                      <RequestCard
                        key={request.id}
                        request={request}
                        amount={show(request.amount_minor)}
                        onChanged={requests.reload}
                      />
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

function NewRequest({
  decimals,
  onCreated,
}: {
  decimals: number;
  onCreated: () => void;
}): React.JSX.Element {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [phone, setPhone] = useState('');
  const minor = toMinorUnits(amount, decimals);
  const create = useAction({
    slot: minor ? `chiwo.request.create:${minor}:${note}:${phone}` : null,
    run: (api) =>
      api.post<ChiwoPaymentRequest>('/v1/chiwo/requests', {
        amount_minor: minor,
        ...(note ? { note } : {}),
        ...(phone ? { payer_phone: phone.replaceAll(' ', '') } : {}),
      }),
    onDone: () => {
      setAmount('');
      setNote('');
      setPhone('');
      onCreated();
    },
  });
  return (
    <Card>
      <Heading>{t('requests.new')}</Heading>
      <TextField label={t('requests.amount')} value={amount} onChangeText={setAmount} numeric />
      {amount !== '' && !minor ? <ErrorText>{t('bad_amount')}</ErrorText> : null}
      <TextField label={t('requests.note')} value={note} onChangeText={setNote} maxLength={140} />
      <TextField label={t('requests.payer')} value={phone} onChangeText={setPhone} />
      <Button
        label={t('requests.create')}
        onPress={create.start}
        disabled={!minor || create.state === 'working'}
      />
      {create.state === 'done' ? <Muted>{t('requests.created')}</Muted> : null}
      <MoneyActionView action={create} />
    </Card>
  );
}

function RequestCard({
  request,
  amount,
  onChanged,
}: {
  request: ChiwoPaymentRequest;
  amount: string;
  onChanged: () => void;
}): React.JSX.Element {
  const pay = useMoneyAction({
    slot: `chiwo.request.pay:${request.id}`,
    run: (api, key) => api.post(`/v1/chiwo/requests/${request.id}/pay`, {}, key),
    onDone: onChanged,
  });
  const cancel = useAction({
    slot: `chiwo.request.cancel:${request.id}`,
    run: (api) => api.post(`/v1/chiwo/requests/${request.id}/cancel`),
    onDone: onChanged,
  });
  const who =
    request.role === 'requester'
      ? request.payer
        ? t('requests.to', { name: request.payer.display_name })
        : t('requests.anyone')
      : t('requests.from', { name: request.requester.display_name });
  const open = request.status === 'open';
  return (
    <Card>
      <Body strong>
        {amount} · {t(`requests.status.${request.status}`)}
      </Body>
      <Muted>{who}</Muted>
      {request.note ? <Body>{request.note}</Body> : null}
      {open ? (
        <Muted>
          {t('requests.expires', {
            date: new Date(request.expires_at).toLocaleString('en-KE', {
              timeZone: 'Africa/Nairobi',
            }),
          })}
        </Muted>
      ) : null}
      {open && request.role !== 'requester' && pay.state !== 'done' && (
        <Button
          label={t('requests.pay', { amount })}
          onPress={pay.start}
          disabled={pay.state === 'working' || pay.state === 'unknown'}
        />
      )}
      {pay.state === 'done' ? <Body>{t('requests.paid_now')}</Body> : null}
      <MoneyActionView action={pay} />
      {open && request.role === 'requester' && cancel.state !== 'done' && (
        <Button label={t('requests.cancel')} onPress={cancel.start} secondary />
      )}
      {cancel.state === 'done' ? <Body>{t('requests.cancelled_now')}</Body> : null}
      <MoneyActionView action={cancel} />
    </Card>
  );
}
