import type { List, Treasury, Withdrawal } from '@aora/api-client';
import {
  Body,
  Button,
  Card,
  Heading,
  money,
  MoneyActionView,
  Muted,
  ResourceView,
  Row,
  Screen,
  useAction,
  useResource,
  WebOnly,
} from '@aora/mobile';
import { statusLabel, t } from '../messages';

/** USDC balances (separate from KES) and the second-person approval of a withdrawal (J9). */
export function TreasuryScreen({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const treasury = useResource(
    `treasury:${workspaceId}`,
    (api) => api.get<Treasury>('/v1/treasury'),
    workspaceId,
  );
  const withdrawals = useResource(
    `withdrawals:${workspaceId}`,
    (api) => api.get<List<Withdrawal>>('/v1/treasury/withdrawals'),
    workspaceId,
  );
  return (
    <Screen title={t('treasury.title')}>
      <ResourceView resource={treasury}>
        {(data) => {
          const usdc = (minor: string): string =>
            money(minor, data.asset.code, data.asset.decimals);
          return (
            <>
              <Card>
                <Muted>{t('treasury.sandbox', { network: data.network.label })}</Muted>
                <Row label={t('treasury.available')} value={usdc(data.balances.available_minor)} />
                <Row
                  label={t('treasury.in_flight')}
                  value={usdc(data.balances.withdrawals_in_flight_minor)}
                />
                <Muted>{t('treasury.separate')}</Muted>
              </Card>
              <Heading>{t('treasury.withdrawals')}</Heading>
              <ResourceView resource={withdrawals}>
                {(list) =>
                  list.data.length === 0 ? (
                    <Muted>{t('treasury.empty')}</Muted>
                  ) : (
                    list.data.map((row) => (
                      <WithdrawalCard
                        key={row.id}
                        workspaceId={workspaceId}
                        withdrawal={row}
                        amount={usdc(row.amount_minor)}
                        onDecided={withdrawals.reload}
                      />
                    ))
                  )
                }
              </ResourceView>
              <WebOnly what={t('home.web_only')} />
            </>
          );
        }}
      </ResourceView>
    </Screen>
  );
}

function WithdrawalCard({
  workspaceId,
  withdrawal,
  amount,
  onDecided,
}: {
  workspaceId: string;
  withdrawal: Withdrawal;
  amount: string;
  onDecided: () => void;
}): React.JSX.Element {
  const approve = useAction({
    slot: `kony.withdrawal.approve:${withdrawal.id}`,
    workspaceId,
    run: (api) => api.post(`/v1/treasury/withdrawals/${withdrawal.id}/approval`, {}),
    onDone: onDecided,
  });
  const reject = useAction({
    slot: `kony.withdrawal.reject:${withdrawal.id}`,
    workspaceId,
    run: (api) =>
      api.post(`/v1/treasury/withdrawals/${withdrawal.id}/rejection`, {
        reason: t('treasury.reject_reason'),
      }),
    onDone: onDecided,
  });
  const busy = approve.state === 'working' || reject.state === 'working';
  return (
    <Card>
      <Body>
        {t('treasury.withdrawal', {
          amount,
          destination: withdrawal.destination,
          status: statusLabel(withdrawal.status),
        })}
      </Body>
      {approve.state === 'done' && <Body>{t('treasury.approved')}</Body>}
      {reject.state === 'done' && <Body>{t('treasury.rejected')}</Body>}
      {withdrawal.status === 'requested' && approve.state !== 'done' && reject.state !== 'done' && (
        <>
          <Muted>{t('treasury.approve_help')}</Muted>
          <Button label={t('treasury.approve')} onPress={approve.start} disabled={busy} />
          <Button label={t('treasury.reject')} onPress={reject.start} disabled={busy} secondary />
        </>
      )}
      <MoneyActionView action={approve} />
      <MoneyActionView action={reject} />
    </Card>
  );
}
