import Constants from 'expo-constants';
import { createElement, useEffect, useRef } from 'react';
import { AppleMaps, GoogleMaps } from 'expo-maps';
import { Animated, Platform, View } from 'react-native';
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
  driverTitle?: string;
  title?: string;
  height?: number;
  /** Immersive, map-first variant used by the customer booking screen. */
  compact?: boolean;
}) {
  const theme = useTheme();
  const routeProgress = useRef(new Animated.Value(0)).current;
  const pickupPoint = coordinates(pickup);
  const destinationPoint = coordinates(destination);
  const driverPoint = driverFix ? { latitude: driverFix.lat, longitude: driverFix.lng } : null;
  const customerPoint = customerFix ? { latitude: customerFix.lat, longitude: customerFix.lng } : null;
  const routeCoordinates = decodePolyline(routePolyline);
  const polylines = routeCoordinates.length > 1
    ? [{ id: 'trip-route', coordinates: routeCoordinates, color: theme.colors.primary, width: 6 }]
    : [];
  const points = [pickupPoint, destinationPoint, driverPoint, customerPoint, ...routeCoordinates].filter((point) => point !== null);

  // The first booking frame still shows a usable city map before the customer
  // chooses an address. This is only the launch-area camera centre; no pin or
  // current-location claim is rendered until we have a real coordinate.
  const centre = driverPoint ?? pickupPoint ?? points[0] ?? { latitude: 28.4595, longitude: 77.0266 };
  const latitudeSpread = points.length ? Math.max(...points.map((point) => Math.abs(point.latitude - centre.latitude))) : 0;
  const longitudeSpread = points.length ? Math.max(...points.map((point) => Math.abs(point.longitude - centre.longitude))) : 0;
  const spread = Math.max(latitudeSpread, longitudeSpread);
  const zoom = spread < 0.015 ? 15 : spread < 0.08 ? 12 : spread < 0.4 ? 9 : 6;
  const extra = Constants.expoConfig?.extra as { mapsAndroidConfigured?: boolean } | undefined;
  const webMapUrl = pickupPoint && destinationPoint
    ? `https://maps.google.com/maps?saddr=${pickupPoint.latitude},${pickupPoint.longitude}&daddr=${destinationPoint.latitude},${destinationPoint.longitude}&output=embed`
    : `https://maps.google.com/maps?q=${centre.latitude},${centre.longitude}&z=${zoom}&output=embed`;

  useEffect(() => {
    if (!pickupPoint || !destinationPoint) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(routeProgress, { toValue: 1, duration: 3_200, useNativeDriver: false }),
      Animated.timing(routeProgress, { toValue: 0, duration: 0, useNativeDriver: false }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [destinationPoint?.latitude, destinationPoint?.longitude, pickupPoint?.latitude, pickupPoint?.longitude, routeProgress]);

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
      {!compact && pickupPoint && destinationPoint ? (
          <View accessibilityLabel="Route preview from pickup to destination" style={{ marginHorizontal: theme.spacing.md, marginBottom: theme.spacing.xs, padding: theme.spacing.sm, borderRadius: theme.radius.md, backgroundColor: theme.colors.surfaceMuted, overflow: 'hidden' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 7 }}>
            <Text variant="caption" tone="brand" numberOfLines={1}>PICKUP · {pickup?.label ?? 'Starting point'}</Text>
            <Text variant="caption" tone="brand" numberOfLines={1}>DROP · {destination?.label ?? 'Destination'}</Text>
          </View>
          <View style={{ height: 12, justifyContent: 'center' }}>
            <View style={{ height: 3, borderRadius: 2, backgroundColor: theme.colors.border }} />
            <View style={{ position: 'absolute', left: 2, width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.primary }} />
            <View style={{ position: 'absolute', right: 2, width: 8, height: 8, borderRadius: 2, backgroundColor: theme.colors.textBrand }} />
            <Animated.View style={{ position: 'absolute', left: routeProgress.interpolate({ inputRange: [0, 1], outputRange: ['5%', '92%'] }), width: 10, height: 10, borderRadius: 5, backgroundColor: theme.palette.brandBright, borderWidth: 2, borderColor: theme.colors.surface }} />
          </View>
          <Text variant="caption" tone="faint" style={{ marginTop: 4 }}>Route preview · the moving marker is decorative, not a live driver location</Text>
        </View>
      ) : null}
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
            ...(destinationPoint ? [{ id: 'destination', coordinates: destinationPoint, title: 'Destination', tintColor: theme.colors.primaryInk }] : []),
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
            ...(destinationPoint ? [{ id: 'destination', coordinates: destinationPoint, title: 'Destination', snippet: destination?.label ?? '' }] : []),
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
            src: (driverPoint ?? customerPoint)
              ? `https://maps.google.com/maps?q=${(driverPoint ?? customerPoint)!.latitude},${(driverPoint ?? customerPoint)!.longitude}&z=15&output=embed`
              : webMapUrl,
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
