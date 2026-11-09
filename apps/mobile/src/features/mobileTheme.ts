import { theme, type Theme } from '@drivx/design-tokens';

/** Customer and Driver share the warm paper palette and typography used by the app mockup. */
export const mobileTheme = {
  ...theme,
  radius: {
    ...theme.radius,
    md: 14,
    lg: 18,
    xl: 24,
  },
  colors: {
    ...theme.colors,
    // A very light cream ground keeps the screens soft without tinting cards.
    background: '#F7F6F2',
    surface: '#FFFEFC',
    surfaceMuted: '#F2F0EB',
    surfaceBrand: '#172033',
    border: '#E8E5DE',
    borderFocus: '#315EE8',
    text: '#172033',
    textMuted: '#727B8B',
    textFaint: '#8991A0',
    textBrand: '#172033',
    textOnBrand: '#FFFFFF',
    primary: '#315EE8',
    primaryPressed: '#244CCA',
    primaryInk: '#244CCA',
    primarySoft: '#EAF0FF',
    onPrimary: '#FFFFFF',
    neutralAction: '#172033',
    neutralActionPressed: '#101827',
    success: '#168A5B',
    successSoft: '#E8F6EF',
  },
  palette: {
    ...theme.palette,
    brand: '#315EE8',
    brandDeep: '#244CCA',
    brandBright: '#315EE8',
    brandTint: '#EAF0FF',
    brandTintDeep: '#DCE6FF',
    ink: '#172033',
    inkDeep: '#101827',
    ground: '#F7F6F2',
    white: '#FFFEFC',
    body: '#172033',
    secondary: '#727B8B',
    faint: '#8991A0',
    border: '#E8E5DE',
    panel: '#F2F0EB',
  },
  support: {
    ...theme.support,
    brandSoft: '#EAF0FF',
    brandDeep: '#244CCA',
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
