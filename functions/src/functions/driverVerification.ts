import { onCall } from 'firebase-functions/v2/https';
import { randomInt } from 'node:crypto';
import { FieldPath } from 'firebase-admin/firestore';
import { z } from 'zod';
import type { UserRole } from '@drivx/domain';
import { authAdmin, db, readDoc, serverTimestamp, writeAuditLog } from '../lib/admin';
import { CALLABLE_OPTIONS } from '../lib/config';
import { invalidArgument, notFound, parseInput, failedPrecondition } from '../lib/errors';
import { requireAdmin } from '../lib/guards';
import { uidSchema } from '../lib/validate';
import { outstandingDues, describeOutstanding } from '../lib/dues';

const input = z.object({
  driverUid: uidSchema,
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().min(8).max(400),
  /** Document ids released or held; approval is per-document, not blanket. */
  documentIds: z.array(z.string().min(1).max(120)).min(1).max(20),
});

/** No `O`, `I`, `0` or `1`, because this id is read aloud and typed by hand. */
const DRIVER_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * A fresh `DRV-XXXXXX`.
 *
 * Checked against the profiles that already exist rather than assumed unique:
 * the id is the number the office writes on a slip, and two drivers sharing one
 * is worse than a slow approval.
 */
async function mintDriverId(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let candidate = 'DRV-';
    for (let i = 0; i < 6; i += 1) {
      candidate += DRIVER_ID_ALPHABET[randomInt(DRIVER_ID_ALPHABET.length)];
    }
    const taken = await db()
      .collection('driverProfiles')
      .where('driverId', '==', candidate)
      .limit(1)
      .get();
    if (taken.empty) return candidate;
  }
  throw failedPrecondition('Could not mint a driver id because every candidate is already taken. Try again.');
}

/**
 * Approves or rejects the submitted driver documents.
 *
 * This is the only path to `verificationStatus: approved`, and the only place
 * `driverVerified` may appear in a claim set. Approval is transactional with
 * the document updates so a driver can never be half-approved, and the claim
 * write is followed by an audit entry naming the reviewer.
 *
 * Approval also refuses while the driver owes the platform anything, which is
 * how the one-time Admin-configured onboarding fee becomes a real gate instead of a note
 * in a document. Rejecting needs no such check: sending paperwork back never
 * takes money.
 */
export const setDriverVerification = onCall({ ...CALLABLE_OPTIONS, cpu: 'gcf_gen1', maxInstances: 1 }, async (request) => {
  const actor = requireAdmin(request);
  const data = parseInput(input, request.data);

  const profileRef = db().collection('driverProfiles').doc(data.driverUid);
  const profile = await readDoc(profileRef.path);
  if (!profile) throw notFound('No driver profile found for that account.');

  let outstanding: Awaited<ReturnType<typeof outstandingDues>> = [];
  if (data.decision === 'approved') {
    outstanding = await outstandingDues(data.driverUid);
    if (outstanding.length > 0) {
      throw failedPrecondition(
        `${describeOutstanding(outstanding)} They cannot be activated. Record the collection with ` +
          `"Money collected" first — approval is refused, not skipped.`,
      );
    }
  }

  const docsRef = profileRef.collection('documents');
  const docSnaps = await docsRef.where(FieldPath.documentId(), 'in', data.documentIds).get();
  if (docSnaps.size !== data.documentIds.length) {
    throw invalidArgument('One or more document ids do not belong to this driver.');
  }
  if (data.decision === 'approved' && profile.verificationStatus !== 'approved') {
    const required = ['driver_photograph', 'photo_id', 'driving_licence'];
    const filed = new Map(docSnaps.docs.map((document) => [document.id, document.data()]));
    if (required.some((id) => !data.documentIds.includes(id) || filed.get(id)?.status !== 'pending_review')) {
      throw failedPrecondition('Approval requires all three submitted documents to be selected and awaiting review.');
    }
  }

  const nextStatus = data.decision === 'approved' ? 'approved' : 'rejected';
  // An approved-then-rejected-then-approved driver keeps the id the office
  // already wrote on their slip; a second id would make the first one wrong.
  const existingDriverId = typeof profile.driverId === 'string' ? profile.driverId : null;
  const driverId = data.decision === 'approved' ? (existingDriverId ?? await mintDriverId()) : existingDriverId;

  await db().runTransaction(async (tx) => {
    for (const snap of docSnaps.docs) {
      tx.update(snap.ref, {
        status: nextStatus,
        reviewedAtMs: serverTimestamp(),
        reviewedByUid: actor.uid,
        rejectionNote: data.decision === 'rejected' ? data.reason : null,
      });
    }

    tx.set(
      profileRef,
      {
        verificationStatus: nextStatus,
        verifiedAtMs: data.decision === 'approved' ? serverTimestamp() : null,
        verifiedByUid: actor.uid,
        rejectionReason: data.decision === 'rejected' ? data.reason : null,
        applicationSubmittedAtMs: data.decision === 'rejected' ? null : profile.applicationSubmittedAtMs ?? null,
        driverId,
        // A rejected driver cannot be online for dispatch.
        availabilityState: data.decision === 'approved' ? profile.availabilityState : 'offline',
        updatedAtMs: serverTimestamp(),
      },
      { merge: true },
    );
  });

  const target = await authAdmin().getUser(data.driverUid);
  const heldRoles = Array.isArray(target.customClaims?.roles)
    ? (target.customClaims.roles as UserRole[])
    : [];
  await authAdmin().setCustomUserClaims(data.driverUid, {
    ...target.customClaims,
    role: 'driver',
    // Applying to drive does not cancel the customer account on the same phone
    // number, so the driver role joins the list instead of replacing it.
    roles: [...new Set([...heldRoles, 'driver' as UserRole])],
    driverVerified: data.decision === 'approved',
  });

  const auditLogId = await writeAuditLog({
    actorUid: actor.uid,
    actorRole: 'admin',
    action: data.decision === 'approved' ? 'driver_approved' : 'driver_rejected',
    targetType: 'driver',
    targetId: data.driverUid,
    before: { verificationStatus: profile.verificationStatus },
    after: { verificationStatus: nextStatus, documents: data.documentIds, driverId },
    reason: data.reason,
  });

  return {
    verificationStatus: nextStatus,
    reviewedDocuments: data.documentIds.length,
    driverSetOffline: nextStatus !== 'approved',
    /** What the office writes on the slip; null until the first approval. */
    driverId,
    auditLogId,
  };
});
