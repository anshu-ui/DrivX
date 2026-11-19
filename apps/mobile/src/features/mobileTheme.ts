import { theme, type Theme } from '@drivx/design-tokens';

/** Customer and Driver share the clean, cool-white app palette and typography. */
export const mobileTheme = {
  ...theme,
  radius: {
    ...theme.radius,
    md: 16,
    lg: 20,
    xl: 24,
  },
  sizing: {
    ...theme.sizing,
    inputHeight: 56,
    buttonLg: 58,
    cardGap: 18,
  },
  colors: {
    ...theme.colors,
    // Cool white page ground with softly tinted panels for clear hierarchy.
    background: '#F6F8FC',
    surface: '#FFFFFF',
    surfaceMuted: '#F1F5FB',
    surfaceBrand: '#172033',
    border: '#E3E9F2',
    borderFocus: '#2563EB',
    text: '#172033',
    // Keep helper text and timestamps readable on white and blue-tinted panels.
    textMuted: '#64748B',
    textFaint: '#475569',
    textBrand: '#172033',
    textOnBrand: '#FFFFFF',
    primary: '#2563EB',
    primaryPressed: '#1D4ED8',
    primaryInk: '#1D4ED8',
    primarySoft: '#EFF6FF',
    onPrimary: '#FFFFFF',
    neutralAction: '#172033',
    neutralActionPressed: '#101827',
    success: '#168A5B',
    successSoft: '#E8F6EF',
  },
  palette: {
    ...theme.palette,
    brand: '#2563EB',
    brandDeep: '#1D4ED8',
    brandBright: '#2563EB',
    brandTint: '#EFF6FF',
    brandTintDeep: '#DBEAFE',
    ink: '#172033',
    inkDeep: '#101827',
    ground: '#F6F8FC',
    white: '#FFFFFF',
    body: '#172033',
    secondary: '#64748B',
    faint: '#475569',
    border: '#E3E9F2',
    panel: '#F1F5FB',
  },
  elevation: {
    ...theme.elevation,
    card: {
      shadowColor: '#172033',
      shadowOpacity: 0.06,
      shadowRadius: 9,
      shadowOffset: { width: 0, height: 3 },
      elevation: 2,
    },
    floating: {
      shadowColor: '#172033',
      shadowOpacity: 0.12,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 7 },
      elevation: 7,
    },
  },
  support: {
    ...theme.support,
    brandSoft: '#EFF6FF',
    brandDeep: '#1D4ED8',
    successSoft: '#E8F6EF',
    successDeep: '#0F6C48',
    hairline: 'rgba(23, 32, 51, 0.09)',
    scrim: 'rgba(23, 32, 51, 0.50)',
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
