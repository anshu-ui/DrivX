import { FieldPath, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { z } from 'zod';
import { notificationPath } from '@drivx/domain';
import { db, serverTimestamp, writeAuditLog } from '../lib/admin';
import { REGION } from '../lib/config';
import { failedPrecondition, parseInput } from '../lib/errors';
import { requireAdminCaller, type Caller } from '../lib/guards';
import { deliverInbox } from '../lib/notify';

const audienceSchema = z.enum(['all', 'customers', 'drivers']);
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }),
  z.object({
    action: z.literal('publish'),
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(500),
    audience: audienceSchema,
  }),
  z.object({ action: z.literal('repeat'), announcementId: z.string().trim().min(1).max(160) }),
  z.object({ action: z.literal('withdraw'), announcementId: z.string().trim().min(1).max(160) }),
]);

type Audience = z.infer<typeof audienceSchema>;

async function audienceUids(audience: Audience): Promise<string[]> {
  const profileCollections = audience === 'all'
    ? ['customerProfiles', 'driverProfiles']
    : [audience === 'customers' ? 'customerProfiles' : 'driverProfiles'];
  const uids = new Set<string>();
  for (const collectionName of profileCollections) {
    let cursor: QueryDocumentSnapshot | null = null;
    while (true) {
      let query = db().collection(collectionName).orderBy(FieldPath.documentId()).limit(200);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      page.docs.forEach((profile) => uids.add(profile.id));
      if (page.size < 200) break;
      cursor = page.docs[page.docs.length - 1] ?? null;
    }
  }
  return [...uids];
}

async function removeInboxCopies(announcementId: string, audience: Audience): Promise<void> {
  const uids = await audienceUids(audience);
  const inboxId = `announcement_${announcementId}`;
  for (let offset = 0; offset < uids.length; offset += 400) {
    const batch = db().batch();
    for (const uid of uids.slice(offset, offset + 400)) {
      batch.delete(db().doc(notificationPath(uid, inboxId)));
    }
    await batch.commit();
  }
}

/** Admin-only announcement composer API. Every repeat creates a separately audited send. */
export async function manageAdminAnnouncementsForCaller(caller: Caller, raw: unknown) {
  requireAdminCaller(caller);
  const input = parseInput(requestSchema, raw);
  const announcements = db().collection('adminAnnouncements');

  if (input.action === 'read') {
    const snapshot = await announcements.orderBy('createdAtMs', 'desc').limit(50).get();
    return { items: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })) };
  }

  if (input.action === 'repeat') {
    const originalRef = announcements.doc(input.announcementId);
    const original = await originalRef.get();
    if (!original.exists) throw failedPrecondition('That announcement no longer exists.');
    const source = original.data() ?? {};
    if (source.status === 'withdrawn') throw failedPrecondition('A removed announcement cannot be repeated.');
    const title = typeof source.title === 'string' ? source.title : '';
    const body = typeof source.body === 'string' ? source.body : '';
    const audience = audienceSchema.safeParse(source.audience);
    if (!title || !body || !audience.success) throw failedPrecondition('That announcement cannot be repeated because its content is incomplete.');
    const ref = announcements.doc();
    const createdAtMs = Date.now();
    const record = {
      title, body, audience: audience.data, status: 'queued', actorUid: caller.uid,
      repeatedFromId: original.id, createdAtMs, createdAt: serverTimestamp(), recipientCount: 0,
    };
    await ref.create(record);
    await writeAuditLog({ actorUid: caller.uid, actorRole: 'admin', action: 'repeat_app_announcement', targetType: 'admin_announcement', targetId: ref.id, before: { repeatedFromId: original.id }, after: record });
    return { ok: true, id: ref.id, status: 'queued' as const };
  }

  if (input.action === 'withdraw') {
    const ref = announcements.doc(input.announcementId);
    const before = await ref.get();
    if (!before.exists) throw failedPrecondition('That announcement no longer exists.');
    const data = before.data() ?? {};
    const audience = audienceSchema.safeParse(data.audience);
    if (!audience.success) throw failedPrecondition('That announcement has an invalid audience.');
    await ref.set({ status: 'withdrawn', withdrawnAtMs: Date.now(), withdrawnByUid: caller.uid, withdrawnAt: serverTimestamp() }, { merge: true });
    // Removes the DrivX inbox copy. A push already displayed by the phone OS
    // cannot be recalled after FCM has delivered it.
    await removeInboxCopies(input.announcementId, audience.data);
    await writeAuditLog({ actorUid: caller.uid, actorRole: 'admin', action: 'withdraw_app_announcement', targetType: 'admin_announcement', targetId: input.announcementId, before: data, after: { status: 'withdrawn' } });
    return { ok: true, id: input.announcementId, status: 'withdrawn' as const };
  }

  if (!input.title || !input.body) throw failedPrecondition('Enter both a notification title and message.');
  const ref = announcements.doc();
  const createdAtMs = Date.now();
  const record = {
    title: input.title, body: input.body, audience: input.audience, status: 'queued',
    actorUid: caller.uid, createdAtMs, createdAt: serverTimestamp(), recipientCount: 0,
  };
  await ref.create(record);
  await writeAuditLog({ actorUid: caller.uid, actorRole: 'admin', action: 'publish_app_announcement', targetType: 'admin_announcement', targetId: ref.id, after: record });
  return { ok: true, id: ref.id, status: 'queued' as const };
}

/** Durable inbox write plus an opted-in FCM push; withdrawals clean up inbox copies. */
export const adminAnnouncementCreated = onDocumentCreated(
  { region: REGION, document: 'adminAnnouncements/{announcementId}', retry: true, timeoutSeconds: 540, memory: '512MiB' },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    const initial = snapshot.data();
    if (!initial) return;
    const audience = audienceSchema.safeParse(initial.audience);
    if (!audience.success) throw failedPrecondition('Announcement audience is invalid.');
    const targets = await audienceUids(audience.data);
    let recipientCount = 0;
    for (let offset = 0; offset < targets.length; offset += 20) {
      const current = await snapshot.ref.get();
      if (!current.exists || current.get('status') === 'withdrawn') {
        await removeInboxCopies(event.params.announcementId, audience.data);
        return;
      }
      const page = targets.slice(offset, offset + 20);
      const accountSnaps = await db().getAll(...page.map((uid) => db().collection('users').doc(uid)));
      const activeUids = page.filter((_, index) => {
        const account = accountSnaps[index];
        const status = account?.get('accountStatus');
        return account?.exists && status !== 'suspended' && status !== 'deleted' && status !== 'deletion_requested';
      });
      const results = await Promise.all(activeUids.map((uid) => deliverInbox({
        uid,
        surface: initial.audience === 'all' ? 'all' : initial.audience === 'drivers' ? 'driver' : 'customer',
        id: `announcement_${event.params.announcementId}`,
        type: 'announcement',
        title: String(initial.title),
        body: String(initial.body),
        route: null,
        bookingId: null,
        data: { announcementId: event.params.announcementId },
      })));
      recipientCount += results.filter(Boolean).length;
      const failedUids = activeUids.filter((_, index) => !results[index]);
      if (failedUids.length) {
        const inboxDocs = await db().getAll(...failedUids.map((uid) => db().doc(notificationPath(uid, `announcement_${event.params.announcementId}`))));
        if (inboxDocs.some((doc) => !doc.exists)) throw new Error('Announcement inbox delivery did not complete; retrying fan-out.');
        recipientCount += failedUids.length;
      }
    }

    const final = await snapshot.ref.get();
    if (!final.exists || final.get('status') === 'withdrawn') {
      await removeInboxCopies(event.params.announcementId, audience.data);
      return;
    }
    await snapshot.ref.set({ status: 'sent', recipientCount, processedAtMs: Date.now(), processedAt: serverTimestamp() }, { merge: true });
  },
);
