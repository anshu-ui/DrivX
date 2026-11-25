import { createHash } from 'node:crypto';
import { bucket, db, epochMs, serverTimestamp } from './admin';
import { RESEND_API_KEY, RESEND_FROM_EMAIL } from './config';
import { CUSTOMER_CARE_CONTACTS, COMMISSION_TERMS, driverTripSplitFor, readCommissionSnapshot } from '@drivx/domain';
import type { Caller } from './guards';
import { billableCompletion, configuredCommissionTerms } from './dues';
import { failedPrecondition, invalidArgument, permissionDenied } from './errors';

type Data = Record<string, unknown>;
type InvoiceSide = 'customer' | 'driver';
type InvoiceIssuer = { businessName: string; gstin: string; address: string };

const INR = (paise: unknown): string => `INR ${(Number.isFinite(Number(paise)) ? Number(paise) / 100 : 0).toFixed(2)}`;
const text = (value: unknown, fallback = ''): string => typeof value === 'string' && value.trim() ? value.trim() : fallback;
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

function placeLabel(place: unknown): string {
  if (!place || typeof place !== 'object') return 'Not recorded';
  const row = place as Data;
  return text(row.label, [row.addressLine1, row.addressLine2, row.city, row.state]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join(', ') || 'Not recorded');
}

function dateLabel(value: unknown): string {
  const millis = epochMs(value);
  return millis === null ? 'Not recorded' : new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
  }).format(millis);
}

function financialYear(atMs: number): string {
  const istDate = new Date(atMs + 330 * 60_000);
  const year = istDate.getUTCFullYear();
  const start = istDate.getUTCMonth() >= 3 ? year : year - 1;
  return `${String(start).slice(-2)}-${String(start + 1).slice(-2)}`;
}

function cleanAscii(value: string): string {
  return value.replace(/₹/g, 'INR ').replace(/[–—]/g, '-').replace(/[“”]/g, '"').replace(/[’]/g, "'")
    .replace(/[\r\n\t]/g, ' ').replace(/[^\x20-\x7E]/g, '?');
}

function pdfString(value: string): string {
  return cleanAscii(value).replace(/[\\()]/g, '\\$&').slice(0, 150);
}

function wrapText(value: string, maxCharacters: number): string[] {
  const words = cleanAscii(value).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (word.length > maxCharacters) {
      if (line) lines.push(line);
      line = '';
      for (let offset = 0; offset < word.length; offset += maxCharacters) lines.push(word.slice(offset, offset + maxCharacters));
      continue;
    }
    if (line && `${line} ${word}`.length > maxCharacters) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function textCommand(text: string, x: number, y: number, size: number, bold: boolean, color: string): string {
  return `${color} rg BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${y} Td (${pdfString(text)}) Tj ET`;
}

/** Brand-styled, concise one-page PDF shared by both immutable trip records. */
function invoicePdf(title: string, invoiceNumber: string, invoiceDate: string, issuer: InvoiceIssuer, lines: string[]): Buffer {
  const navy = '0.059 0.09 0.165'; // #0F172A
  const blue = '0.118 0.251 0.686'; // #1E40AF
  const muted = '0.392 0.455 0.545'; // #64748B
  const border = '0.886 0.91 0.937'; // #E2E8F0
  const pale = '0.945 0.961 0.976'; // #F1F5F9
  const content = [
    `${navy} rg 0 744 595 98 re f`,
    `${blue} rg 0 739 595 5 re f`,
    textCommand('DrivX', 48, 803, 22, true, '1 1 1'),
    textCommand(title, 48, 778, 10, true, '0.87 0.90 0.96'),
    textCommand('INVOICE', 390, 810, 8, true, '0.78 0.83 0.92'),
    textCommand(invoiceNumber, 390, 794, 9, true, '1 1 1'),
    textCommand(invoiceDate, 390, 778, 8, false, '0.87 0.90 0.96'),
  ];
  let issuerY = 716;
  content.push(textCommand('ISSUED BY', 48, issuerY, 7.5, true, blue));
  issuerY -= 16;
  const issuerName = issuer.businessName || 'DrivX';
  for (const line of wrapText(issuerName, 48).slice(0, 2)) {
    content.push(textCommand(line, 48, issuerY, 11, true, navy));
    issuerY -= 13;
  }
  const legalRows = [
    ...(issuer.gstin ? [`GSTIN  ${issuer.gstin}`] : []),
    ...(issuer.address ? wrapText(issuer.address, 74).slice(0, 2) : []),
    ...(!issuer.businessName || !issuer.gstin ? ['Legal business name and GSTIN pending Admin setup'] : []),
  ];
  for (const line of legalRows) {
    content.push(textCommand(line, 48, issuerY, 7.5, false, muted));
    issuerY -= 11;
  }
  const dividerY = issuerY - 6;
  content.push(`${border} RG 0.7 w 48 ${dividerY} m 547 ${dividerY} l S`);
  let y = dividerY - 17;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      y -= 3;
      content.push(textCommand(line.slice(3).toUpperCase(), 48, y, 8, true, blue));
      content.push(`${border} RG 0.5 w 48 ${y - 5} m 547 ${y - 5} l S`);
      y -= 16;
      continue;
    }
    const [label, ...valueParts] = line.split('\t');
    const value = valueParts.join(' ');
    if (!value) continue;
    const valueLines = wrapText(value, 53);
    const rowHeight = Math.max(15, valueLines.length * 11 + 4);
    const isCustomerTotal = label === 'Customer total';
    const isDriverTotal = label === 'Total driver remittance to DrivX';
    const isNet = label === 'Driver net from customer total';
    if (isCustomerTotal || isDriverTotal || isNet) {
      const ground = isNet ? pale : navy;
      content.push(`${ground} rg 42 ${y - rowHeight + 3} 511 ${rowHeight + 5} re f`);
    }
    const labelColor = isCustomerTotal || isDriverTotal ? '1 1 1' : isNet ? navy : muted;
    const valueColor = isCustomerTotal || isDriverTotal ? '1 1 1' : navy;
    const labelLines = wrapText(label ?? '', 40);
    labelLines.forEach((part, index) => content.push(textCommand(part, 50, y - (index * 11), 8, isCustomerTotal || isDriverTotal || isNet, labelColor)));
    valueLines.forEach((part, index) => content.push(textCommand(part, 300, y - (index * 11), 8.3, isCustomerTotal || isDriverTotal || isNet, valueColor)));
    y -= rowHeight;
    if (y < 62) throw new Error('Trip invoice details exceed the one-page layout.');
  }
  content.push(`${border} RG 0.7 w 48 45 m 547 45 l S`);
  content.push(textCommand(`DrivX  |  ${CUSTOMER_CARE_CONTACTS.email}`, 48, 30, 7, false, muted));
  const stream = Buffer.from(content.join('\n'), 'binary');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'binary'), stream, Buffer.from('\nendstream', 'binary')]),
  ];
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%DrivX\n', 'binary')];
  const offsets = [0];
  let length = chunks[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const wrapped = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'binary'), Buffer.isBuffer(object) ? object : Buffer.from(object, 'binary'), Buffer.from('\nendobj\n', 'binary')]);
    chunks.push(wrapped); length += wrapped.length;
  });
  const xrefOffset = length;
  const xref = [`xref\n0 ${objects.length + 1}`, '0000000000 65535 f ', ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `), `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`];
  chunks.push(Buffer.from(`${xref.join('\n')}\n`, 'binary'));
  return Buffer.concat(chunks);
}

function tripRouteRows(trip: Data): string[] {
  const startedAt = epochMs(trip.startedAtMs);
  const completedAtMs = epochMs(trip.completedAtMs);
  const distanceMeters = Number(trip.distanceMeters ?? 0);
  const durationSeconds = Number(trip.durationSeconds ?? (startedAt === null || completedAtMs === null ? 0 : Math.max(0, (completedAtMs - startedAt) / 1000)));
  return [
    '## Trip details',
    `Pickup\t${text(trip.pickup, 'Not recorded')}`,
    `Drop-off\t${text(trip.destination, 'Not recorded')}`,
    ...(epochMs(trip.scheduledPickupAtMs) !== null ? [`Pickup time\t${dateLabel(trip.scheduledPickupAtMs)}`] : []),
    ...(startedAt !== null ? [`Trip started\t${dateLabel(startedAt)}`] : []),
    ...(completedAtMs !== null ? [`Trip completed\t${dateLabel(completedAtMs)}`] : []),
    ...(distanceMeters > 0 ? [`Distance\t${(distanceMeters / 1000).toFixed(1)} km`] : []),
    ...(durationSeconds > 0 ? [`Duration\t${Math.floor(durationSeconds / 60)} minutes`] : []),
    ...(text(trip.serviceType) ? [`Service\t${text(trip.serviceType).replaceAll('_', ' ')}`] : []),
    ...(text(trip.vehicle) ? [`Vehicle\t${text(trip.vehicle)}`] : []),
  ];
}

function fareRows(fare: Data): string[] {
  const items = Array.isArray(fare.items) ? fare.items as Data[] : [];
  const subtotalPaise = Number(fare.subtotalPaise ?? 0);
  const taxRate = subtotalPaise > 0 ? Number(fare.taxPaise ?? 0) / subtotalPaise : 0;
  return [
    '## Fare breakdown',
    ...items.map((item) => `${text(item.label, text(item.key, 'Fare item'))}\t${INR(item.amountPaise)}`),
    `Fare subtotal\t${INR(subtotalPaise)}`,
    `Fare GST ${Math.round(taxRate * 100)}%\t${INR(fare.taxPaise)}`,
    `Customer total\t${INR(fare.totalPaise)}`,
  ];
}

function invoiceEmailHtml(input: { recipient: string; title: string; invoiceNumber: string; reference: string; total: string; issuerConfigured: boolean }): string {
  const pending = input.issuerConfigured ? '' : '<p style="font-size:12px;color:#64748b">Company legal name and GSTIN are pending Admin setup.</p>';
  return `<!doctype html><html><body style="margin:0;background:#F8FAFC;font-family:Arial,sans-serif;color:#334155;padding:24px"><div style="max-width:620px;margin:auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden"><div style="background:#0F172A;border-bottom:4px solid #1E40AF;padding:22px 24px;color:#fff"><div style="font-size:22px;font-weight:bold">DrivX</div><div style="margin-top:5px;font-size:12px;color:#CBD5E1">${escapeHtml(input.title)}</div></div><div style="padding:24px"><h1 style="margin:0 0 12px;font-size:20px;color:#0F172A">Your trip invoice is ready</h1><p>Hi ${escapeHtml(input.recipient)}, your completed trip PDF is attached.</p><div style="background:#F1F5F9;border-radius:10px;padding:16px;line-height:1.8"><b>Invoice</b> ${escapeHtml(input.invoiceNumber)}<br><b>Booking</b> ${escapeHtml(input.reference)}<br><b>Total</b> ${escapeHtml(input.total)}</div>${pending}<p style="margin:20px 0 0;font-size:12px;color:#64748b">DrivX support · ${escapeHtml(CUSTOMER_CARE_CONTACTS.email)}</p></div></div></body></html>`;
}

async function reserveInvoiceNumbers(bookingId: string, invoiceData: Data, completedAtMs: number): Promise<Data> {
  const year = financialYear(completedAtMs);
  const invoiceRef = db().doc(`tripInvoices/${bookingId}`);
  return db().runTransaction(async (transaction) => {
    const existing = await transaction.get(invoiceRef);
    if (existing.exists) return existing.data() ?? {};
    const customerCounterRef = db().doc(`invoiceCounters/customer-${year}`);
    const driverCounterRef = db().doc(`invoiceCounters/driver-${year}`);
    const [customerCounter, driverCounter] = await Promise.all([
      transaction.get(customerCounterRef), transaction.get(driverCounterRef),
    ]);
    const customerSequence = Number(customerCounter.get('nextSequence') ?? 1);
    const driverSequence = Number(driverCounter.get('nextSequence') ?? 1);
    const safeSequence = (value: number) => Number.isSafeInteger(value) && value > 0 ? value : 1;
    const customerNumber = safeSequence(customerSequence);
    const driverNumber = safeSequence(driverSequence);
    const customerInvoiceNumber = `DRX-C-${year}-${String(customerNumber).padStart(6, '0')}`;
    const driverInvoiceNumber = `DRX-D-${year}-${String(driverNumber).padStart(6, '0')}`;
    transaction.set(customerCounterRef, { nextSequence: customerNumber + 1, updatedAtMs: serverTimestamp() }, { merge: true });
    transaction.set(driverCounterRef, { nextSequence: driverNumber + 1, updatedAtMs: serverTimestamp() }, { merge: true });
    transaction.create(invoiceRef, {
      ...invoiceData,
      bookingId,
      financialYear: year,
      customerInvoiceNumber,
      driverInvoiceNumber,
      createdAtMs: serverTimestamp(),
      updatedAtMs: serverTimestamp(),
      pdfStatus: 'pending',
      customerEmailStatus: 'pending',
      driverEmailStatus: 'pending',
    });
    return { ...invoiceData, customerInvoiceNumber, driverInvoiceNumber, financialYear: year };
  });
}

async function sendInvoiceEmail(input: {
  bookingId: string; side: InvoiceSide; uid: string; recipientEmail: string; recipientName: string;
  invoiceNumber: string; reference: string; totalPaise: number; pdf: Buffer; issuer: InvoiceIssuer;
}): Promise<'sent' | 'skipped'> {
  const deliveryId = createHash('sha256').update(`trip-invoice:${input.bookingId}:${input.side}`).digest('hex');
  const deliveryRef = db().doc(`emailDeliveryEvents/${deliveryId}`);
  if ((await deliveryRef.get()).get('status') === 'sent') return 'sent';
  if (!input.recipientEmail || !input.recipientEmail.includes('@')) {
    await deliveryRef.set({ bookingId: input.bookingId, invoiceSide: input.side, recipientUid: input.uid, recipient: null, status: 'skipped_missing_email', updatedAt: serverTimestamp() }, { merge: true });
    return 'skipped';
  }
  const apiKey = RESEND_API_KEY.value();
  const from = RESEND_FROM_EMAIL.value();
  if (!apiKey || !from) throw new Error('Resend is not configured for completed-trip invoices.');
  const title = input.side === 'customer' ? 'Customer trip invoice' : 'Driver trip settlement statement';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `drivx-invoice-${input.side}-${deliveryId}` },
    body: JSON.stringify({
      from,
      to: [input.recipientEmail],
      reply_to: CUSTOMER_CARE_CONTACTS.email,
      subject: `${title} · ${input.reference} · ${input.invoiceNumber}`,
      html: invoiceEmailHtml({ recipient: input.recipientName, title, invoiceNumber: input.invoiceNumber, reference: input.reference, total: INR(input.totalPaise), issuerConfigured: Boolean(input.issuer.businessName && input.issuer.gstin) }),
      text: `Hi ${input.recipientName},\n\nYour ${title.toLowerCase()} is attached.\nInvoice: ${input.invoiceNumber}\nBooking: ${input.reference}\nTotal: ${INR(input.totalPaise)}\n\nDrivX Support: ${CUSTOMER_CARE_CONTACTS.email}`,
      attachments: [{ filename: `${input.invoiceNumber}.pdf`, content: input.pdf.toString('base64'), content_type: 'application/pdf' }],
      tags: [{ name: 'event', value: `trip-invoice-${input.side}` }, { name: 'booking', value: createHash('sha256').update(input.bookingId).digest('hex').slice(0, 32) }],
    }),
  });
  const result = await response.json().catch(() => ({})) as Data;
  if (!response.ok) {
    const errorName = text(result.name, `http_${response.status}`);
    await deliveryRef.set({ bookingId: input.bookingId, invoiceSide: input.side, recipientUid: input.uid, recipient: input.recipientEmail, status: 'failed', error: errorName, updatedAt: serverTimestamp() }, { merge: true });
    throw new Error(`Resend rejected the ${input.side} trip invoice (${errorName}).`);
  }
  await deliveryRef.set({ bookingId: input.bookingId, invoiceSide: input.side, recipientUid: input.uid, recipient: input.recipientEmail, status: 'sent', provider: 'resend', providerEmailId: text(result.id) || null, updatedAt: serverTimestamp() }, { merge: true });
  return 'sent';
}

/** Reserves invoice numbers, stores both private PDFs and sends one completion email per trip participant. */
export async function sendTripCompletionInvoices(bookingId: string, booking: Data): Promise<void> {
  if (booking.status !== 'completed' || !booking.finalFare || typeof booking.finalFare !== 'object') return;
  const customerUid = text(booking.customerUid);
  const driverUid = text(booking.assignedDriverUid);
  if (!customerUid || !driverUid) return;
  const completedAtMs = epochMs(booking.completedAtMs) ?? Date.now();
  const fare = booking.finalFare as Data;
  const commissionSnapshot = readCommissionSnapshot(booking.commission);
  const fallbackTerms = commissionSnapshot ? null : await configuredCommissionTerms();
  const terms = commissionSnapshot ?? billableCompletion(booking, fallbackTerms?.rate, fallbackTerms?.gstRate, fallbackTerms?.tdsRate)?.terms ?? null;
  const split = driverTripSplitFor({
    subtotalPaise: Number(fare.subtotalPaise ?? 0) as never,
    taxPaise: Number(fare.taxPaise ?? 0) as never,
    totalPaise: Number(fare.totalPaise ?? 0) as never,
  }, terms);
  const [customerProfileSnapshot, customerUserSnapshot, driverProfileSnapshot, driverUserSnapshot, issuerSnapshot] = await Promise.all([
    db().doc(`customerProfiles/${customerUid}`).get(),
    db().doc(`users/${customerUid}`).get(),
    db().doc(`driverProfiles/${driverUid}`).get(),
    db().doc(`users/${driverUid}`).get(),
    db().doc('appConfig/invoice').get(),
  ]);
  const customer = customerProfileSnapshot.data() ?? {};
  const customerUser = customerUserSnapshot.data() ?? {};
  const driverProfile = driverProfileSnapshot.data() ?? {};
  const driverUser = driverUserSnapshot.data() ?? {};
  const issuerData = issuerSnapshot.data() ?? {};
  const issuer: InvoiceIssuer = {
    businessName: text(issuerData.businessName),
    gstin: text(issuerData.gstin).toUpperCase(),
    address: text(issuerData.address),
  };
  const customerEmail = text(customer.email, text(customerUser.email)).toLowerCase();
  const driverEmail = text(driverProfile.email, text(driverUser.email)).toLowerCase();
  const customerName = text(customer.fullName, text(customerUser.displayName));
  const driverName = text(driverProfile.fullName, text(driverUser.displayName));
  if (customerName.length < 2 || driverName.length < 2) {
    throw new Error('Customer and driver full names are required before trip invoices can be issued.');
  }
  const driverCard = booking.driver && typeof booking.driver === 'object' ? booking.driver as Data : {};
  const vehicle = driverCard.vehicle && typeof driverCard.vehicle === 'object' ? driverCard.vehicle as Data : {};
  const reference = text(booking.reference, bookingId);
  const startedAtMs = epochMs(booking.tripStartedAtMs);
  const durationSeconds = Number(booking.actualDurationSeconds ?? (startedAtMs === null ? 0 : Math.max(0, (completedAtMs - startedAtMs) / 1000)));
  const vehicleLabel = [vehicle.make, vehicle.model, vehicle.plate].map((part) => text(part)).filter(Boolean).join(' · ');
  const tripSnapshot = {
    pickup: placeLabel(booking.pickup),
    destination: placeLabel(booking.destination),
    scheduledPickupAtMs: epochMs(booking.scheduledForMs),
    startedAtMs,
    completedAtMs,
    distanceMeters: Number(booking.actualDistanceMeters ?? 0),
    durationSeconds,
    serviceType: text(booking.serviceTypeId),
    vehicle: vehicleLabel,
  };
  const fareSnapshot = {
    currency: text(fare.currency, 'INR'),
    items: (Array.isArray(fare.items) ? fare.items : []).map((item) => {
      const row = item && typeof item === 'object' ? item as Data : {};
      return { label: text(row.label, text(row.key, 'Fare item')), amountPaise: Number(row.amountPaise ?? 0) };
    }),
    subtotalPaise: Number(fare.subtotalPaise ?? 0),
    taxPaise: Number(fare.taxPaise ?? 0),
    totalPaise: Number(fare.totalPaise ?? 0),
  };
  const customerTax = booking.customerTaxDetails && typeof booking.customerTaxDetails === 'object' ? booking.customerTaxDetails as Data : {};
  const customerInvoiceData = {
    customerUid,
    driverUid,
    customerName,
    customerEmail: customerEmail || null,
    driverName,
    driverEmail: driverEmail || null,
    reference,
    completedAtMs,
    fareSubtotalPaise: fareSnapshot.subtotalPaise,
    fareTaxPaise: fareSnapshot.taxPaise,
    fareTotalPaise: fareSnapshot.totalPaise,
    fareSnapshot,
    tripSnapshot,
    commissionSnapshot: terms,
    settlement: split,
    customerTaxDetails: { businessName: text(customerTax.businessName) || null, gstin: text(customerTax.gstin).toUpperCase() || null },
    issuer: { businessName: issuer.businessName || null, gstin: issuer.gstin || null, address: issuer.address || null },
  };
  const record = await reserveInvoiceNumbers(bookingId, customerInvoiceData, completedAtMs);
  const customerInvoiceNumber = text(record.customerInvoiceNumber);
  const driverInvoiceNumber = text(record.driverInvoiceNumber);
  if (!customerInvoiceNumber || !driverInvoiceNumber) throw new Error('Trip invoice numbers could not be reserved.');
  const savedIssuer = record.issuer && typeof record.issuer === 'object' ? record.issuer as Data : {};
  const invoiceIssuer: InvoiceIssuer = {
    businessName: text(savedIssuer.businessName),
    gstin: text(savedIssuer.gstin).toUpperCase(),
    address: text(savedIssuer.address),
  };
  const savedTrip = record.tripSnapshot && typeof record.tripSnapshot === 'object' ? record.tripSnapshot as Data : tripSnapshot;
  const savedFare = record.fareSnapshot && typeof record.fareSnapshot === 'object' ? record.fareSnapshot as Data : fareSnapshot;
  const savedCustomerTax = record.customerTaxDetails && typeof record.customerTaxDetails === 'object' ? record.customerTaxDetails as Data : {};
  const savedSettlement = record.settlement && typeof record.settlement === 'object' ? record.settlement as Data : {};
  const savedTerms = record.commissionSnapshot && typeof record.commissionSnapshot === 'object' ? record.commissionSnapshot as Data : {};
  const savedCustomerName = text(record.customerName, customerName);
  const savedDriverName = text(record.driverName, driverName);
  const savedCustomerEmail = text(record.customerEmail, customerEmail).toLowerCase();
  const savedDriverEmail = text(record.driverEmail, driverEmail).toLowerCase();
  const savedReference = text(record.reference, reference);
  const savedCompletedAt = epochMs(record.completedAtMs) ?? completedAtMs;
  const normalizedTerms = {
    rate: Number(savedTerms.rate ?? COMMISSION_TERMS.rate),
    gstRate: Number(savedTerms.gstRate ?? COMMISSION_TERMS.gstRate),
    commissionablePaise: Number(savedTerms.commissionablePaise ?? 0),
    basePaise: Number(savedTerms.basePaise ?? 0),
    gstPaise: Number(savedTerms.gstPaise ?? 0),
    tdsRate: Number(savedTerms.tdsRate ?? 0),
    tdsBasePaise: Number(savedTerms.tdsBasePaise ?? 0),
    tdsPaise: Number(savedTerms.tdsPaise ?? 0),
    totalPaise: Number(savedTerms.totalPaise ?? 0),
  };
  const fareTotalPaise = Number(savedFare.totalPaise ?? record.fareTotalPaise ?? fareSnapshot.totalPaise);
  const driverRemittancePaise = Number(savedSettlement.totalDuePaise ?? normalizedTerms.totalPaise);
  const customerLines = [
    '## Booking',
    `Booking reference\t${savedReference}`,
    `Booking ID\t${bookingId}`,
    `Customer\t${savedCustomerName}`,
    `Driver\t${savedDriverName}`,
    ...(text(savedCustomerTax.businessName) || text(savedCustomerTax.gstin) ? [
      '## Customer GST details',
      ...(text(savedCustomerTax.businessName) ? [`Business name\t${text(savedCustomerTax.businessName)}`] : []),
      ...(text(savedCustomerTax.gstin) ? [`Customer GSTIN\t${text(savedCustomerTax.gstin).toUpperCase()}`] : []),
    ] : []),
    ...tripRouteRows(savedTrip),
    ...fareRows(savedFare),
  ];
  const driverLines = [
    '## Booking',
    `Booking reference\t${savedReference}`,
    `Booking ID\t${bookingId}`,
    `Driver\t${savedDriverName}`,
    `Customer\t${savedCustomerName}`,
    ...tripRouteRows(savedTrip),
    ...fareRows(savedFare),
    '## Driver settlement',
    `Commissionable fare base\t${INR(normalizedTerms.commissionablePaise)}`,
    `Commission ${Math.round(normalizedTerms.rate * 100)}%\t${INR(normalizedTerms.basePaise)}`,
    `GST on commission ${Math.round(normalizedTerms.gstRate * 100)}%\t${INR(normalizedTerms.gstPaise)}`,
    `Customer fare GST ${Math.round(Number(savedSettlement.fareTaxRate ?? 0) * 100)}% to remit\t${INR(savedSettlement.fareTaxPaise ?? savedFare.taxPaise ?? 0)}`,
    `TDS base after commission\t${INR(savedSettlement.tdsBasePaise ?? normalizedTerms.tdsBasePaise)}`,
    `TDS ${Math.round(Number(savedSettlement.tdsRate ?? normalizedTerms.tdsRate) * 100)}%\t${INR(savedSettlement.tdsPaise ?? normalizedTerms.tdsPaise)}`,
    `Total driver remittance to DrivX\t${INR(driverRemittancePaise)}`,
    `Driver net from customer total\t${INR(savedSettlement.netPaise ?? Math.max(0, fareTotalPaise - driverRemittancePaise))}`,
  ];
  const customerTitle = invoiceIssuer.businessName && invoiceIssuer.gstin ? 'CUSTOMER TRIP INVOICE' : 'CUSTOMER TRIP RECEIPT';
  const customerPdf = invoicePdf(customerTitle, customerInvoiceNumber, dateLabel(savedCompletedAt), invoiceIssuer, customerLines);
  const driverPdf = invoicePdf('DRIVER SETTLEMENT INVOICE', driverInvoiceNumber, dateLabel(savedCompletedAt), invoiceIssuer, driverLines);
  if (customerPdf.length > 5_000_000 || driverPdf.length > 5_000_000) throw new Error('Trip invoice PDF exceeded the email attachment limit.');
  const customerPath = `trip-invoices/${bookingId}/customer-${customerInvoiceNumber}.pdf`;
  const driverPath = `trip-invoices/${bookingId}/driver-${driverInvoiceNumber}.pdf`;
  await Promise.all([
    bucket().file(customerPath).save(customerPdf, { resumable: false, metadata: { contentType: 'application/pdf', cacheControl: 'private, no-store', metadata: { bookingId, invoiceSide: 'customer', invoiceNumber: customerInvoiceNumber } } }),
    bucket().file(driverPath).save(driverPdf, { resumable: false, metadata: { contentType: 'application/pdf', cacheControl: 'private, no-store', metadata: { bookingId, invoiceSide: 'driver', invoiceNumber: driverInvoiceNumber } } }),
  ]);
  const invoiceRef = db().doc(`tripInvoices/${bookingId}`);
  await invoiceRef.set({
    customer: { invoiceNumber: customerInvoiceNumber, storagePath: customerPath, recipientEmail: savedCustomerEmail || null, emailStatus: 'pending' },
    driver: { invoiceNumber: driverInvoiceNumber, storagePath: driverPath, recipientEmail: savedDriverEmail || null, emailStatus: 'pending' },
    pdfStatus: 'ready', updatedAtMs: serverTimestamp(),
  }, { merge: true });
  const [customerStatus, driverStatus] = await Promise.all([
    sendInvoiceEmail({ bookingId, side: 'customer', uid: customerUid, recipientEmail: savedCustomerEmail, recipientName: savedCustomerName, invoiceNumber: customerInvoiceNumber, reference: savedReference, totalPaise: fareTotalPaise, pdf: customerPdf, issuer: invoiceIssuer }),
    sendInvoiceEmail({ bookingId, side: 'driver', uid: driverUid, recipientEmail: savedDriverEmail, recipientName: savedDriverName, invoiceNumber: driverInvoiceNumber, reference: savedReference, totalPaise: driverRemittancePaise, pdf: driverPdf, issuer: invoiceIssuer }),
  ]);
  await invoiceRef.set({
    customer: { emailStatus: customerStatus },
    driver: { emailStatus: driverStatus },
    emailStatus: customerStatus === 'sent' && driverStatus === 'sent' ? 'sent' : 'incomplete',
    updatedAtMs: serverTimestamp(),
  }, { merge: true });
}

/** Returns a short-lived private PDF URL only to the invoice owner or authorised staff. */
export async function getTripInvoiceDownloadUrlForCaller(caller: Caller, input: unknown): Promise<{ url: string; expiresAtMs: number }> {
  if (!input || typeof input !== 'object') throw invalidArgument('Choose a completed trip invoice.');
  const row = input as Data;
  const bookingId = text(row.bookingId);
  const side = row.side;
  if (!bookingId || bookingId.length > 128 || (side !== 'customer' && side !== 'driver')) throw invalidArgument('Booking ID and invoice type are required.');
  const [bookingSnapshot, invoiceSnapshot] = await Promise.all([
    db().doc(`bookings/${bookingId}`).get(), db().doc(`tripInvoices/${bookingId}`).get(),
  ]);
  if (!bookingSnapshot.exists || !invoiceSnapshot.exists) throw failedPrecondition('The completed trip invoice is not available yet.');
  const booking = bookingSnapshot.data() ?? {};
  const staff = caller.claims.admin || caller.claims.ops;
  const belongs = side === 'customer' ? booking.customerUid === caller.uid : booking.assignedDriverUid === caller.uid;
  if (!staff && !belongs) throw permissionDenied('You can only download your own trip invoice.');
  const invoice = invoiceSnapshot.get(side) as Data | undefined;
  const storagePath = text(invoice?.storagePath);
  if (!storagePath.startsWith(`trip-invoices/${bookingId}/${side}-`)) throw failedPrecondition('This invoice PDF has not been stored yet.');
  const file = bucket().file(storagePath);
  const [exists] = await file.exists();
  if (!exists) throw failedPrecondition('This invoice PDF is temporarily unavailable.');
  const expiresAtMs = Date.now() + 5 * 60_000;
  const [url] = await file.getSignedUrl({ action: 'read', expires: expiresAtMs, responseDisposition: `attachment; filename="${storagePath.split('/').pop()}"` });
  return { url, expiresAtMs };
}

type ZipEntry = { name: string; bytes: Buffer; atMs: number };

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(atMs: number): { date: number; time: number } {
  const date = new Date(atMs);
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  return {
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
  };
}

/** Build a simple ZIP with stored (uncompressed) PDFs so no third-party archiver is required. */
function storedZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.bytes);
    const { date, time } = dosDateTime(entry.atMs);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(entry.bytes.length, 18);
    header.writeUInt32LE(entry.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    localParts.push(header, name, entry.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.bytes.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += header.length + name.length + entry.bytes.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

/** Admin-only bulk export for the currently filtered customer or driver archive. */
export async function getTripInvoiceArchiveForCaller(caller: Caller, input: unknown): Promise<{ zipBase64: string; filename: string }> {
  if (!caller.claims.admin && !caller.claims.ops) throw permissionDenied('Administrator or operations role required.');
  if (!input || typeof input !== 'object') throw invalidArgument('Choose invoice records to export.');
  const row = input as Data;
  const side = row.side;
  const rawIds = row.bookingIds;
  if ((side !== 'customer' && side !== 'driver') || !Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > 1000) {
    throw invalidArgument('Choose between 1 and 1,000 invoices of one type.');
  }
  const bookingIds = [...new Set(rawIds.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 128))];
  if (bookingIds.length !== rawIds.length) throw invalidArgument('The invoice selection contains an invalid booking ID.');
  const snapshots = [];
  for (let index = 0; index < bookingIds.length; index += 50) {
    const chunk = bookingIds.slice(index, index + 50);
    snapshots.push(...await Promise.all(chunk.map((bookingId) => db().doc(`tripInvoices/${bookingId}`).get())));
  }
  const pendingEntries: Array<{ name: string; atMs: number; storagePath: string }> = [];
  for (const snapshot of snapshots) {
    if (!snapshot.exists) throw failedPrecondition('One or more selected invoice records are no longer available. Refresh the archive and try again.');
    const invoice = snapshot.get(side) as Data | undefined;
    const storagePath = text(invoice?.storagePath);
    if (!storagePath.startsWith(`trip-invoices/${snapshot.id}/${side}-`)) {
      throw failedPrecondition('One or more selected PDFs are still being prepared. Check the email status and try again shortly.');
    }
    const invoiceNumber = text(invoice?.invoiceNumber, snapshot.id).replace(/[^A-Za-z0-9_-]/g, '-');
    const reference = text(snapshot.get('reference'), snapshot.id).replace(/[^A-Za-z0-9_-]/g, '-');
    pendingEntries.push({ name: `${side}/${invoiceNumber}-${reference}.pdf`, atMs: epochMs(snapshot.get('completedAtMs')) ?? Date.now(), storagePath });
  }
  const entries: ZipEntry[] = [];
  for (let index = 0; index < pendingEntries.length; index += 25) {
    const chunk = pendingEntries.slice(index, index + 25);
    const downloaded = await Promise.all(chunk.map((entry) => bucket().file(entry.storagePath).download()));
    downloaded.forEach(([bytes], offset) => entries.push({ name: chunk[offset]!.name, atMs: chunk[offset]!.atMs, bytes }));
  }
  const zip = storedZip(entries);
  if (zip.length > 7_000_000) throw failedPrecondition('This PDF archive is too large to export in one file. Choose a shorter period or narrow the search.');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  return { zipBase64: zip.toString('base64'), filename: `drivx-${side}-invoices-${today}.zip` };
}
