import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Button, Card, Field, Screen, ScreenHeader, Text, useTheme } from '@drivx/ui';
import { emailSchema, signUpProfileInputSchema } from '@drivx/domain';
import { callFunction, FunctionCallError } from '@drivx/firebase-client';
import { useSession } from '../features/auth/AuthProvider';
import { firebase } from '../lib/firebase';
import { appSurface } from '../lib/appSurface';

export default function AppAccess() {
  const theme = useTheme();
  const { signOut, user, refresh, profileDraft, setProfileDraft } = useSession();
  const surface = appSurface;
  const isDriver = surface === 'driver';
  const appName = isDriver ? 'DrivX Driver' : 'DrivX Customer';
  const roleName = isDriver ? 'driver' : 'customer';
  const [fullName, setFullName] = useState(profileDraft.fullName);
  const [email, setEmail] = useState(profileDraft.email);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function applyAsDriver() {
    const name = signUpProfileInputSchema.shape.fullName.safeParse(fullName);
    const address = emailSchema.safeParse(email);
    if (!name.success) {
      setError(name.error.issues[0]?.message ?? 'Enter your full name.');
      return;
    }
    if (!address.success) {
      setError(address.error.issues[0]?.message ?? 'Enter a valid email address.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await callFunction(firebase(), 'beginDriverOnboarding', {
        fullName: name.data,
        email: address.data,
      });
      await refresh();
      router.replace('/');
    } catch (caught) {
      setError(
        caught instanceof FunctionCallError
          ? caught.functionName === 'beginDriverOnboarding' && caught.message.includes('no HTTP response')
            ? 'Driver registration is temporarily unavailable. Your application was not created and no documents or payment were submitted. Please contact DrivX support to restore secure registration access.'
            : caught.functionName === 'beginDriverOnboarding' && caught.code === 'not-found'
            ? 'Driver registration service is not published to Firebase yet. Your details were not submitted. Please try again after the DrivX team deploys the onboarding service.'
            : caught.message
          : caught instanceof Error
            ? caught.message
            : 'We could not start your driver application. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <View style={{ gap: theme.spacing.lg }}>
        <ScreenHeader
          title={isDriver ? 'Start your driver application' : appName}
          subtitle={isDriver ? 'Verify your phone, add your details, upload your documents and pay the one-time fee. The DrivX team reviews your application before you go online.' : undefined}
        />
        <Card style={{ gap: theme.spacing.md }}>
          {isDriver ? (
            <>
              <Text variant="caption" tone="muted">
                Phone verified: {user?.phoneNumber ?? 'your signed-in number'}
              </Text>
              <Field
                label="Full name"
                autoCapitalize="words"
                value={fullName}
                onChangeText={(value) => {
                  setFullName(value);
                  setProfileDraft({ fullName: value, email });
                }}
                accessibilityLabel="Driver full name"
              />
              <Field
                label="Email address"
                value={email}
                onChangeText={(value) => {
                  setEmail(value);
                  setProfileDraft({ fullName, email: value });
                }}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Driver email address"
              />
              {error ? (
                <Text variant="caption" tone="danger" accessibilityRole="alert">
                  {error}
                </Text>
              ) : null}
              <Button
                label="Create driver application"
                fullWidth
                loading={busy}
                onPress={() => void applyAsDriver()}
              />
              <Text variant="caption" tone="faint">
                Your account stays offline until the documents and one-time fee are checked and an admin approves you.
              </Text>
              <Button
                label="Use another number"
                fullWidth
                appearance="ghost"
                onPress={() => void signOut().then(() => router.replace('/sign-in'))}
              />
            </>
          ) : (
            <>
              <Text variant="subheading" tone="brand">
                This number does not have a {roleName} account yet.
              </Text>
              <Text variant="body" tone="muted">
                Sign in with a number linked to a {roleName} profile. DrivX keeps customer and driver access separate.
              </Text>
              <Button
                label="Use another number"
                fullWidth
                onPress={() => void signOut().then(() => router.replace('/sign-in'))}
              />
            </>
          )}
        </Card>
      </View>
    </Screen>
  );
}
