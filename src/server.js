import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { scheduleTravelMinutes, waterbusSchedulePublic } from './waterbus-schedule.js';
import { createSignalRRelay } from './signalr-relay.js';
import { distanceMeters, routeLength } from './geo-distance.js';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const sequenceStatePath = path.join(rootDir, '.simulator-sequences.json');

const env = await loadEnv();
if (parseBool(env.TARGET_GPS_ALLOW_SELF_SIGNED)) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
const port = Number(env.PORT || 5177);
const sequenceState = await loadSequenceState();
let sequenceSaveTimer = null;
const dbPool = createDbPool(env);

const clients = new Set();
const state = {
  boats: new Map(),
  routes: new Map(),
  stations: [],
  routeStops: [],
  senderEnabled: parseBool(env.SEND_TO_TARGET),
  targetEndpoint: String(env.TARGET_GPS_ENDPOINT || '').trim(),
  targetApiKey: String(env.TARGET_GPS_API_KEY || '').trim(),
  lastSend: null,
  lastGps: null,
  offlineQueue: [],
  collector: null,
  collectorQueue: [],
  lastCollectorSend: null,
  lastRecordingSession: null,
  lastTrackingApiCall: null,
  apiCallLog: [],
  lastAutoSavedRoute: null,
  gpsDevicesByBoatCode: new Map(),
  hubBoats: new Map(),
  signalrStatus: {
    connected: false,
    hubUrl: '',
    lastError: null,
    lastEventAt: null,
    transport: null,
  },
  dbStatus: { ok: false, message: 'Not loaded yet', loadedAt: null },
};

let hubBroadcastTimer = null;
const signalrRelay = createSignalRRelay({
  getHubUrl: () => {
    const configured = cleanOptionalText(env.SIGNALR_HUB_URL);
    if (configured) return configured;
    const root = getTargetApiRoot();
    return root ? `${root}/hubs/tracking` : '';
  },
  onBoatLocation: (payload) => {
    upsertHubBoat(payload);
    // Gộp broadcast để không flood SSE khi GPS ping dày.
    if (hubBroadcastTimer) return;
    hubBroadcastTimer = setTimeout(() => {
      hubBroadcastTimer = null;
      broadcast();
    }, 200);
  },
  onStatus: (status) => {
    state.signalrStatus = status;
    broadcast();
  },
});

const boatsSql = `
with default_route as (
  select route_id from routes where coalesce(status, '') ilike 'active' order by created_at nulls last limit 1
),
latest_trip as (
  select distinct on (boat_id) boat_id, trip_id, route_id
  from trips
  where route_id is not null
  order by boat_id, departure_time desc nulls last, created_at desc nulls last
)
select coalesce(jsonb_agg(jsonb_build_object(
  'boatId', b.boat_id,
  'boatCode', b.boat_code,
  'boatName', b.boat_name,
  'status', b.status,
  'maxSpeedKmh', b.max_speed_kmh,
  'numberOfDecks', b.number_of_decks,
  'tripId', t.trip_id,
  'routeId', coalesce(t.route_id, (select route_id from default_route))
)), '[]'::jsonb)
from boats b
left join latest_trip t on t.boat_id = b.boat_id
where coalesce(b.status, '') ilike 'active';
`;

const routesSql = `
select coalesce(jsonb_agg(jsonb_build_object(
  'routeId', route_id,
  'routeCode', route_code,
  'routeName', route_name,
  'status', status,
  'baseDistanceKm', base_distance_km,
  'estimatedDurationMin', estimated_duration_min,
  'geojson', ST_AsGeoJSON(route_geometry)::jsonb
)), '[]'::jsonb)
from routes
where route_geometry is not null;
`;

const routeStopsSql = `
select coalesce(jsonb_agg(jsonb_build_object(
  'routeId', rs.route_id,
  'routeStopId', rs.route_stop_id,
  'stationId', s.station_id,
  'stationCode', s.station_code,
  'stationName', s.station_name,
  'lat', s.latitude,
  'lng', s.longitude,
  'stopOrder', rs.stop_order,
  'standardTravelMin', rs.standard_travel_min
) order by rs.route_id, rs.stop_order), '[]'::jsonb)
from route_stops rs
join stations s on s.station_id = rs.station_id;
`;

const stationsSql = `
select coalesce(jsonb_agg(jsonb_build_object(
  'stationId', s.station_id,
  'stationCode', s.station_code,
  'stationName', s.station_name,
  'lat', s.latitude,
  'lng', s.longitude,
  'routeId', null,
  'stopOrder', null
) order by s.station_name), '[]'::jsonb)
from stations s
where s.latitude is not null and s.longitude is not null;
`;

const gpsDevicesSql = `
select coalesce(jsonb_agg(jsonb_build_object(
  'boatId', b.boat_id,
  'boatCode', b.boat_code,
  'deviceId', d.device_id,
  'isActive', d.is_active
) order by b.boat_code), '[]'::jsonb)
from gps_devices d
join boats b on b.boat_id = d.boat_id
where coalesce(d.is_active, true) = true
  and d.device_id is not null
  and b.boat_code is not null;
`;

/** Sau khi dừng ghi survey, ignore echo SignalR một lúc để marker không hiện lại. */
const hubBoatSuppressUntil = new Map();
let boatsLatestPollBusy = false;
let boatsLatestLastOkAt = null;
let boatsLatestLastError = null;

await refreshFromDatabase();
setInterval(refreshFromDatabase, Number(env.DB_REFRESH_MS || 15000));
setInterval(tickSimulator, 1000);
setInterval(publishGpsPositions, Number(env.SEND_INTERVAL_MS || 2000));
setInterval(publishCollectorPosition, Number(env.SEND_INTERVAL_MS || 2000));
setInterval(pruneStaleHubBoats, 5000);
// BE contract: load lần đầu + poll /boats/latest khi SignalR thiếu/lỗi.
setInterval(pollLatestBoatLocations, Number(env.BOATS_LATEST_POLL_MS || 4000));

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/debug/calls' && req.method === 'GET') {
      return sendJson(res, {
        count: state.apiCallLog.length,
        calls: state.apiCallLog,
        lastTrackingApiCall: state.lastTrackingApiCall,
        lastCollectorSend: state.lastCollectorSend,
        lastAutoSavedRoute: state.lastAutoSavedRoute,
      });
    }
    if (url.pathname === '/api/debug/calls' && req.method === 'DELETE') {
      state.apiCallLog = [];
      return sendJson(res, { ok: true, cleared: true });
    }
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, {
        ok: true,
        service: 'waterbus-gps-simulator',
        time: new Date().toISOString(),
        hasDatabase: Boolean(env.DATABASE_URL || env.DB_HOST),
        senderEnabled: state.senderEnabled,
        collectorRunning: Boolean(state.collector),
      });
    }
    if (url.pathname === '/events') return handleEvents(req, res);
    if (url.pathname === '/api/snapshot') return sendJson(res, snapshot());
    if (url.pathname === '/api/config') return sendJson(res, publicConfig());
    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      await refreshFromDatabase();
      return sendJson(res, snapshot());
    }
    if (url.pathname === '/api/sender' && req.method === 'PATCH') {
      const body = await readJson(req);
      if (body.enabled !== undefined) state.senderEnabled = Boolean(body.enabled);
      if (body.endpoint !== undefined) state.targetEndpoint = cleanOptionalText(body.endpoint) || '';
      if (body.apiKey !== undefined) state.targetApiKey = cleanOptionalText(body.apiKey) || '';
      broadcast();
      return sendJson(res, publicConfig());
    }
    if (url.pathname === '/api/routes/capture' && req.method === 'POST') {
      const body = await readJson(req);
      const route = await createCapturedRouteSafe(body);
      await refreshFromDatabase();
      return sendJson(res, route, 201);
    }
    {
      const routeMatch = url.pathname.match(/^\/api\/routes\/([^/]+)$/);
      if (routeMatch && req.method === 'GET') {
        const detail = await getRouteDetail(decodeURIComponent(routeMatch[1]));
        if (!detail) return sendJson(res, { error: 'Route not found' }, 404);
        return sendJson(res, detail);
      }
    }
    if (url.pathname === '/api/recording/save-route' && req.method === 'POST') {
      const body = await readJson(req);
      const session = state.lastRecordingSession;
      if (!session?.recordedPoints?.length && !state.collector?.recordedPoints?.length) {
        return sendJson(res, { error: 'Chưa có điểm GPS để lưu.' }, 400);
      }
      try {
        const result = await persistRecordingSession(body, session);
        broadcast();
        return sendJson(res, result, 201);
      } catch (error) {
        return sendJson(res, {
          error: error.message,
          code: error.code || undefined,
        }, error.status || 500);
      }
    }
    if (url.pathname === '/api/live/gps' && req.method === 'POST') {
      const body = await readJson(req);
      try {
        const result = await publishLiveGpsPosition(body);
        return sendJson(res, result, result.ok ? 200 : (result.status || 400));
      } catch (error) {
        return sendJson(res, {
          ok: false,
          error: error.message,
          code: error.code || undefined,
        }, error.status || 500);
      }
    }
    if (url.pathname === '/api/collector/start' && req.method === 'POST') {
      const body = await readJson(req);
      state.collector = startCollector(body);
      state.collectorQueue = [];
      state.lastCollectorSend = null;
      state.lastAutoSavedRoute = null;
      // Đồng bộ sequence cao hơn mọi bản tin cũ trên Azure (tránh 409 "sequence cũ").
      bumpDeviceSequence(state.collector.deviceId, state.collector);
      if (state.collector.sendToTarget && getTargetApiRoot()) {
        const sessionResult = await startTrackingSessionOnTarget(state.collector);
        if (sessionResult.ok) {
          state.collector.targetSessionStarted = true;
          state.collector.targetSessionWarning = null;
        } else {
          // Device chưa đăng ký / session fail → ghi local, vẫn tự lưu DB khi xong.
          state.collector.targetSessionStarted = false;
          state.collector.sendToTarget = false;
          state.collector.targetSessionWarning = `${sessionResult.error || 'Khong bat dau session tren BE'}. Dang ghi local — se tu luu DB khi tau den dich.`;
        }
      }
      broadcast();
      return sendJson(res, state.collector, 201);
    }
    if (url.pathname === '/api/collector/pause' && req.method === 'PATCH') {
      const body = await readJson(req);
      if (!state.collector) return sendJson(res, { error: 'Collector is not running' }, 404);
      state.collector.paused = Boolean(body.paused);
      state.collector.status = state.collector.paused ? 'paused' : 'moving';
      broadcast();
      return sendJson(res, state.collector);
    }
    if (url.pathname === '/api/collector/stop' && req.method === 'POST') {
      const stopped = state.collector;
      let targetStop = null;
      // Keep Azure session open until save-route (from-gps needs active session).
      if (stopped?.recordedPoints?.length) {
        state.lastRecordingSession = {
          sessionId: stopped.sessionId,
          routeCode: stopped.routeCode,
          routeName: stopped.routeName,
          boatCode: stopped.boatCode,
          deviceId: stopped.deviceId,
          tripId: stopped.tripId,
          recordingStatus: 'stopped',
          recordedPoints: stopped.recordedPoints,
          // Giữ đúng đường user vẽ — không dùng mẫu GPS thưa khi tạo geometry.
          plannedCoordinates: Array.isArray(stopped.coordinates) ? stopped.coordinates : null,
          startStationId: stopped.startStationId || null,
          endStationId: stopped.endStationId || null,
          routeType: stopped.routeType || null,
          stops: Array.isArray(stopped.stops) ? stopped.stops : null,
          createReverseRoute: Boolean(stopped.createReverseRoute),
          reverseRouteCode: stopped.reverseRouteCode || null,
          reverseRouteName: stopped.reverseRouteName || null,
          averageSpeedKmh: stopped.speedKmh || null,
          stoppedAt: new Date().toISOString(),
          targetSessionStarted: Boolean(stopped.targetSessionStarted),
        };
      }
      state.collector = null;
      state.collectorQueue = [];
      clearHubBoat(stopped?.boatCode, { suppressMs: 180_000 });
      broadcast();
      return sendJson(res, {
        ok: true,
        stopped,
        session: state.lastRecordingSession || null,
        targetStop,
      });
    }
    if (url.pathname.startsWith('/api/boats/') && url.pathname.endsWith('/speed') && req.method === 'PATCH') {
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const body = await readJson(req);
      const boat = state.boats.get(id);
      if (!boat) return sendJson(res, { error: 'Boat not found' }, 404);
      boat.speedKmh = clamp(Number(body.speedKmh), 0, Math.max(boat.maxSpeedKmh || 40, 80));
      boat.manualSpeed = true;
      broadcast();
      return sendJson(res, boat);
    }
    if (url.pathname.startsWith('/api/boats/') && url.pathname.endsWith('/pause') && req.method === 'PATCH') {
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const body = await readJson(req);
      const boat = state.boats.get(id);
      if (!boat) return sendJson(res, { error: 'Boat not found' }, 404);
      boat.paused = Boolean(body.paused);
      boat.status = boat.paused ? 'stopped' : 'moving';
      broadcast();
      return sendJson(res, boat);
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    if (!error.status) console.error(error);
    return sendJson(res, {
      error: error.message,
      code: error.code || undefined,
    }, error.status || 500);
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Stop the running simulator or set another PORT in .env.`);
    process.exit(1);
  }
  throw error;
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Waterbus GPS simulator: http://localhost:${port}`);
  signalrRelay.start().catch((error) => {
    console.warn(`[signalr-relay] start: ${error.message}`);
  });
  // BE: GET /api/tracking/boats/latest lần đầu rồi poll (fallback khi hub chưa có).
  pollLatestBoatLocations({ force: true }).catch((error) => {
    console.warn(`[boats-latest] seed: ${error.message}`);
  });
});

function isActiveBoatCode(boatCode) {
  const code = String(boatCode || '').trim();
  if (!code) return false;
  const boat = [...state.boats.values()].find((row) => (
    String(row.boatCode || '').trim() === code
    && !String(row.boatId || '').startsWith('collector-')
    && row.boatId !== 'fallback-boat'
  ));
  if (!boat) return false;
  return String(boat.dbStatus || '').trim().toLowerCase() === 'active';
}

function upsertHubBoat(payload) {
  if (!payload || typeof payload !== 'object') return;
  const code = String(payload.boatCode || '').trim();
  const lat = Number(payload.lat);
  const lng = Number(payload.lng);
  if (!code || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  // Không hiện / giữ hub cho tàu không Active.
  if (!isActiveBoatCode(code)) {
    state.hubBoats.delete(code);
    return;
  }
  const suppressUntil = hubBoatSuppressUntil.get(code) || 0;
  if (suppressUntil > Date.now()) return;
  if (suppressUntil) hubBoatSuppressUntil.delete(code);
  // Đang hoặc vừa survey cùng mã → không giữ twin live trên map (marker collector/route xong sẽ ẩn).
  if (state.collector && String(state.collector.boatCode || '').trim() === code) return;
  state.hubBoats.set(code, {
    boatCode: code,
    boatName: payload.boatName || null,
    boatId: payload.boatId || null,
    deviceId: payload.deviceId || null,
    routeId: payload.routeId || null,
    routeCode: payload.routeCode || null,
    tripId: payload.tripId || null,
    tripCode: payload.tripCode || null,
    lat,
    lng,
    speedKmh: Number.isFinite(Number(payload.speedKmh)) ? Number(payload.speedKmh) : null,
    heading: Number.isFinite(Number(payload.heading)) ? Number(payload.heading) : null,
    recordedAt: payload.recordedAt || null,
    receivedAt: payload.receivedAt || null,
    sequence: payload.sequence ?? null,
    isOnline: payload.isOnline !== false,
    updatedAt: new Date().toISOString(),
  });
}

function clearHubBoat(boatCode, { suppressMs = 120_000 } = {}) {
  const code = String(boatCode || '').trim();
  if (!code) return false;
  const had = state.hubBoats.delete(code);
  if (suppressMs > 0) hubBoatSuppressUntil.set(code, Date.now() + suppressMs);
  return had;
}

/** Tàu live không còn ping thì biến mất khỏi map (sau khi ghi GPS xong cũng hết). */
function pruneStaleHubBoats() {
  const ttl = Math.max(10_000, Number(env.HUB_BOAT_TTL_MS || 45_000));
  const now = Date.now();
  let changed = false;
  for (const [code, boat] of [...state.hubBoats.entries()]) {
    if (!isActiveBoatCode(code)) {
      state.hubBoats.delete(code);
      changed = true;
      continue;
    }
    const updated = Date.parse(boat.updatedAt || '');
    if (!Number.isFinite(updated) || now - updated > ttl) {
      state.hubBoats.delete(code);
      changed = true;
    }
  }
  if (changed) broadcast();
}

/**
 * FE/admin BE contract:
 * 1) GET /api/tracking/boats/latest — seed marker
 * 2) SignalR boatLocation — realtime
 * 3) Poll lại latest mỗi vài giây nếu hub disconnect / chưa deploy
 */
async function pollLatestBoatLocations({ force = false } = {}) {
  if (boatsLatestPollBusy) return;
  if (!getTargetApiRoot()) return;
  // Hub đang connected → poll thưa hơn (chỉ catch-up), vẫn seed nếu force.
  const hubOk = Boolean(state.signalrStatus?.connected);
  if (!force && hubOk) {
    const last = boatsLatestLastOkAt ? Date.parse(boatsLatestLastOkAt) : 0;
    if (Number.isFinite(last) && Date.now() - last < 15_000) return;
  }

  boatsLatestPollBusy = true;
  try {
    const deviceId = surveyDeviceId();
    const result = await getFromTargetApi('/api/tracking/boats/latest', deviceId, { silent: true });
    if (!result.ok) {
      boatsLatestLastError = result.error || `HTTP ${result.status}`;
      return;
    }
    const rows = normalizeLatestBoatRows(result.data);
    let changed = false;
    for (const row of rows) {
      const before = state.hubBoats.get(String(row.boatCode || '').trim());
      upsertHubBoat(row);
      const after = state.hubBoats.get(String(row.boatCode || '').trim());
      if (after && (!before || before.lat !== after.lat || before.lng !== after.lng || before.updatedAt !== after.updatedAt)) {
        changed = true;
      }
    }
    boatsLatestLastOkAt = new Date().toISOString();
    boatsLatestLastError = null;
    if (changed || force) broadcast();
  } catch (error) {
    boatsLatestLastError = error.message;
    console.warn(`[boats-latest] ${error.message}`);
  } finally {
    boatsLatestPollBusy = false;
  }
}

function normalizeLatestBoatRows(data) {
  const list = Array.isArray(data)
    ? data
    : (Array.isArray(data?.items) ? data.items
      : Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.boats) ? data.boats
          : Array.isArray(data?.results) ? data.results
            : []);
  return list.map((row) => ({
    boatCode: row.boatCode || row.BoatCode || row.boat_code,
    boatName: row.boatName || row.BoatName || row.boat_name || null,
    boatId: row.boatId || row.BoatId || row.boat_id || null,
    deviceId: row.deviceId || row.DeviceId || row.device_id || null,
    routeId: row.routeId || row.RouteId || null,
    routeCode: row.routeCode || row.RouteCode || null,
    tripId: row.tripId || row.TripId || null,
    tripCode: row.tripCode || row.TripCode || null,
    lat: row.lat ?? row.latitude ?? row.Latitude,
    lng: row.lng ?? row.lon ?? row.longitude ?? row.Longitude,
    speedKmh: row.speedKmh ?? row.SpeedKmh ?? row.speed_kmh,
    heading: row.heading ?? row.Heading,
    recordedAt: row.recordedAt || row.RecordedAt || row.recorded_at || null,
    receivedAt: row.receivedAt || row.ReceivedAt || null,
    sequence: row.sequence ?? row.Sequence ?? null,
    isOnline: row.isOnline ?? row.IsOnline ?? row.is_online ?? true,
  })).filter((row) => String(row.boatCode || '').trim());
}

async function loadEnv() {
  const values = { ...process.env };
  const envPath = path.join(rootDir, '.env');
  if (!existsSync(envPath)) return values;
  const content = await readFile(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!values[key]) values[key] = value;
  }
  return values;
}

async function refreshFromDatabase() {
  try {
    let [boats, routes, stations, routeStops, gpsDevices] = await Promise.all([
      queryJson(boatsSql),
      queryJson(routesSql),
      queryJson(stationsSql),
      queryJson(routeStopsSql),
      queryJson(gpsDevicesSql).catch(() => []),
    ]);

    // Tàu mới thêm vào boats → tự insert gps_devices (device_id = gps-{boatcode}).
    const registeredCount = await ensureGpsDevicesForBoats(boats);
    if (registeredCount > 0) {
      gpsDevices = await queryJson(gpsDevicesSql).catch(() => gpsDevices);
    }

    state.gpsDevicesByBoatCode = new Map();
    for (const row of Array.isArray(gpsDevices) ? gpsDevices : []) {
      const code = String(row.boatCode || '').trim();
      const deviceId = String(row.deviceId || '').trim();
      if (code && deviceId) state.gpsDevicesByBoatCode.set(code, deviceId);
    }

    state.routes.clear();
    for (const route of routes) {
      const coordinates = parseRouteCoordinates(route.geojson);
      if (coordinates.length >= 2) {
        state.routes.set(route.routeId, {
          ...route,
          coordinates,
          lengthMeters: routeLength(coordinates),
          baseDistanceKm: route.baseDistanceKm != null
            ? Number(route.baseDistanceKm)
            : round(routeLength(coordinates) / 1000, 3),
          estimatedDurationMin: route.estimatedDurationMin != null
            ? Number(route.estimatedDurationMin)
            : null,
        });
      }
    }

    state.stations = stations.map((station) => ({
      ...station,
      lat: Number(station.lat),
      lng: Number(station.lng),
    }));
    state.routeStops = Array.isArray(routeStops) ? routeStops : [];

    const routeList = [...state.routes.values()];
    // Vị trí mặc định khi tàu chưa có route (trung tâm sông SG) — vẫn hiện tàu thật.
    const defaultAnchor = state.stations[0]
      ? { lat: Number(state.stations[0].lat), lng: Number(state.stations[0].lng) }
      : { lat: 10.776, lng: 106.705 };
    let boatIndex = 0;
    for (const dbBoat of boats) {
      const existing = state.boats.get(dbBoat.boatId);
      const hasOwnRoute = Boolean(dbBoat.routeId && state.routes.has(dbBoat.routeId));
      const route = hasOwnRoute
        ? state.routes.get(dbBoat.routeId)
        : (routeList[boatIndex % Math.max(routeList.length, 1)] || null);
      const idx = boatIndex;
      boatIndex += 1;
      const stagger = route ? route.lengthMeters * ((idx * 0.37) % 1) : 0;
      const maxSpeedKmh = Number(dbBoat.maxSpeedKmh || env.DEFAULT_SPEED_KMH || 16);
      const base = {
        boatId: dbBoat.boatId,
        boatCode: dbBoat.boatCode,
        boatName: dbBoat.boatName,
        dbStatus: dbBoat.status,
        numberOfDecks: Number(dbBoat.numberOfDecks) || 1,
        routeId: route ? route.routeId : null,
        routeCode: route ? route.routeCode : null,
        routeName: route ? route.routeName : null,
        maxSpeedKmh,
      };

      if (existing) {
        const routeChanged = existing.routeId !== (route ? route.routeId : null);
        Object.assign(existing, base);
        existing.deviceId = deviceIdForBoat(dbBoat);
        if (!existing.manualSpeed) {
          existing.speedKmh = Math.min(
            Number(existing.speedKmh || env.DEFAULT_SPEED_KMH || 16),
            maxSpeedKmh || Number(env.DEFAULT_SPEED_KMH || 16),
          );
        }
        // Spread boats that share a route so many are visible on the map.
        if (route && !hasOwnRoute && routeChanged) {
          existing.progressMeters = stagger;
          existing.direction = idx % 2 === 0 ? 1 : -1;
          const pos = pointAtDistance(route.coordinates, existing.progressMeters);
          existing.lat = pos.lat;
          existing.lng = pos.lng;
          existing.heading = existing.direction === 1 ? pos.heading : (pos.heading + 180) % 360;
        }
        if (!route && (!Number.isFinite(Number(existing.lat)) || !Number.isFinite(Number(existing.lng)))) {
          existing.lat = defaultAnchor.lat;
          existing.lng = defaultAnchor.lng;
        }
      } else {
        const start = route ? pointAtDistance(route.coordinates, stagger) : { ...defaultAnchor, heading: 0 };
        const deviceId = deviceIdForBoat(dbBoat);
        state.boats.set(dbBoat.boatId, {
          ...base,
          deviceId,
          tripId: dbBoat.tripId || null,
          progressMeters: stagger,
          direction: idx % 2 === 0 ? 1 : -1,
          sequence: sequenceState[deviceId] ?? initialSequence(),
          batteryPercent: randomInt(78, 96),
          signalStrength: 4,
          gpsFixQuality: 'good',
          speedKmh: Math.min(
            Number(env.DEFAULT_SPEED_KMH || 16),
            maxSpeedKmh || Number(env.DEFAULT_SPEED_KMH || 16),
          ),
          heading: start.heading,
          lat: start.lat,
          lng: start.lng,
          status: route ? 'moving' : 'idle',
          paused: false,
          manualSpeed: false,
          updatedAt: new Date().toISOString(),
        });
      }
    }
    // Bỏ tàu demo khi đã có tàu thật từ DB.
    if (boats.length && state.boats.has('fallback-boat')) {
      state.boats.delete('fallback-boat');
    }

    const activeBoatIds = new Set(boats.map((boat) => boat.boatId));
    const activeBoatCodes = new Set(
      boats.map((boat) => String(boat.boatCode || '').trim()).filter(Boolean),
    );
    for (const boatId of [...state.boats.keys()]) {
      if (!activeBoatIds.has(boatId) && !String(boatId).startsWith('collector-') && boatId !== 'fallback-boat') {
        state.boats.delete(boatId);
      }
    }
    // Tàu Inactive: bỏ hub + không còn gửi/hiện GPS live.
    for (const code of [...state.hubBoats.keys()]) {
      if (!activeBoatCodes.has(code)) state.hubBoats.delete(code);
    }

    // Chỉ dùng tàu demo khi DB thật sự KHÔNG có tàu nào.
    // Route trống không được xóa tàu thật (tránh hiện WB_01 giả).
    if (!state.boats.size && parseBool(env.USE_FALLBACK_WHEN_EMPTY ?? 'true')) {
      ensureFallbackData();
      state.dbStatus = {
        ok: true,
        message: `Loaded ${boats.length} boat(s), ${routes.length} route(s); using demo fallback`,
        loadedAt: new Date().toISOString(),
      };
    } else {
      state.dbStatus = { ok: true, message: `Loaded ${boats.length} boat(s), ${routes.length} route(s)`, loadedAt: new Date().toISOString() };
    }
    broadcast();
  } catch (error) {
    state.dbStatus = { ok: false, message: error.message, loadedAt: new Date().toISOString() };
    ensureFallbackData();
    broadcast();
  }
}

function tickSimulator() {
  for (const boat of state.boats.values()) {
    const route = state.routes.get(boat.routeId);
    if (!route || boat.paused || boat.speedKmh <= 0) continue;
    const metersPerSecond = boat.speedKmh / 3.6;
    boat.direction ||= 1;
    boat.progressMeters += metersPerSecond * boat.direction;

    if (boat.progressMeters >= route.lengthMeters) {
      boat.progressMeters = route.lengthMeters;
      boat.direction = -1;
    } else if (boat.progressMeters <= 0) {
      boat.progressMeters = 0;
      boat.direction = 1;
    }

    const next = pointAtDistance(route.coordinates, boat.progressMeters);
    boat.lat = next.lat;
    boat.lng = next.lng;
    boat.heading = boat.direction === 1 ? next.heading : (next.heading + 180) % 360;
    boat.status = 'moving';
    boat.updatedAt = new Date().toISOString();
  }
  tickCollector();
  broadcast();
}

function tickCollector() {
  const collector = state.collector;
  if (!collector || collector.paused || collector.status === 'completed' || collector.speedKmh <= 0) return;
  const metersPerSecond = collector.speedKmh / 3.6;
  collector.progressMeters = Math.min(collector.lengthMeters, collector.progressMeters + metersPerSecond);
  const next = pointAtDistance(collector.coordinates, collector.progressMeters);
  collector.lat = next.lat;
  collector.lng = next.lng;
  collector.heading = next.heading;
  collector.updatedAt = new Date().toISOString();
  if (collector.progressMeters >= collector.lengthMeters) {
    // Dừng đúng điểm cuối (bến đích) — idle cho GPS side FE.
    const end = pointAtDistance(collector.coordinates, collector.lengthMeters);
    const endStation = collector.endStationId
      ? (state.stations || []).find((s) => String(s.stationId) === String(collector.endStationId))
      : null;
    if (endStation && Number.isFinite(Number(endStation.lat)) && Number.isFinite(Number(endStation.lng))) {
      collector.lat = Number(endStation.lat);
      collector.lng = Number(endStation.lng);
    } else {
      collector.lat = end.lat;
      collector.lng = end.lng;
    }
    collector.heading = end.heading;
    collector.progressMeters = collector.lengthMeters;
    collector.speedKmh = 0;
    collector.status = 'completed';
    collector.gpsEndStatus = 'idle';
  } else {
    collector.status = 'moving';
  }
}

async function publishGpsPositions() {
  // Mặc định không POST tàu live — chỉ survey collector (tránh 400 spam trên Azure).
  if (!parseBool(env.PUBLISH_LIVE_BOATS || 'false')) return;
  // Khi đang survey GPS, không POST tàu live — tránh đụng sequence/deviceId với collector.
  if (state.collector) {
    return;
  }

  const payloads = [...state.boats.values()].map(buildTargetPayload);
  state.lastGps = { at: new Date().toISOString(), payloads };

  if (!state.senderEnabled || !getTargetEndpoint()) {
    state.lastSend = {
      at: state.lastGps.at,
      mode: 'local',
      results: payloads.map((payload) => ({ boatCode: payload.boatCode, ok: true, status: 'generated' })),
    };
    broadcast();
    return;
  }

  const results = [];
  const pendingPayloads = [...state.offlineQueue, ...payloads];
  state.offlineQueue = [];

  for (const payload of pendingPayloads) {
    try {
      const azurePayload = sanitizeGpsPayloadForAzure(payload);
      const body = JSON.stringify(azurePayload);
      const headers = buildGpsHeaders(azurePayload);
      const response = await fetch(getTargetEndpoint(), {
        method: 'POST',
        headers,
        body,
      });
      let accepted = response.status >= 200 && response.status < 300;
      if (response.status === 409) {
        const retried = await retryGpsAfterSequenceConflict(azurePayload);
        accepted = retried.ok;
        results.push({
          boatCode: payload.boatCode,
          ok: accepted,
          status: accepted ? retried.status : 409,
          error: accepted ? undefined : 'sequence conflict (409)',
        });
        if (!accepted && response.status >= 500) state.offlineQueue.push(payload);
        continue;
      }
      results.push({ boatCode: payload.boatCode, ok: accepted, status: response.status });
      if (response.status >= 500) state.offlineQueue.push(payload);
    } catch (error) {
      state.offlineQueue.push(payload);
      results.push({ boatCode: payload.boatCode, ok: false, error: error.message });
    }
  }
  state.lastSend = { at: new Date().toISOString(), mode: 'target', results };
  broadcast();
}

async function publishCollectorPosition() {
  const collector = state.collector;
  if (!collector || collector.status === 'idle') return;
  if (collector.paused) return;
  const sendIntervalMs = clamp(Number(collector.sendIntervalMs || 5000), 3000, 10000);
  const now = Date.now();
  if (collector.lastPublishAt && now - collector.lastPublishAt < sendIntervalMs && !state.collectorQueue.length) return;
  const shouldCreatePayload = !(collector.status === 'completed' && collector.completedPublished);
  if (!shouldCreatePayload && !state.collectorQueue.length) return;
  let payload = collector.lastPayload;
  if (shouldCreatePayload) {
    payload = buildRecordingPayload(collector);
    collector.sampleCount += 1;
    collector.lastPayload = payload;
    if (collector.recording) {
      collector.recordedPoints.push({
        lat: payload.lat,
        lng: payload.lng,
        accuracyMeters: payload.accuracyMeters,
        sequence: payload.sequence,
        recordedAt: payload.recordedAt,
      });
    }
    if (collector.status === 'completed') collector.completedPublished = true;
  }

  const endpoint = getTargetEndpoint();
  if (!collector.sendToTarget || !endpoint) {
    collector.lastPublishAt = now;
    state.lastCollectorSend = {
      at: new Date().toISOString(),
      mode: 'local',
      ok: true,
      status: 'generated',
      payload,
      recordedCount: collector.recordedPoints.length,
    };
    broadcast();
    if (collector.status === 'completed' && collector.completedPublished) {
      queueFinalizeCollector();
    }
    return;
  }

  const pendingPayloads = shouldCreatePayload
    ? [...state.collectorQueue, payload]
    : [...state.collectorQueue];
  state.collectorQueue = [];
  const results = [];

  for (const item of pendingPayloads) {
    try {
      const azurePayload = sanitizeGpsPayloadForAzure(item);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: buildGpsHeaders(azurePayload),
        body: JSON.stringify(azurePayload),
      });
      let ok = response.status >= 200 && response.status < 300;
      let status = response.status;
      let errorText = null;
      if (response.status === 409) {
        const retried = await retryGpsAfterSequenceConflict(azurePayload);
        ok = retried.ok;
        status = retried.status;
        errorText = ok ? null : (retried.error || 'sequence conflict (409)');
        // Vẫn coi là gửi được cho UI nếu chỉ lệch sequence — điểm đã ghi local.
        if (!ok && retried.soft) {
          results.push({
            ok: false,
            soft: true,
            status: 409,
            sequence: item.sequence,
            error: 'Sequence lệch BE (điểm vẫn ghi local, sẽ lưu khi xong)',
          });
          continue;
        }
      } else if (!ok) {
        try {
          const text = await response.text();
          if (text) {
            const parsed = JSON.parse(text);
            errorText = parsed.error || parsed.message || text.slice(0, 160);
          }
        } catch {
          // ignore body parse errors
        }
      }
      results.push({ ok, status, sequence: item.sequence, error: errorText });
      if (status >= 500) state.collectorQueue.push(item);
    } catch (error) {
      state.collectorQueue.push(item);
      results.push({ ok: false, error: error.message, sequence: item.sequence });
    }
  }

  collector.lastPublishAt = now;
  const lastResult = results.at(-1) || { ok: false, status: 'not-sent' };
  state.lastCollectorSend = {
    at: new Date().toISOString(),
    mode: 'target',
    ...lastResult,
    soft: Boolean(lastResult.soft),
    queueSize: state.collectorQueue.length,
    payload,
    recordedCount: collector.recordedPoints.length,
  };
  broadcast();
  if (collector.status === 'completed' && collector.completedPublished) {
    queueFinalizeCollector();
  }
}

function buildTargetPayload(boat) {
  // Sequence luôn tăng theo ms — không dùng Date.now()/1000 (dễ thấp hơn bản tin cũ trên Azure).
  const next = Math.max(
    Number(boat.sequence || 0) + 1,
    Number(sequenceState[boat.deviceId] || 0) + 1,
    Date.now(),
  );
  boat.sequence = next;
  sequenceState[boat.deviceId] = next;
  scheduleSequenceSave();
  boat.batteryPercent = Math.max(8, Number(boat.batteryPercent || 90) - (Math.random() < 0.08 ? 1 : 0));
  boat.signalStrength = boat.paused ? 4 : randomInt(3, 5);
  boat.gpsFixQuality = boat.signalStrength >= 4 ? 'good' : 'fair';
  const accuracyMeters = boat.gpsFixQuality === 'good' ? randomInt(3, 8) : randomInt(9, 22);

  return {
    messageId: randomUUID(),
    deviceId: boat.deviceId,
    boatId: boat.boatId,
    boatCode: boat.boatCode,
    tripId: boat.tripId || null,
    routeId: boat.routeId,
    routeCode: boat.routeCode,
    lat: round(boat.lat, 7),
    lng: round(boat.lng, 7),
    speedKmh: round(boat.speedKmh, 1),
    heading: round(boat.heading, 0),
    accuracyMeters,
    recordedAt: formatRecordedAt(new Date()),
    sequence: boat.sequence,
    batteryPercent: boat.batteryPercent,
    signalStrength: boat.signalStrength,
    gpsFixQuality: boat.gpsFixQuality,
    direction: boat.direction === -1 ? 'backward' : 'forward',
    status: boat.status,
  };
}

/**
 * Live GPS drag page: giả lập device POST /api/tracking/locations.
 * Body: { boatCode, lat, lng, speedKmh?, heading?, status?, sendToTarget? }
 */
async function publishLiveGpsPosition(body = {}) {
  const boatCode = cleanOptionalText(body.boatCode);
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!boatCode) {
    const err = new Error('Chọn boatCode trước khi gửi GPS.');
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const err = new Error('lat/lng không hợp lệ.');
    err.status = 400;
    throw err;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    const err = new Error('lat/lng ngoài phạm vi WGS84.');
    err.status = 400;
    throw err;
  }

  if (!isActiveBoatCode(boatCode)) {
    state.hubBoats.delete(boatCode);
    return {
      ok: false,
      status: 403,
      error: `Tàu ${boatCode} không hoạt động (Inactive) — không gửi GPS / không hiện map.`,
    };
  }

  if (state.collector && String(state.collector.boatCode || '').trim() === boatCode) {
    return {
      ok: false,
      status: 409,
      error: `Tàu ${boatCode} đang ghi GPS survey — không kéo live cùng lúc (tránh đụng sequence).`,
    };
  }

  const matched = [...state.boats.values()].find((boat) => (
    String(boat.boatCode) === boatCode
    && !String(boat.boatId || '').startsWith('collector-')
    && String(boat.dbStatus || '').trim().toLowerCase() === 'active'
  ));
  const deviceId = deviceIdForBoat({ boatCode, boatId: matched?.boatId });
  const prev = state.hubBoats.get(boatCode);
  const speedKmh = Number.isFinite(Number(body.speedKmh))
    ? Number(body.speedKmh)
    : 0;
  const heading = resolveStableHeading({
    requested: body.heading,
    prev,
    lat,
    lng,
    speedKmh,
  });
  const status = cleanOptionalText(body.status) || (speedKmh > 0.5 ? 'moving' : 'idle');

  const sequence = bumpDeviceSequence(deviceId, matched || null);
  const payload = {
    messageId: randomUUID(),
    deviceId,
    boatId: matched?.boatId || body.boatId || null,
    boatCode,
    boatName: matched?.boatName || body.boatName || null,
    tripId: null,
    routeId: null,
    routeCode: null,
    lat: round(lat, 7),
    lng: round(lng, 7),
    speedKmh: round(speedKmh, 1),
    heading: round(heading, 0),
    accuracyMeters: randomInt(3, 12),
    recordedAt: formatRecordedAt(new Date()),
    sequence,
    batteryPercent: matched?.batteryPercent || randomInt(70, 95),
    signalStrength: randomInt(3, 5),
    gpsFixQuality: 'good',
    direction: 'forward',
    status,
    capturedRoute: null,
  };

  const sendToTarget = body.sendToTarget !== undefined
    ? Boolean(body.sendToTarget)
    : Boolean(state.senderEnabled && getTargetEndpoint());

  // Optimistic local hub marker (SSE) — BE sẽ đồng bộ lại qua SignalR / boats/latest.
  hubBoatSuppressUntil.delete(boatCode);
  upsertHubBoat({
    ...payload,
    isOnline: true,
    recordedAt: payload.recordedAt,
    receivedAt: new Date().toISOString(),
  });
  broadcast();

  if (!sendToTarget || !getTargetEndpoint()) {
    return {
      ok: true,
      status: 200,
      mode: 'local',
      sequence: payload.sequence,
      payload,
      warning: 'Chưa gửi Azure (SEND_TO_TARGET tắt hoặc chưa cấu hình endpoint).',
    };
  }

  try {
    const azurePayload = sanitizeGpsPayloadForAzure(payload);
    const response = await fetch(getTargetEndpoint(), {
      method: 'POST',
      headers: buildGpsHeaders(azurePayload),
      body: JSON.stringify(azurePayload),
    });
    let ok = response.status >= 200 && response.status < 300;
    let statusCode = response.status;
    let errorText = null;
    let responseData = null;
    const text = await response.text();
    if (text) {
      try { responseData = JSON.parse(text); } catch { responseData = { message: text }; }
    }
    if (response.status === 409) {
      const retried = await retryGpsAfterSequenceConflict(azurePayload);
      ok = retried.ok;
      statusCode = retried.status;
      errorText = ok ? null : (retried.error || 'sequence conflict (409)');
      if (!ok && retried.soft) {
        pushApiCallLog({
          method: 'POST',
          url: getTargetEndpoint(),
          path: '/api/tracking/locations',
          ok: false,
          soft: true,
          status: 409,
          error: errorText,
          at: new Date().toISOString(),
          request: summarizeApiPayload(payload),
          response: summarizeApiPayload(responseData),
          deviceId,
        });
        return {
          ok: true,
          soft: true,
          status: 409,
          sequence: payload.sequence,
          payload,
          warning: 'Sequence lệch BE — điểm đã cập nhật local map.',
        };
      }
    }
    if (!ok) {
      errorText = formatTargetApiError(responseData, statusCode);
    }
    pushApiCallLog({
      method: 'POST',
      url: getTargetEndpoint(),
      path: '/api/tracking/locations',
      ok,
      status: statusCode,
      error: errorText,
      at: new Date().toISOString(),
      request: summarizeApiPayload(payload),
      response: summarizeApiPayload(responseData),
      deviceId,
    });
    return {
      ok,
      status: statusCode,
      mode: 'target',
      sequence: payload.sequence,
      payload,
      error: errorText,
      data: responseData,
    };
  } catch (error) {
    pushApiCallLog({
      method: 'POST',
      url: getTargetEndpoint(),
      path: '/api/tracking/locations',
      ok: false,
      status: 502,
      error: error.message,
      at: new Date().toISOString(),
      request: summarizeApiPayload(payload),
      response: null,
      deviceId,
    });
    return {
      ok: false,
      status: 502,
      mode: 'target',
      sequence: payload.sequence,
      payload,
      error: error.message,
    };
  }
}

function bumpDeviceSequence(deviceId, boat = null) {
  const next = Math.max(
    Number(sequenceState[deviceId] || 0) + 1,
    Number(boat?.sequence || 0) + 1,
    Date.now() + 1,
  );
  sequenceState[deviceId] = next;
  if (boat) boat.sequence = next;
  scheduleSequenceSave();
  return next;
}

async function retryGpsAfterSequenceConflict(payload) {
  const nextSequence = Math.max(bumpDeviceSequence(payload.deviceId), Date.now() + Math.floor(Math.random() * 1000));
  payload.sequence = nextSequence;
  payload.messageId = randomUUID();
  payload.recordedAt = formatRecordedAt(new Date());
  sequenceState[payload.deviceId] = nextSequence;
  scheduleSequenceSave();

  if (state.collector?.deviceId === payload.deviceId) {
    state.collector.sequence = nextSequence;
  }
  for (const boat of state.boats.values()) {
    if (boat.deviceId === payload.deviceId) boat.sequence = nextSequence;
  }

  try {
    const azurePayload = sanitizeGpsPayloadForAzure(payload);
    const response = await fetch(getTargetEndpoint(), {
      method: 'POST',
      headers: buildGpsHeaders(azurePayload),
      body: JSON.stringify(azurePayload),
    });
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status };
    }
    let error = `BE tra ${response.status}`;
    try {
      const text = await response.text();
      if (text) {
        const parsed = JSON.parse(text);
        error = formatTargetApiError(parsed, response.status);
      }
    } catch {
      // ignore
    }
    // 409 sequence: coi như cảnh báo, điểm vẫn ghi local — không spam lỗi cứng.
    if (response.status === 409) {
      return { ok: false, status: 409, error, soft: true };
    }
    return { ok: false, status: response.status, error };
  } catch (error) {
    return { ok: false, status: 502, error: error.message };
  }
}

function buildGpsHeaders(payload) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Device-Id': payload.deviceId,
  };
  if (state.targetApiKey) headers['X-Api-Key'] = state.targetApiKey;
  return headers;
}

/**
 * BE routes đang trống: gửi routeId/routeCode sẽ 404 → vị trí không cập nhật.
 * Mặc định luôn null trên POST /tracking/locations (tắt bằng AZURE_GPS_OMIT_ROUTE=false).
 */
function sanitizeGpsPayloadForAzure(payload) {
  const out = { ...payload };
  if (parseBool(env.AZURE_GPS_OMIT_ROUTE ?? 'true')) {
    out.routeId = null;
    out.routeCode = null;
    out.tripId = null;
  }
  return out;
}

function getTargetEndpoint() {
  return String(state.targetEndpoint || env.TARGET_GPS_ENDPOINT || '').trim();
}

function getTargetApiRoot() {
  const endpoint = getTargetEndpoint();
  if (!endpoint) return '';
  try {
    const url = new URL(endpoint);
    const basePath = url.pathname.replace(/\/api\/tracking\/locations\/?$/i, '');
    return `${url.origin}${basePath}`.replace(/\/$/, '');
  } catch {
    return '';
  }
}

function targetApiUrl(pathname) {
  const root = getTargetApiRoot();
  if (!root) return '';
  return `${root}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

async function postToTargetApi(pathname, payload, deviceId) {
  const url = targetApiUrl(pathname);
  if (!url) {
    const result = { ok: false, error: 'Chua cau hinh TARGET_GPS_ENDPOINT', status: 400, at: new Date().toISOString(), path: pathname };
    pushApiCallLog({ method: 'POST', ...result, request: summarizeApiPayload(payload), url: null });
    return result;
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: buildGpsHeaders({ deviceId }),
      body: JSON.stringify(payload),
    });
    let data = null;
    const text = await response.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = { message: text }; }
    }
    const result = {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      data,
      error: null,
      at: new Date().toISOString(),
      path: pathname,
    };
    if (!result.ok) {
      result.error = formatTargetApiError(data, response.status);
    }
    state.lastTrackingApiCall = result;
    pushApiCallLog({
      method: 'POST',
      url,
      path: pathname,
      ok: result.ok,
      status: result.status,
      error: result.error,
      at: result.at,
      request: summarizeApiPayload(payload),
      response: summarizeApiPayload(data),
      deviceId: deviceId || null,
    });
    return result;
  } catch (error) {
    const result = {
      ok: false,
      status: 502,
      data: null,
      error: error.message,
      at: new Date().toISOString(),
      path: pathname,
    };
    state.lastTrackingApiCall = result;
    pushApiCallLog({
      method: 'POST',
      url,
      path: pathname,
      ok: false,
      status: 502,
      error: error.message,
      at: result.at,
      request: summarizeApiPayload(payload),
      response: null,
      deviceId: deviceId || null,
    });
    return result;
  }
}

function summarizeApiPayload(payload) {
  if (payload == null) return null;
  if (typeof payload !== 'object') return payload;
  if (Array.isArray(payload)) {
    return {
      _type: 'array',
      count: payload.length,
      sample: payload.slice(0, 3),
    };
  }
  const out = { ...payload };
  if (Array.isArray(out.coordinates)) {
    const coords = out.coordinates;
    out.coordinates = {
      count: coords.length,
      first: coords[0] || null,
      last: coords.length > 1 ? coords[coords.length - 1] : null,
      sample: coords.slice(0, 3),
    };
  }
  if (Array.isArray(out.stops)) {
    out.stops = out.stops.map((stop) => ({
      stationId: stop.stationId,
      stationCode: stop.stationCode,
      stationName: stop.stationName,
      stopOrder: stop.stopOrder,
      standardTravelMin: stop.standardTravelMin ?? null,
      isPickupAllowed: stop.isPickupAllowed,
      isDropoffAllowed: stop.isDropoffAllowed,
    }));
  }
  return out;
}

function pushApiCallLog(entry) {
  const row = {
    id: randomUUID(),
    ...entry,
  };
  state.apiCallLog.unshift(row);
  if (state.apiCallLog.length > 80) state.apiCallLog.length = 80;
}

function formatTargetApiError(data, status) {
  if (data == null || data === '') return `BE tra ${status} (empty body)`;
  if (typeof data !== 'object') return String(data).slice(0, 300) || `BE tra ${status}`;
  if (data.errors && typeof data.errors === 'object') {
    const parts = Object.entries(data.errors).flatMap(([field, messages]) => {
      const list = Array.isArray(messages) ? messages : [messages];
      return list.map((msg) => `${field}: ${msg}`);
    });
    if (parts.length) return parts.join(' | ');
  }
  if (Array.isArray(data) && data.length) return data.map(String).join(' | ');
  return data.error || data.message || data.title || data.detail || `BE tra ${status}`;
}

/** Azure thường bắt standardTravelMin là int ≥ 1. */
function azureTravelMinutes(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.round(n));
}

async function getFromTargetApi(pathname, deviceId, { silent = false } = {}) {
  const url = targetApiUrl(pathname);
  if (!url) {
    const result = { ok: false, error: 'Chua cau hinh TARGET_GPS_ENDPOINT', status: 400, at: new Date().toISOString(), path: pathname };
    if (!silent) pushApiCallLog({ method: 'GET', ...result, request: null, url: null });
    return result;
  }
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: buildGpsHeaders({ deviceId }),
    });
    let data = null;
    const text = await response.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = { message: text }; }
    }
    const result = {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      data,
      error: null,
      at: new Date().toISOString(),
      path: pathname,
    };
    if (!result.ok) {
      result.error = data?.error || data?.message || data?.title || `BE tra ${response.status}`;
    }
    if (!silent) {
      pushApiCallLog({
        method: 'GET',
        url,
        path: pathname,
        ok: result.ok,
        status: result.status,
        error: result.error,
        at: result.at,
        request: null,
        response: summarizeApiPayload(data),
        deviceId: deviceId || null,
      });
    }
    return result;
  } catch (error) {
    const result = { ok: false, status: 502, data: null, error: error.message, at: new Date().toISOString(), path: pathname };
    if (!silent) {
      pushApiCallLog({
        method: 'GET',
        url,
        path: pathname,
        ok: false,
        status: 502,
        error: error.message,
        at: result.at,
        request: null,
        response: null,
        deviceId: deviceId || null,
      });
    }
    return result;
  }
}

async function startTrackingSessionOnTarget(collector) {
  return postToTargetApi('/api/tracking/sessions/start', {
    sessionId: collector.sessionId,
    boatCode: collector.boatCode,
    routeCode: collector.routeCode,
    routeName: collector.routeName,
    startStationId: collector.startStationId || null,
    endStationId: collector.endStationId || null,
    plannedLengthMeters: round(collector.lengthMeters, 1),
    startedAt: formatRecordedAt(new Date()),
  }, collector.deviceId);
}

async function stopTrackingSessionOnTarget(collector, recordedPointCount) {
  return postToTargetApi(`/api/tracking/sessions/${encodeURIComponent(collector.sessionId)}/stop`, {
    stoppedAt: formatRecordedAt(new Date()),
    recordedPointCount,
    status: 'completed',
  }, collector.deviceId || deviceIdForBoat({ boatCode: collector.boatCode }));
}

/** Ưu tiên đường vẽ (planned) — recordedPoints chỉ là kênh GPS thưa, dễ làm gãy góc. */
function resolveSurveyPathCoordinates(session, body, averageSpeedKmh) {
  const sources = [
    body?.coordinates,
    session?.plannedCoordinates,
    session?.coordinates,
    session?.recordedPoints,
  ];
  let raw = [];
  let sourceName = 'none';
  for (const [index, candidate] of sources.entries()) {
    if (!Array.isArray(candidate) || candidate.length < 2) continue;
    raw = candidate;
    sourceName = ['body', 'planned', 'session.coordinates', 'recorded'][index];
    break;
  }
  const coordinates = raw
    .filter((point) => Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng)))
    .map((point, index) => ({
      lat: round(Number(point.lat), 7),
      lng: round(Number(point.lng), 7),
      speedKmh: averageSpeedKmh,
      sequence: Number(point.sequence) || index + 1,
      recordedAt: point.recordedAt || formatRecordedAt(new Date()),
    }));
  if (sourceName === 'recorded') {
    console.warn('[from-gps] Using sparse recordedPoints as geometry — corners may look wrong.');
  } else {
    console.log(`[from-gps] Geometry source: ${sourceName} (${coordinates.length} pts)`);
  }
  return coordinates;
}

async function saveRouteFromGpsOnTarget(session, body) {
  const boatCode = cleanOptionalText(body.boatCode || session.boatCode);
  const maxSpeed = maxSpeedForBoatCode(boatCode);
  const averageSpeedKmh = clampSpeedToBoatMax(
    Number(body.averageSpeedKmh || session.averageSpeedKmh || session.speedKmh || env.DEFAULT_SPEED_KMH || 16),
    maxSpeed,
  );
  // BE thường giới hạn tốc độ/phút nguyên — không gửi 200 km/h hay 0.1 phút.
  const azureMaxSpeed = Math.max(1, Number(env.AZURE_MAX_SPEED_KMH || 80));
  const azureSpeedKmh = Math.min(averageSpeedKmh, azureMaxSpeed);
  const coordinates = resolveSurveyPathCoordinates(session, body, averageSpeedKmh);

  const payload = {
    routeCode: cleanRouteText(body.routeCode || session.routeCode, 'Route code'),
    routeName: cleanRouteText(body.routeName || session.routeName || body.routeCode || session.routeCode, 'Route name'),
    description: cleanOptionalText(body.description) || 'Captured from GPS recording session',
    status: cleanOptionalText(body.status) || 'Active',
    averageSpeedKmh: azureSpeedKmh,
    coordinates,
  };
  if (session.targetSessionStarted && session.sessionId) {
    payload.sessionId = session.sessionId;
  }
  const startStationId = cleanOptionalText(body.startStationId || session.startStationId);
  const endStationId = cleanOptionalText(body.endStationId || session.endStationId);
  if (startStationId) payload.startStationId = startStationId;
  if (endStationId) payload.endStationId = endStationId;

  // Contract mới: GPS không gửi routeType/isBookable — BE tự phân loại
  // (start≠end → route nguồn; start=end → sightseeing loop).
  const inferredLoop = Boolean(startStationId && endStationId && startStationId === endStationId);

  const wantReverse = Boolean(body.createReverseRoute ?? session?.createReverseRoute)
    && !inferredLoop;
  if (wantReverse) {
    let reverseCode = cleanOptionalText(body.reverseRouteCode || session?.reverseRouteCode);
    let reverseName = cleanOptionalText(body.reverseRouteName || session?.reverseRouteName);
    // BE bắt buộc reverseRouteCode khác routeCode — tự sửa nếu thiếu/trùng.
    if (!reverseCode || reverseCode.toLowerCase() === String(payload.routeCode).toLowerCase()) {
      const parts = String(payload.routeCode || '').split('-').map((s) => s.trim()).filter(Boolean);
      reverseCode = parts.length >= 2
        ? parts.reverse().join('-')
        : `${payload.routeCode}-VE`;
      if (reverseCode.toLowerCase() === String(payload.routeCode).toLowerCase()) {
        reverseCode = `${payload.routeCode}-VE`;
      }
    }
    if (!reverseName) {
      const nameParts = String(payload.routeName || '').split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
      reverseName = nameParts.length >= 2
        ? nameParts.reverse().join(' - ')
        : `${payload.routeName || payload.routeCode} (chiều về)`;
    }
    payload.createReverseRoute = true;
    payload.reverseRouteCode = reverseCode;
    payload.reverseRouteName = reverseName;
    console.log(
      `[from-gps] reverse → ${reverseCode} (${reverseName}) for ${payload.routeCode}`,
    );
  }

  const detectRadius = Number(env.STOP_DETECT_RADIUS_M || 200);
  let stops = enrichStopsAlongPath(
    coordinates,
    body.stops || session.stops,
    startStationId,
    endStationId,
    detectRadius,
  ).map((stop, index) => ({
    stationId: stop.stationId,
    stationCode: stop.stationCode || null,
    stationName: stop.stationName || null,
    stopOrder: Number(stop.stopOrder) || index + 1,
    lat: Number.isFinite(Number(stop.lat)) ? Number(stop.lat) : null,
    lng: Number.isFinite(Number(stop.lng)) ? Number(stop.lng) : null,
    isPickupAllowed: stop.isPickupAllowed !== false,
    isDropoffAllowed: stop.isDropoffAllowed !== false,
  }));
  if (stops.length) {
    const snapped = snapCoordinatesToStops(coordinates, stops, detectRadius);
    stops = attachSegmentTravelMinutes(snapped, stops, azureSpeedKmh).map((stop) => ({
      stationId: stop.stationId,
      stationCode: stop.stationCode || null,
      stationName: stop.stationName || null,
      stopOrder: Number(stop.stopOrder) || null,
      lat: Number.isFinite(Number(stop.lat)) ? Number(stop.lat) : null,
      lng: Number.isFinite(Number(stop.lng)) ? Number(stop.lng) : null,
      isPickupAllowed: stop.isPickupAllowed !== false,
      isDropoffAllowed: stop.isDropoffAllowed !== false,
      standardTravelMin: azureTravelMinutes(stop.standardTravelMin),
      segmentDistanceKm: stop.segmentDistanceKm == null ? null : Number(stop.segmentDistanceKm),
    }));
    payload.stops = stops;
    payload.coordinates = snapped.map((point, index) => ({
      lat: round(Number(point.lat), 7),
      lng: round(Number(point.lng), 7),
      speedKmh: azureSpeedKmh,
      sequence: index + 1,
      recordedAt: point.recordedAt || coordinates[Math.min(index, coordinates.length - 1)]?.recordedAt || formatRecordedAt(new Date()),
    }));
    const segmentTotal = sumTravelMinutes(stops);
    payload.estimatedDurationMin = Math.max(
      1,
      Math.round(segmentTotal || ((routeLength(snapped) / 1000 / azureSpeedKmh) * 60)),
    );
    console.log(
      `[from-gps] ${payload.routeCode} azureSpeed=${azureSpeedKmh} segments:`,
      stops.map((s) => `#${s.stopOrder} ${s.stationCode || s.stationName || s.stationId}=${s.standardTravelMin ?? '-'}p/${s.segmentDistanceKm ?? '-'}km`).join(' | '),
    );
  }

  const targetResult = await postToTargetApi(
    '/api/routes/from-gps',
    payload,
    session.deviceId || deviceIdForBoat({ boatCode: session.boatCode }),
  );
  // Giữ stops đã gửi để UI/BE fallback nếu Azure không trả stops[].
  if (targetResult && typeof targetResult === 'object') {
    targetResult.outboundStops = stops;
    targetResult.outboundCreateReverse = Boolean(payload.createReverseRoute);
  }
  return targetResult;
}

async function persistRecordingSession(body, sessionInput = null) {
  const session = sessionInput || state.lastRecordingSession;
  let route = null;
  let savedTo = 'local';
  let warning = null;
  const hasCoordinates = (session?.recordedPoints?.length || 0) >= 2
    || (session?.plannedCoordinates?.length || 0) >= 2
    || (Array.isArray(body?.coordinates) && body.coordinates.length >= 2);
  // Chỉ gọi Azure from-gps khi session đã start thật trên BE.
  // sessionId local luôn có → nếu cứ gửi sẽ bị "GPS session khong ton tai".
  const canTryAzure = Boolean(getTargetApiRoot() && hasCoordinates && session?.targetSessionStarted);

  if (canTryAzure) {
    let targetSave = await saveRouteFromGpsOnTarget(session, body);
    let reverseError = null;
    // Lỗi khi đang gửi reverse (trùng mã chiều về, …) → thử lại chỉ chiều đi để tuyến chính vẫn lên BE.
    const wantedReverse = Boolean(body.createReverseRoute || session?.createReverseRoute);
    if (
      !targetSave.ok
      && targetSave.status !== 409
      && wantedReverse
    ) {
      reverseError = targetSave.error || `BE from-gps trả ${targetSave.status}`;
      console.warn(`[save-route] from-gps failed with reverse (${targetSave.status}): ${reverseError}. Retry without createReverseRoute.`);
      const retrySave = await saveRouteFromGpsOnTarget(
        { ...session, createReverseRoute: false, reverseRouteCode: null, reverseRouteName: null },
        { ...body, createReverseRoute: false, reverseRouteCode: null, reverseRouteName: null },
      );
      if (retrySave.ok) {
        targetSave = retrySave;
        warning = `Chiều đi đã lên BE; chiều về lỗi: ${reverseError}`;
      }
    }

    if (targetSave.ok) {
      route = targetSave.data || {};
      const routeId = route.routeId || route.id;
      if (routeId) {
        const details = await getFromTargetApi(
          `/api/routes/${encodeURIComponent(routeId)}`,
          session.deviceId || deviceIdForBoat({ boatCode: session.boatCode }),
        );
        if (details.ok && details.data) route = { ...route, ...details.data };
      }
      // BE đôi khi không trả / không giữ phút từng đoạn — ưu tiên bản GPS đã tính.
      const outboundStops = Array.isArray(targetSave.outboundStops) ? targetSave.outboundStops : [];
      const returnedStops = Array.isArray(route.stops) ? route.stops : [];
      if (outboundStops.length) {
        if (!returnedStops.length) {
          route.stops = outboundStops;
        } else {
          route.stops = returnedStops.map((stop, index) => {
            const out = outboundStops.find((item) => (
              String(item.stationId) === String(stop.stationId)
              && Number(item.stopOrder) === Number(stop.stopOrder)
            )) || outboundStops[index];
            const travel = stop.standardTravelMin ?? stop.standard_travel_min ?? out?.standardTravelMin;
            return {
              ...stop,
              standardTravelMin: travel == null || travel === '' ? null : Number(travel),
              segmentDistanceKm: out?.segmentDistanceKm ?? stop.segmentDistanceKm ?? null,
            };
          });
        }
      }
      if (!route.reverseRoute && targetSave.data?.reverseRoute) {
        route.reverseRoute = targetSave.data.reverseRoute;
      }
      if (route.createReverseRoute == null) {
        route.createReverseRoute = Boolean(targetSave.outboundCreateReverse);
      }
      if (warning && !route.reverseRoute) {
        route.createReverseRoute = false;
        route.reverseWarning = warning;
      }
      savedTo = 'target';
      state.lastRecordingSession = null;
    } else if (targetSave.status === 409) {
      const err = userError(targetSave.error || 'Mã tuyến đã tồn tại. Hãy đổi mã tuyến khác.');
      err.status = 409;
      err.code = 'ROUTE_CODE_EXISTS';
      throw err;
    } else {
      warning = targetSave.error || `BE from-gps trả ${targetSave.status}`;
      console.warn(`[save-route] Azure failed (${targetSave.status}): ${warning}. Falling back to local DB.`);
      route = await saveRecordedRoute(body);
      await refreshFromDatabase();
      savedTo = 'local';
      state.lastRecordingSession = null;
      if (session.targetSessionStarted) {
        try {
          await stopTrackingSessionOnTarget(
            {
              sessionId: session.sessionId,
              boatCode: session.boatCode,
              deviceId: session.deviceId || deviceIdForBoat({ boatCode: session.boatCode }),
            },
            session.recordedPoints?.length || 0,
          );
        } catch {
          // ignore
        }
      }
    }
  } else {
    route = await saveRecordedRoute(body);
    await refreshFromDatabase();
    state.lastRecordingSession = null;
  }

  return { ...route, savedTo, warning, ok: true };
}

let finalizeTimer = null;
function queueFinalizeCollector() {
  const collector = state.collector;
  if (!collector || collector.finalizeQueued || collector.finalizeDone) return;
  collector.finalizeQueued = true;
  clearTimeout(finalizeTimer);
  finalizeTimer = setTimeout(() => {
    finalizeCollectorRecording().catch((error) => {
      console.error(`[auto-save] ${error.message}`);
    });
  }, 500);
}

async function finalizeCollectorRecording() {
  const stopped = state.collector;
  if (!stopped || stopped.status !== 'completed' || stopped.finalizeDone) return;
  stopped.finalizeDone = true;

  if (!stopped.recordedPoints?.length) {
    // Vẫn giữ vị trí cuối trên hub (không ẩn GPS).
    hubBoatSuppressUntil.delete(String(stopped.boatCode || '').trim());
    upsertHubBoat({
      boatCode: stopped.boatCode,
      boatName: stopped.boatName,
      lat: stopped.lat,
      lng: stopped.lng,
      heading: stopped.heading,
      speedKmh: 0,
      status: 'idle',
      isOnline: true,
      recordedAt: formatRecordedAt(new Date()),
      receivedAt: new Date().toISOString(),
    });
    state.collector = null;
    state.collectorQueue = [];
    broadcast();
    return;
  }

  state.lastRecordingSession = {
    sessionId: stopped.sessionId,
    routeCode: stopped.routeCode,
    routeName: stopped.routeName,
    boatCode: stopped.boatCode,
    deviceId: stopped.deviceId,
    tripId: stopped.tripId,
    recordingStatus: 'stopped',
    recordedPoints: stopped.recordedPoints,
    plannedCoordinates: Array.isArray(stopped.coordinates) ? stopped.coordinates : null,
    startStationId: stopped.startStationId || null,
    endStationId: stopped.endStationId || null,
    routeType: stopped.routeType || null,
    stops: Array.isArray(stopped.stops) ? stopped.stops : null,
    createReverseRoute: Boolean(stopped.createReverseRoute),
    reverseRouteCode: stopped.reverseRouteCode || null,
    reverseRouteName: stopped.reverseRouteName || null,
    averageSpeedKmh: stopped.speedKmh || null,
    stoppedAt: new Date().toISOString(),
    targetSessionStarted: Boolean(stopped.targetSessionStarted),
  };
  // Giữ marker GPS ở bến đích (không suppress) — FE theo dõi vẫn thấy lat/lng.
  hubBoatSuppressUntil.delete(String(stopped.boatCode || '').trim());
  upsertHubBoat({
    boatCode: stopped.boatCode,
    boatName: stopped.boatName,
    boatId: stopped.boatId,
    deviceId: stopped.deviceId,
    lat: stopped.lat,
    lng: stopped.lng,
    heading: stopped.heading,
    speedKmh: 0,
    status: 'idle',
    isOnline: true,
    recordedAt: formatRecordedAt(new Date()),
    receivedAt: new Date().toISOString(),
  });
  state.collector = null;
  state.collectorQueue = [];
  broadcast();

  try {
    const result = await persistRecordingSession({
      routeCode: stopped.routeCode,
      routeName: stopped.routeName,
      boatCode: stopped.boatCode,
      description: 'Auto-saved after GPS recording completed',
      status: 'Active',
      averageSpeedKmh: stopped.speedKmh,
      startStationId: stopped.startStationId || null,
      endStationId: stopped.endStationId || null,
      routeType: stopped.routeType || null,
      stops: stopped.stops || null,
      createReverseRoute: Boolean(stopped.createReverseRoute),
      reverseRouteCode: stopped.reverseRouteCode || null,
      reverseRouteName: stopped.reverseRouteName || null,
    }, state.lastRecordingSession);
    state.lastAutoSavedRoute = {
      ...result,
      at: new Date().toISOString(),
      autoSaved: true,
    };
    console.log(`[auto-save] Saved ${result.routeCode || stopped.routeCode} → ${result.savedTo}`);
  } catch (error) {
    state.lastAutoSavedRoute = {
      ok: false,
      error: error.message,
      code: error.code || undefined,
      routeCode: stopped.routeCode,
      at: new Date().toISOString(),
      autoSaved: true,
    };
    console.error(`[auto-save] Failed: ${error.message}`);
  }
  broadcast();
}

function buildRecordingPayload(collector) {
  const payload = {
    ...buildTargetPayload(collector),
    source: 'route-recording',
    capturedRoute: {
      sessionId: collector.sessionId,
    },
  };

  // BE routes=0 → luôn null route trên GPS ping (kể cả khi đang survey mã tuyến local).
  payload.routeId = null;
  payload.routeCode = null;
  payload.tripId = null;

  if (collector.status === 'completed' || collector.gpsEndStatus === 'idle') {
    payload.status = 'idle';
    payload.speedKmh = 0;
  }

  if (collector.isNewRouteSurvey) {
    delete payload.capturedRoute;
    payload.capturedRoute = null;
    return payload;
  }

  payload.capturedRoute = {
    sessionId: collector.sessionId,
    routeCode: collector.routeCode,
    routeName: collector.routeName,
    progressMeters: round(collector.progressMeters, 1),
    lengthMeters: round(collector.lengthMeters, 1),
    sampleIndex: collector.sampleCount + 1,
    startStationId: collector.startStationId || null,
    endStationId: collector.endStationId || null,
  };
  return payload;
}

async function saveRecordedRoute(body) {
  const session = state.collector
    ? {
        routeCode: state.collector.routeCode,
        routeName: state.collector.routeName,
        recordedPoints: state.collector.recordedPoints,
        startStationId: state.collector.startStationId,
        endStationId: state.collector.endStationId,
      }
    : state.lastRecordingSession;
  if (!session?.recordedPoints?.length && !(session?.plannedCoordinates?.length >= 2)) {
    throw userError('Chua co diem GPS nao de luu. Hay bat dau ghi truoc.');
  }
  const speed = Number(body.averageSpeedKmh || session.averageSpeedKmh || session.speedKmh || env.DEFAULT_SPEED_KMH || 16);
  const coordinates = resolveSurveyPathCoordinates(session, body, speed).map((point) => ({
    lat: point.lat,
    lng: point.lng,
  }));
  if (coordinates.length < 2) throw userError('Can it nhat 2 diem GPS de tao route geometry.');
  return createCapturedRouteSafe({
    routeCode: body.routeCode || session.routeCode,
    routeName: body.routeName || session.routeName || session.routeCode,
    boatCode: body.boatCode || session.boatCode || null,
    description: body.description || 'Captured from GPS recording session',
    status: body.status || 'Active',
    averageSpeedKmh: body.averageSpeedKmh,
    startStationId: body.startStationId || session.startStationId || null,
    endStationId: body.endStationId || session.endStationId || null,
    routeType: body.routeType || session.routeType || null,
    stops: body.stops || session.stops || null,
    coordinates,
  });
}

async function createCapturedRoute(body) {
  const routeCode = cleanRouteText(body.routeCode, 'Route code');
  const routeName = cleanRouteText(body.routeName || body.routeCode, 'Route name');
  const status = cleanOptionalText(body.status) || 'Active';
  let points = validateRoutePoints(body.coordinates);
  const routeId = randomUUID();
  const boatCode = cleanOptionalText(body.boatCode);
  const maxSpeed = maxSpeedForBoatCode(boatCode);
  const averageSpeedKmh = clampSpeedToBoatMax(
    Number(body.averageSpeedKmh || env.DEFAULT_SPEED_KMH || 16),
    maxSpeed,
  );
  const startStationId = cleanOptionalText(body.startStationId);
  const endStationId = cleanOptionalText(body.endStationId);
  const routeType = resolveRouteType(body, null, startStationId, endStationId);
  const baseDescription = cleanOptionalText(body.description) || 'Captured from GPS simulator map';
  const description = baseDescription.includes(`[${routeType}]`)
    ? baseDescription
    : `[${routeType}] ${baseDescription}`.trim();
  const detectRadius = Number(env.STOP_DETECT_RADIUS_M || 200);
  const normalizedStops = enrichStopsAlongPath(
    points,
    body.stops,
    startStationId,
    endStationId,
    detectRadius,
  );
  points = snapCoordinatesToStops(points, normalizedStops, detectRadius);
  const lengthMeters = routeLength(points);
  // phút = (km / tốc_độ_chạy) × 60 · tốc độ ≤ max đăng ký
  const baseDistanceKm = round(lengthMeters / 1000, 3);
  const stopsWithTravel = attachSegmentTravelMinutes(points, normalizedStops, averageSpeedKmh);
  const estimatedDurationExact = Number(
    (sumTravelMinutes(stopsWithTravel) || ((baseDistanceKm / averageSpeedKmh) * 60)).toFixed(1),
  );
  // Cột DB estimated_duration_min là int — làm tròn cận số đúng, không ép floor = 1 cho đoạn ngắn.
  const estimatedDurationMin = Math.max(1, Math.round(estimatedDurationExact));
  const pointSql = points
    .map((point) => `ST_MakePoint(${point.lng}, ${point.lat})::geometry`)
    .join(', ');
  const stopRows = [];
  if (stopsWithTravel.length) {
    for (const [index, stop] of stopsWithTravel.entries()) {
      stopRows.push({
        id: randomUUID(),
        stationId: stop.stationId,
        stopOrder: Number(stop.stopOrder) || index + 1,
        travel: stop.standardTravelMin == null ? null : Number(stop.standardTravelMin),
        pickup: stop.isPickupAllowed !== false,
        dropoff: stop.isDropoffAllowed !== false,
      });
    }
  } else {
    if (startStationId) {
      stopRows.push({
        id: randomUUID(),
        stationId: startStationId,
        stopOrder: 1,
        travel: null,
        pickup: true,
        dropoff: routeType === 'SightseeingLoop',
      });
    }
    // Loop: cho phép endStationId === startStationId (cùng bến xuất hiện 2 lần).
    if (endStationId) {
      stopRows.push({
        id: randomUUID(),
        stationId: endStationId,
        stopOrder: stopRows.length + 1,
        travel: estimatedDurationMin,
        pickup: routeType === 'SightseeingLoop',
        dropoff: true,
      });
    }
  }

  const stopsInsert = stopRows.length
    ? `
, stops_inserted as (
  insert into route_stops (
    route_stop_id, route_id, station_id, stop_order,
    standard_travel_min, is_pickup_allowed, is_dropoff_allowed
  )
  values
  ${stopRows.map((stop) => `(
    ${sqlLiteral(stop.id)}::uuid,
    ${sqlLiteral(routeId)}::uuid,
    ${sqlLiteral(stop.stationId)}::uuid,
    ${stop.stopOrder},
    ${stop.travel == null ? 'null' : Number(stop.travel)},
    ${stop.pickup},
    ${stop.dropoff}
  )`).join(',\n  ')}
  returning route_stop_id, station_id, stop_order, standard_travel_min
)`
    : '';

  const stopsSelect = stopRows.length
    ? `coalesce((
    select jsonb_agg(jsonb_build_object(
      'routeStopId', si.route_stop_id,
      'stationId', s.station_id,
      'stationCode', s.station_code,
      'stationName', s.station_name,
      'stopOrder', si.stop_order,
      'standardTravelMin', si.standard_travel_min,
      'lat', s.latitude,
      'lng', s.longitude
    ) order by si.stop_order)
    from stops_inserted si
    join stations s on s.station_id = si.station_id
  ), '[]'::jsonb)`
    : `'[]'::jsonb`;

  const sql = `
with route_input as (
  select
    ${sqlLiteral(routeId)}::uuid as route_id,
    ${sqlLiteral(routeCode)} as route_code,
    ${sqlLiteral(routeName)} as route_name,
    ${sqlLiteral(description)} as description,
    ${sqlLiteral(status)} as status,
    ${estimatedDurationMin}::int as estimated_duration_min,
    ${baseDistanceKm}::numeric as base_distance_km,
    ST_SetSRID(ST_MakeLine(array[${pointSql}]), 4326)::geography as route_geometry
),
inserted as (
  insert into routes (
    route_id,
    route_code,
    route_name,
    description,
    base_distance_km,
    estimated_duration_min,
    status,
    updated_at,
    created_at,
    route_geometry
  )
  select
    route_id,
    route_code,
    route_name,
    description,
    base_distance_km,
    estimated_duration_min,
    status,
    now(),
    now(),
    route_geometry
  from route_input
  returning route_id, route_code, route_name, status, base_distance_km, estimated_duration_min, description,
            ST_AsGeoJSON(route_geometry)::jsonb as geojson
)
${stopsInsert}
select jsonb_build_object(
  'routeId', i.route_id,
  'routeCode', i.route_code,
  'routeName', i.route_name,
  'status', i.status,
  'routeType', ${sqlLiteral(routeType)},
  'baseDistanceKm', i.base_distance_km,
  'estimatedDurationMin', i.estimated_duration_min,
  'distanceKm', i.base_distance_km,
  'description', i.description,
  'geojson', i.geojson,
  'stops', ${stopsSelect}
)
from inserted i;
`;

  return queryJson(sql);
}

async function createCapturedRouteSafe(body) {
  try {
    return await createCapturedRoute(body);
  } catch (error) {
    const message = String(error?.message || error);
    if (/IX_routes_route_code|duplicate key.*route_code/i.test(message)) {
      const err = userError('Mã tuyến đã tồn tại trên DB. Hãy đổi mã tuyến khác.');
      err.status = 409;
      err.code = 'ROUTE_CODE_EXISTS';
      throw err;
    }
    throw error;
  }
}

async function getRouteDetail(routeId) {
  const local = state.routes.get(routeId);
  const stops = state.routeStops
    .filter((stop) => stop.routeId === routeId)
    .sort((a, b) => Number(a.stopOrder) - Number(b.stopOrder))
    .map((stop) => ({
      routeStopId: stop.routeStopId,
      stationId: stop.stationId,
      stationCode: stop.stationCode,
      stationName: stop.stationName,
      stopOrder: stop.stopOrder,
      standardTravelMin: stop.standardTravelMin,
      lat: Number(stop.lat),
      lng: Number(stop.lng),
    }));

  if (local) {
    return {
      routeId: local.routeId,
      routeCode: local.routeCode,
      routeName: local.routeName,
      status: local.status,
      baseDistanceKm: local.baseDistanceKm ?? round(local.lengthMeters / 1000, 2),
      estimatedDurationMin: local.estimatedDurationMin,
      distanceKm: local.baseDistanceKm ?? round(local.lengthMeters / 1000, 2),
      lengthMeters: round(local.lengthMeters, 0),
      coordinates: local.coordinates,
      stops,
    };
  }

  const sql = `
select jsonb_build_object(
  'routeId', r.route_id,
  'routeCode', r.route_code,
  'routeName', r.route_name,
  'status', r.status,
  'baseDistanceKm', r.base_distance_km,
  'estimatedDurationMin', r.estimated_duration_min,
  'distanceKm', r.base_distance_km,
  'geojson', ST_AsGeoJSON(r.route_geometry)::jsonb,
  'stops', coalesce((
    select jsonb_agg(jsonb_build_object(
      'routeStopId', rs.route_stop_id,
      'stationId', s.station_id,
      'stationCode', s.station_code,
      'stationName', s.station_name,
      'stopOrder', rs.stop_order,
      'standardTravelMin', rs.standard_travel_min,
      'lat', s.latitude,
      'lng', s.longitude
    ) order by rs.stop_order)
    from route_stops rs
    join stations s on s.station_id = rs.station_id
    where rs.route_id = r.route_id
  ), '[]'::jsonb)
)
from routes r
where r.route_id = ${sqlLiteral(routeId)}::uuid
limit 1;
`;
  try {
    const row = await queryJson(sql);
    return row && typeof row === 'object' && !Array.isArray(row) ? row : (Array.isArray(row) ? row[0] : null);
  } catch {
    return null;
  }
}

function maxSpeedForBoatCode(boatCode) {
  const code = String(boatCode || '').trim();
  if (!code) return null;
  for (const boat of state.boats.values()) {
    if (String(boat.boatId || '').startsWith('collector-')) continue;
    if (String(boat.boatCode) !== code) continue;
    const max = Number(boat.maxSpeedKmh);
    if (Number.isFinite(max) && max > 0) return max;
  }
  return null;
}

function clampSpeedToBoatMax(speedKmh, maxSpeedKmh) {
  const max = Number.isFinite(Number(maxSpeedKmh)) && Number(maxSpeedKmh) > 0
    ? Number(maxSpeedKmh)
    : 80;
  return clamp(Number(speedKmh), 1, max);
}

function resolveRouteType(body = {}, session = null, startStationId = '', endStationId = '') {
  const explicit = cleanOptionalText(body.routeType || session?.routeType);
  if (/sightseeingloop|loop/i.test(explicit)) return 'SightseeingLoop';
  if (/charter/i.test(explicit)) return 'CharterReference';
  if (/regular/i.test(explicit)) return 'Regular';
  const start = cleanOptionalText(startStationId || body.startStationId || session?.startStationId);
  const end = cleanOptionalText(endStationId || body.endStationId || session?.endStationId);
  if (start && end && start === end) return 'SightseeingLoop';
  return 'Regular';
}

function haversineMetersSimple(a, b) {
  const toRad = (value) => (Number(value) * Math.PI) / 180;
  const earth = 6371000;
  const dLat = toRad(Number(b.lat) - Number(a.lat));
  const dLng = toRad(Number(b.lng) - Number(a.lng));
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function normalizeRouteStops(rawStops, startStationId = '', endStationId = '') {
  const stops = [];
  if (Array.isArray(rawStops)) {
    for (const [index, stop] of rawStops.entries()) {
      const stationId = cleanOptionalText(stop?.stationId);
      if (!stationId) continue;
      stops.push({
        stationId,
        stationCode: cleanOptionalText(stop.stationCode) || null,
        stationName: cleanOptionalText(stop.stationName) || null,
        stopOrder: Number(stop.stopOrder) || index + 1,
        lat: Number.isFinite(Number(stop.lat)) ? Number(stop.lat) : null,
        lng: Number.isFinite(Number(stop.lng)) ? Number(stop.lng) : null,
        isPickupAllowed: stop.isPickupAllowed !== false,
        isDropoffAllowed: stop.isDropoffAllowed !== false,
      });
    }
  }
  if (stops.length) {
    return stops
      .sort((a, b) => a.stopOrder - b.stopOrder)
      .map((stop, index) => ({ ...stop, stopOrder: index + 1 }));
  }
  const start = cleanOptionalText(startStationId);
  const end = cleanOptionalText(endStationId);
  if (start) {
    stops.push({
      stationId: start,
      stationCode: null,
      stationName: null,
      stopOrder: 1,
      lat: null,
      lng: null,
      isPickupAllowed: true,
      isDropoffAllowed: Boolean(end && end === start),
    });
  }
  if (end) {
    stops.push({
      stationId: end,
      stationCode: null,
      stationName: null,
      stopOrder: stops.length + 1,
      lat: null,
      lng: null,
      isPickupAllowed: Boolean(start && end === start),
      isDropoffAllowed: true,
    });
  }
  return stops;
}

/** Giữ nguyên coordinates FE gửi — không kéo đầu/cuối (tránh biến dạng đường khảo sát). */
function snapCoordinatesToStops(coordinates, _stops, _radiusM = 200) {
  if (!Array.isArray(coordinates) || !coordinates.length) return coordinates || [];
  return coordinates.map((p) => ({
    ...p,
    lat: Number(p.lat),
    lng: Number(p.lng),
  }));
}

/**
 * Ưu tiên stops GPS đã gửi. Không tự thêm bến “đi qua” nếu client đã gửi stops[].
 * Chỉ fallback start/end khi không có stops.
 */
function enrichStopsAlongPath(coordinates, rawStops, startStationId = '', endStationId = '', radiusM = 200) {
  const start = cleanOptionalText(startStationId);
  const end = cleanOptionalText(endStationId);
  const explicit = normalizeRouteStops(rawStops, start, end);
  // Client đã chọn bến tường minh → dùng nguyên, không auto-detect thêm.
  if (Array.isArray(rawStops) && rawStops.length >= 1 && explicit.length) {
    return explicit.map((stop, index, arr) => ({
      ...stop,
      stopOrder: index + 1,
      isPickupAllowed: index === 0 || (start && end && start === end) || index < arr.length - 1
        ? (stop.isPickupAllowed !== false)
        : stop.isPickupAllowed !== false,
      isDropoffAllowed: stop.isDropoffAllowed !== false,
    }));
  }

  const path = Array.isArray(coordinates)
    ? coordinates.filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng)))
    : [];
  const stations = Array.isArray(state.stations) ? state.stations : [];
  if (path.length < 2 || !stations.length) return explicit;

  const explicitIds = new Set(explicit.map((s) => s.stationId));
  const hits = [];
  for (const station of stations) {
    const id = cleanOptionalText(station.stationId);
    if (!id) continue;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < path.length; i += 1) {
      const dist = haversineMetersSimple(path[i], station);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    const forced = id === start || id === end || explicitIds.has(id);
    if (!forced && bestDist > radiusM) continue;
    hits.push({
      stationId: id,
      stationCode: cleanOptionalText(station.stationCode) || null,
      stationName: cleanOptionalText(station.stationName) || null,
      lat: Number(station.lat),
      lng: Number(station.lng),
      pathIndex: bestIdx,
      dist: bestDist,
      forced,
    });
  }

  hits.sort((a, b) => {
    if (a.stationId === start && b.stationId !== start) return -1;
    if (b.stationId === start && a.stationId !== start) return 1;
    if (a.stationId === end && b.stationId !== end) return 1;
    if (b.stationId === end && a.stationId !== end) return -1;
    return a.pathIndex - b.pathIndex || a.dist - b.dist;
  });

  const ordered = [];
  const seen = new Set();
  const isLoop = Boolean(start && end && start === end);
  for (const hit of hits) {
    if (seen.has(hit.stationId)) continue;
    // Loop trùng bến đầu = bến cuối: chỉ giữ bến đầu, không tự thêm bến "đi qua".
    if (isLoop && hit.stationId !== start) continue;
    // Loop: bỏ qua end==start ở giữa; sẽ gắn lại cuối.
    if (hit.stationId === start && ordered.length > 0 && isLoop) continue;
    seen.add(hit.stationId);
    const fromExplicit = explicit.find((s) => s.stationId === hit.stationId);
    ordered.push({
      stationId: hit.stationId,
      stationCode: hit.stationCode || fromExplicit?.stationCode || null,
      stationName: hit.stationName || fromExplicit?.stationName || null,
      stopOrder: ordered.length + 1,
      lat: hit.lat,
      lng: hit.lng,
      isPickupAllowed: true,
      isDropoffAllowed: true,
    });
  }

  if (isLoop && ordered.length) {
    ordered.push({
      ...ordered[0],
      stopOrder: ordered.length + 1,
      isPickupAllowed: true,
      isDropoffAllowed: true,
    });
  } else if (end && ordered.length && ordered.at(-1).stationId !== end) {
    const endHit = hits.find((h) => h.stationId === end)
      || explicit.find((s) => s.stationId === end);
    if (endHit) {
      ordered.push({
        stationId: end,
        stationCode: endHit.stationCode || null,
        stationName: endHit.stationName || null,
        stopOrder: ordered.length + 1,
        lat: endHit.lat ?? null,
        lng: endHit.lng ?? null,
        isPickupAllowed: true,
        isDropoffAllowed: true,
      });
    }
  }

  return ordered.map((stop, index, arr) => ({
    ...stop,
    stopOrder: index + 1,
    isPickupAllowed: index === 0 || (start && end && start === end) || index < arr.length - 1,
    isDropoffAllowed: index === arr.length - 1 || (start && end && start === end) || index > 0,
  }));
}

function startCollector(body) {
  const routeCode = cleanRouteText(body.routeCode, 'Route code');
  const routeName = cleanRouteText(body.routeName || body.routeCode, 'Route name');
  const coordinates = validateRoutePoints(body.coordinates);
  const lengthMeters = routeLength(coordinates);
  const start = pointAtDistance(coordinates, 0);
  const boatCode = cleanOptionalText(body.boatCode) || `SURVEY-${routeCode}`;
  // Dùng device đã đăng ký trong gps_devices cho đúng tàu (vd WB_005 → gps-wb-005).
  const deviceId = deviceIdForBoat({ boatCode });
  const seedSequence = Math.max(
    Number(sequenceState[deviceId] || 0) + 1,
    Date.now(),
  );
  sequenceState[deviceId] = seedSequence;
  scheduleSequenceSave();
  const matchedBoat = [...state.boats.values()].find((boat) => (
    String(boat.boatCode) === boatCode && !String(boat.boatId || '').startsWith('collector-')
  ));
  const maxSpeedKmh = Number(matchedBoat?.maxSpeedKmh) || maxSpeedForBoatCode(boatCode) || 80;
  // max_speed_kmh chỉ là trần; tốc độ chạy lấy từ input / DEFAULT.
  const speedKmh = clampSpeedToBoatMax(
    Number(body.speedKmh || env.DEFAULT_SPEED_KMH || 16),
    maxSpeedKmh,
  );
  const startStationId = cleanOptionalText(body.startStationId) || null;
  const endStationId = cleanOptionalText(body.endStationId) || null;
  const routeType = resolveRouteType(body, null, startStationId, endStationId);
  const stops = enrichStopsAlongPath(
    coordinates,
    body.stops,
    startStationId,
    endStationId,
    Number(env.STOP_DETECT_RADIUS_M || 200),
  );
  return {
    boatId: `collector-${routeCode}`,
    deviceId,
    boatCode,
    boatName: body.boatName || matchedBoat?.boatName || 'Route collector boat',
    tripId: null,
    routeId: `capture-${routeCode}`,
    routeCode,
    routeName,
    coordinates,
    lengthMeters,
    progressMeters: 0,
    direction: 1,
    sequence: seedSequence,
    batteryPercent: randomInt(82, 96),
    signalStrength: 4,
    gpsFixQuality: 'good',
    speedKmh,
    maxSpeedKmh,
    heading: start.heading,
    lat: start.lat,
    lng: start.lng,
    status: 'moving',
    paused: false,
    manualSpeed: true,
    sendToTarget: body.sendToTarget !== false,
    recording: body.recording !== false,
    recordingStatus: 'recording',
    sessionId: randomUUID(),
    startStationId,
    endStationId,
    routeType,
    stops,
    createReverseRoute: Boolean(body.createReverseRoute) && routeType !== 'SightseeingLoop',
    reverseRouteCode: cleanOptionalText(body.reverseRouteCode) || null,
    reverseRouteName: cleanOptionalText(body.reverseRouteName) || null,
    sendIntervalMs: clamp(Number(body.sendIntervalMs || 5000), 3000, 10000),
    recordedPoints: [],
    lastPublishAt: 0,
    sampleCount: 0,
    isNewRouteSurvey: body.isNewRouteSurvey !== false,
    targetSessionStarted: false,
    targetSessionWarning: null,
    updatedAt: new Date().toISOString(),
  };
}

function createDbPool(envValues) {
  let pool = null;
  if (envValues.DATABASE_URL) {
    pool = new Pool({
      connectionString: envValues.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
    });
  } else if (!envValues.DB_HOST || String(envValues.DB_HOST).startsWith('http')) {
    return null;
  } else {
    pool = new Pool({
      host: envValues.DB_HOST,
      port: Number(envValues.DB_PORT || 5432),
      database: envValues.DB_NAME || 'waterbusdb',
      user: envValues.DB_USER || 'postgres',
      password: envValues.DB_PASSWORD || '',
      max: 5,
      idleTimeoutMillis: 30_000,
    });
  }
  // Idle Neon/TLS timeout không được làm crash cả process.
  pool.on('error', (error) => {
    console.warn(`[db] idle client error: ${error.message}`);
  });
  return pool;
}

async function queryJson(sql) {
  if (!dbPool) {
    throw new Error('Chua cau hinh DATABASE_URL (Neon). Tren Railway khong dung psql CLI.');
  }
  const result = await dbPool.query(sql);
  if (!result.rows?.length) return [];
  const value = result.rows[0][result.fields[0].name];
  if (value == null) return [];
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (parseError) {
      throw new Error(`Cannot parse SQL JSON: ${parseError.message}`);
    }
  }
  return value;
}

/** Tự đăng ký gps_devices cho tàu Active chưa có device (thêm tàu mới vẫn dùng được survey). */
async function ensureGpsDevicesForBoats(boats) {
  if (!dbPool || !parseBool(env.AUTO_REGISTER_GPS_DEVICES ?? 'true')) return 0;
  const list = Array.isArray(boats) ? boats : [];
  if (!list.length) return 0;
  let inserted = 0;
  for (const boat of list) {
    const boatId = boat.boatId || boat.boat_id;
    const boatCode = String(boat.boatCode || boat.boat_code || '').trim();
    if (!boatId || !boatCode) continue;
    const deviceId = `gps-${boatCode.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    try {
      const result = await dbPool.query(
        `
        insert into gps_devices (gps_device_id, device_id, boat_id, is_active, created_at, updated_at)
        select $1::uuid, $2, $3::uuid, true, now(), now()
        where not exists (
          select 1 from gps_devices where boat_id = $3::uuid
        )
        returning device_id
        `,
        [randomUUID(), deviceId, boatId],
      );
      if (result.rowCount > 0) {
        inserted += 1;
        console.log(`[gps-device] Auto-registered ${boatCode} → ${deviceId}`);
      }
    } catch (error) {
      console.warn(`[gps-device] Auto-register ${boatCode} failed: ${error.message}`);
    }
  }
  return inserted;
}

function cleanRouteText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw userError(`${label} is required`);
  if (text.length > 120) throw userError(`${label} is too long`);
  return text;
}

function cleanOptionalText(value) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, 240) : '';
}

function validateRoutePoints(value) {
  if (!Array.isArray(value) || value.length < 2) throw userError('At least 2 route points are required');
  return value.map((point, index) => {
    const lat = Number(point.lat);
    const lng = Number(point.lng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw userError(`Point ${index + 1} has invalid lat`);
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw userError(`Point ${index + 1} has invalid lng`);
    return { lat: round(lat, 9), lng: round(lng, 9) };
  });
}

function userError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function parseRouteCoordinates(geojson) {
  if (!geojson) return [];
  const geometry = typeof geojson === 'string' ? JSON.parse(geojson) : geojson;
  if (geometry.type === 'LineString') return geometry.coordinates.map(([lng, lat]) => ({ lat: Number(lat), lng: Number(lng) }));
  if (geometry.type === 'MultiLineString') return geometry.coordinates.flat().map(([lng, lat]) => ({ lat: Number(lat), lng: Number(lng) }));
  return [];
}

// routeLength / distanceMeters → Turf WGS84 (@/src/geo-distance.js)

/** Index điểm trên path gần stop nhất + khoảng cách dọc path tới điểm đó. */
function nearestPathProbe(path, stop) {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < path.length; i += 1) {
    const dist = distanceMeters(path[i], stop);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  let along = 0;
  for (let i = 1; i <= bestIdx; i += 1) along += distanceMeters(path[i - 1], path[i]);
  return { index: bestIdx, alongMeters: along, distToPath: bestDist };
}

/**
 * Gắn standardTravelMin:
 * 1) nếu cặp bến có trong lịch Waterbus → lấy phút lịch (chuẩn đời thực)
 * 2) không thì phút = (km đường GPS ÷ tốc độ) × 60 (1 số thập phân)
 */
function attachSegmentTravelMinutes(coordinates, stops, speedKmh) {
  const path = Array.isArray(coordinates)
    ? coordinates.filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng)))
    : [];
  const list = Array.isArray(stops) ? stops.map((s) => ({ ...s })) : [];
  const speed = Number(speedKmh) > 0 ? Number(speedKmh) : 16;
  const nearM = Number(env.STOP_DETECT_RADIUS_M || 200);
  const preferSchedule = parseBool(env.PREFER_WATERBUS_SCHEDULE ?? 'true');
  if (!list.length) return [];
  if (list.length === 1 || path.length < 2) {
    return list.map((stop) => ({
      ...stop,
      standardTravelMin: null,
      segmentDistanceKm: null,
      travelSource: null,
    }));
  }

  const probes = list.map((stop) => (
    Number.isFinite(Number(stop.lat)) && Number.isFinite(Number(stop.lng))
      ? nearestPathProbe(path, stop)
      : { index: 0, alongMeters: 0, distToPath: Infinity }
  ));

  for (let i = 1; i < probes.length; i += 1) {
    if (probes[i].alongMeters < probes[i - 1].alongMeters) {
      probes[i] = {
        ...probes[i],
        alongMeters: probes[i - 1].alongMeters,
        index: Math.max(probes[i].index, probes[i - 1].index),
      };
    }
  }

  return list.map((stop, index) => {
    if (index === 0) {
      return { ...stop, standardTravelMin: null, segmentDistanceKm: null, travelSource: null };
    }
    const prevStop = list[index - 1];
    const prev = probes[index - 1];
    const cur = probes[index];
    if (prev.distToPath > nearM || cur.distToPath > nearM) {
      return { ...stop, standardTravelMin: null, segmentDistanceKm: null, travelSource: null };
    }
    const meters = cur.alongMeters - prev.alongMeters;
    if (!(meters > 5)) {
      return { ...stop, standardTravelMin: null, segmentDistanceKm: null, travelSource: null };
    }
    const km = meters / 1000;
    const scheduled = preferSchedule
      ? scheduleTravelMinutes(prevStop.stationCode, stop.stationCode)
      : null;
    if (scheduled != null) {
      return {
        ...stop,
        standardTravelMin: scheduled,
        segmentDistanceKm: round(km, 3),
        travelSource: 'schedule',
      };
    }
    const minutes = Number(((km / speed) * 60).toFixed(1));
    return {
      ...stop,
      standardTravelMin: minutes > 0 ? minutes : null,
      segmentDistanceKm: round(km, 3),
      travelSource: 'gps',
    };
  });
}

function sumTravelMinutes(stops) {
  return (stops || []).reduce((sum, stop) => sum + (Number(stop.standardTravelMin) || 0), 0);
}

function pointAtDistance(points, targetMeters) {
  let travelled = 0;
  for (let i = 1; i < points.length; i += 1) {
    const start = points[i - 1];
    const end = points[i];
    const segment = distanceMeters(start, end);
    if (travelled + segment >= targetMeters) {
      const ratio = segment === 0 ? 0 : (targetMeters - travelled) / segment;
      return {
        lat: start.lat + (end.lat - start.lat) * ratio,
        lng: start.lng + (end.lng - start.lng) * ratio,
        heading: bearingDegrees(start, end),
      };
    }
    travelled += segment;
  }
  const previous = points.at(-2) || points[0];
  const last = points.at(-1);
  return { lat: last.lat, lng: last.lng, heading: bearingDegrees(previous, last) };
}

function bearingDegrees(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Heartbeat cùng chỗ / nhiễu GPS → không tính bearing mới (tránh mũi tên quay lung tung). */
function resolveStableHeading({ requested, prev, lat, lng, speedKmh }) {
  if (Number.isFinite(Number(requested))) return Number(requested);
  const prevHeading = Number(prev?.heading);
  const hasPrevPos = prev
    && Number.isFinite(Number(prev.lat))
    && Number.isFinite(Number(prev.lng));
  if (!hasPrevPos) return Number.isFinite(prevHeading) ? prevHeading : 0;

  const moved = distanceMeters(
    { lat: Number(prev.lat), lng: Number(prev.lng) },
    { lat: Number(lat), lng: Number(lng) },
  );
  if (!Number.isFinite(moved) || moved < 8 || Number(speedKmh) < 0.5) {
    return Number.isFinite(prevHeading) ? prevHeading : 0;
  }
  return bearingDegrees(
    { lat: Number(prev.lat), lng: Number(prev.lng) },
    { lat: Number(lat), lng: Number(lng) },
  );
}

function toRad(value) {
  return value * Math.PI / 180;
}

function firstRoute() {
  return state.routes.values().next().value;
}

function ensureFallbackData() {
  const route = {
    routeId: 'fallback-route',
    routeCode: 'DEMO-WATERBUS',
    routeName: 'Demo Waterbus',
    coordinates: [
      { lat: 10.7752301, lng: 106.7072821 },
      { lat: 10.7758815, lng: 106.7090714 },
      { lat: 10.7767663, lng: 106.7096303 },
    ],
  };
  route.lengthMeters = routeLength(route.coordinates);
  state.routes.set(route.routeId, route);
  if (!state.stations.length) state.stations = [
    { stationId: 'st-bd', stationCode: 'ST-BD', stationName: 'Ben Bach Dang', lat: 10.7752301, lng: 106.7072821, routeId: route.routeId, stopOrder: 1 },
    { stationId: 'st-tt', stationCode: 'ST-TT', stationName: 'Ben Thu Thiem', lat: 10.7767663, lng: 106.7096303, routeId: route.routeId, stopOrder: 2 },
  ];
  if (state.boats.size) return;
  state.boats.set('fallback-boat', {
    boatId: 'fallback-boat',
    deviceId: 'gps-wb-01',
    boatCode: 'WB_01',
    boatName: 'Saigon Waterbus 01',
    tripId: null,
    routeId: route.routeId,
    routeCode: route.routeCode,
    routeName: route.routeName,
    progressMeters: 0,
    direction: 1,
    sequence: sequenceState['gps-wb-01'] ?? initialSequence(),
    batteryPercent: 88,
    signalStrength: 4,
    gpsFixQuality: 'good',
    speedKmh: Number(env.DEFAULT_SPEED_KMH || 16),
    maxSpeedKmh: 35,
    heading: 0,
    lat: route.coordinates[0].lat,
    lng: route.coordinates[0].lng,
    status: 'moving',
    paused: false,
    updatedAt: new Date().toISOString(),
  });
}

function snapshot() {
  return {
    boats: [...state.boats.values()].map((boat) => ({
      ...boat,
      lat: round(boat.lat, 7),
      lng: round(boat.lng, 7),
      heading: round(boat.heading, 0),
      speedKmh: round(boat.speedKmh, 1),
    })),
    hubBoats: [...state.hubBoats.values()].map((boat) => ({
      ...boat,
      lat: round(boat.lat, 7),
      lng: round(boat.lng, 7),
      heading: boat.heading == null ? null : round(boat.heading, 0),
      speedKmh: boat.speedKmh == null ? null : round(boat.speedKmh, 1),
    })),
    routes: [...state.routes.values()].map((route) => ({
      routeId: route.routeId,
      routeCode: route.routeCode,
      routeName: route.routeName,
      status: route.status,
      lengthMeters: round(route.lengthMeters, 0),
      baseDistanceKm: route.baseDistanceKm ?? round(route.lengthMeters / 1000, 2),
      estimatedDurationMin: route.estimatedDurationMin,
      stops: state.routeStops
        .filter((stop) => stop.routeId === route.routeId)
        .sort((a, b) => Number(a.stopOrder) - Number(b.stopOrder))
        .map((stop) => ({
          stationId: stop.stationId,
          stationCode: stop.stationCode,
          stationName: stop.stationName,
          stopOrder: stop.stopOrder,
          standardTravelMin: stop.standardTravelMin,
          lat: Number(stop.lat),
          lng: Number(stop.lng),
        })),
      coordinates: route.coordinates,
    })),
    stations: state.stations,
    collector: state.collector ? {
      ...state.collector,
      lat: round(state.collector.lat, 7),
      lng: round(state.collector.lng, 7),
      heading: round(state.collector.heading, 0),
      speedKmh: round(state.collector.speedKmh, 1),
      progressMeters: round(state.collector.progressMeters, 1),
      lengthMeters: round(state.collector.lengthMeters, 1),
      recordedCount: state.collector.recordedPoints?.length || 0,
      coordinates: undefined,
      recordedPoints: undefined,
    } : null,
    recordingSession: state.lastRecordingSession ? {
      sessionId: state.lastRecordingSession.sessionId,
      routeCode: state.lastRecordingSession.routeCode,
      routeName: state.lastRecordingSession.routeName,
      boatCode: state.lastRecordingSession.boatCode,
      recordingStatus: state.lastRecordingSession.recordingStatus,
      stoppedAt: state.lastRecordingSession.stoppedAt,
      targetSessionStarted: state.lastRecordingSession.targetSessionStarted,
      recordedCount: state.lastRecordingSession.recordedPoints?.length || 0,
    } : null,
    lastAutoSavedRoute: state.lastAutoSavedRoute ? {
      ok: state.lastAutoSavedRoute.ok !== false,
      autoSaved: true,
      at: state.lastAutoSavedRoute.at,
      savedTo: state.lastAutoSavedRoute.savedTo,
      warning: state.lastAutoSavedRoute.warning || null,
      error: state.lastAutoSavedRoute.error || null,
      code: state.lastAutoSavedRoute.code || null,
      routeId: state.lastAutoSavedRoute.routeId || state.lastAutoSavedRoute.id || null,
      routeCode: state.lastAutoSavedRoute.routeCode || null,
      routeName: state.lastAutoSavedRoute.routeName || null,
      baseDistanceKm: state.lastAutoSavedRoute.baseDistanceKm ?? state.lastAutoSavedRoute.distanceKm ?? null,
      estimatedDurationMin: state.lastAutoSavedRoute.estimatedDurationMin ?? null,
      stops: Array.isArray(state.lastAutoSavedRoute.stops)
        ? state.lastAutoSavedRoute.stops.map((stop, index) => ({
            stationId: stop.stationId || null,
            stationCode: stop.stationCode || null,
            stationName: stop.stationName || null,
            stopOrder: Number(stop.stopOrder) || index + 1,
            standardTravelMin: stop.standardTravelMin ?? null,
            lat: Number.isFinite(Number(stop.lat)) ? Number(stop.lat) : null,
            lng: Number.isFinite(Number(stop.lng)) ? Number(stop.lng) : null,
            isPickupAllowed: stop.isPickupAllowed,
            isDropoffAllowed: stop.isDropoffAllowed,
          }))
        : [],
      routeType: state.lastAutoSavedRoute.routeType || null,
      isBookable: state.lastAutoSavedRoute.isBookable,
    } : null,
    config: publicConfig(),
    dbStatus: state.dbStatus,
    lastSend: state.lastSend,
    lastGps: state.lastGps ? { at: state.lastGps.at, count: state.lastGps.payloads?.length || 0 } : null,
    lastCollectorSend: state.lastCollectorSend ? {
      at: state.lastCollectorSend.at,
      mode: state.lastCollectorSend.mode,
      ok: state.lastCollectorSend.ok,
      soft: Boolean(state.lastCollectorSend.soft),
      status: state.lastCollectorSend.status,
      error: state.lastCollectorSend.error || null,
      sequence: state.lastCollectorSend.sequence || state.lastCollectorSend.payload?.sequence || null,
      recordedCount: state.lastCollectorSend.recordedCount || 0,
    } : null,
    lastTrackingApiCall: state.lastTrackingApiCall ? {
      at: state.lastTrackingApiCall.at,
      path: state.lastTrackingApiCall.path,
      ok: state.lastTrackingApiCall.ok,
      status: state.lastTrackingApiCall.status,
      error: state.lastTrackingApiCall.error || null,
    } : null,
  };
}

function publicConfig() {
  const endpoint = getTargetEndpoint();
  return {
    senderEnabled: state.senderEnabled,
    targetEndpoint: endpoint,
    targetEndpointMasked: endpoint ? maskEndpoint(endpoint) : '',
    targetApiRoot: getTargetApiRoot(),
    hasApiKey: Boolean(state.targetApiKey),
    sendIntervalMs: Number(env.SEND_INTERVAL_MS || 2000),
    surveyDeviceId: surveyDeviceId(),
    gpsDevices: Object.fromEntries(state.gpsDevicesByBoatCode.entries()),
    // Trình duyệt Railway bị CORS khi nối thẳng Azure hub → FE dùng SSE relay.
    signalrRelay: parseBool(env.SIGNALR_BROWSER_CONNECT ?? 'false') ? false : true,
    signalrHubUrl: (() => {
      // Chỉ expose hub URL cho browser khi bật SIGNALR_BROWSER_CONNECT=true.
      if (!parseBool(env.SIGNALR_BROWSER_CONNECT ?? 'false')) return '';
      const configured = cleanOptionalText(env.SIGNALR_HUB_URL);
      if (configured) return configured;
      const root = getTargetApiRoot();
      return root ? `${root}/hubs/tracking` : '';
    })(),
    signalrStatus: {
      ...state.signalrStatus,
      boatsLatestOkAt: boatsLatestLastOkAt,
      boatsLatestError: boatsLatestLastError,
    },
    // Ưu tiên phút lịch Waterbus khi cặp bến khớp (khớp đời thực).
    preferWaterbusSchedule: parseBool(env.PREFER_WATERBUS_SCHEDULE ?? 'true'),
    waterbusSchedule: waterbusSchedulePublic(),
  };
}

function maskEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return `${url.origin}${url.pathname}`;
  } catch {
    return endpoint;
  }
}

function broadcast() {
  let data;
  try {
    data = `data: ${JSON.stringify(snapshot())}\n\n`;
  } catch (error) {
    console.error(`[broadcast] snapshot failed: ${error.message}`);
    return;
  }
  for (const client of [...clients]) {
    try {
      client.write(data);
    } catch {
      clients.delete(client);
      try { client.end(); } catch { /* ignore */ }
    }
  }
}

function handleEvents(_req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  clients.add(res);
  try {
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  } catch (error) {
    console.error(`[events] initial snapshot failed: ${error.message}`);
  }
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
      clients.delete(res);
    }
  }, 15000);
  res.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

async function serveStatic(pathname, res) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) return sendJson(res, { error: 'Forbidden' }, 403);
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    res.end(content);
  } catch {
    sendJson(res, { error: 'Not found' }, 404);
  }
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  if (filePath.endsWith('.ico')) return 'image/x-icon';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.geojson') || filePath.endsWith('.json')) return 'application/geo+json; charset=utf-8';
  return 'application/octet-stream';
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function parseBool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/** Fallback device khi tàu chưa có dòng gps_devices. */
function surveyDeviceId() {
  return cleanOptionalText(env.SURVEY_DEVICE_ID) || 'gps-wb-001';
}

/** Ưu tiên device_id đã đăng ký trong gps_devices theo boatCode. */
function deviceIdForBoat(boat) {
  const code = String(boat?.boatCode || boat?.boatId || '').trim();
  const registered = code ? state.gpsDevicesByBoatCode.get(code) : null;
  if (registered) return registered;
  const synthetic = `gps-${String(boat?.boatCode || boat?.boatId || 'WB_001').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  // Nếu chưa đăng ký riêng: fallback device chung (tránh 404), log cảnh báo.
  if (code && !String(code).startsWith('SURVEY-')) {
    console.warn(`[gps-device] ${code} chưa có trong gps_devices — dùng fallback ${surveyDeviceId()} (synthetic ${synthetic})`);
    return surveyDeviceId();
  }
  return synthetic;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatRecordedAt(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, '0');
  const minutes = String(abs % 60).padStart(2, '0');
  const local = new Date(date.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 19);
  return `${local}${sign}${hours}:${minutes}`;
}

async function loadSequenceState() {
  try {
    return JSON.parse(await readFile(sequenceStatePath, 'utf8'));
  } catch {
    return {};
  }
}

function initialSequence() {
  return Number(env.SEQUENCE_START || Math.floor(Date.now() / 1000));
}

function scheduleSequenceSave() {
  if (sequenceSaveTimer) return;
  sequenceSaveTimer = setTimeout(() => {
    sequenceSaveTimer = null;
    writeFile(sequenceStatePath, `${JSON.stringify(sequenceState, null, 2)}\n`).catch((error) => {
      console.error(`Cannot save sequence state: ${error.message}`);
    });
  }, 250);
}
