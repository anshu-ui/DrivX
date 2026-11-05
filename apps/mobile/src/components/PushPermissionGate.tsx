import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, Platform, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { User } from 'firebase/auth';
import { getPermissionsAsync } from 'expo-notifications';
import { enablePushNotifications } from '../features/customer/pushNotifications';

const preferenceKey = (uid: string) => `drivx.push.enabled.${uid}`;

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
    <View style={{ flex: 1, minHeight: '100%', backgroundColor: '#F5F8FC', justifyContent: 'center', padding: 24 }}>
      <View style={{ width: '100%', maxWidth: 520, alignSelf: 'center', backgroundColor: 'white', borderColor: '#E1E8F0', borderWidth: 1, borderRadius: 24, padding: 26, gap: 14 }}>
        <View style={{ width: 54, height: 54, borderRadius: 18, backgroundColor: '#EAF1FF', alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: '#155EEF', fontSize: 26, fontWeight: '900' }}>⌁</Text>
        </View>
        <Text style={{ color: '#14243A', fontSize: 25, fontWeight: '900' }}>Turn on DrivX notifications</Text>
        <Text style={{ color: '#66758B', fontSize: 15, lineHeight: 23 }}>
          Get driver offers, booking confirmations, trip status and payment updates. You can continue using DrivX without notifications and enable them later in settings.
        </Text>
        {missingWebKey ? (
          <Text accessibilityRole="alert" style={{ color: '#B42318', fontSize: 14, lineHeight: 21 }}>
            Push notifications are unavailable in this browser. You can still use DrivX; trip updates remain available in the app.
          </Text>
        ) : null}
        {error ? <Text accessibilityRole="alert" style={{ color: '#B42318', fontSize: 14 }}>{error}</Text> : null}
        {!ready ? (
          <ActivityIndicator color="#155EEF" />
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
            style={{ minHeight: 52, borderRadius: 14, backgroundColor: busy || missingWebKey ? '#A9BAD4' : '#155EEF', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 }}
          >
            <Text style={{ color: 'white', fontSize: 16, fontWeight: '800' }}>{busy ? 'Enabling…' : 'Allow notifications'}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity disabled={busy} onPress={() => setDismissed(true)} style={{ paddingVertical: 8 }}>
          <Text style={{ textAlign: 'center', color: '#155EEF', fontWeight: '700' }}>Continue without notifications</Text>
        </TouchableOpacity>
        {Platform.OS !== 'web' ? (
          <TouchableOpacity onPress={() => void Linking.openSettings()} style={{ paddingVertical: 10 }}>
            <Text style={{ textAlign: 'center', color: '#155EEF', fontWeight: '700' }}>Open device notification settings</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity disabled={busy} onPress={() => void onSignOut()} style={{ paddingVertical: 8 }}>
          <Text style={{ textAlign: 'center', color: '#66758B', fontWeight: '700' }}>Sign out</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
