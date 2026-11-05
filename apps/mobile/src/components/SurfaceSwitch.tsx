import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Button, Card, Text, useTheme } from '@drivx/ui';
import { useSession, type Surface } from '../features/auth/AuthProvider';

const COPY: Record<Surface, { heading: string; action: string }> = {
  customer: {
    heading: 'This number also has a customer account.',
    action: 'Open the customer app',
  },
  driver: {
    heading: 'This number also has a driver account.',
    action: 'Open the driver app',
  },
};

/**
 * The door between the two accounts one phone number can hold.
 *
 * It renders only when the signed-in account genuinely holds both, so a
 * customer never sees a switch that would take them somewhere they cannot
 * work. The choice is stored on this device, not on the account: the same
 * person may keep the driver app open on their phone and the customer app on a
 * tablet at the same time.
 */
export function SurfaceSwitch() {
  const theme = useTheme();
  const { surface, surfaces, chooseSurface } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const other = surfaces.find((candidate) => candidate !== surface);
  if (!other) return null;

  const switchTo = async () => {
    setBusy(true);
    setError(null);
    try {
      const resolved = await chooseSurface(other);
      // Replace, never push: the screens of the app being left must not stay on
      // the stack behind the one that just opened.
      if (!resolved) return;
      router.replace(
        resolved.needsProfile ? '/create-profile' : other === 'driver' ? '/(driver)' : '/(customer)',
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not switch.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card tone="inset">
      <View style={{ gap: theme.spacing.sm }}>
        <Text variant="body" tone="default">
          {COPY[other].heading}
        </Text>
        {error ? (
          <Text variant="caption" tone="danger">
            {error}
          </Text>
        ) : null}
        <Button
          label={busy ? 'Switching…' : COPY[other].action}
          appearance="secondary"
          size="sm"
          disabled={busy}
          onPress={() => void switchTo()}
        />
      </View>
    </Card>
  );
}
