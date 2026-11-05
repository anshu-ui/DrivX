import { Redirect, type Href } from 'expo-router';
import { Screen, StateView } from '@drivx/ui';
import { useSession } from '../features/auth/AuthProvider';

/**
 * Route guard. Sends the device to whichever app it is standing in — a number
 * that holds both accounts has two, and only this device knows which one was
 * opened — and keeps an unprofiled account in the modal flow instead of
 * dropping it into a tab.
 */
export default function Index() {
  const { status, surface, surfaces, needsProfile } = useSession();

  if (status === 'initializing') {
    return (
      <Screen>
        <StateView kind="loading" title="DrivX" message="Starting up…" />
      </Screen>
    );
  }

  if (status === 'signed_out') {
    return <Redirect href="/sign-in" />;
  }

  if (!surfaces.includes(surface)) {
    return <Redirect href={'/app-access' as Href} />;
  }

  if (needsProfile) {
    return <Redirect href="/create-profile" />;
  }

  return <Redirect href={surface === 'driver' ? '/(driver)' : '/(customer)'} />;
}
