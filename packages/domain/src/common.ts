import type { GeofenceKind } from './enums';

/**
 * Firestore timestamps are converted to epoch milliseconds at every read
 * boundary, so domain consumers never have to import the Firestore SDK.
 * Writes go the other way: the persistence layer emits
 * `firebase.firestore.FieldValue.serverTimestamp()` for these fields.
 */
export type EpochMs = number;

/** ISO-4217 INR minor units. Money is always integer paise, never a float. */
export type MoneyPaise = number;

export function paiseToRupees(paise: MoneyPaise): number {
  return paise / 100;
}

export function rupeesToPaise(rupees: number): MoneyPaise {
  return Math.round(rupees * 100);
}

export function formatINR(paise: MoneyPaise): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(paiseToRupees(paise));
}

export type GeoPointLite = {
  lat: number;
  lng: number;
};

export type Place = {
  /** Human-readable single-line address from Places or reverse geocoding. */
  label: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  pincode?: string;
  location: GeoPointLite;
  /** Google Places place id when the address came from Autocomplete. */
  placeId?: string;
  /** Source of truth for the address, used for fare-audit confidence. */
  source: 'places_autocomplete' | 'map_pin' | 'saved_place' | 'reverse_geocode';
};

export type Geofence = {
  center: GeoPointLite;
  /** Metres. Configurable per service type and tuned in Phase 4. */
  radiusMeters: number;
  kind: GeofenceKind;
};

/**
 * A GPS reading with its quality attached. Accuracy is mandatory: arrival and
 * completion detection must reject readings above the configured threshold
 * rather than trusting the coordinate alone.
 */
export type LocationSample = {
  location: GeoPointLite;
  /** Metres; higher is worse. */
  accuracyMeters: number;
  altitudeMeters?: number;
  /** Degrees clockwise from true north. */
  headingDegrees?: number;
  /** Metres per second. Near zero is the "vehicle stopped" signal. */
  speedMps?: number;
  /** Device clock of the fix, epoch ms. */
  fixTimeMs: EpochMs;
  provider: 'gps' | 'network' | 'fused';
  /** True when the reading came from the last known location, not a fresh fix. */
  isStale: boolean;
};

/**
 * Location freshness. `null` availability is a real state that the UI must
 * render — the app never invents a precise position or ETA.
 */
export type EtaEstimate = {
  minutes: number | null;
  /** Epoch ms when the estimate was produced, so the client can show staleness. */
  calculatedAtMs: EpochMs;
  /** Metres travelled along the route, when the Routes API returned it. */
  distanceMeters: number | null;
  source: 'google_routes' | 'haversine_fallback' | 'unavailable';
  trafficAware: boolean;
};
