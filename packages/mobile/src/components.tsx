import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, space } from './theme';

// Small building blocks for the native screens. Presentation only: hiding a
// button is never security; the API decides (ADR 0016 rule 8).

export function Screen({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text role="heading" aria-level={1} style={styles.title}>
        {title}
      </Text>
      {children}
    </ScrollView>
  );
}

export function Card({ children }: { children: ReactNode }): React.JSX.Element {
  return <View style={styles.card}>{children}</View>;
}

export function Heading({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text role="heading" aria-level={2} style={styles.heading}>
      {children}
    </Text>
  );
}

export function Body({
  children,
  strong,
}: {
  children: ReactNode;
  strong?: boolean;
}): React.JSX.Element {
  return <Text style={[styles.body, strong ? styles.strong : null]}>{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text style={[styles.body, styles.muted]}>{children}</Text>;
}

export function ErrorText({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text role="alert" style={[styles.body, styles.bad]}>
      {children}
    </Text>
  );
}

/** A label and its value on one line, for amounts and states. */
export function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={[styles.body, styles.muted]}>{label}</Text>
      <Text style={[styles.body, styles.value]}>{value}</Text>
    </View>
  );
}

export function Button({
  label,
  onPress,
  disabled,
  secondary,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      role="button"
      onPress={onPress}
      disabled={disabled ?? false}
      aria-disabled={disabled ?? false}
      style={[
        styles.button,
        secondary ? styles.secondary : null,
        disabled ? styles.disabled : null,
      ]}
    >
      <Text style={[styles.buttonText, secondary ? styles.secondaryText : null]}>{label}</Text>
    </Pressable>
  );
}

export function TextField({
  label,
  value,
  onChangeText,
  help,
  secure,
  numeric,
  maxLength,
  autoCapitalize,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  help?: string;
  secure?: boolean;
  numeric?: boolean;
  maxLength?: number;
  autoCapitalize?: 'none' | 'characters';
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={[styles.body, styles.muted]}>{label}</Text>
      <TextInput
        aria-label={label}
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secure ?? false}
        keyboardType={numeric ? 'decimal-pad' : 'default'}
        autoCapitalize={autoCapitalize ?? 'none'}
        autoComplete="off"
        autoCorrect={false}
        {...(maxLength === undefined ? {} : { maxLength })}
        style={styles.input}
      />
      {help ? <Muted>{help}</Muted> : null}
    </View>
  );
}

/** One option of a single choice, announced as a radio button. */
export function Choice({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      role="radio"
      aria-checked={selected}
      onPress={onSelect}
      style={[styles.item, selected ? styles.selected : null]}
    >
      <Text style={[styles.body, selected ? styles.strong : null]}>{label}</Text>
    </Pressable>
  );
}

/** A tappable list entry that opens something. */
export function ListItem({
  title,
  detail,
  onPress,
}: {
  title: string;
  detail?: string;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable role="link" onPress={onPress} style={styles.item}>
      <Text style={[styles.body, styles.strong]}>{title}</Text>
      {detail ? <Text style={[styles.body, styles.muted]}>{detail}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, gap: space.md, paddingBottom: 64 },
  title: { fontSize: 22, fontWeight: '700', color: colors.ink },
  heading: { fontSize: 17, fontWeight: '600', color: colors.ink, marginTop: space.sm },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 8,
    padding: space.lg,
    gap: space.sm,
  },
  body: { fontSize: 15, color: colors.ink },
  strong: { fontWeight: '600' },
  muted: { color: colors.muted },
  bad: { color: colors.bad },
  value: { fontVariant: ['tabular-nums'], textAlign: 'right', flexShrink: 1 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  button: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    alignItems: 'center',
  },
  secondary: { backgroundColor: colors.card },
  disabled: { opacity: 0.5 },
  buttonText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  secondaryText: { color: colors.accent },
  field: { gap: space.xs },
  input: {
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    fontSize: 16,
    backgroundColor: colors.card,
    color: colors.ink,
  },
  selected: { borderColor: colors.accent, borderWidth: 2 },
  item: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 8,
    padding: space.md,
    gap: space.xs,
  },
});
