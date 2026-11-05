# Operations

Development builds, deployment, monitoring, release checklist, cost, and the honest backlog.
Assumes the Firebase project and Maps keys from `docs/firebase-setup.md` and
`docs/google-maps.md` exist.

## 1. Why Expo Go is not enough

The phone-OTP path cannot work in Expo Go. `signInWithPhoneNumber` from the JS SDK needs a
reCAPTCHA verifier that React Native cannot mint, so a native build must supply
`@react-native-firebase/auth` as the `nativePhoneVerifier` (`packages/firebase-client/src/auth.ts`).
`DrivXAuth` is already shaped for it. Push, Crashlytics, background location and the Maps SDK are
native too.

**State of the repository today:** `apps/mobile/app.json` declares the location and notification
permission strings and the usage descriptions, but has **no** `@react-native-firebase/*`,
`expo-location`, `react-native-maps` or Google Maps key config. A `npm run mobile:dev-build` right
now therefore produces a shell that can talk to Firestore/Auth over the JS SDK — which is exactly
what Phase 1 needs — and nothing native. Adding those plugins is Phase 3 work and should be done
one capability at a time, each verified on a device before the next lands.

## 2. iOS development build

Prerequisites: macOS with Xcode 16+, CocoaPods, an Apple Developer account, and EAS
(`npm i -g eas-cli && eas login`), plus `EXPO_PUBLIC_*` values in `apps/mobile/.env`.

```bash
npm run mobile:dev-build              # expo prebuild --clean → generates ios/ and android/
cd apps/mobile && pod-install         # npx pod-install
eas build --profile development --platform ios
eas build --platform ios             # or: npx expo run:ios --configuration Release
```

Then:

1. Drop `GoogleService-Info.plist` into `apps/mobile/ios/` and set
   `ios.googleServicesFile: "./GoogleService-Info.plist"` in `app.json`.
2. Add `expo-build-properties` and the Firebase/Crashlytics + Messaging config plugins once the
   native packages are installed.
3. Register the bundle id `in.drivx.app` in App Check (App Attest) and add the simulator's debug
   token while testing on a Mac.
4. Re-run `expo prebuild` after **every** `app.json` change; hand-edits inside `ios/` are lost.

`NSLocationWhenInUseUsageDescription` is for the customer. `NSLocationAlwaysAndWhenInUseUsageDescription`
exists only for the driver surface — App Review will ask what background location is used for, and
"the driver streams their position to the customer during an assigned trip, and stops when it ends"
must also be true in the code, not just in the plist.

## 3. Android development build

Prerequisites: Android Studio with an SDK 35 platform and emulator image, JDK 17, a device with
Google Play services, and `npm i -g eas-cli`.

That JDK 17 is Gradle's requirement and is separate from the Firebase Emulator Suite's, which needs
**Java 21 or newer** (`scripts/emulators.sh` picks a qualifying JVM by itself — see §8). A JDK 17
alone builds the Android app but cannot boot the emulators.

```bash
npm run mobile:dev-build
eas build --profile development --platform android
npx expo run:android --variant debug      # direct Gradle build instead of EAS
```

1. Put `google-services.json` in `apps/mobile/android/app/` and reference it with
   `android.googleServicesFile`.
2. `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` and `POST_NOTIFICATIONS` are already declared.
   `ACCESS_BACKGROUND_LOCATION` is **not** — add it only when the driver surface actually needs
   updates while backgrounded, and only with the Play location-disclosure flow in place (§6).
3. Create the signing key with `eas credentials` (or `keytool` locally); Play App Signing means the
   upload key is not the account key, so losing it is recoverable and losing the keystore password
   is not.
4. App Check (Play Integrity) needs the SHA-1/SHA-256 of the **signing** certificate, not just the
   upload one.

## 4. Deployment

Order for a release (rules before code, so no client ever sees an unprotected surface):

```bash
npm run typecheck && npm run test:rules      # must pass, against the local emulator
npm run verify:phone-otp                     # the auth trigger still mints the claim on a fresh number
npm run verify:customer-paths                # every shipped client query still clears the rules
npm run verify:driver-onboarding             # the ₹315 fee still gates activation, and cleans up after itself
npm run verify:driver-dues                   # the office's cut (13% default) + 5% still raises one row per finished trip, and holds new work
firebase deploy --project drivx-116de --only firestore:rules,firestore:indexes,database,storage
firebase deploy --project drivx-116de --only functions
npm --workspace @drivx/admin run build && # deploy the dashboard to its own host
npm --workspace @drivx/mobile run build:dev:ios   # then store builds via EAS Submit
```

- Tag every release (`git tag -a v0.1.0`) so a rollback is a redeploy of a known tag rather than a
  guess. Rules files are in git, which makes a rules rollback the same operation.
- `--project` is not optional here. `.firebaserc` points at `drivx-local` so the emulator and the seed
  agree, which means a bare `firebase deploy` targets a project that does not exist in the console.
  Never "fix" that with `firebase use`; see `docs/firebase-setup.md` §5.
- Cloud Functions deploys per-function: `firebase deploy --project drivx-116de --only
  functions:setRole`. Verify after any change with a real call, not just a successful deploy.
- Never deploy a rule you have not run the suite against. If the suite is green locally, that is
  the test.
- **What is live on `drivx-116de` as of 2026-10-26**, from four runs rather than intent:
  `deploy --only firestore:rules,firestore:indexes` (`released rules … to cloud.firestore`, then
  `firestore:indexes` reading back **28** composite indexes against `(default)` in `asia-south1`),
  `deploy --only database:rules` (`rules for database drivx-116de-default-rtdb released`) and
  `deploy --only storage` (`released rules firebase/storage.rules to firebase.storage`) — that last
  one only after the owner enabled Storage in the console, since the first attempt refused with
  *"Firebase Storage has not been set up on project 'drivx-116de'"*. Functions were deliberately left
  out of scope, so every callable and every trigger still exists only in the emulator. Three
  deployment facts worth recording: `--only storage:rules` is invalid (a Storage target is a *bucket*,
  so the named form dies with `Could not find rules for the following storage targets: rules`), this
  CLI version has no `rules get` so deployed rule **text** cannot be read back from the terminal (the
  console's Rules history is the rollback path, and the local files are the source of truth), and the
  bucket the Storage rules landed on was proved by probing rather than assumed —
  `drivx-116de.appspot.com` answers `404` while `drivx-116de.firebasestorage.app` answers `403`, so
  the project has exactly one bucket and it is the one every env file already names.
- Deploys run as **`amit@referralme.in`**, added to the CLI with `firebase login:add` and selected
  with `firebase login:use`. That route was forced, not chosen: `referralme.in` is a Google Workspace
  whose organization policy restricts project membership to allowed domains, so inviting the
  pre-existing CLI identity (`amit.1drona@gmail.com`) as Owner failed at acceptance with *"An
  organization policy restricts that only users from specific domains are allowed"*. `login:list`
  still shows both accounts, so switching back is one command — but every live write must be made as
  the referralme account.
- **Schema and rules changes must be backward compatible with the builds already installed on
  devices.** A rule that requires a new field breaks every app version that does not send it; ship
  the app change first, wait for adoption, then tighten the rule.

## 5. Monitoring and alerting

Spec §11 requires crash reporting, performance monitoring, structured logs and alerts. Mapping of
each requirement to where it lives:

| Requirement | Implementation |
| --- | --- |
| Structured, privacy-conscious server logs | every function logs one JSON line with `fn`, `outcome`, actor id and request id; no coordinates, addresses or phone numbers (`functions/src/functions/*.ts`) |
| Trip-event correlation | `TripEventRecord.requestId` joins a Firestore event to the Cloud Function execution that wrote it |
| Crash reporting | Crashlytics, enabled once the native build exists (§2–3); `registerDeviceToken` already stores the push token the alert path will use |
| Alerts on failed assignment / function errors | Cloud Monitoring alert policies below |
| Idempotent booking creation | `bookings.idempotencyKey` plus the `customerUid, idempotencyKey` index; a retry reads the existing booking instead of creating a second |
| Duplicate-notification prevention | `NotificationRecord.dedupeKey` is the uniqueness claim |
| Restart recovery | RN `AsyncStorage` persistence for the auth session; `RTDB connections/{uid}` cleared by `onDisconnect` |
| Stale-location indication | `RTDB_RETENTION.staleAfterMs` plus `EtaEstimate.calculatedAtMs` render as an explicit "stale" state, never a silent live pin |
| Maps/Firebase cost monitoring | the request-budget counter in `functions/.env`, GCP budget alerts, and the export below |

Alert policies to create in Cloud Monitoring (each needs a threshold agreed with whoever is on call):

```
logstash."ERROR"                              severity: error    — any function error, 5-minute window
firestore.googleapises/document_write_count   combined with      — a write spike means a client bug
resource.labels.cloud_function_name = createBooking / failure_rate > 1% over 10 min
maps_backend_request_budget_exhausted         (custom metric)    — the daily Maps cap was hit
sweepStaleLocationData                        no successful      — a sweeper that stops running leaks location data
```

The last one matters most: if the stale-location sweep silently fails, position data outlives the
trips it belongs to. That is a privacy incident, not a backlog item, so it should page.

Also turn on **BigQuery export** for Firestore and Analytics before the first real trip — you cannot
query history retroactively, and spec §10's reports (fulfilment, on-time arrival, cancellations,
repeat usage, revenue) are aggregation queries that should not run against production Firestore.

## 6. App Store and Google Play release checklist

Policy, not preference: an on-demand-driver and passenger app is reviewed against location, privacy
and account-deletion rules specifically. This is a working checklist; items marked ✗ are not yet
satisfied by this repository.

**Both stores**

- [x] One app containing both customer and driver surfaces — allowed, but expect questions.
- [ ] Privacy policy URL, and a data-deletion request path (DPDP Act 2023 in India also requires a
  grievance officer and a consent record; `users.deletionScheduledAtMs` is the field the flow uses).
- [ ] In-app account deletion — required by both stores since 2022; the field exists, the function
  does not.
- [ ] Stated purpose for precise location, and a build that stops collecting it when no trip is
  active (enforced by the RTDB rules' `trackingEnabled` check).
- [ ] Review notes with a test driver account and a test customer account, plus the OTP handover
  explanation. Reviewers do not have two phones; without this, the app is rejected as
  "incomplete functionality".
- [ ] A staged rollout, and a forced-update path for builds whose rules no longer match.

**Apple**

- [ ] Background location mode declared with a real justification (2.5.2); the driver surface must
  be honest about why.
- [ ] `NSLocationWhenInUseUsageDescription` wording already in `app.json` — review it for accuracy
  once the app actually uses it.
- [ ] If a driver earns through the app, decide the payments story: real-world services are exempt
  from IAP, but in-app "wallet top-ups" are not, and Apple has rejected apps for that line.
- [ ] Push: APNs key uploaded to Firebase Messaging; iOS 17+ requires the `POST_NOTIFICATIONS`
  equivalent consent flow.

**Google Play**

- [ ] Play Console → **Location access declarations**: foreground, and background only if added;
  each requires a use case and a prominent-disclosure screen.
- [ ] Data safety form: precise + coarse location, name, phone number, photos (driver documents),
  financial info (payments), and the reason for each.
- [ ] Sensitive-permission declaration for `ACCESS_BACKGROUND_LOCATION`.
- [ ] Target API level meeting the current Play requirement at submission time (check the policy
  page — it moves annually).
- [ ] Closed testing track with the driver cohort first; the fleet is where a GPS-threshold bug is
  cheapest to find.
- [ ] App Signing, an App Bundle, and a `proguard`/R8 pass on the release build.

## 7. Cost estimate

Pilot assumptions, which is the only honest way to price this: **300 completed trips/month, 15
drivers online, 2 zones, 1 200 customers, average trip 22 minutes, Blaze plan.** ₹ converted at
₹88/US$ — adjust both the volume and the rate before you rely on any of it.

**Every unit rate below is from the published rate cards as of writing and must be re-verified on
the vendor pricing pages before it is used for a budget.** Google repriced Maps SKUs recently, and
Firebase's free allowances have moved. The useful content of this table is the *shape* — what
dominates and why — not the totals.

| Service | Usage basis | Assumed rate | Monthly (US$) |
| --- | --- | --- | --- |
| Firestore writes | ~45 writes/trip (booking + events + assignment + notification) → 14 k | $0.18 / 100 k | ~$0.03 |
| Firestore reads | the dominant term: 4 listeners × 60 s polls × 8 h/day → ~4 M | $0.06 / 100 k | ~$2.40 |
| Firestore storage | <1 GiB at pilot | $0.18 / GiB | ~$0.20 |
| Realtime Database | 3 s location cadence, 15 drivers ≈ 43 M writes — this is exactly why it is not in Firestore | $0.15 / GiB downloads, 1 GiB free | ~$3–6 |
| Cloud Functions | 40 k invocations, 256 MiB × 300 ms | $0.40 / M + $2.50 / M GiB-s | ~$16–20 |
| Cloud Scheduler | 1 job (the sweep) | free ≤ 25 jobs | $0 |
| Auth phone verifications | 3 000 OTPs | $0.05 each, 10 k free | $0 |
| FCM push | 20 k messages | free | $0 |
| Cloud Storage | 500 driver documents + traces, ~5 GiB | $0.02 / GiB | ~$0.10 |
| App Check | pilot volume | free tier covers it | $0 |
| **Firebase subtotal** | | | **≈ $22–30 (₹1 900–2 600)** |
| Places autocomplete + details | 15 k sessions | 10 k free / SKU, then per-1 000 | $5–25 |
| Routes: trip quotes | 600 compute-routes | Essentials/Pro SKU split | $8–30 |
| Routes: driver ETA during tracking | 900 calls/trip-day is the trap — throttle to one per 60 s | | $20–70 |
| Matrix (dispatch ranking) | 300 batch calls | | $5–15 |
| Maps SDK sessions (map rendering) | 3 000 map loads | billed per session SKU | $0–20 |
| **Maps subtotal** | | | **≈ $60–160 (₹5 300–14 000)** |

Two conclusions worth carrying into Phase 2:

1. **Maps, not Firebase, is the cost centre** — by 3–5× at pilot volume, and it scales with
   *requests per trip*, not with trips alone. The three decisions that control it are the ETA
   refresh interval during tracking, batching dispatch through one matrix call, and autocomplete
   session tokens.
2. Firestore stays near-free at pilot volume because the location stream was moved to RTDB by
   design. Had live position been written to a `bookings` document instead, the same traffic would
   be roughly two orders of magnitude more expensive and would re-fetch booking documents on every
   fix.

At 10× volume, expect Firebase ₹15–25 k and Maps ₹40–120 k per month, with Maps growth the thing to
watch — the ETA and matrix call counts are the levers, so they need to be configurable per zone
rather than hardcoded.

## 8. Backlog: what still needs your credentials or a real device

**Needs credentials (cannot be built or tested without them)**

1. Firebase project — **supplied**: `drivx-116de`, web config now in all four env files. Outstanding
   for that project: its iOS and Android app configs, and the deploy itself (indexes, rules,
   functions), which blocks everything below. The Firebase CLI on this machine must also be re-run as
   `firebase login` under the account that owns it, because it currently sees a different project.
2. Phone-auth provider enabled + test numbers — blocks real OTP.
3. Blaze plan — **in place** on `drivx-116de`; the earlier project's billing was never recognised by
   Google, which is why the project was replaced rather than renamed. Cloud Functions, the scheduled
   sweep and Storage still need deploying there before the plan buys the app anything.
4. Maps keys — **one of five supplied**. The server key in `functions/.env` already prices every
   quote off Google's road distance, and it also answers Places and Geocoding calls, but it carries
   no API or referrer restriction, so it should be restricted or rotated (it was pasted into a chat).
   What is still missing is the Android, iOS and JavaScript API keys, which are what any visible map
   needs — the app has no map surface yet, so nothing on screen can draw roads, pins or a route line.
5. Cashfree — **configured, and blocked one step short of working.** The live app id and secret key are
   in `functions/.env` and the functions are redeployed; one ₹1.00 order was created against the live
   merchant account and read back with its amount intact, so the outbound leg is proved. The two
   charges the platform keeps are *live* regardless — the driver's ₹315 onboarding fee and the configured cut (13% by
   default) + any Admin-configured tax on completed-trip commission — because the office takes cash or UPI and an administrator
   records that handover (`recordDriverDuePayment`), which is an attested fact rather than a simulated
   transaction. What the in-app path still cannot do is complete: the `referralme.in` organisation policy
   (see `credentials-checklist.md` step 10) refuses to make a Cloud Run service publicly callable, which
   blocks the driver's browser from `createPaymentOrder` *and* Cashfree from `paymentWebhook`. So no due
   has ever been settled by the gateway, and nothing pretends otherwise.
   **The secret key was pasted into a chat on 2026-10-26.** Rotate it in Cashfree Dashboard → Developers
   → API Keys once the flow is proved, exactly as the Maps server key above still needs rotating.
6. App Store developer account + EAS credentials; Play Console developer account + signing keystore.
7. FCM/APNs configuration for push, including the APNs auth key upload.

**Needs a physical device (cannot be proven in a simulator or an emulator)**

8. Real SMS delivery and the reCAPTCHA/Play Integrity/App Attest flows.
9. Background-location behaviour and battery optimisation on Xiaomi/Oppo/Realme devices, which kill
   the driver's location service far more aggressively than stock Android.
10. GPS accuracy in a basement parking level and a Delhi underpass — the numbers that set
    `maxArrivalAccuracyMeters` and `arrivalConsecutiveSamples` have to be measured, not guessed.
11. Push delivery with the app terminated, and the cold-start deep link to a trip.
12. Live maps performance on a low-end Android handset while the customer is watching a moving pin.

**Needs a decision from you rather than a credential**

13. Financial-record retention period for bookings, payments, refunds and audit logs — the data
    model has a "Gap" row for this in `docs/data-model.md`.
14. Trip-trace retention (Storage has no purge and the dispute window is undefined).
15. Whether cash rides are recorded-only or collected-in-app once a policy exists.
16. Cab/fleet licensing review before `cab_standard` and `cab_premium` are enabled — the schema is
    ready and the spec explicitly forbids claiming a legal fleet operation before that review.
17. Fare settings in `pricingRules` are proposed pilot values, not a permanent public tariff. Local rates stay on the prior chart: one-way slabs through 40 km then ₹12/km; hourly packages ₹149/₹279/₹449/₹799/₹1,099 with ₹10/km extra and ₹120/hour overtime. Outstation one-way uses separate bands through 500 km and ₹10/km beyond the accepted quote; round trips use day packages through 11 days, ₹100/hour overtime and ₹200 per eligible night hour. Local night stays flat ₹150. The Admin Fare settings page lets an authorized Admin edit these values, configured tax, commission, night window and overtime grace. Routes beyond 500 km and trips beyond 11 days require Admin review. Existing bookings keep the price snapshot they accepted. No tax rate is assumed by default.
18. Two `allow list` rules assume the field they test is present on every candidate (`serviceTypes`
    `enabled` at L212 and L215). A query that filters on that field works, but an *unfiltered*
    `getDocs` over that collection is refused outright with "Property … is undefined on object"
    rather than returning what the caller may see. Every query the apps run today filters, so nothing
    is broken — but the admin dashboard will want unfiltered reads, and the fix is a
    `resource.data.enabled == true` guard written against a possibly-absent field. `ratings` is not in
    that group: it uses `allow read` (L284) and tests `raterUid`/`ratedUid` per candidate, so an
    unfiltered list is refused by the first row that isn't the caller's — which is why the driver's
    rating list filters on `ratedUid` and needs the declared composite index
    `ratings (ratedUid ASC, createdAtMs DESC)` to exist on the live project. That it does was written
    into `firebase/firestore.indexes.json` and cannot be re-read today: `firebase firestore:indexes`
    answers "Your credentials are no longer valid", so `firebase login --reauth` is a prerequisite to
    checking it.
19. Whether the ₹315 onboarding fee stays an office collection now that Cashfree can take it online.
    The ledger is already the right shape for a gateway — a due carries its own `providerOrderId` and
    settles in place — but two
    decisions are yours, not engineering: whether a driver who pays online is approved automatically
    or still checked by a human, and whether the fee is refundable at all (nothing in the schema
    refunds it today; `refunds` is a booking-scoped store).
    **The commission is now on that same ledger** — the office's configured cut, 13% unless
    `appConfig/commission` says otherwise — one `commission_{bookingId}` row per completed
    trip, unpaid from the moment the booking is written as finished, with new work held until it is
    recorded as collected. Three things follow that are yours to decide, not engineering:
   - **How often commission is collected.** Today every trip bills its own row and the hold lifts only
     when *every* row is cleared, so a driver with three finished trips has to bring ₹337.15 to the
     counter before the office will send them another booking — that is literally the seeded demo
     state on `/dues`. The usual alternatives (settle weekly, cap the outstanding balance and bill at
     a threshold, or deduct the share from cash the driver already collected from the customer) are
     each a change to *when* `recordDriverDuePayment` is called, not to the schema. Nothing in the
     code insists on per-trip collection.
   - **Whether dispatch should also read the ledger.** The hold sits on `respondToAssignment` and on
     going online, which is all Phase 1 can reach; once dispatch exists it has to skip candidates with
     unpaid dues as well, or it will keep offering trips those drivers cannot accept. The check lives
     in `requireDriverForNewWork` precisely so the dispatcher can call the same helper.
   - **Whether the cut is of the fare before tax or of the receipt.** It is currently the configured
     rate of the booking's own GST-exclusive `subtotalPaise` — minus any `platform_fee` line, which is
     the office's charge and not a fare the driver took — plus Admin-configured tax on that share, with 0.13 as the
     fallback in `COMMISSION_TERMS` and pinned by the 37 cases in `packages/domain/tests/dues.test.ts`.
     At these two rates the readings differ by exactly nothing (13% of ₹1,008.00 = ₹124.80 + ₹6.24),
     which is why the checks assert `basePaise` and the excluded lines rather than the total: if the
     intent was 13% *of the receipt*, that is one field, and rows billed before the change read as
     history. What the rate itself is worth is decided at the counter, not here — `verify:driver-dues`
     proves the ledger follows `appConfig/commission` (a trip after a move to 10% billed at 10%) and
     that a trip carrying the terms it was quoted on keeps them.
20. The rules suite and the apps share one emulator, and the Firestore emulator does not separate
    projects, so the suite seeds its fixtures under a per-run uid namespace (`cust-1-<run>`). Two
    assertions are therefore membership checks rather than row counts: the ops whole-board read and
    the customer's enabled-catalogue query, both of which legitimately see the demo bookings and the
    `chauffeur_*` services the app seeds beside them. Everything else, including "a customer lists
    only their own bookings", still asserts the exact set. Export `RULES_RUN_ID` to reproduce a run
    against one fixed fixture set.

## 9. Known limitations of this repository right now

- **The rules are now proven by execution, and were not before.** Running the suite for the first
  time (JDK 21 + `npm run emulators` + `npm run test:rules` → 79 passed at that point, 115 now)
  immediately found five defects that review had missed: an `in` operator in the RTDB rules (a
  language the Realtime Database does not support, which would have failed `firebase deploy`), two
  `let` bindings written inside `match` blocks where the Firestore grammar does not allow them, a
  `notifications/{uid}/{id}` path that is not a legal Firestore document path, a Storage rule that
  let any signed-in uid write into the `drivers/` tree because it compared only uids and not the
  driver role, and a `get()` inside a `list` rule, which Firestore cannot evaluate — that last one
  would have made every customer's trip-history query fail in production.
- **Two more defects appeared when the customer app's own queries were executed**
  (`npm run verify:customer-paths`, restated as 27 durable cases in
  `packages/rules-tests/src/customer-app.test.ts`):
  1. `savedPlaces/{uid}/places/{placeId}` granted `allow read, create, update`, and `allow read`
     covers **list** as well as get. Because Firestore ORs the matching allow rules, the
     `allow list … request.query.limit <= 20` cap written underneath it could never bind — the
     bound was decorative. A `limit(21)` from a client succeeded until the rule was split into
     `allow get` plus the capped `allow list`.
  2. Nothing held `privacy.preciseLocationWhileIdle` at `false`. Guardrail 5 says precise location
     is scoped to trip participants; the field was readable and writable by its owner, so an idle
     customer could turn themselves into a continuously-tracked device. `idleLocationStaysOff()` now
     refuses the create and the update. Writing it as `data.get('privacy', {}).get(…)` looked
     reasonable and was an evaluation error — the rules engine's `Map.get` is unreliable here, so
     the guard uses `'k' in data` tests.
  A third finding was about the fixtures rather than the rules: the seed and the rules-test seed
  carried fields the domain model does not have (`estimatedFarePaise`, `paymentStatus: 'paid'`,
  a `name` on saved places instead of a `Place`). They wrote cleanly and the screens would have
  rendered "Not set" against them, which is the worst possible first impression of real data. Both
  are now built from the `@drivx/domain` types.
- **The dues ledger was the first thing built twice — once as a rule, once as money — and the second
  pass corrected the fixture, not the code.** `npm run verify:driver-dues` (38 checks) completes a real
  booking through the Functions emulator and reads back the row the trigger raised; the findings:
  1. The seed marked its approved driver `availabilityState: 'online'` while their commission rows sat
     unpaid — precisely the state the new hold exists to make unreachable, and visible as a
     contradiction because `/dues` reads that Firestore field while the driver app reads RTDB presence,
     which is empty in Phase 1. The fixture now seeds `offline`, and the two surfaces agree again.
  2. The first run of the onboarding script failed five checks, and for the same class of reason the
     rules were never at fault: recording a collection by hand in the browser during an earlier
     session left the seeded pending driver's ₹315 row `paid`, and the script asserts against live
     fixture state. Re-running `npm run seed` restores it. Anything that reads a seeded document must
     treat the seed as a precondition, and both money scripts now say so at the top.
  3. A `collectionGroup('dues')` read is evaluated against `match /{path=**}/dues/{dueId}` *alone*.
     The per-profile grant does not carry it, and Firestore denies the whole query rather than the row,
     so a missing grant looks like an empty page instead of a permission error. That rule and its
     staff-only condition are now among the 54 Firestore cases.
  4. The commission base is a business rule disguised as arithmetic. The configured cut of the pre-tax
     `subtotalPaise`; configured tax applies to that commission only. Fare tax is excluded from the base.
     `packages/domain/tests/dues.test.ts` pins the derivation instead; see decision 19 above.
- **What the suite still does not cover.** `packages/rules-tests` exercises rules only. Fares and the
  commission share are unit-tested (54 + 37 cases, in `packages/rules-tests` and `packages/domain/tests/dues.test.ts`), and the money paths are
  executed end to end by `verify:driver-onboarding` and `verify:driver-dues`. The trip loop is covered
  by neither a rules case nor a unit test alone: `npm run verify:trip-loop` runs the whole chain
  against the emulator — both codes, both dial readings, the running meter, the metered receipt and
  the commission row it raises — with the rules enforcing who may write each of them. What still has
  no execution at all is dispatch's claim transitions (`respondToAssignment`, the radius sweep) and
  every payment call; those remain `501 not-implemented` until Phase 3, and the money hold is the
  only part of those calls that exists today.
- The emulator seed runs and is re-runnable (`npm run seed`), but it seeds Firestore only. Realtime
  Database location state and Storage objects are not seeded — the fixtures for those exist only
  inside the rules-test suite, because in production they are written by dispatch (Phase 3).
- The scheduled functions (`sweepStaleLocationData`) now initialize locally — `firebase.json` runs
  the Pub/Sub emulator, without which the Functions emulator reports
  `function ignored because the pubsub emulator does not exist` and the retention sweeper is never
  even loaded. What still cannot be proven on a laptop is the **wall-clock firing**: Cloud Scheduler
  itself is not emulated, so the cron delivery has to be watched in a deployed project's logs.
- **Phone sign-in and sign-up now run for real** (`npm run verify:phone-otp`): the React Native build
  of the JS SDK asks the Auth emulator for a code, the emulator generates and validates its own
  six-digit value, and a wrong code is refused. The first new number to pass through it exposed a
  second defect: `provisionNewAccount` did `tx.get()` after `tx.set()`, which Firestore transactions
  forbid, so every fresh signup died with *"Firestore transactions require all reads to be executed
  before all writes"* and no role claim was ever minted. Fixed, and the trigger now writes
  `users/{uid}`, `customerProfiles/{uid}` and the `role: customer` claim.
  What the emulator still cannot do is **deliver the SMS** — the code is read back from its own
  store and shown on the sign-in screen, labelled as such. Real delivery needs a project plus a
  development build with `@react-native-firebase/auth`.
- **The customer app's data paths now run for real** (`npm run verify:customer-paths`): four
  concurrent signed-in sessions — a customer, a second customer, an admin, a verified driver —
  each issuing the exact query or write its hook builds, from bookings and trip detail to saved
  places, profile save, notification read receipt and support ticket. It also proves the negative
  half: the other customer's booking, profile and inbox are refused, a client cannot write its own
  fare, and `createBooking` — now implemented — is exercised on the happy path: it writes
  `bk-{idempotencyKey}` with the breakdown the callable priced, an immediate replay of the same key
  returns that booking with `deduplicated: true` and one document rather than two, and the same
  payload sent on a driver token comes back `permission-denied` with nothing left behind. A browser
  session made the same call twice on the two services and hit the rate limit once, so
  `functions/resource-exhausted` ("This account has 6 bookings per hour") is a state the composer
  renders rather than a code that only appears in tests.
  Two behaviours it surfaced belong to Firestore's semantics rather than to a defect, but they
  shape what a screen is allowed to say: a client GET of a document that is missing **or** belongs
  to someone else is answered the same way — `permission-denied`, never not-found, because the
  read rule dereferences `resource.data` and there is nothing to dereference. So trip detail
  cannot promise "this booking does not exist" and says "not available to you" instead. And in a
  list, refusing *every* candidate fails the whole request while refusing only some drops those
  rows silently — which is why the ownership filters in `queries.ts` are part of the query, not a
  client-side `.filter()`.
- **The customer app has now been looked at** — in a browser, on this Mac, through the Expo web
  target (`npm run mobile:web` → `http://localhost:8081`), with the emulator behind it. Signing in
  as `+919000000001` showed the live "Driver on the way" card, ₹-formatted fares, the itemised fare
  plus event log on trip detail, saved places, support tickets and the account aggregates; signing
  in as `+919000000002` showed the empty saved-places state and only that customer's own booking.
  Opening it for the first time found **six defects that 105 rules cases and a green typecheck had
  not caught**, which is the argument for rendering rather than only executing:
  1. `read(value, prefix)` in `packages/firebase-client/src/config.ts` ignored its `prefix`
     argument, so *every unset* environment variable came back as its own key name. The app
     therefore reported a "live" Firebase project (`FIREBASE_PROJECT_ID` as the project id) instead
     of emulator mode, and the README's "with no `.env` both apps default to the emulator" was
     false until this was fixed. Absent now stays `undefined`.
  2. `getReactNativePersistence` does not exist in the browser build of `firebase/auth`, so the
     web target died at import time. Persistence is now branched by platform
     (`apps/mobile/src/lib/firebase.ts`) — AsyncStorage on native, the SDK's own default on web.
  3. `expo start --web` crashed in `@expo/cli`'s typed-routes generator with
     `Cannot find module 'expo-router/internal/testing'`, because `expo-router` sat in
     `apps/mobile/node_modules` and root `npm install` never hoisted it. It is now a root
     devDependency; a fresh clone needs that hoist or the web target cannot start.
  4. `options={{ href: null }}` on the pushed screens looked like the correct way to say "not in
     the tab bar", but it also removes them from the *linkable* route table: `/saved-places`,
     `/support` and `/trips/bk-demo-1` all cold-loaded to `/`, and `router.push` to them did
     nothing. `tabBarButton: () => null` hides the button and keeps the route reachable.
  5. The callable transport converts an absent optional field into `null`, so a booking with no
     address line two was rejected as `invalid-argument` **on both sides of the wire** — the
     client's `placeInputSchema` in `@drivx/domain` and the server's own `placeSchema` in
     `functions/src/lib/validate.ts` both used `.optional()`. Fixing only the client copy still
     produced the same server refusal; both now use `.nullish()`. That moved the failure rather
     than ending it: `.nullish().transform(v => v ?? undefined)` leaves a *present* key whose value
     is `undefined`, and the Admin SDK's Firestore encoder throws on `undefined` instead of skipping
     the field, so `createBooking` answered an opaque `INTERNAL` 500 for exactly the payload the
     browser sends. `functions/src/lib/admin.ts` now sets `ignoreUndefinedProperties` on the cached
     instance, and the bisect that proved it is recorded in `docs/data-model.md`: dropping
     `addressLine2` or `placeId` still 500s, dropping both used to return 200.
  6. The sign-in screen never navigated after a verified code — the route guard lives on `/`, so
     a successful `confirm()` left the form on screen, where a second tap resubmitted the same
     verification id and Auth answered `auth/invalid-verification-id`. `/sign-in` now redirects
     to `/` once the session is signed in.
- **The driver onboarding chain has now been run as one real driver** — sign up a new number, get the
  driver role, upload paperwork from the phone side, approve it from the console side, and read every
  step back from the server. Three defects surfaced only because the whole chain was executed:
  1. `apps/mobile/src/features/driver/documents.ts` wrote `uploadedAtMs: Date.now()` while this repo
     stores every `*Ms` field as a native Firestore `Timestamp` and converts at the read boundary
     (`packages/firebase-client/src/serialize.ts`). The reviewer's panel therefore threw
     `Runtime RangeError: Invalid time value` inside `Intl.DateTimeFormat`, because the seeded
     documents already arrive as Timestamps and the console had been handed the same lie the writer
     was telling. Both sides are fixed: the driver app writes `serverTimestamp()`, the console reads
     through `toEpochMs`. A type that says `number | null` over a field the database stores as a
     `Timestamp` is not a check — only running it caught this.
  2. `uidSchema` demanded 28 characters. Real Auth-minted uids are 20 characters on a legacy project,
     so `setDriverVerification` refused a genuine driver with
     `invalid-argument — … driverUid: String must contain at least 28 character(s)` while accepting
     the seed fixtures. The floor is 20 — high enough to catch a typed-in id that is not a real uid,
     low enough to answer a legacy project's twenty.
     The other half of that finding came later and was the worse bug: the *seed* minted its accounts
     under the bare aliases (`drv-1`, `admin-1`), five characters, so every privileged callable refused
     them. The verification console listed a seeded driver in its queue and then answered
     "Money collected" with a uid-length error — the demo data was un-actionable by design and looked
     broken to whoever pressed the button. `scripts/seed.mjs` now mints `drv-1-drivx-local-seed` and
     friends, which is what a real uid looks like, and `upsertAccount` retires the old short account
     and its documents when it meets one. A fixture should be able to do what a real account does, or
     it is not testing the thing it appears to test.
  3. Building the review queue on a collection-group read of `driverProfiles/*/documents/*` answered
     `false for 'list' @ L328`; see the rules note below.
- **Automation-only, and worth knowing before the native build**: under browser automation the Expo
  dev overlay reports an uncaught `Failed to execute 'removeChild'` from
  `node_modules/expo-image-picker/src/ExponentImagePicker.web.ts:139`. Its change handler runs twice
  for one input when the harness assigns `input.files` and dispatches `change` itself, and the second
  pass tries to detach the input a second time. The exact trigger is expo's own (the `cancel`
  listener on line 141 re-dispatches `change`), and it was not isolated further because the upload is
  unaffected — `resolve()` happens on line 132, before the cleanup throws — and all three documents
  reached Storage in the run that produced this note. The `.web.ts` picker is not the code path iOS or
  Android use, and a human choosing a file fires `change` once, so this is not a product defect. It is
  the reason the driver checklist still has to be run on a device before the upload path can be
  called verified there.
- **The admin console has now been looked at** — `npm --workspace @drivx/admin run dev -- -p 3001`
  (port 3000 belongs to another dev server on this machine, and `npm run admin -- --port 3001` does
  not work: npm forwards it as `next dev 3001`, which Next reads as a project directory). Its first
  render caught a real one: every status badge came up the same grey. Nothing was wrong with the
  tokens — `--dx-badge-*` were in the injected style — but Tailwind had emitted no
  `.text-badge-*` rule, so each badge silently *inherited* its colour. An element with no matching
  utility does not fail, it just inherits, which is how a missing token namespace looks like a
  design decision. `touch globals.css` did not help; the chunk hash was unchanged until the dev
  server restarted.
- **The driver screens have now been rendered too** — Duty, Trips, Documents, Earnings and Account,
  signed in as `+919000000011` through the real phone-and-code screen, both in-app and on a cold load
  of `/`. An earlier note here claimed the observation that "a driver lands on the *customer* tab bar"
  was a stale-bundle artifact; that was wrong and is corrected: it is real for any **named** route
  below `/`. `/(customer)` and `/(driver)` share their screen names, so `/` does resolve to the right
  group by session (`apps/mobile/src/app/index.tsx` works as written), while `/account` or
  `/documents` cold-loaded by a driver matched the customer group first and rendered its screens. That
  is now closed by the per-group guard described further below, not by the entry redirect.
- What the theme pass added to the backlog, none of it business logic:
  1. `ScreenHeader`'s eyebrow clipped instead of wrapping until its text block got
     `flex: 1, minWidth: 0` — a flex child will not shrink below its content otherwise.
  2. `react-native-web`'s `Switch` paints its thumb **Material teal** in the on state unless
     `activeThumbColor` is passed, and no React Native type declares that prop. `Toggle` now sets it
     once, branched by platform.
  3. `BottomNav` in `@drivx/ui` is exported but used by neither app — both tab bars are
     expo-router `Tabs`. It was restyled with everything else and left in place; deleting it is
     cleanup, not redesign.
  4. `theme.fontFamily.mono` still names `SpaceMono`, which the mobile app no longer loads (only
     Plus Jakarta Sans). Nothing reads the role, so it renders nowhere — but it is a lie in the token
     file, and the admin's mono is Geist Mono from a different source.
  5. Both tab bars drew their label in **system-ui at ~10px**, because react-navigation sets no font
     on it — the one line of text in the bar was outside the type system. `tabBarLabelStyle` now
     pins Jakarta 13/500 from the tokens; read back off the live render, not assumed.
- **Two signed-in roles in one browser tab** is how the trip loop gets driven: `http://localhost:8083`
  and `http://127.0.0.1:8083` are *different origins* to the browser, so each keeps its own
  `localStorage` and therefore its own Firebase session. Customer on one, driver on the other, one
  tab, no sign-out dance. Two things about Expo web are worth knowing before automating it: previous
  screens stay **mounted** underneath the current one, so a coordinate-based click can land on a
  hidden button (that is how a demo trip got cancelled by accident), and the reliable pattern is to
  find the element by its accessible name inside the live document and dispatch the press there.
  Text inputs need the native `value` setter plus an `input` event — assigning `el.value` directly
  updates the DOM and leaves React's state empty, so the form submits a blank code.
- **The trip loop has no way to reach a driver on its own.** `verifyTripOtp` / `recordOdometer` /
  `confirmCompletion` all assert `assignedDriverUid === caller.uid`, and nothing in the product writes
  that field — dispatch (`manualAssign`, the 50 km radius offer sweep) is still Phase 3. So driving
  the loop by hand needs one privileged write from outside the apps; `scripts/seed.mjs` leaves its
  bookings in `requested`/`assigned` demo states and does not help here. Until dispatch exists, the
  Duty screen's "no trip" state is the honest one for a driver with nothing hand-assigned.
- **`Pay … now` on the driver's Duty screen shows a JavaScript error as user-facing copy.** Pressing
  it renders `cashfree.checkout is not a function` — the real reason is that in-app payment has no
  keys and no reachable callable on this project (see the Cloud Run org-policy blocker), but the
  surface should say that in the owner's language instead of leaking a stack line. The fallback copy
  underneath it ("hand it over at the office instead") is already correct; the raw string above it is
  the defect, and it is a display bug only — no money movement is attempted and no due changes state.
- **The role guard below `/` exists, and it is what a deep link now hits first.** This used to be the
  repository's worst routing defect: `apps/mobile/src/app/index.tsx` picked the tab group at the entry
  route only, so a driver who cold-loaded `/account` got the *customer* Account screen — empty name,
  no contact, "Trips booked: 0" — because a read of a document that does not exist comes back
  `exists: false` rather than `permission-denied`, so the screen had nothing to show and nothing to
  refuse. No data ever crossed accounts and the write path stayed the rules', but a driver tapping
  "Save changes" there would have created a `customerProfiles` document under their own uid, and a
  signed-out cold load simply hung on "One moment". Both tab groups now render inside
  `apps/mobile/src/components/AppSurfaceGate.tsx`, which redirects on the session rather than on the
  URL: signed out → `/sign-in`, no profile → `/create-profile`, wrong surface → that surface's own
  root. Re-proven on `127.0.0.1:8083` with the Auth emulator: a driver session cold-loading
  `/account` renders its own Duty screen (the customer form never appears), and with the session
  removed `/documents` and `/account` both land on the sign-in screen with "One moment" nowhere on the
  page. What the guard deliberately does **not** do is land you on the matching screen: `(customer)`
  and `(driver)` share their route names, so `/account` is one URL for two screens and there is no
  way to tell from the path which one was meant. A cross-surface deep link arrives at the app's root
  and the right tab is one tap away. The real fix is a per-surface path prefix (`/(driver)` mapping to
  `/driver/…`), which changes every link in the app and is a Phase-3 decision, not a patch.
- `npm run lint` is **not clean**, and the two remaining findings predate the theme pass:
  `apps/mobile/src/app/(customer)/account.tsx:57` errors on `react-hooks/set-state-in-effect` (the
  profile form seeds itself from the query inside an effect — the correct fix is a keyed child
  component so the seed arrives as initial state, which is a behaviour-bearing change to a working
  screen and was left alone), and `sign-in.tsx` warns that React Compiler skips
  `useForm().watch()`. The admin workspace lints clean.
- `apps/mobile` contains a nested `.git` directory created by the Expo template while the repository
  root has no git history. Reconcile that before the first commit — otherwise `apps/mobile` becomes
  an untracked submodule-shaped hole.
- Cloud Functions compile to `lib/` and load in the Functions emulator, and the **27** exported
  definitions of that last deploy are **deployed and ACTIVE** in `drivx-116de` (`asia-south1`). The
  entry point exports **32** names today, and `rateTrip` is certainly not among the deployed set — it
  was written after that deploy, so it cannot have reached the project. Whether the four trip calls
  have is not knowable from this machine right now: `npx firebase functions:list --project
  drivx-116de` answers "Your credentials are no longer valid", so `firebase login --reauth` is the
  prerequisite for any claim about what the live bundle holds. Reachability is a
  separate fact: an anonymous `POST` to any callable URL returns Cloud Run's **HTML** `403 Forbidden`,
  which is the platform refusing before the function runs — not the function's own "Sign-in required."
  answer. So no callable here has yet been reached by a live client, and until the services grant
  `allUsers` as `roles/run.invoker` none can be. The wrappers themselves still have **no unit tests** — what is tested
  is the arithmetic and the ledger they call (`@drivx/domain`: 52 fare cases, 11 commission cases) and
  the routes those functions take against a live emulator. Thirteen have now been executed against a
  real session rather than reviewed: `provisionNewAccount` (minted `role: customer` for a
  brand-new number), `setRole` (granted the driver role, wrote its audit entry — and it is the one
  place a claim can be revoked, which is why it refuses to target the caller's own account),
  `flagDriverOnFirstUpload` (moved a real profile to `pending_review` the moment its driver filed a
  document, and raised the ₹315 row beside it), `setDriverVerification` (approved three documents,
  wrote the audit entry, and set `driverVerified: true`, which came back in a freshly-minted ID
  token), `recordDriverDuePayment` (twice — the fee and two commission rows — each with its own audit
  entry), `chargeCommissionOnImportedTrip` and `chargeCommissionOnCompletion` (one raised the row for
  a booking that arrived `completed`, the other re-billed a trip that was cancelled and closed again
  and collided on the same document instead of doubling it), `bookingOptions`, `quoteFare`,
  `createBooking`, and the `searchPlaces` → `resolvePlace` → `reverseGeocode` chain. What has never
  run: `sweepStaleLocationData` (Cloud Scheduler is not emulated), `flagDriverOnResubmission`, and
  the dispatch, offer-response, availability and payment calls, which answer `501` by design. The
  four trip calls — `tripCodes`, `verifyTripOtp`, `recordOdometer`, `confirmCompletion` — are no
  longer in that group: `npm run verify:trip-loop` executes all of them against the emulator with the
  rules on, and they have been driven by hand through both apps. The two
  `publishDriverCardOn…` triggers have been executed too, by the same suite. `rateTrip` belongs in the
  executed group as well: `npm run verify:ratings` drives it through the Functions emulator with the
  rules on — 30 checks over its own throwaway accounts, bookings and driver profile, all deleted again
  at the end — and both screens then read back the rows it wrote: the customer's receipt shows the
  score they gave, the driver's Account shows the star, the chips, the note and the trip reference per
  rating. It is also the definition the live project does **not** have, so until it is deployed no
  customer on `drivx-116de` can rate a trip at all. Rules tests should
  extend to the claim transitions these executions mint (`role: customer`, `role: driver`,
  `driverVerified`); the dues ledger they also write is already covered, per-profile and as a
  collection group.
- **The live project does not fire v1 auth triggers, and that is what broke the first real signup.** On
  2026-10-26 a test phone number signed the owner's number in against `drivx-116de` for real —
  `accounts:signInWithPhoneNumber` answered `200` and Auth created
  `HsMx6Fd3UyMRtojiXIQfflkuHiC2` — and the app then stopped on `/create-profile` with *"Missing or
  insufficient permissions."* The evidence that the trigger is the culprit, not the rules: the function
  is `ACTIVE` with the correct `eventTrigger`
  (`providers/firebase.auth/eventTypes/user.create`), `functions:log` records no invocation anywhere
  near 07:46:15 GMT, `customClaims` came back `null`, and `users/{uid}` did not exist — while
  `firebase/firestore.rules:110` only lets a client create its own `customerProfiles/{uid}` once a
  `role` claim is present. So an unprovisioned account has no route to finish onboarding, and the
  comment claiming the client could do it alone was wrong; it is corrected in
  `functions/src/functions/identity.ts`. The fix is not a rule relaxation, because provisioning decides
  a role: the same transaction now also answers the callable `provisionSelf`, which the app invokes
  when a fresh session arrives with no role, taking the uid and the number from the ID token and
  writing nothing but `customer`. Sixteen checks cover it (`npm run verify:provision-self`), including
  that a second run reports `already_provisioned` and leaves both an admin's claims and a hand-edited
  profile untouched. Until it is deployed, **no new customer can sign up on production**. Worth saying
  plainly: this is the second time an emulator-green phone flow hid a live-only defect — the first was
  `packages/firebase-client` treating a missing reCAPTCHA Enterprise key as fatal.
- A **collection-group read is a `list`**, and `list` has no rule for
  `driverProfiles/{userId}/documents/{documentId}` — candidates fall through to the
  `match /{document=**} { allow read, write: if false; }` catch-all, so the emulator answers
  `false for 'list' @ L328` for the whole query. The verification queue therefore reads
  `driverProfiles` where `verificationStatus == 'pending_review'` — a fact only the server can
  write — and per-driver documents are read as a subcollection of one profile, which the rules do
  name. Anyone adding "all pending documents" needs a server-side index or a `pending_review` field
  on the documents themselves, not a broader client query.
