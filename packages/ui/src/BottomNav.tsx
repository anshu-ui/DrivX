import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from './Text';
import { useTheme } from './ThemeProvider';
import { useReducedMotion } from './accessibility';

export function Skeleton({ width = '100%', height = 16, style }: { width?: number | string; height?: number; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const pulse = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    // A looping shimmer is exactly what "reduce motion" asks for an app to stop.
    if (reduceMotion) {
      pulse.setValue(0.7);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: theme.motion.slow, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.45, duration: theme.motion.slow, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduceMotion, theme.motion.slow]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width, height, borderRadius: theme.radius.sm, backgroundColor: theme.colors.skeleton, opacity: pulse }, style]}
    />
  );
}

export type TabItem = {
  key: string;
  label: string;
  /** Icon rendered by the app so this package stays icon-library agnostic. */
  icon?: React.ReactNode;
  /** Rendered when the tab is selected; falls back to `icon`. */
  activeIcon?: React.ReactNode;
  badgeCount?: number;
};

export type BottomNavProps = {
  tabs: TabItem[];
  activeKey: string;
  onSelect: (key: string) => void;
};

export function BottomNav({ tabs, activeKey, onSelect }: BottomNavProps) {
  const theme = useTheme();

  return (
    <View
      accessibilityRole="tablist"
      style={[
        styles.bar,
        {
          height: theme.sizing.navBarHeight,
          backgroundColor: theme.colors.surface,
          borderTopWidth: theme.borderWidth.thin,
          borderTopColor: theme.colors.border,
        },
      ]}
    >
      {tabs.map((tab) => {
        const active = tab.key === activeKey;
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={tab.label}
            onPress={() => onSelect(tab.key)}
            style={({ pressed }) => [
              styles.tab,
              { opacity: pressed && !active ? 0.7 : 1, gap: theme.spacing.xxs },
            ]}
          >
            <View style={styles.iconWrap}>
              {active ? (tab.activeIcon ?? tab.icon) : tab.icon}
              {tab.badgeCount ? <View style={[styles.badge, { backgroundColor: theme.colors.danger }]} /> : null}
            </View>
            <Text variant="overline" style={{ color: active ? theme.colors.primaryInk : theme.colors.textMuted }}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'stretch' },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  iconWrap: { position: 'relative' },
  badge: { position: 'absolute', top: -2, right: -6, width: 8, height: 8, borderRadius: 4 },
});
