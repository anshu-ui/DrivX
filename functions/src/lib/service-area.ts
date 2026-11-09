import { HttpsError } from 'firebase-functions/v2/https';
import { db } from './admin';

const DEFAULT_CITIES = ['Delhi', 'Gurugram', 'Noida', 'Greater Noida', 'Ghaziabad', 'Faridabad'];

function normalizeCity(value: string): string {
  return value.trim().toLocaleLowerCase('en-IN').replace(/[.,]/g, '').replace(/\s+/g, ' ');
}

const CITY_ALIASES: Record<string, string> = {
  'new delhi': 'delhi',
  'gurgaon': 'gurugram',
  'gautam buddha nagar': 'noida',
  'gb nagar': 'noida',
};

function canonical(value: string): string {
  const city = normalizeCity(value);
  return CITY_ALIASES[city] ?? city;
}

/** Server-side pickup availability. Drop-off may be anywhere. */
export async function assertPickupServiceable(cityValue: string): Promise<void> {
  const snapshot = await db().doc('appConfig/serviceArea').get();
  const data = snapshot.data() ?? {};
  const enabled = data.enabled !== false;
  const configured = Array.isArray(data.cities)
    ? data.cities.filter((city): city is string => typeof city === 'string' && city.trim().length > 0)
    : DEFAULT_CITIES;
  const requested = canonical(cityValue);
  const allowed = configured.some((city) => canonical(city) === requested);

  if (!enabled || !allowed) {
    const cities = configured.length ? configured.join(', ') : DEFAULT_CITIES.join(', ');
    throw new HttpsError(
      'failed-precondition',
      `DrivX pickup service is not available in ${cityValue || 'this area'} yet. It is currently available in: ${cities}. Drop-off can be outside this area.`,
    );
  }
}
