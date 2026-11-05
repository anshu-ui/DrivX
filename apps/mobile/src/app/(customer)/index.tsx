/**
 * The booking composer.
 *
 * Layout follows the reference screen the customer asked for: a brand bar, a
 * driver-versus-cab switch, a stack of thin-bordered cards on the left, and the
 * availability panel on the right. What is *inside* those cards comes from the
 * server, because the mockup's own numbers were invented in JavaScript — a base
 * fare of ₹249, a promo of ₹50 off, "32 drivers" and "42 mins" with no routing
 * behind them. Every control below is bound to a field the backend reads, and
 * the three places the mockup promised something this build does not have (a
 * wallet balance or coupon say so in the same slot they would otherwise have
 * shown a made-up value. The route preview uses the device map provider.
 */
import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, ScrollView, Share, TextInput, useWindowDimensions, View } from 'react-native';
import { router } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  Button,
  Card,
  Chip,
  Divider,
  Screen,
  SectionCard,
  SelectBox,
  SegmentedTabs,
  Sheet,
  StateView,
  StatusPill,
  Tag,
  Text,
  useTheme,
} from '@drivx/ui';
import {
  isQuoteExpired,
  type FareBreakdown,
  type CarType,
  type MoneyPaise,
  type Place,
  type ServiceTypeId,
  type TripDirection,
  type Transmission,
} from '@drivx/domain';
import { BrandBar } from '../../components/BrandBar';
import { MobileWelcomeHero } from '../../components/MobileWelcomeHero';
import { useSession } from '../../features/auth/AuthProvider';
import {
  useCustomerProfile,
  useSavedPlaces,
} from '../../features/customer/queries';
import { PlaceSearchPanel } from '../../features/customer/PlaceSearchPanel';
import { newIdempotencyKey, useCreateBooking } from '../../features/customer/mutations';
import { TripMapPanel } from '../../features/customer/TripMapPanel';
import { PricingSheet } from '../../features/customer/PricingPanel';
import {
  clockLabel,
  DEPARTURE_OPTIONS,
  departureAt,
  nextScheduleSlot,
  MIN_LEAD_MS,
  latestBookingDateMs,
  scheduledEpochMs,
  scheduleCalendarMonth,
  slotIsTooSoon,
  tripIdentity,
  upcomingDays,
  useBookingOptions,
  useEnabledServiceCatalogue,
  useFareQuote,
  useNowMs,
  type DepartureKey,
  type ScheduleSlot,
  type TripDraft,
} from '../../features/customer/booking';
import { dateTime, money } from '../../features/customer/labels';
import { callFunction } from '@drivx/firebase-client';
import { firebase } from '../../lib/firebase';

/** The 12-hour clock the customer reads, and the quarter-hour starts offered. */
const HOURS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const MINUTES = [0, 15, 30, 45];
const CAR_OPTIONS: { id: CarType; title: string }[] = [
  { id: 'hatchback', title: 'Hatchback' },
  { id: 'sedan', title: 'Sedan' },
  { id: 'suv', title: 'SUV' },
  { id: 'luxury', title: 'Luxury' },
  { id: 'ev', title: 'Electric' },
  { id: 'either', title: 'Other' },
];
const TRANSMISSION_OPTIONS: { id: Transmission; title: string }[] = [
  { id: 'manual', title: 'Manual' },
  { id: 'automatic', title: 'Automatic' },
  { id: 'either', title: 'No preference' },
];

/** One end of the trip, chosen from search, GPS or a saved place. */
type PickedEnd = { place: Place; name: string; key: string };

function initialsOf(name: string | null, phone: string | null): string {
  const fromName = (name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('');
  if (fromName) return fromName;
  return (phone ?? '').replace(/\D/g, '').slice(-2) || 'MS';
}

/** The small right-hand control inside a card header, drawn as text + glyph. */
function HeaderAction({
  label,
  icon,
  onPress,
  disabled = false,
}: {
  label: string;
  icon: 'swap-horizontal' | 'chevron-down' | 'chevron-up';
  onPress: () => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.xxs,
          opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
        },
      ]}
    >
      <Ionicons name={icon} size={15} color={theme.colors.primaryInk} />
      <Text variant="label" tone="primary">
        {label}
      </Text>
    </Pressable>
  );
}

/** A tiny bordered pill that sits at the right edge of an itinerary row. */
function Marker({ kind }: { kind: 'pickup' | 'dropoff' }) {
  const theme = useTheme();
  return (
    <View
      style={{
        width: 14,
        height: 14,
        borderRadius: kind === 'pickup' ? 7 : 4,
        backgroundColor: kind === 'pickup' ? theme.palette.brandBright : theme.colors.textBrand,
      }}
    />
  );
}

export default function CustomerHome() {
  const theme = useTheme();
  const entrance = useRef(new Animated.Value(0)).current;
  const { width } = useWindowDimensions();
  const wide = width >= 1080;
  const { user } = useSession();
  const profile = useCustomerProfile();
  const savedPlaces = useSavedPlaces();
  const options = useBookingOptions();
  const catalogue = useEnabledServiceCatalogue();
  const booking = useCreateBooking();
  const [rewardCheckout, setRewardCheckout] = useState<{ walletPaise: number; milesPoints: number; customerReferralCode: string | null } | null>(null);
  const [rewardsReload, setRewardsReload] = useState(0);
  const [rewardsLoadError, setRewardsLoadError] = useState(false);
  const [couponCode, setCouponCode] = useState('');
  const [couponPreview, setCouponPreview] = useState<{
    identity: string;
    couponCode: string;
    baseFarePaise: number;
    discountPaise: number;
    customerPayablePaise: number;
  } | null>(null);
  const [couponPreviewBusy, setCouponPreviewBusy] = useState(false);
  const [couponPreviewError, setCouponPreviewError] = useState<string | null>(null);
  const [useWallet, setUseWallet] = useState(false);
  const [useMiles, setUseMiles] = useState(false);

  useEffect(() => {
    let active = true;
    if (!user) {
      setRewardCheckout(null);
      setRewardsLoadError(false);
      return () => { active = false; };
    }
    setRewardCheckout(null);
    setRewardsLoadError(false);
    void callFunction<{ role: 'customer' }, { account: { walletPaise: number; milesPoints: number; customerReferralCode: string | null } }>(firebase(), 'getRewards', { role: 'customer' })
      .then((result) => { if (active) setRewardCheckout(result.account); })
      .catch(() => { if (active) { setRewardCheckout(null); setRewardsLoadError(true); } });
    return () => { active = false; };
  }, [user, rewardsReload]);

  useEffect(() => {
    Animated.timing(entrance, { toValue: 1, duration: 320, useNativeDriver: true }).start();
  }, [entrance]);

  const [serviceTypeId, setServiceTypeId] = useState<ServiceTypeId | null>(null);
  const [pickupId, setPickupId] = useState<string | null>(null);
  const [destinationId, setDestinationId] = useState<string | null>(null);
  /**
   * An address from search is not a saved place, so it cannot be stored as one.
   * These hold the resolved `Place` itself; the saved-place ids below stay the
   * fallback when the customer picks from their list instead.
   */
  const [pickupPicked, setPickupPicked] = useState<PickedEnd | null>(null);
  const [destinationPicked, setDestinationPicked] = useState<PickedEnd | null>(null);
  const [picking, setPicking] = useState<'pickup' | 'dropoff' | null>(null);
  const [openBox, setOpenBox] = useState<'start' | 'duration' | null>(null);
  const [departure, setDeparture] = useState<DepartureKey | 'slot'>('slot');
  const [calendarMonthOffset, setCalendarMonthOffset] = useState(0);
  /** The last hand-picked slot, kept so the panel reopens where the customer left it. */
  const [initialSchedule] = useState(() => {
    const now = Date.now();
    const slot = nextScheduleSlot(now);
    return { slot, scheduledForMs: scheduledEpochMs(slot, now) };
  });
  const [slot, setSlot] = useState<ScheduleSlot>(() => initialSchedule.slot);
  const [scheduledForMs, setScheduledForMs] = useState<number | null>(() => initialSchedule.scheduledForMs);
  const [tierId, setTierId] = useState<string | null>(null);
  const [direction, setDirection] = useState<TripDirection>('one_way');
  const [carType, setCarType] = useState<CarType>('either');
  const [transmission, setTransmission] = useState<Transmission>('either');
  const [vehicleDescription, setVehicleDescription] = useState('');
  const [showFareDetails, setShowFareDetails] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  // One key per booking *attempt*, kept across retries so a request that times
  // out and is sent again cannot become two bookings.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  const nowMs = useNowMs(20_000);
  const places = savedPlaces.data ?? [];
  const optionResult = options.data;
  const services = optionResult && !optionResult.failed ? optionResult.options.services : [];
  const unavailable = optionResult && !optionResult.failed ? optionResult.options.unavailable : [];
  const visibleServiceIds = services.length > 0
    ? services.map((row) => row.id)
    : (catalogue.data ?? []).map((row) => row.id);

  const service = services.find((row) => row.id === serviceTypeId) ?? services[0] ?? null;

  /**
   * A round trip is only on offer when the server has a price for one.
   * `roundTripTiers` is null for a service with no round-trip rule, and the
   * alternative to hiding the switch is a control that leads to a refusal.
   */
  const roundTripTiers = service?.roundTripTiers ?? null;
  const offersRoundTrip = roundTripTiers !== null && roundTripTiers.length > 0;
  const tripDirection: TripDirection =
    offersRoundTrip && direction === 'round_trip' ? 'round_trip' : 'one_way';
  // The tier list always comes from the rule that will price the trip.
  const tiers = (tripDirection === 'round_trip' ? roundTripTiers : service?.tiers) ?? [];
  const packageTierId = tiers.some((tier) => tier.id === tierId)
    ? tierId
    : (tiers[0]?.id ?? null);
  const chosenTier = tiers.find((tier) => tier.id === packageTierId) ?? null;

  const effectivePickupId = pickupPicked?.key ?? pickupId ?? places[0]?.id ?? null;
  const effectiveDestinationId =
    destinationPicked?.key ?? destinationId ?? places[1]?.id ?? places[0]?.id ?? null;
  const savedPickup = places.find((place) => place.id === effectivePickupId) ?? null;
  const savedDestination = places.find((place) => place.id === effectiveDestinationId) ?? null;
  const pickup = pickupPicked?.place ?? savedPickup?.place ?? null;
  const destination = tripDirection === 'round_trip'
    ? pickup
    : destinationPicked?.place ?? savedDestination?.place ?? null;
  const pickupName = pickupPicked?.name ?? savedPickup?.name ?? 'Choose pickup';
  const destinationName = tripDirection === 'round_trip'
    ? (pickupPicked?.name ?? savedPickup?.name ?? 'Return to pickup')
    : destinationPicked?.name ?? savedDestination?.name ?? 'Choose drop-off';

  const draft: TripDraft = {
    serviceTypeId: service?.id ?? null,
    tripDirection,
    pickup,
    destination,
    scheduledForMs,
    packageTierId,
  };
  const identity = tripIdentity(draft);
  const quote = useFareQuote(draft);
  const outcome = quote.data;
  const breakdown = outcome && !outcome.failed ? outcome.quote.breakdown : null;
  const normalizedCouponCode = couponCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
  const activeCoupon = couponPreview?.identity === identity && couponPreview.couponCode === normalizedCouponCode
    ? couponPreview
    : null;
  const displayedPayablePaise = activeCoupon?.customerPayablePaise ?? breakdown?.totalPaise ?? null;

  useEffect(() => {
    setCouponPreview(null);
    setCouponPreviewError(null);
  }, [identity]);

  /*
   * A price that moves on the *same* trip has to be said out loud before the
   * customer confirms, because the alternative is someone tapping a number they
   * never agreed to. A different trip changing price is the customer's own doing
   * — a new destination, a longer package — and interrupting them for that would
   * train them to dismiss the alert that matters. So the comparison is keyed on
   * the trip's identity, not on the quote.
   */
  const quoted = useRef<{ identity: string; breakdown: FareBreakdown } | null>(null);
  const [priceChange, setPriceChange] = useState<{
    fromPaise: number;
    toPaise: number;
    changed: string[];
  } | null>(null);

  useEffect(() => {
    if (!breakdown) return;
    const before = quoted.current;
    quoted.current = { identity, breakdown };
    if (!before || before.identity !== identity || identity === 'incomplete') return;
    if (before.breakdown.totalPaise === breakdown.totalPaise) return;
    const moved = [
      ...breakdown.items.filter(
        (item) => before.breakdown.items.find((row) => row.key === item.key)?.amountPaise !== item.amountPaise,
      ),
      ...before.breakdown.items.filter((row) => !breakdown.items.some((item) => item.key === row.key)),
    ].map((row) => row.label);
    setPriceChange({ fromPaise: before.breakdown.totalPaise, toPaise: breakdown.totalPaise, changed: moved });
  }, [breakdown, identity]);

  const quoteExpired = breakdown ? isQuoteExpired(breakdown, nowMs) : false;
  const samePlace = tripDirection !== 'round_trip' &&
    pickup !== null &&
    destination !== null &&
    pickup.location.lat === destination.location.lat &&
    pickup.location.lng === destination.location.lng;
  const attempted = booking.data;

  // Chips are the UI; a scheduled departure has to be resolved once, at the
  // moment it is chosen. Recomputing it on every render would move the quote key
  // forever and the price would never settle. The screen's own ticking clock is
  // the reference point rather than `Date.now()`, so the slot a chip names and
  // the expiry the fare card counts down share one reading.
  function chooseDeparture(key: DepartureKey) {
    setDeparture(key);
    setScheduledForMs(departureAt(key, nowMs));
    setOpenBox(null);
  }

  // A hand-picked slot stays open until the customer closes it, because the
  // panel is three choices — day, clock, minutes — not one.
  function chooseSlot(next: ScheduleSlot) {
    setSlot(next);
    setDeparture('slot');
    setScheduledForMs(scheduledEpochMs(next, nowMs));
  }

  const days = upcomingDays(nowMs);
  const calendarMonth = scheduleCalendarMonth(nowMs, calendarMonthOffset);
  const startTooSoon = departure === 'slot' && slotIsTooSoon(slot, nowMs);
  const startLabel =
    departure === 'slot'
      ? `${days[slot.offsetDays]?.label ?? 'Today'} ${clockLabel(slot)}`
      : DEPARTURE_OPTIONS.find((option) => option.key === departure)?.label ?? 'Choose pickup time';

  const modeSegments: { key: string; serviceId: ServiceTypeId; direction: TripDirection; title: string; icon: 'arrow-forward-outline' | 'git-compare-outline' | 'map-outline' | 'calendar-outline' }[] = [
    { key: 'one_way', serviceId: 'chauffeur_own_car', direction: 'one_way', title: 'One Way', icon: 'arrow-forward-outline' },
    { key: 'round_trip', serviceId: 'chauffeur_own_car', direction: 'round_trip', title: 'Round Trip', icon: 'git-compare-outline' },
    { key: 'outstation', serviceId: 'chauffeur_outstation', direction: 'one_way', title: 'Outstation', icon: 'map-outline' },
    { key: 'daily', serviceId: 'cab_standard', direction: 'one_way', title: 'Daily', icon: 'calendar-outline' },
  ];
  const unavailableById = new Map(unavailable.map((row) => [row.id, row]));
  const selectedMode = service?.id === 'chauffeur_outstation'
    ? 'outstation'
    : service?.id === 'cab_standard'
      ? 'daily'
      : direction === 'round_trip'
        ? 'round_trip'
        : 'one_way';

  return (
    <Screen layout="scroll" bleed paddedBottom>
      <BrandBar
        tagline="Safar aapka, driver hamara"
        right={
          <View
            accessibilityLabel={`Signed in as ${profile.data?.fullName ?? user?.phoneNumber ?? 'customer'}`}
            style={{
              width: theme.sizing.avatarMd,
              height: theme.sizing.avatarMd,
              borderRadius: theme.sizing.avatarMd / 2,
              backgroundColor: theme.colors.surfaceMuted,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text variant="label" tone="brand">
              {initialsOf(profile.data?.fullName ?? null, user?.phoneNumber ?? null)}
            </Text>
          </View>
        }
      />

      <Animated.View
        style={{
          gap: theme.spacing.lg,
          paddingHorizontal: wide ? theme.spacing.xl : theme.sizing.screenGutter,
          paddingBottom: theme.spacing.lg,
          opacity: entrance,
          transform: [{ translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }],
        }}
      >
        {options.isError || (optionResult?.failed ?? false) ? (
          <Card style={{ gap: theme.spacing.xs, borderColor: theme.colors.primary }}>
            <Text variant="label" tone="brand">Services are available · live fares are temporarily offline</Text>
            <Text variant="caption" tone="muted">
              Choose a service below. Live fare estimates are temporarily unavailable, so a booking cannot be confirmed yet. No booking was placed.
            </Text>
            <Button label="Retry live services" appearance="ghost" onPress={() => void options.refetch()} />
          </Card>
        ) : null}

        {optionResult && !optionResult.failed && services.length === 0 ? (
          <StateView
            kind="unavailable"
            title="No service is bookable here yet"
            message="Every service is either switched off or has no pricing rule. An administrator has to enable one."
          />
        ) : null}

        <MobileWelcomeHero
          name={profile.data?.fullName}
          fallback="there"
          role="customer"
        />

        <View style={{ gap: theme.spacing.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text variant="heading" tone="brand" style={{ flexShrink: 1, marginRight: theme.spacing.sm }}>Where do you want to go?</Text>
            {service ? <Tag label={service.driversOnline > 0 ? `${service.driversOnline} NEARBY` : 'LIVE AVAILABILITY'} tone={service.driversOnline > 0 ? 'success' : 'neutral'} /> : null}
          </View>
          <View style={{ height: wide ? 390 : 350, borderRadius: theme.radius.xl, overflow: 'hidden', position: 'relative', borderWidth: 1, borderColor: theme.colors.border }}>
            <TripMapPanel pickup={pickup} destination={destination} title={pickup && destination ? 'Your route' : 'Gurugram map'} height={wide ? 390 : 350} compact />
            <View style={{ position: 'absolute', top: 12, left: 12, right: 12, gap: 8 }}>
              {([
                ['pickup', pickupName, 'Pickup'],
                ['dropoff', destinationName, 'Where to?'],
              ] as const).map(([end, value, fallback]) => (
                <Pressable
                  key={end}
                  accessibilityRole="button"
                  accessibilityLabel={`${end === 'pickup' ? 'Set pickup' : 'Set destination'}: ${value}`}
                  disabled={end === 'dropoff' && tripDirection === 'round_trip'}
                  onPress={() => setPicking(end)}
                  style={({ pressed }) => ({
                    minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10,
                    borderRadius: theme.radius.md, paddingHorizontal: 14,
                    backgroundColor: theme.colors.surface, opacity: pressed ? 0.82 : 0.97,
                    borderWidth: 1, borderColor: theme.colors.border,
                    shadowColor: '#102d60', shadowOpacity: 0.14, shadowRadius: 8, elevation: 3,
                  })}
                >
                  <Marker kind={end} />
                  <Text variant="bodyStrong" numberOfLines={1} style={{ flex: 1 }}>{value === 'Choose pickup' || value === 'Choose drop-off' ? fallback : value}</Text>
                  {end === 'dropoff' && tripDirection === 'round_trip'
                    ? <Ionicons name="return-down-back-outline" size={18} color={theme.colors.textBrand} />
                    : <Ionicons name="search-outline" size={18} color={theme.colors.textBrand} />}
                </Pressable>
              ))}
            </View>
            {pickup && destination ? (
              <View style={{ position: 'absolute', right: 12, bottom: 12, backgroundColor: theme.colors.surface, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: theme.colors.border }}>
                <Text variant="caption" tone="brand">Route ready · live fare below</Text>
              </View>
            ) : null}
          </View>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: theme.spacing.xs, paddingBottom: 2 }}>
          {modeSegments.map((mode) => {
            const enabledInCatalogue = visibleServiceIds.includes(mode.serviceId);
            const disabled = !enabledInCatalogue || (mode.key === 'round_trip' && services.length > 0 && !offersRoundTrip);
            const selected = serviceTypeId === mode.serviceId && direction === mode.direction || (!serviceTypeId && selectedMode === mode.key);
            const reason = unavailableById.get(mode.serviceId)?.reason;
            return (
              <Pressable
                key={mode.key}
                accessibilityRole="button"
                accessibilityState={{ selected, disabled }}
                accessibilityLabel={reason ? `${mode.title}. ${reason}` : mode.title}
                disabled={disabled}
                onPress={() => {
                  setServiceTypeId(mode.serviceId);
                  setDirection(mode.direction);
                  setTierId(null);
                }}
                style={({ pressed }) => ({
                  width: 104,
                  minHeight: 78,
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: theme.spacing.xxs,
                  padding: theme.spacing.xs,
                  borderRadius: theme.radius.md,
                  backgroundColor: selected ? theme.colors.primarySoft : theme.colors.surface,
                  borderWidth: selected ? 2 : theme.borderWidth.thin,
                  borderColor: selected ? theme.colors.primary : theme.colors.border,
                  opacity: disabled ? 0.55 : pressed ? 0.72 : 1,
                })}
              >
                <Ionicons name={mode.icon} size={19} color={selected ? theme.colors.primaryInk : theme.colors.textMuted} />
                <Text variant="label" tone={selected ? 'primary' : disabled ? 'faint' : 'muted'} numberOfLines={1}>{mode.title}</Text>
                {disabled ? <Text variant="overline" tone="faint" numberOfLines={1}>{enabledInCatalogue ? 'Pricing unavailable' : 'Coming soon'}</Text> : null}
              </Pressable>
            );
          })}
        </ScrollView>

        <View
          style={{ gap: theme.spacing.lg }}
          >
            <View
              style={{
                // In the stacked layout the row's main axis is vertical and its
                // height is whatever the content needs, so a zero flex basis
                // would collapse both columns to nothing and let them overlap.
                width: '100%',
                minWidth: 0,
                gap: theme.spacing.lg,
              }}
            >
              <SectionCard
                title="Vehicle details"
                icon={<Ionicons name="car-outline" size={16} color={theme.colors.textBrand} />}
              >
                <Text variant="caption" tone="muted">Tell your driver which car to expect.</Text>
                <TextInput
                  accessibilityLabel="Car make and model"
                  placeholder="Make and model · e.g. Honda City"
                  placeholderTextColor={theme.colors.textFaint}
                  value={vehicleDescription}
                  onChangeText={setVehicleDescription}
                  maxLength={80}
                  returnKeyType="done"
                  style={{
                    minHeight: 48, borderWidth: 1, borderColor: theme.colors.border,
                    borderRadius: theme.radius.md, paddingHorizontal: theme.spacing.md,
                    color: theme.colors.text, backgroundColor: theme.colors.surface,
                  }}
                />
                <Text variant="label" tone="muted">Car type</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: theme.spacing.xs }}>
                  {CAR_OPTIONS.map((option) => (
                    <Chip key={option.id} title={option.title} selected={carType === option.id} onPress={() => setCarType(option.id)} />
                  ))}
                </ScrollView>
                <Text variant="label" tone="muted">Transmission</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs }}>
                  {TRANSMISSION_OPTIONS.map((option) => (
                    <Chip key={option.id} title={option.title} selected={transmission === option.id} onPress={() => setTransmission(option.id)} />
                  ))}
                </View>
              </SectionCard>

              <SectionCard
                title="Trip itinerary"
                icon={<Ionicons name="location" size={16} color={theme.colors.textBrand} />}
                action={tripDirection === 'round_trip' ? undefined :
                  <HeaderAction
                    label="Swap"
                    icon="swap-horizontal"
                    disabled={pickup === null || destination === null}
                    onPress={() => {
                      // Swap the resolved addresses, not the pickers: after a
                      // swap both ends are whatever the customer was looking at,
                      // whether that came from search, GPS or a saved place.
                      if (pickup === null || destination === null) return;
                      setPickupPicked({ place: destination, name: destinationName, key: `swapped-${effectiveDestinationId}` });
                      setDestinationPicked({ place: pickup, name: pickupName, key: `swapped-${effectivePickupId}` });
                    }}
                  />
                }
                footer={
                  samePlace ? (
                    <Text variant="caption" tone="warning">
                      Pickup and drop-off are the same place. Choose a different destination.
                    </Text>
                  ) : null
                }
              >
                {tripDirection === 'round_trip' ? (
                  <Text variant="caption" tone="faint">
                    The driver returns you to pickup. Fare is time-based; distance is not charged separately.
                  </Text>
                ) : service?.id === 'chauffeur_outstation' ? (
                  <Text variant="caption" tone="faint">
                    Outstation one-way packages run through 3,000 km. After 500 km, each 50 km package adds ₹285; extra odometer distance is ₹10/km. A ₹200/hour night charge is added only for trip time from 10 PM to 6 AM.
                  </Text>
                ) : null}

                <View style={{ flexDirection: wide ? 'row' : 'column', gap: theme.spacing.sm }}>
                  <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
                    <SelectBox
                      label="Pickup date & time"
                      value={startLabel}
                      icon={<Ionicons name="calendar-outline" size={16} color={theme.colors.textBrand} />}
                      expanded={openBox === 'start'}
                      disabled={service?.allowsScheduling === false}
                      onPress={() => setOpenBox(openBox === 'start' ? null : 'start')}
                      trailing={
                        <Ionicons
                          name={openBox === 'start' ? 'chevron-up' : 'chevron-down'}
                          size={15}
                          color={theme.colors.textMuted}
                        />
                      }
                    />
                  </View>
                  <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
                    <SelectBox
                      label={tripDirection === 'round_trip' ? 'Package hours' : 'Rental duration'}
                      value={
                        chosenTier
                          ? tripDirection === 'round_trip'
                            ? `${chosenTier.hours} ${chosenTier.hours === 1 ? 'hour' : 'hours'} · ${money(chosenTier.packagePricePaise)}`
                            : `${chosenTier.hours} hours (${chosenTier.includedKilometers} km included)`
                          : 'By distance'
                      }
                      icon={<Ionicons name="time-outline" size={16} color={theme.colors.textBrand} />}
                      expanded={openBox === 'duration'}
                      disabled={tiers.length === 0}
                      onPress={() => setOpenBox(openBox === 'duration' ? null : 'duration')}
                      trailing={
                        tiers.length > 0 ? (
                          <Ionicons
                            name={openBox === 'duration' ? 'chevron-up' : 'chevron-down'}
                            size={15}
                            color={theme.colors.textMuted}
                          />
                        ) : null
                      }
                    />
                  </View>
                </View>

                {openBox === 'start' && service?.allowsScheduling !== false ? (
                  <View style={{ gap: theme.spacing.md }}>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
                      {DEPARTURE_OPTIONS.map((option) => (
                        <Chip
                          key={option.key}
                          title={option.label}
                          selected={departure === option.key}
                          onPress={() => chooseDeparture(option.key)}
                        />
                      ))}
                    </View>

                    <Divider size="sm" />

                    <View style={{ gap: theme.spacing.sm }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Text variant="label" tone="brand">Choose a date</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Previous month"
                            disabled={calendarMonthOffset === 0}
                            onPress={() => setCalendarMonthOffset((month) => Math.max(0, month - 1))}
                            style={{ padding: theme.spacing.xs, opacity: calendarMonthOffset === 0 ? 0.35 : 1 }}
                          >
                            <Ionicons name="chevron-back" size={18} color={theme.colors.textBrand} />
                          </Pressable>
                          <Text variant="label">{calendarMonth.label}</Text>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Next month"
                            disabled={calendarMonthOffset >= 6}
                            onPress={() => setCalendarMonthOffset((month) => Math.min(6, month + 1))}
                            style={{ padding: theme.spacing.xs, opacity: calendarMonthOffset >= 6 ? 0.35 : 1 }}
                          >
                            <Ionicons name="chevron-forward" size={18} color={theme.colors.textBrand} />
                          </Pressable>
                        </View>
                      </View>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((weekday) => (
                          <View key={weekday} style={{ width: '14.2857%', alignItems: 'center', paddingVertical: theme.spacing.xs }}>
                            <Text variant="caption" tone="muted">{weekday}</Text>
                          </View>
                        ))}
                        {Array.from({ length: calendarMonth.firstWeekday }, (_, index) => (
                          <View key={`empty-${index}`} style={{ width: '14.2857%', height: 44 }} />
                        ))}
                        {calendarMonth.days.map((day) => {
                          const selected = departure === 'slot' && slot.offsetDays === day.offsetDays;
                          const candidatePickupMs = scheduledEpochMs({ ...slot, offsetDays: day.offsetDays }, nowMs);
                          const disabled = day.offsetDays < 0 || candidatePickupMs > latestBookingDateMs(nowMs);
                          return (
                            <Pressable
                              key={day.offsetDays}
                              accessibilityRole="button"
                              accessibilityLabel={`${calendarMonth.label} ${day.day}`}
                              accessibilityState={{ selected, disabled }}
                              disabled={disabled}
                              onPress={() => chooseSlot({ ...slot, offsetDays: day.offsetDays })}
                              style={{
                                width: '14.2857%', height: 44, alignItems: 'center', justifyContent: 'center',
                                borderRadius: 22, backgroundColor: selected ? theme.colors.primary : 'transparent',
                                opacity: disabled ? 0.3 : 1,
                              }}
                            >
                              <Text variant="label" style={{ color: selected ? theme.colors.onPrimary : theme.colors.text }}>{day.day}</Text>
                            </Pressable>
                          );
                        })}
                      </View>
                      <Text variant="caption" tone="muted">Bookings are available up to 6 months ahead. Pickup needs at least 30 minutes’ notice.</Text>
                    </View>

                    <View style={{ gap: theme.spacing.sm }}>
                      <SegmentedTabs
                        options={[
                          { id: 'am', title: 'AM' },
                          { id: 'pm', title: 'PM' },
                        ]}
                        value={departure === 'slot' ? slot.meridiem : null}
                        onChange={(meridiem) => chooseSlot({ ...slot, meridiem })}
                        accessibilityLabel="Morning or afternoon"
                      />
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs }}>
                        {HOURS.map((hour) => (
                          <Chip
                            key={`hour-${hour}`}
                            title={String(hour)}
                            style={{ minWidth: 46 }}
                            selected={departure === 'slot' && slot.hour12 === hour}
                            disabled={slotIsTooSoon({ ...slot, hour12: hour }, nowMs)}
                            onPress={() => chooseSlot({ ...slot, hour12: hour })}
                          />
                        ))}
                      </View>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs }}>
                        {MINUTES.map((minute) => (
                          <Chip
                            key={`minute-${minute}`}
                            title={String(minute).padStart(2, '0')}
                            style={{ minWidth: 46 }}
                            selected={departure === 'slot' && slot.minute === minute}
                            disabled={slotIsTooSoon({ ...slot, minute }, nowMs)}
                            onPress={() => chooseSlot({ ...slot, minute })}
                          />
                        ))}
                      </View>
                    </View>

                    {startTooSoon ? (
                      <Text variant="caption" tone="danger" accessibilityRole="alert">
                        That time has already passed. A pickup needs at least{' '}
                        {MIN_LEAD_MS / 60_000} minutes’ notice.
                      </Text>
                    ) : null}
                  </View>
                ) : null}

                {openBox === 'duration' && tiers.length > 0 ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
                    {tiers.map((tier) => (
                      <Chip
                        key={tier.id}
                        title={`${tier.label} · ${tier.includedKilometers} km · ${money(tier.packagePricePaise)}`}
                        selected={packageTierId === tier.id}
                        onPress={() => {
                          setTierId(tier.id);
                          setOpenBox(null);
                        }}
                      />
                    ))}
                  </View>
                ) : null}

                {scheduledForMs !== null ? (
                  <Text variant="caption" tone="muted">
                    Departing {dateTime(scheduledForMs)}.
                  </Text>
                ) : null}
              </SectionCard>

              <SectionCard
                title="DrivX fare estimate"
                icon={<Ionicons name="receipt-outline" size={16} color={theme.colors.textBrand} />}
                action={
                  breakdown ? (
                    <HeaderAction
                      label={showFareDetails ? 'Hide details' : 'Fare details'}
                      icon={showFareDetails ? 'chevron-up' : 'chevron-down'}
                      onPress={() => setShowFareDetails((open) => !open)}
                    />
                  ) : null
                }
                footer={
                  <View style={{ gap: theme.spacing.sm }}>
                    {rewardCheckout ? (
                      <Card tone="inset" style={{ gap: theme.spacing.xs }}>
                        <Text variant="label" tone="brand">DrivX Rewards</Text>
                        <Text variant="caption" tone="muted">Available: {money(rewardCheckout.walletPaise)} wallet credit · {rewardCheckout.milesPoints} Miles (100 Miles = ₹20)</Text>
                        {rewardCheckout.customerReferralCode ? (
                          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing.sm }}>
                            <View style={{ flex: 1, gap: 2 }}>
                              <Text variant="caption" tone="muted">Your personal invite code</Text>
                              <Text variant="label" tone="brand">{rewardCheckout.customerReferralCode}</Text>
                            </View>
                            <Button
                              label="Share code"
                              appearance="secondary"
                              size="sm"
                              onPress={() => void Share.share({
                                title: 'Join me on DrivX',
                                message: `Join DrivX for trusted drivers. Use my invite code ${rewardCheckout.customerReferralCode} when you sign up.`,
                              })}
                            />
                          </View>
                        ) : (
                          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing.sm }}>
                            <Text variant="caption" tone="muted" style={{ flex: 1 }}>Your invite code is being prepared.</Text>
                            <Button label="Refresh" appearance="secondary" size="sm" onPress={() => setRewardsReload((value) => value + 1)} />
                          </View>
                        )}
                        <Text variant="caption" tone="muted">Share your personal code. Both accounts get their referral credit after your friend completes an eligible first trip.</Text>
                        <TextInput
                          value={couponCode}
                          onChangeText={(value) => {
                            setCouponCode(value.toUpperCase());
                            setCouponPreview(null);
                            setCouponPreviewError(null);
                          }}
                          placeholder="Enter coupon code"
                          autoCapitalize="characters"
                          accessibilityLabel="Coupon code"
                          style={{ minHeight: 44, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, paddingHorizontal: 12, color: theme.colors.text }}
                        />
                        {activeCoupon ? (
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: theme.spacing.sm }}>
                            <Text variant="caption" tone="success">
                              {activeCoupon.couponCode} applied · save {money(activeCoupon.discountPaise)}
                            </Text>
                            <Pressable
                              accessibilityRole="button"
                              onPress={() => { setCouponCode(''); setCouponPreview(null); setCouponPreviewError(null); }}
                              hitSlop={8}
                            >
                              <Text variant="caption" tone="primary">Remove</Text>
                            </Pressable>
                          </View>
                        ) : (
                          <Button
                            label="Apply coupon"
                            appearance="secondary"
                            onPress={async () => {
                              if (!service || !pickup || !destination || !normalizedCouponCode) {
                                setCouponPreviewError('Enter a coupon code and add pickup and destination first.');
                                return;
                              }
                              setCouponPreviewBusy(true);
                              setCouponPreviewError(null);
                              setCouponPreview(null);
                              try {
                                const result = await callFunction<{
                                  serviceTypeId: ServiceTypeId;
                                  tripDirection: TripDirection;
                                  pickup: Place;
                                  destination: Place;
                                  scheduledForMs: number | null;
                                  packageTierId: string | null;
                                  couponCode: string;
                                }, {
                                  couponCode: string;
                                  baseFarePaise: number;
                                  discountPaise: number;
                                  customerPayablePaise: number;
                                  currency: 'INR';
                                }>(firebase(), 'previewCoupon', {
                                  serviceTypeId: service.id,
                                  tripDirection,
                                  pickup,
                                  destination,
                                  scheduledForMs,
                                  packageTierId,
                                  couponCode: normalizedCouponCode,
                                });
                                setCouponPreview({ identity, ...result });
                              } catch (error) {
                                setCouponPreviewError(error instanceof Error ? error.message : 'Could not apply this coupon.');
                              } finally {
                                setCouponPreviewBusy(false);
                              }
                            }}
                            disabled={!normalizedCouponCode || !pickup || !destination || couponPreviewBusy}
                            loading={couponPreviewBusy}
                            fullWidth
                          />
                        )}
                        {!activeCoupon ? (
                          <Text variant="caption" tone="muted">Apply a coupon to preview the reduced fare. The server validates it before you confirm the ride.</Text>
                        ) : null}
                        {couponPreviewError ? (
                          <Text variant="caption" tone="danger" accessibilityRole="alert">{couponPreviewError}</Text>
                        ) : null}
                        {activeCoupon ? (
                          <Text variant="caption" tone="muted">
                            Fare {money(activeCoupon.baseFarePaise)} − coupon {money(activeCoupon.discountPaise)} = {money(activeCoupon.customerPayablePaise)} before wallet or Miles.
                          </Text>
                        ) : null}
                        {rewardCheckout.walletPaise > 0 ? <Pressable onPress={() => setUseWallet((v) => !v)}><Text variant="caption" tone={useWallet ? 'success' : 'primary'}>{useWallet ? '✓ ' : '○ '}Use wallet credit up to {money(rewardCheckout.walletPaise)}</Text></Pressable> : null}
                        {rewardCheckout.milesPoints > 0 ? <Pressable onPress={() => setUseMiles((v) => !v)}><Text variant="caption" tone={useMiles ? 'success' : 'primary'}>{useMiles ? '✓ ' : '○ '}Use {rewardCheckout.milesPoints} available Miles</Text></Pressable> : null}
                        <Text variant="caption" tone="faint">The server checks this coupon again when you confirm. Nothing is charged until your ride is completed.</Text>
                      </Card>
                    ) : rewardsLoadError ? (
                      <Card tone="inset" style={{ gap: theme.spacing.xs }}>
                        <Text variant="label" tone="brand">DrivX Rewards</Text>
                        <Text variant="caption" tone="danger" accessibilityRole="alert">Could not load your invite code or wallet right now.</Text>
                        <Button label="Retry rewards" appearance="secondary" onPress={() => setRewardsReload((value) => value + 1)} />
                      </Card>
                    ) : user ? (
                      <Card tone="inset" style={{ gap: theme.spacing.xs }}>
                        <Text variant="label" tone="brand">DrivX Rewards</Text>
                        <Text variant="caption" tone="muted">Loading your invite code and wallet…</Text>
                      </Card>
                    ) : null}
                    {breakdown ? (
                      <Text variant="caption" tone={quoteExpired ? 'danger' : 'faint'}>
                        {quoteExpired
                          ? `This price lapsed at ${dateTime(breakdown.expiresAtMs)}. Refresh before confirming.`
                          : `Valid until ${dateTime(breakdown.expiresAtMs)}.`}
                      </Text>
                    ) : (
                      <Text variant="caption" tone="muted">
                        Add both places to see the fare.
                      </Text>
                    )}
                    <Button
                      label="Confirm DrivX ride"
                      onPress={() => {
                        if (!service || !pickup || !destination) return;
                        booking.mutate(
                          {
                            pickup,
                            destination,
                            serviceTypeId: service.id,
                            tripDirection,
                            preferences: {
                              transmission,
                              carType,
                              vehicleDescription: vehicleDescription.trim() || undefined,
                              notes: null,
                            },
                            scheduledForMs,
                            packageTierId,
                            couponCode: activeCoupon?.couponCode,
                            redeemWalletPaise: useWallet ? (rewardCheckout?.walletPaise ?? 0) : 0,
                            redeemMilesPoints: useMiles ? (rewardCheckout?.milesPoints ?? 0) : 0,
                            idempotencyKey,
                          },
                          {
                            // The trip screen is the confirmation: it already shows
                            // the reference, the status and the stored fare, so the
                            // composer keeps nothing of a finished booking behind.
                            onSuccess: (outcome) => {
                              if (!outcome.ok) return;
                              const { bookingId } = outcome.result;
                              booking.reset();
                              setIdempotencyKey(newIdempotencyKey());
                              router.push(`/(customer)/trips/${bookingId}`);
                            },
                          },
                        );
                      }}
                      disabled={
                        !breakdown ||
                        quoteExpired ||
                        samePlace ||
                        startTooSoon ||
                        booking.isPending ||
                        couponPreviewBusy ||
                        (normalizedCouponCode.length > 0 && !activeCoupon) ||
                        // Held until the customer acknowledges the new number: a
                        // price they have not seen is a price they have not agreed to.
                        priceChange !== null
                      }
                      loading={booking.isPending}
                      fullWidth
                      style={{ minHeight: theme.sizing.buttonLg }}
                    />
                    <Text variant="caption" tone="muted">
                      {breakdown
                        ? `Total includes ${money(breakdown.taxPaise)} tax${activeCoupon ? ` · coupon saves ${money(activeCoupon.discountPaise)}` : ''}. Nothing is charged now.`
                        : 'Nothing is charged now.'}
                    </Text>
                  </View>
                }
              >
                <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: theme.spacing.md }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text variant="fare" tone="brand">
                      {displayedPayablePaise !== null ? money(displayedPayablePaise) : '—'}
                    </Text>
                  </View>
                  {service ? (
                    <Tag
                      label={service.driversOnline > 0 ? `${service.driversOnline} NEARBY` : 'NONE ONLINE'}
                      tone={service.driversOnline > 0 ? 'success' : 'neutral'}
                      dot={service.driversOnline > 0}
                    />
                  ) : null}
                </View>

                {service ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setShowTerms(true)}
                    hitSlop={8}
                    style={({ pressed }) => [
                      {
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: theme.spacing.xxs,
                        alignSelf: 'flex-start',
                        opacity: pressed ? 0.6 : 1,
                      },
                    ]}
                  >
                    <Ionicons
                      name="information-circle-outline"
                      size={15}
                      color={theme.colors.primaryInk}
                    />
                    <Text variant="label" tone="primary">
                      Price rules and what to know
                    </Text>
                  </Pressable>
                ) : null}

                {quote.isFetching ? (
                  <Text variant="caption" tone="muted">
                    Pricing this trip…
                  </Text>
                ) : null}

                {outcome?.failed ? (
                  <View style={{ gap: theme.spacing.xxs }}>
                    <StatusPill label={`Refused · ${outcome.error.code}`} tone="warning" />
                    <Text variant="caption" tone="warning">
                      {outcome.error.message}
                    </Text>
                  </View>
                ) : null}

                {showFareDetails && breakdown ? (
                  <Card tone="inset" style={{ gap: theme.spacing.xs }}>
                    {breakdown.items.map((item) => (
                      <View
                        key={`${item.key}-${item.label}`}
                        style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.sm }}
                      >
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text variant="caption">{item.label}</Text>
                          {item.detail ? (
                            <Text variant="caption" tone="faint">
                              {item.detail}
                            </Text>
                          ) : null}
                        </View>
                        <Text variant="caption" tone={item.amountPaise < 0 ? 'success' : 'default'}>
                          {money(item.amountPaise)}
                        </Text>
                      </View>
                    ))}
                    <Divider size="sm" />
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text variant="label" tone="muted">
                        Subtotal
                      </Text>
                      <Text variant="label">{money(breakdown.subtotalPaise)}</Text>
                    </View>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text variant="label" tone="muted">
                        tax
                      </Text>
                      <Text variant="label">{money(breakdown.taxPaise)}</Text>
                    </View>
                    {activeCoupon ? (
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text variant="label" tone="success">Coupon · {activeCoupon.couponCode}</Text>
                        <Text variant="label" tone="success">−{money(activeCoupon.discountPaise)}</Text>
                      </View>
                    ) : null}
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text variant="subheading" tone="brand">
                        {activeCoupon ? 'You pay' : 'Total'}
                      </Text>
                      <Text variant="subheading" tone="brand">
                        {money(displayedPayablePaise ?? breakdown.totalPaise)}
                      </Text>
                    </View>
                  </Card>
                ) : null}

                {outcome && !outcome.failed ? (
                  <Text variant="caption" tone="muted">
                    Route distance · {(outcome.quote.distanceMeters / 1000).toFixed(1)} km
                    {outcome.quote.durationSeconds !== null
                      ? ` · ${Math.round(outcome.quote.durationSeconds / 60)} min estimated driving`
                      : outcome.quote.distanceSource === 'haversine_fallback'
                        ? ' · straight-line estimate; final route is checked by the server'
                        : ''}
                  </Text>
                ) : null}

                {breakdown ? (
                  <Button
                    label="Refresh this price"
                    onPress={() => void quote.refetch()}
                    appearance={quoteExpired ? 'brand' : 'ghost'}
                    size="sm"
                    loading={quote.isFetching}
                  />
                ) : null}

              </SectionCard>

              {attempted && !attempted.ok ? (
                /* A refusal has to stay on the screen: the tap produced no booking,
                   and the customer needs the server's own reason, not a toast. */
                <Card tone="inset" style={{ gap: theme.spacing.xs }}>
                  <StatusPill label={`Refused · ${attempted.error.code}`} tone="danger" />
                  <Text variant="caption" tone="danger">
                    {attempted.error.message}
                  </Text>
                  <Text variant="caption" tone="faint">
                    Nothing was booked and nothing was charged. Keep the same details and tap again —
                    the retry cannot create a second booking.
                  </Text>
                </Card>
              ) : booking.isError ? (
                /* A thrown mutation has no `data` to read a code from — an HTTP 500
                   from the functions emulator arrives this way. Without this branch
                   the tap silently does nothing. */
                <Card tone="inset" style={{ gap: theme.spacing.xs }}>
                  <StatusPill label="Booking failed" tone="danger" />
                  <Text variant="caption" tone="danger">
                    {booking.error instanceof Error
                      ? booking.error.message
                      : 'The booking request did not reach the backend.'}
                  </Text>
                  <Text variant="caption" tone="faint">
                    Nothing was booked. Tap again to retry.
                  </Text>
                </Card>
              ) : null}
            </View>

          </View>
      </Animated.View>

      <PricingSheet
        service={service}
        tripDirection={tripDirection}
        open={showTerms}
        onClose={() => setShowTerms(false)}
      />

      <Sheet
        open={picking !== null}
        title={picking === 'pickup' ? 'Choose pickup' : 'Choose destination'}
        subtitle="Search an address, use your location, or pick a saved place."
        onClose={() => setPicking(null)}
        label="Done"
      >
        {picking ? (
          <PlaceSearchPanel
            title={picking === 'pickup' ? 'Pickup address' : 'Destination address'}
            savedPlaces={places}
            pickedPlaceId={picking === 'pickup' ? effectivePickupId : effectiveDestinationId}
            onPick={(place, name, key) => {
              const picked = { place, name, key };
              if (picking === 'pickup') {
                setPickupPicked(picked);
                setPickupId(null);
              } else {
                setDestinationPicked(picked);
                setDestinationId(null);
              }
              setPicking(null);
            }}
            onOpenSavedPlaces={() => {
              setPicking(null);
              router.push('/(customer)/saved-places');
            }}
          />
        ) : null}
      </Sheet>

      <Sheet
        open={priceChange !== null}
        title="Price updated"
        subtitle="This trip was quoted again before you confirmed, and the total moved."
        onClose={() => setPriceChange(null)}
        label="Got it, continue"
      >
        {priceChange ? (
          <View style={{ gap: theme.spacing.sm }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing.md }}>
              <Text variant="body" tone="muted" style={{ textDecorationLine: 'line-through' }}>
                {money(priceChange.fromPaise)}
              </Text>
              <Text variant="fare" tone="brand">
                {money(priceChange.toPaise)}
              </Text>
            </View>
            <Text
              variant="caption"
              tone={priceChange.toPaise > priceChange.fromPaise ? 'warning' : 'success'}
            >
              {priceChange.toPaise > priceChange.fromPaise
                ? `${money((priceChange.toPaise - priceChange.fromPaise) as MoneyPaise)} more than the price you were shown.`
                : `${money((priceChange.fromPaise - priceChange.toPaise) as MoneyPaise)} less than the price you were shown.`}
            </Text>
            {priceChange.changed.length > 0 ? (
              <Text variant="caption" tone="muted">
                What moved: {priceChange.changed.join(', ')}.
              </Text>
            ) : null}
            <Text variant="caption" tone="faint">
              Nothing is booked and nothing is charged until you tap Confirm DrivX ride.
            </Text>
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}
