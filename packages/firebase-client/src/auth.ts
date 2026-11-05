import {
  createUserWithEmailAndPassword,
  RecaptchaVerifier,
  signInAnonymously,
  signInWithEmailAndPassword,
  signInWithPhoneNumber,
  signOut,
  updateProfile,
  type ApplicationVerifier,
  type Auth,
  type ConfirmationResult,
  type User,
} from 'firebase/auth';
import type { FirebaseClients } from './client';
import { EMULATOR_PROJECT_ID } from './client';

/**
 * Authentication surface used by both apps.
 *
 * The launch path is Indian phone OTP (spec section 3). On a native development
 * build, `@react-native-firebase/auth` supplies `nativePhoneVerifier` and real
 * SMS is delivered. Against the local emulator the JS SDK is used directly: the
 * emulator generates and validates a genuine six-digit code and simply cannot
 * deliver it by SMS, so `emulatorSmsCode` reports the code it issued. Nothing in
 * this file can fabricate a session when `useEmulators` is false.
 */

export type PhoneSession = {
  verificationId: string;
  /**
   * Only set in emulator mode: the code the Auth emulator generated for this
   * `verificationId`, which the local SMS channel cannot deliver.
   */
  emulatorSmsCode?: string | null;
  /** Provider handle for submitting the SMS code. */
  confirm: (code: string) => Promise<User | null>;
};

export type NativePhoneVerifier = {
  /** Starts SMS delivery to `e164`. Must reject if it cannot complete. */
  start(e164: string): Promise<PhoneSession>;
};

export class AuthUnavailableError extends Error {
  constructor(reason: string) {
    super(`Authentication unavailable: ${reason}`);
    this.name = 'AuthUnavailableError';
  }
}

/**
 * Stand-in for the reCAPTCHA widget the JS SDK insists on before it will request
 * an SMS. The Auth emulator ignores this value entirely — the credential that is
 * actually checked is the code the emulator generated itself. Used only while
 * `useEmulators` is true; `_reset` is the internal hook the SDK calls in a
 * `finally`, which is why the object cannot be typed as the public interface.
 */
const EMULATOR_VERIFIER = {
  type: 'recaptcha',
  render: async () => 1,
  verify: async () => 'emulator-ignored-token',
  clear: () => {},
  _reset: () => {},
} as unknown as ApplicationVerifier;

/** Answers that mean "the provider is off", not "the password is wrong". */
const DISABLED_PROVIDER_CODES = new Set([
  'auth/operation-not-allowed',
  'auth/admin-restricted-operation',
  'auth/configuration-not-found',
]);

/** Sessions the project will refuse forever, not just until the next retry. */
const DEAD_SESSION_CODES = new Set(['auth/invalid-refresh-token', 'auth/user-not-found']);

/**
 * True when a stored session can never be refreshed again — it was minted by the
 * Auth emulator, by a different project, or under an account since deleted.
 * Flipping `FIREBASE_EMULATOR` leaves exactly this in the browser: the app must
 * drop it and show sign-in, not sit on "Checking your session…" for ever.
 */
export function isDeadSession(error: unknown): boolean {
  return DEAD_SESSION_CODES.has((error as { code?: string } | null)?.code ?? '');
}

/**
 * The reCAPTCHA a browser needs to ask for an SMS on this project.
 *
 * Firebase asks for its reCAPTCHA Enterprise key first. `drivx-116de` has none:
 * `/v2/recaptchaConfig` answers both providers as `ENFORCEMENT_STATE_UNSPECIFIED`
 * with no `recaptchaKey` at all, so the SDK marks the request's token as the
 * placeholder and requires the caller to supply a classic v2 verifier instead.
 * Send the request without one and `sendVerificationCode` is refused before any
 * SMS leaves Google — which this file used to report as "the provider is off" or
 * "the domain is not authorized", neither of which was true.
 *
 * Render a visible checkbox. Invisible tokens are often rejected by embedded
 * browsers as `auth/invalid-app-credential`; a visible v2 challenge gives the
 * user a chance to solve Google's challenge before Firebase creates the SMS
 * credential. Keep it on screen and near the action so it cannot be clipped.
 */
let verifierContainer: HTMLElement | null = null;
let previousVerifier: RecaptchaVerifier | null = null;

function webPhoneVerifier(auth: Auth): RecaptchaVerifier {
  previousVerifier?.clear();

  if (!verifierContainer?.isConnected) {
    verifierContainer = document.createElement('div');
    Object.assign(verifierContainer.style, {
      position: 'fixed',
      left: '16px',
      bottom: '16px',
      zIndex: '9999',
      background: '#fff',
      padding: '8px',
      borderRadius: '8px',
      boxShadow: '0 2px 12px rgba(15, 23, 42, .18)',
    });
    document.body.appendChild(verifierContainer);
  }

  const verifier = new RecaptchaVerifier(auth, verifierContainer, { size: 'normal' });
  previousVerifier = verifier;
  return verifier;
}

export class DrivXAuth {
  constructor(
    private readonly clients: FirebaseClients,
    private readonly nativePhoneVerifier?: NativePhoneVerifier,
  ) {}

  get currentUser(): User | null {
    return this.clients.auth.currentUser;
  }

  /**
   * Requests an OTP over SMS. On a native development build it delegates to the
   * Firebase Mobile SDK passed in at construction; on web it needs a real
   * reCAPTCHA verifier; against the emulator it runs the same REST flow with the
   * stub verifier above and reports the code the emulator generated.
   */
  async sendOtp(e164: string, verifier?: ApplicationVerifier): Promise<PhoneSession> {
    if (this.nativePhoneVerifier) {
      return this.nativePhoneVerifier.start(e164);
    }

    if (this.clients.env.useEmulators) {
      const result = await signInWithPhoneNumber(this.clients.auth, e164, EMULATOR_VERIFIER);
      return {
        verificationId: result.verificationId,
        emulatorSmsCode: await this.peekEmulatorSmsCode(result.verificationId),
        confirm: async (code) => (await result.confirm(code)).user,
      };
    }

    if (!verifier) {
      // A browser with no document is a React Native runtime, and React Native
      // has no reCAPTCHA to offer: it needs a development build carrying
      // @react-native-firebase/auth, which arrives as `nativePhoneVerifier`.
      if (typeof document === 'undefined') {
        throw new AuthUnavailableError(
          'Phone OTP on React Native needs a development build with @react-native-firebase/auth. ' +
            'For local emulator work, run `npm run emulators`.',
        );
      }
      // No Enterprise key on this project, so the SDK wants the classic widget.
      verifier = webPhoneVerifier(this.clients.auth);
    }

    let result: ConfirmationResult;
    try {
      result = await signInWithPhoneNumber(this.clients.auth, e164, verifier);
    } catch (error) {
      // A failed/expired reCAPTCHA token cannot be reused. Remove it so the
      // next tap builds a clean challenge instead of returning the same error.
      if (typeof document !== 'undefined') {
        previousVerifier?.clear();
        previousVerifier = null;
        verifierContainer?.remove();
        verifierContainer = null;
      }
      throw error;
    }
    if (typeof document !== 'undefined') {
      previousVerifier?.clear();
      previousVerifier = null;
      verifierContainer?.remove();
      verifierContainer = null;
    }
    return {
      verificationId: result.verificationId,
      confirm: async (code) => (await result.confirm(code)).user,
    };
  }

  /**
   * Reads the pending code back from the Auth emulator's own store. This is the
   * local replacement for the SMS channel, not for the check itself: a wrong
   * code still fails. Returns null when the emulator is not configured.
   */
  async peekEmulatorSmsCode(verificationId: string): Promise<string | null> {
    const endpoint = this.clients.env.emulator.auth;
    if (!this.clients.env.useEmulators || !endpoint) return null;
    const projectId = this.clients.env.firebase?.projectId ?? EMULATOR_PROJECT_ID;
    const url = `http://${endpoint.host}:${endpoint.port}/emulator/v1/projects/${projectId}/verificationCodes`;
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const body = (await response.json()) as {
        verificationCodes?: { code: string; sessionInfo: string }[];
      };
      return (
        body.verificationCodes?.find((entry) => entry.sessionInfo === verificationId)?.code ?? null
      );
    } catch {
      return null;
    }
  }

  /**
   * Emulator-only developer sign-in. Accounts come from the seed script, which
   * creates them through the Auth emulator REST API with the right claims.
   * Throws in production configuration.
   */
  async devEmailSignIn(email: string, password: string): Promise<User> {
    if (!this.clients.env.useEmulators) {
      throw new AuthUnavailableError(
        'Email developer sign-in is disabled outside emulator mode. Use phone OTP.',
      );
    }
    const credential = await signInWithEmailAndPassword(this.clients.auth, email, password);
    return credential.user;
  }

  /**
   * Staff sign-in for the operations console, in either mode.
   *
   * The account and its claims are minted server-side (`scripts/provision-live.mjs`
   * on the live project), so this authenticates and grants nothing. A project with
   * Email/Password switched off answers `operation-not-allowed`, which would
   * otherwise read as a wrong password — so it is named for what it is.
   */
  async emailPasswordSignIn(email: string, password: string): Promise<User> {
    try {
      const credential = await signInWithEmailAndPassword(this.clients.auth, email, password);
      return credential.user;
    } catch (caught) {
      const code = (caught as { code?: string })?.code ?? '';
      if (DISABLED_PROVIDER_CODES.has(code)) {
        throw new AuthUnavailableError(
          'this project has Email/Password sign-in switched off. Turn it on in Firebase Console → Authentication → Sign-in method.',
        );
      }
      throw caught;
    }
  }

  /** Used by the driver onboarding test harness; not a production path. */
  async createDevAccount(email: string, password: string, displayName: string): Promise<User> {
    if (!this.clients.env.useEmulators) {
      throw new AuthUnavailableError('Account creation is disabled outside emulator mode.');
    }
    const credential = await createUserWithEmailAndPassword(this.clients.auth, email, password);
    await updateProfile(credential.user, { displayName });
    return credential.user;
  }

  /**
   * Anonymous sessions exist solely to exercise Firestore rules in the
   * emulator test suite. Claims are absent, so every privileged read is
   * expected to be denied.
   */
  async anonymousSessionForRuleTesting(): Promise<User> {
    if (!this.clients.env.useEmulators) {
      throw new AuthUnavailableError('Anonymous sign-in is restricted to emulator mode.');
    }
    const credential = await signInAnonymously(this.clients.auth);
    return credential.user;
  }

  async signOutUser(): Promise<void> {
    await signOut(this.clients.auth);
  }

  /** ID token, for bearer auth against Cloud Functions. */
  async idToken(forceRefresh = false): Promise<string | null> {
    const user = this.clients.auth.currentUser;
    return user ? user.getIdToken(forceRefresh) : null;
  }
}
