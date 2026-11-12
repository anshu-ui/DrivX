import type { EpochMs, MoneyPaise } from './common';
import type { DistanceRoundingMode } from './enums';
import type { DistanceSlab, HourlyPackageTier, PricingRuleRecord } from './records-identity';
import type { FareBreakdown, FareLineItem } from './records-trip';

/**
 * The fare engine. Pure and synchronous: it takes a pricing rule and the facts
 * of a trip and returns the breakdown, with no I/O, no clock and no randomness,
 * so the same inputs always produce the same paise. Callers supply `nowMs` and
 * the distance they measured; Cloud Functions are the only caller that matters,
 * because a fare a client can compute is a fare a client can set.
 *
 * ## Money
 *
 * Everything is integer paise. Each component is rounded once, half-up, and the
 * subtotal is the *sum of the rounded items* rather than a rounded sum — that
 * ordering is what makes `subtotalPaise === Σ items` true by construction, so a
 * receipt can be checked by adding it up. Tax sits outside the items for the
 * same reason: `totalPaise === subtotalPaise + taxPaise`.
 *
 * ## One charge per unit of usage
 *
 * A city one-way trip is priced off one **slab**: the row whose ceiling reaches
 * the distance the customer was quoted, and nothing else. The chart is a price
 * list, not a per-kilometre rate, so twelve kilometres is the "up to 15 km" row
 * and never three rows added together — and a metered bill keeps that row,
 * charging per kilometre only for the distance past the ceiling it covers.
 * An hourly package is the same promise from the other
 * side: the package price covers its hours and its kilometres, and only the
 * overage is metered — the included distance is not billed again as extra, and
 * time past the package is charged once, as overtime, not twice as waiting.
 *
 * ## Order of operation
 *
 * core (slab, package, or per-kilometre fare, plus overage and waiting) → night
 * surcharge → surge → minimum-fare top-up → platform fee → configured tax. Night and surge
 * both read the core fare, never each other, and the platform fee is charged on
 * the discounted-to-floor amount so a minimum fare cannot silently inflate the
 * commission.
 */

export type FareErrorCode =
  | 'rule_inactive'
  | 'zone_mismatch'
  | 'invalid_input'
  | 'tier_required'
  | 'tier_unknown'
  | 'tier_not_allowed'
  | 'surge_out_of_range'
  | 'slabs_empty'
  | 'route_beyond_chart';

export class FareError extends Error {
  readonly code: FareErrorCode;

  constructor(code: FareErrorCode, message: string) {
    super(message);
    this.name = 'FareError';
    this.code = code;
  }
}

export type FareComputation = {
  rule: PricingRuleRecord;
  /** The booking's zone; a rule from another zone is refused, not re-priced. */
  zoneId: string;
  distanceMeters: number;
  durationSeconds: number;
  /** Minutes the driver waited at pickup beyond the rule's included allowance. */
  waitingMinutes: number;
  /**
   * Local hour the trip started, 0–23, resolved by the caller from the zone's
   * IANA time zone. The engine deliberately does not own time-zone maths.
   */
  localStartHour: number;
  /** Local start minute, used to prorate a night window across the trip. */
  localStartMinute?: number;
  /** 1 for no surge. Must not exceed `rule.surge.maxMultiplier`. */
  surgeMultiplier: number;
  /** Required for an `hourly_package` rule, forbidden for any other model. */
  packageTierId?: string | null;
  /** Server-generated quote or accepted-price identifier. */
  quoteId?: string | null;
  /**
   * The distance the customer was quoted, when this is a metered bill rather than
   * that quote itself. A `distance_slab` chart is read at this distance and stays
   * there: kilometres the dial ran past it are metered per-km instead of moving
   * the trip onto a higher row. See `computeMeteredFare`.
   */
  quotedDistanceMeters?: number | null;
  kind: 'estimate' | 'final';
  nowMs: EpochMs;
  /**
   * Turns the canonical rule snapshot into the stored hash. Injected because
   * `node:crypto` is not available in the React Native bundle, and a hand-rolled
   * SHA-256 in the domain package is a correctness risk not worth taking.
   * Omit for a breakdown with a null snapshot hash.
   */
  hash?: SnapshotHasher;
};

/** Produces the stored form of `pricingSnapshotHash` for a canonical string. */
export type SnapshotHasher = (canonical: string) => string;

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 3600;
const METRES_PER_KM = 1000;
/** The granularity `one_decimal` rounding bills at: a tenth of a kilometre. */
const TENTH_KM_METRES = 100;

/** Half-up on paise. Pinned by a test so the tie-break is a decision, not drift. */
function paise(value: number): MoneyPaise {
  return Math.round(value);
}

function requireFinite(name: string, value: number, min = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new FareError('invalid_input', `${name} must be a finite number >= ${min}, got ${String(value)}`);
  }
  return value;
}

/** True when `hour` falls inside the rule's half-open `[from, to)` night window. */
export function isNightHour(hour: number, fromHour: number, toHour: number): boolean {
  // Equal bounds are a zero-length window, not "all day" — a rule that wants
  // every trip surcharged should set a rate on a real range instead.
  if (fromHour === toHour) return false;
  if (fromHour < toHour) return hour >= fromHour && hour < toHour;
  // Wraps midnight: 22 → 06 covers [22, 24) and [0, 6).
  return hour >= fromHour || hour < toHour;
}

/** `8` for ₹8.00, `12.50` for ₹12.50 — used in the detail string of a line item. */
function rupeesLabel(amountPaise: MoneyPaise): string {
  const value = amountPaise / 100;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** `12` for 12 000 m, `12.5` for 12 500 m — never `12.500000000000002`. */
function kilometresLabel(meters: number): string {
  const km = meters / METRES_PER_KM;
  return Number.isInteger(km) ? String(km) : km.toFixed(1);
}

function minutesLabel(seconds: number): string {
  return (seconds / MINUTE_SECONDS).toFixed(0);
}

/** `22:00` and `06:00`, so a night window on a receipt reads as a time. */
function clockLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/**
 * The distance the chart is read against, in whole metres.
 *
 * Rounding happens *before* pricing, on the metre count rather than on a float
 * kilometre value, so a route of 12 040 m is one number everywhere it is used:
 * the slab it lands in, the overflow past the chart, and the line printed on the
 * receipt. `next_whole_km` bills a part kilometre as a whole one; `one_decimal`
 * bills the nearest tenth.
 */
export function billableMetres(distanceMeters: number, mode: DistanceRoundingMode): number {
  if (mode === 'next_whole_km') {
    return Math.ceil(distanceMeters / METRES_PER_KM) * METRES_PER_KM;
  }
  return Math.round(distanceMeters / TENTH_KM_METRES) * TENTH_KM_METRES;
}

/** `m` metres at `perKmPaise` per kilometre, rounded once to the paisa. */
function priceMetres(m: number, perKmPaise: MoneyPaise): MoneyPaise {
  return paise((m * perKmPaise) / METRES_PER_KM);
}

/** Tiers of a rule in the order the customer should see them. */
export function listPackageTiers(rule: PricingRuleRecord): HourlyPackageTier[] {
  if (rule.pricingModel !== 'hourly_package') return [];
  return [...rule.packages].sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * The rule's slabs ordered by ceiling, which is what the engine actually prices
 * against. `sortOrder` is for the screen; a dashboard that saved the rows out of
 * order must not be able to price a 12 km trip at the 25 km row.
 */
export function listDistanceSlabs(rule: PricingRuleRecord): DistanceSlab[] {
  if (rule.pricingModel !== 'distance_slab') return [];
  return [...rule.slabs].sort((a, b) => a.upToKilometers - b.upToKilometers);
}

function resolveTier(rule: PricingRuleRecord, tierId: string | null | undefined): HourlyPackageTier {
  if (tierId === null || tierId === undefined || tierId === '') {
    throw new FareError('tier_required', `Rule ${rule.id} sells hourly packages and needs a packageTierId`);
  }
  const tier = rule.packages.find((t) => t.id === tierId);
  if (!tier) {
    throw new FareError('tier_unknown', `Rule ${rule.id} has no package tier "${tierId}"`);
  }
  return tier;
}

function assertRuleUsable(rule: PricingRuleRecord, zoneId: string, nowMs: EpochMs): void {
  if (!rule.active) {
    throw new FareError('rule_inactive', `Pricing rule ${rule.id} is not active`);
  }
  if (rule.effectiveFromMs !== null && nowMs < rule.effectiveFromMs) {
    throw new FareError('rule_inactive', `Pricing rule ${rule.id} is not effective until ${new Date(rule.effectiveFromMs).toISOString()}`);
  }
  if (rule.effectiveUntilMs !== null && nowMs >= rule.effectiveUntilMs) {
    throw new FareError('rule_inactive', `Pricing rule ${rule.id} lapsed at ${new Date(rule.effectiveUntilMs).toISOString()}`);
  }
  if (rule.zoneId !== zoneId) {
    throw new FareError('zone_mismatch', `Pricing rule ${rule.id} is priced for ${rule.zoneId}, not ${zoneId}`);
  }
  if (rule.currency !== 'INR') {
    throw new FareError('rule_inactive', `Pricing rule ${rule.id} is not an INR rule`);
  }
}

/**
 * The snapshot the stored hash covers: the rule values that actually moved the
 * number, serialised in a fixed field order. Key order is spelled out rather
 * than left to `JSON.stringify`, so two runs cannot disagree because a Firestore
 * read returned fields in a different sequence.
 *
 * `v4` adds Admin's tariff revision and overtime grace to the snapshot, alongside
 * the slab chart, overflow rate, distance rounding rule,
 * the flat night charge. A quote taken before them is still `v1` data and is read
 * from the booking's own stored breakdown, never recomputed here.
 */
export function canonicalFareSnapshot(rule: PricingRuleRecord, tier: HourlyPackageTier | null): string {
  const parts: (string | number | boolean | null)[] = [
    'v5',
    rule.id,
    rule.pricingVersion ?? 1,
    rule.pricingModel,
    rule.zoneId,
    rule.currency,
    rule.baseFarePaise,
    rule.perKmPaise,
    rule.perMinutePaise,
    rule.includedWaitMinutes,
    rule.waitChargePerMinutePaise,
    rule.overtimeGraceMinutes ?? 0,
    rule.platformFeeRate,
    rule.gstRate,
    rule.nightSurcharge.enabled,
    rule.nightSurcharge.fromHour,
    rule.nightSurcharge.toHour,
    rule.nightSurcharge.mode,
    rule.nightSurcharge.flatPaise,
    rule.nightSurcharge.rate,
    rule.surge.enabled,
    rule.surge.maxMultiplier,
    rule.minimumFarePaise,
    rule.distanceRounding,
    rule.slabOverflowPerKmPaise,
    // Slabs are priced in ceiling order, so the snapshot describes that order and
    // not whatever sequence a dashboard happened to write them in.
    listDistanceSlabs(rule)
      .map((slab) => `${slab.upToKilometers}:${slab.farePaise}`)
      .join(','),
  ];
  if (tier) {
    parts.push(tier.id, tier.hours, tier.includedKilometers, tier.packagePricePaise, tier.extraKmPaise, tier.extraHourPaise);
  }
  return parts.join('|');
}

/** True when the scheduled journey starts in, or is estimated to enter, the night window. */
function journeyOverlapsNightWindow(
  localStartHour: number,
  localStartMinute: number,
  durationSeconds: number,
  fromHour: number,
  toHour: number,
): boolean {
  if (fromHour === toHour) return false;
  if (isNightHour(localStartHour, fromHour, toHour)) return true;
  if (durationSeconds <= 0) return false;

  const startSeconds = localStartHour * HOUR_SECONDS + localStartMinute * MINUTE_SECONDS;
  const nextWindowStart = (fromHour * HOUR_SECONDS - startSeconds + 86_400) % 86_400 || 86_400;
  // A trip ending exactly at the window boundary has not spent time inside it.
  return durationSeconds > nextWindowStart;
}

/** The one-time night line, when the scheduled/estimated journey overlaps the window. */
function nightLine(
  rule: PricingRuleRecord,
  corePaise: MoneyPaise,
  localStartHour: number,
  localStartMinute: number,
  durationSeconds: number,
): FareLineItem | null {
  const night = rule.nightSurcharge;
  if (!night.enabled) return null;

  const window = `between ${clockLabel(night.fromHour)} and ${clockLabel(night.toHour)}`;
  if (night.mode === 'flat' || night.mode === 'hourly') {
    if (!journeyOverlapsNightWindow(localStartHour, localStartMinute, durationSeconds, night.fromHour, night.toHour)) return null;
    if (night.flatPaise <= 0) return null;
    return {
      key: 'night_surcharge',
      label: 'Night charge',
      amountPaise: paise(night.flatPaise),
      detail: isNightHour(localStartHour, night.fromHour, night.toHour)
        ? `Flat ₹${rupeesLabel(night.flatPaise)} for a departure ${window}`
        : `One-time ₹${rupeesLabel(night.flatPaise)} because the estimated journey overlaps ${window}`,
    };
  }
  if (night.rate <= 0 || !isNightHour(localStartHour, night.fromHour, night.toHour)) return null;
  if (night.rate <= 0) return null;
  return {
    key: 'night_surcharge',
    label: 'Night allowance',
    amountPaise: paise(corePaise * night.rate),
    detail: `${Math.round(night.rate * 100)}% of the fare ${window}`,
  };
}

export function computeFare(input: FareComputation): FareBreakdown {
  const { rule, kind, nowMs } = input;
  assertRuleUsable(rule, input.zoneId, nowMs);

  const distanceMeters = requireFinite('distanceMeters', input.distanceMeters);
  const durationSeconds = requireFinite('durationSeconds', input.durationSeconds);
  const waitingMinutes = requireFinite('waitingMinutes', input.waitingMinutes);
  const overtimeGraceMinutes = requireFinite('overtimeGraceMinutes', rule.overtimeGraceMinutes ?? 0);
  if (!Number.isInteger(overtimeGraceMinutes)) {
    throw new FareError('invalid_input', 'overtimeGraceMinutes must be a whole number of minutes');
  }
  const localStartHour = requireFinite('localStartHour', input.localStartHour);
  if (localStartHour > 23) {
    throw new FareError('invalid_input', `localStartHour must be 0–23, got ${localStartHour}`);
  }
  const localStartMinute = input.localStartMinute ?? 0;
  if (!Number.isInteger(localStartMinute) || localStartMinute < 0 || localStartMinute > 59) {
    throw new FareError('invalid_input', 'localStartMinute must be 0–59');
  }

  const surgeMultiplier = requireFinite('surgeMultiplier', input.surgeMultiplier, 1);
  if (surgeMultiplier > 1 && (!rule.surge.enabled || surgeMultiplier > rule.surge.maxMultiplier)) {
    throw new FareError(
      'surge_out_of_range',
      rule.surge.enabled
        ? `Surge ${surgeMultiplier}x exceeds rule ${rule.id} cap of ${rule.surge.maxMultiplier}x`
        : `Rule ${rule.id} has surge disabled but a ${surgeMultiplier}x multiplier was requested`,
    );
  }

  let tier: HourlyPackageTier | null = null;
  const items: FareLineItem[] = [];
  const billable = billableMetres(distanceMeters, rule.distanceRounding);

  if (rule.pricingModel === 'hourly_package') {
    tier = resolveTier(rule, input.packageTierId);

    items.push({
      key: 'package',
      label: tier.label,
      amountPaise: paise(tier.packagePricePaise),
      detail: tier.includedKilometers > 0
        ? `${tier.hours} ${tier.hours === 1 ? 'hour' : 'hours'} · ${tier.includedKilometers} km included`
        : `${tier.hours} ${tier.hours === 1 ? 'hour' : 'hours'} · billed by time`,
    });

    const extraMetres = Math.max(0, billable - tier.includedKilometers * METRES_PER_KM);
    if (extraMetres > 0 && tier.extraKmPaise > 0) {
      items.push({
        key: 'distance',
        label: 'Additional distance',
        amountPaise: priceMetres(extraMetres, tier.extraKmPaise),
        detail: `${kilometresLabel(extraMetres)} km beyond ${tier.includedKilometers} included × ₹${rupeesLabel(tier.extraKmPaise)}/km`,
      });
    }

    // Prorated by the minute: an hour and a half over a four-hour package costs
    // half the overtime rate, not a whole extra hour of it.
    const minutesUsed = Math.ceil(durationSeconds / MINUTE_SECONDS);
    const extraMinutes = Math.max(0, minutesUsed - tier.hours * 60 - overtimeGraceMinutes);
    if (extraMinutes > 0) {
      items.push({
        key: 'duration',
        label: 'Additional time',
        amountPaise: paise((extraMinutes * tier.extraHourPaise) / 60),
        detail: `${extraMinutes} min beyond ${tier.hours} hours × ₹${rupeesLabel(tier.extraHourPaise)}/hr`,
      });
    }
  } else if (rule.pricingModel === 'distance_slab') {
    if (input.packageTierId) {
      throw new FareError(
        'tier_not_allowed',
        `Rule ${rule.id} prices by distance slab and takes no package tier (got "${input.packageTierId}")`,
      );
    }
    const slabs = listDistanceSlabs(rule);
    if (slabs.length === 0) {
      throw new FareError('slabs_empty', `Pricing rule ${rule.id} sells distance slabs but has none configured.`);
    }
    const last = slabs[slabs.length - 1]!;

    // One row only, and it is chosen at the distance the customer was QUOTED, not
    // the distance the dial later showed: a metered bill cannot push the trip onto
    // a higher row than the price the customer confirmed. A shorter run keeps that
    // row too — the chart is a price list, so the shown price is what is paid
    // unless the car goes past the ceiling it covers.
    const priced =
      input.quotedDistanceMeters === null || input.quotedDistanceMeters === undefined
        ? billable
        : billableMetres(requireFinite('quotedDistanceMeters', input.quotedDistanceMeters), rule.distanceRounding);
    const slab = slabs.find((s) => priced <= s.upToKilometers * METRES_PER_KM) ?? last;
    items.push({
      key: 'slab_fare',
      label: `${rule.serviceTypeId === 'chauffeur_outstation' ? 'Outstation fare' : 'City fare'} up to ${slab.upToKilometers} km`,
      amountPaise: paise(slab.farePaise),
      detail: `${kilometresLabel(priced)} km charged on the ₹${rupeesLabel(slab.farePaise)} slab`,
    });

    // Kilometres past the ceiling this row covers are the only distance billed
    // twice, and they are metered at the rule's per-kilometre rate.
    const extraBasisMetres = input.quotedDistanceMeters === null || input.quotedDistanceMeters === undefined || priced > last.upToKilometers * METRES_PER_KM
      ? slab.upToKilometers * METRES_PER_KM
      : priced;
    const extraMetres = Math.max(0, billable - extraBasisMetres);
    if (extraMetres > 0) {
      if (rule.slabOverflowPerKmPaise <= 0) {
        // Refuse rather than extend a chart nobody priced: the alternative is a
        // customer confirming a number the owner never approved.
        throw new FareError(
          'route_beyond_chart',
          input.quotedDistanceMeters !== null && input.quotedDistanceMeters !== undefined && priced <= last.upToKilometers * METRES_PER_KM
            ? `Actual distance of ${kilometresLabel(billable)} km exceeds the ${kilometresLabel(priced)} km quoted on rule ${rule.id}, which sets no extra-distance rate`
            : `Route of ${kilometresLabel(billable)} km runs past the ${slab.upToKilometers} km priced on rule ${rule.id}, which sets no per-kilometre rate beyond it`,
        );
      }
      items.push({
        key: 'distance',
        label: 'Additional distance',
        amountPaise: priceMetres(extraMetres, rule.slabOverflowPerKmPaise),
        detail: `${kilometresLabel(extraMetres)} km beyond ${input.quotedDistanceMeters !== null && input.quotedDistanceMeters !== undefined && priced <= last.upToKilometers * METRES_PER_KM ? 'the quoted route' : `the ${slab.upToKilometers} km priced`} × ₹${rupeesLabel(rule.slabOverflowPerKmPaise)}/km`,
      });
    }
  } else {
    if (input.packageTierId) {
      throw new FareError(
        'tier_not_allowed',
        `Rule ${rule.id} prices by distance and takes no package tier (got "${input.packageTierId}")`,
      );
    }
    if (rule.baseFarePaise > 0) {
      items.push({
        key: 'base_fare',
        label: 'Base fare',
        amountPaise: paise(rule.baseFarePaise),
        detail: 'Charged on every trip',
      });
    }
    if (billable > 0) {
      items.push({
        key: 'distance',
        label: 'Distance',
        amountPaise: priceMetres(billable, rule.perKmPaise),
        detail: `${kilometresLabel(billable)} km × ₹${rupeesLabel(rule.perKmPaise)}/km`,
      });
    }
    if (durationSeconds > 0 && rule.perMinutePaise > 0) {
      items.push({
        key: 'duration',
        label: 'Time',
        amountPaise: paise((durationSeconds / MINUTE_SECONDS) * rule.perMinutePaise),
        detail: `${minutesLabel(durationSeconds)} min × ₹${rupeesLabel(rule.perMinutePaise)}/min`,
      });
    }
  }

  const billableWait = Math.max(0, waitingMinutes - rule.includedWaitMinutes);
  if (billableWait > 0 && rule.waitChargePerMinutePaise > 0) {
    items.push({
      key: 'waiting',
      label: 'Waiting time',
      amountPaise: paise(billableWait * rule.waitChargePerMinutePaise),
      detail: `${billableWait} min beyond ${rule.includedWaitMinutes} free × ₹${rupeesLabel(rule.waitChargePerMinutePaise)}/min`,
    });
  }

  // Night and surge both read the core fare, so neither compounds the other.
  const corePaise = items.reduce((sum, item) => sum + item.amountPaise, 0);

  const night = nightLine(rule, corePaise, localStartHour, localStartMinute, durationSeconds);
  if (night) items.push(night);

  if (surgeMultiplier > 1) {
    items.push({
      key: 'surge',
      label: 'Demand charge',
      amountPaise: paise(corePaise * (surgeMultiplier - 1)),
      detail: `${surgeMultiplier.toFixed(2)}× applied to the fare`,
    });
  }

  const preFeePaise = items.reduce((sum, item) => sum + item.amountPaise, 0);
  if (rule.minimumFarePaise > preFeePaise) {
    items.push({
      key: 'minimum_fare',
      label: 'Minimum fare',
      amountPaise: rule.minimumFarePaise - preFeePaise,
      detail: `Trip charged at the ₹${rupeesLabel(rule.minimumFarePaise)} minimum`,
    });
  }

  const afterMinimumPaise = Math.max(preFeePaise, rule.minimumFarePaise);
  if (rule.platformFeeRate > 0) {
    items.push({
      key: 'platform_fee',
      label: 'Platform fee',
      amountPaise: paise(afterMinimumPaise * rule.platformFeeRate),
      detail: `${Math.round(rule.platformFeeRate * 100)}% of the trip fare`,
    });
  }

  // Sum of the rounded items, so the receipt adds up exactly as printed.
  const subtotalPaise = items.reduce((sum, item) => sum + item.amountPaise, 0);
  const taxPaise = paise(subtotalPaise * rule.gstRate);

  return {
    currency: 'INR',
    items,
    subtotalPaise,
    taxPaise,
    totalPaise: subtotalPaise + taxPaise,
    pricingRuleId: rule.id,
    quoteId: input.quoteId ?? null,
    pricingVersion: rule.pricingVersion ?? 1,
    pricingSnapshotHash: input.hash ? input.hash(canonicalFareSnapshot(rule, tier)) : null,
    generatedAtMs: nowMs,
    expiresAtMs: kind === 'estimate' ? nowMs + rule.estimateValidityMinutes * MINUTE_SECONDS * 1000 : null,
    kind,
    packageTierId: tier ? tier.id : null,
  };
}

/**
 * Whether a stored quote is still the one the customer should see. A lapsed
 * quote is not silently re-priced in place — the UI has to ask for a new one,
 * because the alternative is a customer confirming a fare that no longer exists.
 */
export function isQuoteExpired(breakdown: FareBreakdown, nowMs: EpochMs): boolean {
  return breakdown.expiresAtMs !== null && nowMs >= breakdown.expiresAtMs;
}

/**
 * ## The metered fare — what the car actually ran
 *
 * The quote at booking time is priced on the route the map returned. The bill is
 * priced on the odometer: the driver reads the dial at pickup and again at the
 * drop, and the difference is the distance the customer actually ran. That is the
 * owner's rule, and it has a ceiling: the price shown for the mapped route is what
 * is paid, and only the kilometres *past the row that price covers* are metered,
 * at the rule's per-kilometre rate. A chauffeur job that wanders further than the
 * map said costs extra per km; one that comes back early is not re-priced onto a
 * cheaper row, because the customer confirmed a band, not a distance.
 *
 * Deliberately, this is not a second fare engine. It converts the dial readings
 * into the same `distanceMeters` and `durationSeconds` the quote was priced on,
 * hands `computeFare` the quoted distance so the chart stays locked, and calls it:
 * so the slab, included kilometres, overtime, waiting, the night window, the
 * minimum fare, the platform fee and configured tax all apply exactly as they did on
 * the estimate. The only thing a metered fare can differ from its quote in is the
 * extra distance and the time.
 *
 * Readings are whole kilometres because that is what a dial shows; storing them
 * in metres would be inventing a precision nobody has.
 */

/** A dial reading: a whole, non-negative number of kilometres. */
function requireOdometerKm(name: string, km: number): number {
  if (typeof km !== 'number' || !Number.isInteger(km) || km < 0) {
    throw new FareError('invalid_input', `${name} must be a whole number of kilometres >= 0, got ${String(km)}`);
  }
  return km;
}

/** Metres between two dial readings, refusing a closing reading below the opening. */
export function odometerRunMeters(startOdometerKm: number, odometerKm: number): number {
  const start = requireOdometerKm('startOdometerKm', startOdometerKm);
  const current = requireOdometerKm('odometerKm', odometerKm);
  if (current < start) {
    throw new FareError(
      'invalid_input',
      `Odometer reading ${current} km is below the ${start} km captured at pickup — the meter does not run backwards`,
    );
  }
  return (current - start) * METRES_PER_KM;
}

export type MeteredFareInput = {
  rule: PricingRuleRecord;
  /** The quote the customer confirmed; it carries the zone and the package tier. */
  quote: FareBreakdown;
  /**
   * The distance that quote was priced on, from the booking. A distance-slab bill
   * stays on that row and meters only what ran past it; null (a booking older than
   * the field) falls back to pricing the dial on the chart as a quote would.
   */
  quotedDistanceMeters: number | null;
  zoneId: string;
  /** Dial at pickup. */
  startOdometerKm: number;
  /** Dial now — the live reading mid-trip, the closing one for the final bill. */
  odometerKm: number;
  /** When the trip started, so a running fare grows with the clock too. */
  tripStartMs: EpochMs;
  localStartHour: number;
  localStartMinute?: number;
  waitingMinutes: number;
  surgeMultiplier: number;
  /** `final` for the bill at the drop; `estimate` for the live running meter. */
  kind: 'estimate' | 'final';
  nowMs: EpochMs;
  hash?: SnapshotHasher;
};

/**
 * The fare for a trip driven so far, or for a trip just finished.
 *
 * `nowMs` is both the clock and the end of the metered window, which is what
 * makes the number a customer watches mid-trip reconcile to the paise with the
 * receipt: same rule, same tier, same call, only a later `nowMs`.
 */
export function computeMeteredFare(input: MeteredFareInput): FareBreakdown {
  const durationSeconds = Math.max(0, Math.floor((input.nowMs - input.tripStartMs) / 1000));

  return computeFare({
    rule: input.rule,
    zoneId: input.zoneId,
    distanceMeters: odometerRunMeters(input.startOdometerKm, input.odometerKm),
    quotedDistanceMeters: input.quotedDistanceMeters,
    durationSeconds,
    waitingMinutes: input.waitingMinutes,
    localStartHour: input.localStartHour,
    localStartMinute: input.localStartMinute,
    surgeMultiplier: input.surgeMultiplier,
    packageTierId: input.quote.packageTierId,
    quoteId: input.quote.quoteId,
    kind: input.kind,
    nowMs: input.nowMs,
    hash: input.hash,
  });
}
