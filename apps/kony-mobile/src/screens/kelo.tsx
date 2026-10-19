import type { KeloDashboard, KeloMerchantPurchase, List } from '@aora/api-client';
import {
  Body,
  Button,
  Card,
  exponentOf,
  Heading,
  money,
  MoneyActionView,
  Muted,
  ResourceView,
  Screen,
  TextField,
  useAction,
  useAssets,
  useResource,
  WebOnly,
} from '@aora/mobile';
import { useState } from 'react';
import { t } from '../messages';

/**
 * The KELO section of KONY (kelo-experience.md §3, K7): the dashboard in its
 * order, then each order with what the merchant must do next. Every figure is
 * the API's, read from the ledger; no buyer's credit data is ever shown.
 */
export function KeloScreen({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const assets = useAssets();
  const dashboard = useResource(
    `kelo.dashboard:${workspaceId}`,
    (api) => api.get<KeloDashboard>('/v1/workspace/kelo/dashboard'),
    workspaceId,
  );
  const orders = useResource(
    `kelo.orders:${workspaceId}`,
    (api) => api.get<List<KeloMerchantPurchase>>('/v1/workspace/kelo/purchases'),
    workspaceId,
  );
  const reload = (): void => {
    dashboard.reload();
    orders.reload();
  };
  return (
    <Screen title={t('kelo.title')}>
      <ResourceView resource={assets}>
        {(list) => {
          const show = (minor: string, code: string): string =>
            money(minor, code, exponentOf(list, code));
          return (
            <>
              <ResourceView resource={dashboard}>
                {(data) => {
                  const kes = (minor: string): string => show(minor, data.currency);
                  return (
                    <Card>
                      <Body strong>
                        {t('kelo.needing_action', {
                          count: String(data.orders_needing_action.total),
                        })}
                      </Body>
                      <Muted>
                        {t('kelo.needing_detail', {
                          confirm: String(data.orders_needing_action.confirm),
                          fulfil: String(data.orders_needing_action.fulfil),
                          returns: String(data.orders_needing_action.respond_to_return),
                        })}
                      </Muted>
                      <Body>
                        {t('kelo.sales', {
                          count: String(data.bnpl_sales.count),
                          amount: kes(data.bnpl_sales.gross_minor),
                        })}
                      </Body>
                      <Body>
                        {t('kelo.settlements_due', {
                          count: String(data.settlements.due.count),
                          amount: kes(data.settlements.due.net_minor),
                        })}
                      </Body>
                      <Body>
                        {t('kelo.settlements_paid', {
                          amount: kes(data.settlements.paid.to_available_minor),
                          gross: kes(data.settlements.paid.gross_minor),
                          fees: kes(data.settlements.paid.fees_minor),
                          clawback: kes(data.settlements.paid.clawback_netted_minor),
                        })}
                      </Body>
                      <Body>
                        {t('kelo.returns', {
                          open: String(data.returns.open),
                          accepted: String(data.returns.accepted),
                          amount: kes(data.returns.clawed_back_minor),
                        })}
                      </Body>
                      <Body>
                        {t('kelo.fees', {
                          charged: kes(data.fees.charged_minor),
                          refunded: kes(data.fees.refunded_minor),
                          net: kes(data.fees.net_minor),
                        })}
                      </Body>
                      <Muted>{t('kelo.no_buyer_data')}</Muted>
                    </Card>
                  );
                }}
              </ResourceView>
              <Heading>{t('kelo.orders')}</Heading>
              <ResourceView resource={orders}>
                {(data) =>
                  data.data.length === 0 ? (
                    <Muted>{t('kelo.empty')}</Muted>
                  ) : (
                    data.data.map((order) => (
                      <OrderCard
                        key={order.id}
                        workspaceId={workspaceId}
                        order={order}
                        show={(minor) => show(minor, order.currency)}
                        onChanged={reload}
                      />
                    ))
                  )
                }
              </ResourceView>
              <WebOnly what={t('kelo.web_only')} />
            </>
          );
        }}
      </ResourceView>
    </Screen>
  );
}

function OrderCard({
  workspaceId,
  order,
  show,
  onChanged,
}: {
  workspaceId: string;
  order: KeloMerchantPurchase;
  show: (minor: string) => string;
  onChanged: () => void;
}): React.JSX.Element {
  const [proof, setProof] = useState('');
  const [reason, setReason] = useState('');
  const step = order.next_action === 'confirm' ? 'confirm' : 'fulfil';
  const act = useAction({
    slot: `kony.kelo.${step}:${order.id}`,
    workspaceId,
    run: (api) =>
      step === 'confirm'
        ? api.post(`/v1/workspace/kelo/purchases/${order.id}/confirm`, {})
        : api.post(
            `/v1/workspace/kelo/purchases/${order.id}/fulfil`,
            proof ? { proof_reference: proof } : {},
          ),
    onDone: onChanged,
  });
  const claimId = order.claim?.id ?? '';
  // Accepting a return claws the sale back from the merchant: a PIN step-up (handled by the hook).
  const accept = useAction({
    slot: `kony.kelo.claim.accept:${claimId}`,
    workspaceId,
    run: (api) => api.post(`/v1/workspace/kelo/claims/${claimId}/accept`),
    onDone: onChanged,
  });
  const reject = useAction({
    slot: `kony.kelo.claim.reject:${claimId}`,
    workspaceId,
    run: (api) => api.post(`/v1/workspace/kelo/claims/${claimId}/reject`, { reason }),
    onDone: onChanged,
  });
  return (
    <Card>
      <Heading>{order.listing_title}</Heading>
      <Muted>
        {t('kelo.order_money', {
          total: show(order.total_minor),
          fee: show(order.merchant_fee_minor),
          net: show(order.net_minor),
        })}
      </Muted>
      <Body strong>{t(`kelo.next.${order.next_action}`)}</Body>
      {order.claim ? (
        <>
          <Muted>
            {t('kelo.claim', {
              kind: t(`claim_kind.${order.claim.kind}`),
              reason: t(`claim_reason.${order.claim.reason_code}`),
            })}
          </Muted>
          {order.claim.details ? (
            <Muted>{t('kelo.claim_details', { details: order.claim.details })}</Muted>
          ) : null}
        </>
      ) : null}
      {order.next_action === 'confirm' || order.next_action === 'fulfil' ? (
        <>
          {order.next_action === 'fulfil' ? (
            <TextField
              label={t('kelo.proof')}
              value={proof}
              onChangeText={setProof}
              maxLength={80}
            />
          ) : null}
          <Button
            label={t(order.next_action === 'confirm' ? 'kelo.confirm' : 'kelo.fulfil')}
            onPress={act.start}
            disabled={act.state === 'working'}
          />
          {act.state === 'done' ? <Muted>{t('kelo.done')}</Muted> : null}
          <MoneyActionView action={act} />
        </>
      ) : null}
      {order.next_action === 'respond_to_return' && order.claim ? (
        <>
          <Muted>{t('kelo.accept_help')}</Muted>
          <Button
            label={t('kelo.accept', { amount: show(order.net_minor) })}
            onPress={accept.start}
            disabled={accept.state === 'working'}
          />
          <MoneyActionView action={accept} />
          <TextField
            label={t('kelo.reject_reason')}
            value={reason}
            onChangeText={setReason}
            maxLength={300}
          />
          <Button
            label={t('kelo.reject')}
            onPress={reject.start}
            disabled={reason.trim().length < 3 || reject.state === 'working'}
            secondary
          />
          <MoneyActionView action={reject} />
        </>
      ) : null}
    </Card>
  );
}
