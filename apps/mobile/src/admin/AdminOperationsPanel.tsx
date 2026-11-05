import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { collection, doc, getDoc, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { COLLECTIONS, formatINR } from '@drivx/domain';
import { callFunction, toEpochMs } from '@drivx/firebase-client';
import { firebase } from '../lib/firebase';

type BookingRow = {
  id: string; reference: string; status: string; paymentStatus: string;
  customerUid: string; customerName: string | null; customerPhone: string | null;
  driverUid: string | null; driverName: string | null;
  pickup: string; destination: string; totalPaise: number; commissionPaise: number;
  commissionRate: number | null; commissionStatus: string; createdAtMs: number | null;
  serviceTypeId: string; zoneId: string;
};
type DriverRow = { uid: string; name: string; phone: string; zoneId: string; serviceTypeIds: string[]; verification: string; availability: string };
type PaymentRow = { id: string; bookingId: string; amountPaise: number; status: string; provider: string; providerOrderId: string; providerPaymentId: string; verifiedAtMs: number | null };
type RefundRow = { id: string; bookingId: string; amountPaise: number; status: string; reason: string; providerRefundId: string };

const ink = '#14243A';
const muted = '#66758B';
const blue = '#155EEF';
const border = '#E3EAF2';
const surface = '#F4F7FB';

function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return <View style={{ backgroundColor: 'white', borderWidth: 1, borderColor: border, borderRadius: 19, padding: 18, gap: 12 }}><Text style={{ color: ink, fontSize: 18, fontWeight: '900' }}>{title}</Text>{subtitle ? <Text style={{ color: muted }}>{subtitle}</Text> : null}{children}</View>;
}

function AdminAction({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  return <TouchableOpacity disabled={disabled} onPress={onPress} style={{ borderRadius: 11, backgroundColor: disabled ? '#98A6B8' : blue, paddingHorizontal: 13, paddingVertical: 11 }}><Text style={{ color: 'white', fontWeight: '800' }}>{title}</Text></TouchableOpacity>;
}

function text(value: unknown, fallback = '—') { return typeof value === 'string' && value.length ? value : fallback; }
function amount(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
function address(value: unknown) {
  if (!value || typeof value !== 'object') return 'Address not available';
  const p = value as { label?: unknown; addressLine1?: unknown; city?: unknown };
  return [p.label ?? p.addressLine1, p.city].filter((v): v is string => typeof v === 'string' && v.length > 0).join(', ') || 'Address not available';
}

export function AdminOperationsPanel({ onError }: { onError: (message: string) => void }) {
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [refunds, setRefunds] = useState<RefundRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [section, setSection] = useState<'money' | 'bookings' | 'payments' | 'refunds' | 'drivers'>('bookings');

  useEffect(() => {
    const db = firebase().firestore;
    let pending = 4;
    // Cache the supplemental profile/ledger reads for this live session. A
    // single new booking used to cause up to 80 historical reads to run again.
    const customerCache = new Map<string, { name: string | null; phone: string | null } | null>();
    const commissionCache = new Map<string, string>();
    const ready = () => { pending -= 1; if (pending <= 0) setLoading(false); };
    const stops = [
      onSnapshot(query(collection(db, COLLECTIONS.bookings), orderBy('createdAtMs', 'desc'), limit(40)), (snap) => {
        const changed = snap.docChanges().filter((change) => change.type !== 'removed');
        const rows = snap.docs.map((row) => {
          const data = row.data();
          const fare = (data.finalFare ?? data.runningFare ?? data.estimate ?? {}) as Record<string, unknown>;
          const commission = (data.commission ?? {}) as Record<string, unknown>;
          const driver = (data.driver ?? {}) as Record<string, unknown>;
          return {
            id: row.id, reference: text(data.reference, row.id), status: text(data.status, 'unknown'),
            paymentStatus: text(data.paymentStatus, 'unknown'), customerUid: text(data.customerUid),
            customerName: typeof data.customer?.fullName === 'string' ? data.customer.fullName : null,
            customerPhone: typeof data.customer?.phoneE164 === 'string' ? data.customer.phoneE164 : null,
            driverUid: typeof data.assignedDriverUid === 'string' ? data.assignedDriverUid : null,
            driverName: typeof driver.fullName === 'string' ? driver.fullName : null,
            pickup: address(data.pickup), destination: address(data.destination), totalPaise: amount(fare.totalPaise),
            commissionPaise: amount(commission.totalPaise), commissionRate: typeof commission.rate === 'number' ? commission.rate : null,
            commissionStatus: commissionCache.get(row.id) ?? 'loading', createdAtMs: toEpochMs(data.createdAtMs),
            serviceTypeId: text(data.serviceTypeId, ''), zoneId: text(data.zoneId, ''),
          } satisfies BookingRow;
        });
        setBookings(rows); ready();
        const missingProfiles = [...new Set(changed.map((change) => text(change.doc.data().customerUid)).filter((uid) => uid && !customerCache.has(uid)))];
        void Promise.all(missingProfiles.map(async (uid) => {
          try {
            const customer = await getDoc(doc(db, COLLECTIONS.customerProfiles, uid));
            const data = customer.data();
            return [uid, customer.exists() ? {
              name: typeof data?.fullName === 'string' ? data.fullName : null,
              phone: typeof data?.contactPhoneE164 === 'string' ? data.contactPhoneE164 : null,
            } : null] as const;
          } catch { return [uid, null] as const; }
        })).then((profiles) => {
          profiles.forEach(([uid, profile]) => customerCache.set(uid, profile));
          setBookings((current) => current.map((row) => {
            const profile = customerCache.get(row.customerUid);
            return profile ? { ...row, customerName: row.customerName ?? profile.name, customerPhone: row.customerPhone ?? profile.phone } : row;
          }));
        });
        const changedIds = new Set(changed.map((change) => change.doc.id));
        void Promise.all(rows.filter((row) => changedIds.has(row.id)).map(async (row) => {
          if (!row.driverUid || row.commissionPaise <= 0) return [row.id, 'no commission recorded'] as const;
          try {
            const due = await getDoc(doc(db, COLLECTIONS.driverProfiles, row.driverUid, 'dues', `commission_${row.id}`));
            return [row.id, due.exists() ? text(due.data().status, 'unknown') : 'not raised'] as const;
          } catch { return [row.id, 'unavailable'] as const; }
        })).then((states) => {
          const statusById = new Map(states);
          statusById.forEach((status, id) => commissionCache.set(id, status));
          setBookings((current) => current.map((row) => ({ ...row, commissionStatus: statusById.get(row.id) ?? row.commissionStatus })));
        });
      }, (error) => { onError(error.message); setLoading(false); }),
      onSnapshot(query(collection(db, COLLECTIONS.driverProfiles), orderBy('updatedAtMs', 'desc'), limit(100)), (snap) => {
        setDrivers(snap.docs.map((row) => {
          const data = row.data();
          return { uid: row.id, name: text(data.fullName, 'Driver'), phone: text(data.phoneE164 ?? data.phoneNumber), zoneId: text(data.zoneId, ''), serviceTypeIds: Array.isArray(data.serviceTypeIds) ? data.serviceTypeIds.filter((id): id is string => typeof id === 'string') : [], verification: text(data.verificationStatus, 'unknown'), availability: text(data.availabilityState, 'offline') };
        })); ready();
      }, (error) => { onError(error.message); setLoading(false); }),
      onSnapshot(query(collection(db, COLLECTIONS.payments), orderBy('updatedAtMs', 'desc'), limit(40)), (snap) => {
        setPayments(snap.docs.map((row) => { const data = row.data(); return { id: row.id, bookingId: text(data.bookingId), amountPaise: amount(data.amountPaise), status: text(data.status, 'unknown'), provider: text(data.provider), providerOrderId: text(data.providerOrderId), providerPaymentId: text(data.providerPaymentId), verifiedAtMs: toEpochMs(data.verifiedAtMs) }; })); ready();
      }, (error) => { onError(error.message); setLoading(false); }),
      onSnapshot(query(collection(db, COLLECTIONS.refunds), orderBy('createdAtMs', 'desc'), limit(40)), (snap) => {
        setRefunds(snap.docs.map((row) => { const data = row.data(); return { id: row.id, bookingId: text(data.bookingId), amountPaise: amount(data.amountPaise), status: text(data.status, 'unknown'), reason: text(data.reason), providerRefundId: text(data.providerRefundId) }; })); ready();
      }, (error) => { onError(error.message); setLoading(false); }),
    ];
    return () => stops.forEach((stop) => stop());
  }, [onError]);

  async function assign(row: BookingRow) {
    const driverUid = selected[row.id];
    if (!driverUid) return;
    setBusy(row.id); onError('');
    try {
      await callFunction(firebase(), 'manualAssign', { bookingId: row.id, driverUid, reason: 'Admin selected an eligible online driver for this booking.' });
    } catch (error) { onError(error instanceof Error ? error.message : 'Could not assign this driver.'); }
    finally { setBusy(null); }
  }

  const paidPayments = payments.filter((p) => p.status === 'succeeded' || p.status === 'paid');
  const paidPaise = paidPayments.reduce((sum, p) => sum + p.amountPaise, 0);
  const commissionTotal = bookings.reduce((sum, b) => sum + b.commissionPaise, 0);
  const collectedCommission = bookings.filter((b) => b.commissionStatus === 'paid').reduce((sum, b) => sum + b.commissionPaise, 0);

  if (loading && bookings.length === 0) return <View style={{ backgroundColor: 'white', borderRadius: 18, padding: 22, alignItems: 'center' }}><ActivityIndicator color={blue} /><Text style={{ color: muted, marginTop: 10 }}>Loading live operations…</Text></View>;

  const sections = [
    { id: 'bookings', label: 'Bookings', count: bookings.length },
    { id: 'drivers', label: 'Drivers', count: drivers.length },
    { id: 'payments', label: 'Payments', count: payments.length },
    { id: 'refunds', label: 'Refunds', count: refunds.length },
    { id: 'money', label: 'Money', count: null },
  ] as const;

  return <>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 4, borderRadius: 16, backgroundColor: 'white', borderWidth: 1, borderColor: border }}>
      {sections.map((item) => <TouchableOpacity key={item.id} accessibilityRole="tab" accessibilityState={{ selected: section === item.id }} onPress={() => setSection(item.id)} style={{ minHeight: 42, justifyContent: 'center', borderRadius: 12, backgroundColor: section === item.id ? '#E9F0FF' : 'white', paddingHorizontal: 13 }}><Text style={{ color: section === item.id ? blue : muted, fontWeight: '800' }}>{item.label}{item.count === null ? '' : ` · ${item.count}`}</Text></TouchableOpacity>)}
    </View>
    {section === 'money' ? <Panel title="Money & platform take" subtitle="Recent 40 bookings/payments only; figures come from server records, not client estimates.">
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <View style={{ flex: 1, minWidth: 140, borderRadius: 14, padding: 13, backgroundColor: surface }}><Text style={{ color: muted }}>Verified customer collections</Text><Text style={{ color: ink, fontSize: 20, fontWeight: '900', marginTop: 6 }}>{formatINR(paidPaise)}</Text></View>
        <View style={{ flex: 1, minWidth: 140, borderRadius: 14, padding: 13, backgroundColor: surface }}><Text style={{ color: muted }}>Commission on recent trips</Text><Text style={{ color: ink, fontSize: 20, fontWeight: '900', marginTop: 6 }}>{formatINR(commissionTotal)}</Text><Text style={{ color: muted, marginTop: 4 }}>Recorded as collected: {formatINR(collectedCommission)}</Text></View>
      </View>
    </Panel> : null}

    {section === 'bookings' ? <Panel title="Bookings · live ledger" subtitle="Status, customer, assigned driver, fare and commission collected state.">
      {bookings.length ? bookings.slice(0, 20).map((row) => {
        const eligible = drivers.filter((driver) => driver.verification === 'approved' && driver.availability === 'online' && driver.zoneId === row.zoneId && driver.serviceTypeIds.includes(row.serviceTypeId));
        const canAssign = !row.driverUid && ['requested', 'searching_driver'].includes(row.status);
        return <View key={row.id} style={{ borderTopWidth: 1, borderTopColor: border, paddingTop: 12, gap: 6 }}>
          <Text style={{ color: ink, fontWeight: '900' }}>{row.reference} · {row.status.replaceAll('_', ' ')}</Text>
          <Text style={{ color: muted }}>{row.pickup} → {row.destination}</Text>
          <Text style={{ color: muted }}>Customer: {row.customerName ?? row.customerUid}{row.customerPhone ? ` · ${row.customerPhone}` : ''} · Driver: {row.driverName ?? row.driverUid ?? 'Not assigned'}</Text>
          <Text style={{ color: muted }}>Payment: {row.paymentStatus} · Fare: {formatINR(row.totalPaise)} · Commission: {formatINR(row.commissionPaise)} {row.commissionRate === null ? '' : `(${Math.round(row.commissionRate * 100)}%)`} · driver paid commission: {row.commissionStatus}</Text>
          {canAssign ? <View style={{ gap: 7 }}><Text style={{ color: muted, fontWeight: '700' }}>Choose a verified, online driver. Server also checks service area, unpaid dues and trip conflicts.</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>{eligible.length ? eligible.map((driver) => <TouchableOpacity key={driver.uid} onPress={() => setSelected((current) => ({ ...current, [row.id]: driver.uid }))} style={{ borderWidth: 1, borderColor: selected[row.id] === driver.uid ? blue : border, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 7, backgroundColor: selected[row.id] === driver.uid ? '#E9F0FF' : 'white' }}><Text style={{ color: ink, fontSize: 12, fontWeight: '700' }}>{driver.name} · {driver.phone}</Text></TouchableOpacity>) : <Text style={{ color: muted }}>No matching verified, online drivers loaded.</Text>}</View><AdminAction title={busy === row.id ? 'Assigning…' : 'Send assignment offer'} disabled={!selected[row.id] || !!busy} onPress={() => void assign(row)} /></View> : null}
        </View>;
      }) : <Text style={{ color: muted }}>No booking records yet.</Text>}
    </Panel> : null}

    {section === 'payments' ? <Panel title="Payment reconciliation" subtitle="Provider order/payment references and verified state. A frontend return never means paid.">
      {payments.length ? payments.slice(0, 20).map((row) => <View key={row.id} style={{ borderTopWidth: 1, borderTopColor: border, paddingTop: 10, gap: 4 }}><Text style={{ color: ink, fontWeight: '800' }}>{formatINR(row.amountPaise)} · {row.status}</Text><Text style={{ color: muted }}>Booking {row.bookingId} · {row.provider} · order {row.providerOrderId}</Text><Text style={{ color: muted }}>Gateway payment {row.providerPaymentId} · webhook verified {row.verifiedAtMs ? new Date(row.verifiedAtMs).toLocaleString() : 'not verified'}</Text></View>) : <Text style={{ color: muted }}>No payment records yet.</Text>}
    </Panel> : null}

    {section === 'refunds' ? <Panel title="Refunds" subtitle="Requested and provider-confirmed refund states are distinct.">
      {refunds.length ? refunds.slice(0, 20).map((row) => <View key={row.id} style={{ borderTopWidth: 1, borderTopColor: border, paddingTop: 10, gap: 4 }}><Text style={{ color: ink, fontWeight: '800' }}>{formatINR(row.amountPaise)} · {row.status}</Text><Text style={{ color: muted }}>Booking {row.bookingId} · {row.reason} · provider refund {row.providerRefundId}</Text></View>) : <Text style={{ color: muted }}>No refund records yet.</Text>}
    </Panel> : null}

    {section === 'drivers' ? <Panel title="Online drivers" subtitle="Presence is live; personal contact details remain limited to authorized admin use.">
      {drivers.filter((driver) => driver.verification === 'approved').length ? drivers.filter((driver) => driver.verification === 'approved').slice(0, 25).map((driver) => <View key={driver.uid} style={{ borderTopWidth: 1, borderTopColor: border, paddingTop: 9 }}><Text style={{ color: ink, fontWeight: '800' }}>{driver.name} · {driver.phone}</Text><Text style={{ color: muted }}>Online list · {driver.zoneId} · {driver.uid}</Text></View>) : <Text style={{ color: muted }}>No approved drivers in the current driver-profile snapshot.</Text>}
    </Panel> : null}
  </>;
}
