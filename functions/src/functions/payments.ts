import { onCall, onRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { SUBCOLLECTIONS, driverDuePath, formatINR } from '@drivx/domain';
import { parseInput, unavailable, failedPrecondition, notFound } from '../lib/errors';
import { requireDriver } from '../lib/guards';
import { CALLABLE_OPTIONS, CASHFREE_APP_ID, CASHFREE_SECRET_KEY, PROJECT_ID, PUBLIC_ORIGIN, REGION } from '../lib/config';
import { db, readDoc, serverTimestamp, writeAuditLog } from '../lib/admin';
import { queueDriverApplicationIfReady } from './driverReview';
import { ensureOnboardingDue } from '../lib/dues';
import {
  cashfreeCredentials,
  cashfreeOrderIdFor,
  createCashfreeOrder,
  dueMethodFor,
  fetchCashfreeOrder,
  fetchCashfreeOrderPayments,
  verifyCashfreeWebhook,
  type CashfreePayment,
} from '../lib/cashfree';

/**
 * Cashfree, on the one thing the owner actually collects in-app today: a
 * driver's unpaid dues.
 *
 * Two entry points, and the asymmetry between them is the whole design.
 * `createPaymentOrder` asks for money — it reads the due from the ledger, and
 * the amount the gateway is told to charge is the number *we* stored, never a
 * number the caller supplied. `paymentWebhook` is the only thing that can say
 * the money arrived, it trusts the webhook no further than an order id, and it
 * re-reads that order from Cashfree before writing `paid`.
 *
 * Nothing here marks a payment on a client's word, and nothing fakes a result
 * when the gateway is not configured: that answers `unavailable`.
 */

const orderInput = z.object({
  dueId: z.string().min(1).max(64),
});

/** `+918510840825` → `8510840825`; Cashfree wants the 10-digit national number. */
function nationalPhone(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const digits = e164.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  return digits.length === 10 ? digits : null;
}



export const createPaymentOrder = onCall(
  {
    ...CALLABLE_OPTIONS,
    // Keep this low-volume money endpoint within the project's current regional CPU quota.
    cpu: 'gcf_gen1',
    maxInstances: 1,
    secrets: [CASHFREE_APP_ID, CASHFREE_SECRET_KEY],
  },
  async (request) => {
  const caller = requireDriver(request);
  const input = parseInput(orderInput, request.data);

  // If an Admin changed the one-time fee, refresh an unpaid ledger row before
  // opening checkout. `ensureOnboardingDue` deliberately preserves a paid row
  // and refuses to rewrite the amount underneath an existing Cashfree order.
  if (input.dueId === 'onboarding_fee') await ensureOnboardingDue(caller.uid);

  const credentials = cashfreeCredentials();
  if (!credentials) {
    throw unavailable(
      'Payments are not configured. Set CASHFREE_APP_ID and CASHFREE_SECRET_KEY, then verify the merchant account.',
    );
  }

  const path = driverDuePath(caller.uid, input.dueId);
  const due = await readDoc(path);
  if (!due) {
    throw notFound('You have no charge with that id, so there is nothing to pay.');
  }
  if (due.status === 'paid') {
    throw failedPrecondition(
      `This ${formatINR(Number(due.totalPaise ?? 0))} charge is already settled${
        due.reference ? ` (${String(due.reference)})` : ''
      }. Nothing was charged.`,
    );
  }

  const amountPaise = Number(due.totalPaise ?? 0);
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw failedPrecondition(
      `This charge has no amount we can bill (${due.totalPaise}), so the gateway was not asked for anything.`,
    );
  }

  const profile = await readDoc(`driverProfiles/${caller.uid}`);
  const phone = nationalPhone((profile?.phoneE164 as string | undefined) ?? null);
  if (!phone) {
    throw failedPrecondition(
      'Your profile has no Indian mobile number for the gateway to bill, so no order was created.',
    );
  }

  const orderId = cashfreeOrderIdFor(caller.uid, input.dueId);
  const order = await createCashfreeOrder(credentials, {
    orderId,
    amountPaise,
    customerPhone: phone,
    customerEmail: (profile?.email as string | undefined) ?? null,
    customerName: (profile?.fullName as string | undefined) ?? null,
    orderNote: `DrivX ${String(due.title ?? 'charge')}`,
    orderTags: { driver_uid: caller.uid, due_id: input.dueId, customer_ref: caller.uid },
    returnUrl: `${PUBLIC_ORIGIN}/driver/documents?order_id={order_id}`,
    notifyUrl: `https://${REGION}-${PROJECT_ID}.cloudfunctions.net/paymentWebhook`,
  });

  await db().doc(path).update({
    provider: 'cashfree',
    providerOrderId: order.orderId,
    providerCfOrderId: order.cfOrderId,
    providerOrderStatus: order.orderStatus,
    providerAmountPaise: order.amountPaise,
    paymentSessionId: order.paymentSessionId,
    orderPlacedAtMs: serverTimestamp(),
    updatedAtMs: serverTimestamp(),
  });

  console.log(
    JSON.stringify({
      level: 'info',
      fn: 'createPaymentOrder',
      outcome: 'order_created',
      driverUid: caller.uid,
      dueId: input.dueId,
      orderId: order.orderId,
      amountPaise,
      orderStatus: order.orderStatus,
    }),
  );

  return {
    dueId: input.dueId,
    orderId: order.orderId,
    paymentSessionId: order.paymentSessionId,
    amountPaise,
    orderStatus: order.orderStatus,
    environment: credentials.environment,
  };
  },
);

/**
 * The gateway callback.
 *
 * It is deliberately loud about what it refuses: an unsigned request, an order
 * we never issued, a paid order whose amount does not match the charge, and a
 * row that is already settled each answer a different code and log a different
 * outcome, so a missing payment can always be traced to which gate stopped it.
 */
export const paymentWebhook = onRequest(
  {
    region: 'asia-south1',
    // This endpoint handles low-volume payment callbacks. Gen-1 CPU defaults
    // keep the Gen-2 service inside the project's current Cloud Run CPU quota;
    // webhook requests are serialized per instance, with retries handled by
    // Cashfree if a burst briefly exceeds the available instances.
    cpu: 'gcf_gen1',
    maxInstances: 1,
    timeoutSeconds: 60,
    secrets: [CASHFREE_APP_ID, CASHFREE_SECRET_KEY],
  },
  async (req, res) => {
  const credentials = cashfreeCredentials();
  if (!credentials) {
    res.status(503).type('json').send({
      error: 'payment_provider_not_configured',
      message: 'No merchant keys are set. This endpoint records nothing and changes nothing.',
    });
    return;
  }

  const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(String(req.rawBody ?? ''));
  const signature = req.header('x-webhook-signature') ?? null;
  const timestamp = req.header('x-webhook-timestamp') ?? null;

  if (!verifyCashfreeWebhook({ rawBody, signature, timestamp, secretKey: credentials.secretKey })) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        fn: 'paymentWebhook',
        outcome: 'signature_rejected',
        hasSignature: signature !== null,
        hasTimestamp: timestamp !== null,
        bytes: rawBody.length,
      }),
    );
    res.status(401).type('json').send({ error: 'invalid_signature' });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    res.status(400).type('json').send({ error: 'unparseable_payload' });
    return;
  }

  const event = String(payload.type ?? payload.event ?? '');
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const orderPayload = (data.order ?? {}) as Record<string, unknown>;
  // Cashfree's current PG webhook nests the order id at data.order.order_id;
  // retain the flat aliases for older payload versions too.
  const orderId = String(orderPayload.order_id ?? data.payment_order_id ?? data.order_id ?? '');
  if (!orderId) {
    res.status(400).type('json').send({ error: 'missing_order_id', event });
    return;
  }

  const match = await db()
    .collectionGroup(SUBCOLLECTIONS.driverDues)
    .where('providerOrderId', '==', orderId)
    .limit(1)
    .get();
  const dueDoc = match.empty ? null : match.docs[0];
  if (!dueDoc) {
    console.warn(
      JSON.stringify({ level: 'warn', fn: 'paymentWebhook', outcome: 'unknown_order', orderId, event }),
    );
    res.status(404).type('json').send({ error: 'unknown_order', orderId });
    return;
  }
  const due = dueDoc.data();
  const driverUid = String(due.driverUid ?? dueDoc.ref.parent.parent?.id ?? '');

  if (due.status === 'paid') {
    res.status(200).type('json').send({ settled: 'already', dueId: dueDoc.id });
    return;
  }

  let order;
  try {
    // The settlement rests on this fresh read from the gateway, not on the
    // notification that pointed us at the order.
    order = await fetchCashfreeOrder(credentials, orderId);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        fn: 'paymentWebhook',
        outcome: 'gateway_read_failed',
        orderId,
        reason: String((error as Error).message).slice(0, 200),
      }),
    );
    res.status(502).type('json').send({ error: 'gateway_read_failed', orderId });
    return;
  }

  if (!order) {
    res.status(404).type('json').send({ error: 'order_not_at_gateway', orderId });
    return;
  }

  await dueDoc.ref.update({ providerOrderStatus: order.orderStatus, updatedAtMs: serverTimestamp() });

  if (order.orderStatus !== 'PAID') {
    console.log(
      JSON.stringify({
        level: 'info',
        fn: 'paymentWebhook',
        outcome: 'not_paid_yet',
        orderId,
        orderStatus: order.orderStatus,
      }),
    );
    res.status(200).type('json').send({ settled: 'no', orderStatus: order.orderStatus });
    return;
  }

  // The order says the money arrived; this says how. It is a second read rather
  // than a field on the first, because Cashfree's order response carries no
  // payment at all. Failing to get it must not strand a paid driver, so the
  // settlement goes ahead and only the instrument label degrades.
  let settledPayment: CashfreePayment | null = null;
  try {
    const payments = await fetchCashfreeOrderPayments(credentials, orderId);
    settledPayment =
      payments.find((payment) => payment.status.toUpperCase() === 'SUCCESS') ?? payments.at(-1) ?? null;
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        fn: 'paymentWebhook',
        outcome: 'payment_details_unavailable',
        orderId,
        reason: String((error as Error).message).slice(0, 200),
      }),
    );
  }

  const method = dueMethodFor(settledPayment?.instrument ?? '');
  const reference = settledPayment?.paymentId ? `cashfree:${settledPayment.paymentId}` : `cashfree:${orderId}`;
  // Cashfree may retry the same event, and two deliveries can overlap. Read
  // the current ledger row inside the transaction so only one callback changes
  // unpaid -> paid and writes the corresponding audit entry.
  const settlement = await db().runTransaction(async (tx) => {
    const latestSnapshot = await tx.get(dueDoc.ref);
    if (!latestSnapshot.exists) return 'missing' as const;
    const latest = latestSnapshot.data() ?? {};
    if (latest.status === 'paid') return 'already' as const;
    if (latest.providerOrderId !== orderId) return 'order_changed' as const;
    if (order.amountPaise !== Number(latest.totalPaise)) return 'amount_mismatch' as const;

    tx.update(dueDoc.ref, {
      status: 'paid',
      method,
      reference,
      providerOrderStatus: 'PAID',
      providerPaymentId: settledPayment?.paymentId ?? null,
      settledBy: 'cashfree',
      recordedByUid: null,
      recordedAtMs: serverTimestamp(),
      updatedAtMs: serverTimestamp(),
    });
    return 'settled' as const;
  });

  if (settlement === 'already') {
    res.status(200).type('json').send({ settled: 'already', dueId: dueDoc.id });
    return;
  }
  if (settlement !== 'settled') {
    const outcome = settlement === 'amount_mismatch' ? 'amount_mismatch' : 'order_changed';
    console.error(
      JSON.stringify({
        level: 'error',
        fn: 'paymentWebhook',
        outcome,
        orderId,
        gatewayPaise: order.amountPaise,
        ledgerPaise: due.totalPaise,
      }),
    );
    res.status(409).type('json').send({
      error: outcome,
      message:
        outcome === 'amount_mismatch'
          ? 'The gateway confirmed a different amount than the ledger charges. Nothing was settled.'
          : 'The charge changed while the gateway confirmation was being processed. Nothing was settled.',
    });
    return;
  }

  const auditLogId = await writeAuditLog({
    actorUid: 'gateway:cashfree',
    actorRole: 'system',
    action: 'due_settled_by_gateway',
    targetType: 'driver',
    targetId: driverUid,
    before: { status: 'unpaid', dueId: dueDoc.id },
    after: {
      status: 'paid',
      dueId: dueDoc.id,
      method,
      totalPaise: order.amountPaise,
      reference,
    },
    reason: orderId,
  });

  if (dueDoc.id === 'onboarding_fee') {
    await queueDriverApplicationIfReady(driverUid, 'cashfree_payment_confirmed');
  }

  console.log(
    JSON.stringify({
      level: 'info',
      fn: 'paymentWebhook',
      outcome: 'due_settled',
      driverUid,
      dueId: dueDoc.id,
      orderId,
      amountPaise: order.amountPaise,
      auditLogId,
    }),
  );

  res.status(200).type('json').send({ settled: 'yes', dueId: dueDoc.id, auditLogId });
  },
);
