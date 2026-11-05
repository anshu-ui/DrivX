'use client';

import Image from 'next/image';
import { useCallback, useEffect, useState } from 'react';
import {
  collection,
  doc,
  limit,
  onSnapshot,
  query,
  where,
  type DocumentData,
  type QuerySnapshot,
} from 'firebase/firestore';
import {
  COLLECTIONS,
  DOCUMENT_LABELS,
  SUBCOLLECTIONS,
  formatINR,
  type DocumentType,
  type VerificationStatus,
} from '@drivx/domain';
import {
  callFunction,
  driverDocumentDownloadUrl,
  toEpochMs,
} from '@drivx/firebase-client';
import { firebaseClients } from '../../lib/firebase';
import {
  ConsoleHeader,
  StaffGate,
  describe,
  stamp,
  useReviewerSession,
} from '../../lib/staff-session';

/**
 * Driver verification.
 *
 * This is where an upload stops being `pending_review`, and it is not a direct
 * Firestore write: the decision goes to `setDriverVerification`, which moves the
 * profile, every document named in the decision, the `driverVerified` claim and
 * an audit entry together. A console that wrote the profile itself could leave a
 * driver half-approved, and nothing here would notice.
 *
 * Loading and errors are derived from one view object per panel rather than
 * three flags per panel: a flag set at the start of an effect would re-render
 * the whole page before the read has even been issued, and it can say "loading
 * the new driver" while still showing the previous driver's documents.
 */

/** What the console shows about a driver: name, number, and where they stand. */
type DriverSummary = {
  uid: string;
  fullName: string;
  phoneE164: string;
  email: string | null;
  verificationStatus: VerificationStatus;
  /** Minted on the first approval; null until then. */
  driverId: string | null;
};

type QueueRow = DriverSummary;

type ReviewDocument = {
  id: string;
  label: string;
  status: VerificationStatus;
  numberMasked: string | null;
  uploadedAtMs: number | null;
  /** The reviewer's own earlier note, shown when a driver re-submitted. */
  rejectionNote: string | null;
  previewUrl: string | null;
  /** Why there is no preview, said out loud instead of leaving a blank box. */
  previewError: string | null;
  selected: boolean;
};

type QueueView = { rows: QueueRow[] } | { error: string };

/** One charge on the driver's record, as the console reads it. */
type DueRow = {
  id: string;
  title: string;
  basePaise: number;
  gstPaise: number;
  totalPaise: number;
  status: 'unpaid' | 'paid';
  method: string | null;
  reference: string | null;
  providerPaymentId: string | null;
  providerOrderId: string | null;
};

type DuesView = { rows: DueRow[] } | { error: string };

type DetailView =
  | { uid: string; documents: ReviewDocument[] }
  | { uid: string; error: string };

type Decision = 'approved' | 'rejected';

const STATUS_LABEL: Record<string, string> = {
  approved: 'approved',
  rejected: 'rejected',
  pending_review: 'awaiting review',
  not_started: 'not started',
  expired: 'expired',
  expiring_soon: 'expiring soon',
};

const BADGE: Record<string, string> = {
  pending_review: 'bg-warning-soft text-badge-warning',
  rejected: 'bg-danger-soft text-badge-danger',
  approved: 'bg-success-soft text-badge-success',
  other: 'bg-surface-muted text-badge-neutral',
};

const badgeClass = (status: string) => BADGE[status] ?? BADGE.other;

/**
 * Pulls the few fields this screen shows off a profile document. A profile
 * written before the driver typed a name reads as "No name on file" rather than
 * an empty heading, because the reviewer needs to know the record is thin.
 */
function readDriver(uid: string, data: DocumentData): DriverSummary {
  return {
    uid,
    fullName: typeof data.fullName === 'string' && data.fullName.trim() ? data.fullName : 'No name on file',
    phoneE164: typeof data.phoneE164 === 'string' ? data.phoneE164 : '—',
    email: typeof data.email === 'string' ? data.email : null,
    verificationStatus: (data.verificationStatus as VerificationStatus) ?? 'not_started',
    driverId: typeof data.driverId === 'string' ? data.driverId : null,
  };
}

export default function DriverVerification() {
  const { reviewer, checked } = useReviewerSession();

  const [queueView, setQueueView] = useState<QueueView | null>(null);
  const [allDrivers, setAllDrivers] = useState<DriverSummary[] | null>(null);
  const [allDriversError, setAllDriversError] = useState<string | null>(null);
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [detailView, setDetailView] = useState<DetailView | null>(null);
  const [driverInfo, setDriver] = useState<DriverSummary | null>(null);

  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const [duesView, setDuesView] = useState<DuesView | null>(null);
  const [feeMethod, setFeeMethod] = useState<'cash' | 'upi'>('cash');
  const [feeReference, setFeeReference] = useState('');
  const [feeBusy, setFeeBusy] = useState(false);
  const [feeMessage, setFeeMessage] = useState<string | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  /**
   * The queue is every profile the *server* has marked `pending_review`, nothing
   * more: a driver cannot write that column (the rules hold it for the reviewer),
   * and `flagDriverOnFirstUpload` is what sets it the moment a document is filed.
   *
   * Querying the documents directly looked like the obvious version of this and
   * does not work. A collection-group read is a `list` over a path the rules only
   * name inside `driverProfiles/{userId}/documents/{documentId}`, so the emulator
   * falls through to the catch-all and answers `false for 'list'` for the entire
   * query — with no way for the console to tell that apart from an empty queue.
   */
  useEffect(() => {
    if (!reviewer?.admin) return;
    return onSnapshot(
      query(
        collection(firebaseClients().firestore, COLLECTIONS.driverProfiles),
        where('verificationStatus', '==', 'pending_review'),
      ),
      (snap) => {
        // Legacy auto-queued profiles without this server stamp have not tapped
        // Submit now. Keep them off the review queue until explicit submission.
        const rows = snap.docs
          .filter((snapDoc) => snapDoc.data().applicationSubmittedAtMs != null)
          .map((snapDoc) => readDriver(snapDoc.id, snapDoc.data()));
        rows.sort((a, b) => a.fullName.localeCompare(b.fullName));
        setQueueView({ rows });
        // Only claim the first row when nothing is open yet, so a driver being
        // reviewed is not swapped out from under the reviewer.
        setSelectedUid((current) => current ?? rows[0]?.uid ?? null);
      },
      (error) => setQueueView({ error: describe(error) }),
    );
  }, [reviewer]);

  useEffect(() => {
    if (!reviewer?.admin) return;
    return onSnapshot(query(collection(firebaseClients().firestore, COLLECTIONS.driverProfiles), limit(100)), (snap) => {
      const rows = snap.docs.map((row) => readDriver(row.id, row.data())).sort((a, b) => a.fullName.localeCompare(b.fullName));
      setAllDrivers(rows);
      setAllDriversError(null);
    }, (error) => setAllDriversError(describe(error)));
  }, [reviewer]);

  /**
   * Resolve the file behind each pointer before the panel is drawn: a reviewer
   * deciding on a licence has to see the licence, and a row whose image cannot
   * be opened has to say why rather than show a blank.
   */
  const buildDetail = useCallback(async (uid: string, filed: QuerySnapshot<DocumentData>) => {
    const clients = firebaseClients();
    const documents: ReviewDocument[] = [];
    for (const snap of filed.docs) {
      const docData = snap.data();
      const type = (docData.type ?? snap.id) as DocumentType;
      const storagePath = typeof docData.storagePath === 'string' ? docData.storagePath : null;
      let previewUrl: string | null = null;
      let previewError: string | null = null;
      if (storagePath) {
        try {
          previewUrl = await driverDocumentDownloadUrl(clients, { uid, documentId: snap.id });
        } catch (error) {
          // A seeded pointer has no bytes behind it. Say so, rather than show
          // an empty frame the reviewer reads as a failed upload.
          previewError = `No file could be opened at ${storagePath} (${describe(error)})`;
        }
      } else {
        previewError = 'This record has no file attached to it.';
      }
      documents.push({
        id: snap.id,
        label: DOCUMENT_LABELS[type] ?? String(type),
        status: (docData.status as VerificationStatus) ?? 'not_started',
        numberMasked: (docData.numberMasked as string | null) ?? null,
        uploadedAtMs: toEpochMs(docData.uploadedAtMs),
        rejectionNote: (docData.rejectionNote as string | null) ?? null,
        previewUrl,
        previewError,
        // Only a document that is actually waiting can join a decision.
        selected: docData.status === 'pending_review',
      });
    }
    documents.sort((a, b) => a.label.localeCompare(b.label));
    setDetailView({ uid, documents });
  }, []);

  useEffect(() => {
    if (!selectedUid) return;
    const db = firebaseClients().firestore;
    const stopProfile = onSnapshot(
      doc(db, COLLECTIONS.driverProfiles, selectedUid),
      (snap) =>
        setDriver(snap.exists() ? readDriver(selectedUid, snap.data()) : null),
      (error) => setDetailView({ uid: selectedUid, error: describe(error) }),
    );
    const stopDocuments = onSnapshot(
      collection(db, COLLECTIONS.driverProfiles, selectedUid, SUBCOLLECTIONS.driverDocuments),
      (snap) => void buildDetail(selectedUid, snap),
      (error) => setDetailView({ uid: selectedUid, error: describe(error) }),
    );
    // The bill is read live for the same reason the documents are: a fee the
    // office records at the counter has to unlock Approve without a reload.
    const stopDues = onSnapshot(
      collection(db, COLLECTIONS.driverProfiles, selectedUid, SUBCOLLECTIONS.driverDues),
      (snap) =>
        setDuesView({
          rows: snap.docs.map((row) => {
            const data = row.data();
            return {
              id: row.id,
              title: typeof data.title === 'string' ? data.title : 'Amount due',
              basePaise: Number(data.basePaise ?? 0),
              gstPaise: Number(data.gstPaise ?? 0),
              totalPaise: Number(data.totalPaise ?? 0),
              status: data.status === 'paid' ? ('paid' as const) : ('unpaid' as const),
              method: typeof data.method === 'string' ? data.method : null,
              reference: typeof data.reference === 'string' ? data.reference : null,
              providerPaymentId: typeof data.providerPaymentId === 'string' ? data.providerPaymentId : null,
              providerOrderId: typeof data.providerOrderId === 'string' ? data.providerOrderId : null,
            };
          }),
        }),
      (error) => setDuesView({ error: describe(error) }),
    );
    return () => {
      stopProfile();
      stopDocuments();
      stopDues();
    };
  }, [selectedUid, buildDetail]);

  const rows = queueView && 'rows' in queueView ? queueView.rows : null;
  const queueError = queueView && 'error' in queueView ? queueView.error : null;

  const detail = detailView && detailView.uid === selectedUid ? detailView : null;
  const detailLoading = selectedUid !== null && detail === null;
  const detailError = detail && 'error' in detail ? detail.error : null;
  const documents = detail && 'documents' in detail ? detail.documents : [];
  const driver = driverInfo && driverInfo.uid === selectedUid ? driverInfo : null;

  const chosen = documents.filter((document) => document.selected && document.status === 'pending_review');

  const dues = duesView && 'rows' in duesView ? duesView.rows : null;
  const duesError = duesView && 'error' in duesView ? duesView.error : null;
  const unpaid = (dues ?? []).filter((row) => row.status === 'unpaid');
  const outstandingPaise = unpaid.reduce((sum, row) => sum + row.totalPaise, 0);
  /**
   * This page only ever touches the one-time fee. A commission row belongs to a
   * completed trip and is cleared on `/dues`, where the office can see the whole
   * ledger at once; picking "the first unpaid row" here would have quietly
   * recorded a trip payment under a driver's onboarding paperwork.
   */
  const onboardingFee = (dues ?? []).find((row) => row.id === 'onboarding_fee') ?? null;

  async function recordFee() {
    if (!selectedUid || !onboardingFee || onboardingFee.status !== 'unpaid') return;
    setFeeBusy(true);
    setFeeMessage(null);
    try {
      const result = await callFunction<
        { driverUid: string; dueId: string; method: 'cash' | 'upi'; reference: string },
        { totalPaise: number; outstandingDues: number; auditLogId: string }
      >(firebaseClients(), 'recordDriverDuePayment', {
        driverUid: selectedUid,
        dueId: onboardingFee.id,
        method: feeMethod,
        reference: feeReference.trim(),
      });
      setFeeMessage(
        `${formatINR(result.totalPaise)} recorded as collected. ${
          result.outstandingDues === 0
            ? 'Nothing else is owed — Approve is unlocked.'
            : `${result.outstandingDues} charge(s) still outstanding — clear them on Clear dues.`
        } Audit entry ${result.auditLogId}.`,
      );
      // Clear the form: the next collection is a separate payment with its own
      // reference, and a pre-filled box gets copied.
      setFeeReference('');
    } catch (error) {
      setFeeMessage(describe(error));
    } finally {
      setFeeBusy(false);
    }
  }

  async function record(decision: Decision) {
    if (!selectedUid) return;
    setBusy(true);
    setDecisionError(null);
    setOutcome(null);
    try {
      const result = await callFunction<
        { driverUid: string; decision: Decision; reason: string; documentIds: string[] },
        { verificationStatus: string; reviewedDocuments: number; driverId: string | null; auditLogId: string }
      >(firebaseClients(), 'setDriverVerification', {
        driverUid: selectedUid,
        decision,
        reason: reason.trim(),
        documentIds: chosen.map((document) => document.id),
      });
      setOutcome(
        `${decision === 'approved' ? 'Approved' : 'Rejected'} — ${result.reviewedDocuments} document${
          result.reviewedDocuments === 1 ? '' : 's'
        }${decision === 'rejected' ? ', driver set offline' : ''}. ${
          decision === 'approved' ? `Driver id ${result.driverId}.` : ''
        } Audit entry ${result.auditLogId}.`,
      );
      setReason('');
      // Both panels are listeners, so the new statuses and the shrinking queue
      // arrive by themselves.
    } catch (error) {
      setDecisionError(describe(error));
    } finally {
      setBusy(false);
    }
  }

  async function resetOnboarding() {
    if (!selectedUid) return;
    const note = window.prompt('Why are you resetting this driver onboarding? Their uploaded documents will be removed. Paid fee and trip ledger history stay intact.');
    if (!note || note.trim().length < 8) {
      setResetMessage('Reset cancelled. Enter a reason of at least 8 characters to continue.');
      return;
    }
    setResetBusy(true);
    setResetMessage(null);
    try {
      const result = await callFunction<{ driverUid: string; reason: string }, { documentsRemoved: number; paidOnboardingFeePreserved: boolean }>(firebaseClients(), 'resetDriverOnboarding', { driverUid: selectedUid, reason: note.trim() });
      setResetMessage(`Onboarding reset. ${result.documentsRemoved} uploaded document(s) removed; ${result.paidOnboardingFeePreserved ? 'the verified fee payment remains on the ledger.' : 'the unpaid fee remains available to collect.'}`);
    } catch (error) {
      setResetMessage(describe(error));
    } finally {
      setResetBusy(false);
    }
  }

  return (
    <main className="flex-1">
      <StaffGate
        checked={checked}
        reviewer={reviewer}
        claim="admin"
        signInHeading="Staff sign-in"
        signInBlurb="Only an account carrying the administrator claim can review drivers. That claim is read from the signed-in token, never typed in here."
      >
          {() => (
          <>
          <ConsoleHeader
            title="Driver verification"
            blurb="Nothing unlocks a driver app except a decision recorded here."
            reviewer={reviewer}
            links={[{ href: '/', label: 'Overview' }, { href: '/bookings', label: 'Bookings & dispatch' }, { href: '/verification', label: 'Driver reviews' }, { href: '/dues', label: 'Earnings & dues' }, { href: '/pricing', label: 'Fare settings' }]}
          />
          <div className="console-content mx-auto w-full max-w-6xl px-6 py-8">
          <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
            <aside className="rounded-card border border-line bg-surface shadow-card">
              <div className="flex items-center justify-between border-b border-line px-5 py-4">
                <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-ink-muted">
                  Awaiting review
                </h2>
                <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-faint">
                  <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
                  Live
                </span>
              </div>

              {queueError ? (
                <p className="m-5 rounded-control bg-danger-soft px-3 py-2 text-sm text-badge-danger">
                  {queueError}
                </p>
              ) : null}

              {rows === null && !queueError ? <p className="m-5 text-sm text-ink-muted">Loading…</p> : null}

              {rows !== null && rows.length === 0 ? (
                <p className="m-5 text-sm text-ink-muted">
                  Nobody is waiting. A driver appears here after filing documents; the one-time fee must also be paid before approval can activate the account.
                </p>
              ) : null}

              <ul>
                {rows?.map((row) => (
                  <li key={row.uid}>
                    <button
                      type="button"
                      onClick={() => setSelectedUid(row.uid)}
                      aria-current={row.uid === selectedUid}
                      className={`w-full border-b border-line px-5 py-4 text-left transition hover:bg-surface-muted ${
                        row.uid === selectedUid ? 'bg-accent-soft' : ''
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-medium">{row.fullName}</span>
                        <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-badge-warning">
                          new
                        </span>
                      </span>
                      <span className="mt-1 block font-mono text-xs text-ink-muted">{row.phoneE164}</span>
                      <span className="mt-1 block font-mono text-[11px] text-ink-faint">{row.uid}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="border-t border-line px-5 py-4">
                <h3 className="text-sm font-semibold">All driver accounts · first 100</h3>
                {allDriversError ? <p className="mt-2 text-xs text-badge-danger">{allDriversError}</p> : null}
                {!allDrivers && !allDriversError ? <p className="mt-2 text-xs text-ink-muted">Loading accounts…</p> : null}
                <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto">
                  {allDrivers?.map((row) => <li key={`all-${row.uid}`}>
                    <button type="button" onClick={() => setSelectedUid(row.uid)} aria-current={row.uid === selectedUid} className={`w-full rounded-control px-3 py-2 text-left text-sm hover:bg-surface-muted ${row.uid === selectedUid ? 'bg-accent-soft' : ''}`}>
                      <span className="flex justify-between gap-2"><span className="truncate font-medium">{row.fullName}</span><span className="shrink-0 text-xs text-ink-muted">{STATUS_LABEL[row.verificationStatus] ?? row.verificationStatus}</span></span>
                      <span className="mt-0.5 block font-mono text-xs text-ink-faint">{row.phoneE164}</span>
                    </button>
                  </li>)}
                </ul>
              </div>
            </aside>

            <section>
              {!selectedUid ? (
                <p className="text-sm text-ink-muted">Pick a driver on the left.</p>
              ) : (
                <div className="rounded-card border border-line bg-surface p-6 shadow-card">
                  {detailLoading ? (
                    <p className="text-sm text-ink-muted">Loading their paperwork…</p>
                  ) : detailError ? (
                    <p className="rounded-control bg-danger-soft px-3 py-2 text-sm text-badge-danger">
                      {detailError}
                    </p>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                          <h2 className="text-lg font-semibold">{driver?.fullName ?? 'Driver'}</h2>
                          <p className="mt-1 font-mono text-sm text-ink-muted">{driver?.phoneE164 ?? '—'}</p>
                          {driver?.email ? <p className="mt-1 text-sm text-ink-muted">{driver.email}</p> : null}
                          <p className="mt-1 text-xs text-ink-faint">
                            Profile status:{' '}
                            {STATUS_LABEL[driver?.verificationStatus ?? ''] ??
                              driver?.verificationStatus ??
                              'unknown'}
                            {driver?.driverId ? ` · driver id ${driver.driverId}` : ' · no driver id yet'}
                          </p>
                        </div>
                        <p className="max-w-xs text-xs text-ink-faint">
                          Numbers are kept as their last four characters only. The full number is
                          whatever the image below shows.
                        </p>
                      </div>
                      {driver ? <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
                        <button type="button" disabled={resetBusy} onClick={() => void resetOnboarding()} className="rounded-control border border-danger px-4 py-2 text-sm font-semibold text-badge-danger hover:bg-danger-soft disabled:opacity-50">{resetBusy ? 'Resetting…' : 'Reset onboarding'}</button>
                        <p className="max-w-2xl text-xs text-ink-muted">Keeps the same phone login and payment/trip ledger; removes uploaded identity documents and returns the profile to onboarding.</p>
                        {resetMessage ? <p role="status" className="w-full text-sm text-ink-muted">{resetMessage}</p> : null}
                      </div> : null}

                      <ul className="mt-6 space-y-4">
                        {documents.length === 0 ? (
                          <li className="text-sm text-ink-muted">
                            This profile has no documents on it, so there is nothing to approve. The
                            driver uploads them from the Documents tab of their app.
                          </li>
                        ) : null}
                        {documents.map((document) => (
                          <li
                            key={document.id}
                            className="grid gap-4 rounded-card border border-line bg-surface-muted p-4 sm:grid-cols-[16rem_1fr]"
                          >
                            <div className="overflow-hidden rounded-control border border-line bg-surface">
                              {document.previewUrl ? (
                                <a href={document.previewUrl} target="_blank" rel="noreferrer">
                                  <Image
                                    src={document.previewUrl}
                                    alt={`${document.label} uploaded by ${driver?.fullName ?? 'the driver'}`}
                                    width={640}
                                    height={420}
                                    unoptimized
                                    className="h-40 w-full object-contain"
                                  />
                                </a>
                              ) : (
                                <p className="flex h-40 items-center justify-center px-3 text-center text-xs text-ink-faint">
                                  {document.previewError}
                                </p>
                              )}
                            </div>
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="font-medium">{document.label}</p>
                                <span
                                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${badgeClass(
                                    document.status,
                                  )}`}
                                >
                                  {STATUS_LABEL[document.status] ?? document.status}
                                </span>
                              </div>
                              <p className="mt-1 text-sm text-ink-muted">
                                {document.numberMasked ?? 'No number recorded'} · filed{' '}
                                {stamp(document.uploadedAtMs)}
                              </p>
                              {document.rejectionNote ? (
                                <p className="mt-2 rounded-control bg-surface px-3 py-2 text-sm text-ink-muted">
                                  Earlier note: {document.rejectionNote}
                                </p>
                              ) : null}
                              {document.status === 'pending_review' ? (
                                <label className="mt-3 flex items-center gap-2 text-sm">
                                  <input
                                    type="checkbox"
                                    checked={document.selected}
                                    onChange={(event) =>
                                      setDetailView((current) =>
                                        current && 'documents' in current
                                          ? {
                                              ...current,
                                              documents: current.documents.map((row) =>
                                                row.id === document.id
                                                  ? { ...row, selected: event.target.checked }
                                                  : row,
                                              ),
                                            }
                                          : current,
                                      )
                                    }
                                    className="h-4 w-4 accent-[var(--dx-primary)]"
                                  />
                                  Include this document in the decision
                                </label>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ul>

                      {duesError ? (
                        <p className="mt-6 rounded-control bg-danger-soft px-3 py-2 text-sm text-badge-danger">
                          Could not read this driver&rsquo;s dues: {duesError}
                        </p>
                      ) : null}

                      {onboardingFee ? (
                        <div className="mt-6 rounded-card border border-line bg-surface-muted p-4">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="font-medium">{onboardingFee.title}</p>
                            <span
                              className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                                onboardingFee.status === 'paid'
                                  ? 'bg-success-soft text-badge-success'
                                  : 'bg-warning-soft text-badge-warning'
                              }`}
                            >
                              {onboardingFee.status === 'paid' ? 'collected' : 'not collected'}
                            </span>
                          </div>

                          <dl className="mt-3 space-y-1 text-sm">
                            <div className="flex justify-between gap-4">
                              <dt className="text-ink-muted">Onboarding fee</dt>
                              <dd className="font-mono">{formatINR(onboardingFee.basePaise)}</dd>
                            </div>
                            <div className="flex justify-between gap-4">
                              <dt className="text-ink-muted">Tax ({Math.round((onboardingFee.gstPaise / Math.max(onboardingFee.basePaise, 1)) * 100)}%)</dt>
                              <dd className="font-mono">{formatINR(onboardingFee.gstPaise)}</dd>
                            </div>
                            <div className="flex justify-between gap-4 border-t border-line pt-1">
                              <dt className="font-semibold">Total</dt>
                              <dd className="font-mono font-semibold">{formatINR(onboardingFee.totalPaise)}</dd>
                            </div>
                          </dl>

                          {onboardingFee.status === 'paid' ? (
                            <div className="mt-3 space-y-1 text-xs text-ink-muted">
                              <p>Paid via {onboardingFee.method ?? 'Cashfree'}{onboardingFee.reference ? ` · ${onboardingFee.reference}` : ''}. Do not collect it twice.</p>
                              {onboardingFee.providerOrderId ? <p>Cashfree order: <span className="font-mono">{onboardingFee.providerOrderId}</span></p> : null}
                              {onboardingFee.providerPaymentId ? <p>Cashfree transaction: <span className="font-mono">{onboardingFee.providerPaymentId}</span></p> : null}
                            </div>
                          ) : (
                            <div className="mt-4 space-y-3">
                              <p className="text-xs text-ink-muted">
                                Use this only if the driver paid cash or UPI at the office. Cashfree payments are verified by the server webhook and appear here automatically.
                              </p>
                              <div className="flex flex-wrap items-end gap-3">
                                <label className="text-sm font-medium">
                                  Taken as
                                  <select
                                    value={feeMethod}
                                    onChange={(event) => setFeeMethod(event.target.value as 'cash' | 'upi')}
                                    className="mt-1 block rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink"
                                  >
                                    <option value="cash">Cash</option>
                                    <option value="upi">UPI</option>
                                  </select>
                                </label>
                                <label className="flex-1 text-sm font-medium">
                                  Receipt or UPI reference
                                  <input
                                    value={feeReference}
                                    onChange={(event) => setFeeReference(event.target.value)}
                                    className="mt-1 w-full min-w-48 rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-line-focus"
                                  />
                                </label>
                                <button
                                  type="button"
                                  disabled={feeBusy || feeReference.trim().length < 3}
                                  onClick={() => void recordFee()}
                                  className="rounded-control bg-accent px-4 py-2.5 text-sm font-semibold text-ink-on-brand hover:bg-accent-pressed disabled:bg-disabled-surface disabled:text-disabled-ink"
                                >
                                  {feeBusy ? 'Recording…' : 'Money collected'}
                                </button>
                              </div>
                              {feeMessage ? (
                                <p className="rounded-control bg-surface px-3 py-2 text-sm text-ink-muted">
                                  {feeMessage}
                                </p>
                              ) : null}
                            </div>
                          )}
                        </div>
                      ) : dues !== null && dues.length === 0 ? (
                        <p className="mt-6 text-sm text-ink-muted">
                          This driver has no charge on their record, so nothing was billed for onboarding. A fee
                          appears as soon as a document is filed.
                        </p>
                      ) : null}

                      {chosen.length > 0 ? (
                        <div className="mt-6 border-t border-line pt-5">
                          <label className="block text-sm font-medium">
                            Reason
                            <span className="ml-2 font-normal text-ink-faint">
                              kept in the audit log, and shown to the driver when you reject
                            </span>
                            <textarea
                              value={reason}
                              onChange={(event) => setReason(event.target.value)}
                              rows={2}
                              className="mt-2 w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-line-focus"
                            />
                          </label>

                          {decisionError ? (
                            <p className="mt-3 rounded-control bg-danger-soft px-3 py-2 text-sm text-badge-danger">
                              {decisionError}
                            </p>
                          ) : null}
                          {outcome ? (
                            <p className="mt-3 rounded-control bg-success-soft px-3 py-2 text-sm text-badge-success">
                              {outcome}
                            </p>
                          ) : null}

                          <div className="mt-4 flex flex-wrap items-center gap-3">
                            <button
                              type="button"
                              disabled={busy || reason.trim().length < 8 || outstandingPaise > 0}
                              onClick={() => void record('approved')}
                              className="rounded-control bg-accent px-5 py-2.5 text-sm font-semibold text-ink-on-brand hover:bg-accent-pressed disabled:bg-disabled-surface disabled:text-disabled-ink"
                            >
                              Approve {chosen.length} document{chosen.length === 1 ? '' : 's'}
                            </button>
                            <button
                              type="button"
                              disabled={busy || reason.trim().length < 8}
                              onClick={() => void record('rejected')}
                              className="rounded-control border border-danger px-5 py-2.5 text-sm font-semibold text-badge-danger hover:bg-danger-soft disabled:opacity-50"
                            >
                              Reject
                            </button>
                            {outstandingPaise > 0 ? (
                              <p className="text-xs text-ink-faint">
                                Approve is held until {formatINR(outstandingPaise)} is recorded as
                                collected. Trip commission is not on this panel — Clear dues lists it
                                row by row. The server refuses the approval either way; this only saves
                                you from finding that out by pressing it.
                              </p>
                            ) : reason.trim().length < 8 ? (
                              <p className="text-xs text-ink-faint">
                                Write at least eight characters — the server refuses a decision with no
                                reason behind it.
                              </p>
                            ) : null}
                          </div>
                        </div>
                      ) : null}

                      {documents.length > 0 && chosen.length === 0 ? (
                        <p className="mt-6 border-t border-line pt-5 text-sm text-ink-muted">
                          Nothing here is waiting on you. Every document on this profile has already
                          been decided; reload to catch a fresh upload.
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
              )}
            </section>
          </div>
          </div>
          </>
          )}
      </StaffGate>
    </main>
  );
}
