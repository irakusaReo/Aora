import { AppRoot } from '@aora/mobile/native';
import { Stack } from 'expo-router';
import { EN } from '../src/messages';

// Every screen sits under the sandbox banner and behind sign-in (phase-9 P9-4).
export default function RootLayout(): React.JSX.Element {
  return (
    <AppRoot copy={EN}>
      <Stack screenOptions={{ headerShown: true, title: EN['app.name'] }} />
    </AppRoot>
  );
}
