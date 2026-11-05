/**
 * Spacing on an 8-point baseline: 8, 16, 24, 32, 48, 64 are the grid anchors,
 * with 4 and 12 as half-steps for icon gaps and dense rows. Every padding,
 * margin and gap in the three surfaces comes from this scale — a component that
 * needs a number that isn't here is a sign the layout should change instead.
 */
export const spacing = {
  /** Micro gap: icon to label, badge to edge. */
  xxs: 4,
  /** Grid half-step: text to its own note. */
  xs: 8,
  sm: 12,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  xxxl: 64,
} as const;

/** Cards and sheets sit at 12–16; nothing else is rounder than that. */
export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

export const borderWidth = {
  hairline: 0.5,
  thin: 1,
  focus: 2,
} as const;

export const sizing = {
  /** Minimum accessible touch target. */
  touchTarget: 44,
  inputHeight: 52,
  /** A multiline field opens to three lines so its label is never the hint. */
  inputMultilineHeight: 104,
  buttonSm: 40,
  buttonLg: 56,
  navBarHeight: 64,
  iconSm: 16,
  iconMd: 20,
  iconLg: 28,
  avatarSm: 32,
  avatarMd: 44,
  avatarLg: 64,
  /** Horizontal page gutter used by Screen and cards. */
  screenGutter: 20,
  cardGap: 16,
} as const;
