import { View } from 'react-native';
import { router } from 'expo-router';
import {
  Button,
  Card,
  Divider,
  Screen,
  ScreenHeader,
  StateView,
  StatusPill,
  Tag,
  Text,
  useTheme,
} from '@drivx/ui';
import { formatINR } from '@drivx/domain';
import { RequireApproval } from '../../components/RequireApproval';
import { useDriverTrip } from '../../features/driver/trip-control';
import { useDriverDues } from '../../features/driver/profile';
import { useDrivenTrips, type DrivenTrip } from '../../features/driver/trips';
import { addressLine, dateTime, money, statusLabel, statusTone } from '../../features/customer/labels';

/**
 * Every trip this driver has driven, in one list.
 *
 * The owner's rule of 2026-10-27: *"driver ke pas section bnao trips ke jisme
 * uski sab completed trips dikhe, na ki duty section me"*. Duty is the job in
 * hand; this is the record. Each row carries the booking reference and the fare
 * detail, because the same rule says a driver must be able to see which booking
 * money came from — the reference, the two dial readings, what the customer paid
 * and what was kept.
 *
 * Nothing is computed here. The fare lines come from the booking's own
 * server-priced `finalFare`, the commission figure from the ledger row that
 * billing wrote, and the distance from the dial, so this screen cannot disagree
 * with Earnings, Duty or the office's console about the same trip.
 */

function Row({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: theme.spacing.md,
      }}
    >
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="body" tone="default">
        {value}
      </Text>
    </View>
  );
}

function dialLine(trip: DrivenTrip): string | null {
  if (trip.startOdometerKm === null || trip.endOdometerKm === null) return null;
  const driven = trip.endOdometerKm - trip.startOdometerKm;
  return `${trip.startOdometerKm} → ${trip.endOdometerKm} km on the dial · ${driven} km driven`;
}

export default function DriverTrips() {
  const theme = useTheme();
  const live = useDriverTrip();
  const trips = useDrivenTrips();
  const dues = useDriverDues();

  const rows = trips.data ?? [];
  const onHand = live.data ?? null;

  return (
    <Screen>
      <View style={{ gap: theme.spacing.lg }}>
        <ScreenHeader title="Your trips" />
        <RequireApproval>
          {trips.isError ? (
            <StateView
              kind="error"
              title="Your trips could not be read"
              message={trips.error instanceof Error ? trips.error.message : 'Firestore refused.'}
              actionLabel="Try again"
              onAction={() => void trips.refetch()}
            />
          ) : null}

          {onHand ? (
            <Card tone="brand" style={{ gap: theme.spacing.sm }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.md }}>
                <Text variant="heading" tone="onBrand">
                  {statusLabel(onHand.status)}
                </Text>
                <Tag label={onHand.reference} tone="onBrand" />
              </View>
              <Text variant="body" tone="onBrand">
                {addressLine(onHand.pickup)} → {addressLine(onHand.destination)}
              </Text>
              <Text variant="caption" tone="onBrand">
                {onHand.runningFare
                  ? `Fare so far ${money(onHand.runningFare.totalPaise)}${
                      onHand.currentOdometerKm !== null ? ` · ${onHand.currentOdometerKm} km on the dial` : ''
                    }`
                  : `Quoted ${money(onHand.estimate?.totalPaise)} — the bill is written from the two readings`}
              </Text>
              <Button
                label="Open trip"
                appearance="secondary"
                size="sm"
                onPress={() => router.push('/(driver)/trip')}
                style={{ alignSelf: 'flex-start' }}
              />
            </Card>
          ) : null}

          {rows.length === 0 && !trips.isError && !trips.isPending ? (
            <StateView
              kind="empty"
              title="No completed trips yet"
              message="A trip lands here the moment the office records it as finished, with the booking reference, the fare the customer paid and what you kept. Nothing appears before that happens."
            />
          ) : null}

          {rows.map((trip) => {
            const due = dues.rows.find((row) => row.bookingId === trip.id && row.kind === 'commission');
            return (
              <Card key={trip.id} style={{ gap: theme.spacing.xs }}>
                <View
                  style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.md }}
                >
                  <Text variant="subheading" tone="brand">
                    {trip.reference}
                  </Text>
                  <StatusPill label={statusLabel('completed')} tone={statusTone('completed')} />
                </View>
                <Text variant="caption" tone="faint">
                  {trip.completedAtMs !== null ? dateTime(trip.completedAtMs) : 'Date not recorded'}
                  {' · '}
                  {trip.oneWay ? 'One way' : 'Round trip'}
                  {trip.kilometres !== null ? ` · ${trip.kilometres} km` : ''}
                </Text>

                {trip.pickup || trip.destination ? (
                  <Text variant="body" tone="default">
                    {addressLine(trip.pickup)} → {addressLine(trip.destination)}
                  </Text>
                ) : null}

                {dialLine(trip) ? (
                  <Text variant="caption" tone="muted">
                    {dialLine(trip)}
                  </Text>
                ) : (
                  <Text variant="caption" tone="warning">
                    No dial reading was recorded on this trip, so its distance and bill were never
                    measured.
                  </Text>
                )}

                {trip.split ? (
                  <>
                    <Divider />
                    <Row label="Fare the customer paid" value={formatINR(trip.split.fareTotalPaise)} />
                    <Row label="tax inside that bill" value={formatINR(trip.split.gstPaise)} />
                    <Row
                      label={`Commission ${Math.round(trip.split.rate * 100)}% + tax on it`}
                      value={`− ${formatINR(trip.split.commissionPaise)}`}
                    />
                    <Row label="You kept" value={formatINR(trip.split.netPaise)} />
                    {due ? (
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 }}>
                        <Text variant="caption" tone="faint">
                          {due.status === 'paid'
                            ? `Commission cleared${due.method ? ` · ${due.method}` : ''}`
                            : 'To pay before the next booking'}
                        </Text>
                        <Text variant="caption" tone={due.status === 'paid' ? 'success' : 'warning'}>
                          {formatINR(due.totalPaise)}
                        </Text>
                      </View>
                    ) : null}
                  </>
                ) : (
                  <Text variant="caption" tone="muted">
                    This trip has no fare on its record, so there is nothing to show beside the
                    reference.
                  </Text>
                )}
              </Card>
            );
          })}

          {rows.length > 0 ? (
            <Card tone="inset">
              <Text variant="caption" tone="faint">
                {rows.length} completed trip{rows.length === 1 ? '' : 's'} on this account. Fares and
                commission are written by DrivX, and what the office recorded against each one is
                shown beside it — {formatINR(dues.outstandingPaise)} is still outstanding.
              </Text>
            </Card>
          ) : null}
        </RequireApproval>
      </View>
    </Screen>
  );
}
