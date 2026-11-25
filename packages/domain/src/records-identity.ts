import type { EpochMs, Geofence, MoneyPaise, Place } from './common';
import type { FareLineItem } from './records-trip';
import type {
  AccountStatus,
  AttestableDueMethod,
  AvailabilityState,
  CarType,
  DistanceRoundingMode,
  DocumentType,
  DriverDueKind,
  DriverDueStatus,
  NightSurchargeMode,
  PricingModel,
  SavedPlaceLabel,
  ServiceTypeId,
  Transmission,
  VerificationStatus,
} from './enums';

/** users/{uid} — one row per Firebase Auth account, role claims mirrored. */
export type UserRecord = {
  uid: string;
  /** E.164, e.g. +919812345678. Unique; enforced by rules + a lookup doc. */
  phoneNumberE164: string;
  email: string | null;
  displayName: string | null;
  role: 'customer' | 'driver' | 'admin' | 'ops';
  accountStatus: AccountStatus;
  localeTag: string;
  /** IANA zone, e.g. Asia/Kolkata. */
  timeZone: string;
  fcmToken: string | null;
  createdAtMs: EpochMs | null;
  lastSignInAtMs: EpochMs | null;
  /** Set by a Cloud Function when account deletion is scheduled. */
  deletionScheduledAtMs: EpochMs | null;
};

/** customerProfiles/{uid} */
export type CustomerProfileRecord = {
  uid: string;
  fullName: string;
  /** Collected at sign-up so receipts and trip updates can be emailed. */
  email: string | null;
  /** Default pickup area; used to bias driver search and address predictions. */
  defaultPickup: Place | null;
  preferredTransmission: Transmission;
  preferredCarTypes: CarType[];
  contactPhoneE164: string;
  /** Consent flags surfaced in privacy controls (spec section 3). */
  privacy: {
    shareTripWithContact: boolean;
    marketingOptIn: boolean;
    preciseLocationWhileIdle: false;
  };
  /** Emergency contact used by trip sharing and the panic flow. */
  emergencyContact: {
    name: string | null;
    phoneE164: string | null;
    sharesLiveLocation: boolean;
  };
  ratingAverage: number | null;
  ratingCount: number;
  lifetimeBookings: number;
  createdAtMs: EpochMs | null;
  updatedAtMs: EpochMs | null;
};

/** driverProfiles/{uid} */
export type DriverProfileRecord = {
  uid: string;
  fullName: string;
  /** Contact email collected when the driver applies; private to staff and owner. */
  email?: string | null;
  phoneE164: string;
  /**
   * Storage path under `avatars/{uid}/` — the one image a customer is allowed to
   * see, which is why it is not the private `drivers/{uid}/driver_photograph` the
   * office reviews. Null until the driver files their photograph.
   */
  photoUrl: string | null;
  languages: string[];
  /** Serving area; dispatch only suggests drivers inside an enabled zone. */
  zoneId: string;
  serviceAreas: Geofence[];
  /**
   * The car the customer is told to look for, typed by the driver rather than
   * filed as a document — under "Safar aapka, driver hamara" the car is the
   * customer's own, so there is no RC or insurance certificate for the driver to
   * upload, but there is still a number plate they must be findable by.
   */
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehiclePlate: string | null;
  serviceTypeIds: ServiceTypeId[];
  /** Production bookings require `approved` (spec section 4). */
  verificationStatus: VerificationStatus;
  /** Server timestamp set only when the driver submits paid, complete paperwork. */
  applicationSubmittedAtMs?: EpochMs | null;
  verifiedAtMs: EpochMs | null;
  verifiedByUid: string | null;
  rejectionReason: string | null;
  /** Documents whose expiry is approaching, recomputed by a scheduled function. */
  documentsExpiringBeforeMs: EpochMs | null;
  /**
   * The reference the office hands out once a driver is activated, e.g.
   * `DRV-4K7QXA`. Minted by `setDriverVerification` on approval, never reused and
   * never derived from the uid, so a driver can be quoted on a paper slip or in a
   * message without anyone reading a Firestore id aloud.
   */
  driverId: string | null;
  availabilityState: AvailabilityState;
  availabilitySinceMs: EpochMs | null;
  /**
   * Which version of the duty agreement this driver agreed to, and when.
   *
   * A version rather than a checkbox, because the owner's rule is that a trip is
   * only *offered* after the terms are agreed — so when the office changes the
   * terms, dispatch has to be able to tell that this person agreed to the old
   * ones. Null means never; any other value means the driver agreed to words
   * that no longer apply. Written only by `acceptDutyTerms`.
   */
  dutyTermsVersion: string | null;
  dutyTermsAcceptedAtMs: EpochMs | null;
  /** Only aggregate rating is public; raw comments stay in `ratings`. */
  ratingAverage: number;
  ratingCount: number;
  lifetimeTrips: number;
  /** Percentage of accepted assignments completed on time, for admin reports. */
  onTimeArrivalRate: number | null;
  acceptanceRate: number | null;
  createdAtMs: EpochMs | null;
  updatedAtMs: EpochMs | null;
};

/**
 * driverProfiles/{uid}/documents/{documentId}
 * The file itself lives in Cloud Storage under a private path; only the
 * metadata pointer is stored here.
 */
export type DriverDocumentRecord = {
  id: string;
  driverUid: string;
  type: DocumentType;
  /** Storage object name, e.g. drivers/{uid}/dl/front.jpg */
  storagePath: string;
  sha256: string | null;
  status: VerificationStatus;
  /** Number the driver typed; never shown to other users. */
  numberMasked: string | null;
  issuedBy: string | null;
  validFromMs: EpochMs | null;
  validUntilMs: EpochMs | null;
  uploadedAtMs: EpochMs | null;
  reviewedAtMs: EpochMs | null;
  reviewedByUid: string | null;
  rejectionNote: string | null;
};

/**
 * driverProfiles/{uid}/dues/{dueId}
 *
 * Money a driver owes the platform, one document per charge. The id is derived,
 * never generated: `onboarding_fee` for the one-time charge, `commission_{bookingId}`
 * for a trip's remittance. That is what makes billing idempotent — however many
 * uploads, retries or triggers fire around a driver, there is exactly one row for
 * the fee and one row per booking.
 */
export type DriverDueRecord = {
  id: string;
  driverUid: string;
  kind: DriverDueKind;
  /** What the driver and the office both read the charge as. */
  title: string;
  /** The trip remittance came from; null for the one-time fee. */
  bookingId: string | null;
  currency: 'INR';
  /** The charge before tax. */
  basePaise: MoneyPaise;
  /**
   * The platform's cut this row was billed at, e.g. 0.13 — the office can change
   * the rate tomorrow and every issued row keeps the one it was raised with.
   * Null on the one-time fee, which has no rate.
   */
  rate: number | null;
  /** The fare that `rate` was applied to; null on the one-time fee. */
  commissionablePaise: MoneyPaise | null;
  /** Admin-configured tax fraction, stored per due row to preserve its history. */
  gstRate: number;
  gstPaise: MoneyPaise;
  /** Fare GST collected from the customer and passed through by the driver. */
  fareTaxPaise?: MoneyPaise;
  /** Effective fare GST rate captured from the completed fare snapshot. */
  fareTaxRate?: number;
  /** Route GST classification used for both fare and commission tax. */
  gstType?: GstType;
  /** Legacy field retained for previously recorded settlements. New rows use zero. */
  tdsBasePaise?: MoneyPaise;
  /** Legacy TDS rate, retained only to read older due rows. */
  tdsRate?: number;
  /** Legacy TDS amount, retained only to read older due rows. */
  tdsPaise?: MoneyPaise;
  /** Driver remittance: commission, commission GST and customer fare GST. */
  totalPaise: MoneyPaise;
  status: DriverDueStatus;
  /**
   * How the office took the money. Only ever written by `recordDriverDuePayment`,
   * and only for a method a person can see being paid — a gateway payment arrives
   * through the webhook, not from a console form.
   */
  method: AttestableDueMethod | null;
  /** UPI reference or note the collector typed in. */
  reference: string | null;
  /** The admin who recorded the collection; a driver can never write this row. */
  recordedByUid: string | null;
  recordedAtMs: EpochMs | null;
  createdAtMs: EpochMs | null;
  updatedAtMs: EpochMs | null;
};

/**
 * Default one-time charge for a new driver: ₹500 + 5% GST. The live value is
 * stored in `appConfig/onboardingFee`; these are only safe fallbacks.
 */
export const ONBOARDING_FEE = {
  /** Firestore doc id under `driverProfiles/{uid}/dues`. */
  dueId: 'onboarding_fee',
  kind: 'onboarding_fee' as DriverDueKind,
  title: 'One-time onboarding fee',
  basePaise: 50_000 as MoneyPaise,
  gstRate: 0.05,
};

/** Configured tax on the onboarding fee, rounded to the nearest paise. */
export const ONBOARDING_FEE_GST_PAISE = Math.round(
  ONBOARDING_FEE.basePaise * ONBOARDING_FEE.gstRate,
) as MoneyPaise;

/** ₹525 — default total a driver must clear before activation. */
export const ONBOARDING_FEE_TOTAL_PAISE = (ONBOARDING_FEE.basePaise +
  ONBOARDING_FEE_GST_PAISE) as MoneyPaise;

/**
 * The platform's share of every trip the driver actually completes.
 *
 * 13% of the **commissionable** fare plus 18% GST on that share. The rate here is
 * the fallback: the operator's own figure lives in `appConfig/commission` and is
 * read when a booking is created, so the trip keeps the rate it was quoted at
 * even after the office changes it. `commissionDueFor` and `commissionSnapshotFor`
 * both take the rate as an argument rather than reaching for a document, so this
 * object stays the only place a default is written down.
 *
 * The commissionable base is the fare subtotal, not the customer's tax line. Customer fare GST is passed through separately; TDS is currently disabled.
 */
export const COMMISSION_TERMS = {
  kind: 'commission' as DriverDueKind,
  /** The platform's cut of the trip fare, unless the office has configured another. */
  rate: 0.13,
  /** GST on the platform's commission. */
  gstRate: 0.18,
  /** TDS is currently disabled. */
  tdsRate: 0,
  title: 'Driver trip remittance',
};

/**
 * Fare lines the platform takes no cut of.
 *
 * `platform_fee` is the office's own charge, so billing commission on it would
 * mean the driver pays a share of a share. `cancellation_fee` is not a fare at
 * all — nobody drove. Tolls, parking and tips are deliberately absent from this
 * list because the fare engine never emits them: a customer pays them on the
 * spot, so they are outside the breakdown and therefore outside the base.
 * Anything that is not excluded — slab, package, extra distance, extra time,
 * waiting, night, surge, minimum-fare top-up — is the fare and is commissionable.
 */
export const NON_COMMISSIONABLE_FARE_LINES = ['platform_fee', 'cancellation_fee'] as const;

/** The part of a breakdown the commission is charged on, in paise. */
export function commissionablePaise(breakdown: {
  items: readonly Pick<FareLineItem, 'key' | 'amountPaise'>[];
  subtotalPaise: MoneyPaise;
}): MoneyPaise {
  const excluded = breakdown.items
    .filter((item) =>
      (NON_COMMISSIONABLE_FARE_LINES as readonly string[]).includes(item.key),
    )
    .reduce((sum, item) => sum + item.amountPaise, 0);
  return (breakdown.subtotalPaise - excluded) as MoneyPaise;
}

/** One trip's commission, exactly as the ledger will bill it and the driver will read it. */
export type CommissionSnapshot = {
  /** The rate this trip was billed at, not whatever the office sets tomorrow. */
  rate: number;
  gstRate: number;
  /** Customer fare GST, collected by the driver and remitted to DrivX. */
  fareTaxPaise?: MoneyPaise;
  /** Effective customer fare GST rate on this trip. */
  fareTaxRate?: number;
  /** Route tax treatment shared by the fare GST and the commission GST. */
  gstType?: GstType;
  /** Legacy TDS fraction, read from previously issued settlements only. */
  tdsRate?: number;
  /** Legacy field, retained for previously issued settlements. */
  tdsBasePaise?: MoneyPaise;
  /** Legacy TDS amount, retained for previously issued settlements. */
  tdsPaise?: MoneyPaise;
  /** The fare the rate was applied to — the subtotal minus every excluded line. */
  commissionablePaise: MoneyPaise;
  /** `rate × commissionablePaise`, rounded once. */
  basePaise: MoneyPaise;
  gstPaise: MoneyPaise;
  /** Commission + commission GST + customer fare GST. */
  totalPaise: MoneyPaise;
};

export type GstType = 'intra_state' | 'inter_state';

/** Normalize Google Places state strings before comparing pickup and drop. */
export function normalizedStateName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLocaleLowerCase('en-IN')
    .replace(/&/g, ' and ')
    .replace(/[.,]/g, '')
    .replace(/^state of\s+/, '')
    .replace(/\s+/g, ' ');
  const aliases: Record<string, string> = {
    'nct of delhi': 'delhi',
    'new delhi': 'delhi',
    orissa: 'odisha',
    uttaranchal: 'uttarakhand',
    pondicherry: 'puducherry',
  };
  return aliases[normalized] ?? normalized;
}

/** DrivX route GST rule: same pickup/drop state is intra-state; crossing states is IGST. */
export function gstTypeForRoute(pickupState: unknown, destinationState: unknown): GstType {
  const pickup = normalizedStateName(pickupState);
  const destination = normalizedStateName(destinationState);
  return pickup && destination && pickup === destination ? 'intra_state' : 'inter_state';
}

/** Split a GST amount in paise while preserving the exact total after rounding. */
export function gstComponentsFor(amountPaise: MoneyPaise | number, gstType: GstType): {
  cgstPaise: MoneyPaise;
  sgstPaise: MoneyPaise;
  igstPaise: MoneyPaise;
} {
  const amount = Math.max(0, Math.round(Number(amountPaise) || 0));
  if (gstType === 'intra_state') {
    const cgstPaise = Math.floor(amount / 2) as MoneyPaise;
    return { cgstPaise, sgstPaise: (amount - cgstPaise) as MoneyPaise, igstPaise: 0 as MoneyPaise };
  }
  return { cgstPaise: 0 as MoneyPaise, sgstPaise: 0 as MoneyPaise, igstPaise: amount as MoneyPaise };
}

/**
 * Commission, commission GST, customer fare GST, and legacy TDS rounded at paise.
 *
 * Rounding is `Math.round` at paise, matching the fare engine, and commission GST is
 * computed from the rounded commission rather than from the un-rounded product,
 * so each statement line adds to the amount the driver remits.
 */
export function commissionDueFor(
  fareBasePaise: MoneyPaise | number,
  rate: number = COMMISSION_TERMS.rate,
  gstRate: number = COMMISSION_TERMS.gstRate,
  fareTaxPaise: MoneyPaise | number = 0,
  tdsRate: number = COMMISSION_TERMS.tdsRate,
): {
  rate: number;
  basePaise: MoneyPaise;
  gstPaise: MoneyPaise;
  fareTaxPaise: MoneyPaise;
  tdsRate: number;
  tdsBasePaise: MoneyPaise;
  tdsPaise: MoneyPaise;
  totalPaise: MoneyPaise;
} {
  const basePaise = Math.round(Number(fareBasePaise) * rate) as MoneyPaise;
  const gstPaise = Math.round(basePaise * gstRate) as MoneyPaise;
  const tdsBasePaise = tdsRate > 0
    ? Math.max(0, Math.round(Number(fareBasePaise) - basePaise)) as MoneyPaise
    : 0 as MoneyPaise;
  const tdsPaise = Math.round(tdsBasePaise * tdsRate) as MoneyPaise;
  const fareTax = Math.max(0, Math.round(Number(fareTaxPaise))) as MoneyPaise;
  return {
    rate, basePaise, gstPaise, fareTaxPaise: fareTax, tdsRate, tdsBasePaise, tdsPaise,
    totalPaise: (basePaise + gstPaise + fareTax + tdsPaise) as MoneyPaise,
  };
}

/**
 * The commission terms of one quoted trip.
 *
 * Produced by the server at booking time and stored on the booking, so the
 * ledger, the driver's earnings screen and the office all read the *same* fare
 * and settlement snapshot instead of recomputing rates that may have moved since.
 */
export function commissionSnapshotFor(
  breakdown: {
    items: readonly Pick<FareLineItem, 'key' | 'amountPaise'>[];
    subtotalPaise: MoneyPaise;
    taxPaise: MoneyPaise;
  },
  rate: number = COMMISSION_TERMS.rate,
  gstRate: number = COMMISSION_TERMS.gstRate,
  tdsRate: number = COMMISSION_TERMS.tdsRate,
  gstType?: GstType,
): CommissionSnapshot {
  const base = commissionablePaise(breakdown);
  const { basePaise, gstPaise, fareTaxPaise, tdsBasePaise, tdsPaise, totalPaise } =
    commissionDueFor(base, rate, gstRate, breakdown.taxPaise, tdsRate);
  return {
    rate,
    gstRate,
    fareTaxPaise,
    fareTaxRate: breakdown.subtotalPaise > 0 ? Number(breakdown.taxPaise) / Number(breakdown.subtotalPaise) : 0,
    ...(gstType ? { gstType } : {}),
    tdsRate,
    tdsBasePaise,
    tdsPaise,
    commissionablePaise: base,
    basePaise,
    gstPaise,
    totalPaise,
  };
}

/**
 * `appConfig/commission` — the office's own cut, written only through a
 * privileged function. Absent or unusable, the default in `COMMISSION_TERMS`
 * applies.
 */
export const COMMISSION_CONFIG_DOC = 'commission';

/**
 * Whether a stored commission rate is one the engine will charge with.
 *
 * The document is edited by a person, so this is the boundary: a rate has to be
 * a finite fraction of the fare. Zero is legitimate (the office takes nothing),
 * and anything past 1 is not a commission but the whole fare, so it is refused
 * rather than billed.
 */
export function commissionRateFrom(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

/**
 * A commission block read back off a Firestore document.
 *
 * Null unless every number in it is finite and non-negative, because a partially
 * readable snapshot would let the ledger bill a figure nobody computed.
 */
export function readCommissionSnapshot(value: unknown): CommissionSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const rate = commissionRateFrom(row.rate);
  const gstRate = commissionRateFrom(row.gstRate);
  const paise = [row.commissionablePaise, row.basePaise, row.gstPaise, row.totalPaise].map(
    (field) => (typeof field === 'number' && Number.isFinite(field) && field >= 0 ? field : null),
  );
  if (rate === null || gstRate === null || paise.some((amount) => amount === null)) return null;
  const [commissionable, base, gst, total] = paise as [number, number, number, number];
  const tdsRate = row.tdsRate === undefined ? 0 : commissionRateFrom(row.tdsRate);
  const gstType = row.gstType === undefined
    ? null
    : row.gstType === 'intra_state' || row.gstType === 'inter_state' ? row.gstType : false;
  const fareTaxRate = row.fareTaxRate === undefined ? null : commissionRateFrom(row.fareTaxRate);
  const optionalPaise = (field: unknown): number | null => field === undefined
    ? null
    : typeof field === 'number' && Number.isFinite(field) && field >= 0 ? field : Number.NaN;
  const fareTaxPaise = optionalPaise(row.fareTaxPaise);
  const tdsBasePaise = optionalPaise(row.tdsBasePaise);
  const tdsPaise = optionalPaise(row.tdsPaise);
  if (tdsRate === null || gstType === false || (row.fareTaxRate !== undefined && fareTaxRate === null) || [fareTaxPaise, tdsBasePaise, tdsPaise].some((amount) => Number.isNaN(amount))) return null;
  // Legacy snapshots only recorded commission and its tax. New snapshots also
  // account for customer fare GST. Historical TDS remains readable, but new
  // terms set it to zero.
  const expectedTotal = base + gst + (fareTaxPaise ?? 0) + (tdsPaise ?? 0);
  if (expectedTotal !== total) return null;
  return {
    rate,
    gstRate,
    ...(fareTaxPaise === null ? {} : { fareTaxPaise: fareTaxPaise as MoneyPaise }),
    ...(fareTaxRate === null ? {} : { fareTaxRate }),
    ...(gstType === null ? {} : { gstType }),
    ...(tdsBasePaise === null ? {} : { tdsBasePaise: tdsBasePaise as MoneyPaise }),
    ...(row.tdsRate === undefined ? {} : { tdsRate }),
    ...(tdsPaise === null ? {} : { tdsPaise: tdsPaise as MoneyPaise }),
    commissionablePaise: commissionable as MoneyPaise,
    basePaise: base as MoneyPaise,
    gstPaise: gst as MoneyPaise,
    totalPaise: total as MoneyPaise,
  };
}

/** One trip remittance row per booking, keyed by its id so a retry cannot bill twice. */
export function commissionDueId(bookingId: string): string {
  return `commission_${bookingId}`;
}

/** The title on a trip remittance row, naming the trip it came from. */
export function commissionTitleFor(reference: string): string {
  return `Driver remittance for trip ${reference}`;
}

/** The fare and settlement amounts of a completed trip, in the order a driver reads them. */
export type DriverTripSplit = {
  /** What the customer paid, including any configured tax. */
  fareTotalPaise: MoneyPaise;
  /** Customer fare tax included in the fare total. */
  gstPaise: MoneyPaise;
  commissionBasePaise: MoneyPaise;
  commissionGstPaise: MoneyPaise;
  fareTaxPaise: MoneyPaise;
  fareTaxRate: number;
  gstType: GstType;
  fareCgstPaise: MoneyPaise;
  fareSgstPaise: MoneyPaise;
  fareIgstPaise: MoneyPaise;
  commissionCgstPaise: MoneyPaise;
  commissionSgstPaise: MoneyPaise;
  commissionIgstPaise: MoneyPaise;
  tdsBasePaise: MoneyPaise;
  tdsRate: number;
  tdsPaise: MoneyPaise;
  totalDuePaise: MoneyPaise;
  /** The rate this trip's commission was taken at, as it was billed. */
  rate: number;
  gstRate: number;
  /** Commission before GST, kept as a separate display line. */
  commissionPaise: MoneyPaise;
  /** What the driver keeps, in cash at the end of the trip. */
  netPaise: MoneyPaise;
};

/**
 * Splits one completed trip between the platform and the driver.
 *
 * Uses the trip's own stored snapshot rather than current Admin rates, so a
 * later rate change cannot rewrite the settlement. GST component amounts are
 * split by the route state pair. TDS is currently disabled.
 * A booking with no snapshot has no
 * honest number to show, so this returns null instead of assuming a rate.
 */
export function driverTripSplitFor(
  fare: {
    subtotalPaise: MoneyPaise;
    taxPaise: MoneyPaise;
    totalPaise: MoneyPaise;
  },
  commission: Pick<CommissionSnapshot,
    'rate' | 'gstRate' | 'totalPaise' | 'basePaise' | 'gstPaise' | 'commissionablePaise'
    | 'fareTaxPaise' | 'fareTaxRate' | 'tdsRate' | 'tdsBasePaise' | 'tdsPaise' | 'gstType'
  > | null | undefined,
  routeGstType?: GstType,
): DriverTripSplit | null {
  if (!commission) return null;
  const gstType = commission.gstType ?? routeGstType ?? 'inter_state';
  const fareTaxPaise = commission.fareTaxPaise ?? fare.taxPaise;
  const fareGst = gstComponentsFor(fareTaxPaise, gstType);
  const commissionGst = gstComponentsFor(commission.gstPaise, gstType);
  const tdsRate = commission.tdsRate ?? 0;
  const tdsBasePaise = commission.tdsBasePaise
    ?? (tdsRate > 0 ? Math.max(0, commission.commissionablePaise - commission.basePaise) as MoneyPaise : 0 as MoneyPaise);
  const tdsPaise = commission.tdsPaise ?? 0 as MoneyPaise;
  const totalDuePaise = commission.totalPaise + (commission.fareTaxPaise === undefined ? fare.taxPaise : 0);
  return {
    fareTotalPaise: fare.totalPaise,
    gstPaise: fare.taxPaise,
    rate: commission.rate,
    gstRate: commission.gstRate,
    commissionPaise: commission.basePaise,
    commissionBasePaise: commission.basePaise,
    commissionGstPaise: commission.gstPaise,
    fareTaxPaise,
    fareTaxRate: commission.fareTaxRate ?? (fare.subtotalPaise > 0 ? fare.taxPaise / fare.subtotalPaise : 0),
    gstType,
    fareCgstPaise: fareGst.cgstPaise,
    fareSgstPaise: fareGst.sgstPaise,
    fareIgstPaise: fareGst.igstPaise,
    commissionCgstPaise: commissionGst.cgstPaise,
    commissionSgstPaise: commissionGst.sgstPaise,
    commissionIgstPaise: commissionGst.igstPaise,
    tdsBasePaise,
    tdsRate,
    tdsPaise,
    totalDuePaise: totalDuePaise as MoneyPaise,
    netPaise: (fare.totalPaise - totalDuePaise) as MoneyPaise,
  };
}

/** serviceTypes/{id} — the seam that makes future cab booking additive. */
export type ServiceTypeRecord = {
  id: ServiceTypeId;
  name: string;
  description: string;
  /** Disabled services never appear in the customer app. */
  enabled: boolean;
  /** `own_car` = driver drives the customer's vehicle; `fleet` = cab mode. */
  vehicleOwnership: 'own_car' | 'fleet' | 'operator';
  /** Requires an approved driver profile before assignment. */
  requiresVerifiedDriver: boolean;
  allowsScheduling: boolean;
  allowsHourly: boolean;
  supportsCabFleet: boolean;
  /** Pricing rule that resolves the estimate for this service. */
  pricingRuleId: string;
  /**
   * Rule that prices a round trip, normally the zone's hourly package rule: the
   * chauffeur and the car are tied up for the return leg, so the day is what is
   * sold. Absent means the service cannot be booked as a round trip.
   */
  roundTripPricingRuleId?: string | null;
  pickupGeofence: Geofence;
  destinationGeofence: Geofence;
  /** Minimum GPS accuracy the arrival detector will accept, in metres. */
  maxArrivalAccuracyMeters: number;
  /** Sustained observations required before a geofence entry counts. */
  arrivalConsecutiveSamples: number;
  cancellationFreeWindowMinutes: number;
  minDurationMinutes: number;
  iconKey: string;
  sortOrder: number;
  updatedAtMs: EpochMs | null;
};

/**
 * One hourly package tier — the unit a customer actually buys for an hourly
 * booking. `hours` and `includedKilometers` are the promise; the two `extra*`
 * rates are what happens when the trip runs past it.
 */
export type HourlyPackageTier = {
  /** Stable id the booking references, e.g. `h4`. Renaming one is a data migration. */
  id: string;
  label: string;
  /** Booked length in whole hours. */
  hours: number;
  /** Kilometres carried by `packagePricePaise`. */
  includedKilometers: number;
  packagePricePaise: MoneyPaise;
  /** Per kilometre beyond `includedKilometers`. */
  extraKmPaise: MoneyPaise;
  /**
   * Per hour beyond `hours`, charged **pro rata by the minute**: on a ₹120/hr
   * rate, 30 extra minutes is ₹50 and one extra minute is ₹1.67. It is not a
   * "per started hour" rate, which would bill a minute over the same as an
   * hour over.
   */
  extraHourPaise: MoneyPaise;
  sortOrder: number;
};

/**
 * One band of the city one-way chart: every route that fits inside
 * `upToKilometers` costs `farePaise`, and only one slab is ever charged.
 *
 * The slabs are deliberately *not* cumulative. A route is priced using only the
 * first slab whose ceiling reaches its quoted distance; actual odometer distance
 * beyond the accepted quote follows the configured overflow rate. The engine picks
 * the first slab whose ceiling reaches
 * the billable distance and prices nothing else but the overflow beyond the last
 * slab, so the receipt a customer sees is the chart they were shown.
 */
export type DistanceSlab = {
  /** Upper bound of this band in kilometres, e.g. `10` for "over 5 up to 10 km". */
  upToKilometers: number;
  farePaise: MoneyPaise;
  /** Display order; the engine sorts by `upToKilometers` rather than trusting it. */
  sortOrder: number;
};

/** pricingRules/{id} — read-only to clients; only admin writes via functions. */
export type PricingRuleRecord = {
  id: string;
  /** Incremented by Admin whenever fare terms change; copied into quote receipts. */
  pricingVersion?: number;
  serviceTypeId: ServiceTypeId;
  zoneId: string;
  currency: 'INR';
  pricingModel: PricingModel;
  /** Charged the moment a booking enters `trip_started`. Zero for a pure per-km rule. */
  baseFarePaise: MoneyPaise;
  /** Only read by a `distance` rule; a `distance_slab` rule meters overflow at `slabOverflowPerKmPaise`. */
  perKmPaise: MoneyPaise;
  perMinutePaise: MoneyPaise;
  /** Free wait included after driver arrival. */
  includedWaitMinutes: number;
  waitChargePerMinutePaise: MoneyPaise;
  /** Grace minutes after a selected hourly package before overtime begins. */
  overtimeGraceMinutes?: number;
  /** Tax applied to the subtotal; set by Admin after review, default 0. */
  platformFeeRate: number;
  gstRate: number;
  nightSurcharge: {
    enabled: boolean;
    /**
     * Local hour range, half-open `[fromHour, toHour)`. When `fromHour` is the
     * larger of the two the window wraps midnight, which is what a 22→06 night
     * allowance means.
     */
    fromHour: number;
    toHour: number;
    /** `flat` and legacy `hourly` both charge `flatPaise` once when the journey overlaps the night window; `percent` charges a fare share. */
    mode: NightSurchargeMode;
    flatPaise: MoneyPaise;
    rate: number;
  };
  surge: {
    enabled: boolean;
    maxMultiplier: number;
  };
  /**
   * Floor on the pre-fee fare. A rule that genuinely has no floor sets 0; the
   * engine will not invent one.
   */
  minimumFarePaise: MoneyPaise;
  /**
   * Tiers for an `hourly_package` rule. Empty for a `distance` rule, which is
   * the honest representation of "this rule sells no packages" — the engine
   * refuses to guess a tier when the list is empty.
   */
  packages: HourlyPackageTier[];
  /**
   * The city one-way chart for a `distance_slab` rule, in any order — the engine
   * sorts it. Empty on any other model, where the engine never reads it.
   */
  slabs: DistanceSlab[];
  /**
   * Per kilometre past the highest slab's ceiling, so the chart can end at 40 km
   * and still price a 65 km route. Zero means a route longer than the last slab
   * is refused rather than guessed at.
   */
  slabOverflowPerKmPaise: MoneyPaise;
  /** How a billable distance is rounded before it is priced. */
  distanceRounding: DistanceRoundingMode;
  /** Fare estimate TTL; the client must re-quote after this window. */
  estimateValidityMinutes: number;
  active: boolean;
  effectiveFromMs: EpochMs | null;
  effectiveUntilMs: EpochMs | null;
  updatedByUid: string | null;
  updatedAtMs: EpochMs | null;
};

/** savedPlaces/{uid}/places/{placeId} */
export type SavedPlaceRecord = {
  id: string;
  uid: string;
  label: SavedPlaceLabel;
  name: string;
  place: Place;
  updatedAtMs: EpochMs | null;
};
