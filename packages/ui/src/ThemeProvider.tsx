import { createContext, useContext } from 'react';
import { theme as defaultTheme, type Theme } from '@drivx/design-tokens';

const ThemeContext = createContext<Theme>(defaultTheme);

/**
 * Wrapping the app in ThemeProvider is optional — the tokens are static for
 * launch — but keeping the context lets a dark variant land without touching
 * every component.
 */
export function ThemeProvider({ theme, children }: { theme?: Theme; children: React.ReactNode }): React.JSX.Element {
  return <ThemeContext.Provider value={theme ?? defaultTheme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

export { defaultTheme };
export type { Theme };
