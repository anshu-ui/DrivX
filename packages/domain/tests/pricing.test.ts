import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  billableMetres,
  canonicalFareSnapshot,
  computeFare,
  computeMeteredFare,
  FareError,
  isNightHour,
  isQuoteExpired,
  listDistanceSlabs,
  listPackageTiers,
  odometerRunMeters,
  type FareComputation,
  type MeteredFareInput,
} from '../src/pricing';
import type { DistanceSlab, HourlyPackageTier, PricingRuleRecord } from '../src/records-identity';
import type { FareBreakdown, FareLineItem } from '../src/records-trip';

const NOW = Date.UTC(2026, 9, 20, 10, 0, 0);
/** `durationSeconds` is seconds; the timestamp maths below is milliseconds. */
const HOUR = 3_600;
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

/**
 * The city one-way chart the owner approved, in paise: one row per distance
 * band, ₹179 up to 5 km through ₹559 up to 40 km; metered overflow is ₹12/km.
 */
const CITY_CHART: DistanceSlab[] = [
  [5, 179], [10, 229], [15, 289], [20, 345], [25, 399], [30, 459], [40, 559],
].map(([upToKilometers, rupees], index) => ({ upToKilometers: upToKilometers!, farePaise: rupees! * 100, sortOrder: index + 1 }));

/** Existing local round-trip prices, one-hour increments through 12 hours. */
function tier(overrides: Partial<HourlyPackageTier> = {}): HourlyPackageTier {
  return {
    id: 'h4',
    label: '4 hours',
    hours: 4,
    includedKilometers: 0,
    packagePricePaise: 59_000,
    extraKmPaise: 0,
    extraHourPaise: 12_000,
    sortOrder: 1,
    ...overrides,
  };
}

function slabRule(overrides: Partial<PricingRuleRecord> = {}): PricingRuleRecord {
  return {
    id: 'ggn-city-one-way',
    serviceTypeId: 'chauffeur_own_car',
    zoneId: 'zone-ggn-1',
    currency: 'INR',
    pricingModel: 'distance_slab',
    baseFarePaise: 0,
    perKmPaise: 0,
    perMinutePaise: 0,
    includedWaitMinutes: 10,
    waitChargePerMinutePaise: 0,
    platformFeeRate: 0,
    gstRate: 0.05,
    nightSurcharge: { enabled: true, fromHour: 22, toHour: 6, mode: 'flat', flatPaise: 15_000, rate: 0 },
    surge: { enabled: true, maxMultiplier: 1.5 },
    minimumFarePaise: 0,
    packages: [],
    slabs: CITY_CHART,
    slabOverflowPerKmPaise: 1_200,
    distanceRounding: 'one_decimal',
    estimateValidityMinutes: 15,
    active: true,
    effectiveFromMs: null,
    effectiveUntilMs: null,
    updatedByUid: null,
    updatedAtMs: null,
    ...overrides,
  };
}

/** The flat per-kilometre model an outstation rule still uses. */
function distanceRule(overrides: Partial<PricingRuleRecord> = {}): PricingRuleRecord {
  return slabRule({
    id: 'ggn-outstation-per-km',
    serviceTypeId: 'chauffeur_outstation',
    pricingModel: 'distance',
    slabs: [],
    slabOverflowPerKmPaise: 0,
    perKmPaise: 800,
    waitChargePerMinutePaise: 300,
    ...overrides,
  });
}

function hourlyRule(overrides: Partial<PricingRuleRecord> = {}): PricingRuleRecord {
  return slabRule({
    id: 'ggn-chauffeur-hourly',
    serviceTypeId: 'chauffeur_hourly',
    pricingModel: 'hourly_package',
    slabs: [],
    slabOverflowPerKmPaise: 0,
    includedWaitMinutes: 0,
    nightSurcharge: { enabled: false, fromHour: 22, toHour: 6, mode: 'flat', flatPaise: 0, rate: 0 },
    packages: [
      tier({ id: 'h1', label: '1 hour', hours: 1, includedKilometers: 0, packagePricePaise: 14_900, extraKmPaise: 1_000, sortOrder: 1 }),
      tier({ id: 'h2', label: '2 hours', hours: 2, includedKilometers: 0, packagePricePaise: 27_900, extraKmPaise: 1_000, sortOrder: 2 }),
      tier({ id: 'h4', label: '4 hours', hours: 4, includedKilometers: 40, packagePricePaise: 44_900, extraKmPaise: 1_000, sortOrder: 4 }),
      tier({ id: 'h8', label: '8 hours', hours: 8, includedKilometers: 80, packagePricePaise: 79_900, extraKmPaise: 1_000, sortOrder: 8 }),
      tier({ id: 'h12', label: '12 hours', hours: 12, includedKilometers: 120, packagePricePaise: 109_900, extraKmPaise: 1_000, sortOrder: 12 }),
    ],
    ...overrides,
  });
}

function quote(overrides: Partial<FareComputation> = {}): FareComputation {
  return {
    rule: slabRule(),
    zoneId: 'zone-ggn-1',
    distanceMeters: 12_400,
    durationSeconds: 45 * 60,
    waitingMinutes: 0,
    localStartHour: 14,
    surgeMultiplier: 1,
    packageTierId: null,
    kind: 'estimate',
    nowMs: NOW,
    ...overrides,
  };
}

function itemOf(breakdown: FareBreakdown, key: FareLineItem['key']): FareLineItem {
  const found = breakdown.items.find((i) => i.key === key);
  if (!found) throw new Error(`no "${key}" line in ${JSON.stringify(breakdown.items)}`);
  return found;
}

function keys(breakdown: FareBreakdown): FareLineItem['key'][] {
  return breakdown.items.map((i) => i.key);
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof FareError) return error.code;
    throw error;
  }
  throw new Error('expected the fare computation to throw');
}

describe('city one-way distance slabs', () => {
  it.each([
    [4_800, 'up to 5 km', 17_900],
    [8_400, 'up to 10 km', 22_900],
    [12_400, 'up to 15 km', 28_900],
    [17_000, 'up to 20 km', 34_500],
    [22_000, 'up to 25 km', 39_900],
    [28_500, 'up to 30 km', 45_900],
    [36_000, 'up to 40 km', 55_900],
  ] as Array<[number, string, number]>)(
    'charges the one slab a %jm route falls in and nothing else',
    (metres, band, farePaise) => {
      const breakdown = computeFare(quote({ distanceMeters: metres }));
      expect(keys(breakdown)).toEqual(['slab_fare']);
      expect(itemOf(breakdown, 'slab_fare').label).toBe(`City fare ${band}`);
      expect(itemOf(breakdown, 'slab_fare').amountPaise).toBe(farePaise);
    },
  );


  it.each([
    [5_000, 17_900], [5_100, 22_900],
    [10_000, 22_900], [10_100, 28_900],
    [15_000, 28_900], [15_100, 34_500],
    [20_000, 34_500], [20_100, 39_900],
    [25_000, 39_900], [25_100, 45_900],
    [30_000, 45_900], [30_100, 55_900],
    [40_000, 55_900], [40_100, 55_900],
  ])('keeps exact and next-tenth boundary %jm in one configured slab', (metres, expected) => {
    const result = computeFare(quote({ distanceMeters: metres }));
    const slab = itemOf(result, 'slab_fare');
    expect(slab.amountPaise).toBe(expected);
    if (metres === 40_100) expect(result.subtotalPaise).toBe(56_020);
  });

  it('never stacks the rows a route passes through', () => {
    // A 12.4 km drive is the ₹289 row, not a sum of earlier bands.
    const breakdown = computeFare(quote({ distanceMeters: 12_400 }));
    expect(breakdown.subtotalPaise).toBe(28_900);
    expect(breakdown.items).toHaveLength(1);
  });

  it('reads its own row at each boundary', () => {
    expect(itemOf(computeFare(quote({ distanceMeters: 5_000 })), 'slab_fare').amountPaise).toBe(17_900);
    // 5.01 km rounds to 5.0 km under the tenth rule, so it is still the first row.
    expect(itemOf(computeFare(quote({ distanceMeters: 5_010 })), 'slab_fare').amountPaise).toBe(17_900);
    expect(itemOf(computeFare(quote({ distanceMeters: 5_060 })), 'slab_fare').amountPaise).toBe(22_900);
    expect(itemOf(computeFare(quote({ distanceMeters: 40_000 })), 'slab_fare').amountPaise).toBe(55_900);
  });

  it('adds only the kilometres past the end of the chart', () => {
    const breakdown = computeFare(quote({ distanceMeters: 120_000 }));
    expect(keys(breakdown)).toEqual(['slab_fare', 'distance']);
    expect(itemOf(breakdown, 'slab_fare').amountPaise).toBe(55_900);
    // An estimated 80 km beyond the 40 km chart, at ₹12/km.
    expect(itemOf(breakdown, 'distance').amountPaise).toBe(96_000);
    expect(itemOf(breakdown, 'distance').detail).toBe('80 km beyond the 40 km priced × ₹12/km');
    expect(breakdown.subtotalPaise).toBe(151_900);
  });

  it('prices one tenth of a kilometre past the chart as one tenth of the rate', () => {
    const breakdown = computeFare(quote({ distanceMeters: 40_100 }));
    expect(itemOf(breakdown, 'distance').amountPaise).toBe(120);
    expect(breakdown.subtotalPaise).toBe(56_020);
  });

  it('charges the first row for a route with no distance in it', () => {
    // A zero-kilometre booking is still a chauffeur sent somewhere: the chart's
    // floor is the price, and the engine does not hand back an empty receipt.
    const breakdown = computeFare(quote({ distanceMeters: 0 }));
    expect(itemOf(breakdown, 'slab_fare').amountPaise).toBe(17_900);
  });

  it('sorts by distance ceiling, so a dashboard that saved the rows out of order cannot misprice', () => {
    const scrambled = [...CITY_CHART].reverse().map((slab, index) => ({ ...slab, sortOrder: 99 - index }));
    const breakdown = computeFare(quote({ rule: slabRule({ slabs: scrambled }) }));
    expect(itemOf(breakdown, 'slab_fare').amountPaise).toBe(28_900);
    expect(listDistanceSlabs(slabRule({ slabs: scrambled })).map((s) => s.upToKilometers)).toEqual([5, 10, 15, 20, 25, 30, 40]);
  });

  it('refuses a slab rule with no chart instead of guessing a price', () => {
    expect(codeOf(() => computeFare(quote({ rule: slabRule({ slabs: [] }) })))).toBe('slabs_empty');
  });

  it('refuses a route past the chart when no overflow rate is set', () => {
    const noOverflow = slabRule({ slabOverflowPerKmPaise: 0 });
    expect(codeOf(() => computeFare(quote({ rule: noOverflow, distanceMeters: 105_000 })))).toBe('route_beyond_chart');
    // Inside the chart the same rule is perfectly usable.
    expect(itemOf(computeFare(quote({ rule: noOverflow, distanceMeters: 39_900 })), 'slab_fare').amountPaise).toBe(55_900);
  });

  it('takes no package tier, because a slab rule sells a distance and not a duration', () => {
    expect(codeOf(() => computeFare(quote({ packageTierId: 'h4' })))).toBe('tier_not_allowed');
    expect(listDistanceSlabs(hourlyRule())).toEqual([]);
  });
});

describe('distance rounding', () => {
  it('bills the nearest tenth by default and the next whole kilometre when configured', () => {
    expect(billableMetres(12_449, 'one_decimal')).toBe(12_400);
    expect(billableMetres(12_450, 'one_decimal')).toBe(12_500);
    expect(billableMetres(12_001, 'next_whole_km')).toBe(13_000);
    expect(billableMetres(12_000, 'next_whole_km')).toBe(12_000);
  });

  it('rounds before it selects the slab, so the same rule decides both', () => {
    const wholeKm = slabRule({ distanceRounding: 'next_whole_km' });
    // 4.8 km is a 5 km job when a part kilometre counts as a whole one, and it
    // still lands in the first row; 5.1 km becomes 6 km and moves up to ₹229.
    expect(itemOf(computeFare(quote({ rule: wholeKm, distanceMeters: 4_800 })), 'slab_fare').amountPaise).toBe(17_900);
    expect(itemOf(computeFare(quote({ rule: wholeKm, distanceMeters: 5_100 })), 'slab_fare').amountPaise).toBe(22_900);
    expect(itemOf(computeFare(quote({ distanceMeters: 5_100 })), 'slab_fare').amountPaise).toBe(22_900);
  });

  it('prices the rounded distance, not the raw metres, on a per-kilometre rule', () => {
    const tenth = computeFare(quote({ rule: distanceRule(), distanceMeters: 1_250 }));
    // 1.25 km is billed as 1.3 km, and 1.3 km × ₹8 is ₹10.40 exactly.
    expect(itemOf(tenth, 'distance').amountPaise).toBe(1_040);
    expect(itemOf(tenth, 'distance').detail).toBe('1.3 km × ₹8/km');

    const whole = computeFare(
      quote({ rule: distanceRule({ distanceRounding: 'next_whole_km' }), distanceMeters: 1_250 }),
    );
    expect(itemOf(whole, 'distance').amountPaise).toBe(1_600);
  });

  it('rounds a half-paisa tie up, on the component rather than the total', () => {
    // 0.1 km at ₹12.05/km is exactly 120.5 paise. Half-up bills 121.
    const tie = computeFare(
      quote({ rule: distanceRule({ perKmPaise: 1_205, gstRate: 0 }), distanceMeters: 100 }),
    );
    expect(itemOf(tie, 'distance').amountPaise).toBe(121);
    const plain = computeFare(quote({ rule: distanceRule({ perKmPaise: 1_200, gstRate: 0 }), distanceMeters: 100 }));
    expect(itemOf(plain, 'distance').amountPaise).toBe(120);
  });
});

describe('outstation one-way chart', () => {
  const outstation = slabRule({
    id: 'ggn-outstation-per-km', serviceTypeId: 'chauffeur_outstation',
    slabs: [
      { upToKilometers: 100, farePaise: 127_000, sortOrder: 1 },
      { upToKilometers: 150, farePaise: 138_000, sortOrder: 2 },
      { upToKilometers: 200, farePaise: 166_600, sortOrder: 3 },
      { upToKilometers: 250, farePaise: 194_000, sortOrder: 4 },
      { upToKilometers: 300, farePaise: 216_700, sortOrder: 5 },
      { upToKilometers: 350, farePaise: 272_200, sortOrder: 6 },
      { upToKilometers: 400, farePaise: 300_000, sortOrder: 7 },
      { upToKilometers: 450, farePaise: 327_000, sortOrder: 8 },
      { upToKilometers: 500, farePaise: 355_500, sortOrder: 9 },
    ], slabOverflowPerKmPaise: 1_000,
  });

  it.each([[100_000, 127_000], [100_100, 138_000], [150_000, 138_000], [150_100, 166_600], [200_000, 166_600], [200_100, 194_000], [250_000, 194_000], [250_100, 216_700], [500_000, 355_500]])(
    'uses the configured route slab at %jm', (distanceMeters, expectedPaise) => {
      expect(itemOf(computeFare(quote({ rule: outstation, distanceMeters })), 'slab_fare').amountPaise).toBe(expectedPaise);
    },
  );

  it('uses the configured ₹10/km overflow after the accepted outstation route', () => {
    const result = computeFare(quote({ rule: outstation, distanceMeters: 500_100 }));
    expect(itemOf(result, 'distance').amountPaise).toBe(100);
  });
});

describe('hourly packages', () => {
  it('charges the package and nothing for a trip inside its hours and kilometres', () => {
    const breakdown = computeFare(quote({ rule: hourlyRule(), packageTierId: 'h4', distanceMeters: 22_000, durationSeconds: 3 * HOUR }));
    expect(keys(breakdown)).toEqual(['package']);
    expect(itemOf(breakdown, 'package').amountPaise).toBe(44_900);
    expect(itemOf(breakdown, 'package').detail).toBe('4 hours · 40 km included');
    expect(breakdown.packageTierId).toBe('h4');
  });

  it.each([
    ['h1', 14_900, '1 hour · billed by time'],
    ['h2', 27_900, '2 hours · billed by time'],
    ['h4', 44_900, '4 hours · 40 km included'],
    ['h8', 79_900, '8 hours · 80 km included'],
    ['h12', 109_900, '12 hours · 120 km included'],
  ] as Array<[string, number, string]>)(
    '%s sells for its approved price',
    (id, price, detail) => {
      const breakdown = computeFare(quote({ rule: hourlyRule(), packageTierId: id }));
      expect(itemOf(breakdown, 'package').amountPaise).toBe(price);
      expect(itemOf(breakdown, 'package').detail).toBe(detail);
    },
  );

  it('meters only kilometres past the included allowance at ₹10/km', () => {
    const breakdown = computeFare(quote({ rule: hourlyRule(), packageTierId: 'h4', distanceMeters: 52_500, durationSeconds: 4 * HOUR }));
    expect(keys(breakdown)).toEqual(['package', 'distance']);
    expect(breakdown.subtotalPaise).toBe(57_400);
  });

  it('prorates overtime by the minute instead of billing a started hour', () => {
    // ₹120/hr prorated is ₹2 for one minute past the package. ₹100/hr
    // prorated is ₹1.67 for that minute and ₹50 for half an hour.
    const oneMinute = computeFare(quote({ rule: hourlyRule(), packageTierId: 'h4', durationSeconds: 4 * HOUR + 60 }));
    expect(itemOf(oneMinute, 'duration').amountPaise).toBe(200);
    expect(itemOf(oneMinute, 'duration').detail).toBe('1 min beyond 4 hours × ₹120/hr');

    const halfHour = computeFare(quote({ rule: hourlyRule(), packageTierId: 'h4', durationSeconds: 4 * HOUR + 30 * 60 }));
    expect(itemOf(halfHour, 'duration').amountPaise).toBe(6_000);
    expect(itemOf(halfHour, 'duration').detail).toBe('30 min beyond 4 hours × ₹120/hr');

    const ninety = computeFare(quote({ rule: hourlyRule(), packageTierId: 'h4', durationSeconds: 5.5 * HOUR }));
    expect(itemOf(ninety, 'duration').amountPaise).toBe(18_000);
  });


  it('waits for the Admin-configured overtime grace before billing minutes', () => {
    const rule = hourlyRule({ overtimeGraceMinutes: 5 });
    const withinGrace = computeFare(quote({ rule, packageTierId: 'h4', durationSeconds: 4 * HOUR + 5 * 60 }));
    const afterGrace = computeFare(quote({ rule, packageTierId: 'h4', durationSeconds: 4 * HOUR + 6 * 60 }));
    expect(withinGrace.items.some((item) => item.key === 'duration')).toBe(false);
    expect(itemOf(afterGrace, 'duration').amountPaise).toBe(200);
  });

  it('charges no overtime the instant the package is used up', () => {
    expect(keys(computeFare(quote({ rule: hourlyRule(), packageTierId: 'h4', durationSeconds: 4 * HOUR })))).toEqual(['package']);
    expect(keys(computeFare(quote({ rule: hourlyRule(), packageTierId: 'h4', durationSeconds: 4 * HOUR + 1 })))).toContain('duration');
  });

  it('never bills negative overage for a short trip', () => {
    const breakdown = computeFare(quote({ rule: hourlyRule(), packageTierId: 'h12', distanceMeters: 5_000, durationSeconds: 600 }));
    expect(keys(breakdown)).toEqual(['package']);
  });

  it('charges time past a package once, and not again as waiting', () => {
    // The hour the driver is held is the product; a separate per-minute waiting
    // charge on top of overtime would bill the same clock twice.
    const breakdown = computeFare(quote({ rule: hourlyRule(), packageTierId: 'h4', durationSeconds: 5 * HOUR, waitingMinutes: 60 }));
    expect(keys(breakdown)).toEqual(['package', 'duration']);
    const chargedWaiting = computeFare(
      quote({ rule: hourlyRule({ waitChargePerMinutePaise: 200 }), packageTierId: 'h4', durationSeconds: 5 * HOUR, waitingMinutes: 60 }),
    );
    expect(itemOf(chargedWaiting, 'waiting').amountPaise).toBe(60 * 200);
    expect(itemOf(chargedWaiting, 'duration').amountPaise).toBe(12_000);
  });

  it('lists tiers in display order, and lists none for a slab rule', () => {
    expect(listPackageTiers(hourlyRule()).map((t) => t.id)).toEqual(['h1', 'h2', 'h4', 'h8', 'h12']);
    expect(listPackageTiers(slabRule())).toEqual([]);
  });
});

describe('flat night allowance', () => {
  it('adds the unchanged ₹150 city night fee once per eligible departure', () => {
    const breakdown = computeFare(quote({ distanceMeters: 4_000, localStartHour: 23 }));
    expect(keys(breakdown)).toEqual(['slab_fare', 'night_surcharge']);
    expect(itemOf(breakdown, 'night_surcharge').amountPaise).toBe(15_000);
    expect(itemOf(breakdown, 'night_surcharge').detail).toBe('Flat ₹150 for a departure between 22:00 and 06:00');
    expect(breakdown.subtotalPaise).toBe(17_900 + 15_000);

    const longer = computeFare(quote({ distanceMeters: 30_000, localStartHour: 23 }));
    expect(itemOf(longer, 'night_surcharge').amountPaise).toBe(15_000);
  });

  it('applies the window to the hour the trip starts, half-open and wrapping midnight', () => {
    const at = (hour: number) => keys(computeFare(quote({ localStartHour: hour }))).includes('night_surcharge');
    expect(at(21)).toBe(false);
    expect(at(22)).toBe(true);
    expect(at(0)).toBe(true);
    expect(at(5)).toBe(true);
    expect(at(6)).toBe(false);
    expect(at(14)).toBe(false);
  });

  it('does not compound with surge', () => {
    const breakdown = computeFare(quote({ distanceMeters: 12_400, localStartHour: 23, surgeMultiplier: 1.5 }));
    expect(itemOf(breakdown, 'night_surcharge').amountPaise).toBe(15_000);
    expect(itemOf(breakdown, 'surge').amountPaise).toBe(Math.round(28_900 * 0.5));
  });

  it('still supports a percentage window, computed off the core fare', () => {
    const percent = slabRule({
      nightSurcharge: { enabled: true, fromHour: 22, toHour: 6, mode: 'percent', flatPaise: 0, rate: 0.1 },
    });
    const breakdown = computeFare(quote({ rule: percent, distanceMeters: 12_400, localStartHour: 23 }));
    expect(itemOf(breakdown, 'night_surcharge').amountPaise).toBe(2_890);
    expect(itemOf(breakdown, 'night_surcharge').detail).toBe('10% of the fare between 22:00 and 06:00');
  });

  it('adds nothing when the charge is zero, the window is empty, or it is switched off', () => {
    expect(keys(computeFare(quote({ localStartHour: 23, rule: slabRule({ nightSurcharge: { enabled: true, fromHour: 22, toHour: 6, mode: 'flat', flatPaise: 0, rate: 0 } }) })))).not.toContain('night_surcharge');
    expect(keys(computeFare(quote({ localStartHour: 3, rule: slabRule({ nightSurcharge: { enabled: true, fromHour: 3, toHour: 3, mode: 'flat', flatPaise: 15_000, rate: 0 } }) })))).not.toContain('night_surcharge');
    expect(keys(computeFare(quote({ localStartHour: 23, rule: slabRule({ nightSurcharge: { enabled: false, fromHour: 22, toHour: 6, mode: 'flat', flatPaise: 15_000, rate: 0 } }) })))).not.toContain('night_surcharge');
  });

  it('treats a midnight-wrapping window as a range rather than all day', () => {
    expect(isNightHour(3, 3, 3)).toBe(false);
    expect(isNightHour(23, 22, 6)).toBe(true);
  });
});

describe('money invariants', () => {
  const matrix: Array<Partial<FareComputation>> = [
    {},
    { distanceMeters: 0 },
    { distanceMeters: 1 },
    { distanceMeters: 999 },
    { distanceMeters: 1_234_567, durationSeconds: 9_999 },
    { distanceMeters: 40_100 },
    { distanceMeters: 105_000, rule: slabRule({ distanceRounding: 'next_whole_km' }) },
    { waitingMinutes: 47 },
    { surgeMultiplier: 1.5 },
    { localStartHour: 23 },
    { localStartHour: 3, rule: slabRule({ minimumFarePaise: 60_000, platformFeeRate: 0.07, gstRate: 0.18 }) },
    { rule: hourlyRule(), packageTierId: 'h12', distanceMeters: 142_300, durationSeconds: 13 * HOUR + 11 * 60 },
    { rule: distanceRule(), distanceMeters: 33_333 },
  ];

  it.each(matrix)('the printed receipt adds up exactly for %j', (overrides) => {
    const breakdown = computeFare(quote(overrides));
    const sum = breakdown.items.reduce((total, item) => total + item.amountPaise, 0);
    expect(breakdown.subtotalPaise).toBe(sum);
    expect(breakdown.totalPaise).toBe(breakdown.subtotalPaise + breakdown.taxPaise);
  });

  it.each(matrix)('every amount is a whole non-negative integer of paise for %j', (overrides) => {
    const breakdown = computeFare(quote(overrides));
    for (const value of [...breakdown.items.map((i) => i.amountPaise), breakdown.subtotalPaise, breakdown.taxPaise, breakdown.totalPaise]) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('is deterministic: the same inputs in a different call produce byte-identical output', () => {
    const input = quote({ rule: hourlyRule(), packageTierId: 'h8', distanceMeters: 88_100, durationSeconds: 6 * HOUR });
    expect(computeFare(input)).toEqual(computeFare(input));
  });
});

describe('GST and the floor', () => {
  it('adds 5% GST on top of the slab and prints it outside the items', () => {
    const breakdown = computeFare(quote({ distanceMeters: 12_400 }));
    expect(breakdown.subtotalPaise).toBe(28_900);
    expect(breakdown.taxPaise).toBe(1_445);
    expect(breakdown.totalPaise).toBe(30_345);
    expect(keys(breakdown)).not.toContain('gst');
  });

  it('tops the fare up to the floor and says so on its own line', () => {
    const floored = slabRule({ slabs: [{ upToKilometers: 5, farePaise: 5_000, sortOrder: 1 }], minimumFarePaise: 15_000 });
    const breakdown = computeFare(quote({ rule: floored, distanceMeters: 1_000 }));
    expect(itemOf(breakdown, 'minimum_fare').amountPaise).toBe(10_000);
    expect(itemOf(breakdown, 'minimum_fare').detail).toBe('Trip charged at the ₹150 minimum');
    expect(breakdown.subtotalPaise).toBe(15_000);
  });

  it('charges a platform fee on the floored amount, not on the raw slab', () => {
    const rule = slabRule({ slabs: [{ upToKilometers: 5, farePaise: 5_000, sortOrder: 1 }], minimumFarePaise: 15_000, platformFeeRate: 0.05 });
    const breakdown = computeFare(quote({ rule, distanceMeters: 1_000 }));
    expect(itemOf(breakdown, 'platform_fee').amountPaise).toBe(750);
  });

  it('adds nothing once the trip is already above the floor', () => {
    expect(keys(computeFare(quote({ rule: slabRule({ minimumFarePaise: 15_000 }) })))).not.toContain('minimum_fare');
  });

  it('bills waiting only past the included allowance', () => {
    const rule = slabRule({ waitChargePerMinutePaise: 1_500 });
    const breakdown = computeFare(quote({ rule, waitingMinutes: 30 }));
    expect(itemOf(breakdown, 'waiting').amountPaise).toBe(20 * 1_500);
    expect(itemOf(breakdown, 'waiting').detail).toBe('20 min beyond 10 free × ₹15/min');
    expect(keys(computeFare(quote({ rule, waitingMinutes: 10 })))).not.toContain('waiting');
  });
});

describe('refusals', () => {
  it('will not price an hourly booking without choosing a tier', () => {
    expect(codeOf(() => computeFare(quote({ rule: hourlyRule() })))).toBe('tier_required');
    expect(codeOf(() => computeFare(quote({ rule: hourlyRule(), packageTierId: '' })))).toBe('tier_required');
  });

  it('will not invent a tier the rule does not sell', () => {
    expect(codeOf(() => computeFare(quote({ rule: hourlyRule(), packageTierId: 'h24' })))).toBe('tier_unknown');
  });

  it('will not price a booking in a zone the rule was not written for', () => {
    expect(codeOf(() => computeFare(quote({ zoneId: 'zone-del-1' })))).toBe('zone_mismatch');
  });

  it('will not price against an inactive or out-of-date rule', () => {
    expect(codeOf(() => computeFare(quote({ rule: slabRule({ active: false }) })))).toBe('rule_inactive');
    expect(codeOf(() => computeFare(quote({ rule: slabRule({ effectiveFromMs: NOW + HOUR_MS }) })))).toBe('rule_inactive');
    expect(codeOf(() => computeFare(quote({ rule: slabRule({ effectiveUntilMs: NOW - 1 }) })))).toBe('rule_inactive');
    // Half-open: the effectiveUntil instant itself is already too late.
    expect(codeOf(() => computeFare(quote({ rule: slabRule({ effectiveUntilMs: NOW }) })))).toBe('rule_inactive');
  });

  it('will not apply surge above the rule cap, or any surge where surge is disabled', () => {
    expect(codeOf(() => computeFare(quote({ surgeMultiplier: 1.51 })))).toBe('surge_out_of_range');
    expect(codeOf(() => computeFare(quote({ surgeMultiplier: 1.2, rule: slabRule({ surge: { enabled: false, maxMultiplier: 2 } }) })))).toBe('surge_out_of_range');
    expect(itemOf(computeFare(quote({ surgeMultiplier: 1.5 })), 'surge').amountPaise).toBe(14_450);
  });

  it('rejects impossible measurements instead of producing a plausible wrong number', () => {
    expect(codeOf(() => computeFare(quote({ distanceMeters: -1 })))).toBe('invalid_input');
    expect(codeOf(() => computeFare(quote({ durationSeconds: Number.NaN })))).toBe('invalid_input');
    expect(codeOf(() => computeFare(quote({ waitingMinutes: Number.POSITIVE_INFINITY })))).toBe('invalid_input');
    expect(codeOf(() => computeFare(quote({ localStartHour: 24 })))).toBe('invalid_input');
    expect(codeOf(() => computeFare(quote({ surgeMultiplier: 0.5 })))).toBe('invalid_input');
  });
});

describe('the pricing snapshot', () => {
  const hasher = (canonical: string) => `sha256:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;

  it('is null when no hasher is supplied, so the field never claims a hash that was not taken', () => {
    expect(computeFare(quote()).pricingSnapshotHash).toBeNull();
  });

  it('is stable for the same rule and changes when any priced value changes', () => {
    const base = computeFare(quote({ hash: hasher })).pricingSnapshotHash;
    expect(base).toBe(computeFare(quote({ hash: hasher })).pricingSnapshotHash);
    expect(computeFare(quote({ hash: hasher, rule: slabRule({ gstRate: 0.12 }) })).pricingSnapshotHash).not.toBe(base);
    // A field the fare never reads still cannot move the hash.
    expect(computeFare(quote({ hash: hasher, rule: slabRule({ updatedByUid: 'someone-else' }) })).pricingSnapshotHash).toBe(base);
  });

  it('covers the whole chart, so a repriced slab cannot hide behind an old hash', () => {
    const base = computeFare(quote({ hash: hasher })).pricingSnapshotHash;
    const repriced = slabRule({ slabs: CITY_CHART.map((s) => (s.upToKilometers === 5 ? { ...s, farePaise: 19_900 } : s)) });
    expect(computeFare(quote({ hash: hasher, rule: repriced })).pricingSnapshotHash).not.toBe(base);
    const shorter = slabRule({ slabs: CITY_CHART.slice(0, 5) });
    expect(computeFare(quote({ hash: hasher, rule: shorter })).pricingSnapshotHash).not.toBe(base);
    // The overflow rate and the rounding rule both move the number, so both move
    // the snapshot.
    expect(computeFare(quote({ hash: hasher, rule: slabRule({ slabOverflowPerKmPaise: 1_400 }) })).pricingSnapshotHash).not.toBe(base);
    expect(computeFare(quote({ hash: hasher, rule: slabRule({ distanceRounding: 'next_whole_km' }) })).pricingSnapshotHash).not.toBe(base);
    expect(computeFare(quote({ hash: hasher, rule: slabRule({ pricingVersion: 2 }) })).pricingSnapshotHash).not.toBe(base);
    expect(computeFare(quote({ hash: hasher, rule: slabRule({ nightSurcharge: { enabled: true, fromHour: 22, toHour: 6, mode: 'flat', flatPaise: 20_000, rate: 0 } }) })).pricingSnapshotHash).not.toBe(base);
  });

  it('names the chart it priced against', () => {
    const canonical = canonicalFareSnapshot(slabRule(), null);
    expect(canonical.startsWith('v5|ggn-city-one-way|1|distance_slab|zone-ggn-1|INR|')).toBe(true);
    expect(canonical).toContain('5:17900,10:22900,15:28900,20:34500,25:39900,30:45900,40:55900');
  });

  it('records which tier was priced, so a h4 quote cannot be defended as an h12 one', () => {
    const rule = hourlyRule();
    const h4 = canonicalFareSnapshot(rule, rule.packages.find((item) => item.id === 'h4')!);
    const h12 = canonicalFareSnapshot(rule, rule.packages.find((item) => item.id === 'h12')!);
    expect(h4).not.toBe(h12);
    expect(h4.endsWith('|h4|4|40|44900|1000|12000')).toBe(true);
  });

  it('is produced by the injected function, so the domain package needs no crypto of its own', () => {
    const calls: string[] = [];
    computeFare(quote({ hash: (canonical) => { calls.push(canonical); return 'x'; } }));
    expect(calls).toHaveLength(1);
  });
});

describe('quote lifetime', () => {
  it('expires an estimate on the rule clock and never expires a final fare', () => {
    const estimate = computeFare(quote());
    expect(estimate.expiresAtMs).toBe(NOW + 15 * MIN_MS);
    expect(isQuoteExpired(estimate, NOW + 14 * MIN_MS)).toBe(false);
    expect(isQuoteExpired(estimate, NOW + 15 * MIN_MS)).toBe(true);

    const final = computeFare(quote({ kind: 'final' }));
    expect(final.expiresAtMs).toBeNull();
    expect(isQuoteExpired(final, NOW + 365 * 24 * HOUR_MS)).toBe(false);
    expect(final.kind).toBe('final');
  });
});

/**
 * The bill is what the car ran, not what the map guessed. These are the owner's
 * rules in arithmetic: read the dial at pickup, read it again at the drop, price
 * the difference on the same chart the quote was priced on.
 */
describe('the odometer, read as a person reads it', () => {
  it('turns two whole-kilometre readings into the metres between them', () => {
    expect(odometerRunMeters(12_000, 12_035)).toBe(35_000);
    expect(odometerRunMeters(12_000, 12_000)).toBe(0);
  });

  it('refuses a closing reading below the opening one, because the meter does not run backwards', () => {
    expect(() => odometerRunMeters(12_000, 11_999)).toThrow(FareError);
    expect(() => odometerRunMeters(12_000, 11_999)).toThrow(/does not run backwards/);
  });

  it('refuses a reading that is not a whole number of kilometres, rather than inventing precision', () => {
    expect(() => odometerRunMeters(12_000, 12_000.5)).toThrow(/whole number of kilometres/);
    expect(() => odometerRunMeters(12_000, -3)).toThrow(/whole number of kilometres/);
    expect(() => odometerRunMeters(Number.NaN, 12_000)).toThrow(/whole number of kilometres/);
  });
});

describe('the metered fare', () => {
  /** Quoted at 12.4 km, which is the ₹289 "up to 15 km" row. */
  const slabQuote = computeFare(quote());

  const metered = (odometerKm: number, overrides: Partial<MeteredFareInput> = {}): FareBreakdown =>
    computeMeteredFare({
      rule: slabRule(),
      quote: slabQuote,
      quotedDistanceMeters: 12_400,
      zoneId: 'zone-ggn-1',
      startOdometerKm: 5_000,
      odometerKm,
      tripStartMs: NOW - 52 * MIN_MS,
      localStartHour: 14,
      waitingMinutes: 0,
      surgeMultiplier: 1,
      kind: 'final',
      nowMs: NOW,
      ...overrides,
    });

  it('keeps the slab the customer was quoted and meters only the kilometres past its ceiling', () => {
    // The dial says 25 km ran on a trip quoted at 12.4 km. Charge only 12.6 km
    // beyond the accepted route at ₹12/km; keep the original quoted slab.
    const final = metered(5_025);

    expect(slabQuote.subtotalPaise).toBe(28_900);
    expect(final.items.map((i) => [i.key, i.amountPaise])).toEqual([
      ['slab_fare', 28_900],
      ['distance', 15_120],
    ]);
    expect(itemOf(final, 'distance').detail).toBe('12.6 km beyond the quoted route × ₹12/km');
    expect(final.subtotalPaise).toBe(44_020);
    expect(final.taxPaise).toBe(2_201);
    expect(final.totalPaise).toBe(46_221);
    expect(final.kind).toBe('final');
  });

  it('is the quoted price to the paisa while the dial stays inside the priced band', () => {
    const final = metered(5_014);

    expect(keys(final)).toEqual(['slab_fare', 'distance']);
    expect(itemOf(final, 'distance').amountPaise).toBe(1_920);
  });

  it('does not move a short run onto a cheaper row: the band was confirmed, not the distance', () => {
    const final = metered(5_008);

    expect(itemOf(final, 'slab_fare').amountPaise).toBe(28_900);
    expect(final.subtotalPaise).toBe(28_900);
  });

  it('refuses a bill past the priced row when the rule sets no per-kilometre rate', () => {
    // Refusing is better than inventing a price the owner never approved, even
    // though it means the driver has to call support to close the trip.
    const noRate = () => metered(5_025, { rule: slabRule({ slabOverflowPerKmPaise: 0 }) });

    expect(noRate).toThrow(/exceeds the 12.4 km quoted/);
    expect(codeOf(noRate)).toBe('route_beyond_chart');
  });

  it('carries the flat night charge across to the metered bill', () => {
    const atNight = metered(5_025, { localStartHour: 23 });

    expect(itemOf(atNight, 'night_surcharge').amountPaise).toBe(15_000);
    expect(atNight.subtotalPaise).toBe(59_020);
    expect(atNight.totalPaise).toBe(61_971);
  });

  it('keeps the package the customer picked and meters only what ran over it', () => {
    const packageQuote = computeFare({
      rule: hourlyRule(),
      zoneId: 'zone-ggn-1',
      distanceMeters: 40_000,
      durationSeconds: 4 * HOUR,
      waitingMinutes: 0,
      localStartHour: 11,
      surgeMultiplier: 1,
      packageTierId: 'h4',
      kind: 'estimate',
      nowMs: NOW,
    });

    // 55 km off the dial and five hours on the clock, over a 4 h / 40 km package.
    const final = computeMeteredFare({
      rule: hourlyRule(),
      quote: packageQuote,
      quotedDistanceMeters: 40_000,
      zoneId: 'zone-ggn-1',
      startOdometerKm: 1_000,
      odometerKm: 1_055,
      tripStartMs: NOW - 5 * HOUR_MS,
      localStartHour: 11,
      waitingMinutes: 0,
      surgeMultiplier: 1,
      kind: 'final',
      nowMs: NOW,
    });

    expect(final.packageTierId).toBe('h4');
    expect(itemOf(final, 'package').amountPaise).toBe(44_900);
    expect(keys(final)).toEqual(['package', 'distance', 'duration']);
    expect(itemOf(final, 'distance').amountPaise).toBe(15_000);
    expect(itemOf(final, 'duration').amountPaise).toBe(12_000);
    expect(final.subtotalPaise).toBe(71_900);
    expect(final.totalPaise).toBe(75_495);
  });

  it('is the same engine as the quote, so a running meter becomes the receipt at the drop', () => {
    const midTrip = metered(5_010, { kind: 'estimate', tripStartMs: NOW - 30 * MIN_MS, nowMs: NOW - 10 * MIN_MS });
    const atDrop = metered(5_025, { tripStartMs: NOW - 30 * MIN_MS });

    // Nothing about a live meter is a second price list: the same call with the
    // distance, the quoted band and the time it would have used produces the
    // identical breakdown.
    expect(atDrop).toEqual(
      computeFare({
        rule: slabRule(),
        zoneId: 'zone-ggn-1',
        distanceMeters: 25_000,
        quotedDistanceMeters: 12_400,
        durationSeconds: 30 * 60,
        waitingMinutes: 0,
        localStartHour: 14,
        surgeMultiplier: 1,
        packageTierId: slabQuote.packageTierId,
        kind: 'final',
        nowMs: NOW,
      }),
    );
    expect(atDrop.totalPaise).toBeGreaterThan(midTrip.totalPaise);
  });

  it('refuses to bill a metered trip whose dial was never read at pickup', () => {
    expect(() => metered(5_025, { startOdometerKm: Number.NaN })).toThrow(/startOdometerKm/);
  });
});
