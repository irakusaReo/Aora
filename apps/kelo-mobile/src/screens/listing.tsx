import {
  type KeloAnyPlan,
  type KeloCreditDecision,
  type KeloCreditPlan,
  type KeloPlan,
  type KeloPublicListing,
  type KeloPurchase,
  type List,
  toMinorUnits,
} from '@aora/api-client';
import {
  Body,
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
  Screen,
  TextField,
  useAssets,
  useMoneyAction,
  useResource,
  WebOnly,
} from '@aora/mobile';
import { useState } from 'react';
import { formatDate, t } from '../messages';
import { CreditPlanCard, LayawayPlanCard } from '../plan-cards';
import { payBody, type Rail, RailChoice } from '../rails';

interface Option {
  key: string;
  label: string;
  query: Record<string, string>;
  body: Record<string, string>;
}

/** A listing, its options and the ways to pay for the chosen one (K2, K3, K4, K6). */
export function ListingScreen({
  listingId,
  go,
}: {
  listingId: string;
  go: (path: string) => void;
}): React.JSX.Element {
  const assets = useAssets();
  const listing = useResource(`kelo.listing:${listingId}`, (api) =>
    api.get<KeloPublicListing>(`/v1/kelo/marketplace/listings/${listingId}`),
  );
  return (
    <ResourceView resource={assets}>
      {(list) => (
        <ResourceView resource={listing}>
          {(data) => (
            <Listing
              listing={data}
              show={(minor) => money(minor, data.currency, exponentOf(list, data.currency))}
              exponent={exponentOf(list, data.currency)}
              go={go}
            />
          )}
        </ResourceView>
      )}
    </ResourceView>
  );
}

function Listing({
  listing,
  show,
  exponent,
  go,
}: {
  listing: KeloPublicListing;
  show: (minor: string) => string;
  exponent: number;
  go: (path: string) => void;
}): React.JSX.Element {
  const options: Option[] = [
    ...listing.variants
      .filter((variant) => variant.in_stock)
      .map((variant) => ({
        key: `variant:${variant.id}`,
        label: `${variant.name}: ${show(variant.price_minor)}`,
        query: { variant_id: variant.id },
        body: { variant_id: variant.id },
      })),
    ...listing.sessions
      .filter((session) => session.available)
      .map((session) => ({
        key: `session:${session.id}`,
        label: `${formatDate(session.starts_at)}: ${show(session.price_minor)}`,
        query: { session_id: session.id },
        body: { session_id: session.id },
      })),
  ];
  const [chosenKey, setChosenKey] = useState(options[0]?.key ?? null);
  const chosen = options.find((option) => option.key === chosenKey);
  return (
    <Screen title={listing.title}>
      <Muted>{t('listing.sold_by', { store: listing.store.display_name })}</Muted>
      <Body>{listing.description}</Body>
      {listing.type === 'quote_service' ? (
        <WebOnly what={t('listing.quote_web')} />
      ) : (
        <>
          <Heading>{t('listing.ways_to_pay')}</Heading>
          {options.length === 0 ? <Muted>{t('listing.out_of_stock')}</Muted> : null}
          {options.length > 1 ? (
            <>
              <Muted>{t('listing.option')}</Muted>
              {options.map((option) => (
                <Choice
                  key={option.key}
                  label={option.label}
                  selected={option.key === chosenKey}
                  onSelect={() => {
                    setChosenKey(option.key);
                  }}
                />
              ))}
            </>
          ) : null}
          {chosen ? (
            <Plans listing={listing} option={chosen} show={show} exponent={exponent} go={go} />
          ) : null}
        </>
      )}
    </Screen>
  );
}

function Plans({
  listing,
  option,
  show,
  exponent,
  go,
}: {
  listing: KeloPublicListing;
  option: Option;
  show: (minor: string) => string;
  exponent: number;
  go: (path: string) => void;
}): React.JSX.Element {
  const plans = useResource(`kelo.plans:${listing.id}:${option.key}`, (api) =>
    api.get<List<KeloAnyPlan>>(`/v1/kelo/marketplace/listings/${listing.id}/plans`, option.query),
  );
  return (
    <ResourceView resource={plans}>
      {(list) => {
        // Credit plans are present only while the flag is on: absent, never greyed out.
        const credit = list.data.filter(
          (plan): plan is KeloCreditPlan => plan.plan_type !== 'layaway',
        );
        const layaway = list.data.filter((plan): plan is KeloPlan => plan.plan_type === 'layaway');
        if (list.data.length === 0) return <Muted>{t('plan.none')}</Muted>;
        return (
          <>
            {credit.map((plan) => (
              <Card key={plan.template_key}>
                <Heading>{t('plan.title', { name: plan.name })}</Heading>
                <CreditPlanCard plan={plan} money={show} />
                <CreditCheck
                  listing={listing}
                  option={option}
                  plan={plan}
                  exponent={exponent}
                  onDecided={(decision) => {
                    go(`/decision/${decision.id}`);
                  }}
                />
              </Card>
            ))}
            {layaway.map((plan) => (
              <Card key={plan.template_key}>
                <Heading>{t('plan.title', { name: plan.name })}</Heading>
                <LayawayPlanCard
                  plan={plan}
                  money={show}
                  scheduled={listing.type === 'scheduled_service'}
                />
                <LayawayCheckout
                  listing={listing}
                  option={option}
                  plan={plan}
                  show={show}
                  onBought={() => {
                    go('/purchases');
                  }}
                />
              </Card>
            ))}
          </>
        );
      }}
    </ResourceView>
  );
}

/**
 * One deliberate tap places the purchase and takes the first payment. Both
 * calls use keys derived from one stored slot key, so "check again" replays
 * both without creating a second purchase or a second payment.
 */
function LayawayCheckout({
  listing,
  option,
  plan,
  show,
  onBought,
}: {
  listing: KeloPublicListing;
  option: Option;
  plan: KeloPlan;
  show: (minor: string) => string;
  onBought: () => void;
}): React.JSX.Element {
  const [rail, setRail] = useState<Rail | null>(null);
  const buy = useMoneyAction({
    slot: rail
      ? `kelo.buy:${listing.id}:${option.key}:${plan.template_key}:${plan.total_minor}:${rail}`
      : null,
    run: async (api, key) => {
      const purchase = await api.post<KeloPurchase>(
        '/v1/kelo/purchases',
        {
          listing_id: listing.id,
          ...option.body,
          template_key: plan.template_key,
          expected_total_minor: plan.total_minor,
          terms_version: plan.terms.version,
        },
        `${key}.purchase`,
      );
      return api.post(
        `/v1/kelo/me/purchases/${purchase.id}/instalments/1/pay`,
        payBody(rail ?? 'simulator'),
        `${key}.pay`,
      );
    },
    onDone: onBought,
  });
  return (
    <>
      <RailChoice rail={rail} onChange={setRail} />
      <Muted>{t('checkout.terms', { version: plan.terms.version })}</Muted>
      <Button
        label={t('checkout.agree', { amount: show(plan.instalments[0]?.amount_minor ?? '0') })}
        onPress={buy.start}
        disabled={rail === null || buy.state === 'working' || buy.state === 'unknown'}
      />
      {buy.state === 'done' ? <Body>{t('checkout.started')}</Body> : null}
      <MoneyActionView action={buy} />
    </>
  );
}

function CreditCheck({
  listing,
  option,
  plan,
  exponent,
  onDecided,
}: {
  listing: KeloPublicListing;
  option: Option;
  plan: KeloCreditPlan;
  exponent: number;
  onDecided: (decision: KeloCreditDecision) => void;
}): React.JSX.Element {
  const [income, setIncome] = useState('');
  const [bureau, setBureau] = useState(false);
  const bureauTerms = useResource('terms:kelo_bureau_check_consent', (api) =>
    api.get<{ version: string }>('/v1/terms/kelo_bureau_check_consent'),
  );
  const minor = toMinorUnits(income, exponent);
  const bureauVersion = bureauTerms.status === 'ready' ? bureauTerms.data.version : null;
  const check = useMoneyAction<KeloCreditDecision>({
    slot: minor
      ? `kelo.decision:${listing.id}:${option.key}:${plan.template_key}:${minor}:${bureau ? 'bureau' : 'none'}`
      : null,
    run: (api, key) =>
      api.post<KeloCreditDecision>(
        '/v1/kelo/credit/decisions',
        {
          listing_id: listing.id,
          ...option.body,
          template_key: plan.template_key,
          declared_monthly_income_minor: minor,
          // An explicit, unticked choice with its own consent (kelo-experience.md §2).
          ...(bureau && bureauVersion ? { bureau_check: { consent_version: bureauVersion } } : {}),
        },
        key,
      ),
    onDone: onDecided,
  });
  return (
    <>
      <Heading>{t('credit.check_title')}</Heading>
      <TextField
        label={t('credit.income_label', { currency: listing.currency })}
        value={income}
        onChangeText={setIncome}
        numeric
      />
      {income !== '' && !minor ? <ErrorText>{t('credit.bad_income')}</ErrorText> : null}
      <Muted>{t('credit.income_why')}</Muted>
      <Choice
        label={t('credit.bureau_label')}
        selected={bureau}
        onSelect={() => {
          setBureau(!bureau);
        }}
      />
      {bureauVersion ? <Muted>{t('credit.bureau_terms', { version: bureauVersion })}</Muted> : null}
      <Button
        label={t('credit.check_button')}
        onPress={check.start}
        disabled={!minor || check.state === 'working'}
      />
      <MoneyActionView action={check} />
    </>
  );
}
