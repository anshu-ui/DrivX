'use client';

import { useEffect, useState } from 'react';
import { collection, collectionGroup, limit, onSnapshot, orderBy, query, where, type DocumentData } from 'firebase/firestore';
import { COLLECTIONS, SUBCOLLECTIONS, formatINR, type ServiceTypeId } from '@drivx/domain';
import { callFunction, toEpochMs } from '@drivx/firebase-client';
import { firebaseClients } from '../../lib/firebase';
import { ConsoleHeader, StaffGate, describe, stamp, useReviewerSession } from '../../lib/staff-session';

type Booking = { id: string; reference: string; status: string; archived: boolean; pickup: string; pickupLocation: { lat: number; lng: number } | null; destination: string; zoneId: string; serviceTypeId: ServiceTypeId; amount: number; createdAt: number | null; driverUid: string | null; driverName: string | null; driverPhone: string | null; paymentStatus: string; paymentMethod: string; commissionPaise: number; startOdometerKm: number | null; endOdometerKm: number | null };
type Driver = { uid: string; name: string; phone: string; zoneId: string; services: string[] };
type CommissionPayment = { status: string; method: string | null; reference: string | null };
type State = { bookings: Booking[]; drivers: Driver[]; commissionPayments: Record<string, CommissionPayment> } | { error: string } | null;

const placeLabel = (value: unknown) => typeof value === 'object' && value !== null && 'label' in value && typeof value.label === 'string' ? value.label : 'Location unavailable';
function readBooking(id: string, data: DocumentData): Booking {
  const fare = (data.finalFare ?? data.runningFare ?? data.estimate) as { totalPaise?: number } | null;
  const driver = typeof data.driver === 'object' && data.driver !== null ? data.driver as Record<string, unknown> : {};
  const commission = typeof data.commission === 'object' && data.commission !== null ? data.commission as Record<string, unknown> : {};
  const pickup = data.pickup as { location?: { lat?: unknown; lng?: unknown } } | undefined;
  const lat = pickup?.location?.lat;
  const lng = pickup?.location?.lng;
  return { id, reference: typeof data.reference === 'string' ? data.reference : id, status: String(data.status ?? 'unknown'), archived: data.adminArchivedAtMs != null, pickup: placeLabel(data.pickup), pickupLocation: typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : null, destination: placeLabel(data.destination), zoneId: String(data.zoneId ?? ''), serviceTypeId: data.serviceTypeId as ServiceTypeId, amount: Number(fare?.totalPaise ?? 0), createdAt: toEpochMs(data.createdAtMs), driverUid: typeof data.assignedDriverUid === 'string' ? data.assignedDriverUid : null, driverName: typeof driver.fullName === 'string' ? driver.fullName : null, driverPhone: typeof driver.phoneE164 === 'string' ? driver.phoneE164 : null, paymentStatus: String(data.paymentStatus ?? 'not_recorded'), paymentMethod: String(data.paymentMethod ?? '—'), commissionPaise: Number(commission.totalPaise ?? 0), startOdometerKm: typeof data.startOdometerKm === 'number' ? data.startOdometerKm : null, endOdometerKm: typeof data.endOdometerKm === 'number' ? data.endOdometerKm : null };
}

export default function BookingsPage() {
  const { reviewer, checked } = useReviewerSession();
  const [state, setState] = useState<State>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string; error?: boolean } | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    const db = firebaseClients().firestore;
    let bookings: Booking[] = [];
    let drivers: Driver[] = [];
    let commissionPayments: Record<string, CommissionPayment> = {};
    let done = 0;
    let failed = false;
    const update = () => { done += 1; if (!failed && done >= 3) setState({ bookings, drivers, commissionPayments }); };
    const fail = (error: Error) => { failed = true; setState({ error: error.message }); };
    const stopBookings = onSnapshot(query(collection(db, COLLECTIONS.bookings), orderBy('createdAtMs', 'desc'), limit(100)), (snap) => {
      bookings = snap.docs.map((doc) => readBooking(doc.id, doc.data())); update();
    }, fail);
    const stopDrivers = onSnapshot(query(collection(db, COLLECTIONS.driverProfiles), where('availabilityState', '==', 'online'), where('verificationStatus', '==', 'approved')), (snap) => {
      drivers = snap.docs.map((doc) => { const data = doc.data(); return { uid: doc.id, name: String(data.fullName ?? 'Driver'), phone: String(data.phoneE164 ?? ''), zoneId: String(data.zoneId ?? ''), services: Array.isArray(data.serviceTypeIds) ? data.serviceTypeIds.map(String) : [] }; }); update();
    }, fail);
    const stopCommissionPayments = onSnapshot(query(collectionGroup(db, SUBCOLLECTIONS.driverDues), orderBy('createdAtMs', 'desc'), limit(500)), (snap) => {
      commissionPayments = Object.fromEntries(snap.docs.flatMap((due) => {
        const data = due.data();
        if (data.kind !== 'commission' || typeof data.bookingId !== 'string') return [];
        return [[data.bookingId, { status: String(data.status ?? 'unknown'), method: typeof data.method === 'string' ? data.method : null, reference: typeof data.reference === 'string' ? data.reference : null }]];
      })); update();
    }, fail);
    return () => { stopBookings(); stopDrivers(); stopCommissionPayments(); };
  }, []);



  async function assign(booking: Booking, drivers: Driver[]) {
    const driverUid = selected[booking.id];
    const why = reason[booking.id]?.trim() || 'Admin selected this online driver for the booking.';
    if (!driverUid) { setNotice({ id: booking.id, text: 'Choose a driver first.', error: true }); return; }
    const driver = drivers.find((item) => item.uid === driverUid);
    if (!driver) { setNotice({ id: booking.id, text: 'That driver is no longer online. Refresh and choose again.', error: true }); return; }
    setBusy(booking.id); setNotice(null);
    try {
      await callFunction(firebaseClients(), 'manualAssign', { bookingId: booking.id, driverUid, reason: why });
      setNotice({ id: booking.id, text: `Offer sent to ${driver.name}. They must accept it in the driver app.` });
    } catch (error) { setNotice({ id: booking.id, text: describe(error), error: true }); }
    finally { setBusy(null); }
  }

  async function manageBooking(booking: Booking, action: 'cancel' | 'archive') {
    const prompt = action === 'cancel'
      ? `Cancel ${booking.reference}? This is allowed only before a trip starts; the customer and assigned driver will be notified.`
      : `Archive ${booking.reference}? This only hides it from the default list; payments and audit history stay intact.`;
    const reasonText = window.prompt(`${prompt}\n\nEnter a reason (minimum 8 characters):`);
    if (!reasonText || reasonText.trim().length < 8) return;
    setBusy(booking.id); setNotice(null);
    try {
      const result = await callFunction<{ bookingId: string; action: 'cancel' | 'archive'; reason: string }, { bookingId: string; action: 'cancel' | 'archive'; auditLogId: string }>(firebaseClients(), 'adminManageBooking', { bookingId: booking.id, action, reason: reasonText.trim() });
      setNotice({ id: booking.id, text: `${action === 'cancel' ? 'Booking cancelled' : 'Booking archived'} · audit ${result.auditLogId}.` });
    } catch (error) {
      setNotice({ id: booking.id, text: describe(error), error: true });
    } finally { setBusy(null); }
  }

  return <main className="flex-1">
    <StaffGate checked={checked} reviewer={reviewer} claim="admin" signInHeading="Administrator sign-in required" signInBlurb="Sign in with the DrivX administrator account. Customer and driver accounts use phone OTP in their own apps.">
      {(signedIn) => <>
        <ConsoleHeader title="Bookings & dispatch" blurb="Every approved, online driver receives the booking offer. Admin can also send it directly to any online driver; the first to accept gets the trip." reviewer={signedIn} links={[{ href: '/', label: 'Overview' }, { href: '/bookings', label: 'Bookings & dispatch' }, { href: '/verification', label: 'Driver reviews' }, { href: '/dues', label: 'Earnings & dues' }, { href: '/pricing', label: 'Fare settings' }]} />
        <div className="console-content mx-auto w-full max-w-6xl px-5 py-8 sm:px-8">
          {state && !('error' in state) ? <section className="mb-6 rounded-2xl border border-line bg-surface p-5"><div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-bold">Approved drivers online</h2><p className="text-sm text-ink-muted">Distance, zones and service labels do not restrict booking offers.</p></div><span className="rounded-full bg-info-soft px-3 py-1 text-sm font-semibold">{state.drivers.length} online</span></div>{state.drivers.length ? <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{state.drivers.map((driver) => <div key={driver.uid} className="rounded-xl bg-surface-muted p-3 text-sm"><p className="font-semibold">{driver.name}{driver.phone ? ` · ${driver.phone}` : ''}</p><p className="mt-1 text-xs text-ink-muted">Work zone: {driver.zoneId || 'not set'} · Services: {driver.services.join(', ') || 'none enabled'}</p></div>)}</div> : <p className="mt-4 text-sm text-ink-muted">No approved driver currently has Online status. They must be approved, clear dues, accept duty terms and turn on duty with location enabled.</p>}</section> : null}
          {state === null ? <div className="rounded-2xl border border-line bg-surface p-8 text-sm text-ink-muted">Loading live bookings and drivers…</div> : 'error' in state ? <div role="alert" className="rounded-xl border border-danger/30 bg-danger-soft p-5 text-sm text-badge-danger">Could not read dispatch data: {state.error}</div> : state.bookings.length === 0 ? <section className="rounded-2xl border border-line bg-surface px-6 py-16 text-center"><p className="text-lg font-semibold">No bookings yet</p><p className="mt-2 text-sm text-ink-muted">New customer requests and completed trips appear here in real time.</p></section> : <div className="space-y-8"><section><div className="mb-4"><h2 className="text-lg font-bold">Waiting for a driver</h2><p className="text-sm text-ink-muted">Bookings stay here until a driver accepts. Manual dispatch sends an offer; the driver still confirms it.</p></div><div className="space-y-5">{state.bookings.filter((booking) => !booking.archived && (booking.status === 'requested' || booking.status === 'searching_driver')).map((booking) => {
            const eligible = state.drivers;
            return <article key={booking.id} className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-bold">{booking.reference}</h3><span className="rounded-full bg-warning-soft px-2.5 py-1 text-xs font-medium capitalize text-badge-warning">{booking.status.replaceAll('_', ' ')}</span></div><p className="mt-1 text-sm text-ink-faint">ID {booking.id} · Received {stamp(booking.createdAt)}</p></div><p className="text-xl font-bold">{formatINR(booking.amount)}</p></div>
              <div className="mt-5 grid gap-3 sm:grid-cols-2"><div className="rounded-xl bg-surface-muted p-3"><p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Pickup</p><p className="mt-1 text-sm">{booking.pickup}</p></div><div className="rounded-xl bg-surface-muted p-3"><p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Destination</p><p className="mt-1 text-sm">{booking.destination}</p></div></div>
              <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_1fr_auto] lg:items-end"><label className="text-sm font-medium">Online drivers<select value={selected[booking.id] ?? ''} onChange={(event) => setSelected((prev) => ({ ...prev, [booking.id]: event.target.value }))} className="mt-1.5 w-full rounded-control border border-line bg-surface px-3 py-2.5 font-normal"><option value="">{eligible.length ? 'Choose an online driver' : 'No approved driver online'}</option>{state.drivers.map((driver) => <option key={driver.uid} value={driver.uid}>{driver.name}{driver.phone ? ` · ${driver.phone}` : ''} · Online</option>)}</select></label><label className="text-sm font-medium">Dispatch note<input value={reason[booking.id] ?? ''} onChange={(event) => setReason((prev) => ({ ...prev, [booking.id]: event.target.value }))} placeholder="Optional dispatch note" maxLength={400} className="mt-1.5 w-full rounded-control border border-line bg-surface px-3 py-2.5 font-normal" /></label><button type="button" disabled={!eligible.length || busy === booking.id} onClick={() => void assign(booking, state.drivers)} className="rounded-control bg-surface-brand px-5 py-2.5 font-semibold text-ink-on-brand disabled:cursor-not-allowed disabled:opacity-50">{busy === booking.id ? 'Sending…' : 'Send offer'}</button></div>
              <button type="button" disabled={busy === booking.id} onClick={() => void manageBooking(booking, 'cancel')} className="mt-3 rounded-control border border-danger px-4 py-2 text-sm font-semibold text-badge-danger disabled:opacity-50">Cancel booking</button>
              {notice?.id === booking.id ? <p role={notice.error ? 'alert' : 'status'} className={`mt-3 text-sm ${notice.error ? 'text-badge-danger' : 'text-badge-success'}`}>{notice.text}</p> : null}
            </article>;
          })}{state.bookings.every((booking) => booking.archived || (booking.status !== 'requested' && booking.status !== 'searching_driver')) ? <div className="rounded-2xl border border-line bg-surface px-6 py-8 text-sm text-ink-muted">No bookings are waiting for a driver.</div> : null}</div></section><section><div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg font-bold">Recent bookings · live</h2><p className="text-sm text-ink-muted">Last 100 bookings, including assigned, active and completed. Refreshes automatically as trip and payment status change.</p></div><button type="button" onClick={() => setShowArchived((value) => !value)} className="rounded-control border border-line px-3 py-2 text-sm font-medium">{showArchived ? 'Hide archived' : `Show archived (${state.bookings.filter((booking) => booking.archived).length})`}</button></div><div className="space-y-3">{state.bookings.filter((booking) => showArchived || !booking.archived).map((booking) => { const commissionPayment = state.commissionPayments[booking.id]; return <article key={`live-${booking.id}`} className="rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h3 className="font-bold">{booking.reference}</h3><span className="rounded-full bg-info-soft px-2.5 py-1 text-xs font-medium capitalize text-badge-info">{booking.status.replaceAll('_', ' ')}</span>{booking.archived ? <span className="rounded-full bg-surface-muted px-2.5 py-1 text-xs">Archived</span> : null}</div><p className="mt-1 break-all text-xs text-ink-faint">Booking ID: {booking.id}</p></div><div className="text-right"><p className="font-bold">{formatINR(booking.amount)}</p><p className="text-xs text-ink-muted">{stamp(booking.createdAt)}</p></div></div><div className="mt-3 grid gap-2 text-sm sm:grid-cols-2"><p><span className="text-ink-muted">Pickup:</span> {booking.pickup}</p><p><span className="text-ink-muted">Drop:</span> {booking.destination}</p><p><span className="text-ink-muted">Driver:</span> {booking.driverName ?? booking.driverUid ?? 'Not assigned'}{booking.driverPhone ? ` · ${booking.driverPhone}` : ''}</p><p><span className="text-ink-muted">Customer fare payment:</span> {booking.paymentStatus.replaceAll('_', ' ')} · {booking.paymentMethod}</p><p><span className="text-ink-muted">Driver commission:</span> {booking.commissionPaise ? `${formatINR(booking.commissionPaise)} · ${commissionPayment ? `${commissionPayment.status}${commissionPayment.method ? ` via ${commissionPayment.method}` : ''}${commissionPayment.reference ? ` · Ref ${commissionPayment.reference}` : ''}` : booking.status === 'completed' ? 'Ledger pending' : 'Created on completion'}` : booking.status === 'completed' ? 'Ledger pending' : 'Calculated on completion'}</p><p><span className="text-ink-muted">Odometer:</span> {booking.startOdometerKm ?? '—'} km → {booking.endOdometerKm ?? '—'} km</p></div><div className="mt-4 flex flex-wrap gap-2">{!booking.archived && ['requested', 'searching_driver', 'assigned', 'driver_en_route', 'driver_arrived'].includes(booking.status) ? <button type="button" disabled={busy === booking.id} onClick={() => void manageBooking(booking, 'cancel')} className="rounded-control border border-danger px-3 py-2 text-sm font-semibold text-badge-danger disabled:opacity-50">Cancel before trip starts</button> : null}{!booking.archived && ['cancelled', 'completed'].includes(booking.status) ? <button type="button" disabled={busy === booking.id} onClick={() => void manageBooking(booking, 'archive')} className="rounded-control border border-line px-3 py-2 text-sm font-semibold disabled:opacity-50">Archive record</button> : null}</div>{notice?.id === booking.id ? <p role={notice.error ? 'alert' : 'status'} className={`mt-3 text-sm ${notice.error ? 'text-badge-danger' : 'text-badge-success'}`}>{notice.text}</p> : null}</article>; })}</div></section></div>}
        </div>
      </>}
    </StaffGate>
  </main>;
}
