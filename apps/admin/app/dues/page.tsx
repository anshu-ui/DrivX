'use client';

import { useEffect, useState } from 'react';
import {
  collection,
  collectionGroup,
  documentId,
  getDocs,
  onSnapshot,
  query,
  where,
  type DocumentData,
} from 'firebase/firestore';
import {
  COLLECTIONS,
  COMMISSION_TERMS,
  SUBCOLLECTIONS,
  formatINR,
  type DriverDueKind,
} from '@drivx/domain';
import { toEpochMs } from '@drivx/firebase-client';
import { firebaseClients } from '../../lib/firebase';
import { ConsoleHeader, StaffGate, describe, stamp, useReviewerSession, type Reviewer } from '../../lib/staff-session';

/**
 * Clear dues.
 *
 * The owner's money page. It reads unpaid charges and the Cashfree-confirmed
 * payment receipts across all drivers. Cashfree is the online settlement source;
 * the due ledger stays owned by Cloud Functions.
 *
 * The list is a collection-group query, which is exactly what the verification
 * screen cannot do for documents. It works here because the rules carry a
 * staff-only `match /{path=**}/dues/{dueId}` — without it, Firestore evaluates a
 * `list` against the catch-all, denies the *whole* query, and the console sees an
 * empty page instead of a permission error. That rule is tested.
 */

type DueRow = {
  dueId: string;
  driverUid: string;
  status: string;
  kind: DriverDueKind;
  title: string;
  bookingId: string | null;
  basePaise: number;
  /** The cut this row was billed at; null on the one-time fee. */
  rate: number | null;
  /** The fare that cut was taken from; null on the one-time fee. */
  commissionablePaise: number | null;
  gstPaise: number;
  gstRate: number;
  totalPaise: number;
  createdAtMs: number | null;
  recordedAtMs: number | null;
  method: string | null;
  reference: string | null;
  settledBy: string | null;
};

type DriverFace = {
  fullName: string;
  phoneE164: string;
  driverId: string | null;
  availabilityState: string | null;
};

type Group = {
  driverUid: string;
  rows: DueRow[];
  totalPaise: number;
  driver: DriverFace | null;
};

type ViewState = { rows: DueRow[] } | { error: string };

const KIND_LABEL: Record<DriverDueKind, string> = {
  onboarding_fee: 'Onboarding fee',
  commission: 'Trip commission',
  late_arrival_penalty: 'Late start penalty',
};

function readDue(snap: { id: string; ref: { path: string }; data: () => DocumentData }): DueRow | null {
  const data = snap.data();
  // driverProfiles/{uid}/dues/{dueId} — the path is the only trustworthy source
  // of the owner, because a seeded row may not carry driverUid at all.
  const segments = snap.ref.path.split('/');
  const driverUid = segments[segments.indexOf(SUBCOLLECTIONS.driverDues) - 1];
  if (!driverUid) return null;
  return {
    dueId: snap.id,
    driverUid,
    status: String(data.status ?? 'unpaid'),
    kind: data.kind === 'commission' || data.kind === 'late_arrival_penalty' ? data.kind : 'onboarding_fee',
    title: typeof data.title === 'string' ? data.title : 'Amount due',
    bookingId: typeof data.bookingId === 'string' ? data.bookingId : null,
    basePaise: Number(data.basePaise ?? 0),
    rate: typeof data.rate === 'number' ? data.rate : null,
    commissionablePaise: typeof data.commissionablePaise === 'number' ? data.commissionablePaise : null,
    gstPaise: Number(data.gstPaise ?? 0),
    gstRate: Number(data.gstRate ?? 0),
    totalPaise: Number(data.totalPaise ?? 0),
    createdAtMs: toEpochMs(data.createdAtMs),
    recordedAtMs: toEpochMs(data.recordedAtMs),
    method: typeof data.method === 'string' ? data.method : null,
    reference: typeof data.reference === 'string' ? data.reference : null,
    settledBy: typeof data.settledBy === 'string' ? data.settledBy : null,
  };
}

/**
 * Names come from a one-shot `documentId in (...)` read per refresh rather than a
 * listener each: the dues snapshot is the thing that has to be live, and it
 * re-fires whenever a collection is recorded, which is when the faces matter.
 * Chunked because Firestore caps an `in` at 30 ids — a page that quietly dropped
 * the 31st driver would be worse than one that never showed a name.
 */
async function resolveDrivers(uids: string[]): Promise<Record<string, DriverFace>> {
  const db = firebaseClients().firestore;
  const faces: Record<string, DriverFace> = {};
  for (let start = 0; start < uids.length; start += 30) {
    const chunk = uids.slice(start, start + 30);
    const snap = await getDocs(
      query(collection(db, COLLECTIONS.driverProfiles), where(documentId(), 'in', chunk)),
    );
    for (const doc of snap.docs) {
      const data = doc.data();
      faces[doc.id] = {
        fullName: typeof data.fullName === 'string' && data.fullName.trim() ? data.fullName : 'No name on file',
        phoneE164: typeof data.phoneE164 === 'string' ? data.phoneE164 : '—',
        driverId: typeof data.driverId === 'string' ? data.driverId : null,
        availabilityState: typeof data.availabilityState === 'string' ? data.availabilityState : null,
      };
    }
  }
  return faces;
}

export default function ClearDues() {
  const { reviewer, checked } = useReviewerSession();

  return (
    <main className="flex-1">
      <StaffGate
        checked={checked}
        reviewer={reviewer}
        claim="staff"
        signInHeading="Staff sign-in"
        signInBlurb="Only an account carrying the administrator or operations claim can read the live due ledger and confirmed payment receipts."
      >
        {(signedIn) => <>
          <ConsoleHeader
            title="Clear dues"
            blurb="Live unpaid driver charges and Cashfree-confirmed payment receipts."
            reviewer={signedIn}
            links={[{ href: '/', label: 'Overview' }, { href: '/bookings', label: 'Bookings & dispatch' }, { href: '/verification', label: 'Driver reviews' }, { href: '/dues', label: 'Earnings & dues' }, { href: '/pricing', label: 'Fare settings' }]}
          />
          <div className="console-content mx-auto w-full max-w-5xl px-6 py-8"><DuesBoard reviewer={signedIn} /></div>
        </>}
      </StaffGate>
    </main>
  );
}

function DuesBoard({ reviewer }: { reviewer: Reviewer }) {
  const [view, setView] = useState<ViewState | null>(null);
  const [faces, setFaces] = useState<Record<string, DriverFace>>({});
  const [namesError, setNamesError] = useState<string | null>(null);


  useEffect(() => {
    const stop = onSnapshot(
      query(
        collectionGroup(firebaseClients().firestore, SUBCOLLECTIONS.driverDues),
      ),
      async (snap) => {
        const rows = snap.docs
          .map((doc) => readDue(doc))
          .filter((row): row is DueRow => row !== null);
        rows.sort((a, b) => (b.recordedAtMs ?? b.createdAtMs ?? 0) - (a.recordedAtMs ?? a.createdAtMs ?? 0));
        setView({ rows });
        // A payment settlement re-fires this listener, so both outstanding
        // charges and successful receipts stay in sync without a reload.
        try {
          const resolved = await resolveDrivers([...new Set(rows.map((row) => row.driverUid))]);
          // Merged, not replaced: keep previously resolved names for payment
          // history rows when a driver's unpaid balance reaches zero.
          setFaces((previous) => ({ ...previous, ...resolved }));
          setNamesError(null);
        } catch (error) {
          setNamesError(describe(error));
        }
      },
      (error) => setView({ error: describe(error) }),
    );
    return stop;
  }, []);

  const allRows = view && 'rows' in view ? view.rows : null;
  const rows = allRows?.filter((row) => row.status === 'unpaid') ?? null;
  const successfulPayments = allRows?.filter((row) => row.status === 'paid' && row.settledBy === 'cashfree') ?? [];
  const listError = view && 'error' in view ? view.error : null;

  const groups: Group[] = [];
  if (rows) {
    const byDriver = new Map<string, DueRow[]>();
    for (const row of rows) {
      const list = byDriver.get(row.driverUid) ?? [];
      list.push(row);
      byDriver.set(row.driverUid, list);
    }
    for (const [driverUid, driverRows] of byDriver) {
      groups.push({
        driverUid,
        rows: driverRows,
        totalPaise: driverRows.reduce((sum, row) => sum + row.totalPaise, 0),
        driver: faces[driverUid] ?? null,
      });
    }
    groups.sort((a, b) => b.totalPaise - a.totalPaise);
  }

  const totalPaise = (rows ?? []).reduce((sum, row) => sum + row.totalPaise, 0);
  const commissionRows = (rows ?? []).filter((row) => row.kind === 'commission');
  const commissionPaise = commissionRows.reduce((sum, row) => sum + row.totalPaise, 0);
  const feePaise = totalPaise - commissionPaise;
  /**
   * The rates that are actually on the ledger. Each trip was billed at the rate
   * the office had set when it was booked, so a panel quoting one number for the
   * whole column would be a claim about rows it did not read.
   */
  const billedRates = [
    ...new Set(
      commissionRows.map((row) => row.rate).filter((rate): rate is number => typeof rate === 'number'),
    ),
  ].sort((a, b) => a - b);

  return (
    <>
      <section className="rounded-card border border-line bg-surface p-6 shadow-card">
        <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-ink-muted">
          Outstanding
        </h2>
        {listError ? (
          <p className="mt-3 rounded-control bg-danger-soft px-3 py-2 text-sm text-badge-danger">
            Could not read the ledger: {listError}
          </p>
        ) : null}
        {namesError ? (
          <p className="mt-3 rounded-control bg-warning-soft px-3 py-2 text-sm text-badge-warning">
            The charges came through but their names did not: {namesError}
          </p>
        ) : null}

        <dl className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase tracking-[0.14em] text-ink-faint">Total to collect</dt>
            <dd className="mt-1 font-mono text-2xl font-semibold">{rows === null ? '—' : formatINR(totalPaise)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.14em] text-ink-faint">
              Trip commission (
              {billedRates.length > 0
                ? billedRates.map((rate) => `${Math.round(rate * 100)}%`).join(' or ')
                : `${Math.round(COMMISSION_TERMS.rate * 100)}%`}{' '}
              of fare + {Math.round(COMMISSION_TERMS.gstRate * 100)}% tax)
            </dt>
            <dd className="mt-1 font-mono text-xl">{rows === null ? '—' : formatINR(commissionPaise)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.14em] text-ink-faint">Onboarding fees</dt>
            <dd className="mt-1 font-mono text-xl">{rows === null ? '—' : formatINR(feePaise)}</dd>
          </div>
        </dl>

        <p className="mt-4 text-xs text-ink-faint">
          {groups.length} driver{groups.length === 1 ? '' : 's'} hold{groups.length === 1 ? 's' : ''}{' '}
          an unpaid row. While one is unpaid the server refuses that driver a new booking when they
          answer an offer or go online — a driver in the middle of a trip is never cut off over money.
        </p>
      </section>

      {rows === null && !listError ? <p className="mt-6 text-sm text-ink-muted">Loading…</p> : null}



      {rows !== null && rows.length === 0 ? (
        <p className="mt-6 rounded-card border border-line bg-surface p-6 text-sm text-ink-muted">
          Nobody owes anything. A commission row appears here on its own once a trip is marked
          completed, and the onboarding fee appears when a driver first files a document.
        </p>
      ) : null}

      <ul className="mt-6 space-y-5">
        {groups.map((group) => (
          <li key={group.driverUid}>
            <DriverDues group={group} canRecord={reviewer.admin} />
          </li>
        ))}
      </ul>

      {successfulPayments.length > 0 ? (
        <section className="mt-10 rounded-card border border-line bg-surface p-6 shadow-card">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Successful online payments</h2>
              <p className="mt-1 text-sm text-ink-muted">Confirmed by Cashfree. Cleared charges stay visible here as receipts.</p>
            </div>
            <p className="font-mono text-lg font-semibold">{formatINR(successfulPayments.reduce((sum, row) => sum + row.totalPaise, 0))}</p>
          </div>
          <ul className="mt-4 divide-y divide-line border-t border-line">
            {successfulPayments.map((row) => (
              <li key={`${row.driverUid}-${row.dueId}`} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-medium">{faces[row.driverUid]?.fullName ?? `Driver ${row.driverUid.slice(0, 8)}`} · {row.title}</p>
                  <p className="mt-0.5 text-xs text-ink-faint">Successful payment · {row.method ?? 'Online'}{row.reference ? ` · ${row.reference}` : ''}{row.recordedAtMs ? ` · ${stamp(row.recordedAtMs)}` : ''}</p>
                </div>
                <p className="font-mono font-semibold">{formatINR(row.totalPaise)}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!reviewer.admin ? (
        <p className="mt-6 rounded-card border border-line bg-surface-muted p-5 text-sm text-ink-muted">
          Signed in as {reviewer.label}, which carries the operations claim only. You can read the
          ledger and confirmed receipts; payment settlement itself is verified by Cashfree.
        </p>
      ) : null}
    </>
  );
}

function DriverDues({ group, canRecord }: { group: Group; canRecord: boolean }) {

  const shortBy = group.rows
    .map((row) => row.bookingId?.replace(/^bk-/, '').slice(0, 8))
    .filter((id): id is string => Boolean(id));



  return (
    <article className="rounded-card border border-line bg-surface p-6 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">
            {group.driver?.fullName ?? 'Driver ' + group.driverUid.slice(0, 8)}
          </h3>
          <p className="mt-1 font-mono text-sm text-ink-muted">{group.driver?.phoneE164 ?? '—'}</p>
          <p className="mt-1 text-xs text-ink-faint">
            {group.driver?.driverId ? `Driver id ${group.driver.driverId}` : 'No driver id yet'} ·{' '}
            {group.driver?.availabilityState ? `availability ${group.driver.availabilityState}` : 'availability unknown'}
          </p>
          <p className="mt-1 font-mono text-[11px] text-ink-faint">{group.driverUid}</p>
        </div>
        <p className="font-mono text-2xl font-semibold">{formatINR(group.totalPaise)}</p>
      </div>

      <ul className="mt-4 divide-y divide-line border-t border-line">
        {group.rows.map((row) => (
          <li key={row.dueId} className="flex flex-wrap items-baseline justify-between gap-3 py-3">
            <div>
              <p className="font-medium">{row.title}</p>
              <p className="mt-0.5 text-xs text-ink-faint">
                {KIND_LABEL[row.kind]}
                {row.rate !== null && row.commissionablePaise !== null
                  ? ` · ${Math.round(row.rate * 100)}% of ${formatINR(row.commissionablePaise)} fare`
                  : ''}
                {row.bookingId ? ` · booking ${row.bookingId}` : ''} ·{' '}
                {row.createdAtMs === null ? 'no date on the row' : `billed ${stamp(row.createdAtMs)}`}
              </p>
            </div>
            <p className="font-mono text-sm">
              {formatINR(row.basePaise)}
              <span className="text-ink-faint">
                {' '}
                + {Math.round(row.gstRate * 100)}% tax {formatINR(row.gstPaise)} ={' '}
              </span>{' '}
              <span className="font-semibold">{formatINR(row.totalPaise)}</span>
            </p>
          </li>
        ))}
      </ul>

      {canRecord ? (
        <p className="mt-4 text-xs text-ink-muted">
          Payment is completed by the driver through Cashfree. After gateway confirmation, this charge moves to Successful online payments and the driver&apos;s dues clear automatically.
        </p>
      ) : (
        <p className="mt-4 text-xs text-ink-muted">
          Read-only for this account: only the administrator can review the ledger.
        </p>
      )}

    </article>
  );
}
