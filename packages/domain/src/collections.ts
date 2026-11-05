/**
 * Top-level Firestore collections. Single source of truth so rules, functions,
 * seeds and clients cannot drift apart. Nested stores live in SUBCOLLECTIONS,
 * which keeps this map aligned with the physical layout the rules describe.
 */
export const COLLECTIONS = {
  users: 'users',
  customerProfiles: 'customerProfiles',
  driverProfiles: 'driverProfiles',
  serviceTypes: 'serviceTypes',
  pricingRules: 'pricingRules',
  bookings: 'bookings',
  tripSummaries: 'tripSummaries',
  payments: 'payments',
  refunds: 'refunds',
  ratings: 'ratings',
  supportTickets: 'supportTickets',
  savedPlaces: 'savedPlaces',
  adminAuditLogs: 'adminAuditLogs',
  /** Server-side OTP records. Never written by a client. */
  otpCodes: 'otpCodes',
  /** App Check / dispatch configuration and feature flags. */
  appConfig: 'appConfig',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

/**
 * Sub-collection layout. Kept explicit because the security rules mirror it:
 *
 * users/{uid}
 * customerProfiles/{uid}
 * driverProfiles/{uid}
 * driverProfiles/{uid}/documents/{documentId}
 * driverProfiles/{uid}/dues/{dueId}            <- money the driver owes
 * bookings/{bookingId}
 * bookings/{bookingId}/events/{eventId}        <- append-only trip log
 * bookings/{bookingId}/assignments/{assignmentId}
 * payments/{paymentId}
 * savedPlaces/{uid}/places/{placeId}
 * users/{uid}/notifications/{notificationId}
 */
export const SUBCOLLECTIONS = {
  driverDocuments: 'documents',
  driverDues: 'dues',
  tripEvents: 'events',
  driverAssignments: 'assignments',
  savedPlaces: 'places',
  notifications: 'notifications',
} as const;

/** Public booking reference shown to customers, e.g. DRX-7K3QD2. */
export const BOOKING_REFERENCE_PREFIX = 'DRX';

export function bookingRefPath(bookingId: string): string {
  return `${COLLECTIONS.bookings}/${bookingId}`;
}

export function tripEventPath(bookingId: string, eventId: string): string {
  return `${bookingRefPath(bookingId)}/${SUBCOLLECTIONS.tripEvents}/${eventId}`;
}

export function assignmentPath(bookingId: string, assignmentId: string): string {
  return `${bookingRefPath(bookingId)}/${SUBCOLLECTIONS.driverAssignments}/${assignmentId}`;
}

/** `driverProfiles/{uid}/dues/{dueId}` — one charge a driver owes. */
export function driverDuePath(driverUid: string, dueId: string): string {
  return `${COLLECTIONS.driverProfiles}/${driverUid}/${SUBCOLLECTIONS.driverDues}/${dueId}`;
}

/**
 * `users/{uid}/notifications/{id}` — one message in one inbox. Nested under the
 * user so the rules can decide ownership from the path alone.
 */
export function notificationPath(uid: string, notificationId: string): string {
  return `${COLLECTIONS.users}/${uid}/${SUBCOLLECTIONS.notifications}/${notificationId}`;
}
