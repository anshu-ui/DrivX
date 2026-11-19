import Constants from 'expo-constants';
import { createElement } from 'react';
import { AppleMaps, GoogleMaps } from 'expo-maps';
import { Platform, View } from 'react-native';
import { Card, Text, useTheme } from '@drivx/ui';
import type { Place } from '@drivx/domain';
import type { LiveDriverFix } from './liveLocation';

function coordinates(place: Place | null | undefined) {
  return place ? { latitude: place.location.lat, longitude: place.location.lng } : null;
}

export function TripMapPanel({
  pickup,
  destination,
  driverFix,
  customerFix,
  routePolyline,
  routeMode = 'trip',
  driverTitle = 'Your driver',
  title = 'Trip map',
  height = 230,
  compact = false,
}: {
  pickup: Place | null | undefined;
  destination: Place | null | undefined;
  driverFix?: LiveDriverFix | null;
  customerFix?: LiveDriverFix | null;
  routePolyline?: string | null;
  /** Focus the current driver-to-pickup route before the trip begins. */
  routeMode?: 'pickup' | 'trip';
  driverTitle?: string;
  title?: string;
  height?: number;
  /** Immersive, map-first variant used by the customer booking screen. */
  compact?: boolean;
}) {
  const theme = useTheme();
  const pickupPoint = coordinates(pickup);
  const destinationPoint = coordinates(destination);
  const driverPoint = driverFix ? { latitude: driverFix.lat, longitude: driverFix.lng } : null;
  const customerPoint = customerFix ? { latitude: customerFix.lat, longitude: customerFix.lng } : null;
  const routeCoordinates = decodePolyline(routePolyline);
  const polylines = routeCoordinates.length > 1
    ? [{ id: 'trip-route', coordinates: routeCoordinates, color: theme.colors.primary, width: 6 }]
    : [];
  // While the driver is travelling to pickup, frame that road route. Including
  // the trip destination here zoomed the customer out to the entire journey and
  // made the live driver-to-pickup preview unreadable.
  const routeBounds = routeMode === 'pickup'
    ? [...routeCoordinates, pickupPoint].filter((point) => point !== null)
    : [pickupPoint, destinationPoint, ...routeCoordinates].filter((point) => point !== null);
  const points = routeBounds.length > 1 ? routeBounds : [pickupPoint, destinationPoint].filter((point) => point !== null);

  // The first booking frame still shows a usable city map before the customer
  // chooses an address. This is only the launch-area camera centre; no pin or
  // current-location claim is rendered until we have a real coordinate.
  const latitudes = points.map((point) => point.latitude);
  const longitudes = points.map((point) => point.longitude);
  const latitudeSpread = latitudes.length ? Math.max(...latitudes) - Math.min(...latitudes) : 0;
  const longitudeSpread = longitudes.length ? Math.max(...longitudes) - Math.min(...longitudes) : 0;
  const centre = points.length
    ? { latitude: (Math.max(...latitudes) + Math.min(...latitudes)) / 2, longitude: (Math.max(...longitudes) + Math.min(...longitudes)) / 2 }
    : { latitude: 28.4595, longitude: 77.0266 };
  const spread = Math.max(latitudeSpread, longitudeSpread);
  const zoom = spread < 0.012 ? 15 : spread < 0.04 ? 13 : spread < 0.12 ? 11 : spread < 0.5 ? 8 : 6;
  const extra = Constants.expoConfig?.extra as { mapsAndroidConfigured?: boolean } | undefined;
  const webMapUrl = pickupPoint && destinationPoint
    ? `https://maps.google.com/maps?saddr=${pickupPoint.latitude},${pickupPoint.longitude}&daddr=${destinationPoint.latitude},${destinationPoint.longitude}&output=embed`
    : `https://maps.google.com/maps?q=${centre.latitude},${centre.longitude}&z=${zoom}&output=embed`;

  return (
    <Card style={{ gap: compact ? 0 : theme.spacing.sm, padding: 0, overflow: 'hidden' }}>
      {!compact ? <View style={{ paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.md, gap: theme.spacing.xxs }}>
        <Text variant="subheading" tone="brand">{title}</Text>
        <Text variant="caption" tone="muted">
          {driverFix
            ? driverFix.stale
              ? 'Last driver location is old; waiting for a fresh update.'
              : 'Driver location updates live while this booking is active.'
            : 'Pickup and destination on the map. Driver position appears after they share a live fix.'}
        </Text>
      </View> : null}
      {Platform.OS === 'android' && !extra?.mapsAndroidConfigured ? (
        <View style={{ height, backgroundColor: theme.colors.surfaceMuted, padding: theme.spacing.md, justifyContent: 'center', gap: theme.spacing.xs }}>
          <Text variant="label" tone="brand">Map key required on Android</Text>
          <Text variant="caption" tone="muted">Add a restricted Google Maps SDK for Android key as GOOGLE_MAPS_ANDROID_API_KEY, then rebuild the app. The driver’s live GPS stream will display here.</Text>
          <Text variant="caption" tone="faint">For now: {pickup?.label ?? 'Pickup'}{destination?.label ? ` → ${destination.label}` : ''}</Text>
        </View>
      ) : Platform.OS === 'ios' ? (
        <AppleMaps.View
          style={{ height, width: '100%' }}
          colorScheme={AppleMaps.MapColorScheme.LIGHT}
          cameraPosition={{ coordinates: centre, zoom }}
          markers={[
            ...(pickupPoint ? [{ id: 'pickup', coordinates: pickupPoint, title: 'Pickup', tintColor: theme.colors.primary }] : []),
            ...(routeMode === 'trip' && destinationPoint ? [{ id: 'destination', coordinates: destinationPoint, title: 'Destination', tintColor: theme.colors.primaryInk }] : []),
            ...(driverPoint ? [{ id: 'driver', coordinates: driverPoint, title: driverFix?.stale ? `${driverTitle} · last update is stale` : driverTitle, tintColor: theme.colors.primaryInk, systemImage: 'car.fill' }] : []),
            ...(customerPoint ? [{ id: 'customer', coordinates: customerPoint, title: customerFix?.stale ? 'Customer · last update is stale' : 'Customer', tintColor: theme.colors.primaryInk, systemImage: 'figure.walk' }] : []),
          ]}
          polylines={polylines}
          uiSettings={{ compassEnabled: true, scaleBarEnabled: true }}
        />
      ) : Platform.OS === 'android' ? (
        <GoogleMaps.View
          style={{ height, width: '100%' }}
          cameraPosition={{ coordinates: centre, zoom }}
          markers={[
            ...(pickupPoint ? [{ id: 'pickup', coordinates: pickupPoint, title: 'Pickup', snippet: pickup?.label ?? '' }] : []),
            ...(routeMode === 'trip' && destinationPoint ? [{ id: 'destination', coordinates: destinationPoint, title: 'Destination', snippet: destination?.label ?? '' }] : []),
            ...(driverPoint ? [{ id: 'driver', coordinates: driverPoint, title: driverFix?.stale ? `${driverTitle} · last update is stale` : driverTitle, snippet: 'Live booking location' }] : []),
            ...(customerPoint ? [{ id: 'customer', coordinates: customerPoint, title: customerFix?.stale ? 'Customer · last update is stale' : 'Customer', snippet: 'Live customer location' }] : []),
          ]}
          polylines={polylines}
          properties={{
            isMyLocationEnabled: false,
            mapStyleOptions: {
              json: JSON.stringify([
              { elementType: 'geometry', stylers: [{ color: '#F2F5FA' }] },
              { elementType: 'labels.text.fill', stylers: [{ color: '#727B8B' }] },
              { elementType: 'labels.text.stroke', stylers: [{ color: '#FFFFFF' }] },
              { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#E7E9EE' }] },
              { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#F2F5FA' }] },
              { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#E8F6EF' }] },
              { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#FFFFFF' }] },
              { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#EAF0FF' }] },
              { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#E7E9EE' }] },
              { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#EAF0F8' }] },
              { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#EAF0FF' }] },
              ]),
            },
          }}
          colorScheme={GoogleMaps.MapColorScheme.LIGHT}
          uiSettings={{ compassEnabled: true, myLocationButtonEnabled: false, zoomControlsEnabled: true }}
        />
      ) : (
        <View style={{ height, width: '100%', overflow: 'hidden', backgroundColor: theme.colors.surfaceMuted }}>
          {createElement('iframe', {
            title: title,
            src: webMapUrl,
            loading: 'lazy',
            allowFullScreen: true,
            referrerPolicy: 'no-referrer-when-downgrade',
            style: { width: '100%', height: '100%', border: 0 },
          })}
        </View>
      )}
    </Card>
  );
}

/** Google's encoded polyline format, decoded to native map coordinates. */
function decodePolyline(encoded: string | null | undefined): { latitude: number; longitude: number }[] {
  if (!encoded || encoded.length > 100_000) return [];
  const points: { latitude: number; longitude: number }[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const delta = () => {
    let result = 0;
    let shift = 0;
    while (index < encoded.length && shift < 35) {
      const byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) throw new Error('Invalid encoded route');
      result |= (byte & 0x1f) << shift;
      if (byte < 0x20) return result & 1 ? ~(result >> 1) : result >> 1;
      shift += 5;
    }
    throw new Error('Truncated encoded route');
  };
  try {
    while (index < encoded.length) {
      lat += delta();
      lng += delta();

      const latitude = lat / 1e5;
      const longitude = lng / 1e5;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
      points.push({ latitude, longitude });
    }
  } catch {
    return [];
  }
  return points;
}
