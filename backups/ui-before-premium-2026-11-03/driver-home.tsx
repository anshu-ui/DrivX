import { useEffect, useRef, useState } from 'react';
import { Animated, View } from 'react-native';
import { router } from 'expo-router';
import { Button, Card, Screen, ScreenHeader, StateView, StatusPill, Text, useTheme } from '@drivx/ui';
import { DUTY_TERMS, formatINR } from '@drivx/domain';
import { useSession } from '../../features/auth/AuthProvider';
import {
  ACCESS_COPY,
  describeOutstandingFee,
  useDriverAccess,
  useDriverDues,
  useDriverProfile,
} from '../../features/driver/profile';
import { useDriverTrip } from '../../features/driver/trip-control';
import { useDrivenTrips } from '../../features/driver/trips';
import { money, statusLabel } from '../../features/customer/labels';
import { payDriverDue } from '../../features/driver/payments';
import { RequireApproval } from '../../components/RequireApproval';
import { BrandMark } from '../../components/BrandMark';
import { SurfaceSwitch } from '../../components/SurfaceSwitch';
import {
  driverDispatchError,
  useAcceptDutyTerms,
  useDriverOffers,
  usePublishDriverLocation,
  useRespondToDriverOffer,
  useSetDriverAvailability,
} from '../../features/driver/dispatch';

/**
 * Driver duty screen: current agreement, location-backed availability, live
 * offers, active trip and money hold all meet here.
 *
 * The money hold is named here too, because this is the screen a driver opens
 * expecting work: an unpaid row means `respondToAssignment` and going online are
 * refused server-side, and a silent refusal is indistinguishable from a quiet
 * market.
 */
export default function DriverHome() {
  const theme = useTheme();
  const entrance = useRef(new Animated.Value(0)).current;
  const livePulse = useRef(new Animated.Value(0.45)).current;
  const { user } = useSession();
  const access = useDriverAccess();
  const { profile } = useDriverProfile();
  const dues = useDriverDues();
  const trips = useDrivenTrips();
  const trip = useDriverTrip();
  const offers = useDriverOffers();
  const acceptTerms = useAcceptDutyTerms();
  const availabilityMutation = useSetDriverAvailability();
  const respond = useRespondToDriverOffer();
  const status = ACCESS_COPY[access.status] ?? ACCESS_COPY.unknown!;
  const [paying, setPaying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  useEffect(() => {
    Animated.timing(entrance, { toValue: 1, duration: 320, useNativeDriver: true }).start();
  }, [entrance]);
  const dutyTermsAccepted = profile?.dutyTermsVersion === DUTY_TERMS.version;
  const online = profile?.availabilityState === 'online';
  useEffect(() => {
    if (!online) {
      livePulse.setValue(0.45);
      return;
    }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(livePulse, { toValue: 1, duration: 850, useNativeDriver: true }),
      Animated.timing(livePulse, { toValue: 0.45, duration: 850, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [livePulse, online]);
  usePublishDriverLocation(online, trip.data?.id ?? null);
  const oldestUnpaid = dues.rows.find((row) => row.status === 'unpaid') ?? null;

  const rows = trips.data ?? [];
  const priced = rows.filter((row) => row.split !== null);
  const keptPaise = priced.reduce((sum, row) => sum + row.split!.netPaise, 0);
  const unpriced = rows.length - priced.length;

  // New and pending drivers must see application steps on the first screen.
  // Hiding this card below unusable duty controls made document upload look
  // absent unless someone scrolled through the rest of the dashboard.
  if (!access.loading && access.status !== 'approved') {
    return (
      <Screen>
        <View style={{ gap: theme.spacing.lg }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
            <BrandMark />
            <View style={{ flex: 1, minWidth: 0 }}>
              <ScreenHeader title="Driver application" />
            </View>
          </View>
          <Card tone="brand" style={{ gap: theme.spacing.sm }}>
            <Text variant="caption" tone="onBrand">WELCOME TO DRIVX</Text>
            <Text variant="heading" tone="onBrand">Finish your driver setup</Text>
            <Text variant="caption" tone="onBrand">
              Add your photo, ID and driving licence, pay the one-time onboarding fee, then the Admin team reviews your application. Your driver ID and bookings activate after approval.
            </Text>
          </Card>
          <RequireApproval>
            <StateView kind="unavailable" title="Application not ready" message="Refresh this screen after your account is approved." />
          </RequireApproval>
          <Button
            label="Open document checklist"
            onPress={() => router.push('/(driver)/documents')}
            fullWidth
          />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Animated.View style={{ gap: theme.spacing.md, opacity: entrance, transform: [{ translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
          <BrandMark />
          <View style={{ flex: 1, minWidth: 0 }}>
            <ScreenHeader title="Duty" />
          </View>
        </View>

        <Card tone="brand" style={{ gap: theme.spacing.md }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: theme.spacing.md }}>
            <View style={{ flex: 1, gap: theme.spacing.xxs }}>
              <Text variant="caption" tone="onBrand">DRIVER DASHBOARD</Text>
              <Text variant="heading" tone="onBrand" numberOfLines={1}>{profile?.fullName ?? status.label}</Text>
              <Text variant="caption" tone="onBrand">{profile?.driverId ? `Driver ID ${profile.driverId}` : user?.phoneNumber ?? 'Phone number unavailable'}</Text>
            </View>
            <StatusPill label={status.label} tone={status.tone} />
          </View>
          <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
            <View style={{ flex: 1, borderRadius: theme.radius.md, backgroundColor: theme.colors.surface, padding: theme.spacing.sm }}>
              <Text variant="caption" tone="muted">Rating</Text>
              <Text variant="subheading" tone="brand">{profile?.ratingCount ? `${profile.ratingAverage.toFixed(2)} ★` : '—'}</Text>
              <Text variant="caption" tone="faint">{profile?.ratingCount ? `${profile.ratingCount} reviews` : 'No reviews yet'}</Text>
            </View>
            <View style={{ flex: 1, borderRadius: theme.radius.md, backgroundColor: theme.colors.surface, padding: theme.spacing.sm }}>
              <Text variant="caption" tone="muted">Completed trips</Text>
              <Text variant="subheading" tone="brand">{profile?.lifetimeTrips ?? 0}</Text>
              <Text variant="caption" tone="faint">Since joining DrivX</Text>
            </View>
            <View style={{ flex: 1, borderRadius: theme.radius.md, backgroundColor: theme.colors.surface, padding: theme.spacing.sm }}>
              <Text variant="caption" tone="muted">Commission rate</Text>
              <Text variant="subheading" tone="brand">{priced[0] ? `${Math.round(priced[0].split!.rate * 100)}%` : '—'}</Text>
              <Text variant="caption" tone="faint">{priced.length ? 'Latest completed trip' : 'Shown after first trip'}</Text>
            </View>
          </View>
        </Card>

        <Card style={{ gap: theme.spacing.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing.md }}>
            <View style={{ flex: 1, gap: theme.spacing.xxs }}>
              <Text variant="subheading" tone="default">Your duty status</Text>
              <Text variant="caption" tone="muted">Go online when you’re ready to receive a trip offer.</Text>
            </View>
            <StatusPill
              label={profile?.availabilityState?.replace(/_/g, ' ') ?? 'offline'}
              tone={online ? 'success' : profile?.availabilityState === 'on_assignment' ? 'info' : 'neutral'}
            />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs, borderRadius: theme.radius.md, backgroundColor: online ? '#EFF6FF' : theme.colors.surfaceMuted, paddingHorizontal: theme.spacing.sm, paddingVertical: theme.spacing.xs }}>
            <Animated.View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: online ? '#2563EB' : '#94A3B8', opacity: online ? livePulse : 1, transform: [{ scale: online ? livePulse.interpolate({ inputRange: [0.45, 1], outputRange: [0.85, 1.25] }) : 1 }] }} />
            <Text variant="caption" tone={online ? 'brand' : 'muted'}>
              {online ? `${offers.data?.length ?? 0} trip offers · live refresh` : 'Offers appear here when you go online'}
            </Text>
          </View>
        </Card>

        {!dutyTermsAccepted ? (
          <Card style={{ gap: theme.spacing.sm }}>
            <Text variant="subheading" tone="brand">{DUTY_TERMS.title}</Text>
            {DUTY_TERMS.lines.map((line, index) => (
              <Text key={index} variant="caption" tone="muted">{index + 1}. {line}</Text>
            ))}
            <Button
              label="I have read and agree · Go online"
              onPress={() => {
                setDispatchError(null);
                void (async () => {
                  await acceptTerms.mutateAsync();
                  if (dues.outstandingPaise > 0) {
                    setDispatchError('Your duty terms are saved. Clear the outstanding balance before going online.');
                    return;
                  }
                  await availabilityMutation.mutateAsync('online');
                })().catch((error) => setDispatchError(driverDispatchError(error)));
              }}
              loading={acceptTerms.isPending || availabilityMutation.isPending}
              disabled={dues.loading || dues.unreadable || Boolean(trip.data)}
              fullWidth
            />
            {dues.outstandingPaise > 0 ? (
              <Text variant="caption" tone="danger">Clear your outstanding balance before going online. Your agreement will remain saved once submitted.</Text>
            ) : null}
          </Card>
        ) : (
          <Card style={{ gap: theme.spacing.sm }}>
            <Text variant="subheading" tone="brand">Duty</Text>
            <Text variant="caption" tone="muted">
              Booking offers are sent to every eligible online driver, regardless of distance or work zone. Your live location is shared with the customer only after you accept a booking.
            </Text>
            <Text variant="caption" tone="muted">
              Reach pickup by the scheduled time. After the configured grace period, any late-start penalty set by Admin is added to your dues. Admin can change the amount or set it to ₹0 to turn it off.
            </Text>
            <Button
              label={online ? 'Go offline' : 'Go online and receive trip offers'}
              onPress={() => {
                setDispatchError(null);
                void availabilityMutation
                  .mutateAsync(online ? 'offline' : 'online')
                  .catch((error) => setDispatchError(driverDispatchError(error)));
              }}
              loading={availabilityMutation.isPending}
              disabled={
                access.status !== 'approved' || dues.loading || dues.unreadable || dues.outstandingPaise > 0 || Boolean(trip.data)
              }
              fullWidth
            />
            {trip.data ? (
              <Text variant="caption" tone="faint">Finish your current trip before changing availability.</Text>
            ) : null}
            {dispatchError ? (
              <Text variant="caption" tone="danger" accessibilityRole="alert">{dispatchError}</Text>
            ) : null}
          </Card>
        )}

        {dutyTermsAccepted && offers.data?.map((offer) => (
          <Card key={offer.id} tone="brand" style={{ gap: theme.spacing.sm }}>
            <Text variant="caption" tone="onBrand">New trip · {offer.bookingReference}</Text>
            <Text variant="bodyStrong" tone="onBrand">{offer.pickup} → {offer.destination}</Text>
            <Text variant="caption" tone="onBrand">
              Estimate {offer.farePaise === null ? 'unavailable' : formatINR(offer.farePaise)} · {offer.distanceToPickupMeters === null ? 'nearby' : `${(offer.distanceToPickupMeters / 1000).toFixed(1)} km away`} · stays until accepted or declined
            </Text>
            <Text variant="caption" tone="onBrand">
              Vehicle · {offer.vehicleDescription ? `${offer.vehicleDescription} · ` : ''}{offer.carType === 'either' ? 'Type not specified' : offer.carType} · {offer.transmission === 'either' ? 'Transmission not specified' : offer.transmission}
            </Text>
            {offer.customerNotes ? (
              <View style={{ borderRadius: theme.radius.md, backgroundColor: theme.colors.surface, padding: theme.spacing.sm }}>
                <Text variant="caption" tone="brand">Customer note</Text>
                <Text variant="body" tone="default">{offer.customerNotes}</Text>
              </View>
            ) : null}
            <Text variant="caption" tone="onBrand">The final bill uses the odometer readings at pickup and drop-off.</Text>
            <View style={{ borderRadius: theme.radius.md, backgroundColor: '#FFFFFF', padding: theme.spacing.sm, gap: theme.spacing.xxs }}>
              <Text variant="caption" tone="brand">How your earnings work</Text>
              <Text variant="caption" tone="muted">This is the customer’s fare estimate. After the trip, the final fare is calculated from the odometer; the Admin-configured commission and tax are shown separately in your dues before you pay.</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
              <Button
                label="Accept"
                onPress={() => {
                  setDispatchError(null);
                  void respond.mutateAsync({ bookingId: offer.bookingId, decision: 'accept' }).catch((error) => setDispatchError(driverDispatchError(error)));
                }}
                loading={respond.isPending}
                fullWidth
              />
              <Button
                label="Decline"
                appearance="secondary"
                onPress={() => {
                  setDispatchError(null);
                  void respond.mutateAsync({ bookingId: offer.bookingId, decision: 'decline' }).catch((error) => setDispatchError(driverDispatchError(error)));
                }}
                loading={respond.isPending}
                fullWidth
              />
            </View>
          </Card>
        ))}
        {offers.isError ? (
          <Text variant="caption" tone="danger">Offers could not be refreshed: {offers.error instanceof Error ? offers.error.message : 'Check your connection.'}</Text>
        ) : null}

        <Card tone="brand" style={{ gap: theme.spacing.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.lg }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text variant="caption" tone="onBrand">
                Kept from completed trips
              </Text>
              <Text variant="fare" tone="onBrand">
                {trips.isPending || trips.isError ? '—' : formatINR(keptPaise)}
              </Text>
              <Text variant="caption" tone="onBrand">
                {trips.isPending
                  ? 'Reading your trips…'
                  : trips.isError
                    ? 'Your trips could not be read just now.'
                    : rows.length === 0
                      ? 'No trip has been closed on your account yet.'
                      : `${priced.length} trip${priced.length === 1 ? '' : 's'} closed after the commission${
                          unpriced > 0 ? `, ${unpriced} closed without a fare recorded` : ''
                        }.`}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: theme.spacing.xxs }}>
              <Text variant="caption" tone="onBrand">
                To clear
              </Text>
              <Text variant="subheading" tone="onBrand">
                {dues.loading || dues.unreadable ? '—' : formatINR(dues.outstandingPaise)}
              </Text>
            </View>
          </View>
          <Text variant="caption" tone="onBrand">
            {priced.length === 0
              ? 'DrivX keeps a share of every trip you close, plus tax on that share. The office sets the rate; each trip in Earnings shows the one it billed you at.'
              : `DrivX kept ${Math.round(priced[0]!.split!.rate * 100)}% of your last trip, plus ${Math.round(
                  priced[0]!.split!.gstRate * 100,
                )}% tax on that share. Earnings lists the same figure on every trip.`}
          </Text>
          {priced[0] ? (
            <View accessibilityLabel={`Latest trip split: DrivX commission ${Math.round(priced[0].split!.rate * 100)} percent; you kept ${formatINR(priced[0].split!.netPaise)}`}>
              <View style={{ height: 8, overflow: 'hidden', borderRadius: 999, flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.25)' }}>
                <View style={{ width: `${Math.max(0, Math.min(100, priced[0].split!.rate * 100))}%`, backgroundColor: theme.colors.surface }} />
                <View style={{ flex: 1, backgroundColor: theme.colors.primarySoft }} />
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: theme.spacing.xs }}>
                <Text variant="caption" tone="onBrand">DrivX · {Math.round(priced[0].split!.rate * 100)}% + applicable tax</Text>
                <Text variant="caption" tone="onBrand">Your net · {formatINR(priced[0].split!.netPaise)}</Text>
              </View>
            </View>
          ) : null}
          <Button
            label="See the breakdown per trip"
            onPress={() => router.push('/(driver)/earnings')}
            appearance="secondary"
            size="sm"
          />
        </Card>

        <RequireApproval>
          {trip.data ? (
            <Card tone="brand" style={{ gap: theme.spacing.xs }}>
              <View
                style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: theme.spacing.md }}
              >
                <View style={{ gap: theme.spacing.xxs, flex: 1, minWidth: 0 }}>
                  <Text variant="caption" tone="onBrand">
                    In hand
                  </Text>
                  <Text variant="heading" tone="onBrand">
                    {statusLabel(trip.data.status)}
                  </Text>
                  <Text variant="caption" tone="onBrand">
                    {trip.data.reference} ·{' '}
                    {trip.data.startOdometerKm === null
                      ? 'waiting for the customer’s start code and the reading at pickup'
                      : trip.data.currentOdometerKm === null
                        ? `opened at ${trip.data.startOdometerKm} km, no reading posted yet`
                        : `${trip.data.currentOdometerKm} km on the dial, ${money(
                            trip.data.runningFare?.totalPaise,
                          )} so far`}
                  </Text>
                </View>
              </View>
              <Button
                label={trip.data.startOdometerKm === null ? 'Start this trip' : 'Open the meter'}
                onPress={() => router.push('/(driver)/trip')}
                appearance="secondary"
                size="sm"
                fullWidth
              />
            </Card>
          ) : null}
          {dues.outstandingPaise > 0 || dues.unreadable ? (
            <Card tone="flat" style={{ gap: theme.spacing.xs }}>
              <Text variant="bodyStrong" tone="default">
                Bookings are held
              </Text>
              <Text variant="caption" tone="muted">
                {describeOutstandingFee(dues)}
              </Text>
              {oldestUnpaid ? (
                <>
                  <Button
                    label={`Pay ${formatINR(oldestUnpaid.totalPaise)} now`}
                    onPress={() => {
                      setNotice(null);
                      setPaying(true);
                      void payDriverDue(oldestUnpaid.id).then((result) => {
                        setPaying(false);
                        setNotice(
                          result.ok
                            ? `Cashfree is asking you for ${formatINR(result.amountPaise)} for ${oldestUnpaid.title}. Your bookings resume as soon as the gateway confirms it — this screen updates on its own.`
                            : result.message,
                        );
                      });
                    }}
                    loading={paying}
                    appearance="primary"
                    fullWidth
                  />
                  {notice ? (
                    <Text variant="caption" tone="muted">
                      {notice}
                    </Text>
                  ) : null}
                </>
              ) : null}
              <Text variant="caption" tone="muted">
                You can still hand it over at the office instead — the hold lifts as soon as they
                record the collection, no need to sign in again.
              </Text>
            </Card>
          ) : null}
          {!trip.data && offers.data?.length === 0 && online ? (
            <StateView kind="empty" title="You are online" message="Waiting for a booking offer. Distance and work zone do not limit dispatch." />
          ) : null}
        </RequireApproval>

        <SurfaceSwitch />
      </Animated.View>
    </Screen>
  );
}
