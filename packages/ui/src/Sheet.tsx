import { Modal, Pressable, ScrollView, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from './Button';
import { Text } from './Text';
import { useTheme } from './ThemeProvider';

export type SheetProps = {
  open: boolean;
  /** The heading the panel slides in under, e.g. `PRICING`. */
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Replaces the default Close button — pass the actions this panel owes. */
  footer?: React.ReactNode;
  /** Shown under the title, for the one line a customer reads before the list. */
  subtitle?: string;
  label?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * A panel that rises from the bottom of the screen and owns the screen while it
 * is open.
 *
 * The rate card and the price-update alert both need one, and neither should
 * carry its own scrim, dismiss behaviour and safe-area padding. Tapping the
 * dark area closes it; the footer button is the same action spelled out, because
 * a panel that only closes on an invisible target is a panel you get stuck in.
 */
export function Sheet({
  open,
  title,
  onClose,
  children,
  footer,
  subtitle,
  label = 'Close',
  style,
  testID,
}: SheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: theme.colors.scrim }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Dismiss ${title}`}
          onPress={onClose}
          style={{ flex: 1 }}
        />
        <View
          accessibilityViewIsModal
          testID={testID}
          style={[
            {
              backgroundColor: theme.colors.surface,
              borderTopLeftRadius: theme.radius.xl,
              borderTopRightRadius: theme.radius.xl,
              paddingTop: theme.spacing.sm,
              paddingHorizontal: theme.spacing.lg,
              paddingBottom: theme.spacing.lg + insets.bottom,
              gap: theme.spacing.md,
              maxHeight: '80%',
            },
            theme.elevation.overlay,
            style,
          ]}
        >
          <View
            style={{
              alignSelf: 'center',
              width: 40,
              height: 4,
              borderRadius: 2,
              backgroundColor: theme.colors.border,
            }}
          />
          <View style={{ gap: theme.spacing.xxs }}>
            <Text variant="subheading" tone="brand">
              {title}
            </Text>
            {subtitle ? (
              <Text variant="caption" tone="muted">
                {subtitle}
              </Text>
            ) : null}
          </View>
          <ScrollView showsVerticalScrollIndicator={false} style={{ flexGrow: 0 }}>
            <View style={{ gap: theme.spacing.md }}>{children}</View>
          </ScrollView>
          {footer ?? (
            <Button label={label} onPress={onClose} appearance="brand" fullWidth size="lg" />
          )}
        </View>
      </View>
    </Modal>
  );
}
