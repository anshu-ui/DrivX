# DrivX data model

The schema authority is `packages/domain/src` — record types, enums and the RTDB shape live there
and are imported by the rules tests, the seed and Cloud Functions. `firebase/firestore.indexes.json`
and `firebase/*.rules` describe the same layout; when they disagree, the domain types win and the
other files are the bug.

Spec §7 lists 17 stores. Fourteen are top-level collections; the other three are subcollections
because they have no meaning outside their parent. `otpCodes` and `appConfig` are additions the
spec's security and configuration requirements imply but do not list; `driverDues` is the owner's
V2 rule that a driver pays before they work, which the original spec never covered.

## Conventions

| Rule | Why |
| --- | --- |
| Every timestamp field is named `*Ms` and typed `EpochMs` (a number) in the domain, and stored as a native Firestore `Timestamp` | Clients never import the SDK to read time; `serverTimestamp()` gives a trustworthy write-time clock and makes TTL eligible |
| Money is `MoneyPaise`, an integer count of paise | Float rupees drift; a fare dispute needs exact arithmetic |
| Statuses are explicit string unions from `packages/domain/src/enums.ts` | No magic integers in logs, rules or the admin UI |
| `createdAtMs` / `updatedAtMs` are server-owned | The rules reject any client write that touches them |
| References are ids, never denormalised copies of another document | A driver's name changes; a booking must not keep the old one |
| Documents a client may not write say `allow write: if false` | Cloud Functions use the Admin SDK, which bypasses rules, so this only restricts clients |

### Document ids

| Path | Id policy |
| --- | --- |
| `users/{uid}`, `customerProfiles/{uid}`, `driverProfiles/{uid}`, `users/{uid}/notifications/…`, `savedPlaces/{uid}/…` | The Firebase Auth uid — one document per person, so ownership is checkable from the path alone |
| `bookings/{bookingId}` | Server-generated; the human-facing `DRX-7K3QD2` string is `reference`, never the id |
| `bookings/{id}/events/{eventId}` | `<event_type>-<nonce>`; a replayed write collides instead of duplicating |
| `bookings/{id}/assignments/{assignmentId}` | Server-generated per offer attempt |
| `tripSummaries/{bookingId}` | Equal to the booking id — a 1:1 immutable receipt |
| `driverProfiles/{uid}/documents/{documentId}` | Must equal the last path segment of `storagePath`; the rules enforce `storagePath == 'drivers/' + userId + '/' + documentId`, so a client cannot point a metadata row at someone else's file |
| `driverProfiles/{uid}/dues/{dueId}` | **Deterministic** — `onboarding_fee` for the one-time charge, `commission_{bookingId}` for one trip's share. A retried trigger, a replayed event or an import of the same trip therefore collide on one document instead of billing twice |
| `otpCodes/{bookingId}_{purpose}` | Composite so exactly one live code exists per purpose per booking |
| `serviceTypes/{id}` | One of the five `ServiceTypeId` literals; three are `enabled: true` today — `chauffeur_own_car` (Local), `chauffeur_hourly` (Hourly) and `chauffeur_outstation` |
| `appConfig/{key}` | `public` (launch flags, readable by any signed-in user) and `dispatch` (admin only — ops is deliberately excluded, because tuning dispatch thresholds is a privileged change) |

## The 17 stores

| Spec store | Physical path | Written by | Readable by |
| --- | --- | --- | --- |
| users | `users/{uid}` | `provisionNewAccount` or `provisionSelf` (whichever provisions the account first), `setRole`, `registerDeviceToken` | self, staff |
| customerProfiles | `customerProfiles/{uid}` | self (create + limited update; `privacy.preciseLocationWhileIdle` is pinned to `false` by rule), functions for aggregates | self, staff |
| driverProfiles | `driverProfiles/{uid}` | self (create + limited update), `setDriverVerification` for approval, `flagDriverOnFirstUpload`/`flagDriverOnResubmission` for `pending_review` | self, staff |
| driverDocuments | `driverProfiles/{uid}/documents/{docId}` | self (`pending_review` only), `setDriverVerification` for the decision | self, staff |
| *(extra)* driverDues | `driverProfiles/{uid}/dues/{dueId}` | `ensureOnboardingDue` via `flagDriverOnFirstUpload`, `chargeCommissionDue` via the two `bookings/{id}` triggers, `recordDriverDuePayment` for the collection | self, staff — **no client write of any kind** |
| serviceTypes | `serviceTypes/{id}` | admin via functions | signed-in, if `enabled`, plus staff |
| pricingRules | `pricingRules/{id}` | admin via functions | admin only — clients get a signed estimate instead |
| bookings | `bookings/{id}` | functions only | customer, assigned driver, staff |
| driverAssignments | `bookings/{id}/assignments/{asId}` | functions only | the offered driver, staff |
| tripEvents | `bookings/{id}/events/{eventId}` | functions only | booking participants |
| tripSummaries | `tripSummaries/{bookingId}` | functions only, at completion | booking participants |
| payments | `payments/{id}` | functions + verified webhook | customer who owns it, staff — **declared, never written**: nothing has taken a fare in-app, and a settled driver due keeps its provider fields on the due row instead |
| refunds | `refunds/{id}` | functions | booking customer, staff |
| ratings | `ratings/{id}` — one per trip, id derived from the booking as `customer_{bookingId}`, so a second submit cannot make a second row | `rateTrip` only, in the same transaction that folds the driver's average and stamps the score on the booking | rater, rated party, staff — the rated driver lists their own rows on `ratedUid` newest-first, which is the composite index `firestore.indexes.json` declares for this collection |
| supportTickets | `supportTickets/{id}` | opener (create, replies) + staff | opener, staff |
| notifications | `users/{uid}/notifications/{nid}` | functions; client may only set `readAtMs` | recipient |
| savedPlaces | `savedPlaces/{uid}/places/{placeId}` | owner | owner — `list` capped at 20, and it needs its own `allow list`, because `allow read` would grant list too and Firestore ORs the two |
| adminAuditLogs | `adminAuditLogs/{id}` | functions only | admin |
| *(extra)* otpCodes | `otpCodes/{bookingId}_{purpose}` | functions only | **nobody** — not even staff, by rule |
| *(extra)* appConfig | `appConfig/{key}` | admin | `public`: signed-in; rest: admin |

`COLLECTIONS` and `SUBCOLLECTIONS` in `packages/domain/src/collections.ts` are the single source
for these names, so the rules, the seed and the clients cannot drift to different spellings.

## Booking record

Spec §7 requires each booking to carry, and `BookingRecord` provides:

- customer id → `customerUid`; assigned driver → `assignedDriverUid` (null until accepted)
- service type → `serviceTypeId`, plus the `zoneId` it was booked in
- pickup and destination → `pickup` / `destination` as `Place` (formatted address components
  **and** coordinates, with `source` recording whether Places, a map pin, a saved place or reverse
  geocoding produced it) — plus the resolved `pickupGeofence` / `destinationGeofence`
- scheduled time → `scheduledForMs` (null means "now")
- estimated fare and breakdown → `estimate` (a `FareBreakdown` with line items, subtotal, tax,
  total, `pricingRuleId`, `packageTierId` and `pricingSnapshotHash`); `finalFare` only after the
  server computes it — see Fare engine
- booking and payment status → `status`, `paymentStatus`
- trip start and completion → `tripStartedAtMs`, `completedAtMs`, with
  `arrivalConfirmedManually` / `completionConfirmedManually` flagging any fallback used
- cancellation → nested `cancellation` object: who, reason code and text, when, `feePaise`,
  `refundEligible`
- server-generated references → `reference`, `idempotencyKey`, `routeGeometryRef`

Two fields exist specifically to make client tampering useless: `stateVersion` (bumped by functions
on every transition) and `supportHold` (a human has taken over the booking).

Frequently changing position data is **not** on this document — see Realtime Database below.

### `driver`: the card the customer is shown

The owner's rule of 2026-10-27 is "jo driver assign hoga uski sab details aaegi… name kya hai
uska, number, sab kuch customer ke paas". A customer's phone cannot satisfy that by reading
`driverProfiles/{uid}` — that document also holds another person's Aadhaar pointer, their unpaid
dues, their home zone and whether they are currently online. So `publishDriverCardOnAssignment`
copies a **bounded** `AssignedDriverCard` onto the booking the customer may already read, and
`publishDriverCardOnImportedBooking` does the same for a booking that arrives already assigned.
Both fire on the document, so any route that puts a driver on a trip — today a script or an
operator, tomorrow dispatch — produces the same card.

The eleven fields that leave the profile: `uid`, `fullName`, `phoneE164`, `driverId`, `languages`,
`ratingAverage`, `ratingCount`, `lifetimeTrips`, `vehicle` (`make` / `model` / `plate`),
`photoPath` and `publishedAtMs`. What is deliberately withheld is equally part of the record:
document numbers, what the driver is owed, where they live, and any reachability after the trip
("DrivX shares these details with you for this trip only").

`photoPath` is a Storage **path** (`avatars/{uid}/profile.jpg`), never a download URL. A URL is a
bearer token with an expiry, and one person's token must not sit in a document other people read;
each viewer mints their own from their own session, and the rules decide then whether they may.
That is also why the face is a *second* copy of the driver's photograph — the office-reviewed file
at `drivers/{uid}/driver_photograph` is closed to everyone but the driver and staff, while
`avatars/{uid}/…` is the one object any signed-in user may read.

The copy re-fires the update trigger, which sees `card.uid === assignedDriverUid` and returns; that
is the whole loop guard. It also means a card published before the driver uploaded a photo keeps
`photoPath: null` until the booking moves again — the customer's card then shows initials rather
than a broken image, which is the fallback the screen is built for.

`npm run verify:trip-loop` asserts the card appears, carries the five columns the owner named,
carries *only* those eleven fields, is readable by the customer and by no other driver, and that
the same name, number and plate arrive in the customer's inbox as a `driver_assigned` message.

### Trip codes: `otpCodes/{bookingId}_{purpose}`

The owner's rule of 2026-10-27: *"otp ek bar generate hoga system generate karega booking id ke
against, hum bar bar new code generate ni kar sakte"*. The document id **is** the booking and the
stage, so one live code per purpose is a property of the schema rather than of a check somewhere:
`_trip_start` and `_trip_end`, written once by `tripCodes` and never rewritten by any code path in
this repository.

- `codeHash` is `sha256(bookingId | purpose | code)`, so a read of the store cannot hand over a
  usable code — which matters because verification goes through the Admin SDK and no client, staff
  included, is granted a read (`verify:trip-loop` proves the refusal for the booking's own customer
  and for the assigned driver).
- `expiresAtMs` is **`null` by design** ("uski koi time limit nai ho"). The code ends by being
  consumed, not by a clock. Wrong guesses are capped at `maxAttempts: 5`, and each refusal tells the
  driver how many are left.
- The digits are also stored in plaintext, because `tripCodes` has to answer them to the customer's
  screen and the same call is expected to return the same pair on a re-read. That is the one field on
  this document a compromise would leak, and it is why the store is closed to every client.
- Single-use is asserted across bookings: booking A's start code cannot close booking A's trip
  twice, nor open booking B.
- Nothing anywhere logs the digits. The customer's inbox message (`trip_codes`) says a code was
  issued; the `otp_sent` event records purpose and actor. The only place the six characters exist is
  the two screens that must show them.

## Status enums and the trip state machine

`BOOKING_STATUSES`: `requested → searching_driver → assigned → driver_en_route → driver_arrived →
trip_started → in_progress → destination_reached → completed`, with `cancelled`, `no_show` and
`expired` as terminal exits. Helpers `isActiveTrip`, `isTerminalBooking` and `isCancellable` are the
only places that decide membership, so a rule or function cannot invent a fourth interpretation.

**Only the customer cancels.** Every edge in `ALLOWED_TRANSITIONS` that ends in `cancelled` has
actor `customer`, and `CANCELLATION_BY` has no `driver` value at all: a chauffeur who cannot attend
releases the assignment (`assigned → searching_driver`, actor `driver`), which is a reassignment and
not an end to the booking. `cancelBooking` is therefore the single writer of the `cancellation`
object, and `packages/domain/tests/booking-state.test.ts` fails if any other actor gains the edge.
No fee is recorded — nothing is collected at booking, so there is nothing to forfeit, and whether a
late cancellation should cost anything is the owner's open decision rather than a gap in the engine.
The six `CANCELLATION_REASONS` codes are what the customer chooses between in the app's cancel sheet,
and the trip detail prints the stored one beside the timestamp and `by customer`; a double tap reads
back the original reason instead of overwriting it.

Other lifecycles: `VERIFICATION_STATUSES`, `ASSIGNMENT_STATUSES`, `PAYMENT_STATUSES`,
`REFUND_STATUSES`, `SUPPORT_TICKET_STATUSES`, `AVAILABILITY_STATES`, `ACCOUNT_STATUSES`.

### Trip events

`bookings/{id}/events/{eventId}` is the append-only history spec §6 requires. Twenty types, all
server-written and never mutated or deleted:

`booking_created`, `driver_offered`, `driver_assigned`, `driver_declined`, `reassigned`,
`driver_arrived`, `arrival_forced_manually`, `otp_sent`, `otp_verified`, `otp_failed`,
`trip_started`, `destination_detected`, `trip_completed`, `completion_forced_manually`,
`booking_cancelled`, `no_show_recorded`, `support_intervention`, `fare_finalised`,
`payment_captured`, `refund_issued`.

Each row records `fromStatus` / `toStatus`, the actor and role, the GPS `LocationSample` if one was
required, and the Cloud Function `requestId` so a log query can find the execution that wrote it.
The rules give clients no create, update or delete path on this collection.

## Fare engine

`packages/domain/src/pricing.ts` implements `computeFare()` — pure and synchronous, no clock, no I/O,
no randomness, so Cloud Functions and the test suite run the identical arithmetic. It exists because
`pricingRules/{id}` was previously a document nothing read: a rule row is only worth having if a
single deterministic function turns it plus the facts of a trip into the line items a customer sees.

**Three models**, chosen by `PricingRuleRecord.pricingModel`:

- `distance_slab` — a city or outstation one-way chart. `slabs[]` is a list of `{ upToKilometers, farePaise, sortOrder }`
  and **exactly one row applies**: the first ceiling the *quoted* distance reaches, so a 12 km trip is
  the ≤15 km band and never ₹179 + ₹229. That row is then **locked**: `computeMeteredFare` hands the
  engine the booking's `quotedDistanceMeters` next to the dial reading, so a bill can never be moved onto
  a bigger row than the price the customer confirmed — kilometres run past that ceiling are added at
  `slabOverflowPerKmPaise` (₹12 on the city chart), and a drive that comes back short still pays the band
  it was sold. That is the owner's rule of 2026-10-27: the set price is what is shown, and only extra
  distance is metered. Past the last ceiling the same rate continues; a rule with no overflow rate refuses
  the trip (`route_beyond_chart`) instead of inventing a number nobody approved. `perKmPaise` is `0` on
  such a rule, because a chart and a rate on the same document would be two answers to one question.
- `hourly_package` — a `packages[]` tier (fixed `packagePricePaise` covering `includedKilometers` and
  `hours`), then `extraKmPaise` above the included distance and `extraHourPaise` **pro-rated by the
  minute** above the package plus Admin-configured `overtimeGraceMinutes` (₹120/hr in the current proposal).
  `packages` is required on every rule (`[]` for a distance rule) so a tier can never be added to a rule
  that does not price them.
- `distance` — `baseFarePaise` + km × `perKmPaise` + minutes × `perMinutePaise`. The outstation one-way rule is a distance-slab chart through 500 km; route distance beyond the accepted quote is metered at ₹10/km. Outstation return trips use day packages through 11 days; longer durations are not offered by this seed.

`billableMetres()` rounds the measured distance to the rule's `distanceRounding`
(`one_decimal` → nearest 0.1 km, `next_whole_km` → up to the next whole km) **before** any fare line is
computed, in whole metres, so the band chosen, the overflow line, the receipt label and the rate card all
Current source catalogue keeps the prior local rate card: local one-way is ₹179/₹229/₹289/₹345/₹399/₹459/₹559 through 40 km, then ₹12/km; local hourly/round trip is ₹149 (1 h), ₹279 (2 h), ₹449 (4 h / 40 km), ₹799 (8 h / 80 km), and ₹1,099 (12 h / 120 km), with ₹10/km beyond the package distance and ₹120/hour overtime prorated by minute. Local round trips return to pickup. Local night remains a flat ₹150. The added outstation one-way chart is ₹1,270 through 100 km, ₹1,380 through 150 km, ₹1,666 through 200 km, ₹1,940 through 250 km, ₹2,167 through 300 km, ₹2,722 through 350 km, ₹3,000 through 400 km, ₹3,270 through 450 km, and ₹3,555 through 500 km; odometer distance beyond the accepted quote is ₹10/km. Outstation return packages are ₹1,333/₹2,555/₹3,777/₹4,999/₹6,221/₹7,443/₹8,665/₹9,887/₹11,109/₹12,331/₹13,554 for 1–11 days, with ₹100/hour overtime and ₹200 per eligible hour during the 22:00–06:00 night window. Tax defaults to zero until Admin configures a reviewed rate. Admin can edit the pricing rules; confirmed bookings retain their stored price snapshot.

**One way and round trip** is a property of the *service*, not the rule:
`ServiceTypeRecord.roundTripPricingRuleId` names the rule a round trip prices from, and the seed points
Local to its `hourly_package` rule, and Outstation to its day-package rule. The reason is the product: a chauffeur who
drives you to Sector 56 and back is committed for the hours, not for the kilometres. `quoteFare` and
`createBooking` both take `tripDirection` and resolve the rule through it — `'one_way'` is the schema
default, so a client built before the field existed keeps being priced as a drop-off — and
`bookingOptions` answers with `roundTripTiers`, read from that second rule. `null` means the service has
no round-trip price, which is when the composer hides the switch rather than offering a booking the
engine would refuse; asking for a round trip anyway is a `failed-precondition` naming the round trip,
never a silent per-km price. The direction is written on the booking and echoed back by a replay.

**Order of operation**, which is what makes a receipt auditable:
core (slab band or package, plus overflow distance, duration, waiting) → night surcharge → surge →
minimum-fare top-up → platform fee → configured tax. The night surcharge has its own `mode`: `flat` adds
`flatPaise` once to any trip that starts inside `fromHour`→`toHour` (the ₹150 the owner asked for),
`percent` adds `rate` of the core fare; `enabled: false` adds nothing. Night and surge are each computed
off the core fare and **never compounded on one another**. The platform fee is charged on
`max(core, minimumFare)` so flooring a fare cannot silently inflate the commission; it is `0` on every
seeded rule, because the platform's take is the per-trip commission, not a line on the customer's bill.
Every component is rounded once, half-up, and
`subtotalPaise` is the **sum of the rounded items** rather than a rounded sum, so
`subtotalPaise === Σ items.amountPaise` and `totalPaise === subtotalPaise + taxPaise` hold by
construction — a customer can add up their own receipt. `expiresAtMs` is set only for
`kind: 'estimate'`; a final fare does not expire.

**Refusals.** `computeFare` throws `FareError` with one of `rule_inactive` (flag off, or outside the
effective window, which is half-open at `effectiveUntilMs`, or not INR), `zone_mismatch`,
`invalid_input` (NaN, negative, `localStartHour` outside 0–23, surge below 1), `tier_required`,
`tier_unknown`, `tier_not_allowed`, `surge_out_of_range`, `slabs_empty` (a chart rule with no rows),
`route_beyond_chart` (a route past the last ceiling with no overflow rate). It never clamps a bad input
into a plausible number — a booking with an unusable rule fails loudly rather than pricing itself.

**Tamper evidence.** `canonicalFareSnapshot()` (`v3`) serialises every field that affects the paise —
including `distanceRounding`, the sorted slab chart, `slabOverflowPerKmPaise` and the night mode with its
flat amount — and the caller supplies a `SnapshotHasher`. The hasher is injected rather than imported
because this module also bundles into React Native, where `node:crypto` does not exist; the functions
deploy passes `crypto.createHash`. The resulting `pricingSnapshotHash` is stored on the `FareBreakdown`,
so a later edit to the rule cannot retroactively change what a booked estimate claimed. A night window
that wraps midnight (`fromHour > toHour`) is handled as ≥ from OR < to, so 22:00→06:00 is one window, not
an impossible one.

Worked examples under the current source configuration (fare tax defaults to 0; an Admin can change it):

| trip | line items | subtotal | configured tax | total |
| --- | --- | --- | --- | --- |
| 21.4 km quoted, then driven 22.1 km in daylight | ₹399 slab through 25 km; actual distance remains within that quote band | ₹399 | ₹0 | **₹399** |
| 13.2 km quoted, dial runs 35 km | ₹289 slab through 15 km + 20 km overflow × ₹12 | ₹529 | ₹0 | **₹529** |
| 8 h package used 11 h / 142.3 km | ₹799 package + 62.3 km × ₹10 + 180 min × ₹2 | ₹1,782 | ₹0 | **₹1,782** |

**What is true on a live path.** `createBooking` prices on the server and writes the result, and when configured it uses Google Routes road distance. These numbers have not been verified against production Firestore in this checkout. Existing quotes and confirmed bookings retain their stored price snapshot when the Admin later edits a rule. Production data remains unchanged until the current Functions/Admin source is deployed and an authorized Admin saves the approved test configuration.

One encoder setting matters for every write above: `functions/src/lib/admin.ts` calls
`db().settings({ ignoreUndefinedProperties: true })` on the cached Firestore instance. A zod schema
turns an optional field the client sent as `null` into a key whose value is `undefined`, and the
Firestore encoder throws on that rather than skipping the field — which surfaced as an opaque
`INTERNAL` 500 from `createBooking` for any place with no second address line. With the setting on, an
absent field stays absent, and a booking written from a place that has `addressLine2` keeps it while a
place without it simply has no such key.

## Driver dues: two charges, one hold, and the id approval issues

The driver clears a one-time ₹500 + 5% GST onboarding fee (₹525 default) and the Admin verifies the documents before the driver can work. The fee is editable by Admin. After completed trips the platform takes the configured 13% commission by default; any tax on the fare or commission is an Admin setting and defaults to zero. Cashfree settles driver dues through a signed webhook:

- **The fee** is `driverProfiles/{uid}/dues/onboarding_fee` — ₹500 base (`50_000` paise), 5% GST (`2_500` paise), and ₹525 total by default; the amount is in `ONBOARDING_FEE` in
  `packages/domain/src/records-identity.ts` so the app, the admin console and the trigger cannot
  quote different figures. The document id is deterministic, so a retried trigger re-uses the row
  instead of billing the driver twice.
- **The commission** is `driverProfiles/{uid}/dues/commission_{bookingId}` — one row per *completed*
  trip, the office's rate of the booking's own `subtotalPaise` plus an Admin-configured tax on that share; all four
  numbers are produced by `commissionDueFor` in the same domain module the fare engine lives in
  (`COMMISSION_TERMS` holds the default 0.13 / 0 tax pair, and the 37 cases in
  `packages/domain/tests/dues.test.ts` pin the arithmetic). The rate a trip is billed at is the one
  written on the booking as its `commission` block when `createBooking` quoted it; only a booking
  older than that block reads `appConfig/commission` at billing time, and a stored rate that is not
  a fraction of a fare (absent, negative, above 1) falls back to the default instead of billing it.
  The amount is read off the fare the server already wrote; no client figure reaches the ledger.
- **The booking's `commission` block is re-pinned when the trip closes.** At quote time it prices the
  fare the map promised; `confirmCompletion` overwrites it with the terms derived from `finalFare`,
  keeping the rate and moving the base. This is not cosmetic: the driver's Earnings splits each trip
  from the booking's own block (`driverTripSplitFor`), while the ledger derives from the metered
  receipt, so without the re-pin one booking says two things — a 13 km quote driven as 35 km billed
  ₹72.21 in the ledger while the driver's list showed ₹39.45 for the same trip. `verify:trip-loop`
  now asserts `bookings/{id}.commission` equals the due row's `totalPaise` and `commissionablePaise`,
  and the driver's Duty and Earnings panels agree to the paisa on the trip it just closed.
- **Who writes them.** `ensureOnboardingDue` runs inside `flagDriverOnFirstUpload` — filing paperwork
  is what charges — and `chargeCommissionDue` runs from two `bookings/{id}` Firestore triggers:
  `chargeCommissionOnCompletion` on the update that first sets `status: 'completed'`, and
  `chargeCommissionOnImportedTrip` on a booking that *arrives* completed (the seed's finished trips,
  an office backfill, a data import). Watching the document rather than a callable is deliberate:
  `confirmCompletion` will finish trips once the lifecycle lands, an operator can re-close a stuck one
  today, and a trip written finished by an import has no callable at all. Both use `create`, not `set`
  — two triggers racing the same booking cannot rewrite an already-paid row back to unpaid. The rules
  give the subcollection `allow read` for the owning driver and staff and
  `create, update, delete: if false` for everyone else, so neither the driver nor an administrator's
  client can clear, shrink or delete a row. Only the Admin SDK can change one.
- **The base is the fare the driver actually took**: `subtotalPaise` minus every line in
  `NON_COMMISSIONABLE_FARE_LINES` (`platform_fee` — the office's own charge, so commissioning it
  would take a share of a share; `cancellation_fee` — nobody drove), then the Admin-configured tax on that share. The
  customer's tax is out of the commission base by construction, because `totalPaise === subtotalPaise + taxPaise`.
  Tolls, parking and tips have no line in a breakdown at all: the customer hands those over on the
  spot, so they are outside the fare and therefore outside the base. On a ₹960.00 subtotal the default 13%
  commission is ₹124.80 before any separately configured tax on commission. The commission is derived
  from the pre-tax subtotal rather than from a tax-inclusive total, so changing fare tax cannot change
  the commission base.
  `verify:driver-dues` asserts `basePaise` (₹124.80) and the ₹910.00 base under a ₹50.00 platform
  fee, not only the total.
- **Status is binary** (`unpaid | paid`). There is no partial payment, and `method`, `reference`,
  `recordedByUid` and `recordedAtMs` stay null until a collection is actually recorded.
- **The collection** is `recordDriverDuePayment`, admin-only, attesting money physically handed over
  as **cash or UPI** (`ATTESTABLE_DUE_METHODS`) with a reference of at least three characters. Card,
  netbanking and wallet are deliberately absent: those would imply a gateway. The call writes an
  `adminAuditLogs` row with `action: 'driver_fee_recorded'` and refuses a second collection of the
  same row with `failed-precondition`. The `/dues` console groups a driver's rows behind one button
  ("Record ₹337.15 · 3 charges", on today’s seeded ledger) but records each row separately, and a commission row keeps its
  `bookingId` so a cleared trip can never be billed again by a later event.
- **The hold.** `assertNoOutstandingDues` runs on the two calls that put a driver in front of a
  customer — `respondToAssignment` (accept *and* decline, so nobody sits on a queue they cannot work)
  and `setAvailability` when the state is **`online`** — and on `setDriverVerification` when the
  decision is `approved`. It is deliberately absent from `publishDriverLocation` and from going
  `offline`: a driver with a customer in the car is never cut off over money, and stopping work must
  always be allowed. `describeOutstanding` names the kinds rather than only the sum, because
  "₹172.67 of trip commission (2 trips) is uncleared on this account. New bookings are held until the
  office records it." is collectable at a counter and a bare total is not. Rejection is *not* gated:
  sending paperwork back costs the driver nothing.
- **A staff list read needs its own rule.** The console's "who owes what" page is a
  `collectionGroup('dues')` query, and Firestore evaluates that against
  `match /{path=**}/dues/{dueId}` alone — not the per-profile rules above. Without the staff-only
  grant the query is refused *wholesale*, which surfaces as an empty page rather than a permission
  error; that rule is one of the 54 Firestore cases.
- **`driverId`** appears on `driverProfiles/{uid}` only at approval: `DRV-` plus six characters from
  `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, so it survives being read aloud over the phone (no O/0, I/1).
  Uniqueness is checked by query before minting, and a re-approval keeps the existing id rather than
  issuing a second one. The rules list `driverId` among the fields a driver may not write, so nobody
  can mint their own.

What is *not* here: no payment has ever been taken in the app. `createPaymentOrder` answers
`unavailable` while `CASHFREE_APP_ID` / `CASHFREE_SECRET_KEY` are unset, and `paymentWebhook` answers
`503`, so neither can settle a row; both proof scripts assert exactly that —
`npm run verify:driver-onboarding` (36 checks) at the end of an otherwise successful onboarding run,
`npm run verify:driver-dues` (38 checks) after clearing two commission rows and confirming the hold
lifts. `npm run verify:payments` (14 checks) covers the gateway seam itself: the order amount always
comes from the stored due, and a webhook that is tampered with, replayed, signed with another secret
or unsigned is refused before it touches the ledger. A settled row would keep its own
`providerOrderId`, `provider` (`cashfree`) and `settledBy: 'cashfree'` beside the office path's
`recordedByUid`, so the two ways a due clears stay distinguishable — no `payments/{id}` document is
written, and that collection stays as designed for the day a customer pays a fare in-app.

## Indexes

`firebase/firestore.indexes.json` declares **28 composite indexes**. They exist for the queries the
apps will actually run, and each is one of three shapes:

| Shape | Example | Serves |
| --- | --- | --- |
| Ownership + recency | `customerUid ASC, createdAtMs DESC` (bookings) | "my trips", newest first |
| Dispatch queue | `status ASC, scheduledForMs ASC`; `zoneId, availabilityState, verificationStatus` (driverProfiles) | the dispatcher's candidate search |
| Ops reporting | `status ASC, priority ASC, updatedAtMs DESC` (supportTickets); `targetType, targetId, atMs DESC` (adminAuditLogs) | staff queues and audit lookup |

Deliberately absent: any index that would make a *global* scan of bookings or driver locations
cheap. A query that lists every booking is not something a customer should be able to issue, and
indexing it would make the abuse cheap as well as impossible.

Collection-group indexes (`assignments`, `events`, `documents`, `places`) are used
because those stores live under a parent the caller does not know in advance — dispatch needs every
pending offer across all bookings, not offers for one booking. Notifications are the opposite case:
a client only ever opens its own inbox, so that index is collection-scoped.

### TTL

Two `fieldOverrides` mark `expiresAtMs` as the TTL field on `otpCodes` and `notifications`. Firestore
deletes those documents itself once the timestamp passes, which is why the sweeper function does not
duplicate the work. TTL requires the field to be a `Timestamp`, which is exactly what the `*Ms`
write convention produces.

## Realtime Database

Live location changes many times a minute. Keeping it out of Firestore avoids both a write-cost
problem and a rule-evaluation problem (a Firestore read of a booking to decide a location write
would cost a document read every single time).

| Path | Shape | Purpose |
| --- | --- | --- |
| `driverLocations/{driverUid}` | `RtdbDriverLocation` | the driver's current fix, while they hold an accepted assignment |
| `activeBookings/{bookingId}` | `RtdbActiveBooking` | the tracking stream the customer and ops subscribe to |
| `presence/{driverUid}` | `RtdbPresence` | dispatch eligibility, not a location |
| `dispatchGrid/{zoneId}/{driverUid}` | `RtdbDispatchCell` | coarse ~1 km cell, staff-readable only |
| `authz/{bookingId}` | `BookingAuthzMirror` | the access mirror described below |
| `connections/{uid}` | heartbeat | onDisconnect cleanup, self-read/write |

### The authorization mirror

RTDB rules cannot read Firestore, but a rule expression **can** traverse `root` without itself being
subject to rules. So Cloud Functions mirror the minimum facts needed to authorize a location read
into `authz/{bookingId}`:

```json
{
  "bookingId": "bk-1",
  "customerUid": "…",
  "driverUid": "…",
  "sharedWith": { "<emergency-contact-uid>": true },
  "trackingEnabled": true,
  "expiresAtMs": 0
}
```

`sharedWith` is a `uid → true` map rather than an array because the rule tests membership with
`child('sharedWith').child(auth.uid).exists()`, which RTDB cannot do against a list. Operations
staff get visibility from the `ops` claim instead, so a temporary grant never needs a write here.
The clients have **no** read or write access to `authz` — the tests in
`packages/rules-tests/src/database.test.ts` assert that.

### Rules that make location safe

- A driver may only write `driverLocations/{their own uid}`, and only while `authz` says they are
  the assigned driver **and** `trackingEnabled == true`.
- `.validate` on `lat`, `lng`, `accuracyMeters`, `fixTimeMs` and `receivedAtMs` bounds what a
  compromised client can publish: a coordinate out of range, or a fix stamped 15 minutes ago, is
  rejected as a permission failure.
- Reads are granted to the assigned driver, the booking's customer, uids in `sharedWith`, and staff
  — and only while `trackingEnabled` is true, so a completed trip stops being traceable.
- `activeBookings` and `dispatchGrid` are write-protected entirely (`".write": false`); only
  functions produce them. `dispatchGrid` carries its read rule at the `$zoneId` **and** `$driverUid`
  levels, because a rule defined only on the child does not authorize a read of the parent.

### Retention and cleanup

`RTDB_RETENTION` in `packages/domain/src/realtime.ts` is the single set of numbers:

| Value | Meaning |
| --- | --- |
| `staleAfterMs: 20_000` | older than this, the client renders "position is stale" instead of a live pin |
| `activeBookingsTtlMs: 6h` | a node this old is deleted regardless of state |
| `presenceTtlMs: 24h` | an offline driver should not hold a presence row |
| `publishIntervalMovingMs: 3s` / `IdleMs: 15s` | write cadence, the cost lever |
| `minMoveMeters: 15` | a same-place write is suppressed rather than published |

`sweepStaleLocationData` (functions, every 15 minutes) queries `activeBookings` by `expiresAtMs`,
`driverLocations` by `receivedAtMs` and `presence` by `updatedAtMs`, removes what it finds (500 per
pass, per index) and sets `authz/{bookingId}/trackingEnabled = false` alongside each expired
booking. That function is what bounds any leak from a crashed app or a killed background process.

## Cloud Storage

| Path | Contents | Access |
| --- | --- | --- |
| `drivers/{uid}/{documentId}` | Aadhaar, driving licence and the driver's own photograph — the only three kinds the app accepts | owner + staff; never public, never listable by another user |
| `avatars/{uid}/{file}` | profile photograph shown to the counterparty | any signed-in read, owner write |
| `trip-traces/{bookingId}/{file}` | recorded GPS trace for disputes | staff read; **no client write path, not even staff** |

Uploads are capped at 8 MB and restricted to `image/*` or `application/pdf`, with an explicit
refusal of `text/html` and `application/javascript` so an object can never be served as executable
content.

`verificationStatus == 'pending_review'` on `driverProfiles` is a **server-written fact**: the driver
cannot write that column, so `flagDriverOnFirstUpload` sets it the moment their first document is
filed and `flagDriverOnResubmission` re-files a rejected one. It has to work that way because a
collection-group read of `driverProfiles/*/documents/*` is a `list` no rule grants, so "who is
awaiting review" can only come from a field on the profile the queue can query. The name each
document type is shown under lives in `DOCUMENT_LABELS` (`packages/domain/src/enums.ts`) rather than
in either screen, so the driver's checklist and the reviewer's queue cannot describe the same file
differently.

## Retention and deletion, by data class

| Data | Retention | Mechanism | Status |
| --- | --- | --- | --- |
| Sign-in OTP codes | `OTP_TTL_SECONDS` (5 min default) | Firestore TTL | Implemented |
| Trip start/end codes | while the booking lives, then TTL | `expiresAtMs: null`, so nothing expires them; they end by being **consumed** | Implemented — deliberate, see Trip codes |
| Notifications | `expiresAtMs` | Firestore TTL | Implemented |
| Live location, presence, active bookings | 20 s stale / 24 h / 6 h | sweeper function | Deployed, never observed running |
| Trip events, bookings, trip summaries, payments, refunds, audit logs | financial-records period | none yet | **Gap** — needs a written policy decision |
| Driver documents and avatars | while the account is active | none yet | **Gap** — the account-deletion flow (spec §3) is not built, so `deletionScheduledAtMs` on `users` is currently only a field |
| Trip traces | dispute window | none yet | **Gap** — Storage has no scheduled purge |

## Cab booking, kept as a seam

Spec §12 asks for reusable interfaces without claiming a fleet is legal to operate:

- `ServiceTypeRecord.vehicleOwnership` is `own_car | fleet | operator`, and `supportsCabFleet`,
  `requiresVerifiedDriver` and `enabled` are separate flags — `cab_standard` and `cab_premium`
  already exist as documents with `enabled: false`, so enabling them is a data change plus the
  pricing and dispatch work, not a schema migration.
- `DriverProfileRecord.vehicleMake`/`vehicleModel`/`vehiclePlate` are the three free-text fields the
  customer's driver card is built from. They exist because "Safar aapka, driver hamara" means the car
  is the customer's, so a car is not a legal document to file — but a number plate is still how a
  customer finds their driver in a crowd. The driver writes them himself from his own Account screen
  (`apps/mobile/src/features/driver/profile.ts` → `useUpdateDriverProfile`), which sends `fullName`,
  the three car fields and `languages` and nothing else; `firestore.rules` lets exactly that through,
  because none of those five names is on the profile's `untouched([...])` list, and refuses the same
  write the moment it also stamps `updatedAtMs` or moves `driverId`. The office console has no field
  for the car yet, and the card is a snapshot taken when a driver is assigned, so an edit appears on
  the next trip rather than the one in hand. There is no `vehicles` or `operator` collection, and that
  is deliberate: adding them is additive, and inventing them before the licensing review would be
  designing for a requirement we do not have.
- `PricingRuleRecord` is per service type and zone, so a cab fare model is a new rule row.
- `DispatchStrategy` in `packages/domain/src/ports.ts` is the interface a fleet dispatcher would
  implement alongside the chauffeur one.
