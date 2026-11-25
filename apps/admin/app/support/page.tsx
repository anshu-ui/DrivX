'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  writeBatch,
  type DocumentData,
} from 'firebase/firestore';
import { COLLECTIONS, SUBCOLLECTIONS } from '@drivx/domain';
import { toEpochMs } from '@drivx/firebase-client';
import { firebaseClients } from '../../lib/firebase';
import { ConsoleHeader, StaffGate, stamp, useReviewerSession } from '../../lib/staff-session';

type TicketStatus = 'open' | 'in_progress' | 'awaiting_customer' | 'resolved' | 'closed';
type Ticket = {
  id: string; subject: string; body: string; status: TicketStatus; category: string;
  suggestedCategory: string | null; suggestedPriority: string | null; priority: string;
  forRole: 'customer' | 'driver'; openedByUid: string; bookingId: string | null; bookingReference: string | null;
  createdAtMs: number | null; updatedAtMs: number | null; resolution: string | null;
  lastEmailDeliveryStatus: string | null; lastEmailRecipient: string | null;
};
type Message = { id: string; body: string; authorUid: string; authorRole: string; createdAtMs: number | null };
type Snapshot = { rows: Ticket[] } | { error: string } | null;

function readTicket(id: string, data: DocumentData): Ticket {
  return {
    id,
    subject: String(data.subject ?? ''),
    body: String(data.body ?? ''),
    status: (String(data.status ?? 'open')) as TicketStatus,
    category: String(data.category ?? 'trip_issue'),
    suggestedCategory: typeof data.suggestedCategory === 'string' ? data.suggestedCategory : null,
    suggestedPriority: typeof data.suggestedPriority === 'string' ? data.suggestedPriority : null,
    priority: String(data.priority ?? 'normal'),
    forRole: data.forRole === 'driver' ? 'driver' : 'customer',
    openedByUid: String(data.openedByUid ?? ''),
    bookingId: typeof data.bookingId === 'string' ? data.bookingId : null,
    bookingReference: typeof data.bookingReference === 'string' ? data.bookingReference : null,
    createdAtMs: toEpochMs(data.createdAtMs),
    updatedAtMs: toEpochMs(data.updatedAtMs),
    resolution: typeof data.resolution === 'string' ? data.resolution : null,
    lastEmailDeliveryStatus: typeof data.lastEmailDeliveryStatus === 'string' ? data.lastEmailDeliveryStatus : null,
    lastEmailRecipient: typeof data.lastEmailRecipient === 'string' ? data.lastEmailRecipient : null,
  };
}

function SupportInbox({ reviewer }: { reviewer: { label: string; admin: boolean; ops: boolean } }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messageView, setMessageView] = useState<{ ticketId: string; rows: Message[] } | null>(null);
  const [reply, setReply] = useState('');
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean } | null>(null);
  const [filter, setFilter] = useState<'active' | 'all' | 'closed'>('active');
  const tickets = useMemo(() => snapshot && 'rows' in snapshot ? snapshot.rows : [], [snapshot]);
  const messages = messageView?.ticketId === selectedId ? messageView.rows : [];
  const selected = tickets.find((ticket) => ticket.id === selectedId) ?? null;

  useEffect(() => {
    const db = firebaseClients().firestore;
    return onSnapshot(query(collection(db, COLLECTIONS.supportTickets), orderBy('updatedAtMs', 'desc'), limit(200)),
      (rows) => setSnapshot({ rows: rows.docs.map((row) => readTicket(row.id, row.data())) }),
      (error) => setSnapshot({ error: error.message }));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const db = firebaseClients().firestore;
    return onSnapshot(query(collection(db, COLLECTIONS.supportTickets, selectedId, SUBCOLLECTIONS.supportMessages), orderBy('createdAtMs', 'asc'), limit(100)),
      (rows) => setMessageView({ ticketId: selectedId, rows: rows.docs.map((row) => {
        const data = row.data();
        return { id: row.id, body: String(data.body ?? ''), authorUid: String(data.authorUid ?? ''), authorRole: String(data.authorRole ?? 'customer'), createdAtMs: toEpochMs(data.createdAtMs) };
      }) }),
      (error) => setFeedback({ text: `Could not load conversation: ${error.message}`, error: true }));
  }, [selectedId]);

  const visible = useMemo(() => tickets.filter((ticket) => filter === 'all' ||
    (filter === 'closed' ? ticket.status === 'closed' || ticket.status === 'resolved' : ticket.status !== 'closed' && ticket.status !== 'resolved'))
    .sort((left, right) => {
      const rank = (ticket: Ticket) => ({ urgent: 0, high: 1, normal: 2, low: 3 }[ticket.suggestedPriority ?? ticket.priority] ?? 4);
      return rank(left) - rank(right) || (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0);
    }), [tickets, filter]);

  async function changeStatus(ticket: Ticket, status: TicketStatus) {
    setBusy(true); setFeedback(null);
    try {
      const user = firebaseClients().auth.currentUser;
      if (!user) throw new Error('Admin sign-in expired. Sign in again.');
      await updateDoc(doc(firebaseClients().firestore, COLLECTIONS.supportTickets, ticket.id), {
        status,
        resolvedAtMs: status === 'resolved' || status === 'closed' ? serverTimestamp() : null,
        resolution: status === 'resolved' ? resolution.trim() || 'Resolved by DrivX support.' : null,
        updatedAtMs: serverTimestamp(),
        lastAdminActionByUid: user.uid,
        lastAdminActionByRole: reviewer.admin ? 'admin' : 'ops',
        lastAdminActionNote: resolution.trim() || null,
      });
      setFeedback({ text: `Ticket ${ticket.id} moved to ${status.replace(/_/g, ' ')}.` });
    } catch (error) { setFeedback({ text: error instanceof Error ? error.message : 'Could not update ticket status.', error: true }); }
    finally { setBusy(false); }
  }

  async function sendReply() {
    if (!selected || reply.trim().length < 2) return;
    setBusy(true); setFeedback(null);
    try {
      const db = firebaseClients().firestore;
      const user = firebaseClients().auth.currentUser;
      if (!user) throw new Error('Admin sign-in expired. Sign in again.');
      const ticketRef = doc(db, COLLECTIONS.supportTickets, selected.id);
      const messageRef = doc(collection(ticketRef, SUBCOLLECTIONS.supportMessages));
      const batch = writeBatch(db);
      batch.set(messageRef, {
        id: messageRef.id,
        ticketId: selected.id,
        authorUid: user.uid,
        authorRole: reviewer.admin ? 'admin' : 'ops',
        body: reply.trim(),
        createdAtMs: serverTimestamp(),
      });
      batch.update(ticketRef, {
        status: 'awaiting_customer',
        resolvedAtMs: null,
        resolution: null,
        updatedAtMs: serverTimestamp(),
        lastAdminActionByUid: user.uid,
        lastAdminActionByRole: reviewer.admin ? 'admin' : 'ops',
        lastAdminActionNote: 'Support replied; waiting for the requester.',
      });
      await batch.commit();
      setReply('');
      setFeedback({ text: 'Reply added to the ticket. It will appear in the app; an email is sent when the account has an email address on file.' });
    } catch (error) { setFeedback({ text: error instanceof Error ? error.message : 'Could not send the reply.', error: true }); }
    finally { setBusy(false); }
  }

  return <>
    <div className="mb-6 grid gap-3 sm:grid-cols-3">
      {[['Open', tickets.filter((row) => row.status === 'open').length], ['In progress', tickets.filter((row) => row.status === 'in_progress').length], ['Waiting / closed', tickets.filter((row) => row.status === 'awaiting_customer' || row.status === 'resolved' || row.status === 'closed').length]].map(([label, count]) => <div key={label} className="rounded-2xl border border-line bg-surface p-4"><p className="text-xs font-semibold text-ink-muted">{label}</p><p className="mt-2 text-2xl font-extrabold text-accent">{count}</p></div>)}
    </div>
    <div className="grid gap-5 xl:grid-cols-[minmax(300px,.8fr)_minmax(0,1.2fr)]">
      <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-4"><div><h2 className="font-bold">Ticket queue</h2><p className="text-xs text-ink-muted">Live updates · up to 200 recent tickets</p></div><select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)} className="rounded-control border border-line bg-surface px-3 py-2 text-xs"><option value="active">Active</option><option value="all">All</option><option value="closed">Resolved / closed</option></select></div>
        {snapshot === null ? <p className="p-6 text-sm text-ink-muted">Loading support tickets…</p> : 'error' in snapshot ? <p role="alert" className="p-6 text-sm text-badge-danger">Could not read support tickets: {snapshot.error}</p> : visible.length === 0 ? <p className="p-8 text-sm text-ink-muted">No tickets in this view.</p> : <div className="max-h-[72vh] divide-y divide-line overflow-y-auto">{visible.map((ticket) => <button key={ticket.id} type="button" onClick={() => { setSelectedId(ticket.id); setFeedback(null); }} className={`block w-full p-4 text-left transition hover:bg-surface-muted ${ticket.id === selectedId ? 'bg-accent-soft' : ''}`}><div className="flex items-start justify-between gap-3"><span className="font-bold text-ink">{ticket.subject || 'Support request'}</span><span className="shrink-0 rounded-full bg-surface-muted px-2.5 py-1 text-[10px] font-bold uppercase text-ink-muted">{ticket.status.replaceAll('_', ' ')}</span></div><p className="mt-1 line-clamp-2 text-sm text-ink-muted">{ticket.body}</p><p className="mt-2 text-[11px] text-ink-faint">{ticket.forRole} · {ticket.category} · {ticket.priority} · {stamp(ticket.updatedAtMs ?? ticket.createdAtMs)}</p>{ticket.suggestedPriority ? <p className="mt-1 text-[11px] font-semibold text-warning">Suggested triage: {ticket.suggestedPriority} · {ticket.suggestedCategory}</p> : null}</button>)}</div>}
      </section>
      <section className="min-h-[520px] rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
        {!selected ? <div className="flex h-full min-h-[420px] flex-col items-center justify-center text-center"><span className="text-3xl text-ink-faint">✉</span><h2 className="mt-3 font-bold">Select a ticket</h2><p className="mt-1 max-w-sm text-sm text-ink-muted">Ticket replies are saved to the conversation, shown in the customer or driver app, and emailed to the user.</p></div> : <>
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-4"><div><p className="text-xs font-bold uppercase tracking-wider text-accent">{selected.forRole} support · {selected.id}</p><h2 className="mt-1 text-xl font-extrabold">{selected.subject}</h2><p className="mt-1 text-xs text-ink-muted">Opened {stamp(selected.createdAtMs)} · Account {selected.openedByUid}{selected.bookingReference ? ` · Booking ${selected.bookingReference}` : selected.bookingId ? ` · Booking ${selected.bookingId}` : ''}</p></div><span className="rounded-full bg-accent-soft px-3 py-1.5 text-xs font-bold capitalize text-accent">{selected.status.replaceAll('_', ' ')}</span></div>
          <div className="mt-4 rounded-xl bg-surface-muted p-4"><p className="whitespace-pre-wrap text-sm leading-6">{selected.body}</p><p className="mt-3 text-xs text-ink-faint">{selected.category} · Actual priority: {selected.priority}{selected.suggestedPriority ? ` · System suggestion: ${selected.suggestedPriority} / ${selected.suggestedCategory}` : ''}</p></div>
          {selected.lastEmailDeliveryStatus ? <p className="mt-3 text-xs text-ink-muted">Last support email: {selected.lastEmailDeliveryStatus}{selected.lastEmailRecipient ? ` to ${selected.lastEmailRecipient}` : ''}</p> : null}
          {selected.resolution ? <p className="mt-3 rounded-lg bg-success-soft p-3 text-sm text-badge-success">Resolution: {selected.resolution}</p> : null}
          <div className="mt-5 space-y-3"><h3 className="text-sm font-bold">Conversation</h3>{messages.length === 0 ? <p className="text-sm text-ink-faint">No replies yet.</p> : messages.map((message) => <article key={message.id} className={`rounded-xl p-3 ${message.authorRole === 'admin' || message.authorRole === 'ops' ? 'bg-accent-soft' : 'bg-surface-muted'}`}><div className="flex justify-between gap-3 text-[11px] font-bold text-ink-muted"><span>{message.authorRole === 'admin' || message.authorRole === 'ops' ? 'DrivX support' : `${message.authorRole} · ${message.authorUid}`}</span><span>{stamp(message.createdAtMs)}</span></div><p className="mt-2 whitespace-pre-wrap text-sm leading-6">{message.body}</p></article>)}</div>
          {selected.status !== 'closed' && selected.status !== 'resolved' ? <div className="mt-5"><label htmlFor="support-reply" className="text-sm font-bold">Reply to user</label><textarea id="support-reply" value={reply} onChange={(event) => setReply(event.target.value)} rows={4} className="mt-2 w-full rounded-xl border border-line bg-surface px-3 py-3 text-sm outline-none focus:border-accent" placeholder="Write a clear response. The user will see it in the app and receive an email." /><button type="button" disabled={busy || reply.trim().length < 2} onClick={() => void sendReply()} className="mt-2 rounded-control bg-accent px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">{busy ? 'Sending…' : 'Send reply'}</button></div> : null}
          <div className="mt-5 border-t border-line pt-4"><label htmlFor="resolution" className="text-xs font-bold text-ink-muted">Resolution note (optional)</label><input id="resolution" value={resolution} onChange={(event) => setResolution(event.target.value)} className="mt-2 w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-sm outline-none focus:border-accent" placeholder="What was done to resolve this ticket?" /><div className="mt-3 flex flex-wrap gap-2">{(['open', 'in_progress', 'awaiting_customer', 'resolved', 'closed'] as TicketStatus[]).filter((status) => status !== selected.status).map((status) => <button key={status} type="button" disabled={busy} onClick={() => void changeStatus(selected, status)} className="rounded-control border border-line px-3 py-2 text-xs font-semibold capitalize hover:bg-surface-muted disabled:opacity-50">{status === 'open' ? 'Reopen' : status.replaceAll('_', ' ')}</button>)}</div></div>
        </>}
        {feedback ? <p role={feedback.error ? 'alert' : 'status'} className={`mt-4 text-sm ${feedback.error ? 'text-badge-danger' : 'text-badge-success'}`}>{feedback.text}</p> : null}
      </section>
    </div>
  </>;
}

export default function SupportPage() {
  const { reviewer, checked } = useReviewerSession();
  return <main className="flex-1"><StaffGate checked={checked} reviewer={reviewer} claim="staff" signInHeading="Administrator sign-in required" signInBlurb="Support tickets contain customer and driver messages. Sign in with your DrivX staff account to review and reply.">{(signedIn) => <><ConsoleHeader title="Support inbox" blurb="Review customer and driver tickets, reply in one thread, and manage ticket status." reviewer={signedIn} links={[{ href: '/', label: 'Overview' }, { href: '/bookings', label: 'Bookings' }, { href: '/verification', label: 'Driver reviews' }, { href: '/dues', label: 'Earnings & dues' }, { href: '/pricing', label: 'Fare settings' }]} /><div className="console-content mx-auto w-full max-w-7xl px-5 py-8 sm:px-8"><SupportInbox reviewer={signedIn} /></div></>}</StaffGate></main>;
}
