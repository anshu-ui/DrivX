import { theme, type Theme } from '@drivx/design-tokens';

/** Customer and Driver surfaces share the light, premium DrivX palette. */
export const mobileTheme = {
  ...theme,
  colors: {
    ...theme.colors,
    background: '#FFFFFF',
    surface: '#FFFFFF',
    surfaceMuted: '#F5F7FA',
    surfaceBrand: '#17171B',
    border: '#E6EAF0',
    borderFocus: '#2563EB',
    text: '#25282E',
    textMuted: '#74777D',
    textFaint: '#96989D',
    textBrand: '#17171B',
    textOnBrand: '#FFFFFF',
    primary: '#2563EB',
    primaryPressed: '#1D4ED8',
    primaryInk: '#2563EB',
    primarySoft: '#EAF0FF',
    onPrimary: '#FFFFFF',
    neutralAction: '#17171B',
    neutralActionPressed: '#101114',
    success: '#16734A',
    successSoft: '#E5F2E9',
  },
  palette: {
    ...theme.palette,
    brand: '#2563EB',
    brandDeep: '#1D4ED8',
    brandBright: '#2563EB',
    brandTint: '#EAF0FF',
    brandTintDeep: '#DCE6FF',
    ink: '#17171B',
    inkDeep: '#101114',
    ground: '#FFFFFF',
    white: '#FFFFFF',
    body: '#25282E',
    secondary: '#74777D',
    faint: '#96989D',
    border: '#E6EAF0',
    panel: '#F5F7FA',
  },
  support: {
    ...theme.support,
    brandSoft: '#EAF0FF',
    brandDeep: '#17171B',
    successSoft: '#E5F2E9',
    successDeep: '#12633E',
    hairline: 'rgba(23, 23, 27, 0.09)',
    scrim: 'rgba(23, 23, 27, 0.50)',
  },
  fontFamily: {
    ...theme.fontFamily,
    display: 'PlusJakartaSans_800ExtraBold',
    text: 'PlusJakartaSans_400Regular',
    textMedium: 'PlusJakartaSans_500Medium',
    textSemiBold: 'PlusJakartaSans_600SemiBold',
    textBold: 'PlusJakartaSans_700Bold',
    textExtraBold: 'PlusJakartaSans_800ExtraBold',
  },
} as unknown as Theme;

export function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function firstNameOf(name: string | null | undefined, fallback: string): string {
  const first = name?.trim().split(/\s+/)[0];
  return first || fallback;
}
