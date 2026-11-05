import { notificationPath, type NotificationType } from '@drivx/domain';
import { createHash } from 'node:crypto';
import { getMessaging } from 'firebase-admin/messaging';
import { db, serverTimestamp } from './admin';

/**
 * One message in one customer's inbox, written by the server.
 *
 * Stores the durable in-app inbox event, then sends a best-effort FCM push to
 * the device token the user explicitly opted in on. Inbox delivery remains the
 * source of truth when a device is offline or its push permission is disabled.
 *
 * The id is passed in rather than generated, and the write is a `create`, so a
 * retried function or a trigger firing twice collides on the same document
 * instead of stacking a second copy of the same message in front of the person.
 */
export async function deliverInbox(input: {
  uid: string;
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  route: string | null;
  bookingId: string | null;
  data?: Record<string, string> | null;
}): Promise<boolean> {
  try {
    await db().doc(notificationPath(input.uid, input.id)).create({
      id: input.id,
      uid: input.uid,
      type: input.type,
      title: input.title,
      body: input.body,
      route: input.route,
      bookingId: input.bookingId,
      data: input.data ?? null,
      readAtMs: null,
      dedupeKey: input.id,
      createdAtMs: serverTimestamp(),
    });
    const accountRef = db().collection('users').doc(input.uid);
    const [account, devices] = await Promise.all([
      accountRef.get(),
      accountRef.collection('deviceTokens').get(),
    ]);
    const tokens = new Set<string>();
    const legacyToken = account.get('fcmToken');
    if (typeof legacyToken === 'string' && legacyToken.length > 20) tokens.add(legacyToken);
    for (const device of devices.docs) {
      const token = device.get('token');
      if (typeof token === 'string' && token.length > 20) tokens.add(token);
    }
    if (tokens.size) {
      try {
        const response = await getMessaging().sendEachForMulticast({
          tokens: [...tokens],
          notification: { title: input.title, body: input.body },
          data: {
            notificationId: input.id,
            ...(input.route ? { route: input.route } : {}),
            ...(input.bookingId ? { bookingId: input.bookingId } : {}),
            ...(input.data ?? {}),
          },
          android: { priority: 'high', notification: { channelId: 'bookings' } },
        });
        const stale = response.responses.flatMap((result, index) => {
          const code = result.error?.code;
          return code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token'
            ? [[...tokens][index] as string]
            : [];
        });
        if (stale.length) {
          const batch = db().batch();
          for (const token of stale) {
            const tokenId = createHash('sha256').update(token).digest('hex');
            batch.delete(accountRef.collection('deviceTokens').doc(tokenId));
            if (legacyToken === token) batch.update(accountRef, { fcmToken: null, fcmPlatform: null });
          }
          await batch.commit();
        }
        for (const result of response.responses) {
          if (result.error) console.warn(JSON.stringify({ level: 'warn', fn: 'deliverInbox', outcome: 'push_failed', uid: input.uid, code: result.error.code }));
        }
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        console.warn(JSON.stringify({ level: 'warn', fn: 'deliverInbox', outcome: 'push_failed', uid: input.uid, code: typeof code === 'string' ? code : 'unknown' }));
      }
    }
    return true;
  } catch {
    // Already filed by a racing write. The message is in the inbox either way.
    return false;
  }
}
