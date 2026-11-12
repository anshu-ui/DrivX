import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
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
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) return null;
      const components = bytes[offset + 7] as number;
      if (length < 8 + components * 3) return null;
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
        components,
      };
    }
    offset += length;
  }
  return null;
}

type PdfPhoto = { width: number; height: number; rgb: Buffer; alpha: Buffer | null };

/** Decode the public profile avatar formats accepted by driver onboarding. */
function pdfPhoto(bytes: Buffer): PdfPhoto | null {
  const jpeg = jpegDimensions(bytes);
  if (jpeg && jpeg.width > 0 && jpeg.height > 0 && jpeg.components === 3
    && jpeg.width <= 4096 && jpeg.height <= 4096 && jpeg.width * jpeg.height <= 4_000_000) {
    return { width: jpeg.width, height: jpeg.height, rgb: bytes, alpha: null };
  }
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(pngSignature)) return null;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) return null;
    if (type === 'IHDR') {
      if (length !== 13 || width !== 0 || height !== 0) return null;
      width = bytes.readUInt32BE(start);
      height = bytes.readUInt32BE(start + 4);
      bitDepth = bytes[start + 8] as number;
      colorType = bytes[start + 9] as number;
      if (bytes[start + 10] !== 0 || bytes[start + 11] !== 0 || bytes[start + 12] !== 0) return null;
    } else if (type === 'IDAT') idat.push(bytes.subarray(start, end));
    else if (type === 'IEND') break;
    offset = end + 4;
  }
  if (!width || !height || bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || idat.length === 0) return null;
  // Avatar images are user uploads. Bound dimensions and decoded memory before
  // inflating so a tiny compressed PNG cannot exhaust the function instance.
  if (width > 4096 || height > 4096 || width * height > 4_000_000) return null;
  const channels = colorType === 6 ? 4 : 3;
  const rowBytes = width * channels;
  let filtered: Buffer;
  try {
    filtered = inflateSync(Buffer.concat(idat), { maxOutputLength: height * (rowBytes + 1) });
  } catch {
    return null;
  }
  if (filtered.length !== height * (rowBytes + 1)) return null;
  const pixels = Buffer.alloc(height * rowBytes);
  const paeth = (left: number, up: number, upperLeft: number): number => {
    const p = left + up - upperLeft;
    const dl = Math.abs(p - left); const du = Math.abs(p - up); const dul = Math.abs(p - upperLeft);
    return dl <= du && dl <= dul ? left : du <= dul ? up : upperLeft;
  };
  for (let y = 0; y < height; y += 1) {
    const source = y * (rowBytes + 1);
    const filter = filtered[source] as number;
    if (filter > 4) return null;
    const row = y * rowBytes;
    const priorRow = row - rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = filtered[source + 1 + x] as number;
      const left = x >= channels ? pixels[row + x - channels] as number : 0;
      const up = y > 0 ? pixels[priorRow + x] as number : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[priorRow + x - channels] as number : 0;
      const predictor = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, upperLeft) : 0;
      pixels[row + x] = (raw + predictor) & 0xff;
    }
  }
  if (colorType === 2) return { width, height, rgb: pixels, alpha: null };
  const rgb = Buffer.alloc(width * height * 3);
  const alpha = Buffer.alloc(width * height);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * 4;
    const target = pixel * 3;
    rgb[target] = pixels[source] as number;
    rgb[target + 1] = pixels[source + 1] as number;
    rgb[target + 2] = pixels[source + 2] as number;
    alpha[pixel] = pixels[source + 3] as number;
  }
  return { width, height, rgb, alpha };
}

type BookingPdfInput = {
  reference: string; driverName: string; driverPhone: string; driverId: string;
  vehicle: string; rating: string; pickup: string; destination: string; time: string;
  direction: string; fare: string;
};

function makePdf(input: BookingPdfInput, photo?: Buffer): Buffer {
  const image = photo ? pdfPhoto(photo) : null;
  const objects: Buffer[] = [];
  const pushObject = (content: Buffer | string): number => {
    objects.push(Buffer.isBuffer(content) ? content : Buffer.from(content, 'binary'));
    return objects.length;
  };
  pushObject('<< /Type /Catalog /Pages 2 0 R >>');
  pushObject('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  pushObject(''); // page object is completed after the image and content object numbers are known
  pushObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pushObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  let imageObject: number | null = null;
  if (image) {
    const imageData = image.rgb === photo ? photo as Buffer : deflateSync(image.rgb);
    const imageFilter = image.rgb === photo ? '/DCTDecode' : '/FlateDecode';
    const maskObject = image.alpha ? objects.length + 2 : null;
    imageObject = objects.length + 1;
    const maskReference = maskObject ? `/SMask ${maskObject} 0 R ` : '';
    const imageHeader = Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ${imageFilter} ${maskReference}/Length ${imageData.length} >>\nstream\n`, 'binary');
    pushObject(Buffer.concat([imageHeader, imageData, Buffer.from('\nendstream', 'binary')]));
    if (image.alpha) {
      const alphaData = deflateSync(image.alpha);
      const alphaHeader = Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${alphaData.length} >>\nstream\n`, 'binary');
      pushObject(Buffer.concat([alphaHeader, alphaData, Buffer.from('\nendstream', 'binary')]));
    }
  }

  const content: string[] = [];
  const pageHeight = 842;
  const colors: Record<string, string> = {
    cream: '0.965 0.953 0.929', white: '1 1 1', ink: '0.09 0.10 0.13',
    navy: '0.10 0.16 0.36', blue: '0.15 0.36 0.91', muted: '0.40 0.44 0.51',
    border: '0.87 0.86 0.83', green: '0.04 0.48 0.29', greenPale: '0.91 0.97 0.93',
    bluePale: '0.92 0.95 1', soft: '0.97 0.96 0.94', whiteBlue: '0.70 0.78 1',
  };
  const fillRect = (x: number, top: number, width: number, height: number, color: string): void => {
    content.push(`${colors[color] ?? color} rg ${x} ${pageHeight - top - height} ${width} ${height} re f`);
  };
  const roundRect = (x: number, top: number, width: number, height: number, radius: number, fill: string, stroke?: string): void => {
    const y = pageHeight - top - height;
    const r = Math.min(radius, width / 2, height / 2);
    const k = 0.55228475;
    const path = [
      `${x + r} ${y} m`,
      `${x + width - r} ${y} l`,
      `${x + width - r + r * k} ${y} ${x + width} ${y + r - r * k} ${x + width} ${y + r} c`,
      `${x + width} ${y + height - r} l`,
      `${x + width} ${y + height - r + r * k} ${x + width - r + r * k} ${y + height} ${x + width - r} ${y + height} c`,
      `${x + r} ${y + height} l`,
      `${x + r - r * k} ${y + height} ${x} ${y + height - r + r * k} ${x} ${y + height - r} c`,
      `${x} ${y + r} l`,
      `${x} ${y + r - r * k} ${x + r - r * k} ${y} ${x + r} ${y} c h`,
    ].join(' ');
    content.push(`${colors[fill] ?? fill} rg${stroke ? ` ${colors[stroke] ?? stroke} RG 0.8 w` : ''} ${path} ${stroke ? 'B' : 'f'}`);
  };
  const drawText = (text: string, x: number, top: number, size = 9, bold = false, color = 'ink'): void => {
    content.push(`${colors[color] ?? color} rg BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${pageHeight - top} Td (${pdfEscape(text)}) Tj ET`);
  };
  const wrap = (text: string, width: number, size: number, maxRows = 2): string[] => {
    const maxChars = Math.max(10, Math.floor(width / (size * 0.52)));
    const rows: string[] = [];
    let row = '';
    for (const word of ascii(text).split(/\s+/)) {
      const candidate = row ? `${row} ${word}` : word;
      if (candidate.length > maxChars && row) { rows.push(row); row = word; }
      else row = candidate;
    }
    if (row) rows.push(row);
    if (rows.length > maxRows) {
      const clipped = rows.slice(0, maxRows);
      clipped[maxRows - 1] = `${(clipped[maxRows - 1] ?? '').slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
      return clipped;
    }
    return rows;
  };
  const drawWrapped = (text: string, x: number, top: number, width: number, size: number, color = 'ink', maxRows = 2): number => {
    const rows = wrap(text, width, size, maxRows);
    rows.forEach((row, index) => drawText(row, x, top + index * (size + 3), size, false, color));
    return rows.length * (size + 3);
  };
  const pill = (text: string, x: number, top: number, width: number, fill: string, foreground: string): void => {
    roundRect(x, top, width, 19, 9.5, fill);
    drawText(text, x + 10, top + 13, 7, true, foreground);
  };
  const drawAvatar = (x: number, top: number, size: number): void => {
    const y = pageHeight - top - size;
    if (image && imageObject) {
      const scale = Math.max(size / image.width, size / image.height);
      const drawWidth = image.width * scale;
      const drawHeight = image.height * scale;
      const drawX = x + (size - drawWidth) / 2;
      const drawY = y + (size - drawHeight) / 2;
      const r = size / 2;
      const k = 0.55228475;
      content.push(`q ${x + r} ${y} m ${x + r + r * k} ${y} ${x + size} ${y + r - r * k} ${x + size} ${y + r} c ${x + size} ${y + r + r * k} ${x + r + r * k} ${y + size} ${x + r} ${y + size} c ${x + r - r * k} ${y + size} ${x} ${y + r + r * k} ${x} ${y + r} c ${x} ${y + r - r * k} ${x + r - r * k} ${y} ${x + r} ${y} c h W n ${drawWidth} 0 0 ${drawHeight} ${drawX} ${drawY} cm /Im1 Do Q`);
    } else {
      roundRect(x, top, size, size, 12, 'bluePale');
      drawText('DR', x + size * 0.27, top + size * 0.60, 14, true, 'blue');
    }
  };

  fillRect(0, 0, 595, 842, 'cream');
  roundRect(40, 28, 30, 30, 9, 'blue');
  drawText('D', 49, 50, 19, true, 'white');
  drawText('DrivX', 79, 51, 18, true, 'navy');
  drawText('CUSTOMER TRIP CONFIRMATION', 414, 48, 7, true, 'muted');
  drawText('Your trip details', 40, 101, 23, true, 'ink');
  drawText('Booking confirmation - Keep this for your journey.', 40, 120, 8, false, 'muted');
  pill('CONFIRMED', 466, 88, 88, 'greenPale', 'green');

  roundRect(40, 138, 515, 56, 12, 'white', 'border');
  drawText('BOOKING REFERENCE', 56, 158, 6.5, true, 'muted');
  drawText(input.reference, 56, 179, 14, true, 'navy');
  drawText('Confirmed', 492, 169, 8, true, 'green');

  roundRect(40, 208, 250, 146, 12, 'white', 'border');
  drawText('YOUR DRIVER', 56, 229, 7, true, 'muted');
  drawAvatar(56, 241, 52);
  drawText(input.driverName, 119, 258, 10, true, 'ink');
  drawText('DrivX Captain', 119, 274, 7.5, false, 'muted');
  drawText(input.rating ? `* ${input.rating}` : 'New driver', 119, 288, 7.5, false, 'muted');
  drawText('Identity verified by DrivX', 119, 304, 7, true, 'green');
  content.push(`${colors.border} RG 0.6 w 56 ${pageHeight - 312} m 274 ${pageHeight - 312} l S`);
  drawText('DRIVER CONTACT', 56, 328, 6.2, true, 'muted');
  drawText(input.driverPhone || 'Phone number unavailable', 126, 328, 7, true, 'ink');
  drawText('VEHICLE', 56, 344, 6.2, true, 'muted');
  drawWrapped(input.vehicle, 103, 344, 168, 7, 'ink', 1);

  roundRect(304, 208, 251, 146, 12, 'bluePale');
  drawText('SAFETY & PRIVACY', 320, 229, 7, true, 'muted');
  drawText('Driver identity checked', 320, 251, 9, true, 'green');
  drawWrapped("DrivX has verified the assigned driver's profile. For your safety, Aadhaar and driving-licence scans and ID numbers are kept restricted and are not shared in customer emails.", 320, 269, 218, 7.2, 'ink', 4);
  drawWrapped('Use the driver contact above for trip coordination. Your start OTP stays inside your DrivX account and should only be shared at pickup.', 320, 323, 218, 6.5, 'muted', 3);

  roundRect(40, 368, 515, 173, 12, 'white', 'border');
  drawText('JOURNEY', 56, 389, 7, true, 'muted');
  content.push(`${colors.blue} RG 1 w 59 ${pageHeight - 412} m 59 ${pageHeight - 462} l S`);
  content.push(`${colors.blue} rg 55 ${pageHeight - 416} 8 8 re f`);
  content.push(`${colors.blue} RG 1.2 w 55 ${pageHeight - 478} 8 8 re S`);
  drawText('PICKUP', 76, 414, 6.5, true, 'muted');
  drawWrapped(input.pickup, 76, 431, 454, 8.2, 'ink', 2);
  drawText('DROP-OFF', 76, 465, 6.5, true, 'muted');
  drawWrapped(input.destination, 76, 482, 454, 8.2, 'ink', 2);
  content.push(`${colors.border} RG 0.6 w 56 ${pageHeight - 501} m 539 ${pageHeight - 501} l S`);
  drawText(input.time, 56, 521, 7, false, 'muted');
  drawText(input.direction, 257, 521, 7, false, 'muted');
  drawText('Driver and vehicle details are in this confirmation', 397, 521, 6.2, false, 'muted');

  roundRect(40, 555, 250, 132, 12, 'white', 'border');
  drawText('ESTIMATED FARE', 56, 576, 7, true, 'muted');
  drawText(input.direction, 56, 599, 7, false, 'muted');
  drawText(input.fare, 231, 601, 10, true, 'ink');
  content.push(`${colors.border} RG 0.6 w 56 ${pageHeight - 613} m 274 ${pageHeight - 613} l S`);
  drawText('Payable fare', 56, 633, 7.5, true, 'ink');
  drawText('Final fare in app', 204, 633, 7, true, 'blue');
  drawWrapped('This is an estimate. The final fare follows the completed trip record and applicable fare rules.', 56, 652, 216, 6.6, 'muted', 3);

  roundRect(304, 555, 251, 132, 12, 'white', 'border');
  drawText('BEFORE PICKUP', 320, 576, 7, true, 'muted');
  const reminders = [
    'Be ready at the pickup point at the scheduled time',
    'Confirm the driver and vehicle details',
    'Share the start OTP only at pickup',
    'Use the app to follow trip updates',
  ];
  reminders.forEach((reminder, index) => {
    const y = 599 + index * 19;
    content.push(`${colors.bluePale} rg 321 ${pageHeight - y - 3} 6 6 re f`);
    drawWrapped(reminder, 335, y + 3, 202, 6.5, 'ink', 1);
  });

  roundRect(40, 701, 515, 48, 10, 'soft');
  drawText('YOUR PRIVACY', 55, 720, 6.5, true, 'muted');
  drawWrapped('Only trip-relevant driver profile details are included. Government ID scans and full ID numbers remain private with authorised verification staff.', 55, 737, 480, 6.7, 'muted', 2);
  content.push(`${colors.border} RG 0.6 w 40 ${pageHeight - 769} m 555 ${pageHeight - 769} l S`);
  drawText('DrivX Support  |  customersupport@drivx.in  |  +91 87085 06508  |  +91 98130 51505', 40, 788, 7, false, 'muted');
  drawText('Please keep this confirmation for your trip.', 40, 805, 6.5, false, 'muted');
  const stream = Buffer.from(content.join('\n'), 'binary');
  const contentObject = objects.length + 1;
  pushObject(Buffer.concat([
    Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'binary'),
    stream,
    Buffer.from('\nendstream', 'binary'),
  ]));
  const imageResource = imageObject ? `/XObject << /Im1 ${imageObject} 0 R >>` : '';
  objects[2] = Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> ${imageResource} >> /Contents ${contentObject} 0 R >>`, 'binary');

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
  rating: string; photoUrl: string | null; tripUrl: string; direction: string;
}): string {
  const initials = input.driverName.split(/\s+/).map((part) => part.charAt(0)).filter(Boolean).slice(0, 2).join('').toUpperCase() || 'DR';
  const photo = input.photoUrl
    ? `<img src="${html(input.photoUrl)}" alt="${html(input.driverName)}" width="68" height="68" style="display:block;width:68px;height:68px;border-radius:16px;object-fit:cover;border:1px solid #dce4f5;">`
    : `<table role="presentation" width="68" height="68" cellspacing="0" cellpadding="0" style="width:68px;height:68px;background:#edf2ff;border-radius:16px;"><tr><td align="center" valign="middle" style="font-family:Arial,Helvetica,sans-serif;color:#2563eb;font-size:20px;font-weight:bold;">${html(initials)}</td></tr></table>`;
  const driverId = input.driverId ? `<br><span style="color:#737b8a;font-size:12px;">${html(input.driverId)}</span>` : '';
  const phone = input.driverPhone ? `<a href="tel:${html(input.driverPhone.replace(/[^\d+]/g, ''))}" style="color:#2563eb;text-decoration:none;">Call driver: ${html(input.driverPhone)}</a>` : 'Phone number available in your DrivX trip';
  const rating = input.rating ? `&nbsp;·&nbsp; <span style="color:#936c00;">&#9733; ${html(input.rating)}</span>` : '';
  const direction = html(input.direction);
  const trip = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#f5f2ed;border-radius:16px;"><tr><td style="padding:18px 20px 12px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="font-size:11px;letter-spacing:.6px;color:#747b86;font-weight:bold;">YOUR TRIP &middot; ${html(input.reference)}</td><td align="right"><span style="display:inline-block;background:#e9f7ee;border-radius:12px;padding:5px 11px;color:#15803d;font-size:10px;font-weight:bold;">CONFIRMED</span></td></tr></table><div style="border-top:1px solid #dfdcd6;margin:13px 0 14px;"></div><div style="font-size:10px;letter-spacing:.5px;color:#737b86;font-weight:bold;">PICKUP</div><div style="font-size:14px;line-height:1.5;color:#17191e;padding:3px 0 12px;">${html(input.pickup)}</div><div style="font-size:10px;letter-spacing:.5px;color:#737b86;font-weight:bold;">DROP-OFF</div><div style="font-size:14px;line-height:1.5;color:#17191e;padding:3px 0 14px;">${html(input.destination)}</div><div style="border-top:1px solid #dfdcd6;padding-top:12px;font-size:11px;line-height:1.6;color:#5e6571;">${html(input.time)} &nbsp;&nbsp;|&nbsp;&nbsp; ${direction}</div></td></tr></table>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your DrivX ride is confirmed</title></head><body style="margin:0;padding:0;background:#f5f2ed;font-family:Arial,Helvetica,sans-serif;color:#15171b;-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#f5f2ed;border-collapse:collapse;"><tr><td align="center" style="padding:26px 12px 30px;">
    <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;border-collapse:separate;border-spacing:0;">
      <tr><td style="padding:0 0 18px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td><table role="presentation" cellspacing="0" cellpadding="0"><tr><td width="34" height="34" align="center" valign="middle" style="width:34px;height:34px;background:#2563eb;border-radius:10px;color:#fff;font-size:20px;font-weight:bold;">D</td><td style="padding-left:10px;color:#1b2b5b;font-size:21px;font-weight:bold;">DrivX</td></tr></table></td><td align="right" style="font-size:10px;letter-spacing:.6px;color:#626a76;font-weight:bold;">CUSTOMER EMAIL</td></tr></table></td></tr>
      <tr><td style="padding:0 0 14px;"><h1 style="margin:0;color:#15171b;font-size:26px;line-height:1.2;letter-spacing:-.4px;">Your DrivX ride is confirmed.</h1><p style="margin:7px 0 0;color:#727986;font-size:13px;line-height:1.5;">Your driver is assigned. Keep these details handy for pickup.</p></td></tr>
      <tr><td style="padding:24px 24px 20px;background:#fff;border:1px solid #e1ded8;border-radius:20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;"><tr><td width="56" valign="middle"><table role="presentation" width="44" height="44" cellspacing="0" cellpadding="0" style="width:44px;height:44px;background:#edf2ff;border-radius:14px;"><tr><td align="center" valign="middle" style="color:#2563eb;font-size:21px;font-weight:bold;">&#9776;</td></tr></table></td><td valign="middle"><div style="font-size:11px;letter-spacing:.5px;color:#1b2b5b;font-weight:bold;">DRIVX RIDE DESK</div><div style="font-size:11px;color:#858b95;margin-top:3px;">Booking confirmation</div></td></tr></table>
        <div style="border-top:1px solid #e7e4df;margin:17px 0 17px;"></div>
        <h2 style="font-size:19px;line-height:1.35;margin:0 0 12px;color:#15171b;">Booking confirmed: ${html(input.reference)}</h2>
        <p style="font-size:13px;line-height:1.55;color:#737b86;margin:0 0 5px;"><b style="font-size:10px;letter-spacing:.5px;color:#737b86;">TO</b>&nbsp;&nbsp; ${html(input.customerName)}</p>
        <p style="font-size:13px;line-height:1.55;color:#737b86;margin:0 0 5px;"><b style="font-size:10px;letter-spacing:.5px;color:#737b86;">FROM</b>&nbsp;&nbsp; DrivX Ride Desk</p>
        <p style="font-size:13px;line-height:1.55;color:#737b86;margin:0 0 20px;"><b style="font-size:10px;letter-spacing:.5px;color:#737b86;">WHEN</b>&nbsp;&nbsp; ${html(input.time)}</p>
        <p style="font-size:14px;line-height:1.6;margin:0 0 8px;color:#17191e;">Hi ${html(input.customerName)},</p>
        <p style="font-size:13px;line-height:1.6;margin:0 0 18px;color:#30343c;">Thank you for choosing DrivX. Your driver has been assigned and your trip details are below. The attached confirmation PDF is easy to keep for reference.</p>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#e9f7ee;border-radius:14px;margin:0 0 14px;"><tr><td style="padding:14px 17px;"><div style="font-size:11px;letter-spacing:.5px;color:#15803d;font-weight:bold;">YOUR DRIVER IS ASSIGNED</div><div style="font-size:12px;line-height:1.5;color:#262b31;margin-top:5px;">${html(input.driverName)} &middot; DrivX Captain &middot; Identity verified by DrivX</div></td></tr></table>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:0;border:1px solid #e1ded8;border-radius:16px;margin:0 0 14px;"><tr><td width="96" valign="middle" style="padding:15px 0 15px 15px;">${photo}<div style="font-size:8px;color:#737b86;margin-top:4px;">DRIVER PROFILE PHOTO</div></td><td valign="middle" style="padding:14px 16px 14px 12px;font-size:12px;line-height:1.5;color:#272b32;"><b style="font-size:16px;color:#17191e;">${html(input.driverName)}</b><br><span style="color:#737b86;">DrivX Captain${rating}</span>${driverId}<br><span style="color:#4c5667;">Vehicle: ${html(input.vehicle)}</span><br><span style="font-size:11px;">${phone}</span></td></tr><tr><td colspan="2" style="padding:0 16px 14px;font-size:10px;line-height:1.45;color:#737b86;">DrivX has verified the driver's identity and required documents. Government ID scans and full ID numbers are kept private with authorised verification staff.</td></tr></table>
        ${trip}
        <div style="padding:17px 0 0;"><div style="font-size:10px;letter-spacing:.5px;color:#737b86;font-weight:bold;">FARE &amp; PAYMENT</div><p style="font-size:13px;line-height:1.55;color:#30343c;margin:7px 0 14px;">Estimated fare <b style="color:#1b2b5b;font-size:17px;">${html(input.fare)}</b>. No charge is made now; the final fare is confirmed from the completed trip record and applicable fare rules. Any changes will be shown in your app.</p></div>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:5px;"><tr><td width="40%" valign="middle"><a href="${html(input.tripUrl)}" style="display:inline-block;background:#2563eb;border-radius:22px;padding:13px 19px;color:#fff;text-decoration:none;font-size:12px;font-weight:bold;">Open your trip</a></td><td valign="middle" style="border:1px solid #e1ded8;border-radius:14px;padding:10px 14px;font-size:11px;color:#333943;"><b style="color:#2563eb;">PDF</b>&nbsp;&nbsp; Trip confirmation &middot; ${html(input.reference)}<br><span style="font-size:9px;color:#818894;">1 page attached</span></td></tr></table>
      </td></tr>
      <tr><td style="padding:18px 18px 0;"><p style="font-size:13px;line-height:1.5;color:#272b32;margin:0 0 5px;"><b>Thanks for riding with DrivX.</b></p><p style="font-size:11px;line-height:1.6;color:#737b86;margin:0;">Need help? <a href="mailto:customersupport@drivx.in" style="color:#2563eb;text-decoration:none;">customersupport@drivx.in</a> &nbsp;|&nbsp; +91 87085 06508 &nbsp;|&nbsp; +91 98130 51505</p><p style="font-size:10px;line-height:1.5;color:#858b95;margin:12px 0 0;"><a href="${html(`${PUBLIC_ORIGIN}/privacy-policy.html`)}" style="color:#737b86;">Privacy Policy</a> &nbsp;|&nbsp; DrivX &middot; Your car. Your rules.</p></td></tr>
    </table>
  </td></tr></table></body></html>`;
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
  const tripDirection = booking.tripDirection === 'round_trip' ? 'Round trip' : 'One way';
  const serviceTypeId = value(booking.serviceTypeId);
  const direction = serviceTypeId === 'chauffeur_outstation'
    ? `Outstation - ${tripDirection}`
    : serviceTypeId === 'chauffeur_hourly'
      ? 'Hourly package'
      : `In-city - ${tripDirection}`;
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
      if ((contentType === 'image/jpeg' || contentType === 'image/png') && size > 0 && size <= 2_000_000) {
        const [download] = await file.download();
        photoBytes = download;
        const [signed] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 72 * 60 * 60 * 1000 });
        photoUrl = signed;
      }
    } catch (error) {
      console.warn(JSON.stringify({ level: 'warn', fn: 'sendCustomerAssignmentEmail', bookingId, outcome: 'driver_photo_unavailable', code: (error as { code?: unknown }).code ?? 'unknown' }));
    }
  }

  const pdf = makePdf({
    reference,
    driverName,
    driverPhone: driverPhone || 'Phone number unavailable',
    driverId: driverId || 'Available in the trip screen',
    vehicle: vehicleLabel,
    rating: rating || 'New driver',
    pickup,
    destination,
    time,
    direction,
    fare,
  }, photoBytes);
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
      html: emailHtml({ customerName, reference, pickup, destination, time, fare, driverName, driverPhone, driverId, vehicle: vehicleLabel, rating, photoUrl, tripUrl, direction }),
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
