import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from './ThemeProvider';
import { Text } from './Text';

/**
 * A radio-styled card for a small set of mutually exclusive requests, used for
 * transmission. Heavier than a chip because the reference screen treats it as
 * the one choice that decides which driver is sent.
 */
export function OptionCard({
  title,
  note,
  icon,
  selected,
  onPress,
  style,
}: {
  title: string;
  note?: string;
  icon?: ReactNode;
  selected: boolean;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const ring = 18;

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected, checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          flex: 1,
          flexBasis: 160,
          minWidth: 0,
          gap: theme.spacing.sm,
          minHeight: 56,
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.sm,
          borderRadius: theme.radius.lg,
          backgroundColor: pressed
            ? theme.colors.primarySoft
            : selected
              ? theme.colors.surface
              : theme.colors.surfaceMuted,
          borderColor: selected ? theme.colors.textBrand : theme.colors.border,
          // The selected card gains a border rather than a colour, so a row of
          // them stays legible on a screen that already uses brand navy for actions.
          borderWidth: selected ? theme.borderWidth.focus : theme.borderWidth.thin,
        },
        style,
      ]}
    >
      <View
        style={[
          styles.radio,
          {
            width: ring,
            height: ring,
            borderRadius: ring / 2,
            borderColor: selected ? theme.colors.textBrand : theme.colors.disabledText,
            borderWidth: theme.borderWidth.thin,
          },
        ]}
      >
        {selected ? (
          <View
            style={{
              width: ring - 8,
              height: ring - 8,
              borderRadius: (ring - 8) / 2,
              backgroundColor: theme.colors.textBrand,
            }}
          />
        ) : null}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="bodyStrong" tone="brand" numberOfLines={1}>
          {title}
        </Text>
        {note ? (
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {note}
          </Text>
        ) : null}
      </View>
      {icon ? <View style={styles.icon}>{icon}</View> : null}
    </Pressable>
  );
}

/** A multi-select chip: the shape the preference and body-type rows take. */
export function Chip({
  title,
  selected,
  onPress,
  icon,
  style,
  disabled = false,
}: {
  title: string;
  selected: boolean;
  onPress: () => void;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /**
   * For a choice that is real but no longer available — a departure slot that
   * has already passed. Hidden controls leave the customer guessing; a greyed
   * one explains itself.
   */
  disabled?: boolean;
}) {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          gap: theme.spacing.xs,
          minHeight: 40,
          paddingHorizontal: theme.spacing.md,
          borderRadius: theme.radius.lg,
          backgroundColor: selected
            ? theme.colors.surface
            : pressed
              ? theme.colors.surfaceMuted
              : theme.colors.surface,
          borderColor: selected ? theme.colors.textBrand : theme.colors.border,
          borderWidth: selected ? theme.borderWidth.focus : theme.borderWidth.thin,
          opacity: disabled ? 0.45 : 1,
        },
        style,
      ]}
    >
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      <Text variant="label" tone={selected ? 'brand' : 'muted'} numberOfLines={1}>
        {title}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  radio: { alignItems: 'center', justifyContent: 'center' },
  icon: { alignItems: 'center' },
});
