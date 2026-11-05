import { createHash, randomUUID } from 'node:crypto';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { z } from 'zod';
import {
  BOOKING_REFERENCE_PREFIX,
  cancelBookingInputSchema,
  commissionSnapshotFor,
  couponPreviewInputSchema,
  createBookingInputSchema,
  fareQuoteInputSchema,
  isActiveTrip,
  isCancellable,
  RTDB_PATHS,
  type BookingOptionService,
  type BookingOptionUnavailable,
  type BookingOptionsResult,
  type BookingStatus,
  type CancelBookingResult,
  type CancellationReason,
  type CreateBookingResult,
  type FareBreakdown,
  type FareQuoteResult,
  type MoneyPaise,
  type PricingRuleRecord,
  type RouteSource,
  type ServiceTypeId,
  type ServiceTypeRecord,
} from '@drivx/domain';
import { db, epochMs, rtdb, serverTimestamp } from '../lib/admin';
import { CALLABLE_OPTIONS, RATE_LIMITS } from '../lib/config';
import { offerTrip } from '../lib/dispatch';
import { configuredCommissionTerms } from '../lib/dues';
import { failedPrecondition, parseInput, permissionDenied, resourceExhausted } from '../lib/errors';
import { requireAuth, requireCustomer, requireCustomerCaller, type Caller } from '../lib/guards';
import { asRule, loadPricingContext, loadRoundTripOffer, offeredTiers, priceTrip, publishedTerms, type PricingContext } from '../lib/pricing';
import { measureRoute, routingIsConfigured } from '../lib/routes';

/**
 * The customer's booking surface: what can be bought, what it costs, and the
 * booking itself.
 *
 * Three callables, in the order a customer meets them. `bookingOptions` says
 * which services are open and what a package contains; `quoteFare` prices a
 * chosen trip on the server; `createBooking` writes the booking with *that*
 * quote stored inside it. Nothing between them trusts a number from the device —
 * the fare is computed twice server-side, once to show and once to store, and a
 * client never sends either total.
 */

const registerTokenInput = z.object({
  /** FCM registration token for this device. */
  token: z.string().min(20).max(600),
  platform: z.enum(['ios', 'android', 'web']),
});

/**
 * Stores the device's push token on the caller's own account.
 *
 * Any signed-in role, not just customers: a driver's phone has to be reachable
 * for assignment offers, and the write only ever touches the caller's own doc.
 * Sending is Phase 5.
 */
export const registerDeviceToken = onCall(CALLABLE_OPTIONS, async (request) => {
  const caller = requireAuth(request);
  const input = parseInput(registerTokenInput, request.data);
  const tokenId = createHash('sha256').update(input.token).digest('hex');
  await db().collection('users').doc(caller.uid).collection('deviceTokens').doc(tokenId).set({
    token: input.token,
    platform: input.platform,
    updatedAtMs: serverTimestamp(),
  }, { merge: true });

  return { registered: true };
});

/** Revokes this signed-in device's push target when the user turns push off. */
export const unregisterDeviceToken = onCall(CALLABLE_OPTIONS, async (request) => {
  const caller = requireAuth(request);
  const input = z.object({ token: z.string().min(20).max(600) }).safeParse(request.data);
  if (!input.success) throw new HttpsError('invalid-argument', 'A device token is required.');
  const tokenId = createHash('sha256').update(input.data.token).digest('hex');
  await db().collection('users').doc(caller.uid).collection('deviceTokens').doc(tokenId).delete();
  return { unregistered: true };
});

/** Display code for a booking, e.g. DRX-7K3QD2. Ambiguous glyphs are excluded. */
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Derived from the idempotency key rather than drawn at random, so a retry of a
 * dropped request shows the customer the same reference. Uniqueness of the
 * booking itself comes from the document id, not from this string.
 */
function referenceFromKey(idempotencyKey: string): string {
  const digest = createHash('sha256').update(idempotencyKey).digest();
  const body = Array.from(digest.subarray(0, 6), (byte) =>
    REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length],
  ).join('');
  return `${BOOKING_REFERENCE_PREFIX}-${body}`;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Verified drivers who are online and can serve one service.
 *
 * Only the count leaves this function. Precise positions are never broadcast to
 * customers — an assignment is what turns a driver into a named, tracked
 * participant on a trip.
 */
async function countOnlineDrivers(zoneId: string, serviceTypeId: ServiceTypeId): Promise<number> {
  const snap = await db()
    .collection('driverProfiles')
    .where('verificationStatus', '==', 'approved')
    .where('availabilityState', '==', 'online')
    .limit(50)
    .get();
  return snap.docs.filter(
    (docSnap) =>
      docSnap.data().zoneId === zoneId &&
      Array.isArray(docSnap.data().serviceTypeIds) &&
      (docSnap.data().serviceTypeIds as string[]).includes(serviceTypeId),
  ).length;
}

/**
 * What the booking screen may offer, what it may not, and how the distance
 * will be measured.
 *
 * `pricingRules` are not client-readable, so the tier list and the published
 * terms are projected here: label, hours, included kilometres, the sticker
 * price, and the rates a customer would otherwise have to book a trip to learn —
 * per kilometre, per extra hour, the night window, the free waiting minutes.
 * What is deliberately absent is the arithmetic: a total is still only ever
 * produced by `quoteFare`.
 *
 * Disabled services come back as a named, explained absence rather than
 * vanishing. A customer comparing this app to a cab aggregator asks where the
 * cabs are; the honest answer is in the service document's own description.
 */
export const bookingOptions = onCall(CALLABLE_OPTIONS, async (request) => {
  requireCustomer(request);

  const all = await db().collection('serviceTypes').orderBy('sortOrder').limit(25).get();

  const services: BookingOptionService[] = [];
  const unavailable: BookingOptionUnavailable[] = [];

  for (const docSnap of all.docs) {
    const serviceType = docSnap.data() as unknown as ServiceTypeRecord;
    const base = { id: serviceType.id, name: serviceType.name };

    if (serviceType.enabled !== true) {
      unavailable.push({ ...base, reason: serviceType.description || 'Not open yet.' });
      continue;
    }

    const ruleId =
      typeof serviceType.pricingRuleId === 'string' ? serviceType.pricingRuleId : '';
    const ruleSnap = ruleId ? await db().doc(`pricingRules/${ruleId}`).get() : null;
    if (!ruleSnap?.exists) {
      // Offered but unpriceable: the button would only ever fail, so it is left
      // out of `services` and the reason is logged and shown instead.
      console.warn(
        JSON.stringify({ fn: 'bookingOptions', outcome: 'no_pricing_rule', serviceTypeId: docSnap.id }),
      );
      unavailable.push({ ...base, reason: 'Pricing for this service is not configured yet.' });
      continue;
    }

    const rule = asRule(ruleId, ruleSnap.data() as Record<string, unknown>);
    if (!rule.active) {
      unavailable.push({ ...base, reason: 'This service is paused by the operations team.' });
      continue;
    }

    const roundTripOffer = await loadRoundTripOffer(serviceType);
    services.push({
      ...base,
      description: serviceType.description,
      pricingModel: rule.pricingModel,
      vehicleOwnership: serviceType.vehicleOwnership,
      allowsHourly: serviceType.allowsHourly,
      allowsScheduling: serviceType.allowsScheduling,
      minDurationMinutes: serviceType.minDurationMinutes,
      iconKey: serviceType.iconKey,
      sortOrder: serviceType.sortOrder,
      zoneId: rule.zoneId,
      driversOnline: await countOnlineDrivers(rule.zoneId, serviceType.id),
      tiers: offeredTiers({ serviceType, rule }),
      terms: publishedTerms(rule),
      // A separate read, because a round trip is priced by a different rule and
      // both the tier list and the rate card have to come from that rule.
      roundTripTiers: roundTripOffer?.tiers ?? null,
      roundTripTerms: roundTripOffer?.terms ?? null,
    });
  }

  const result: BookingOptionsResult = {
    services,
    unavailable,
    routingIsRoadDistance: routingIsConfigured(),
  };
  return result;
});

/**
 * Prices a trip without booking it.
 *
 * The distance comes from the Routes API when a key is configured and from a
 * straight line otherwise; `distanceSource` says which, and the fare card is
 * expected to repeat it. Drive time is null on the straight-line path rather
 * than guessed from an average speed, because an invented duration becomes an
 * invented line on the customer's receipt.
 */
export const quoteFare = onCall(CALLABLE_OPTIONS, async (request) => {
  requireCustomer(request);
  // The same schema the client validates with, re-run here: sharing it is what
  // stops the two sides disagreeing about what a valid request is.
  const input = parseInput(fareQuoteInputSchema, request.data);

  const ctx = await loadPricingContext(input.serviceTypeId, input.tripDirection);
  const nowMs = Date.now();
  const departAtMs = input.scheduledForMs ?? nowMs;
  const route = await measureRoute(input.pickup.location, input.destination.location, departAtMs);

  const breakdown = priceTrip({
    ctx,
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds ?? 0,
    departAtMs,
    packageTierId: input.packageTierId ?? null,
    quoteId: `quote-${randomUUID()}`,
    kind: 'estimate',
    nowMs,
  });

  const result: FareQuoteResult = {
    serviceTypeId: input.serviceTypeId,
    serviceTypeName: ctx.serviceType.name,
    zoneId: ctx.rule.zoneId,
    pricingRuleId: ctx.rule.id,
    tripDirection: input.tripDirection,
    breakdown,
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    distanceSource: route.source,
    packageTierId: breakdown.packageTierId,
    serverNowMs: nowMs,
  };
  return result;
});

/**
 * Previews a coupon against a freshly server-priced route. This is read-only:
 * createBooking rechecks and consumes the coupon atomically at confirmation.
 */
export async function previewCouponForCaller(caller: Caller, rawInput: unknown) {
  requireCustomerCaller(caller);
  const input = parseInput(couponPreviewInputSchema, rawInput);
  const couponCode = input.couponCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
  if (!couponCode) throw new HttpsError('invalid-argument', 'Enter a coupon code.');

  const nowMs = Date.now();
  const departAtMs = input.scheduledForMs ?? nowMs;
  const ctx = await loadPricingContext(input.serviceTypeId, input.tripDirection);
  const route = await measureRoute(input.pickup.location, input.destination.location, departAtMs);
  const breakdown = priceTrip({
    ctx,
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds ?? 0,
    departAtMs,
    packageTierId: input.packageTierId ?? null,
    quoteId: `coupon-preview-${randomUUID()}`,
    kind: 'estimate',
    nowMs,
  });

  const [settings, coupon, usage] = await Promise.all([
    db().doc('appConfig/rewards').get(),
    db().doc(`rewardCoupons/${couponCode}`).get(),
    db().doc(`rewardCouponUsage/${couponCode}_${caller.uid}`).get(),
  ]);
  const cfg = settings.data() ?? {};
  const data = coupon.data() ?? {};
  const max = Number(data.maxRedemptions ?? 0);
  const used = Number(data.redemptionCount ?? 0);
  const expiresAtMs = Number(data.expiresAtMs ?? 0);
  if (
    cfg.enabled === false || cfg.couponsEnabled === false || !coupon.exists || data.active !== true ||
    (expiresAtMs > 0 && expiresAtMs < nowMs) || (max > 0 && used >= max) || usage.exists ||
    Number(data.perUserLimit ?? 1) < 1
  ) {
    throw new HttpsError('failed-precondition', 'This coupon is invalid, expired, inactive or already used.');
  }
  if (breakdown.totalPaise < Number(data.minimumFarePaise ?? 0)) {
    throw new HttpsError('failed-precondition', 'This booking does not meet the coupon minimum.');
  }
  const value = Number(data.discountValue ?? 0);
  const discountPaise = Math.min(
    breakdown.totalPaise,
    Math.max(0, data.discountType === 'percent' ? Math.floor(breakdown.totalPaise * value / 100) : value * 100),
  );
  return {
    couponCode,
    baseFarePaise: breakdown.totalPaise,
    discountPaise,
    customerPayablePaise: breakdown.totalPaise - discountPaise,
    currency: 'INR' as const,
  };
}

/**
 * Rebuilds a response from a booking that already exists.
 *
 * A replay never re-prices: the stored estimate is the price the customer was
 * shown and accepted the first time, and quoting again could hand them a
 * different total for a trip already booked. How that distance was measured is
 * only ever recorded in the creation event, so it is read from there — and
 * reported as null rather than assumed when the event does not carry it.
 */
async function deduplicatedResult(
  bookingId: string,
  data: Record<string, unknown>,
  ctx: PricingContext,
): Promise<CreateBookingResult> {
  const stored = data.estimate as FareBreakdown;
  const eventSnap = await db().doc(`bookings/${bookingId}/events/ev-booking_created`).get();
  const payload = (eventSnap.data()?.payload ?? {}) as Record<string, unknown>;
  const recorded = payload.distanceSource;

  return {
    serviceTypeId: ctx.serviceType.id,
    serviceTypeName: ctx.serviceType.name,
    zoneId: typeof data.zoneId === 'string' ? data.zoneId : ctx.rule.zoneId,
    pricingRuleId: stored.pricingRuleId ?? ctx.rule.id,
    tripDirection: data.tripDirection === 'round_trip' ? 'round_trip' : 'one_way',
    breakdown: stored,
    distanceMeters: Number(data.estimatedDistanceMeters ?? 0),
    durationSeconds: typeof data.estimatedDurationSeconds === 'number' ? data.estimatedDurationSeconds : null,
    distanceSource:
      recorded === 'google_routes' || recorded === 'haversine_fallback' ? recorded : null,
    packageTierId: stored.packageTierId ?? null,
    serverNowMs: Date.now(),
    bookingId,
    reference: String(data.reference ?? ''),
    status: data.status as BookingStatus,
    createdAtMs: epochMs(data.createdAtMs),
    deduplicated: true,
    rewardSnapshot: (data.rewardSnapshot as CreateBookingResult['rewardSnapshot'] | undefined) ?? {
      couponCode: null, walletRedeemedPaise: 0, milesRedeemedPoints: 0,
      discountPaise: 0, customerPayablePaise: stored.totalPaise,
      driverSubsidyPaise: 0,
    },
  };
}

/**
 * Books the trip at the fare the server just quoted.
 *
 * Four things are checked before anything is written: the caller is a customer,
 * the service is enabled and priced, the account is inside the booking throttle,
 * and the idempotency key has not been used. The key doubles as the document id,
 * so a retried request — the classic double-charge on a flaky network — resolves
 * to the booking that already exists instead of a second one.
 *
 * The stored estimate is computed here, not carried over from `quoteFare`: a
 * customer can sit on a quote until it lapses, and honouring an old price would
 * be a pricing decision made by the device's clock.
 */
export const createBooking = onCall(CALLABLE_OPTIONS, async (request) => {
  const caller = requireCustomer(request);
  const input = parseInput(createBookingInputSchema, request.data);

  const ctx = await loadPricingContext(input.serviceTypeId, input.tripDirection);
  const nowMs = Date.now();
  const departAtMs = input.scheduledForMs ?? nowMs;

  const recent = await db()
    .collection('bookings')
    .where('customerUid', '==', caller.uid)
    .orderBy('createdAtMs', 'desc')
    .limit(RATE_LIMITS.bookingsPerCustomerPerHour + 1)
    .get();
  const insideHour = recent.docs.filter(
    (docSnap) => (epochMs(docSnap.data().createdAtMs) ?? 0) > nowMs - HOUR_MS,
  ).length;
  if (insideHour >= RATE_LIMITS.bookingsPerCustomerPerHour) {
    throw resourceExhausted(
      `This account has ${RATE_LIMITS.bookingsPerCustomerPerHour} bookings per hour. Wait a little and try again.`,
    );
  }

  const route = await measureRoute(input.pickup.location, input.destination.location, departAtMs);
  const breakdown = priceTrip({
    ctx,
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds ?? 0,
    departAtMs,
    packageTierId: input.packageTierId ?? null,
    quoteId: `booking-${input.idempotencyKey}`,
    kind: 'estimate',
    nowMs,
  });
  const commissionTerms = await configuredCommissionTerms();
  const commission = commissionSnapshotFor(breakdown, commissionTerms.rate, commissionTerms.gstRate);

  // Reward selections are requests only. The wallet, miles and coupon are
  // checked and consumed atomically with the booking below.
  const rewardConfigRef = db().doc('appConfig/rewards');
  const customerRewardRef = db().doc(`rewardAccounts/${caller.uid}`);
  const couponCode = String(input.couponCode ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
  const couponRef = couponCode ? db().doc(`rewardCoupons/${couponCode}`) : null;
  const couponUseRef = couponCode ? db().doc(`rewardCouponUsage/${couponCode}_${caller.uid}`) : null;
  const walletLedgerRef = customerRewardRef.collection('ledger').doc(`wallet_use_${input.idempotencyKey}`);
  const milesLedgerRef = customerRewardRef.collection('ledger').doc(`miles_use_${input.idempotencyKey}`);
  const couponLedgerRef = customerRewardRef.collection('ledger').doc(`coupon_use_${input.idempotencyKey}`);

  const bookingId = `bk-${input.idempotencyKey}`;
  const bookingRef = db().doc(`bookings/${bookingId}`);
  const eventRef = db().doc(`bookings/${bookingId}/events/ev-booking_created`);

  const existing = await bookingRef.get();
  if (existing.exists) {
    return await deduplicatedResult(bookingId, existing.data() ?? {}, ctx);
  }

  const reference = referenceFromKey(input.idempotencyKey);
  const notes = input.preferences.notes?.trim() || null;

  let rewardSnapshot = { couponCode: null as string | null, walletRedeemedPaise: 0, milesRedeemedPoints: 0, discountPaise: 0, customerPayablePaise: breakdown.totalPaise, driverSubsidyPaise: 0 };
  let concurrentReplay = false;
  await db().runTransaction(async (tx) => {
    const [bookingExists, rewardSettings, rewardAccount, coupon, couponUse, walletLedger, milesLedger, couponLedger] = await Promise.all([
      tx.get(bookingRef),
      tx.get(rewardConfigRef), tx.get(customerRewardRef), couponRef ? tx.get(couponRef) : Promise.resolve(null),
      couponUseRef ? tx.get(couponUseRef) : Promise.resolve(null), tx.get(walletLedgerRef), tx.get(milesLedgerRef), tx.get(couponLedgerRef),
    ]);
    if (bookingExists.exists) { concurrentReplay = true; return; }
    if (walletLedger.exists || milesLedger.exists || couponLedger.exists) throw new HttpsError('already-exists', 'This booking key has already used rewards.');
    const cfg = rewardSettings.data() ?? {};
    const rewardsEnabled = cfg.enabled !== false;
    let couponDiscount = 0;
    if (couponCode) {
      const data = coupon?.data() ?? {};
      const max = Number(data.maxRedemptions ?? 0); const used = Number(data.redemptionCount ?? 0);
      const perUser = Number(data.perUserLimit ?? 1);
      if (!rewardsEnabled || cfg.couponsEnabled === false || !coupon?.exists || data.active !== true || Number(data.expiresAtMs ?? 0) > 0 && Number(data.expiresAtMs) < nowMs || max > 0 && used >= max || couponUse?.exists || perUser < 1) {
        throw new HttpsError('failed-precondition', 'This coupon is invalid, expired, inactive or already used.');
      }
      if (breakdown.totalPaise < Number(data.minimumFarePaise ?? 0)) throw new HttpsError('failed-precondition', 'This booking does not meet the coupon minimum.');
      const value = Number(data.discountValue ?? 0);
      couponDiscount = data.discountType === 'percent' ? Math.floor(breakdown.totalPaise * value / 100) : value * 100;
      couponDiscount = Math.min(breakdown.totalPaise, Math.max(0, couponDiscount));
    }
    const acct = rewardAccount?.data() ?? {};
    let walletBalance = Number(acct.walletPaise ?? 0);
    if (rewardsEnabled && rewardAccount?.exists) {
      const ledger = await tx.get(customerRewardRef.collection('ledger'));
      walletBalance = ledger.docs.reduce((sum, row) => {
        const line = row.data(); const amount = Number(line.amountPaise ?? 0);
        if (Number(line.expiresAtMs ?? 0) > 0 && Number(line.expiresAtMs) <= nowMs) return sum;
        return sum + amount;
      }, 0);
    } else walletBalance = 0;
    let walletRedeemed = cfg.walletRedemptionEnabled !== false ? Math.min(Math.max(0, input.redeemWalletPaise), Math.max(0, walletBalance), Math.max(0, breakdown.totalPaise - couponDiscount)) : 0;
    const pointsBalance = rewardsEnabled && cfg.milesRedemptionEnabled !== false && cfg.milesEnabled !== false ? Math.max(0, Number(acct.milesPoints ?? 0)) : 0;
    const milesPoints = Math.min(Math.max(0, input.redeemMilesPoints), pointsBalance);
    const milesRate = Number(cfg.milesPaisePer100Points ?? 2_000);
    const milesDiscount = Math.min(Math.max(0, breakdown.totalPaise - couponDiscount - walletRedeemed), Math.floor(milesPoints * milesRate / 100));
    const actualMilesPoints = milesRate > 0 ? Math.min(milesPoints, Math.floor(milesDiscount * 100 / milesRate)) : 0;
    // Driver commission/earnings remain based on the agreed fare. Promo value is
    // recorded as a platform-funded subsidy and later added to payable rewards.
    const discountPaise = couponDiscount + walletRedeemed + milesDiscount;
    rewardSnapshot = { couponCode: couponCode || null, walletRedeemedPaise: walletRedeemed, milesRedeemedPoints: actualMilesPoints, discountPaise, customerPayablePaise: breakdown.totalPaise - discountPaise, driverSubsidyPaise: discountPaise };
    tx.set(bookingRef, {
        id: bookingId,
        reference,
        customerUid: caller.uid,
        assignedDriverUid: null,
        // The customer's copy of the driver lands beside the uid, written by the
        // server when a driver is assigned. Nothing before that has a face to show.
        driver: null,
        serviceTypeId: input.serviceTypeId,
        zoneId: ctx.rule.zoneId,
        // Searching for a driver is dispatch's job (Phase 3); a booking stops at
        // `requested` until a function moves it, which is why no status here is
        // ever a promise of a car.
        status: 'requested',
        paymentStatus: 'estimated',
        pickup: input.pickup,
        destination: input.destination,
        // Radius comes from the service type; the centre is the customer's own
        // pickup pin, because the arrival fence has to sit around where they are.
        pickupGeofence: {
          center: input.pickup.location,
          radiusMeters: ctx.serviceType.pickupGeofence.radiusMeters,
        },
        destinationGeofence: {
          center: input.destination.location,
          radiusMeters: ctx.serviceType.destinationGeofence?.radiusMeters ?? 120,
        },
        scheduledForMs: input.scheduledForMs ?? null,
        // Which rule priced this booking, kept so a replay and a dispute read the
        // same answer the customer was shown.
        tripDirection: input.tripDirection,
        // Preserve the exact rates accepted with this quote. Admin edits only
        // affect later quotes and cannot rewrite a trip being driven today.
        pricingRuleSnapshot: ctx.rule,
        createdAtMs: serverTimestamp(),
        updatedAtMs: serverTimestamp(),
        driverEnRouteEta: null,
        arrivalConfirmedAtMs: null,
        arrivalConfirmedManually: false,
        tripStartedAtMs: null,
        // The car's own dials. Empty here means "not read yet", never zero —
        // the final fare is priced from the opening and closing readings, so a
        // missing one has to stay distinguishable from a car at 0 km.
        startOdometerKm: null,
        currentOdometerKm: null,
        endOdometerKm: null,
        destinationDetectedAtMs: null,
        completedAtMs: null,
        completionConfirmedManually: false,
        // The office's cut, captured at the moment the fare was priced. The
        // commission trigger bills from this block and the driver's earnings
        // screen reads it, so a later rate change cannot move a booked trip.
        commission,
        estimate: breakdown,
        rewardSnapshot,
        // What the car has run so far, once the driver starts posting readings.
        runningFare: null,
        finalFare: null,
        customerPreferences: {
          transmission: input.preferences.transmission,
          carType: input.preferences.carType,
          vehicleDescription: input.preferences.vehicleDescription?.trim() || null,
          notes,
        },
        cancellation: {
          by: null,
          reasonCode: null,
          reasonText: null,
          atMs: null,
          feePaise: 0,
          refundEligible: false,
        },
        idempotencyKey: input.idempotencyKey,
        routeGeometryRef: null,
        routePolyline: route.encodedPolyline,
        estimatedDistanceMeters: route.distanceMeters,
        estimatedDurationSeconds: route.durationSeconds,
        stateVersion: 1,
        supportHold: false,
      });
      tx.set(eventRef, {
        id: 'ev-booking_created',
        bookingId,
        type: 'booking_created',
        atMs: serverTimestamp(),
        actor: { uid: caller.uid, role: 'customer' },
        location: null,
        geofenceKind: null,
        fromStatus: null,
        toStatus: 'requested',
        payload: {
          serviceTypeId: input.serviceTypeId,
          packageTierId: breakdown.packageTierId,
          distanceMeters: route.distanceMeters,
          distanceSource: route.source,
          estimateTotalPaise: breakdown.totalPaise,
          customerPayablePaise: rewardSnapshot.customerPayablePaise,
          rewardDiscountPaise: rewardSnapshot.discountPaise,
        },
        requestId: input.idempotencyKey,
      });
    if (walletRedeemed > 0) {
      tx.create(walletLedgerRef, { type: 'wallet_redemption', amountPaise: -walletRedeemed, bookingId, createdAt: serverTimestamp(), createdAtMs: nowMs });
      tx.set(customerRewardRef, { walletPaise: Math.max(0, walletBalance - walletRedeemed), updatedAt: serverTimestamp() }, { merge: true });
    }
    if (actualMilesPoints > 0) {
      tx.create(milesLedgerRef, { type: 'miles_redemption', points: -actualMilesPoints, amountPaise: -milesDiscount, bookingId, createdAt: serverTimestamp(), createdAtMs: nowMs });
      tx.set(customerRewardRef, { milesPoints: pointsBalance - actualMilesPoints, updatedAt: serverTimestamp() }, { merge: true });
    }
    if (couponCode && couponRef && couponUseRef) {
      tx.create(couponUseRef, { code: couponCode, uid: caller.uid, bookingId, discountPaise: couponDiscount, createdAt: serverTimestamp(), createdAtMs: nowMs });
      tx.update(couponRef, { redemptionCount: Number(coupon?.data()?.redemptionCount ?? 0) + 1, updatedAtMs: nowMs });
      tx.create(couponLedgerRef, { type: 'coupon_redemption', amountPaise: -couponDiscount, code: couponCode, bookingId, createdAt: serverTimestamp(), createdAtMs: nowMs });
    }
  });

  if (concurrentReplay) return deduplicatedResult(bookingId, (await bookingRef.get()).data() ?? {}, ctx);

  console.log(
    JSON.stringify({
      level: 'info',
      fn: 'createBooking',
      outcome: 'created_dispatch_queued',
      actorUid: caller.uid,
      bookingId,
      serviceTypeId: input.serviceTypeId,
      distanceSource: route.source,
    totalPaise: rewardSnapshot.customerPayablePaise,
    }),
  );

  return {
    serviceTypeId: input.serviceTypeId,
    serviceTypeName: ctx.serviceType.name,
    zoneId: ctx.rule.zoneId,
    pricingRuleId: ctx.rule.id,
    tripDirection: input.tripDirection,
    breakdown,
    rewardSnapshot,
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    distanceSource: route.source,
    packageTierId: breakdown.packageTierId,
    serverNowMs: nowMs,
    bookingId,
    reference,
    // Dispatch is a Firestore create trigger. A slow realtime-location read
    // must never turn a successfully stored booking into an HTTP timeout.
    status: 'requested',
    createdAtMs: null, // serverTimestamp resolves on read; the client refetches
    deduplicated: false,
  } satisfies CreateBookingResult;
});

/**
 * Dispatch after the customer callable has returned. The realtime driver grid
 * can be temporarily unavailable; that must not erase a booking or leave the
 * customer staring at a transport-level 500. Retry the idempotent offer flow
 * from the durable Firestore event instead.
 */
export const dispatchNewBooking = onDocumentCreated(
  {
    region: CALLABLE_OPTIONS.region,
    document: 'bookings/{bookingId}',
    cpu: 'gcf_gen1',
    maxInstances: 1,
  },
  async (event) => {
    const bookingId = event.params.bookingId;
    try {
      const result = await offerTrip(bookingId);
      console.log(JSON.stringify({
        level: 'info',
        fn: 'dispatchNewBooking',
        outcome: result.offered ? 'offered' : 'no_eligible_driver',
        bookingId,
        driverUid: result.offered?.driverUid ?? null,
        skippedCount: result.skipped.length,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        fn: 'dispatchNewBooking',
        outcome: 'dispatch_failed',
        bookingId,
        detail: String((error as Error).message ?? error),
      }));
      throw error;
    }
  },
);

/**
 * The customer ends the trip.
 *
 * This is the only cancellation path in the product: a driver who cannot attend
 * releases the assignment back to dispatch, and staff cancellation is not an app
 * surface. So the caller is forced to be the booking's own customer, and the
 * only status that survives is one where the trip has not started.
 *
 * Two details carry weight. The status is re-read inside the transaction,
 * because between the check and the write a driver can start the trip, and
 * cancelling under them would erase a journey that happened. And a second call
 * on an already-cancelled booking returns the original cancellation instead of
 * an error — a double tap on a slow connection is not a failure the customer
 * should be shown.
 *
 * There is no cancellation fee. Nothing is collected when a booking is made, so
 * there is no money to forfeit; whether a late cancellation should cost anything
 * is the owner's open business decision, and this function will not invent one.
 */
export const cancelBooking = onCall(CALLABLE_OPTIONS, async (request) =>
  cancelBookingForCaller(requireCustomer(request), request.data),
);

/** Shared implementation for the callable and authenticated Hosting gateway. */
export async function cancelBookingForCaller(caller: Caller, raw: unknown) {
  const trustedCaller = requireCustomerCaller(caller);
  const input = parseInput(cancelBookingInputSchema, raw);

  const bookingRef = db().doc(`bookings/${input.bookingId}`);
  const before = await bookingRef.get();
  if (!before.exists || before.data()?.customerUid !== caller.uid) {
    throw permissionDenied('This booking does not belong to your account.');
  }

  const currentStatus = String(before.data()?.status ?? '') as BookingStatus;
  if (currentStatus !== 'cancelled' && !isCancellable(currentStatus)) {
    throw failedPrecondition(
      isActiveTrip(currentStatus)
        ? 'The trip has already started, so it cannot be cancelled here. Contact support about this journey.'
        : 'This booking is already closed, so there is nothing to cancel.',
    );
  }

  const eventRef = db().doc(`bookings/${input.bookingId}/events/ev-booking_cancelled`);

  const outcome = await db().runTransaction(async (tx) => {
    const snapshot = await tx.get(bookingRef);
    const data = snapshot.data() ?? {};
    const status = String(data.status ?? '') as BookingStatus;

    if (status === 'cancelled') {
      const stored = (data.cancellation ?? {}) as Record<string, unknown>;
      return {
        alreadyCancelled: true,
        status,
        reference: String(data.reference ?? ''),
        reasonCode: (stored.reasonCode as CancellationReason | null) ?? null,
        cancelledAtMs: epochMs(stored.atMs),
        feePaise: Number(stored.feePaise ?? 0) as MoneyPaise,
        hadDriverAssigned: data.assignedDriverUid != null,
        releasedDriverUid: null,
        zoneId: null,
      };
    }

    if (!isCancellable(status)) {
      // The booking moved between the read above and this one — usually the
      // chauffeur starting the trip. Nothing has been written.
      throw failedPrecondition(
        'The status of this trip just changed, so it was not cancelled. Reload it and try again.',
      );
    }

    const assignmentsQuery = bookingRef.collection('assignments');
    const assignments = await tx.get(assignmentsQuery);
    const assignedDriverUid = typeof data.assignedDriverUid === 'string' ? data.assignedDriverUid : null;
    const driverProfileRef = assignedDriverUid
      ? db().doc(`driverProfiles/${assignedDriverUid}`)
      : null;
    const driverProfile = driverProfileRef ? await tx.get(driverProfileRef) : null;

    const fromStatus = status;
    tx.update(bookingRef, {
      status: 'cancelled',
      cancellation: {
        by: 'customer',
        reasonCode: input.reasonCode,
        reasonText: input.reasonText,
        atMs: serverTimestamp(),
        feePaise: 0,
        refundEligible: false,
      },
      updatedAtMs: serverTimestamp(),
      stateVersion: Number(data.stateVersion ?? 0) + 1,
    });
    tx.set(eventRef, {
      id: 'ev-booking_cancelled',
      bookingId: input.bookingId,
      type: 'booking_cancelled',
      atMs: serverTimestamp(),
      // The role is stated rather than assumed: the same document may later be
      // closed by staff, and the audit trail has to show who did it.
      actor: { uid: trustedCaller.uid, role: 'customer' },
      location: null,
      geofenceKind: null,
      fromStatus,
      toStatus: 'cancelled',
      payload: {
        reasonCode: input.reasonCode,
        reasonText: input.reasonText,
        hadDriverAssigned: data.assignedDriverUid != null,
        estimatedTotalPaise: data.estimate?.totalPaise ?? null,
      },
      requestId: null,
    });

    // End every offer/assignment with the cancelled booking, otherwise a stale
    // driver offer can remain visible and an accepted driver stays stuck in
    // `on_assignment` after the customer has ended the trip.
    for (const assignment of assignments.docs) {
      const assignmentStatus = String(assignment.data().status ?? '');
      if (assignmentStatus === 'offered' || assignmentStatus === 'accepted') {
        tx.update(assignment.ref, {
          status: 'revoked', respondedAtMs: Date.now(), updatedAtMs: serverTimestamp(),
          revokeReason: 'customer_cancelled_booking',
        });
      }
    }
    if (driverProfileRef && driverProfile?.exists) {
      tx.update(driverProfileRef, {
        availabilityState: 'offline', availabilitySinceMs: null, updatedAtMs: serverTimestamp(),
      });
    }

    return {
      alreadyCancelled: false,
      status: 'cancelled' as BookingStatus,
      reference: String(data.reference ?? ''),
      reasonCode: input.reasonCode as CancellationReason | null,
      cancelledAtMs: null,
      feePaise: 0 as MoneyPaise,
      hadDriverAssigned: data.assignedDriverUid != null,
      releasedDriverUid: assignedDriverUid,
      zoneId: typeof data.zoneId === 'string' ? data.zoneId : null,
    };
  });

  // Firestore is authoritative. Best-effort realtime cleanup prevents the
  // customer map and dispatch grid from retaining an ended pre-trip booking.
  if (!outcome.alreadyCancelled && outcome.releasedDriverUid) {
    const cleanup = [
      rtdb().ref(RTDB_PATHS.activeBooking(input.bookingId)).remove(),
      rtdb().ref(`authz/${input.bookingId}`).remove(),
      rtdb().ref(RTDB_PATHS.driverLocation(outcome.releasedDriverUid)).remove(),
      rtdb().ref(RTDB_PATHS.presence(outcome.releasedDriverUid)).update({
        state: 'offline', location: null, updatedAtMs: Date.now(),
      }),
      ...(outcome.zoneId
        ? [rtdb().ref(RTDB_PATHS.dispatchGrid(outcome.zoneId, outcome.releasedDriverUid)).remove()]
        : []),
    ];
    await Promise.allSettled(cleanup);
  }

  console.log(
    JSON.stringify({
      level: 'info',
      fn: 'cancelBooking',
      outcome: outcome.alreadyCancelled ? 'already_cancelled' : 'cancelled',
      actorUid: trustedCaller.uid,
      bookingId: input.bookingId,
      reasonCode: input.reasonCode,
      hadDriverAssigned: outcome.hadDriverAssigned,
    }),
  );

  return {
    bookingId: input.bookingId,
    alreadyCancelled: outcome.alreadyCancelled,
    status: outcome.status,
    reference: outcome.reference,
    reasonCode: outcome.reasonCode,
    cancelledAtMs: outcome.cancelledAtMs,
    feePaise: outcome.feePaise,
    hadDriverAssigned: outcome.hadDriverAssigned,
  } satisfies CancelBookingResult;
}

/**
 * Driver eligibility, zone matching and the move to `searching_driver` are
 * deliberately *not* here. That is dispatch (Phase 3): it needs the offer
 * records, the response window and the admin override, and guessing at it from
 * the booking path would produce assignments nobody audited.
 */
