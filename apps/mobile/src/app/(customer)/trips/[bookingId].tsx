import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Card, Divider, Screen, ScreenHeader, StateView, StatusPill, Text, useTheme } from '@drivx/ui';
import { CancelTripAction } from '../../../features/customer/CancelTripPanel';
import { DriverCardPanel } from '../../../features/customer/DriverCardPanel';
import { RateDriverPanel } from '../../../features/customer/RateDriverPanel';
import { TripCodePanel } from '../../../features/customer/TripCodePanel';
import { TripMapPanel } from '../../../features/customer/TripMapPanel';
import { useLiveCustomerFix, useLiveDriverFix, usePublishCustomerLocation } from '../../../features/customer/liveLocation';
import { useBookingDetail } from '../../../features/customer/queries';
import {
  addressLine,
  cancellationReasonLabel,
  dateTime,
  money,
  statusLabel,
  statusTone,
} from '../../../features/customer/labels';

/**
 * One trip, read as three documents the rules already allow the customer to
 * see: the booking, its trip summary, and the append-only event log.
 */
export default function TripDetail() {
  const theme = useTheme();
  const { bookingId } = useLocalSearchParams<{ bookingId: string }>();
  const detail = useBookingDetail(bookingId);
  const bookingForLocation = detail.data?.booking;
  const trackable = bookingForLocation?.assignedDriverUid !== null && bookingForLocation?.assignedDriverUid !== undefined &&
    ['driver_en_route', 'driver_arrived', 'trip_started', 'in_progress', 'destination_reached'].includes(bookingForLocation.status);
  const driverFix = useLiveDriverFix(bookingId, trackable);
  const tripStarted = Boolean(bookingForLocation && ['trip_started', 'in_progress', 'destination_reached'].includes(bookingForLocation.status));
  const customerFix = useLiveCustomerFix(bookingId, tripStarted);
  usePublishCustomerLocation(bookingId, tripStarted);

  if (detail.isPending) {
    return (
      <Screen>
        <StateView kind="loading" />
      </Screen>
    );
  }

  if (detail.isError) {
    return (
      <Screen>
        <StateView
          kind="permission_denied"
          title="This trip isn't available to you"
          message={
            'Firestore answers a booking lookup only for the customer and the driver on that trip. ' +
            (detail.error instanceof Error
              ? detail.error.message
              : 'Firestore denied the request.')
          }
        />
      </Screen>
    );
  }

  if (!detail.data) {
    return (
      <Screen>
        <StateView
          kind="empty"
          title="No such trip"
          message="The booking is gone, or it was deleted with the account."
        />
      </Screen>
    );
  }

  const { booking, summary, events } = detail.data;
  // Whichever number the server has most recently priced: the receipt once the
  // trip is closed, the running bill while the dial is moving, the map quote
  // before the car starts. Never an arithmetic the phone did itself.
  const fare = booking.finalFare ?? booking.runningFare ?? booking.estimate;
  const fareHeading = booking.finalFare
    ? 'Final fare'
    : booking.runningFare
      ? 'Fare so far'
      : 'Fare estimate';
  const drivenKm =
    booking.currentOdometerKm !== null && booking.startOdometerKm !== null
      ? booking.currentOdometerKm - booking.startOdometerKm
      : null;

  return (
    <Screen>
      <View style={{ gap: theme.spacing.lg }}>
        <ScreenHeader
          eyebrow={`Booking ${booking.reference}`}
          title="Your trip"
        />

        <Card style={{ gap: theme.spacing.xs }}>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: theme.spacing.md,
            }}
          >
            <Text variant="caption" tone="faint">
              {dateTime(booking.createdAtMs)}
            </Text>
            <StatusPill label={statusLabel(booking.status)} tone={statusTone(booking.status)} />
          </View>
          <Divider size="sm" />
          <View style={{ gap: theme.spacing.xxs }}>
            <Text variant="label" tone="muted">
              Pickup
            </Text>
            <Text variant="body">{addressLine(booking.pickup)}</Text>
          </View>
          <View style={{ gap: theme.spacing.xxs }}>
            <Text variant="label" tone="muted">
              Destination
            </Text>
            <Text variant="body">{addressLine(booking.destination)}</Text>
          </View>
          {booking.tripDirection === 'round_trip' ? (
            <Text variant="caption" tone="muted">
              Round trip — the driver comes back with you, so the fare is a package of hours.
            </Text>
          ) : null}
          {booking.etaMinutes !== null ? (
            <Text variant="caption" tone="muted">
              Driver estimated {booking.etaMinutes} min from the pickup point
            </Text>
          ) : null}
          {booking.status === 'cancelled' ? (
            <View style={{ gap: theme.spacing.xxs }}>
              <Text variant="label" tone="danger">
                Cancelled
                {cancellationReasonLabel(booking.cancellation.reasonCode)
                  ? ` — ${cancellationReasonLabel(booking.cancellation.reasonCode)}`
                  : ''}
              </Text>
              <Text variant="caption" tone="faint">
                {dateTime(booking.cancellation.atMs)} · by {booking.cancellation.by ?? 'DrivX'}
                {booking.cancellation.reasonText ? ` · ${booking.cancellation.reasonText}` : ''}
              </Text>
            </View>
          ) : null}
        </Card>

        {booking.assignedDriverUid ? (
          <TripMapPanel
            pickup={booking.pickup}
            destination={booking.destination}
            driverFix={driverFix}
            customerFix={customerFix}
            routePolyline={booking.routePolyline}
            title="Live driver map"
          />
        ) : null}

        <View style={{ gap: theme.spacing.sm }}>
          {booking.driver ? (
            <DriverCardPanel driver={booking.driver} />
          ) : booking.assignedDriverUid ? (
            <Card tone="inset">
              <Text variant="caption" tone="muted">
                A driver is on this trip. Their name, number and photo appear here the moment
                DrivX publishes them.
              </Text>
            </Card>
          ) : null}

          <CancelTripAction
            bookingId={booking.id}
            status={booking.status}
            hasDriver={booking.assignedDriverUid !== null}
          />
          <TripCodePanel bookingId={booking.id} status={booking.status} />
        </View>

        {fare ? (
          <Card style={{ gap: theme.spacing.sm }}>
            <Text variant="subheading" tone="brand">
              {fareHeading}
            </Text>
            {drivenKm !== null ? (
              <View style={{ gap: theme.spacing.xxs }}>
                <Text variant="fare" tone="brand">
                  {money(fare.totalPaise)}
                </Text>
                <Text variant="caption" tone="muted">
                  {booking.currentOdometerKm} km on the dial, from {booking.startOdometerKm} km at
                  pickup — {drivenKm} km driven
                </Text>
              </View>
            ) : null}
            {fare.items.map((item) => (
              <View
                key={item.key}
                style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.md }}
              >
                <View style={{ flex: 1, gap: theme.spacing.xxs }}>
                  <Text variant="caption">{item.label}</Text>
                  {item.detail ? (
                    <Text variant="caption" tone="faint">
                      {item.detail}
                    </Text>
                  ) : null}
                </View>
                <Text variant="caption" tone="muted">
                  {money(item.amountPaise)}
                </Text>
              </View>
            ))}
            <SummaryLine label="Subtotal" amountPaise={fare.subtotalPaise} />
            <SummaryLine label="tax" amountPaise={fare.taxPaise} />
            <Divider size="sm" />
            <View
              style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', gap: theme.spacing.md }}
            >
              <Text variant="label" tone="muted">
                Total
              </Text>
              <Text variant="fare" tone="brand">
                {money(fare.totalPaise)}
              </Text>
            </View>
            <Text variant="caption" tone="faint">
              {fareHeading} priced {dateTime(fare.generatedAtMs)}
            </Text>
            {booking.status === 'completed' ? (
              <Text variant="caption" tone="muted">
                {booking.paymentStatus === 'cash_collected'
                  ? 'Cash fare recorded as collected by your driver when you shared the trip end code. DrivX did not charge your card or wallet.'
                  : 'Pay the driver directly in cash. DrivX does not collect the trip fare online.'}
              </Text>
            ) : null}
            {booking.finalFare ? null : booking.runningFare ? (
              <Text variant="caption" tone="warning">
                This is what the trip has cost up to now, off the driver&apos;s odometer readings.
                The final bill is set when the trip is closed with your end code.
              </Text>
            ) : (
              <Text variant="caption" tone="warning">
                This is an estimate, not a receipt.
              </Text>
            )}
          </Card>
        ) : (
          <StateView
            kind="empty"
            title="No fare on this booking"
            message="No fare has been calculated for this trip yet."
          />
        )}

        {summary ? (
          <Card style={{ gap: theme.spacing.xs }}>
            <Text variant="subheading" tone="brand">
              Trip record
            </Text>
            <Text variant="caption" tone="muted">
              {summary.actualDistanceMeters === null
                ? 'Distance not read from the dial'
                : `${(summary.actualDistanceMeters / 1000).toFixed(1)} km driven`}{' '}
              · Duration {summary.durationSeconds !== null ? `${Math.round(summary.durationSeconds / 60)} min` : 'not finished'}
            </Text>
            {summary.startOdometerKm !== null && summary.endOdometerKm !== null ? (
              <Text variant="caption" tone="muted">
                Dial {summary.startOdometerKm} km at pickup to {summary.endOdometerKm} km at the drop
                {summary.quotedDistanceMeters !== null
                  ? `, against the ${(summary.quotedDistanceMeters / 1000).toFixed(1)} km the trip was priced on`
                  : ''}
                .
              </Text>
            ) : null}
            <Text variant="caption" tone="faint">
              Started {dateTime(summary.startedAtMs)} · completed {dateTime(summary.completedAtMs)}
            </Text>
          </Card>
        ) : null}

        {booking.status === 'completed' ? (
          <RateDriverPanel
            bookingId={booking.id}
            driverName={booking.driver?.fullName ?? null}
            customerRating={booking.customerRating}
          />
        ) : null}

        <Card style={{ gap: theme.spacing.sm }}>
          <Text variant="subheading" tone="brand">
            What happened
          </Text>
          {events.length === 0 ? (
            <Text variant="caption" tone="muted">
              No events recorded yet.
            </Text>
          ) : (
            events.map((event) => (
              <View key={event.id} style={{ gap: theme.spacing.xxs }}>
                <Text variant="caption">{event.type.replace(/_/g, ' ')}</Text>
                <Text variant="caption" tone="faint">
                  {dateTime(event.atMs)}
                  {event.fromStatus && event.toStatus
                    ? ` · ${event.fromStatus} → ${event.toStatus}`
                    : ''}
                </Text>
              </View>
            ))
          )}
          <Text variant="caption" tone="faint">
            DrivX records these as the trip happens. Neither app can change them.
          </Text>
        </Card>
      </View>
    </Screen>
  );
}

/**
 * A fare line the breakdown carries outside `items` — the subtotal and the tax.
 * They are rendered because `totalPaise` is `subtotal + tax` while the listed
 * items sum only to the subtotal: without these two rows the receipt on screen
 * does not add up, which is the one thing a fare breakdown exists to avoid.
 */
function SummaryLine({ label, amountPaise }: { label: string; amountPaise: number }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.md }}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="caption" tone="muted">
        {money(amountPaise)}
      </Text>
    </View>
  );
}
