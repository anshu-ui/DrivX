import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Cashfree's order API, called directly over fetch.
 *
 * Three properties hold this money surface together:
 *
 * - The amount is always derived from our own ledger in paise and converted
 *   here; no caller ever names a rupee figure.
 * - A payment is only believed after Cashfree's own `GET /orders/{id}` read
 *   confirms it. A webhook is a pointer to an order, not proof of money.
 * - A webhook whose signature does not match the raw body is answered `401`
 *   and writes nothing at all.
 *
 * The signature scheme is the one Cashfree documents today: base64 of
 * HMAC-SHA256 over `x-webhook-timestamp` concatenated with the *raw* request
 * body, keyed with the merchant secret key, compared to `x-webhook-signature`.
 */

export type CashfreeEnvironment = 'production' | 'sandbox';

export type CashfreeCredentials = {
  appId: string;
  secretKey: string;
  environment: CashfreeEnvironment;
};

/** `null` until the merchant keys exist; the caller refuses rather than pretending. */
export function cashfreeCredentials(): CashfreeCredentials | null {
  const appId = process.env.CASHFREE_APP_ID?.trim();
  const secretKey = process.env.CASHFREE_SECRET_KEY?.trim();
  if (!appId || !secretKey) return null;
  return {
    appId,
    secretKey,
    environment: process.env.CASHFREE_ENV?.trim() === 'sandbox' ? 'sandbox' : 'production',
  };
}

const API_VERSION = '2026-01-01';

function baseUrl(environment: CashfreeEnvironment): string {
  return environment === 'sandbox' ? 'https://sandbox.cashfree.com/pg' : 'https://api.cashfree.com/pg';
}

/** Cashfree prices in rupees with paise precision; our ledger is whole paise. */
export function paiseToRupeeString(paise: number): string {
  if (!Number.isInteger(paise) || paise <= 0) {
    throw new Error(`Refusing to charge a non-integer or non-positive paise amount: ${paise}`);
  }
  return (paise / 100).toFixed(2);
}

export function rupeeStringToPaise(value: unknown): number | null {
  const rupees = typeof value === 'string' ? Number(value) : Number(value);
  if (!Number.isFinite(rupees) || rupees <= 0) return null;
  return Math.round(rupees * 100);
}

export type CashfreeOrder = {
  orderId: string;
  /** Cashfree's own id for the order. Their v2026-01-01 API returns it as a string. */
  cfOrderId: string | null;
  orderStatus: string;
  amountPaise: number | null;
  paymentSessionId: string | null;
};

function asOrder(raw: Record<string, unknown>, orderId: string): CashfreeOrder {
  const cfOrderId = raw.cf_order_id;
  return {
    orderId: String(raw.order_id ?? orderId),
    cfOrderId:
      cfOrderId === undefined || cfOrderId === null || cfOrderId === '' ? null : String(cfOrderId),
    orderStatus: String(raw.order_status ?? 'UNKNOWN'),
    amountPaise: rupeeStringToPaise(raw.order_amount),
    paymentSessionId: typeof raw.payment_session_id === 'string' ? raw.payment_session_id : null,
  };
}

async function call(
  credentials: CashfreeCredentials,
  method: 'POST' | 'GET',
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const response = await fetch(`${baseUrl(credentials.environment)}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': credentials.appId,
      'x-client-secret': credentials.secretKey,
      'x-api-version': API_VERSION,
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

export type NewCashfreeOrder = {
  orderId: string;
  amountPaise: number;
  customerPhone: string;
  customerEmail: string | null;
  customerName: string | null;
  orderNote: string;
  orderTags: Record<string, string>;
  returnUrl?: string;
  notifyUrl?: string;
};

/** Creates the order. A duplicate `order_id` is a 409, which this surfaces as a failure. */
export async function createCashfreeOrder(
  credentials: CashfreeCredentials,
  order: NewCashfreeOrder,
): Promise<CashfreeOrder> {
  const { status, json, text } = await call(credentials, 'POST', '/orders', {
    order_id: order.orderId,
    order_amount: Number(paiseToRupeeString(order.amountPaise)),
    order_currency: 'INR',
    order_note: order.orderNote,
    order_tags: order.orderTags,
    ...(order.returnUrl || order.notifyUrl
      ? {
          order_meta: {
            ...(order.returnUrl ? { return_url: order.returnUrl } : {}),
            ...(order.notifyUrl ? { notify_url: order.notifyUrl } : {}),
          },
        }
      : {}),
    customer_details: {
      customer_id: order.orderTags.customer_ref ?? order.orderId.slice(0, 50),
      customer_phone: order.customerPhone,
      ...(order.customerEmail ? { customer_email: order.customerEmail } : {}),
      ...(order.customerName ? { customer_name: order.customerName } : {}),
    },
  });

  if (status !== 200 || !json) {
    throw new Error(`Cashfree refused the order (${status}): ${text.slice(0, 200)}`);
  }
  return asOrder(json, order.orderId);
}

/**
 * Reads an order back from the gateway.
 *
 * This is the only thing that turns a webhook into a settled due: the webhook
 * tells us which order to look at, and this call tells us whether the money
 * actually arrived and how much.
 */
export async function fetchCashfreeOrder(
  credentials: CashfreeCredentials,
  orderId: string,
): Promise<CashfreeOrder | null> {
  const { status, json, text } = await call(credentials, 'GET', `/orders/${encodeURIComponent(orderId)}`);
  if (status === 404) return null;
  if (status !== 200 || !json) {
    throw new Error(`Cashfree order read failed (${status}): ${text.slice(0, 200)}`);
  }
  return asOrder(json, orderId);
}

export type CashfreePayment = {
  paymentId: string;
  status: string;
  /** Cashfree's own name for the instrument, e.g. `UPI_QR`, `CARD`, `bank_transfer`. */
  instrument: string;
  amountPaise: number | null;
};

/**
 * The payments behind an order.
 *
 * `GET /orders/{id}` does not carry them — proved against the live API, where a
 * fresh order's response has no payment field at all — so the ledger's `method`
 * column can only be filled honestly from this endpoint. It answers `[]` while
 * an order is still unpaid.
 */
export async function fetchCashfreeOrderPayments(
  credentials: CashfreeCredentials,
  orderId: string,
): Promise<CashfreePayment[]> {
  const { status, json, text } = await call(
    credentials,
    'GET',
    `/orders/${encodeURIComponent(orderId)}/payments`,
  );
  if (status !== 200 || !Array.isArray(json)) {
    throw new Error(`Cashfree payment read failed (${status}): ${text.slice(0, 200)}`);
  }
  return json.map((row) => {
    const payment = row as Record<string, unknown>;
    return {
      paymentId: String(payment.payment_id ?? ''),
      status: String(payment.payment_status ?? 'UNKNOWN'),
      instrument: String(payment.payment_method ?? ''),
      amountPaise: rupeeStringToPaise(payment.payment_amount),
    };
  });
}

/**
 * Cashfree's instrument name, mapped onto the vocabulary the ledger stores.
 *
 * Anything the map does not recognise stays `online`. Labelling a payment `upi`
 * because that is the common case would invent a fact the office relies on.
 */
export function dueMethodFor(instrument: string): 'card' | 'upi' | 'netbanking' | 'wallet' | 'online' {
  const name = instrument.toUpperCase();
  if (name.startsWith('CARD')) return 'card';
  if (name.startsWith('UPI')) return 'upi';
  if (name.startsWith('NETBANKING') || name.startsWith('BANK_TRANSFER')) return 'netbanking';
  if (name.startsWith('WALLET')) return 'wallet';
  return 'online';
}

/**
 * Verifies a webhook against the raw body.
 *
 * `rawBody` must be the bytes as received. Parsing the JSON and re-serialising it
 * changes key order and spacing, and the signature of that rewrite matches
 * nothing — so the caller hands the buffer over untouched.
 */
export function verifyCashfreeWebhook(input: {
  rawBody: Buffer;
  signature: string | null;
  timestamp: string | null;
  secretKey: string;
}): boolean {
  if (!input.signature || !input.timestamp) return false;
  const signed = `${input.timestamp}${input.rawBody.toString('utf8')}`;
  const expected = createHmac('sha256', input.secretKey).update(signed).digest('base64');
  const received = Buffer.from(input.signature, 'utf8');
  const computed = Buffer.from(expected, 'utf8');
  if (received.length !== computed.length) return false;
  return timingSafeEqual(received, computed);
}

/** Cashfree order ids: 3–45 characters of `[A-Za-z0-9_-]`, unique per attempt. */
export function cashfreeOrderIdFor(driverUid: string, dueId: string): string {
  const hash = createHmac('sha256', driverUid).update(dueId).digest('hex').slice(0, 16);
  return `due_${hash}_${Date.now().toString(36)}`;
}
