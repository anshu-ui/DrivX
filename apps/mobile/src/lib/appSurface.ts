import { applicationId } from 'expo-application';
import Constants from 'expo-constants';

export type AppSurface = 'customer' | 'driver' | 'admin' | null;

/**
 * Standalone installs must follow their native package id. This is the one
 * value Android and iOS cannot accidentally inherit from another app's Metro
 * or Expo config. Expo config is used only by Expo Go/combined development.
 */
const nativePackageSurfaces: Record<string, Exclude<AppSurface, null>> = {
  'in.drivx.customer': 'customer',
  'in.drivx.driver': 'driver',
  'in.drivx.admin': 'admin',
};

const configuredSurface =
  Constants.expoConfig?.extra?.appSurface === 'customer' ||
  Constants.expoConfig?.extra?.appSurface === 'driver' ||
  Constants.expoConfig?.extra?.appSurface === 'admin'
    ? Constants.expoConfig.extra.appSurface
    : null;

// Expo Go has no DrivX native package id, so use the selected Expo config there.
export const appSurface: AppSurface =
  nativePackageSurfaces[applicationId ?? ''] ?? configuredSurface;

export const isCombinedApp =
  applicationId === 'in.drivx.app' ||
  (appSurface === null && Constants.expoConfig?.name === 'DrivX');
