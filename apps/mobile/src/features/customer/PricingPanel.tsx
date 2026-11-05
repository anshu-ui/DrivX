import { View } from 'react-native';
import { Divider, Sheet, Text, useTheme } from '@drivx/ui';
import type { BookingOptionService, BookingOptionTerms, TripDirection } from '@drivx/domain';
import { MIN_LEAD_MS } from './booking';
import { money } from './labels';

/**
 * The rate card, in the customer's words.
 *
 * Every number here is read off the pricing rule that will quote the trip —
 * `bookingOptions` publishes the rates, `quoteFare` does the arithmetic — so the
 * sheet cannot promise a different minimum slab from the server. What it
 * says about the *business* (who feeds the driver, whose job the return journey
 * is) is the operator's policy, and is stated as such rather than left for a
 * driver and a customer to argue about in the car.
 */

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** 22 → "10 PM". A night window a customer can only read as a 24-hour number is not a window they trust. */
function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;
}

function Bullet({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          marginTop: 8,
          backgroundColor: theme.colors.primaryInk,
        }}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="body">{text}</Text>
      </View>
    </View>
  );
}

function Group({ title, rows }: { title: string; rows: string[] }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text variant="label" tone="brand">
        {title}
      </Text>
      {rows.map((row) => (
        <Bullet key={row} text={row} />
      ))}
    </View>
  );
}

/**
 * The distance bands a one-way trip is priced on, printed from the rule itself.
 * The chart is an alternative slab list, and the odometer adds only distance
 * beyond the quoted route.
 */
function chartRows(terms: BookingOptionTerms | null): string[] {
  if (!terms || terms.slabs.length === 0) return [];
  const last = terms.slabs[terms.slabs.length - 1]!;
  const outstation = terms.slabs.some((slab) => slab.upToKilometers === 3_000);
  const visibleSlabs = outstation ? terms.slabs.filter((slab) => slab.upToKilometers <= 500) : terms.slabs;
  const rows = visibleSlabs.map((slab) => `Up to ${slab.upToKilometers} km — ${money(slab.farePaise)}`);
  if (outstation) {
    const firstExtended = terms.slabs.find((slab) => slab.upToKilometers === 550);
    rows.push(`Above 500 km, the next 50 km package is ${money(firstExtended?.farePaise ?? last.farePaise + 28_500)}. Each following 50 km adds ₹285, through 3,000 km (${money(last.farePaise)}).`);
  }
  rows.push(
    `Beyond ${last.upToKilometers} km, ${money(last.farePaise)} plus ${money(
      terms.slabOverflowPerKmPaise ?? 0,
    )} for every additional kilometre.`,
  );
  rows.push('One band prices the whole route. The bands are never added together.');
  if (terms.slabOverflowPerKmPaise !== null) {
    rows.push(
      `Your driver reads the odometer at pickup and at the drop. Kilometres beyond your quoted route are added at ${money(
        terms.slabOverflowPerKmPaise,
      )} each — and a drive that comes back early still pays that band.`,
    );
  }
  if (terms.distanceRounding === 'next_whole_km') {
    rows.push('A part kilometre is counted as a whole one.');
  } else if (terms.distanceRounding === 'one_decimal') {
    rows.push('Distance is rounded to the nearest 0.1 km before the fare is calculated.');
  }
  return rows;
}

/** The lines that describe this fare, straight from the rule that prices it. */
function pricingRows(service: BookingOptionService, roundTrip: boolean): string[] {
  const terms = roundTrip ? service.roundTripTerms : service.terms;
  if (!terms) return [];
  const tiers = (roundTrip ? service.roundTripTiers : service.tiers) ?? [];
  const rows: string[] = [
    `The fare plus ${percent(terms.gstRate)} tax is what you pay. Tax is added on top of the price, not hidden inside it.`,
  ];

  if (tiers.length > 0) {
    rows.push(`Available packages: ${tiers.map((tier) => `${tier.label} — ${money(tier.packagePricePaise)}`).join(' · ')}.`);
  }

  if (terms.slabs.length === 0 && terms.perKmPaise !== null) {
    rows.push(
      `${money(terms.perKmPaise)} per kilometre, taken over the road between your pickup and your drop-off.`,
    );
  } else if (tiers.length > 0) {
    if (service.id === 'chauffeur_outstation' && roundTrip && tiers[0]!.includedKilometers === 0) {
      rows.push(`Outstation round trip is charged by day package, not by kilometres. The trip duration is ${tiers[0]!.hours / 24} day${tiers[0]!.hours === 24 ? '' : 's'} for this selected package; overtime is ${money(tiers[0]!.extraHourPaise / 60)} per minute after the package hours.`);
    } else if (tiers[0]!.includedKilometers === 0 && tiers[0]!.extraKmPaise === 0) {
      rows.push(`Round trip is priced by time. It returns to the pickup location; overtime is ${money(tiers[0]!.extraHourPaise / 60)} per minute after the selected hours.`);
    } else {
      rows.push(`Each package includes its displayed time and distance. Extra distance is ${money(tiers[0]!.extraKmPaise)} per km; overtime is ${money(tiers[0]!.extraHourPaise / 60)} per minute after the selected hours.`);
    }
  }

  if (terms.platformFeeRate > 0) {
    rows.push(`A ${percent(terms.platformFeeRate)} platform fee is part of the fare.`);
  }
  if (terms.baseFarePaise > 0) {
    rows.push(`${money(terms.baseFarePaise)} base fare applies to every trip.`);
  }
  if (terms.minimumFarePaise > 0) {
    rows.push(`No trip is billed below ${money(terms.minimumFarePaise)}.`);
  }
  if (terms.nightSurcharge) {
    const night = terms.nightSurcharge;
    const window = `driving time between ${hourLabel(night.fromHour)} and ${hourLabel(night.toHour)}`;
    rows.push(
      night.mode === 'flat'
        ? `${money(night.flatPaise)} night charge applies once when the trip starts during ${window}.`
        : night.mode === 'hourly'
          ? `${money(night.flatPaise)} per eligible driving hour applies only to trip minutes that fall within ${window}; partial hours are prorated. The charge is automatic and shown in your fare before booking.`
          : `${percent(night.rate)} night allowance applies during ${window}.`,
    );
  }
  if (terms.waitChargePerMinutePaise > 0) {
    rows.push(
      `The driver's first ${terms.includedWaitMinutes} minutes at your door are free; after that it is ${money(
        terms.waitChargePerMinutePaise,
      )} per minute.`,
    );
  } else if (tiers.length > 0) {
    rows.push(
      'Waiting inside your package is not charged again — the hours you bought are the hours the driver is held.',
    );
  }
  if (roundTrip && service.id === 'chauffeur_outstation' && tiers.length > 0) {
    rows.push('Outstation round-trip packages are day based and do not include a kilometre cap or extra kilometre billing. Overtime applies only when shown in the selected package.');
  }
  rows.push(
    `A price is held for ${terms.estimateValidityMinutes} minutes. After that the trip is quoted again, and you are told before anything is booked.`,
  );
  return rows;
}

function knowledgeRows(service: BookingOptionService): string[] {
  const online = service.driversOnline;
  return [
    'Nothing is charged when you book. You pay for the trip after it is done.',
    `A pickup needs at least ${MIN_LEAD_MS / 60_000} minutes’ notice.`,
    'Only a driver whose documents an operator has approved can take you.',
    'A one-way fare covers your drop-off. If you want the driver to wait and bring you back, book it as a round trip.',
    'On a one-way drop, the driver’s meal and return travel are not included unless the quote explicitly lists them.',
    online > 0
      ? `${online} verified ${online === 1 ? 'driver is' : 'drivers are'} online for ${service.name} right now.`
      : `No ${service.name.toLowerCase()} driver is online at this moment — you can still book a time.`,
  ];
}

export function PricingSheet({
  service,
  tripDirection,
  open,
  onClose,
}: {
  service: BookingOptionService | null;
  tripDirection: TripDirection;
  open: boolean;
  onClose: () => void;
}) {
  const roundTrip = tripDirection === 'round_trip';
  const terms = service ? (roundTrip ? service.roundTripTerms : service.terms) : null;
  const pricing = service ? pricingRows(service, roundTrip) : [];
  const chart = chartRows(terms);

  return (
    <Sheet
      open={open && service !== null && pricing.length > 0}
      title="Pricing"
      subtitle={
        service
          ? `How a ${service.name.toLowerCase()} trip is priced${roundTrip ? ' as a round trip' : ''}.`
          : undefined
      }
      onClose={onClose}
    >
      {service ? (
        <>
          {chart.length > 0 ? (
            <>
              <Group title="DISTANCE BANDS" rows={chart} />
              <Divider size="sm" />
            </>
          ) : null}
          <Group title="PRICING" rows={pricing} />
          <Divider size="sm" />
          <Group title="THINGS TO KNOW" rows={knowledgeRows(service)} />
          <Text variant="caption" tone="faint">
            These are the terms of the price rule in force for {service.zoneId}. The fare card on the
            booking screen is the final word on what this trip costs.
          </Text>
        </>
      ) : null}
    </Sheet>
  );
}
