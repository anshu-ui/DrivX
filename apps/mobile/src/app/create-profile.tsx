import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Button, Card, Field, Screen, ScreenHeader, Text, useTheme } from '@drivx/ui';
import { emailSchema, signUpProfileInputSchema } from '@drivx/domain';
import { useSession } from '../features/auth/AuthProvider';

/**
 * First-run profile step. The document a user creates here is the one the
 * security rules allow them to write: their own name, email, defaults and
 * preferences — never a role, verification state or rating.
 */
export default function CreateProfile() {
  const theme = useTheme();
  const { bootstrapProfile, profileDraft, setProfileDraft, surface, user } = useSession();
  const isDriver = surface === 'driver';
  const [fullName, setFullName] = useState(profileDraft.fullName);
  const [email, setEmail] = useState(profileDraft.email);
  const [errors, setErrors] = useState<{ fullName?: string; email?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setFullName((value) => value || profileDraft.fullName);
    setEmail((value) => value || profileDraft.email);
  }, [profileDraft.email, profileDraft.fullName]);

  const submit = async () => {
    const next: { fullName?: string; email?: string } = {};
    const name = signUpProfileInputSchema.shape.fullName.safeParse(fullName);
    if (!name.success) next.fullName = name.error.issues[0]?.message ?? 'Enter your full name.';
    const address = emailSchema.safeParse(email);
    if (!address.success) {
      next.email = address.error.issues[0]?.message ?? 'Enter a valid email address.';
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      await bootstrapProfile({ fullName, email });
      router.replace('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We could not save your profile.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={{ gap: theme.spacing.xl }}>
        <ScreenHeader
          eyebrow={isDriver ? 'Driver account' : 'Almost ready'}
          title={isDriver ? 'What name should we use?' : 'Your name and email'}
          subtitle={isDriver ? 'Use the email where the office can reach you about your application.' : 'Receipts and trip updates go to this email.'}
        />

        <Card style={{ gap: theme.spacing.lg }}>
          <Field
            label="Full name"
            autoCapitalize="words"
            value={fullName}
            onChangeText={(value) => {
              setFullName(value);
              setProfileDraft({ fullName: value, email });
              setErrors((current) => ({ ...current, fullName: undefined }));
            }}
            error={errors.fullName ?? null}
            helper={user?.phoneNumber ?? undefined}
            accessibilityLabel="Full name"
          />
          <Field
            label="Email"
            value={email}
            onChangeText={(value) => {
              setEmail(value);
              setProfileDraft({ fullName, email: value });
              setErrors((current) => ({ ...current, email: undefined }));
            }}
            error={errors.email ?? null}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Email"
          />
          <Button label="Continue" onPress={submit} loading={busy} fullWidth />
          {error ? (
            <Text variant="caption" tone="danger" accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
        </Card>
      </View>
    </Screen>
  );
}
