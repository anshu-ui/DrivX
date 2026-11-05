import { Linking, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import {
  Button,
  Card,
  Screen,
  ScreenHeader,
  StateView,
  StatusPill,
  Tag,
  Text,
  useTheme,
} from '@drivx/ui';
import { useActiveBooking, useMyBookings } from '../../features/customer/queries';
import { CancelTripAction } from '../../features/customer/CancelTripPanel';
import { addressLine, dateTime, money, statusLabel, statusTone } from '../../features/customer/labels';

/**
 * Trip history straight from `bookings`, filtered on the caller's uid — the
 * only shape the list rule and the (customerUid, createdAtMs) index allow.
 */
export default function CustomerTrips() {
  const theme = useTheme();
  const bookings = useMyBookings();
  const live = useActiveBooking().booking;

  if (bookings.isPending) {
    return (
      <Screen>
        <StateView kind="loading" />
      </Screen>
    );
  }

  if (bookings.isError) {
    return (
      <Screen>
        <StateView
          kind="error"
          title="Could not load your trips"
          message={
            bookings.error instanceof Error
              ? bookings.error.message
              : 'Firestore refused this query.'
          }
          actionLabel="Try again"
          onAction={() => void bookings.refetch()}
        />
      </Screen>
    );
  }

  if (bookings.data.length === 0) {
    return (
      <Screen>
        <ScreenHeader title="Your trips" />
        <StateView
          kind="empty"
          title="No trips yet"
          message="Receipts, ratings and fare breakdowns appear here after a completed journey."
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ gap: theme.spacing.lg }}>
        <ScreenHeader title="Your trips" />

        {live ? (
          <Card tone="brand" style={{ gap: theme.spacing.sm }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.md }}>
              <Text variant="heading" tone="onBrand">
                {statusLabel(live.status)}
              </Text>
              <Tag label={live.reference} tone="onBrand" />
            </View>
            <Text variant="body" tone="onBrand">
              {addressLine(live.pickup)} → {addressLine(live.destination)}
            </Text>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.md }}>
              <Text variant="caption" tone="onBrand">
                {live.driver
                  ? `${live.driver.fullName}${live.driver.phoneE164 ? ` · ${live.driver.phoneE164}` : ''}${live.driver.vehicle.plate ? ` · ${live.driver.vehicle.plate}` : ''}`
                  : live.assignedDriverUid
                    ? 'Driver assigned · open the trip for every update'
                    : "We'll show your driver here as soon as one is assigned"}
              </Text>
              <Text variant="bodyStrong" tone="onBrand">
                {money(live.finalFare?.totalPaise ?? live.runningFare?.totalPaise ?? live.estimate?.totalPaise)}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
              {live.driver?.phoneE164 ? (
                <Button
                  label="Call driver"
                  onPress={() => void Linking.openURL(`tel:${live.driver!.phoneE164}`)}
                  appearance="secondary"
                  size="sm"
                />
              ) : null}
              <Button
                label="Open trip"
                onPress={() => router.push(`/(customer)/trips/${live.id}`)}
                appearance="secondary"
                size="sm"
                style={{ flex: 1 }}
              />
              <CancelTripAction
                bookingId={live.id}
                status={live.status}
                hasDriver={live.assignedDriverUid !== null}
              />
            </View>
          </Card>
        ) : null}

        <View style={{ gap: theme.spacing.sm }}>
          {bookings.data
            .filter((booking) => booking.id !== live?.id)
            .map((booking) => (
              <Pressable
                key={booking.id}
                onPress={() => router.push(`/(customer)/trips/${booking.id}`)}
                accessibilityRole="button"
                accessibilityLabel={`Trip ${booking.reference}`}
              >
                <Card tone="flat" style={{ gap: theme.spacing.xs }}>
                  <View
                    style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.md }}
                  >
                    <Text variant="heading" tone="brand">
                      {booking.reference}
                    </Text>
                    <StatusPill label={statusLabel(booking.status)} tone={statusTone(booking.status)} />
                  </View>
                  <Text variant="caption" tone="muted">
                    {addressLine(booking.pickup)} → {addressLine(booking.destination)}
                  </Text>
                  {booking.driver ? (
                    <View style={{ gap: theme.spacing.xxs }}>
                      <Text variant="bodyStrong" tone="brand">Driver: {booking.driver.fullName}</Text>
                      <Text variant="caption" tone="muted">
                        {booking.driver.phoneE164 || 'Phone number unavailable'} · Open trip to call and see trip updates
                      </Text>
                    </View>
                  ) : booking.assignedDriverUid ? (
                    <Text variant="caption" tone="muted">
                      Driver assigned · Open trip to load their contact details
                    </Text>
                  ) : null}
                  <View
                    style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.md }}
                  >
                    <Text variant="caption" tone="faint">
                      {dateTime(booking.createdAtMs ?? booking.scheduledForMs)}
                    </Text>
                    <Text variant="bodyStrong" tone="brand">
                      {booking.finalFare ? money(booking.finalFare.totalPaise) : money(booking.estimate?.totalPaise)}
                    </Text>
                  </View>
                </Card>
              </Pressable>
            ))}
        </View>

        <Card tone="inset">
          <Text variant="caption" tone="faint">
            Payment status, fares and trip states are written by Cloud Functions. This list is a read
            of what the server already decided.
          </Text>
        </Card>
      </View>
    </Screen>
  );
}
