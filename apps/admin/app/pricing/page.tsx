'use client';

import { useEffect, useMemo, useState } from 'react';
import { collection, doc, limit, onSnapshot, query, serverTimestamp, setDoc, updateDoc, writeBatch, type DocumentData } from 'firebase/firestore';
import { COLLECTIONS, COMMISSION_CONFIG_DOC, formatINR } from '@drivx/domain';
import { firebaseClients } from '../../lib/firebase';
import { ConsoleHeader, StaffGate, describe, useReviewerSession } from '../../lib/staff-session';

type Rule = { id: string; data: DocumentData };
type Service = { id: string; data: DocumentData };
function rupees(value: unknown) { return String(Number(value ?? 0) / 100); }

export default function PricingPage() {
  const { reviewer, checked } = useReviewerSession();
  const db = firebaseClients().firestore;
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [services, setServices] = useState<Service[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [commission, setCommission] = useState('13');
  const [commissionTax, setCommissionTax] = useState('0');
  const [onboardingBase, setOnboardingBase] = useState('500');
  const [onboardingGst, setOnboardingGst] = useState('5');
  const [arrivalGrace, setArrivalGrace] = useState('10');
  const [latePenalty, setLatePenalty] = useState('50');
  const [latePenaltyGst, setLatePenaltyGst] = useState('0');
  const [pickupAreaEnabled, setPickupAreaEnabled] = useState(true);
  const [pickupCities, setPickupCities] = useState('Delhi\nGurugram\nNoida\nGreater Noida\nGhaziabad\nFaridabad');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!reviewer?.admin) return;
    const offRules = onSnapshot(collection(db, 'pricingRules'), (snap) => {
      setRules(snap.docs.map((item) => ({ id: item.id, data: item.data() })));
    }, (error) => setMessage(describe(error)));
    // Firestore rules intentionally cap service catalogue list reads at 25.
    // Keep the admin query within that bound so its listener does not surface
    // a misleading permissions error alongside pricing save feedback.
    const offServices = onSnapshot(query(collection(db, 'serviceTypes'), limit(25)), (snap) => {
      setServices(snap.docs.map((item) => ({ id: item.id, data: item.data() })).sort((a, b) => Number(a.data.sortOrder ?? 99) - Number(b.data.sortOrder ?? 99)));
    }, (error) => setMessage(describe(error)));
    const offCommission = onSnapshot(doc(db, COLLECTIONS.appConfig, COMMISSION_CONFIG_DOC), (snap) => {
      if (snap.exists()) { setCommission(String(Number(snap.data().rate ?? 0.13) * 100)); setCommissionTax(String(Number(snap.data().gstRate ?? 0) * 100)); }
    }, (error) => setMessage(describe(error)));
    const offOnboarding = onSnapshot(doc(db, COLLECTIONS.appConfig, 'onboardingFee'), (snap) => {
      if (snap.exists()) {
        setOnboardingBase(String(Number(snap.data().basePaise ?? 50_000) / 100));
        setOnboardingGst(String(Number(snap.data().gstRate ?? 0.05) * 100));
      }
    }, (error) => setMessage(describe(error)));
    const offDriverPerformance = onSnapshot(doc(db, COLLECTIONS.appConfig, 'driverPerformance'), (snap) => {
      if (snap.exists()) {
        setArrivalGrace(String(Number(snap.data().arrivalGraceMinutes ?? 10)));
        setLatePenalty(String(Number(snap.data().lateArrivalPenaltyPaise ?? 5_000) / 100));
        setLatePenaltyGst(String(Number(snap.data().lateArrivalPenaltyGstRate ?? 0) * 100));
      }
    }, (error) => setMessage(describe(error)));
    const offServiceArea = onSnapshot(doc(db, COLLECTIONS.appConfig, 'serviceArea'), (snap) => {
      if (!snap.exists()) return;
      setPickupAreaEnabled(snap.data().enabled !== false);
      const cities = snap.data().cities;
      if (Array.isArray(cities)) setPickupCities(cities.filter((city): city is string => typeof city === 'string').join('\n'));
    }, (error) => setMessage(describe(error)));
    return () => { offRules(); offServices(); offCommission(); offOnboarding(); offDriverPerformance(); offServiceArea(); };
  }, [db, reviewer?.admin]);

  const ordered = useMemo(() => [...(rules ?? [])].sort((a, b) => a.id.localeCompare(b.id)), [rules]);
  function editKey(ruleId: string, field: string, id: string) { return `${ruleId}:${field}:${id}`; }
  function value(rule: Rule, field: 'slabs' | 'packages', row: DocumentData) {
    const rowId = String(row.id ?? row.sortOrder);
    return drafts[editKey(rule.id, field, rowId)] ?? rupees(row.farePaise ?? row.packagePricePaise);
  }

  function packagesDefault(rule: Rule, field: 'extraKmPaise' | 'extraHourPaise') {
    const rows = Array.isArray(rule.data.packages) ? rule.data.packages as DocumentData[] : [];
    return rows[0]?.[field] ?? 0;
  }

  async function savePrices(rule: Rule, field: 'slabs' | 'packages') {
    const rows = (Array.isArray(rule.data[field]) ? rule.data[field] : []) as DocumentData[];
    try {
      const updated = rows.map((row) => {
        const input = Number(value(rule, field, row));
        if (!Number.isFinite(input) || input < 0 || input > 1_000_000) throw new Error('Enter a valid price in rupees.');
        const paise = Math.round(input * 100);
        return field === 'slabs' ? { ...row, farePaise: paise } : { ...row, packagePricePaise: paise };
      });
      const night = rule.data.nightSurcharge ?? {};
      const moneyInput = (key: string, fallbackPaise: number) => { const amount = Number(drafts[`${rule.id}:setting:${key}`] ?? fallbackPaise / 100); if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) throw new Error('Enter a valid charge in rupees.'); return Math.round(amount * 100); };
      const fromHour = Number(drafts[`${rule.id}:setting:nightFrom`] ?? night.fromHour ?? 22);
      const toHour = Number(drafts[`${rule.id}:setting:nightTo`] ?? night.toHour ?? 6);
      const taxPercent = Number(drafts[`${rule.id}:setting:gst`] ?? Number(rule.data.gstRate ?? 0) * 100);
      if (![fromHour, toHour].every((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23) || !Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 100) throw new Error('Check the night window and tax rate.');
      const updatedPackages = field === 'packages' ? updated.map((row) => ({ ...row, extraKmPaise: moneyInput('extraKm', Number(packagesDefault(rule, 'extraKmPaise'))), extraHourPaise: moneyInput('overtimePerHour', Number(packagesDefault(rule, 'extraHourPaise'))) })) : updated;
      const graceMinutes = Number(drafts[`${rule.id}:setting:graceMinutes`] ?? rule.data.overtimeGraceMinutes ?? 0);
      if (!Number.isInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > 180) throw new Error('Overtime grace must be a whole number of minutes from 0 to 180.');
      const key = `${rule.id}:${field}`; setBusy(key); setMessage(null);
      await updateDoc(doc(db, 'pricingRules', rule.id), { [field]: field === 'packages' ? updatedPackages : updated, pricingVersion: Number(rule.data.pricingVersion ?? 1) + 1, slabOverflowPerKmPaise: moneyInput('overflowPerKm', Number(rule.data.slabOverflowPerKmPaise ?? 0)), overtimeGraceMinutes: graceMinutes, gstRate: taxPercent / 100, nightSurcharge: { ...night, enabled: true, mode: 'flat', flatPaise: moneyInput('nightFee', Number(night.flatPaise ?? 20_000)), fromHour, toHour }, updatedAtMs: serverTimestamp() });
      setMessage(`${rule.id} saved. New quotes use these prices; confirmed bookings keep their saved price.`);
    } catch (error) { setMessage(describe(error)); }
    finally { setBusy(null); }
  }

  async function saveCommission() {
    const rate = Number(commission) / 100;
    const gstRate = Number(commissionTax) / 100;
    if (!Number.isFinite(rate) || rate < 0 || rate > 1 || !Number.isFinite(gstRate) || gstRate < 0 || gstRate > 1) { setMessage('Commission and tax must each be between 0% and 100%.'); return; }
    setBusy('commission'); setMessage(null);
    try {
      await setDoc(doc(db, COLLECTIONS.appConfig, COMMISSION_CONFIG_DOC), { rate, gstRate, updatedAtMs: serverTimestamp() }, { merge: true });
      setMessage('Commission saved. New bookings use the updated rate; earlier booking snapshots stay unchanged.');
    } catch (error) { setMessage(describe(error)); }
    finally { setBusy(null); }
  }

  async function saveOnboardingFee() {
    const base = Number(onboardingBase);
    const gstRate = Number(onboardingGst) / 100;
    if (!Number.isFinite(base) || base < 0 || base > 1_000_000 || !Number.isFinite(gstRate) || gstRate < 0 || gstRate > 1) {
      setMessage('Onboarding fee and GST must be valid values from 0 to 100%.'); return;
    }
    setBusy('onboardingFee'); setMessage(null);
    try {
      const basePaise = Math.round(base * 100);
      await setDoc(doc(db, COLLECTIONS.appConfig, 'onboardingFee'), { basePaise, gstRate, updatedAtMs: serverTimestamp() }, { merge: true });
      setMessage(`Driver onboarding is now ${formatINR(basePaise)} + ${Number(onboardingGst)}% GST. Existing paid checkouts keep their original amount.`);
    } catch (error) { setMessage(describe(error)); }
    finally { setBusy(null); }
  }

  async function saveDriverPerformance() {
    const grace = Number(arrivalGrace);
    const penalty = Number(latePenalty);
    const gstRate = Number(latePenaltyGst) / 100;
    if (!Number.isInteger(grace) || grace < 0 || grace > 180 || !Number.isFinite(penalty) || penalty < 0 || penalty > 1_000_000 || !Number.isFinite(gstRate) || gstRate < 0 || gstRate > 1) {
      setMessage('Grace must be 0–180 whole minutes; penalty and tax must be valid non-negative amounts.'); return;
    }
    setBusy('driverPerformance'); setMessage(null);
    try {
      await setDoc(doc(db, COLLECTIONS.appConfig, 'driverPerformance'), {
        arrivalGraceMinutes: grace,
        lateArrivalPenaltyPaise: Math.round(penalty * 100),
        lateArrivalPenaltyGstRate: gstRate,
        updatedAtMs: serverTimestamp(),
      }, { merge: true });
      setMessage(`Start-time grace is ${grace} minutes after pickup. A late-start penalty of ${formatINR(Math.round(penalty * 100))} plus configured tax is added after the trip completes; ₹0 disables it.`);
    } catch (error) { setMessage(describe(error)); }
    finally { setBusy(null); }
  }

  async function savePickupArea() {
    const cities = [...new Set(pickupCities.split(/[\n,]+/).map((city) => city.trim()).filter(Boolean))];
    if (cities.length > 50 || cities.some((city) => city.length > 80)) {
      setMessage('Enter up to 50 city/area names, each no longer than 80 characters.'); return;
    }
    if (pickupAreaEnabled && cities.length === 0) {
      setMessage('Add at least one pickup city, or turn the pickup service off.'); return;
    }
    setBusy('serviceArea'); setMessage(null);
    try {
      await setDoc(doc(db, COLLECTIONS.appConfig, 'serviceArea'), {
        enabled: pickupAreaEnabled,
        cities,
        updatedAtMs: serverTimestamp(),
      }, { merge: true });
      setMessage(pickupAreaEnabled
        ? `Pickup service is on for ${cities.join(', ')}. New quotes and bookings use this list immediately.`
        : 'Pickup service is paused for all cities. Existing trips are unchanged.');
    } catch (error) { setMessage(describe(error)); }
    finally { setBusy(null); }
  }

  async function enableOutstationRoundTrip() {
    const fares = [1250, 2410, 3570, 4728, 5888, 7047, 8211, 9372, 10534, 11696, 12854, 14020, 15181, 16340, 17502, 18663, 19824, 20985, 22146, 23307, 24468, 25629, 26790, 27968, 29111, 30290, 31434, 32594, 33755, 34916];
    setBusy('outstationRoundTrip'); setMessage(null);
    try {
      const batch = writeBatch(db);
      batch.set(doc(db, 'pricingRules', 'ggn-outstation-round-trip'), {
        id: 'ggn-outstation-round-trip', pricingVersion: 1, serviceTypeId: 'chauffeur_outstation', zoneId: 'zone-ggn-1', currency: 'INR', pricingModel: 'hourly_package', baseFarePaise: 0, perKmPaise: 0, perMinutePaise: 0, includedWaitMinutes: 0, waitChargePerMinutePaise: 0, overtimeGraceMinutes: 0, platformFeeRate: 0, gstRate: 0,
        nightSurcharge: { enabled: true, fromHour: 22, toHour: 6, mode: 'flat', flatPaise: 20_000, rate: 0 }, surge: { enabled: false, maxMultiplier: 1 }, minimumFarePaise: 0,
        packages: fares.map((fare, index) => ({ id: `d${index + 1}`, label: `${index + 1} ${index === 0 ? 'day' : 'days'}`, hours: (index + 1) * 24, includedKilometers: 0, packagePricePaise: fare * 100, extraKmPaise: 0, extraHourPaise: 12_000, sortOrder: index + 1 })),
        slabs: [], slabOverflowPerKmPaise: 0, distanceRounding: 'one_decimal', estimateValidityMinutes: 30, active: true, updatedAtMs: serverTimestamp(),
      });
      batch.update(doc(db, 'serviceTypes', 'chauffeur_outstation'), { roundTripPricingRuleId: 'ggn-outstation-round-trip', updatedAtMs: serverTimestamp() });
      await batch.commit();
      setMessage('Outstation round-trip day packages are enabled with the approved 1–30 day rates. New quotes use these rates; existing bookings keep their saved price.');
    } catch (error) { setMessage(describe(error)); }
    finally { setBusy(null); }
  }

  async function applyNightCharge() {
    if (!rules?.length) return;
    setBusy('nightCharge'); setMessage(null);
    try {
      const batch = writeBatch(db);
      for (const rule of rules) {
        batch.update(doc(db, 'pricingRules', rule.id), {
          nightSurcharge: { ...(rule.data.nightSurcharge ?? {}), enabled: true, fromHour: 22, toHour: 6, mode: 'flat', flatPaise: 20_000, rate: 0 },
          pricingVersion: Number(rule.data.pricingVersion ?? 1) + 1,
          updatedAtMs: serverTimestamp(),
        });
      }
      await batch.commit();
      setMessage('₹200 once per eligible trip is now active when pickup or the map-estimated journey overlaps 10 PM–6 AM. Confirmed bookings keep their agreed fare.');
    } catch (error) { setMessage(describe(error)); }
    finally { setBusy(null); }
  }

  async function toggleService(service: Service) {
    const busyKey = `service:${service.id}`;
    setBusy(busyKey);
    setMessage(null);
    try {
      await updateDoc(doc(db, 'serviceTypes', service.id), {
        enabled: service.data.enabled !== true,
        updatedAtMs: serverTimestamp(),
      });
      setMessage(`${String(service.data.name ?? service.id)} ${service.data.enabled === true ? 'paused' : 'opened'} for new customer bookings.`);
    } catch (error) {
      setMessage(describe(error));
    } finally {
      setBusy(null);
    }
  }

  return <StaffGate checked={checked} reviewer={reviewer} claim="admin" signInHeading="Admin sign-in" signInBlurb="Sign in with the DrivX administrator account to manage fare rules.">
    {(signedIn) => <>
      <ConsoleHeader title="Fare settings" blurb="Live backend pricing for new quotes and bookings." reviewer={signedIn} links={[{ href: '/', label: 'Overview' }, { href: '/bookings', label: 'Bookings & dispatch' }, { href: '/verification', label: 'Driver reviews' }, { href: '/dues', label: 'Earnings & dues' }, { href: '/pricing', label: 'Fare settings' }]} />
      <main className="console-content mx-auto w-full max-w-6xl px-6 py-8">
        <section className="rounded-card border border-line bg-surface p-5 shadow-card">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div><h2 className="text-lg font-semibold">Pickup service area</h2><p className="mt-1 text-sm text-ink-muted">Only pickup is restricted; a customer can choose a drop-off anywhere. The server checks this before quoting, coupon preview, and booking confirmation.</p></div>
            <label className="flex items-center gap-2 rounded-control border border-line px-3 py-2 text-sm font-semibold"><input type="checkbox" checked={pickupAreaEnabled} onChange={(event) => setPickupAreaEnabled(event.target.checked)} /> Accept pickups in listed cities</label>
          </div>
          <label className="mt-4 block text-sm font-medium">Available pickup cities/areas <span className="font-normal text-ink-muted">(one per line; aliases such as Gurgaon/Gurugram are matched)</span>
            <textarea aria-label="Pickup service cities" value={pickupCities} onChange={(event) => setPickupCities(event.target.value)} rows={5} className="mt-2 block w-full rounded-control border border-line bg-surface px-3 py-2 font-normal" placeholder={'Delhi\nGurugram\nNoida'} />
          </label>
          <div className="mt-4 flex flex-wrap items-center gap-3"><button type="button" onClick={() => void savePickupArea()} disabled={busy === 'serviceArea'} className="rounded-control bg-accent px-4 py-2.5 text-sm font-semibold text-ink-on-brand disabled:opacity-50">{busy === 'serviceArea' ? 'Saving…' : 'Save pickup areas'}</button><span className="text-xs text-ink-muted">Current default: Delhi, Gurugram, Noida, Greater Noida, Ghaziabad and Faridabad.</span></div>
        </section>
        <section className="rounded-card border border-line bg-surface p-5 shadow-card">
          <h2 className="text-lg font-semibold">Platform commission</h2><p className="mt-1 text-sm text-ink-muted">This is stored on the backend and snapshotted when each booking is created.</p>
          <div className="mt-4 flex flex-wrap items-end gap-3"><label className="text-sm font-medium">Commission (%)<input aria-label="Commission percent" type="number" min="0" max="100" step="0.1" value={commission} onChange={(event) => setCommission(event.target.value)} className="mt-1 block w-32 rounded-control border border-line bg-surface px-3 py-2" /></label><label className="text-sm font-medium">Tax on commission (%)<input aria-label="Commission tax percent" type="number" min="0" max="100" step="0.1" value={commissionTax} onChange={(event) => setCommissionTax(event.target.value)} className="mt-1 block w-32 rounded-control border border-line bg-surface px-3 py-2" /></label><button type="button" onClick={() => void saveCommission()} disabled={busy === 'commission'} className="rounded-control bg-accent px-4 py-2.5 text-sm font-semibold text-ink-on-brand disabled:opacity-50">{busy === 'commission' ? 'Saving…' : 'Save commission'}</button></div>
        </section>
        <section className="mt-5 rounded-card border border-line bg-surface p-5 shadow-card">
          <h2 className="text-lg font-semibold">Driver onboarding fee</h2>
          <p className="mt-1 text-sm text-ink-muted">The backend creates the driver’s one-time due from this setting. The requested default is ₹500 + 5% GST = ₹525.</p>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="text-sm font-medium">Base fee (₹)<input aria-label="Driver onboarding base fee in rupees" type="number" min="0" step="1" value={onboardingBase} onChange={(event) => setOnboardingBase(event.target.value)} className="mt-1 block w-36 rounded-control border border-line bg-surface px-3 py-2" /></label>
            <label className="text-sm font-medium">GST (%)<input aria-label="Driver onboarding GST percent" type="number" min="0" max="100" step="0.1" value={onboardingGst} onChange={(event) => setOnboardingGst(event.target.value)} className="mt-1 block w-32 rounded-control border border-line bg-surface px-3 py-2" /></label>
            <strong className="rounded-control bg-accent-soft px-3 py-2.5 text-sm">Checkout total: {formatINR(Math.round(Math.round(Number(onboardingBase || 0) * 100) * (1 + Number(onboardingGst || 0) / 100)))}</strong>
            <button type="button" onClick={() => void saveOnboardingFee()} disabled={busy === 'onboardingFee'} className="rounded-control bg-accent px-4 py-2.5 text-sm font-semibold text-ink-on-brand disabled:opacity-50">{busy === 'onboardingFee' ? 'Saving…' : 'Save onboarding fee'}</button>
          </div>
        </section>
        <section className="mt-5 rounded-card border border-line bg-surface p-5 shadow-card">
          <h2 className="text-lg font-semibold">Driver on-time arrival (OTR)</h2>
          <p className="mt-1 text-sm text-ink-muted">OTR is measured when the driver verifies the start OTP against scheduled pickup plus grace. A ₹50 late-start penalty is added to driver dues after trip completion; set the amount to ₹0 to turn it off.</p>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="text-sm font-medium">Start-time grace after pickup (minutes)<input aria-label="Driver start-time grace minutes" type="number" min="0" max="180" step="1" value={arrivalGrace} onChange={(event) => setArrivalGrace(event.target.value)} className="mt-1 block w-40 rounded-control border border-line bg-surface px-3 py-2" /></label>
            <label className="text-sm font-medium">Late-start penalty (₹)<input aria-label="Late-start penalty rupees" type="number" min="0" step="1" value={latePenalty} onChange={(event) => setLatePenalty(event.target.value)} className="mt-1 block w-40 rounded-control border border-line bg-surface px-3 py-2" /></label>
            <label className="text-sm font-medium">Penalty tax (%)<input aria-label="Late arrival penalty tax percent" type="number" min="0" max="100" step="0.1" value={latePenaltyGst} onChange={(event) => setLatePenaltyGst(event.target.value)} className="mt-1 block w-32 rounded-control border border-line bg-surface px-3 py-2" /></label>
            <button type="button" onClick={() => void saveDriverPerformance()} disabled={busy === 'driverPerformance'} className="rounded-control bg-accent px-4 py-2.5 text-sm font-semibold text-ink-on-brand disabled:opacity-50">{busy === 'driverPerformance' ? 'Saving…' : 'Save OTR policy'}</button>
          </div>
          <p className="mt-3 text-xs text-ink-muted">The backend timestamps start-OTP verification. Trips without a scheduled pickup time have no OTR sample. Existing trips keep their saved terms.</p>
        </section>
        {rules?.some((rule) => rule.id === 'ggn-outstation-per-km') ? <section className="mt-5 rounded-card border border-line bg-surface p-5 shadow-card"><h2 className="text-lg font-semibold">Outstation one-way rate chart</h2><p className="mt-1 text-sm text-ink-muted">Packages run from 100 km through 3,000 km. Distance beyond the selected package is ₹10/km. Local fare rules remain separate.</p></section> : null}
        {rules && services && (!rules.some((rule) => rule.id === 'ggn-outstation-round-trip') || services.find((service) => service.id === 'chauffeur_outstation')?.data.roundTripPricingRuleId !== 'ggn-outstation-round-trip') ? <section className="mt-5 rounded-card border border-line bg-surface p-5 shadow-card"><h2 className="text-lg font-semibold">Outstation round-trip packages</h2><p className="mt-1 text-sm text-ink-muted">Enable the approved 1–30 day rate chart. Kilometres are not billed separately; overtime after the package is ₹2/minute.</p><button type="button" onClick={() => void enableOutstationRoundTrip()} disabled={busy === 'outstationRoundTrip'} className="mt-4 rounded-control bg-accent px-4 py-2.5 text-sm font-semibold text-ink-on-brand disabled:opacity-50">{busy === 'outstationRoundTrip' ? 'Enabling…' : 'Enable outstation day packages'}</button></section> : null}
        {rules ? <section className="mt-5 rounded-card border border-line bg-surface p-5 shadow-card"><h2 className="text-lg font-semibold">Night charge</h2><p className="mt-1 text-sm text-ink-muted">Apply the configured one-time charge when scheduled pickup is from 10 PM to 6 AM, or when the map-estimated journey overlaps that window. It is never charged per hour; confirmed bookings keep their saved fare.</p><button type="button" onClick={() => void applyNightCharge()} disabled={busy === 'nightCharge'} className="mt-4 rounded-control bg-accent px-4 py-2.5 text-sm font-semibold text-ink-on-brand disabled:opacity-50">{busy === 'nightCharge' ? 'Applying…' : 'Apply ₹200 per eligible trip'}</button></section> : null}
        <section className="mt-5 rounded-card border border-line bg-surface p-5 shadow-card">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 className="text-lg font-semibold">Customer services</h2><p className="mt-1 text-sm text-ink-muted">Open or pause a service for new bookings. Existing bookings keep their agreed price.</p></div>
            <span className="rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-ink">Live control</span>
          </div>
          {!services ? <p className="mt-4 text-sm text-ink-muted">Loading services…</p> : services.map((service) => {
            const enabled = service.data.enabled === true;
            return <div key={service.id} className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-control border border-line bg-surface-muted p-4">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{String(service.data.name ?? service.id)}</h3><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${enabled ? 'bg-success-soft text-badge-success' : 'bg-surface text-ink-muted'}`}>{enabled ? 'Open' : 'Paused'}</span></div><p className="mt-1 text-sm text-ink-muted">{String(service.data.description ?? service.id)}</p><p className="mt-1 text-xs text-ink-faint">{service.id}</p></div>
              <button type="button" onClick={() => void toggleService(service)} disabled={busy === `service:${service.id}`} className={`min-h-11 rounded-control px-4 py-2 text-sm font-semibold ${enabled ? 'border border-line bg-surface text-ink' : 'bg-accent text-ink-on-brand'} disabled:opacity-50`}>{busy === `service:${service.id}` ? 'Saving…' : enabled ? 'Pause service' : 'Open service'}</button>
            </div>;
          })}
        </section>
        {message ? <p role="status" className="mt-4 rounded-control border border-line bg-surface p-3 text-sm text-ink-muted">{message}</p> : null}
        {!rules ? <p className="mt-6 text-sm text-ink-muted">Loading live pricing…</p> : ordered.map((rule) => {
          const slabs = (Array.isArray(rule.data.slabs) ? rule.data.slabs : []) as DocumentData[];
          const packages = (Array.isArray(rule.data.packages) ? rule.data.packages : []) as DocumentData[];
          const field = slabs.length ? 'slabs' as const : 'packages' as const;
          const rows = slabs.length ? slabs : packages;
          if (!rows.length) return null;
          const saveKey = `${rule.id}:${field}`;
          return <section key={rule.id} className="mt-5 rounded-card border border-line bg-surface p-5 shadow-card">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{rule.id}</h2><p className="mt-1 text-sm text-ink-muted">{rule.data.active ? 'Active for new quotes' : 'Inactive'} · tariff v{Number(rule.data.pricingVersion ?? 1)} · {rule.data.pricingModel === 'distance_slab' ? 'distance bands' : 'hourly packages'}</p></div><span className="rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-ink">{String(rule.data.zoneId ?? '')}</span></div>
            <div className="mt-4 divide-y divide-line">{rows.map((row) => { const rowId = String(row.id ?? row.sortOrder); const title = field === 'slabs' ? `Up to ${row.upToKilometers} km` : `${row.label ?? `${row.hours} hours`} · ${Number(row.includedKilometers ?? 0) === 0 ? 'time based' : `${row.includedKilometers} km included`}`; return <div key={rowId} className="flex flex-wrap items-center justify-between gap-3 py-3"><label className="text-sm font-medium">{title}</label><label className="flex items-center gap-2 text-sm text-ink-muted">₹<input aria-label={`${title} fare in rupees`} type="number" min="0" step="1" value={value(rule, field, row)} onChange={(event) => setDrafts((current) => ({ ...current, [editKey(rule.id, field, rowId)]: event.target.value }))} className="w-28 rounded-control border border-line bg-surface px-3 py-2 text-right font-mono text-ink" /></label></div>; })}</div>
            {field === 'packages' && Number(packages[0]?.includedKilometers ?? 0) === 0 ? <p className="mt-3 rounded-control bg-accent-soft p-3 text-sm text-ink-muted">Round-trip packages are day based and price by selected days only. Overtime is prorated per minute; distance is not billed separately.</p> : null}
            <div className="mt-4 grid gap-3 rounded-control bg-surface-muted p-4 sm:grid-cols-2 lg:grid-cols-3">
              {[["overflowPerKm", "Extra km / distance-slab overflow (₹/km)", Number(rule.data.slabOverflowPerKmPaise ?? 0) / 100], ["extraKm", "Hourly package extra distance (₹/km)", Number(packages[0]?.extraKmPaise ?? 0) / 100], ["overtimePerHour", "Hourly package overtime (₹/hour)", Number(packages[0]?.extraHourPaise ?? 0) / 100], ["nightFee", "Night charge (₹ per eligible trip)", Number(rule.data.nightSurcharge?.flatPaise ?? 20_000) / 100], ["nightFrom", "Night start hour (0–23)", Number(rule.data.nightSurcharge?.fromHour ?? 22)], ["nightTo", "Night end hour (0–23)", Number(rule.data.nightSurcharge?.toHour ?? 6)], ["gst", "Fare tax (%)", Number(rule.data.gstRate ?? 0) * 100], ["graceMinutes", "Overtime grace (minutes)", Number(rule.data.overtimeGraceMinutes ?? 0)]].map(([key, label, current]) => <label key={String(key)} className="text-xs font-medium text-ink-muted">{String(label)}<input aria-label={String(label)} type="number" min="0" step="1" value={drafts[`${rule.id}:setting:${String(key)}`] ?? String(current)} onChange={(event) => setDrafts((state) => ({ ...state, [`${rule.id}:setting:${String(key)}`]: event.target.value }))} className="mt-1 block w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink" /></label>)}
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4"><p className="text-xs text-ink-muted">{rule.data.slabOverflowPerKmPaise ? `Extra distance ${formatINR(Number(rule.data.slabOverflowPerKmPaise))}/km` : packages[0] ? `Extra distance ${formatINR(Number(packages[0].extraKmPaise ?? 0))}/km · overtime ${formatINR(Number(packages[0].extraHourPaise ?? 0) / 60)}/minute` : 'No automatic overage beyond the chart'} · Night charge {formatINR(Number(rule.data.nightSurcharge?.flatPaise ?? 20_000))}/eligible trip, {rule.data.nightSurcharge?.fromHour ?? 22}:00–{rule.data.nightSurcharge?.toHour ?? 6}:00</p><button type="button" onClick={() => void savePrices(rule, field)} disabled={busy === saveKey} className="rounded-control bg-accent px-4 py-2.5 text-sm font-semibold text-ink-on-brand disabled:opacity-50">{busy === saveKey ? 'Saving…' : 'Save prices'}</button></div>
          </section>;
        })}
        <p className="mt-5 rounded-control bg-accent-soft p-4 text-sm text-ink-muted">Tax is not assumed. Outstation one-way prices follow the configured distance chart. Outstation round-trip day packages and overtime are separate; kilometres are not billed on top of those day prices.</p>
      </main>
    </>}
  </StaffGate>;
}
