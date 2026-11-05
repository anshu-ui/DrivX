import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  fareQuoteInputSchema,
  type BookingOptionsResult,
  type FareQuoteInput,
  type FareQuoteResult,
  type Place,
  type ServiceTypeId,
  type TripDirection,
} from '@drivx/domain';
import { FunctionCallError, callFunction } from '@drivx/firebase-client';
import { COLLECTIONS } from '@drivx/domain';
import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore';
import { useSession } from '../auth/AuthProvider';
import { firebase } from '../../lib/firebase';

/**
 * The two reads that go through the server because the client is not allowed to
 * decide either answer.
 *
 * A price comes from `quoteFare`, and what can be sold comes from
 * `bookingOptions`. Neither has a client-side fallback: if the function refuses,
 * the screen shows the refusal rather than a number the device made up.
 */

export type QuoteFailure = { failed: true; error: FunctionCallError };

/** A callable error is data here, not a thrown exception — the UI renders it verbatim. */
export type QuoteOutcome =
  | { failed: false; quote: FareQuoteResult }
  | QuoteFailure;

/**
 * Departure choices that need no picker component and no fake precision.
 *
 * Every booking has a scheduled pickup at least 30 minutes ahead. There is no
 * immediate dispatch option, so customers can see the pickup time before they
 * confirm.
 */
export const DEPARTURE_OPTIONS = [
  { key: 'in30', label: 'In 30 minutes', offsetMinutes: 30 },
  { key: 'in2h', label: 'In 2 hours', offsetMinutes: 120 },
  { key: 'tomorrow', label: 'Tomorrow, 9:00 AM', offsetMinutes: null },
] as const;

export type DepartureKey = (typeof DEPARTURE_OPTIONS)[number]['key'];

/**
 * The same slot a customer picks by hand: a day from today, a 12-hour clock
 * value and a minute. India runs on one offset with no daylight saving, so a
 * schedule can be resolved without a timezone library — and it is resolved in
 * IST rather than the device's zone, because that is the zone the pricing rule
 * and its night surcharge read.
 */
export type ScheduleSlot = {
  offsetDays: number;
  hour12: number;
  minute: number;
  meridiem: 'am' | 'pm';
};

/** The first 15-minute IST slot that still meets the 30-minute notice window. */
export function nextScheduleSlot(nowMs: number): ScheduleSlot {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const totalMinutes = value('hour') * 60 + value('minute') + Math.ceil(value('second') / 60) + 30;
  const roundedMinutes = Math.ceil(totalMinutes / 15) * 15;
  const offsetDays = roundedMinutes >= 24 * 60 ? 1 : 0;
  const minuteOfDay = roundedMinutes % (24 * 60);
  const hour24 = Math.floor(minuteOfDay / 60);
  const hour12 = hour24 % 12 || 12;
  return {
    offsetDays,
    hour12,
    minute: minuteOfDay % 60,
    meridiem: hour24 >= 12 ? 'pm' : 'am',
  };
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Matches `createBookingInputSchema`: every pickup needs 30 minutes' notice. */
export const MIN_LEAD_MS = 30 * 60 * 1000;

/** End of the date six calendar months from today, measured in India time. */
export function latestBookingDateMs(nowMs: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const targetMonth = value('month') - 1 + 6;
  const targetYear = value('year') + Math.floor(targetMonth / 12);
  const month = targetMonth % 12;
  const targetDay = Math.min(value('day'), new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate());
  return Date.UTC(targetYear, month, targetDay + 1) - IST_OFFSET_MS - 1;
}

/** Midnight UTC of the IST calendar date `offsetDays` from now. */
function istDayStart(offsetDays: number, nowMs: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(pick('year'), pick('month') - 1, pick('day') + offsetDays);
}

export function hour24(slot: Pick<ScheduleSlot, 'hour12' | 'meridiem'>): number {
  const wrapped = slot.hour12 % 12;
  return slot.meridiem === 'pm' ? wrapped + 12 : wrapped;
}

/** The chosen slot as epoch ms. */
export function scheduledEpochMs(slot: ScheduleSlot, nowMs: number): number {
  return (
    istDayStart(slot.offsetDays, nowMs) +
    hour24(slot) * 60 * 60 * 1000 +
    slot.minute * 60 * 1000 -
    IST_OFFSET_MS
  );
}

/** "9:00 AM" — the form a customer expects an Indian booking screen to use. */
export function clockLabel(slot: Pick<ScheduleSlot, 'hour12' | 'minute' | 'meridiem'>): string {
  return `${slot.hour12}:${String(slot.minute).padStart(2, '0')} ${slot.meridiem === 'am' ? 'AM' : 'PM'}`;
}

export function dayLabel(offsetDays: number): string {
  return offsetDays === 0 ? 'Today' : offsetDays === 1 ? 'Tomorrow' : '';
}

export type ScheduleDay = { offsetDays: number; label: string };

export type CalendarMonth = {
  label: string;
  firstWeekday: number;
  days: { offsetDays: number; day: number }[];
};

/** Month grid for the six-calendar-month booking window, using India-local dates. */
export function scheduleCalendarMonth(nowMs: number, monthOffset: number): CalendarMonth {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const year = value('year');
  const month = value('month') - 1 + monthOffset;
  const first = new Date(Date.UTC(year, month, 1));
  const dayCount = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const todayStart = istDayStart(0, nowMs);
  return {
    label: new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first),
    firstWeekday: first.getUTCDay(),
    days: Array.from({ length: dayCount }, (_, index) => {
      const day = index + 1;
      const calendarDayStart = Date.UTC(year, month, day);
      return { day, offsetDays: Math.round((calendarDayStart - todayStart) / 86_400_000) };
    }),
  };
}

/** The dates the schedule panel offers, labelled in IST. */
export function upcomingDays(nowMs: number, count = 90): ScheduleDay[] {
  const weekday = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  return Array.from({ length: count }, (_, offsetDays) => ({
    offsetDays,
    label: dayLabel(offsetDays) || weekday.format(new Date(istDayStart(offsetDays, nowMs))),
  }));
}

/** False once the slot is far enough ahead for the backend to accept it. */
export function slotIsTooSoon(slot: ScheduleSlot, nowMs: number): boolean {
  return scheduledEpochMs(slot, nowMs) < nowMs + MIN_LEAD_MS;
}

/**
 * Resolves a departure choice to epoch ms in IST.
 */
export function departureAt(key: DepartureKey, nowMs: number): number | null {
  if (key === 'in30') return scheduledEpochMs(nextScheduleSlot(nowMs), nowMs);
  if (key === 'in2h') return nowMs + 120 * 60 * 1000;
  return scheduledEpochMs({ offsetDays: 1, hour12: 9, minute: 0, meridiem: 'am' }, nowMs);
}

/**
 * A clock for the quote countdown.
 *
 * Only a quote's *expiry* is compared against it. The price and the moment it
 * was issued come from the server, so a wrong device clock can shorten the
 * remaining time but cannot bring a lapsed fare back.
 */
export function useNowMs(intervalMs: number = 15_000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return nowMs;
}

/** Services the customer may book, plus the ones that exist but cannot. */
export function useBookingOptions() {
  const { user } = useSession();
  return useQuery({
    queryKey: ['bookingOptions', user?.uid ?? 'anon'],
    enabled: Boolean(user),
    // Prices are editable from Admin. Refresh the published rate card while
    // the booking screen is open so an installed app sees changes promptly;
    // quoteFare still reads the authoritative rule on the server every time.
    staleTime: 0,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      try {
        const data = await callFunction<Record<string, never>, BookingOptionsResult>(
          firebase(),
          'bookingOptions',
          {},
        );
        return { failed: false as const, options: data };
      } catch (error) {
        if (error instanceof FunctionCallError) return { failed: true as const, error };
        throw error;
      }
    },
  });
}

/**
 * The enabled catalogue is safe for signed-in customers to read directly.
 * It keeps service choices visible when the callable gateway is unavailable;
 * it never contains prices and cannot be used to quote or create a booking.
 */
export function useEnabledServiceCatalogue() {
  const { user } = useSession();
  return useQuery({
    queryKey: ['enabledServiceCatalogue', user?.uid ?? 'anon'],
    enabled: Boolean(user),
    staleTime: 60_000,
    queryFn: async () => {
      const snapshot = await getDocs(query(
        collection(firebase().firestore, COLLECTIONS.serviceTypes),
        where('enabled', '==', true),
        orderBy('sortOrder', 'asc'),
        limit(25),
      ));
      return snapshot.docs.map((row) => ({
        id: row.id as ServiceTypeId,
        name: String(row.data().name ?? row.id),
      }));
    },
  });
}

/**
 * Everything a quote needs, before it is assembled into the callable's input.
 *
 * The places are keyed by their coordinates rather than an id because a saved
 * place can be edited, and a fare must be priced off what is on screen now.
 */
export type TripDraft = {
  serviceTypeId: ServiceTypeId | null;
  pickup: Place | null;
  destination: Place | null;
  scheduledForMs: number | null;
  packageTierId: string | null;
  /** Decides which pricing rule the server quotes against. */
  tripDirection: TripDirection;
};

/**
 * Stable identity for a draft: the same string the quote is cached under.
 *
 * Exported because the screen has to tell two kinds of price change apart — a
 * different trip, which is expected, and the *same* trip quoted at a different
 * number, which is the one a customer has to be told about before they confirm.
 */
export function tripIdentity(draft: TripDraft): string {
  const { pickup, destination } = draft;
  if (!pickup || !destination || !draft.serviceTypeId) return 'incomplete';
  return [
    draft.serviceTypeId,
    draft.tripDirection,
    draft.packageTierId ?? '-',
    draft.scheduledForMs ?? 'now',
    pickup.location.lat.toFixed(5),
    pickup.location.lng.toFixed(5),
    destination.location.lat.toFixed(5),
    destination.location.lng.toFixed(5),
  ].join('|');
}

export function useFareQuote(draft: TripDraft) {
  const { user } = useSession();

  const input: FareQuoteInput | null = (() => {
    if (!draft.serviceTypeId || !draft.pickup || !draft.destination) return null;
    const parsed = fareQuoteInputSchema.safeParse({
      serviceTypeId: draft.serviceTypeId,
      tripDirection: draft.tripDirection,
      pickup: draft.pickup,
      destination: draft.destination,
      scheduledForMs: draft.scheduledForMs,
      packageTierId: draft.packageTierId ?? undefined,
    });
    // A draft the client's own schema rejects is never sent: the server would
    // reject it too, and the screen would show a spinner for a doomed request.
    return parsed.success ? parsed.data : null;
  })();

  return useQuery({
    queryKey: ['fareQuote', user?.uid ?? 'anon', tripIdentity(draft)],
    enabled: input !== null && Boolean(user),
    staleTime: 20_000,
    queryFn: async (): Promise<QuoteOutcome> => {
      try {
        const quote = await callFunction<FareQuoteInput, FareQuoteResult>(
          firebase(),
          'quoteFare',
          input!,
        );
        return { failed: false, quote };
      } catch (error) {
        if (error instanceof FunctionCallError) return { failed: true, error };
        throw error;
      }
    },
  });
}
