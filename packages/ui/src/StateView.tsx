import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Button } from './Button';
import { Text } from './Text';
import { useTheme } from './ThemeProvider';

/**
 * The non-happy paths the brief calls out explicitly. Every list and screen
 * must pick one of these rather than rendering a blank area or a spinner that
 * never resolves.
 */
export type StateKind =
  | 'loading'
  | 'empty'
  | 'error'
  | 'offline'
  | 'permission_denied'
  | 'unavailable';

export type StateViewProps = {
  kind: StateKind;
  /** Optional product-specific override; otherwise the copy below is used. */
  title?: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  /** Secondary escape hatch, e.g. "Continue without location". */
  alternateLabel?: string;
  onAlternate?: () => void;
  testID?: string;
};

const DEFAULTS: Record<StateKind, { title: string; message: string }> = {
  loading: { title: 'One moment', message: 'Fetching the latest trip information.' },
  empty: { title: 'Nothing here yet', message: 'Items will appear once there is something to show.' },
  error: { title: 'Something went wrong', message: 'We could not complete that request. Please try again.' },
  offline: {
    title: 'You are offline',
    message: 'Reconnect to refresh live location, fares and trip status.',
  },
  permission_denied: {
    title: 'Permission needed',
    message: 'This feature is unavailable because the required permission was declined.',
  },
  unavailable: {
    title: 'Temporarily unavailable',
    message: 'This service is not ready yet. You will not be charged.',
  },
};

export function StateView({
  kind,
  title,
  message,
  actionLabel,
  onAction,
  alternateLabel,
  onAlternate,
  testID,
}: StateViewProps) {
  const theme = useTheme();
  const copy = DEFAULTS[kind];
  const isBusy = kind === 'loading';

  return (
    <View
      testID={testID}
      accessibilityLiveRegion={isBusy ? 'polite' : 'assertive'}
      style={[
        styles.root,
        {
          padding: theme.spacing.xl,
          gap: theme.spacing.sm,
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius.lg,
          borderWidth: theme.borderWidth.thin,
          borderColor: theme.colors.border,
        },
      ]}
    >
      {isBusy ? <ActivityIndicator color={theme.colors.primary} /> : null}

      <Text variant="heading" tone="brand" style={styles.center}>
        {title ?? copy.title}
      </Text>
      <Text variant="caption" tone="muted" style={styles.center}>
        {message ?? copy.message}
      </Text>

      {actionLabel && onAction ? (
        <Button
          label={actionLabel}
          onPress={onAction}
          appearance={kind === 'error' || kind === 'offline' ? 'brand' : 'primary'}
          size="sm"
          style={styles.action}
        />
      ) : null}

      {alternateLabel && onAlternate ? (
        <Button label={alternateLabel} onPress={onAlternate} appearance="ghost" size="sm" />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', justifyContent: 'center' },
  center: { textAlign: 'center' },
  action: { marginTop: 4, minWidth: 160 },
});
