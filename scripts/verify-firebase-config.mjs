#!/usr/bin/env node
/**
 * Which Firebase backend do the apps actually get?
 *
 * Flipping `FIREBASE_EMULATOR` is the one switch that decides whether the app talks to the local
 * suite or to the live project, and a mistake in that resolution is invisible: with a live project
 * id while the emulator is on, sign-in works and every read comes back empty. This reads the real
 * env files, runs them through the same `buildClientEnv` the apps use, and asserts both halves —
 * emulator mode must carry no live address, live mode must carry the whole live config.
 *
 * No network, no emulator: it only needs the env files and the config resolver.
 *
 *   npm run verify:firebase-config
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildClientEnv } from '../packages/firebase-client/src/config.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_PROJECT = 'drivx-116de';
const LIVE_RTDB = `https://${LIVE_PROJECT}-default-rtdb.firebaseio.com`;
const LIVE_BUCKET = `${LIVE_PROJECT}.firebasestorage.app`;

function readEnvFile(file) {
  const values = {};
  for (const line of fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

/** apps/admin/lib/env.ts hands the resolver plain names; Expo keeps its own prefix. */
const adminShaped = (values) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k.replace(/^NEXT_PUBLIC_/, ''), v]));

const apps = [
  {
    name: 'mobile',
    file: 'apps/mobile/.env',
    source: readEnvFile('apps/mobile/.env'),
    flag: 'EXPO_PUBLIC_FIREBASE_EMULATOR',
    module: 'apps/mobile/src/lib/env.ts',
    prefix: 'EXPO_PUBLIC_',
  },
  {
    name: 'admin',
    file: 'apps/admin/.env.local',
    source: adminShaped(readEnvFile('apps/admin/.env.local')),
    flag: 'FIREBASE_EMULATOR',
    module: 'apps/admin/lib/env.ts',
    prefix: 'NEXT_PUBLIC_',
  },
];

/**
 * The names that decide which backend the browser talks to.
 *
 * A bundler can only replace `process.env.X` when it sees that exact reference written out, so an
 * env module that loops over key names and indexes `process.env` with a computed key hands the
 * browser `undefined` for everything. `buildClientEnv` then reports an unconfigured project and
 * switches to the emulator by design — which is how the operations console came to render a
 * server-side "live · drivx-116de" banner while the code on screen signed people in through
 * `127.0.0.1:9099`. Resolving the file correctly proves nothing about the bundle, so read the
 * module's text as well.
 */
const BACKEND_KEYS = [
  'FIREBASE_API_KEY',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_APP_ID',
  'FIREBASE_AUTH_DOMAIN',
  'FIREBASE_STORAGE_BUCKET',
  'FIREBASE_MESSAGING_SENDER_ID',
  'FIREBASE_DATABASE_URL',
  'FIREBASE_EMULATOR',
];

const results = [];
const check = (name, ok) => results.push({ name, ok });

for (const app of apps) {
  // The env files ship in live mode now, so the emulator half has to be forced
  // back on to test it — the point is that the resolver still behaves correctly
  // for anyone who runs this repo with the suite.
  const live = buildClientEnv(app.source);
  const emulator = buildClientEnv({ ...app.source, [app.flag]: 'true' });

  check(`${app.name}: the file itself runs against ${LIVE_PROJECT}`, app.source[app.flag] === 'false');
  check(`${app.name}: live mode resolves to ${LIVE_PROJECT}`, live.firebase?.projectId === LIVE_PROJECT);
  check(`${app.name}: live mode uses the firebasestorage bucket`, live.firebase?.storageBucket === LIVE_BUCKET);
  check(`${app.name}: live mode uses the configured database URL`, live.firebase?.databaseURL === LIVE_RTDB);
  check(`${app.name}: live mode leaves every emulator endpoint unset`, Object.values(live.emulator).every((v) => v === null));
  check(`${app.name}: emulator mode still resolves to drivx-local`, emulator.firebase?.projectId === 'drivx-local');
  check(`${app.name}: emulator mode carries no live database URL`, emulator.firebase?.databaseURL === undefined);
  check(`${app.name}: emulator mode still points every service at the suite`, Object.values(emulator.emulator).every(Boolean));

  const moduleText = fs.readFileSync(path.join(ROOT, app.module), 'utf8');
  for (const key of BACKEND_KEYS) {
    check(
      `${app.name}: ${app.prefix}${key} is written out in ${app.module}`,
      moduleText.includes(`${app.prefix}${key}`),
    );
  }
}

const failed = results.filter((r) => !r.ok);
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed — live project ${LIVE_PROJECT}, emulator project drivx-local.`);
if (failed.length > 0) {
  console.error('\nThe env files and the resolved config disagree. Do not ship either until that is fixed.');
  process.exit(1);
}
