import type { ComponentProps } from 'react';
import type { ColorValue } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

/**
 * expo-router hands tab icons React Native's `ColorValue`, while
 * @expo/vector-icons declares its colour prop more narrowly. The tab bar always
 * passes a plain colour string, so the two declarations are bridged here once.
 */
export function TabIcon({
  name,
  color,
  size,
}: {
  name: IoniconName;
  color: ColorValue;
  size: number;
}) {
  return <Ionicons name={name} size={size} color={color as string} />;
}
