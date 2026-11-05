import { createHash, randomInt } from 'node:crypto';
import { db, increment } from './admin';
import { OTP_CONFIG } from './config';
import { permissionDenied, resourceExhausted } from './errors';

/**
 * The trip codes that prove a person was actually standing at the car.
 *
 * Two of them, on the owner's flow: a START code the customer reads out at
 * pickup and an END code they read out at the drop. The driver types each one;
 * neither is ever sent to the driver's app by the server, because a code the
 * driver can read proves nothing about where the customer was.
 *
 * What is stored is a hash, never the digits — `otpCodes` is readable by nobody
 * from a client, but a leak of a hash should not be a leak of a live code. The
 * hash covers the booking and the purpose as well as the code, so a code issued
 * for one trip cannot open another, and a start code cannot close one.
 *
 * A code is single-use and has no time limit — the owner's rule: the digits the
 * customer was shown are the digits that work, for as long as the trip is at that
 * stage. A wrong guess is counted rather than silently retried, so brute force
 * hits a wall after `maxAttempts` instead of running forever.
 */

export type TripOtpPurpose = 'trip_start' | 'trip_end';

export const tripOtpPath = (bookingId: string, purpose: TripOtpPurpose): string =>
  `otpCodes/${bookingId}_${purpose}`;

/** `sha256:<hex>` over booking, purpose and code. */
function hashCode(bookingId: string, purpose: TripOtpPurpose, code: string): string {
  return `sha256:${createHash('sha256').update(`${bookingId}|${purpose}|${code}`).digest('hex')}`;
}

/** Uniform six digits from the CSPRNG. `Math.random` is not a code generator. */
function mintCode(): string {
  const space = 10 ** OTP_CONFIG.length;
  return String(randomInt(space)).padStart(OTP_CONFIG.length, '0');
}

/**
 * The two codes for this booking, generated once and never regenerated.
 *
 * The owner's rule of 2026-10-27: "otp ek bar generate hoga system generate
 * karega booking id ke against, hum bar bar new code generate ni kar sakte."
 * So there is no issue counter and no re-issue path: the first call for a
 * booking and purpose mints the digits, every later call returns the same ones,
 * and a spent code stays spent. The document id is `{bookingId}_{purpose}`, so
 * "against the booking id" is literal — two bookings cannot share a code, and a
 * start code cannot close a trip.
 *
 * The digits are stored on the record, not only as a hash. That is the price of
 * the rule: a code the customer must be able to read tomorrow, after a phone
 * restart, has to exist somewhere the server can hand back. The mitigations that
 * remain are the ones the rules already enforce — `otpCodes` is readable by no
 * client at all, only the Admin SDK reaches it, and the callable returns the
 * digits to the booking's own customer and to nobody else. The hash is still
 * what verification compares against, so the field the driver-facing code path
 * reads never has to be the plaintext.
 */
export async function ensureTripOtp(input: {
  bookingId: string;
  purpose: TripOtpPurpose;
  actorUid: string;
}): Promise<{ code: string; minted: boolean }> {
  const ref = db().doc(tripOtpPath(input.bookingId, input.purpose));
  const now = Date.now();

  return db().runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    const record = existing.data() as Record<string, unknown> | undefined;
    const held = typeof record?.code === 'string' ? record.code : null;
    if (held) return { code: held, minted: false };

    const code = mintCode();
    tx.set(
      ref,
      {
        id: ref.id,
        bookingId: input.bookingId,
        purpose: input.purpose,
        code,
        codeHash: hashCode(input.bookingId, input.purpose, code),
        issuedAtMs: now,
        // Written as null on purpose. The owner's rule is that the code stands
        // until it is used, and there is no later write that could revise it.
        expiresAtMs: null,
        attempts: 0,
        maxAttempts: OTP_CONFIG.maxAttempts,
        consumedAtMs: null,
        lastAttemptAtMs: null,
        issuedToUid: input.actorUid,
      },
      { merge: true },
    );
    return { code, minted: true };
  });
}

/**
 * Checks a typed code and burns it.
 *
 * Every refusal path says something different on purpose: an already-used code,
 * a wrong code and a locked code are three different next actions for the person
 * standing at the car, and one message for all three sends them asking the
 * customer the same thing over and over. There is deliberately no expiry — the
 * digits the customer was shown keep working until they are used.
 *
 * The attempt counter is written *after* the transaction returns, not inside it:
 * a Firestore transaction that throws is discarded whole, so an increment made
 * next to the refusal would never reach the database — and an uncounted wrong
 * guess is a code that can be guessed at forever.
 */
export async function consumeTripOtp(input: {
  bookingId: string;
  purpose: TripOtpPurpose;
  code: string;
  actorUid: string;
}): Promise<void> {
  const ref = db().doc(tripOtpPath(input.bookingId, input.purpose));
  const now = Date.now();

  const outcome = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw permissionDenied(
        `No ${input.purpose === 'trip_start' ? 'start' : 'end'} code has been issued for this trip. Ask the customer to request one in their app.`,
      );
    }
    const record = snap.data() as Record<string, unknown>;
    if (record.consumedAtMs) throw permissionDenied('That code has already been used on this trip.');

    const attempts = Number(record.attempts ?? 0);
    const maxAttempts = Number(record.maxAttempts ?? OTP_CONFIG.maxAttempts);
    if (attempts >= maxAttempts) {
      throw resourceExhausted(
        'Too many wrong tries on this code, and a DrivX code is never reissued — the office has to confirm the digits with the customer before this trip can go on.',
      );
    }

    if (String(record.codeHash) !== hashCode(input.bookingId, input.purpose, input.code)) {
      return { result: 'wrong', triesLeft: maxAttempts - attempts - 1 } as const;
    }

    tx.update(ref, { consumedAtMs: now, verifiedByUid: input.actorUid });
    return { result: 'consumed' } as const;
  });

  if (outcome.result === 'consumed') return;

  await ref.update({ attempts: increment(1), lastAttemptAtMs: now });

  throw permissionDenied(
    `That is not the code for this trip. ${outcome.triesLeft} ${
      outcome.triesLeft === 1 ? 'try' : 'tries'
    } left before it locks.`,
  );
}
