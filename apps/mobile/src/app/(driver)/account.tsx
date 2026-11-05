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
  useTheme,
  type PillTone,
} from '@drivx/ui';
import { DOCUMENT_LABELS, formatINR } from '@drivx/domain';
import { useSession } from '../../features/auth/AuthProvider';
import {
  ACCESS_COPY,
  describeOutstandingFee,
  useDriverProfile,
  useDriverDues,
  useUpdateDriverProfile,
} from '../../features/driver/profile';
import { useDriverDocuments } from '../../features/driver/documents';
import { useDriverRatings, type ReceivedRating } from '../../features/driver/ratings';
import { useNotifications } from '../../features/customer/queries';
import { useMarkNotificationRead } from '../../features/customer/mutations';
import { dateTime, LANGUAGES_OFFERED, languageLabel, ratingTagLabel } from '../../features/customer/labels';
import { LegalPanel } from '../../features/legal/LegalPanel';
import { SurfaceSwitch } from '../../components/SurfaceSwitch';
import { PushNotificationsCard } from '../../components/PushNotificationsCard';

const DOCUMENT_TONE: Record<string, PillTone> = {
  approved: 'success',
  pending_review: 'warning',
  rejected: 'danger',
  expiring_soon: 'warning',
  expired: 'danger',
  not_uploaded: 'neutral',
};

function stars(score: number): string {
  const filled = Math.max(0, Math.min(5, Math.round(score)));
  return `${'★'.repeat(filled)}${'☆'.repeat(5 - filled)}`;
}

/**
 * One rating a customer left on a closed trip.
 *
 * The trip is named by its reference, not its Firestore id, because a driver
 * argues about a job by the number printed on it — which is why `rateTrip`
 * copies the reference onto the rating when it writes the row.
 *
 * The customer is deliberately not named here. The rules give a driver no read
 * on a customer's profile, so an attribution would have to be invented, and an
 * anonymous rating is both the truthful and the safer thing to show.
 */
function RatingRow({ row }: { row: ReceivedRating }) {
  const theme = useTheme();
  return (
    <View
      style={{
        gap: theme.spacing.xxs,
        borderTopWidth: theme.borderWidth.thin,
        borderTopColor: theme.colors.border,
        paddingTop: theme.spacing.sm,
      }}
    >
      <View
        style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.md }}
      >
        <Text variant="body">{stars(row.score)}</Text>
        <Text variant="caption" tone="muted">
          {row.bookingReference ?? row.bookingId}
        </Text>
      </View>
      <Text variant="caption" tone="faint">
        {row.atMs !== null ? dateTime(row.atMs) : 'Date not recorded'}
      </Text>
      {row.tags.length > 0 ? (
        <Text variant="caption" tone="muted">
          {row.tags.map(ratingTagLabel).join(' · ')}
        </Text>
      ) : null}
      {row.comment ? <Text variant="body" tone="default">“{row.comment}”</Text> : null}
    </View>
  );
}

/**
 * The driver's own account.
 *
 * The owner asked for "sab kuch" on this screen twice over: what the business
 * holds about the driver — name, number, reference, approval date, languages,
 * car, rating, trips, paperwork and the ledger — and the same help desk, Terms
 * and Privacy the customer gets, in the driver's own words. The car fields are
 * editable here because the rules leave them open to the driver and, under
 * "Safar aapka, driver hamara", the person behind the wheel is the only one who
 * knows which car they are in today.
 */
export default function DriverAccount() {
  const theme = useTheme();
  const { user, signOut } = useSession();
  const { profile, loading, unreadable } = useDriverProfile();
  const dues = useDriverDues();
  const documents = useDriverDocuments();
  const ratings = useDriverRatings();
  const notifications = useNotifications();
  const markRead = useMarkNotificationRead();
  const updateProfile = useUpdateDriverProfile();

  const [fullName, setFullName] = useState('');
  const [vehicleMake, setVehicleMake] = useState('');
  const [vehicleModel, setVehicleModel] = useState('');
  const [vehiclePlate, setVehiclePlate] = useState('');
  const [languages, setLanguages] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Seeded off the stored values rather than a timestamp: a profile written by
  // the office can legitimately have no `updatedAtMs`, and a form that never
  // fills in is a form that looks broken. The signature only changes when the
  // record does — so a save paints the normalised plate, and typing is never
  // overwritten by a snapshot that says the same thing as the last one.
  const [seededValues, setSeededValues] = useState<string | null>(null);
  const values = profile
    ? JSON.stringify([
        profile.fullName,
        profile.vehicleMake,
        profile.vehicleModel,
        profile.vehiclePlate,
        profile.languages,
      ])
    : null;
  if (profile && values !== null && values !== seededValues) {
    setSeededValues(values);
    setFullName(profile.fullName === 'Unnamed driver' ? '' : profile.fullName);
    setVehicleMake(profile.vehicleMake ?? '');
    setVehicleModel(profile.vehicleModel ?? '');
    setVehiclePlate(profile.vehiclePlate ?? '');
    setLanguages(profile.languages);
  }

  const onSave = () => {
    setFeedback(null);
    updateProfile.mutate(
      { fullName, vehicleMake, vehicleModel, vehiclePlate, languages },
      {
        onSuccess: () => setFeedback({ tone: 'success', text: 'Saved. Your next trip shows this.' }),
        onError: (error) =>
          setFeedback({
            tone: 'danger',
            text: error instanceof Error ? error.message : 'The backend refused this update.',
          }),
      },
    );
  };

  const onSignOut = async () => {
    setBusy(true);
    await signOut();
    setBusy(false);
    router.replace('/sign-in');
  };

  const status = ACCESS_COPY[profile?.verificationStatus ?? 'unknown'] ?? ACCESS_COPY.unknown!;
  const unpaid = dues.rows.filter((row) => row.status === 'unpaid');
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
              <StatusPill label={status.label} tone={status.tone} />
            </View>
          }
        />

        {unreadable ? (
          <StateView
            kind="permission_denied"
            title="Could not read your profile"
            message="Firestore refused the read, so the details below are not shown rather than guessed."
          />
        ) : null}

        {loading && !unreadable ? (
          <StateView kind="loading" message="Reading your account…" />
        ) : null}

        {profile ? (
          <Card style={{ gap: theme.spacing.sm }}>
            <Text variant="subheading" tone="brand">
              {profile.fullName}
            </Text>
            <Text variant="caption" tone="muted">
              {profile.driverId
                ? `Driver reference ${profile.driverId}`
                : 'Driver reference: issued by the office when your documents are approved.'}
            </Text>
            <Text variant="caption" tone="muted">
              {profile.phoneE164 ?? user?.phoneNumber ?? 'No number on the profile'}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
              <StatusPill
                label={profile.availabilityState === 'online' ? 'online' : profile.availabilityState}
                tone={profile.availabilityState === 'online' ? 'success' : 'neutral'}
              />
            </View>
            <Text variant="caption" tone="faint">
              {profile.languages.length > 0
                ? `Speaks ${profile.languages.map(languageLabel).join(', ')}`
                : 'No languages recorded yet — add them below so the customer knows.'}
            </Text>
            <Text variant="caption" tone="faint">
              {profile.verifiedAtMs !== null
                ? `Approved by the office on ${dateTime(profile.verifiedAtMs)}.`
                : profile.createdAtMs !== null
                  ? `On DrivX since ${dateTime(profile.createdAtMs)}.`
                  : ''}
            </Text>
            <Text variant="caption" tone="faint">
              Work zone: {profile.zoneId ?? 'not recorded'} · {profile.lifetimeTrips} trip
              {profile.lifetimeTrips === 1 ? '' : 's'} completed
            </Text>
          </Card>
        ) : null}

        {profile ? (
          <Card style={{ gap: theme.spacing.md }}>
            <Text variant="subheading" tone="brand">
              Your details and your car
            </Text>
            <Field label="Full name" value={fullName} onChangeText={setFullName} />
            <Field
              label="Contact number"
              value={profile.phoneE164 ?? ''}
              editable={false}
              helper="Set from the number you signed in with. Changing it means signing in again with the new one."
            />
            <Field
              label="Car make"
              value={vehicleMake}
              onChangeText={setVehicleMake}
              optional
              autoCapitalize="words"
              helper="Leave all three empty if you drive the customer's car."
            />
            <Field label="Car model" value={vehicleModel} onChangeText={setVehicleModel} optional autoCapitalize="words" />
            <Field
              label="Number plate"
              value={vehiclePlate}
              onChangeText={setVehiclePlate}
              optional
              autoCapitalize="characters"
              helper="What the customer reads at the pickup point."
            />

            <View style={{ gap: theme.spacing.xs }}>
              <Text variant="label" tone="brand">
                Languages you speak
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
                {LANGUAGES_OFFERED.map((code) => {
                  const selected = languages.includes(code);
                  return (
                    <Button
                      key={code}
                      label={languageLabel(code)}
                      size="sm"
                      appearance="secondary"
                      selected={selected}
                      onPress={() =>
                        setLanguages(
                          selected ? languages.filter((item) => item !== code) : [...languages, code],
                        )
                      }
                    />
                  );
                })}
              </View>
            </View>

            <Button label="Save changes" onPress={onSave} loading={updateProfile.isPending} fullWidth />
            <Text variant="caption" tone="faint">
              The card a customer is shown is written when a driver is assigned to the trip, so an
              edit here appears on your next trip rather than the one in hand. Your verification
              status, rating and trip counts are not on this form — the rules only let the office
              and DrivX write them.
            </Text>
            {feedback ? (
              <Text variant="caption" tone={feedback.tone} accessibilityRole="alert">
                {feedback.text}
              </Text>
            ) : null}
          </Card>
        ) : null}

        {profile ? (
          <Card tone="inset" style={{ gap: theme.spacing.xs }}>
            <Text variant="subheading" tone="brand">
              Your rating
            </Text>
            <Text variant="fare">
              {profile.ratingCount > 0 ? profile.ratingAverage.toFixed(2) : '—'}
              {profile.ratingCount > 0 ? (
                <Text variant="caption" tone="muted">
                  {' '}
                  ★ from {profile.ratingCount} rating{profile.ratingCount === 1 ? '' : 's'}
                </Text>
              ) : null}
            </Text>
            <Text variant="caption" tone="faint">
              {profile.ratingCount > 0
                ? 'This is the figure the customer is shown when a driver is assigned. You cannot write it yourself, and the rules refuse the office writing it directly too — only a customer’s rating on a closed trip moves it.'
                : 'No rating on your account yet. A customer rates their trip from their own screen once it has closed, and that rating is the only thing that writes this number.'}
            </Text>

            {ratings.isError ? (
              <Text variant="caption" tone="danger" accessibilityRole="alert">
                {ratings.error instanceof Error
                  ? ratings.error.message
                  : 'Firestore refused the rating list.'}
              </Text>
            ) : null}

            {(ratings.data ?? []).map((row) => (
              <RatingRow key={row.id} row={row} />
            ))}

            {ratings.data && ratings.data.length === 0 ? (
              <Text variant="caption" tone="muted">
                {profile.ratingCount > 0
                  ? 'No rating row is on file for this account, so the average above came with it rather than from a trip this app can point at. Each rating a customer sends is written with its trip reference and appears here.'
                  : 'No rating has been left on one of your trips yet. There is nothing to show until a customer sends one.'}
              </Text>
            ) : null}

            {(ratings.data ?? []).length > 0 ? (
              <Text variant="caption" tone="faint">
                Newest first, up to your last 20 ratings — the average above counts every rating on
                your account, including any older than this list. The customer who sent each one is
                not named, because the rules do not give you their profile.
              </Text>
            ) : null}
          </Card>
        ) : null}

        {profile ? (
          <Card tone="inset" style={{ gap: theme.spacing.xs }}>
            <Text variant="subheading" tone="brand">On-time arrival (OTR)</Text>
            <Text variant="fare">
              {profile.onTimeArrivalRate === null ? '—' : `${Math.round(profile.onTimeArrivalRate * 100)}%`}
            </Text>
            <Text variant="caption" tone="muted">
              {profile.onTimeArrivalCount + profile.lateArrivalCount > 0
                ? `${profile.onTimeArrivalCount} on-time · ${profile.lateArrivalCount} late from ${profile.onTimeArrivalCount + profile.lateArrivalCount} scheduled trips.`
                : 'No scheduled arrival has been measured yet. Immediate bookings do not count toward OTR.'}
            </Text>
            <Text variant="caption" tone="faint">
              OTR is recorded when you enter the trip start OTP. The Admin-configured grace period applies; any configured late penalty appears in Your dues with the trip reference.
            </Text>
          </Card>
        ) : null}

        <Card style={{ gap: theme.spacing.sm }}>
          <Text variant="subheading" tone="brand">
            Your documents
          </Text>
          {documents.isError ? (
            <Text variant="caption" tone="danger">
              {documents.error instanceof Error ? documents.error.message : 'Firestore refused.'}
            </Text>
          ) : null}
          {(documents.data ?? []).map((row) => (
            <View
              key={row.type}
              style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.md }}
            >
              <Text variant="caption">{DOCUMENT_LABELS[row.type]}</Text>
              <StatusPill
                label={
                  row.status === 'not_uploaded'
                    ? 'not uploaded'
                    : row.status.replace(/_/g, ' ')
                }
                tone={DOCUMENT_TONE[row.status] ?? 'neutral'}
              />
            </View>
          ))}
          <Button
            label="Open document checklist"
            appearance="secondary"
            size="sm"
            onPress={() => router.push('/(driver)/documents')}
          />
        </Card>

        <Card tone="inset" style={{ gap: theme.spacing.xs }}>
          <Text variant="subheading" tone="brand">
            Money owed to DrivX
          </Text>
          <Text variant="caption" tone={dues.outstandingPaise > 0 ? 'danger' : 'muted'}>
            {describeOutstandingFee(dues)}
          </Text>
          {unpaid.map((row) => (
            <View
              key={row.id}
              style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.md }}
            >
              <Text variant="caption" tone="muted">
                {row.title}
              </Text>
              <Text variant="caption">{formatINR(row.totalPaise)}</Text>
            </View>
          ))}
          <Button
            label="Open earnings"
            appearance="secondary"
            size="sm"
            onPress={() => router.push('/(driver)/earnings')}
          />
        </Card>

        <Divider size="sm" />

        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="subheading" tone="brand">
            Help and support
          </Text>
          <Text variant="caption" tone="muted">
            Open a ticket about a trip, a commission row or your documents, and reply to one you
            already opened. Anything the office decides about your account shows up there as well as
            on this screen.
          </Text>
          <Button
            label="Open support"
            onPress={() => router.push('/(driver)/support')}
            appearance="secondary"
            size="sm"
          />
          <Divider size="sm" />
          <Text variant="subheading" tone="brand">
            Notifications {unread > 0 ? `(${unread} unread)` : ''}
          </Text>
          {notifications.isError ? (
            <Text variant="caption" tone="danger">
              {notifications.error instanceof Error ? notifications.error.message : 'Firestore refused.'}
            </Text>
          ) : null}
          {!notifications.isError &&
          (notifications.data ?? []).length === 0 &&
          !notifications.isPending ? (
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
                  onPress={() => markRead.mutate(item.id)}
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

        <LegalPanel role="driver" />

        <SurfaceSwitch />

        <Button label="Sign out" onPress={onSignOut} loading={busy} appearance="secondary" fullWidth />
      </View>
    </Screen>
  );
}
