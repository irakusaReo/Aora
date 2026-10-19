import type { AoraApi } from '@aora/api-client';
import { createContext, type ReactNode, useContext } from 'react';
import type { IntentKeys } from './intent-keys';

// What a screen needs from outside React: an API client carrying the current
// session token, the idempotency-key store, and where the web app is. Apps
// provide the real ones (Clerk, secure storage); tests provide fakes.
export interface Services {
  /** A client with a fresh session token; scoped to a workspace when one is given. */
  readonly api: (workspaceId?: string) => Promise<AoraApi>;
  readonly intents: IntentKeys;
  /** The web app, for the set-up tasks that stay on the web (phase-9 P9-10). */
  readonly webUrl: string;
  readonly signOut: () => Promise<void>;
}

const Context = createContext<Services | null>(null);

export function ServicesProvider({
  value,
  children,
}: {
  value: Services;
  children: ReactNode;
}): React.JSX.Element {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useServices(): Services {
  const value = useContext(Context);
  if (!value) throw new Error('useServices needs a ServicesProvider');
  return value;
}
