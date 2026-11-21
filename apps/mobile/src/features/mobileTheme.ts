import { theme, type Theme } from '@drivx/design-tokens';

/** Customer and Driver share the website's warm-white, ink and blue identity. */
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
    // Match the marketing site's warm paper ground and white content cards.
    background: '#F3F0EB',
    surface: '#FFFFFF',
    surfaceMuted: '#FAF8F4',
    surfaceBrand: '#111113',
    border: '#DFDDD8',
    borderFocus: '#2563EB',
    text: '#111113',
    textMuted: '#686662',
    textFaint: '#5C5A56',
    textBrand: '#111113',
    textOnBrand: '#FFFFFF',
    primary: '#2563EB',
    primaryPressed: '#1D4ED8',
    primaryInk: '#1D4ED8',
    primarySoft: '#EFF6FF',
    onPrimary: '#FFFFFF',
    neutralAction: '#111113',
    neutralActionPressed: '#252426',
    success: '#168A5B',
    successSoft: '#EAF3EA',
  },
  palette: {
    ...theme.palette,
    brand: '#2563EB',
    brandDeep: '#1D4ED8',
    brandBright: '#2563EB',
    brandTint: '#EFF6FF',
    brandTintDeep: '#DBEAFE',
    ink: '#111113',
    inkDeep: '#252426',
    ground: '#F3F0EB',
    white: '#FFFFFF',
    body: '#111113',
    secondary: '#686662',
    faint: '#5C5A56',
    border: '#DFDDD8',
    panel: '#FAF8F4',
  },
  elevation: {
    ...theme.elevation,
    card: {
      shadowColor: '#111113',
      shadowOpacity: 0.06,
      shadowRadius: 9,
      shadowOffset: { width: 0, height: 3 },
      elevation: 2,
    },
    floating: {
      shadowColor: '#111113',
      shadowOpacity: 0.12,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 7 },
      elevation: 7,
    },
  },
  support: {
    ...theme.support,
    brandSoft: '#EEF3FF',
    brandDeep: '#1D4ED8',
    successSoft: '#EAF3EA',
    successDeep: '#0F6C48',
    hairline: 'rgba(17, 17, 19, 0.10)',
    scrim: 'rgba(17, 17, 19, 0.50)',
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
