/**
 * DrivX brand palette — "Navy Slate".
 *
 * Premium, minimal, technology-driven: white cards on a cool pale slate ground,
 * deep blue structural surfaces and text, with white page surfaces and blue
 * actions. No black fills, gold, neon, or gradient fills.
 *
 * The brand moved from emerald to a professional dark blue. The readable step of
 * the new hue is navy 800 (#1E40AF — 8.72:1 against white, and 7.80:1 on its own
 * tint), which carries every button label and every line of brand text, while
 * #0F2A5A holds the pressed step and badge ink. The bright #3B82F6 is reserved
 * for the live-status dot, which is always accompanied by the words beside it
 * rather than colour alone.
 *
 * Status hues keep their distance from the brand now that the brand is blue:
 * informational states use sky (#0284C7 / #0369A1 on #F0F9FF), while success
 * uses the same dark-blue family as the brand. Labels and icons carry the
 * status too, so completed and online remain clear without introducing green.
 *
 * These are the source-of-truth values for the customer app, the driver app and
 * the admin dashboard; components consume the semantic roles in `theme.ts`,
 * never a hex value from here.
 */
export const palette = {
  /** Brand navy — primary actions, selection accents, focus. */
  brand: '#1E40AF',
  brandDeep: '#0F2A5A',
  /** Live/online indicator only, and never the sole signal — the label says it too. */
  brandBright: '#3B82F6',
  /** Soft navy ground for selected chips, positive badges and quiet fills. */
  brandTint: '#EEF2FF',
  brandTintDeep: '#E0E7FF',
  /** Deep navy blue — headings, active pills, the brand surface. */
  ink: '#0F2A5A',
  inkDeep: '#091A39',
  /** Page ground. */
  ground: '#F8FAFC',
  white: '#FFFFFF',
  /** Body text. */
  body: '#334155',
  /** Secondary text. 4.76:1 on white, 4.55:1 on the page ground. */
  secondary: '#64748B',
  /** Small print. Darker than `secondary` because it must stay legible on tinted grounds too. */
  faint: '#475569',
  /** Borders and dividers. */
  border: '#E2E8F0',
  /** Quiet inset fill: grouped rows, helper panels. */
  panel: '#F1F5F9',
  /** Disabled control fill. */
  disabledSurface: '#E2E8F0',
  disabledText: '#94A3B8',
  /** Positive status (trip completed, driver online): dark blue, per the no-green brand brief. */
  success: '#1E40AF',
  /** Accent sky for informational states, kept one hue family away from the brand blue so a link never looks like a button. */
  accent: '#0284C7',
  accentDeep: '#0369A1',
  accentTint: '#F0F9FF',
  warning: '#B45309',
  error: '#DC2626',
} as const;

/**
 * Support tones that carry no colour of their own: the darker step of a status
 * hue for badge text, the pale step for badge ground, and the two translucent
 * washes. A status colour at full strength on its own tint falls short at badge
 * size, which is why every badge pairs a `*Soft` ground with a `*Deep` ink.
 */
export const support = {
  inkTint: '#1E293B',
  brandSoft: '#EEF2FF',
  brandDeep: '#0F2A5A',
  successSoft: '#EEF2FF',
  /** Badge ink for positive states: a deeper blue than `palette.success`. */
  successDeep: '#0F2A5A',
  infoSoft: '#F0F9FF',
  infoDeep: '#0369A1',
  warningSoft: '#FEF3C7',
  warningDeep: '#92400E',
  errorSoft: '#FEE2E2',
  /** Pressed state for a destructive action: the same red, one step darker. */
  errorDeep: '#B91C1C',
  scrim: 'rgba(15, 23, 42, 0.45)',
  hairline: 'rgba(15, 23, 42, 0.08)',
} as const;

/**
 * Relative-luminance contrast helper. `npm run check:contrast` asserts the
 * pairs the components actually ship, so a palette edit that breaks WCAG AA
 * fails a command instead of landing on a screen.
 */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string): number => {
    const rgb = [1, 3, 5].map((i) => {
      const raw = parseInt(hex.slice(i, i + 2), 16) / 255;
      return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
  };
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
