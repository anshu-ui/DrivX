import { useEffect, useRef, useState } from 'react';
import { Animated, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Card, Text, useTheme } from '@drivx/ui';
import { firstNameOf, greetingForHour } from '../features/mobileTheme';

type MobileWelcomeHeroProps = {
  name?: string | null;
  fallback: string;
  role: 'customer' | 'driver';
};

/** Welcome and route preview shared by the customer and driver home screens. */
export function MobileWelcomeHero({ name, fallback, role }: MobileWelcomeHeroProps) {
  const theme = useTheme();
  const pulse = useRef(new Animated.Value(0.55)).current;
  const [hour, setHour] = useState(() => new Date().getHours());

  useEffect(() => {
    const clock = setInterval(() => setHour(new Date().getHours()), 60_000);
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1250, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.55, duration: 1250, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => {
      clearInterval(clock);
      animation.stop();
    };
  }, [pulse]);

  const driver = role === 'driver';

  return (
    <Card
      style={{
        gap: theme.spacing.md,
        padding: theme.spacing.md,
        borderRadius: 28,
        borderColor: 'rgba(16, 42, 82, 0.10)',
        backgroundColor: theme.colors.surface,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing.sm, paddingHorizontal: 3 }}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text variant="caption" tone="muted">{greetingForHour(hour)}</Text>
          <Text variant="subheading" tone="brand" numberOfLines={1}>
            Welcome, {firstNameOf(name, fallback)}
          </Text>
        </View>
        <View
          accessibilityLabel={driver ? 'Driver trips' : 'Customer trips'}
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: theme.colors.surfaceMuted,
            borderWidth: 1,
            borderColor: theme.colors.border,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name={driver ? 'car-sport-outline' : 'menu-outline'} size={23} color={theme.colors.primaryInk} />
          <View style={{ position: 'absolute', width: 7, height: 7, borderRadius: 4, right: 8, top: 9, backgroundColor: theme.colors.primary }} />
        </View>
      </View>

      <View
        style={{
          overflow: 'hidden',
          minHeight: 174,
          borderRadius: 23,
          backgroundColor: theme.colors.surfaceMuted,
          borderWidth: 1,
          borderColor: theme.colors.border,
          padding: theme.spacing.md,
          justifyContent: 'space-between',
        }}
      >
        {/* Abstract route artwork keeps the mockup's map-led feel without a fake static map. */}
        <View style={{ position: 'absolute', left: 18, right: 18, top: 16, bottom: 16, opacity: 0.7 }}>
          <View style={{ position: 'absolute', left: '8%', top: '22%', width: '84%', height: 1, backgroundColor: 'rgba(23,23,27,0.10)', transform: [{ rotate: '-8deg' }] }} />
          <View style={{ position: 'absolute', left: '12%', top: '63%', width: '76%', height: 1, backgroundColor: 'rgba(23,23,27,0.10)', transform: [{ rotate: '7deg' }] }} />
          <View style={{ position: 'absolute', left: '28%', top: '2%', width: 1, height: '95%', backgroundColor: 'rgba(23,23,27,0.08)', transform: [{ rotate: '19deg' }] }} />
          <View style={{ position: 'absolute', left: '72%', top: '4%', width: 1, height: '90%', backgroundColor: 'rgba(23,23,27,0.08)', transform: [{ rotate: '-17deg' }] }} />
        </View>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: 'rgba(255,255,255,0.82)', paddingHorizontal: 10, paddingVertical: 7, borderRadius: 20 }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.primary }} />
            <Text variant="overline" tone="brand" style={{ fontSize: 10 }}>{driver ? 'DRIVX CAPTAIN' : 'YOUR DRIVX JOURNEY'}</Text>
          </View>
          <Ionicons name="compass-outline" size={21} color={theme.colors.primaryInk} />
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56 }}>
          <View style={{ width: 12, alignItems: 'center', alignSelf: 'stretch', justifyContent: 'space-between', paddingVertical: 3 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: theme.colors.primary, borderWidth: 2, borderColor: '#ffffff', zIndex: 1 }} />
            <View style={{ position: 'absolute', top: 10, bottom: 10, left: 5, width: 2, backgroundColor: 'rgba(37,99,235,0.25)' }} />
            <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: theme.colors.primaryInk, borderWidth: 2, borderColor: '#ffffff', zIndex: 1 }} />
          </View>
          <View style={{ flex: 1, gap: 5 }}>
            <Text variant="heading" tone="brand" style={{ fontSize: 19 }}>
              {driver ? 'Your next trip starts here' : 'Let’s start your journey'}
            </Text>
            <Text variant="caption" tone="muted">
              {driver ? 'Go online to receive booking requests.' : 'Choose pickup and destination to see your fare.'}
            </Text>
          </View>
          <Animated.View
            style={{
              width: 42,
              height: 42,
              borderRadius: 21,
              backgroundColor: '#ffffff',
              borderWidth: 1,
              borderColor: theme.colors.border,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pulse,
              transform: [{ scale: pulse.interpolate({ inputRange: [0.55, 1], outputRange: [0.94, 1.06] }) }],
            }}
          >
            <Ionicons name={driver ? 'car-sport' : 'navigate'} size={20} color={theme.colors.primary} />
          </Animated.View>
        </View>

        <View style={{ height: 1, backgroundColor: 'rgba(23,23,27,0.10)' }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text variant="caption" tone="brand" style={{ fontSize: 12 }}>
            {driver ? 'Trips · earnings · ratings' : 'Your car, driven by a verified professional'}
          </Text>
          <Ionicons name="arrow-forward" size={17} color={theme.colors.primaryInk} />
        </View>
      </View>
    </Card>
  );
}
