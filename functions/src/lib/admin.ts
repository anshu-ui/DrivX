import {
  FieldValue,
  getFirestore,
  type DocumentData,
  type Firestore,
} from 'firebase-admin/firestore';
import { getDatabase, type Database } from 'firebase-admin/database';
import { getStorage, type Storage } from 'firebase-admin/storage';
import { getFunctions } from 'firebase-admin/functions';
import { initializeApp, getApps, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';

/**
 * Admin SDK entry point.
 *
 * This is the only module that touches `firebase-admin`, and it is reachable
 * only from Cloud Functions. No client bundle imports it, so service-account
 * credentials never reach a device.
 */

let app: App | null = null;

function ensureApp(): App {
  if (app) return app;
  const defaultApp = getApps().find((candidate) => candidate.name === '[DEFAULT]');
  app = defaultApp ?? initializeApp();
  return app;
}

// Configure Firestore while the Functions module is loading, before a
// Firestore-trigger event can construct or access its snapshot references.
// Calling settings() lazily inside a handler is too late for those triggers.
const store: Firestore = (() => {
  const created = getFirestore(ensureApp());
  // Zod schemas can preserve omitted optional fields as `undefined`; Firestore
  // should skip those keys instead of rejecting the write.
  created.settings({ ignoreUndefinedProperties: true });
  return created;
})();

export const serverTimestamp = (): DocumentData => FieldValue.serverTimestamp();
export const deleteField = (): DocumentData => FieldValue.delete();
export const increment = (n: number): DocumentData => FieldValue.increment(n);

export function db(): Firestore {
  return store;
}

export function messagingAdmin(): Messaging {
  return getMessaging(ensureApp());
}

export function rtdb(): Database {
  return getDatabase(ensureApp());
}

/** Admin Auth: the only way claims change, and only from here. */
export function authAdmin(): Auth {
  return getAuth(ensureApp());
}

export function bucket(): ReturnType<Storage['bucket']> {
  return getStorage(ensureApp()).bucket();
}

export function tasks(): ReturnType<typeof getFunctions> {
  return getFunctions(ensureApp());
}

/**
 * Writes an append-only audit record. Every privileged human action in the
 * admin dashboard goes through this so the log cannot be skipped by accident.
 */
export async function writeAuditLog(input: {
  actorUid: string;
  /** `system` is a machine write — a gateway webhook, a scheduled sweep. */
  actorRole: 'admin' | 'ops' | 'driver' | 'system';
  action: string;
  targetType: string;
  targetId: string;
  before?: DocumentData | null;
  after?: DocumentData | null;
  reason?: string | null;
}): Promise<string> {
  const ref = db().collection('adminAuditLogs').doc();
  await ref.set({
    actorUid: input.actorUid,
    actorRole: input.actorRole,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason ?? null,
    at: serverTimestamp(),
  });
  return ref.id;
}

/** Document data as a plain object, or null when the path does not exist. */
export async function readDoc(path: string): Promise<DocumentData | null> {
  const snap = await db().doc(path).get();
  return snap.exists ? (snap.data() ?? null) : null;
}

/**
 * Reads a `*Ms` field back as epoch milliseconds.
 *
 * Writes go in as `serverTimestamp()` and come back as `Timestamp`, a `Date` in
 * the emulator's REST path, or a plain number in a hand-seeded document. The
 * domain types only ever speak milliseconds, so every function that compares a
 * stored time needs this one conversion rather than three.
 */
export function epochMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object' && 'toMillis' in value) {
    const millis = (value as { toMillis: () => number }).toMillis();
    return Number.isFinite(millis) ? millis : null;
  }
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}
