import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { Card, Text, useTheme } from '@drivx/ui';
import type { Place } from '@drivx/domain';
import type { LiveDriverFix } from './liveLocation';

type Point = { lat: number; lng: number };
type LatLng = [number, number];
type LeafletMap = {
  fitBounds(bounds: LeafletBounds, options?: Record<string, unknown>): void;
  setView(point: LatLng, zoom: number, options?: Record<string, unknown>): void;
  remove(): void;
  invalidateSize(options?: Record<string, unknown>): void;
};
type LeafletBounds = { isValid(): boolean };
type LeafletLayer = { addTo(map: LeafletMap): LeafletLayer; remove(): void };
type LeafletMarker = {
  addTo(map: LeafletMap): LeafletMarker;
  remove(): void;
  setLatLng(point: LatLng): LeafletMarker;
  setStyle(style: Record<string, unknown>): LeafletMarker;
  setTooltipContent(content: string): LeafletMarker;
  bindTooltip(content: string, options?: Record<string, unknown>): LeafletMarker;
};
type LeafletPolyline = LeafletLayer & { setLatLngs(points: LatLng[]): LeafletPolyline };
type LeafletApi = {
  map(element: HTMLElement, options?: Record<string, unknown>): LeafletMap;
  tileLayer(url: string, options?: Record<string, unknown>): LeafletLayer;
  circleMarker(point: LatLng, options?: Record<string, unknown>): LeafletMarker;
  polyline(points: LatLng[], options?: Record<string, unknown>): LeafletPolyline;
  latLngBounds(points: LatLng[]): LeafletBounds;
};

declare global {
  interface Window { L?: LeafletApi }
}

const LEAFLET_VERSION = '1.9.4';
let leafletScript: Promise<LeafletApi> | null = null;

/** A keyless interactive road map for live pins and the server's route geometry. */
function loadLeaflet(): Promise<LeafletApi> {
  if (window.L) return Promise.resolve(window.L);
  if (leafletScript) return leafletScript;

  const cssId = 'drivx-leaflet-css';
  if (!document.getElementById(cssId)) {
    const style = document.createElement('link');
    style.id = cssId;
    style.rel = 'stylesheet';
    style.href = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;
    document.head.appendChild(style);
  }

  leafletScript = new Promise<LeafletApi>((resolve, reject) => {
    const existing = document.getElementById('drivx-leaflet-js') as HTMLScriptElement | null;
    const script = existing ?? document.createElement('script');
    const loaded = () => window.L ? resolve(window.L) : reject(new Error('The map library did not initialize.'));
    const failed = () => reject(new Error('The map library could not load.'));
    script.addEventListener('load', loaded, { once: true });
    script.addEventListener('error', failed, { once: true });
    if (!existing) {
      script.id = 'drivx-leaflet-js';
      script.async = true;
      script.src = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;
      document.head.appendChild(script);
    }
  }).catch((error) => {
    leafletScript = null;
    throw error;
  });
  return leafletScript;
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
      const point = { lat: lat / 1e5, lng: lng / 1e5 };
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng) || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) return [];
      points.push(point);
    }
  } catch { return []; }
  return points;
}

const coordinates = (points: Point[]): LatLng[] => points.map(({ lat, lng }) => [lat, lng]);

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
}: {
  pickup: Place | null | undefined;
  destination: Place | null | undefined;
  driverFix?: LiveDriverFix | null;
  customerFix?: LiveDriverFix | null;
  routePolyline?: string | null;
  routeMode?: 'pickup' | 'trip';
  driverTitle?: string;
  title?: string;
  height?: number;
}) {
  const theme = useTheme();
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [mapError, setMapError] = useState(false);
  const [mapVersion, setMapVersion] = useState(0);
  const mapRef = useRef<LeafletMap | null>(null);
  const markersRef = useRef<Record<string, LeafletMarker>>({});
  const routeRef = useRef<LeafletPolyline | null>(null);
  const pickupPoint = useMemo(() => pickup ? { lat: pickup.location.lat, lng: pickup.location.lng } : null, [pickup]);
  const destinationPoint = useMemo(() => destination ? { lat: destination.location.lat, lng: destination.location.lng } : null, [destination]);
  const driverPoint = useMemo(() => driverFix ? { lat: driverFix.lat, lng: driverFix.lng } : null, [driverFix]);
  const customerPoint = useMemo(() => customerFix ? { lat: customerFix.lat, lng: customerFix.lng } : null, [customerFix]);
  const routePoints = useMemo(() => decodePolyline(routePolyline), [routePolyline]);
  const center = pickupPoint ?? destinationPoint ?? { lat: 28.4595, lng: 77.0266 };
  const fallbackUrl = pickupPoint && destinationPoint
    ? `https://maps.google.com/maps?saddr=${pickupPoint.lat},${pickupPoint.lng}&daddr=${destinationPoint.lat},${destinationPoint.lng}&output=embed`
    : `https://maps.google.com/maps?q=${center.lat},${center.lng}&z=14&output=embed`;

  useEffect(() => {
    if (!host) return undefined;
    let cancelled = false;
    void loadLeaflet().then((leaflet) => {
      if (cancelled) return;
      const map = leaflet.map(host, { zoomControl: true, scrollWheelZoom: false, tap: true });
      leaflet.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      }).addTo(map);
      map.setView([28.4595, 77.0266], 13);
      mapRef.current = map;
      setMapError(false);
      setMapVersion((value) => value + 1);
      requestAnimationFrame(() => map.invalidateSize());
    }).catch(() => { if (!cancelled) setMapError(true); });
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markersRef.current = {};
      routeRef.current = null;
    };
  }, [host]);

  // Only route changes move the camera. GPS marker updates stay smooth instead
  // of repeatedly snapping the map as the driver moves.
  useEffect(() => {
    const map = mapRef.current;
    const leaflet = window.L;
    if (!map || !leaflet) return;
    routeRef.current?.remove();
    routeRef.current = null;
    if (routePoints.length > 1) {
      routeRef.current = leaflet.polyline(coordinates(routePoints), {
        color: '#315EE8', weight: 6, opacity: 0.9, lineCap: 'round', lineJoin: 'round',
      }).addTo(map) as LeafletPolyline;
    }
    const framePoints = routeMode === 'pickup'
      ? routePoints.length > 1 ? routePoints : pickupPoint ? [pickupPoint] : []
      : [...(pickupPoint ? [pickupPoint] : []), ...(destinationPoint ? [destinationPoint] : []), ...routePoints];
    if (framePoints.length > 1) {
      const bounds = leaflet.latLngBounds(coordinates(framePoints));
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [26, 26], maxZoom: 15, animate: false });
    } else {
      const point = pickupPoint ?? destinationPoint;
      if (point) map.setView([point.lat, point.lng], 15, { animate: false });
    }
  }, [mapVersion, pickupPoint, destinationPoint, routePoints, routeMode]);

  // GPS updates move existing markers only; they do not redraw the road route.
  useEffect(() => {
    const map = mapRef.current;
    const leaflet = window.L;
    if (!map || !leaflet) return;
    const entries: [string, Point | null, string, string, boolean][] = [
      ['pickup', pickupPoint, 'Pickup', '#315EE8', false],
      ['destination', routeMode === 'trip' ? destinationPoint : null, 'Drop-off', '#172033', false],
      ['driver', driverPoint, driverFix?.stale ? `${driverTitle} · last update is old` : driverTitle, '#168A5B', Boolean(driverFix?.stale)],
      ['customer', customerPoint, customerFix?.stale ? 'Customer · last update is old' : 'Customer', '#B98525', Boolean(customerFix?.stale)],
    ];
    for (const [id, point, label, color, stale] of entries) {
      let marker = markersRef.current[id];
      if (!point) {
        marker?.remove();
        delete markersRef.current[id];
        continue;
      }
      if (!marker) {
        const createdMarker = leaflet.circleMarker([point.lat, point.lng], {
          radius: id === 'driver' ? 10 : id === 'customer' ? 8 : 7,
          color: '#FFFFFF', weight: 3, fillColor: color, fillOpacity: stale ? 0.55 : 1,
          title: label,
        }).addTo(map);
        createdMarker.bindTooltip(label, { direction: 'top', offset: [0, -8], opacity: 0.95 });
        marker = createdMarker;
        markersRef.current[id] = createdMarker;
      } else {
        marker.setLatLng([point.lat, point.lng]);
        marker.setStyle({ fillOpacity: stale ? 0.55 : 1 });
        marker.setTooltipContent(label);
      }
    }
  }, [mapVersion, pickupPoint, destinationPoint, driverPoint, driverFix?.stale, customerPoint, customerFix?.stale, driverTitle, routeMode]);

  return (
    <Card style={{ gap: theme.spacing.sm, padding: 0, overflow: 'hidden' }}>
      <View style={{ paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.md, gap: theme.spacing.xxs }}>
        <Text variant="subheading" tone="brand">{title}</Text>
        <Text variant="caption" tone="muted">
          {routeMode === 'pickup' && driverFix
            ? `${driverFix.stale ? 'Last driver fix is old. ' : 'Live driver pin. '}Road route and pickup ETA update with fresh GPS fixes.`
            : driverFix
              ? driverFix.stale
                ? 'Last driver location is old; waiting for a fresh update.'
                : 'Driver location updates live while this booking is active.'
              : 'Pickup and destination are shown here. Live driver location appears when shared.'}
        </Text>
      </View>
      <View style={{ height, width: '100%', overflow: 'hidden', backgroundColor: '#F2F5FA' }}>
        {!mapError
          ? createElement('div', { ref: setHost, 'aria-label': `${title}, live pickup, destination, driver and customer map`, style: { width: '100%', height: '100%' } })
          : createElement('iframe', { title, src: fallbackUrl, loading: 'lazy', allowFullScreen: true, referrerPolicy: 'no-referrer-when-downgrade', style: { width: '100%', height: '100%', border: 0 } })}
      </View>
      <Text variant="caption" tone="faint" style={{ paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm }}>
        Map tiles © OpenStreetMap contributors. Driver GPS and road ETA are shared only for this booking.
      </Text>
    </Card>
  );
}
