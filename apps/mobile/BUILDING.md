# DrivX mobile app builds

The Expo project produces separate customer and driver installs from the same
shared codebase. `DRIVX_APP_VARIANT=customer` builds `DrivX Customer` with
`in.drivx.customer`; `DRIVX_APP_VARIANT=driver` builds `DrivX Driver` with
`in.drivx.driver`. Both are role-locked at sign-in and at route boundaries.
The default `combined` variant keeps the current role-aware development app.

## Preview locally

Run `npm run web:customer` or `npm run web:driver` from this folder. Add the
Firebase public client values from `.env.example` to a local `.env` first.

## Build an install

Use `npm run build:customer:android`, `npm run build:customer:ios`,
`npm run build:driver:android`, or `npm run build:driver:ios`. These use the
matching production profiles in `eas.json`; `build:*:dev:*` makes internal
development builds.

Before building, add the `EXPO_PUBLIC_FIREBASE_*` client configuration values
from `.env.example` to the matching EAS `preview`, `development`, and
`production` environments. Set `EXPO_PUBLIC_FIREBASE_EMULATOR=false` for real
builds. These Firebase client settings are public app configuration; never add
Cashfree secrets, service-account credentials, or server keys to this bundle.

The native admin app is the `admin` Android variant and uses the restricted
administrator sign-in. The web operations console also lives in `apps/admin`.

## Build a local Android APK in Android Studio

The Android project is generated from Expo config. Prepare one role at a time
from `apps/mobile`; the variant sets a different application id, so customer,
driver, and admin installs stay separate on the phone. Use a terminal in the
mobile folder and run the matching command before opening Android Studio:

```bash
DRIVX_APP_VARIANT=customer npx expo prebuild --platform android --clean
DRIVX_APP_VARIANT=driver npx expo prebuild --platform android --clean
DRIVX_APP_VARIANT=admin npx expo prebuild --platform android --clean
```

Run only the variant you are preparing each time. Then open `apps/mobile/android`
in Android Studio, wait for Gradle sync, connect the phone with USB debugging
enabled, and use **Run** to install that app. To make an APK instead, choose
**Build → Build Bundle(s) / APK(s) → Build APK(s)**. Android Studio shows the
generated APK location when it finishes. Repeat prebuild for the next variant;
`--clean` regenerates the native project from the selected app config.

Before prebuild, `apps/mobile/.env` must contain the production Firebase client
settings and `GOOGLE_MAPS_ANDROID_API_KEY`. Keep the API key restricted to the
three DrivX Android package IDs and the signing certificate fingerprints you
use. These local Android Studio builds are debug-signed; use their debug
fingerprint in the Maps key restriction. Push notifications additionally need
FCM/APNs credentials and a device test; a Firestore inbox update alone is not a
system push notification.
