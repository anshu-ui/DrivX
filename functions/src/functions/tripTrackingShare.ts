import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { bookingRefPath } from '@drivx/domain';
import { db, rtdb } from '../lib/admin';
import { PUBLIC_ORIGIN } from '../lib/config';
import { failedPrecondition, notFound, parseInput, permissionDenied } from '../lib/errors';
import { holdsRole } from '@drivx/domain';
import type { Caller } from '../lib/guards';

const createSchema = z.object({ bookingId: z.string().min(8).max(64) });
const tokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{40,64}$/) });
const RUNNING = new Set(['trip_started', 'in_progress', 'destination_reached']);
const SHARE_LIFETIME_MS = 12 * 60 * 60 * 1000;

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function pointOf(place: unknown): { lat: number; lng: number } | null {
  if (!place || typeof place !== 'object') return null;
  const location = (place as { location?: unknown }).location;
  if (!location || typeof location !== 'object') return null;
  const lat = Number((location as { lat?: unknown }).lat);
  const lng = Number((location as { lng?: unknown }).lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** A trip party can mint a temporary, unguessable link while the trip is active. */
export async function createTripTrackingShareForCaller(caller: Caller, raw: unknown) {
  const { bookingId } = parseInput(createSchema, raw);
  const bookingSnap = await db().doc(bookingRefPath(bookingId)).get();
  if (!bookingSnap.exists) throw notFound('Trip not found.');
  const booking = bookingSnap.data() ?? {};
  const isCustomer = holdsRole(caller.claims, 'customer') && booking.customerUid === caller.uid;
  const isDriver = holdsRole(caller.claims, 'driver') && booking.assignedDriverUid === caller.uid;
  if (!isCustomer && !isDriver) throw permissionDenied('Only the customer or assigned driver can share this trip.');
  if (!RUNNING.has(String(booking.status ?? ''))) throw failedPrecondition('Live sharing becomes available after the trip starts.');
  const authorization = await rtdb().ref(`authz/${bookingId}/trackingEnabled`).get();
  if (authorization.val() !== true) throw failedPrecondition('Live location sharing is not active for this trip.');

  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  await db().collection('tripTrackingShares').doc(tokenHash(token)).set({
    bookingId,
    createdByUid: caller.uid,
    createdAtMs: now,
    expiresAtMs: now + SHARE_LIFETIME_MS,
  });
  return { url: `${PUBLIC_ORIGIN}/api/tripTrackingShare#${token}`, expiresAtMs: now + SHARE_LIFETIME_MS };
}

/** Public, token-scoped location response. Does not disclose names, phones, or booking ids. */
export async function readPublicTripTracking(raw: unknown) {
  const { token } = parseInput(tokenSchema, raw);
  const share = await db().collection('tripTrackingShares').doc(tokenHash(token)).get();
  if (!share.exists) return { active: false, reason: 'This share link is invalid or has expired.' };
  const data = share.data() ?? {};
  const bookingId = typeof data.bookingId === 'string' ? data.bookingId : '';
  if (!bookingId || Number(data.expiresAtMs ?? 0) <= Date.now()) return { active: false, reason: 'This share link has expired.' };
  const [bookingSnap, authorizationSnap, liveSnap] = await Promise.all([
    db().doc(bookingRefPath(bookingId)).get(),
    rtdb().ref(`authz/${bookingId}/trackingEnabled`).get(),
    rtdb().ref(`activeBookings/${bookingId}`).get(),
  ]);
  const status = String(bookingSnap.data()?.status ?? '');
  if (!bookingSnap.exists || !RUNNING.has(status) || authorizationSnap.val() !== true) {
    return { active: false, reason: 'Live sharing has ended with the trip.' };
  }
  const live = liveSnap.val() as Record<string, unknown> | null;
  const point = live?.location as Record<string, unknown> | undefined;
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return { active: true, location: null, updatedAtMs: null };
  }
  const booking = bookingSnap.data() ?? {};
  return {
    active: true,
    location: {
      lat,
      lng,
      headingDegrees: Number.isFinite(Number(point?.headingDegrees)) ? Number(point?.headingDegrees) : null,
    },
    updatedAtMs: Number.isFinite(Number(point?.receivedAtMs)) ? Number(point?.receivedAtMs) : null,
    routePolyline: typeof booking.routePolyline === 'string' ? booking.routePolyline : null,
    pickup: pointOf(booking.pickup),
    destination: pointOf(booking.destination),
  };
}

export function trackingSharePage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>DrivX live trip</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"><style>
*{box-sizing:border-box}body{margin:0;background:#f5f7fb;color:#17243d;font:16px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.shell{max-width:760px;margin:0 auto;padding:20px}.head,.panel{background:#fff;border:1px solid #e3e9f2;border-radius:20px;box-shadow:0 8px 24px #14264b12}.head{padding:20px 22px;margin-bottom:14px}.brand{font-size:13px;font-weight:800;letter-spacing:.18em;color:#2563eb}.head h1{font-size:23px;margin:10px 0 5px}.sub{color:#62718a;font-size:14px}.panel{overflow:hidden}.status{padding:15px 18px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #edf0f5;font-weight:650}.dot{width:10px;height:10px;border-radius:50%;background:#16a36a;box-shadow:0 0 0 5px #16a36a20}.dot.stale{background:#e49b28;box-shadow:0 0 0 5px #e49b2820}.dot.off{background:#8a94a6;box-shadow:0 0 0 5px #8a94a620}#map{height:min(58vh,460px);min-height:300px;background:#edf2f8}.meta{padding:13px 18px;color:#66738a;font-size:13px}.foot{padding:14px 18px;border-top:1px solid #edf0f5;color:#7b8798;font-size:12px;line-height:1.55}.leaflet-control-attribution{font-size:9px!important}.car-pin{width:38px;height:38px;border:3px solid white;border-radius:50%;display:grid;place-items:center;background:#2563eb;color:white;box-shadow:0 3px 12px #183d8a66;font-size:18px}.car-pin span{display:block;line-height:1;transform:rotate(var(--heading,0deg))}.leaflet-container{font:inherit}
</style></head><body><main class="shell"><header class="head"><div class="brand">DRIVX</div><h1>Live trip location</h1><div class="sub">A private link shared by a trip participant. Location updates while sharing is active.</div></header><section class="panel"><div class="status"><span id="dot" class="dot"></span><span id="state">Connecting securely…</span></div><div id="map"></div><div id="updated" class="meta">Waiting for the driver's first location update.</div><div class="foot">This link shows the vehicle's latest shared location and planned route. It does not show passenger or driver contact details. Sharing ends when the trip ends or the link expires.</div></section></main>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>
(()=>{
 const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
 const state=document.getElementById('state'),updated=document.getElementById('updated'),dot=document.getElementById('dot');
 let map=null,marker=null,routeLine=null,pickupPin=null,destinationPin=null,firstFix=true,poll=0;
 function decodePolyline(encoded){
  if(!encoded||encoded.length>100000)return[];let index=0,lat=0,lng=0;const points=[];
  function delta(){let result=0,shift=0;while(index<encoded.length&&shift<35){const byte=encoded.charCodeAt(index++)-63;if(byte<0||byte>63)throw Error('Invalid route');result|=(byte&31)<<shift;if(byte<32)return result&1?~(result>>1):result>>1;shift+=5}throw Error('Invalid route')}
  try{while(index<encoded.length){lat+=delta();lng+=delta();points.push([lat/1e5,lng/1e5])}}catch{return[]}return points;
 }
 function carIcon(heading){return L.divIcon({className:'',html:'<div class="car-pin" style="--heading:'+((heading||0)-45)+'deg"><span>➤</span></div>',iconSize:[38,38],iconAnchor:[19,19]})}
 function addEndpoint(point,label,color){if(!point||!Number.isFinite(Number(point.lat))||!Number.isFinite(Number(point.lng)))return null;return L.circleMarker([Number(point.lat),Number(point.lng)],{radius:8,color:'#fff',weight:3,fillColor:color,fillOpacity:1}).bindTooltip(label).addTo(map)}
 if(!token){state.textContent='This share link is missing its access token.';dot.className='dot off';return}
 async function refresh(){try{
  const response=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({data:{token}})});
  if(!response.ok)throw Error('Request failed');const payload=await response.json(),data=payload.result||{};
  if(!data.active){state.textContent=data.reason||'Sharing is no longer active.';dot.className='dot off';if(poll)clearInterval(poll);return}
  if(!map){map=L.map('map',{zoomControl:true}).setView([28.4595,77.0266],12);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map)}
  if(data.routePolyline&&!routeLine){const route=decodePolyline(data.routePolyline);if(route.length>1){routeLine=L.polyline(route,{color:'#2563eb',weight:5,opacity:.82,lineCap:'round',lineJoin:'round'}).addTo(map)}}
  if(!pickupPin)pickupPin=addEndpoint(data.pickup,'Pickup','#16a36a');
  if(!destinationPin)destinationPin=addEndpoint(data.destination,'Destination','#17243d');
  const bounds=[];if(routeLine)bounds.push(routeLine.getBounds());if(pickupPin)bounds.push(pickupPin.getLatLng().toBounds(120));if(destinationPin)bounds.push(destinationPin.getLatLng().toBounds(120));
  if(firstFix&&bounds.length)map.fitBounds(bounds.length===1?bounds[0]:bounds.reduce((all,next)=>all.extend(next)) .pad(.12));
  if(!data.location){state.textContent='Waiting for live location';updated.textContent='The trip is active. The driver’s device has not sent a location fix yet.';dot.className='dot stale';return}
  const point=[Number(data.location.lat),Number(data.location.lng)];
  // The shared location endpoint returns the most recent device GPS fix. Do not
  // interpolate between fixes: that invents movement while the driver is stopped
  // or offline and can make the public tracking link misleading.
  if(!marker)marker=L.marker(point,{icon:carIcon(data.location.headingDegrees),title:'Driver location'}).addTo(map);else {marker.setIcon(carIcon(data.location.headingDegrees));marker.setLatLng(point)}
  if(firstFix&&!bounds.length)map.setView(point,15);else if(!map.getBounds().pad(-.15).contains(point))map.panTo(point,{animate:true,duration:.5});firstFix=false;
  const lastFix=Number(data.updatedAtMs)||Date.now(),age=Math.max(0,Math.floor((Date.now()-lastFix)/1000));state.textContent=age>90?'Last location may be delayed':'Driver location is updating';dot.className='dot'+(age>90?' stale':'');updated.textContent='Last location update: '+new Date(lastFix).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})+(age>90?' · device may be offline or location permission is off':'');
 }catch{state.textContent='Could not refresh location. Retrying…';dot.className='dot stale'}}
 refresh();poll=window.setInterval(refresh,5000);
})();
</script></body></html>`;
}
