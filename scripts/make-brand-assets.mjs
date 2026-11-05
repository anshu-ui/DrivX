#!/usr/bin/env node
/**
 * Builds every DrivX brand image from the one logo file the business owns.
 *
 * The supplied artwork came out of an image generator with its transparency
 * checkerboard *painted into the pixels* — all 1.08 M of them opaque — so it
 * cannot be dropped onto a screen as-is. The mark is near-black (luminance
 * 24–47) and the two checker tones are light (208–255) with a wide empty band
 * between them, which is what makes a luminance key safe here: alpha is a ramp
 * across that band, so the anti-aliased edge of the mark survives and the
 * painted grid disappears.
 *
 *   node scripts/make-brand-assets.mjs <path-to-logo.png>   # re-extract, then build
 *   node scripts/make-brand-assets.mjs                       # build from the stored master
 *
 * The extracted master is written next to its outputs, so the repo never needs
 * the original download again.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const mobileAssets = join(root, 'apps/mobile/assets');
const mobilePublic = join(root, 'apps/mobile/public');
const adminApp = join(root, 'apps/admin/app');
const adminPublic = join(root, 'apps/admin/public');

/** `palette.ink`. */
const INK = [0x0f, 0x17, 0x2a];
const WHITE = [255, 255, 255];

/** Luminance ramp: at or below DARK a pixel is fully mark, at or above LIGHT fully ground. */
const DARK = 60;
const LIGHT = 200;

const masterPath = join(mobileAssets, 'logo-mark-source.png');
const source = process.argv[2];

/**
 * Key the artwork out and repaint it in one flat colour, keeping only its
 * coverage as alpha.
 *
 * The source colour is discarded on purpose: the artwork's own near-black and
 * the brand ink are a few units apart, and a mark that drifts from the token
 * the headings use looks like a different brand sitting beside them.
 */
async function extractToInkAlpha(path) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i += info.channels) {
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const a = Math.min(1, Math.max(0, (LIGHT - l) / (LIGHT - DARK)));
    [out[i], out[i + 1], out[i + 2]] = INK;
    out[i + 3] = Math.round(a * 255);
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } });
}

/** Tight box around the mark, so later steps scale from the artwork and not from its canvas. */
async function markBox(image) {
  const { data, info } = await image.clone().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * info.channels + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('keying found no mark at all — check the artwork');
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Repaint every opaque pixel `colour`, keeping alpha. Returns a PNG buffer. */
async function recolour(image, colour) {
  const { data, info } = await image.clone().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i += info.channels) {
    [out[i], out[i + 1], out[i + 2]] = colour;
    out[i + 3] = data[i + 3];
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/** Centre a PNG buffer on a `size` square canvas, over a flat ground or nothing. */
async function plate(mark, size, ground) {
  // This sharp build parses a background as a colour, so even the transparent
  // case needs a full RGB triple alongside the alpha.
  const background = ground
    ? { r: ground[0], g: ground[1], b: ground[2], alpha: 1 }
    : { r: 0, g: 0, b: 0, alpha: 0 };
  const canvas = sharp({
    create: { width: size, height: size, channels: 4, background },
  });
  return (mark ? canvas.composite([{ input: mark, gravity: 'centre' }]) : canvas).png().toBuffer();
}

/** Scale a mark so its longer edge is `side`, preserving aspect. */
async function fit(mark, side) {
  return sharp(mark).resize(side, side, { fit: 'inside' }).png().toBuffer();
}

function save(buffer, path) {
  writeFileSync(path, buffer);
  console.log('wrote', path.replace(`${root}/`, ''));
}

/**
 * Wrap a square PNG in an ICO container.
 *
 * This sharp build has no ICO encoder, and a browser requests `/favicon.ico`
 * from the dev server before anything points it elsewhere, so the container is
 * written here. A PNG payload in an ICO is the Vista-and-later form.
 */
function icoFromPng(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size % 256, 0);
  entry.writeUInt8(size % 256, 1);
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);
  return Buffer.concat([header, entry, png]);
}

async function main() {
  let master;
  if (source) {
    if (!existsSync(source)) {
      console.error(`No logo at ${source}`);
      process.exit(1);
    }
    const keyed = await extractToInkAlpha(source);
    const box = await markBox(keyed);
    // The mark fills 80% of a 1024 square, which leaves every icon to scale
    // down from it rather than up.
    const mark = await keyed
      .clone()
      .extract(box)
      .resize(
        Math.round(box.width * (Math.round(1024 * 0.8) / Math.max(box.width, box.height))),
        Math.round(box.height * (Math.round(1024 * 0.8) / Math.max(box.width, box.height))),
        { fit: 'inside' },
      )
      .png()
      .toBuffer();
    master = await plate(mark, 1024);
    save(master, masterPath);
  } else {
    if (!existsSync(masterPath)) {
      console.error(
        `No ${masterPath.replace(`${root}/`, '')} and no source given.\n` +
          '  node scripts/make-brand-assets.mjs <path-to-logo.png>',
      );
      process.exit(1);
    }
    master = await sharp(masterPath).png().toBuffer();
  }

  const light = await recolour(sharp(master), WHITE);

  // In-app lockups keep a transparent ground so each surface supplies its own fill.
  save(await fit(master, 256), join(mobileAssets, 'logo-mark.png'));
  save(await fit(light, 256), join(mobileAssets, 'logo-mark-light.png'));

  // iOS icons must be opaque: white mark on the ink ground.
  save(await plate(await fit(light, 640), 1024, INK), join(mobileAssets, 'icon.png'));

  // The adaptive launcher crops a circle out of the safe zone, so the mark
  // stays at half the frame and the ground is a flat plate.
  save(await plate(await fit(light, 256), 512), join(mobileAssets, 'android-icon-foreground.png'));
  save(await plate(null, 512, INK), join(mobileAssets, 'android-icon-background.png'));
  save(await plate(await fit(light, 216), 432), join(mobileAssets, 'android-icon-monochrome.png'));

  // The splash sits on the pale ground app.json declares, so it keeps the ink mark.
  save(await plate(await fit(master, 430), 1024), join(mobileAssets, 'splash-icon.png'));

  // At 48px a smaller mark than this loses the gap under the arrow.
  save(await plate(await fit(light, 36), 48, INK), join(mobileAssets, 'favicon.png'));
  save(await plate(await fit(light, 379), 512, INK), join(adminApp, 'icon.png'));

  // A browser asks the dev server for /favicon.ico unprompted, and app.json's
  // web.favicon only reaches a static export, so the brand has to be at that
  // literal path in the public folder Metro serves ahead of its own template.
  mkdirSync(mobilePublic, { recursive: true });
  save(
    icoFromPng(await plate(await fit(light, 48), 64, INK), 64),
    join(mobilePublic, 'favicon.ico'),
  );

  // The admin header band is dark ink, so it takes the light mark; the pale
  // variant is there for any future light surface.
  save(await fit(light, 256), join(adminPublic, 'logo-mark-light.png'));
  save(await fit(master, 256), join(adminPublic, 'logo-mark.png'));

  console.log('\nRestart Metro with --clear: a renamed or new asset is not picked up live.');
}

await main();
