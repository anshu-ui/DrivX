import { createHash } from 'node:crypto';
import type { DocumentReference } from 'firebase-admin/firestore';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { notificationPath } from '@drivx/domain';
import { db, messagingAdmin, serverTimestamp } from '../lib/admin';
import { REGION } from '../lib/config';

type PushOutbox = {
  uid?: unknown;
  id?: unknown;
  surface?: unknown;
  title?: unknown;
  body?: unknown;
  route?: unknown;
  bookingId?: unknown;
  data?: unknown;
  sentTokenIds?: unknown;
  status?: unknown;
  attemptCount?: unknown;
};

function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function tokenReceiptId(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function transientMessagingError(code: string): boolean {
  return code === 'messaging/server-unavailable' || code === 'messaging/internal-error' ||
    code === 'messaging/message-rate-exceeded' || code === 'messaging/unknown-error';
}

/**
 * Delivers each durable inbox event independently from booking/email handlers.
 * Cloud Functions retries transient FCM errors; successful device tokens are
 * checkpointed so a retry does not alert those devices twice.
 */
export const deliverNotificationPush = onDocumentCreated(
  { region: REGION, document: 'notificationPushOutbox/{outboxId}', retry: true, timeoutSeconds: 60 },
  async (event) => {
    // Use the shared Firestore singleton whose settings were applied at module
    // load, before this trigger's DocumentReference is accessed.
    const firestore = db();
    const outboxRef = event.data?.ref;
    const value = event.data?.data() as PushOutbox | undefined;
    if (!outboxRef || !value) return;
    const uid = string(value.uid);
    const notificationId = string(value.id);
    const surface = string(value.surface);
    const title = string(value.title);
    const body = string(value.body);
    if (!uid || !notificationId || !surface || !title || !body) {
      await outboxRef.set({ status: 'invalid', updatedAtMs: serverTimestamp() }, { merge: true });
      console.error(JSON.stringify({ level: 'error', fn: 'deliverNotificationPush', outcome: 'invalid_outbox', outboxId: event.params.outboxId }));
      return;
    }
    const latest = (await outboxRef.get()).data() as PushOutbox | undefined;
    if (latest?.status === 'sent' || latest?.status === 'partially_sent' || latest?.status === 'no_registered_devices' || latest?.status === 'cancelled') return;

    const notificationRef = firestore.doc(notificationPath(uid, notificationId));
    if (!(await notificationRef.get()).exists) {
      await outboxRef.set({ status: 'cancelled', updatedAtMs: serverTimestamp() }, { merge: true });
      return;
    }

    const accountRef = firestore.collection('users').doc(uid);
    const [account, devices] = await Promise.all([accountRef.get(), accountRef.collection('deviceTokens').get()]);
    const tokens = new Map<string, { receiptId: string; deviceId: string | null }>();
    const legacyToken = account.get('fcmToken');
    // Untagged legacy tokens are allowed only for an all-app announcement; a
    // shared phone number must not cross-deliver customer and driver alerts.
    if (surface === 'all' && typeof legacyToken === 'string' && legacyToken.length > 20) {
      tokens.set(legacyToken, { receiptId: `legacy_${tokenReceiptId(legacyToken)}`, deviceId: null });
    }
    for (const device of devices.docs) {
      const token = device.get('token');
      if (typeof token !== 'string' || token.length < 20) continue;
      if (surface !== 'all' && device.get('surface') !== surface) continue;
      tokens.set(token, { receiptId: device.id, deviceId: device.id });
    }

    if (!tokens.size) {
      await Promise.all([
        outboxRef.set({ status: 'no_registered_devices', updatedAtMs: serverTimestamp() }, { merge: true }),
        notificationRef.set({ pushState: 'no_registered_devices', pushCheckedAtMs: Date.now() }, { merge: true }),
      ]);
      console.warn(JSON.stringify({ level: 'warn', fn: 'deliverNotificationPush', outcome: 'no_registered_devices', uid, surface, notificationId }));
      return;
    }

    const alreadySent = new Set(Array.isArray(latest?.sentTokenIds)
      ? latest.sentTokenIds.filter((item): item is string => typeof item === 'string')
      : []);
    const pending = [...tokens.entries()].filter(([, target]) => !alreadySent.has(target.receiptId));
    if (!pending.length) {
      await outboxRef.set({ status: 'sent', updatedAtMs: serverTimestamp() }, { merge: true });
      return;
    }

    const route = string(value.route);
    const bookingId = string(value.bookingId);
    const extraData = value.data && typeof value.data === 'object' && !Array.isArray(value.data)
      ? Object.fromEntries(Object.entries(value.data as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : {};
    const tokenList = pending.map(([token]) => token);
    const response = await messagingAdmin().sendEachForMulticast({
      tokens: tokenList,
      notification: { title, body },
      data: {
        notificationId,
        ...(route ? { route } : {}),
        ...(bookingId ? { bookingId } : {}),
        ...extraData,
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'drivx_trip_alerts',
          sound: 'default',
          tag: notificationId,
          icon: 'notification_icon',
          color: '#2563EB',
        },
      },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: { aps: { sound: 'default' } },
      },
      webpush: {
        headers: { Urgency: 'high' },
        notification: { icon: '/favicon.ico', tag: notificationId },
      },
    });

    const sentTokenIds = new Set(alreadySent);
    const staleDeviceRefs: DocumentReference[] = [];
    const transientCodes: string[] = [];
    const permanentCodes: string[] = [];
    response.responses.forEach((result, index) => {
      const [token, target] = pending[index]!;
      if (!result.error) {
        sentTokenIds.add(target.receiptId);
        return;
      }
      const code = result.error.code;
      console.warn(JSON.stringify({ level: 'warn', fn: 'deliverNotificationPush', outcome: 'device_delivery_failed', uid, surface, notificationId, deviceId: target.deviceId, code }));
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        if (target.deviceId) staleDeviceRefs.push(accountRef.collection('deviceTokens').doc(target.deviceId));
        if (legacyToken === token) {
          staleDeviceRefs.push(accountRef);
        }
      } else if (transientMessagingError(code)) transientCodes.push(code);
      else permanentCodes.push(code);
    });

    if (staleDeviceRefs.length) {
      const batch = db().batch();
      for (const ref of staleDeviceRefs) {
        if (ref.path === accountRef.path) batch.update(ref, { fcmToken: null, fcmPlatform: null });
        else batch.delete(ref);
      }
      await batch.commit();
    }

    const status = transientCodes.length ? 'retrying'
      : sentTokenIds.size ? (permanentCodes.length ? 'partially_sent' : 'sent')
        : 'failed';
    const update = {
      status,
      sentTokenIds: [...sentTokenIds],
      failedCodes: [...new Set(permanentCodes)],
      attemptCount: Number(latest?.attemptCount ?? 0) + 1,
      updatedAtMs: serverTimestamp(),
      ...(status === 'sent' || status === 'partially_sent' ? { sentAtMs: Date.now() } : {}),
    };
    await Promise.all([
      outboxRef.set(update, { merge: true }),
      notificationRef.set({ pushState: status, pushSentAtMs: status === 'sent' || status === 'partially_sent' ? Date.now() : null }, { merge: true }),
    ]);

    if (transientCodes.length) {
      throw new Error(`Transient push delivery failure for ${transientCodes.length} device(s).`);
    }
  },
);
