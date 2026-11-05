import { onCall } from 'firebase-functions/v2/https';
import {
  placeDetailInputSchema,
  placeSuggestionInputSchema,
  reverseGeocodeInputSchema,
  type PlaceResolvedResult,
  type PlaceSuggestionsResult,
} from '@drivx/domain';
import { CALLABLE_OPTIONS } from '../lib/config';
import { failedPrecondition, notFound, parseInput } from '../lib/errors';
import { requireCustomer, type Caller } from '../lib/guards';
import { placesIsConfigured, fetchPlaceDetail, placeFromPoint, suggestPlaces } from '../lib/places';

/**
 * Address search for the booking screen.
 *
 * These are the only three endpoints a customer needs to turn "the office gate"
 * into a coordinate the fare engine can price, and all three answer from the
 * server so no Places key ever ships in a bundle. Every one of them requires a
 * signed-in customer: search costs money per call, and an anonymous caller with
 * a script is the cheapest way to burn a budget.
 *
 * When no key is configured the search says so instead of returning an empty
 * list — "no results" and "search is off" are different things to a customer,
 * and only one of them means they should type something shorter.
 */

export async function searchPlacesForCaller(_caller: Caller, rawInput: unknown) {
  const input = parseInput(placeSuggestionInputSchema, rawInput);

  if (!placesIsConfigured()) {
    const result: PlaceSuggestionsResult = { suggestions: [], configured: false };
    return result;
  }

  const suggestions = await suggestPlaces(input.query, input.near);
  const result: PlaceSuggestionsResult = { suggestions, configured: true };
  return result;
}

export const searchPlaces = onCall(CALLABLE_OPTIONS, async (request) =>
  searchPlacesForCaller(requireCustomer(request), request.data),
);

export async function resolvePlaceForCaller(_caller: Caller, rawInput: unknown) {
  const input = parseInput(placeDetailInputSchema, rawInput);

  const place = await fetchPlaceDetail(input.placeId);
  if (!place) {
    // Not a not-found: the place exists, Google just did not give enough of an
    // address to send a driver to. The customer needs to pick a different row.
    throw failedPrecondition(
      'Google does not have a precise enough address for that result. Choose a different one.',
    );
  }

  const result: PlaceResolvedResult = { place };
  return result;
}

export const resolvePlace = onCall(CALLABLE_OPTIONS, async (request) =>
  resolvePlaceForCaller(requireCustomer(request), request.data),
);

export async function reverseGeocodeForCaller(_caller: Caller, rawInput: unknown) {
  const input = parseInput(reverseGeocodeInputSchema, rawInput);

  const place = await placeFromPoint({ lat: input.lat, lng: input.lng });
  if (!place) {
    throw notFound('Nothing addressable is at this location. Type an address instead.');
  }

  const result: PlaceResolvedResult = { place };
  return result;
}

export const reverseGeocode = onCall(CALLABLE_OPTIONS, async (request) =>
  reverseGeocodeForCaller(requireCustomer(request), request.data),
);
