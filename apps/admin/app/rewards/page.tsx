'use client';

import { useCallback, useEffect, useState } from 'react';
import { callFunction } from '@drivx/firebase-client';
import { formatINR } from '@drivx/domain';
import { firebaseClients } from '../../lib/firebase';
import { ConsoleHeader, StaffGate, describe, useReviewerSession } from '../../lib/staff-session';

type Rules = {
  enabled: boolean; customerReferralEnabled: boolean; customerReferralCreditPaise: number; customerReferralMinimumFarePaise: number;
  creditExpiryDays: number; milesEnabled: boolean; milesPer100Rupees: number; milesPaisePer100Points: number;
  walletRedemptionEnabled: boolean; milesRedemptionEnabled: boolean; couponsEnabled: boolean;
  driverReferralEnabled: boolean; driverTripsFirstMilestone: number; driverFirstMilestonePaise: number;
  driverTripsSecondMilestone: number; driverSecondMilestonePaise: number; driverMilestoneWindowDays: number;
  driverMinimumRating: number; driverMinimumRatings: number; driverChampionReferralCount: number;
};
type RewardRow = Record<string, unknown> & { id: string; uid?: string; code?: string; status?: string; walletPaise?: number; milesPoints?: number; rewardPayablePaise?: number; driverTrips?: number; customerTrips?: number; badges?: string[]; amountPaise?: number; createdAtMs?: number };
type Snapshot = { rules: Rules; coupons: RewardRow[]; referrals: RewardRow[]; payouts: RewardRow[]; payoutRequests: RewardRow[]; accounts: RewardRow[] };
type CouponDraft = { code: string; discountType: 'fixed' | 'percent'; discountValue: string; minimumFare: string; maxRedemptions: string; expiresAt: string };
const DEFAULT_RULES: Rules = { enabled: true, customerReferralEnabled: true, customerReferralCreditPaise: 10_000, customerReferralMinimumFarePaise: 39_900, creditExpiryDays: 60, milesEnabled: true, milesPer100Rupees: 5, milesPaisePer100Points: 2_000, walletRedemptionEnabled: true, milesRedemptionEnabled: true, couponsEnabled: true, driverReferralEnabled: true, driverTripsFirstMilestone: 10, driverFirstMilestonePaise: 20_000, driverTripsSecondMilestone: 20, driverSecondMilestonePaise: 30_000, driverMilestoneWindowDays: 30, driverMinimumRating: 4.5, driverMinimumRatings: 3, driverChampionReferralCount: 5 };
const rupees = (paise: unknown) => (Number(paise ?? 0) / 100).toFixed(2);
const dateLabel = (ms: unknown) => typeof ms === 'number' ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(ms) : '—';

export default function RewardsAdminPage() {
  const { reviewer, checked } = useReviewerSession();
  const [data, setData] = useState<Snapshot | null>(null);
  const [rules, setRules] = useState<Rules>(DEFAULT_RULES);
  const [coupon, setCoupon] = useState<CouponDraft>({ code: '', discountType: 'fixed', discountValue: '100', minimumFare: '399', maxRedemptions: '0', expiresAt: '' });
  const [accountUid, setAccountUid] = useState('');
  const [adjustment, setAdjustment] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [payoutUid, setPayoutUid] = useState('');
  const [payoutAmount, setPayoutAmount] = useState('');
  const [payoutReason, setPayoutReason] = useState('Driver referral reward payout');
  const [payoutReference, setPayoutReference] = useState('');
  const [requestRejectReason, setRequestRejectReason] = useState('Bank details or eligibility could not be verified.');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const result = await callFunction<{ action: 'read' }, Snapshot>(firebaseClients(), 'manageRewardsAdmin', { action: 'read' });
      setData(result); setRules({ ...DEFAULT_RULES, ...result.rules });
    } catch (caught) { setError(describe(caught)); }
  }, []);
  useEffect(() => { if (reviewer?.admin) void refresh(); }, [reviewer?.admin, refresh]);

  async function act<T extends Record<string, unknown>>(payload: T, success: string) {
    setBusy(true); setMessage(null); setError(null);
    try { await callFunction(firebaseClients(), 'manageRewardsAdmin', payload); setMessage(success); await refresh(); }
    catch (caught) { setError(describe(caught)); }
    finally { setBusy(false); }
  }
  async function saveRules() { await act({ action: 'saveRules', rules }, 'Rewards policy saved. New eligible trips and checkouts use the updated settings.'); }
  async function saveCoupon() {
    const value = Number(coupon.discountValue), minimum = Number(coupon.minimumFare), max = Number(coupon.maxRedemptions);
    if (!coupon.code.trim() || !Number.isFinite(value) || value <= 0 || minimum < 0 || max < 0) { setError('Enter a coupon code and valid non-negative amounts.'); return; }
    await act({ action: 'saveCoupon', coupon: { code: coupon.code, discountType: coupon.discountType, discountValue: Math.round(value), minimumFarePaise: Math.round(minimum * 100), maxRedemptions: Math.round(max), expiresAtMs: coupon.expiresAt ? new Date(coupon.expiresAt).getTime() : 0, active: true } }, `Coupon ${coupon.code.trim().toUpperCase()} saved and enabled.`);
    setCoupon((old) => ({ ...old, code: '' }));
  }
  async function adjustWallet() {
    const amount = Number(adjustment);
    if (!accountUid.trim() || !Number.isFinite(amount) || amount === 0 || !adjustReason.trim()) { setError('Choose an account, enter a non-zero adjustment, and add a reason.'); return; }
    await act({ action: 'adjustWallet', uid: accountUid.trim(), amountPaise: Math.round(amount * 100), reason: adjustReason.trim() }, 'Wallet adjustment recorded in the account ledger.'); setAdjustment(''); setAdjustReason('');
  }
  async function recordPayout() {
    const amount = Number(payoutAmount);
    if (!payoutUid.trim() || !Number.isFinite(amount) || amount <= 0 || !payoutReason.trim() || !payoutReference.trim()) { setError('Driver UID, amount, transfer reference, and reason are required.'); return; }
    await act({ action: 'payDriverReward', uid: payoutUid.trim(), amountPaise: Math.round(amount * 100), reason: payoutReason.trim(), reference: payoutReference.trim() }, 'Payout recorded against the driver’s payable rewards. Confirm the bank transfer separately.'); setPayoutAmount(''); setPayoutReference('');
  }
  async function toggleCoupon(item: RewardRow) {
    await act({ action: 'setCouponActive', code: item.id, active: item.active !== true }, `Coupon ${item.id} ${item.active === true ? 'paused' : 'enabled'}.`);
  }
  async function recordRequestedPayout(item: RewardRow) {
    if (!payoutReference.trim()) { setError('Enter the completed bank transfer UTR/reference below before recording this request.'); return; }
    await act({ action: 'recordRequestedDriverPayout', uid: String(item.uid ?? ''), reference: payoutReference.trim(), reason: payoutReason.trim() || 'Driver referral reward payout' }, 'Completed bank transfer recorded; payable rewards were reduced.');
    setPayoutReference('');
  }
  async function rejectRequestedPayout(item: RewardRow) {
    if (!requestRejectReason.trim()) { setError('Enter a reason before declining a payout request.'); return; }
    await act({ action: 'rejectRequestedDriverPayout', uid: String(item.uid ?? ''), reason: requestRejectReason.trim() }, 'Payout request declined; driver bank details were cleared.');
  }
  function set<K extends keyof Rules>(key: K, value: Rules[K]) { setRules((old) => ({ ...old, [key]: value })); }
  const moneyField = (label: string, key: 'customerReferralCreditPaise' | 'customerReferralMinimumFarePaise' | 'driverFirstMilestonePaise' | 'driverSecondMilestonePaise') => <label className="grid gap-1 text-sm font-medium text-ink-muted">{label}<input type="number" min="0" step="1" value={rupees(rules[key])} onChange={(e) => set(key, Math.round(Number(e.target.value || 0) * 100))} className="rounded-control border border-line bg-surface px-3 py-2 text-ink" /></label>;
  const numberField = (label: string, key: 'creditExpiryDays' | 'milesPer100Rupees' | 'milesPaisePer100Points' | 'driverTripsFirstMilestone' | 'driverTripsSecondMilestone' | 'driverMilestoneWindowDays' | 'driverMinimumRatings' | 'driverChampionReferralCount' | 'driverMinimumRating') => <label className="grid gap-1 text-sm font-medium text-ink-muted">{label}<input type="number" min="0" step={key === 'driverMinimumRating' ? '0.1' : '1'} value={rules[key]} onChange={(e) => set(key, Number(e.target.value || 0))} className="rounded-control border border-line bg-surface px-3 py-2 text-ink" /></label>;
  const flag = (label: string, key: 'enabled' | 'customerReferralEnabled' | 'milesEnabled' | 'walletRedemptionEnabled' | 'milesRedemptionEnabled' | 'couponsEnabled' | 'driverReferralEnabled') => <label className="flex items-center gap-2 rounded-xl border border-line bg-surface-muted px-3 py-2 text-sm font-medium"><input type="checkbox" checked={rules[key]} onChange={(e) => set(key, e.target.checked)} />{label}</label>;

  return <StaffGate checked={checked} reviewer={reviewer} claim="admin" signInHeading="Admin sign-in" signInBlurb="Only the DrivX administrator can change rewards, coupons and reward-wallet records.">
    {(signedIn) => <>
      <ConsoleHeader title="Rewards & loyalty" blurb="Live rewards settings, coupons, customer credits and driver milestones." reviewer={signedIn} links={[{ href: '/', label: 'Overview' }, { href: '/bookings', label: 'Bookings & dispatch' }, { href: '/verification', label: 'Driver reviews' }, { href: '/dues', label: 'Earnings & dues' }, { href: '/pricing', label: 'Fare settings' }, { href: '/rewards', label: 'Rewards & loyalty' }]} />
      <main className="console-content mx-auto w-full max-w-6xl px-5 py-7 sm:px-8">
        {message ? <div role="status" className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">{message}</div> : null}
        {error ? <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">{error}</div> : null}
        <section className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-bold">Rewards policy</h2><p className="mt-1 text-sm text-ink-muted">Changes apply to new qualifying trips and checkout calculations. Completed bookings keep their saved amounts.</p></div><button onClick={() => void refresh()} className="rounded-control border border-line px-3 py-2 text-sm font-semibold">Refresh live data</button></div>
          <div className="mt-4 flex flex-wrap gap-2">{flag('Rewards programme', 'enabled')}{flag('Customer referrals', 'customerReferralEnabled')}{flag('DrivX Miles', 'milesEnabled')}{flag('Wallet at checkout', 'walletRedemptionEnabled')}{flag('Miles at checkout', 'milesRedemptionEnabled')}{flag('Coupons', 'couponsEnabled')}{flag('Driver referrals', 'driverReferralEnabled')}</div>
          <h3 className="mt-6 font-semibold">Customer Invite & Earn / Miles</h3><div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{moneyField('Credit to each user (₹)', 'customerReferralCreditPaise')}{moneyField('Minimum completed fare (₹)', 'customerReferralMinimumFarePaise')}{numberField('Credit expiry (days)', 'creditExpiryDays')}{numberField('Miles per ₹100', 'milesPer100Rupees')}{numberField('Miles value (paise per 100 points)', 'milesPaisePer100Points')}</div>
          <h3 className="mt-6 font-semibold">Driver referral milestones</h3><div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{numberField('First milestone trips', 'driverTripsFirstMilestone')}{moneyField('First reward (₹)', 'driverFirstMilestonePaise')}{numberField('Second milestone trips', 'driverTripsSecondMilestone')}{moneyField('Second reward (₹)', 'driverSecondMilestonePaise')}{numberField('Milestone window (days)', 'driverMilestoneWindowDays')}{numberField('Minimum rating', 'driverMinimumRating')}{numberField('Minimum ratings count', 'driverMinimumRatings')}{numberField('Champion referrals', 'driverChampionReferralCount')}</div>
          <button disabled={busy} onClick={() => void saveRules()} className="mt-5 rounded-control bg-accent px-5 py-3 text-sm font-bold text-ink-on-brand disabled:opacity-50">{busy ? 'Saving…' : 'Save rewards policy'}</button>
        </section>
        <section className="mt-5 rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6"><h2 className="text-xl font-bold">Coupons</h2><p className="mt-1 text-sm text-ink-muted">Create a fixed-rupee or percentage coupon. It is checked and applied by the booking backend.</p><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><label className="grid gap-1 text-sm">Coupon code<input value={coupon.code} onChange={(e) => setCoupon({ ...coupon, code: e.target.value.toUpperCase() })} placeholder="DRIVX100" className="rounded-control border border-line px-3 py-2" /></label><label className="grid gap-1 text-sm">Discount type<select value={coupon.discountType} onChange={(e) => setCoupon({ ...coupon, discountType: e.target.value as 'fixed' | 'percent' })} className="rounded-control border border-line px-3 py-2"><option value="fixed">Fixed ₹</option><option value="percent">Percent</option></select></label><label className="grid gap-1 text-sm">Discount value<input type="number" min="1" value={coupon.discountValue} onChange={(e) => setCoupon({ ...coupon, discountValue: e.target.value })} className="rounded-control border border-line px-3 py-2" /></label><label className="grid gap-1 text-sm">Minimum fare (₹)<input type="number" min="0" value={coupon.minimumFare} onChange={(e) => setCoupon({ ...coupon, minimumFare: e.target.value })} className="rounded-control border border-line px-3 py-2" /></label><label className="grid gap-1 text-sm">Max uses (0 = no cap)<input type="number" min="0" value={coupon.maxRedemptions} onChange={(e) => setCoupon({ ...coupon, maxRedemptions: e.target.value })} className="rounded-control border border-line px-3 py-2" /></label><label className="grid gap-1 text-sm">Expiry (optional)<input type="datetime-local" value={coupon.expiresAt} onChange={(e) => setCoupon({ ...coupon, expiresAt: e.target.value })} className="rounded-control border border-line px-3 py-2" /></label></div><button disabled={busy || !rules.couponsEnabled} onClick={() => void saveCoupon()} className="mt-4 rounded-control bg-accent px-5 py-3 text-sm font-bold text-ink-on-brand disabled:opacity-50">Create / update coupon</button><div className="mt-4 divide-y divide-line">{data?.coupons.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"><strong>{item.id}</strong><span>{item.discountType === 'percent' ? `${item.discountValue}%` : formatINR(Number(item.discountValue ?? 0) * 100)} off · minimum {formatINR(Number(item.minimumFarePaise ?? 0))} · {item.active ? 'Active' : 'Inactive'}</span><span className="text-ink-faint">Expires {dateLabel(item.expiresAtMs)}</span><button disabled={busy} onClick={() => void toggleCoupon(item)} className="rounded-control border border-line px-3 py-2 font-semibold">{item.active === true ? 'Pause coupon' : 'Enable coupon'}</button></div>)}</div></section>
        <section className="mt-5 grid gap-5 lg:grid-cols-2">
          <div className="rounded-2xl border border-line bg-surface p-5 shadow-card"><h2 className="text-xl font-bold">Adjust customer reward wallet</h2><p className="mt-1 text-sm text-ink-muted">Use the customer’s Firebase UID. Every adjustment is written to the ledger with a reason.</p><div className="mt-4 grid gap-3"><select value={accountUid} onChange={(e) => setAccountUid(e.target.value)} className="rounded-control border border-line px-3 py-2"><option value="">Select a customer account</option>{data?.accounts.filter((a) => Number(a.customerTrips ?? 0) > 0 || a.customerReferralCode).map((a) => <option key={a.id} value={a.id}>{a.id} · wallet {formatINR(Number(a.walletPaise ?? 0))}</option>)}</select><input type="number" step="0.01" value={adjustment} onChange={(e) => setAdjustment(e.target.value)} placeholder="Adjustment in ₹ (negative allowed)" className="rounded-control border border-line px-3 py-2" /><input value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} placeholder="Reason for audit ledger" className="rounded-control border border-line px-3 py-2" /><button disabled={busy} onClick={() => void adjustWallet()} className="rounded-control bg-accent px-4 py-3 text-sm font-bold text-ink-on-brand disabled:opacity-50">Record wallet adjustment</button></div></div>
          <div className="rounded-2xl border border-line bg-surface p-5 shadow-card"><h2 className="text-xl font-bold">Driver reward payout</h2><p className="mt-1 text-sm text-ink-muted">First pay through your bank, then record its reference here. This form does not send money automatically.</p><div className="mt-4 grid gap-3"><select value={payoutUid} onChange={(e) => setPayoutUid(e.target.value)} className="rounded-control border border-line px-3 py-2"><option value="">Select a driver with payable rewards</option>{data?.accounts.filter((a) => Number(a.rewardPayablePaise ?? 0) > 0).map((a) => <option key={a.id} value={a.id}>{a.id} · payable {formatINR(Number(a.rewardPayablePaise ?? 0))}</option>)}</select><input type="number" step="0.01" value={payoutAmount} onChange={(e) => setPayoutAmount(e.target.value)} placeholder="Amount paid (₹)" className="rounded-control border border-line px-3 py-2" /><input value={payoutReference} onChange={(e) => setPayoutReference(e.target.value)} placeholder="Bank / UTR reference" className="rounded-control border border-line px-3 py-2" /><input value={payoutReason} onChange={(e) => setPayoutReason(e.target.value)} placeholder="Reason" className="rounded-control border border-line px-3 py-2" /><button disabled={busy} onClick={() => void recordPayout()} className="rounded-control bg-accent px-4 py-3 text-sm font-bold text-ink-on-brand disabled:opacity-50">Record completed transfer</button></div></div>
        </section>
        <section className="mt-5 rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6"><h2 className="text-xl font-bold">Driver payout requests</h2><p className="mt-1 text-sm text-ink-muted">Private bank details are visible to this admin-only screen. Transfer funds in your bank separately; only then mark a request paid with the bank UTR. Declining clears submitted bank details.</p><div className="mt-3 grid gap-3 sm:grid-cols-2"><input value={payoutReference} onChange={(e) => setPayoutReference(e.target.value)} placeholder="Completed bank transfer UTR / reference" className="rounded-control border border-line px-3 py-2" /><input value={requestRejectReason} onChange={(e) => setRequestRejectReason(e.target.value)} placeholder="Decline reason" className="rounded-control border border-line px-3 py-2" /></div><div className="mt-4 divide-y divide-line">{data?.payoutRequests.filter((r) => r.status === 'pending').length ? data.payoutRequests.filter((r) => r.status === 'pending').map((item) => <article key={item.id} className="grid gap-3 py-4 text-sm md:grid-cols-[1fr_auto]"><div><strong>{String(item.uid ?? item.id)}</strong><p className="mt-1">{formatINR(Number(item.amountPaise ?? 0))} · requested {dateLabel(item.createdAtMs)}</p><p className="mt-1 text-ink-muted">{String(item.accountHolder ?? '—')} · IFSC {String(item.ifsc ?? '—')}</p><p className="mt-1 rounded-lg bg-surface-muted p-2 font-mono text-xs">Bank account · <span className="select-all">{String(item.accountNumber ?? 'Not provided')}</span></p></div><div className="flex flex-wrap items-start gap-2"><button disabled={busy || !payoutReference.trim()} onClick={() => void recordRequestedPayout(item)} className="rounded-control bg-accent px-3 py-2 font-semibold text-ink-on-brand disabled:opacity-50">Record transfer paid</button><button disabled={busy || !requestRejectReason.trim()} onClick={() => void rejectRequestedPayout(item)} className="rounded-control border border-red-200 px-3 py-2 font-semibold text-red-700 disabled:opacity-50">Decline</button></div></article>) : <p className="py-4 text-sm text-ink-muted">No pending payout requests.</p>}</div></section>
        <section className="mt-5 rounded-2xl border border-line bg-surface p-5 shadow-card"><h2 className="text-xl font-bold">Live accounts & activity</h2><p className="mt-1 text-sm text-ink-muted">Latest reward accounts, referral status, and recorded driver payouts.</p><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead><tr className="border-b border-line text-ink-muted"><th className="py-3">Account UID</th><th>Customer wallet</th><th>Miles</th><th>Trips</th><th>Driver reward payable</th><th>Badges</th></tr></thead><tbody>{data?.accounts.map((a) => <tr key={a.id} className="border-b border-line"><td className="py-3 font-medium">{a.id}</td><td>{formatINR(Number(a.walletPaise ?? 0))}</td><td>{Number(a.milesPoints ?? 0)}</td><td>{Number(a.customerTrips ?? 0)} customer / {Number(a.driverTrips ?? 0)} driver</td><td>{formatINR(Number(a.rewardPayablePaise ?? 0))}</td><td>{Array.isArray(a.badges) ? a.badges.join(', ') : '—'}</td></tr>)}</tbody></table></div><h3 className="mt-6 font-semibold">Recent referrals</h3><div className="mt-2 divide-y divide-line">{data?.referrals.map((r) => <div key={r.id} className="flex flex-wrap justify-between gap-2 py-3 text-sm"><span>{r.id} · {String(r.referrerUid ?? '—')} → {String(r.referredUid ?? '—')}</span><span>{String(r.status ?? 'pending')} · {dateLabel(r.createdAtMs)}</span></div>)}</div><h3 className="mt-6 font-semibold">Recorded payouts</h3><div className="mt-2 divide-y divide-line">{data?.payouts.map((p) => <div key={p.id} className="flex flex-wrap justify-between gap-2 py-3 text-sm"><span>{String(p.uid ?? '—')} · {formatINR(Number(p.amountPaise ?? 0))} · {String(p.reference ?? '—')}</span><span>{dateLabel(p.createdAtMs)}</span></div>)}</div></section>
        <p className="mt-4 text-xs leading-5 text-ink-faint">Rewards are in-app credits. Customer credits/Miles are applied during booking; they are not cash withdrawals. Driver referral reward payout records reduce the recorded payable balance only after the Admin enters a completed bank transfer.</p>
      </main>
    </>}
  </StaffGate>;
}
