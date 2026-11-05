import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';

/**
 * Function-side error vocabulary. Clients are allowed to see these codes and
 * safe messages only; internal detail stays in structured logs.
 */
export function invalidArgument(message: string): HttpsError {
  return new HttpsError('invalid-argument', message);
}

export function permissionDenied(message = 'You are not allowed to perform this action.'): HttpsError {
  return new HttpsError('permission-denied', message);
}

export function failedPrecondition(message: string): HttpsError {
  return new HttpsError('failed-precondition', message);
}

export function notFound(message: string): HttpsError {
  return new HttpsError('not-found', message);
}

export function unavailable(message: string): HttpsError {
  return new HttpsError('unavailable', message);
}

/** A throttle was hit. Distinct from a permission problem so the UI can say "wait", not "you can't". */
export function resourceExhausted(message: string): HttpsError {
  return new HttpsError('resource-exhausted', message);
}

/**
 * A phase that has not been built yet. Deliberately loud: an unimplemented
 * integration must never be papered over with a plausible-looking success.
 */
export function notImplemented(phase: string, feature: string): HttpsError {
  return new HttpsError(
    'unimplemented',
    `${feature} is not implemented yet (scheduled for ${phase}). No result was produced.`,
  );
}

/** Parses untrusted callable input, mapping failures to invalid-argument. */
export function parseInput<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
      .join('; ');
    throw invalidArgument(`Invalid request — ${detail}`);
  }
  return result.data;
}
