import { straightLineMeters, type GeoPointLite, type RouteSource } from '@drivx/domain';

/**
 * Distance and drive time between two pins.
 *
 * Two authorities, and the code never conflates them. With a Routes key the
 * number is a road distance; without one it is a straight line, which is a
 * *floor* on the real distance and must be labelled as such wherever a customer
 * reads it. The fallback exists because a booking screen that hangs on a missing
 * key is worse than one that prices honestly and says how.
 *
 * The key is `GOOGLE_ROUTES_API_KEY` in `functions/.env` (see
 * `docs/google-maps.md` §2). It is never sent to a device.
 */

const ROUTES_ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const ROUTES_TIMEOUT_MS = 4000;
const FIELD_MASK = 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline';

/**
 * A "right away" quote stamps the departure with the server's own clock, which is
 * already in the past by the time Google reads it, and a past `departureTime` is a
 * 400. Departures closer than this are treated as immediate: no timestamp, live
 * traffic. Two minutes is comfortably above the request's own round trip.
 */
const IMMEDIATE_WINDOW_MS = 120_000;

export type RouteMeasurement = {
  distanceMeters: number;
  /** Null when nobody measured a drive time — the UI must not invent minutes. */
  durationSeconds: number | null;
  source: RouteSource;
  /** Road geometry returned by Routes API; absent when only a straight-line estimate is available. */
  encodedPolyline: string | null;
};

export function routingIsConfigured(): boolean {
  return Boolean(process.env.GOOGLE_ROUTES_API_KEY?.trim());
}

function straightLine(origin: GeoPointLite, destination: GeoPointLite): RouteMeasurement {
  return {
    distanceMeters: straightLineMeters(origin, destination),
    durationSeconds: null,
    source: 'haversine_fallback',
    encodedPolyline: null,
  };
}

/** Routes answers with a protobuf `Duration` like `"2530s"`. */
function parseDurationSeconds(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const seconds = Number.parseFloat(value.replace(/s$/, ''));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : null;
}

function point(geo: GeoPointLite) {
  return { location: { latLng: { latitude: geo.lat, longitude: geo.lng } } };
}

/**
 * Why a non-2xx happened, from Google's error body.
 *
 * The fallback log is the only trace of a failed measurement, and "HTTP 400" on
 * its own names neither the field nor the fix — the request stays broken until
 * somebody replays it by hand.
 */
async function describeError(response: Response): Promise<string> {
  const detail = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return `HTTP ${response.status}${detail?.error?.message ? ` — ${detail.error.message}` : ''}`;
}

/**
 * Road distance when a key is configured, straight-line otherwise.
 *
 * A failed Routes call degrades rather than failing the booking: the customer
 * still gets a quote, and `source` records that it came off a straight line so
 * the fare audit can tell the two apart.
 */
export async function measureRoute(
  origin: GeoPointLite,
  destination: GeoPointLite,
  departAtMs: number | null,
): Promise<RouteMeasurement> {
  const key = process.env.GOOGLE_ROUTES_API_KEY?.trim();
  if (origin.lat === destination.lat && origin.lng === destination.lng) {
    return { distanceMeters: 0, durationSeconds: 0, source: key ? 'google_routes' : 'haversine_fallback', encodedPolyline: null };
  }
  if (!key) return straightLine(origin, destination);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUTES_TIMEOUT_MS);
  const scheduled =
    departAtMs !== null && departAtMs - Date.now() > IMMEDIATE_WINDOW_MS
      ? {
          routingPreference: 'TRAFFIC_AWARE' as const,
          departureTime: new Date(departAtMs).toISOString(),
        }
      : {};
  try {
    const response = await fetch(ROUTES_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({
        origin: point(origin),
        destination: point(destination),
        travelMode: 'DRIVE',
        // Immediate trips carry no routing preference: the enum has no "least time"
        // value, and the traffic-aware ones need a departure time in the future.
        ...scheduled,
        computeAlternativeRoutes: false,
        languageCode: 'en-IN',
        regionCode: 'IN',
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(await describeError(response));

    const body = (await response.json()) as {
      routes?: { distanceMeters?: number; duration?: string; polyline?: { encodedPolyline?: string } }[];
    };
    const route = body.routes?.[0];
    if (typeof route?.distanceMeters !== 'number' || route.distanceMeters <= 0) {
      throw new Error('no route distance');
    }
    return {
      distanceMeters: Math.round(route.distanceMeters),
      durationSeconds: parseDurationSeconds(route.duration),
      source: 'google_routes',
      encodedPolyline: typeof route.polyline?.encodedPolyline === 'string' ? route.polyline.encodedPolyline : null,
    };
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        fn: 'measureRoute',
        outcome: 'fallback_straight_line',
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    return straightLine(origin, destination);
  } finally {
    clearTimeout(timer);
  }
}
