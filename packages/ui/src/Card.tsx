import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from './ThemeProvider';

export type CardProps = {
  children: React.ReactNode;
  /**
   * `raised` is the standard white card, `flat` the same without shadow,
   * `brand` a deep-blue surface used for featured trip details, and `inset` a
   * softly tinted panel for notes and footers.
   */
  tone?: 'raised' | 'flat' | 'brand' | 'inset';
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function Card({ children, tone = 'raised', padded = true, style, testID }: CardProps) {
  const theme = useTheme();
  const { colors } = theme;
  const isInset = tone === 'inset';

  const surface = {
    raised: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: theme.borderWidth.thin,
      ...theme.elevation.card,
    },
    flat: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: theme.borderWidth.thin,
    },
    brand: {
      backgroundColor: colors.surfaceBrand,
      borderColor: 'transparent',
      ...theme.elevation.floating,
    },
    inset: {
      backgroundColor: colors.surfaceMuted,
      borderColor: colors.border,
      borderWidth: theme.borderWidth.hairline,
    },
  }[tone];

  return (
    <View
      testID={testID}
      style={[
        styles.base,
        // Cards sit at 24; an inset panel is a footnote, not a card.
        {
          borderRadius: theme.radius.lg,
          padding: padded ? (isInset ? theme.spacing.md : theme.spacing.lg) : 0,
        },
        surface,
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    overflow: 'hidden',
  },
});
