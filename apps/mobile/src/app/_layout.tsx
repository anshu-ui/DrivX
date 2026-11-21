import { useEffect } from 'react';
import { Platform } from 'react-native';
import { Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SystemUI from 'expo-system-ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@drivx/ui';
import { theme } from '@drivx/design-tokens';
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from '@expo-google-fonts/plus-jakarta-sans';
import { mobileTheme } from '../features/mobileTheme';
import { AuthProvider, useSession } from '../features/auth/AuthProvider';
import AdminApp from '../admin/AdminApp';
import { usePushRegistrationSync } from '../features/customer/pushNotifications';
import { PushPermissionGate } from '../components/PushPermissionGate';
import { appSurface } from '../lib/appSurface';
import { trackAppScreen } from '../lib/analytics';
import '../features/driver/locationTask';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Trip state is streamed from Realtime Database in Phase 3; Firestore
      // reads here are profiles and history, which do not need to be instant.
      staleTime: 30_000,
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

// Keep guest and sign-in screens on the same product theme as the customer and
// driver tabs. Admin keeps its separate console theme.
const appTheme = appSurface === 'admin' ? theme : mobileTheme;

/**
 * The navigator, keyed to the account and the surface it is standing on.
 *
 * Signing in as somebody else without leaving the app has to start from an empty
 * stack: the guard at `/` can only redirect the screen it is rendered on, so a
 * tab group left mounted underneath the previous account stays on screen and
 * the driver ends up looking at the customer's tabs — or the reverse — with a
 * role error in the middle. One number holding two accounts makes this the
 * normal way to move between them, so the stack is rebuilt instead of patched.
 */
function RootStack() {
  const { status, user, surface, needsProfile, signOut } = useSession();
  const pathname = usePathname();
  const notificationSurface = surface ?? appSurface ?? 'customer';
  usePushRegistrationSync(status === 'signed_in' ? user : null, notificationSurface);
  const stackKey = status === 'signed_in' ? `${user?.uid ?? 'anon'}:${surface}` : 'guest';

  useEffect(() => {
    trackAppScreen(pathname, surface ?? appSurface);
  }, [pathname, surface]);

  const stack = (
    <Stack
      key={stackKey}
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: appTheme.colors.background },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="sign-in" />
      <Stack.Screen name="dev-sign-in" options={{ presentation: 'modal' }} />
      <Stack.Screen name="create-profile" options={{ presentation: 'modal' }} />
      <Stack.Screen name="(customer)" />
      <Stack.Screen name="(driver)" />
    </Stack>
  );

  if (status === 'signed_in' && user && !needsProfile) {
    return <PushPermissionGate user={user} surface={notificationSurface} onSignOut={signOut}>{stack}</PushPermissionGate>;
  }
  return stack;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
  });

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const host = window.location.hostname.toLowerCase();
    if (host === 'drivx-116de.web.app' || host === 'drivx-116de.firebaseapp.com') {
      window.location.replace(
        `https://drivx.in${window.location.pathname}${window.location.search}${window.location.hash}`,
      );
    }
  }, []);

  useEffect(() => {
    // A cold start after a crash must not leave a stale cached booking on screen.
    queryClient.removeQueries({ queryKey: ['liveTrip'] });
  }, []);

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(appTheme.colors.background);
  }, []);

  if (!fontsLoaded && !fontError) return null;

  if (appSurface === 'admin') {
    return (
      <SafeAreaProvider>
        <ThemeProvider theme={theme}>
          <StatusBar style="dark" />
          <AdminApp />
        </ThemeProvider>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <ThemeProvider theme={appTheme}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <StatusBar style="dark" />
            <RootStack />
          </AuthProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
