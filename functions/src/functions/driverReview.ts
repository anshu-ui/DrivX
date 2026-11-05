import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { db, readDoc, serverTimestamp } from '../lib/admin';
import { REGION } from '../lib/config';
import { ensureOnboardingDue } from '../lib/dues';

/**
 * Puts a driver's paperwork in front of the office.
 *
 * A driver cannot promote their own profile — the rules hold
 * `verificationStatus` for the reviewer — so after an upload the profile still
 * reads `not_started` and nothing lists it for review. This is the server
 * noticing, and it is deliberately one-directional: it only ever moves a profile
 * that has not been decided yet into `pending_review`.
 *
 * An approved driver renewing one document keeps their profile approved, so they
 * are not locked out of duty by their own paperwork. The renewed document still
 * sits at `pending_review`, and the reviewer sees it as soon as the profile is
 * opened; `documentsExpiringBeforeMs` is what pushes a renewal, not this trigger.
 */

/** Profile states in which a filing is a first submission, not a renewal. */
const UNDECIDED = ['not_started', 'rejected'];

export async function queueDriverApplicationIfReady(driverUid: string, reason: string): Promise<boolean> {
  const profile = await readDoc(`driverProfiles/${driverUid}`);
  if (!profile) return false;

  const current = String(profile.verificationStatus ?? 'not_started');
  if (!UNDECIDED.includes(current)) return false;

  const [fee, documents] = await Promise.all([
    readDoc(`driverProfiles/${driverUid}/dues/onboarding_fee`),
    db().collection(`driverProfiles/${driverUid}/documents`).get(),
  ]);
  const required = ['driver_photograph', 'photo_id', 'driving_licence'];
  const filed = new Set(documents.docs.map((row) => row.id));
  if (
    !profile.applicationSubmittedAtMs ||
    fee?.status !== 'paid' ||
    required.some((id) => !filed.has(id) || documents.docs.find((row) => row.id === id)?.get('status') !== 'pending_review')
  ) return false;

  await db().collection('driverProfiles').doc(driverUid).update({
    verificationStatus: 'pending_review',
    updatedAtMs: serverTimestamp(),
  });

  console.log(
    JSON.stringify({
      level: 'info',
      fn: 'queueDriverApplicationIfReady',
      driverUid,
      outcome: 'queued_for_review',
      from: current,
      trigger: reason,
    }),
  );
  return true;
}

async function flagForReview(driverUid: string, documentId: string, reason: string): Promise<void> {
  const profile = await readDoc(`driverProfiles/${driverUid}`);
  if (!profile) {
    console.warn(JSON.stringify({ level: 'warn', fn: reason, driverUid, documentId, outcome: 'no_profile' }));
    return;
  }
  // The first real upload creates the one-time due. Uploads and payment alone
  // do not submit an application; the driver must press Submit now.
  await ensureOnboardingDue(driverUid);
  await queueDriverApplicationIfReady(driverUid, reason);
}

export const flagDriverOnFirstUpload = onDocumentCreated(
  { region: REGION, document: 'driverProfiles/{driverUid}/documents/{documentId}', cpu: 'gcf_gen1', maxInstances: 1 },
  async (event) => {
    const { driverUid, documentId } = event.params;
    await flagForReview(driverUid, documentId, 'flagDriverOnFirstUpload');
  },
);

/**
 * A re-submission after a rejection has to come back into the queue, and the
 * create trigger cannot see it because the document already exists.
 */
export const flagDriverOnResubmission = onDocumentUpdated(
  { region: REGION, document: 'driverProfiles/{driverUid}/documents/{documentId}', cpu: 'gcf_gen1', maxInstances: 1 },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after) return;
    if (after.status !== 'pending_review' || before.status === after.status) return;
    const { driverUid, documentId } = event.params;
    await flagForReview(driverUid, documentId, 'flagDriverOnResubmission');
  },
);
