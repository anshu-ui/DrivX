import { Tabs } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ThemeProvider } from '@drivx/ui';
import { theme } from '@drivx/design-tokens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from '@expo-google-fonts/plus-jakarta-sans';
import { TabIcon } from '../../components/TabIcon';
import { AppSurfaceGate } from '../../components/AppSurfaceGate';
import { mobileTheme } from '../../features/mobileTheme';

export default function DriverLayout() {
  const [fontsLoaded, fontError] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
  });
  const insets = useSafeAreaInsets();
  if (!fontsLoaded && !fontError) return null;
  return (
    <AppSurfaceGate expects="driver">
      <ThemeProvider theme={mobileTheme}>
      <StatusBar style="dark" />
      <Tabs
        screenOptions={{
          headerShown: false,
          // Keep tab labels legible and consistent with the current brand theme.
          tabBarActiveTintColor: mobileTheme.colors.primaryInk,
          tabBarInactiveTintColor: mobileTheme.colors.textMuted,
          // Set the label typography explicitly so all five tabs stay readable.
          tabBarLabelStyle: {
            fontFamily: 'PlusJakartaSans_600SemiBold',
            fontSize: 11,
            lineHeight: 14,
            fontWeight: 'normal',
            marginTop: 3,
            marginBottom: 2,
            includeFontPadding: false,
          },
          tabBarStyle: {
            backgroundColor: mobileTheme.colors.surface,
            borderTopColor: mobileTheme.colors.border,
            paddingHorizontal: 8,
            height: theme.sizing.navBarHeight + insets.bottom,
            paddingBottom: insets.bottom,
            paddingTop: 4,
          },
          tabBarItemStyle: {
            flex: 1,
            flexBasis: 0,
            width: 0,
            minWidth: 0,
            paddingHorizontal: 2,
            alignItems: 'center',
            justifyContent: 'center',
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Duty',
            tabBarIcon: ({ color, size }) => <TabIcon name="radio-outline" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="trip"
          // Not a tab: the trip opens from Duty when one is assigned, and a driver
          // with nothing on hand has no reason to see an empty code form. Only the
          // button is hidden — `href: null` would also drop the screen from the
          // linkable route table, and then this push resolves back to Duty.
          options={{ tabBarButton: () => null }}
        />
        <Tabs.Screen
          name="trips"
          options={{
            title: 'Trips',
            tabBarIcon: ({ color, size }) => <TabIcon name="receipt-outline" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="earnings"
          options={{
            title: 'Earnings',
            tabBarIcon: ({ color, size }) => <TabIcon name="wallet-outline" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="account"
          options={{
            title: 'Account',
            tabBarIcon: ({ color, size }) => <TabIcon name="person-outline" color={color} size={size} />,
          }}
        />
        <Tabs.Screen name="rewards" options={{ title: 'Rewards', tabBarIcon: ({ color, size }) => <TabIcon name="gift-outline" color={color} size={size} /> }} />
        <Tabs.Screen name="documents" options={{ tabBarButton: () => null }} />
        {/* Opened from Account, not from the bar: five tabs is the practical limit
            on a phone, and a driver has no reason to sit on an empty ticket desk. */}
        <Tabs.Screen name="support" options={{ tabBarButton: () => null }} />
      </Tabs>
      </ThemeProvider>
    </AppSurfaceGate>
  );
}
