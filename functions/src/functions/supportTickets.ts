import { createHash } from 'node:crypto';
import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { CUSTOMER_CARE_CONTACTS, SUPPORT_TICKET_INBOX } from '@drivx/domain';
import { REGION, RESEND_API_KEY, RESEND_FROM_EMAIL, PUBLIC_ORIGIN } from '../lib/config';
import { db, serverTimestamp } from '../lib/admin';
import { deliverInbox } from '../lib/notify';

type Data = Record<string, unknown>;
const value = (input: unknown, fallback = ''): string => typeof input === 'string' && input.trim() ? input.trim() : fallback;
const escapeHtml = (input: string): string => input.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
const validEmail = (input: string): string | null => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ? input : null;

async function auditOnce(id: string, input: Data): Promise<void> {
  try {
    await db().doc(`adminAuditLogs/${id}`).create({ ...input, at: serverTimestamp() });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== 6 && code !== 'already-exists') throw error;
  }
}

async function requester(ticket: Data): Promise<{ email: string | null; name: string }> {
  const uid = value(ticket.openedByUid);
  if (!uid) return { email: null, name: 'DrivX user' };
  const profileCollection = ticket.forRole === 'driver' ? 'driverProfiles' : 'customerProfiles';
  const [profileSnap, userSnap] = await Promise.all([
    db().doc(`${profileCollection}/${uid}`).get(),
    db().doc(`users/${uid}`).get(),
  ]);
  const profile = (profileSnap.data() ?? {}) as Data;
  const user = (userSnap.data() ?? {}) as Data;
  return {
    email: validEmail(value(profile.email, value(user.email))),
    name: value(profile.fullName, value(user.displayName, 'DrivX user')),
  };
}

function suggestion(ticket: Data): { category: string; priority: 'normal' | 'high' | 'urgent' } {
  const content = `${value(ticket.subject)} ${value(ticket.body)}`.toLowerCase();
  if (/accident|unsafe|assault|threat|injur|emergency|police|harass/.test(content)) {
    return { category: 'emergency_follow_up', priority: 'urgent' };
  }
  if (/double charge|charged twice|payment failed|cashfree|refund|wrong charge|commission|fare|overcharg/.test(content)) {
    return { category: /fare|overcharg|commission/.test(content) ? 'fare_dispute' : 'payment', priority: 'high' };
  }
  if (/cancel|cancelled|cancellation/.test(content)) return { category: 'cancellation', priority: 'normal' };
  if (/lost|forgot|left behind|item/.test(content)) return { category: 'lost_item', priority: 'normal' };
  if (/driver|behaviour|behavior|conduct|rude/.test(content)) return { category: 'driver_conduct', priority: 'high' };
  return { category: value(ticket.category, 'trip_issue'), priority: 'normal' };
}

async function sendEmail(input: {
  idempotencyKey: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
  ticketId: string;
}): Promise<void> {
  const deliveryId = createHash('sha256').update(input.idempotencyKey).digest('hex');
  const deliveryRef = db().doc(`supportEmailEvents/${deliveryId}`);
  if ((await deliveryRef.get()).get('status') === 'sent') return;
  const apiKey = RESEND_API_KEY.value();
  const from = RESEND_FROM_EMAIL.value();
  if (!apiKey || !from) throw new Error('Support email is not configured in Firebase Secret Manager.');
  await deliveryRef.set({ ticketId: input.ticketId, recipient: input.to, status: 'sending', updatedAtMs: serverTimestamp() }, { merge: true });
  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `drivx-support-${deliveryId}`,
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
        subject: input.subject,
        html: input.html,
        text: input.text,
        tags: [{ name: 'event', value: 'support-ticket' }, { name: 'ticket', value: input.ticketId.slice(0, 32) }],
      }),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 160) : 'network_error';
    await Promise.all([
      deliveryRef.set({ status: 'failed', error: reason, updatedAtMs: serverTimestamp() }, { merge: true }),
      db().doc(`supportTickets/${input.ticketId}`).set({ lastEmailDeliveryStatus: 'failed', lastEmailRecipient: input.to, lastEmailAtMs: Date.now(), lastEmailError: reason }, { merge: true }),
    ]);
    throw error;
  }
  const result = await response.json().catch(() => ({})) as Data;
  if (!response.ok) {
    const reason = value(result.name, `http_${response.status}`);
    await Promise.all([
      deliveryRef.set({ status: 'failed', error: reason, updatedAtMs: serverTimestamp() }, { merge: true }),
      db().doc(`supportTickets/${input.ticketId}`).set({ lastEmailDeliveryStatus: 'failed', lastEmailRecipient: input.to, lastEmailAtMs: Date.now(), lastEmailError: reason }, { merge: true }),
    ]);
    throw new Error(`Resend rejected DrivX support email (${reason}).`);
  }
  await deliveryRef.set({ status: 'sent', provider: 'resend', providerEmailId: value(result.id) || null, updatedAtMs: serverTimestamp() }, { merge: true });
  await db().doc(`supportTickets/${input.ticketId}`).set({
    lastEmailDeliveryStatus: 'sent',
    lastEmailRecipient: input.to,
    lastEmailAtMs: Date.now(),
    lastEmailError: null,
  }, { merge: true });
}

function mailHtml(title: string, greeting: string, body: string, ticketId: string, role: string): string {
  const safeTitle = escapeHtml(title);
  const surface = role === 'driver' ? 'driver' : 'customer';
  return `<!doctype html><html lang="en"><body style="margin:0;background:#f5f2ed;color:#17191e;font-family:Arial,Helvetica,sans-serif;padding:24px 12px"><main style="max-width:620px;margin:auto;background:#fff;border:1px solid #e1ded8;border-radius:20px;overflow:hidden"><header style="background:#20309a;color:#fff;padding:24px 28px"><div style="font-size:12px;letter-spacing:2px;font-weight:bold">DRIVX</div><h1 style="font-size:22px;margin:16px 0 0">${safeTitle}</h1></header><section style="padding:26px 28px;line-height:1.65"><p>Hi ${escapeHtml(greeting)},</p><p>${body}</p><div style="background:#f5f2ed;border-radius:14px;padding:16px;margin:20px 0"><b>Ticket:</b> ${escapeHtml(ticketId)}<br><b>Account:</b> ${escapeHtml(role)}</div><p>Reply in the DrivX app to keep the conversation attached to this ticket.</p><p style="font-size:12px;color:#667085">${escapeHtml(CUSTOMER_CARE_CONTACTS.email)} · ${CUSTOMER_CARE_CONTACTS.phones.map((phone) => escapeHtml(phone.label)).join(' · ')}</p><a href="${escapeHtml(`${PUBLIC_ORIGIN}/${surface}/support/`)}" style="display:inline-block;background:#2563eb;color:#fff;border-radius:24px;padding:12px 20px;text-decoration:none;font-weight:bold">Open DrivX support</a></section></main></body></html>`;
}

/** Every new ticket reaches the operations inbox and is kept in the live Admin queue. */
export const notifySupportTicketCreated = onDocumentCreated(
  { region: REGION, document: 'supportTickets/{ticketId}', secrets: [RESEND_API_KEY, RESEND_FROM_EMAIL], retry: true },
  async (event) => {
    const ticket = event.data?.data() as Data | undefined;
    if (!ticket) return;
    const ticketId = event.params.ticketId;
    const suggested = suggestion(ticket);
    await db().doc(`supportTickets/${ticketId}`).set({
      suggestedCategory: suggested.category,
      suggestedPriority: suggested.priority,
      triageVersion: 1,
    }, { merge: true });
    const account = await requester(ticket);
    const reference = value(ticket.bookingReference, value(ticket.bookingId, 'Not linked'));
    const subject = `New DrivX support ticket · ${value(ticket.subject, ticketId)}`;
    const text = [
      `New support ticket ${ticketId}`,
      `From: ${account.name} (${value(ticket.forRole, 'customer')})`,
      `Booking: ${reference}`,
      `Category: ${value(ticket.category, 'trip_issue')} · suggested ${suggested.priority}/${suggested.category}`,
      '',
      value(ticket.subject),
      value(ticket.body),
      '',
      `Admin inbox: ${PUBLIC_ORIGIN}/admin/support/`,
    ].join('\n');
    const body = `A DrivX ${escapeHtml(value(ticket.forRole, 'customer'))} opened a support ticket. The original message is below.<blockquote style="white-space:pre-wrap;border-left:3px solid #2563eb;padding-left:14px;color:#344054">${escapeHtml(value(ticket.body))}</blockquote><p><b>Subject:</b> ${escapeHtml(value(ticket.subject))}<br><b>Booking:</b> ${escapeHtml(reference)}<br><b>Suggested triage:</b> ${escapeHtml(suggested.priority)} · ${escapeHtml(suggested.category)}</p><p><a href="${escapeHtml(`${PUBLIC_ORIGIN}/admin/support/`)}" style="color:#2563eb">Open the Admin support inbox</a></p>`;
    await sendEmail({
      idempotencyKey: `ticket-opened:${event.id}`,
      to: SUPPORT_TICKET_INBOX,
      subject,
      text,
      html: mailHtml('New support ticket', account.name, body, ticketId, value(ticket.forRole, 'customer')),
      replyTo: account.email,
      ticketId,
    });
    await deliverInbox({
      uid: value(ticket.openedByUid),
      surface: value(ticket.forRole) === 'driver' ? 'driver' : 'customer',
      id: `support_ticket_opened_${ticketId}`,
      type: 'support_reply',
      title: 'Support ticket received',
      body: `Ticket ${ticketId} is open. DrivX support will reply in the app.`,
      route: '/support',
      bookingId: value(ticket.bookingId) || null,
    });
  },
);

/** App replies go to the support inbox; Admin replies return to the user by email and app inbox. */
export const notifySupportTicketMessage = onDocumentCreated(
  { region: REGION, document: 'supportTickets/{ticketId}/messages/{messageId}', secrets: [RESEND_API_KEY, RESEND_FROM_EMAIL], retry: true },
  async (event) => {
    const message = event.data?.data() as Data | undefined;
    if (!message) return;
    const ticketId = event.params.ticketId;
    const ticketSnap = await db().doc(`supportTickets/${ticketId}`).get();
    if (!ticketSnap.exists) return;
    const ticket = (ticketSnap.data() ?? {}) as Data;
    const role = value(message.authorRole);
    const bodyText = value(message.body);
    const ticketSubject = value(ticket.subject, ticketId);
    if (role === 'admin' || role === 'ops') {
      await auditOnce(`support_reply_${event.id}`, {
        actorUid: value(message.authorUid), actorRole: role, action: 'support_ticket_replied',
        targetType: 'support_ticket', targetId: ticketId,
        before: null, after: { messageId: event.params.messageId, status: ticket.status ?? null }, reason: null,
      });
      const target = await requester(ticket);
      const email = target.email;
      const subject = `DrivX support replied · ${ticketSubject}`;
      const supportUrl = `${PUBLIC_ORIGIN}/${ticket.forRole === 'driver' ? 'driver' : 'customer'}/support/`;
      const body = `DrivX support replied to your ticket.<blockquote style="white-space:pre-wrap;border-left:3px solid #2563eb;padding-left:14px;color:#344054">${escapeHtml(bodyText)}</blockquote><p><a href="${escapeHtml(supportUrl)}" style="color:#2563eb">Open your support ticket</a></p>`;
      if (email) await sendEmail({ idempotencyKey: `ticket-reply:${event.id}`, to: email, subject, text: `DrivX support replied to ${ticketId}:\n\n${bodyText}`, html: mailHtml('Support replied', target.name, body, ticketId, value(ticket.forRole)), ticketId });
      await deliverInbox({ uid: value(ticket.openedByUid), id: `support_reply_${event.params.messageId}`, type: 'support_reply', surface: value(ticket.forRole) === 'driver' ? 'driver' : 'customer', title: 'DrivX support replied', body: bodyText.slice(0, 180), route: '/support', bookingId: value(ticket.bookingId) || null });
      return;
    }
    const author = await requester({ openedByUid: message.authorUid, forRole: role });
    if (ticket.status === 'awaiting_customer') {
      await db().doc(`supportTickets/${ticketId}`).set({
        status: 'in_progress', updatedAtMs: Date.now(),
        lastAdminActionByUid: 'system', lastAdminActionByRole: 'system', lastAdminActionNote: 'Customer replied to the ticket.',
      }, { merge: true });
    }
    const reference = value(ticket.bookingReference, value(ticket.bookingId, 'Not linked'));
    const subject = `DrivX support reply · ${ticketSubject}`;
    const text = `Reply on ticket ${ticketId} from ${author.name} (${role})\nBooking: ${reference}\n\n${bodyText}\n\n${PUBLIC_ORIGIN}/admin/support/`;
    const body = `A user replied to an open DrivX support ticket.<blockquote style="white-space:pre-wrap;border-left:3px solid #2563eb;padding-left:14px;color:#344054">${escapeHtml(bodyText)}</blockquote><p><b>Booking:</b> ${escapeHtml(reference)}</p><p><a href="${escapeHtml(`${PUBLIC_ORIGIN}/admin/support/`)}" style="color:#2563eb">Reply in the Admin support inbox</a></p>`;
    await sendEmail({ idempotencyKey: `ticket-user-reply:${event.id}`, to: SUPPORT_TICKET_INBOX, subject, text, html: mailHtml('Customer replied', author.name, body, ticketId, role), replyTo: author.email, ticketId });
  },
);

/** Status changes are visible in the app; closing/resolving also sends one email update. */
export const notifySupportTicketStatusChanged = onDocumentUpdated(
  { region: REGION, document: 'supportTickets/{ticketId}', secrets: [RESEND_API_KEY, RESEND_FROM_EMAIL], retry: true },
  async (event) => {
    const before = event.data?.before.data() as Data | undefined;
    const after = event.data?.after.data() as Data | undefined;
    if (!before || !after || before.status === after.status) return;
    const ticketId = event.params.ticketId;
    const status = value(after.status);
    const statusLabel = status.replace(/_/g, ' ');
    const actorRole = value(after.lastAdminActionByRole);
    const actorUid = value(after.lastAdminActionByUid);
    await auditOnce(`support_status_${event.id}`, {
      actorUid: actorUid || 'system',
      actorRole: actorRole === 'ops' ? 'ops' : actorRole === 'admin' ? 'admin' : 'system',
      action: 'support_ticket_status_changed', targetType: 'support_ticket', targetId: ticketId,
      before: { status: before.status ?? null }, after: { status: after.status ?? null, resolution: after.resolution ?? null },
      reason: value(after.lastAdminActionNote) || null,
    });
    await deliverInbox({
      uid: value(after.openedByUid),
      surface: value(after.forRole) === 'driver' ? 'driver' : 'customer',
      id: `support_status_${ticketId}_${value(after.updatedAtMs, event.id)}`,
      type: 'support_reply',
      title: `Support ticket ${statusLabel}`,
      body: `Ticket ${ticketId} is now ${statusLabel}.${value(after.resolution) ? ` ${value(after.resolution)}` : ''}`,
      route: '/support',
      bookingId: value(after.bookingId) || null,
    });
    if (status !== 'resolved' && status !== 'closed') return;
    const target = await requester(after);
    if (!target.email) return;
    const note = value(after.resolution, `Your support ticket is now ${statusLabel}.`);
    await sendEmail({
      idempotencyKey: `ticket-status:${event.id}`,
      to: target.email,
      subject: `DrivX support update · ${value(after.subject, ticketId)}`,
      text: `Your DrivX support ticket ${ticketId} is now ${statusLabel}.\n\n${note}`,
      html: mailHtml(`Ticket ${statusLabel}`, target.name, `<p>${escapeHtml(note)}</p>`, ticketId, value(after.forRole)),
      ticketId,
    });
  },
);
