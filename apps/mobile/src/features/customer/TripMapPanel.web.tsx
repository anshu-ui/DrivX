import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { Card, Text, useTheme } from '@drivx/ui';
import type { Place } from '@drivx/domain';
import { mobileEnv } from '../../lib/env';
import type { LiveDriverFix } from './liveLocation';

type Point = { lat: number; lng: number };
type MapMarker = { setMap(map: GoogleMap | null): void; setPosition(point: Point): void };
type MapPolyline = { setMap(map: GoogleMap | null): void };
type MapBounds = { extend(point: Point): void };
type GoogleMap = { setCenter(point: Point): void; setZoom(zoom: number): void; fitBounds(bounds: MapBounds, padding?: number): void };
type MapsApi = {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => GoogleMap;
  Marker: new (options: Record<string, unknown>) => MapMarker;
  Polyline: new (options: Record<string, unknown>) => MapPolyline;
  LatLngBounds: new () => MapBounds;
};

declare global {
  interface Window { google?: { maps?: MapsApi } }
}

let mapsScript: Promise<MapsApi> | null = null;
function loadMaps(key: string): Promise<MapsApi> {
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  if (mapsScript) return mapsScript;
  mapsScript = new Promise<MapsApi>((resolve, reject) => {
    const existing = document.getElementById('drivx-google-maps') as HTMLScriptElement | null;
    const script = existing ?? document.createElement('script');
    const loaded = () => window.google?.maps ? resolve(window.google.maps) : reject(new Error('Google Maps did not initialize'));
    script.addEventListener('load', loaded, { once: true });
    script.addEventListener('error', () => reject(new Error('Google Maps could not load')), { once: true });
    if (!existing) {
      script.id = 'drivx-google-maps';
      script.async = true;
      script.defer = true;
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&loading=async`;
      document.head.appendChild(script);
    }
  }).catch((error) => { mapsScript = null; throw error; });
  return mapsScript!;
}

function decodePolyline(encoded: string | null | undefined): Point[] {
  if (!encoded || encoded.length > 100_000) return [];
  const points: Point[] = [];
  let index = 0; let lat = 0; let lng = 0;
  const delta = () => {
    let result = 0; let shift = 0;
    while (index < encoded.length && shift < 35) {
      const byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) throw new Error('Invalid route');
      result |= (byte & 0x1f) << shift;
      if (byte < 0x20) return result & 1 ? ~(result >> 1) : result >> 1;
      shift += 5;
    }
    throw new Error('Invalid route');
  };
  try {
    while (index < encoded.length) {
      lat += delta(); lng += delta();
      points.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
  } catch { return []; }
  return points;
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
}: {
  pickup: Place | null | undefined;
  destination: Place | null | undefined;
  driverFix?: LiveDriverFix | null;
  customerFix?: LiveDriverFix | null;
  routePolyline?: string | null;
  driverTitle?: string;
  title?: string;
  height?: number;
}) {
  const theme = useTheme();
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [mapError, setMapError] = useState(false);
  const [mapVersion, setMapVersion] = useState(0);
  const mapRef = useRef<GoogleMap | null>(null);
  const markersRef = useRef<Record<string, MapMarker>>({});
  const routeRef = useRef<MapPolyline | null>(null);
  const pickupLat = pickup?.location.lat;
  const pickupLng = pickup?.location.lng;
  const destinationLat = destination?.location.lat;
  const destinationLng = destination?.location.lng;
  const driverLat = driverFix?.lat;
  const driverLng = driverFix?.lng;
  const customerLat = customerFix?.lat;
  const customerLng = customerFix?.lng;
  const pickupPoint = useMemo(() => pickupLat === undefined || pickupLng === undefined ? null : { lat: pickupLat, lng: pickupLng }, [pickupLat, pickupLng]);
  const destinationPoint = useMemo(() => destinationLat === undefined || destinationLng === undefined ? null : { lat: destinationLat, lng: destinationLng }, [destinationLat, destinationLng]);
  const driverPoint = useMemo(() => driverLat === undefined || driverLng === undefined ? null : { lat: driverLat, lng: driverLng }, [driverLat, driverLng]);
  const customerPoint = useMemo(() => customerLat === undefined || customerLng === undefined ? null : { lat: customerLat, lng: customerLng }, [customerLat, customerLng]);
  const env = mobileEnv();
  const key = env.googleMapsWebKey;
  const centre = useMemo(() => pickupPoint ?? destinationPoint ?? { lat: 28.4595, lng: 77.0266 }, [pickupPoint, destinationPoint]);
  const fallbackUrl = pickupPoint && destinationPoint
    ? `https://maps.google.com/maps?saddr=${pickupPoint.lat},${pickupPoint.lng}&daddr=${destinationPoint.lat},${destinationPoint.lng}&output=embed`
    : `https://maps.google.com/maps?q=${centre.lat},${centre.lng}&z=14&output=embed`;

  useEffect(() => {
    if (!host || !key) return;
    let cancelled = false;
    void loadMaps(key).then((maps) => {
      if (cancelled) return;
      mapRef.current = new maps.Map(host, {
        center: centre,
        zoom: 14,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true,
        clickableIcons: false,
        styles: [
          { elementType: 'geometry', stylers: [{ color: '#F2F5FA' }] },
          { elementType: 'labels.text.fill', stylers: [{ color: '#727B8B' }] },
          { elementType: 'labels.text.stroke', stylers: [{ color: '#FFFFFF' }] },
          { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#E7E9EE' }] },
          { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#F2F5FA' }] },
          { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#E8F6EF' }] },
          { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#FFFFFF' }] },
          { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#EAF0FF' }] },
          { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#E7E9EE' }] },
          { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#EAF0FF' }] },
        ],
      });
      setMapError(false);
      setMapVersion((version) => version + 1);
    }).catch(() => { if (!cancelled) setMapError(true); });
    return () => { cancelled = true; mapRef.current = null; markersRef.current = {}; routeRef.current = null; };
  }, [host, key, centre]);

  // Draw/focus the planned route independently of live GPS. Re-fitting this
  // bounds on every driver update caused the web map to jump around.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.google?.maps) return;
    const maps = window.google.maps;
    const bounds = new maps.LatLngBounds();
    const route = decodePolyline(routePolyline);
    let count = 0;
    for (const point of [pickupPoint, destinationPoint, ...route]) {
      if (!point) continue;
      bounds.extend(point);
      count += 1;
    }
    routeRef.current?.setMap(null);
    routeRef.current = null;
    if (route.length > 1) routeRef.current = new maps.Polyline({ map, path: route, strokeColor: '#315EE8', strokeOpacity: 0.88, strokeWeight: 5 });
    if (count > 1) map.fitBounds(bounds, 36);
    else {
      const point = pickupPoint ?? destinationPoint;
      if (point) { map.setCenter(point); map.setZoom(15); }
    }
  }, [mapVersion, pickupPoint, destinationPoint, routePolyline]);

  // GPS updates move only the relevant pins; they never change map bounds.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.google?.maps) return;
    const maps = window.google.maps;
    const entries: [string, Point | null, string, string][] = [
      ['pickup', pickupPoint, 'Pickup', '#315EE8'],
      ['destination', destinationPoint, 'Drop-off', '#172033'],
      ['driver', driverPoint, driverFix?.stale ? `${driverTitle} · last update is old` : driverTitle, '#168A5B'],
      ['customer', customerPoint, customerFix?.stale ? 'Customer · last update is old' : 'Customer', '#B98525'],
    ];
    for (const [id, point, label, color] of entries) {
      let marker = markersRef.current[id];
      if (!point) { marker?.setMap(null); delete markersRef.current[id]; continue; }
      if (!marker) {
        marker = new maps.Marker({ map, title: label, position: point, label: id === 'driver' ? 'D' : id === 'customer' ? 'C' : undefined, icon: { path:  googleMarkerPath(), fillColor: color, fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2, scale: id === 'driver' || id === 'customer' ? 7 : 6, anchor: { x: 0, y: 0 } } });
        markersRef.current[id] = marker;
      } else {
        marker.setMap(map);
        marker.setPosition(point);
      }
    }
  }, [mapVersion, pickupPoint, destinationPoint, driverPoint, driverFix?.stale, customerPoint, customerFix?.stale, driverTitle]);

  return (
    <Card style={{ gap: theme.spacing.sm, padding: 0, overflow: 'hidden' }}>
      <View style={{ paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.md, gap: theme.spacing.xxs }}>
        <Text variant="subheading" tone="brand">{title}</Text>
        <Text variant="caption" tone="muted">
          {(!key || mapError) && (driverFix || customerFix)
            ? 'Live location sharing is active, but the web map key is not configured; the map can only show the route preview.'
            : driverFix || customerFix
            ? 'Trip locations refresh live. Only this booking’s customer and assigned driver can see them.'
            : 'Pickup and destination are shown here. Shared live locations appear after the trip starts.'}
        </Text>
      </View>
      <View style={{ height, width: '100%', overflow: 'hidden', backgroundColor: '#F2F5FA' }}>
        {key && !mapError
          ? createElement('div', { ref: setHost, 'aria-label': `${title}, live pickup, destination, driver and customer map`, style: { width: '100%', height: '100%' } })
          : createElement('iframe', { title, src: fallbackUrl, loading: 'lazy', allowFullScreen: true, referrerPolicy: 'no-referrer-when-downgrade', style: { width: '100%', height: '100%', border: 0 } })}
      </View>
    </Card>
  );
}

function googleMarkerPath(): string {
  return 'M 0,0 C -5,-7 -10,-12 -10,-18 A 10,10 0 1 1 10,-18 C 10,-12 5,-7 0,0 Z';
}
