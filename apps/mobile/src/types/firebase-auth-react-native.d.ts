import type { Persistence } from '@firebase/auth';

/**
 * Metro resolves `firebase/auth` to @firebase/auth's `react-native` build, which
 * exports `getReactNativePersistence`. TypeScript instead matches the earlier
 * `types` condition and reads the browser typings, where the symbol is absent.
 * This augmentation describes the runtime symbol the RN bundle really provides.
 */
declare module 'firebase/auth' {
  export function getReactNativePersistence(storage: {
    setItem(key: string, value: string): Promise<void>;
    getItem(key: string): Promise<string | null>;
    removeItem(key: string): Promise<void>;
  }): Persistence;
}
