import type { EpochMs, GeoPointLite } from './common';
import type { AvailabilityState, BookingStatus } from './enums';

/**
 * Realtime Database layout for high-frequency data.
 *
 * Deliberately separate from Firestore: driver coordinates change many times
 * per minute and must not burn Firestore writes or re-fetch booking documents.
 * Only transient, resumable state lives here — booking records, trip summaries
 * and critical events stay in Firestore.
 */
export const RTDB_PATHS = {
  /** Live position of a driver currently on an authorised assignment. */
  driverLocation: (driverUid: string) => `driverLocations/${driverUid}`,
  /** Per-booking tracking stream the customer and ops staff subscribe to. */
  activeBooking: (bookingId: string) => `activeBookings/${bookingId}`,
  /** Online/offline presence for dispatch eligibility. */
  presence: (driverUid: string) => `presence/${driverUid}`,
  /** Coarse last-known position used only for dispatch matching. */
  dispatchGrid: (zoneId: string, driverUid: string) => `dispatchGrid/${zoneId}/${driverUid}`,
  /** Client connection heartbeats, cleared by onDisconnect. */
  connections: (uid: string) => `connections/${uid}`,
} as const;

/** driverLocations/{driverUid} */
export type RtdbDriverLocation = {
  /** Present only while the driver holds an accepted assignment. */
  bookingId: string | null;
  lat: number;
  lng: number;
  accuracyMeters: number;
  headingDegrees: number | null;
  speedMps: number | null;
  /** Device clock of the fix. */
  fixTimeMs: EpochMs;
  /** Server clock of the write, so readers can detect staleness. */
  receivedAtMs: EpochMs;
  /** Coarse-only fallback: true when precise coordinates were withheld. */
  degraded: boolean;
};

/** activeBookings/{bookingId} */
export type RtdbActiveBooking = {
  bookingId: string;
  driverUid: string;
  customerUid: string;
  /** Mirrored status so a tracker can render without a Firestore read. */
  status: BookingStatus;
  location: RtdbDriverLocation | null;
  etaMinutes: number | null;
  etaCalculatedAtMs: EpochMs | null;
  /** Route polyline token held in Firestore; only the ref is streamed. */
  routeGeometryRef: string | null;
  updatedAtMs: EpochMs;
  /** Node is deleted by the completion function; this bounds any leak. */
  expiresAtMs: EpochMs;
};

/** presence/{driverUid} */
export type RtdbPresence = {
  driverUid: string;
  state: AvailabilityState;
  zoneId: string | null;
  /** Null while offline — no coordinates are retained past availability. */
  location: GeoPointLite | null;
  updatedAtMs: EpochMs;
  /** App-scoped client id; lets a scheduled sweep drop orphan nodes. */
  clientId: string | null;
};

/** dispatchGrid/{zoneId}/{driverUid} — coarse grid cell, not an address. */
export type RtdbDispatchCell = {
  driverUid: string;
  /** Geohash-style cell key at ~1km precision for driver search. */
  cell: string;
  lat: number;
  lng: number;
  updatedAtMs: EpochMs;
};

/**
 * Retention policy, enforced by the cleanup function and the RTDB rules'
 * `expiresAtMs` check. Live tracking data is short-lived by design.
 */
export const RTDB_RETENTION = {
  /** A location sample older than this is treated as stale by the client. */
  staleAfterMs: 20_000,
  /** Active booking nodes are force-deleted past this age. */
  activeBookingTtlMs: 6 * 60 * 60 * 1000,
  /** Offline driver presence is pruned after this. */
  presenceTtlMs: 24 * 60 * 60 * 1000,
  /** Location write cadence while the driver is moving. */
  publishIntervalMovingMs: 3_000,
  /** Relaxed cadence when the driver is stationary or on background. */
  publishIntervalIdleMs: 15_000,
  /** Minimum displacement before a same-position write is suppressed. */
  minMoveMeters: 15,
} as const;
