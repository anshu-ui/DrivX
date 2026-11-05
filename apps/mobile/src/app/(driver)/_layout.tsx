import { Tabs } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ThemeProvider } from '@drivx/ui';
import { theme } from '@drivx/design-tokens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TabIcon } from '../../components/TabIcon';
import { AppSurfaceGate } from '../../components/AppSurfaceGate';
import { mobileTheme } from '../../features/mobileTheme';

export default function DriverLayout() {
  const insets = useSafeAreaInsets();
  return (
    <AppSurfaceGate expects="driver">
      <ThemeProvider theme={mobileTheme}>
      <StatusBar style="dark" />
      <Tabs
        screenOptions={{
          headerShown: false,
          // The active tab is brand navy, at the readable step of the hue: the
          // label is 13px text, and #1E40AF measures 8.72:1 against the bar.
          tabBarActiveTintColor: mobileTheme.colors.primaryInk,
          tabBarInactiveTintColor: mobileTheme.colors.textMuted,
          // react-navigation sets no font on its label, so without this the one
          // line of text in the bar renders system-ui at 10px while everything
          // else on the screen is Plus Jakarta Sans.
          tabBarLabelStyle: {
            fontFamily: theme.fontFamily.text,
            fontSize: 10,
            lineHeight: 13,
            fontWeight: '500',
            marginTop: 2,
            marginBottom: 1,
            includeFontPadding: false,
          },
          tabBarStyle: {
            backgroundColor: mobileTheme.colors.surface,
            borderTopColor: mobileTheme.colors.border,
            paddingHorizontal: 5,
            height: theme.sizing.navBarHeight + insets.bottom,
            paddingBottom: insets.bottom,
            paddingTop: 4,
          },
          tabBarItemStyle: {
            flex: 1,
            minWidth: 0,
            paddingHorizontal: 0,
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
