'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { callFunction } from '@drivx/firebase-client';
import { firebaseClients } from '../../lib/firebase';
import { ConsoleHeader, StaffGate, describe, stamp, useReviewerSession } from '../../lib/staff-session';

type Audience = 'all' | 'customers' | 'drivers';
type Announcement = {
  id: string;
  title: string;
  body: string;
  audience: Audience;
  status: 'queued' | 'sent' | string;
  recipientCount: number;
  createdAtMs: number;
  processedAtMs?: number;
  repeatedFromId?: string;
};
type AnnouncementList = { items: Announcement[] };

export default function AnnouncementsPage() {
  const { reviewer, checked } = useReviewerSession();
  const [items, setItems] = useState<Announcement[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<Audience>('all');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await callFunction<{ action: 'read' }, AnnouncementList>(
        firebaseClients(),
        'manageAdminAnnouncements',
        { action: 'read' },
      );
      setItems(result.items ?? []);
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!reviewer?.admin) return;
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [reviewer?.admin, refresh]);

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      await callFunction(firebaseClients(), 'manageAdminAnnouncements', {
        action: 'publish', title: title.trim(), body: body.trim(), audience,
      });
      setTitle('');
      setBody('');
      setNotice('Announcement queued. Delivery is starting; opted-in devices receive a push and all active accounts get an in-app inbox item.');
      await refresh();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setSending(false);
    }
  }

  async function runAction(action: 'repeat' | 'withdraw', item: Announcement) {
    if (action === 'withdraw' && !window.confirm('Remove this announcement from DrivX app inboxes? A push already shown by the phone cannot be recalled.')) return;
    setActionId(item.id);
    setError(null);
    setNotice(null);
    try {
      await callFunction(firebaseClients(), 'manageAdminAnnouncements', { action, announcementId: item.id });
      setNotice(action === 'repeat'
        ? 'A fresh send has been queued for the same audience.'
        : 'Removed from DrivX app inboxes. A push already delivered to a phone cannot be recalled.');
      await refresh();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setActionId(null);
    }
  }

  const links = [
    { href: '/', label: 'Overview' },
    { href: '/bookings', label: 'Bookings & dispatch' },
    { href: '/verification', label: 'Driver reviews' },
    { href: '/dues', label: 'Earnings & dues' },
    { href: '/pricing', label: 'Fare settings' },
    { href: '/rewards', label: 'Rewards & loyalty' },
    { href: '/announcements', label: 'Push notifications' },
  ];

  return <StaffGate checked={checked} reviewer={reviewer} claim="admin" signInHeading="Admin sign-in" signInBlurb="Only the DrivX administrator can send customer and driver announcements.">
    {(signedIn) => <>
      <ConsoleHeader title="Push notifications" blurb="Send an announcement to customer and driver app inboxes." reviewer={signedIn} links={links} />
      <main className="console-content mx-auto w-full max-w-6xl px-5 py-7 sm:px-8">
        {notice ? <div role="status" className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">{notice}</div> : null}
        {error ? <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">{error}</div> : null}

        <section className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">Customer + Captain apps</p><h2 className="mt-2 text-xl font-bold">Compose announcement</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-ink-muted">The message is saved to each recipient’s DrivX notification inbox. A device push is sent where notification permission and a valid device token are available.</p></div>
            <span className="rounded-full border border-line bg-surface-muted px-3 py-1.5 text-xs font-semibold text-ink-muted">Admin only · audited</span>
          </div>
          <form onSubmit={(event) => void publish(event)} className="mt-5 grid gap-4">
            <label className="grid gap-1.5 text-sm font-semibold text-ink-muted">Audience
              <select value={audience} onChange={(event) => setAudience(event.target.value as Audience)} className="min-h-11 rounded-control border border-line bg-surface px-3 text-ink">
                <option value="all">All active customers and drivers</option>
                <option value="customers">Customers</option>
                <option value="drivers">Drivers</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-semibold text-ink-muted">Notification title <span className="font-normal">{title.length}/80</span>
              <input required maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="For example: A new offer for your next trip" className="min-h-11 rounded-control border border-line bg-surface px-3 text-ink placeholder:text-ink-faint" />
            </label>
            <label className="grid gap-1.5 text-sm font-semibold text-ink-muted">Message <span className="font-normal">{body.length}/500</span>
              <textarea required maxLength={500} rows={4} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Write the update customers or drivers will see in the app." className="rounded-control border border-line bg-surface px-3 py-2 text-ink placeholder:text-ink-faint" />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <button disabled={sending || !title.trim() || !body.trim()} className="rounded-control bg-accent px-5 py-3 text-sm font-bold text-ink-on-brand disabled:cursor-not-allowed disabled:opacity-50">{sending ? 'Sending…' : 'Send announcement'}</button>
              <p className="text-xs text-ink-faint">Push delivery depends on device permissions and network availability.</p>
            </div>
          </form>
        </section>

        <section className="mt-5 overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6"><div><h2 className="font-bold">Recent announcements</h2><p className="mt-1 text-sm text-ink-muted">Most recent 50. Sent count means the in-app inbox item was stored.</p></div><button type="button" onClick={() => void refresh()} disabled={loading} className="rounded-control border border-line px-3 py-2 text-sm font-semibold disabled:opacity-50">{loading ? 'Refreshing…' : 'Refresh'}</button></div>
          {items.length === 0 ? <p className="px-5 py-10 text-center text-sm text-ink-muted">{loading ? 'Loading announcements…' : 'No announcements yet.'}</p> : <div className="divide-y divide-line">{items.map((item) => <article key={item.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[1fr_auto] sm:items-center"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{item.title}</h3><span className="rounded-full bg-accent-soft px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-accent">{item.status}</span></div><p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-muted">{item.body}</p><p className="mt-2 text-xs text-ink-faint">{item.audience} · {stamp(Number.isFinite(item.createdAtMs) ? item.createdAtMs : null)}{item.repeatedFromId ? ` · repeated from ${item.repeatedFromId}` : ''}</p></div><div className="flex flex-wrap items-center gap-2"><p className="mr-2 text-sm font-semibold text-ink-muted">{item.status === 'sent' ? `${item.recipientCount} inboxes` : item.status === 'withdrawn' ? 'Removed' : 'Queued'}</p><button type="button" disabled={actionId !== null || item.status === 'withdrawn'} onClick={() => void runAction('repeat', item)} className="rounded-control border border-line px-3 py-2 text-xs font-semibold disabled:opacity-50">{actionId === item.id ? 'Working…' : 'Repeat send'}</button><button type="button" disabled={actionId !== null || item.status === 'withdrawn'} onClick={() => void runAction('withdraw', item)} className="rounded-control border border-line px-3 py-2 text-xs font-semibold text-badge-danger disabled:opacity-50">Remove</button></div></article>)}</div>}
        </section>
      </main>
    </>}
  </StaffGate>;
}
