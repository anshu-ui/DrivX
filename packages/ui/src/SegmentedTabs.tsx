import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from './ThemeProvider';
import { Text } from './Text';

export type Segment<T extends string> = {
  id: T;
  title: string;
  icon?: React.ReactNode;
  /** A small chip inside the segment — "Your Car", a count — passed in by the caller. */
  badge?: React.ReactNode;
  /**
   * Shown rather than hidden because the option is real but unavailable: a
   * disabled segment that says nothing reads as a broken control.
   */
  disabled?: boolean;
  note?: string;
};

/**
 * The single-select row that appears twice on the booking screen.
 *
 * `filled` is the mode switch — an ink block on a grey ground, the heaviest
 * choice on the page. `card` is a tab strip — a white block lifted out of the
 * same grey ground, which reads as "one of several" rather than "the decision".
 * `ink` is the account switcher in the top bar: a bordered white rail whose
 * active slot is filled with near-black, because it states who you are rather
 * than what you want. Both resolve selection by shape and ground, never by
 * colour alone, so the active segment survives a screen that renders navy as
 * a mid-tone.
 */
export function SegmentedTabs<T extends string>({
  options,
  value,
  onChange,
  variant = 'card',
  accessibilityLabel,
  style,
}: {
  options: Segment<T>[];
  value: T | null;
  onChange: (id: T) => void;
  variant?: 'filled' | 'card' | 'ink';
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const filled = variant === 'filled';
  const ink = variant === 'ink';

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={[
        {
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: theme.spacing.xs,
          padding: theme.spacing.xs,
          backgroundColor: ink ? theme.colors.surface : theme.colors.surfaceMuted,
          borderColor: ink ? theme.colors.border : 'transparent',
          borderWidth: ink ? theme.borderWidth.thin : 0,
          borderRadius: filled ? theme.radius.xl : ink ? theme.radius.lg : theme.radius.lg,
        },
        style,
      ]}
    >
      {options.map((option) => {
        const active = option.id === value;
        const colors = filled
          ? {
              bg: active ? theme.colors.surfaceBrand : 'transparent',
              fg: active ? theme.colors.textOnBrand : theme.colors.textBrand,
              border: 'transparent',
            }
          : ink
            ? {
                bg: active ? theme.colors.surfaceBrand : 'transparent',
                fg: active ? theme.colors.textOnBrand : theme.colors.textMuted,
                border: 'transparent',
              }
            : {
                bg: active ? theme.colors.surface : 'transparent',
                fg: active ? theme.colors.textBrand : theme.colors.textMuted,
                border: active ? theme.colors.border : 'transparent',
              };

        return (
          <Pressable
            key={option.id}
            accessibilityRole="button"
            accessibilityState={{ selected: active, disabled: Boolean(option.disabled) }}
            accessibilityLabel={option.note ? `${option.title}. ${option.note}` : option.title}
            disabled={Boolean(option.disabled)}
            onPress={() => onChange(option.id)}
            style={({ pressed }) => [
              styles.segment,
              {
                flex: 1,
                // A one-line label gives a segment an intrinsic width, and a CSS
                // flex row will not shrink an item below its content unless told
                // to. Without minWidth 0 three long service names push the whole
                // column past the viewport on a phone.
                flexBasis: 150,
                minWidth: 0,
                gap: theme.spacing.xs,
                minHeight: filled ? 52 : 40,
                paddingHorizontal: theme.spacing.sm,
                borderRadius: filled ? theme.radius.lg : theme.radius.md,
                backgroundColor: pressed && !option.disabled ? theme.colors.primarySoft : colors.bg,
                borderColor: colors.border,
                borderWidth: theme.borderWidth.thin,
                opacity: option.disabled ? 0.55 : 1,
              },
              active && variant === 'card' ? theme.elevation.card : null,
            ]}
          >
            {option.icon ? <View style={styles.icon}>{option.icon}</View> : null}
            <Text
              variant={filled ? 'button' : 'label'}
              numberOfLines={2}
              style={{
                color: option.disabled ? theme.colors.disabledText : colors.fg,
                // Without this the label keeps its one-word intrinsic width and
                // the segment truncates to "Chauffeur b…" instead of wrapping.
                flexShrink: 1,
                minWidth: 0,
                textAlign: 'center',
              }}
            >
              {option.title}
            </Text>
            {option.badge}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  segment: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: { alignItems: 'center' },
});
