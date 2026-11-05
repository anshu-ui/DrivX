import { describe, expect, it } from 'vitest';

import {
  COMMISSION_TERMS,
  NON_COMMISSIONABLE_FARE_LINES,
  ONBOARDING_FEE,
  ONBOARDING_FEE_TOTAL_PAISE,
  commissionDueFor,
  commissionDueId,
  commissionRateFrom,
  commissionSnapshotFor,
  commissionablePaise,
  driverTripSplitFor,
  commissionTitleFor,
  readCommissionSnapshot,
} from '../src/records-identity';
import type { MoneyPaise } from '../src/common';
import { DRIVER_DUE_KINDS } from '../src/enums';
import type { FareBreakdown, FareLineItem } from '../src/records-trip';

type Receipt = Pick<FareBreakdown, 'items' | 'subtotalPaise' | 'taxPaise' | 'totalPaise'>;

function line(key: FareLineItem['key'], amountPaise: number): FareLineItem {
  return { key, label: key, amountPaise: amountPaise as MoneyPaise };
}

/**
 * A receipt the way the fare engine builds one: the named lines add up to the
 * subtotal, and GST sits on top of it.
 */
function fare(subtotalPaise: number, lines?: FareLineItem[]): Receipt {
  const items = lines ?? [line('slab_fare', subtotalPaise)];
  const taxPaise = Math.round(subtotalPaise * 0.05);
  return {
    items,
    subtotalPaise: subtotalPaise as MoneyPaise,
    taxPaise: taxPaise as MoneyPaise,
    totalPaise: (subtotalPaise + taxPaise) as MoneyPaise,
  };
}

describe('driver due kinds', () => {
  it('bills both the one-time fee and a per-booking commission', () => {
    expect(DRIVER_DUE_KINDS).toEqual(['onboarding_fee', 'commission', 'late_arrival_penalty']);
  });

  it('defaults the onboarding fee to ₹500 plus 5% GST', () => {
    expect(ONBOARDING_FEE).toMatchObject({ basePaise: 50_000, gstRate: 0.05 });
    expect(ONBOARDING_FEE_TOTAL_PAISE).toBe(52_500);
  });
});

describe('commission terms', () => {
  it('default to the configured 13% commission with no assumed tax', () => {
    expect(COMMISSION_TERMS).toMatchObject({ kind: 'commission', rate: 0.13, gstRate: 0 });
  });

  it('charge the default 13% on a ₹960.00 trip without assumed tax', () => {
    expect(commissionDueFor(96_000)).toEqual({
      rate: 0.13,
      basePaise: 12_480,
      gstPaise: 0,
      totalPaise: 12_480,
    });
  });

  it('take the rate as an argument, so the office can set another', () => {
    expect(commissionDueFor(96_000, 0.15, 0.05)).toEqual({
      rate: 0.15,
      basePaise: 14_400,
      gstPaise: 720,
      totalPaise: 15_120,
    });
    expect(commissionDueFor(96_000, 0)).toEqual({
      rate: 0,
      basePaise: 0,
      gstPaise: 0,
      totalPaise: 0,
    });
  });

  it('leave exactly 87% of the fare with the driver at the default', () => {
    const { basePaise } = commissionDueFor(96_000);
    expect(96_000 - basePaise).toBe(Math.round(96_000 * 0.87));
  });

  it('round each line to whole paise, once', () => {
    // ₹1.00 trip: 13 paise of commission, 0.65 paise of GST → 1, never 0.
    expect(commissionDueFor(100, 0.13, 0.05)).toEqual({ rate: 0.13, basePaise: 13, gstPaise: 1, totalPaise: 14 });
    expect(commissionDueFor(0)).toEqual({ rate: 0.13, basePaise: 0, gstPaise: 0, totalPaise: 0 });
  });

  it('adds up, because the driver is shown every line', () => {
    for (const subtotal of [1, 99, 5_000, 96_000, 12_34_567]) {
      const due = commissionDueFor(subtotal);
      expect(due.totalPaise).toBe(due.basePaise + due.gstPaise);
    }
  });
});

describe('the commissionable base', () => {
  it('is the whole subtotal when every line is fare', () => {
    const receipt = fare(96_000, [
      line('slab_fare', 70_000),
      line('night_surcharge', 15_000),
      line('surge', 7_000),
      line('minimum_fare', 4_000),
    ]);
    expect(commissionablePaise(receipt)).toBe(96_000);
  });

  it('excludes the platform fee, so a driver never pays a share of a share', () => {
    const receipt = fare(100_000, [line('package', 91_000), line('platform_fee', 9_000)]);
    expect(commissionablePaise(receipt)).toBe(91_000);
    expect(commissionSnapshotFor(receipt).basePaise).toBe(Math.round(91_000 * 0.13));
  });

  it('excludes a cancellation fee, which is not a fare at all', () => {
    const receipt = fare(31_500, [line('slab_fare', 1_500), line('cancellation_fee', 30_000)]);
    expect(commissionablePaise(receipt)).toBe(1_500);
  });

  it('never reaches for the GST, because the base is the subtotal', () => {
    const receipt = fare(96_000);
    expect(commissionablePaise(receipt)).toBe(96_000);
    expect(commissionablePaise(receipt)).not.toBe(receipt.totalPaise);
  });

  it('names the two excluded lines and nothing else', () => {
    expect(NON_COMMISSIONABLE_FARE_LINES).toEqual(['platform_fee', 'cancellation_fee']);
  });
});

describe('the commission snapshot stored on a booking', () => {
  it('carries the rate, the base and the three money lines', () => {
    const receipt = fare(100_000, [line('slab_fare', 90_000), line('platform_fee', 10_000)]);
    expect(commissionSnapshotFor(receipt, 0.15, 0.05)).toEqual({
      rate: 0.15,
      gstRate: 0.05,
      commissionablePaise: 90_000,
      basePaise: 13_500,
      gstPaise: 675,
      totalPaise: 14_175,
    });
  });

  it('falls back to the configured default when no rate is passed', () => {
    expect(commissionSnapshotFor(fare(96_000)).rate).toBe(COMMISSION_TERMS.rate);
  });

  it('survives a round trip through Firestore unchanged', () => {
    const snapshot = commissionSnapshotFor(fare(123_456), 0.11);
    expect(readCommissionSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it('refuses a block whose parts do not add up', () => {
    expect(
      readCommissionSnapshot({
        rate: 0.13,
        gstRate: 0.05,
        commissionablePaise: 96_000,
        basePaise: 12_480,
        gstPaise: 624,
        // 12.48 + 6.24 is 13.104, not this.
        totalPaise: 14_000,
      }),
    ).toBeNull();
  });

  it('refuses a rate that is not a fraction, and a block that is not a block', () => {
    expect(readCommissionSnapshot(null)).toBeNull();
    expect(readCommissionSnapshot('commission')).toBeNull();
    expect(readCommissionSnapshot({ rate: '0.13' })).toBeNull();
    expect(readCommissionSnapshot({ ...commissionSnapshotFor(fare(96_000)), basePaise: -1 })).toBeNull();
  });

  it('accepts a zero rate, because taking nothing is a decision an office can make', () => {
    const snapshot = commissionSnapshotFor(fare(96_000), 0);
    expect(readCommissionSnapshot(snapshot)).toEqual(snapshot);
  });
});

describe('commissionRateFrom', () => {
  it.each([
    [0, 0],
    [0.13, 0.13],
    [1, 1],
  ])('accepts the fraction %p', (input, expected) => {
    expect(commissionRateFrom(input)).toBe(expected);
  });

  it.each([[-0.01], [1.5], ['0.13'], [Number.NaN], [undefined], [null], [{}]])(
    'refuses %p rather than bill a nonsense rate',
    (input) => {
      expect(commissionRateFrom(input)).toBeNull();
    },
  );
});

describe('commission due ids', () => {
  const bookingId = 'bk-3f2a7c1e-9b4d-4e6a-8f21-0c5d7e9a1b3c';

  it('are derived from the booking so a retried trigger cannot bill twice', () => {
    expect(commissionDueId(bookingId)).toBe(`commission_${bookingId}`);
    expect(commissionDueId(bookingId)).toBe(commissionDueId(bookingId));
  });

  it('fit the id limit the console and the rules accept', () => {
    expect(commissionDueId(bookingId).length).toBeLessThanOrEqual(64);
  });

  it('name the trip on the row the driver reads', () => {
    expect(commissionTitleFor('DRX-7K3QD2')).toBe('Commission on trip DRX-7K3QD2');
  });
});

describe('driver trip split', () => {
  it('hands the driver everything the ledger did not take', () => {
    // A ₹960.00 fare plus its separately-stored tax; default commission has no assumed tax.
    const receipt = fare(96_000);
    expect(driverTripSplitFor(receipt, commissionSnapshotFor(receipt))).toEqual({
      fareTotalPaise: 100_800,
      gstPaise: 4_800,
      rate: 0.13,
      gstRate: 0,
      commissionPaise: 12_480,
      netPaise: 88_320,
    });
  });

  it('agrees with the charge that gets raised, on every fare', () => {
    for (const subtotal of [1, 99, 5_000, 96_000, 12_34_567]) {
      const receipt = fare(subtotal);
      const split = driverTripSplitFor(receipt, commissionSnapshotFor(receipt));
      expect(split?.commissionPaise).toBe(commissionSnapshotFor(receipt).totalPaise);
      expect(split!.netPaise + split!.commissionPaise).toBe(split!.fareTotalPaise);
    }
  });

  it('keeps the rate the trip was billed at, not the one the office sets later', () => {
    const receipt = fare(96_000);
    const billedAt15 = commissionSnapshotFor(receipt, 0.15, 0.05);
    expect(driverTripSplitFor(receipt, billedAt15)).toMatchObject({
      rate: 0.15,
      commissionPaise: 15_120,
      netPaise: 100_800 - 15_120,
    });
  });

  it('shows nothing rather than a guessed rate on a trip with no terms', () => {
    expect(driverTripSplitFor(fare(96_000), null)).toBeNull();
    expect(driverTripSplitFor(fare(96_000), undefined)).toBeNull();
  });

  it('leaves a zero-fare trip at zero rather than owing the platform', () => {
    const receipt = fare(0);
    expect(driverTripSplitFor(receipt, commissionSnapshotFor(receipt))).toEqual({
      fareTotalPaise: 0,
      gstPaise: 0,
      rate: 0.13,
      gstRate: 0,
      commissionPaise: 0,
      netPaise: 0,
    });
  });
});
