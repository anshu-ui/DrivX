import { createHash } from 'node:crypto';
import type { HttpsError } from 'firebase-functions/v2/https';
import {
  computeFare,
  computeMeteredFare,
  FareError,
  listDistanceSlabs,
  listPackageTiers,
  type BookingOptionTerms,
  type FareBreakdown,
  type PricingRuleRecord,
  type ServiceTypeId,
  type ServiceTypeRecord,
  type TripDirection,
} from '@drivx/domain';
import { db, epochMs } from './admin';
import { failedPrecondition, invalidArgument, notFound } from './errors';

/**
 * The server-side pricing path.
 *
 * A pricing rule is deliberately unreadable by a client (`firestore.rules`
 * §pricingRules), so this module is the only place that turns a rule plus the
 * facts of a trip into a fare, and the only thing that hands a number to a
 * screen. The customer app renders whatever arrives here — it has no way to
 * recompute a total, which is the point.
 */

/** Stored form of `pricingSnapshotHash`; a receipt can be re-checked against the rule. */
const snapshotHash = (canonical: string): string => `sha256:${createHash('sha256').update(canonical).digest('hex')}`;

/**
 * Both launch zones are NCR, so one time zone covers them today. When a second
 * region is priced, this becomes a lookup on the zone document rather than a
 * default — the engine takes an hour, not a zone, on purpose.
 */
const ZONE_TIME_ZONES: Record<string, string> = {
  'zone-ggn-1': 'Asia/Kolkata',
  'zone-del-1': 'Asia/Kolkata',
};

export function localStartHour(ms: number, zoneId: string): number {
  const timeZone = ZONE_TIME_ZONES[zoneId] ?? 'Asia/Kolkata';
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hour12: false }).format(
    new Date(ms),
  );
  return Number.parseInt(hour, 10) % 24;
}

export function localStartMinute(ms: number, zoneId: string): number {
  const timeZone = ZONE_TIME_ZONES[zoneId] ?? 'Asia/Kolkata';
  const minute = new Intl.DateTimeFormat('en-GB', { timeZone, minute: 'numeric' }).format(new Date(ms));
  return Number.parseInt(minute, 10);
}

export type PricingContext = {
  serviceType: ServiceTypeRecord;
  rule: PricingRuleRecord;
};

/**
 * Firestore hands back Timestamps where the domain type says EpochMs, and it
 * hands back nothing at all for a field a rule was written before. Every read of
 * `pricingRules` goes through this one function: a rule that is normalised two
 * different ways is a fare that is computed two different ways.
 */
export function asRule(id: string, raw: Record<string, unknown>): PricingRuleRecord {
  if (
    raw.pricingModel !== 'distance' &&
    raw.pricingModel !== 'distance_slab' &&
    raw.pricingModel !== 'hourly_package'
  ) {
    throw failedPrecondition(
      `Pricing rule ${id} has no pricing model, so nothing can be priced against it. Re-run npm run seed.`,
    );
  }
  const night = (raw.nightSurcharge ?? {}) as Record<string, unknown>;
  const surge = (raw.surge ?? {}) as Record<string, unknown>;
  return {
    ...(raw as unknown as PricingRuleRecord),
    id,
    pricingVersion: Number.isInteger(Number(raw.pricingVersion)) && Number(raw.pricingVersion) > 0 ? Number(raw.pricingVersion) : 1,
    effectiveFromMs: epochMs(raw.effectiveFromMs),
    effectiveUntilMs: epochMs(raw.effectiveUntilMs),
    updatedAtMs: epochMs(raw.updatedAtMs),
    packages: Array.isArray(raw.packages) ? (raw.packages as PricingRuleRecord['packages']) : [],
    slabs: Array.isArray(raw.slabs) ? (raw.slabs as PricingRuleRecord['slabs']) : [],
    slabOverflowPerKmPaise: Number(raw.slabOverflowPerKmPaise ?? 0),
    // A rule written before the rounding rule existed billed the nearest tenth,
    // which is what that field's absence has to mean.
    distanceRounding: raw.distanceRounding === 'next_whole_km' ? 'next_whole_km' : 'one_decimal',
    nightSurcharge: {
      enabled: night.enabled === true,
      fromHour: Number(night.fromHour ?? 0),
      toHour: Number(night.toHour ?? 0),
      // Older rules carried a percentage and nothing else, so no mode means the
      // percentage the document already had.
      // Legacy production rules may still say `hourly`; DrivX now charges the
      // ₹200 night amount once per booking, so normalize that stored value here.
      mode: night.mode === 'flat' || night.mode === 'hourly' ? 'flat' : 'percent',
      flatPaise: Number(night.flatPaise ?? 0),
      rate: Number(night.rate ?? 0),
    },
    surge: {
      enabled: surge.enabled === true,
      maxMultiplier: Number(surge.maxMultiplier ?? 1),
    },
    minimumFarePaise: Number(raw.minimumFarePaise ?? 0),
  };
}

/**
 * Resolves a service type to the rule that prices it.
 *
 * A disabled service is refused here rather than at the rules layer, because the
 * rules already hide it from a list — the message a customer sees has to name
 * the reason, and only this read knows it.
 *
 * `tripDirection` chooses *which* rule prices it. A round trip is sold off the
 * service's hourly rule because the chauffeur and the car are committed for the
 * return leg; a service with no round-trip rule is refused outright rather than
 * quietly priced as a drop-off, which would be a different job at the wrong
 * price.
 */
export async function loadPricingContext(
  serviceTypeId: ServiceTypeId,
  tripDirection: TripDirection = 'one_way',
): Promise<PricingContext> {
  const fs = db();
  const serviceSnap = await fs.doc(`serviceTypes/${serviceTypeId}`).get();
  if (!serviceSnap.exists) {
    throw notFound(`Service "${serviceTypeId}" does not exist, so it cannot be booked.`);
  }
  const serviceRaw = serviceSnap.data() as Record<string, unknown>;
  if (serviceRaw.enabled !== true) {
    throw failedPrecondition(
      `${String(serviceRaw.name ?? serviceTypeId)} is not open for booking yet. ${String(serviceRaw.description ?? '')}`.trim(),
    );
  }

  const roundTripRuleId =
    typeof serviceRaw.roundTripPricingRuleId === 'string' ? serviceRaw.roundTripPricingRuleId : '';
  const ruleId =
    tripDirection === 'round_trip'
      ? roundTripRuleId
      : typeof serviceRaw.pricingRuleId === 'string'
        ? serviceRaw.pricingRuleId
        : '';

  if (!ruleId) {
    throw failedPrecondition(
      tripDirection === 'round_trip'
        ? `${String(serviceRaw.name ?? serviceTypeId)} cannot be booked as a round trip yet — no round-trip price is set for it.`
        : `Service type "${serviceTypeId}" has no pricing rule attached.`,
    );
  }
  const ruleSnap = await fs.doc(`pricingRules/${ruleId}`).get();
  if (!ruleSnap.exists) {
    throw notFound(`Pricing rule "${ruleId}" for ${serviceTypeId} is missing. Run npm run seed.`);
  }

  const rule = asRule(ruleId, ruleSnap.data() as Record<string, unknown>);
  return {
    serviceType: {
      ...(serviceRaw as unknown as ServiceTypeRecord),
      updatedAtMs: epochMs(serviceRaw.updatedAtMs),
    },
    rule,
  };
}

/**
 * The packages a round trip can be booked on and the terms behind them, or null
 * when the service has no round-trip rule. Read from that rule rather than the
 * one that prices a drop-off, so both the tier list and the rate card the screen
 * prints come from the rule the fare will be taken from.
 */
export async function loadRoundTripOffer(
  serviceType: ServiceTypeRecord,
): Promise<{ tiers: ReturnType<typeof offeredTiers>; terms: BookingOptionTerms } | null> {
  const ruleId =
    typeof serviceType.roundTripPricingRuleId === 'string' ? serviceType.roundTripPricingRuleId : '';
  if (!ruleId) return null;
  const snap = await db().doc(`pricingRules/${ruleId}`).get();
  if (!snap.exists) return null;
  const rule = asRule(ruleId, snap.data() as Record<string, unknown>);
  if (!rule.active) return null;
  const ctx = { serviceType, rule };
  return { tiers: offeredTiers(ctx), terms: publishedTerms(rule) };
}

export type PriceTripInput = {
  ctx: PricingContext;
  distanceMeters: number;
  durationSeconds: number;
  /** When the trip starts, because the night window is priced in local time. */
  departAtMs: number;
  packageTierId?: string | null;
  quoteId?: string | null;
  kind: 'estimate' | 'final';
  nowMs: number;
  /** Left at 1 until demand pricing exists; a client never supplies it. */
  surgeMultiplier?: number;
  waitingMinutes?: number;
};

/**
 * Runs the fare engine and translates its refusals into callable errors, so a
 * bad request fails with the reason instead of a stack trace in the log.
 */
export function priceTrip(input: PriceTripInput): FareBreakdown {
  const { ctx } = input;
  try {
    return computeFare({
      rule: ctx.rule,
      zoneId: ctx.rule.zoneId,
      distanceMeters: input.distanceMeters,
      durationSeconds: input.durationSeconds,
      waitingMinutes: input.waitingMinutes ?? 0,
      localStartHour: localStartHour(input.departAtMs, ctx.rule.zoneId),
      localStartMinute: localStartMinute(input.departAtMs, ctx.rule.zoneId),
      surgeMultiplier: input.surgeMultiplier ?? 1,
      packageTierId: input.packageTierId ?? null,
      quoteId: input.quoteId ?? null,
      kind: input.kind,
      nowMs: input.nowMs,
      hash: snapshotHash,
    });
  } catch (error) {
    throw fareRefusal(error, ctx.serviceType.name);
  }
}

/**
 * The same fare engine read off the odometer instead of the route.
 *
 * The quoted distance travels with it: the chart row the customer was priced on
 * stays theirs, and only the kilometres past that row's ceiling are metered.
 *
 * There is no service-type record at completion time — the trip already
 * happened — so the refusal names the rule the booking was priced on.
 */
export function meteredTrip(input: {
  rule: PricingRuleRecord;
  /** The quote the customer confirmed; carries the package tier. */
  quote: FareBreakdown;
  /** The distance that quote was priced on, from the booking. */
  quotedDistanceMeters: number | null;
  startOdometerKm: number;
  odometerKm: number;
  tripStartMs: number;
  /** Scheduled pickup controls the one-time night charge; actual start prices duration. */
  scheduledForMs?: number | null;
  waitingMinutes?: number;
  kind: 'estimate' | 'final';
  nowMs: number;
}): FareBreakdown {
  try {
    return computeMeteredFare({
      rule: input.rule,
      quote: input.quote,
      quotedDistanceMeters: input.quotedDistanceMeters,
      zoneId: input.rule.zoneId,
      startOdometerKm: input.startOdometerKm,
      odometerKm: input.odometerKm,
      tripStartMs: input.tripStartMs,
      localStartHour: localStartHour(input.scheduledForMs ?? input.tripStartMs, input.rule.zoneId),
      localStartMinute: localStartMinute(input.scheduledForMs ?? input.tripStartMs, input.rule.zoneId),
      waitingMinutes: input.waitingMinutes ?? 0,
      surgeMultiplier: 1,
      kind: input.kind,
      nowMs: input.nowMs,
      hash: snapshotHash,
    });
  } catch (error) {
    throw fareRefusal(error, `pricing rule ${input.rule.id}`);
  }
}

/**
 * Why the chart refused, in a sentence a customer can act on.
 *
 * A stale or missing tier is a bad request; a dead rule, an unconfigured chart
 * or a route the chart does not reach is the platform's problem, and the customer
 * should not be told they typed something wrong.
 */
function fareRefusal(error: unknown, subject: string): HttpsError {
  if (!(error instanceof FareError)) throw error;
  const message =
    error.code === 'tier_required'
      ? `${subject} is sold in hourly packages — choose one first.`
      : error.code === 'tier_unknown'
        ? 'That package is no longer on offer. Pick another.'
        : error.code === 'rule_inactive'
          ? `${subject} is not priced right now. Try again shortly.`
          : error.code === 'slabs_empty'
            ? `${subject} has no distance chart configured yet. Try again shortly.`
            : error.code === 'route_beyond_chart'
              ? 'This route is outside the automatic fare chart. Please request an Admin-reviewed written quote; automatic booking is unavailable.'
              : error.message;
  const refuse =
    error.code === 'rule_inactive' ||
    error.code === 'zone_mismatch' ||
    error.code === 'slabs_empty' ||
    error.code === 'route_beyond_chart'
      ? failedPrecondition
      : invalidArgument;
  return refuse(message);
}

/**
 * The tier list a customer may pick from, with the sticker price of each and the
 * rates that apply once the package runs out.
 */
export function offeredTiers(ctx: PricingContext) {
  return listPackageTiers(ctx.rule).map((tier) => ({
    id: tier.id,
    label: tier.label,
    hours: tier.hours,
    includedKilometers: tier.includedKilometers,
    packagePricePaise: tier.packagePricePaise,
    extraKmPaise: tier.extraKmPaise,
    extraHourPaise: tier.extraHourPaise,
  }));
}

/**
 * The published half of a rule: what a rate card needs to say, and nothing that
 * lets a device produce a total.
 *
 * `pricingRules` stay unreadable by clients. This projects the rates a customer
 * would otherwise have to book a trip to discover — per kilometre, per extra
 * hour, the night window, the free waiting minutes — while the arithmetic that
 * turns them into money stays in `computeFare` behind `quoteFare`.
 */
export function publishedTerms(rule: PricingRuleRecord): BookingOptionTerms {
  const night = rule.nightSurcharge;
  const chargesNight = night.enabled && (night.mode === 'flat' || night.mode === 'hourly' ? night.flatPaise > 0 : night.rate > 0);
  return {
    pricingRuleId: rule.id,
    gstRate: rule.gstRate,
    platformFeeRate: rule.platformFeeRate,
    // A package rule or a slab chart has no flat per-kilometre rate at all: the
    // first sells time, the second sells bands, and only a slab rule has a rate
    // past the end of its own table.
    perKmPaise: rule.pricingModel === 'distance' && rule.perKmPaise > 0 ? rule.perKmPaise : null,
    baseFarePaise: rule.baseFarePaise,
    slabs:
      rule.pricingModel === 'distance_slab'
        ? listDistanceSlabs(rule).map((slab) => ({
            upToKilometers: slab.upToKilometers,
            farePaise: slab.farePaise,
          }))
        : [],
    slabOverflowPerKmPaise:
      rule.pricingModel === 'distance_slab' && rule.slabOverflowPerKmPaise > 0
        ? rule.slabOverflowPerKmPaise
        : null,
    distanceRounding: rule.distanceRounding,
    includedWaitMinutes: rule.includedWaitMinutes,
    waitChargePerMinutePaise: rule.waitChargePerMinutePaise,
    minimumFarePaise: rule.minimumFarePaise,
    nightSurcharge: chargesNight
      ? {
          fromHour: night.fromHour,
          toHour: night.toHour,
          mode: night.mode,
          flatPaise: night.flatPaise,
          rate: night.rate,
        }
      : null,
    estimateValidityMinutes: rule.estimateValidityMinutes,
  };
}
