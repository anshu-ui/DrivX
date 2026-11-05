import { Timestamp, type FieldValue } from 'firebase/firestore';
import type { EpochMs } from '@drivx/domain';

/**
 * Timestamp translation at the persistence boundary.
 *
 * Convention: every `*Ms` field in `@drivx/domain` is stored in Firestore as
 * a native `Timestamp` written with `serverTimestamp()`, and is read back as
 * epoch milliseconds through `toEpochMs`. Domain code therefore never touches
 * the Firestore SDK, while the database still gets ordered, server-clock values.
 */

export function toEpochMs(value: unknown): EpochMs | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  // Plain { seconds, nanoseconds } objects arrive from emulator snapshots.
  const candidate = value as { seconds?: number; nanoseconds?: number };
  if (typeof candidate.seconds === 'number') {
    return candidate.seconds * 1000 + Math.floor((candidate.nanoseconds ?? 0) / 1_000_000);
  }
  return null;
}

/**
 * Strips fields the client is not allowed to author. Firestore rules reject a
 * whole write when a guarded field is present but unchanged, so the writer must
 * omit it instead of sending a sentinel.
 */
export function omitServerOwnedFields<T extends Record<string, unknown>>(
  payload: T,
  guardedKeys: readonly string[],
): Partial<T> {
  const clone: Record<string, unknown> = { ...payload };
  for (const key of guardedKeys) delete clone[key];
  return clone as Partial<T>;
}

export const SERVER_OWNED_FIELDS = [
  'createdAtMs',
  'updatedAtMs',
  'stateVersion',
  'finalFare',
  'paymentStatus',
  'status',
  'assignedDriverUid',
  'idempotencyKey',
] as const;
