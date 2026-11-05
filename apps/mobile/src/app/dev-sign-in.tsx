import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Button, Card, Field, Screen, ScreenHeader, Text, useTheme } from '@drivx/ui';
import { firebase, drivxAuth } from '../lib/firebase';

/**
 * Emulator-only sign-in for local development.
 *
 * It authenticates against the Firebase Auth emulator with the accounts the
 * seed script creates (email + password, with real sessions and real custom
 * claims). It is never reachable when the app points at a live project, and it
 * is not a substitute for phone OTP.
 */
export default function DevSignIn() {
  const theme = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const available = firebase().env.useEmulators;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await drivxAuth().devEmailSignIn(email.trim(), password);
      router.replace('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  if (!available) {
    return (
      <Screen>
        <Card>
          <Text variant="heading" tone="brand">
            Not available
          </Text>
          <Text variant="caption" tone="muted">
            Developer sign-in only works against the Firebase emulator. Start it with `npm run emulators`, or use phone
            sign-in.
          </Text>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ gap: theme.spacing.lg }}>
        <ScreenHeader title="Developer sign-in" />
        <Text variant="caption" tone="muted">
          Run `npm run seed` first. Customers amit@example.test and priya@example.test, drivers
          rakesh@example.test (approved) and suna@example.test (pending), staff ops@drivx.test and
          admin@drivx.test. Every one uses the password the seed prints.
        </Text>

        <Card style={{ gap: theme.spacing.md }}>
          <Field
            label="Email"
            keyboardType="email-address"
            autoCapitalize="none"
            value={email}
            onChangeText={setEmail}
            accessibilityLabel="Developer account email"
          />
          <Field
            label="Password"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            accessibilityLabel="Developer account password"
          />
          <Button label="Sign in" onPress={submit} loading={busy} fullWidth />
          {error ? (
            <Text variant="caption" tone="danger" accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
        </Card>

        <Button label="Back to phone sign-in" onPress={() => router.back()} appearance="ghost" size="sm" />
      </View>
    </Screen>
  );
}
