import { StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { useTheme } from './ThemeProvider';

export type PillTone = 'neutral' | 'brand' | 'info' | 'success' | 'warning' | 'danger';

/**
 * Status is one of five fixed colours, used the same way in all three surfaces:
 * success blue, warning amber, danger red, info sky, neutral grey. The text
 * comes from `statusInk` so it clears AA against its own tint. `info` keeps a
 * separate ground from `primarySoft`, because under a navy brand a brand-blue
 * pill would read as "press me" rather than as a neutral fact.
 */
export function StatusPill({ label, tone = 'neutral' }: { label: string; tone?: PillTone }) {
  const theme = useTheme();

  const colors = {
    neutral: { bg: theme.colors.surfaceMuted, fg: theme.statusInk.neutral },
    brand: { bg: theme.colors.surfaceBrand, fg: theme.colors.textOnBrand },
    info: { bg: theme.colors.infoSoft, fg: theme.statusInk.info },
    success: { bg: theme.colors.successSoft, fg: theme.statusInk.success },
    warning: { bg: theme.colors.warningSoft, fg: theme.statusInk.warning },
    danger: { bg: theme.colors.dangerSoft, fg: theme.statusInk.danger },
  }[tone];

  return (
    <View
      style={[
        styles.pill,
        {
          backgroundColor: colors.bg,
          borderRadius: theme.radius.pill,
          paddingHorizontal: theme.spacing.sm,
        },
      ]}
    >
      <Text variant="overline" style={{ color: colors.fg }}>
        {label}
      </Text>
    </View>
  );
}

export function Divider({ size = 'lg' }: { size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const theme = useTheme();
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.border,
        marginVertical: theme.spacing[size],
      }}
    />
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
    minHeight: 24,
    justifyContent: 'center',
  },
});
