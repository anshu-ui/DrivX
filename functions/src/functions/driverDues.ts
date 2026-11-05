import { onCall } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { ATTESTABLE_DUE_METHODS, formatINR } from '@drivx/domain';
import { CALLABLE_OPTIONS } from '../lib/config';
import { requireAdmin } from '../lib/guards';
import { uidSchema, zodEnum } from '../lib/validate';
import { failedPrecondition, notFound, parseInput } from '../lib/errors';
import { db, readDoc, serverTimestamp, writeAuditLog } from '../lib/admin';
import { outstandingDues } from '../lib/dues';
import { queueDriverApplicationIfReady } from './driverReview';

const input = z.object({
  driverUid: uidSchema,
  dueId: z.string().min(1).max(64),
  method: zodEnum(ATTESTABLE_DUE_METHODS),
  reference: z.string().trim().min(3).max(120),
});

/**
 * Records money the office physically collected from a driver.
 *
 * This is the only write path that turns a due into `paid`, and it is honest
 * about what it is: an administrator attesting a cash or UPI handover, with a
 * reference they had to type and an audit entry naming them. It is *not* a
 * payment integration — a card, netbanking or wallet payment only exists once
 * the gateway confirms it, so those methods are refused here rather than
 * accepted on someone's word. Online settlement goes through Cashfree's verified
 * webhook path instead.
 */
export const recordDriverDuePayment = onCall({ ...CALLABLE_OPTIONS, cpu: 'gcf_gen1', maxInstances: 1 }, async (request) => {
  const actor = requireAdmin(request);
  const data = parseInput(input, request.data);

  const dueRef = db().doc(`driverProfiles/${data.driverUid}/dues/${data.dueId}`);
  const due = await readDoc(dueRef.path);
  if (!due) throw notFound('That driver has no charge with that id, so there is nothing to record.');
  if (due.status === 'paid') {
    throw failedPrecondition(
      `This ${formatINR(Number(due.totalPaise ?? 0))} charge was already recorded as paid${
        due.recordedByUid ? ` by ${String(due.recordedByUid)}` : ''
      }. Do not collect it twice.`,
    );
  }

  await dueRef.update({
    status: 'paid',
    method: data.method,
    reference: data.reference,
    recordedByUid: actor.uid,
    recordedAtMs: serverTimestamp(),
    updatedAtMs: serverTimestamp(),
  });

  const remaining = await outstandingDues(data.driverUid);

  if (data.dueId === 'onboarding_fee') {
    await queueDriverApplicationIfReady(data.driverUid, 'admin_recorded_payment');
  }

  const auditLogId = await writeAuditLog({
    actorUid: actor.uid,
    actorRole: 'admin',
    action: 'driver_fee_recorded',
    targetType: 'driver',
    targetId: data.driverUid,
    before: { status: 'unpaid', dueId: data.dueId },
    after: {
      status: 'paid',
      dueId: data.dueId,
      method: data.method,
      totalPaise: due.totalPaise ?? null,
    },
    reason: data.reference,
  });

  console.log(
    JSON.stringify({
      level: 'info',
      fn: 'recordDriverDuePayment',
      outcome: 'due_cleared',
      actorUid: actor.uid,
      driverUid: data.driverUid,
      dueId: data.dueId,
      method: data.method,
      outstandingDues: remaining.length,
    }),
  );

  return {
    dueId: data.dueId,
    status: 'paid' as const,
    totalPaise: Number(due.totalPaise ?? 0),
    outstandingDues: remaining.length,
    auditLogId,
  };
});
