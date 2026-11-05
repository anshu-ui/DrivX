import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from './ThemeProvider';
import { Text } from './Text';

/**
 * The heading block every screen repeats: an eyebrow, the screen title in
 * near-black slate ink, one line of context, and an optional right-hand action.
 */
export function ScreenHeader({
  eyebrow,
  title,
  subtitle,
  action,
  style,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();

  return (
    <View style={[styles.root, { gap: theme.spacing.md }, style]}>
      <View style={[styles.copy, { gap: theme.spacing.xs }]}>
        {eyebrow ? (
          <Text variant="overline" tone="muted">
            {eyebrow}
          </Text>
        ) : null}
        <Text variant="title" tone="brand">
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="muted">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  // Without flex the text block takes its intrinsic width, so a long eyebrow
  // runs off the edge instead of wrapping — minWidth 0 is what lets it shrink.
  copy: { flex: 1, minWidth: 0 },
  action: { paddingTop: 4 },
});
