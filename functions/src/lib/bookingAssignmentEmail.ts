import { createHash } from 'node:crypto';
import { bucket, db, serverTimestamp } from './admin';
import { RESEND_API_KEY, RESEND_FROM_EMAIL, PUBLIC_ORIGIN } from './config';

type Data = Record<string, unknown>;

function value(input: unknown, fallback = ''): string {
  return typeof input === 'string' && input.trim() ? input.trim() : fallback;
}

function html(valueToEscape: string): string {
  return valueToEscape.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

function amountInr(paise: unknown): string {
  const amount = Number(paise ?? 0);
  return `INR ${Number.isFinite(amount) ? (amount / 100).toFixed(2) : '0.00'}`;
}

function placeLabel(place: unknown): string {
  if (!place || typeof place !== 'object') return 'To be confirmed';
  const record = place as Data;
  return value(record.label, [record.addressLine1, record.addressLine2, record.city, record.state]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(', ') || 'To be confirmed');
}

function readableDate(timestamp: unknown): string {
  const date = typeof timestamp === 'number' ? new Date(timestamp) : null;
  if (!date || !Number.isFinite(date.getTime())) return 'As shown in your DrivX trip';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
  }).format(date);
}

function ascii(input: string): string {
  return input
    .replace(/₹/g, 'INR ')
    .replace(/[–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/[^\x20-\x7E]/g, '?');
}

function pdfEscape(input: string): string {
  return ascii(input).replace(/[\\()]/g, '\\$&');
}

function jpegDimensions(bytes: Buffer): { width: number; height: number; components: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1] as number;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
        components: bytes[offset + 7] as number,
      };
    }
    offset += length;
  }
  return null;
}

function makePdf(lines: Array<{ text: string; size?: number; color?: string; bold?: boolean }>, photo?: Buffer): Buffer {
  const image = photo ? jpegDimensions(photo) : null;
  const usableImage = image && image.width > 0 && image.height > 0 && image.components === 3 ? photo : null;
  const imageInfo = usableImage ? jpegDimensions(usableImage) : null;
  const objects: Buffer[] = [];
  const pushObject = (content: Buffer | string): number => {
    objects.push(Buffer.isBuffer(content) ? content : Buffer.from(content, 'binary'));
    return objects.length;
  };
  pushObject('<< /Type /Catalog /Pages 2 0 R >>');
  pushObject('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  const imageResource = usableImage && imageInfo ? '/XObject << /Im1 5 0 R >>' : '';
  pushObject(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 7 0 R >> ${imageResource} >> /Contents 6 0 R >>`);
  pushObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  if (usableImage && imageInfo) {
    const imageHeader = Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${imageInfo.width} /Height ${imageInfo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${usableImage.length} >>\nstream\n`, 'binary');
    pushObject(Buffer.concat([imageHeader, usableImage, Buffer.from('\nendstream', 'binary')]));
  } else {
    pushObject('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n\xFF\xFF\xFF\nendstream');
  }

  let cursorY = 138;
  const content: string[] = [
    '0.965 0.969 0.980 rg 0 0 595 842 re f',
    '0.055 0.122 0.271 rg 0 746 595 96 re f',
    '1 1 1 rg',
    `BT /F2 25 Tf 42 795 Td (${pdfEscape('DrivX')}) Tj ET`,
    `BT /F1 10 Tf 43 772 Td (${pdfEscape('YOUR RIDE, CONFIRMED')}) Tj ET`,
  ];
  if (usableImage && imageInfo) {
    content.push('q 76 0 0 76 466 752 cm /Im1 Do Q');
  }
  for (const line of lines) {
    const font = line.bold ? 'F2' : 'F1';
    const size = line.size ?? 11;
    const color = line.color ?? '0.12 0.17 0.25';
    const maxChars = Math.max(24, Math.floor(500 / (size * 0.52)));
    const words = ascii(line.text).split(/\s+/);
    const wrapped: string[] = [];
    let current = '';
    for (const word of words) {
      if ((current ? `${current} ${word}` : word).length > maxChars && current) {
        wrapped.push(current); current = word;
      } else current = current ? `${current} ${word}` : word;
    }
    if (current) wrapped.push(current);
    for (const row of wrapped) {
      cursorY += size + 7;
      content.push(`${color} rg BT /${font} ${size} Tf 44 ${842 - cursorY} Td (${pdfEscape(row)}) Tj ET`);
    }
    cursorY += line.size === 16 ? 5 : 0;
  }
  content.push('0.055 0.122 0.271 rg 44 34 507 1 re f');
  content.push(`0.36 0.41 0.49 rg BT /F1 8 Tf 44 21 Td (${pdfEscape('DrivX customer support: customersupport@drivx.in  |  +91 87085 06508 / +91 98130 51505')}) Tj ET`);
  const stream = Buffer.from(content.join('\n'), 'binary');
  pushObject(Buffer.concat([
    Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'binary'),
    stream,
    Buffer.from('\nendstream', 'binary'),
  ]));
  pushObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%DrivX\n', 'binary')];
  const offsets = [0];
  let byteLength = chunks[0]?.length ?? 0;
  objects.forEach((object, index) => {
    offsets.push(byteLength);
    const wrapped = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'binary'), object, Buffer.from('\nendobj\n', 'binary'),
    ]);
    chunks.push(wrapped); byteLength += wrapped.length;
  });
  const xrefOffset = byteLength;
  const xref = [`xref\n0 ${objects.length + 1}`, '0000000000 65535 f '];
  for (const offset of offsets.slice(1)) xref.push(`${String(offset).padStart(10, '0')} 00000 n `);
  xref.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  chunks.push(Buffer.from(`${xref.join('\n')}\n`, 'binary'));
  return Buffer.concat(chunks);
}

function emailHtml(input: {
  customerName: string; reference: string; pickup: string; destination: string; time: string;
  fare: string; driverName: string; driverPhone: string; driverId: string; vehicle: string;
  rating: string; photoUrl: string | null; tripUrl: string;
}): string {
  const photo = input.photoUrl
    ? `<img src="${html(input.photoUrl)}" alt="${html(input.driverName)}" width="64" height="64" style="width:64px;height:64px;border-radius:50%;object-fit:cover;border:2px solid #e4eaf4;">`
    : `<div style="width:64px;height:64px;border-radius:50%;background:#eaf0fb;color:#203a70;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:22px;">${html(input.driverName.slice(0, 1).toUpperCase())}</div>`;
  return `<!doctype html><html><body style="margin:0;background:#f3f6fb;font-family:Arial,Helvetica,sans-serif;color:#17233b;">
  <div style="max-width:640px;margin:0 auto;padding:24px 14px;">
    <div style="background:#17366b;border-radius:18px 18px 0 0;padding:26px 30px;color:#fff;">
      <div style="font-size:13px;letter-spacing:2px;font-weight:700;">DRIVX</div>
      <h1 style="font-size:24px;line-height:1.3;margin:18px 0 6px;">Your ride is confirmed</h1>
      <p style="margin:0;color:#d8e5fb;font-size:14px;">Your driver has been assigned. Here are the details for your trip.</p>
    </div>
    <div style="background:#fff;padding:26px 30px;border:1px solid #e1e7f0;">
      <p style="font-size:15px;line-height:1.65;margin:0 0 18px;">Hi ${html(input.customerName)},<br><br>Thank you for choosing DrivX. We appreciate you booking with us, and we’re ready to make your journey smooth and dependable. Your driver and trip details are below; your confirmation PDF is attached for easy reference.</p>
      <div style="border:1px solid #e4eaf2;border-radius:14px;padding:17px;margin:18px 0;background:#fbfcfe;">
        <div style="font-size:11px;letter-spacing:1px;color:#6b7890;font-weight:700;">BOOKING ${html(input.reference)}</div>
        <div style="font-size:13px;line-height:1.7;margin-top:12px;"><b>Pickup</b><br>${html(input.pickup)}<br><br><b>Drop</b><br>${html(input.destination)}<br><br><b>Scheduled</b><br>${html(input.time)}<br><br><b>Estimated fare</b><br><span style="font-size:20px;color:#17366b;font-weight:700;">${html(input.fare)}</span></div>
      </div>
      <div style="border:1px solid #e4eaf2;border-radius:14px;padding:17px;margin:18px 0;">
        <div style="font-size:11px;letter-spacing:1px;color:#6b7890;font-weight:700;margin-bottom:13px;">YOUR DRIVX DRIVER</div>
        <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;"><tr><td style="width:76px;vertical-align:top;">${photo}</td><td style="vertical-align:middle;font-size:14px;line-height:1.55;"><b style="font-size:16px;">${html(input.driverName)}</b>${input.driverId ? `<br><span style="color:#64728a;">${html(input.driverId)}</span>` : ''}<br><a href="tel:${html(input.driverPhone)}" style="color:#1e4f9a;text-decoration:none;">${html(input.driverPhone || 'Phone number unavailable')}</a><br>${html(input.vehicle)}${input.rating ? `<br><span style="color:#8a6812;">★ ${html(input.rating)}</span>` : ''}</td></tr></table>
        <p style="margin:14px 0 0;color:#68768d;font-size:12px;line-height:1.5;">The driver’s identity and required documents have been verified by DrivX. For privacy, personal identity document scans are not included.</p>
      </div>
      <p style="font-size:13px;color:#68768d;line-height:1.6;">The fare shown is the current estimate. Any approved extra distance or time will be reflected in the final trip details. Payment is due after your trip is completed.</p>
      <p style="text-align:center;margin:24px 0;"><a href="${html(input.tripUrl)}" style="display:inline-block;background:#1f4f9c;border-radius:10px;padding:14px 24px;color:#fff;text-decoration:none;font-weight:700;">View trip details</a></p>
      <p style="font-size:14px;line-height:1.65;margin:0;">Thanks again for riding with DrivX. If you need help at any point, our customer support team is here for you.</p>
      <p style="font-size:13px;line-height:1.7;color:#35435c;margin:14px 0 0;"><a href="mailto:customersupport@drivx.in" style="color:#1f4f9c;">customersupport@drivx.in</a><br>+91 87085 06508 &nbsp;·&nbsp; +91 98130 51505</p>
    </div>
    <div style="padding:16px 22px;color:#77849a;text-align:center;font-size:11px;">DrivX · Your car. Your rules.<br><a href="${html(`${PUBLIC_ORIGIN}/privacy-policy.html`)}" style="color:#526b95;">Privacy Policy</a></div>
  </div></body></html>`;
}

/** Sends one customer assignment email and a customer-facing booking PDF. Never includes private KYC scans. */
export async function sendCustomerAssignmentEmail(bookingId: string, booking: Data): Promise<void> {
  const customerUid = value(booking.customerUid);
  const driverUid = value(booking.assignedDriverUid);
  if (!customerUid || !driverUid || booking.status !== 'assigned') return;

  const [profileSnapshot, userSnapshot] = await Promise.all([
    db().doc(`customerProfiles/${customerUid}`).get(),
    db().doc(`users/${customerUid}`).get(),
  ]);
  const profile = (profileSnapshot.data() ?? {}) as Data;
  const user = (userSnapshot.data() ?? {}) as Data;
  const email = value(profile.email, value(user.email)).toLowerCase();
  if (!email || !email.includes('@')) return;

  const driver = (booking.driver && typeof booking.driver === 'object' ? booking.driver : {}) as Data;
  const vehicle = (driver.vehicle && typeof driver.vehicle === 'object' ? driver.vehicle : {}) as Data;
  const reference = value(booking.reference, bookingId);
  const version = Number(booking.stateVersion ?? 0);
  const deliveryId = createHash('sha256').update(`${bookingId}:${driverUid}:${version}`).digest('hex');
  const deliveryRef = db().doc(`emailDeliveryEvents/${deliveryId}`);
  const existing = await deliveryRef.get();
  if (existing.get('status') === 'sent') return;

  const apiKey = RESEND_API_KEY.value();
  const from = RESEND_FROM_EMAIL.value();
  if (!apiKey || !from) {
    console.warn(JSON.stringify({ level: 'warn', fn: 'sendCustomerAssignmentEmail', bookingId, outcome: 'resend_not_configured' }));
    return;
  }

  const pickup = placeLabel(booking.pickup);
  const destination = placeLabel(booking.destination);
  const customerName = value(profile.fullName, value(user.displayName, 'there'));
  const driverName = value(driver.fullName, 'Your DrivX driver');
  const driverPhone = value(driver.phoneE164);
  const driverId = value(driver.driverId);
  const vehicleLabel = [vehicle.make, vehicle.model, vehicle.plate].map((part) => value(part)).filter(Boolean).join(' · ') || 'Vehicle details are available in your trip';
  const ratingAverage = Number(driver.ratingAverage ?? 0);
  const rating = Number.isFinite(ratingAverage) && ratingAverage > 0 ? `${ratingAverage.toFixed(1)} (${Number(driver.ratingCount ?? 0)} ratings)` : '';
  const estimate = (booking.estimate && typeof booking.estimate === 'object' ? booking.estimate : {}) as Data;
  const fare = amountInr(estimate.totalPaise);
  const scheduledFor = booking.scheduledForMs;
  const time = scheduledFor == null ? 'As soon as your driver reaches pickup' : readableDate(scheduledFor);
  const tripUrl = `${PUBLIC_ORIGIN}/customer/trips?bookingId=${encodeURIComponent(bookingId)}`;
  const photoPath = value(driver.photoPath);
  let photoBytes: Buffer | undefined;
  let photoUrl: string | null = null;
  if (photoPath.startsWith(`avatars/${driverUid}/`)) {
    try {
      const file = bucket().file(photoPath);
      const [metadata] = await file.getMetadata();
      const contentType = value(metadata.contentType).toLowerCase();
      const size = Number(metadata.size ?? 0);
      if (contentType.startsWith('image/') && size > 0 && size <= 2_000_000) {
        const [download] = await file.download();
        photoBytes = download;
        const [signed] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 72 * 60 * 60 * 1000 });
        photoUrl = signed;
      }
    } catch (error) {
      console.warn(JSON.stringify({ level: 'warn', fn: 'sendCustomerAssignmentEmail', bookingId, outcome: 'driver_photo_unavailable', code: (error as { code?: unknown }).code ?? 'unknown' }));
    }
  }

  const pdfLines = [
    { text: `Booking ${reference}`, size: 16, bold: true },
    { text: `Prepared for ${customerName}`, size: 10 },
    { text: 'Your DrivX driver has been assigned. Keep this confirmation for your trip.', size: 10 },
    { text: 'TRIP DETAILS', size: 11, color: '0.12 0.31 0.61', bold: true },
    { text: `Pickup: ${pickup}` },
    { text: `Drop: ${destination}` },
    { text: `Scheduled: ${time}` },
    { text: `Estimated fare: ${fare}`, bold: true },
    { text: 'This is an estimate. Any approved extra distance/time appears in the final trip details.' },
    { text: 'DRIVER', size: 11, color: '0.12 0.31 0.61', bold: true },
    { text: `Name: ${driverName}` },
    { text: `Phone: ${driverPhone || 'Phone number unavailable'}` },
    { text: `Driver ID: ${driverId || 'Available in the trip screen'}` },
    { text: `Vehicle: ${vehicleLabel}` },
    { text: `Rating: ${rating || 'New driver'}` },
    { text: 'DrivX has verified the driver identity and required documents. Private Aadhaar/licence scans are not shared.' },
    { text: 'THANK YOU', size: 11, color: '0.12 0.31 0.61', bold: true },
    { text: 'Thank you for choosing DrivX. We hope you have a safe and comfortable journey.' },
    { text: 'Support: customersupport@drivx.in | +91 87085 06508 | +91 98130 51505' },
  ];
  const pdf = makePdf(pdfLines, photoBytes);
  if (pdf.length > 5_000_000) throw new Error('DrivX booking confirmation PDF exceeded the email attachment limit.');
  const subject = driverName === 'Your DrivX driver'
    ? `Your DrivX driver is confirmed · ${reference}`
    : `Your DrivX driver is confirmed: ${driverName} · ${reference}`;
  const bodyText = [
    `Hi ${customerName},`, '',
    'Thank you for choosing DrivX. Your driver has been assigned, and we are ready to make your journey smooth and dependable.', '',
    `Booking: ${reference}`, `Pickup: ${pickup}`, `Drop: ${destination}`, `Scheduled: ${time}`, `Estimated fare: ${fare}`, '',
    `Driver: ${driverName}`, `Call: ${driverPhone || 'Phone number unavailable'}`, `Vehicle: ${vehicleLabel}`,
    '', 'Your driver identity has been verified by DrivX. Private identity document scans are not shared.',
    'The fare shown is an estimate. Any approved extra distance or time will appear in the final trip details. Payment is due after the trip is completed.',
    '', `View trip: ${tripUrl}`, '',
    'Thanks again for riding with DrivX. Need help? customersupport@drivx.in | +91 87085 06508 | +91 98130 51505',
  ].join('\n');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `drivx-booking-assigned-${deliveryId}`,
    },
    body: JSON.stringify({
      from,
      to: [email],
      reply_to: 'customersupport@drivx.in',
      subject,
      html: emailHtml({ customerName, reference, pickup, destination, time, fare, driverName, driverPhone, driverId, vehicle: vehicleLabel, rating, photoUrl, tripUrl }),
      text: bodyText,
      attachments: [{ filename: `DrivX-${reference.replace(/[^a-zA-Z0-9_-]/g, '-')}-booking-confirmation.pdf`, content: pdf.toString('base64'), content_type: 'application/pdf' }],
      tags: [{ name: 'event', value: 'driver-assigned' }, { name: 'booking', value: deliveryId.slice(0, 32) }],
    }),
  });
  const result = await response.json().catch(() => ({})) as Data;
  if (!response.ok) {
    const errorName = value(result.name, `http_${response.status}`);
    await deliveryRef.set({ bookingId, customerUid, driverUid, recipient: email, status: 'failed', error: errorName, updatedAt: serverTimestamp() }, { merge: true });
    throw new Error(`Resend rejected DrivX assignment email (${errorName}).`);
  }
  await deliveryRef.set({
    bookingId, customerUid, driverUid, recipient: email, status: 'sent', provider: 'resend',
    providerEmailId: value(result.id) || null, updatedAt: serverTimestamp(),
  }, { merge: true });
}
