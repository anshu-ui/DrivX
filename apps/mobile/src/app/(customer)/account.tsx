import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import {
  Button,
  Card,
  Divider,
  Field,
  Screen,
  ScreenHeader,
  StateView,
  StatusPill,
  Text,
  Toggle,
  useTheme,
} from '@drivx/ui';
import { TRANSMISSIONS, type Transmission } from '@drivx/domain';
import { useSession } from '../../features/auth/AuthProvider';
import { useCustomerProfile, useNotifications } from '../../features/customer/queries';
import { useMarkNotificationRead, useUpdateProfile } from '../../features/customer/mutations';
import { dateTime } from '../../features/customer/labels';
import { LegalPanel } from '../../features/legal/LegalPanel';
import { SurfaceSwitch } from '../../components/SurfaceSwitch';
import { PushNotificationsCard } from '../../components/PushNotificationsCard';

const TRANSMISSION_LABEL: Record<Transmission, string> = {
  automatic: 'Automatic',
  manual: 'Manual',
  either: 'No preference',
};

/**
 * Everything here is a field the customer rules actually let this account
 * change: name, transmission preference and the emergency contact. Ratings,
 * booking counts and the timestamps are shown read-only because the update
 * rule refuses a write that includes them at all.
 */
export default function CustomerAccount() {
  const theme = useTheme();
  const { user, claims, signOut } = useSession();
  const profile = useCustomerProfile();
  const notifications = useNotifications();
  const updateProfile = useUpdateProfile();
  const markRead = useMarkNotificationRead();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [transmission, setTransmission] = useState<Transmission>('either');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  // The form is seeded from the profile during render rather than in an effect:
  // each completed fetch of the profile replaces the fields once, and React
  // re-renders before the inputs paint, so a saved value is never a frame stale.
  // An effect did the same thing but after the customer had started typing.
  const [seededAtMs, setSeededAtMs] = useState<number | null>(null);
  const profileData = profile.data;
  if (profileData && profile.dataUpdatedAt !== seededAtMs) {
    setSeededAtMs(profile.dataUpdatedAt);
    setFullName(profileData.fullName);
    setEmail(profileData.email ?? '');
    setTransmission(
      TRANSMISSIONS.includes(profileData.preferredTransmission as Transmission)
        ? (profileData.preferredTransmission as Transmission)
        : 'either',
    );
    setMarketingOptIn(profileData.marketingOptIn);
    setContactName(profileData.emergencyContactName ?? '');
    setContactPhone(profileData.emergencyContactPhone ?? '');
  }

  const onSignOut = async () => {
    setBusy(true);
    await signOut();
    setBusy(false);
    router.replace('/sign-in');
  };

  const onSave = () => {
    setFeedback(null);
    updateProfile.mutate(
      {
        fullName,
        email,
        preferredTransmission: transmission,
        emergencyContactName: contactName,
        emergencyContactPhone: contactPhone,
        marketingOptIn,
      },
      {
        onSuccess: () => setFeedback({ tone: 'success', text: 'Saved.' }),
        onError: (error) =>
          setFeedback({
            tone: 'danger',
            text: error instanceof Error ? error.message : 'The backend refused this update.',
          }),
      },
    );
  };

  const unread = (notifications.data ?? []).filter((item) => item.readAtMs === null).length;

  return (
    <Screen>
      <View style={{ gap: theme.spacing.lg }}>
        <ScreenHeader
          title="Account"
          action={
            <View style={{ alignItems: 'flex-end', gap: theme.spacing.xs }}>
              <Text variant="caption" tone="muted">
                {user?.phoneNumber ?? 'Phone number unavailable'}
              </Text>
              <StatusPill label={claims.role} tone={claims.admin ? 'brand' : 'info'} />
            </View>
          }
        />

        {profile.isError ? (
          <StateView
            kind="permission_denied"
            title="Could not read your profile"
            message={profile.error instanceof Error ? profile.error.message : 'Firestore refused.'}
          />
        ) : null}

        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="subheading" tone="brand">
            Your details
          </Text>
          <Field label="Full name" value={fullName} onChangeText={setFullName} />
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            helper="Receipts and trip updates go here."
          />
          <Field
            label="Contact number"
            value={profile.data?.contactPhoneE164 ?? ''}
            editable={false}
            helper="Set from your verified sign-in number. Changing a number means signing in again with it."
          />

          <View style={{ gap: theme.spacing.xs }}>
            <Text variant="label" tone="brand">
              Preferred transmission
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
              {TRANSMISSIONS.map((option) => (
                <Button
                  key={option}
                  label={TRANSMISSION_LABEL[option]}
                  size="sm"
                  appearance="secondary"
                  selected={transmission === option}
                  onPress={() => setTransmission(option)}
                />
              ))}
            </View>
          </View>

          <Divider size="sm" />

          <View style={{ gap: theme.spacing.xs }}>
            <Text variant="label" tone="brand">
              Emergency contact
            </Text>
            <Text variant="caption" tone="faint">
              Shared with the driver only in an emergency.
            </Text>
            <Field
              label="Contact name"
              value={contactName}
              onChangeText={setContactName}
              optional
            />
            <Field
              label="Contact number"
              value={contactPhone}
              onChangeText={setContactPhone}
              optional
              keyboardType="phone-pad"
            />
          </View>

          <View style={{ gap: theme.spacing.xs }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
              <Toggle
                value={marketingOptIn}
                onValueChange={setMarketingOptIn}
                accessibilityLabel="Marketing messages"
              />
              <Text variant="caption" tone="muted" style={{ flex: 1 }}>
                Marketing messages
              </Text>
            </View>
            <Text variant="caption" tone="faint">
              Occasional offers and service updates.
            </Text>
          </View>

          <Button label="Save changes" onPress={onSave} loading={updateProfile.isPending} fullWidth />
          {feedback ? (
            <Text variant="caption" tone={feedback.tone} accessibilityRole="alert">
              {feedback.text}
            </Text>
          ) : null}
        </Card>

        <Card tone="inset" style={{ gap: theme.spacing.sm }}>
          <Text variant="subheading" tone="brand">
            Account record
          </Text>
          <Text variant="caption" tone="faint">
            Trips booked: {profile.data?.lifetimeBookings ?? 0} ·{' '}
            {profile.data && profile.data.ratingAverage !== null
              ? `Rated ${profile.data.ratingAverage.toFixed(2)} across ${profile.data.ratingCount} ratings`
              : 'Not rated yet'}
          </Text>
          <Text variant="caption" tone="faint">
            {profile.data ? `With us since ${dateTime(profile.data.createdAtMs)}.` : ''}
          </Text>
        </Card>

        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="subheading" tone="brand">
            Saved places
          </Text>
          <Text variant="caption" tone="muted">
            Addresses you reuse for trip requests.
          </Text>
          <Button
            label="Manage saved places"
            onPress={() => router.push('/(customer)/saved-places')}
            appearance="secondary"
            size="sm"
          />
          <Divider size="sm" />
          <Text variant="subheading" tone="brand">
            Help and support
          </Text>
          <Text variant="caption" tone="muted">
            Open a ticket about a trip, a fare or your account, and reply to one you already opened.
          </Text>
          <Button
            label="Open support"
            onPress={() => router.push('/(customer)/support')}
            appearance="secondary"
            size="sm"
          />
        </Card>

        <Card style={{ gap: theme.spacing.sm }}>
          <Text variant="subheading" tone="brand">
            Notifications {unread > 0 ? `(${unread} unread)` : ''}
          </Text>
          {notifications.isError ? (
            <Text variant="caption" tone="danger">
              {notifications.error instanceof Error ? notifications.error.message : 'Firestore refused.'}
            </Text>
          ) : null}
          {!notifications.isError && (notifications.data ?? []).length === 0 && !notifications.isPending ? (
            <Text variant="caption" tone="muted">
              No notifications yet.
            </Text>
          ) : null}
          {(notifications.data ?? []).map((item) => (
            <View key={item.id} style={{ gap: theme.spacing.xxs }}>
              <Text variant="caption">{item.title ?? item.type ?? 'Notification'}</Text>
              <Text variant="caption" tone="muted">
                {item.body ?? '—'} · {dateTime(item.createdAtMs)}
              </Text>
              {item.readAtMs === null ? (
                <Button
                  label="Mark read"
                  appearance="ghost"
                  size="sm"
                  loading={markRead.isPending && markRead.variables === item.id}
                  onPress={() =>
                    markRead.mutate(item.id, {
                      onError: (error) =>
                        setFeedback({
                          tone: 'danger',
                          text: error instanceof Error ? error.message : 'Could not mark that as read.',
                        }),
                    })
                  }
                />
              ) : (
                <Text variant="caption" tone="faint">
                  Read {dateTime(item.readAtMs)}
                </Text>
              )}
            </View>
          ))}
        </Card>

        <PushNotificationsCard />

        <LegalPanel role="customer" />

        <SurfaceSwitch />

        <Button label="Sign out" onPress={onSignOut} loading={busy} appearance="secondary" fullWidth />
      </View>
    </Screen>
  );
}
