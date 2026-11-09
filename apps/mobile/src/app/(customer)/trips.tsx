import { useMemo, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
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
import { useActiveBooking, useMyBookings, type BookingView } from '../../features/customer/queries';
import { CancelTripAction } from '../../features/customer/CancelTripPanel';
import { addressLine, dateTime, isLive, money, statusLabel, statusTone } from '../../features/customer/labels';

type TripFilter = 'all' | 'active' | 'completed';

function SummaryTile({
  label,
  value,
  icon,
  selected,
  onPress,
}: {
  label: string;
  value: number;
  icon: 'layers-outline' | 'navigate-outline' | 'checkmark-done-outline';
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minWidth: 96,
        padding: theme.spacing.md,
        gap: theme.spacing.sm,
        borderRadius: theme.radius.lg,
        borderWidth: theme.borderWidth.thin,
        borderColor: selected ? theme.colors.primary : theme.colors.border,
        backgroundColor: selected ? theme.colors.primarySoft : theme.colors.surface,
        opacity: pressed ? 0.76 : 1,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing.xs }}>
        <Ionicons name={icon} size={18} color={selected ? theme.colors.primary : theme.colors.textMuted} />
        <Text variant="heading" tone="brand">{value}</Text>
      </View>
      <Text variant="overline" tone="muted" numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

function TripRow({ booking }: { booking: BookingView }) {
  const theme = useTheme();
  const fare = booking.finalFare?.totalPaise ?? booking.runningFare?.totalPaise ?? booking.estimate?.totalPaise;
  const driverName = booking.driver?.fullName;
  const vehicle = [booking.driver?.vehicle.make, booking.driver?.vehicle.model]
    .filter(Boolean)
    .join(' ');

  return (
    <Pressable
      onPress={() => router.push(`/(customer)/trips/${booking.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`Open trip ${booking.reference}`}
      style={({ pressed }) => ({ opacity: pressed ? 0.76 : 1 })}
    >
      <Card tone="raised" style={{ gap: theme.spacing.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: theme.spacing.sm }}>
          <View style={{ flex: 1, minWidth: 0, gap: theme.spacing.xxs }}>
            <Text variant="label" tone="brand" numberOfLines={1}>{booking.reference}</Text>
            <Text variant="caption" tone="muted">{dateTime(booking.createdAtMs ?? booking.scheduledForMs)}</Text>
          </View>
          <StatusPill label={statusLabel(booking.status)} tone={statusTone(booking.status)} />
        </View>

        <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
          <View style={{ alignItems: 'center', paddingTop: 4, width: 16 }}>
            <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: theme.colors.primary }} />
            <View style={{ width: 1, height: 23, backgroundColor: theme.colors.border }} />
            <View style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: theme.colors.textMuted }} />
          </View>
          <View style={{ flex: 1, gap: theme.spacing.sm }}>
            <Text variant="body" tone="brand" numberOfLines={2}>{addressLine(booking.pickup)}</Text>
            <Text variant="body" tone="brand" numberOfLines={2}>{addressLine(booking.destination)}</Text>
          </View>
        </View>

        {(driverName || booking.assignedDriverUid) ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, padding: theme.spacing.sm, borderRadius: theme.radius.md, backgroundColor: theme.colors.surfaceMuted }}>
            <View style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.primarySoft }}>
              <Ionicons name="person-outline" size={17} color={theme.colors.primary} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text variant="label" tone="brand" numberOfLines={1}>{driverName ?? 'Driver assigned'}</Text>
              <Text variant="overline" tone="muted" numberOfLines={1}>{vehicle || 'Open trip for driver details'}</Text>
            </View>
            {booking.driver?.phoneE164 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Call ${driverName ?? 'driver'}`}
                hitSlop={8}
                onPress={() => void Linking.openURL(`tel:${booking.driver!.phoneE164}`)}
                style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surface }}
              >
                <Ionicons name="call-outline" size={17} color={theme.colors.primary} />
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">{booking.finalFare ? 'Final fare' : booking.runningFare ? 'Fare so far' : 'Estimated fare'}</Text>
          <Text variant="heading" tone="brand">{money(fare)}</Text>
        </View>
      </Card>
    </Pressable>
  );
}

export default function CustomerTrips() {
  const theme = useTheme();
  const bookings = useMyBookings();
  const live = useActiveBooking().booking;
  const [filter, setFilter] = useState<TripFilter>('all');

  const summary = useMemo(() => {
    const rows = new Map((bookings.data ?? []).map((booking) => [booking.id, booking]));
    if (live) rows.set(live.id, live);
    const all = [...rows.values()];
    return {
      all,
      total: all.length,
      active: all.filter((booking) => isLive(booking.status)).length,
      completed: all.filter((booking) => booking.status === 'completed').length,
    };
  }, [bookings.data, live]);

  const visibleBookings = useMemo(() => {
    const rows = summary.all.filter((booking) => {
      if (filter === 'active') return isLive(booking.status);
      if (filter === 'completed') return booking.status === 'completed';
      return true;
    });
    return rows.sort((a, b) => (b.createdAtMs ?? b.scheduledForMs ?? 0) - (a.createdAtMs ?? a.scheduledForMs ?? 0));
  }, [filter, summary.all]);

  // The live booking has its own prominent card above. Keep it out of the
  // history list so the customer sees one actionable card per active trip.
  const highlightedLive = Boolean(live && filter !== 'completed');
  const listBookings = highlightedLive
    ? visibleBookings.filter((booking) => booking.id !== live?.id)
    : visibleBookings;

  if (bookings.isPending) {
    return <Screen><StateView kind="loading" /></Screen>;
  }

  if (bookings.isError) {
    return (
      <Screen>
        <ScreenHeader title="Your trips" subtitle="Every journey, all in one place." />
        <StateView
          kind="error"
          title="Could not load your trips"
          message={bookings.error instanceof Error ? bookings.error.message : 'Firestore refused this query.'}
          actionLabel="Try again"
          onAction={() => void bookings.refetch()}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ gap: theme.spacing.lg }}>
        <ScreenHeader title="Your trips" subtitle="Every journey, all in one place." />

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
          <SummaryTile label="All trips" value={summary.total} icon="layers-outline" selected={filter === 'all'} onPress={() => setFilter('all')} />
          <SummaryTile label="In progress" value={summary.active} icon="navigate-outline" selected={filter === 'active'} onPress={() => setFilter('active')} />
          <SummaryTile label="Completed" value={summary.completed} icon="checkmark-done-outline" selected={filter === 'completed'} onPress={() => setFilter('completed')} />
        </View>

        {live && filter !== 'completed' ? (
          <Card tone="brand" style={{ gap: theme.spacing.md }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: theme.spacing.sm }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs, flex: 1 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#B8F3D0' }} />
                <Text variant="label" tone="onBrand" numberOfLines={1}>{statusLabel(live.status)}</Text>
              </View>
              <Tag label={live.reference} tone="onBrand" />
            </View>
            <View style={{ gap: theme.spacing.sm }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.sm }}>
                <Ionicons name="radio-button-on-outline" size={16} color="#DCE8FF" />
                <Text variant="caption" tone="onBrand" style={{ flex: 1 }}>{addressLine(live.pickup)}</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.sm }}>
                <Ionicons name="location-outline" size={16} color="#DCE8FF" />
                <Text variant="caption" tone="onBrand" style={{ flex: 1 }}>{addressLine(live.destination)}</Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: theme.spacing.sm }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                {live.driver ? (
                  <>
                    <Text variant="label" tone="onBrand" numberOfLines={1}>{live.driver.fullName}</Text>
                    <Text variant="overline" tone="onBrand" numberOfLines={1}>
                      {[live.driver.vehicle.make, live.driver.vehicle.model, live.driver.vehicle.plate].filter(Boolean).join(' · ') || live.driver.phoneE164 || 'Driver assigned'}
                    </Text>
                  </>
                ) : (
                  <Text variant="caption" tone="onBrand">
                    {live.assignedDriverUid ? 'Driver assigned · Open trip for details' : "We'll show your driver here as soon as one is assigned"}
                  </Text>
                )}
              </View>
              <Text variant="bodyStrong" tone="onBrand">
                {money(live.finalFare?.totalPaise ?? live.runningFare?.totalPaise ?? live.estimate?.totalPaise)}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs }}>
              {live.driver?.phoneE164 ? (
                <Button label="Call driver" onPress={() => void Linking.openURL(`tel:${live.driver!.phoneE164}`)} appearance="secondary" size="sm" />
              ) : null}
              <Button label="Open trip" onPress={() => router.push(`/(customer)/trips/${live.id}`)} appearance="secondary" size="sm" style={{ flex: 1 }} />
              <CancelTripAction bookingId={live.id} status={live.status} hasDriver={live.assignedDriverUid !== null} />
            </View>
          </Card>
        ) : null}

        <View style={{ gap: theme.spacing.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing.sm }}>
            <Text variant="heading" tone="brand">{filter === 'active' ? 'Current journeys' : filter === 'completed' ? 'Completed journeys' : 'Recent journeys'}</Text>
            <Text variant="caption" tone="muted">{visibleBookings.length} {visibleBookings.length === 1 ? 'trip' : 'trips'}</Text>
          </View>

          {listBookings.length > 0 ? (
            listBookings.map((booking) => <TripRow key={booking.id} booking={booking} />)
          ) : summary.total === 0 ? (
            <Card tone="raised" style={{ alignItems: 'center', gap: theme.spacing.sm, paddingVertical: theme.spacing.xl }}>
              <View style={{ width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.primarySoft }}>
                <Ionicons name="car-outline" size={25} color={theme.colors.primary} />
              </View>
              <Text variant="heading" tone="brand">Your next trip starts here</Text>
              <Text variant="caption" tone="muted" style={{ textAlign: 'center' }}>
                Book a trusted driver and find every trip update and receipt here.
              </Text>
              <Button label="Book a ride" onPress={() => router.replace('/(customer)')} appearance="primary" />
            </Card>
          ) : highlightedLive ? (
            <Card tone="inset" style={{ alignItems: 'center', gap: theme.spacing.xs }}>
              <Text variant="label" tone="brand">Your active trip is shown above</Text>
              <Text variant="caption" tone="muted" style={{ textAlign: 'center' }}>
                Earlier bookings and completed trips will appear here.
              </Text>
            </Card>
          ) : (
            <Card tone="inset" style={{ alignItems: 'center', gap: theme.spacing.xs }}>
              <Text variant="label" tone="brand">
                {filter === 'active' ? 'No active trips' : filter === 'completed' ? 'No completed trips' : 'No trips yet'}
              </Text>
              <Text variant="caption" tone="muted" style={{ textAlign: 'center' }}>
                {filter === 'active'
                  ? 'New and ongoing bookings will appear here.'
                  : filter === 'completed'
                    ? 'Completed trip receipts will appear here.'
                    : 'Your bookings and trip receipts will appear here.'}
              </Text>
            </Card>
          )}
        </View>
      </View>
    </Screen>
  );
}
