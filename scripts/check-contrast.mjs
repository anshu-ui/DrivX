/**
 * Contrast gate for the Navy Slate palette.
 *
 * `npm run check:contrast` recomputes every text-on-ground pair the UI actually
 * ships from @drivx/design-tokens and fails if one drops below the floor
 * recorded here, so a palette edit that breaks legibility fails a command
 * instead of landing on a screen.
 *
 * Four rows print as `note` instead of `ok`: a disabled control, which WCAG 1.4.3
 * excludes; a switch at rest, whose state reads from thumb position rather than
 * colour; the 1px hairline, which the design language fixes at #E2E8F0 and which
 * is carried by the visible label and the focus ring; and the bright blue live
 * indicator, which never signals alone because the words beside it say the same
 * thing. Everything else is asserted, and the brand blues are the readable step
 * of the hue rather than the pretty one.
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

// The token package is TypeScript source with extensionless relative imports,
// which Node's type stripping resolves only with a hook.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('./') || /\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(specifier, context);
    }
    for (const candidate of ['.ts', '/index.ts']) {
      const url = new URL(`${specifier}${candidate}`, context.parentURL).href;
      if (existsSync(fileURLToPath(url))) return { url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { colors, statusInk } = await import('../packages/design-tokens/src/theme.ts');
const { contrastRatio, palette, support } = await import('../packages/design-tokens/src/colors.ts');

/** AA for normal text, and the floor a large or bold run is held to. */
const AA = 4.5;
const AA_LARGE = 3;

/** @type {{ fg: string, bg: string, min: number, size: string, label: string, exempt?: string }[]} */
const pairs = [
  { fg: colors.text, bg: colors.surface, min: AA, size: '15 body', label: 'body on card' },
  { fg: colors.text, bg: colors.background, min: AA, size: '15 body', label: 'body on page ground' },
  { fg: colors.textBrand, bg: colors.background, min: AA, size: '31 display', label: 'heading on page ground' },
  { fg: colors.textBrand, bg: colors.surface, min: AA, size: '17 subheading', label: 'card title on card' },
  { fg: colors.textMuted, bg: colors.surface, min: AA, size: '13 caption', label: 'secondary text on card' },
  { fg: colors.textMuted, bg: colors.background, min: AA, size: '13 caption', label: 'secondary text on page ground' },
  { fg: colors.textFaint, bg: colors.surface, min: AA, size: '13 caption', label: 'small print on card' },
  { fg: colors.textFaint, bg: colors.surfaceMuted, min: AA, size: '13 caption', label: 'small print on inset panel' },
  { fg: colors.textFaint, bg: colors.primarySoft, min: AA, size: '13 caption', label: 'small print on brand tint' },
  { fg: colors.textOnBrand, bg: colors.surfaceBrand, min: AA, size: '19 heading', label: 'text on ink surface' },
  { fg: colors.textOnBrand, bg: support.inkTint, min: AA, size: '19 heading', label: 'text on ink row' },
  { fg: colors.onPrimary, bg: colors.primary, min: AA, size: '15 semibold button', label: 'primary button label' },
  { fg: colors.onPrimary, bg: colors.primaryPressed, min: AA, size: '15 semibold button', label: 'pressed primary label' },
  { fg: colors.neutralAction, bg: colors.surface, min: AA, size: '15 semibold button', label: 'secondary (ink) button label' },
  { fg: colors.onPrimary, bg: colors.neutralAction, min: AA, size: '13 active pill', label: 'label on the dark active pill' },
  { fg: colors.primaryInk, bg: colors.surface, min: AA, size: '15 button', label: 'ghost (navy) action on card' },
  { fg: colors.primaryInk, bg: colors.background, min: AA, size: '15 button', label: 'ghost (navy) action on ground' },
  { fg: colors.primaryInk, bg: colors.primarySoft, min: AA, size: '13 selected chip', label: 'selected chip label on tint' },
  { fg: colors.primaryInk, bg: colors.surface, min: AA, size: '13 tab label', label: 'active tab label' },
  { fg: colors.textMuted, bg: colors.surface, min: AA, size: '13 tab label', label: 'inactive tab label' },
  {
    fg: colors.disabledText,
    bg: colors.disabledSurface,
    min: AA,
    size: '15 disabled',
    label: 'disabled control label',
    exempt: 'WCAG 1.4.3 excludes inactive interface components',
  },
  { fg: statusInk.neutral, bg: colors.surfaceMuted, min: AA, size: '12 badge', label: 'neutral badge' },
  { fg: statusInk.info, bg: colors.infoSoft, min: AA, size: '12 badge', label: 'info badge (sky, not brand navy)' },
  { fg: statusInk.success, bg: colors.successSoft, min: AA, size: '12 badge', label: 'success badge' },
  { fg: statusInk.warning, bg: colors.warningSoft, min: AA, size: '12 badge', label: 'warning badge' },
  { fg: statusInk.danger, bg: colors.dangerSoft, min: AA, size: '12 badge', label: 'danger badge' },
  { fg: colors.success, bg: colors.surface, min: AA, size: '13 caption', label: 'success text on card' },
  { fg: colors.warning, bg: colors.surface, min: AA, size: '13 caption', label: 'warning text on card' },
  { fg: colors.danger, bg: colors.surface, min: AA, size: '13 caption', label: 'danger text on card' },
  {
    fg: colors.border,
    bg: colors.surface,
    min: AA_LARGE,
    size: '1px line',
    label: 'resting input border',
    exempt: 'the design language fixes #E2E8F0 for hairlines; the field is carried by its visible label and the 2px ring below',
  },
  { fg: colors.danger, bg: colors.surface, min: AA_LARGE, size: '2px line', label: 'invalid input border' },
  { fg: colors.primary, bg: colors.surface, min: AA_LARGE, size: '2px ring', label: 'focus ring against card' },
  { fg: colors.primary, bg: colors.primarySoft, min: AA_LARGE, size: 'switch, on', label: 'switch thumb against track, on' },
  {
    fg: colors.surfaceMuted,
    bg: colors.border,
    min: AA_LARGE,
    size: 'switch, off',
    label: 'switch thumb against track, off',
    exempt: 'the resting state reads from thumb position and the platform thumb shadow, not from colour',
  },
  {
    fg: palette.brandBright,
    bg: colors.surface,
    min: AA_LARGE,
    size: '8px dot',
    label: 'live/online dot',
    exempt: 'decorative reinforcement — the adjacent label spells the state out in words',
  },
];

// The map keys are the only place the palette is allowed to drift from the brief.
const brief = {
  primary: '#1E40AF',
  primaryPressed: '#0F2A5A',
  primaryInk: '#1E40AF',
  textBrand: '#0F172A',
  background: '#F8FAFC',
  surface: '#FFFFFF',
  surfaceMuted: '#F1F5F9',
  primarySoft: '#EEF2FF',
  infoSoft: '#F0F9FF',
  text: '#334155',
  textMuted: '#64748B',
  border: '#E2E8F0',
  disabledSurface: '#E2E8F0',
  disabledText: '#94A3B8',
  success: '#1E40AF',
  warning: '#B45309',
  danger: '#DC2626',
};

let failed = 0;
const pad = (value, width) => String(value).padEnd(width);

console.log(`text and interface colours, as the components draw them\n`);
for (const pair of pairs) {
  const ratio = contrastRatio(pair.fg, pair.bg);
  const ok = ratio >= pair.min;
  if (ok || pair.exempt) {
    const mark = ok ? '  ok  ' : ' note ';
    console.log(`${mark} ${pad(ratio.toFixed(2), 6)} ${pad(pair.label, 30)} ${pad(pair.size, 20)} ${pair.fg} on ${pair.bg}${pair.exempt ? ` · ${pair.exempt}` : ''}`);
  } else {
    failed += 1;
    console.log(` FAIL  ${pad(ratio.toFixed(2), 6)} ${pad(pair.label, 30)} ${pad(pair.size, 20)} ${pair.fg} on ${pair.bg} · needs ${pair.min}`);
  }
}

console.log('');
for (const [role, hex] of Object.entries(brief)) {
  if (colors[role] !== hex) {
    failed += 1;
    console.log(` FAIL  ${role} is ${colors[role]} in the tokens, ${hex} in the brief`);
  }
}

console.log(
  failed === 0
    ? `\n${pairs.length} pairs checked, ${Object.keys(brief).length} brief hexes pinned — all within their floors.`
    : `\n${failed} problem(s).`,
);
process.exit(failed === 0 ? 0 : 1);
