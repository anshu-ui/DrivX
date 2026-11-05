import { forwardRef, useState, type ComponentRef } from 'react';
import {
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { Text } from './Text';
import { useTheme } from './ThemeProvider';

export type FieldProps = TextInputProps & {
  label: string;
  /** Visible only after the field is touched; never used as a placeholder. */
  error?: string | null;
  helper?: string | null;
  optional?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
};

/**
 * Inputs start empty and carry no placeholder copy — helper text sits outside
 * the field so nothing reads as pre-filled data. The border is the state:
 * hairline grey at rest, blue while focused, red with an inline message.
 */
export const Field = forwardRef<ComponentRef<typeof TextInput>, FieldProps>(function Field(
  { label, error = null, helper = null, optional = false, containerStyle, style, onFocus, onBlur, editable = true, multiline = false, ...inputProps },
  ref,
) {
  const theme = useTheme();
  const { colors } = theme;
  const [focused, setFocused] = useState(false);
  const invalid = Boolean(error);
  const disabled = !editable;

  const borderColor = invalid ? colors.danger : focused ? colors.borderFocus : colors.border;

  return (
    <View style={[styles.root, containerStyle]}>
      <View style={[styles.labelRow, { marginBottom: theme.spacing.xs, gap: theme.spacing.xs }]}>
        <Text variant="label" tone={disabled ? 'faint' : 'brand'} accessibilityRole="text">
          {label}
        </Text>
        {optional ? (
          <Text variant="caption" tone="faint">
            optional
          </Text>
        ) : null}
      </View>

      <TextInput
        ref={ref}
        multiline={multiline}
        accessibilityLabel={label}
        accessibilityState={{ selected: invalid, disabled }}
        placeholderTextColor={colors.textFaint}
        editable={editable}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        style={[
          styles.input,
          {
            minHeight: multiline ? theme.sizing.inputMultilineHeight : theme.sizing.inputHeight,
            paddingTop: multiline ? theme.spacing.sm : 0,
            borderRadius: theme.radius.md,
            borderWidth: invalid || focused ? theme.borderWidth.focus : theme.borderWidth.thin,
            borderColor,
            backgroundColor: disabled ? colors.disabledSurface : colors.surface,
            color: disabled ? colors.disabledText : colors.text,
            paddingHorizontal: theme.spacing.md,
            fontFamily: theme.fontFamily.text,
            // Android centres a single line in its box; a textarea starts at the top.
            textAlignVertical: multiline ? 'top' : 'center',
          },
          style,
        ]}
        {...inputProps}
      />

      {error ? (
        <Text variant="caption" tone="danger" accessibilityRole="alert" style={{ marginTop: theme.spacing.xs }}>
          {error}
        </Text>
      ) : helper ? (
        <Text variant="caption" tone="muted" style={{ marginTop: theme.spacing.xs }}>
          {helper}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  root: { width: '100%' },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  // 16px keeps iOS Safari from zooming the page when the field takes focus.
  input: { fontSize: 16 },
});
