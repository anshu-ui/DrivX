import { z } from 'zod';
import type {
  BookingStatus,
  CancellationReason,
  DistanceRoundingMode,
  DriverDueStatus,
  NightSurchargeMode,
  PricingModel,
  ServiceTypeId,
  TripDirection,
} from './enums';
import type { MoneyPaise } from './common';
import type { FareBreakdown } from './records-trip';
import {
  ATTESTABLE_DUE_METHODS,
  CAR_TYPES,
  CANCELLATION_REASONS,
  DOCUMENT_TYPES,
  DRIVER_RATING_TAGS,
  RATING_SCORE_MAX,
  RATING_SCORE_MIN,
  SERVICE_TYPE_IDS,
  TRANSMISSIONS,
  TRIP_DIRECTIONS,
} from './enums';

/**
 * Client-side input validation. These schemas guard UX and save round-trips;
 * they are a convenience, not a trust boundary. Every one of them is re-run
 * inside a Cloud Function before a write.
 */

/** Indian mobile: +91 followed by 6-9 and ten further digits. */
export const INDIAN_MOBILE = /^[6-9]\d{9}$/;

/**
 * Bridges a frozen `as const` tuple into zod's enum signature, so the closed
 * sets in `enums.ts` stay the single source of truth.
 */
function zodEnum<T extends readonly string[]>(values: T) {
  return z.enum(values as unknown as [T[number], ...T[number][]]);
}

export const indiaPhoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-()]/g, ''))
  .refine(
    (value) => {
      const digits = value.startsWith('+91')
        ? value.slice(3)
        : value.startsWith('91') && value.length === 12
          ? value.slice(2)
          : value.length === 10
            ? value
            : null;
      return digits !== null && INDIAN_MOBILE.test(digits);
    },
    { message: 'Enter a valid 10-digit Indian mobile number' },
  )
  .transform((value) => {
    const digits = value.startsWith('+91')
      ? value.slice(3)
      : value.startsWith('91') && value.length === 12
        ? value.slice(2)
        : value;
    return `+91${digits}`;
  });

/**
 * Address a customer gives at sign-up. Stored lowercased so the same mailbox
 * never becomes two different values in a query, and deliberately not RFC 5322:
 * this check catches a typo, while delivery is proven by the mail arriving.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Enter your email address')
  .max(254, 'Email address is too long')
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Enter a valid email address');

/** The name-and-email step every first-run account is asked for. */
export const signUpProfileInputSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(2, 'Enter the name as it should appear on receipts')
    .max(80, 'Name is too long'),
  email: emailSchema,
});

export const otpSchema = z
  .string()
  .trim()
  .regex(/^\d{4,6}$/, 'Enter the digits from the SMS');

export const tripOtpSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Trip start code must be 6 digits');

export const latSchema = z.number().min(-90).max(90);
export const lngSchema = z.number().min(-180).max(180);

export const geoPointSchema = z.object({
  lat: latSchema,
  lng: lngSchema,
});

/**
 * Place as submitted from Places Autocomplete, a dragged map pin or a saved place.
 *
 * The three optional fields accept `null` as well as absence: a v2 callable
 * delivers `undefined` as `null` over the wire, and Firestore stores `null` in a
 * field a document never set. `.transform` puts the value back to `undefined` so
 * what this yields still matches the `Place` record type.
 */
export const placeInputSchema = z.object({
  label: z.string().trim().min(4, 'Address is too short').max(300),
  addressLine1: z.string().trim().min(3).max(200),
  addressLine2: z.string().trim().max(200).nullish().transform((v) => v ?? undefined),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  pincode: z
    .string()
    .trim()
    .regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit PIN code')
    .nullish()
    .transform((v) => v ?? undefined),
  location: geoPointSchema,
  placeId: z.string().trim().max(120).nullish().transform((v) => v ?? undefined),
  source: z.enum(['places_autocomplete', 'map_pin', 'saved_place', 'reverse_geocode']),
});

export const customerPreferencesSchema = z.object({
  transmission: zodEnum(TRANSMISSIONS),
  carType: zodEnum(CAR_TYPES),
  vehicleDescription: z.string().trim().max(80).nullable().optional(),
  notes: z.string().trim().max(280).nullable().optional(),
});

/**
 * The facts a fare is priced from, before any booking exists.
 *
 * `packageTierId` is required for an hourly service and refused for a per-km
 * one; which is which is a property of the pricing rule, so the engine is the
 * place that decides and this schema only constrains the shape.
 */
const quoteFields = z.object({
  serviceTypeId: zodEnum(SERVICE_TYPE_IDS),
  pickup: placeInputSchema,
  destination: placeInputSchema,
  /** Epoch ms in the zone's time; null means "as soon as a driver is free". */
  scheduledForMs: z.number().int().positive().nullable().default(null),
  packageTierId: z
    .string()
    .trim()
    .min(1)
    .max(24)
    .nullish()
    .transform((v) => v ?? undefined),
  /**
   * Decides *which* rule prices the trip: the service's own per-km rule for a
   * drop-off, its hourly rule for a trip where the chauffeur returns with you.
   * The client always states it; the default only covers an older build.
   */
  tripDirection: zodEnum(TRIP_DIRECTIONS).default('one_way'),
});

/** Two identical pins price a zero-distance trip, which is never a real job. */
const distinctEndpoints = (value: {
  pickup: { location: { lat: number; lng: number } };
  destination: { location: { lat: number; lng: number } };
}) =>
  value.pickup.location.lat !== value.destination.location.lat ||
  value.pickup.location.lng !== value.destination.location.lng;

const NOT_THE_SAME_PLACE = 'Pickup and destination cannot be the same';

export const fareQuoteInputSchema = quoteFields.refine((value) => value.tripDirection === 'round_trip' || distinctEndpoints(value), {
  message: NOT_THE_SAME_PLACE,
  path: ['destination'],
});

/** Read-only checkout validation for a coupon against the current server quote. */
export const couponPreviewInputSchema = quoteFields
  .extend({ couponCode: z.string().trim().min(1).max(24) })
  .refine((value) => value.tripDirection === 'round_trip' || distinctEndpoints(value), {
    message: NOT_THE_SAME_PLACE,
    path: ['destination'],
  });

export const createBookingInputSchema = quoteFields
  .extend({
    preferences: customerPreferencesSchema,
    /** Optional reward selections. Values are requests only; the backend recomputes them. */
    couponCode: z.string().trim().max(24).nullish().transform((v) => v || undefined),
    redeemWalletPaise: z.number().int().min(0).max(10_000_000).default(0),
    redeemMilesPoints: z.number().int().min(0).max(1_000_000).default(0),
    /** Client-generated UUID; the server dedupes on it. */
    idempotencyKey: z.string().uuid(),
  })
  .refine((value) => value.tripDirection === 'round_trip' || distinctEndpoints(value), { message: NOT_THE_SAME_PLACE, path: ['destination'] })
  .refine(
    (value) => value.scheduledForMs !== null && value.scheduledForMs >= Date.now() + 30 * 60 * 1000,
    { message: 'Pickups must be scheduled at least 30 minutes ahead', path: ['scheduledForMs'] },
  )
  .refine(
    (value) => value.scheduledForMs !== null && value.scheduledForMs <= latestBookingDateEndMs(Date.now()),
    { message: 'Bookings can be scheduled up to 6 months ahead', path: ['scheduledForMs'] },
  );

/** Six calendar months in India time, through the final minute of that date. */
function latestBookingDateEndMs(nowMs: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const targetMonth = value('month') - 1 + 6;
  const targetYear = value('year') + Math.floor(targetMonth / 12);
  const month = targetMonth % 12;
  const targetDay = Math.min(value('day'), new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate());
  // IST is UTC+05:30. Convert local midnight at the target date to UTC, then
  // allow that whole calendar date for a scheduled pickup.
  return Date.UTC(targetYear, month, targetDay + 1) - 5.5 * 60 * 60 * 1000 - 1;
}

/**
 * Cancelling a trip. Only the customer's app calls this — the reason codes are
 * theirs, and the free-text field exists for `other` rather than as a general
 * comment box, so the stored text stays groupable.
 */
export const cancelBookingInputSchema = z.object({
  bookingId: z.string().min(8).max(64),
  reasonCode: z.enum(CANCELLATION_REASONS),
  reasonText: z
    .string()
    .trim()
    .max(300)
    .nullable()
    .optional()
    .transform((v) => v ?? null),
});

/**
 * The customer's verdict on the driver who just drove them.
 *
 * `bookingId` is the only thing a client gets to name about a trip — the score
 * is theirs, but who it lands on, what it does to the driver's average and
 * whether the trip was even finished are all decided server-side from the
 * booking document itself.
 */
export const rateTripInputSchema = z.object({
  bookingId: z.string().min(8).max(64),
  score: z.number().int().min(RATING_SCORE_MIN).max(RATING_SCORE_MAX),
  // A closed set: a tag the product has never heard of is refused rather than
  // stored, so the driver's screen can always name what a customer meant.
  tags: z.array(z.enum(DRIVER_RATING_TAGS)).max(DRIVER_RATING_TAGS.length).default([]),
  comment: z.string().trim().max(500).nullable().optional().transform((v) => v ?? null),
});

export const supportTicketInputSchema = z.object({
  bookingId: z.string().min(8).nullable().optional(),
  category: z.string().min(2).max(40),
  subject: z.string().trim().min(4).max(120),
  body: z.string().trim().min(10).max(2000),
});

export const savedPlaceInputSchema = z.object({
  label: z.enum(['home', 'work', 'other']),
  name: z.string().trim().min(1).max(60),
  place: placeInputSchema,
});

/**
 * A document number is reduced to its last four characters on the way in, so a
 * full Aadhaar or licence number never reaches Firestore. The reviewer who needs
 * the whole number opens the uploaded image; the queue only has to match a name
 * against a tail.
 */
export const documentNumberSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(6, 'Enter the number exactly as it is printed on the document')
  .max(32, 'That is too long to be a document number')
  .regex(/^[A-Z0-9-]+$/, 'Letters, numbers and dashes only')
  .transform((value) => `****-${value.replace(/[^A-Z0-9]/g, '').slice(-4)}`);

/** What the app checks before it spends the driver's data on an upload. */
export const driverDocumentUploadInputSchema = z.object({
  type: z.enum(DOCUMENT_TYPES),
  fileName: z.string().min(2).max(160),
  /** bytes */
  sizeBytes: z.number().int().positive().max(8 * 1024 * 1024),
  contentType: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
});

/**
 * What the office sends when a driver hands over money they owe.
 *
 * A `reference` is required because the console is attesting a payment it
 * watched happen — a UPI transaction id, a receipt number, a slip number. A
 * blank reason would let someone record a payment against nothing, and the audit
 * entry exists precisely so that cannot be done quietly.
 */
export const recordDriverDuePaymentInputSchema = z.object({
  driverUid: z.string().min(8).max(128),
  dueId: z.string().min(1).max(64),
  method: z.enum(ATTESTABLE_DUE_METHODS),
  reference: z.string().trim().min(3).max(120),
});

export type CreateBookingInput = z.infer<typeof createBookingInputSchema>;
export type CancelBookingInput = z.infer<typeof cancelBookingInputSchema>;
export type SignUpProfileInput = z.infer<typeof signUpProfileInputSchema>;
export type RecordDriverDuePaymentInput = z.infer<typeof recordDriverDuePaymentInputSchema>;
export type FareQuoteInput = z.infer<typeof fareQuoteInputSchema>;
export type PlaceInput = z.infer<typeof placeInputSchema>;
export type SavedPlaceInput = z.infer<typeof savedPlaceInputSchema>;
export type RateTripInput = z.infer<typeof rateTripInputSchema>;

/**
 * Callable response shapes.
 *
 * The client is allowed to *display* these and nothing else: a fare arrives
 * already computed, with the rule it came from and how the distance was
 * measured, so no screen has to do arithmetic that could be tampered with.
 */

/** Which authority produced the kilometres a fare was priced from. */
export type RouteSource = 'google_routes' | 'haversine_fallback';

export type FareQuoteResult = {
  serviceTypeId: ServiceTypeId;
  serviceTypeName: string;
  zoneId: string;
  /** The rule the money came from, so a dispute can be traced to one document. */
  pricingRuleId: string;
  /** Echoed back, so the screen states what the server actually priced. */
  tripDirection: TripDirection;
  breakdown: FareBreakdown;
  distanceMeters: number;
  /** Null when only a straight line was available — no invented minutes. */
  durationSeconds: number | null;
  distanceSource: RouteSource;
  packageTierId: string | null;
  /** Server clock at pricing time, so a countdown does not trust the device. */
  serverNowMs: number;
};

export type BookingOptionTier = {
  id: string;
  label: string;
  hours: number;
  includedKilometers: number;
  /**
   * The sticker price of the package, shown so a customer can compare tiers.
   * It is not the amount they pay: taxes and the platform fee only appear in the
   * quote, which is the sole source of a total.
   */
  packagePricePaise: MoneyPaise;
  /** What a kilometre beyond `includedKilometers` costs, printed on the rate card. */
  extraKmPaise: MoneyPaise;
  /**
   * What an hour beyond `hours` costs, charged pro rata by the minute — half an
   * hour over on a ₹120/hr rate is ₹60, not a whole ₹100 hour.
   */
  extraHourPaise: MoneyPaise;
};

/** One published row of a distance-slab chart: the band and the price for it. */
export type BookingOptionSlab = {
  upToKilometers: number;
  farePaise: MoneyPaise;
};

/**
 * The terms a service's price is built from, read off the rule that will quote
 * it so the rate card cannot drift from the fare.
 *
 * This is the part of a pricing rule that is safe to publish: the numbers a
 * customer would otherwise have to guess at before booking. It is not the fare.
 * A total still only ever comes from `quoteFare`, which is the difference
 * between telling someone the price of a kilometre and letting them set one.
 */
export type BookingOptionTerms = {
  pricingRuleId: string;
  /** Added on top of the fare, not inside it. */
  gstRate: number;
  platformFeeRate: number;
  /** Null on a rule that has no flat per-kilometre rate: a package or a slab chart. */
  perKmPaise: MoneyPaise | null;
  baseFarePaise: MoneyPaise;
  /**
   * The city one-way chart, cheapest band first, empty on any other model. The
   * customer is shown the row their route lands in, so the card has to carry all
   * of them.
   */
  slabs: BookingOptionSlab[];
  /** Per kilometre past the last slab. Null when the rule has no overflow rate. */
  slabOverflowPerKmPaise: MoneyPaise | null;
  /** How the billable distance is rounded before the chart is read against it. */
  distanceRounding: DistanceRoundingMode;
  includedWaitMinutes: number;
  waitChargePerMinutePaise: MoneyPaise;
  minimumFarePaise: MoneyPaise;
  /**
   * Null when nothing is added for a night departure. `flat` is one amount added
   * once — the ₹150 night allowance — and `percent` is a share of the fare.
   */
  nightSurcharge: {
    fromHour: number;
    toHour: number;
    mode: NightSurchargeMode;
    flatPaise: MoneyPaise;
    rate: number;
  } | null;
  estimateValidityMinutes: number;
};

export type BookingOptionService = {
  id: ServiceTypeId;
  name: string;
  description: string;
  pricingModel: PricingModel;
  /**
   * Whose vehicle moves. `own_car` is what lets the app say "your car, our
   * driver" on the toggle instead of guessing from the service id.
   */
  vehicleOwnership: 'own_car' | 'fleet' | 'operator';
  allowsHourly: boolean;
  allowsScheduling: boolean;
  minDurationMinutes: number;
  iconKey: string;
  sortOrder: number;
  /** The zone the price comes from, so the app can say where a service is live. */
  zoneId: string;
  /**
   * Verified, currently-online drivers who can serve this service in its zone.
   * A count, never identities or coordinates — driver positions stay private
   * until an assignment exists.
   */
  driversOnline: number;
  /** Empty unless the service's rule sells packages. */
  tiers: BookingOptionTier[];
  /**
   * Packages for a round trip, read from the service's hourly rule. Null means
   * no round-trip price is configured, which is when the app hides the choice
   * rather than offering a trip it would refuse to price.
   */
  roundTripTiers: BookingOptionTier[] | null;
  /** The rate card behind `tiers`, from the rule that prices a one-way trip. */
  terms: BookingOptionTerms;
  /**
   * Terms for the round-trip rule, which is a different document and can carry
   * different taxes, night hours and minimums from the one-way one.
   */
  roundTripTerms: BookingOptionTerms | null;
};

/** A service that exists in the catalogue but cannot be booked today. */
export type BookingOptionUnavailable = {
  id: ServiceTypeId;
  name: string;
  /**
   * Why it is off, straight from the service document. Cabs are gated on
   * aggregator licensing, insurance and tax review, and a customer who sees a
   * greyed-out option is entitled to know what they are waiting for.
   */
  reason: string;
};

export type BookingOptionsResult = {
  /** Enabled, priced services a booking can actually be made against. */
  services: BookingOptionService[];
  /**
   * Modelled but not bookable, with the operator's own reason. Shown rather
   * than hidden so the app does not look like it lacks the feature.
   */
  unavailable: BookingOptionUnavailable[];
  /**
   * False while the fare is priced off a straight line between the two pins.
   * The booking screen has to show which of the two it is, because a customer
   * reading "21 km" off a map expects road kilometres.
   */
  routingIsRoadDistance: boolean;
};

export type CreateBookingResult = Omit<FareQuoteResult, 'distanceSource'> & {
  /**
   * Null only when the booking already existed and its creation event carries
   * no measurement record. A replayed request reports the fare that was
   * originally accepted instead of re-pricing, and it must not claim a distance
   * authority it cannot show.
   */
  distanceSource: RouteSource | null;
  bookingId: string;
  reference: string;
  status: BookingStatus;
  createdAtMs: number | null;
  /** True when this call replayed an earlier one with the same idempotency key. */
  deduplicated: boolean;
  rewardSnapshot: {
    couponCode: string | null;
    walletRedeemedPaise: number;
    milesRedeemedPoints: number;
    discountPaise: number;
    customerPayablePaise: number;
    driverSubsidyPaise: number;
  };
};

/**
 * The customer ended the trip. Returned as data rather than "ok" so the screen
 * can repeat back the time and the money — there is no fee to report, and that
 * has to be stated rather than left as an absent field.
 */
export type CancelBookingResult = {
  bookingId: string;
  reference: string;
  status: BookingStatus;
  /**
   * Null because the write uses a server timestamp; the client refetches the
   * booking document to render the real time.
   */
  cancelledAtMs: number | null;
  /**
   * The reason on the record, which for a second tap on an already-cancelled
   * trip is the one from the *first* call, not this one. Null when the booking
   * was closed by something other than a customer tapping Cancel — there are no
   * driver codes, because a driver cannot cancel.
   */
  reasonCode: CancellationReason | null;
  /**
   * Always zero today: nothing is collected when a booking is made, so there is
   * no money to forfeit. Whether a late cancellation should cost anything is an
   * open decision for the owner, not a gap in the engine.
   */
  feePaise: MoneyPaise;
  /**
   * True when the trip was already cancelled, so this call changed nothing and
   * the original reason stands. A double tap must not look like a failure.
   */
  alreadyCancelled: boolean;
  /**
   * True when a driver was attached at the moment of cancellation. The app uses
   * it to say "we told your driver" instead of implying one arrived.
   */
  hadDriverAssigned: boolean;
};

export type RecordDriverDuePaymentResult = {
  dueId: string;
  status: DriverDueStatus;
  /** The amount that was cleared, so the console repeats the number back. */
  totalPaise: MoneyPaise;
  /**
   * Charges still standing between this driver and their first booking. Zero is
   * the only number that lets `setDriverVerification` approve.
   */
  outstandingDues: number;
  auditLogId: string;
};
