import { useState } from 'react';
import { Linking, View } from 'react-native';
import { router } from 'expo-router';
import {
  Button,
  Card,
  Field,
  Screen,
  ScreenHeader,
  StateView,
  StatusPill,
  Text,
  useTheme,
} from '@drivx/ui';
import type { FareBreakdown } from '@drivx/domain';
import {
  useDriverTrip,
  useEndTrip,
  useStartTrip,
  useStartTripApproach,
  type DriverTripView,
} from '../../features/driver/trip-control';
import { addressLine, dateTime, money, statusLabel, statusTone } from '../../features/customer/labels';
import { BrandMark } from '../../components/BrandMark';
import { TripMapPanel } from '../../features/customer/TripMapPanel';
import { TripTrackingShare } from '../../features/customer/TripTrackingShare';
import { useLiveCustomerFix, useLiveDriverFix } from '../../features/customer/liveLocation';

/**
 * The trip the driver is carrying, in the order it actually happens: take the
 * customer's start code and the dial at pickup, then take the end code and the
 * dial at drop-off. The bill is priced from those two readings.
 *
 * Nothing on this screen computes money. The rupees shown while the trip runs are
 * the breakdown the server wrote on the booking, the same one the customer's app
 * renders, so the two cannot disagree at the end of the trip. The readings are
 * typed, and the server is the one that decides whether a reading is possible.
 */
export default function DriverTrip() {
  const theme = useTheme();
  const trip = useDriverTrip();
  const driverFix = useLiveDriverFix(trip.data?.id, Boolean(trip.data));
  const customerFix = useLiveCustomerFix(trip.data?.id, Boolean(trip.data?.startOdometerKm !== null && trip.data?.startOdometerKm !== undefined));

  if (trip.isPending) {
    return (
      <Screen>
        <StateView kind="loading" />
      </Screen>
    );
  }

  if (trip.isError) {
    return (
      <Screen>
        <StateView
          kind="permission_denied"
          title="Your trip could not be read"
          message={
            'A driver may read only the booking assigned to them. ' +
            (trip.error instanceof Error ? trip.error.message : 'Firestore denied the request.')
          }
        />
      </Screen>
    );
  }

  const view = trip.data;

  if (!view) {
    return (
      <Screen>
        <ScreenHeader eyebrow="Duty" title="No trip on your account" />
        <StateView
          kind="empty"
          title="Nothing to drive right now"
          message="When a booking is handed to you it opens here with the code to enter and the dial to read."
          alternateLabel="Back to Duty"
          onAlternate={() => router.replace('/(driver)')}
        />
      </Screen>
    );
  }

  const started = view.startOdometerKm !== null;

  return (
    <Screen>
      <View style={{ gap: theme.spacing.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
          <BrandMark />
          <View style={{ flex: 1, minWidth: 0 }}>
            <ScreenHeader eyebrow={`Booking ${view.reference}`} title="Your trip" />
          </View>
          <StatusPill label={statusLabel(view.status)} tone={statusTone(view.status)} />
        </View>

        <Card tone="flat" style={{ gap: theme.spacing.xs }}>
          <View style={{ gap: theme.spacing.xxs }}>
            <Text variant="label" tone="muted">
              Pickup
            </Text>
            <Text variant="body">{addressLine(view.pickup)}</Text>
          </View>
          <View style={{ gap: theme.spacing.xxs }}>
            <Text variant="label" tone="muted">
              Drop
            </Text>
            <Text variant="body">{addressLine(view.destination)}</Text>
          </View>
          {view.scheduledForMs ? (
            <Text variant="caption" tone="faint">
              Booked for {dateTime(view.scheduledForMs)}
            </Text>
          ) : null}
          {view.tripDirection === 'round_trip' ? (
            <Text variant="caption" tone="muted">
              Round trip — you come back with the customer, so the fare is the package of hours.
            </Text>
          ) : null}
          {view.serviceTypeId === 'chauffeur_outstation' ? (
            <Text variant="caption" tone="muted">
              Outstation trip: the customer arranges your meals during the trip.
            </Text>
          ) : null}
        </Card>

        {!started && view.estimate ? (
          <Card tone="inset" style={{ gap: theme.spacing.sm }}>
            <View style={{ gap: theme.spacing.xxs }}>
              <Text variant="overline" tone="brand">CUSTOMER QUOTE</Text>
              <Text variant="fare" tone="brand">{money(view.estimate.totalPaise)}</Text>
              {view.estimatedDistanceMeters !== null ? (
                <Text variant="caption" tone="muted">
                  Estimated route · {(view.estimatedDistanceMeters / 1000).toFixed(1)} km
                  {view.estimatedDurationSeconds !== null
                    ? ` · ${Math.round(view.estimatedDurationSeconds / 60)} min`
                    : ''}
                </Text>
              ) : null}
            </View>
            <FareLines fare={view.estimate} />
            <Text variant="caption" tone="warning">
              Estimate only. The final fare is priced from your opening and closing odometer readings.
            </Text>
          </Card>
        ) : null}

        <Card style={{ gap: theme.spacing.sm }}>
          <Text variant="overline" tone="brand">Customer contact</Text>
          <Text variant="subheading">{view.customerContact?.fullName ?? 'DrivX customer'}</Text>
          {view.customerContact?.phoneE164 ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing.md }}>
              <Text variant="bodyStrong">{view.customerContact.phoneE164}</Text>
              <Button
                label="Call customer"
                appearance="secondary"
                size="sm"
                onPress={() => void Linking.openURL(`tel:${view.customerContact!.phoneE164}`)}
              />
            </View>
          ) : (
            <Text variant="caption" tone="warning">Customer phone number is unavailable. Contact DrivX support.</Text>
          )}
        </Card>

        <TripMapPanel
          pickup={view.pickup}
          destination={view.destination}
          driverFix={driverFix}
          customerFix={customerFix}
          routeMode={['assigned', 'driver_en_route'].includes(view.status) ? 'pickup' : 'trip'}
          routePolyline={driverFix && driverFix.etaTarget === (['assigned', 'driver_en_route'].includes(view.status) ? 'pickup' : 'destination')
            ? driverFix.routePolyline
            : view.status === 'driver_en_route' ? view.pickupRoutePolyline : view.status === 'assigned' ? null : view.routePolyline}
          driverTitle="Your live location"
          title="Pickup and drop-off"
        />
        {driverFix ? <Card tone="inset" style={{ gap: theme.spacing.xxs }}>
          <Text variant="bodyStrong" tone="brand">Your location is sharing for this trip</Text>
          <Text variant="caption" tone="muted">{driverFix.stale ? 'GPS update is delayed' : 'Live location updated'} · {dateTime(driverFix.receivedAtMs)}</Text>
          {driverFix.etaMinutes != null && driverFix.etaTarget ? <Text variant="caption" tone="muted">
            {driverFix.etaDistanceMeters != null ? `${(driverFix.etaDistanceMeters / 1000).toFixed(1)} km · ` : ''}{driverFix.etaMinutes} min to {driverFix.etaTarget === 'pickup' ? 'pickup' : 'drop'}
          </Text> : null}
        </Card> : null}

        {started ? <TripTrackingShare bookingId={view.id} /> : null}

        {!started ? <StartForm trip={view} /> : null}

        {started ? <CloseForm trip={view} /> : null}

        <Card tone="inset">
          <Text variant="caption" tone="faint">
            DrivX prices this trip from the two readings you report, on the rate card the booking was
            quoted against. Your app cannot change a fare, a status or a code.
          </Text>
        </Card>
      </View>
    </Screen>
  );
}

/** The code the customer read out, and the dial standing at pickup. */
function StartForm({ trip }: { trip: DriverTripView }) {
  const theme = useTheme();
  const start = useStartTrip();
  const approach = useStartTripApproach();
  const [code, setCode] = useState('');
  const [km, setKm] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const pickupLocation = trip.pickup?.location ?? null;

  const submit = () => {
    const reading = Number(km);
    if (!/^\d{4,6}$/.test(code)) {
      setNotice('Enter the digits the customer is reading you.');
      return;
    }
    if (!/^\d+$/.test(km) || !Number.isInteger(reading)) {
      setNotice('Enter the odometer reading in whole kilometres.');
      return;
    }
    setNotice(null);
    void start.mutateAsync({ bookingId: trip.id, code, odometerKm: reading }).then((outcome) => {
      if (!outcome.ok) setNotice(outcome.message);
      else setNotice(`Trip started at ${outcome.result.startOdometerKm} km. The meter is running.`);
    });
  };

  return (
    <Card style={{ gap: theme.spacing.sm }}>
      {trip.status === 'assigned' || trip.status === 'driver_en_route' ? (
        <>
          <Text variant="subheading" tone="brand">On the way to pickup</Text>
          <Text variant="caption" tone="muted">Tell the customer when you begin travelling. They will get an in-app update and push notification if enabled. Enter the start OTP only when you have reached the pickup and are ready to begin the metered trip.</Text>
          {trip.status === 'driver_en_route' && trip.pickupEtaMinutes !== null ? (
            <Text variant="bodyStrong" tone="brand">
              Pickup ETA · {trip.pickupDistanceMeters !== null ? `${(trip.pickupDistanceMeters / 1000).toFixed(1)} km · ` : ''}{trip.pickupEtaMinutes} min
            </Text>
          ) : null}
          {pickupLocation ? (
            <Button
              label="Navigate to pickup"
              appearance="secondary"
              fullWidth
              onPress={() => {
                const { lat, lng } = pickupLocation;
                const destination = `${lat},${lng}`;
                const url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving`;
                void Linking.openURL(url).catch(() => setNotice('Could not open Maps. Check that a maps app is available.'));
              }}
            />
          ) : null}
          <Button
            label={trip.status === 'driver_en_route' ? 'On the way · customer notified' : 'I’m on my way'}
            disabled={trip.status === 'driver_en_route'}
            loading={approach.isPending}
            appearance="secondary"
            fullWidth
            onPress={() => void approach.mutateAsync(trip.id).then((outcome) => {
              if (!outcome.ok) setNotice(outcome.message);
              else setNotice('Customer notified: you’re on the way to pickup.');
            })}
          />
        </>
      ) : null}
      <Text variant="subheading" tone="brand">
        Start the trip
      </Text>
      <Text variant="caption" tone="muted">
        Ask the customer for the start code in their app. It does not expire, and once it is used it
        cannot open the trip again.
      </Text>
      <Field
        label="Customer's start code"
        value={code}
        onChangeText={(next) => setCode(next.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad"
        autoComplete="off"
        inputMode="numeric"
        maxLength={6}
      />
      <Field
        label="Odometer at pickup (km)"
        value={km}
        onChangeText={(next) => setKm(next.replace(/[^\d]/g, '').slice(0, 7))}
        keyboardType="number-pad"
        inputMode="numeric"
        helper="Read it off the car now. The whole trip is metered from this number."
      />
      {notice ? (
        <Text variant="caption" tone={start.isPending || approach.isPending ? 'muted' : notice.startsWith('Customer notified') ? 'success' : 'danger'}>
          {notice}
        </Text>
      ) : null}
      <Button
        label="Start the trip"
        onPress={submit}
        loading={start.isPending}
        appearance="primary"
        fullWidth
      />
    </Card>
  );
}

/** The end code, the closing reading, and the bill that follows. */
function CloseForm({ trip }: { trip: DriverTripView }) {
  const theme = useTheme();
  const close = useEndTrip();
  const [code, setCode] = useState('');
  const [km, setKm] = useState('');
  const [outcome, setOutcome] = useState<null | string | { fare: FareBreakdown; remittancePaise: number | null }>(
    null,
  );

  if (outcome && typeof outcome !== 'string') {
    return (
      <Card style={{ gap: theme.spacing.xs }}>
        <Text variant="subheading" tone="brand">
          Trip closed
        </Text>
        <Text variant="fare" tone="brand">
          {money(outcome.fare.totalPaise)}
        </Text>
        <Text variant="caption" tone="muted">
          {outcome.fare.items.map((item) => `${item.label} ${money(item.amountPaise)}`).join(' · ')}
        </Text>
        <Text variant="caption" tone="faint">
          Subtotal {money(outcome.fare.subtotalPaise)} · tax {money(outcome.fare.taxPaise)}
        </Text>
        {outcome.remittancePaise !== null ? (
          <Text variant="caption" tone="warning">
            Your full remittance for this trip is {money(outcome.remittancePaise)}, and it is on your dues
            until it is paid.
          </Text>
        ) : null}
        <Button
          label="Back to Duty"
          onPress={() => router.replace('/(driver)')}
          appearance="primary"
          size="sm"
          style={{ marginTop: theme.spacing.sm }}
        />
      </Card>
    );
  }

  const submit = () => {
    const reading = Number(km);
    if (!/^\d{4,6}$/.test(code)) {
      setOutcome('Enter the end code the customer is reading you.');
      return;
    }
    if (!/^\d+$/.test(km) || !Number.isInteger(reading)) {
      setOutcome('Enter the closing odometer reading in whole kilometres.');
      return;
    }
    setOutcome(null);
    void close.mutateAsync({ bookingId: trip.id, code, odometerKm: reading }).then((result) => {
      if (!result.ok) {
        setOutcome(result.message);
        return;
      }
      setKm('');
      setCode('');
      setOutcome({
        fare: result.result.finalFare,
        remittancePaise: result.result.remittancePaise,
      });
    });
  };

  return (
    <Card style={{ gap: theme.spacing.sm }}>
      <Text variant="subheading" tone="brand">
        Close the trip
      </Text>
      <Text variant="caption" tone="muted">
        Collect the final fare in cash from the customer first. Then ask for their end code and read
        the dial one last time. Closing records the cash fare and prices the trip between those two
        odometer readings.
      </Text>
      <Field
        label="Customer's end code"
        value={code}
        onChangeText={(next) => setCode(next.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad"
        inputMode="numeric"
        maxLength={6}
      />
      <Field
        label="Odometer at the drop (km)"
        value={km}
        onChangeText={(next) => setKm(next.replace(/[^\d]/g, '').slice(0, 7))}
        keyboardType="number-pad"
        inputMode="numeric"
        helper={`Opened at ${trip.startOdometerKm} km. The final fare uses this and the drop-off reading.`}
      />
      {typeof outcome === 'string' ? (
        <Text variant="caption" tone="danger">
          {outcome}
        </Text>
      ) : null}
      <Button
        label="Close the trip and bill it"
        onPress={submit}
        loading={close.isPending}
        appearance="primary"
        fullWidth
      />
    </Card>
  );
}

/** The server's own lines, item by item, exactly as the breakdown carries them. */
function FareLines({ fare, onBrand = false }: { fare: FareBreakdown; onBrand?: boolean }) {
  const theme = useTheme();
  const tone = onBrand ? 'onBrand' : 'muted';
  return (
    <View style={{ gap: theme.spacing.xxs }}>
      {fare.items.map((item) => (
        <View key={item.key} style={{ gap: 2 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.md }}>
            <Text variant="caption" tone={tone}>{item.label}</Text>
            <Text variant="caption" tone={tone}>{money(item.amountPaise)}</Text>
          </View>
          {item.detail ? (
            <Text variant="caption" tone={onBrand ? 'onBrand' : 'faint'}>{item.detail}</Text>
          ) : null}
        </View>
      ))}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.md }}>
        <Text variant="caption" tone={tone}>
          Subtotal
        </Text>
        <Text variant="caption" tone={tone}>
          {money(fare.subtotalPaise)}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.md }}>
        <Text variant="caption" tone={tone}>
          tax
        </Text>
        <Text variant="caption" tone={tone}>
          {money(fare.taxPaise)}
        </Text>
      </View>
    </View>
  );
}
