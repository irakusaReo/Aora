import type {
  KeloClaim,
  KeloCreditLimit,
  KeloCreditQuote,
  KeloPurchase,
  List,
} from '@aora/api-client';
import {
  Body,
  Button,
  Card,
  Choice,
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
  useMoneyAction,
  useResource,
} from '@aora/mobile';
import { useState } from 'react';
import { t } from '../messages';
import { payBody, type Rail, RailChoice } from '../rails';

const REASONS: KeloClaim['reason_code'][] = [
  'not_delivered',
  'not_as_described',
  'faulty',
  'changed_mind',
  'other',
];

/** The purchases hub (kelo-experience.md §2): each purchase, what is paid and to come, and its actions. */
export function PurchasesScreen({ go }: { go: (path: string) => void }): React.JSX.Element {
  const assets = useAssets();
  const purchases = useResource('kelo.purchases', (api) =>
    api.get<List<KeloPurchase>>('/v1/kelo/me/purchases'),
  );
  return (
    <Screen title={t('purchases.title')}>
      <ResourceView resource={assets}>
        {(list) => (
          <>
            <LimitCard show={(minor, code) => money(minor, code, exponentOf(list, code))} />
            <ResourceView resource={purchases}>
              {(data) =>
                data.data.length === 0 ? (
                  <Muted>{t('purchases.empty')}</Muted>
                ) : (
                  data.data.map((purchase) => (
                    <PurchaseCard
                      key={purchase.id}
                      purchase={purchase}
                      show={(minor) =>
                        money(minor, purchase.currency, exponentOf(list, purchase.currency))
                      }
                      onChanged={purchases.reload}
                      go={go}
                    />
                  ))
                )
              }
            </ResourceView>
          </>
        )}
      </ResourceView>
    </Screen>
  );
}

/** "You can spread up to…", never a balance. Absent while credit is switched off. */
function LimitCard({
  show,
}: {
  show: (minor: string, code: string) => string;
}): React.JSX.Element | null {
  const limit = useResource('kelo.limit', (api) =>
    api.get<KeloCreditLimit>('/v1/kelo/credit/limit'),
  );
  if (limit.status !== 'ready') return null;
  return (
    <Card>
      <Heading>{t('credit.limit_title')}</Heading>
      <Body>
        {t('credit.spread_up_to', { amount: show(limit.data.limit_minor, limit.data.currency) })}
      </Body>
      <Muted>
        {t('credit.spread_in_use', {
          amount: show(limit.data.limit_used_minor, limit.data.currency),
        })}
      </Muted>
      <Muted>{t('credit.grows')}</Muted>
    </Card>
  );
}

function PurchaseCard({
  purchase,
  show,
  onChanged,
  go,
}: {
  purchase: KeloPurchase;
  show: (minor: string) => string;
  onChanged: () => void;
  go: (path: string) => void;
}): React.JSX.Element {
  const [rail, setRail] = useState<Rail | null>(null);
  const credit = purchase.credit;
  const lines = credit ? credit.instalments : purchase.instalments;
  const next = lines.find((line) => line.status !== 'paid' && line.status !== 'cancelled');
  const paused = purchase.claim?.status === 'open';
  const layawayPayable =
    !credit &&
    purchase.plan_status === 'active' &&
    purchase.status !== 'cancelled' &&
    next !== undefined &&
    next.status === 'due';
  const firstCreditPayment =
    credit?.status === 'pending_first_payment' && next !== undefined && next.status !== 'pending';

  const pay = useMoneyAction({
    slot: next && rail ? `kelo.instalment:${purchase.id}:${String(next.seq)}:${rail}` : null,
    run: (api, key) =>
      api.post(
        credit
          ? `/v1/kelo/me/purchases/${purchase.id}/credit/instalments/${String(next?.seq ?? 0)}/pay`
          : `/v1/kelo/me/purchases/${purchase.id}/instalments/${String(next?.seq ?? 0)}/pay`,
        payBody(rail ?? 'simulator'),
        key,
      ),
    onDone: onChanged,
  });
  const confirmDelivery = useAction({
    slot: `kelo.delivery:${purchase.id}`,
    run: (api) => api.post(`/v1/kelo/me/purchases/${purchase.id}/confirm-delivery`),
    onDone: onChanged,
  });
  const cancel = useAction({
    slot: `kelo.cancel:${purchase.id}`,
    run: (api) => api.post(`/v1/kelo/me/purchases/${purchase.id}/cancel`),
    onDone: onChanged,
  });
  const delivered =
    purchase.status === 'merchant_confirmed' &&
    (credit ? credit.status === 'active' : purchase.plan_status === 'paid_in_full');

  return (
    <Card>
      <Heading>{purchase.listing_title}</Heading>
      <Muted>
        {credit ? `${t(`credit.status.${credit.status}`)} · ` : ''}
        {t(`purchases.status.${purchase.status}`)}
      </Muted>
      {!credit ? (
        <Body>
          {t('purchases.paid_of', {
            paid: show(purchase.paid_minor),
            total: show(purchase.total_minor),
          })}
        </Body>
      ) : null}
      {lines.map((line) => (
        <Muted key={line.seq}>
          {t('plan.instalment', {
            seq: String(line.seq),
            date: line.due_on,
            amount: show(line.amount_minor),
          })}{' '}
          · {t(`instalment.status.${line.status}`)}
        </Muted>
      ))}
      {paused ? <Muted>{t('claim.paused')}</Muted> : null}
      {next?.status === 'pending' ? <Muted>{t('purchases.checking')}</Muted> : null}
      {(layawayPayable || firstCreditPayment) && !paused ? (
        <>
          <Body>{t('purchases.next', { amount: show(next.amount_minor), date: next.due_on })}</Body>
          <RailChoice rail={rail} onChange={setRail} />
          <Button
            label={t('purchases.pay_next', { amount: show(next.amount_minor) })}
            onPress={pay.start}
            disabled={rail === null || pay.state === 'working' || pay.state === 'unknown'}
          />
          <MoneyActionView action={pay} />
        </>
      ) : null}
      {credit && ['active', 'defaulted'].includes(credit.status) && !paused ? (
        <PayEarly purchaseId={purchase.id} show={show} onPaid={onChanged} />
      ) : null}
      {credit ? (
        <Button
          label={t('credit.statement')}
          onPress={() => {
            go(`/statement/${purchase.id}`);
          }}
          secondary
        />
      ) : null}
      {!credit && purchase.plan_status === 'paid_in_full' ? (
        <Body>{t('purchases.receive')}</Body>
      ) : null}
      {delivered ? (
        <>
          <Button label={t('purchases.confirm_delivery')} onPress={confirmDelivery.start} />
          <MoneyActionView action={confirmDelivery} />
        </>
      ) : null}
      {purchase.refund ? (
        <Muted>
          {t('purchases.refund', {
            refund: show(purchase.refund.refund_minor),
            paid: show(purchase.refund.paid_minor),
            fee: show(purchase.refund.fee_minor),
            status: purchase.refund.status,
          })}
        </Muted>
      ) : null}
      <Claim purchase={purchase} onChanged={onChanged} />
      {['placed', 'payment_ready', 'merchant_confirmed'].includes(purchase.status) ? (
        <>
          <Button label={t('purchases.cancel')} onPress={cancel.start} secondary />
          <MoneyActionView action={cancel} />
        </>
      ) : null}
    </Card>
  );
}

/** Pay early, from the API's own quote: the exact amount, interest only to today, no penalty. */
function PayEarly({
  purchaseId,
  show,
  onPaid,
}: {
  purchaseId: string;
  show: (minor: string) => string;
  onPaid: () => void;
}): React.JSX.Element {
  const [rail, setRail] = useState<Rail | null>(null);
  const quote = useResource(`kelo.quote:${purchaseId}`, (api) =>
    api.get<KeloCreditQuote>(`/v1/kelo/me/purchases/${purchaseId}/credit/quote`),
  );
  const next = useRepay(purchaseId, 'next', quote, rail, onPaid);
  const payoff = useRepay(purchaseId, 'payoff', quote, rail, onPaid);
  return (
    <ResourceView resource={quote}>
      {(data) => (
        <>
          <Heading>{t('credit.pay_early_title')}</Heading>
          <RailChoice rail={rail} onChange={setRail} />
          {data.next ? (
            <Button
              label={t('credit.pay_next_early', { amount: show(data.next.amount_minor) })}
              onPress={next.start}
              disabled={rail === null || next.state === 'working' || next.state === 'unknown'}
              secondary
            />
          ) : null}
          <MoneyActionView action={next} />
          {data.payoff ? (
            <>
              <Button
                label={t('credit.pay_off', { amount: show(data.payoff.amount_minor) })}
                onPress={payoff.start}
                disabled={rail === null || payoff.state === 'working' || payoff.state === 'unknown'}
              />
              <Muted>
                {t('credit.pay_off_detail', {
                  principal: show(data.payoff.principal_minor),
                  charges: show(data.payoff.charges_minor),
                  interest: show(data.payoff.interest_minor),
                  saved: show(data.payoff.waived_minor),
                })}
              </Muted>
            </>
          ) : null}
          <MoneyActionView action={payoff} />
        </>
      )}
    </ResourceView>
  );
}

function useRepay(
  purchaseId: string,
  kind: 'next' | 'payoff',
  quote: ReturnType<typeof useResource<KeloCreditQuote>>,
  rail: Rail | null,
  onPaid: () => void,
): ReturnType<typeof useMoneyAction> {
  const amount = quote.status === 'ready' ? quote.data[kind]?.amount_minor : undefined;
  return useMoneyAction({
    slot: amount && rail ? `kelo.repay:${purchaseId}:${kind}:${amount}:${rail}` : null,
    run: (api, key) =>
      api.post(
        `/v1/kelo/me/purchases/${purchaseId}/credit/repay`,
        // What the person was shown goes back; a changed amount is refused.
        { kind, expected_amount_minor: amount, ...payBody(rail ?? 'simulator') },
        key,
      ),
    onDone: onPaid,
  });
}

/** Returns and disputes (K5): an open request pauses the plan. */
function Claim({
  purchase,
  onChanged,
}: {
  purchase: KeloPurchase;
  onChanged: () => void;
}): React.JSX.Element | null {
  const [reason, setReason] = useState<KeloClaim['reason_code'] | null>(null);
  const [details, setDetails] = useState('');
  const kind = purchase.status === 'completed' ? 'return' : 'dispute';
  const claim = purchase.claim;
  const open = useMoneyAction({
    slot: reason ? `kelo.claim:${purchase.id}:${kind}:${reason}` : null,
    run: (api, key) =>
      api.post(
        `/v1/kelo/me/purchases/${purchase.id}/claims`,
        { kind, reason_code: reason, ...(details ? { details } : {}) },
        key,
      ),
    onDone: onChanged,
  });
  const withdraw = useAction({
    slot: claim ? `kelo.claim.withdraw:${claim.id}` : null,
    run: (api) =>
      api.post(`/v1/kelo/me/purchases/${purchase.id}/claims/${claim?.id ?? ''}/withdraw`),
    onDone: onChanged,
  });
  if (claim?.status === 'open') {
    return (
      <>
        <Body>{t('claim.status.open')}</Body>
        <Button label={t('claim.withdraw')} onPress={withdraw.start} secondary />
        <MoneyActionView action={withdraw} />
      </>
    );
  }
  const status = claim ? (
    <Muted>{t(`claim.status.${claim.status}`, { reason: claim.decision_reason ?? '' })}</Muted>
  ) : null;
  if (!['payment_ready', 'merchant_confirmed', 'completed'].includes(purchase.status))
    return status;
  return (
    <>
      {status}
      <Heading>{t('claim.title')}</Heading>
      <Muted>{t('claim.reason_label')}</Muted>
      {REASONS.filter((code) =>
        kind === 'return' ? code !== 'not_delivered' : code !== 'changed_mind',
      ).map((code) => (
        <Choice
          key={code}
          label={t(`claim.reason.${code}`)}
          selected={reason === code}
          onSelect={() => {
            setReason(code);
          }}
        />
      ))}
      <TextField
        label={t('claim.details_label')}
        value={details}
        onChangeText={setDetails}
        maxLength={500}
      />
      <Button
        label={t(kind === 'return' ? 'claim.return' : 'claim.dispute')}
        onPress={open.start}
        disabled={reason === null || open.state === 'working'}
        secondary
      />
      <MoneyActionView action={open} />
    </>
  );
}
