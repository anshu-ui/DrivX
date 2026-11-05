import {
  formatINR,
  type BookingStatus,
  type CancellationReason,
  type DriverRatingTag,
  type MoneyPaise,
  type SupportCategory,
} from '@drivx/domain';

/** Plain-language status copy. Kept out of the components so the list and detail agree. */
const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  requested: 'Request received',
  searching_driver: 'Finding a driver',
  assigned: 'Driver assigned',
  driver_en_route: 'Driver on the way',
  driver_arrived: 'Driver has arrived',
  trip_started: 'Trip started',
  in_progress: 'On the road',
  destination_reached: 'Arrived at destination',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'Driver did not show',
  expired: 'Expired',
};

export function statusLabel(status: BookingStatus): string {
  return BOOKING_STATUS_LABEL[status] ?? status;
}

const STATUS_TONE: Partial<Record<BookingStatus, 'success' | 'warning' | 'danger' | 'info' | 'brand'>> = {
  completed: 'success',
  cancelled: 'danger',
  no_show: 'danger',
  expired: 'danger',
  driver_en_route: 'info',
  driver_arrived: 'brand',
  trip_started: 'brand',
  in_progress: 'brand',
};

export function statusTone(status: BookingStatus) {
  return STATUS_TONE[status] ?? 'neutral';
}

/** True while a booking is still live rather than finished. */
export function isLive(status: BookingStatus): boolean {
  return status !== 'completed' && status !== 'cancelled' && status !== 'no_show' && status !== 'expired';
}

export function money(paise: MoneyPaise | null | undefined): string {
  return typeof paise === 'number' ? formatINR(paise) : '—';
}

export function addressLine(place: { label: string; city?: string } | null): string {
  if (!place) return 'Not set';
  return place.city ? `${place.label} · ${place.city}` : place.label;
}

export function dateTime(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  });
}

/** The customer's own reason for cancelling, in their words rather than the code. */
export const CANCELLATION_REASON_LABEL: Record<CancellationReason, string> = {
  plan_changed: 'My plan changed',
  wrong_details: 'I booked the wrong pickup or drop',
  waited_too_long: 'The wait was too long',
  found_alternative: 'I found another ride',
  fare_too_high: 'The fare was more than I expected',
  other: 'Something else',
};

/** A stored code is shown even if the app no longer offers it, so an old trip never reads as blank. */
export function cancellationReasonLabel(code: string | null): string | null {
  if (!code) return null;
  return (CANCELLATION_REASON_LABEL as Record<string, string>)[code] ?? code.replace(/_/g, ' ');
}

/**
 * The chips a customer can tick under their stars.
 *
 * The words are written as completions of "He…" because that is how the panel
 * reads them, and the same set is what the server's notification assembles its
 * sentence from — a tag outside this list is refused by the schema before it
 * reaches Firestore.
 */
export const DRIVER_RATING_TAG_LABEL: Record<DriverRatingTag, string> = {
  drove_carefully: 'drove carefully',
  knew_the_route: 'knew the route',
  arrived_on_time: 'arrived on time',
  polite: 'was polite',
  helped_with_luggage: 'helped with the luggage',
  car_was_clean: 'kept the car clean',
};

/** A stored tag is shown even if the app stops offering it, so an old rating never reads as blank. */
export function ratingTagLabel(tag: string): string {
  return (DRIVER_RATING_TAG_LABEL as Record<string, string>)[tag] ?? tag.replace(/_/g, ' ');
}

export const SUPPORT_CATEGORY_LABEL: Record<SupportCategory, string> = {
  trip_issue: 'Trip issue',
  fare_dispute: 'Fare dispute',
  driver_conduct: 'Driver conduct',
  lost_item: 'Lost item',
  payment: 'Payment',
  cancellation: 'Cancellation',
  account: 'Account',
  emergency_follow_up: 'Safety follow-up',
};

/**
 * Language codes → the name a passenger reads.
 *
 * Stored as a short code on the driver's profile and shown spelled out on the
 * customer's driver card, so one table serves both. Kept here because the
 * customer screen and the driver's Account screen must not call the same
 * language two different names.
 */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  pa: 'Punjabi',
  ur: 'Urdu',
  bn: 'Bengali',
  mr: 'Marathi',
  ta: 'Tamil',
  te: 'Telugu',
  ml: 'Malayalam',
  gu: 'Gujarati',
  as: 'Assamese',
  or: 'Odia',
  ne: 'Nepali',
  sd: 'Sindhi',
  ks: 'Kashmiri',
};

export function languageLabel(code: string): string {
  return LANGUAGE_NAMES[code.toLowerCase()] ?? code;
}

/** The codes a driver may pick from — the ones a Delhi NCR trip is asked for. */
export const LANGUAGES_OFFERED = ['en', 'hi', 'pa', 'ur', 'bn', 'mr', 'ta', 'te', 'gu'];

