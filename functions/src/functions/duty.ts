import { onCall } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { COLLECTIONS, DUTY_TERMS } from '@drivx/domain';
import { db, serverTimestamp } from '../lib/admin';
import { CALLABLE_OPTIONS } from '../lib/config';
import { failedPrecondition, parseInput } from '../lib/errors';
import { requireDriver, requireDriverCaller, type Caller } from '../lib/guards';

/**
 * Driver: agree to the terms of duty.
 *
 * The owner's gate, in his words: "term agree karne ke baad hi uske paas vo
 * booking aaegi". Agreeing is what opens it, and this is a callable rather than a
 * field the app writes, because the rules refuse a driver who sets their own
 * `dutyTermsVersion` — an acceptance the driver typed in themselves is not an
 * acceptance, it is a way to walk into the queue without reading the terms.
 *
 * The client sends the version *it displayed*, and a mismatch is refused. That is
 * the only part of an agreement a server can still verify: if the office has
 * since rewritten the terms, a stale app must not be able to agree to words the
 * driver is no longer looking at. The driver gets the current lines back and
 * shows them again.
 *
 * What this does not do is approve anybody. Documents, approval and unpaid
 * commission are separate gates in dispatch and in `respondToAssignment`; this
 * one only says the person has read what duty means.
 */
const acceptInput = z.object({
  version: z.string().min(1).max(64),
});

export async function acceptDutyTermsForCaller(caller: Caller, raw: unknown) {
  requireDriverCaller(caller);
  const input = parseInput(acceptInput, raw);

  if (input.version !== DUTY_TERMS.version) {
    throw failedPrecondition(
      `The duty terms on your screen (${input.version}) are not the ones DrivX holds (${DUTY_TERMS.version}). Read the current terms and agree again.`,
    );
  }

  const now = Date.now();
  await db()
    .doc(`${COLLECTIONS.driverProfiles}/${caller.uid}`)
    .update({
      dutyTermsVersion: DUTY_TERMS.version,
      dutyTermsAcceptedAtMs: now,
      updatedAtMs: serverTimestamp(),
    });

  console.log(
    JSON.stringify({
      level: 'info',
      fn: 'acceptDutyTerms',
      outcome: 'accepted',
      actorUid: caller.uid,
      version: DUTY_TERMS.version,
    }),
  );

  return { version: DUTY_TERMS.version, acceptedAtMs: now };
}

export const acceptDutyTerms = onCall(CALLABLE_OPTIONS, async (request) =>
  acceptDutyTermsForCaller(requireDriver(request), request.data),
);
