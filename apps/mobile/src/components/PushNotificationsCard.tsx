import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Button, Card, Text } from '@drivx/ui';
import { useSession } from '../features/auth/AuthProvider';
import { disablePushNotifications, enablePushNotifications } from '../features/customer/pushNotifications';

export function PushNotificationsCard() {
  const { user } = useSession();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const webPushConfigured = Platform.OS !== 'web'
    || Boolean(process.env.EXPO_PUBLIC_FIREBASE_VAPID_KEY
      || (typeof window !== 'undefined'
        && (window as Window & { DRIVX_FIREBASE_CONFIG?: { vapidKey?: string } }).DRIVX_FIREBASE_CONFIG?.vapidKey));

  useEffect(() => {
    let active = true;
    if (user) {
      void AsyncStorage.getItem(`drivx.push.enabled.${user.uid}`).then((value) => {
        if (active) setEnabled(value === 'true');
      });
    }
    return () => { active = false; };
  }, [user]);

  if (!user) return null;
  return (
    <Card style={{ gap: 10 }}>
      <Text variant="subheading" tone="brand">Trip push alerts</Text>
      <Text variant="caption" tone="muted">
        {!webPushConfigured
          ? 'Browser push setup needs the Firebase Web Push public key. Your in-app trip inbox still works while DrivX is open.'
          : enabled
          ? Platform.OS === 'web'
            ? 'Browser push alerts are enabled for booking and trip updates, even when DrivX is closed. Your history stays in the Account inbox.'
            : 'Push alerts are enabled on this phone. Your in-app notification history stays available too.'
          : Platform.OS === 'web'
            ? 'Enable browser push to receive booking and trip updates when DrivX is closed. Install DrivX on your home screen for the best experience.'
            : 'Get booking, driver and payment updates on this phone, including when DrivX is not open.'}
      </Text>
      {message ? <Text variant="caption" tone="danger" accessibilityRole="alert">{message}</Text> : null}
      {webPushConfigured ? <Button
        label={busy ? 'Saving…' : enabled ? 'Turn off push alerts' : 'Enable push alerts'}
        appearance={enabled ? 'secondary' : 'primary'}
        loading={busy}
        onPress={() => {
          setBusy(true);
          setMessage(null);
          const action = enabled ? disablePushNotifications(user) : enablePushNotifications(user);
          void action.then(() => setEnabled(!enabled)).catch((error) => {
            setMessage(error instanceof Error ? error.message : 'Push notification settings could not be saved.');
          }).finally(() => setBusy(false));
        }}
      /> : null}
    </Card>
  );
}
