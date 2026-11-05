# DrivX live-readiness audit

Checked: 2026-10-28. This is a source/configuration audit, not a production deployment or a real-device acceptance test.

## Implemented in this working copy

- Customer and driver are separate Android package variants. Runtime role selection now reads the installed native package ID, so a driver APK cannot silently resolve to the customer surface when Android Studio bundles JS without `DRIVX_APP_VARIANT`.
- Customer phone OTP, profile onboarding, saved places, exact-date/time scheduling, server-priced quote and booking flows are present.
- Current source catalogue retains the prior local rates: one-way slabs through 40 km then ₹12/km; hourly packages ₹149/₹279/₹449/₹799/₹1,099 with ₹10/km extra and ₹2/minute overtime. Only outstation pricing was added: one-way packages through 500 km with ₹10/km beyond the accepted route, and 1–11 day round trips with ₹100/hour overtime; local night remains flat ₹150 and outstation night is ₹200 per eligible hour. Admin can edit the pricing rules. Driver onboarding defaults to ₹500 + 5% GST (₹525); Admin can edit it. Customer trip settlement remains cash; Cashfree handles driver dues.
- Driver application image upload uses a Blob-compatible local-file read; the one-time ₹525 default Cashfree due is created at first upload. The Admin queue receives the application only after all required images exist and payment is verified; Admin can review images and Cashfree references and approval activates the driver. Booking offers, trip OTPs and odometer-priced completion are present.
- Admin source includes driver approval/document review, booking ledger, manual assignment offer, payment reconciliation, refunds, driver/commission views and an Admin-only live Fare settings editor for slabs, packages, overtime, night fee, tax and commission.
- Trip route geometry is now saved on new bookings and rendered on customer/driver native maps. Driver GPS uses a native location task and Android foreground service while online/on-trip.
- Native package IDs take priority when selecting the app surface. Background-location permissions and the location plug-in are now included only in the driver variant; customer/admin builds request foreground location only.
- Customer/driver push opt-in, native FCM token registration, foreground presentation and server-side FCM send are now in source. The in-app inbox remains the durable history.

## Still required before calling it live

| Area | Current evidence | Required to close |
|---|---|---|
| Live Firebase access | Earlier project notes record Cloud Run HTTP 403 from the `referralme.in` public-invoker organization policy. This turn could not re-check the policy: this checkout defaults to `drivx-local`, and Firebase CLI is not installed here. | Workspace super-admin must resolve the project policy for `drivx-116de`; then verify an authenticated callable and Cashfree webhook can reach their handlers. |
| Latest Functions source | Route-polyline persistence, FCM sending/token revocation and related code are newer than the last deployment notes. No deployment was performed. | Deploy the current Functions source to `drivx-116de` after callable ingress is allowed. Confirm Cashfree Secret Manager bindings remain attached. |
| Live fare document | Source catalogue contains the proposed rules; Admin Fare settings writes production `pricingRules` once deployed and an Admin saves them. This checkout did not read production rules, so current live values are unverified. | Read the production rule and compare each slab, GST, night charge and package rate with the approved chart. |
| Android apps | No APK was built in this audit. The checked-in generated `apps/mobile/android` project is currently `in.drivx.admin`. Expo config was checked for all three variants: customer/admin omit background location, driver includes it. | Prebuild customer, driver and admin separately, then build/install each in Android Studio. Driver needs `DRIVX_APP_VARIANT=driver` before prebuild. |
| Background GPS | Android background permission and foreground-service source is configured but has not been permission-tested on a phone. Android may stop work after a force-stop or vendor battery restriction. | On the driver phone, grant “Allow all the time”, start duty, lock the phone and check customer location freshness; then go offline and confirm updates stop. |
| Push | Code is present; FCM delivery has not been deployed or tested on a phone. Android 13+ also needs the user to allow notifications. | Deploy Functions, opt in from Account on both apps, confirm the token registers, and send a real booking/assignment notification with the app foregrounded and backgrounded. |
| Cashfree | Source creates orders only for driver onboarding/commission dues; signed webhook code re-reads the order before settling. No valid payment/webhook was tested in this audit, and prior notes record production reachability/deploy blockers. | After policy and Functions deployment, complete one small controlled driver-due payment and verify order, signature, settlement, provider ID and audit record. |
| Admin pricing | New source includes an Admin-only pricing editor; production Firestore values are not read from this environment. | Deploy Admin app, sign in, review/save proposed test rates, then verify quote snapshots and final receipts in production. |

Typecheck passed for mobile, Functions and domain during this source audit. Mobile lint completed with existing warnings and no errors. No APK was built and no production service or tariff was changed. The latest app/function source is not live until it is deployed.
