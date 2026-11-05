/**
 * Explicit status values. Firestore stores these as strings; rules and Cloud
 * Functions are the only places allowed to move a document between them.
 */

export const USER_ROLES = ['customer', 'driver', 'admin', 'ops'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const ACCOUNT_STATUSES = ['active', 'suspended', 'deletion_requested', 'deleted'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** Driver must be `approved` before receiving production assignments. */
export const VERIFICATION_STATUSES = [
  'not_started',
  'pending_review',
  'approved',
  'rejected',
  'expiring_soon',
  'expired',
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/**
 * The paperwork a DrivX driver files, and the only kinds the app will accept.
 *
 * The owner's rule of 2026-10-27: "sirf adhar card driving license chaiye aur
 * ni kuch aur". Vehicle registration, insurance, fitness and police
 * verification were removed rather than hidden, because under "Safar aapka,
 * driver hamara" the car is the customer's — those certificates are not the
 * driver's to produce, and a checklist that demanded them was asking every
 * applicant for documents belonging to a different owner's vehicle.
 *
 * The photograph stays because the driver's own rule of 2026-10-25 allows
 * exactly one ("Aadhaar + driving licence + one more photo, nothing beyond
 * these"), and because it is the face the customer is shown when a driver is
 * assigned — the Aadhaar image cannot serve that purpose, since it carries a
 * number the customer must never see.
 */
export const DOCUMENT_TYPES = ['driving_licence', 'photo_id', 'driver_photograph'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/**
 * The name each kind of paperwork is shown under, in the driver's checklist and
 * in the reviewer's queue alike. Two apps that describe the same document
 * differently are how a driver ends up uploading the wrong photo, so the wording
 * lives here rather than in either interface.
 */
export const DOCUMENT_LABELS: Record<DocumentType, string> = {
  driving_licence: 'Driving licence',
  photo_id: 'Aadhaar card',
  driver_photograph: 'Profile photograph',
};

/**
 * Booking lifecycle. `destination_reached` is a geofence-assisted signal that
 * still requires an explicit driver completion confirmation.
 */
export const BOOKING_STATUSES = [
  'requested',
  'searching_driver',
  'assigned',
  'driver_en_route',
  'driver_arrived',
  'trip_started',
  'in_progress',
  'destination_reached',
  'completed',
  'cancelled',
  'no_show',
  'expired',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Statuses after which the trip has begun; location tracking is permitted. */
export const ACTIVE_TRIP_STATUSES = ['trip_started', 'in_progress', 'destination_reached'] as const;

export const CANCELLABLE_STATUSES = [
  'requested',
  'searching_driver',
  'assigned',
  'driver_en_route',
  'driver_arrived',
] as const satisfies readonly BookingStatus[];

export const TRIP_TERMINAL_STATUSES = ['completed', 'cancelled', 'no_show', 'expired'] as const;

export function isActiveTrip(status: BookingStatus): boolean {
  return (ACTIVE_TRIP_STATUSES as readonly string[]).includes(status);
}

export function isTerminalBooking(status: BookingStatus): boolean {
  return (TRIP_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function isCancellable(status: BookingStatus): boolean {
  return (CANCELLABLE_STATUSES as readonly string[]).includes(status);
}

export const PAYMENT_STATUSES = [
  'not_required',
  'estimated',
  'pending',
  'authorized',
  'captured',
  'failed',
  'refunded',
  'partially_refunded',
  'waived',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Cash is recorded, never collected in-app, until the cash policy is cleared. */
export const PAYMENT_METHODS = ['upi', 'card', 'netbanking', 'wallet', 'cash', 'corporate'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * How a driver's money owed is standing. There is no `partial`: each row — the
 * onboarding fee or one trip's commission — is cleared in a single payment, so a
 * half-collected row would be a state nobody can act on.
 */
export const DRIVER_DUE_STATUSES = ['unpaid', 'paid'] as const;
export type DriverDueStatus = (typeof DRIVER_DUE_STATUSES)[number];

/**
 * What a driver can owe. `onboarding_fee` is the one-time charge the owner sets
 * before a new driver takes a booking; `commission` is the platform's share of a
 * trip that has actually been driven, so there is exactly one row per completed
 * booking rather than one row per driver.
 */
export const DRIVER_DUE_KINDS = ['onboarding_fee', 'commission', 'late_arrival_penalty'] as const;
export type DriverDueKind = (typeof DRIVER_DUE_KINDS)[number];

/**
 * Only money the office can physically see being handed over may be recorded by
 * an admin. A card, netbanking or wallet payment exists only as far as the
 * gateway confirms it, so marking one paid from the console would be inventing a
 * transaction — those methods stay with the webhook.
 */
export const ATTESTABLE_DUE_METHODS = ['cash', 'upi'] as const;
export type AttestableDueMethod = (typeof ATTESTABLE_DUE_METHODS)[number];

export const REFUND_STATUSES = ['requested', 'processing', 'completed', 'failed', 'rejected'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const ASSIGNMENT_STATUSES = [
  'offered',
  'accepted',
  'declined',
  'expired',
  'revoked',
  'completed',
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const AVAILABILITY_STATES = ['offline', 'online', 'on_assignment', 'on_trip', 'break'] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

/**
 * Append-only, server-validated trip events (spec section 6). The mobile
 * client is not permitted to write these directly.
 */
export const TRIP_EVENT_TYPES = [
  'booking_created',
  'driver_offered',
  'driver_assigned',
  'driver_declined',
  'reassigned',
  'driver_arrived',
  'arrival_forced_manually',
  'otp_sent',
  'otp_verified',
  'otp_failed',
  'trip_started',
  'odometer_recorded',
  'destination_detected',
  'trip_completed',
  'completion_forced_manually',
  'booking_cancelled',
  'no_show_recorded',
  'support_intervention',
  'fare_finalised',
  'payment_captured',
  'refund_issued',
] as const;
export type TripEventType = (typeof TRIP_EVENT_TYPES)[number];

/** Events that must never be mutated or deleted once written. */
export const IMMUTABLE_TRIP_EVENTS = TRIP_EVENT_TYPES;

export const SERVICE_TYPE_IDS = [
  'chauffeur_own_car',
  'chauffeur_hourly',
  'chauffeur_outstation',
  'cab_standard',
  'cab_premium',
] as const;
export type ServiceTypeId = (typeof SERVICE_TYPE_IDS)[number];

/**
 * How a pricing rule turns a trip into money. `distance` charges every kilometre
 * at one flat rate; `distance_slab` prices the whole route off one slab table
 * (one configured row prices the route) and meters only the
 * kilometres past the last slab; `hourly_package` sells a fixed tier of N hours
 * with M kilometres inside it, and meters only the overage.
 */
export const PRICING_MODELS = ['distance', 'distance_slab', 'hourly_package'] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];

/**
 * How a billable kilometre count is rounded before it is priced. The two models
 * that meter distance must agree on one rule, because the same 12.04 km route
 * cannot be 12.0 km on one line of a receipt and 13 km on the next.
 */
export const DISTANCE_ROUNDING_MODES = ['one_decimal', 'next_whole_km'] as const;
export type DistanceRoundingMode = (typeof DISTANCE_ROUNDING_MODES)[number];

/**
 * What a night departure costs. `flat` adds one configured amount once to an
 * eligible booking — the ₹150 night allowance the owner approved; `percent` adds
 * a share of the core fare, which is how the earlier rules were written and is
 * still what a zone may want for a surge-shaped night premium.
 */
export const NIGHT_SURCHARGE_MODES = ['flat', 'percent', 'hourly'] as const;
export type NightSurchargeMode = (typeof NIGHT_SURCHARGE_MODES)[number];

/**
 * Launch posture: what a customer can actually book today.
 *
 * Outstation one-way and day-package returns are enabled with their published
 * charts through the configured 3,000 km package; cab fleet services stay closed
 * until their separate operating requirements are met.
 */
export const ENABLED_SERVICE_TYPES: readonly ServiceTypeId[] = [
  'chauffeur_own_car',
  'chauffeur_hourly',
  'chauffeur_outstation',
];

export function isServiceTypeEnabled(id: ServiceTypeId): boolean {
  return ENABLED_SERVICE_TYPES.includes(id);
}

export const TRANSMISSIONS = ['automatic', 'manual', 'either'] as const;
export type Transmission = (typeof TRANSMISSIONS)[number];

export const CAR_TYPES = ['hatchback', 'sedan', 'suv', 'luxury', 'ev', 'either'] as const;
export type CarType = (typeof CAR_TYPES)[number];

/**
 * Whether the chauffeur drops you and leaves, or keeps the car for the return
 * leg. A round trip is sold as an hourly package rather than per kilometre,
 * because what the customer is buying is the driver's day, not the distance.
 */
export const TRIP_DIRECTIONS = ['one_way', 'round_trip'] as const;
export type TripDirection = (typeof TRIP_DIRECTIONS)[number];

export const SUPPORT_TICKET_STATUSES = ['open', 'in_progress', 'awaiting_customer', 'resolved', 'closed'] as const;
export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];

export const SUPPORT_CATEGORIES = [
  'trip_issue',
  'fare_dispute',
  'driver_conduct',
  'lost_item',
  'payment',
  'cancellation',
  'account',
  'emergency_follow_up',
] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const NOTIFICATION_CHANNELS = ['push', 'sms', 'in_app', 'email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * Push payload types. Kept as a closed set so the client can route without
 * parsing free-form text.
 */
export const NOTIFICATION_TYPES = [
  'booking_confirmed',
  'driver_assigned',
  'trip_codes',
  'driver_arrived',
  'trip_started',
  'trip_completed',
  'driver_rated',
  'booking_cancelled',
  'assignment_offer',
  'scheduled_booking_reminder',
  'verification_update',
  'payment_update',
  'support_reply',
  'safety_alert',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * What a customer can say beside the number of stars.
 *
 * A closed set rather than free text because the words have to mean the same
 * thing on the driver's screen as they do on the customer's, and because a
 * rating the office cannot group is a rating nobody acts on. The comment field
 * on `ratings/{id}` is where anything else goes.
 */
export const DRIVER_RATING_TAGS = [
  'drove_carefully',
  'knew_the_route',
  'arrived_on_time',
  'polite',
  'helped_with_luggage',
  'car_was_clean',
] as const;
export type DriverRatingTag = (typeof DRIVER_RATING_TAGS)[number];

/** The one-to-five scale the whole product shares, so no screen invents its own. */
export const RATING_SCORE_MIN = 1;
export const RATING_SCORE_MAX = 5;

export const AUDIT_ACTIONS = [
  'driver_approved',
  'driver_rejected',
  'driver_application_submitted',
  'driver_fee_recorded',
  'due_settled_by_gateway',
  'driver_suspended',
  'role_granted',
  'role_revoked',
  'manual_assignment',
  'reassignment',
  'booking_cancelled_by_admin',
  'refund_issued_by_admin',
  'pricing_rule_updated',
  'service_type_toggled',
  'support_ticket_resolved',
  'account_deleted',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Who ended the booking. `driver` is deliberately absent — a driver who cannot
 * attend releases the assignment back to dispatch, which is a reassignment, not
 * a cancellation. The app only ever writes `customer`; `admin`/`ops`/`system`
 * are records for back-office and automated closures, which are not app
 * surfaces today and would have to be built before anything could use them.
 */
export const CANCELLATION_BY = ['customer', 'admin', 'ops', 'system'] as const;
export type CancellationBy = (typeof CANCELLATION_BY)[number];

/**
 * Why a booking was cancelled — the dimension the cancellation report groups
 * on. There are no driver-attributable codes because a driver cannot cancel;
 * they release the assignment and dispatch re-offers the trip.
 */
export const CANCELLATION_REASONS = [
  'plan_changed',
  'wrong_details',
  'waited_too_long',
  'found_alternative',
  'fare_too_high',
  'other',
] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

export const GEOFENCE_KINDS = ['pickup', 'destination'] as const;
export type GeofenceKind = (typeof GEOFENCE_KINDS)[number];

export const SAVED_PLACE_LABELS = ['home', 'work', 'other'] as const;
export type SavedPlaceLabel = (typeof SAVED_PLACE_LABELS)[number];
