# DrivX mobile builds

The Expo app has separate customer and driver variants. For App Store Connect,
the customer app is **DrivX Book a Driver** (`in.drivx.customer`) and the driver
app is **DrivX Captain** (`in.drivx.driver`). Build one variant at a time; each
uses its matching Firebase iOS app configuration and app scheme.

## Build and upload to TestFlight on a Mac

This creates a signed iOS archive and uploads it to App Store Connect/TestFlight.
It does not release the app publicly on the App Store.

1. Pull the intended Git commit and install dependencies from the repository
   root:

   ```bash
   git pull
   npm ci
   ```

2. Obtain the ignored local files securely from the project owner. Do not commit
   them to Git:

   - `apps/mobile/.env`, based on `.env.example`, with the production
     `EXPO_PUBLIC_FIREBASE_*` client settings.
   - For the customer build:
     `apps/mobile/firebase/ios/customer/GoogleService-Info.plist`.
   - For the driver build:
     `apps/mobile/firebase/ios/driver/GoogleService-Info.plist`.

   The Firebase plist files are intentionally excluded from Git. They must be
   present before prebuild; otherwise Firebase's native app configuration will
   be missing from the archive.

3. From the repository root, generate the native project for exactly one app:

   ```bash
   npm run prebuild:ios:customer --workspace @drivx/mobile
   # or
   npm run prebuild:ios:driver --workspace @drivx/mobile
   ```

   This regenerates `apps/mobile/ios` from Expo config. Do not edit generated
   files by hand. The native bundle ID, Firebase plist, deep-link scheme, and
   role-specific routes are selected together by the variant.

4. If prebuild did not create the CocoaPods workspace, run `npx pod-install`
   from `apps/mobile`. Open the generated workspace in Xcode:

   - Customer: `apps/mobile/ios/DrivXCustomer.xcworkspace`
   - Driver: `apps/mobile/ios/DrivXDriver.xcworkspace`

   Select the matching app scheme, set the Apple Developer Team with automatic
   signing, choose **Any iOS Device (arm64)**, then use **Product → Archive**.
   The archive is configured as version **1.0**, build **6** for both apps; the
   App Store Connect records currently have build 5. For a later upload,
   increment `ios.buildNumber` in `apps/mobile/app.json` and commit that change
   first.

5. In Xcode Organizer, select the archive and choose **Distribute App → App
   Store Connect → Upload**. After Apple processes the build, finish its
   TestFlight information and add internal testers in App Store Connect.

## Firebase phone sign-in before handing out the build

The Expo config adds the Firebase Auth callback URL scheme, APNs entitlement,
and `remote-notification` background mode. In Apple Developer, make sure Push
Notifications are enabled for each app identifier; in Firebase Cloud Messaging,
upload the team's APNs authentication key. Firebase can fall back to reCAPTCHA
if silent APNs verification is unavailable, so test phone sign-in on a physical
device and test the fallback flow (for example, on the simulator).
[Firebase's iOS phone-auth setup](https://firebase.google.com/docs/auth/ios/phone-auth)
lists these requirements.

## EAS alternatives

The `build:customer:ios` and `build:driver:ios` scripts use EAS Build instead
of local Xcode. They require an authorized Expo account for this EAS project,
Apple signing credentials, and the same local Firebase files and production
environment values. A cloud build uploads the project source to Expo. The local
Xcode workflow above keeps source building on the Mac; either workflow still
uploads the resulting archive to App Store Connect for TestFlight.

## Android and web

Android build scripts remain in `package.json`; customer, driver, and admin
package IDs are distinct. The web scripts set `DRIVX_WEB_BASE_URL=true` because
the hosted web apps live under `/customer`, `/driver`, and `/admin`. Native iOS
and Android builds intentionally omit those web subpaths so Expo Router starts
from `/`.

## Release boundaries

- No Firebase or website deployment is needed for an iOS-only native build.
- Uploading a build to TestFlight is not a public App Store release.
- Public release still requires completing App Store Connect metadata and
  passing App Review. App Store Connect currently shows the iOS versions as
  rejected, so those review issues need to be resolved and resubmitted before a
  public release.
- Never place Cashfree secrets, service-account credentials, or server keys in
  the app bundle.
