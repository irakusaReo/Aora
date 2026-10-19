// AORA colour and spacing tokens for the native apps, the same values as the
// web apps' stylesheet (packages/ui/src/styles.ts).
export const colors = {
  ink: '#16181d',
  muted: '#5b6170',
  line: '#e3e5ea',
  bg: '#f7f8fa',
  card: '#ffffff',
  accent: '#0b6b4f',
  warnBg: '#fff3cd',
  warnInk: '#664d03',
  bad: '#a1281b',
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
