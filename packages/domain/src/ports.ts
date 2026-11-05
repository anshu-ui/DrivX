import type { EtaEstimate, GeoPointLite, MoneyPaise, Place } from './common';
import type { BookingStatus, CarType, ServiceTypeId, Transmission } from './enums';
import type { FareBreakdown } from './records-trip';

/**
 * Provider seams. The app talks to these interfaces, never to a vendor SDK
 * directly, so a provider can be swapped without touching feature code.
 * Implementations live in each app's infrastructure layer.
 */

export type PaymentIntentRequest = {
  bookingId: string;
  amountPaise: MoneyPaise;
  currency: 'INR';
  customerUid: string;
  methodHint: 'upi' | 'card' | 'netbanking' | 'wallet' | null;
};

export type PaymentIntentResult = {
  providerOrderId: string;
  /** Opaque payload handed to the provider SDK. Never a success flag. */
  checkoutPayload: Record<string, string>;
  amountPaise: MoneyPaise;
};

/**
 * A verified payment outcome. Only a webhook handler or a server-side
 * signature check may produce one; a client callback can never mark a payment
 * captured.
 */
export type VerifiedPayment = {
  bookingId: string;
  providerOrderId: string;
  providerPaymentId: string;
  amountPaise: MoneyPaise;
  captured: boolean;
  verifiedAtMs: number;
  /** Provider's own signature, verified server-side before use. */
  rawEventRef: string | null;
};

export interface PaymentProvider {
  readonly id: string;
  /** Rejects with NOT_CONFIGURED until merchant credentials are verified. */
  createIntent(request: PaymentIntentRequest): Promise<PaymentIntentResult>;
  verifyWebhook(input: { headers: Record<string, string>; body: string }): Promise<VerifiedPayment>;
}

export type RouteRequest = {
  origin: GeoPointLite;
  destination: GeoPointLite;
  waypoints?: GeoPointLite[];
  departAtMs?: number;
  trafficAware: boolean;
};

export type RouteResult = {
  distanceMeters: number;
  durationSeconds: number;
  /** Encoded polyline; stored by reference, not inside the booking document. */
  geometryPolyline: string | null;
  eta: EtaEstimate;
  /** True when the result is a straight-line guess rather than a route. */
  approximate: boolean;
};

export interface MapsProvider {
  autocomplete(input: { query: string; near: GeoPointLite; sessionToken: string }): Promise<Place[]>;
  reverseGeocode(point: GeoPointLite): Promise<Place | null>;
  calculateRoute(request: RouteRequest): Promise<RouteResult>;
  /** Suggested legal stopping points near a pin. */
  suggestPickupPoints(point: GeoPointLite): Promise<GeoPointLite[]>;
}

export type CandidateDriver = {
  driverUid: string;
  distanceToPickupMeters: number;
  etaToPickupMinutes: number;
  ratingAverage: number;
  /** Verification and service-type eligibility, resolved server-side. */
  eligible: boolean;
  inactivitySeconds: number | null;
  acceptanceRate: number | null;
};

export type DispatchRequest = {
  bookingId: string;
  serviceTypeId: ServiceTypeId;
  pickup: Place;
  zoneId: string;
  scheduledForMs: number | null;
  requiredTransmission: Transmission;
  requiredCarType: CarType;
  /** How many candidates to return. */
  limit: number;
};

export interface DispatchStrategy {
  /** Returns eligible, nearby, online drivers ranked for offer. */
  suggest(request: DispatchRequest): Promise<CandidateDriver[]>;
}

export type TripFareQuoteRequest = {
  serviceTypeId: ServiceTypeId;
  zoneId: string;
  distanceMeters: number;
  durationSeconds: number;
  departAtMs: number;
  waitingMinutes?: number;
};

export type TripFareQuote = {
  breakdown: FareBreakdown;
  /** Surfaced so the UI can tell the customer a quote has lapsed. */
  expired: boolean;
};

export interface FareEngine {
  quote(request: TripFareQuoteRequest): Promise<TripFareQuote>;
  /** Final fare uses actual route data and is the only chargeable figure. */
  finalise(input: { bookingId: string; actualDistanceMeters: number | null; actualDurationSeconds: number | null; waitingMinutes: number }): Promise<FareBreakdown>;
}

export type BookingStateTransition = {
  from: BookingStatus;
  to: BookingStatus;
  /** Only a Cloud Function may perform this edge. */
  actor: 'customer' | 'driver' | 'admin' | 'ops' | 'system';
  /** Guard name, evaluated server-side before the write. */
  requires: Array<'trip_otp' | 'geofence_entry' | 'accuracy_threshold' | 'assignment_owner' | 'manual_fallback_reason'>;
};

/**
 * The Phase 4 state machine, declared as data so rules, functions and tests
 * can assert against the same table. Anything not listed here is invalid.
 */
export const ALLOWED_TRANSITIONS: readonly BookingStateTransition[] = [
  { from: 'requested', to: 'searching_driver', actor: 'system', requires: [] },
  { from: 'searching_driver', to: 'assigned', actor: 'system', requires: ['assignment_owner'] },
  { from: 'assigned', to: 'driver_en_route', actor: 'driver', requires: ['assignment_owner'] },
  { from: 'driver_en_route', to: 'driver_arrived', actor: 'system', requires: ['geofence_entry', 'accuracy_threshold'] },
  { from: 'driver_en_route', to: 'driver_arrived', actor: 'driver', requires: ['manual_fallback_reason'] },
  { from: 'driver_arrived', to: 'trip_started', actor: 'system', requires: ['trip_otp'] },
  { from: 'trip_started', to: 'in_progress', actor: 'system', requires: [] },
  { from: 'in_progress', to: 'destination_reached', actor: 'system', requires: ['geofence_entry', 'accuracy_threshold'] },
  { from: 'destination_reached', to: 'completed', actor: 'driver', requires: ['assignment_owner'] },
  // The metered path the owner asked for: the drop is proven by the customer's
  // end code and the closing odometer reading, not by a geofence the phone may
  // never have settled in. The bill is priced off those two facts.
  { from: 'in_progress', to: 'completed', actor: 'driver', requires: ['trip_otp', 'assignment_owner'] },
  { from: 'in_progress', to: 'completed', actor: 'driver', requires: ['manual_fallback_reason'] },
  { from: 'requested', to: 'cancelled', actor: 'customer', requires: [] },
  { from: 'searching_driver', to: 'cancelled', actor: 'customer', requires: [] },
  { from: 'assigned', to: 'cancelled', actor: 'customer', requires: [] },
  // The owner's rule: only the customer can cancel a trip. A driver who cannot
  // attend hands the job back to dispatch instead of ending the booking —
  // releasing it is a reassignment, not a cancellation, so the customer still
  // has a trip and still gets a driver.
  { from: 'assigned', to: 'searching_driver', actor: 'driver', requires: ['assignment_owner'] },
  { from: 'assigned', to: 'searching_driver', actor: 'system', requires: [] },
  { from: 'driver_en_route', to: 'cancelled', actor: 'customer', requires: [] },
  { from: 'driver_en_route', to: 'no_show', actor: 'system', requires: [] },
  { from: 'driver_arrived', to: 'cancelled', actor: 'customer', requires: [] },
  { from: 'driver_arrived', to: 'no_show', actor: 'system', requires: [] },
  { from: 'searching_driver', to: 'expired', actor: 'system', requires: [] },
];

export function canTransition(
  from: BookingStatus,
  to: BookingStatus,
  actor: BookingStateTransition['actor'],
): boolean {
  return ALLOWED_TRANSITIONS.some((t) => t.from === from && t.to === to && t.actor === actor);
}

export function allowedNextStates(
  from: BookingStatus,
  actor: BookingStateTransition['actor'],
): BookingStatus[] {
  return ALLOWED_TRANSITIONS.filter((t) => t.from === from && t.actor === actor).map((t) => t.to);
}
