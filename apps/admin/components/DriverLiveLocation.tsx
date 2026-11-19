'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { onValue, ref } from 'firebase/database';
import { doc, onSnapshot } from 'firebase/firestore';
import { COLLECTIONS, RTDB_PATHS } from '@drivx/domain';
import { firebaseClients } from '../lib/firebase';

type Point = { lat: number; lng: number };
type Fix = Point & { receivedAtMs: number; headingDegrees: number | null; accuracyMeters: number | null; bookingId: string | null };
type Presence = { state: string; updatedAtMs: number | null; location: Point | null; headingDegrees: number | null };
type Booking = {
  reference: string;
  status: string;
  pickup: { label?: string; location?: Point } | null;
  destination: { label?: string; location?: Point } | null;
  enRouteEta: { minutes: number | null; distanceMeters: number | null; routePolyline: string | null; calculatedAtMs: number | null } | null;
};
type BookingState = { id: string; value: Booking | null };

type Bounds = { isValid(): boolean };
type MapApi = {
  setView(point: [number, number], zoom: number, options?: Record<string, unknown>): void;
  fitBounds(bounds: Bounds, options?: Record<string, unknown>): void;
  invalidateSize(): void;
  remove(): void;
};
interface Layer { addTo(map: MapApi): Layer; remove(): void }
type Marker = { addTo(map: MapApi): Marker; remove(): void; setLatLng(point: [number, number]): Marker; setIcon(icon: unknown): Marker; bindTooltip(text: string): Marker };
interface Polyline extends Layer { addTo(map: MapApi): Polyline; setLatLngs(points: [number, number][]): Polyline }
type Leaflet = {
  map(element: HTMLElement, options?: Record<string, unknown>): MapApi;
  tileLayer(url: string, options?: Record<string, unknown>): Layer;
  divIcon(options: Record<string, unknown>): unknown;
  marker(point: [number, number], options?: Record<string, unknown>): Marker;
  circleMarker(point: [number, number], options?: Record<string, unknown>): Marker;
  polyline(points: [number, number][], options?: Record<string, unknown>): Polyline;
  latLngBounds(points: [number, number][]): Bounds;
};
declare global { interface Window { L?: Leaflet } }

const activeStatuses = new Set(['assigned', 'driver_en_route', 'driver_arrived', 'trip_started', 'in_progress', 'destination_reached']);
const onlineStates = new Set(['online', 'on_assignment', 'on_trip']);
const STALE_AFTER_MS = 90_000;
const LEAFLET_VERSION = '1.9.4';
let leafletLoading: Promise<Leaflet> | null = null;

function loadLeaflet(): Promise<Leaflet> {
  if (window.L) return Promise.resolve(window.L);
  if (leafletLoading) return leafletLoading;
  if (!document.getElementById('drivx-admin-leaflet-css')) {
    const css = document.createElement('link');
    css.id = 'drivx-admin-leaflet-css'; css.rel = 'stylesheet';
    css.href = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;
    document.head.appendChild(css);
  }
  leafletLoading = new Promise<Leaflet>((resolve, reject) => {
    const existing = document.getElementById('drivx-admin-leaflet-js') as HTMLScriptElement | null;
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', () => window.L ? resolve(window.L) : reject(new Error('Map did not initialize.')), { once: true });
    script.addEventListener('error', () => reject(new Error('Map library could not load.')), { once: true });
    if (!existing) {
      script.id = 'drivx-admin-leaflet-js'; script.async = true;
      script.src = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;
      document.head.appendChild(script);
    }
  }).catch((error) => { leafletLoading = null; throw error; });
  return leafletLoading!;
}

function decodePolyline(encoded: string | null): [number, number][] {
  if (!encoded || encoded.length > 100_000) return [];
  let index = 0; let lat = 0; let lng = 0;
  const points: [number, number][] = [];
  const delta = () => {
    let result = 0; let shift = 0;
    while (index < encoded.length && shift < 35) {
      const byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) throw new Error('bad polyline');
      result |= (byte & 31) << shift;
      if (byte < 32) return result & 1 ? ~(result >> 1) : result >> 1;
      shift += 5;
    }
    throw new Error('bad polyline');
  };
  try {
    while (index < encoded.length) {
      lat += delta(); lng += delta();
      const point: [number, number] = [lat / 1e5, lng / 1e5];
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[0]) > 90 || Math.abs(point[1]) > 180) return [];
      points.push(point);
    }
  } catch { return []; }
  return points;
}

function parsePoint(value: unknown): Point | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const lat = Number(row.lat); const lng = Number(row.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

function dateLabel(value: number | null): string {
  return value ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(value) : 'No location update received';
}

function headingLabel(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'Direction unavailable';
  return `${Math.round(((value % 360) + 360) % 360)}° heading`;
}

export function DriverLiveLocation({ driverUid, activeBookingId, profileAvailability }: {
  driverUid: string;
  activeBookingId: string | null;
  profileAvailability: string | null;
}) {
  const [presence, setPresence] = useState<Presence | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  const [bookingIdFromFix, setBookingIdFromFix] = useState<string | null>(null);
  const [bookingState, setBookingState] = useState<BookingState | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const mapElement = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapApi | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const pickupRef = useRef<Marker | null>(null);
  const destinationRef = useRef<Marker | null>(null);
  const routeRef = useRef<Polyline | null>(null);
  const cameraCenteredRef = useRef(false);
  const effectiveBookingId = bookingIdFromFix ?? activeBookingId;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const database = firebaseClients().database;
    const stopPresence = onValue(ref(database, RTDB_PATHS.presence(driverUid)), (snapshot) => {
      const value = snapshot.val() as Record<string, unknown> | null;
      setPresence(value ? {
        state: typeof value.state === 'string' ? value.state : 'unknown',
        updatedAtMs: typeof value.updatedAtMs === 'number' ? value.updatedAtMs : null,
        location: parsePoint(value.location),
        headingDegrees: typeof value.headingDegrees === 'number' ? value.headingDegrees : null,
      } : null);
      setError(null);
    }, (reason) => setError(reason.message));
    const stopFix = onValue(ref(database, RTDB_PATHS.driverLocation(driverUid)), (snapshot) => {
      const value = snapshot.val() as Record<string, unknown> | null;
      const point = parsePoint(value);
      if (!value || !point || typeof value.receivedAtMs !== 'number') {
        setFix(null); setBookingIdFromFix(null); return;
      }
      const bookingId = typeof value.bookingId === 'string' ? value.bookingId : null;
      setBookingIdFromFix(bookingId);
      setFix({
        ...point,
        receivedAtMs: value.receivedAtMs,
        headingDegrees: typeof value.headingDegrees === 'number' ? value.headingDegrees : null,
        accuracyMeters: typeof value.accuracyMeters === 'number' ? value.accuracyMeters : null,
        bookingId,
      });
    }, (reason) => setError(reason.message));
    return () => { stopPresence(); stopFix(); };
  }, [driverUid]);

  useEffect(() => {
    if (!effectiveBookingId) return undefined;
    return onSnapshot(doc(firebaseClients().firestore, COLLECTIONS.bookings, effectiveBookingId), (snapshot) => {
      if (!snapshot.exists()) { setBookingState({ id: effectiveBookingId, value: null }); return; }
      const value = snapshot.data() as Record<string, unknown>;
      const pickup = value.pickup && typeof value.pickup === 'object' ? value.pickup as Booking['pickup'] : null;
      const destination = value.destination && typeof value.destination === 'object' ? value.destination as Booking['destination'] : null;
      const etaValue = value.status === 'driver_en_route' ? value.driverEnRouteEta : value.driverTripEta;
      const etaRaw = etaValue && typeof etaValue === 'object' ? etaValue as Record<string, unknown> : null;
      const eta = etaRaw ? {
        minutes: typeof etaRaw.minutes === 'number' ? etaRaw.minutes : null,
        distanceMeters: typeof etaRaw.distanceMeters === 'number' ? etaRaw.distanceMeters : null,
        routePolyline: typeof etaRaw.routePolyline === 'string' ? etaRaw.routePolyline : null,
        calculatedAtMs: typeof etaRaw.calculatedAtMs === 'number' ? etaRaw.calculatedAtMs : null,
      } : null;
      setBookingState({
        id: effectiveBookingId,
        value: {
          reference: typeof value.reference === 'string' ? value.reference : effectiveBookingId,
          status: typeof value.status === 'string' ? value.status : 'unknown',
          pickup,
          destination,
          enRouteEta: eta,
        },
      });
    }, (reason) => setError(reason.message));
  }, [effectiveBookingId]);

  const booking = bookingState?.id === effectiveBookingId ? bookingState.value : null;
  const profileOnline = profileAvailability === 'online' || profileAvailability === 'on_assignment' || profileAvailability === 'on_trip';
  const explicitlyOffline = presence?.state === 'offline' || presence?.state === 'break' || profileAvailability === 'offline' || profileAvailability === 'break';
  const isOnline = !explicitlyOffline && (Boolean(presence && onlineStates.has(presence.state)) || profileOnline || Boolean(booking && activeStatuses.has(booking.status)));
  const currentPoint = explicitlyOffline ? null : fix?.bookingId && fix.bookingId === effectiveBookingId ? fix : (presence?.location ?? fix);
  const fixUpdatedAt = currentPoint && 'receivedAtMs' in currentPoint && typeof currentPoint.receivedAtMs === 'number'
    ? currentPoint.receivedAtMs
    : null;
  const updatedAt = explicitlyOffline ? null : fixUpdatedAt ?? presence?.updatedAtMs ?? null;
  const stale = updatedAt !== null && now - updatedAt > STALE_AFTER_MS;
  const heading = fix?.headingDegrees ?? presence?.headingDegrees ?? null;
  const routePoints = useMemo(() => decodePolyline(booking?.enRouteEta?.routePolyline ?? null), [booking?.enRouteEta?.routePolyline]);
  const pickupPoint = parsePoint(booking?.pickup?.location);
  const destinationPoint = parsePoint(booking?.destination?.location);
  const markerPoint = currentPoint ? [currentPoint.lat, currentPoint.lng] as [number, number] : null;
  const markerLat = markerPoint?.[0] ?? null;
  const markerLng = markerPoint?.[1] ?? null;
  const pickupLat = pickupPoint?.lat ?? null;
  const pickupLng = pickupPoint?.lng ?? null;
  const destinationLat = destinationPoint?.lat ?? null;
  const destinationLng = destinationPoint?.lng ?? null;
  const arrival = booking?.enRouteEta;

  useEffect(() => {
    if (!mapElement.current) return undefined;
    let disposed = false;
    void loadLeaflet().then((leaflet) => {
      if (disposed || !mapElement.current) return;
      const map = leaflet.map(mapElement.current, { zoomControl: true, scrollWheelZoom: false });
      leaflet.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
      }).addTo(map);
      map.setView([28.4595, 77.0266], 11);
      mapRef.current = map;
      setMapReady(true);
      window.setTimeout(() => map.invalidateSize(), 0);
    }).catch((reason: Error) => setError(reason.message));
    return () => {
      disposed = true;
      mapRef.current?.remove(); mapRef.current = null;
      markerRef.current = null; pickupRef.current = null; destinationRef.current = null; routeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current; const leaflet = window.L;
    if (!map || !leaflet) return;
    if (markerLat !== null && markerLng !== null) {
      const arrow = `<div style="width:30px;height:30px;border:3px solid white;border-radius:50%;background:#2563eb;box-shadow:0 2px 10px #17203366;display:grid;place-items:center"><span style="display:block;color:white;font-size:17px;line-height:17px;transform:rotate(${heading ?? 0}deg)">▲</span></div>`;
      const icon = leaflet.divIcon({ html: arrow, className: 'drivx-driver-live-pin', iconSize: [30, 30], iconAnchor: [15, 15] });
      const point: [number, number] = [markerLat, markerLng];
      if (!markerRef.current) markerRef.current = leaflet.marker(point, { icon, zIndexOffset: 1000 }).addTo(map).bindTooltip('Driver location');
      else markerRef.current.setLatLng(point).setIcon(icon);
    } else if (markerRef.current) { markerRef.current.remove(); markerRef.current = null; }

    const syncPoint = (marker: Marker | null, point: Point | null, color: string, label: string): Marker | null => {
      if (!point) { marker?.remove(); return null; }
      const coords: [number, number] = [point.lat, point.lng];
      if (!marker) return leaflet.circleMarker(coords, { radius: 8, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1 }).addTo(map).bindTooltip(label);
      return marker.setLatLng(coords);
    };
    pickupRef.current = syncPoint(pickupRef.current, pickupLat !== null && pickupLng !== null ? { lat: pickupLat, lng: pickupLng } : null, '#15803d', 'Pickup');
    destinationRef.current = syncPoint(destinationRef.current, destinationLat !== null && destinationLng !== null ? { lat: destinationLat, lng: destinationLng } : null, '#7c3aed', 'Drop-off');
  }, [mapReady, markerLat, markerLng, heading, pickupLat, pickupLng, destinationLat, destinationLng]);

  useEffect(() => {
    const map = mapRef.current; const leaflet = window.L;
    if (!map || !leaflet) return;
    routeRef.current?.remove(); routeRef.current = null;
    if (routePoints.length > 1) routeRef.current = leaflet.polyline(routePoints, { color: '#2563eb', weight: 5, opacity: 0.8 }).addTo(map);
    const points = [
      ...(pickupLat !== null && pickupLng !== null ? [[pickupLat, pickupLng] as [number, number]] : []),
      ...(destinationLat !== null && destinationLng !== null ? [[destinationLat, destinationLng] as [number, number]] : []),
      ...routePoints,
    ];
    if (points.length > 1) {
      const bounds = leaflet.latLngBounds(points);
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [28, 28], maxZoom: 15 });
    } else if (points.length === 1) map.setView(points[0]!, 14);
  // Camera should follow a new trip/route, not every GPS marker tick.
  }, [mapReady, effectiveBookingId, booking?.status, booking?.enRouteEta?.routePolyline, routePoints, pickupLat, pickupLng, destinationLat, destinationLng]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || effectiveBookingId) { cameraCenteredRef.current = false; return; }
    if (markerLat !== null && markerLng !== null && !cameraCenteredRef.current) {
      map.setView([markerLat, markerLng], 14, { animate: true });
      cameraCenteredRef.current = true;
    }
  }, [mapReady, effectiveBookingId, markerLat, markerLng]);

  const statusLabel = explicitlyOffline ? 'Location sharing off' : stale ? 'Location update is delayed' : isOnline ? 'Live location' : 'Offline';
  const badgeClass = explicitlyOffline || !isOnline ? 'bg-slate-100 text-slate-600' : stale ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800';

  return (
    <section className="mt-5 rounded-2xl border border-line bg-surface p-5 shadow-card" aria-label="Driver live location">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="text-lg font-semibold">Live location</h3><p className="mt-1 text-sm text-ink-muted">Updates while this driver is online or has an active trip.</p></div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${badgeClass}`}>{statusLabel}</span>
      </div>
      {error ? <p role="alert" className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-badge-danger">Live location could not load: {error}</p> : null}
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(250px,1fr)]">
        <div className="relative min-h-[270px] overflow-hidden rounded-xl border border-line bg-surface-muted">
          <div ref={mapElement} className="absolute inset-0" />
          {!markerPoint ? <div className="absolute inset-0 grid place-items-center bg-surface/75 p-6 text-center text-sm text-ink-muted">{explicitlyOffline ? 'Location sharing is off. The driver marker is hidden while offline.' : 'Waiting for the next GPS update.'}</div> : null}
        </div>
        <div className="grid content-start gap-3 text-sm">
          <div className="rounded-xl bg-surface-muted p-3"><p className="text-xs uppercase tracking-wide text-ink-faint">Location update</p><p className="mt-1 font-medium">{explicitlyOffline ? 'Location sharing stopped while offline' : dateLabel(updatedAt)}</p><p className="mt-1 text-xs text-ink-muted">{explicitlyOffline ? 'The driver marker is hidden until they go online again.' : stale ? 'This fix is over 90 seconds old; check the driver’s GPS or network.' : headingLabel(heading)}{!explicitlyOffline && fix?.accuracyMeters != null ? ` · ±${Math.round(fix.accuracyMeters)} m` : ''}</p></div>
          <div className="rounded-xl bg-surface-muted p-3"><p className="text-xs uppercase tracking-wide text-ink-faint">Driver status</p><p className="mt-1 font-medium capitalize">{explicitlyOffline ? 'Offline' : booking && activeStatuses.has(booking.status) ? booking.status.replaceAll('_', ' ') : isOnline ? 'Online' : 'Offline'}</p></div>
          {booking && activeStatuses.has(booking.status) ? <div className="rounded-xl bg-surface-muted p-3">
            <p className="text-xs uppercase tracking-wide text-ink-faint">Active trip · {booking.reference}</p>
            <p className="mt-2"><span className="font-semibold">Status:</span> <span className="capitalize">{booking.status.replaceAll('_', ' ')}</span></p>
            <p className="mt-2"><span className="font-semibold">Pickup:</span> {booking.pickup?.label ?? 'Not available'}</p>
            <p className="mt-2"><span className="font-semibold">Drop:</span> {booking.destination?.label ?? 'Not available'}</p>
            {booking.status === 'driver_en_route' && arrival?.minutes != null ? <p className="mt-2 font-semibold text-accent">{arrival.minutes} min to pickup{arrival.distanceMeters != null ? ` · ${(arrival.distanceMeters / 1000).toFixed(1)} km` : ''}</p> : null}
            {['trip_started', 'in_progress', 'destination_reached'].includes(booking.status) && arrival?.minutes != null ? <p className="mt-2 font-semibold text-accent">{arrival.minutes} min to drop{arrival.distanceMeters != null ? ` · ${(arrival.distanceMeters / 1000).toFixed(1)} km` : ''}</p> : null}
            {booking.status === 'driver_arrived' ? <p className="mt-2 font-semibold text-emerald-700">Driver has reached pickup.</p> : null}
          </div> : <p className="rounded-xl bg-surface-muted p-3 text-ink-muted">No active trip is linked to this driver.</p>}
        </div>
      </div>
    </section>
  );
}
