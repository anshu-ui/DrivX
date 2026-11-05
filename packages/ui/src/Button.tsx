import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useState } from 'react';
import { useTheme } from './ThemeProvider';
import { Text } from './Text';

type Appearance = 'primary' | 'brand' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

export type ButtonProps = {
  label: string;
  onPress: () => void;
  appearance?: Appearance;
  size?: Size;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  selected?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Read aloud by screen readers in place of the visible label. */
  accessibilityLabel?: string;
  testID?: string;
};

/**
 * Every appearance resolves four states — rest, pressed, focused and disabled —
 * from colour rather than opacity, so "tap to confirm" and "this cannot be
 * tapped" are legible without guessing.
 */
export function Button({
  label,
  onPress,
  appearance = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  fullWidth = false,
  selected,
  iconLeft,
  iconRight,
  style,
  accessibilityLabel,
  testID,
}: ButtonProps) {
  const theme = useTheme();
  const inactive = disabled || loading;
  const { colors } = theme;
  // RN's pressable state has no focus flag, and the blue focus ring is what a
  // keyboard or remote user sees instead of a hover state.
  const [focused, setFocused] = useState(false);

  const paletteFor = (kind: Appearance) => {
    switch (kind) {
      case 'primary':
        return {
          bg: colors.primary,
          bgPressed: colors.primaryPressed,
          fg: colors.onPrimary,
          border: 'transparent',
          borderPressed: 'transparent',
        };
      case 'brand':
        return {
          bg: selected ? colors.primarySoft : colors.neutralAction,
          bgPressed: selected ? colors.primarySoft : colors.neutralActionPressed,
          fg: selected ? colors.primaryInk : colors.textOnBrand,
          border: selected ? colors.primary : 'transparent',
          borderPressed: selected ? colors.primary : 'transparent',
        };
      case 'secondary':
        return {
          bg: selected ? colors.primarySoft : colors.surface,
          bgPressed: selected ? colors.primarySoft : colors.surfaceMuted,
          fg: selected ? colors.primaryInk : colors.textBrand,
          border: selected ? colors.primary : colors.border,
          borderPressed: selected ? colors.primary : colors.border,
        };
      case 'ghost':
        return {
          bg: 'transparent',
          bgPressed: colors.primarySoft,
          fg: colors.primaryInk,
          border: 'transparent',
          borderPressed: 'transparent',
        };
      case 'danger':
        return {
          bg: colors.danger,
          bgPressed: colors.dangerPressed,
          fg: colors.onPrimary,
          border: 'transparent',
          borderPressed: 'transparent',
        };
    }
  };

  const palette = paletteFor(appearance);
  const heights: Record<Size, number> = {
    sm: theme.sizing.buttonSm,
    md: theme.sizing.inputHeight,
    lg: theme.sizing.buttonLg,
  };
  const paddings: Record<Size, number> = { sm: theme.spacing.sm, md: theme.spacing.md, lg: theme.spacing.lg };

  const foreground = inactive ? colors.disabledText : palette.fg;
  const background = inactive
    ? appearance === 'secondary' || appearance === 'ghost'
      ? 'transparent'
      : colors.disabledSurface
    : palette.bg;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, selected, busy: loading }}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      disabled={inactive}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: Math.max(heights[size], theme.sizing.touchTarget),
          paddingHorizontal: paddings[size],
          backgroundColor: background,
          borderColor: focused && !inactive ? colors.borderFocus : palette.border,
          borderWidth: focused && !inactive ? theme.borderWidth.focus : theme.borderWidth.thin,
          borderRadius: theme.radius.md,
          alignSelf: fullWidth ? 'stretch' : 'auto',
        },
        pressed && !inactive && {
          backgroundColor: palette.bgPressed,
          borderColor: palette.borderPressed,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={inactive ? colors.disabledText : palette.fg} />
      ) : (
        <View style={styles.content}>
          {iconLeft ? <View style={styles.iconGap}>{iconLeft}</View> : null}
          <Text variant="button" style={{ color: foreground }} numberOfLines={1}>
            {label}
          </Text>
          {iconRight ? <View style={styles.iconGap}>{iconRight}</View> : null}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconGap: {
    marginHorizontal: 4,
  },
});
