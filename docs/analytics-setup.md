# DrivX Analytics

Firebase Console shows an existing DrivX GA4 web Measurement ID: `G-5G5MVS6WR9`.
The DrivX marketing site and both web apps use that same property/stream. Reports
can distinguish them using the sanitized page paths:

- Marketing site: `/`
- Customer web app: `/customer/<screen>`
- Driver web app: `/driver/<screen>`

The ID is already configured in `public-site/analytics-config.js` and is the
fallback for Customer and Driver web builds in `apps/mobile/src/lib/analytics.ts`.
The optional `.env` overrides can be used if separate web streams are created
later, but are not required for the current stream.

## Native apps

Firebase has separate Android and iOS registrations for `in.drivx.customer` and
`in.drivx.driver`. The Expo config includes `@react-native-firebase/analytics`;
native screen events use names such as `customer_trips` and `driver_earnings`.
Firebase Analytics associates those events with the native Firebase app, so the
Customer and Driver apps can be compared separately from web traffic. A new
Android/iOS build is required to include a newly added native Analytics SDK.

## Privacy

Web page views use a fixed, sanitized route; native events use a normalized
screen name. No DrivX user ID, phone, email, booking ID, fare, address, or precise
location is sent. Google Analytics may collect broad device and usage metadata;
keep the privacy policy and consent behavior appropriate for DrivX's regions.

## Viewing traffic

In Google Analytics, use Reports → Realtime to confirm a deployment, then use
Reports or Explorations with `Page path and screen class` / `Screen name` to
separate `/customer/` and `/driver/` web views from `/`. Use platform/app filters
to compare native apps. Firebase Console → Analytics can also show app activity.
