#!/usr/bin/env node
/**
 * Runs before every Cloud Functions deploy (wired up as `predeploy` in
 * `firebase.json`).
 *
 * The functions import `@drivx/domain`, which lives in this workspace, but the
 * deploy bundle contains only `functions/` — `node_modules` is in the ignore
 * list, and the server-side build runs `npm install` from a clean checkout with
 * no access to this repository. Left alone, `"@drivx/domain": "*"` resolves
 * against the public registry, there is no such package, and the build dies
 * with a 404 that looks nothing like the monorepo problem it is.
 *
 * So the shared package is compiled and packed into `functions/vendor/`, where
 * the tarball travels with the source and `file:vendor/…` resolves offline.
 * Rebuilt on every deploy, because a vendored copy that drifts from the source
 * would price fares on rules the tests no longer cover.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOMAIN = `${ROOT}packages/domain`;
const VENDOR = `${ROOT}functions/vendor`;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd} (exit ${result.status})`);
  }
}

// Fail loudly rather than shipping yesterday's pricing code.
if (!existsSync(`${DOMAIN}/tsconfig.build.json`)) {
  throw new Error(`Shared package missing at ${DOMAIN}`);
}

const tsc = `${ROOT}node_modules/.bin/tsc`;
if (!existsSync(tsc)) throw new Error(`TypeScript not installed at ${tsc} — run npm install first.`);

console.log('› building @drivx/domain (CommonJS, for the Functions runtime)');
run(tsc, ['-p', 'tsconfig.build.json'], DOMAIN);

const tarball = 'drivx-domain-0.1.0.tgz';
console.log(`› packing @drivx/domain into functions/vendor/${tarball}`);
rmSync(VENDOR, { recursive: true, force: true });
mkdirSync(VENDOR, { recursive: true });
run('npm', ['pack', '--pack-destination', VENDOR], DOMAIN);

if (!existsSync(`${VENDOR}/${tarball}`)) {
  throw new Error(`Expected ${VENDOR}/${tarball} — check the version in packages/domain/package.json.`);
}

console.log(`✓ vendored; functions/package.json points at file:vendor/${tarball}`);
