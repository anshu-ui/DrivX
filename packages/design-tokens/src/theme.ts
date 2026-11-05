import { palette, support } from './colors';
import { elevation, webShadow } from './elevation';
import { borderWidth, radius, sizing, spacing } from './layout';
import { fontFamily, fontSize, lineHeight, typography } from './typography';

/**
 * Semantic colour roles. Components consume these roles, never raw palette hex
 * values, so the customer app, the driver app and the admin dashboard cannot
 * drift apart.
 *
 * Blue and white stay consistent across customer, driver and admin. Headings
 * use deep navy for readable contrast; active surfaces and actions use blue.
 */
export const colors = {
  background: palette.ground,
  surface: palette.white,
  /** Quiet inset fill: grouped rows, helper panels, unread chips. */
  surfaceMuted: palette.panel,
  /** Dark structural surface: admin navigation, brand panels. */
  surfaceBrand: palette.ink,

  border: palette.border,
  borderFocus: palette.brand,

  text: palette.body,
  textMuted: palette.secondary,
  /**
   * Small print — timestamps, footnotes, field helpers. Darker than `textMuted`
   * rather than lighter, because it is the one text role that has to stay
   * legible on tinted grounds as well as white.
   */
  textFaint: palette.faint,
  textBrand: palette.ink,
  textOnBrand: palette.white,

  primary: palette.brand,
  primaryPressed: palette.brandDeep,
  /**
   * Brand navy that has to be *read* rather than pressed — a ghost action's label,
   * the text of a selected chip, an active tab. `primary` is already the legible
   * step of the hue, so both roles land on the same value and stay honest about
   * being one colour.
   */
  primaryInk: palette.brand,
  /** Soft navy ground: selected chips, positive badges, quiet fills. */
  primarySoft: palette.brandTint,
  /**
   * Informational ground, deliberately a different hue from `primarySoft`. A
   * neutral status pill on a brand-blue tint reads as an action prompt, and now
   * that the brand itself is blue, info keeps the farther-out sky family so the
   * two never blur together.
   */
  infoSoft: support.infoSoft,
  onPrimary: palette.white,

  /** Deep-blue secondary action for active pills and confirmations. */
  neutralAction: palette.ink,
  neutralActionPressed: palette.inkDeep,

  disabledSurface: palette.disabledSurface,
  disabledText: palette.disabledText,

  /** Positive status blue; its text label also names the state. */
  success: palette.success,
  successSoft: support.successSoft,
  warning: palette.warning,
  warningSoft: support.warningSoft,
  danger: palette.error,
  dangerPressed: support.errorDeep,
  dangerSoft: support.errorSoft,

  skeleton: palette.border,
  /** Ground behind a sheet or dialog: the ink, held back enough to see through. */
  scrim: support.scrim,
} as const;

/**
 * Badge foregrounds, keyed to match `colors.*Soft` behind them. A status colour
 * at full strength on its own tint falls short at badge size, so each text
 * colour here is the same hue one step darker. `neutral` is body ink because a
 * grey-on-grey chip has nothing to signal.
 */
export const statusInk = {
  neutral: palette.body,
  info: support.infoDeep,
  success: support.successDeep,
  warning: support.warningDeep,
  danger: support.errorDeep,
} as const;

export const motion = {
  instant: 120,
  quick: 180,
  moderate: 260,
  slow: 420,
  easing: 'out',
  springDamping: 20,
} as const;

export const theme = {
  colors,
  statusInk,
  palette,
  support,
  spacing,
  radius,
  borderWidth,
  sizing,
  typography,
  fontFamily,
  fontSize,
  lineHeight,
  elevation,
  webShadow,
  motion,
} as const;

export type Theme = typeof theme;
export type ColorRole = keyof typeof colors;
