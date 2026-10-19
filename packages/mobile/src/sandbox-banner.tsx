import { SANDBOX_TEXT } from '@aora/ui';
import { StyleSheet, Text, View } from 'react-native';
import { colors, space } from './theme';

// Every screen says it is sandbox (CLAUDE.md rule 10, ADR 0016 rule 7).
// Rendered once by each app's root layout, above every screen, never dismissible.
export function SandboxBanner(): React.JSX.Element {
  return (
    <View role="status" aria-label="Sandbox environment" style={styles.banner}>
      <Text style={styles.text}>{SANDBOX_TEXT}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.warnBg,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: '#f0d78c',
  },
  text: { color: colors.warnInk, fontWeight: '600', fontSize: 13, textAlign: 'center' },
});
