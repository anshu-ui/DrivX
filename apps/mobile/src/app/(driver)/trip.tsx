import { useState } from 'react';
import { View } from 'react-native';
import { Linking } from 'react-native';
import { router } from 'expo-router';
import {
  Button,
  Card,
  Field,
  Screen,
  ScreenHeader,
  StateView,
  StatusPill,
  Tag,
  Text,
  useTheme,
} from '@drivx/ui';
import type { FareBreakdown } from '@drivx/domain';
import {
  useDriverTrip,
  useEndTrip,
  usePostReading,
  useStartTrip,
  useStartTripApproach,
  type DriverTripView,
} from '../../features/driver/trip-control';
import { addressLine, dateTime, money, statusLabel, statusTone } from '../../features/customer/labels';
import { BrandMark } from '../../components/BrandMark';
import { TripMapPanel } from '../../features/customer/TripMapPanel';
import { useLiveCustomerFix, useLiveDriverFix } from '../../features/customer/liveLocation';

/**
 * The trip the driver is carrying, in the order it actually happens: take the
 * customer's start code and the dial at pickup, post readings as the car moves,
 * then take the end code and the closing reading, and the bill is priced from the
 * two.
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
          {!started && view.estimate ? (
            <Text variant="caption" tone="faint">
              The map quoted {money(view.estimate.totalPaise)} for this route. The bill is priced from
              your dial, not from that number.
            </Text>
          ) : null}
        </Card>

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
          routePolyline={view.routePolyline}
          driverTitle="Your live location"
          title="Pickup and drop-off"
        />

        {started ? <LiveMeter trip={view} /> : <StartForm trip={view} />}

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

/**
 * What the car has run and what it costs so far.
 *
 * Both figures come off the booking document, which the server writes — so this
 * panel and the customer's screen show the same number at the same moment, and a
 * posting that failed never leaves a bigger fare on the driver's side.
 */
function LiveMeter({ trip }: { trip: DriverTripView }) {
  const theme = useTheme();
  const post = usePostReading();
  const [km, setKm] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const fare = trip.runningFare;
  const driven =
    trip.currentOdometerKm !== null && trip.startOdometerKm !== null
      ? trip.currentOdometerKm - trip.startOdometerKm
      : null;

  const submit = () => {
    const reading = Number(km);
    if (!/^\d+$/.test(km) || !Number.isInteger(reading)) {
      setNotice('Enter the odometer reading in whole kilometres.');
      return;
    }
    setNotice(null);
    void post.mutateAsync({ bookingId: trip.id, odometerKm: reading }).then((outcome) => {
      if (!outcome.ok) {
        setNotice(outcome.message);
        return;
      }
      setKm('');
      setNotice(
        `Posted ${outcome.result.currentOdometerKm} km — ${money(outcome.result.runningFare.totalPaise)} so far.`,
      );
    });
  };

  return (
    <Card tone="brand" style={{ gap: theme.spacing.sm }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: theme.spacing.md }}>
        <View style={{ gap: theme.spacing.xxs }}>
          <Text variant="caption" tone="onBrand">
            Fare so far
          </Text>
          <Text variant="fare" tone="onBrand">
            {fare ? money(fare.totalPaise) : '—'}
          </Text>
        </View>
        <Tag label={`${driven ?? 0} km`} tone="onBrand" />
      </View>
      <Text variant="caption" tone="onBrand">
        {trip.currentOdometerKm !== null
          ? `Dial at ${trip.currentOdometerKm} km, opened at ${trip.startOdometerKm} km`
          : 'No reading posted yet'}
        {trip.tripStartedAtMs ? ` · started ${dateTime(trip.tripStartedAtMs)}` : ''}
      </Text>
      {fare ? <FareLines fare={fare} onBrand /> : null}

      <View style={{ gap: theme.spacing.xs }}>
        <Field
          label="Post the current reading (km)"
          value={km}
          onChangeText={(next) => setKm(next.replace(/[^\d]/g, '').slice(0, 7))}
          keyboardType="number-pad"
          inputMode="numeric"
          containerStyle={{ marginTop: theme.spacing.sm }}
          helper={
            trip.currentOdometerKm === null
              ? 'The reading on the dial right now.'
              : `Last posted: ${trip.currentOdometerKm} km. A reading below it is refused.`
          }
        />
        {notice ? (
          <Text variant="caption" tone="onBrand">
            {notice}
          </Text>
        ) : null}
        <Button
          label="Post reading"
          onPress={submit}
          loading={post.isPending}
          appearance="secondary"
          fullWidth
        />
      </View>
    </Card>
  );
}

/** The end code, the closing reading, and the bill that follows. */
function CloseForm({ trip }: { trip: DriverTripView }) {
  const theme = useTheme();
  const close = useEndTrip();
  const [code, setCode] = useState('');
  const [km, setKm] = useState('');
  const [outcome, setOutcome] = useState<null | string | { fare: FareBreakdown; commissionPaise: number | null }>(
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
        {outcome.commissionPaise !== null ? (
          <Text variant="caption" tone="warning">
            DrivX&apos;s share of this trip is {money(outcome.commissionPaise)}, and it is on your dues
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
        commissionPaise: result.result.commissionPaise,
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
        helper={
          trip.currentOdometerKm === null
            ? `Opened at ${trip.startOdometerKm} km.`
            : `Opened at ${trip.startOdometerKm} km, last posted ${trip.currentOdometerKm} km.`
        }
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
        <View
          key={item.key}
          style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.md }}
        >
          <Text variant="caption" tone={tone}>
            {item.label}
          </Text>
          <Text variant="caption" tone={tone}>
            {money(item.amountPaise)}
          </Text>
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
