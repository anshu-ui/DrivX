import { theme, type Theme } from '@drivx/design-tokens';

/** Website-matched palette for the customer and driver mobile surfaces only. */
export const mobileTheme = {
  ...theme,
  colors: {
    ...theme.colors,
    background: '#fbfaf7',
    surface: '#ffffff',
    surfaceMuted: '#f4f1ea',
    surfaceBrand: '#102a52',
    border: '#e8e5df',
    borderFocus: '#2563eb',
    text: '#172238',
    textMuted: '#657184',
    textFaint: '#657184',
    textBrand: '#102a52',
    textOnBrand: '#ffffff',
    primary: '#2563eb',
    primaryPressed: '#1d4ed8',
    primaryInk: '#102a52',
    primarySoft: '#eaf0fb',
    onPrimary: '#ffffff',
    neutralAction: '#102a52',
    neutralActionPressed: '#0b1d38',
    success: '#2563eb',
    successSoft: '#eaf0fb',
  },
  palette: {
    ...theme.palette,
    brand: '#2563eb',
    brandDeep: '#1d4ed8',
    brandBright: '#2563eb',
    brandTint: '#eaf0fb',
    brandTintDeep: '#dce8ff',
    ink: '#102a52',
    inkDeep: '#0b1d38',
    ground: '#fbfaf7',
    white: '#ffffff',
    body: '#172238',
    secondary: '#657184',
    faint: '#657184',
    border: '#e8e5df',
    panel: '#f4f1ea',
  },
  support: {
    ...theme.support,
    brandSoft: '#eaf0fb',
    brandDeep: '#102a52',
    successSoft: '#eaf0fb',
    successDeep: '#102a52',
    hairline: 'rgba(16, 42, 82, 0.08)',
    scrim: 'rgba(16, 42, 82, 0.45)',
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
