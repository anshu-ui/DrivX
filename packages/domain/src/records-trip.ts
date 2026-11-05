import type {
  AssignmentStatus,
  AuditAction,
  BookingStatus,
  CancellationBy,
  CarType,
  GeofenceKind,
  NotificationType,
  PaymentMethod,
  PaymentStatus,
  RefundStatus,
  ServiceTypeId,
  SupportCategory,
  SupportTicketStatus,
  TicketPriority,
  Transmission,
  TripDirection,
  TripEventType,
} from './enums';
import type { EpochMs, EtaEstimate, GeoPointLite, LocationSample, MoneyPaise, Place } from './common';
import type { PricingRuleRecord } from './records-identity';

/** One line of the transparent fare breakdown shown before and after a trip. */
export type FareLineItem = {
  key:
    | 'base_fare'
    | 'slab_fare'
    | 'package'
    | 'distance'
    | 'duration'
    | 'waiting'
    | 'night_surcharge'
    | 'surge'
    | 'minimum_fare'
    | 'platform_fee'
    | 'gst'
    | 'discount'
    | 'rounding'
    | 'cancellation_fee';
  label: string;
  amountPaise: MoneyPaise;
  /** Human-readable route charge detail shown to the customer and Admin. */
  detail?: string;
};

export type FareBreakdown = {
  currency: 'INR';
  /**
   * Every charge, including `platform_fee`, listed here. The engine guarantees
   * `subtotalPaise === sum(items.amountPaise)` and `totalPaise === subtotal + tax`,
   * so a receipt can be checked by adding it up.
   */
  items: FareLineItem[];
  subtotalPaise: MoneyPaise;
  taxPaise: MoneyPaise;
  totalPaise: MoneyPaise;
  /** Rule snapshot so a later pricing change cannot alter a past quote. */
  pricingRuleId: string;
  /** Server-issued identifier for this estimate/accepted booking price. */
  quoteId: string | null;
  /** Admin-controlled tariff revision used to calculate this fare. */
  pricingVersion: number;
  /**
   * Hash of the canonical rule + tier the fare was computed from, produced by
   * the caller's hasher. Null only where a quote predates the field.
   */
  pricingSnapshotHash: string | null;
  generatedAtMs: EpochMs;
  expiresAtMs: EpochMs | null;
  /** `estimate` is never a charged amount; `final` is server-produced. */
  kind: 'estimate' | 'final';
  /** The tier a package fare was priced against, so a receipt is reproducible. */
  packageTierId: string | null;
};

/**
 * The driver as the customer is allowed to see them, copied onto the booking by
 * the server when a driver is assigned.
 *
 * It is a copy rather than a read of `driverProfiles` because the rules refuse a
 * customer that collection — the same document carries their Aadhaar pointer,
 * their dues and their availability. The owner's rule of 2026-10-27 is that a
 * customer gets "uski sab details… name, number, sab kuch", so this is the part
 * of a driver that a customer is owed, written by whoever makes the assignment
 * and never by a client.
 */
export type AssignedDriverCard = {
  uid: string;
  /** The office's own reference, e.g. `DRV-4K7QXA`, which the customer can quote. */
  driverId: string | null;
  fullName: string;
  /** The driver's real number, dialable from the trip screen. */
  phoneE164: string;
  /** `avatars/{uid}/…`, or null when no face was filed. */
  photoPath: string | null;
  ratingAverage: number;
  ratingCount: number;
  lifetimeTrips: number;
  languages: string[];
  vehicle: { make: string | null; model: string | null; plate: string | null };
  /** Copied at assignment; a later profile edit does not rewrite a past trip. */
  publishedAtMs: EpochMs | null;
};

/** bookings/{bookingId} */
export type BookingRecord = {
  id: string;
  /** Server-generated public reference, e.g. DRX-7K3QD2. */
  reference: string;
  customerUid: string;
  /** Null until an assignment is accepted. */
  assignedDriverUid: string | null;
  /**
   * The driver's details for the customer, published by the server beside the
   * uid it was copied from. Null until a driver is assigned.
   */
  driver: AssignedDriverCard | null;
  serviceTypeId: ServiceTypeId;
  zoneId: string;

  status: BookingStatus;
  paymentStatus: PaymentStatus;

  pickup: Place;
  destination: Place | null;
  /** Pickup geofence resolved from the service type at creation time. */
  pickupGeofence: { center: GeoPointLite; radiusMeters: number };
  destinationGeofence: { center: GeoPointLite; radiusMeters: number } | null;

  /** Null means "now"; otherwise the requested local start. */
  scheduledForMs: EpochMs | null;
  /**
   * Which rule priced this booking: the service's own for a drop-off, its
   * hourly rule when the chauffeur returns with the customer.
   */
  tripDirection: TripDirection;
  /** The exact fare rule accepted at booking time; later Admin edits cannot reprice this trip. */
  pricingRuleSnapshot?: PricingRuleRecord | null;
  createdAtMs: EpochMs | null;
  updatedAtMs: EpochMs | null;

  driverEnRouteEta: EtaEstimate | null;
  arrivalConfirmedAtMs: EpochMs | null;
  /** Set when arrival was confirmed without a valid GPS fix. */
  arrivalConfirmedManually: boolean;
  tripStartedAtMs: EpochMs | null;
  destinationDetectedAtMs: EpochMs | null;
  completedAtMs: EpochMs | null;
  /** Set when completion was confirmed without a valid geofence reading. */
  completionConfirmedManually: boolean;

  estimate: FareBreakdown;
  /**
   * What the trip costs so far, priced by the server off the latest posted
   * reading. Null until the driver posts the first one.
   *
   * It lives on the booking rather than only in `recordOdometer`'s response
   * because the customer's app cannot call that function — the reading is the
   * driver's to report — and must never do its own arithmetic. Both screens
   * render this one breakdown, so the rupees a customer watches climbing are
   * produced by the same call that will price the receipt.
   */
  runningFare: FareBreakdown | null;
  /** Only present after the server finalises the fare. */
  finalFare: FareBreakdown | null;

  customerPreferences: {
    transmission: Transmission;
    carType: CarType;
    vehicleDescription?: string | null;
    notes: string | null;
  };

  cancellation: {
    by: CancellationBy | null;
    reasonCode: string | null;
    reasonText: string | null;
    atMs: EpochMs | null;
    feePaise: MoneyPaise;
    refundEligible: boolean;
  };

  /** Idempotency key supplied by the client so a retry cannot double-book. */
  idempotencyKey: string | null;
  /** Route token from the Routes API, reused for the trip polyline. */
  routeGeometryRef: string | null;
  /** Encoded Routes API road polyline displayed by both mobile trip maps. */
  routePolyline?: string | null;
  estimatedDistanceMeters: number | null;
  estimatedDurationSeconds: number | null;

  /**
   * The car's odometer dial, in whole kilometres, as the driver typed it.
   *
   * Three numbers, all written only by Cloud Functions after the trip OTP for
   * that stage checked out: `startOdometerKm` at pickup, `currentOdometerKm`
   * while the trip runs, `endOdometerKm` at the drop. The bill is priced off
   * `endOdometerKm - startOdometerKm` rather than the route the map quoted,
   * because the quote is a promise about distance and the dial is the fact.
   * Null until captured — an absent reading is never treated as zero.
   */
  startOdometerKm: number | null;
  currentOdometerKm: number | null;
  endOdometerKm: number | null;

  /** Bumped by functions on every state change; clients cannot set it. */
  stateVersion: number;
  /** True while a support agent has taken over the booking. */
  supportHold: boolean;
};

/** bookings/{bookingId}/assignments/{assignmentId} */
export type DriverAssignmentRecord = {
  id: string;
  bookingId: string;
  driverUid: string;
  attempt: number;
  status: AssignmentStatus;
  offeredAtMs: EpochMs | null;
  /** Offer lapses here; a scheduled function marks it `expired`. */
  expiresAtMs: EpochMs | null;
  respondedAtMs: EpochMs | null;
  declineReason: string | null;
  /** Distance in metres from driver to pickup when offered. */
  distanceToPickupMeters: number | null;
  etaToPickupMinutes: number | null;
  strategy: 'auto_dispatch' | 'manual_admin' | 'reassignment';
  assignedByUid: string | null;
};

/**
 * bookings/{bookingId}/events/{eventId} — append-only, server-written.
 * `eventId` is derived from the event type plus a nonce so a replayed write
 * collides instead of duplicating.
 */
export type TripEventRecord = {
  id: string;
  bookingId: string;
  type: TripEventType;
  atMs: EpochMs | null;
  actor: {
    uid: string | null;
    role: 'customer' | 'driver' | 'admin' | 'ops' | 'system';
  };
  /** GPS reading at the moment of the event, when one was required. */
  location: LocationSample | null;
  geofenceKind: GeofenceKind | null;
  /** Booking status before/after, for state-machine audit. */
  fromStatus: BookingStatus | null;
  toStatus: BookingStatus | null;
  /** Anything the event changed; kept small and free of PII. */
  payload: Record<string, string | number | boolean | null> | null;
  /** Cloud Function request id, for correlation with structured logs. */
  requestId: string | null;
};

/** tripSummaries/{bookingId} — written once at completion, then immutable. */
export type TripSummaryRecord = {
  bookingId: string;
  customerUid: string;
  driverUid: string;
  serviceTypeId: ServiceTypeId;
  startedAtMs: EpochMs | null;
  completedAtMs: EpochMs | null;
  durationSeconds: number | null;
  /** Null when the GPS trace was too poor to trust a distance. */
  distanceMeters: number | null;
  distanceSource: 'google_routes_actual' | 'gps_trace' | 'unavailable';
  /** Storage/RTDB pointer to the recorded trace, not the trace itself. */
  traceRef: string | null;
  pickupAddressSummary: string;
  destinationAddressSummary: string;
  finalFarePaise: MoneyPaise | null;
  waitingMinutes: number | null;
  cancellationFeePaise: MoneyPaise | null;
  paymentMethod: PaymentMethod | null;
  customerRating: number | null;
  driverRating: number | null;
  arrivedLateSeconds: number | null;
  createdAtMs: EpochMs | null;
};

/** payments/{paymentId} */
export type PaymentRecord = {
  id: string;
  bookingId: string;
  customerUid: string;
  amountPaise: MoneyPaise;
  currency: 'INR';
  method: PaymentMethod | null;
  status: PaymentStatus;
  /** Provider abstraction: cashfree | cash | corporate | manual. */
  provider: string | null;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  providerSignatureRef: string | null;
  /** Verified by the webhook handler, never by the client. */
  verifiedAtMs: EpochMs | null;
  failureReason: string | null;
  createdAtMs: EpochMs | null;
  updatedAtMs: EpochMs | null;
};

/** refunds/{refundId} */
export type RefundRecord = {
  id: string;
  bookingId: string;
  paymentId: string;
  customerUid: string;
  amountPaise: MoneyPaise;
  currency: 'INR';
  status: RefundStatus;
  reason: string;
  initiatedBy: 'system_cancellation' | 'support' | 'admin';
  actorUid: string | null;
  providerRefundId: string | null;
  processedAtMs: EpochMs | null;
  createdAtMs: EpochMs | null;
};

/** ratings/{id} */
export type RatingRecord = {
  id: string;
  bookingId: string;
  /**
   * The reference printed on the trip, copied at the moment of rating. A driver
   * reading their own ratings must be able to say which job a star came from, and
   * a booking id is not something a person recognises.
   */
  bookingReference: string | null;
  /** Who rated: customer → driver, or driver → customer. */
  raterUid: string;
  ratedUid: string;
  direction: 'customer_to_driver' | 'driver_to_customer';
  score: number;
  tags: string[];
  comment: string | null;
  createdAtMs: EpochMs | null;
};

/** supportTickets/{id} */
export type SupportTicketRecord = {
  id: string;
  bookingId: string | null;
  openedByUid: string;
  forRole: 'customer' | 'driver';
  category: SupportCategory;
  priority: TicketPriority;
  status: SupportTicketStatus;
  subject: string;
  body: string;
  assignedAdminUid: string | null;
  lastCustomerReplyAtMs: EpochMs | null;
  resolvedAtMs: EpochMs | null;
  resolution: string | null;
  createdAtMs: EpochMs | null;
  updatedAtMs: EpochMs | null;
};

/** users/{uid}/notifications/{notificationId} */
export type NotificationRecord = {
  id: string;
  uid: string;
  type: NotificationType;
  title: string;
  body: string;
  /** Deep link routed by the app, e.g. /booking/{id}/tracking */
  route: string | null;
  bookingId: string | null;
  data: Record<string, string> | null;
  readAtMs: EpochMs | null;
  /** Dedupe key so a retried function cannot notify twice. */
  dedupeKey: string | null;
  createdAtMs: EpochMs | null;
};

/** adminAuditLogs/{id} — append-only, admin-readable only. */
export type AdminAuditLogRecord = {
  id: string;
  actorUid: string;
  actorRole: 'admin' | 'ops' | 'driver' | 'system';
  action: AuditAction;
  targetType: 'booking' | 'driver' | 'customer' | 'pricing_rule' | 'service_type' | 'payment' | 'support_ticket';
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  ipAddress: string | null;
  atMs: EpochMs | null;
};

/**
 * otpCodes/{bookingId}_{purpose} — server-only. Trip-start OTPs, trip-end OTPs
 * and cancellation OTPs live here; the mobile client has no read access.
 *
 * The code is only ever shown to the person who is supposed to *say* it: the
 * customer reads the start code to the driver at pickup, and the driver is
 * refused it. A code both sides can read is not a proof that anyone arrived.
 *
 * One code per booking per purpose, for the life of that booking. The owner's
 * rule of 2026-10-27 removed re-issue: the digits are generated once against
 * the booking id and every later read returns the same pair, which is also why
 * the plaintext is stored here rather than only its hash.
 */
export type OtpCodeRecord = {
  id: string;
  bookingId: string;
  purpose: 'trip_start' | 'trip_end' | 'cancellation' | 'handover';
  /** The digits, as minted. Verification compares `codeHash`, never this field. */
  code: string;
  codeHash: string;
  issuedAtMs: EpochMs | null;
  expiresAtMs: EpochMs | null;
  attempts: number;
  maxAttempts: number;
  consumedAtMs: EpochMs | null;
  lastAttemptAtMs: EpochMs | null;
  /** The customer the digits were handed to. */
  issuedToUid: string | null;
};
