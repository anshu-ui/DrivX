'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, Timestamp, where, type DocumentData } from 'firebase/firestore';
import { COLLECTIONS, formatINR } from '@drivx/domain';
import { toEpochMs } from '@drivx/firebase-client';
import { firebaseClients } from '../lib/firebase';
import { ConsoleHeader, StaffGate, stamp, useReviewerSession } from '../lib/staff-session';

type Booking = { id: string; reference: string; status: string; paymentStatus: string; pickup: string; destination: string; amount: number; estimatePaise: number | null; finalFarePaise: number | null; createdAt: number | null };
type Overview = { bookings: Booking[]; todayBookings: Booking[]; onlineDrivers: number; pendingDrivers: number; paymentFailures: number };
type View = { value: Overview } | { error: string } | null;

function readBooking(id: string, data: DocumentData): Booking {
  const place = (value: unknown) => typeof value === 'object' && value !== null && 'label' in value && typeof value.label === 'string' ? value.label : 'Location unavailable';
  const fare = data.finalFare ?? data.runningFare ?? data.estimate;
  return {
    id,
    reference: typeof data.reference === 'string' ? data.reference : id,
    status: typeof data.status === 'string' ? data.status : 'unknown',
    paymentStatus: typeof data.paymentStatus === 'string' ? data.paymentStatus.toLowerCase() : 'unknown',
    pickup: place(data.pickup),
    destination: place(data.destination),
    amount: typeof fare?.totalPaise === 'number' ? fare.totalPaise : 0,
    estimatePaise: typeof data.estimate?.totalPaise === 'number' ? data.estimate.totalPaise : null,
    finalFarePaise: typeof data.finalFare?.totalPaise === 'number' ? data.finalFare.totalPaise : null,
    createdAt: toEpochMs(data.createdAtMs),
  };
}

const statusLabel = (value: string) => value.replaceAll('_', ' ');

function todayStartIst(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? 0);
  return Date.UTC(part('year'), part('month') - 1, part('day')) - 330 * 60_000;
}

function LiveOverview() {
  const [view, setView] = useState<View>(null);
  useEffect(() => {
    const db = firebaseClients().firestore;
    let bookings: Booking[] = [];
    let todayBookings: Booking[] = [];
    let onlineDrivers = 0;
    let pendingDrivers = 0;
    let paymentFailures = 0;
    let ready = 0;
    let failed = false;
    const publish = () => {
      ready += 1;
      if (!failed && ready >= 5) setView({ value: { bookings, todayBookings, onlineDrivers, pendingDrivers, paymentFailures } });
    };
    const fail = (error: Error) => { failed = true; setView({ error: error.message }); };
    const stops = [
      onSnapshot(query(collection(db, COLLECTIONS.bookings), where('status', 'in', ['requested', 'searching_driver'])), (snapshot) => {
        bookings = snapshot.docs.map((row) => readBooking(row.id, row.data())).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)); publish();
      }, fail),
      onSnapshot(query(
        collection(db, COLLECTIONS.bookings),
        where('createdAtMs', '>=', Timestamp.fromMillis(todayStartIst())),
        where('createdAtMs', '<=', Timestamp.fromMillis(Date.now())),
      ), (snapshot) => {
        todayBookings = snapshot.docs.map((row) => readBooking(row.id, row.data())); publish();
      }, fail),
      onSnapshot(query(collection(db, COLLECTIONS.driverProfiles), where('availabilityState', '==', 'online')), (snapshot) => { onlineDrivers = snapshot.size; publish(); }, fail),
      onSnapshot(query(collection(db, COLLECTIONS.driverProfiles), where('verificationStatus', '==', 'pending_review')), (snapshot) => { pendingDrivers = snapshot.docs.filter((row) => row.data().applicationSubmittedAtMs != null).length; publish(); }, fail),
      onSnapshot(query(collection(db, 'paymentFailures'), where('createdAtMs', '>=', todayStartIst())), (snapshot) => { paymentFailures = snapshot.size; publish(); }, fail),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);

  if (!view) return <section className="rounded-2xl border border-line bg-surface p-8 text-sm text-ink-muted">Connecting to live operations…</section>;
  if ('error' in view) return <section role="alert" className="rounded-2xl border border-danger/30 bg-danger-soft p-6 text-sm text-badge-danger">Could not load live operations: {view.error}</section>;
  const data = view.value;
  const cancelledToday = data.todayBookings.filter((booking) => booking.status === 'cancelled').length;
  const completedToday = data.todayBookings.filter((booking) => booking.status === 'completed').length;
  const fareReview = data.todayBookings.filter((booking) => {
    return booking.estimatePaise !== null && booking.finalFarePaise !== null &&
      Math.abs(booking.finalFarePaise - booking.estimatePaise) >= Math.max(25_000, booking.estimatePaise * 0.25);
  }).length;
  const priorities = [
    ...(cancelledToday >= 4 && cancelledToday / Math.max(data.todayBookings.length, 1) >= 0.25 ? [`Cancellations are elevated: ${cancelledToday} of ${data.todayBookings.length} bookings.`] : []),
    ...(data.paymentFailures ? [`${data.paymentFailures} Cashfree payment attempt${data.paymentFailures === 1 ? '' : 's'} failed today. Review driver dues and gateway status.`] : []),
    ...(fareReview ? [`Review ${fareReview} trip${fareReview === 1 ? '' : 's'} with a large estimate-to-final fare difference.`] : []),
    ...(data.bookings.length ? [`${data.bookings.length} booking${data.bookings.length === 1 ? '' : 's'} still need a driver.`] : []),
  ];
  const metrics = [
    { label: 'Needs a driver', value: data.bookings.length, detail: 'Live unassigned bookings', href: '/bookings', tone: 'text-accent', mark: '↗', tint: 'bg-accent-soft' },
    { label: 'Drivers online', value: data.onlineDrivers, detail: 'Currently marked online', href: '/bookings', tone: 'text-success', mark: '●', tint: 'bg-success-soft' },
    { label: 'Driver reviews', value: data.pendingDrivers, detail: 'Waiting for document review', href: '/verification', tone: 'text-warning', mark: '✓', tint: 'bg-warning-soft' },
  ];
  return <>
    <section className="relative mb-7 overflow-hidden rounded-3xl border border-line bg-surface px-6 py-7 shadow-card sm:px-9 sm:py-9">
      <div aria-hidden className="absolute -right-16 -top-28 h-72 w-72 rounded-full border border-blue-200/70" /><div aria-hidden className="absolute -right-2 -top-14 h-44 w-44 rounded-full border border-blue-200/70" />
      <div className="relative flex flex-wrap items-end justify-between gap-6"><div><div className="inline-flex items-center gap-2 rounded-full border border-accent/15 bg-accent-soft px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.15em] text-accent"><span className="h-2 w-2 rounded-full bg-success" /> Live operations</div><h2 className="mt-5 text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">Today, at a glance</h2><p className="mt-2 max-w-xl text-sm leading-6 text-ink-muted">Bookings, driver availability and reviews—together in one DrivX workspace.</p></div><Link href="/bookings" className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-3 text-sm font-bold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-accent-pressed hover:shadow-lg">Open dispatch <span aria-hidden>→</span></Link></div>
    </section>
    <div className="grid gap-4 md:grid-cols-3">
      {metrics.map((metric) => <Link key={metric.label} href={metric.href} className="group relative overflow-hidden rounded-2xl border border-line bg-surface p-5 shadow-card transition hover:-translate-y-1 hover:shadow-xl">
        <div className="flex items-start justify-between"><p className="text-sm font-semibold text-ink-muted">{metric.label}</p><span className={`flex h-10 w-10 items-center justify-center rounded-xl ${metric.tint} text-sm font-bold ${metric.tone}`} aria-hidden>{metric.mark}</span></div><div className="mt-5 flex items-end justify-between"><p className={`text-4xl font-extrabold tracking-tight ${metric.tone}`}>{metric.value}</p><span className="mb-1 text-ink-faint transition group-hover:translate-x-1" aria-hidden>→</span></div><p className="mt-2 text-xs font-medium text-ink-faint">{metric.detail}</p>
      </Link>)}
    </div>
    <section className="mt-6 rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="font-bold">Today’s operations brief</h2><p className="mt-1 text-sm text-ink-muted">Live count since midnight India time. Automated flags are prompts for a person to review.</p></div>
        <span className="rounded-full bg-accent-soft px-3 py-1 text-xs font-bold text-accent">{data.todayBookings.length} bookings</span>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          ['Completed', completedToday], ['Cancelled', cancelledToday], ['Awaiting driver', data.bookings.length], ['Fare reviews', fareReview], ['Payment failures', data.paymentFailures],
        ].map(([label, value]) => <div key={label} className="rounded-xl border border-line bg-surface-muted/50 p-3"><p className="text-xs text-ink-muted">{label}</p><p className="mt-1 text-2xl font-extrabold text-ink">{value}</p></div>)}
      </div>
      <div className="mt-4 rounded-xl bg-surface-muted p-4">
        <p className="text-xs font-bold uppercase tracking-wider text-ink-faint">What needs attention</p>
        {priorities.length ? <ul className="mt-2 space-y-2 text-sm text-ink">{priorities.map((item) => <li key={item} className="flex gap-2"><span className="text-warning" aria-hidden>•</span><span>{item}</span></li>)}</ul> : <p className="mt-2 text-sm text-ink-muted">No priority flags from today’s booking records.</p>}
      </div>
    </section>
    <section className="mt-8 overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6"><div><div className="flex items-center gap-2"><h2 className="font-bold">Dispatch queue</h2><span className="rounded-full bg-accent-soft px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-accent">Live</span></div><p className="mt-1 text-sm text-ink-muted">Bookings waiting for a driver.</p></div><Link href="/bookings" className="rounded-control border border-line px-4 py-2 text-sm font-semibold text-ink transition hover:bg-surface-muted">View all <span aria-hidden>→</span></Link></div>
      {data.bookings.length === 0 ? <div className="flex flex-col items-center px-5 py-14 text-center"><span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-muted text-2xl text-ink-faint" aria-hidden>✓</span><p className="mt-5 font-bold">All clear for now</p><p className="mt-1 max-w-sm text-sm leading-6 text-ink-muted">No unassigned trips in the queue. New customer requests will show here as they arrive.</p><Link href="/bookings" className="mt-5 text-sm font-bold text-accent hover:underline">Go to dispatch <span aria-hidden>→</span></Link></div> : <div className="divide-y divide-line">{data.bookings.slice(0, 8).map((booking) => <Link key={booking.id} href="/bookings" className="grid gap-3 px-5 py-4 transition hover:bg-surface-muted sm:grid-cols-[1fr_auto] sm:items-center"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{booking.reference}</span><span className="rounded-full bg-warning-soft px-2.5 py-1 text-xs font-medium capitalize text-badge-warning">{statusLabel(booking.status)}</span></div><p className="mt-2 truncate text-sm text-ink-muted">{booking.pickup} <span className="px-1 text-ink-faint">→</span> {booking.destination}</p><p className="mt-1 text-xs text-ink-faint">Requested {stamp(booking.createdAt)}</p></div><span className="font-semibold">{formatINR(booking.amount)}</span></Link>)}</div>}
    </section>
    <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Link href="/bookings" className="rounded-xl border border-line bg-surface p-4 font-semibold hover:bg-surface-muted">Bookings & dispatch <span className="float-right text-accent">→</span></Link>
      <Link href="/verification" className="rounded-xl border border-line bg-surface p-4 font-semibold hover:bg-surface-muted">Driver verification <span className="float-right text-accent">→</span></Link>
      <Link href="/dues" className="rounded-xl border border-line bg-surface p-4 font-semibold hover:bg-surface-muted">Driver earnings & dues <span className="float-right text-accent">→</span></Link>
      <Link href="/invoices" className="rounded-xl border border-line bg-surface p-4 font-semibold hover:bg-surface-muted">Customer & driver invoices <span className="float-right text-accent">→</span></Link>
      <Link href="/rewards" className="rounded-xl border border-line bg-surface p-4 font-semibold hover:bg-surface-muted">Rewards & loyalty <span className="float-right text-accent">→</span></Link>
    </div>
  </>;
}

export default function ConsoleHome() {
  const { reviewer, checked } = useReviewerSession();
  return <main className="flex-1">
    <StaffGate checked={checked} reviewer={reviewer} claim="staff" signInHeading="Sign in to DrivX operations" signInBlurb="Admin access is for amit@referralme.in. Customers and drivers sign in with phone OTP in their own apps.">
      {(signedIn) => <>
        <ConsoleHeader title="Operations overview" blurb="Live bookings, driver availability and dispatch." reviewer={signedIn} links={[{ href: '/bookings', label: 'Bookings' }, { href: '/verification', label: 'Driver reviews' }, { href: '/dues', label: 'Earnings & dues' }, { href: '/invoices', label: 'Trip invoices' }, { href: '/pricing', label: 'Fare settings' }, { href: '/rewards', label: 'Rewards & loyalty' }]} />
        <div className="console-content mx-auto w-full max-w-6xl px-5 py-8 sm:px-8"><LiveOverview /></div>
      </>}
    </StaffGate>
  </main>;
}
