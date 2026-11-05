/** Helvetica first, with native system fallbacks on platforms without Helvetica. */
export const fontFamily = {
  display: 'Helvetica',
  text: 'Helvetica',
  mono: 'Helvetica',
} as const;

export const fontSize = {
  xs: 12,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 19,
  '2xl': 26,
  '3xl': 31,
} as const;

export const lineHeight = {
  tight: 1.15,
  snug: 1.3,
  normal: 1.5,
} as const;

type Variant = {
  fontSize: number;
  lineHeight: number;
  fontWeight: '400' | '500' | '600' | '700' | '800';
  letterSpacing?: number;
};

export const typography = {
  /** Large page heading (30–32px, bold). */
  display: { fontSize: fontSize['3xl'], lineHeight: lineHeight.tight, fontWeight: '700', letterSpacing: -0.8 },
  /** Screen heading (24–28px). */
  title: { fontSize: fontSize['2xl'], lineHeight: 1.2, fontWeight: '700', letterSpacing: -0.6 },
  /** The fare amount, the one number a customer reads before anything else. */
  fare: { fontSize: 28, lineHeight: lineHeight.tight, fontWeight: '700', letterSpacing: -0.5 },
  /** Section heading (18–20px). */
  heading: { fontSize: fontSize.xl, lineHeight: lineHeight.snug, fontWeight: '600', letterSpacing: -0.2 },
  /** Card title (16–18px). */
  subheading: { fontSize: fontSize.lg, lineHeight: lineHeight.snug, fontWeight: '600', letterSpacing: -0.1 },
  body: { fontSize: fontSize.md, lineHeight: lineHeight.normal, fontWeight: '400' },
  bodyStrong: { fontSize: fontSize.md, lineHeight: lineHeight.normal, fontWeight: '600' },
  /** Form labels (13–14px, medium). */
  label: { fontSize: fontSize.sm, lineHeight: lineHeight.snug, fontWeight: '500', letterSpacing: 0.1 },
  /** Helper and secondary copy (12–13px). */
  caption: { fontSize: fontSize.sm, lineHeight: lineHeight.normal, fontWeight: '400' },
  overline: { fontSize: fontSize.xs, lineHeight: lineHeight.snug, fontWeight: '700', letterSpacing: 0.8 },
  button: { fontSize: fontSize.md, lineHeight: lineHeight.snug, fontWeight: '600', letterSpacing: -0.1 },
  /** The brand wordmark: uppercase, extra-bold, wide tracking. */
  wordmark: { fontSize: fontSize.sm, lineHeight: lineHeight.snug, fontWeight: '800', letterSpacing: 1.6 },
} satisfies Record<string, Variant>;

export type TypographyVariant = keyof typeof typography;
