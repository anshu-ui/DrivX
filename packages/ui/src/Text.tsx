import { StyleSheet, Text as RNText, type TextProps } from 'react-native';
import type { TypographyVariant } from '@drivx/design-tokens';
import { useTheme } from './ThemeProvider';
import { useFontScale } from './accessibility';

type Tone = 'default' | 'muted' | 'faint' | 'brand' | 'onBrand' | 'primary' | 'success' | 'warning' | 'danger';

export type DrivXTextProps = TextProps & {
  variant?: TypographyVariant;
  tone?: Tone;
};

const toneRole = {
  default: 'text',
  muted: 'textMuted',
  faint: 'textFaint',
  brand: 'textBrand',
  onBrand: 'textOnBrand',
  /** Blue that is being read, not pressed: `primaryInk`, which clears AA as text. */
  primary: 'primaryInk',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
} as const satisfies Record<Tone, keyof ReturnType<typeof useTheme>['colors']>;

export function Text({ variant = 'body', tone = 'default', style, ...rest }: DrivXTextProps) {
  const theme = useTheme();
  const fontScale = useFontScale();
  const t = theme.typography[variant];
  const appFonts = theme.fontFamily as typeof theme.fontFamily & {
    textMedium?: string;
    textSemiBold?: string;
    textBold?: string;
    textExtraBold?: string;
  };
  const weightFont: Record<string, string | undefined> = {
    '500': appFonts.textMedium,
    '600': appFonts.textSemiBold,
    '700': appFonts.textBold,
    '800': appFonts.textExtraBold,
  };
  const selectedWeightFont = weightFont[String(t.fontWeight)];
  // The platform scales `fontSize` for us (allowFontScaling is on by default)
  // but leaves the derived metrics in design units, which clips descenders once
  // a user raises the system text size. Only leading and tracking need
  // multiplying; scaling the size here too would double-apply it on device.
  const leading = Math.round(t.fontSize * fontScale * t.lineHeight);

  return (
    <RNText
      accessibilityRole="text"
      style={[
        styles.base,
        {
          color: theme.colors[toneRole[tone]],
          fontFamily: selectedWeightFont ?? theme.fontFamily.text,
          fontSize: t.fontSize,
          lineHeight: leading,
          fontWeight: selectedWeightFont ? 'normal' : t.fontWeight,
          letterSpacing: ('letterSpacing' in t ? t.letterSpacing : 0) * fontScale,
        },
        style,
      ]}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  base: {
    // Keeps Android from clipping descenders on the larger display sizes.
    includeFontPadding: false,
  },
});
