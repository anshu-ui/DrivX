import type { ReactNode } from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from './ThemeProvider';
import { Text } from './Text';

/**
 * The grey field-shaped box that opens in place: a tiny uppercase label, the
 * value already chosen, and a control glyph on the right.
 *
 * It is not a dropdown. The options render underneath, inside the same card,
 * because a native picker on the web build opens a menu this screen cannot
 * style and a customer cannot read the price out of.
 */
export function SelectBox({
  label,
  value,
  icon,
  trailing,
  expanded = false,
  onPress,
  disabled = false,
  accessibilityLabel,
  style,
}: {
  label: string;
  value: string;
  icon?: ReactNode;
  /** The chevron / dot on the right. Omitted when the box cannot open. */
  trailing?: ReactNode;
  expanded?: boolean;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, expanded }}
      accessibilityLabel={accessibilityLabel ?? `${label}: ${value}`}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.sm,
          minHeight: 60,
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.sm,
          backgroundColor: disabled
            ? theme.colors.disabledSurface
            : pressed
              ? theme.colors.border
              : theme.colors.surfaceMuted,
          borderColor: expanded ? theme.colors.borderFocus : 'transparent',
          borderWidth: theme.borderWidth.thin,
          borderRadius: theme.radius.lg,
        },
        style,
      ]}
    >
      {icon ? <View style={{ alignItems: 'center' }}>{icon}</View> : null}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          variant="overline"
          tone={disabled ? 'faint' : 'muted'}
          style={{ fontSize: theme.fontSize.xs - 1, letterSpacing: 0.7 }}
          numberOfLines={1}
        >
          {label.toUpperCase()}
        </Text>
        <Text variant="bodyStrong" tone="brand" numberOfLines={1}>
          {value}
        </Text>
      </View>
      {trailing}
    </Pressable>
  );
}
