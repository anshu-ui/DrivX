import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from './ThemeProvider';
import { Text } from './Text';

/**
 * The card from the booking screen: a thin-bordered white panel whose header is
 * a glyph, a readable title and one right-hand action.
 */
export function SectionCard({
  icon,
  title,
  action,
  children,
  footer,
  style,
  testID,
}: {
  icon?: React.ReactNode;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const theme = useTheme();

  return (
    <View
      testID={testID}
      style={[
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderWidth: theme.borderWidth.thin,
          borderRadius: theme.radius.xl,
          padding: theme.spacing.lg,
          gap: theme.spacing.md,
        },
        theme.elevation.card,
        style,
      ]}
    >
      <View style={[styles.header, { gap: theme.spacing.sm }]}>
        {icon ? <View style={styles.headerIcon}>{icon}</View> : null}
        <Text
          variant="bodyStrong"
          tone="default"
          style={{
            flexShrink: 1,
          }}
        >
          {title}
        </Text>
        <View style={styles.headerSpacer} />
        {action}
      </View>

      <View style={{ gap: theme.spacing.md }}>{children}</View>

      {footer}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center' },
  headerIcon: { alignItems: 'center', justifyContent: 'center' },
  // Keeps the action pinned right even when the title is long enough to wrap.
  headerSpacer: { flex: 1 },
});
