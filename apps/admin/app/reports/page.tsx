'use client';

import { useEffect, useMemo, useState } from 'react';
import { collection, collectionGroup, limit, onSnapshot, orderBy, query, type DocumentData } from 'firebase/firestore';
import { COLLECTIONS, SUBCOLLECTIONS, formatINR } from '@drivx/domain';
import { toEpochMs } from '@drivx/firebase-client';
import { firebaseClients } from '../../lib/firebase';
import { ConsoleHeader, StaffGate, describe, stamp, useReviewerSession } from '../../lib/staff-session';

type BookingRow = { id: string; reference: string; status: string; createdAtMs: number | null; farePaise: number; paymentStatus: string; paymentMethod: string; driverUid: string | null };
type PaymentRow = { id: string; driverUid: string; dueTitle: string; amountPaise: number; method: string; reference: string; createdAtMs: number | null; bookingId: string };
type Feed = { bookings: BookingRow[]; payments: PaymentRow[] };

const timeKey = (ms: number, format: 'day' | 'month') => {
  const parts = new Intl.DateTimeFormat('en-CA', format === 'day'
    ? { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Kolkata' }
    : { year: 'numeric', month: '2-digit', timeZone: 'Asia/Kolkata' }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return format === 'day' ? `${get('year')}-${get('month')}-${get('day')}` : `${get('year')}-${get('month')}`;
};
const csv = (filename: string, rows: Array<Array<string | number>>) => {
  const quote = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const blob = new Blob([rows.map((row) => row.map(quote).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
};
function readBooking(id: string, data: DocumentData): BookingRow {
  const fare = (data.finalFare ?? data.runningFare ?? data.estimate) as { totalPaise?: unknown } | null;
  return { id, reference: typeof data.reference === 'string' ? data.reference : id, status: String(data.status ?? 'unknown'), createdAtMs: toEpochMs(data.createdAtMs), farePaise: Number(fare?.totalPaise ?? 0), paymentStatus: String(data.paymentStatus ?? 'unknown'), paymentMethod: String(data.paymentMethod ?? '—'), driverUid: typeof data.assignedDriverUid === 'string' ? data.assignedDriverUid : null };
}
function readPayment(snap: { id: string; ref: { path: string }; data: () => DocumentData }): PaymentRow | null {
  const data = snap.data(); if (data.status !== 'paid' || data.settledBy !== 'cashfree') return null;
  const parts = snap.ref.path.split('/'); const driverUid = parts[parts.indexOf(SUBCOLLECTIONS.driverDues) - 1]; if (!driverUid) return null;
  return { id: snap.id, driverUid, dueTitle: typeof data.title === 'string' ? data.title : String(data.kind ?? 'Driver payment'), amountPaise: Number(data.totalPaise ?? 0), method: String(data.method ?? 'Online'), reference: typeof data.reference === 'string' ? data.reference : String(data.providerPaymentId ?? '—'), createdAtMs: toEpochMs(data.recordedAtMs ?? data.createdAtMs), bookingId: typeof data.bookingId === 'string' ? data.bookingId : '' };
}
function BarChart({ rows, label, money = false }: { rows: Array<{ label: string; value: number }>; label: string; money?: boolean }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return <div role="img" aria-label={label} className="mt-5 grid grid-cols-7 items-end gap-2 sm:gap-3">
    {rows.map((row) => <div key={row.label} className="flex min-w-0 flex-col items-center gap-2"><span className="truncate text-[10px] font-semibold text-ink-muted sm:text-xs">{money ? formatINR(row.value) : row.value}</span><div className="flex h-36 w-full items-end rounded-lg bg-surface-muted p-1"><div title={`${row.label}: ${money ? formatINR(row.value) : row.value}`} className="w-full rounded-md bg-surface-brand transition-[height] duration-500" style={{ height: `${Math.max(row.value > 0 ? 7 : 2, row.value / max * 100)}%` }} /></div><span className="text-[10px] text-ink-faint sm:text-xs">{row.label}</span></div>)}
  </div>;
}

export default function ReportsPage() {
  const { reviewer, checked } = useReviewerSession();
  const [feed, setFeed] = useState<Feed | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    const db = firebaseClients().firestore; let bookings: BookingRow[] = []; let payments: PaymentRow[] = []; let ready = 0;
    const publish = () => { ready += 1; if (ready >= 2) setFeed({ bookings, payments }); };
    const fail = (message: string) => setErrors((prior) => prior.includes(message) ? prior : [...prior, message]);
    const stopBookings = onSnapshot(query(collection(db, COLLECTIONS.bookings), orderBy('createdAtMs', 'desc'), limit(1000)), (snap) => { bookings = snap.docs.map((doc) => readBooking(doc.id, doc.data())); publish(); }, (error) => fail(`Bookings: ${describe(error)}`));
    const stopPayments = onSnapshot(query(collectionGroup(db, SUBCOLLECTIONS.driverDues)), (snap) => { payments = snap.docs.map(readPayment).filter((row): row is PaymentRow => row !== null).sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0)); publish(); }, (error) => fail(`Online payment ledger: ${describe(error)}`));
    return () => { stopBookings(); stopPayments(); };
  }, []);

  const now = Date.now();
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => { const date = new Date(); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() - (6 - index)); const key = timeKey(date.getTime(), 'day'); return { key, label: new Intl.DateTimeFormat('en-IN', { weekday: 'short', timeZone: 'Asia/Kolkata' }).format(date) }; }), []);
  const months = useMemo(() => Array.from({ length: 6 }, (_, index) => { const date = new Date(); date.setDate(1); date.setHours(12, 0, 0, 0); date.setMonth(date.getMonth() - (5 - index)); const key = timeKey(date.getTime(), 'month'); return { key, label: new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'Asia/Kolkata' }).format(date) }; }), []);
  const bookings = feed?.bookings ?? []; const payments = feed?.payments ?? [];
  const dailyBookings = days.map((day) => ({ label: day.label, value: bookings.filter((row) => row.createdAtMs && timeKey(row.createdAtMs, 'day') === day.key).length }));
  const monthlyBookings = months.map((month) => ({ label: month.label, value: bookings.filter((row) => row.createdAtMs && timeKey(row.createdAtMs, 'month') === month.key).length }));
  const dailyPayments = days.map((day) => ({ label: day.label, value: payments.filter((row) => row.createdAtMs && timeKey(row.createdAtMs, 'day') === day.key).reduce((sum, row) => sum + row.amountPaise, 0) }));
  const completed = bookings.filter((row) => row.status === 'completed');
  const completedFarePaise = completed.reduce((sum, row) => sum + row.farePaise, 0);
  const cancelled = bookings.filter((row) => row.status === 'cancelled').length;
  const onlinePaymentPaise = payments.reduce((sum, row) => sum + row.amountPaise, 0);
  const paidThisMonth = payments.filter((row) => row.createdAtMs && timeKey(row.createdAtMs, 'month') === timeKey(now, 'month')).reduce((sum, row) => sum + row.amountPaise, 0);

  return <main className="flex-1"><StaffGate checked={checked} reviewer={reviewer} claim="staff" signInHeading="Staff sign-in" signInBlurb="Only the administrator and operations team can read company-wide booking and payment reports.">{(signedIn) => <>
    <ConsoleHeader title="Reports & growth" blurb="Live booking activity, completed trip fares and Cashfree-confirmed driver payments." reviewer={signedIn} links={[{ href: '/', label: 'Overview' }, { href: '/bookings', label: 'Bookings & dispatch' }, { href: '/verification', label: 'Driver reviews' }, { href: '/dues', label: 'Earnings & dues' }, { href: '/reports', label: 'Reports & growth' }, { href: '/pricing', label: 'Fare settings' }, { href: '/rewards', label: 'Rewards & loyalty' }]} />
    <div className="console-content mx-auto w-full max-w-7xl px-5 py-7 sm:px-8">
      {errors.map((error) => <p key={error} role="alert" className="mb-3 rounded-xl border border-danger/30 bg-danger-soft p-3 text-sm text-badge-danger">{error}</p>)}
      {!feed ? <div className="rounded-2xl border border-line bg-surface p-8 text-sm text-ink-muted">Loading live company activity…</div> : <>
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[["Bookings in latest 1,000", bookings.length], ['Completed trips in window', completed.length], ['Cancelled in window', cancelled], ['Completed trip fares', formatINR(completedFarePaise)], ['Cashfree driver payments', formatINR(onlinePaymentPaise)], ['Cashfree paid this month', formatINR(paidThisMonth)]].map(([label, value]) => <article key={String(label)} className="rounded-2xl border border-line bg-surface p-4 shadow-card"><p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{label}</p><p className="mt-2 font-mono text-xl font-bold">{value}</p></article>)}
        </section>
        <p className="mt-3 text-xs leading-5 text-ink-faint">Booking counts and completed fares are based on the latest 1,000 booking documents loaded below. Cashfree payments are the full successful driver-due ledger (onboarding, commission or penalties) and are separate from customer trip fares. Cash collected for a ride is not counted as an online settlement.</p>
        <section className="mt-5 grid gap-5 xl:grid-cols-2">
          <article className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6"><div><h2 className="text-lg font-bold">Bookings · last 7 days</h2><p className="text-sm text-ink-muted">New customer booking requests by day</p></div><BarChart rows={dailyBookings} label="Bookings received each of the last seven days" /></article>
          <article className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6"><div><h2 className="text-lg font-bold">Bookings · last 6 months</h2><p className="text-sm text-ink-muted">Monthly bookings in the loaded window</p></div><BarChart rows={monthlyBookings} label="Bookings received in each of the last six months" /></article>
          <article className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6 xl:col-span-2"><div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg font-bold">Successful online payments · last 7 days</h2><p className="text-sm text-ink-muted">Cashfree-confirmed driver charge settlements. Download the full receipt list below.</p></div><p className="font-mono text-lg font-bold">{formatINR(onlinePaymentPaise)}</p></div><BarChart rows={dailyPayments} label="Cashfree successful driver payments for each of the last seven days" money /></article>
        </section>
        <section className="mt-5 rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6"><div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg font-bold">Successful online payment receipts</h2><p className="mt-1 text-sm text-ink-muted">Only Cashfree-confirmed driver-dues transactions appear here, including payment reference, driver, due type and timestamp.</p></div><button type="button" disabled={!payments.length} onClick={() => csv('drivx-successful-online-payments.csv', [['Payment ledger ID', 'Driver UID', 'Charge', 'Amount paise', 'Payment method', 'Payment reference', 'Recorded at', 'Booking ID'], ...payments.map((row) => [row.id, row.driverUid, row.dueTitle, row.amountPaise, row.method, row.reference, row.createdAtMs ? stamp(row.createdAtMs) : '', row.bookingId])])} className="rounded-control border border-line px-4 py-2 text-sm font-semibold disabled:opacity-50">Export payments CSV</button></div>
          <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[800px] text-left text-sm"><thead className="border-b border-line text-ink-muted"><tr><th className="py-3">Recorded</th><th>Driver UID</th><th>Charge type</th><th>Payment method</th><th>Reference</th><th className="text-right">Amount</th></tr></thead><tbody>{payments.map((row) => <tr key={`${row.driverUid}-${row.id}`} className="border-b border-line"><td className="py-3">{row.createdAtMs ? stamp(row.createdAtMs) : '—'}</td><td className="font-mono text-xs">{row.driverUid}</td><td>{row.dueTitle}{row.bookingId ? <p className="text-[10px] text-ink-faint">{row.bookingId}</p> : null}</td><td>{row.method}</td><td className="font-mono text-xs">{row.reference}</td><td className="text-right font-mono font-semibold">{formatINR(row.amountPaise)}</td></tr>)}{!payments.length ? <tr><td colSpan={6} className="py-8 text-center text-ink-muted">No successful Cashfree driver payments found.</td></tr> : null}</tbody></table></div>
        </section>
        <section className="mt-5 rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6"><div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg font-bold">Recent bookings & payment status</h2><p className="mt-1 text-sm text-ink-muted">Fare is trip revenue; payment status/method indicate what the booking record says was collected.</p></div><button type="button" disabled={!bookings.length} onClick={() => csv('drivx-booking-growth.csv', [['Booking ID', 'Reference', 'Status', 'Created at', 'Fare paise', 'Payment status', 'Payment method', 'Driver UID'], ...bookings.map((row) => [row.id, row.reference, row.status, row.createdAtMs ? stamp(row.createdAtMs) : '', row.farePaise, row.paymentStatus, row.paymentMethod, row.driverUid ?? ''])])} className="rounded-control border border-line px-4 py-2 text-sm font-semibold disabled:opacity-50">Export bookings CSV</button></div>
          <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="border-b border-line text-ink-muted"><tr><th className="py-3">Created</th><th>Booking</th><th>Status</th><th>Fare</th><th>Customer payment</th><th>Driver UID</th></tr></thead><tbody>{bookings.slice(0, 100).map((row) => <tr key={row.id} className="border-b border-line"><td className="py-3">{row.createdAtMs ? stamp(row.createdAtMs) : '—'}</td><td>{row.reference}<p className="font-mono text-[10px] text-ink-faint">{row.id}</p></td><td className="capitalize">{row.status.replaceAll('_', ' ')}</td><td className="font-mono">{formatINR(row.farePaise)}</td><td>{row.paymentStatus.replaceAll('_', ' ')} · {row.paymentMethod}</td><td className="font-mono text-xs">{row.driverUid ?? '—'}</td></tr>)}</tbody></table></div><p className="mt-3 text-xs text-ink-faint">Showing the latest {Math.min(bookings.length, 100)} booking rows here; the chart and booking export use all {bookings.length} loaded records.</p>
        </section>
      </>}
    </div>
  </>}</StaffGate></main>;
}
