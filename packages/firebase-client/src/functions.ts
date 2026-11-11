import { connectFunctionsEmulator, getFunctions, httpsCallable, type Functions } from 'firebase/functions';
import type { FirebaseClients } from './client';

/**
 * The single seam between an app and a trusted server.
 *
 * Nothing here decides a fare, a role, a trip state or a payment result — the
 * functions do, and when a function answers `unimplemented` this layer reports
 * exactly that. A client is never handed a plausible-looking substitute for a
 * result the backend refused to produce.
 */

/** Codes a client may branch on; they mirror the Functions RPC vocabulary. */
export type FunctionErrorCode =
  | 'unimplemented'
  | 'permission-denied'
  | 'invalid-argument'
  | 'failed-precondition'
  | 'not-found'
  | 'resource-exhausted'
  | 'unavailable'
  | 'internal'
  | 'unknown';

export class FunctionCallError extends Error {
  constructor(
    readonly code: FunctionErrorCode,
    message: string,
    /** Which callable answered; keeps a refusal attributable in the UI. */
    readonly functionName: string,
  ) {
    super(message);
    this.name = 'FunctionCallError';
  }

  /** True when the feature simply has not been built yet. */
  get notImplemented(): boolean {
    return this.code === 'unimplemented';
  }
}

const emulatorBound = new WeakSet<Functions>();
const hostingCallableNames = new Set([
  'acceptDutyTerms',
  'setAvailability',
  'publishDriverLocation',
  'publishCustomerLocation',
  'respondToAssignment',
  'startTripApproach',
  'cancelBooking',
  'previewCoupon',
  'tripCodes',
  'customerContactForAssignedDriver',
  'rateTrip',
  'searchPlaces',
  'resolvePlace',
  'reverseGeocode',
  'registerDeviceToken',
  'unregisterDeviceToken',
  'getRewards',
  'claimReferralCode',
  'claimDriverReferralCode',
  'manageRewardsAdmin',
  'requestDriverRewardPayout',
]);

/**
 * The suffix the SDK puts on a call that produced no readable HTTP response.
 *
 * Its own comment says this cannot be told apart from a crashed function: a
 * platform permission refusal, a missing CORS header and a network failure all
 * arrive as `internal [0]`, because the browser never sees the answer. Showing
 * that string makes the app look broken when the request never got through, so
 * the message is replaced with what the client can actually claim.
 */
const NO_RESPONSE = / \[0\]$/;

function functionsFor(clients: FirebaseClients, functionName: string): Functions {
  const useHostingProxy =
    !clients.env.useEmulators &&
    clients.env.functionsBaseURL &&
    hostingCallableNames.has(functionName);
  const functions = getFunctions(
    clients.app,
    useHostingProxy ? clients.env.functionsBaseURL! : clients.env.region,
  );
  const endpoint = clients.env.emulator.functions;
  if (clients.env.useEmulators && endpoint && !emulatorBound.has(functions)) {
    connectFunctionsEmulator(functions, endpoint.host, endpoint.port);
    emulatorBound.add(functions);
  }
  return functions;
}

function toFunctionError(functionName: string, error: unknown): FunctionCallError {
  const candidate = error as {
    code?: string;
    message?: string;
    details?: { message?: string };
  } | null;
  const raw = String(candidate?.code ?? 'unknown');
  // The SDK prefixes callable errors with "functions/".
  const suffix = raw.startsWith('functions/') ? raw.slice('functions/'.length) : raw;
  const known: FunctionErrorCode[] = [
    'unimplemented',
    'permission-denied',
    'invalid-argument',
    'failed-precondition',
    'not-found',
    'resource-exhausted',
    'unavailable',
    'internal',
    'unknown',
  ];
  const code: FunctionErrorCode = (known as string[]).includes(suffix)
    ? (suffix as FunctionErrorCode)
    : 'unknown';
  const message = candidate?.details?.message ?? candidate?.message ?? `${functionName} failed`;
  return new FunctionCallError(
    code,
    NO_RESPONSE.test(message)
      ? `${functionName} never answered — the request got no HTTP response back, so it was refused before it reached the function.`
      : message,
    functionName,
  );
}

/**
 * Calls a v2 callable and returns its data. Errors surface as
 * `FunctionCallError` with the server's own code and message intact.
 */
export async function callFunction<Request, Response>(
  clients: FirebaseClients,
  functionName: string,
  data: Request,
): Promise<Response> {
  const invoke = httpsCallable<Request, Response>(functionsFor(clients, functionName), functionName);
  try {
    const response = await invoke(data);
    return response.data;
  } catch (error) {
    throw toFunctionError(functionName, error);
  }
}
