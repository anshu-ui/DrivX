'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where, type DocumentData } from 'firebase/firestore';
import { COLLECTIONS, formatINR } from '@drivx/domain';
import { toEpochMs } from '@drivx/firebase-client';
import { firebaseClients } from '../lib/firebase';
import { ConsoleHeader, StaffGate, stamp, useReviewerSession } from '../lib/staff-session';

type Booking = { id: string; reference: string; status: string; pickup: string; destination: string; amount: number; createdAt: number | null };
type Overview = { bookings: Booking[]; onlineDrivers: number; pendingDrivers: number };
type View = { value: Overview } | { error: string } | null;

function readBooking(id: string, data: DocumentData): Booking {
  const place = (value: unknown) => typeof value === 'object' && value !== null && 'label' in value && typeof value.label === 'string' ? value.label : 'Location unavailable';
  const fare = data.finalFare ?? data.runningFare ?? data.estimate;
  return {
    id,
    reference: typeof data.reference === 'string' ? data.reference : id,
    status: typeof data.status === 'string' ? data.status : 'unknown',
    pickup: place(data.pickup),
    destination: place(data.destination),
    amount: typeof fare?.totalPaise === 'number' ? fare.totalPaise : 0,
    createdAt: toEpochMs(data.createdAtMs),
  };
}

const statusLabel = (value: string) => value.replaceAll('_', ' ');

function LiveOverview() {
  const [view, setView] = useState<View>(null);
  useEffect(() => {
    const db = firebaseClients().firestore;
    let bookings: Booking[] = [];
    let onlineDrivers = 0;
    let pendingDrivers = 0;
    let ready = 0;
    let failed = false;
    const publish = () => {
      ready += 1;
      if (!failed && ready >= 3) setView({ value: { bookings, onlineDrivers, pendingDrivers } });
    };
    const fail = (error: Error) => { failed = true; setView({ error: error.message }); };
    const stops = [
      onSnapshot(query(collection(db, COLLECTIONS.bookings), where('status', 'in', ['requested', 'searching_driver'])), (snapshot) => {
        bookings = snapshot.docs.map((row) => readBooking(row.id, row.data())).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)); publish();
      }, fail),
      onSnapshot(query(collection(db, COLLECTIONS.driverProfiles), where('availabilityState', '==', 'online')), (snapshot) => { onlineDrivers = snapshot.size; publish(); }, fail),
      onSnapshot(query(collection(db, COLLECTIONS.driverProfiles), where('verificationStatus', '==', 'pending_review')), (snapshot) => { pendingDrivers = snapshot.docs.filter((row) => row.data().applicationSubmittedAtMs != null).length; publish(); }, fail),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);

  if (!view) return <section className="rounded-2xl border border-line bg-surface p-8 text-sm text-ink-muted">Connecting to live operations…</section>;
  if ('error' in view) return <section role="alert" className="rounded-2xl border border-danger/30 bg-danger-soft p-6 text-sm text-badge-danger">Could not load live operations: {view.error}</section>;
  const data = view.value;
  const metrics = [
    { label: 'Needs a driver', value: data.bookings.length, detail: 'Live unassigned bookings', href: '/bookings', tone: 'text-brand', mark: '↗', tint: 'bg-accent-soft' },
    { label: 'Drivers online', value: data.onlineDrivers, detail: 'Currently marked online', href: '/bookings', tone: 'text-success', mark: '●', tint: 'bg-success-soft' },
    { label: 'Driver reviews', value: data.pendingDrivers, detail: 'Waiting for document review', href: '/verification', tone: 'text-warning', mark: '✓', tint: 'bg-warning-soft' },
  ];
  return <>
    <section className="relative mb-7 overflow-hidden rounded-3xl bg-surface-brand px-6 py-7 text-ink-on-brand shadow-xl shadow-slate-900/10 sm:px-9 sm:py-9">
      <div aria-hidden className="absolute -right-16 -top-28 h-72 w-72 rounded-full border border-white/10" /><div aria-hidden className="absolute -right-2 -top-14 h-44 w-44 rounded-full border border-white/10" />
      <div className="relative flex flex-wrap items-end justify-between gap-6"><div><div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.15em] text-white/85"><span className="h-2 w-2 rounded-full bg-blue-300" /> Live control room</div><h2 className="mt-5 text-3xl font-extrabold tracking-tight sm:text-4xl">Your network at a glance</h2><p className="mt-2 max-w-xl text-sm leading-6 text-white/70">Bookings, driver availability and reviews—streaming directly from DrivX.</p></div><Link href="/bookings" className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-bold text-ink shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg">Open dispatch <span aria-hidden>→</span></Link></div>
    </section>
    <div className="grid gap-4 md:grid-cols-3">
      {metrics.map((metric) => <Link key={metric.label} href={metric.href} className="group relative overflow-hidden rounded-2xl border border-line bg-surface p-5 shadow-card transition hover:-translate-y-1 hover:shadow-xl">
        <div className="flex items-start justify-between"><p className="text-sm font-semibold text-ink-muted">{metric.label}</p><span className={`flex h-10 w-10 items-center justify-center rounded-xl ${metric.tint} text-sm font-bold ${metric.tone}`} aria-hidden>{metric.mark}</span></div><div className="mt-5 flex items-end justify-between"><p className={`text-4xl font-extrabold tracking-tight ${metric.tone}`}>{metric.value}</p><span className="mb-1 text-ink-faint transition group-hover:translate-x-1" aria-hidden>→</span></div><p className="mt-2 text-xs font-medium text-ink-faint">{metric.detail}</p>
      </Link>)}
    </div>
    <section className="mt-8 overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6"><div><div className="flex items-center gap-2"><h2 className="font-bold">Dispatch queue</h2><span className="rounded-full bg-accent-soft px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-accent">Live</span></div><p className="mt-1 text-sm text-ink-muted">Bookings waiting for a driver.</p></div><Link href="/bookings" className="rounded-control border border-line px-4 py-2 text-sm font-semibold text-ink transition hover:bg-surface-muted">View all <span aria-hidden>→</span></Link></div>
      {data.bookings.length === 0 ? <div className="flex flex-col items-center px-5 py-14 text-center"><span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-muted text-2xl text-ink-faint" aria-hidden>✓</span><p className="mt-5 font-bold">All clear for now</p><p className="mt-1 max-w-sm text-sm leading-6 text-ink-muted">No unassigned trips in the queue. New customer requests will show here as they arrive.</p><Link href="/bookings" className="mt-5 text-sm font-bold text-accent hover:underline">Go to dispatch <span aria-hidden>→</span></Link></div> : <div className="divide-y divide-line">{data.bookings.slice(0, 8).map((booking) => <Link key={booking.id} href="/bookings" className="grid gap-3 px-5 py-4 transition hover:bg-surface-muted sm:grid-cols-[1fr_auto] sm:items-center"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{booking.reference}</span><span className="rounded-full bg-warning-soft px-2.5 py-1 text-xs font-medium capitalize text-badge-warning">{statusLabel(booking.status)}</span></div><p className="mt-2 truncate text-sm text-ink-muted">{booking.pickup} <span className="px-1 text-ink-faint">→</span> {booking.destination}</p><p className="mt-1 text-xs text-ink-faint">Requested {stamp(booking.createdAt)}</p></div><span className="font-semibold">{formatINR(booking.amount)}</span></Link>)}</div>}
    </section>
    <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Link href="/bookings" className="rounded-xl border border-line bg-surface p-4 font-semibold hover:bg-surface-muted">Bookings & dispatch <span className="float-right text-brand">→</span></Link>
      <Link href="/verification" className="rounded-xl border border-line bg-surface p-4 font-semibold hover:bg-surface-muted">Driver verification <span className="float-right text-brand">→</span></Link>
      <Link href="/dues" className="rounded-xl border border-line bg-surface p-4 font-semibold hover:bg-surface-muted">Driver earnings & dues <span className="float-right text-brand">→</span></Link>
      <Link href="/rewards" className="rounded-xl border border-line bg-surface p-4 font-semibold hover:bg-surface-muted">Rewards & loyalty <span className="float-right text-brand">→</span></Link>
    </div>
  </>;
}

export default function ConsoleHome() {
  const { reviewer, checked } = useReviewerSession();
  return <main className="flex-1">
    <StaffGate checked={checked} reviewer={reviewer} claim="staff" signInHeading="Sign in to DrivX operations" signInBlurb="Admin access is for amit@referralme.in. Customers and drivers sign in with phone OTP in their own apps.">
      {(signedIn) => <>
        <ConsoleHeader title="Operations" blurb="Live bookings, driver availability and dispatch." reviewer={signedIn} links={[{ href: '/bookings', label: 'Bookings' }, { href: '/verification', label: 'Driver reviews' }, { href: '/dues', label: 'Earnings & dues' }, { href: '/pricing', label: 'Fare settings' }, { href: '/rewards', label: 'Rewards & loyalty' }]} />
        <div className="console-content mx-auto w-full max-w-6xl px-5 py-8 sm:px-8"><LiveOverview /></div>
      </>}
    </StaffGate>
  </main>;
}
