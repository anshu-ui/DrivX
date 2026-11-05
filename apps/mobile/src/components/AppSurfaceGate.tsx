import type { ReactNode } from 'react';
import { Redirect, type Href } from 'expo-router';
import { Screen, StateView } from '@drivx/ui';
import { useSession, type Surface } from '../features/auth/AuthProvider';

/**
 * The same route guard the landing screen runs, applied to a tab group.
 *
 * `/` cannot be the only place this check happens, because both apps expose
 * screens under the same names — `account`, `trips`, `support` — so a URL like
 * `/account` matches whichever group the router walks first, not the app this
 * device is standing in. Refreshing a driver's Account tab on the web used to
 * open the customer's, with the driver's own session behind it: an empty form
 * reading a profile that does not exist for them. Same reason a signed-out
 * deep link used to hang on "Starting up…".
 *
 * The redirect targets the other group's root rather than the screen the URL
 * named, because the two apps do not share screens: the honest landing is the
 * right app's front door.
 */
export function AppSurfaceGate({
  expects,
  children,
}: {
  expects: Surface;
  children: ReactNode;
}) {
  const { status, surface, surfaces, needsProfile } = useSession();

  if (status === 'initializing') {
    return (
      <Screen>
        <StateView kind="loading" title="DrivX" message="Starting up…" />
      </Screen>
    );
  }
  if (status === 'signed_out') return <Redirect href="/sign-in" />;
  if (!surfaces.includes(expects)) return <Redirect href={'/app-access' as Href} />;
  if (needsProfile) return <Redirect href="/create-profile" />;
  if (surface !== expects) {
    return <Redirect href={surface === 'driver' ? '/(driver)' : '/(customer)'} />;
  }

  return <>{children}</>;
}
