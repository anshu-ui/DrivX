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
import { customerTheme } from '../../features/customer/customerTheme';

export default function CustomerLayout() {
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
    <AppSurfaceGate expects="customer">
      <ThemeProvider theme={customerTheme}>
        <StatusBar style="dark" />
        <Tabs
        screenOptions={{
          headerShown: false,
          // Keep tab labels legible and consistent with the current brand theme.
          tabBarActiveTintColor: customerTheme.colors.primaryInk,
          tabBarInactiveTintColor: customerTheme.colors.textMuted,
          // Keep the tab labels on the same Plus Jakarta Sans scale as the screens.
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
            backgroundColor: customerTheme.colors.surface,
            borderColor: customerTheme.colors.border,
            borderTopWidth: 1,
            borderWidth: 1,
            borderRadius: 24,
            position: 'absolute',
            left: 12,
            right: 12,
            bottom: Math.max(insets.bottom - 16, 8),
            height: theme.sizing.navBarHeight,
            paddingHorizontal: 6,
            paddingBottom: 4,
            paddingTop: 4,
            shadowColor: '#172033',
            shadowOpacity: 0.10,
            shadowRadius: 18,
            shadowOffset: { width: 0, height: 7 },
            elevation: 8,
          },
          tabBarItemStyle: {
            // Let each visible destination share the available row equally.
            flex: 1,
            flexGrow: 1,
            flexShrink: 1,
            flexBasis: 0,
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
