import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, Platform, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { User } from 'firebase/auth';
import { getPermissionsAsync } from 'expo-notifications';
import { enablePushNotifications } from '../features/customer/pushNotifications';
import { mobileTheme } from '../features/mobileTheme';

const preferenceKey = (uid: string) => `drivx.push.enabled.${uid}`;
const { colors, radius } = mobileTheme;
const fontFamily = mobileTheme.fontFamily as typeof mobileTheme.fontFamily & {
  textSemiBold: string;
  textBold: string;
  textExtraBold: string;
};

function hasWebPushKey() {
  return Boolean(process.env.EXPO_PUBLIC_FIREBASE_VAPID_KEY
    || (typeof window !== 'undefined'
      && (window as Window & { DRIVX_FIREBASE_CONFIG?: { vapidKey?: string } }).DRIVX_FIREBASE_CONFIG?.vapidKey));
}

/** Holds customer, driver and admin sessions at an explicit push opt-in step. */
export function PushPermissionGate({
  user,
  onSignOut,
  children,
}: {
  user: User;
  onSignOut: () => Promise<void>;
  children: ReactNode;
}) {
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void (async () => {
      const optedIn = await AsyncStorage.getItem(preferenceKey(user.uid)) === 'true';
      let permissionGranted = false;
      try {
        permissionGranted = Platform.OS === 'web'
          ? 'Notification' in globalThis && Notification.permission === 'granted'
          : (await getPermissionsAsync()).granted;
      } catch { permissionGranted = false; }
      if (active) {
        setEnabled(optedIn && permissionGranted);
        setReady(true);
      }
    })().catch(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, [user.uid]);

  if (enabled || dismissed) return <>{children}</>;

  const missingWebKey = Platform.OS === 'web' && !hasWebPushKey();
  return (
    <View style={{ flex: 1, minHeight: '100%', backgroundColor: colors.background, justifyContent: 'center', padding: 24 }}>
      <View style={{ width: '100%', maxWidth: 520, alignSelf: 'center', backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.xl, padding: 26, gap: 14 }}>
        <View style={{ width: 54, height: 54, borderRadius: radius.lg, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: colors.primary, fontFamily: fontFamily.textExtraBold, fontSize: 26 }}>⌁</Text>
        </View>
        <Text style={{ color: colors.textBrand, fontFamily: fontFamily.textExtraBold, fontSize: 25, lineHeight: 32 }}>
          Turn on DrivX notifications
        </Text>
        <Text style={{ color: colors.textMuted, fontFamily: fontFamily.text, fontSize: 15, lineHeight: 23 }}>
          Get driver offers, booking confirmations, trip status and payment updates. You can continue using DrivX without notifications and enable them later in settings.
        </Text>
        {missingWebKey ? (
          <Text accessibilityRole="alert" style={{ color: colors.danger, fontFamily: fontFamily.text, fontSize: 14, lineHeight: 21 }}>
            Push notifications are unavailable in this browser. You can still use DrivX; trip updates remain available in the app.
          </Text>
        ) : null}
        {error ? <Text accessibilityRole="alert" style={{ color: colors.danger, fontFamily: fontFamily.text, fontSize: 14, lineHeight: 21 }}>{error}</Text> : null}
        {!ready ? (
          <ActivityIndicator color={colors.primary} />
        ) : (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{ disabled: busy || missingWebKey }}
            disabled={busy || missingWebKey}
            onPress={() => {
              setBusy(true);
              setError('');
              void enablePushNotifications(user)
                .then(() => setEnabled(true))
                .catch((reason) => setError(reason instanceof Error ? reason.message : 'Notifications could not be enabled.'))
                .finally(() => setBusy(false));
            }}
            style={{ minHeight: 52, borderRadius: radius.md, backgroundColor: busy || missingWebKey ? colors.disabledSurface : colors.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 }}
          >
            <Text style={{ color: busy || missingWebKey ? colors.disabledText : colors.onPrimary, fontFamily: fontFamily.textBold, fontSize: 16 }}>
              {busy ? 'Enabling…' : 'Allow notifications'}
            </Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity disabled={busy} onPress={() => setDismissed(true)} style={{ paddingVertical: 8 }}>
          <Text style={{ textAlign: 'center', color: colors.primaryInk, fontFamily: fontFamily.textSemiBold }}>
            Continue without notifications
          </Text>
        </TouchableOpacity>
        {Platform.OS !== 'web' ? (
          <TouchableOpacity onPress={() => void Linking.openSettings()} style={{ paddingVertical: 10 }}>
            <Text style={{ textAlign: 'center', color: colors.primaryInk, fontFamily: fontFamily.textSemiBold }}>
              Open device notification settings
            </Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity disabled={busy} onPress={() => void onSignOut()} style={{ paddingVertical: 8 }}>
          <Text style={{ textAlign: 'center', color: colors.textMuted, fontFamily: fontFamily.textSemiBold }}>Sign out</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
