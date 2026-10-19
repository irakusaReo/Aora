import type { AoraApi } from '@aora/api-client';
import { useCallback, useRef, useState } from 'react';
import { Button, Card, ErrorText, Muted } from './components';
import { t } from './messages';
import { classify } from './outcome';
import { PinPrompt } from './pin-prompt';
import { useServices } from './services';

// Every action that moves money or needs a PIN goes through this hook
// (phase-9 P9-7, P9-8). The key is taken from secure storage before the first
// attempt; an unknown outcome keeps it so "check again" repeats the same
// request; only a definite outcome releases it.

export type ActionState =
  'idle' | 'working' | 'done' | 'refused' | 'unknown' | 'step_up' | 'signed_out';

export interface MoneyAction<T> {
  readonly state: ActionState;
  readonly message: string | null;
  readonly result: T | null;
  readonly start: () => void;
  /** Confirm the PIN, then repeat the request with the same key. */
  readonly stepUp: (pin: string) => Promise<string | null>;
  readonly cancelStepUp: () => void;
}

export function useMoneyAction<T>(options: {
  /** The request's slot (see IntentKeys); null while the form is incomplete. */
  slot: string | null;
  run: (api: AoraApi, idempotencyKey: string) => Promise<T>;
  onDone?: (result: T) => void;
  workspaceId?: string;
}): MoneyAction<T> {
  const services = useServices();
  const [state, setState] = useState<ActionState>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<T | null>(null);
  const inFlight = useRef(false);
  const latest = useRef(options);
  latest.current = options;

  const start = useCallback((): void => {
    const { slot, run, onDone, workspaceId } = latest.current;
    if (slot === null || inFlight.current) return;
    inFlight.current = true;
    setState('working');
    setMessage(null);
    void (async () => {
      try {
        const key = await services.intents.keyFor(slot);
        try {
          const value = await run(await services.api(workspaceId), key);
          await services.intents.settle(slot);
          setResult(value);
          setState('done');
          onDone?.(value);
        } catch (error) {
          const outcome = classify(error);
          if (outcome.kind === 'refused') {
            await services.intents.settle(slot);
            setMessage(outcome.message);
          }
          setState(outcome.kind);
        }
      } catch {
        // Secure storage itself failed: nothing was sent, but say so plainly.
        setState('unknown');
      } finally {
        inFlight.current = false;
      }
    })();
  }, [services]);

  const stepUp = useCallback(
    async (pin: string): Promise<string | null> => {
      try {
        const api = await services.api(latest.current.workspaceId);
        await api.post('/v1/auth/step-up', { pin });
      } catch (error) {
        const outcome = classify(error);
        return outcome.kind === 'refused' ? outcome.message : t('pin.wrong');
      }
      start();
      return null;
    },
    [services, start],
  );

  const cancelStepUp = useCallback((): void => {
    setState('idle');
  }, []);

  return { state, message, result, start, stepUp, cancelStepUp };
}

/** What the person sees while an action is in progress, unknown, refused or waiting for a PIN. */
export function MoneyActionView<T>({
  action,
}: {
  action: MoneyAction<T>;
}): React.JSX.Element | null {
  switch (action.state) {
    case 'working':
      return <Muted>{t('action.working')}</Muted>;
    case 'refused':
      return <ErrorText>{action.message ?? ''}</ErrorText>;
    case 'unknown':
      return (
        <Card>
          <Muted>{t('action.unknown')}</Muted>
          <Button label={t('action.check_again')} onPress={action.start} secondary />
        </Card>
      );
    case 'signed_out':
      return (
        <Card>
          <ErrorText>{t('action.signed_out')}</ErrorText>
          <Button label={t('action.check_again')} onPress={action.start} secondary />
        </Card>
      );
    case 'step_up':
      return <PinPrompt onConfirm={action.stepUp} onCancel={action.cancelStepUp} />;
    default:
      return null;
  }
}
