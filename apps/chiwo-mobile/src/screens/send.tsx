import { type ChiwoRecipient, type ChiwoUsdc, type List, toMinorUnits } from '@aora/api-client';
import {
  Body,
  Button,
  Card,
  Choice,
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

/** Find a person by phone, confirm them with the PIN, then send USDC on AORA's books (J12). */
export function SendScreen(): React.JSX.Element {
  const usdc = useResource('chiwo.usdc', (api) => api.get<ChiwoUsdc>('/v1/chiwo/usdc'));
  const people = useResource('chiwo.recipients', (api) =>
    api.get<List<ChiwoRecipient>>('/v1/chiwo/recipients'),
  );
  return (
    <Screen title={t('send.title')}>
      <FindPerson onConfirmed={people.reload} />
      <ResourceView resource={usdc}>
        {(balance) => (
          <ResourceView resource={people}>
            {(list) => (
              <SendForm
                recipients={list.data.filter((person) => person.confirmed)}
                code={balance.asset.code}
                decimals={balance.asset.decimals}
              />
            )}
          </ResourceView>
        )}
      </ResourceView>
    </Screen>
  );
}

function FindPerson({ onConfirmed }: { onConfirmed: () => void }): React.JSX.Element {
  const [phone, setPhone] = useState('');
  const [found, setFound] = useState<ChiwoRecipient | null>(null);
  const find = useAction<ChiwoRecipient>({
    slot: `chiwo.find:${phone}`,
    run: (api) =>
      api.post<ChiwoRecipient>('/v1/chiwo/recipients', { phone: phone.replaceAll(' ', '') }),
    onDone: setFound,
  });
  const confirm = useAction({
    slot: found ? `chiwo.recipient.confirm:${found.id}` : null,
    run: (api) => api.post(`/v1/chiwo/recipients/${found?.id ?? ''}/confirm`),
    onDone: () => {
      setFound(null);
      setPhone('');
      onConfirmed();
    },
  });
  return (
    <Card>
      <TextField label={t('send.find')} value={phone} onChangeText={setPhone} />
      <Button
        label={t('send.find_button')}
        onPress={find.start}
        disabled={phone.trim() === '' || find.state === 'working'}
        secondary
      />
      <MoneyActionView action={find} />
      {found && !found.confirmed && (
        <>
          <Body strong>{t('send.confirm_who', { name: found.display_name })}</Body>
          <Button label={t('send.confirm_button')} onPress={confirm.start} />
          <MoneyActionView action={confirm} />
        </>
      )}
    </Card>
  );
}

function SendForm({
  recipients,
  code,
  decimals,
}: {
  recipients: ChiwoRecipient[];
  code: string;
  decimals: number;
}): React.JSX.Element {
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const minor = toMinorUnits(amount, decimals);
  const send = useMoneyAction({
    slot: recipientId && minor ? `chiwo.transfer:${recipientId}:${minor}:${note}` : null,
    run: (api, key) =>
      api.post(
        '/v1/chiwo/transfers',
        { recipient_id: recipientId, amount_minor: minor, ...(note ? { note } : {}) },
        key,
      ),
  });
  if (recipients.length === 0) return <Muted>{t('send.none')}</Muted>;
  return (
    <Card>
      <Heading>{t('send.people')}</Heading>
      {recipients.map((person) => (
        <Choice
          key={person.id}
          label={person.display_name}
          selected={person.id === recipientId}
          onSelect={() => {
            setRecipientId(person.id);
          }}
        />
      ))}
      <TextField label={t('send.amount')} value={amount} onChangeText={setAmount} numeric />
      {amount !== '' && !minor ? <ErrorText>{t('bad_amount')}</ErrorText> : null}
      <TextField label={t('send.note')} value={note} onChangeText={setNote} maxLength={140} />
      <Muted>{t('send.free')}</Muted>
      {send.state === 'done' ? (
        <Body>{t('send.sent')}</Body>
      ) : (
        <Button
          label={t('send.button', { amount: minor ? money(minor, code, decimals) : code })}
          onPress={send.start}
          disabled={!recipientId || !minor || send.state === 'working' || send.state === 'unknown'}
        />
      )}
      <MoneyActionView action={send} />
    </Card>
  );
}
