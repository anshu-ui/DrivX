import { Linking } from 'react-native';
import { callFunction } from '@drivx/firebase-client';
import { firebase } from '../lib/firebase';

export type TripInvoiceSide = 'customer' | 'driver';

/** Opens the server-authorized, short-lived PDF URL for the signed-in trip participant. */
export async function openTripInvoice(bookingId: string, side: TripInvoiceSide): Promise<void> {
  const result = await callFunction<{ bookingId: string; side: TripInvoiceSide }, { url: string; expiresAtMs: number }>(
    firebase(),
    'getTripInvoiceDownloadUrl',
    { bookingId, side },
  );
  await Linking.openURL(result.url);
}
