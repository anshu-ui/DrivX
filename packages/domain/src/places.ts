import { z } from 'zod';
import type { Place } from './common';

/**
 * Address search.
 *
 * A customer types words and the app needs a coordinate they can be charged
 * from. Only a server holding a Places key can turn words into a coordinate, so
 * these are the shapes that cross that boundary: a cheap suggestion list first,
 * and one exact address only when the customer actually picks it.
 */

export const placeSuggestionInputSchema = z.object({
  query: z.string().trim().min(2, 'Type at least two characters').max(120),
  /** Current position, used only to bias the ranking. Optional: a customer may search before location is granted. */
  near: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    })
    .nullish()
    .transform((v) => v ?? null),
});

export const placeDetailInputSchema = z.object({
  placeId: z.string().trim().min(4).max(120),
});

export const reverseGeocodeInputSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export type PlaceSuggestionInput = z.infer<typeof placeSuggestionInputSchema>;
export type PlaceDetailInput = z.infer<typeof placeDetailInputSchema>;
export type ReverseGeocodeInput = z.infer<typeof reverseGeocodeInputSchema>;

/**
 * One row in the search sheet.
 *
 * Deliberately text-only: it carries no coordinate, because a prediction's
 * position is not a fact until the place is resolved. Pricing never reads this.
 */
export type PlaceSuggestion = {
  placeId: string;
  /** The place name, e.g. "IGI Airport Terminal 3". */
  mainText: string;
  /** The context line, e.g. "Delhi, 110037, India". */
  secondaryText: string;
  /** What Google called it when matching, for disambiguation. */
  fullText: string;
};

export type PlaceSuggestionsResult = {
  suggestions: PlaceSuggestion[];
  /** False when no Places key is configured, so the UI says "search unavailable" rather than "no results". */
  configured: boolean;
};

export type PlaceResolvedResult = {
  place: Place;
};
