import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { Platform } from 'react-native';
import {
  CLAIM_DEFAULTS,
  COLLECTIONS,
  holdsRole,
  type AuthClaims,
} from '@drivx/domain';
import { isDeadSession, callFunction } from '@drivx/firebase-client';
import { firebase, drivxAuth } from '../../lib/firebase';
import { appSurface } from '../../lib/appSurface';

export type AuthStatus = 'initializing' | 'signed_out' | 'signed_in';

/**
 * Which of the two apps this device is currently standing in.
 *
 * A person may hold a customer account and a driver account on the same phone
 * number, so the token cannot answer this: it says what they may do, not which
 * half they opened just now. The choice is therefore kept on the device.
 */
export type Surface = 'customer' | 'driver';

const configuredSurface = appSurface === 'customer' || appSurface === 'driver' ? appSurface : null;

const SURFACE_KEY = 'drivx.surface';
const profileDraftKey = (uid: string) => `drivx.profileDraft.${uid}`;

/** What the session resolved to after a sign-in or a surface switch. */
export type SurfaceState = { surface: Surface; needsProfile: boolean };

export type Session = {
  status: AuthStatus;
  user: User | null;
  claims: AuthClaims;
  /** The surface this device is on, always one the account is allowed to use. */
  surface: Surface;
  /** Every surface the signed-in account can switch to. One for most people. */
  surfaces: Surface[];
  /** True when the signed-in account has no profile document for `surface` yet. */
  needsProfile: boolean;
  /** In-memory first-run fields survive route changes until profile setup succeeds or the user signs out. */
  profileDraft: { fullName: string; email: string };
  setProfileDraft: (draft: { fullName: string; email: string }) => void;
  signOut: () => Promise<void>;
  /** Creates the profile document the rules let a user open for themselves. */
  bootstrapProfile: (input: { fullName: string; email?: string }) => Promise<void>;
  /** Moves this device to the other account on the same number. */
  chooseSurface: (surface: Surface) => Promise<SurfaceState | null>;
  refresh: () => Promise<void>;
};

const GUEST_CLAIMS: AuthClaims = CLAIM_DEFAULTS;

const AuthContext = createContext<Session | null>(null);

function allowedSurfaces(claims: AuthClaims): Surface[] {
  const surfaces: Surface[] = [];
  if (holdsRole(claims, 'customer')) surfaces.push('customer');
  if (holdsRole(claims, 'driver')) surfaces.push('driver');
  return surfaces;
}

function surfacesForBuild(claims: AuthClaims): Surface[] {
  const allowed = allowedSurfaces(claims);
  return configuredSurface ? (allowed.includes(configuredSurface) ? [configuredSurface] : []) : allowed;
}

/**
 * The stored choice wins while it is still one the account is allowed to use,
 * so switching surfaces survives a restart. A stale grant — a driver account
 * that has since been deleted, or a device carried over from another sign-in —
 * falls back to the claim's default surface rather than stranding the user.
 */
function resolveSurface(claims: AuthClaims, stored: string | null): Surface {
  const allowed = surfacesForBuild(claims);
  if (configuredSurface) return configuredSurface;
  if (stored === 'customer' || stored === 'driver') {
    if (allowed.includes(stored)) return stored;
  }
  return allowed.includes(claims.role as Surface) ? (claims.role as Surface) : allowed[0] ?? 'customer';
}

function profileCollection(surface: Surface): string {
  return surface === 'driver' ? COLLECTIONS.driverProfiles : COLLECTIONS.customerProfiles;
}

/**
 * A sign-up that used a brand-new number has no role claim yet, and a client
 * cannot write one for itself — the rules refuse the profile document until the
 * claim exists. `provisionNewAccount` is supposed to mint it from the Auth
 * side, but it has never fired on the live project, so the session asks the
 * trusted server to provision it by callable and then refreshes. That callable
 * is idempotent and only ever writes the `customer` role, so a refusal here is
 * not a security hole: it just means onboarding cannot continue.
 */
async function tokenResultWithClaims(user: User) {
  let result = await user.getIdTokenResult(true);
  if (result.claims?.role) return result;

  try {
    await callFunction<Record<string, never>, { outcome: string; role: string }>(
      firebase(),
      'provisionSelf',
      {},
    );
  } catch {
    // Fall through to the poll: the auth trigger may still be the one that
    // provisions this account, and the screen reports the missing claim itself.
  }

  for (let attempt = 0; attempt < 5 && !result.claims?.role; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    result = await user.getIdTokenResult(true);
  }
  return result;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('initializing');
  const [user, setUser] = useState<User | null>(null);
  const [claims, setClaims] = useState<AuthClaims>(GUEST_CLAIMS);
  const [surface, setSurface] = useState<Surface>('customer');
  const [needsProfile, setNeedsProfile] = useState(false);
  const [profileDraft, setProfileDraft] = useState({ fullName: '', email: '' });
  // Which account the surface and profile state above belong to.
  const adoptedUid = useRef<string | null>(null);
  // Ignore a slower auth/profile read if a newer sign-in or surface choice won.
  const adoptGeneration = useRef(0);

  const adopt = useCallback(async (next: User | null) => {
    const generation = ++adoptGeneration.current;
    setUser(next);
    // Do not let a route guard make an access decision from old claims while a
    // refreshed token is loading. In particular, onboarding may just have
    // granted the driver role and the previous customer-only claims would send
    // a valid driver session back to /app-access during that refresh.
    setStatus('initializing');
    if (!next) {
      const previousUid = adoptedUid.current;
      adoptedUid.current = null;
      setClaims(GUEST_CLAIMS);
      setNeedsProfile(false);
      setProfileDraft({ fullName: '', email: '' });
      setStatus('signed_out');
      if (previousUid) void AsyncStorage.removeItem(profileDraftKey(previousUid)).catch(() => undefined);
      return null;
    }

    // Signing in as somebody else while this device already holds a session is
    // not a refresh: the surface has to be re-resolved from the new claims
    // first, or the router sends a driver into the customer app the previous
    // account left behind.
    if (adoptedUid.current !== next.uid) {
      setProfileDraft({ fullName: '', email: '' });
      try {
        const savedDraft = await AsyncStorage.getItem(profileDraftKey(next.uid));
        if (generation !== adoptGeneration.current) return null;
        if (savedDraft) {
          const parsed = JSON.parse(savedDraft) as { fullName?: unknown; email?: unknown };
          setProfileDraft({
            fullName: typeof parsed.fullName === 'string' ? parsed.fullName : '',
            email: typeof parsed.email === 'string' ? parsed.email : '',
          });
        }
      } catch {
        // A corrupt local draft should never block restoring the signed-in app.
      }
    }

    // Claims are minted server-side, so a refresh is required to pick up a
    // role change made by an administrator since the last token.
    let result: Awaited<ReturnType<typeof tokenResultWithClaims>>;
    try {
      result = await tokenResultWithClaims(next);
    } catch (caught) {
      // A session stored under the emulator or another project can never be
      // refreshed here. Drop it and land on sign-in instead of failing the
      // bootstrap — `signOut` re-enters this observer with no user.
      if (!isDeadSession(caught)) throw caught;
      await signOut(firebase().auth);
      return null;
    }
    if (generation !== adoptGeneration.current) return null;
    const primaryRole = (result.claims.role as AuthClaims['role']) ?? 'customer';
    const decoded: AuthClaims = {
      ...GUEST_CLAIMS,
      role: primaryRole,
      roles: (result.claims.roles as AuthClaims['roles']) ?? [primaryRole],
      admin: result.claims.admin === true,
      ops: result.claims.ops === true,
      driverVerified: result.claims.driverVerified === true,
      zoneId: (result.claims.zoneId as string | null) ?? null,
      serviceTypeIds: (result.claims.serviceTypeIds as AuthClaims['serviceTypeIds']) ?? [],
    };
    const chosen = resolveSurface(decoded, await AsyncStorage.getItem(SURFACE_KEY));
    if (generation !== adoptGeneration.current) return null;
    setClaims(decoded);
    setSurface(chosen);

    // A customer/driver build is tied to one surface. If this account does not
    // hold that server-issued role, keep it out of profile reads and booking
    // actions and show the dedicated account-access screen instead.
    if (!surfacesForBuild(decoded).includes(chosen)) {
      setNeedsProfile(false);
      adoptedUid.current = next.uid;
      setStatus('signed_in');
      return { surface: chosen, needsProfile: false };
    }

    const snap = await getDoc(doc(firebase().firestore, profileCollection(chosen), next.uid));
    if (generation !== adoptGeneration.current) return null;
    // The provisioning trigger creates the profile with an empty name, so a
    // missing document and a nameless one both mean the first-run step is due.
    const fullName = (snap.data() as { fullName?: unknown } | undefined)?.fullName;
    const email = (snap.data() as { email?: unknown } | undefined)?.email;
    const due = !snap.exists() || String(fullName ?? '').trim().length === 0;
    if (!due) {
      setProfileDraft({ fullName: String(fullName), email: typeof email === 'string' ? email : '' });
      void AsyncStorage.removeItem(profileDraftKey(next.uid)).catch(() => undefined);
    }
    setNeedsProfile(due);
    adoptedUid.current = next.uid;
    setStatus('signed_in');
    // Returned so a caller that just changed surface knows whether to route to
    // the profile step or straight into the app.
    return { surface: chosen, needsProfile: due };
  }, []);

  useEffect(() => {
    // Browser auth can take longer to restore IndexedDB persistence than the
    // native SDK. Do not leave the customer/driver web preview on an infinite
    // splash if that initial persistence read never settles; a later Firebase
    // callback still adopts the real session and redirects as usual.
    let receivedInitialState = false;
    const startupTimeout = Platform.OS === 'web'
      ? setTimeout(() => {
          if (!receivedInitialState) setStatus((current) => current === 'initializing' ? 'signed_out' : current);
        }, 5_000)
      : null;
    const unsubscribe = onAuthStateChanged(firebase().auth, (next) => {
        receivedInitialState = true;
        if (startupTimeout) clearTimeout(startupTimeout);
        if (!next) {
          void adopt(null);
          return;
        }
        void adopt(next);
      });
    return () => {
      if (startupTimeout) clearTimeout(startupTimeout);
      unsubscribe();
    };
  }, [adopt]);

  const bootstrapProfile = useCallback(
    async (input: { fullName: string; email?: string }) => {
      if (!user) throw new Error('Sign in before creating a profile.');
      const isDriver = surface === 'driver';
      const fullName = input.fullName.trim();
      if (fullName.length < 2) throw new Error('Enter your full name.');
      const email = input.email?.trim().toLowerCase() ?? null;

      const ref = doc(firebase().firestore, profileCollection(surface), user.uid);
      // Provisioning may already have opened the document. The rules forbid a
      // client from touching server-owned keys when updating, so in that case
      // only the fields a customer owns are written.
      if ((await getDoc(ref)).exists()) {
        await updateDoc(
          ref,
          isDriver
            ? { fullName, email }
            : {
                fullName,
                email,
                contactPhoneE164: user.phoneNumber ?? '',
              },
        );
        setNeedsProfile(false);
        setProfileDraft({ fullName, email: email ?? '' });
        void AsyncStorage.removeItem(profileDraftKey(user.uid)).catch(() => undefined);
        return;
      }

      await setDoc(ref, {
        uid: user.uid,
        fullName,
        ...(isDriver
          ? {
              email,
              phoneE164: user.phoneNumber ?? '',
              photoUrl: null,
              languages: ['en'],
              zoneId: claims.zoneId ?? 'delhi-ncr',
              serviceAreas: [],
              // The customer's driver card reads these; the office or the driver
              // fills them in, and until then the card says so rather than
              // guessing at a car.
              vehicleMake: null,
              vehicleModel: null,
              vehiclePlate: null,
              serviceTypeIds: [],
              verificationStatus: 'not_started',
              verifiedAtMs: null,
              verifiedByUid: null,
              rejectionReason: null,
              documentsExpiringBeforeMs: null,
              availabilityState: 'offline',
              availabilitySinceMs: null,
              ratingAverage: 0,
              ratingCount: 0,
              lifetimeTrips: 0,
              onTimeArrivalRate: null,
              acceptanceRate: null,
            }
          : {
              email,
              defaultPickup: null,
              preferredTransmission: 'either',
              preferredCarTypes: [],
              contactPhoneE164: user.phoneNumber ?? '',
              privacy: {
                shareTripWithContact: false,
                marketingOptIn: false,
                preciseLocationWhileIdle: false,
              },
              emergencyContact: { name: null, phoneE164: null, sharesLiveLocation: false },
              ratingAverage: null,
              ratingCount: 0,
              lifetimeBookings: 0,
            }),
        createdAtMs: serverTimestamp(),
        updatedAtMs: serverTimestamp(),
      });

      setNeedsProfile(false);
      setProfileDraft({ fullName, email: email ?? '' });
      void AsyncStorage.removeItem(profileDraftKey(user.uid)).catch(() => undefined);
    },
    [claims, surface, user],
  );

  /**
   * Switches this device between the two accounts one number can hold. The
   * profile check runs again afterwards, because the other surface has its own
   * profile document and may never have been opened.
   */
  const chooseSurface = useCallback(
    async (next: Surface) => {
      if (!surfacesForBuild(claims).includes(next)) {
        throw new Error(`This account cannot open the ${next} app.`);
      }
      await AsyncStorage.setItem(SURFACE_KEY, next);
      return adopt(firebase().auth.currentUser);
    },
    [adopt, claims],
  );

  const value = useMemo<Session>(
    () => ({
      status,
      user,
      claims,
      surface,
      surfaces: surfacesForBuild(claims),
      needsProfile,
      profileDraft,
      setProfileDraft: (draft) => {
        setProfileDraft(draft);
        const uid = firebase().auth.currentUser?.uid;
        if (uid) void AsyncStorage.setItem(profileDraftKey(uid), JSON.stringify(draft)).catch(() => undefined);
      },
      signOut: () => drivxAuth().signOutUser(),
      bootstrapProfile,
      chooseSurface,
      refresh: async () => {
        await adopt(firebase().auth.currentUser);
      },
    }),
    [adopt, bootstrapProfile, chooseSurface, claims, needsProfile, profileDraft, status, surface, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useSession must be used inside AuthProvider.');
  return ctx;
}
