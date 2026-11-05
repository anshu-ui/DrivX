import { colors, theme } from './theme';
import { webShadow } from './elevation';

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * CSS custom properties for the web surfaces (admin dashboard).
 *
 * The hex values stay in `colors.ts` and are projected here, so the browser
 * build cannot drift from the values the mobile apps render.
 */
export function cssVariables(): string {
  const entries = [
    ...Object.entries(colors).map(([name, value]) => `--dx-${kebab(name)}:${value}`),
    ...Object.entries(theme.statusInk).map(([name, value]) => `--dx-badge-${kebab(name)}:${value}`),
    ...Object.entries(theme.radius).map(([name, value]) => `--dx-radius-${kebab(name)}:${value}px`),
    ...Object.entries(theme.spacing).map(([name, value]) => `--dx-space-${kebab(name)}:${value}px`),
    ...Object.entries(webShadow).map(([name, value]) => `--dx-shadow-${kebab(name)}:${value}`),
  ];
  return `:root{${entries.join(';')}}`;
}
