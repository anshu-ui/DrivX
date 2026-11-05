# Google Maps setup

**Status: the fare measures real roads; nothing draws a map.** `functions/src/lib/routes.ts` calls
the Routes API for every quote and every completed booking, and `GOOGLE_ROUTES_API_KEY` in
`functions/.env` is what makes it happen — without a key the same code prices off a straight line and
labels it `haversine_fallback`. Still unwired: the `MapsProvider` seam in
`packages/domain/src/ports.ts`, Places autocomplete, and every map surface — no Maps SDK, no
JavaScript API loader, no route polyline on a screen. `NEXT_PUBLIC_GOOGLE_MAPS_WEB_API_KEY` reaches a
bundle only for the admin dashboard, and only once Phase 5 puts a live map there.

One key currently serves both server roles, which §2 asks for as two so a Routes cost spike and a
Places cost spike stay separately attributable. Split it when a second key exists.

## 1. One Google Cloud project, APIs enabled

Use the same GCP project that hosts Firebase. Enable **only** what DrivX will call, because every
enabled API is a place a leaked key can spend money:

| API | Used for | Phase |
| --- | --- | --- |
| Maps SDK for iOS | customer map, driver map | 2 |
| Maps SDK for Android | customer map, driver map | 2 |
| Maps JavaScript API | admin live-operations map | 5 |
| Places API (New) | address autocomplete, place details | 2 |
| Geocoding API | map-pin → address, saved-place cleanup | 2 |
| Routes API (New) | distance, duration, ETA, polyline for fares | 2, 3 |
| Matrix API (Routes) | candidate-driver ranking during dispatch | 3 |
| Maps Elevation API | not used — do not enable | — |

## 2. Keys: one per surface, each restricted

A single key reused everywhere means one leak costs you on every API. Create these five keys and
apply **both** restriction columns; no exceptions, and never a server key in a client.

| Key | Lives in | API restriction | Additional restriction |
| --- | --- | --- | --- |
| `MF_IOS_SDK` | `apps/mobile/ios/` native config (via `app.json` `ios.config.googleMapsApiKey`) | Maps SDK for iOS | Bundle ID = `in.drivx.app` |
| `MF_ANDROID_SDK` | `apps/mobile/android/app/` (manifest meta-data) | Maps SDK for Android | Android app + SHA-1/SHA-256 certificate fingerprint |
| `MF_WEB_JS` | `apps/admin/.env.local` as `NEXT_PUBLIC_GOOGLE_MAPS_WEB_API_KEY` | Maps JavaScript API | HTTP referrer = the dashboard origin only |
| `MF_PLACES_SERVER` | `functions/.env` → `GOOGLE_MAPS_SERVER_API_KEY` | Places API (New), Geocoding API | Cloud Functions egress IPs (or leave open and rely on the API restriction plus the request budget below) |
| `MF_ROUTES_SERVER` | `functions/.env` → `GOOGLE_ROUTES_API_KEY` | Routes API, Matrix API | as above |

Why two server keys: Places/Geocoding and Routes bill on different SKU families at very different
unit prices, and separating them makes a cost spike attributable in seconds instead of after
the fact.

The native SDK keys are per-platform and app-restricted, so they are safe to ship inside a signed
binary. They must **not** be added to any `EXPO_PUBLIC_*` variable — that would put them in a JS
bundle that can be read off the device, and a key with no platform restriction is a key anyone can
use.

## 3. Which product does which job

- **Autocomplete (Places New)** — `places.googleapis.com/v1/autocomplete`, sent with a *session
  token* opened when the customer starts typing and closed when they pick a result. Session tokens
  are what stop a five-keystroke search being billed as five separate requests. Bias the query with
  the customer's `defaultPickup` and the service type's `pickupGeofence`, so a Gurugram account is
  not offered Connaught Place first.
- **Place Details** — request the smallest field mask that fills `Place`:
  `id, displayName, formattedAddress, addressComponents, location, types`. With Places API (New) the
  **SKU tier depends on which fields you ask for**, so an unbounded `fields=*` is both slower and
  more expensive than the mask above.
- **Geocoding** — reverse geocode only when the customer drops a pin instead of searching
  (`Place.source = 'map_pin'` → `'reverse_geocode'`), and cache the result on the saved place.
- **Routes API (New)** — `routes.googleapis.com/directions/v2:computeRoutes` with
  `travelMode: DRIVE`, `computeAlternativeRoutes: false`, `languageCode: en-IN`, `regionCode: IN`, and
  the field mask narrowed to `routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline`.
  Two things Google rejects with a 400 that the fallback used to swallow:
  **`routingPreference` has no `LEAST_TIME`** — the only real values are `TRAFFIC_AWARE` and
  `TRAFFIC_AWARE_OPTIMAL` — and **both need a `departureTime` in the future**, so a "right away"
  booking stamped with the server's own clock is already stale by the time the request lands.
  `measureRoute` therefore sends neither for immediate trips and lets Google route on live traffic,
  and it only adds `TRAFFIC_AWARE` when the departure is more than two minutes out. Use
  `TRAFFIC_AWARE_OPTIMAL` for the final fare if at all; it is the slower, pricier variant. Store the
  polyline by reference (`booking.routeGeometryRef`), never inside the booking document.
- **Matrix** — one `computeRouteMatrices` call for a batch of candidate drivers, not N route calls.
  This is the single biggest dispatch cost lever; a naive per-driver route loop multiplies the
  request count by the number of online drivers, every booking.
- **Directions API (legacy)** — deprecated for new projects; do not enable it.
- **Map styling** — when the map lands in Phase 2 it draws from the Emerald Slate tokens, not from a
  Google-hosted style someone picked: pickup marker `#047857`, destination `#0F172A`, driver a third
  distinct colour, on the default light basemap. No gold, no neon, no dark basemap by default. The
  hexes live in `@drivx/design-tokens` (see [design-system.md](design-system.md#6-accessibility-behaviour)),
  so the map cannot drift from the rest of the app.

## 4. Geofencing, arrival and the accuracy rule

Spec §4 and §6 require arrival and completion to be assisted by geofences but never decided by GPS
alone. The data model carries the knobs, and the Maps layer only supplies coordinates:

- `serviceTypes/{id}.pickupGeofence` and `destinationGeofence` (center + radius, per service).
- `maxArrivalAccuracyMeters` — a fix worse than this is not evidence of anything. Typical Indian
  urban GPS in a basement parking level is 30–100 m, so this must be tuned per zone in Phase 4,
  not guessed now.
- `arrivalConsecutiveSamples` — the entry only counts after N sustained readings inside the fence,
  which is what prevents a single multipath bounce from marking a driver as arrived.
- `LocationSample` carries `accuracyMeters`, `speedMps`, `headingDegrees`, `provider` and
  `isStale`; the RTDB `.validate` rules reject out-of-range accuracy and coordinates, so a
  compromised client cannot publish a fake position even if it gets past the function.
- `bookings.arrivalConfirmedManually` / `completionConfirmedManually` record every fallback, and
  `tripEvents` writes `arrival_forced_manually` / `completion_forced_manually` with the reason.
- **Trip start is OTP-protected regardless of position.** `tripCodes` / `verifyTripOtp` are live:
  `npm run verify:trip-loop` runs them through the Functions emulator and both apps start and close
  trips on the codes alone. No position, geofence or map read can start a trip — which is also why
  the live map surface (#108) is still the missing half rather than a missing authority.

Geofence evaluation happens in the app and in Cloud Functions with plain circle math on the stored
centres and radii — no external geofence service, no per-check billing.

## 5. Cost and abuse controls

| Control | Where | Notes |
| --- | --- | --- |
| `MAPS_DAILY_REQUEST_LIMIT` (20 000 default) | functions | a counter in the functions layer that stops returning quotes once exceeded; protects against a runaway client, not against your own traffic spike |
| `MAPS_ESTIMATE_CACHE_MINUTES` (5) | functions | identical origin/destination within the window reuse one route result — the same TTL as `PricingRuleRecord.estimateValidityMinutes` |
| Quota caps in the GCP console | per API | set hard per-minute caps on Routes, Places and Matrix; the SDK defaults are generous enough to be a liability |
| Budget alert + export to BigQuery | GCP billing | alert at 50 / 80 / 100 % of a stated monthly ceiling |
| Session tokens, minimal field masks, batch matrices | the code that uses the seam | the three levers that actually move the bill |
| Key restrictions (§2) | GCP credentials | the only control that also works after a key leaks |

## 6. Failure behaviour the app must implement

Spec §11 requires timeouts and fallbacks for mapping services, and the domain already encodes the
honest version:

- `EtaEstimate.source` is `google_routes | haversine_fallback | unavailable`, and `minutes` may be
  `null`. **A null ETA is a real UI state**, rendered as "position may be delayed", never as an
  invented number.
- `RouteResult.approximate` is true when the value is straight-line, so a fare is never quoted from
  an approximation without saying so.
- `TripSummaryRecord.distanceSource` records which authority produced the billed distance:
  `google_routes_actual`, `gps_trace`, or `unavailable` (in which case `distanceMeters` is null and
  the fare must come from a rule-based fallback agreed by a human).
- Every Maps call needs a deadline, one retry with jitter, and a circuit that degrades to
  `haversine_fallback` rather than hanging the booking screen.
- Structured logs may record request ids, SKU names, latencies and result counts. They must not
  record coordinates, full addresses or driver identifiers for a person the operator is not
  investigating — spec §11 asks for privacy-conscious server logs, and a lat/lng in a log line is
  someone's home.

## 7. What still has to be built

1. Phase 2 — `MapsProvider` implementation (server-side proxy, so the mobile app never holds a
   Places key), autocomplete session flow, pin-drop reverse geocoding, and the route-backed estimate
   feeding the fare engine.
2. Phase 3 — driver-to-pickup ETA streaming, `computeRouteMatrices` dispatch ranking, and the
   polyline the customer sees while tracking.
3. Phase 4 — geofence thresholds tuned against real device traces, including the low-accuracy cases.
4. Phase 5 — `MF_WEB_JS` on the admin live map, behind server-verified staff claims.

Until item 1 exists, no Maps request is issued, no key is configured, and no Maps cost is incurred.
