import type { GeoPointLite } from './common';

/**
 * Geometry the platform needs on both sides of the wire, with no dependencies.
 *
 * A route distance normally comes from the Routes API, which costs money per
 * call and needs a key that is not provisioned yet. Straight-line distance is
 * not a substitute for a road distance — it is a floor — so every caller that
 * uses it has to keep `RouteResult.approximate` / `EtaEstimate.source` set to
 * `haversine_fallback` and say so on the fare card.
 */

const EARTH_RADIUS_METERS = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in whole metres. Same answer anywhere, no network. */
export function straightLineMeters(a: GeoPointLite, b: GeoPointLite): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const chord =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(chord))));
}
