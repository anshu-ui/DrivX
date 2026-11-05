import { useMutation, useQuery } from '@tanstack/react-query';
import * as Location from 'expo-location';
import {
  placeDetailInputSchema,
  placeSuggestionInputSchema,
  reverseGeocodeInputSchema,
  type GeoPointLite,
  type Place,
  type PlaceResolvedResult,
  type PlaceSuggestion,
  type PlaceSuggestionsResult,
} from '@drivx/domain';
import { FunctionCallError, callFunction } from '@drivx/firebase-client';
import { firebase } from '../../lib/firebase';

/**
 * Address search for the booking composer.
 *
 * Three calls behind one seam, and none of them can produce a fare: the search
 * returns text, the resolution returns an address, and only the composer's own
 * draft turns either into a `Place` that `quoteFare` will price. A client cannot
 * invent a coordinate and hand it to the fare engine, because the coordinate it
 * sends is checked against the road distance, not trusted as an address.
 *
 * Failures are returned, not thrown, so a search sheet can say "search is not
 * answering" in the same breath as "type at least two characters".
 */

export type SearchOutcome =
  | { failed: false; suggestions: PlaceSuggestion[]; configured: boolean }
  | { failed: true; error: FunctionCallError };

export function usePlaceSearch(rawQuery: string, near: GeoPointLite | null) {
  const query = rawQuery.trim();
  const parsed = placeSuggestionInputSchema.safeParse({ query, near });

  return useQuery({
    queryKey: ['placeSearch', query, near ? `${near.lat.toFixed(3)},${near.lng.toFixed(3)}` : 'far'],
    enabled: parsed.success,
    staleTime: 60_000,
    // Retrying the same words within five minutes costs nothing. The sheet owns
    // the debounce, because a keystroke-per-call search sheet is the most
    // expensive screen in the app.
    gcTime: 5 * 60_000,
    queryFn: async (): Promise<SearchOutcome> => {
      try {
        const data = await callFunction<typeof parsed.data, PlaceSuggestionsResult>(
          firebase(),
          'searchPlaces',
          parsed.success ? parsed.data : { query: '', near: null },
        );
        return { failed: false, suggestions: data.suggestions, configured: data.configured };
      } catch (error) {
        if (error instanceof FunctionCallError) return { failed: true, error };
        throw error;
      }
    },
  });
}

export type ResolveOutcome =
  | { failed: false; place: Place }
  | { failed: true; error: FunctionCallError };

/** One suggestion, tapped: this is the only moment a coordinate enters the app. */
export function useResolvePlace() {
  return useMutation<ResolveOutcome, Error, string>({
    mutationFn: async (placeId: string): Promise<ResolveOutcome> => {
      const input = placeDetailInputSchema.safeParse({ placeId });
      if (!input.success) throw new Error('That result is not a usable place. Search again.');
      try {
        const data = await callFunction<typeof input.data, PlaceResolvedResult>(
          firebase(),
          'resolvePlace',
          input.data,
        );
        return { failed: false, place: data.place };
      } catch (error) {
        if (error instanceof FunctionCallError) return { failed: true, error };
        throw error;
      }
    },
  });
}

/**
 * The device's own position, asked for once per sheet opening.
 *
 * Denied permission is a normal answer, not an error to retry: the sheet falls
 * back to typed search and says why the current-location row is missing.
 */
export async function devicePosition(): Promise<GeoPointLite | null> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted) return null;
  // A fresh fix can take seconds indoors; the last known position is good enough
  // to bias a search, and the address row it produces is re-resolved on tap.
  const known = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60 * 1000 });
  const fix = known ?? (await Location.getCurrentPositionAsync({}));
  return { lat: fix.coords.latitude, lng: fix.coords.longitude };
}

export function useCurrentLocationPlace() {
  return useMutation<ResolveOutcome, Error, GeoPointLite>({
    mutationFn: async (point: GeoPointLite): Promise<ResolveOutcome> => {
      const input = reverseGeocodeInputSchema.safeParse(point);
      if (!input.success) throw new Error('That position is not usable.');
      try {
        const data = await callFunction<typeof input.data, PlaceResolvedResult>(
          firebase(),
          'reverseGeocode',
          input.data,
        );
        return { failed: false, place: data.place };
      } catch (error) {
        if (error instanceof FunctionCallError) return { failed: true, error };
        throw error;
      }
    },
  });
}
