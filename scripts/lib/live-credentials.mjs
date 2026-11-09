#!/usr/bin/env node
/**
 * A credential the deploy and the one-off provisioning scripts can use against
 * the live project, without creating a service-account key.
 *
 * `scripts/seed.mjs` is emulator-only on purpose: writing production data needs
 * the Admin SDK, and the usual way to hand that to a laptop is a Google service
 * account key file — a long-lived secret that must never sit in a repository or
 * on a desk. This machine already holds a shorter-lived one: the Firebase CLI's
 * OAuth refresh token for `amit@referralme.in`, whose scopes include
 * `cloud-platform`, which is everything the Admin SDK needs.
 *
 * So the credential is the CLI's own, re-minted through the CLI's own code, and
 * it never leaves this machine. Delete it before handing the laptop to anyone.
 *
 * Exports `liveCredentials()` so a caller can also read the raw token and call
 * a REST API the Admin SDK does not cover, such as the Identity Toolkit admin
 * config endpoint.
 */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const CONFIG = `${os.homedir()}/.config/configstore/firebase-tools.json`;
const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform';

function cliCredentialsJson() {
  if (!existsSync(CONFIG)) {
    throw new Error(
      `No Firebase CLI credential file at ${CONFIG}. Run \`firebase login\` as the project owner.`,
    );
  }
  return JSON.parse(readFileSync(CONFIG, 'utf8'));
}

/** The account the CLI is currently using for this directory, i.e. `login:use`. */
export function cliAccount() {
  const store = cliCredentialsJson();
  const active = store.activeAccounts?.[process.cwd()];
  if (active) return active;
  return store.user?.email;
}

/**
 * The same credential in the shape `firebase-admin` wants, so a caller can write
 * with Admin SDK privileges (which security rules do not apply to) instead of
 * hand-rolling REST calls.
 */
export function liveRefreshCredential() {
  const account = cliAccount();
  const store = cliCredentialsJson();
  // Firebase CLI can keep an older copy of the same account in
  // `additionalAccounts` after `login --reauth`. Prefer the primary token set
  // whenever it belongs to the selected account; otherwise a provisioning
  // script may keep refreshing the stale duplicate and receive invalid_rapt.
  const tokens = store.user?.email === account
    ? store.tokens
    : (store.additionalAccounts ?? []).find((entry) => entry.user?.email === account)?.tokens;
  if (!tokens?.refresh_token) throw new Error(`No refresh token stored for ${account}.`);

  const require = createRequire(import.meta.url);
  const api = require('firebase-tools/lib/api.js');
  return {
    account,
    credential: {
      client_id: api.clientId(),
      client_secret: api.clientSecret(),
      refresh_token: tokens.refresh_token,
      type: 'authorized_user',
    },
  };
}

/**
 * `firebase-admin` accepts a refresh-token credential directly, and refreshes it
 * itself on demand — no token printed, no key file, nothing to revoke by hand.
 */
export async function liveCredentials() {
  const { account, credential } = liveRefreshCredential();

  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ credentials: credential, scopes: [CLOUD_PLATFORM] });
  const client = await auth.getClient();
  return { account, auth, client };
}

/** A fresh OAuth access token, for REST calls the Admin SDK does not expose. */
export async function liveAccessToken() {
  const { client } = await liveCredentials();
  // `UserRefreshClient.getAccessToken()` returns a bare string in some versions
  // of google-auth-library and `{ token, res }` in others; a token that is an
  // object silently becomes "Bearer [object Object]" and every API answers 401.
  const issued = await client.getAccessToken();
  const token = typeof issued === 'string' ? issued : (issued?.token ?? issued?.access_token);
  if (!token) throw new Error('Could not mint an access token from the stored CLI credential.');
  return token;
}
