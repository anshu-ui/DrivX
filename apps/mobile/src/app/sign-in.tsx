import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { useForm } from 'react-hook-form';
import { indiaPhoneSchema } from '@drivx/domain';
import { Button, Card, Field, Screen, Text, useTheme } from '@drivx/ui';
import { useSession } from '../features/auth/AuthProvider';
import { AuthUnavailableError, type PhoneSession } from '@drivx/firebase-client';
import { firebase, drivxAuth } from '../lib/firebase';
import { BrandMark } from '../components/BrandMark';
import { appSurface, isCombinedApp } from '../lib/appSurface';

type PhoneForm = { phone: string };

export default function SignIn() {
  const theme = useTheme();
  const { refresh, status } = useSession();
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [session, setSession] = useState<PhoneSession | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [otpWaitSeconds, setOtpWaitSeconds] = useState(0);

  useEffect(() => {
    if (otpWaitSeconds <= 0) return undefined;
    const timer = setTimeout(() => setOtpWaitSeconds((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearTimeout(timer);
  }, [otpWaitSeconds]);

  const { handleSubmit, watch, setValue } = useForm<PhoneForm>({ defaultValues: { phone: '' } });
  const phone = watch('phone');

  const emulatorMode = firebase().env.useEmulators;
  const combinedApp = isCombinedApp;
  const driverApp = appSurface === 'driver';
  const customerApp = appSurface === 'customer';

  // A verified code leaves the session signed in, and the route guard at `/`
  // picks the surface for that role. Staying on this form would also let the
  // same verification id be submitted twice, which Auth refuses.
  if (status === 'signed_in') return <Redirect href="/" />;

  const onSubmitPhone = handleSubmit(async () => {
    const parsed = indiaPhoneSchema.safeParse(phone);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the mobile number.');
      return;
    }
    if (otpWaitSeconds > 0) return;
    setError(null);
    setBusy(true);
    try {
      // In emulator mode this asks the Auth emulator for its own code and shows
      // it below, because no SMS can be delivered locally. A development build
      // with @react-native-firebase/auth sends the real SMS; see README.
      const started = await drivxAuth().sendOtp(parsed.data);
      setSession(started);
      setStep('otp');
    } catch (err) {
      const message = (err as AuthUnavailableError).message ?? String(err);
      const code = (err as { code?: string }).code;
      const isLocalWeb = typeof window !== 'undefined' && ['localhost', '127.0.0.1'].includes(window.location.hostname);
      if (code === 'auth/too-many-requests') {
        setOtpWaitSeconds(60);
        setError(
          'Firebase has temporarily limited OTP requests for this number or network. Wait before trying again; repeated attempts can extend the restriction.',
        );
      } else if (!emulatorMode && code === 'auth/invalid-app-credential' && isLocalWeb) {
        setError('Real SMS OTP cannot be requested from this localhost preview. Open the deployed DrivX site on an authorized Firebase domain to test live OTP.');
      } else {
        setError(
          emulatorMode
            ? `${message}\n\nStart the local backend with \`npm run emulators\` and try again.`
            : message,
        );
      }
    } finally {
      setBusy(false);
    }
  });

  const onSubmitCode = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await session.confirm(code.trim());
      // onAuthStateChanged owns the transition; this only waits for it.
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code did not match. Request a new one.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={{ gap: theme.spacing.xl, paddingTop: theme.spacing.xxxl }}>
        <View style={{ gap: theme.spacing.xs }}>
          <View style={{ marginBottom: theme.spacing.sm }}>
            <BrandMark size={56} />
          </View>
          <Text variant="wordmark" tone="brand">
            DRIVX
          </Text>
          <Text variant="caption" tone="muted">{driverApp ? 'DRIVER APP' : customerApp ? 'CUSTOMER APP' : 'DRIVX'}</Text>
          <Text variant="display" tone="brand">
            {driverApp ? 'Drive with DrivX.' : customerApp ? 'Your journey. Your way.' : 'Your journey. Your way.'}
          </Text>
          <Text variant="caption" tone="muted">
            {driverApp
              ? 'Manage duty, review trip offers and see your earnings clearly.'
              : 'Book a verified driver to get behind the wheel of your own car.'}
          </Text>
        </View>

        <Card style={{ gap: theme.spacing.lg }}>
          {step === 'phone' || !session ? (
            <>
              <Field
                label="Mobile number"
                keyboardType="phone-pad"
                autoComplete="tel-country-code"
                textContentType="telephoneNumber"
                maxLength={14}
                value={phone}
                onChangeText={(value) => setValue('phone', value, { shouldValidate: false })}
                helper="We send a one-time code by SMS. India numbers only for now."
                accessibilityLabel="Indian mobile number"
              />
              <Button
                label={otpWaitSeconds > 0 ? `Try again in ${otpWaitSeconds}s` : 'Send code'}
                onPress={onSubmitPhone}
                loading={busy}
                disabled={otpWaitSeconds > 0}
                fullWidth
              />
            </>
          ) : (
            <>
              <Text variant="body" tone="muted">
                Enter the 6-digit code sent to {phone}.
              </Text>
              <Field
                label="One-time code"
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                maxLength={6}
                value={code}
                onChangeText={setCode}
                helper="The code expires in a few minutes."
                accessibilityLabel="SMS one-time code"
              />
              {session.emulatorSmsCode ? (
                <View
                  style={{
                    gap: theme.spacing.xs,
                    borderRadius: theme.radius.md,
                    borderWidth: theme.borderWidth.thin,
                    borderColor: theme.colors.border,
                    backgroundColor: theme.colors.surfaceMuted,
                    padding: theme.spacing.md,
                  }}
                >
                  <Text variant="caption" tone="faint">
                    Emulator mode · no SMS is sent. The Auth emulator generated code{' '}
                    <Text variant="caption">{session.emulatorSmsCode}</Text> for {phone}, and that is
                    the code it checks. A development build with @react-native-firebase/auth delivers
                    it by SMS instead.
                  </Text>
                  <Button
                    label="Fill emulator code"
                    onPress={() => setCode(session.emulatorSmsCode ?? '')}
                    appearance="secondary"
                    size="sm"
                  />
                </View>
              ) : null}
              <Button label="Verify and continue" onPress={onSubmitCode} loading={busy} fullWidth />
              <Button
                label="Change number"
                onPress={() => {
                  setStep('phone');
                  setSession(null);
                  setCode('');
                }}
                appearance="ghost"
                size="sm"
              />
            </>
          )}

          {error ? (
            <Text variant="caption" tone="danger" accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
        </Card>

        <View style={{ gap: theme.spacing.sm }}>
          {emulatorMode && combinedApp ? (
            <Button
              label="Developer sign-in (emulator only)"
              onPress={() => router.push('/dev-sign-in')}
              appearance="secondary"
              size="sm"
              fullWidth
            />
          ) : null}
        </View>
      </View>
    </Screen>
  );
}
