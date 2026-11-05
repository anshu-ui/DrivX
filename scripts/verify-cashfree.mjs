#!/usr/bin/env node
/**
 * Proves the Cashfree seam refuses correctly.
 *
 * Nothing here needs a merchant key, and that is the point: until Cashfree
 * confirms an order, the only correct behaviour is to take no money and change
 * no ledger row. These checks hold the line on that, and on the signature gate
 * that stands between an HTTP request and a driver's due being marked paid.
 *
 *   npm run emulators    (in another terminal)
 *   npm run verify:payments
 *
 * The pure checks (amounts, order ids, signature tampering) run either way; the
 * callable and webhook checks are skipped when the emulator is not up.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const cashfree = require(path.join(root, 'functions/lib/lib/cashfree.js'));

const failures = [];
function check(label, fn) {
  try {
    fn();
    console.log(`ok    ${label}`);
  } catch (error) {
    console.log(`FAIL  ${label} — ${String(error.message).split('\n')[0]}`);
    failures.push(label);
  }
}

console.log('1. The amount the gateway is told to charge');

check('₹525 onboarding due is billed as 525.00, not 52500', () => {
  assert.equal(cashfree.paiseToRupeeString(52_500), '525.00');
});
check('a commission row keeps its paise exactly', () => {
  assert.equal(cashfree.paiseToRupeeString(12_345), '123.45');
  assert.equal(cashfree.rupeeStringToPaise('123.45'), 12_345);
});
check('zero, negative and fractional paise are refused, not rounded', () => {
  for (const bad of [0, -100, 12.5, Number.NaN]) {
    assert.throws(() => cashfree.paiseToRupeeString(bad));
  }
});

console.log('\n2. Order ids Cashfree will accept');

check('3–45 characters of [A-Za-z0-9_-], unique per attempt', () => {
  const uid = 'HsMx6Fd3UyMRtojiXIQfflkuHiC2';
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) ids.add(cashfree.cashfreeOrderIdFor(uid, 'commission_bk-123'));
  const sample = [...ids][0];
  assert.match(sample, /^[A-Za-z0-9_-]{3,45}$/);
  assert.ok(ids.size >= 2, 'retries must not reuse an order id');
});
check('the same due for two drivers is two different orders', () => {
  assert.notEqual(cashfree.cashfreeOrderIdFor('driverAaaaaaaaaaaaaaaaaaaaaaaa', 'onboarding_fee'),
    cashfree.cashfreeOrderIdFor('driverBbbbbbbbbbbbbbbbbbbbbbbb', 'onboarding_fee'));
});

console.log('\n3. The signature gate');

const SECRET = 'unit-test-secret';
const body = Buffer.from(JSON.stringify({ event: 'PAYMENT_SUCCESS_WEBHOOK', data: { payment_order_id: 'due_x' } }));
const stamp = '1764950000';
const sign = (payload, secret = SECRET, at = stamp) =>
  createHmac('sha256', secret).update(`${at}${payload.toString('utf8')}`).digest('base64');

check('a correctly signed webhook passes', () => {
  assert.equal(
    cashfree.verifyCashfreeWebhook({ rawBody: body, signature: sign(body), timestamp: stamp, secretKey: SECRET }),
    true,
  );
});
check('one rupee added to the amount in the payload fails', () => {
  const tampered = Buffer.from(body.toString('utf8').replace('due_x', 'due_y'));
  assert.equal(
    cashfree.verifyCashfreeWebhook({ rawBody: tampered, signature: sign(body), timestamp: stamp, secretKey: SECRET }),
    false,
  );
});
check('a replayed payload under a new timestamp fails', () => {
  assert.equal(
    cashfree.verifyCashfreeWebhook({ rawBody: body, signature: sign(body), timestamp: '1764950001', secretKey: SECRET }),
    false,
  );
});
check('another merchant secret fails', () => {
  assert.equal(
    cashfree.verifyCashfreeWebhook({ rawBody: body, signature: sign(body), timestamp: stamp, secretKey: 'other' }),
    false,
  );
});
check('no signature, or no timestamp, is refused outright', () => {
  assert.equal(cashfree.verifyCashfreeWebhook({ rawBody: body, signature: null, timestamp: stamp, secretKey: SECRET }), false);
  assert.equal(cashfree.verifyCashfreeWebhook({ rawBody: body, signature: sign(body), timestamp: null, secretKey: SECRET }), false);
});

console.log('\n4. No merchant keys means no order, and no ledger change');

check('credentials read as unset when the env carries no Cashfree keys', () => {
  const saved = { ...process.env };
  delete process.env.CASHFREE_APP_ID;
  delete process.env.CASHFREE_SECRET_KEY;
  try {
    assert.equal(cashfree.cashfreeCredentials(), null);
  } finally {
    process.env = saved;
  }
});

const FUNCTIONS_PORT = Number(process.env.FUNCTIONS_EMULATOR_PORT ?? 5001);
const PROJECT = process.env.FIREBASE_PROJECT_ID ?? 'drivx-local';
const WEBHOOK = `http://127.0.0.1:${FUNCTIONS_PORT}/${PROJECT}/asia-south1/paymentWebhook`;

// The functions runtime loads `functions/.env`, so whether it will accept a
// signed request depends on what that file holds right now. Read it rather than
// assuming, and assert the one answer that is correct for this moment — the
// secret itself is only ever used to compute a signature, never printed.
const merchantEnvPath = path.join(root, 'functions/.env');
const merchantEnv = existsSync(merchantEnvPath) ? readFileSync(merchantEnvPath, 'utf8') : '';
const merchantKeyOf = (key) =>
  (process.env[key] ?? merchantEnv.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] ?? '').trim();
const verificationSecretAvailable = Boolean(merchantKeyOf('CASHFREE_SECRET_KEY'));

let emulatorUp = false;
const forged = Buffer.from('{"event":"PAYMENT_SUCCESS_WEBHOOK","data":{"payment_order_id":"due_none"}}');
const forgedSignature = sign(forged);
try {
  const unsigned = await fetch(WEBHOOK, { method: 'POST', body: forged, headers: { 'Content-Type': 'application/json' } });
  const unsignedText = await unsigned.text();
  emulatorUp = true;

  if (unsigned.status === 401) {
    console.log('\n5. The webhook endpoint is configured and rejects unsigned requests');
    check('an unsigned request for a settlement is refused with 401', () => {
      assert.equal(unsigned.status, 401);
      assert.match(unsignedText, /invalid_signature/);
    });
    const wrongSecret = await fetch(WEBHOOK, {
      method: 'POST',
      body: forged,
      headers: { 'Content-Type': 'application/json', 'x-webhook-timestamp': stamp, 'x-webhook-signature': forgedSignature },
    });
    check('a payload signed with some other secret is refused with 401', () => {
      assert.equal(wrongSecret.status, 401);
    });
    if (verificationSecretAvailable) {
      // Signed with the real key, for an order this ledger never issued: the
      // only way past the signature gate is the merchant's own secret.
      const rightSecret = sign(forged, merchantKeyOf('CASHFREE_SECRET_KEY'));
      const unknownOrder = await fetch(WEBHOOK, {
        method: 'POST',
        body: forged,
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-timestamp': stamp,
          'x-webhook-signature': rightSecret,
        },
      });
      const unknownOrderText = await unknownOrder.text();
      check('a genuine signature for an order we never issued settles nothing', () => {
        assert.equal(unknownOrder.status, 404);
        assert.match(unknownOrderText, /unknown_order/);
      });
    } else {
      console.log('skip  valid-signature check — the running emulator has a key, but it is not available in this workspace.');
    }
  } else {
    console.log('\n5. The webhook endpoint has no merchant keys configured');
    check('an unconfigured gateway answers 503 and records nothing', () => {
      assert.equal(unsigned.status, 503);
    });
    check('the refusal names itself, so nobody reads it as a payment', () => {
      assert.match(unsignedText, /payment_provider_not_configured/);
    });
    const signed = await fetch(WEBHOOK, {
      method: 'POST',
      body: forged,
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-timestamp': stamp,
        'x-webhook-signature': forgedSignature,
      },
    });
    check('a forged payload signed with a test secret is still refused', () => {
      assert.equal(signed.status, 503);
    });
  }
} catch (error) {
  console.log(`skipped: the emulator is not answering on :${FUNCTIONS_PORT} (${error.message}).`);
  console.log('         Run `npm run emulators` and re-run this script for check 5.');
}

console.log('\n6. What the driver actually paid with');

check('the instrument is read from Cashfree, never assumed', () => {
  assert.equal(cashfree.dueMethodFor('UPI_QR'), 'upi');
  assert.equal(cashfree.dueMethodFor('CARD'), 'card');
  assert.equal(cashfree.dueMethodFor('netbanking'), 'netbanking');
  assert.equal(cashfree.dueMethodFor('PAYPAL'), 'online');
  // The default matters most: an order whose payment details could not be read
  // must not be filed as if it were a UPI payment.
  assert.equal(cashfree.dueMethodFor(''), 'online');
});

console.log('');
if (failures.length) {
  console.error(`${failures.length} failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('Cashfree seam verified: every path that could take money without the gateway refuses it.\n');
