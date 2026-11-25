'use client';

import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, orderBy, query, where, type DocumentData } from 'firebase/firestore';
import { formatINR } from '@drivx/domain';
import { callFunction, toEpochMs } from '@drivx/firebase-client';
import { firebaseClients } from '../../lib/firebase';
import { ConsoleHeader, StaffGate, describe, stamp, useReviewerSession, type Reviewer } from '../../lib/staff-session';

type Period = 'week' | 'month' | 'year';
type Side = 'customer' | 'driver';
type InvoiceRow = {
  bookingId: string;
  reference: string;
  side: Side;
  invoiceNumber: string;
  name: string;
  email: string;
  completedAtMs: number;
  pickup: string;
  destination: string;
  totalPaise: number;
  fareTotalPaise: number;
  settlementPaise: number | null;
  pdfStatus: string;
  emailStatus: string;
  data: DocumentData;
};

function currentIstValues(now: number): Record<Period, string> {
  const local = new Date(now + 330 * 60_000);
  return {
    week: local.toISOString().slice(0, 10),
    month: local.toISOString().slice(0, 7),
    year: String(local.getUTCFullYear()),
  };
}

/** Exclusive date window for the chosen week, month, or year in India time. */
function periodWindow(period: Period, value: string): { start: number; end: number } {
  let firstDayUtc: number;
  let dayCount: number;
  if (period === 'year') {
    const year = Number(value);
    firstDayUtc = Date.UTC(year, 0, 1);
    dayCount = (Date.UTC(year + 1, 0, 1) - firstDayUtc) / 86_400_000;
  } else if (period === 'month') {
    const [year, month] = value.split('-').map(Number);
    firstDayUtc = Date.UTC(year, month - 1, 1);
    dayCount = (Date.UTC(year, month, 1) - firstDayUtc) / 86_400_000;
  } else {
    const [year, month, day] = value.split('-').map(Number);
    const selectedDayUtc = Date.UTC(year, month - 1, day);
    const daysFromMonday = (new Date(selectedDayUtc).getUTCDay() + 6) % 7;
    firstDayUtc = selectedDayUtc - daysFromMonday * 86_400_000;
    dayCount = 7;
  }
  const start = firstDayUtc - 330 * 60_000;
  return { start, end: start + dayCount * 86_400_000 };
}

function invoiceRow(bookingId: string, data: DocumentData, side: Side): InvoiceRow | null {
  const invoice = data[side] && typeof data[side] === 'object' ? data[side] as DocumentData : {};
  const completedAtMs = toEpochMs(data.completedAtMs);
  const invoiceNumber = typeof invoice.invoiceNumber === 'string' ? invoice.invoiceNumber : '';
  if (!completedAtMs || !invoiceNumber) return null;
  const settlement = data.settlement && typeof data.settlement === 'object' ? data.settlement as DocumentData : {};
  return {
    bookingId,
    reference: typeof data.reference === 'string' ? data.reference : bookingId,
    side,
    invoiceNumber,
    name: typeof data[side === 'customer' ? 'customerName' : 'driverName'] === 'string' ? data[side === 'customer' ? 'customerName' : 'driverName'] as string : 'Name not recorded',
    email: typeof invoice.recipientEmail === 'string' ? invoice.recipientEmail : 'Email unavailable',
    completedAtMs,
    pickup: typeof data.pickup === 'string' ? data.pickup : '—',
    destination: typeof data.destination === 'string' ? data.destination : '—',
    totalPaise: Number(side === 'customer' ? data.fareTotalPaise : settlement.totalDuePaise ?? data.fareTotalPaise ?? 0),
    fareTotalPaise: Number(data.fareTotalPaise ?? 0),
    settlementPaise: side === 'driver' ? Number(settlement.totalDuePaise ?? 0) : null,
    pdfStatus: typeof data.pdfStatus === 'string' ? data.pdfStatus : typeof invoice.storagePath === 'string' ? 'ready' : 'pending',
    emailStatus: typeof invoice.emailStatus === 'string' ? invoice.emailStatus : 'pending',
    data,
  };
}

export default function InvoiceArchivePage() {
  const { reviewer, checked } = useReviewerSession();
  return <main className="flex-1">
    <StaffGate checked={checked} reviewer={reviewer} claim="staff" signInHeading="Staff sign-in" signInBlurb="Trip invoices contain private customer and driver details and are limited to DrivX operations staff.">
      {(signedIn) => <>
        <ConsoleHeader title="Trip invoices" blurb="Customer fare receipts and driver settlement statements, saved per completed trip." reviewer={signedIn} links={[{ href: '/', label: 'Overview' }, { href: '/bookings', label: 'Bookings & dispatch' }, { href: '/dues', label: 'Earnings & dues' }, { href: '/invoices', label: 'Trip invoices' }, { href: '/pricing', label: 'Fare settings' }]} />
        <div className="console-content mx-auto w-full max-w-7xl px-5 py-8 sm:px-8"><InvoiceArchive reviewer={signedIn} /></div>
      </>}
    </StaffGate>
  </main>;
}

function InvoiceArchive({ reviewer }: { reviewer: Reviewer }) {
  const [period, setPeriod] = useState<Period>('month');
  const [side, setSide] = useState<Side>('customer');
  const [rows, setRows] = useState<InvoiceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [periodValues, setPeriodValues] = useState<Record<Period, string>>(() => currentIstValues(Date.now()));
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const selectedPeriod = periodValues[period];
  const { start, end } = periodWindow(period, selectedPeriod);
  const queryKey = `${start}:${end}:${side}`;
  const [loadedQueryKey, setLoadedQueryKey] = useState('');
  const currentYear = Number(currentIstValues(now).year);
  const years = useMemo(() => Array.from({ length: currentYear - 1999 }, (_, index) => String(currentYear - index)), [currentYear]);

  useEffect(() => {
    if (!reviewer) return;
    const stop = onSnapshot(
      query(collection(firebaseClients().firestore, 'tripInvoices'), where('completedAtMs', '>=', start), where('completedAtMs', '<', end), orderBy('completedAtMs', 'desc')),
      (snapshot) => {
        setError(null);
        setRows(snapshot.docs.map((document) => invoiceRow(document.id, document.data(), side)).filter((row): row is InvoiceRow => row !== null));
        setLoadedQueryKey(`${start}:${end}:${side}`);
      },
      (reason) => { setRows([]); setError(describe(reason)); setLoadedQueryKey(`${start}:${end}:${side}`); },
    );
    return () => stop();
  }, [reviewer, side, start, end]);

  const loadingRecords = loadedQueryKey !== queryKey;
  const visible = useMemo(() => {
    if (loadingRecords) return [];
    const needle = search.trim().toLowerCase();
    if (!needle) return rows ?? [];
    return (rows ?? []).filter((row) => [row.reference, row.bookingId, row.invoiceNumber, row.name, row.email, row.pickup, row.destination].some((value) => value.toLowerCase().includes(needle)));
  }, [loadingRecords, rows, search]);
  const filteredTotal = visible.reduce((sum, row) => sum + row.totalPaise, 0);

  async function download(row: InvoiceRow) {
    setDownloading(`${row.bookingId}:${row.side}`);
    setError(null);
    try {
      const result = await callFunction<{ bookingId: string; side: Side }, { url: string; expiresAtMs: number }>(firebaseClients(), 'getTripInvoiceDownloadUrl', { bookingId: row.bookingId, side: row.side });
      const anchor = document.createElement('a');
      anchor.href = result.url;
      anchor.download = `${row.invoiceNumber}.pdf`;
      anchor.rel = 'noopener';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch (reason) { setError(describe(reason)); }
    finally { setDownloading(null); }
  }

  async function downloadFilteredPdfs() {
    if (!visible.length || visible.length > 1000) return;
    setDownloading('archive');
    setError(null);
    try {
      const result = await callFunction<{ side: Side; bookingIds: string[] }, { zipBase64: string; filename: string }>(firebaseClients(), 'getTripInvoiceArchive', {
        side,
        bookingIds: visible.map((row) => row.bookingId),
      });
      const binary = atob(result.zipBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) { setError(describe(reason)); }
    finally { setDownloading(null); }
  }

  function exportCsv() {
    const columns = ['Invoice number', 'Invoice type', 'Booking reference', 'Booking ID', 'Name', 'Email', 'Completed at', 'Pickup', 'Drop-off', 'Invoice amount paise', 'Customer fare total paise', 'Driver remittance due paise', 'Email status'];
    const quote = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const lines = [columns, ...visible.map((row) => [row.invoiceNumber, row.side, row.reference, row.bookingId, row.name, row.email, new Date(row.completedAtMs).toISOString(), row.pickup, row.destination, row.totalPaise, row.fareTotalPaise, row.settlementPaise ?? '', row.emailStatus])].map((line) => line.map(quote).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([lines], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `drivx-${side}-invoices-${period}.csv`; anchor.click(); URL.revokeObjectURL(url);
  }

  const totalLabel = side === 'customer' ? 'Customer fare totals' : 'Driver remittance totals';
  return <>
    <section className="rounded-2xl border border-line bg-surface p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h2 className="text-xl font-bold">Invoice archive</h2><p className="mt-1 max-w-2xl text-sm text-ink-muted">Each completed trip has a separate customer PDF and driver settlement PDF. Download links are authorized per trip and expire after five minutes.</p></div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={exportCsv} disabled={!visible.length || loadingRecords} className="rounded-control border border-line px-4 py-2 text-sm font-semibold disabled:opacity-50">Export filtered CSV</button>
          <button type="button" onClick={() => void downloadFilteredPdfs()} disabled={!visible.length || visible.length > 1000 || loadingRecords || downloading !== null} className="rounded-control bg-accent px-4 py-2 text-sm font-semibold text-ink-on-brand disabled:opacity-50">{downloading === 'archive' ? 'Preparing ZIP…' : 'Download filtered PDFs'}</button>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        {([{ id: 'customer', label: 'Customer invoices' }, { id: 'driver', label: 'Driver invoices' }] as const).map((tab) => <button key={tab.id} type="button" onClick={() => setSide(tab.id)} className={`rounded-full px-4 py-2 text-sm font-semibold ${side === tab.id ? 'bg-accent text-ink-on-brand' : 'border border-line text-ink-muted'}`}>{tab.label}</button>)}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="text-sm font-semibold">Period<select aria-label="Invoice date period" value={period} onChange={(event) => setPeriod(event.target.value as Period)} className="ml-2 rounded-control border border-line bg-surface px-3 py-2"><option value="week">Week</option><option value="month">Month</option><option value="year">Year</option></select></label>
        {period === 'week' ? <label className="text-sm font-semibold">Week containing<input aria-label="Choose a date in the invoice week" type="date" value={periodValues.week} onChange={(event) => { const value = event.target.value; if (value) setPeriodValues((current) => ({ ...current, week: value })); }} className="ml-2 rounded-control border border-line bg-surface px-3 py-2 font-normal" /></label> : null}
        {period === 'month' ? <label className="text-sm font-semibold">Month<input aria-label="Choose invoice month" type="month" value={periodValues.month} onChange={(event) => { const value = event.target.value; if (value) setPeriodValues((current) => ({ ...current, month: value })); }} className="ml-2 rounded-control border border-line bg-surface px-3 py-2 font-normal" /></label> : null}
        {period === 'year' ? <label className="text-sm font-semibold">Year<select aria-label="Choose invoice year" value={periodValues.year} onChange={(event) => setPeriodValues((current) => ({ ...current, year: event.target.value }))} className="ml-2 rounded-control border border-line bg-surface px-3 py-2">{years.map((year) => <option key={year} value={year}>{year}</option>)}</select></label> : null}
        <label className="min-w-56 flex-1 text-sm font-semibold">Search<input aria-label="Search trip invoices" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Invoice, booking, person, route" className="mt-1 block w-full rounded-control border border-line bg-surface px-3 py-2 font-normal" /></label>
        <div className="rounded-control bg-surface-muted px-4 py-2"><div className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">{totalLabel}</div><div className="font-mono text-lg font-bold">{formatINR(filteredTotal)}</div></div>
      </div>
    </section>

    {error ? <p role="alert" className="mt-4 rounded-control border border-danger/30 bg-danger-soft p-3 text-sm text-danger">{error}</p> : null}
    <section className="mt-5 overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      <div className="flex items-center justify-between border-b border-line px-5 py-4"><div><h2 className="font-bold">{side === 'customer' ? 'Customer trip invoices' : 'Driver settlement statements'}</h2><p className="mt-1 text-sm text-ink-muted">{loadingRecords ? 'Loading records…' : `${visible.length} record${visible.length === 1 ? '' : 's'} · ${stamp(start)} – ${stamp(end - 1)}`}</p></div></div>
      {loadingRecords ? <div className="px-5 py-10 text-sm text-ink-muted">Loading invoice records…</div> : visible.length === 0 ? <div className="px-5 py-10 text-center text-sm text-ink-muted">No {side} invoices match this period.</div> : <div className="divide-y divide-line">{visible.map((row) => <article key={`${row.bookingId}:${row.side}`} className="grid gap-4 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-bold text-ink">{row.invoiceNumber}</span><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${row.pdfStatus === 'ready' ? 'bg-success-soft text-badge-success' : 'bg-warning-soft text-badge-warning'}`}>PDF {row.pdfStatus.replaceAll('_', ' ')}</span><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${row.emailStatus === 'sent' ? 'bg-success-soft text-badge-success' : 'bg-warning-soft text-badge-warning'}`}>Email {row.emailStatus.replaceAll('_', ' ')}</span></div><p className="mt-1 text-sm text-ink-muted">{row.name} · {row.email}</p><p className="mt-1 text-xs text-ink-faint">Booking {row.reference} · {row.bookingId} · completed {stamp(row.completedAtMs)}</p><p className="mt-2 truncate text-sm text-ink">{row.pickup} <span className="px-1 text-ink-faint">→</span> {row.destination}</p></div>
        <div className="flex flex-wrap items-center justify-between gap-3 lg:justify-end"><div className="text-right"><p className="font-mono font-bold">{formatINR(row.totalPaise)}</p>{row.settlementPaise !== null ? <p className="text-xs text-ink-muted">Driver remittance due</p> : <p className="text-xs text-ink-muted">Customer fare total</p>}</div><button type="button" onClick={() => void download(row)} disabled={downloading !== null || row.pdfStatus !== 'ready'} className="rounded-control bg-accent px-4 py-2.5 text-sm font-semibold text-ink-on-brand disabled:opacity-50">{downloading === `${row.bookingId}:${row.side}` ? 'Preparing…' : row.pdfStatus === 'ready' ? 'Download PDF' : 'PDF preparing…'}</button></div>
      </article>)}</div>}
    </section>
    <p className="mt-3 text-xs leading-5 text-ink-faint">Customer and driver statements are separate. Download filtered PDFs creates one ZIP for up to 1,000 matching records. Issuer tax details remain marked pending until the company name and GSTIN are configured in Fare settings.</p>
  </>;
}
