import type { ChiwoActivityItem, ChiwoMe, List } from '@aora/api-client';
import {
  Body,
  Button,
  Card,
  Choice,
  exponentOf,
  Heading,
  ListItem,
  money,
  MoneyActionView,
  Muted,
  ResourceView,
  Screen,
  TextField,
  useAction,
  useAssets,
  useResource,
  useServices,
} from '@aora/mobile';
import { useState } from 'react';
import { t } from '../messages';

interface Terms {
  key: string;
  version: string;
  title: string;
  body: string;
}

/** Sign-up until the account is open; then the activity and the menu (J12). */
export function HomeScreen({ go }: { go: (path: string) => void }): React.JSX.Element {
  const me = useResource('chiwo.me', (api) => api.get<ChiwoMe>('/v1/chiwo/me'));
  return (
    <ResourceView resource={me}>
      {(data) => (data.signed_up ? <Home go={go} /> : <SignUp me={data} onOpened={me.reload} />)}
    </ResourceView>
  );
}

function SignUp({ me, onOpened }: { me: ChiwoMe; onOpened: () => void }): React.JSX.Element {
  const [phone, setPhone] = useState('');
  const [accepted, setAccepted] = useState(false);
  const terms = useResource(me.phone_on_file ? `terms:${me.terms.key}` : null, (api) =>
    api.get<Terms>(`/v1/terms/${me.terms.key}`),
  );
  const savePhone = useAction({
    slot: `me.phone:${phone}`,
    run: (api) => api.put('/v1/me/phone', { phone: phone.replaceAll(' ', '') }),
    onDone: onOpened,
  });
  const open = useAction({
    slot: `chiwo.sign-up:${me.terms.version}`,
    run: (api) => api.post('/v1/chiwo/sign-up', { terms_version: me.terms.version }),
    onDone: onOpened,
  });
  return (
    <Screen title={t('signup.title')}>
      <Body>{t('signup.personal')}</Body>
      {!me.phone_on_file ? (
        <Card>
          <Heading>{t('signup.phone_title')}</Heading>
          <Muted>{t('signup.phone_help')}</Muted>
          <TextField label={t('signup.phone_title')} value={phone} onChangeText={setPhone} />
          <Button
            label={t('signup.phone_save')}
            onPress={savePhone.start}
            disabled={phone.trim() === '' || savePhone.state === 'working'}
          />
          <MoneyActionView action={savePhone} />
        </Card>
      ) : (
        <Card>
          <Heading>{t('signup.terms_title', { version: me.terms.version })}</Heading>
          <ResourceView resource={terms}>{(doc) => <Muted>{doc.body}</Muted>}</ResourceView>
          <Choice
            label={t('signup.accept', { version: me.terms.version })}
            selected={accepted}
            onSelect={() => {
              setAccepted(!accepted);
            }}
          />
          <Button
            label={t('signup.agree')}
            onPress={open.start}
            disabled={!accepted || open.state === 'working'}
          />
          <MoneyActionView action={open} />
        </Card>
      )}
    </Screen>
  );
}

function Home({ go }: { go: (path: string) => void }): React.JSX.Element {
  const { signOut } = useServices();
  const assets = useAssets();
  const activity = useResource('chiwo.activity', (api) =>
    api.get<List<ChiwoActivityItem>>('/v1/chiwo/activity'),
  );
  return (
    <Screen title={t('app.name')}>
      <ListItem
        title={t('nav.pay')}
        onPress={() => {
          go('/pay');
        }}
      />
      <ListItem
        title={t('nav.send')}
        onPress={() => {
          go('/send');
        }}
      />
      <ListItem
        title={t('nav.requests')}
        onPress={() => {
          go('/requests');
        }}
      />
      <ListItem
        title={t('nav.usdc')}
        onPress={() => {
          go('/usdc');
        }}
      />
      <ListItem
        title={t('nav.nam')}
        onPress={() => {
          go('/nam');
        }}
      />
      <Heading>{t('home.activity')}</Heading>
      <ResourceView resource={assets}>
        {(list) => (
          <ResourceView resource={activity}>
            {(data) =>
              data.data.length === 0 ? (
                <Muted>{t('home.empty')}</Muted>
              ) : (
                data.data.map((item) => (
                  <ListItem
                    key={`${item.kind}:${item.id}`}
                    title={t('activity.item', {
                      kind: t(`activity.kind.${item.kind}`),
                      counterparty: item.counterparty,
                    })}
                    detail={t('activity.amount', {
                      sign: item.direction === 'in' ? '+' : '−',
                      amount: money(
                        item.amount_minor,
                        item.currency,
                        exponentOf(list, item.currency),
                      ),
                      status: item.status.replaceAll('_', ' '),
                    })}
                    onPress={() => {
                      if (item.kind === 'merchant_payment') go(`/payments/${item.id}`);
                    }}
                  />
                ))
              )
            }
          </ResourceView>
        )}
      </ResourceView>
      <Button
        label={t('nav.security')}
        onPress={() => {
          go('/security');
        }}
        secondary
      />
      <Button label={t('nav.sign_out')} onPress={() => void signOut()} secondary />
    </Screen>
  );
}
