import { Choice, Muted } from '@aora/mobile';
import { t } from './messages';

export type Rail = 'simulator' | 'mpesa';

// Safaricom's published sandbox test number: the only payer Daraja's sandbox allows.
const DARAJA_TEST_NUMBER = '+254708374149';

/** SANDBOX: the simulator succeeds; the M-Pesa sandbox only accepts Safaricom's test number. */
export function payBody(rail: Rail): Record<string, string> {
  return rail === 'mpesa' ? { payer_phone: DARAJA_TEST_NUMBER } : { sandbox_scenario: 'success' };
}

/** How to pay. Nothing is pre-selected that spends money (kelo-experience.md §5). */
export function RailChoice({
  rail,
  onChange,
}: {
  rail: Rail | null;
  onChange: (rail: Rail) => void;
}): React.JSX.Element {
  return (
    <>
      <Muted>{t('checkout.rail_label')}</Muted>
      <Choice
        label={t('checkout.rail_simulator')}
        selected={rail === 'simulator'}
        onSelect={() => {
          onChange('simulator');
        }}
      />
      <Choice
        label={t('checkout.rail_mpesa')}
        selected={rail === 'mpesa'}
        onSelect={() => {
          onChange('mpesa');
        }}
      />
    </>
  );
}
