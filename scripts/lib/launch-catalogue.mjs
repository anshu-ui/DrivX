#!/usr/bin/env node
/**
 * The launch pricing catalogue, in one place.
 *
 * Two things write it: `scripts/seed.mjs` puts it into the local emulator, and
 * `scripts/provision-live.mjs` puts it into the live project. A copy of the
 * numbers in each script would mean the demo environment and production price
 * the same trip differently, which is the exact failure this repository has been
 * careful to avoid — every fare elsewhere is computed by `@drivx/domain` from
 * rules like these, so a drifted rule silently changes the receipt.
 *
 * Times are raw millisecond offsets from `nowMs`, and each caller converts them
 * to a Firestore timestamp its own way. Nothing here is a Timestamp object, so
 * neither caller can quietly persist something the other cannot.
 */

const DAY_MS = 86_400_000;

/**
 * The launch pricing catalogue.
 *
 * Local one-way keeps the previous approved chart through 40 km. One row prices
 * the whole quoted route; actual distance beyond 40 km continues at ₹12/km.
 *
 * Local round trips retain the configured 1–12 hour prices and are time-only,
 * with no distance allowance or distance charge; overtime is ₹120/hour.
 *
 * All trip types use ₹200 per eligible hour inside the configurable night window. Tolls
 * and parking are separately disclosed actuals; waiting beyond the included time
 * is not charged until an Admin configures a rate.
 *
 * Tax is not assumed by this catalogue: Admin configures a rate only after tax
 * review. The platform fee is 0: the business takes its
 * cut as commission on the driver's fare, not as a line on the customer's bill.
 *
 * Outstation one-way is offered through 3,000 km. Each additional 50 km after
 * 500 km adds the last supplied package gap (₹285). Odometer overage remains ₹10/km.
 */
export function launchCatalogue(nowMs = Date.now()) {
  /** Existing local one-way chart, in paise. Outstation has its own rule below. */
  const CITY_SLABS = [179, 229, 289, 345, 399, 459, 559].map((fare, index) => ({
    upToKilometers: (index + 1) * 5 + (index >= 6 ? 5 : 0),
    farePaise: fare * 100,
    sortOrder: index + 1,
  }));

  /** One-time ₹200 surcharge per eligible trip with scheduled pickup in the 22:00–06:00 window. */
  const CITY_NIGHT = { enabled: true, fromHour: 22, toHour: 6, mode: 'flat', flatPaise: 20_000, rate: 0 };
  const OUTSTATION_NIGHT = CITY_NIGHT;

  const cityOneWay = (id, zoneId, waitChargePerMinutePaise) => ({
    id,
    pricingVersion: 1,
    serviceTypeId: 'chauffeur_own_car',
    zoneId,
    currency: 'INR',
    pricingModel: 'distance_slab',
    baseFarePaise: 0,
    perKmPaise: 0,
    perMinutePaise: 0,
    // Ten free minutes at pickup; beyond that nothing is charged until the owner
    // sets a waiting rate, so the quote never carries an unapproved line.
    includedWaitMinutes: 10,
    waitChargePerMinutePaise,
    platformFeeRate: 0,
    // Tax treatment is an admin policy, not an assumed GST rate.
    gstRate: 0,
    nightSurcharge: CITY_NIGHT,
    surge: { enabled: true, maxMultiplier: 1.5 },
    minimumFarePaise: 0,
    packages: [],
    slabs: CITY_SLABS,
    slabOverflowPerKmPaise: 1_200,
    distanceRounding: 'one_decimal',
    estimateValidityMinutes: 15,
    active: true,
    effectiveFromMs: nowMs - 30 * DAY_MS,
    effectiveUntilMs: null,
    updatedByUid: 'admin-1',
    updatedAtMs: nowMs - 30 * DAY_MS,
  });

  const outstationOneWaySlabs = [
    { upToKilometers: 100, farePaise: 127_000 },
    { upToKilometers: 150, farePaise: 138_000 },
    { upToKilometers: 200, farePaise: 166_600 },
    { upToKilometers: 250, farePaise: 194_000 },
    { upToKilometers: 300, farePaise: 216_700 },
    { upToKilometers: 350, farePaise: 272_200 },
    { upToKilometers: 400, farePaise: 300_000 },
    { upToKilometers: 450, farePaise: 327_000 },
    { upToKilometers: 500, farePaise: 355_500 },
  ];
  // No user-supplied packages above 500 km: carry forward the last provided
  // 450→500 km difference (₹285 per 50 km) as the requested test-rate rule.
  for (let km = 550; km <= 3_000; km += 50) {
    const previous = outstationOneWaySlabs.at(-1);
    outstationOneWaySlabs.push({ upToKilometers: km, farePaise: previous.farePaise + 28_500 });
  }

  const pricingRules = [
    cityOneWay('ggn-city-one-way', 'zone-ggn-1', 0),
    cityOneWay('del-city-one-way', 'zone-del-1', 0),
    {
      id: 'ggn-chauffeur-hourly',
      pricingVersion: 1,
      serviceTypeId: 'chauffeur_hourly',
      zoneId: 'zone-ggn-1',
      currency: 'INR',
      pricingModel: 'hourly_package',
      baseFarePaise: 0,
      perKmPaise: 0,
      perMinutePaise: 0,
      // The package already sells the driver's time, so waiting is not a second
      // charge on the same clock.
      includedWaitMinutes: 0,
      waitChargePerMinutePaise: 0,
      overtimeGraceMinutes: 0,
      platformFeeRate: 0,
      gstRate: 0,
      nightSurcharge: CITY_NIGHT,
      surge: { enabled: false, maxMultiplier: 1 },
      minimumFarePaise: 0,
      packages: [
        { id: 'h1', label: '1 hour', hours: 1, includedKilometers: 0, packagePricePaise: 14_900, extraKmPaise: 1_000, extraHourPaise: 12_000, sortOrder: 1 },
        { id: 'h2', label: '2 hours', hours: 2, includedKilometers: 0, packagePricePaise: 27_900, extraKmPaise: 1_000, extraHourPaise: 12_000, sortOrder: 2 },
        { id: 'h4', label: '4 hours', hours: 4, includedKilometers: 40, packagePricePaise: 44_900, extraKmPaise: 1_000, extraHourPaise: 12_000, sortOrder: 4 },
        { id: 'h8', label: '8 hours', hours: 8, includedKilometers: 80, packagePricePaise: 79_900, extraKmPaise: 1_000, extraHourPaise: 12_000, sortOrder: 8 },
        { id: 'h12', label: '12 hours', hours: 12, includedKilometers: 120, packagePricePaise: 109_900, extraKmPaise: 1_000, extraHourPaise: 12_000, sortOrder: 12 },
      ],
      slabs: [],
      slabOverflowPerKmPaise: 0,
      distanceRounding: 'one_decimal',
      estimateValidityMinutes: 30,
      active: true,
      effectiveFromMs: nowMs - 5 * DAY_MS,
      effectiveUntilMs: null,
      updatedByUid: 'admin-1',
      updatedAtMs: nowMs - 5 * DAY_MS,
    },
    {
      id: 'ggn-outstation-per-km',
      pricingVersion: 1,
      serviceTypeId: 'chauffeur_outstation',
      zoneId: 'zone-ggn-1',
      currency: 'INR',
      pricingModel: 'distance_slab',
      baseFarePaise: 0,
      perKmPaise: 0,
      perMinutePaise: 0,
      includedWaitMinutes: 10,
      waitChargePerMinutePaise: 0,
      platformFeeRate: 0,
      gstRate: 0,
      nightSurcharge: OUTSTATION_NIGHT,
      surge: { enabled: false, maxMultiplier: 1 },
      minimumFarePaise: 0,
      packages: [],
      slabs: outstationOneWaySlabs.map((slab, index) => ({ ...slab, sortOrder: index + 1 })),
      slabOverflowPerKmPaise: 1_000,
      distanceRounding: 'one_decimal',
      estimateValidityMinutes: 15,
      active: true,
      effectiveFromMs: nowMs - 30 * DAY_MS,
      effectiveUntilMs: null,
      updatedByUid: 'admin-1',
      updatedAtMs: nowMs - 30 * DAY_MS,
    },
    {
      id: 'ggn-outstation-round-trip',
      pricingVersion: 1,
      serviceTypeId: 'chauffeur_outstation',
      zoneId: 'zone-ggn-1',
      currency: 'INR',
      pricingModel: 'hourly_package',
      baseFarePaise: 0,
      perKmPaise: 0,
      perMinutePaise: 0,
      includedWaitMinutes: 0,
      waitChargePerMinutePaise: 0,
      overtimeGraceMinutes: 0,
      platformFeeRate: 0,
      gstRate: 0,
      nightSurcharge: OUTSTATION_NIGHT,
      surge: { enabled: false, maxMultiplier: 1 },
      minimumFarePaise: 0,
      packages: [1_333, 2_555, 3_777, 4_999, 6_221, 7_443, 8_665, 9_887, 11_109, 12_331, 13_554].map((fare, index) => {
        const days = index + 1;
        return { id: `d${days}`, label: `${days} ${days === 1 ? 'day' : 'days'}`, hours: days * 24, includedKilometers: 0, packagePricePaise: fare * 100, extraKmPaise: 0, extraHourPaise: 10_000, sortOrder: days };
      }),
      slabs: [],
      slabOverflowPerKmPaise: 0,
      distanceRounding: 'one_decimal',
      estimateValidityMinutes: 30,
      active: true,
      effectiveFromMs: nowMs - 30 * DAY_MS,
      effectiveUntilMs: null,
      updatedByUid: 'admin-1',
      updatedAtMs: nowMs - 30 * DAY_MS,
    },
  ];

  const serviceTypes = [
    {
      id: 'chauffeur_own_car',
      name: 'Local',
      description: 'Around the city with a verified chauffeur driving your car.',
      enabled: true,
      vehicleOwnership: 'own_car',
      requiresVerifiedDriver: true,
      allowsScheduling: true,
      allowsHourly: false,
      supportsCabFleet: false,
      pricingRuleId: 'ggn-city-one-way',
      // A local trip where the chauffeur returns with you is the driver's time,
      // not the distance, so it is priced by the hourly rule.
      roundTripPricingRuleId: 'ggn-chauffeur-hourly',
      pickupGeofence: { center: { lat: 28.4512, lng: 77.0211 }, radiusMeters: 120, kind: 'pickup' },
      destinationGeofence: { center: { lat: 28.6315, lng: 77.2167 }, radiusMeters: 80, kind: 'destination' },
      maxArrivalAccuracyMeters: 30,
      arrivalConsecutiveSamples: 3,
      cancellationFreeWindowMinutes: 5,
      minDurationMinutes: 30,
      iconKey: 'car-outline',
      sortOrder: 1,
      updatedAtMs: nowMs - 10 * DAY_MS,
    },
    {
      id: 'chauffeur_hourly',
      name: 'Hourly',
      description: 'Your car and driver held for 1, 2, 4, 8 or 12 hours.',
      enabled: true,
      vehicleOwnership: 'own_car',
      requiresVerifiedDriver: true,
      allowsScheduling: true,
      allowsHourly: true,
      supportsCabFleet: false,
      pricingRuleId: 'ggn-chauffeur-hourly',
      pickupGeofence: { center: { lat: 28.4512, lng: 77.0211 }, radiusMeters: 150, kind: 'pickup' },
      destinationGeofence: { center: { lat: 28.4512, lng: 77.0211 }, radiusMeters: 150, kind: 'destination' },
      maxArrivalAccuracyMeters: 30,
      arrivalConsecutiveSamples: 3,
      cancellationFreeWindowMinutes: 15,
      minDurationMinutes: 60,
      iconKey: 'time-outline',
      sortOrder: 2,
      updatedAtMs: nowMs - 10 * DAY_MS,
    },
    {
      id: 'chauffeur_outstation',
      name: 'Outstation',
      description:
        'One-way distance packages up to 3,000 km and day-based outstation round trips up to 11 days.',
      enabled: true,
      vehicleOwnership: 'own_car',
      requiresVerifiedDriver: true,
      allowsScheduling: true,
      allowsHourly: false,
      supportsCabFleet: false,
      pricingRuleId: 'ggn-outstation-per-km',
      roundTripPricingRuleId: 'ggn-outstation-round-trip',
      pickupGeofence: { center: { lat: 28.4512, lng: 77.0211 }, radiusMeters: 120, kind: 'pickup' },
      destinationGeofence: { center: { lat: 28.6315, lng: 77.2167 }, radiusMeters: 80, kind: 'destination' },
      maxArrivalAccuracyMeters: 30,
      arrivalConsecutiveSamples: 3,
      cancellationFreeWindowMinutes: 5,
      minDurationMinutes: 30,
      iconKey: 'arrow-forward-circle-outline',
      sortOrder: 3,
      updatedAtMs: nowMs - 10 * DAY_MS,
    },
    {
      id: 'cab_standard',
      name: 'DrivX cab',
      description:
        'Company-operated cab. Disabled until aggregator licensing, insurance and tax review complete.',
      enabled: false,
      vehicleOwnership: 'fleet',
      requiresVerifiedDriver: true,
      allowsScheduling: true,
      allowsHourly: false,
      supportsCabFleet: true,
      // Disabled, so nothing is ever priced against it. Points at the city chart
      // rather than inventing a cab tariff nobody has approved yet.
      pricingRuleId: 'ggn-city-one-way',
      pickupGeofence: { center: { lat: 28.4512, lng: 77.0211 }, radiusMeters: 120, kind: 'pickup' },
      destinationGeofence: { center: { lat: 28.6315, lng: 77.2167 }, radiusMeters: 80, kind: 'destination' },
      maxArrivalAccuracyMeters: 30,
      arrivalConsecutiveSamples: 3,
      cancellationFreeWindowMinutes: 3,
      minDurationMinutes: 10,
      iconKey: 'car-suv-outline',
      sortOrder: 4,
      updatedAtMs: nowMs - 2 * DAY_MS,
    },
  ];

  return { pricingRules, serviceTypes };
}
