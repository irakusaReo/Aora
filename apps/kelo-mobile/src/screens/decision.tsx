import type { KeloCreditDecision, KeloPurchase } from '@aora/api-client';
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
  useAssets,
  useMoneyAction,
  useResource,
} from '@aora/mobile';
import { useState } from 'react';
import { formatDate, t } from '../messages';
import { CreditPlanCard } from '../plan-cards';
import { payBody, type Rail, RailChoice } from '../rails';

/** The decision on the checkout screen: approved, with one deliberate tap; or declined, with reasons (K2, K6). */
export function DecisionScreen({
  decisionId,
  go,
}: {
  decisionId: string;
  go: (path: string) => void;
}): React.JSX.Element {
  const assets = useAssets();
  const decision = useResource(`kelo.decision:${decisionId}`, (api) =>
    api.get<KeloCreditDecision>(`/v1/kelo/credit/decisions/${decisionId}`),
  );
  return (
    <ResourceView resource={assets}>
      {(list) => (
        <ResourceView resource={decision}>
          {(data) => {
            const show = (minor: string): string =>
              money(minor, data.plan.currency, exponentOf(list, data.plan.currency));
            return (
              <Screen title={t('plan.title', { name: data.plan.name })}>
                {data.outcome === 'declined' ? (
                  <Card>
                    <Body strong>{t('credit.declined')}</Body>
                    <Heading>{t('credit.reasons')}</Heading>
                    {data.reasons.map((reason) => (
                      <Body key={reason}>{reason}</Body>
                    ))}
                    <Muted>{t('credit.declined_other_ways')}</Muted>
                    <Button
                      label={t('nav.browse')}
                      onPress={() => {
                        go(`/l/${data.listing_id}`);
                      }}
                      secondary
                    />
                  </Card>
                ) : (
                  <Approved
                    decision={data}
                    show={show}
                    onBought={() => {
                      go('/purchases');
                    }}
                  />
                )}
              </Screen>
            );
          }}
        </ResourceView>
      )}
    </ResourceView>
  );
}

function Approved({
  decision,
  show,
  onBought,
}: {
  decision: KeloCreditDecision;
  show: (minor: string) => string;
  onBought: () => void;
}): React.JSX.Element {
  const [rail, setRail] = useState<Rail | null>(null);
  const plan = decision.plan;
  const first = plan.instalments.find((line) => line.seq === plan.checkout_seq);
  const agree = useMoneyAction({
    slot: rail ? `kelo.agree:${decision.id}:${rail}` : null,
    run: async (api, key) => {
      const purchase = await api.post<KeloPurchase>(
        '/v1/kelo/purchases',
        {
          decision_id: decision.id,
          expected_total_payable_minor: plan.total_payable_minor,
          agreement_version: plan.terms.version,
          kid_version: plan.kid.version,
        },
        `${key}.purchase`,
      );
      return api.post(
        `/v1/kelo/me/purchases/${purchase.id}/credit/instalments/${String(plan.checkout_seq ?? 1)}/pay`,
        payBody(rail ?? 'simulator'),
        `${key}.pay`,
      );
    },
    onDone: onBought,
  });
  return (
    <Card>
      <Body strong>{t('credit.approved')}</Body>
      <Muted>{t('credit.expires', { date: formatDate(decision.expires_at) })}</Muted>
      <CreditPlanCard plan={plan} money={show} />
      {/* A limit is not money: shown as how much can be spread, never as a balance. */}
      <Muted>{t('credit.spread_up_to', { amount: show(decision.limit.limit_minor) })}</Muted>
      <RailChoice rail={rail} onChange={setRail} />
      <Muted>{t('credit.agree_terms')}</Muted>
      <Button
        label={t('credit.agree', { amount: show(first?.amount_minor ?? '0') })}
        onPress={agree.start}
        disabled={rail === null || agree.state === 'working' || agree.state === 'unknown'}
      />
      <MoneyActionView action={agree} />
    </Card>
  );
}
