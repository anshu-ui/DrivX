/**
 * Exercises completed-trip invoice creation, email idempotency, and admin ZIP export
 * against the local Firebase emulators. Resend is mocked; no real email is sent.
 *
 *   npm run emulators
 *   npm run verify:trip-invoices
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const projectId = 'demo-drivx-invoice-test';
const host = process.env.FIREBASE_EMULATOR_HOST ?? '127.0.0.1';
const firestorePort = Number(process.env.FIRESTORE_EMULATOR_PORT ?? 8080);
const storagePort = Number(process.env.STORAGE_EMULATOR_PORT ?? 9199);
process.env.GCLOUD_PROJECT = projectId;
process.env.GCP_PROJECT = projectId;
process.env.FIRESTORE_EMULATOR_HOST = `${host}:${firestorePort}`;
process.env.FIREBASE_STORAGE_EMULATOR_HOST = `${host}:${storagePort}`;
process.env.RESEND_API_KEY = 'local-invoice-test-key';
process.env.RESEND_FROM_EMAIL = 'invoices@example.test';

const resendRequests = [];
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith('https://api.resend.com/emails')) return nativeFetch(input, init);
  const payload = JSON.parse(String(init?.body ?? '{}'));
  resendRequests.push(payload);
  assert.equal(payload.attachments?.length, 1, 'invoice email must include exactly one PDF');
  assert.equal(payload.attachments[0].content_type, 'application/pdf');
  return new Response(JSON.stringify({ id: `local-email-${resendRequests.length}` }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

const { initializeApp, deleteApp } = await import('firebase-admin/app');
const app = initializeApp({ projectId, storageBucket: `${projectId}.appspot.com` });
const {
  sendTripCompletionInvoices,
  getTripInvoiceDownloadUrlForCaller,
  getTripInvoiceArchiveForCaller,
} = await import('../functions/lib/lib/tripInvoices.js');
const { getFirestore } = await import('firebase-admin/firestore');
const { getStorage } = await import('firebase-admin/storage');
const db = getFirestore(app);
const bucket = getStorage(app).bucket();
const storageFilePrototype = Object.getPrototypeOf(bucket.file('trip-invoices/audit-placeholder'));
storageFilePrototype.getSignedUrl = async function () { return [`https://storage.example.test/${this.name}`, {}]; };
const saveStorageFile = storageFilePrototype.save;
const bookingId = `invoice-audit-${randomUUID()}`;
const customerUid = `invoice-customer-${randomUUID()}`;
const driverUid = `invoice-driver-${randomUUID()}`;
const customerEmail = `${customerUid}@example.test`;
const driverEmail = `${driverUid}@example.test`;
const customerPath = `trip-invoices/${bookingId}`;
const issuer = { businessName: 'DrivX Test Private Limited', gstin: '07ABCDE1234F1Z5', address: 'New Delhi, India' };
const fare = {
  currency: 'INR',
  items: [{ key: 'slab_fare', label: 'Trip fare', amountPaise: 100_000 }],
  subtotalPaise: 100_000,
  taxPaise: 5_000,
  totalPaise: 105_000,
};
const booking = {
  status: 'completed',
  customerUid,
  assignedDriverUid: driverUid,
  reference: 'DRX-AUDIT1',
  pickup: { label: 'Connaught Place, New Delhi' },
  destination: { label: 'India Gate, New Delhi' },
  scheduledForMs: Date.now(),
  tripStartedAtMs: Date.now() - 3_600_000,
  completedAtMs: Date.now(),
  actualDistanceMeters: 18_500,
  actualDurationSeconds: 3_600,
  serviceTypeId: 'chauffeur_own_car',
  customerTaxDetails: { businessName: 'Audit Buyer Pvt Ltd', gstin: '07AABCU9603R1ZM' },
  driver: { vehicle: { make: 'Toyota', model: 'Innova', plate: 'DL01AB1234' } },
  finalFare: fare,
  commission: {
    rate: 0.13,
    gstRate: 0.18,
    fareTaxRate: 0.05,
    fareTaxPaise: 5_000,
    tdsRate: 0.01,
    tdsBasePaise: 87_000,
    tdsPaise: 870,
    commissionablePaise: 100_000,
    basePaise: 13_000,
    gstPaise: 2_340,
    totalPaise: 21_210,
  },
};

try {
  await Promise.all([
    db.doc(`bookings/${bookingId}`).set({ customerUid, assignedDriverUid: driverUid, status: 'completed' }),
    db.doc(`customerProfiles/${customerUid}`).set({ fullName: 'Invoice Customer', email: customerEmail }),
    db.doc(`users/${customerUid}`).set({ displayName: 'Invoice Customer', email: customerEmail }),
    db.doc(`driverProfiles/${driverUid}`).set({ fullName: 'Invoice Driver', email: driverEmail }),
    db.doc(`users/${driverUid}`).set({ displayName: 'Invoice Driver', email: driverEmail }),
    db.doc('appConfig/invoice').set(issuer),
  ]);

  storageFilePrototype.save = async function () { throw new Error('simulated temporary storage failure'); };
  try {
    await assert.rejects(() => sendTripCompletionInvoices(bookingId, booking), /simulated temporary storage failure/);
  } finally {
    storageFilePrototype.save = saveStorageFile;
  }
  const pendingInvoice = await db.doc(`tripInvoices/${bookingId}`).get();
  assert.equal(pendingInvoice.get('pdfStatus'), 'pending', 'a storage failure leaves a recoverable invoice row');
  assert.equal(pendingInvoice.get('customer.emailStatus'), 'pending');
  assert.match(pendingInvoice.get('customer.storagePath'), /^trip-invoices\//);
  await assert.rejects(
    () => getTripInvoiceDownloadUrlForCaller({ uid: customerUid, claims: { admin: false, ops: false } }, { bookingId, side: 'customer' }),
    /still being prepared/,
  );

  await sendTripCompletionInvoices(bookingId, booking);
  const invoiceRef = db.doc(`tripInvoices/${bookingId}`);
  const first = await invoiceRef.get();
  assert.ok(first.exists, 'invoice record is created for the completed booking');
  const invoice = first.data();
  assert.match(invoice.customerInvoiceNumber, /^DRX-C-\d{2}-\d{2}-\d{6}$/);
  assert.match(invoice.driverInvoiceNumber, /^DRX-D-\d{2}-\d{2}-\d{6}$/);
  assert.equal(invoice.customerEmail, customerEmail);
  assert.equal(invoice.driverEmail, driverEmail);
  assert.equal(invoice.customerTaxDetails.businessName, 'Audit Buyer Pvt Ltd');
  assert.equal(invoice.issuer.businessName, issuer.businessName);
  assert.equal(invoice.settlement.totalDuePaise, 21_210);
  assert.equal(invoice.pdfStatus, 'ready');
  assert.equal(invoice.emailStatus, 'sent');
  assert.equal(resendRequests.length, 2, 'one customer and one driver email are sent');
  assert.notEqual(resendRequests[0].to[0], resendRequests[1].to[0]);
  const customerEmailMessage = resendRequests.find((message) => message.tags?.some((tag) => tag.value === 'trip-invoice-customer'));
  const driverEmailMessage = resendRequests.find((message) => message.tags?.some((tag) => tag.value === 'trip-invoice-driver'));
  assert.equal(customerEmailMessage?.to[0], customerEmail, 'customer invoice email goes to the customer');
  assert.match(customerEmailMessage?.html ?? '', /CUSTOMER TRIP INVOICE/);
  assert.equal(driverEmailMessage?.to[0], driverEmail, 'driver settlement email goes to the driver');
  assert.match(driverEmailMessage?.html ?? '', /DRIVER SETTLEMENT/);

  const customerDownload = await getTripInvoiceDownloadUrlForCaller({ uid: customerUid, claims: { admin: false, ops: false } }, { bookingId, side: 'customer' });
  const driverDownload = await getTripInvoiceDownloadUrlForCaller({ uid: driverUid, claims: { admin: false, ops: false } }, { bookingId, side: 'driver' });
  assert.match(customerDownload.url, /trip-invoices/);
  assert.match(driverDownload.url, /trip-invoices/);
  await assert.rejects(() => getTripInvoiceDownloadUrlForCaller({ uid: 'other-user', claims: { admin: false, ops: false } }, { bookingId, side: 'customer' }), /only download your own/);

  for (const side of ['customer', 'driver']) {
    const stored = await bucket.file(invoice[side].storagePath).download();
    const pdf = stored[0];
    assert.ok(pdf.subarray(0, 8).toString('ascii').startsWith('%PDF-1.4'), `${side} PDF has a valid PDF header`);
    const body = pdf.toString('latin1');
    assert.ok(body.includes(side === 'customer' ? 'CUSTOMER TRIP INVOICE' : 'DRIVER SETTLEMENT INVOICE'));
    assert.ok(body.includes('DRX-AUDIT1'), `${side} PDF contains the booking reference`);
    assert.ok(body.includes(bookingId), `${side} PDF contains the booking ID`);
    assert.ok(body.includes('07ABCDE1234F1Z5'), `${side} PDF contains the configured issuer GSTIN`);
    assert.ok(body.includes('Connaught Place') && body.includes('India Gate'), `${side} PDF contains the route`);
    if (side === 'customer') assert.ok(body.includes('07AABCU9603R1ZM'), 'customer PDF includes buyer GSTIN');
    if (side === 'driver') assert.ok(body.includes('TDS 1%') && body.includes('GST on commission 18%'));
  }

  await sendTripCompletionInvoices(bookingId, booking);
  const second = await invoiceRef.get();
  assert.equal(second.data().customerInvoiceNumber, invoice.customerInvoiceNumber, 'retry reuses invoice numbers');
  assert.equal(resendRequests.length, 2, 'retry does not send duplicate emails');

  const archive = await getTripInvoiceArchiveForCaller(
    { uid: 'invoice-admin', claims: { admin: true, ops: false } },
    { side: 'customer', bookingIds: [bookingId] },
  );
  const zip = Buffer.from(archive.zipBase64, 'base64');
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'admin archive is a ZIP file');
  assert.ok(zip.includes(Buffer.from('DRX-AUDIT1')), 'archive contains the invoice PDF and trip reference');
  console.log('Invoice audit passed: separate PDFs, party details, GST/settlement rows, two emails, idempotent retry, admin ZIP export.');
} finally {
  const invoice = await db.doc(`tripInvoices/${bookingId}`).get();
  const paths = ['customer', 'driver']
    .map((side) => invoice.get(`${side}.storagePath`))
    .filter((value) => typeof value === 'string');
  await Promise.all(paths.map((storagePath) => bucket.file(storagePath).delete({ ignoreNotFound: true }).catch(() => {})));
  await Promise.all([
    db.doc(`bookings/${bookingId}`).delete().catch(() => {}),
    invoice.ref.delete().catch(() => {}),
    db.doc(`customerProfiles/${customerUid}`).delete().catch(() => {}),
    db.doc(`users/${customerUid}`).delete().catch(() => {}),
    db.doc(`driverProfiles/${driverUid}`).delete().catch(() => {}),
    db.doc(`users/${driverUid}`).delete().catch(() => {}),
    db.doc(`appConfig/invoice`).delete().catch(() => {}),
    ...['customer', 'driver'].map((side) => db.collection('emailDeliveryEvents')
      .where('bookingId', '==', bookingId).where('invoiceSide', '==', side).get()
      .then((snapshot) => Promise.all(snapshot.docs.map((row) => row.ref.delete())))),
  ]);
  await deleteApp(app);
  globalThis.fetch = nativeFetch;
}
