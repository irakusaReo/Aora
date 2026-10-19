import type { Me } from '@aora/api-client';
import { useState } from 'react';
import { Body, Button, Card, Heading, Muted, Screen, TextField } from './components';
import { t } from './messages';
import { MoneyActionView, useMoneyAction as useAction } from './money-action';
import { ResourceView, useResource } from './resource';

/** The phone number (payment identity, held by AORA) and the transaction PIN (ADR 0019). */
export function SecurityScreen(): React.JSX.Element {
  const me = useResource('me', (api) => api.get<Me>('/v1/me'));
  return (
    <Screen title={t('security.title')}>
      <Heading>{t('security.phone')}</Heading>
      <ResourceView resource={me}>
        {(data) =>
          data.phone_set ? (
            <Muted>{t('security.phone_set')}</Muted>
          ) : (
            <PhoneForm onSaved={me.reload} />
          )
        }
      </ResourceView>
      <Heading>{t('security.pin')}</Heading>
      <PinForm />
    </Screen>
  );
}

function PhoneForm({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const [phone, setPhone] = useState('');
  const save = useAction({
    slot: `me.phone:${phone}`,
    run: (api) => api.put('/v1/me/phone', { phone: phone.replaceAll(' ', '') }),
    onDone: onSaved,
  });
  return (
    <Card>
      <TextField label={t('security.phone_label')} value={phone} onChangeText={setPhone} />
      {save.state === 'done' ? (
        <Body>{t('security.phone_saved')}</Body>
      ) : (
        <Button
          label={t('security.phone_save')}
          onPress={save.start}
          disabled={phone.trim() === '' || save.state === 'working'}
        />
      )}
      <MoneyActionView action={save} />
    </Card>
  );
}

function PinForm(): React.JSX.Element {
  const [pin, setPin] = useState('');
  // The PIN is held in this field's memory only, and cleared once set (ADR 0016 rule 5).
  const save = useAction({
    slot: 'me.pin',
    run: (api) => api.put('/v1/auth/pin', { pin }),
    onDone: () => {
      setPin('');
    },
  });
  return (
    <Card>
      <Muted>{t('security.pin_help')}</Muted>
      <TextField
        label={t('security.pin_label')}
        value={pin}
        onChangeText={(text) => {
          setPin(text.replace(/[^0-9]/g, ''));
        }}
        secure
        numeric
        maxLength={6}
      />
      {save.state === 'done' ? <Body>{t('security.pin_saved')}</Body> : null}
      <Button
        label={t('security.pin_save')}
        onPress={save.start}
        disabled={pin.length !== 6 || save.state === 'working'}
      />
      <MoneyActionView action={save} />
    </Card>
  );
}
