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
  it('default to the configured 13% commission, 18% GST and 1% TDS', () => {
    expect(COMMISSION_TERMS).toMatchObject({ kind: 'commission', rate: 0.13, gstRate: 0.18, tdsRate: 0.01 });
  });

  it('calculates commission GST and TDS from the configured commission rate', () => {
    expect(commissionDueFor(96_000)).toEqual({
      rate: 0.13,
      basePaise: 12_480,
      gstPaise: 2_246,
      fareTaxPaise: 0,
      tdsRate: 0.01,
      tdsBasePaise: 83_520,
      tdsPaise: 835,
      totalPaise: 15_561,
    });
  });

  it('take the rate as an argument, so the office can set another', () => {
    expect(commissionDueFor(96_000, 0.15, 0.05)).toEqual({
      rate: 0.15,
      basePaise: 14_400,
      gstPaise: 720,
      fareTaxPaise: 0,
      tdsRate: 0.01,
      tdsBasePaise: 81_600,
      tdsPaise: 816,
      totalPaise: 15_936,
    });
    expect(commissionDueFor(96_000, 0)).toEqual({
      rate: 0,
      basePaise: 0,
      gstPaise: 0,
      fareTaxPaise: 0,
      tdsRate: 0.01,
      tdsBasePaise: 96_000,
      tdsPaise: 960,
      totalPaise: 960,
    });
  });

  it('leave exactly 87% of the fare with the driver at the default', () => {
    const { basePaise } = commissionDueFor(96_000);
    expect(96_000 - basePaise).toBe(Math.round(96_000 * 0.87));
  });

  it('round each line to whole paise, once', () => {
    // ₹1.00 fare: commission 13 paise, GST 2 paise and TDS 1 paise.
    expect(commissionDueFor(100, 0.13, 0.18, 0, 0.01)).toEqual({
      rate: 0.13, basePaise: 13, gstPaise: 2, fareTaxPaise: 0,
      tdsRate: 0.01, tdsBasePaise: 87, tdsPaise: 1, totalPaise: 16,
    });
    expect(commissionDueFor(0)).toEqual({
      rate: 0.13, basePaise: 0, gstPaise: 0, fareTaxPaise: 0,
      tdsRate: 0.01, tdsBasePaise: 0, tdsPaise: 0, totalPaise: 0,
    });
  });

  it('adds up, because the driver is shown every line', () => {
    for (const subtotal of [1, 99, 5_000, 96_000, 12_34_567]) {
      const due = commissionDueFor(subtotal);
      expect(due.totalPaise).toBe(due.basePaise + due.gstPaise + due.fareTaxPaise + due.tdsPaise);
    }
  });

  it('matches the ₹1,000 fare example and recalculates remaining-share TDS when commission changes', () => {
    expect(commissionDueFor(100_000, 0.13, 0.18, 5_000, 0.01)).toMatchObject({
      basePaise: 13_000, gstPaise: 2_340, fareTaxPaise: 5_000,
      tdsBasePaise: 87_000, tdsPaise: 870, totalPaise: 21_210,
    });
    expect(commissionDueFor(100_000, 0.15, 0.18, 5_000, 0.01)).toMatchObject({
      basePaise: 15_000, gstPaise: 2_700, fareTaxPaise: 5_000,
      tdsBasePaise: 85_000, tdsPaise: 850, totalPaise: 23_550,
    });
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
  it('carries commission, both tax bases, and the rate snapshots', () => {
    const receipt = fare(100_000, [line('slab_fare', 90_000), line('platform_fee', 10_000)]);
    expect(commissionSnapshotFor(receipt, 0.15, 0.18)).toEqual({
      rate: 0.15,
      gstRate: 0.18,
      fareTaxPaise: 5_000,
      fareTaxRate: 0.05,
      tdsRate: 0.01,
      tdsBasePaise: 76_500,
      tdsPaise: 765,
      commissionablePaise: 90_000,
      basePaise: 13_500,
      gstPaise: 2_430,
      totalPaise: 21_695,
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
    expect(commissionTitleFor('DRX-7K3QD2')).toBe('Driver remittance for trip DRX-7K3QD2');
  });
});

describe('driver trip split', () => {
  it('hands the driver everything the ledger did not take', () => {
    // ₹960 fare + ₹48 customer GST, less commission, commission GST, pass-through GST and TDS.
    const receipt = fare(96_000);
    expect(driverTripSplitFor(receipt, commissionSnapshotFor(receipt))).toEqual({
      fareTotalPaise: 100_800,
      gstPaise: 4_800,
      rate: 0.13,
      gstRate: 0.18,
      commissionPaise: 12_480,
      commissionBasePaise: 12_480,
      commissionGstPaise: 2_246,
      fareTaxPaise: 4_800,
      fareTaxRate: 0.05,
      tdsBasePaise: 83_520,
      tdsRate: 0.01,
      tdsPaise: 835,
      totalDuePaise: 20_361,
      netPaise: 80_439,
    });
  });

  it('agrees with the charge that gets raised, on every fare', () => {
    for (const subtotal of [1, 99, 5_000, 96_000, 12_34_567]) {
      const receipt = fare(subtotal);
      const split = driverTripSplitFor(receipt, commissionSnapshotFor(receipt));
      expect(split?.totalDuePaise).toBe(commissionSnapshotFor(receipt).totalPaise);
      expect(split!.netPaise + split!.totalDuePaise).toBe(split!.fareTotalPaise);
    }
  });

  it('keeps the rate the trip was billed at, not the one the office sets later', () => {
    const receipt = fare(96_000);
    const billedAt15 = commissionSnapshotFor(receipt, 0.15, 0.18);
    expect(driverTripSplitFor(receipt, billedAt15)).toMatchObject({
      rate: 0.15,
      commissionPaise: 14_400,
      commissionGstPaise: 2_592,
      tdsBasePaise: 81_600,
      tdsPaise: 816,
      totalDuePaise: 22_608,
      netPaise: 78_192,
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
      gstRate: 0.18,
      commissionPaise: 0,
      commissionBasePaise: 0,
      commissionGstPaise: 0,
      fareTaxPaise: 0,
      fareTaxRate: 0,
      tdsBasePaise: 0,
      tdsRate: 0.01,
      tdsPaise: 0,
      totalDuePaise: 0,
      netPaise: 0,
    });
  });
});
