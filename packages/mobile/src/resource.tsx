import { type AoraApi, AoraApiError } from '@aora/api-client';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, ErrorText, Muted } from './components';
import { t } from './messages';
import { classify } from './outcome';
import { useServices } from './services';

// Reading data for a screen. The last good answer for each key is kept in
// memory only (never written to the device) and shown, marked as possibly out
// of date, while a refresh fails (ADR 0016 rule 6).

const lastGood = new Map<string, unknown>();

/** Forget every cached answer, for example on sign-out. */
export function clearResourceCache(): void {
  lastGood.clear();
}

export type Resource<T> =
  | { status: 'loading'; data: null; reload: () => void }
  | { status: 'ready'; data: T; stale: boolean; reload: () => void }
  | { status: 'refused'; data: null; message: string; reload: () => void }
  | { status: 'unreachable'; data: null; reload: () => void };

export function useResource<T>(
  key: string | null,
  load: (api: AoraApi) => Promise<T>,
  workspaceId?: string,
): Resource<T> {
  const services = useServices();
  const loader = useRef(load);
  loader.current = load;
  const [version, setVersion] = useState(0);
  const reload = useCallback((): void => {
    setVersion((value) => value + 1);
  }, []);
  const cached = key === null ? undefined : (lastGood.get(key) as T | undefined);
  const [resource, setResource] = useState<Resource<T>>(
    cached === undefined
      ? { status: 'loading', data: null, reload }
      : { status: 'ready', data: cached, stale: true, reload },
  );

  useEffect(() => {
    if (key === null) return;
    // An answer that arrives after the screen moved on is dropped.
    const current = { live: true };
    void (async () => {
      try {
        const data = await loader.current(await services.api(workspaceId));
        lastGood.set(key, data);
        if (current.live) setResource({ status: 'ready', data, stale: false, reload });
      } catch (error) {
        if (!current.live) return;
        const outcome = classify(error);
        const previous = lastGood.get(key) as T | undefined;
        // A read changes nothing, so any answer the API gave in its own words
        // (even "the chain is unavailable", a 503) is shown as it is.
        const answered =
          error instanceof AoraApiError &&
          error.code !== 'internal_error' &&
          outcome.kind !== 'signed_out';
        if (outcome.kind === 'refused' || answered) {
          setResource({
            status: 'refused',
            data: null,
            message: error instanceof AoraApiError ? error.message : '',
            reload,
          });
        } else if (previous !== undefined) {
          setResource({ status: 'ready', data: previous, stale: true, reload });
        } else {
          setResource({ status: 'unreachable', data: null, reload });
        }
      }
    })();
    return () => {
      current.live = false;
    };
  }, [key, version, services, workspaceId, reload]);

  return resource;
}

/** Loading, refusal and unreachable states for a resource; its data once ready. */
export function ResourceView<T>({
  resource,
  children,
}: {
  resource: Resource<T>;
  children: (data: T) => ReactNode;
}): React.JSX.Element {
  switch (resource.status) {
    case 'loading':
      return <Muted>{t('state.loading')}</Muted>;
    case 'refused':
      return <ErrorText>{resource.message}</ErrorText>;
    case 'unreachable':
      return (
        <Card>
          <ErrorText>{t('state.unreachable')}</ErrorText>
          <Button label={t('state.retry')} onPress={resource.reload} secondary />
        </Card>
      );
    case 'ready':
      return (
        <>
          {resource.stale ? <Muted>{t('state.stale')}</Muted> : null}
          {children(resource.data)}
        </>
      );
  }
}
