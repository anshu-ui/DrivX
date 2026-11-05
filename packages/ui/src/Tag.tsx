import type { ReactNode } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from './ThemeProvider';
import { Text } from './Text';

type TagTone = 'success' | 'neutral' | 'onBrand' | 'outline';

/**
 * The small rounded tag the reference screen scatters across its header rows —
 * "Your Car", "Police verified", "Live". Unlike `StatusPill` it can sit on a
 * dark surface and it can carry a leading dot, because on this screen the tag
 * next to a live driver count is the one place colour is allowed to speak.
 */
export function Tag({
  label,
  tone = 'success',
  dot = false,
  icon,
  style,
}: {
  label: string;
  tone?: TagTone;
  /** A bright dot before the label, for a state that is true right now. */
  dot?: boolean;
  icon?: ReactNode;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const onBrand = tone === 'onBrand';

  const colors = {
    success: { bg: theme.colors.successSoft, fg: theme.statusInk.success, border: 'transparent' },
    neutral: { bg: theme.colors.surfaceMuted, fg: theme.colors.textFaint, border: theme.colors.border },
    onBrand: {
      bg: theme.colors.primarySoft,
      fg: theme.colors.primaryInk,
      border: 'transparent',
    },
    outline: { bg: 'transparent', fg: theme.colors.primaryInk, border: theme.colors.primary },
  }[tone];

  return (
    <View
      style={[
        styles.tag,
        {
          backgroundColor: colors.bg,
          borderColor: colors.border,
          borderWidth: tone === 'outline' ? theme.borderWidth.thin : 0,
          borderRadius: theme.radius.sm,
          paddingHorizontal: theme.spacing.sm,
          paddingVertical: onBrand ? 3 : 4,
        },
        style,
      ]}
    >
      {dot ? (
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: theme.palette.brandBright,
          }}
        />
      ) : null}
      {icon}
      <Text
        variant="overline"
        style={{ color: colors.fg, fontSize: theme.fontSize.xs - 1, letterSpacing: 0.5 }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
});
