import { AoraApi } from '@aora/api-client';
import { ClerkProvider, useAuth } from '@clerk/expo';
import { useHostedAuth } from '@clerk/expo/hosted-auth';
import { tokenCache } from '@clerk/expo/token-cache';
import { type ReactNode, useMemo, useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Body, Button, Card, ErrorText, Muted, Screen } from './components';
import type { Messages } from './i18n';
import { translator } from './i18n';
import { appConfig, type AppConfig, deviceIntentKeys } from './device';
import { clearResourceCache } from './resource';
import { SandboxBanner } from './sandbox-banner';
import { type Services, ServicesProvider } from './services';
import { colors } from './theme';

// The root every AORA native app renders (phase-9 P9-4, P9-5). Clerk keeps
// the session token in secure storage through its `tokenCache`; nothing else
// stores a token (ADR 0016 rule 4). The sandbox banner sits above every screen.

const signInText = translator({
  'signin.button': 'Sign in with your email',
  'signin.help':
    'We send a code to your email. Your phone number is your payment identity and is set inside the app.',
  'signin.failed': 'Sign-in did not finish. Try again.',
  'signin.loading': 'Starting…',
});

export function AppRoot({
  copy,
  children,
}: {
  /** The app's name and one-line description for the sign-in screen. */
  copy: Messages & { 'app.name': string; 'app.tagline': string };
  children: ReactNode;
}): React.JSX.Element {
  const config = appConfig();
  // Clerk's cache is undefined only on the web; a phone without secure storage
  // must not fall back to keeping the session token anywhere else.
  if (!tokenCache) throw new Error('Secure token storage is not available on this device.');
  return (
    <ClerkProvider publishableKey={config.clerkPublishableKey} tokenCache={tokenCache}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <SandboxBanner />
        <SignedInServices config={config} copy={copy}>
          {children}
        </SignedInServices>
      </SafeAreaView>
    </ClerkProvider>
  );
}

function SignedInServices({
  config,
  copy,
  children,
}: {
  config: AppConfig;
  copy: { 'app.name': string; 'app.tagline': string };
  children: ReactNode;
}): React.JSX.Element {
  const { isLoaded, isSignedIn, getToken, signOut } = useAuth();
  const services = useMemo<Services>(
    () => ({
      // A fresh token for every request; Clerk refreshes it (ADR 0019).
      api: async (workspaceId) => {
        const api = new AoraApi({ baseUrl: config.apiUrl, token: await getToken() });
        return workspaceId ? api.forWorkspace(workspaceId) : api;
      },
      intents: deviceIntentKeys(),
      webUrl: config.webUrl,
      signOut: async () => {
        clearResourceCache();
        await signOut();
      },
    }),
    [config, getToken, signOut],
  );
  if (!isLoaded) return <Muted>{signInText('signin.loading')}</Muted>;
  if (!isSignedIn) return <SignIn name={copy['app.name']} tagline={copy['app.tagline']} />;
  return <ServicesProvider value={services}>{children}</ServicesProvider>;
}

function SignIn({ name, tagline }: { name: string; tagline: string }): React.JSX.Element {
  const { startHostedAuth } = useHostedAuth();
  const [failed, setFailed] = useState(false);
  return (
    <Screen title={name}>
      <Card>
        <Body>{tagline}</Body>
        <Muted>{signInText('signin.help')}</Muted>
        {failed ? <ErrorText>{signInText('signin.failed')}</ErrorText> : null}
        <Button
          label={signInText('signin.button')}
          onPress={() => {
            setFailed(false);
            startHostedAuth({ mode: 'sign-in' })
              .then((result) => {
                setFailed(result.createdSessionId === null);
              })
              .catch(() => {
                setFailed(true);
              });
          }}
        />
      </Card>
    </Screen>
  );
}
