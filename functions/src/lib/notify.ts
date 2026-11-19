import { createHash } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { notificationPath, type NotificationType } from '@drivx/domain';
import { db, serverTimestamp } from './admin';

function outboxId(uid: string, surface: string, id: string): string {
  return createHash('sha256').update(`${uid}:${surface}:${id}`).digest('hex');
}

/**
 * One message in one customer's inbox, written by the server.
 *
 * Stores the durable inbox event and an independent push outbox item. The
 * outbox has its own retrying Firestore trigger, so email/network failures in a
 * booking handler cannot suppress a push or make the booking action fail.
 *
 * The stable notification id means retries and concurrent triggers resolve to
 * the same inbox/outbox pair instead of stacking duplicate alerts.
 */
export async function deliverInbox(input: {
  uid: string;
  id: string;
  type: NotificationType;
  /** Keep same-UID customer and driver sessions on their own inbox/device. */
  surface: 'customer' | 'driver' | 'admin' | 'all';
  title: string;
  body: string;
  /** Optional lock-screen-safe copy; the complete message remains in DrivX inbox. */
  pushTitle?: string;
  pushBody?: string;
  route: string | null;
  bookingId: string | null;
  data?: Record<string, string> | null;
}): Promise<boolean> {
  try {
    const inboxRef = db().doc(notificationPath(input.uid, input.id));
    const outboxRef = db().collection('notificationPushOutbox').doc(outboxId(input.uid, input.surface, input.id));
    await db().runTransaction(async (transaction) => {
      const [inbox, outbox] = await Promise.all([transaction.get(inboxRef), transaction.get(outboxRef)]);
      if (!inbox.exists) transaction.create(inboxRef, {
        id: input.id,
        uid: input.uid,
        type: input.type,
        surface: input.surface,
        title: input.title,
        body: input.body,
        route: input.route,
        bookingId: input.bookingId,
        data: input.data ?? null,
        readAtMs: null,
        dedupeKey: input.id,
        createdAtMs: serverTimestamp(),
      });
      if (!outbox.exists) transaction.create(outboxRef, {
        id: input.id,
        uid: input.uid,
        surface: input.surface,
        title: input.pushTitle ?? input.title,
        body: input.pushBody ?? input.body,
        route: input.route,
        bookingId: input.bookingId,
        data: input.data ?? null,
        status: 'queued',
        sentTokenIds: [],
        expiresAtMs: Timestamp.fromMillis(Date.now() + 30 * 86_400_000),
        createdAtMs: serverTimestamp(),
      });
    });
    return true;
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', fn: 'deliverInbox', outcome: 'inbox_outbox_write_failed', uid: input.uid, notificationId: input.id, code: (error as { code?: unknown })?.code ?? 'unknown' }));
    return false;
  }
}
