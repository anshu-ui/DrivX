import { Tabs } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ThemeProvider } from '@drivx/ui';
import { theme } from '@drivx/design-tokens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TabIcon } from '../../components/TabIcon';
import { AppSurfaceGate } from '../../components/AppSurfaceGate';
import { customerTheme } from '../../features/customer/customerTheme';

export default function CustomerLayout() {
  const insets = useSafeAreaInsets();
  return (
    <AppSurfaceGate expects="customer">
      <ThemeProvider theme={customerTheme}>
        <StatusBar style="dark" />
        <Tabs
        screenOptions={{
          headerShown: false,
          // The active tab is brand navy, at the readable step of the hue: the
          // label is 13px text, and #1E40AF measures 8.72:1 against the bar.
          tabBarActiveTintColor: customerTheme.colors.primaryInk,
          tabBarInactiveTintColor: customerTheme.colors.textMuted,
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
            backgroundColor: customerTheme.colors.surface,
            borderTopColor: customerTheme.colors.border,
            paddingHorizontal: 5,
            // Keep the three tabs above Android's gesture/navigation area.
            // The extra bottom inset belongs to the bar, not to the tab items.
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
            title: 'Book',
            tabBarIcon: ({ color, size }) => <TabIcon name="car-outline" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="trips"
          options={{
            title: 'Trips',
            tabBarIcon: ({ color, size }) => <TabIcon name="time-outline" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="support"
          options={{
            title: 'Help',
            tabBarIcon: ({ color, size }) => <TabIcon name="help-circle-outline" color={color} size={size} />,
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
        {/*
          Pushed screens: reachable by router.push, never from the tab bar.
          `href: null` would look like the right way to say that, but it also drops
          the screen from the linkable route table — then router.push and a deep link
          to it silently resolve to the group's initial screen instead. Hiding the
          button is the part that was actually wanted.
        */}
        <Tabs.Screen name="trips/[bookingId]" options={{ tabBarButton: () => null }} />
        <Tabs.Screen name="saved-places" options={{ tabBarButton: () => null }} />
        </Tabs>
      </ThemeProvider>
    </AppSurfaceGate>
  );
}
