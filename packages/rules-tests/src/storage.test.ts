import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getDownloadURL,
  getMetadata,
  list,
  ref as storageRef,
  uploadBytes,
  uploadString,
} from 'firebase/storage';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  ADMIN_UID,
  BOOKING_ONE,
  BUCKET_URL,
  CUSTOMER_ONE,
  CUSTOMER_TWO,
  DRIVER_ONE,
  DRIVER_TWO,
  OPS_UID,
  createTestEnvironment,
  ctxFor,
  expectAllowed,
  expectDenied,
  purgeRunData,
  seedViaServer,
  type TestRole,
} from './helpers';
import { seedStorage } from './seed';

let env: RulesTestEnvironment;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

beforeAll(async () => {
  env = await createTestEnvironment();
  await seedViaServer(env, seedStorage);
});

afterAll(async () => {
  // beforeAll throws when the emulator is absent, leaving env unset.
  if (!env) return;
  // The Storage rules read the driver's Firestore profile, so this file seeds that
  // store as well; the sweep clears it for the next file to re-seed.
  await purgeRunData();
  await env.cleanup();
});

function bucket(uid: string, role: TestRole) {
  return ctxFor(env, uid, role).storage(BUCKET_URL);
}

describe('driver documents', () => {
  it('lets the owner upload their own paperwork to their private path', async () => {
    const storage = bucket(DRIVER_ONE, 'driver');
    const object = storageRef(storage, `drivers/${DRIVER_ONE}/doc-10`);
    await expectAllowed(uploadString(object, 'ZmFrZS1ieXRlcy1mb3ItcmVhdGluZw==', 'base64', { contentType: 'image/png' }));
    await expectAllowed(uploadBytes(object, PNG, { contentType: 'application/pdf' }));
  });

  it('refuses a driver writing into another driver’s folder', async () => {
    const storage = bucket(DRIVER_TWO, 'driver');
    await expectDenied(
      uploadString(storageRef(storage, `drivers/${DRIVER_ONE}/forged`), 'x', 'raw', { contentType: 'image/png' }),
    );
  });

  it('refuses a customer touching the documents tree at all', async () => {
    const storage = bucket(CUSTOMER_ONE, 'customer');
    await expectDenied(
      uploadString(storageRef(storage, `drivers/${CUSTOMER_ONE}/anything`), 'x', 'raw', { contentType: 'image/png' }),
    );
  });

  it('lets the same number file paperwork once it also holds the driver role', async () => {
    // A customer who signs up to drive on the number they already book with is
    // the owner's rule, and their own folder is theirs to write in.
    const storage = bucket(CUSTOMER_ONE, 'dual');
    await expectAllowed(
      uploadString(storageRef(storage, `drivers/${CUSTOMER_ONE}/dual-doc`), 'x', 'raw', {
        contentType: 'image/png',
      }),
    );
  });

  it('refuses an anonymous upload', async () => {
    const storage = env.unauthenticatedContext().storage(BUCKET_URL);
    await expectDenied(
      uploadString(storageRef(storage, `drivers/${DRIVER_ONE}/anon`), 'x', 'raw', { contentType: 'image/png' }),
    );
  });

  it('rejects content types that a browser would execute', async () => {
    const storage = bucket(DRIVER_ONE, 'driver');
    await expectDenied(
      uploadString(storageRef(storage, `drivers/${DRIVER_ONE}/page`), '<h1>hi</h1>', 'raw', { contentType: 'text/html' }),
    );
    await expectDenied(
      uploadString(storageRef(storage, `drivers/${DRIVER_ONE}/script`), 'alert(1)', 'raw', {
        contentType: 'application/javascript',
      }),
    );
    await expectDenied(
      uploadString(storageRef(storage, `drivers/${DRIVER_ONE}/notes`), 'plain text', 'raw', {
        contentType: 'text/plain',
      }),
    );
  });

  it('shows a document only to its owner and to reviewing staff', async () => {
    const path = `drivers/${DRIVER_ONE}/doc-1`;
    // The emulator percent-encodes the object name in the download URL.
    const url = decodeURIComponent(await expectAllowed(getDownloadURL(storageRef(bucket(DRIVER_ONE, 'driver'), path))));
    expect(url).toContain(`/o/${path}`);
    await expectAllowed(getMetadata(storageRef(bucket(OPS_UID, 'ops'), path)));
    await expectAllowed(getMetadata(storageRef(bucket(ADMIN_UID, 'admin'), path)));
    await expectDenied(getMetadata(storageRef(bucket(DRIVER_TWO, 'driver'), path)));
    await expectDenied(getMetadata(storageRef(bucket(CUSTOMER_ONE, 'customer'), path)));
    await expectDenied(getMetadata(storageRef(env.unauthenticatedContext().storage(BUCKET_URL), path)));
  });

  it('refuses a customer listing another driver’s folder', async () => {
    await expectAllowed(list(storageRef(bucket(DRIVER_ONE, 'driver'), `drivers/${DRIVER_ONE}`)));
    await expectDenied(list(storageRef(bucket(CUSTOMER_TWO, 'customer'), `drivers/${DRIVER_ONE}`)));
  });
});

describe('avatars', () => {
  it('are written only by the account they belong to', async () => {
    await expectAllowed(
      uploadBytes(
        storageRef(bucket(DRIVER_ONE, 'driver'), `avatars/${DRIVER_ONE}/photo.png`),
        PNG,
        { contentType: 'image/png' },
      ),
    );
    await expectDenied(
      uploadBytes(
        storageRef(bucket(CUSTOMER_ONE, 'customer'), `avatars/${DRIVER_ONE}/photo.png`),
        PNG,
        { contentType: 'image/png' },
      ),
    );
  });

  it('are readable by any signed-in user, because the counterparty must see them', async () => {
    const path = `avatars/${DRIVER_ONE}/photo.png`;
    expect(await expectAllowed(getDownloadURL(storageRef(bucket(CUSTOMER_TWO, 'customer'), path)))).toContain('photo.png');
    await expectDenied(getDownloadURL(storageRef(env.unauthenticatedContext().storage(BUCKET_URL), path)));
  });
});

describe('trip traces', () => {
  it('stay closed to drivers and customers', async () => {
    const path = `trip-traces/${BOOKING_ONE}/trace.json`;
    await expectAllowed(getMetadata(storageRef(bucket(OPS_UID, 'ops'), path)));
    await expectAllowed(getMetadata(storageRef(bucket(ADMIN_UID, 'admin'), path)));
    await expectDenied(getMetadata(storageRef(bucket(DRIVER_ONE, 'driver'), path)));
    await expectDenied(getMetadata(storageRef(bucket(CUSTOMER_ONE, 'customer'), path)));
  });

  it('have no client write path, not even for staff', async () => {
    for (const [uid, role] of [
      [DRIVER_ONE, 'driver'],
      [CUSTOMER_ONE, 'customer'],
      [ADMIN_UID, 'admin'],
      [OPS_UID, 'ops'],
    ] as const) {
      const storage = bucket(uid, role);
      await expectDenied(
        uploadBytes(storageRef(storage, `trip-traces/${BOOKING_ONE}/forged.json`), PNG, {
          contentType: 'application/json',
        }),
      );
    }
  });
});

describe('paths with no rule', () => {
  it('fail closed', async () => {
    const storage = bucket(ADMIN_UID, 'admin');
    await expectDenied(getMetadata(storageRef(storage, 'receipts/whatever.pdf')));
    await expectDenied(uploadBytes(storageRef(storage, 'receipts/whatever.pdf'), PNG, { contentType: 'application/pdf' }));
  });
});
