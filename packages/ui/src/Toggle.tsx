import { Platform, Switch, type SwitchProps } from 'react-native';
import { useTheme } from './ThemeProvider';

export type ToggleProps = {
  value: boolean;
  onValueChange: (next: boolean) => void;
  accessibilityLabel: string;
  disabled?: boolean;
};

/**
 * The platform switch, coloured from the theme.
 *
 * `trackColor` and `thumbColor` are enough on device, but the web build paints
 * the thumb in Material's default accent for the on state unless `activeThumbColor` is set,
 * and no React Native type declares it. Passing it here once keeps every screen
 * from re-solving the same cross-platform colour problem.
 */
export function Toggle({ value, onValueChange, accessibilityLabel, disabled = false }: ToggleProps) {
  const theme = useTheme();
  const track = { false: theme.colors.border, true: theme.colors.primarySoft };
  const common = { value, onValueChange, accessibilityLabel, disabled, trackColor: track };

  if (Platform.OS === 'web') {
    return (
      <Switch
        {...({ ...common, activeThumbColor: theme.colors.primary } as Partial<SwitchProps>)}
      />
    );
  }

  return (
    <Switch
      {...common}
      thumbColor={value ? theme.colors.primary : theme.colors.surfaceMuted}
    />
  );
}
