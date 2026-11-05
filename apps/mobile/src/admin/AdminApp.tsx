import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { collection, getDocs, onSnapshot, query, where } from 'firebase/firestore';
import { COLLECTIONS, DOCUMENT_LABELS, formatINR, type DocumentType } from '@drivx/domain';
import { driverDocumentDownloadUrl, type DriverDocumentLocation } from '@drivx/firebase-client';
import { callFunction } from '@drivx/firebase-client';
import { drivxAuth, firebase } from '../lib/firebase';
import { AdminOperationsPanel } from './AdminOperationsPanel';
import { PushPermissionGate } from '../components/PushPermissionGate';
import { usePushRegistrationSync } from '../features/customer/pushNotifications';

type Summary = { bookings: number; onlineDrivers: number; reviews: number; queue: Array<{ id: string; status: string; pickup: string; destination: string; amount: number }> };
type Applicant = { uid: string; name: string; phone: string; email: string; docs: Array<{ id: string; type: DocumentType; status: string; path: string }>; due: number; feePaid: boolean };
const ink = '#14243A';
const blue = '#155EEF';

function ActionButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <TouchableOpacity disabled={disabled} onPress={onPress} style={{ backgroundColor: blue, borderRadius: 14, paddingVertical: 15, alignItems: 'center', opacity: disabled ? 0.6 : 1 }}><Text style={{ color: 'white', fontWeight: '800', fontSize: 15 }}>{label}</Text></TouchableOpacity>;
}

function Metric({ label, value, tint }: { label: string; value: number; tint: string }) {
  return <View style={{ flex: 1, minWidth: 140, backgroundColor: 'white', borderWidth: 1, borderColor: '#E3EAF2', borderRadius: 18, padding: 18 }}><Text style={{ color: '#66758B', fontWeight: '600' }}>{label}</Text><Text style={{ color: tint, fontSize: 34, fontWeight: '900', marginTop: 10 }}>{value}</Text></View>;
}

export default function AdminApp() {
  const [user, setUser] = useState<User | null>(null);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState('amit@referralme.in');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [applicants, setApplicants] = useState<Applicant[]>([]);
  const [reviewBusy, setReviewBusy] = useState<string | null>(null);

  usePushRegistrationSync(allowed ? user : null);

  useEffect(() => onAuthStateChanged(firebase().auth, async (next) => {
    setUser(next);
    if (!next) { setAllowed(false); setChecking(false); return; }
    setChecking(true);
    try {
      const token = await next.getIdTokenResult(true);
      const roleAllowed = next.email?.toLowerCase() === 'amit@referralme.in' && token.claims.admin === true;
      setAllowed(roleAllowed);
      if (!roleAllowed) {
        await drivxAuth().signOutUser();
        setError('Only amit@referralme.in with the server-granted admin role can use DrivX Admin.');
      }
    } catch {
      setAllowed(false);
      setError('Could not verify admin access. Check your connection and sign in again.');
    } finally { setChecking(false); }
  }), []);

  useEffect(() => {
    if (!user || !allowed) return;
    const db = firebase().firestore;
    let queue: Summary['queue'] = [];
    let onlineDrivers = 0;
    let reviews = 0;
    let ready = 0;
    const publish = () => {
      ready += 1;
      if (ready >= 3) setSummary({ bookings: queue.length, onlineDrivers, reviews, queue });
    };
    const stops = [
      onSnapshot(query(collection(db, COLLECTIONS.bookings), where('status', 'in', ['requested', 'searching_driver'])), snap => {
        queue = snap.docs.map(row => {
          const data = row.data();
          const place = (v: unknown) => typeof v === 'object' && v !== null && 'label' in v ? String((v as { label?: unknown }).label ?? 'Location unavailable') : 'Location unavailable';
          const fare = (data.finalFare ?? data.runningFare ?? data.estimate) as { totalPaise?: number } | undefined;
          return { id: String(data.reference ?? row.id), status: String(data.status ?? 'requested'), pickup: place(data.pickup), destination: place(data.destination), amount: Number(fare?.totalPaise ?? 0) };
        }); publish();
      }, e => setError(e.message)),
      onSnapshot(query(collection(db, COLLECTIONS.driverProfiles), where('availabilityState', '==', 'online')), snap => { onlineDrivers = snap.size; publish(); }, e => setError(e.message)),
      onSnapshot(query(collection(db, COLLECTIONS.driverProfiles), where('verificationStatus', '==', 'pending_review')), snap => {
        reviews = snap.size; publish();
        void Promise.all(snap.docs.map(async row => {
          const data = row.data();
          const [docSnap, dueSnap] = await Promise.all([
            getDocs(collection(db, COLLECTIONS.driverProfiles, row.id, 'documents')),
            getDocs(collection(db, COLLECTIONS.driverProfiles, row.id, 'dues')),
          ]);
          const docs = docSnap.docs.map(d => ({ id: d.id, type: d.id as DocumentType, status: String(d.data().status ?? ''), path: String(d.data().storagePath ?? '') }));
          const dues = dueSnap.docs.map(d => d.data());
          const fee = dues.find(d => d.kind === 'onboarding_fee');
          return { uid: row.id, name: String(data.fullName ?? 'Driver applicant'), phone: String(data.phoneE164 ?? data.phoneNumber ?? ''), email: String(data.email ?? ''), docs, due: dues.filter(d => d.status !== 'paid').reduce((sum, d) => sum + Number(d.totalPaise ?? 0), 0), feePaid: fee?.status === 'paid' } satisfies Applicant;
        })).then(setApplicants).catch(e => setError(e instanceof Error ? e.message : 'Could not load driver applications.'));
      }, e => setError(e.message)),
    ];
    return () => stops.forEach(stop => stop());
  }, [user, allowed]);

  async function signIn() {
    setBusy(true); setError('');
    try { await drivxAuth().emailPasswordSignIn(email.trim(), password); setPassword(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Sign-in failed.'); }
    finally { setBusy(false); }
  }

  async function reviewDriver(applicant: Applicant, decision: 'approved' | 'rejected') {
    if (decision === 'approved' && (applicant.docs.length < 3 || applicant.docs.some(d => !d.path) || !applicant.feePaid || applicant.due > 0)) return;
    setReviewBusy(applicant.uid); setError('');
    try {
      await callFunction(firebase(), 'setDriverVerification', {
        driverUid: applicant.uid,
        decision,
        reason: decision === 'approved' ? 'Identity documents reviewed and verified.' : 'Please upload clear and valid documents again.',
        documentIds: applicant.docs.map(d => d.id),
      });
    } catch (e) { setError(e instanceof Error ? e.message : 'Driver review could not be saved.'); }
    finally { setReviewBusy(null); }
  }

  async function openDriverDocument(applicant: Applicant, item: Applicant['docs'][number]) {
    try {
      const location: DriverDocumentLocation = { uid: applicant.uid, documentId: item.id };
      const url = await driverDocumentDownloadUrl(firebase(), location);
      await Linking.openURL(url);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not open the driver document.'); }
  }

  if (checking) return <View style={{ flex: 1, backgroundColor: '#F4F7FB', justifyContent: 'center', alignItems: 'center' }}><ActivityIndicator size="large" color={blue} /><Text style={{ marginTop: 12, color: '#66758B' }}>Checking secure admin access…</Text></View>;

  if (!user || !allowed) return <ScrollView contentContainerStyle={{ flexGrow: 1, backgroundColor: '#F4F7FB', justifyContent: 'center', padding: 22 }}><View style={{ width: '100%', maxWidth: 520, alignSelf: 'center', backgroundColor: 'white', borderRadius: 26, padding: 26, borderWidth: 1, borderColor: '#E3EAF2' }}><View style={{ width: 54, height: 54, borderRadius: 18, backgroundColor: '#E9F0FF', alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 25, color: blue, fontWeight: '900' }}>D</Text></View><Text style={{ color: blue, fontWeight: '900', letterSpacing: 2, marginTop: 22 }}>DRIVX · ADMIN</Text><Text style={{ color: ink, fontSize: 30, fontWeight: '900', marginTop: 8 }}>Operations, at a glance.</Text><Text style={{ color: '#66758B', lineHeight: 22, marginTop: 8, marginBottom: 24 }}>Only amit@referralme.in with the administrator role can enter. Customer and driver phone accounts cannot access this app.</Text>{user ? <View style={{ marginBottom: 18, padding: 12, borderRadius: 12, backgroundColor: '#F2F6FC' }}><Text style={{ color: '#52657D' }}>Currently signed in as {user.email ?? user.phoneNumber ?? 'another account'}.</Text><TouchableOpacity onPress={() => void drivxAuth().signOutUser()} style={{ alignSelf: 'flex-start', paddingTop: 10 }}><Text style={{ color: blue, fontWeight: '800' }}>Sign out and switch account</Text></TouchableOpacity></View> : null}<Text style={{ color: ink, fontWeight: '700', marginBottom: 7 }}>Work email</Text><TextInput value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder="amit@referralme.in" style={{ borderWidth: 1, borderColor: '#D8E1EC', borderRadius: 13, padding: 14, marginBottom: 16, color: ink }} /><Text style={{ color: ink, fontWeight: '700', marginBottom: 7 }}>Password</Text><TextInput value={password} onChangeText={setPassword} secureTextEntry placeholder="Enter your password" style={{ borderWidth: 1, borderColor: '#D8E1EC', borderRadius: 13, padding: 14, marginBottom: 18, color: ink }} />{error ? <Text style={{ color: '#B42318', marginBottom: 16 }}>{error}</Text> : null}<ActionButton label={busy ? 'Signing in…' : 'Sign in securely'} disabled={busy || !email.trim() || !password} onPress={() => void signIn()} /></View></ScrollView>;

  return <PushPermissionGate user={user} onSignOut={() => drivxAuth().signOutUser()}><ScrollView style={{ flex: 1, backgroundColor: '#F4F7FB' }} contentContainerStyle={{ padding: 20, paddingTop: 48, gap: 18 }}><View style={{ backgroundColor: '#102E5B', borderRadius: 24, padding: 23 }}><Text style={{ color: '#B7D1FF', fontWeight: '800', letterSpacing: 1.6 }}>DRIVX ADMIN · LIVE</Text><Text style={{ color: 'white', fontSize: 28, fontWeight: '900', marginTop: 12 }}>Good to see you.</Text><Text style={{ color: '#D7E4F8', marginTop: 6 }}>{user.email ?? 'Authorized operations account'}</Text><TouchableOpacity onPress={() => void drivxAuth().signOutUser()} style={{ alignSelf: 'flex-start', borderWidth: 1, borderColor: '#7897C2', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 11, marginTop: 18 }}><Text style={{ color: 'white', fontWeight: '700' }}>Sign out</Text></TouchableOpacity></View>{summary ? <><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}><Metric label="Needs a driver" value={summary.bookings} tint={blue} /><Metric label="Drivers online" value={summary.onlineDrivers} tint={blue} /><Metric label="Driver reviews" value={summary.reviews} tint="#52657D" /></View><View style={{ backgroundColor: 'white', borderRadius: 19, padding: 18, borderWidth: 1, borderColor: '#E3EAF2' }}><Text style={{ fontSize: 18, color: ink, fontWeight: '900' }}>Live dispatch queue</Text><Text style={{ color: '#66758B', marginTop: 4 }}>Bookings currently looking for a driver</Text>{summary.queue.length ? summary.queue.slice(0, 8).map(item => <View key={item.id} style={{ borderTopWidth: 1, borderTopColor: '#EDF1F6', paddingVertical: 14, marginTop: 10 }}><Text style={{ color: ink, fontWeight: '800' }}>{item.id} · {item.status.replaceAll('_', ' ')}</Text><Text style={{ color: '#66758B', marginTop: 5 }}>{item.pickup} → {item.destination}</Text><Text style={{ color: blue, fontWeight: '800', marginTop: 7 }}>{formatINR(item.amount)}</Text></View>) : <Text style={{ color: '#66758B', paddingVertical: 20 }}>No unassigned bookings right now.</Text>}</View><View style={{ backgroundColor: 'white', borderRadius: 19, padding: 18, borderWidth: 1, borderColor: '#E3EAF2', gap: 12 }}><Text style={{ fontSize: 18, color: ink, fontWeight: '900' }}>Driver verification</Text><Text style={{ color: '#66758B' }}>Open each private document, then approve or send the application back.</Text>{applicants.length ? applicants.map(applicant => { const canApprove = applicant.docs.length >= 3 && applicant.docs.every(d => !!d.path) && applicant.feePaid && applicant.due === 0; return <View key={applicant.uid} style={{ borderTopWidth: 1, borderTopColor: '#EDF1F6', paddingTop: 14, gap: 9 }}><Text style={{ color: ink, fontWeight: '900', fontSize: 16 }}>{applicant.name}</Text><Text style={{ color: '#66758B' }}>{applicant.phone} · {applicant.email}</Text>{applicant.docs.map(doc => <TouchableOpacity key={doc.id} onPress={() => void openDriverDocument(applicant, doc)} disabled={!doc.path} style={{ padding: 10, borderRadius: 10, backgroundColor: '#F4F7FB' }}><Text style={{ color: blue, fontWeight: '700' }}>{DOCUMENT_LABELS[doc.type] ?? doc.id} · {doc.status} · {doc.path ? 'Open document' : 'No file'}</Text></TouchableOpacity>)}<Text style={{ color: applicant.feePaid ? blue : '#52657D', fontWeight: '700' }}>{applicant.feePaid ? 'Onboarding fee paid' : `Onboarding fee pending · ${formatINR(applicant.due)}`}</Text><View style={{ flexDirection: 'row', gap: 10 }}><View style={{ flex: 1 }}><ActionButton label={reviewBusy === applicant.uid ? 'Saving…' : 'Approve & activate'} disabled={!canApprove || !!reviewBusy} onPress={() => void reviewDriver(applicant, 'approved')} /></View><View style={{ flex: 1 }}><ActionButton label={reviewBusy === applicant.uid ? 'Saving…' : 'Request re-upload'} disabled={!!reviewBusy || applicant.docs.length === 0} onPress={() => void reviewDriver(applicant, 'rejected')} /></View></View>{!canApprove ? <Text style={{ color: '#66758B', fontSize: 12 }}>Approval unlocks after all three files are uploaded and all dues are paid.</Text> : null}</View>; }) : <Text style={{ color: '#66758B', paddingVertical: 14 }}>No driver applications waiting for review.</Text>}</View><AdminOperationsPanel onError={setError} /></> : <View style={{ backgroundColor: 'white', borderRadius: 18, padding: 22, alignItems: 'center' }}><ActivityIndicator color={blue} /><Text style={{ color: '#66758B', marginTop: 10 }}>Connecting to live operations…</Text></View>}{error ? <Text style={{ color: '#B42318' }}>{error}</Text> : null}</ScrollView></PushPermissionGate>;
}
