import { defineSecret } from 'firebase-functions/params';

/**
 * Deployment knobs. Everything here has a working default so the emulator runs
 * with no environment setup, and every value can be overridden with
 * `firebase functions:config:set` or a `.env` file at deploy time.
 */
const raw = process.env;

/** Cashfree credentials live in Secret Manager and are bound only to payment functions. */
export const CASHFREE_APP_ID = defineSecret('CASHFREE_APP_ID');
export const CASHFREE_SECRET_KEY = defineSecret('CASHFREE_SECRET_KEY');
/** Customer assignment email credentials are bound only to the booking notification trigger. */
export const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
export const RESEND_FROM_EMAIL = defineSecret('RESEND_FROM_EMAIL');

export const REGION = raw.DRIVX_FUNCTION_REGION ?? 'asia-south1';
export const PUBLIC_ORIGIN = raw.DRIVX_PUBLIC_ORIGIN ?? 'https://drivx.in';
export const PROJECT_ID = raw.GCLOUD_PROJECT ?? raw.GCP_PROJECT ?? 'drivx-116de';

/** Cloud Functions share the Mumbai region with the Firestore location. */
export const REGION_OPTIONS = { region: REGION } as const;

/** HTTPS callable defaults: explicit origins for the customer, driver and admin web apps. */
export const CALLABLE_OPTIONS = {
  region: REGION,
  memory: '256MiB' as const,
  // Keep the callable fleet inside Cloud Run's regional CPU allocation quota.
  // These authenticated request handlers are short lived and already have
  // bounded workloads; fractional Gen 1 CPU with one instance per function
  // avoids reserving a full vCPU for every callable service.
  cpu: 'gcf_gen1' as const,
  maxInstances: 1,
  timeoutSeconds: 30,
  /** Never wildcard: callable auth stays enforced and only our known app origins may call from browsers. */
  cors: (
    raw.DRIVX_ADMIN_ORIGIN ??
    [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      'http://localhost:3003',
      'http://localhost:8081',
      'http://localhost:8084',
      'https://drivx.in',
      'https://drivx-116de.web.app',
      'https://drivx-driver.web.app',
    ].join(',')
  )
    .split(',')
    .map((s) => s.trim()),
};

export const OTP_CONFIG = {
  maxAttempts: 5,
  length: 6,
};

export const RATE_LIMITS = {
  /** Bookings a single customer may create inside the window. */
  bookingsPerCustomerPerHour: 6,
  /** Support tickets a customer may open per day. */
  ticketsPerCustomerPerDay: 10,
};

export const RETENTION = {
  /** Terminal bookings keep precise coordinates this long, then they are stripped. */
  stripLocationAfterDays: 30,
  /** Trip-start OTPs are deleted outright after a day. */
  purgeOtpAfterDays: 1,
  /** Anonymised trip summaries are kept for accounting. */
  keepSummariesDays: 820,
};
