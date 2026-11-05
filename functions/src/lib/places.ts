import { type GeoPointLite, type Place, type PlaceSuggestion } from '@drivx/domain';
import { db, increment } from './admin';
import { resourceExhausted, unavailable } from './errors';

/**
 * Turning words and coordinates into addresses a fare can be priced from.
 *
 * Three Google calls, each with one job: autocomplete ranks text into candidate
 * places, place details turn one chosen candidate into an exact address and
 * coordinate, and reverse geocoding labels the position the device already has.
 *
 * The split between the first two is the cost shape. Autocomplete is the cheap
 * SKU and is called on every keystroke, so it returns text only — no coordinate,
 * nothing a fare could be built from. Details are called once, when the customer
 * actually taps a row. A UI that resolved every suggestion would pay the
 * expensive SKU five times to discard four.
 *
 * Credentials: `GOOGLE_MAPS_SERVER_API_KEY` in `functions/.env`, restricted to
 * Places API (New) and Geocoding API (see `docs/google-maps.md` §2). It never
 * leaves the server; a device that could read it could spend against it.
 */

const AUTOCOMPLETE_ENDPOINT = 'https://places.googleapis.com/v1/places:autocomplete';
const AUTOCOMPLETE_MASK =
  'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat';
const DETAIL_MASK =
  'id,displayName,formattedAddress,shortFormattedAddress,location,addressComponents,types';
const GEOCODE_ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';
const PLACES_TIMEOUT_MS = 3500;
const MAX_SUGGESTIONS = 8;
const MIN_QUERY_LENGTH = 2;

export function placesIsConfigured(): boolean {
  return Boolean(process.env.GOOGLE_MAPS_SERVER_API_KEY?.trim());
}

/**
 * Per-day spend ceiling, enforced here rather than hoped for in the console.
 *
 * `MAPS_DAILY_REQUEST_LIMIT` sits next to the keys in `.env`. A runaway client
 * typing in a search box is the case it exists for, so every Maps call counts
 * against it and the refusal is a normal, explainable error code.
 */
async function chargeBudget(sku: string): Promise<void> {
  const limit = Number(process.env.MAPS_DAILY_REQUEST_LIMIT ?? 0);
  if (!Number.isFinite(limit) || limit <= 0) return;

  const day = new Date().toISOString().slice(0, 10);
  const ref = db().doc(`usage/maps-${day}`);
  // A nested merge, not a dotted key: `set()` treats "calls.sku" as a literal
  // field name, which would store a flat key and leave every later read looking
  // at a map that was never written.
  await ref.set({ day, calls: { [sku]: increment(1) } }, { merge: true });
  const after = await ref.get();
  const calls = (after.data()?.calls ?? {}) as Record<string, number>;
  const total = Object.values(calls).reduce((sum, count) => sum + (Number(count) || 0), 0);
  if (total > limit) {
    console.warn(
      JSON.stringify({ level: 'warn', fn: 'places', outcome: 'budget_exceeded', sku, total, limit }),
    );
    throw resourceExhausted(
      'The address search limit for today has been reached. Try again tomorrow, or pick from your saved places.',
    );
  }
}

function timeoutSignal(): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLACES_TIMEOUT_MS);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function describeError(response: Response): Promise<string> {
  const detail = (await response.json().catch(() => null)) as {
    error?: { message?: string };
    error_message?: string;
    status?: string;
  } | null;
  const message = detail?.error?.message ?? detail?.error_message ?? detail?.status ?? '';
  return `HTTP ${response.status}${message ? ` — ${message}` : ''}`;
}

/** Google's own status strings that mean "nobody typed enough yet". */
function noResultsStatus(status: string | undefined): boolean {
  return status === 'ZERO_RESULTS' || status === 'INVALID_REQUEST';
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

type Component = {
  types?: string[];
  /** Places details send a string; autocomplete predictions send `{ text }`. */
  longText?: string | { text?: string };
  /** Legacy Geocoding names the same thing `long_name`. */
  long_name?: string;
};

function componentText(value: Component['longText']): string {
  if (typeof value === 'string') return value.trim();
  return typeof value?.text === 'string' ? value.text.trim() : '';
}

/**
 * The first component carrying one of these types, in the given preference
 * order. Three shapes for one idea across the APIs used here, so the shape is
 * normalised once and the type list stays the only thing a caller has to know.
 */
function pick(components: Component[], ...types: string[]): string {
  for (const type of types) {
    const found = components.find((c) => Array.isArray(c.types) && c.types.includes(type));
    const value = componentText(found?.longText) || (found?.long_name ?? '').trim();
    if (value) return value;
  }
  return '';
}

function pincodeOf(components: Component[]): string | undefined {
  const raw = pick(components, 'postal_code');
  return /^\d{6}$/.test(raw) ? raw : undefined;
}

function pointOf(raw: unknown): GeoPointLite | null {
  const loc = raw as { latitude?: number; lng?: number; longitude?: number } | undefined;
  const lat = typeof loc?.latitude === 'number' ? loc.latitude : Number.NaN;
  const lng =
    typeof loc?.lng === 'number' ? loc.lng : typeof loc?.longitude === 'number' ? loc.longitude : Number.NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/**
 * Turns one Google address payload into the app's `Place`.
 *
 * `city` and `state` are required by the domain record, and an Indian address
 * from either API always has a locality and a state — so a response that
 * genuinely lacks both is treated as unusable rather than filled with a
 * placeholder the customer would then be charged a route to.
 */
function toPlace(input: {
  placeId: string;
  label: string;
  line1: string;
  components: Component[];
  location: GeoPointLite | null;
  source: Place['source'];
}): Place | null {
  if (!input.location) return null;
  const city = pick(
    input.components,
    'locality',
    'sublocality_level_1',
    'administrative_area_level_3',
    'administrative_area_level_2',
  );
  const state = pick(input.components, 'administrative_area_level_1');
  const label = input.label || input.line1;
  if (!city || !state || label.length < 4) return null;

  const street = pick(input.components, 'route');
  const number = pick(input.components, 'street_number');
  return {
    label,
    addressLine1: input.line1 || (street ? `${number ? `${number} ` : ''}${street}` : label),
    city,
    state,
    pincode: pincodeOf(input.components),
    location: input.location,
    placeId: input.placeId || undefined,
    source: input.source,
  };
}

/**
 * Ranked address candidates for a partial query.
 *
 * Text only by design. A suggestion whose coordinate is not shown is also a
 * suggestion nobody can accidentally price from.
 */
export async function suggestPlaces(
  query: string,
  near: GeoPointLite | null,
): Promise<PlaceSuggestion[]> {
  const key = process.env.GOOGLE_MAPS_SERVER_API_KEY?.trim();
  if (!key) throw unavailable('Address search is not configured on this deployment.');
  if (query.trim().length < MIN_QUERY_LENGTH) return [];

  await chargeBudget('places_autocomplete');
  const { signal, done } = timeoutSignal();
  try {
    const response = await fetch(AUTOCOMPLETE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': AUTOCOMPLETE_MASK,
      },
      body: JSON.stringify({
        input: query.trim(),
        languageCode: 'en',
        regionCode: 'IN',
        // Ranked near the customer when the app has a fix, without restricting
        // to it — a Gurugram customer booking an Delhi pickup must still see it.
        ...(near
          ? { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 50000 } } }
          : {}),
      }),
      signal,
    });
    if (!response.ok) throw new Error(await describeError(response));

    const body = (await response.json()) as {
      suggestions?: {
        placePrediction?: {
          placeId?: string;
          text?: { text?: string };
          structuredFormat?: {
            mainText?: { text?: string };
            secondaryText?: { text?: string };
          };
        };
      }[];
    };

    const out: PlaceSuggestion[] = [];
    for (const s of body.suggestions ?? []) {
      const prediction = s.placePrediction;
      const placeId = str(prediction?.placeId);
      const fullText = str(prediction?.text?.text);
      if (!placeId || !fullText) continue;
      out.push({
        placeId,
        mainText: str(prediction?.structuredFormat?.mainText?.text) || fullText,
        secondaryText: str(prediction?.structuredFormat?.secondaryText?.text),
        fullText,
      });
      if (out.length >= MAX_SUGGESTIONS) break;
    }
    console.log(
      JSON.stringify({
        level: 'info',
        fn: 'suggestPlaces',
        outcome: 'ok',
        sku: 'places_autocomplete',
        results: out.length,
        biased: near !== null,
      }),
    );
    return out;
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        fn: 'suggestPlaces',
        outcome: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    throw unavailable('Address search is not answering right now. Pick a saved place or try again.');
  } finally {
    done();
  }
}

/** One place id, resolved to an exact address and coordinate. */
export async function fetchPlaceDetail(placeId: string): Promise<Place | null> {
  const key = process.env.GOOGLE_MAPS_SERVER_API_KEY?.trim();
  if (!key) throw unavailable('Address search is not configured on this deployment.');

  await chargeBudget('places_details');
  const { signal, done } = timeoutSignal();
  try {
    const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(
      placeId,
    )}?languageCode=en&regionCode=IN`;
    const response = await fetch(url, {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': DETAIL_MASK },
      signal,
    });
    if (!response.ok) throw new Error(await describeError(response));

    const body = (await response.json()) as {
      id?: string;
      displayName?: { text?: string };
      formattedAddress?: string;
      shortFormattedAddress?: string;
      location?: unknown;
      addressComponents?: Component[];
    };
    // `displayName` can be as thin as "Terminal 3", which is a name, not a place
    // a driver can find. The single-line address is what the customer reads.
    const name = str(body.displayName?.text);
    const address = str(body.formattedAddress);
    const place = toPlace({
      placeId: str(body.id) || placeId,
      label: address || name,
      line1: str(body.shortFormattedAddress) || address,
      components: Array.isArray(body.addressComponents) ? body.addressComponents : [],
      location: pointOf(body.location),
      source: 'places_autocomplete',
    });
    console.log(
      JSON.stringify({
        level: 'info',
        fn: 'fetchPlaceDetail',
        outcome: place ? 'ok' : 'incomplete_address',
        sku: 'places_details',
      }),
    );
    return place;
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        fn: 'fetchPlaceDetail',
        outcome: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    throw unavailable('That address could not be resolved. Choose another result.');
  } finally {
    done();
  }
}

/**
 * The address a position already sits on.
 *
 * Used for "current location" rows. Geocoding rather than Places, because there
 * is no query to autocomplete and the reverse method in Places (New) is not
 * enabled on this project.
 */
export async function placeFromPoint(point: GeoPointLite): Promise<Place | null> {
  const key = process.env.GOOGLE_MAPS_SERVER_API_KEY?.trim();
  if (!key) throw unavailable('Address lookup is not configured on this deployment.');

  await chargeBudget('geocoding_reverse');
  const { signal, done } = timeoutSignal();
  try {
    const params = new URLSearchParams({
      latlng: `${point.lat},${point.lng}`,
      language: 'en',
      // The most specific result Google has for the point; without this the first
      // row is often a city, which is not an address a driver can be sent to.
      result_type: 'street_address',
      key,
    });
    const response = await fetch(`${GEOCODE_ENDPOINT}?${params.toString()}`, { signal });
    if (!response.ok) throw new Error(await describeError(response));

    const body = (await response.json()) as {
      status?: string;
      results?: {
        formatted_address?: string;
        address_components?: Component[];
        geometry?: { location?: unknown };
      }[];
    };
    if (noResultsStatus(body.status)) return null;

    // A street-number result rarely exists for a raw GPS fix, so the same
    // reader is retried against whatever Google returned first.
    const candidates = [
      ...(Array.isArray(body.results) ? body.results : []),
    ];
    for (const result of candidates) {
      const place = toPlace({
        placeId: '',
        label: str(result.formatted_address),
        line1: '',
        components: Array.isArray(result.address_components) ? result.address_components : [],
        location: pointOf(result.geometry?.location) ?? point,
        source: 'reverse_geocode',
      });
      if (place) {
        console.log(
          JSON.stringify({ level: 'info', fn: 'placeFromPoint', outcome: 'ok', sku: 'geocoding_reverse' }),
        );
        // The coordinate stays the device's own; a rounded address from Google
        // must not silently move the pickup the customer is standing at.
        return { ...place, location: point };
      }
    }
    console.warn(
      JSON.stringify({ level: 'warn', fn: 'placeFromPoint', outcome: 'no_usable_result' }),
    );
    return null;
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        fn: 'placeFromPoint',
        outcome: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    throw unavailable('Could not name this location. You can still type an address.');
  } finally {
    done();
  }
}
