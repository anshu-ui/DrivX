import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { randomBytes } from 'node:crypto';
import { REGION } from '../lib/config';
import { db, serverTimestamp, writeAuditLog } from '../lib/admin';
import { requireAdmin, requireAuth, requireCustomer, requireCustomerCaller, requireDriver, requireDriverCaller, type Caller } from '../lib/guards';
import { invalidArgument } from '../lib/errors';

const OPTIONS = { region: REGION, cors: true };
export const DEFAULT_REWARD_RULES = {
  enabled: true, customerReferralCreditPaise: 10_000, customerReferralMinimumFarePaise: 39_900,
  creditExpiryDays: 60, milesPer100Rupees: 5, milesPaisePer100Points: 2_000,
  driverTripsFirstMilestone: 10, driverFirstMilestonePaise: 20_000,
  driverTripsSecondMilestone: 20, driverSecondMilestonePaise: 30_000,
  driverMilestoneWindowDays: 30, driverMinimumRating: 4.5, driverMinimumRatings: 3, driverChampionReferralCount: 5,
  customerReferralEnabled: true, milesEnabled: true, driverReferralEnabled: true,
  couponsEnabled: true, walletRedemptionEnabled: true, milesRedemptionEnabled: true,
};
const codeOf = (value: unknown) => String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
// Short, readable invite codes avoid exposing any part of a Firebase UID.
const REFERRAL_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const newReferralCode = () => {
  const bytes = randomBytes(6);
  return `DRX${Array.from(bytes, byte => REFERRAL_ALPHABET[byte % REFERRAL_ALPHABET.length]).join('')}`;
};
const account = (uid: string) => db().doc(`rewardAccounts/${uid}`);
const rulesRef = () => db().doc('appConfig/rewards');
const isInt = (v: unknown, min = 0) => Number.isSafeInteger(v) && Number(v) >= min;
const rolesOf = (caller: { claims: { roles?: string[]; role?: string } }) => new Set([...(caller.claims.roles ?? []), caller.claims.role]);

async function ensureAccount(uid: string, role: 'customer' | 'driver') {
  const ref = account(uid);
  const candidates = Array.from({ length: 24 }, newReferralCode);
  await db().runTransaction(async tx => {
    const a = await tx.get(ref);
    const field = role === 'customer' ? 'customerReferralCode' : 'driverReferralCode';
    const existingCode = codeOf(a.data()?.[field]);
    const needsShortCode = !existingCode || existingCode.length > 9;
    const legacyCodeRef = existingCode ? db().doc(`rewardCodes/${role}_${existingCode}`) : null;
    const legacyCodeSnap = legacyCodeRef ? await tx.get(legacyCodeRef) : null;
    if (existingCode && !needsShortCode && legacyCodeSnap?.exists && legacyCodeSnap.data()?.uid !== uid) {
      throw new HttpsError('failed-precondition', 'Your referral code needs Admin support.');
    }
    const codeRefs = needsShortCode ? candidates.map(code => db().doc(`rewardCodes/${role}_${code}`)) : [];
    const codeSnaps = needsShortCode ? await Promise.all(codeRefs.map(codeRef => tx.get(codeRef))) : [];
    let code = existingCode;
    let codeRef = legacyCodeRef ?? undefined;
    if (needsShortCode) {
      const index = codeSnaps.findIndex(snap => !snap.exists);
      if (index < 0) throw new HttpsError('resource-exhausted', 'Could not generate a short referral code. Please try again.');
      code = candidates[index]!;
      codeRef = codeRefs[index]!;
    }
    if (!a.exists) tx.create(ref, { uid, [field]: code, walletPaise: 0, milesPoints: 0, lifetimeMilesPoints: 0, customerTrips: 0, driverTrips: 0, rewardPayablePaise: 0, qualifiedDriverReferrals: 0, badges: [], updatedAt: serverTimestamp() });
    else if (code !== existingCode) tx.update(ref, { [field]: code, updatedAt: serverTimestamp() });
    const selected = needsShortCode ? codeSnaps[candidates.indexOf(code)]! : legacyCodeSnap;
    if (!selected?.exists && codeRef) tx.create(codeRef, { uid, role, createdAt: serverTimestamp() });
    // Preserve an old shared code as an alias after the account moves to a short one.
    // Never overwrite a code index that now belongs to someone else.
    if (needsShortCode && legacyCodeRef && !legacyCodeSnap?.exists) {
      tx.create(legacyCodeRef, { uid, role, createdAt: serverTimestamp(), legacyAlias: true });
    }
  });
  return ref;
}

export async function getRewardsForCaller(caller: Caller, input: unknown) {
  const roles = rolesOf(caller);
  const requestedRole = (input as { role?: unknown } | null)?.role;
  const role = requestedRole === 'driver' && roles.has('driver') ? 'driver' : 'customer';
  if (role === 'customer' && !roles.has('customer')) throw new HttpsError('permission-denied', 'Customer access required.');
  if (role === 'driver' && !roles.has('driver')) throw new HttpsError('permission-denied', 'Driver access required.');
  const ref = await ensureAccount(caller.uid, role);
  const referralRef = db().doc(`rewardReferrals/${role}_${caller.uid}`);
  const payoutRequestRef = role === 'driver' ? db().doc(`driverRewardPayoutRequests/${caller.uid}`) : null;
  const [a, ledger, settings, referralSnap, profileSnap, payoutRequestSnap] = await Promise.all([
    ref.get(), ref.collection('ledger').orderBy('createdAtMs', 'desc').limit(50).get(), rulesRef().get(),
    referralRef.get(), role === 'driver' ? db().doc(`driverProfiles/${caller.uid}`).get() : Promise.resolve(null),
    payoutRequestRef ? payoutRequestRef.get() : Promise.resolve(null),
  ]);
  const data = a.data() ?? {}; const cfg = { ...DEFAULT_REWARD_RULES, ...(settings.data() ?? {}) };
  const rules = Object.fromEntries(Object.keys(DEFAULT_REWARD_RULES).map(key => [key, cfg[key as keyof typeof cfg]]));
  const profile = profileSnap?.data() ?? {};
  const payoutRequest = payoutRequestSnap?.exists ? payoutRequestSnap.data() : null;
  return { account: { customerReferralCode: data.customerReferralCode ?? null, driverReferralCode: data.driverReferralCode ?? null, walletPaise: Number(data.walletPaise ?? 0), milesPoints: Number(data.milesPoints ?? 0), lifetimeMilesPoints: Number(data.lifetimeMilesPoints ?? 0), customerTrips: Number(data.customerTrips ?? 0), driverTrips: Number(data.driverTrips ?? 0), rewardPayablePaise: Number(data.rewardPayablePaise ?? 0), qualifiedDriverReferrals: Number(data.qualifiedDriverReferrals ?? 0), badges: Array.isArray(data.badges) ? data.badges : [] }, referral: referralSnap.exists ? referralSnap.data() : null, payoutRequest: payoutRequest ? { status: String(payoutRequest.status ?? 'pending'), amountPaise: Number(payoutRequest.amountPaise ?? 0), accountLast4: String(payoutRequest.accountLast4 ?? String(payoutRequest.accountNumber ?? '').slice(-4)), reason: String(payoutRequest.rejectionReason ?? ''), createdAtMs: Number(payoutRequest.createdAtMs ?? 0) } : null, driver: role === 'driver' ? { ratingAverage: Number(profile.ratingAverage ?? 0), ratingCount: Number(profile.ratingCount ?? profile.ratingsCount ?? 0), verificationStatus: String(profile.verificationStatus ?? 'pending') } : null, rules, ledger: ledger.docs.map(d => ({ id: d.id, ...d.data() })) };
}
export const getRewards = onCall(OPTIONS, async request => getRewardsForCaller(requireAuth(request), request.data));

async function claimCode(uid: string, code: string, kind: 'customer' | 'driver') {
  const normalized = codeOf(code); if (!normalized) throw invalidArgument('Enter a referral code.');
  const settings = (await rulesRef().get()).data() ?? {};
  if (settings.enabled === false || kind === 'customer' && settings.customerReferralEnabled === false || kind === 'driver' && settings.driverReferralEnabled === false) throw new HttpsError('failed-precondition', 'This referral programme is paused.');
  const codeRef = db().doc(`rewardCodes/${kind}_${normalized}`); const attribution = db().doc(`rewardReferrals/${kind}_${uid}`);
  const userRef = db().doc(`users/${uid}`); const accountRef = await ensureAccount(uid, kind);
  await db().runTransaction(async tx => {
    const [codeSnap, old, user, acct] = await Promise.all([tx.get(codeRef), tx.get(attribution), tx.get(userRef), tx.get(accountRef)]);
    if (!codeSnap.exists) throw new HttpsError('not-found', 'Referral code not found.');
    const referrer = String(codeSnap.data()?.uid ?? '');
    if (!referrer || referrer === uid) throw invalidArgument('You cannot use your own referral code.');
    if (old.exists) throw invalidArgument('A referral code has already been applied.');
    if (kind === 'customer' && (Number(acct.data()?.customerTrips ?? 0) > 0 || user.data()?.firstCompletedBookingAtMs)) throw invalidArgument('Referral codes must be applied before your first completed trip.');
    if (kind === 'driver' && (Number(acct.data()?.driverTrips ?? 0) > 0 || user.data()?.firstCompletedDriverTripAtMs)) throw invalidArgument('Driver referral codes must be applied before your first completed trip.');
    tx.create(attribution, { kind, referrerUid: referrer, referredUid: uid, code: normalized, status: 'pending', createdAt: serverTimestamp(), createdAtMs: Date.now() });
  });
}
export async function claimReferralCodeForCaller(caller: Caller, data: unknown) {
  const customer = requireCustomerCaller(caller);
  await claimCode(customer.uid, String((data as { code?: unknown } | null)?.code ?? ''), 'customer');
  return { ok: true };
}
export async function claimDriverReferralCodeForCaller(caller: Caller, data: unknown) {
  const driver = requireDriverCaller(caller);
  await claimCode(driver.uid, String((data as { code?: unknown } | null)?.code ?? ''), 'driver');
  return { ok: true };
}
export async function requestDriverRewardPayoutForCaller(caller: Caller, data: unknown) {
  const driver = requireDriverCaller(caller); const body = (data ?? {}) as Record<string, unknown>;
  const amountPaise = Number(body.amountPaise); const holder = String(body.accountHolder ?? '').trim().replace(/\s+/g, ' ').slice(0, 100);
  const accountNumber = String(body.accountNumber ?? '').replace(/\D/g, ''); const confirm = String(body.confirmAccountNumber ?? '').replace(/\D/g, '');
  const ifsc = String(body.ifsc ?? '').trim().toUpperCase();
  if (!isInt(amountPaise, 1) || !holder || accountNumber.length < 8 || accountNumber.length > 20 || accountNumber !== confirm || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw invalidArgument('Enter a valid payout amount and matching bank details.');
  const accountRef = account(driver.uid); const requestRef = db().doc(`driverRewardPayoutRequests/${driver.uid}`); const now = Date.now();
  await db().runTransaction(async tx => {
    const [acct, old] = await Promise.all([tx.get(accountRef), tx.get(requestRef)]);
    if (!acct.exists) throw invalidArgument('Driver rewards account not found.');
    if (old.exists && old.data()?.status === 'pending') throw new HttpsError('already-exists', 'A payout request is already awaiting review.');
    const payable = Number(acct.data()?.rewardPayablePaise ?? 0);
    if (amountPaise > payable) throw invalidArgument('Payout request exceeds your payable referral rewards.');
    tx.set(requestRef, { uid: driver.uid, amountPaise, accountHolder: holder, accountNumber, accountLast4: accountNumber.slice(-4), ifsc, status: 'pending', createdAt: serverTimestamp(), createdAtMs: now, updatedAt: serverTimestamp(), updatedAtMs: now });
  });
  return { ok: true, status: 'pending' };
}
export const claimReferralCode = onCall(OPTIONS, async request => claimReferralCodeForCaller(requireCustomer(request), request.data));
export const claimDriverReferralCode = onCall(OPTIONS, async request => claimDriverReferralCodeForCaller(requireDriver(request), request.data));
export const requestDriverRewardPayout = onCall(OPTIONS, async request => requestDriverRewardPayoutForCaller(requireDriver(request), request.data));

export async function manageRewardsAdminForCaller(admin: Caller, data: unknown) {
  const body = (data ?? {}) as Record<string, any>; const action = String(body.action ?? '');
  if (action === 'read') {
    const [settings, coupons, referrals, payouts, payoutRequests, users] = await Promise.all([rulesRef().get(), db().collection('rewardCoupons').orderBy('updatedAtMs', 'desc').limit(100).get(), db().collection('rewardReferrals').orderBy('createdAtMs', 'desc').limit(100).get(), db().collection('rewardPayouts').orderBy('createdAtMs', 'desc').limit(100).get(), db().collection('driverRewardPayoutRequests').orderBy('createdAtMs', 'desc').limit(100).get(), db().collection('rewardAccounts').orderBy('updatedAt', 'desc').limit(100).get()]);
    return { rules: { ...DEFAULT_REWARD_RULES, ...(settings.data() ?? {}) }, coupons: coupons.docs.map(d => ({ id: d.id, ...d.data() })), referrals: referrals.docs.map(d => ({ id: d.id, ...d.data() })), payouts: payouts.docs.map(d => ({ id: d.id, ...d.data() })), payoutRequests: payoutRequests.docs.map(d => ({ id: d.id, ...d.data() })), accounts: users.docs.map(d => ({ id: d.id, ...d.data() })) };
  }
  if (action === 'saveRules') {
    const v = { ...DEFAULT_REWARD_RULES, ...(body.rules ?? {}) };
    for (const key of ['customerReferralCreditPaise','customerReferralMinimumFarePaise','creditExpiryDays','milesPer100Rupees','milesPaisePer100Points','driverTripsFirstMilestone','driverFirstMilestonePaise','driverTripsSecondMilestone','driverSecondMilestonePaise','driverMilestoneWindowDays','driverMinimumRatings','driverChampionReferralCount']) if (!isInt(v[key], 1)) throw invalidArgument(`Invalid reward setting: ${key}`);
    if (['enabled','customerReferralEnabled','milesEnabled','driverReferralEnabled','couponsEnabled','walletRedemptionEnabled','milesRedemptionEnabled'].some(key => typeof v[key] !== 'boolean') || typeof v.driverMinimumRating !== 'number' || v.driverMinimumRating < 0 || v.driverMinimumRating > 5 || v.driverTripsSecondMilestone <= v.driverTripsFirstMilestone) throw invalidArgument('Reward settings are invalid.');
    const before = (await rulesRef().get()).data() ?? null; await rulesRef().set({ ...v, updatedAtMs: Date.now(), updatedAt: serverTimestamp(), updatedByUid: admin.uid });
    await writeAuditLog({ actorUid: admin.uid, actorRole: 'admin', action: 'rewards_rules_updated', targetType: 'config', targetId: 'rewards', before, after: v }); return { ok: true };
  }
  if (action === 'saveCoupon') {
    const c = body.coupon ?? {}; const code = codeOf(c.code); const value = Number(c.discountValue); const type = c.discountType;
    if (!code || !['fixed','percent'].includes(type) || !isInt(value, 1) || (type === 'percent' && value > 100) || !isInt(Number(c.minimumFarePaise ?? 0)) || !isInt(Number(c.maxRedemptions ?? 0))) throw invalidArgument('Coupon fields are invalid.');
    const ref = db().doc(`rewardCoupons/${code}`); const before = (await ref.get()).data() ?? null; const after = { code, active: c.active === true, discountType: type, discountValue: value, minimumFarePaise: Number(c.minimumFarePaise ?? 0), maxRedemptions: Number(c.maxRedemptions ?? 0), expiresAtMs: Number(c.expiresAtMs ?? 0), updatedAtMs: Date.now(), updatedAt: serverTimestamp(), updatedByUid: admin.uid };
    await ref.set(after, { merge: true }); await writeAuditLog({ actorUid: admin.uid, actorRole: 'admin', action: 'reward_coupon_saved', targetType: 'coupon', targetId: code, before, after }); return { ok: true };
  }
  if (action === 'setCouponActive') {
    const code = codeOf(body.code); if (!code || typeof body.active !== 'boolean') throw invalidArgument('Coupon code and active state are required.');
    const ref = db().doc(`rewardCoupons/${code}`); const before = (await ref.get()).data(); if (!before) throw new HttpsError('not-found', 'Coupon not found.');
    await ref.update({ active: body.active, updatedAtMs: Date.now(), updatedAt: serverTimestamp(), updatedByUid: admin.uid });
    await writeAuditLog({ actorUid: admin.uid, actorRole: 'admin', action: 'reward_coupon_status_changed', targetType: 'coupon', targetId: code, before, after: { ...before, active: body.active } }); return { ok: true };
  }
  if (action === 'recordRequestedDriverPayout') {
    const uid = String(body.uid ?? '').trim(); const reference = String(body.reference ?? '').trim().slice(0, 100); const reason = String(body.reason ?? 'Driver referral reward payout').trim().slice(0, 300);
    if (!uid || !reference || !reason) throw invalidArgument('Driver, transfer reference and reason are required.');
    const requestRef = db().doc(`driverRewardPayoutRequests/${uid}`); const acctRef = account(uid); const payRef = db().collection('rewardPayouts').doc(); const ledgerRef = acctRef.collection('ledger').doc(payRef.id); const now = Date.now();
    await db().runTransaction(async tx => {
      const [request, acct] = await Promise.all([tx.get(requestRef), tx.get(acctRef)]);
      if (!request.exists || request.data()?.status !== 'pending') throw new HttpsError('failed-precondition', 'No pending driver payout request.');
      if (!acct.exists) throw invalidArgument('Driver rewards account not found.');
      const amountPaise = Number(request.data()?.amountPaise ?? 0); const payable = Number(acct.data()?.rewardPayablePaise ?? 0);
      if (amountPaise <= 0 || amountPaise > payable) throw new HttpsError('failed-precondition', 'Requested amount no longer matches payable rewards.');
      tx.create(payRef, { uid, amountPaise, reason, reference, status: 'recorded_paid', recordedByUid: admin.uid, createdAt: serverTimestamp(), createdAtMs: now });
      tx.create(ledgerRef, { type: 'driver_reward_payout', amountPaise: -amountPaise, reason, reference, createdAt: serverTimestamp(), createdAtMs: now });
      tx.update(acctRef, { rewardPayablePaise: payable - amountPaise, updatedAt: serverTimestamp() });
      tx.update(requestRef, { status: 'paid', reference, recordedByUid: admin.uid, completedAt: serverTimestamp(), completedAtMs: now, accountHolder: '', accountNumber: '', ifsc: '', updatedAt: serverTimestamp(), updatedAtMs: now });
    });
    await writeAuditLog({ actorUid: admin.uid, actorRole: 'admin', action: 'driver_reward_payout_recorded', targetType: 'rewardPayout', targetId: payRef.id, after: { uid, reference, reason } }); return { ok: true, payoutId: payRef.id };
  }
  if (action === 'rejectRequestedDriverPayout') {
    const uid = String(body.uid ?? '').trim(); const reason = String(body.reason ?? '').trim().slice(0, 300);
    if (!uid || !reason) throw invalidArgument('Driver and a rejection reason are required.');
    const requestRef = db().doc(`driverRewardPayoutRequests/${uid}`); const now = Date.now();
    await db().runTransaction(async tx => {
      const request = await tx.get(requestRef);
      if (!request.exists || request.data()?.status !== 'pending') throw new HttpsError('failed-precondition', 'No pending driver payout request.');
      tx.update(requestRef, { status: 'rejected', rejectionReason: reason, resolvedByUid: admin.uid, resolvedAt: serverTimestamp(), resolvedAtMs: now, accountHolder: '', accountNumber: '', ifsc: '', updatedAt: serverTimestamp(), updatedAtMs: now });
    });
    await writeAuditLog({ actorUid: admin.uid, actorRole: 'admin', action: 'driver_reward_payout_rejected', targetType: 'driverRewardPayoutRequest', targetId: uid, after: { reason } }); return { ok: true };
  }
  if (action === 'payDriverReward') {
    const uid = String(body.uid ?? ''); const amountPaise = Number(body.amountPaise); const reason = String(body.reason ?? '').trim().slice(0, 300); const reference = String(body.reference ?? '').trim().slice(0, 100);
    if (!uid || !isInt(amountPaise, 1) || !reason || !reference) throw invalidArgument('Driver, positive amount, payout reference and reason are required.');
    const payRef = db().collection('rewardPayouts').doc(); const acctRef = account(uid); const ledgerRef = acctRef.collection('ledger').doc(payRef.id);
    await db().runTransaction(async tx => { const acct = await tx.get(acctRef); if (!acct.exists) throw invalidArgument('Driver rewards account not found.'); const payable = Number(acct.data()?.rewardPayablePaise ?? 0); if (amountPaise > payable) throw invalidArgument('Payout exceeds the recorded payable reward.'); tx.create(payRef, { uid, amountPaise, reason, reference, status: 'recorded_paid', recordedByUid: admin.uid, createdAt: serverTimestamp(), createdAtMs: Date.now() }); tx.create(ledgerRef, { type: 'driver_reward_payout', amountPaise: -amountPaise, reason, reference, createdAt: serverTimestamp(), createdAtMs: Date.now() }); tx.update(acctRef, { rewardPayablePaise: payable - amountPaise, updatedAt: serverTimestamp() }); });
    await writeAuditLog({ actorUid: admin.uid, actorRole: 'admin', action: 'driver_reward_payout_recorded', targetType: 'rewardPayout', targetId: payRef.id, after: { uid, amountPaise, reason, reference } }); return { ok: true, payoutId: payRef.id };
  }
  if (action === 'adjustWallet') {
    const uid = String(body.uid ?? '').trim(); const amountPaise = Number(body.amountPaise); const reason = String(body.reason ?? '').trim().slice(0, 300);
    if (!uid || !Number.isSafeInteger(amountPaise) || amountPaise === 0 || !reason) throw invalidArgument('Account, non-zero adjustment and reason are required.');
    const acctRef = account(uid); const ledgerRef = acctRef.collection('ledger').doc();
    await db().runTransaction(async tx => {
      const acct = await tx.get(acctRef); if (!acct.exists) throw invalidArgument('Rewards account not found.');
      const wallet = Number(acct.data()?.walletPaise ?? 0); if (wallet + amountPaise < 0) throw invalidArgument('Adjustment cannot make the wallet negative.');
      tx.create(ledgerRef, { type: 'admin_wallet_adjustment', amountPaise, reason, recordedByUid: admin.uid, createdAt: serverTimestamp(), createdAtMs: Date.now() });
      tx.update(acctRef, { walletPaise: wallet + amountPaise, updatedAt: serverTimestamp() });
    });
    await writeAuditLog({ actorUid: admin.uid, actorRole: 'admin', action: 'rewards_wallet_adjusted', targetType: 'rewardAccount', targetId: uid, after: { amountPaise, reason } }); return { ok: true };
  }
  throw invalidArgument('Unknown rewards admin action.');
}
export const manageRewardsAdmin = onCall(OPTIONS, async (request: CallableRequest<unknown>) => manageRewardsAdminForCaller(requireAdmin(request), request.data));

async function settleCompletedBooking(bookingId: string, booking: Record<string, any>) {
  const customerUid = String(booking.customerUid ?? ''); const driverUid = String(booking.assignedDriverUid ?? ''); if (!customerUid) return;
  const cfg = { ...DEFAULT_REWARD_RULES, ...((await rulesRef().get()).data() ?? {}) }; if (!cfg.enabled) return;
  const fare = Number(booking.finalFare?.totalPaise ?? booking.estimate?.totalPaise ?? 0); const now = Date.now(); const expiry = now + Number(cfg.creditExpiryDays) * 86_400_000;
  const customerAcct = account(customerUid); const miles = cfg.milesEnabled ? Math.floor(fare / 10_000 * Number(cfg.milesPer100Rupees)) : 0;
  await db().runTransaction(async tx => {
    const mRef = customerAcct.collection('ledger').doc(`miles_${bookingId}`); const bRef = db().doc(`bookings/${bookingId}`); const [b, a, l] = await Promise.all([tx.get(bRef), tx.get(customerAcct), tx.get(mRef)]); if (!b.exists || l.exists) return;
    const current = a.data() ?? {}; tx.create(mRef, { type: 'trip_miles', points: miles, bookingId, createdAt: serverTimestamp(), createdAtMs: now }); tx.set(customerAcct, { uid: customerUid, milesPoints: Number(current.milesPoints ?? 0) + miles, lifetimeMilesPoints: Number(current.lifetimeMilesPoints ?? 0) + miles, customerTrips: Number(current.customerTrips ?? 0) + 1, updatedAt: serverTimestamp() }, { merge: true });
  });
  // Referral award is idempotent and only follows the first eligible completed trip.
  if (cfg.customerReferralEnabled && fare >= Number(cfg.customerReferralMinimumFarePaise)) {
    const rRef = db().doc(`rewardReferrals/customer_${customerUid}`); const snap = await rRef.get();
    if (snap.exists && snap.data()?.status === 'pending') await db().runTransaction(async tx => {
      const r = await tx.get(rRef); if (!r.exists || r.data()?.status !== 'pending') return; const referrer = String(r.data()?.referrerUid ?? ''); if (!referrer || referrer === customerUid) return;
      const refAcct = account(referrer); const newAcct = account(customerUid); const refLedger = refAcct.collection('ledger').doc(`customer_referral_${customerUid}`); const newLedger = newAcct.collection('ledger').doc(`customer_welcome_${customerUid}`);
      const [ra, na, rl, nl] = await Promise.all([tx.get(refAcct), tx.get(newAcct), tx.get(refLedger), tx.get(newLedger)]); if (rl.exists || nl.exists) return; const amount = Number(cfg.customerReferralCreditPaise);
      tx.set(refAcct, { walletPaise: Number(ra.data()?.walletPaise ?? 0) + amount, updatedAt: serverTimestamp() }, { merge: true }); tx.set(newAcct, { walletPaise: Number(na.data()?.walletPaise ?? 0) + amount, updatedAt: serverTimestamp() }, { merge: true });
      tx.create(refLedger, { type: 'customer_referral_credit', amountPaise: amount, referredUid: customerUid, bookingId, expiresAtMs: expiry, createdAt: serverTimestamp(), createdAtMs: now }); tx.create(newLedger, { type: 'first_booking_credit', amountPaise: amount, referrerUid: referrer, bookingId, expiresAtMs: expiry, createdAt: serverTimestamp(), createdAtMs: now }); tx.update(rRef, { status: 'qualified', qualifiedBookingId: bookingId, qualifiedAt: serverTimestamp(), qualifiedAtMs: now });
    });
  }
  if (!driverUid) return;
  const dAcct = account(driverUid); const profileRef = db().doc(`driverProfiles/${driverUid}`); const dLedger = dAcct.collection('ledger').doc(`driver_miles_${bookingId}`); const driverReferral = db().doc(`rewardReferrals/driver_${driverUid}`);
  await db().runTransaction(async tx => {
    const [a, ledger, profile, referral] = await Promise.all([tx.get(dAcct), tx.get(dLedger), tx.get(profileRef), tx.get(driverReferral)]); if (ledger.exists) return;
    const current = a.data() ?? {}; const trips = Number(current.driverTrips ?? 0) + 1;
    const driverMiles = cfg.milesEnabled ? Math.floor(fare / 10_000 * Number(cfg.milesPer100Rupees)) : 0;
    const badges = new Set(Array.isArray(current.badges) ? current.badges : []); if (trips >= 10) badges.add('first-10-trips'); if (trips >= 20) badges.add('20-trips');
    const profileData = profile.data() ?? {}; const referralData = referral.data() ?? {};
    const started = Number(referralData.createdAtMs ?? now);
    const ratingCount = Number(profileData.ratingCount ?? profileData.ratingsCount ?? 0);
    const ratingOkay = ratingCount >= Number(cfg.driverMinimumRatings)
      && Number(profileData.ratingAverage ?? 0) >= Number(cfg.driverMinimumRating);
    const withinWindow = referral.exists && now <= started + Number(cfg.driverMilestoneWindowDays) * 86_400_000;
    const referredTrips = withinWindow ? Number(referralData.completedTripsInWindow ?? 0) + 1 : Number(referralData.completedTripsInWindow ?? 0);
    const eligible = cfg.driverReferralEnabled && referral.exists && ['pending', 'milestone_1_paid'].includes(String(referralData.status))
      && profileData.verificationStatus === 'approved' && profileData.seriousSafetyHold !== true && ratingOkay
      && withinWindow;
    const referrerUid = eligible ? String(referralData.referrerUid ?? '') : '';
    const refAcct = referrerUid && referrerUid !== driverUid ? account(referrerUid) : null;
    const milestones: Array<[number, string, number]> = [
      [Number(cfg.driverTripsFirstMilestone), 'driver_referral_10', Number(cfg.driverFirstMilestonePaise)],
      [Number(cfg.driverTripsSecondMilestone), 'driver_referral_20', Number(cfg.driverSecondMilestonePaise)],
    ];
    const refs = refAcct ? milestones.map(([, key]) => refAcct.collection('ledger').doc(`${key}_${driverUid}`)) : [];
    // Read the account and both milestone ledgers before writing. Thresholds use
    // >= so a delayed completion trigger cannot permanently skip a reward.
    const [refDataSnap, ...milestoneSnaps] = refAcct
      ? await Promise.all([tx.get(refAcct), ...refs.map(ref => tx.get(ref))])
      : [null];
    tx.create(dLedger, { type: 'driver_trip_miles', points: driverMiles, bookingId, createdAt: serverTimestamp(), createdAtMs: now });
    tx.set(dAcct, { uid: driverUid, driverTrips: trips, milesPoints: Number(current.milesPoints ?? 0) + driverMiles, lifetimeMilesPoints: Number(current.lifetimeMilesPoints ?? 0) + driverMiles, badges: [...badges], updatedAt: serverTimestamp() }, { merge: true });
    if (referral.exists && withinWindow && ['pending', 'milestone_1_paid'].includes(String(referralData.status))) tx.update(driverReferral, { completedTripsInWindow: referredTrips, lastCompletedTripAtMs: now });
    if (refAcct && referrerUid !== driverUid && refDataSnap) {
      let payable = Number(refDataSnap.data()?.rewardPayablePaise ?? 0); let milestonePaid = false; let secondPaid = false;
      milestones.forEach(([target, key, amount], index) => {
        const milestoneSnap = milestoneSnaps[index];
        if (referredTrips >= target && !milestoneSnap?.exists) {
          const refLedger = refs[index]!;
          tx.create(refLedger, { type: 'driver_referral_reward_earned', amountPaise: amount, milestone: target, referredDriverUid: driverUid, createdAt: serverTimestamp(), createdAtMs: now });
          payable += amount; milestonePaid = true; if (index === 1) secondPaid = true;
        }
      });
      if (milestonePaid) {
        const refAccountData = refDataSnap.data() ?? {};
        const referrerBadges = new Set(Array.isArray(refAccountData.badges) ? refAccountData.badges : []);
        const qualifiedCount = Number(refAccountData.qualifiedDriverReferrals ?? 0) + (secondPaid ? 1 : 0);
        if (qualifiedCount >= Number(cfg.driverChampionReferralCount)) referrerBadges.add('driver-champion');
        tx.set(refAcct, { rewardPayablePaise: payable, qualifiedDriverReferrals: qualifiedCount, badges: [...referrerBadges], updatedAt: serverTimestamp() }, { merge: true });
        tx.update(driverReferral, { status: secondPaid ? 'qualified' : 'milestone_1_paid', ...(secondPaid ? { qualifiedAt: serverTimestamp(), qualifiedAtMs: now } : {}) });
      }
    }
  });
}

export const settleRewardsOnTripCompletion = onDocumentUpdated({ region: REGION, document: 'bookings/{bookingId}' }, async event => {
  const before = event.data?.before.data(); const after = event.data?.after.data(); if (!after || after.status !== 'completed' || before?.status === 'completed') return;
  await settleCompletedBooking(event.params.bookingId, after);
});
