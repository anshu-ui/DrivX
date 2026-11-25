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
  return value.replace(/₹/g, 'INR ').replace(/[·•]/g, ' | ').replace(/[–—]/g, '-').replace(/[“”]/g, '"').replace(/[’]/g, "'")
    .replace(/[\r\n\t]/g, ' ').replace(/[^\x20-\x7E]/g, '?');
}

function pdfString(value: string): string {
  return cleanAscii(value).replace(/[\\()]/g, '\\$&');
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

type InvoiceRow = { label: string; value: string };
type InvoiceSection = { title: string; rows: InvoiceRow[] };

function invoiceSections(lines: string[]): Map<string, InvoiceRow[]> {
  const sections = new Map<string, InvoiceRow[]>();
  let current = 'Booking';
  for (const line of lines) {
    if (line.startsWith('## ')) {
      current = line.slice(3);
      sections.set(current, []);
      continue;
    }
    const [label, ...parts] = line.split('\t');
    const value = parts.join(' ').trim();
    if (!value) continue;
    const rows = sections.get(current) ?? [];
    rows.push({ label: label?.trim() ?? '', value });
    sections.set(current, rows);
  }
  return sections;
}

/** One-page trip invoice styled to match the DrivX booking confirmation PDFs. */
function invoicePdf(title: string, invoiceNumber: string, invoiceDate: string, issuer: InvoiceIssuer, lines: string[]): Buffer {
  const pageHeight = 842;
  const colors: Record<string, string> = {
    cream: '0.965 0.953 0.929', white: '1 1 1', ink: '0.09 0.10 0.13',
    navy: '0.10 0.16 0.36', blue: '0.15 0.36 0.91', muted: '0.40 0.44 0.51',
    border: '0.87 0.86 0.83', green: '0.04 0.48 0.29', greenPale: '0.91 0.97 0.93',
    bluePale: '0.92 0.95 1', soft: '0.97 0.96 0.94',
  };
  const content: string[] = [];
  const fillRect = (x: number, top: number, width: number, height: number, color: string): void => {
    content.push(`${colors[color] ?? color} rg ${x} ${pageHeight - top - height} ${width} ${height} re f`);
  };
  const roundRect = (x: number, top: number, width: number, height: number, radius: number, fill: string, stroke?: string): void => {
    const y = pageHeight - top - height;
    const r = Math.min(radius, width / 2, height / 2);
    const k = 0.55228475;
    const path = [
      `${x + r} ${y} m`, `${x + width - r} ${y} l`,
      `${x + width - r + r * k} ${y} ${x + width} ${y + r - r * k} ${x + width} ${y + r} c`,
      `${x + width} ${y + height - r} l`,
      `${x + width} ${y + height - r + r * k} ${x + width - r + r * k} ${y + height} ${x + width - r} ${y + height} c`,
      `${x + r} ${y + height} l`, `${x + r - r * k} ${y + height} ${x} ${y + height - r + r * k} ${x} ${y + height - r} c`,
      `${x} ${y + r} l`, `${x} ${y + r - r * k} ${x + r - r * k} ${y} ${x + r} ${y} c h`,
    ].join(' ');
    content.push(`${colors[fill] ?? fill} rg${stroke ? ` ${colors[stroke] ?? stroke} RG 0.8 w` : ''} ${path} ${stroke ? 'B' : 'f'}`);
  };
  const drawText = (text: string, x: number, top: number, size = 8, bold = false, color = 'ink'): void => {
    content.push(`${colors[color] ?? color} rg BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${pageHeight - top} Td (${pdfString(text)}) Tj ET`);
  };
  const wrap = (text: string, width: number, size: number): string[] => wrapText(text, Math.max(12, Math.floor(width / (size * 0.52))));
  const drawWrapped = (text: string, x: number, top: number, width: number, size: number, color = 'ink', lineHeight = size + 3): number => {
    const rows = wrap(text, width, size);
    rows.forEach((row, index) => drawText(row, x, top + index * lineHeight, size, false, color));
    return rows.length * lineHeight;
  };
  const pill = (text: string, x: number, top: number, width: number, fill: string, foreground: string): void => {
    roundRect(x, top, width, 20, 10, fill);
    drawText(text, x + 10, top + 13, 7, true, foreground);
  };

  const sections = invoiceSections(lines);
  const booking = sections.get('Booking') ?? [];
  const trip = sections.get('Trip details') ?? [];
  const customerGst = sections.get('Customer GST details') ?? [];
  const fare = sections.get('Fare breakdown') ?? [];
  const settlement = sections.get('Driver settlement') ?? [];
  const bookingValue = (label: string): string => booking.find((row) => row.label === label)?.value ?? '';
  const tripValue = (label: string): string => trip.find((row) => row.label === label)?.value ?? 'Not recorded';
  const gstValue = (label: string): string => customerGst.find((row) => row.label === label)?.value ?? '';
  const driverInvoice = title.includes('DRIVER');
  const customerName = bookingValue('Customer');
  const driverName = bookingValue('Driver');
  const businessName = gstValue('Business name');
  const customerGstin = gstValue('Customer GSTIN');
  const reference = bookingValue('Booking reference');
  const bookingId = bookingValue('Booking ID');

  fillRect(0, 0, 595, 842, 'cream');
  roundRect(40, 28, 34, 34, 10, 'blue');
  drawText('D', 50, 52, 21, true, 'white');
  drawText('DrivX', 84, 52, 19, true, 'navy');
  drawText(driverInvoice ? 'DRIVER SETTLEMENT INVOICE' : 'CUSTOMER TRIP INVOICE', driverInvoice ? 363 : 383, 48, 7, true, 'muted');
  drawText(driverInvoice ? 'Driver settlement' : 'Trip invoice', 40, 101, 23, true, 'ink');
  drawText(driverInvoice ? 'Fare and platform settlement for your completed journey.' : 'Final fare and trip record for your completed journey.', 40, 120, 8, false, 'muted');
  pill('COMPLETED', 465, 79, 90, 'greenPale', 'green');

  roundRect(40, 137, 515, 58, 12, 'white', 'border');
  drawText('BOOKING REFERENCE', 56, 157, 6.5, true, 'muted');
  drawText(reference || bookingId, 56, 180, 14, true, 'navy');
  drawText(`Booking ID: ${bookingId}`, 56, 190, 6.2, false, 'muted');
  drawText('INVOICE NUMBER', 350, 157, 6.5, true, 'muted');
  drawText(invoiceNumber, 350, 172, 8.5, true, 'ink');
  drawText(invoiceDate, 350, 185, 6.5, false, 'muted');

  const billToRows = driverInvoice
    ? [driverName || 'Driver', ...(customerName ? [`Customer: ${customerName}`] : [])]
    : [businessName || customerName || 'Customer', ...(businessName && customerName ? [`Contact: ${customerName}`] : []), ...(customerGstin ? [`GSTIN: ${customerGstin}`] : [])];
  const issuerRows = [
    issuer.businessName || 'DrivX',
    ...(issuer.gstin ? [`GSTIN: ${issuer.gstin}`] : ['GSTIN pending Admin setup']),
    ...(issuer.address ? wrap(issuer.address, 226, 7.2) : []),
  ];
  const billToLineCount = billToRows.reduce((total, row) => total + wrap(row, 220, 7.2).length, 0);
  const issuerLineCount = issuerRows.reduce((total, row) => total + wrap(row, 220, 7.2).length, 0);
  const partyLineCount = Math.max(billToLineCount, issuerLineCount, 1);
  const partyTop = 207;
  const partyHeight = 38 + partyLineCount * 11;
  roundRect(40, partyTop, 250, partyHeight, 12, 'white', 'border');
  roundRect(304, partyTop, 251, partyHeight, 12, 'white', 'border');
  drawText(driverInvoice ? 'SETTLEMENT FOR' : 'BILL TO', 55, partyTop + 20, 6.5, true, 'muted');
  drawText('ISSUED BY', 319, partyTop + 20, 6.5, true, 'muted');
  let partyY = partyTop + 37;
  for (const row of billToRows) {
    const rowLines = wrap(row, 220, 7.2);
    rowLines.forEach((part, index) => drawText(part, 55, partyY + index * 10, 7.2, row === billToRows[0], row === billToRows[0] ? 'navy' : 'ink'));
    partyY += rowLines.length * 10;
  }
  partyY = partyTop + 37;
  issuerRows.forEach((row, index) => {
    const rowLines = wrap(row, 220, 7.2);
    rowLines.forEach((part, lineIndex) => drawText(part, 319, partyY + lineIndex * 10, 7.2, index === 0, index === 0 ? 'navy' : 'ink'));
    partyY += rowLines.length * 10;
  });

  const pickup = tripValue('Pickup');
  const dropoff = tripValue('Drop-off');
  const pickupLines = wrap(pickup, 456, 8.2);
  const dropoffLines = wrap(dropoff, 456, 8.2);
  const metaPairs = ([
    ['PICKUP TIME', tripValue('Pickup time')],
    ['TRIP STARTED', tripValue('Trip started')],
    ['COMPLETED', tripValue('Trip completed')],
    ['DISTANCE', tripValue('Distance')],
    ['DURATION', tripValue('Duration')],
    [driverInvoice ? 'CUSTOMER' : 'YOUR DRIVER', driverInvoice ? customerName : driverName],
    ['SERVICE', tripValue('Service')],
    ['VEHICLE', tripValue('Vehicle')],
  ] as Array<[string, string]>).filter(([, value]) => value !== 'Not recorded' && Boolean(value));
  const journeyTop = partyTop + partyHeight + 12;
  const metadataRows = Math.ceil(metaPairs.length / 2);
  const journeyHeight = 118 + (pickupLines.length + dropoffLines.length) * 11 + Math.max(0, metadataRows - 1) * 21;
  roundRect(40, journeyTop, 515, journeyHeight, 12, 'white', 'border');
  drawText('JOURNEY', 56, journeyTop + 21, 6.5, true, 'muted');
  let routeY = journeyTop + 42;
  drawText('PICKUP', 76, routeY, 6.2, true, 'muted');
  routeY += 13;
  routeY += drawWrapped(pickup, 76, routeY, 455, 8.2, 'ink', 11);
  routeY += 6;
  drawText('DROP-OFF', 76, routeY, 6.2, true, 'muted');
  routeY += 13;
  routeY += drawWrapped(dropoff, 76, routeY, 455, 8.2, 'ink', 11);
  routeY += 7;
  content.push(`${colors.border} RG 0.6 w 56 ${pageHeight - routeY} m 539 ${pageHeight - routeY} l S`);
  routeY += 15;
  metaPairs.forEach(([label, value], index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 56 + column * 254;
    const y = routeY + row * 20;
    drawText(label, x, y, 5.8, true, 'muted');
    drawWrapped(value, x, y + 9, 230, 6.6, 'ink', 8);
  });

  const financialSections: InvoiceSection[] = driverInvoice
    ? [
        { title: 'TRIP FARE', rows: fare },
        { title: 'DRIVER SETTLEMENT', rows: settlement },
      ]
    : [{ title: 'FARE BREAKDOWN', rows: fare }];
  const financialTop = journeyTop + journeyHeight + 12;
  const footerTop = 789;
  const rowsCount = financialSections.reduce((sum, section) => sum + section.rows.length, 0);
  const available = footerTop - financialTop - 20;
  const sectionSpace = 23 * financialSections.length + 18;
  const rowStep = Math.min(13, (available - sectionSpace) / Math.max(1, rowsCount));
  if (rowStep < 8.4) throw new Error('Trip invoice details exceed the one-page layout.');
  const financialHeight = sectionSpace + rowsCount * rowStep;
  roundRect(40, financialTop, 515, financialHeight, 12, 'white', 'border');
  let financeY = financialTop + 22;
  for (const section of financialSections) {
    drawText(section.title, 55, financeY, 6.5, true, 'muted');
    financeY += 13;
    for (const row of section.rows) {
      const total = ['Customer total', 'Total driver remittance to DrivX'].includes(row.label);
      const net = row.label === 'Driver net from customer total';
      if (total || net) roundRect(50, financeY - 8, 495, Math.max(13, rowStep), 5, total ? 'blue' : 'bluePale');
      const foreground = total ? 'white' : net ? 'navy' : 'ink';
      drawText(row.label, 59, financeY + 1, Math.min(7.6, rowStep - 3), total || net, foreground);
      drawText(row.value, 427, financeY + 1, Math.min(7.6, rowStep - 3), total || net, foreground);
      financeY += rowStep;
    }
    financeY += 6;
  }
  content.push(`${colors.border} RG 0.6 w 40 ${pageHeight - footerTop} m 555 ${pageHeight - footerTop} l S`);
  drawText(`DrivX Support  |  ${CUSTOMER_CARE_CONTACTS.email}  |  ${CUSTOMER_CARE_CONTACTS.phones.map((phone) => phone.label).join('  |  ')}`, 40, 807, 6.5, false, 'muted');
  drawText(driverInvoice ? 'Keep this settlement statement for your trip records.' : 'Keep this invoice for your trip records.', 40, 822, 6, false, 'muted');

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
  const isDriver = input.title.toLowerCase().includes('driver');
  const isReceipt = !isDriver && input.title.toLowerCase().includes('receipt');
  const documentName = isDriver ? 'Driver settlement statement' : isReceipt ? 'Customer trip receipt' : 'Customer trip invoice';
  const eyebrow = isDriver ? 'DRIVER SETTLEMENT' : isReceipt ? 'CUSTOMER TRIP RECEIPT' : 'CUSTOMER TRIP INVOICE';
  const heading = isDriver ? 'Your trip settlement is ready.' : isReceipt ? 'Your DrivX trip receipt is ready.' : 'Your DrivX trip is complete.';
  const description = isDriver
    ? 'Your trip fare and platform settlement statement are attached as a PDF.'
    : isReceipt ? 'Your final fare and completed trip receipt are attached as a PDF.' : 'Your final fare and completed trip invoice are attached as a PDF.';
  const amountLabel = isDriver ? 'Platform remittance' : 'Trip total';
  const pending = input.issuerConfigured ? '' : '<p style="margin:16px 0 0;color:#64748b;font-size:12px;line-height:1.5">Registered business name and GSTIN are not configured yet. This PDF is a trip receipt; new tax invoices will include the issuer details after they are saved in DrivX Admin.</p>';
  return `<!doctype html><html><body style="margin:0;background:#f6f3ee;font-family:Arial,Helvetica,sans-serif;color:#15171d;padding:28px 16px"><div style="max-width:620px;margin:0 auto"><div style="padding:10px 4px 22px"><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%"><tr><td><span style="display:inline-block;width:38px;height:38px;line-height:38px;text-align:center;border-radius:11px;background:#2860ef;color:#fff;font-size:24px;font-weight:bold;vertical-align:middle">D</span><span style="margin-left:10px;color:#172a63;font-size:23px;font-weight:bold;vertical-align:middle">DrivX</span></td><td style="text-align:right;color:#657187;font-size:10px;letter-spacing:.04em">${eyebrow}</td></tr></table></div><div style="background:#fff;border:1px solid #dedbd5;border-radius:16px;padding:26px 24px"><h1 style="margin:0 0 10px;font-size:23px;line-height:1.25;color:#17191f">${heading}</h1><p style="margin:0 0 18px;color:#596273;font-size:14px;line-height:1.6">Hi ${escapeHtml(input.recipient)}, ${description}</p><div style="background:#f5f3ef;border-radius:12px;padding:18px 20px"><div style="margin-bottom:15px;color:#657187;font-size:10px;letter-spacing:.04em">BOOKING REFERENCE</div><div style="margin-bottom:18px;color:#172a63;font-size:19px;font-weight:bold">${escapeHtml(input.reference)}</div><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid #dedbd5;padding-top:13px"><tr><td style="padding-top:13px;color:#596273;font-size:13px">${isReceipt ? 'Receipt number' : 'Invoice number'}</td><td style="padding-top:13px;text-align:right;color:#17191f;font-size:13px;font-weight:bold">${escapeHtml(input.invoiceNumber)}</td></tr><tr><td style="padding-top:10px;color:#596273;font-size:13px">${amountLabel}</td><td style="padding-top:10px;text-align:right;color:#17191f;font-size:15px;font-weight:bold">${escapeHtml(input.total)}</td></tr></table></div><div style="margin-top:18px;border:1px solid #dedbd5;border-radius:12px;padding:14px 16px"><span style="color:#2860ef;font-size:12px;font-weight:bold">PDF</span><span style="margin-left:12px;color:#17191f;font-size:13px">${documentName} · ${escapeHtml(input.invoiceNumber)}.pdf</span></div>${pending}<p style="margin:22px 0 0;color:#17191f;font-size:13px;font-weight:bold">Thanks for riding with DrivX.</p><p style="margin:7px 0 0;color:#657187;font-size:12px;line-height:1.5">Need help? ${escapeHtml(CUSTOMER_CARE_CONTACTS.email)}<br>${CUSTOMER_CARE_CONTACTS.phones.map((phone) => escapeHtml(phone.label)).join(' · ')}</p></div><p style="margin:16px 4px 0;color:#657187;font-size:10px;line-height:1.5">This email contains the ${documentName.toLowerCase()} for the completed trip shown above.</p></div></body></html>`;
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
  const issuerConfigured = Boolean(input.issuer.businessName && input.issuer.gstin);
  const title = input.side === 'customer'
    ? issuerConfigured ? 'Customer trip invoice' : 'Customer trip receipt'
    : 'Driver trip settlement statement';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `drivx-invoice-${input.side}-${deliveryId}` },
    body: JSON.stringify({
      from,
      to: [input.recipientEmail],
      reply_to: CUSTOMER_CARE_CONTACTS.email,
      subject: `${title} · ${input.reference} · ${input.invoiceNumber}`,
      html: invoiceEmailHtml({ recipient: input.recipientName, title, invoiceNumber: input.invoiceNumber, reference: input.reference, total: INR(input.totalPaise), issuerConfigured }),
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
