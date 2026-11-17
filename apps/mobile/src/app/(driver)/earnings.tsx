import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Card, Divider, Screen, ScreenHeader, StateView, Text, useTheme } from '@drivx/ui';
import { formatINR } from '@drivx/domain';
import { RequireApproval } from '../../components/RequireApproval';
import { useDriverDues } from '../../features/driver/profile';
import { useDrivenTrips, useDriverEarningsSummary, type DrivenTrip } from '../../features/driver/trips';

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
  const summary = useDriverEarningsSummary();
  const dues = useDriverDues();
  const [period, setPeriod] = useState<'today' | 'week' | 'month'>('today');

  const rows = trips.data ?? [];
  const kept = rows.reduce((sum, trip) => sum + (trip.split?.netPaise ?? 0), 0);
  const totals = summary.data?.[period];
  const today = summary.data?.days.at(-1)?.date ?? '1970-01-01';
  const [year, month, day] = today.split('-').map(Number);
  const currentDateUtc = Date.UTC(year!, month! - 1, day!);
  const mondayOffset = (new Date(currentDateUtc).getUTCDay() + 6) % 7;
  const monday = new Date(currentDateUtc - mondayOffset * 86_400_000).toISOString().slice(0, 10);
  const selectedDays = (summary.data?.days ?? []).filter((row) => period === 'week'
    ? row.date >= monday && row.date <= today
    : period === 'month' ? row.date.startsWith(today.slice(0, 7)) : row.date === today);
  const series = period === 'today'
    ? [{ label: 'Today', amount: totals?.netPaise ?? 0 }]
    : period === 'week'
      ? selectedDays.map((row) => ({ label: row.date.slice(8), amount: row.netPaise }))
      : Array.from({ length: 5 }, (_, index) => ({
          label: `W${index + 1}`,
          amount: selectedDays.filter((row) => Math.floor((Number(row.date.slice(8)) - 1) / 7) === index).reduce((sum, row) => sum + row.netPaise, 0),
        }));
  const tallestBar = Math.max(1, ...series.map((row) => row.amount));

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

          <Card style={{ gap: theme.spacing.md }}>
            <View style={{ gap: theme.spacing.xxs }}>
              <Text variant="subheading" tone="brand">Earnings overview</Text>
              <Text variant="caption" tone="muted">Completed trips, commission and your net earnings.</Text>
            </View>
            <View accessibilityRole="tablist" style={{ flexDirection: 'row', gap: theme.spacing.xs }}>
              {([
                ['today', 'Today'], ['week', 'This week'], ['month', 'This month'],
              ] as const).map(([key, label]) => (
                <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: period === key }} onPress={() => setPeriod(key)} style={{ flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: period === key ? theme.colors.primary : theme.colors.border, backgroundColor: period === key ? theme.colors.primarySoft : theme.colors.surface, paddingHorizontal: 6 }}>
                  <Text variant="caption" tone={period === key ? 'primary' : 'muted'}>{label}</Text>
                </Pressable>
              ))}
            </View>
            {summary.isPending ? <Text variant="caption" tone="muted">Loading your verified earnings…</Text> : null}
            {summary.isError ? <Text variant="caption" tone="danger">Could not load the period summary. Your trip-by-trip records are still shown below.</Text> : null}
            {totals ? <>
              <View style={{ gap: theme.spacing.xs }}>
                <Text variant="fare" tone="brand">{formatINR(totals.netPaise)}</Text>
                <Text variant="caption" tone="muted">You kept · {totals.pricedTrips} priced trip{totals.pricedTrips === 1 ? '' : 's'} · {totals.trips} completed</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.sm }}>
                <Line label="Customer fares" value={formatINR(totals.grossPaise)} />
                <Line label="DrivX commission" value={formatINR(totals.commissionPaise)} />
              </View>
              <View accessibilityLabel={`${period} earnings chart`} style={{ minHeight: 120, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-around', gap: theme.spacing.xs, borderRadius: theme.radius.md, backgroundColor: theme.colors.surfaceMuted, padding: theme.spacing.sm }}>
                {series.map((item) => <View key={item.label} style={{ flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'flex-end', gap: 5 }}>
                  <View accessibilityLabel={`${item.label}: ${formatINR(item.amount)}`} style={{ width: '62%', minWidth: 10, height: Math.max(4, Math.round((item.amount / tallestBar) * 72)), borderRadius: 6, backgroundColor: theme.colors.primary }} />
                  <Text variant="overline" tone="muted" numberOfLines={1}>{item.label}</Text>
                </View>)}
              </View>
              {summary.data?.limited ? <Text variant="caption" tone="faint">Summary is based on the latest 500 completed trips.</Text> : null}
            </> : null}
          </Card>

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
              {trip.finalFare ? (
                <View style={{ gap: theme.spacing.xs }}>
                  <Text variant="overline" tone="brand">FINAL FARE BREAKDOWN</Text>
                  {trip.finalFare.items.map((item) => (
                    <View key={item.key} style={{ gap: 2 }}>
                      <Line label={item.label} value={formatINR(item.amountPaise)} />
                      {item.detail ? <Text variant="caption" tone="faint">{item.detail}</Text> : null}
                    </View>
                  ))}
                  <Line label="Subtotal" value={formatINR(trip.finalFare.subtotalPaise)} />
                  <Line label="Tax" value={formatINR(trip.finalFare.taxPaise)} />
                </View>
              ) : null}
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
