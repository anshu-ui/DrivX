import { theme, type Theme } from '@drivx/design-tokens';

/** Customer and Driver surfaces share DrivX's royal blue, white and silver system. */
export const mobileTheme = {
  ...theme,
  colors: {
    ...theme.colors,
    background: '#F8FAFC',
    surface: '#FFFFFF',
    surfaceMuted: '#F1F5F9',
    surfaceBrand: '#17171B',
    border: '#E2E8F0',
    borderFocus: '#2563EB',
    text: '#1E293B',
    textMuted: '#64748B',
    textFaint: '#64748B',
    textBrand: '#17171B',
    textOnBrand: '#FFFFFF',
    primary: '#2563EB',
    primaryPressed: '#1D4ED8',
    primaryInk: '#2563EB',
    primarySoft: '#EFF6FF',
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
    brandTint: '#EFF6FF',
    brandTintDeep: '#DBEAFE',
    ink: '#17171B',
    inkDeep: '#101114',
    ground: '#F8FAFC',
    white: '#FFFFFF',
    body: '#1E293B',
    secondary: '#64748B',
    faint: '#64748B',
    border: '#E2E8F0',
    panel: '#F1F5F9',
  },
  support: {
    ...theme.support,
    brandSoft: '#EFF6FF',
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
