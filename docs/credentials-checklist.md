# Getting the real accounts and keys

Plain-language, click-by-click. Written for the person who owns the business, not the person who
wrote the code. `docs/firebase-setup.md` is the engineer's version of the same journey; this one
tells you **what to click, what it costs, and what to send back**.

You need four things before DrivX stops being a laptop demo and starts being an app on phones:

| # | What | Who makes it | Cost | Needed for |
| --- | --- | --- | --- | --- |
| A | Firebase project | You, ~20 min | free + pay-as-you-go | accounts, database, SMS OTP, push |
| B | Google Maps keys | You, ~15 min | pay-per-use, see §2 | maps, routes, distance, fare |
| C | Apple + Google developer accounts | You, days (Apple review) | $99/yr + $25 once | the actual apps on phones |
| D | Cashfree | **Approved — keys pending** | per-transaction MDR | online collection of a driver's dues |

Do A and B. C can start while the code is being written, because Apple's account review takes days.

---

## 1. Firebase (accounts, database, SMS, push)

> **Your project is now `drivx-116de`, and the code already knows it.** The repository's four env
> files carry that project's web config — `drivx-116de.firebaseapp.com`,
> `drivx-116de.firebasestorage.app`, `https://drivx-116de-default-rtdb.firebaseio.com` — which is
> the address your customers will see if they ever open a Firebase link. The earlier project,
> `musafir-2415d`, is not configured anywhere any more: its billing never became usable, and Google
> does not allow a project id to be renamed, so it was replaced rather than fixed. Sign in to the
> console as **amit@referralme.in** when you look at it, or the project appears to have vanished.
>
> **Where the checklist stands (2026-10-26).** Steps **1, 2, 4, 5, 7, 8 and 9 are done**: the project
> exists, Blaze is on, Firestore `(default)` is in **`asia-south1`** with **28** composite indexes and
> our rules released on top of it, the `…-default-rtdb` instance exists and carries our rules (it
> answers `401` to an unauthenticated read, which is the rules doing their job), Storage now exists
> with `storage.rules` on it, and the registered web app's id is the one already in the env files. The
> Storage step took two attempts and is worth restating because it is the project's only bucket: the
> first `--only storage` run refused with *"Firebase Storage has not been set up on project
> 'drivx-116de'"*, the owner clicked **Build → Storage → Get started**, and the redeploy released
> `firebase/storage.rules` — after which `drivx-116de.appspot.com` still answers `404` while
> `drivx-116de.firebasestorage.app` answers `403`, which is how the bucket in the env files was proved
> rather than assumed. Step **6 (phone sign-in) is enabled and now proved** — see the phone paragraph
> below. Step **3 (budget alert) is unconfirmed**, and with Blaze on it is the one click
> that decides whether a runaway query becomes a bill. **Cloud Functions are deployed** — 27 gen2
> functions, all `ACTIVE` in `asia-south1`. Deployed is not reachable: an anonymous `POST` to a callable
> returns Cloud Run's HTML `403 Forbidden`, which means the platform blocked it before any function code
> ran. That is the invoker-permission step below, and until it is done no browser can call any of them.
> Step **10 is outstanding**, and it is the one that decides whether a new customer can sign up at all.
>
> `FIREBASE_EMULATOR=false` is now set in every env file and both apps reach `drivx-116de`.
> **Email/Password is enabled** — not a numbered step above, but the console's own login needs it, and
> the owner turned it on 2026-10-26 at **Authentication → Sign-in method → Email/Password**. With it on,
> the console signed in against the live project in a browser, and `/verification` and `/dues` read
> production data behind the deployed rules.
>
> **The phone: one real attempt on 2026-10-26, and it got two answers.** Pressing *Send code* in the
> live app for the owner's own number first failed inside our own wrapper, because
> `packages/firebase-client` asked Firebase for its **reCAPTCHA Enterprise** configuration and treated a
> missing key as fatal. This project has no Enterprise key at all — `GET /v2/recaptchaConfig` answers
> both providers as `ENFORCEMENT_STATE_UNSPECIFIED` with no `recaptchaKey` — and the SDK's own documented
> behaviour in that case is to fall back to the classic reCAPTCHA v2 widget, which Firebase provisions per
> project automatically (`GET /v1/recaptchaParams` returned `6LcMZR0U…`, the invisible widget rendered,
> and it passed silently). The wrapper is fixed; the request then reached Google and was refused for a
> reason no test here could have produced: **`Firebase: SMS unable to be sent until this region enabled
> by the app developer. (auth/operation-not-allowed)`**. Phone sign-in is on, the number is valid, the
> bot check passed — the project had simply never been allowed to send SMS to India. That is a Console
> switch (**Authentication → Settings → SMS region policy → Allow → add India → Save**) and it cannot be
> read or written with the CLI credential from here: the Identity Toolkit config endpoints for this
> project answer `404` HTML.
>
> **Whether that switch works is still unknown, and nothing can tell us from here.** The owner added
> `+91 85108 40825` under **Phone numbers for testing** with the fixed code `123454`, and a test number
> short-circuits the SMS gateway entirely — `accounts:sendVerificationCode` answers `200` and no message
> is ever sent. So that `200` is proof about the test list, not about the region policy, and any claim
> that India SMS is now enabled would be overstated. It stays on the list until a number that is *not*
> in the test list receives a real message.
>
> **What the test number did prove is the part that matters most: the live sign-in itself works.** With
> the code `123454` the app called `accounts:signInWithPhoneNumber`, got `200`, and Firebase created a
> genuine production account for `+918510840825` (`HsMx6Fd3UyMRtojiXIQfflkuHiC2`, 2026-10-26 07:46:15
> GMT). Then onboarding stopped with **"Missing or insufficient permissions."**, and that is the second
> live defect: the server-side trigger meant to provision every new account, `provisionNewAccount`, is
> deployed and `ACTIVE` but **has never fired on this project** — no invocation log entry at sign-in
> time, `customClaims: null`, no `users/{uid}` row — and `firebase/firestore.rules:110` only lets a
> client create `customerProfiles/{uid}` when a `role` claim already exists. In other words **no new
> customer could finish signing up on `drivx-116de`**. The fix is in the repo and proven against the
> emulator (`npm run verify:provision-self`, 16 checks): the same transaction now also answers a
> callable, `provisionSelf`, which the app calls when a fresh session arrives with no role, taking the
> uid and the number from the ID token and writing nothing but the `customer` role. It needs one deploy
> to reach production — see step 10.

1. Go to **console.firebase.google.com** → **Add project** → name it `drivx-prod` → accept.
   Uncheck Google Analytics for now; enable it later, it cannot be pointed at a different property.
   *Already done — your project is `drivx-116de`, so wherever these steps say `drivx-prod`, read
   `drivx-116de`.*
2. **Upgraded to the Blaze plan** — the pencil icon next to "your current plan" top-left, or
   **Project overview → Usage and billing → Manage plan**. Blaze needs a credit card. The free
   Spark plan cannot run Cloud Functions, which is where every fare, OTP and driver assignment
   decision lives, so there is no way around this step.
3. **Set a budget alert immediately**: console.cloud.google.com → Billing → Budgets & alerts →
   $10/month, email you. This is the single most important step in this document. A bug that loops
   on a paid API is the realistic way a side project gets a four-figure bill; a budget alert is how
   you find out at ₹900 instead of ₹90,000.
4. **Create the database**: left sidebar → **Firestore Database** → **Create database** → location
   **asia-south1 (Mumbai)** → **Start in production mode** (this blocks all reads until the security
   rules are deployed — that is correct, deploy step 1 of `docs/firebase-setup.md` §5 before you
   expect an app to work).
   > The Mumbai region cannot be changed after creation. If you pick another region you will pay
   > the latency forever on every trip read.
5. **Create the Realtime Database** (a different product, easy to miss): **Build → Realtime
   Database → Create Database** → same Mumbai region. Live driver position during a trip runs here,
   not in Firestore.
6. **Turn on phone sign-in**: **Build → Authentication → Get started → Sign-in method → Phone →
   Enable**. Then, in the same panel, add **test phone numbers** — put your own number and the
   seeded ones (`+919000000001` … `+919000000099`) with a fixed code like `123456`. Test numbers let
   you and your drivers try the app a hundred times without paying for, or spamming, real SMS.
   *This is the step that actually unblocks testing today: a test number needs no SMS region and sends
   no message, so it works even while real delivery is switched off.*
   **For real SMS there is a second switch, easy to miss**: **Authentication → Settings → SMS region
   policy → Allow → Select regions → India (IN) → Save**. Without it every real number, including your
   own, is refused with `auth/operation-not-allowed` — *"SMS unable to be sent until this region enabled
   by the app developer"* — and the app looks broken even though phone sign-in is on. That is exactly
   what happened on 2026-10-26.
7. **Storage**: **Build → Storage → Get started** → Mumbai. This is where driver licence and
   vehicle-document photos go.
8. **Register the apps**: the gear icon top-left → **Project settings** → scroll to **Your apps**.
   - **iOS** → bundle id `in.drivx.app` → download `GoogleService-Info.plist`
   - **Android** → package name `in.drivx.app` (must match `apps/mobile/app.json` exactly) →
     download `google-services.json`
   - **Web** → nickname `DrivX Operations` → you only need the config values from it
   The bundle id must be the one the code uses, or push notifications and App Check silently fail.
9. **Copy the config**: Project settings → your **Web** app → the `firebaseConfig` block. That is
   the set of values you send back (see §5). The API key in that block is *public by design* — it
   identifies your project, it is not a password. It gets protected by restrictions, not secrecy.
10. **Callable browser origins.** Production callable functions were confirmed reachable on
    2026-10-29: a no-auth POST reached `bookingOptions` and returned the function's JSON “Sign-in
    required” response. The browser failure was CORS, not an organization-policy refusal. The deployed
    `DRIVX_ADMIN_ORIGIN` variable had only localhost origins, so browsers could not read function
    responses. It is now set for all 26 source callables to include
    `https://drivx-116de.web.app`; live preflights return that `Access-Control-Allow-Origin` header.
    Keep `functions/.env.drivx-116de` and `functions/.env.example` aligned for future deployments.
    `provisionSelf` now answers from the browser; the auth trigger `provisionNewAccount` remains
    unverified in production. Firebase Auth, Firestore rules and each callable's own auth/role checks
    still govern the actual operation.
### The India SMS reality, stated plainly

Firebase sends the OTP itself, on Google's sender route. Two consequences:

- The message arrives from an **unbranded sender ID**, not "DrivX".
- Indian telecom DLT rules mean some operators occasionally **filter** those messages. When a
  customer says "I never got the code", this is usually why.

The fix is a DLT-registered Indian SMS provider (MSG91, Twilio India) wired into the same seam the
code already reserves. That is a Phase-5 decision with a ~₹0.15/message cost and a KYC step — not a
blocker today, but know it is coming before you onboard real customers.

---

## 2. Google Maps (maps, routes, and the distance the ₹179–₹559 chart prices)

Maps lives in the **same Google Cloud project as Firebase** (the console links them automatically).

1. console.cloud.google.com → make sure the project picker shows **drivx-116de** (the same Google
   account as the Firebase console, `amit@referralme.in`). If Maps is not yet enabled on that project,
   the console offers to create/attach a billing account — that is the Firebase Blaze account again,
   it costs nothing extra to link.
2. **Enable the APIs** — Marketplace → Library, search and enable each of these four:
   | API | What it is for | Why you need it |
   | --- | --- | --- |
   | Maps SDK for Android | the map inside the driver's phone | live trip screen |
   | Maps SDK for iOS | the map inside an iPhone | live trip screen |
   | Routes API (New) | distance, driving time, the route line | **the distance the ₹179–₹559 chart prices comes from here** |
   | Places API (New) | address autocomplete as the customer types | pickup and destination search |
   Do **not** enable "Directions API" — it is the legacy version of Routes and is billed worse.
3. **Billing must be on for this project too** (same account as Blaze; verify under Google Cloud →
   Billing → it usually shows "Firebase default account").
4. **Create keys separately** — APIs & Services → Credentials → **Create credentials → API key**,
   then immediately **Restrict** it. Five keys, each with both restrictions (two of them are phone
   keys you can leave until the native build, and the two server keys are deliberately *not* one key
   — Routes and Places bill on different SKU families, so splitting them makes a cost spike
   attributable in seconds):
   | Key | Used by | API restriction | Extra restriction |
   | --- | --- | --- | --- |
   | Android | driver/customer app | Maps SDK for Android | package name + SHA-1 |
   | iOS | same | Maps SDK for iOS | bundle id |
   | Web | admin dashboard | Maps JavaScript API | HTTP referrer `localhost:3001` + your domain |
   | Routes server | Cloud Functions | Routes API (New) + Matrix | none available — keep this one out of the app |
   | Places server | Cloud Functions | Places API (New) + Geocoding API | none available — same rule |
   The Android SHA-1 is what people get stuck on: `npx expo run:android` prints it, or run
   `keytool -keystore ~/.android/debug.keystore -list -v` and copy the SHA1 line. Until the key and
   SHA-1 match, the map renders as a grey rectangle with no error message.

   **Where this actually stands: one of these five keys exists**, and it is doing both server jobs —
   it is in `functions/.env` as `GOOGLE_ROUTES_API_KEY` and `GOOGLE_MAPS_SERVER_API_KEY`, and every
   quote in the app now measures its distance through it. It carries **no API restriction and no
   referrer restriction**, proven by the fact that a plain `curl` from a laptop used it successfully.
   Anyone who reads that key from any machine can spend the Maps budget, so either give it an API
   restriction (Routes + Places + Geocoding, nothing else) or delete it and create two properly
   restricted keys. Until then treat the value as published, because it has been pasted into chat.

5. **The server key is the only one that computes money.** It must never appear in the mobile app.
   If it leaks, someone can spend your Maps budget from anywhere, because a key with no platform
   restriction has nothing to check.

### What the map actually costs

Google gives 10,000 free requests per SKU per month, then roughly **$0.002–$0.01 per request**
depending on the SKU. In practice:

- A map load is a request. A customer watching their driver for 15 minutes should be **one** load
  plus marker moves, not 90.
- **Distance Matrix is the expensive one.** Dispatch that asks "how far to each of 40 online
  drivers?" every 5 seconds will be the biggest bill in the system. The code batches these into one
  call per group of candidates — keep it that way.
- The fare needs one Routes call per quote and one per completed trip. At 200 trips/day that is
  roughly ₹1,500–₹3,000/month.

### Turn-by-turn navigation for the driver — the honest recommendation

You asked specifically about real navigation. Google sells two different things:

| | What you get | Cost | Verdict |
| --- | --- | --- | --- |
| **Maps SDK + Routes** | a map, a drawn route, a marker that moves, ETA | cents | build this now, for both roles |
| **Google Maps Navigation SDK** | real turn-by-turn voice navigation inside your app, like the Google Maps app | materially more expensive, billed per active navigation hour, native-only | add later, driver-side only |

Start the driver on a **"Open in Google Maps" deep link** — free, one tap, and every driver already
knows that app. Move to Navigation SDK only when trip volume justifies it and you can see the real
per-hour cost on an actual bill. Building Navigation SDK first is how you get a large recurring cost
before you have a single paying customer.

---

## 3. Developer accounts (the apps themselves)

Nothing in this repository can put an icon on a phone until these exist:

- **Google Play Console** — play.google.com/console, **$25 once**, identity verification takes 1–3
  days. A "closed test" track lets real drivers use the app before it is public.
- **Apple Developer Program** — developer.apple.com, **$99/year**, and for a business account Apple
  needs a **D-U-N-S number** for your registered company. That number takes weeks to obtain, so
  request it first — it is the longest pole in the whole setup.
- Both then need a signing certificate/keystore; `eas build` (Expo Application Services) handles the
  mechanics and has a free tier.

Why this matters for the code: **Expo Go cannot do real SMS, push, or background location.** Those
need a development build. Until one exists on a real handset, everything provable is provable on
the emulator, and the honest status of each feature says so.

---

## 4. Payments — Cashfree credentials are in Secret Manager; deployment and reachability remain

The Cashfree App ID and secret key provided for this setup are stored in Google Secret Manager for
`drivx-116de` as `CASHFREE_APP_ID` and `CASHFREE_SECRET_KEY` (version 1 of each). Values are not in
this repository. The payment functions now declare and bind those secrets in source, but that source
has **not yet been deployed**; the currently deployed revisions do not receive these Secret Manager
versions until `createPaymentOrder` and `paymentWebhook` are redeployed.

| Name | Where you get it | What it unlocks |
| --- | --- | --- |
| `CASHFREE_APP_ID` | Cashfree Dashboard → Developers → API Keys | creating an order |
| `CASHFREE_SECRET_KEY` | same page (it is shown once) | creating orders, and signing the webhook we check |

`CASHFREE_ENV=production` selects the live gateway; `sandbox` points at Cashfree's test one. There is
no separate webhook secret to configure — Cashfree signs the webhook with this same secret key.

**What is proved against the live account:** one ₹1.00 order created through the exact code the
function uses (`functions/src/lib/cashfree.ts`), returned `ACTIVE` with a payment session, and was read
back with the amount intact. Nothing was paid, and the order carries no driver due, so it expires on
its own. Two things that check taught us, now corrected in the code: their
`v2026-01-01` API returns `cf_order_id` as a **string**, and an order response carries **no payment at
all** — so the instrument the driver paid with is read from `GET /orders/{id}/payments`, and anything
that endpoint cannot name is recorded as `online` rather than guessed as `upi`.

The webhook URL to register is `https://asia-south1-drivx-116de.cloudfunctions.net/paymentWebhook`,
subscribed to the payment-success event — but registering it accomplishes nothing until step **10**
above is done, because that policy is why an outside POST cannot reach the endpoint at all. The local
emulator verifier confirmed unsigned (`401`) and wrong-secret (`401`) requests are rejected. This
workspace did not have the merchant secret available to sign a valid unknown-order callback; a signed
sandbox payment and webhook settlement still need to be exercised after function deployment.

**Customer-side cash is unchanged**: no gateway is wired into the booking flow, and the trip fare is
still collected from the customer by the driver.

**What the money is charged against does not change**: the driver's one-time ₹10 + 5% GST = ₹10.50 is
raised automatically when a driver files paperwork, and the office's cut — 13% unless
`appConfig/commission` says otherwise — plus 5% GST of every completed trip is raised beside it as its own `commission_{bookingId}` row — all of it sitting in Firestore as unpaid dues.
Activation is refused while the fee is owed, and a driver with any unpaid row is refused new work
(answering an offer, going online) until it is recorded as collected. Two things can clear a row, and
both write the same fields the ledger already has:

- **At the office.** Someone takes cash or UPI and the admin console's **Clear dues** page records that
  handover with a typed reference and an audit entry naming the collector.
- **In the app.** The Duty screen's `Pay ₹X now` button asks `createPaymentOrder` for an order against
  the oldest unpaid row — the amount comes from the stored row, never from the app — and opens Cashfree's
  payment page. The row only becomes `paid` when `paymentWebhook` confirms that order back through
  Cashfree's API, and the audit entry is then attributed to `gateway:cashfree` rather than a person.
  The current Secret Manager versions still need to be bound by deploying the payment functions. The
  organisation policy in step **10** must also be fixed twice over — once so the driver's browser can
  reach `createPaymentOrder`, and once so Cashfree can reach `paymentWebhook`. Until then this path
  exists but has never moved money.

The button works in the browser build, which is where the app runs today. On a phone build it says so
and points at the office, because Cashfree's native checkout is a separate SDK that has not been added
to the app.

---

## 5. What to send back, and what never to send

**Send these** — they are public-by-design identifiers, safe to paste into a chat. The Firebase ones
have already been sent and are in the repo for `drivx-116de`; what is still missing is the two Maps
keys and the iOS/Android app ids.

```
Project ID            drivx-prod
Web API key           AIza...            (from Project settings → your web app)
App ID (iOS)          1:12345:...:ios:...
App ID (Android)      1:12345:...:android:...
Auth domain           drivx-prod.firebaseapp.com
Storage bucket        drivx-prod.firebasestorage.app   (or .appspot.com — use what the console shows)
Database URL          https://drivx-prod-default-rtdb.firebaseio.com   (Project settings → Realtime Database)
Messaging sender ID   123456789012
Maps server key       AIza...            (the one restricted to Routes/Places)
Maps web key          AIza...
```

**Never send, and never commit to the repository:**

- The **service-account JSON file** Firebase offers under Project settings → Service accounts. It is
  a master key to your whole project. It goes on the server (`FIREBASE_SERVICE_ACCOUNT_JSON_PATH`)
  or into Secret Manager — never into a chat, an email, or `git`.
- Any **private key**, **keystore password**, or the **Apple/Google account passwords** themselves.
- `CASHFREE_SECRET_KEY` and the Cashfree webhook signing secret. Paste them into `functions/.env`
  yourself; do not send them into a chat.

**Where each value goes** — the file already exists, it just has blank lines:

| Value | File | Variable |
| --- | --- | --- |
| Firebase project id | `.env` | `FIREBASE_PROJECT_ID` |
| | `apps/mobile/.env` | `EXPO_PUBLIC_FIREBASE_PROJECT_ID` |
| | `apps/admin/.env.local` | `NEXT_PUBLIC_FIREBASE_PROJECT_ID` |
| Web API key | `apps/mobile/.env` | `EXPO_PUBLIC_FIREBASE_API_KEY` |
| | `apps/admin/.env.local` | `NEXT_PUBLIC_FIREBASE_API_KEY` |
| App id / auth domain / bucket / sender id | same two files | same `EXPO_PUBLIC_` / `NEXT_PUBLIC_` prefix |
| Realtime Database URL | `apps/mobile/.env` | `EXPO_PUBLIC_FIREBASE_DATABASE_URL` |
| | `apps/admin/.env.local` | `NEXT_PUBLIC_FIREBASE_DATABASE_URL` |
| Maps **server** key | `functions/.env` | `GOOGLE_MAPS_SERVER_API_KEY` and `GOOGLE_ROUTES_API_KEY` |
| Maps **web** key | `apps/admin/.env.local` | `NEXT_PUBLIC_GOOGLE_MAPS_WEB_API_KEY` |
| Maps **Android/iOS** keys | `apps/mobile/app.json` native config | not an `EXPO_PUBLIC_*` variable, ever |

`EXPO_PUBLIC_FIREBASE_EMULATOR` and `FIREBASE_EMULATOR` are now **`false`** in every env file, so both
apps talk to `drivx-116de`: the rules, indexes, bucket and all 26 functions are deployed there, which
is the only thing that made the flip safe — before it, a live sign-in would have created no
`users/{uid}` row and every booking would have `404`ed. Set the flag back to `true` (or clear the API
key, project id and app id) when you want the local suite instead; the apps pick their backend from
that one flag, and `npm run verify:firebase-config` checks both halves.

---

## 6. Order of work

1. **Today:** Firebase §1 (20 min) + budget alert. The Maps key restrictions can wait an hour.
2. **Today, in parallel:** apply for Apple's D-U-N-S number and the Play Console account — both
   have multi-day waits and neither blocks the code.
3. **Then:** send me the §5 list. I plug it in, deploy rules and indexes first, and the first real
   SMS OTP goes to your phone.
4. **Then:** one driver handset, one customer handset, one real trip, cash collected, receipt shown.
