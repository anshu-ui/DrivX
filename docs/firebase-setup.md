# Firebase setup

Turn this repository into a running DrivX backend. Nothing here is optional unless marked so,
and nothing here asks you to paste a secret into the repository.

## Before you start

- **Blaze (pay-as-you-go) plan.** Cloud Functions, the scheduled sweeper, Cloud Storage and phone
  auth all require it. The free Spark tier cannot run this backend.
- A Google Cloud billing account with a budget alert attached (see `docs/operations.md`).
- Firebase CLI: `npm i -g firebase-tools`, or use the version this repo pins (`npx firebase`).
- Java **21 or newer** if you want the local emulator and the rules tests — firebase-tools 15
  refuses older JVMs. Check with `java -version`; install with `brew install openjdk@21`.
  `npm run emulators` finds the JDK itself when it is only present as a Homebrew keg.

## 1. Create the project

```
firebase projects:create drivx-prod --project-dir .
```

Keep the name in `.firebaserc` under `projects.default` (the file currently points at
`drivx-local`, which is only meaningful to the emulator). Also set
`FIREBASE_PROJECT_ID` and `FIREBASE_FUNCTIONS_REGION=asia-south1` in the root `.env`.

`drivx-prod` is the placeholder these documents use. The project this repository is configured for
is `drivx-116de`, so read it wherever a command or console step names `drivx-prod`.

> **Which live project this repository points at.** The app is DrivX everywhere, and the Firebase
> project id now matches: the four env files (`.env`, `apps/mobile/.env`, `apps/admin/.env.local`,
> `functions/.env`) carry the web-app config for **`drivx-116de`**, whose Blaze plan works. Its
> addresses are `drivx-116de.firebaseapp.com`, `drivx-116de.firebasestorage.app` and
> `https://drivx-116de-default-rtdb.firebaseio.com`. The `FIREBASE_DATABASE_URL` line matters: the
> JS SDK only guesses `<projectId>-default-rtdb.firebaseio.com`, so a named or diff-region instance
> has to be spelled out.
>
> The earlier project, `musafir-2415d`, is not configured anywhere any more — its billing never
> became usable, and a Google Cloud project id cannot be renamed, so it was replaced rather than
> fixed. A project id cannot be changed in code by renaming either; only the config values move.
>
> **Everything is deployed to `drivx-116de` and both apps now point at it.** On
> 2026-10-26 `firestore:rules`, `firestore:indexes`, `database:rules` and `storage:rules` were
> released, and the read back is an enumeration rather than an assumption: `firestore:indexes` lists
> **28 composite indexes** against the `(default)` database in `asia-south1`, matching the 28 declared
> in `firebase/firestore.indexes.json`. Storage took a second attempt — the first refused with
> *"Firebase Storage has not been set up on project 'drivx-116de'"* until the owner clicked *Get
> started* (§6) — and the bucket question was then answered by probing rather than trusting:
> `drivx-116de.appspot.com` returns `404` while `drivx-116de.firebasestorage.app` returns `403
> Permission denied`, so the project has exactly one bucket and it is the one already in every env
> file. **Cloud Functions are deployed**: 27 gen2 functions in `asia-south1`, every one `ACTIVE`. Read
> this before trusting a `403`: an unauthenticated `POST` to a callable URL returns Cloud Run's **HTML**
> `403 Forbidden` ("your client does not have permission to get URL `/provisionSelf` from this server"),
> which is the platform refusing at the door — the function code never ran. It is *not* the function's
> own `403 PERMISSION_DENIED / "Sign-in required."` JSON, and it is not proof that auth is enforced.
> No callable on this project is reachable from a browser, and that is not a click being missed: the
> `allUsers` / `roles/run.invoker` grant was attempted on all 27 services and **Google refused it** with
> `400 — one or more users named in the policy do not belong to a permitted customer, perhaps due to an
> organization policy`, because `drivx-116de` lives inside the `referralme.in` organisation
> (`709632751966`), which forbids public Cloud Run access. See `credentials-checklist.md` step 10.
> Phone sign-in is enabled per the owner; nothing in the CLI can confirm it, because the Identity
> Toolkit config endpoint returns only the project number and `authorizedDomains` (`localhost`,
> `drivx-116de.firebaseapp.com`, `drivx-116de.web.app`). What that endpoint *also* cannot do is enable
> a provider, which is why **Email/Password had to be switched on by hand** in
> **Authentication → Sign-in method** (before that, `signInWithPassword` answered
> `PASSWORD_LOGIN_DISABLED`). The owner did so on 2026-10-26, and a staff session through the console
> is now the only authenticated live path this project has — the callables above are still unreachable.
>
> `FIREBASE_EMULATOR=false` is now set in every env file, so anyone who runs this repo reaches
> `drivx-116de` instead of a local suite. To work against `npm run emulators`, set the flag back to
> `true` — or clear the three values the resolver needs (`FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID`,
> `FIREBASE_APP_ID`), since an unconfigured project falls back to the emulator on its own. Flipping the
> flag surfaced a defect worth keeping as a rule:
> Next.js only inlines `process.env` reads that are **written out literally** — an indexed read with a
> computed key survives into the browser bundle as `undefined`. `apps/admin/lib/env.ts` used to build
> its config by looping over key names, so the console received no Firebase values at all,
> `buildClientEnv` fell back to the emulator on `firebase === null`, and the page showed a server-side
> "live · `drivx-116de`" banner while the client signed people in through `127.0.0.1:9099`. Write new
> config keys out one by one; `npm run verify:firebase-config` (32 checks) fails if any of them is read
> through a computed name.
>
> **How the CLI got in, and why the obvious route was closed.** `drivx-116de` lives in the
> `referralme.in` Google Workspace, whose organization policy restricts project membership to
> accounts in allowed domains. Inviting this Mac's pre-existing CLI identity,
> `amit.1drona@gmail.com`, was attempted and rejected at acceptance time (*"An organization policy
> restricts that only users from specific domains are allowed"*). What works, and is what the CLI now
> uses: `firebase login:add` on this machine, completed in the browser as `amit@referralme.in`,
> followed by `firebase login:use amit@referralme.in`. `firebase login:list` then reports that
> account as active with `amit.1drona@gmail.com` still available to switch back to, and
> `firebase projects:list` shows `drivx-116de` (project number `505583146898` — the same number that
> appears in the web `appId` and `messagingSenderId` in the env files, which is how the config was
> proved to belong to this project rather than copied on trust).

Region decisions, once, deliberately:

| Choice | Value | Consequence |
| --- | --- | --- |
| Firestore location | `asia-south1` (Mumbai) | cannot be changed later; a diff region means cross-region latency on every trip read and higher Firestore egress |
| Realtime Database instance | `drivx-prod-asia-south1` (or the single-instance form) | must be created manually in the console; RTDB is not provisioned by `firebase init` |
| Cloud Functions region | `asia-south1` | set through `REGION` in `functions/src/lib/config.ts`; every callable URL is region-scoped |
| App Check / Maps | same project / India-facing endpoints | keeps the abuse envelope in one place |

## 2. Register the three apps

In the console: **Project settings → Your apps**.

| App | Platform | Identifier | Config file |
| --- | --- | --- | --- |
| Mobile | iOS | `in.drivx.app` | `GoogleService-Info.plist` into `apps/mobile/ios/` (after prebuild) |
| Mobile | Android | `in.drivx.app` | `google-services.json` into `apps/mobile/android/app/` |
| Console | Web | DrivX Operations | copy the values into `apps/admin/.env.local` |

The iOS and Android identifiers must match `apps/mobile/app.json`, or Deep Links and App Check
attestation will not resolve to the app.

## 3. Enable the services

- **Authentication → Sign-in method → Phone.** Add every developer test number you want
  (`+919000000001` … `+919000000099` with a fixed 6-digit code) so the first device tests do not
  spend real SMS credits. Enable it for the **web** app too, or reCAPTCHA will not initialise.
- **Firestore** → create the database in production mode, region `asia-south1`.
- **Realtime Database** → create the instance in the same region.
- **Storage** → get started; the default bucket is `<project>.appspot.com` (newer projects may show
  `<project>.firebasestorage.app`; set whichever value the console shows in
  `EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET`, because `packages/firebase-client` only defaults to the
  `appspot.com` form).
- **Cloud Messaging** — no configuration needed; the API is on by default. Push tokens are stored
  by `registerDeviceToken`, and sending is Phase 5.
- **App Check** → register the iOS, Android and web apps (see §7).
- **Analytics** → enable, then **Crashlytics** → select the Analytics data stream. Both are
  required by spec §11; the native SDKs are added by the development build in
  `docs/operations.md`, not by the JS SDK.

## 4. Environment files

Copy each example, then fill it in. Values are per-app on purpose: Expo only inlines
`EXPO_PUBLIC_*`, Next.js only inlines `NEXT_PUBLIC_*`, and functions read their own `.env`.

```
.env.example              → .env              (CLI + emulator)
apps/mobile/.env.example  → apps/mobile/.env  (EXPO_PUBLIC_*)
apps/admin/.env.example   → apps/admin/.env.local
functions/.env.example    → functions/.env    (server-side only)
```

| Variable | Where it must appear | Where it must never appear |
| --- | --- | --- |
| Firebase web config (apiKey, appId, authDomain, storageBucket) | mobile, admin, functions | — (these are public by design) |
| Realtime Database URL (`FIREBASE_DATABASE_URL`) | mobile, admin | — (public too; it is the rules that limit it, and without it live driver location cannot connect) |
| Maps **client** key (iOS/Android restricted) | `app.json` native config | any `EXPO_PUBLIC_*` var shared with a web bundle |
| Maps **web** key (referrer-restricted) | admin only | mobile |
| Maps **server** key | functions only | both clients |
| Cashfree secret key, webhook signing secret | functions only | both clients |
| Service-account JSON | functions runtime path or Secret Manager | the repository, the mobile bundle, the admin bundle |

`scripts/seed.mjs` is emulator-only and has no live-project equivalent on purpose: against
production you create accounts by signing in, and grant roles through the `setRole` callable, which
writes an audit entry. Do not "fix" this by pointing a service account at a script in the repo.

## 5. Deploy

Order matters — rules and indexes first, so no client ever talks to an unprotected database.

Name the project on **every** command, and do not run `firebase use drivx-116de`:

```bash
firebase deploy --project drivx-116de --only firestore:indexes   # 28 composite indexes + 3 field overrides
firebase deploy --project drivx-116de --only firestore:rules
firebase deploy --project drivx-116de --only database
firebase deploy --project drivx-116de --only storage
firebase deploy --project drivx-116de --only functions
```

Status on 2026-10-26, from the four commands that were actually run: `firestore:indexes` and
`firestore:rules` released together, `database:rules` released against
`drivx-116de-default-rtdb`, and `storage` **first failed** with
`Firebase Storage has not been set up on project 'drivx-116de'` — the CLI enabled the
`firebasestorage.googleapis.com` API on the way to that answer, but creating the bucket is a console
action (§6), which the owner then did. Second attempt went through: `--only storage` → `released
rules firebase/storage.rules to firebase.storage`. Two things worth knowing about that target.
**`--only storage:rules` is not a
thing** — unlike Firestore, a Storage deploy target is a *bucket*, so the named form dies with
`Could not find rules for the following storage targets: rules`; bare `--only storage` is the correct
command. And naming the bucket explicitly (`--only storage:drivx-116de.firebasestorage.app`) also
fails, because `firebase.json` declares one rules file rather than a bucket→file map; which bucket
receives it is therefore resolved by the CLI, and the way to prove it is the probe above
(`…appspot.com` = `404`, `…firebasestorage.app` = `403`), not the deploy log. `functions` has since
been run: all **27** definitions are `ACTIVE` in `asia-south1`. That is *deployment*, not *reachability*
— an unauthenticated caller gets Cloud Run's HTML `403 Forbidden`, so no callable has yet been executed
by a real client (see §1's correction). Two things make that deploy lie to you. A gen2 function whose create **failed**
keeps its `firebase-functions-hash` label, so the next `firebase deploy` reports *"Skipping the deploy
of unchanged functions"* for functions that were never built — the only cure is
`DELETE /v2/projects/drivx-116de/locations/asia-south1/functions/{name}` and a redeploy. And a new
project fits only one or two Cloud Run healthchecks at a time in one region, so the whole set at once dies with
*"Quota exceeded for total allowable CPU per project per region"*; deploy one at a time with retries.

One deploy warning is expected and is not a failure: the rules compiler reports
`[W] 86:14 - Unused function: isBookingDriver`. That helper is real dead code — every driver-side
write in Phase 1 turned out to be Admin-SDK-only, so no rule ever needed it — and the only honest fix
is to delete it and re-run `npm run test:rules` before the next deploy, not to silence the warning.

`firebase use` rewrites `.firebaserc`, whose `default: drivx-local` is what the emulator suite and
`npm run seed` both run under. Point that alias at the live project and `npm run emulators` starts a
`drivx-116de` emulator while the apps and the seed keep reading and writing `drivx-local` — an empty
app, with no error anywhere to say why.

Index builds take minutes and the console shows progress under **Firestore → Settings → Indexes**;
a query that needs a missing index fails with a `FAILED_PRECONDITION` message containing a
ready-made creation URL. Use that URL when Phase 2 introduces new queries, then move the generated
index back into `firebase/firestore.indexes.json` so the file stays the source of truth.

**A whole-board query needs a form this file did not know about.** `/dues` lists every unpaid row with
`collectionGroup('dues') where status == 'unpaid'`, and a collection-group *single-field* index is not
automatic — the emulator never checks indexes, so this only appeared once the console was really pointed
at `drivx-116de`. Declaring it as a composite entry fails outright
(`HTTP 400, this index is not necessary, configure using single field index controls`); the deployable
form is a field override carrying the scope:
`{ "collectionGroup": "dues", "fieldPath": "status", "indexes": [{ "order": "ASCENDING", "queryScope": "COLLECTION_GROUP" }] }`.
Omitting `queryScope` dies with `Unsupported index query scope: QUERY_SCOPE_UNSPECIFIED`. After a
successful deploy the query still answers *"That index is not ready yet"* for several minutes while
Firestore builds it, so re-probe rather than assuming the deploy did nothing.

TTL only takes effect once the field override has been deployed **and** the stored value is a real
`Timestamp`. The domain's `*Ms`-to-`Timestamp` serialisation is what makes `otpCodes.expiresAtMs`
and `notifications.expiresAtMs` expire.

## 6. Cloud Functions

Prerequisites the deploy will otherwise fail on:

- The **Cloud Functions** and **Cloud Scheduler** APIs enabled (`onSchedule` creates a
  Cloud Scheduler job).
- Service agent identities present; on a brand-new project, run one `firebase deploy --only
  functions` and let the console create them, then grant the runtime service account
  **Cloud Datastore User**, **Firebase Realtime Database Admin**, and
  **Service Account User** if it must mint tokens.
- `functions/.env` loaded from environment or Secret Manager:
  `firebase functions:secrets:set CASHFREE_SECRET_KEY`, etc. Secrets belong in Secret Manager for
  anything money-related; a plain `.env` is acceptable for limits and flags.

What is live today: `provisionNewAccount` (auth trigger, v1, `asia-south1`), `setRole`,
`setDriverVerification`, `flagDriverOnFirstUpload` and `flagDriverOnResubmission` (Firestore
document triggers, `asia-south1`), `registerDeviceToken`, `sweepStaleLocationData` — plus
`provisionSelf`, deployed on the owner's word 2026-10-26 and unreachable until the `referralme.in`
organisation policy that forbids public Cloud Run access is lifted for this project — Google refused
the `allUsers` grant itself (`credentials-checklist.md` step 10). `createPaymentOrder` and
`paymentWebhook` are live in the same region with the merchant keys loaded, and sit behind that same
policy: the outbound call to Cashfree works, the inbound one cannot yet arrive. Everything else
is declared with validation and authorization in place and throws `not-implemented` naming its phase.

Two deliberate decisions recorded in the code:

- `provisionNewAccount` uses the legacy v1 auth trigger because it runs on any plan and in the
  emulator. The Identity Platform **blocking** function (`beforeUserCreated`) would let provisioning
  *reject* a signup instead of following it — worth switching to once the project is on Blaze and
  Identity Platform, which is a deployment change, not a code change.
- **That trigger cannot be relied on as the only route.** On the live project `drivx-116de` it is
  deployed and `ACTIVE` but has never fired: the first real signup (2026-10-26) left the account with
  `customClaims: null` and no `users/{uid}` row, and the rules then refused the profile the client was
  allowed to write for itself. `provisionSelf` is the same transaction behind a callable, which the app
  invokes when a fresh session arrives with no role; it derives the uid and the phone number from the
  ID token, writes only the `customer` role, is idempotent, and leaves an already-provisioned account's
  claims alone. Prove it with `npm run verify:provision-self`.
- Payments need `CASHFREE_APP_ID` and `CASHFREE_SECRET_KEY`; both are set on `drivx-116de` as of
  2026-10-26, and without them `createPaymentOrder` answers `unavailable` while `paymentWebhook`
  answers `503`. A due is only marked `paid` after `paymentWebhook` verifies the base64 HMAC-SHA256 that
  Cashfree signs over `x-webhook-timestamp` + the raw body **with that same secret key** (so there is no
  separate webhook secret to configure), and re-reads the order from Cashfree's own API. The live API
  taught the code two things the documentation had assumed: `cf_order_id` comes back as a string, and an
  order response carries **no payment**, so the instrument is read from `GET /orders/{id}/payments` and
  an unreadable one is recorded as `online` rather than assumed to be `upi`.
  No code path marks an order paid on a client's word or on the notification alone.

## 7. App Check

Spec §9 requires it, and it is configuration rather than code:

1. **iOS** — register the App Attest provider with the `in.drivx.app` bundle id.
2. **Android** — register Play Integrity with the same package name. Debug builds need the
   `expo-dev-client` debug token added to the **Debug tokens** list, or the development app will be
   rejected by every callable.
3. **Web console** — reCAPTCHA Enterprise (v3) with the dashboard origin.
4. Enforce **per product** (Firestore first, then Functions callables) only after the apps in the
   field can produce a token. Enforcing before that locks out every installed build.
5. `APP_CHECK_FIREBASE_PROJECT_ID` in `functions/.env` is for the verify token helper; App Check
   itself is not evaluated by the emulator, so local tests cannot prove enforcement works. That is a
   known limitation of the emulator suite, not of these rules.

## 8. Local emulator

```bash
npm run emulators              # :4000 UI, auth :9099, firestore :8080, RTDB :9000, functions :5001, storage :9199
npm run test:rules             # 112 cases against the three rule files
npm run seed                   # 6 accounts with minted claims + 41 records
npm run verify:phone-otp       # the sign-in path, through the RN build of the JS SDK
npm run verify:customer-paths  # every read/write the customer screens issue, rules enforced
npm run verify:driver-onboarding  # the ₹10.50 fee: raised by the first upload, cleared only by an admin
npm run verify:driver-dues     # the office's cut (13% default) + 5% per completed trip, and the hold on new work
```

`firebase.json` runs `singleProjectMode` with `.firebaserc`'s `drivx-local`, and
`--import ./.firebase/seed --export-on-exit` persists data between restarts — **but only if the
shutdown is a polite one.** Send `SIGINT` to the `firebase emulators:start` process itself and wait
for it to exit; it exports Auth, Firestore, RTDB and Storage into `.firebase/seed` on the way out.
Interrupting the `npm run emulators` wrapper instead, or killing the Firestore/RTDB/Pub/Sub JVMs,
takes the Node-side emulators down with them and **no export happens at all** — the run's accounts
and uploaded files are simply gone, with nothing in `.firebase/seed` to show for it. Check that
directory's timestamps after a restart before trusting it. Every restart also invalidates the ID
tokens the apps are holding, so a signed-in browser session lands back on the sign-in screen.

Delete
`.firebase/seed` to get an empty backend — the seed upserts rather than clears, so a booking or a
profile you edited by hand survives a re-run. The two catalogue collections it owns outright,
`pricingRules` and `serviceTypes`, are the exception: a document removed from `scripts/seed.mjs` is
deleted on the next run, so a retired pricing rule cannot linger and be read by the apps.

The rules suite no longer needs to run before the seed. `singleProjectMode` still gives
`drivx-rules-test` the same database as the app's `drivx-local`, but the suite now writes its
fixtures under a per-run uid namespace (`cust-1-<run>`, `drv-1-<run>`, `bk-<run>-…`), so
`npm run seed`'s `bk-demo-*` bookings and `chauffeur_*` service types cannot land inside its list
assertions any more — 112 cases pass against a seeded emulator, re-run and confirmed on 2026-10-25.
Two of them stay membership checks rather than row counts (the ops whole-board read and the customer's
enabled-catalogue query), because those reads legitimately see the demo rows; everything else asserts
the exact set. Export `RULES_RUN_ID` to reproduce a run against one fixed fixture set.


**Emulator mode always talks to `drivx-local`, whatever project id is in the app's `.env`.**
The Firestore, RTDB and Storage emulators namespace their data by project id, but the Auth emulator
does not — so an app configured with the live project's id while `FIREBASE_EMULATOR=true` signs in
happily and then reads an empty database, which looks like a product with no data rather than a
misconfiguration. `resolveProject()` in `packages/firebase-client/src/config.ts` overrides the id
(override it in turn with `FIREBASE_EMULATOR_PROJECT_ID`), and the live ids stay in the file for the
moment the flag flips to `false`.

Re-running `npm run seed` re-mints each account's claims and password, which revokes live ID tokens:
a browser session that was signed in goes quiet, and screens hang on their loading state until you
sign in again.

Not emulated, and therefore not provable locally: App Check enforcement, real SMS delivery, Cloud
Scheduler wall-clock firing, Analytics, Crashlytics, and billing/quotas.

## 9. Verification checklist for a new project

Run in this order; each step proves something the previous one does not.

1. `npm run test:rules` passes — the rules behave as documented before anything is deployed.
2. `firebase deploy --project drivx-116de --only firestore:rules,database,storage`, then in the
   console **Rules → Firestore → Get rules link** and confirm a signed-out read of `serviceTypes`
   is denied.
3. Sign in on a device with a test phone number; confirm `users/{uid}` and a profile were created
   with `role: customer` claims.
4. From a second account, try to read the first account's `driverProfiles` document. It must fail.
5. Grant a driver the `driver` role with `setRole` from an admin session, then confirm the audit
   log row and that the driver's own token shows `role: driver` after a refresh.
6. Upload a driver document to `drivers/{uid}/{docId}`, confirm no other account can read that
   Storage object, then approve it from the console's `/verification` screen — which calls
   `setDriverVerification` — and confirm `driverVerified: true` in a refreshed ID token.
7. Call `createBooking` with a place that has no second address line and confirm it writes a
   `requested` booking whose `estimate` is priced by the server, then replay the same
   `idempotencyKey` and confirm one booking comes back, not two.
8. Wait for a `sweepStaleLocationData` execution in **Functions → Logs**, or trigger it manually
   from the console with the test-framework button.

### Already proven against the local emulator

Steps 1, 3, 4 and 7 need no live project, and all four pass on this machine:

- **1** — `npm run test:rules` → 112 passed (52 Firestore rule cases, 27 cases that restate the
  customer app's own queries, 21 RTDB, 12 Storage). Running it for the first time corrected five
  defects and executing the app's queries corrected two more; see `docs/operations.md` §9. The dues
  ledger added cases of its own rather than a correction: the console's `collectionGroup('dues')`
  read needs its **own** staff-only `match /{path=**}/dues/{dueId}` grant, because Firestore
  evaluates a list against that rule alone and denies the whole query without it.
- **7** — `npm run verify:customer-paths` calls `createBooking` through the Functions emulator as a
  signed-in customer: it writes `bk-{idempotencyKey}` with status `requested`, stores the fare the
  callable itself priced, keeps the `notes` a driver will read, and writes the
  `events/ev-booking_created` audit child that records how the distance was measured. Replaying the
  same payload returns `deduplicated: true` with the same booking id and the stored fare, and the
  document count proves two calls made one booking. The same run signs in a seeded, verified **driver**
  and sends that identical payload: `permission-denied`, and an admin-side count confirms no booking
  document exists for the driver uid — so the customer gate is observed, not inferred. An unauthenticated
  `POST` to the callable answers `403 PERMISSION_DENIED` ("Sign-in required."). The verification
  booking is then removed through the emulator's owner token, because no client — staff included —
  has a write path to `bookings`.
- `npm run seed` writes 6 accounts with minted claims and 41 records (four bookings spread over two
  customers, so cross-account privacy has something real to refuse; three of them are completed, and
  the ledger rows those three raise are derived by `commissionDueFor` from the same fixtures rather
  than typed out, so the seeded bill cannot disagree with the seeded receipt); the claims arrive in
  the ID token (`role: customer`, `driverVerified: false`), which is what the rules read.
- **Money** — `npm run verify:driver-onboarding` (36 checks) and `npm run verify:driver-dues`
  (46 checks) run the two charges end to end through the Functions emulator with the rules on: the
  ₹10.50 fee raised by a first document upload and cleared only by an admin's recorded cash/UPI
  handover, and the office's cut — 13% unless `appConfig/commission` says otherwise — plus 5% GST per completed trip, held idempotently to one row per booking, gating
  `respondToAssignment` and going online while anything is unpaid. Both clean up after themselves —
  throwaway accounts, bookings, dues and audit rows are deleted on the way out.
- **4, as far as a laptop allows** — `npm run verify:customer-paths` signs in four real sessions at
  once (a customer, a *different* customer, an admin, and the seeded verified driver) and runs each
  hook's exact query or write: the
  other account's booking, saved places and notification inbox all come back `permission-denied`, a
  client cannot write its own fare, status, assignment or a role-bearing field, and the allowed
  writes (saved place add/rename/delete, profile save, read receipt, ticket create and reply) are
  answered. The driver session is not decorative — it sends the customer's exact booking payload and
  is answered `permission-denied`, which is the only way in this suite to show the customer gate is
  enforced by the server rather than by which screen you happen to be on. Those same screens have since been opened in a browser (`npm run mobile:web`) and signed
  into through the real code screen, so the query results above are the ones the customer actually
  sees — not a headless approximation. A phone or tablet is still outstanding.
- **3, as far as a laptop allows** — `npm run verify:phone-otp` runs the phone flow through the same
  React Native build of the JS SDK the app uses: a seeded number signs in and yields a real session
  whose token carries `role: customer` and `sign_in_provider: phone`; a brand-new number creates the
  account, the `provisionNewAccount` trigger writes `users/{uid}` plus `customerProfiles/{uid}` and
  mints the claim; and a wrong code is refused with `auth/invalid-verification-code`. What is still
  unproven is the SMS leg: the emulator generates and checks a genuine code but cannot deliver one,
  so the screen shows the code read back from the emulator's own store. Careful with that first pass
  list: on the live project the same trigger has never fired, which is why the emulator going green
  did not mean a real signup works — see the `provisionSelf` note in §6, and
  `npm run verify:provision-self` for the path that does.
- The Functions emulator loads all 26 exported definitions (enumerated from the compiled
  `lib/index.js` the emulator entry point requires, after rebuilding — not counted in the source).
  That is not only a source-level claim: the two commission triggers among them have fired in an
  emulator run, and `sweepStaleLocationData` initializes with the Pub/Sub emulator enabled instead
  of being skipped. Its **wall-clock firing** still cannot be proven locally (step 8), because Cloud
  Scheduler itself is not emulated.
- **5 and 6, end to end through the browser** — a brand-new number (`+919000000055`) signed up on the
  app's own OTP screen, was granted the driver role by a real `setRole` call, uploaded its
  photograph, photo ID and licence through the driver app's document checklist, and was approved from
  `npm run admin`'s `/verification` screen. Every link in that chain was read back server-side rather
  than trusted from the UI: the files landed at `drivers/{uid}/{documentType}` in the Storage
  emulator, each metadata document carries `status: pending_review` with the number kept only as its
  last four (`****-4518`, `****-5671`), `flagDriverOnFirstUpload` wrote `pending_review` onto the
  profile — which is what put the driver in the reviewer's live queue, since a driver cannot write
  that field — the decision wrote two `adminAuditLogs` rows naming the actor, the reason and the
  before/after state, and a freshly-minted ID token for that account came back with
  `role: driver` and `driverVerified: true`. Two refusals were observed on the way: an unauthenticated
  read of a driver's Storage object answers `403`, and the queue cannot be built by reading
  documents directly, because a collection-group `list` is refused by the rules (see
  `docs/operations.md` §9).

Steps 2 and 8 need a real project — deployed rules to prove a signed-out read is denied, and Cloud
Scheduler to prove the sweeper fires on a wall clock. Both halves now exist on `drivx-116de` (rules
released, all 26 functions ACTIVE), so what remains for steps 5 and 6 is an authenticated live run
rather than the deployment: `setRole` and
`setDriverVerification` write claims and verification state through the Admin SDK, which the emulator
runs but the rules suite has no unit tests for yet.
