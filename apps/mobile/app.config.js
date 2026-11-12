const base = require('./app.json').expo;
const fs = require('node:fs');
const path = require('node:path');

const variants = {
  combined: { name: 'DrivX', suffix: 'app', scheme: 'drivx', surface: null },
  customer: { name: 'DrivX Customer', suffix: 'customer', scheme: 'drivxcustomer', surface: 'customer' },
  driver: { name: 'DrivX Driver', suffix: 'driver', scheme: 'drivxdriver', surface: 'driver' },
  admin: { name: 'DrivX Admin', suffix: 'admin', scheme: 'drivxadmin', surface: 'admin' },
};

module.exports = ({ config }) => {
  // Expo evaluates this file again when Gradle bundles the JavaScript. Android
  // Studio does not inherit the shell variable used by `expo prebuild`, so
  // remember the selected variant beside the app config for that later pass.
  // This is what keeps the embedded Expo config (and route surface) aligned
  // with the native package id during Android Studio builds.
  const variantFile = path.join(__dirname, '.drivx-app-variant');
  const requestedVariant = process.env.DRIVX_APP_VARIANT;
  if (requestedVariant) {
    if (!variants[requestedVariant]) throw new Error(`Unknown DRIVX_APP_VARIANT: ${requestedVariant}`);
    fs.writeFileSync(variantFile, `${requestedVariant}\n`);
  }
  const key = requestedVariant || (fs.existsSync(variantFile) ? fs.readFileSync(variantFile, 'utf8').trim() : 'combined');
  const variant = variants[key];
  if (!variant) throw new Error(`Unknown DRIVX_APP_VARIANT: ${key}`);
  const bundle = `in.drivx.${variant.suffix}`;
  const iosInfoPlist = {
    ...base.ios?.infoPlist,
    ...config.ios?.infoPlist,
  };
  if (variant.surface !== 'driver') {
    delete iosInfoPlist.NSLocationAlwaysAndWhenInUseUsageDescription;
    delete iosInfoPlist.NSLocationAlwaysUsageDescription;
  }
  const plugins = [
    ...new Set([
      ...(base.plugins ?? []),
      ...(config.plugins ?? []),
      '@react-native-firebase/app',
      '@react-native-firebase/auth',
      '@react-native-firebase/analytics',
      '@react-native-firebase/messaging',
      ['expo-maps', { requestLocationPermission: true, locationPermission: 'DrivX uses your location to show pickup and active trip routes.' }],
      ...(variant.surface === 'driver' ? [[ 'expo-location', {
        locationWhenInUsePermission: 'DrivX uses your location to find nearby trips and show your live route while driving.',
        locationAlwaysAndWhenInUsePermission: 'DrivX shares your location in the background only while you are online or carrying an active trip.',
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
        isIosBackgroundLocationEnabled: true,
      }]] : []),
      './plugins/withFirebaseMessagingOverrides',
      ['expo-notifications', { defaultChannel: 'bookings', color: '#155EEF' }],
      ['expo-build-properties', { android: { kotlinVersion: '2.4.0' } }],
    ]),
  ];
  return {
    ...base,
    ...config,
    name: variant.name,
    slug: 'drivx',
    scheme: variant.scheme,
    ios: {
      ...base.ios,
      ...config.ios,
      bundleIdentifier: bundle,
      googleServicesFile: `./firebase/ios/${key}/GoogleService-Info.plist`,
      infoPlist: iosInfoPlist,
    },
    android: {
      ...base.android,
      ...config.android,
      package: bundle,
      googleServicesFile: './firebase/google-services.json',
      config: {
        ...base.android?.config,
        ...config.android?.config,
        googleMaps: {
          ...base.android?.config?.googleMaps,
          ...config.android?.config?.googleMaps,
          apiKey: process.env.GOOGLE_MAPS_ANDROID_API_KEY || undefined,
        },
      },
    },
    plugins,
    experiments: {
      ...base.experiments,
      ...config.experiments,
      ...(variant.surface === 'driver' ? { baseUrl: '/driver' } : {}),
      ...(variant.surface === 'customer' ? { baseUrl: '/customer' } : {}),
      ...(variant.surface === 'admin' ? { baseUrl: '/admin' } : {}),
    },
    extra: {
      ...base.extra,
      ...config.extra,
      appSurface: variant.surface,
      mapsAndroidConfigured: Boolean(process.env.GOOGLE_MAPS_ANDROID_API_KEY),
    },
  };
};
