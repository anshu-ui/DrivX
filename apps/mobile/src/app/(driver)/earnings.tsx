import { View } from 'react-native';
import { Card, Divider, Screen, ScreenHeader, StateView, Text, useTheme } from '@drivx/ui';
import { formatINR } from '@drivx/domain';
import { RequireApproval } from '../../components/RequireApproval';
import { useDriverDues } from '../../features/driver/profile';
import { useDrivenTrips, type DrivenTrip } from '../../features/driver/trips';

/** Labelled money line, the way a receipt reads: description on the left, amount on the right. */
function Line({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
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
      <Text variant={strong ? 'bodyStrong' : 'body'} tone={strong ? 'brand' : 'muted'}>
        {label}
      </Text>
      <Text variant={strong ? 'bodyStrong' : 'body'} tone="default">
        {value}
      </Text>
    </View>
  );
}

function tripTitle(trip: DrivenTrip): string {
  const direction = trip.oneWay ? 'One way' : 'Round trip';
  return trip.kilometres === null ? direction : `${direction} · ${trip.kilometres} km`;
}

const STAMP = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium',
  hour12: true,
  timeZone: 'Asia/Kolkata',
});

/**
 * What a driver earned, trip by trip.
 *
 * Each card answers the four questions the driver actually asks — what the
 * customer paid, how much of that was tax, how much the platform took, and what
 * is left in the driver's pocket — using the same split the dues ledger billed,
 * so the two screens can never disagree about one trip.
 */
export default function DriverEarnings() {
  const theme = useTheme();
  const trips = useDrivenTrips();
  const dues = useDriverDues();

  const rows = trips.data ?? [];
  const kept = rows.reduce((sum, trip) => sum + (trip.split?.netPaise ?? 0), 0);

  return (
    <Screen>
      <View style={{ gap: theme.spacing.lg }}>
        <ScreenHeader title="Earnings" />
        <RequireApproval>
          {trips.isError ? (
            <StateView
              kind="error"
              title="Your trips could not be read"
              message={trips.error instanceof Error ? trips.error.message : 'Firestore refused.'}
            />
          ) : null}

          {rows.length === 0 && !trips.isError ? (
            <StateView
              kind="empty"
              title="No completed trips yet"
              message="A trip appears here the moment it is recorded as finished, with the fare the customer paid, the tax in it, the commission taken and what you kept. Nothing is estimated before that."
            />
          ) : null}

          {rows.length > 0 ? (
            <Card tone="brand">
              <View style={{ gap: theme.spacing.xs }}>
                <Text variant="label" tone="onBrand">
                  Kept from {rows.length} trip{rows.length === 1 ? '' : 's'}
                </Text>
                <Text variant="title" tone="onBrand">
                  {formatINR(kept)}
                </Text>
                {dues.outstandingPaise > 0 ? (
                  <Text variant="caption" tone="onBrand">
                    {formatINR(dues.outstandingPaise)} of that is still owed to the platform and is
                    listed under Duty.
                  </Text>
                ) : null}
              </View>
            </Card>
          ) : null}

          {rows.map((trip) => (
            <Card key={trip.id} style={{ gap: theme.spacing.sm }}>
              <View style={{ gap: theme.spacing.xs }}>
                <Text variant="subheading" tone="brand">
                  {tripTitle(trip)}
                </Text>
                <Text variant="caption" tone="muted">
                  {trip.reference}
                  {trip.completedAtMs !== null ? ` · ${STAMP.format(trip.completedAtMs)}` : ''}
                </Text>
              </View>
              {trip.split ? (
                <>
                  <Divider />
                  <Line label="Fare the customer paid" value={formatINR(trip.split.fareTotalPaise)} />
                  <Line label="tax inside that bill" value={formatINR(trip.split.gstPaise)} />
                  <Line
                    label={`Commission ${Math.round(trip.split.rate * 100)}% + ${Math.round(
                      trip.split.gstRate * 100,
                    )}% tax on it`}
                    value={`− ${formatINR(trip.split.commissionPaise)}`}
                  />
                  <Divider />
                  <Line label="You kept" value={formatINR(trip.split.netPaise)} strong />
                </>
              ) : (
                <Text variant="caption" tone="muted">
                  This trip has no fare or commission terms on its record, so there is nothing to
                  split.
                </Text>
              )}
            </Card>
          ))}
        </RequireApproval>
      </View>
    </Screen>
  );
}
