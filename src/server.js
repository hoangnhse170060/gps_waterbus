import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import pg from 'pg';
import { waterbusSchedulePublic } from './waterbus-schedule.js';
import { createSignalRRelay } from './signalr-relay.js';
import { distanceMeters, routeLength } from './geo-distance.js';
import { createTripAutorun } from './trip-autorun.js';
import {
  advanceAlongCoordinates,
  buildRiverPath,
  resolveRiverBasePath,
} from './river-corridor.js';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const sequenceStatePath = path.join(rootDir, '.simulator-sequences.json');
const lastPositionsPath = path.join(rootDir, '.simulator-last-positions.json');

const env = await loadEnv();
if (parseBool(env.TARGET_GPS_ALLOW_SELF_SIGNED)) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
const port = Number(env.PORT || 5177);
const buildInfo = resolveBuildInfo(env, rootDir);
const sequenceState = await loadSequenceState();
let sequenceSaveTimer = null;
const lastPositions = await loadLastPositions();
let lastPositionsSaveTimer = null;
const dbPool = createDbPool(env);
const osmWaterbusCorridor = await loadOsmWaterbusCorridor();

const clients = new Set();
const state = {
  boats: new Map(),
  routes: new Map(),
  stations: [],
  routeStops: [],
  osmWaterbusCorridor,
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
  openIncidents: new Map(),
  rescueMissions: new Map(),
  tripMissions: new Map(),
  resolvedIncidentIds: new Map(),
  beBoatStatuses: new Map(), // boatCode|boatId → { status, boatId, boatCode, source, updatedAt }
  signalrStatus: {
    connected: false,
    hubUrl: '',
    lastError: null,
    lastEventAt: null,
    transport: null,
  },
  incidentsHubStatus: {
    connected: false,
    hubUrl: '',
    lastError: null,
    lastEventAt: null,
    transport: null,
  },
  targetBearerToken: String(env.TARGET_BEARER_TOKEN || env.AZURE_BEARER_TOKEN || '').trim(),
  liveHookSecret: String(env.LIVE_HOOK_SECRET || '').trim(),
  dbStatus: { ok: false, message: 'Not loaded yet', loadedAt: null },
};

let hubBroadcastTimer = null;
let incidentsBroadcastTimer = null;
const signalrRelay = createSignalRRelay({
  name: 'signalr-tracking',
  getHubUrl: () => {
    const configured = cleanOptionalText(env.SIGNALR_HUB_URL);
    if (configured) return configured;
    const root = getTargetApiRoot();
    return root ? `${root}/hubs/tracking` : '';
  },
  getAccessToken: () => state.targetBearerToken,
  events: [
    {
      names: ['boatLocation', 'BoatLocationUpdated'],
      onEvent: (payload) => {
        // Azure SignalR = SoT vị trí chung cho local + Railway (idle).
        upsertHubBoat({
          ...payload,
          fromAzure: true,
          source: 'azure-signalr',
          forceAccept: shouldForceAcceptAzurePosition(payload),
        });
        // Gộp broadcast để không flood SSE khi GPS ping dày.
        if (hubBroadcastTimer) return;
        hubBroadcastTimer = setTimeout(() => {
          hubBroadcastTimer = null;
          broadcast();
        }, 200);
      },
    },
    {
      names: ['BoatStatusUpdated', 'boatStatusUpdated'],
      onEvent: (payload) => {
        applyBoatStatusesFromBePayload(payload, 'tracking:BoatStatusUpdated');
        scheduleIncidentsBroadcast();
      },
    },
  ],
  onStatus: (status) => {
    state.signalrStatus = status;
    broadcast();
  },
});

const incidentsRelay = createSignalRRelay({
  name: 'signalr-incidents',
  getHubUrl: () => {
    const configured = cleanOptionalText(env.SIGNALR_INCIDENTS_HUB_URL);
    if (configured) return configured;
    const root = getTargetApiRoot();
    return root ? `${root}/hubs/incidents` : '';
  },
  getAccessToken: () => state.targetBearerToken,
  events: [
    {
      names: ['IncidentUpdated', 'incidentUpdated'],
      onEvent: (payload) => {
        upsertIncidentFromHub(payload, 'IncidentUpdated');
        applyBoatStatusesFromBePayload(payload, 'IncidentUpdated');
        scheduleIncidentsBroadcast();
        // Đồng bộ list Open từ BE (staff app báo sự cố → Live nhận ngay).
        refreshOpenIncidents({ force: false }).catch(() => {});
      },
    },
    {
      names: ['RescueDispatched', 'rescueDispatched'],
      onEvent: (payload) => {
        upsertIncidentFromHub(payload, 'RescueDispatched');
        applyBoatStatusesFromBePayload(payload, 'RescueDispatched');
        scheduleIncidentsBroadcast();
        refreshOpenIncidents({ force: false }).catch(() => {});
      },
    },
    {
      names: ['BoatStatusUpdated', 'boatStatusUpdated', 'BoatUpdated', 'boatUpdated'],
      onEvent: (payload) => {
        applyBoatStatusesFromBePayload(payload, 'BoatStatusUpdated');
        scheduleIncidentsBroadcast();
      },
    },
  ],
  onStatus: (status) => {
    state.incidentsHubStatus = status;
    broadcast();
  },
});

function scheduleIncidentsBroadcast() {
  if (incidentsBroadcastTimer) return;
  incidentsBroadcastTimer = setTimeout(() => {
    incidentsBroadcastTimer = null;
    broadcast();
  }, 150);
}

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
where coalesce(b.status, '') ilike 'active'
   or coalesce(b.status, '') ilike 'undermaintenance'
   or coalesce(b.status, '') ilike 'incident';
`;

/** Poll nhẹ — chỉ status tàu từ Neon (nhận Active/Bảo trì/Sự cố ngay khi bạn cập nhật DB). */
const boatStatusSql = `
select coalesce(jsonb_agg(jsonb_build_object(
  'boatId', b.boat_id,
  'boatCode', b.boat_code,
  'boatName', b.boat_name,
  'status', b.status,
  'maxSpeedKmh', b.max_speed_kmh,
  'numberOfDecks', b.number_of_decks
)), '[]'::jsonb)
from boats b
where coalesce(b.status, '') ilike 'active'
   or coalesce(b.status, '') ilike 'undermaintenance'
   or coalesce(b.status, '') ilike 'incident'
   or coalesce(b.status, '') ilike 'inactive';
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
/** Sau GPS Live/trip forceAccept — bỏ echo Azure cũ trong vài giây (tránh nhảy về chỗ cũ). */
const hubLiveAuthorityUntil = new Map();
let boatsLatestPollBusy = false;
let boatsLatestLastOkAt = null;
let boatsLatestLastError = null;
/** Đã seed vị trí từ Azure — mới cho heartbeat ghi Azure (tránh Railway/local đè bằng last-pos cũ). */
let azurePositionsSeeded = false;

// Trip autorun trước refresh/broadcast — snapshot dùng tripMissionsPublic().
const tripAutorun = createTripAutorun({
  state,
  env,
  parseBool,
  cleanOptionalText,
  clampSpeedToBoatMax,
  maxSpeedForBoatCode,
  pointAtDistance,
  parseRouteCoordinates,
  requestTargetApi,
  publishLiveGpsPosition,
  isBoatInActiveRescueMission,
  hasOpenIncidentForBoat,
  isActiveBoatCode,
  deviceIdForBoat,
  boatByIdOrCode,
  normalizeBoatStatus,
  effectiveBoatStatus,
  formatRecordedAt,
});

await refreshFromDatabase();
setInterval(refreshFromDatabase, Number(env.DB_REFRESH_MS || 15000));
// Status tàu từ Neon ~2s — cập nhật DB là Live GPS nhận gần như ngay.
setInterval(() => {
  refreshBoatStatusesFromDatabase().catch((error) => {
    console.warn(`[boat-status] ${error.message}`);
  });
}, Math.max(1000, Number(env.BOAT_STATUS_POLL_MS || 2000)));
setInterval(tickSimulator, 1000);
setInterval(publishGpsPositions, Number(env.SEND_INTERVAL_MS || 2000));
setInterval(publishCollectorPosition, Number(env.SEND_INTERVAL_MS || 2000));
setInterval(pruneStaleHubBoats, 5000);
setInterval(() => {
  tickRescueMissions().catch((error) => {
    console.warn(`[rescue-gps] ${error.message}`);
  });
}, Math.max(1000, Number(env.RESCUE_GPS_INTERVAL_MS || env.SEND_INTERVAL_MS || 2000)));
// BE contract: load lần đầu + poll /boats/latest khi SignalR thiếu/lỗi.
setInterval(pollLatestBoatLocations, Number(env.BOATS_LATEST_POLL_MS || 4000));

setInterval(() => {
  tripAutorun.pollDueTrips().catch((error) => {
    console.warn(`[trip-gps] poll: ${error.message}`);
  });
}, Math.max(5000, Number(env.TRIP_DUE_POLL_MS || 30000)));
setInterval(() => {
  tripAutorun.tickTripMissions().catch((error) => {
    console.warn(`[trip-gps] tick: ${error.message}`);
  });
}, Math.max(1000, Number(env.TRIP_GPS_INTERVAL_MS || 1000)));
// Seed poll due sau khi server lên.
setTimeout(() => {
  tripAutorun.pollDueTrips().catch((error) => {
    console.warn(`[trip-gps] seed: ${error.message}`);
  });
}, 2000);

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
        commit: buildInfo.commit,
        commitShort: buildInfo.commitShort,
        builtAt: buildInfo.builtAt,
        hasDatabase: Boolean(env.DATABASE_URL || env.DB_HOST),
        senderEnabled: state.senderEnabled,
        collectorRunning: Boolean(state.collector),
      });
    }
    if (url.pathname === '/events') return handleEvents(req, res);
    if (url.pathname === '/api/snapshot') return sendJson(res, snapshot());
    if (url.pathname === '/api/river-path' && req.method === 'POST') {
      const body = await readJson(req);
      const from = sanitizeRequestPoint(body?.from || body?.start);
      const to = sanitizeRequestPoint(body?.to || body?.end);
      if (!from || !to) {
        return sendJson(res, { error: 'Cần from/to với lat,lng hợp lệ' }, 400);
      }
      const basePath = getRescueRiverBasePath();
      const built = buildRiverPath(from, to, basePath, { joinMeters: 90 });
      return sendJson(res, {
        coordinates: built.coordinates,
        lengthMeters: built.lengthMeters,
        corridorPoints: basePath.length,
      });
    }
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
      if (body.bearerToken !== undefined) state.targetBearerToken = cleanOptionalText(body.bearerToken) || '';
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
        // Không trả HTTP 409 ra browser (Azure sequence) — map local vẫn cập nhật.
        const httpStatus = result.ok || result.soft || result.skipped
          ? 200
          : (Number(result.status) === 409 ? 200 : (result.status || 400));
        return sendJson(res, result, httpStatus);
      } catch (error) {
        return sendJson(res, {
          ok: false,
          error: error.message,
          code: error.code || undefined,
        }, error.status || 500);
      }
    }
    if (url.pathname === '/api/live/resync-positions' && req.method === 'POST') {
      // Đọc lại Azure nhưng KHÔNG xóa authority / đè chỗ vừa kéo tay.
      azurePositionsSeeded = false;
      try {
        await pollLatestBoatLocations({ force: true });
        const hubs = [...state.hubBoats.values()].map((b) => ({
          boatCode: b.boatCode,
          lat: b.lat,
          lng: b.lng,
          source: b.source || null,
          recordedAt: b.recordedAt || null,
        }));
        return sendJson(res, {
          ok: true,
          seeded: azurePositionsSeeded,
          count: hubs.length,
          boats: hubs,
          commit: buildInfo.commitShort,
          liveAzureWrite: liveAzureWriteEnabled(),
        });
      } catch (error) {
        return sendJson(res, { ok: false, error: error.message }, 502);
      }
    }
    if (url.pathname === '/api/incidents/hook' && req.method === 'POST') {
      const body = await readJson(req);
      const result = ingestIncidentHook(body, req);
      return sendJson(res, result, result.ok ? 200 : (result.status || 401));
    }
    if (url.pathname === '/api/incidents' && req.method === 'GET') {
      const resolutionStatus = url.searchParams.get('resolutionStatus') || 'Open';
      const result = await listIncidents({ resolutionStatus });
      return sendJson(res, result, result.ok ? 200 : (result.status || 502));
    }
    if (url.pathname === '/api/incidents' && req.method === 'POST') {
      const body = await readJson(req);
      const result = await createIncident(body);
      return sendJson(res, result, result.ok ? 200 : (result.status || 400));
    }
    {
      const assignMatch = url.pathname.match(/^\/api\/incidents\/([^/]+)\/assign-replacement-boat$/);
      if (assignMatch && req.method === 'PATCH') {
        const body = await readJson(req);
        const result = await assignReplacementBoat(decodeURIComponent(assignMatch[1]), body);
        return sendJson(res, result, result.ok ? 200 : (result.status || 400));
      }
    }
    {
      const resolveMatch = url.pathname.match(/^\/api\/incidents\/([^/]+)\/resolve$/);
      if (resolveMatch && req.method === 'PATCH') {
        const body = await readJson(req);
        const result = await resolveIncident(decodeURIComponent(resolveMatch[1]), body);
        return sendJson(res, result, result.ok ? 200 : (result.status || 400));
      }
    }
    if (url.pathname === '/api/incidents/refresh' && req.method === 'POST') {
      await refreshFromDatabase();
      const result = state.targetBearerToken
        ? await refreshOpenIncidents({ force: true })
        : { ok: true, status: 200, error: null };
      syncStatusesWithNeon();
      broadcast();
      return sendJson(res, {
        ok: true,
        status: 200,
        azureOk: Boolean(result.ok),
        error: result.error || null,
        count: state.openIncidents.size,
        incidents: [...state.openIncidents.values()],
      });
    }
    if (url.pathname === '/api/incidents/clear-stale' && req.method === 'POST') {
      const before = state.openIncidents.size;
      syncStatusesWithNeon();
      // Xóa toàn bộ sự cố hook/local còn sót (demo).
      for (const [id, row] of [...state.openIncidents.entries()]) {
        const src = String(row.source || '');
        if (src === 'hook' || src === 'local' || src.startsWith('local')) {
          state.openIncidents.delete(id);
          clearBeBoatStatus(row.boatCode || row.boatId);
        }
      }
      for (const boat of state.boats.values()) {
        if (normalizeBoatStatus(boat.dbStatus) === 'active' && !hasOpenIncidentForBoat(boat)) {
          clearBeBoatStatus(boat);
        }
      }
      broadcast();
      return sendJson(res, {
        ok: true,
        cleared: Math.max(0, before - state.openIncidents.size),
        openCount: state.openIncidents.size,
        boats: [...state.boats.values()].map((b) => ({
          boatCode: b.boatCode,
          neonStatus: b.dbStatus,
          effectiveStatus: effectiveBoatStatus(b),
        })),
      });
    }
    if (url.pathname === '/api/collector/start' && req.method === 'POST') {
      const body = await readJson(req);
      let collector;
      try {
        collector = startCollector(body);
      } catch (error) {
        return sendJson(res, { error: error.message }, error.status || 400);
      }
      state.collector = collector;
      state.collectorQueue = [];
      state.lastCollectorSend = null;
      state.lastAutoSavedRoute = null;
      // Đồng bộ sequence cao hơn mọi bản tin cũ trên Azure (tránh 409 "sequence cũ").
      bumpDeviceSequence(state.collector.deviceId, state.collector);
      hideSurveyBoatFromLiveHub();
      broadcast();
      if (state.collector.sendToTarget && getTargetApiRoot()) {
        const sessionResult = await startTrackingSessionOnTarget(state.collector);
        if (sessionResult.ok) {
          state.collector.targetSessionStarted = true;
          state.collector.targetSessionWarning = null;
        } else {
          // Session fail → vẫn gửi GPS locations liên tục (không tắt sendToTarget).
          state.collector.targetSessionStarted = false;
          state.collector.targetSessionWarning = `${sessionResult.error || 'Khong bat dau session tren BE'}. Van gui GPS lien tuc; from-gps co the luu local.`;
        }
      }
      // Gửi ngay điểm GPS đầu — không để UI kẹt "chưa gửi / đang chờ tín hiệu".
      publishCollectorPosition().catch((err) => {
        console.warn(`[collector] first GPS publish: ${err.message}`);
      });
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
          averageSpeedKmh: stopped.cruiseSpeedKmh || stopped.speedKmh || null,
          cruiseSpeedKmh: stopped.cruiseSpeedKmh || null,
          estimatedDurationMin: stopped.estimatedDurationMin ?? null,
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
  console.log(`[build] commit ${buildInfo.commitShort} (${buildInfo.commit})`);
  console.log(`[gps-write] Azure write ${liveAzureWriteEnabled() ? 'ON (primary)' : 'OFF (follow Azure only)'}`);
  const hookMode = Boolean(String(state.liveHookSecret || env.LIVE_HOOK_SECRET || '').trim());
  const jwtMode = Boolean(state.targetBearerToken);
  if (hookMode) {
    console.log('[incidents] nhận lệnh qua webhook POST /api/incidents/hook (không cần JWT)');
  }
  signalrRelay.start().catch((error) => {
    console.warn(`[signalr-relay] start: ${error.message}`);
  });
  // Chỉ nối hub/poll Azure incidents khi có JWT. Hook mode thì bỏ qua (tránh 401 spam).
  if (jwtMode) {
    incidentsRelay.start().catch((error) => {
      console.warn(`[signalr-incidents] start: ${error.message}`);
    });
    refreshOpenIncidents({ force: true }).catch((error) => {
      console.warn(`[incidents] seed: ${error.message}`);
    });
    const incidentsPollMs = Math.max(5000, Number(env.INCIDENTS_POLL_MS || 8000));
    setInterval(() => {
      refreshOpenIncidents({ force: false }).catch(() => {});
    }, incidentsPollMs);
  } else if (hookMode) {
    state.incidentsHubStatus = {
      connected: false,
      hubUrl: '',
      lastError: null,
      lastEventAt: null,
      transport: 'webhook',
      mode: 'hook',
    };
  } else {
    console.warn('[incidents] Chưa có LIVE_HOOK_SECRET lẫn TARGET_BEARER_TOKEN — chỉ demo local');
  }
  // BE: GET /api/tracking/boats/latest lần đầu rồi poll (fallback khi hub chưa có).
  pollLatestBoatLocations({ force: true }).catch((error) => {
    console.warn(`[boats-latest] seed: ${error.message}`);
  });
});

function normalizeBoatStatus(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function canonicalBoatStatus(value) {
  const n = normalizeBoatStatus(value);
  if (n === 'undermaintenance') return 'UnderMaintenance';
  if (n === 'incident') return 'Incident';
  if (n === 'active') return 'Active';
  if (n === 'inactive') return 'Inactive';
  if (n === 'retired') return 'Retired';
  return null;
}

function isActiveBoatCode(boatCode) {
  const code = String(boatCode || '').trim();
  if (!code) return false;
  const boat = [...state.boats.values()].find((row) => (
    String(row.boatCode || '').trim() === code
    && !String(row.boatId || '').startsWith('collector-')
    && row.boatId !== 'fallback-boat'
  ));
  if (!boat) return false;
  return effectiveBoatStatus(boat) === 'Active';
}

/** Live map: Active + UnderMaintenance + Incident (FE báo sự cố → DB = Incident, vẫn hiện đỏ). */
function isLiveMapBoatCode(boatCode) {
  const code = String(boatCode || '').trim();
  if (!code) return false;
  const boat = [...state.boats.values()].find((row) => (
    String(row.boatCode || '').trim() === code
    && !String(row.boatId || '').startsWith('collector-')
    && row.boatId !== 'fallback-boat'
  ));
  if (!boat) {
    // Vẫn giữ hub nếu đang có sự cố mở / đang là tàu cứu hoặc tàu thay khách.
    return [...state.openIncidents.values()].some((row) => (
      String(row.boatCode || '').trim() === code
      || String(row.rescueBoatCode || '').trim() === code
      || String(row.replacementBoatCode || '').trim() === code
    )) || [...state.rescueMissions.values()].some((mission) => (
      String(mission.rescueBoatCode || '').trim() === code
      && String(mission.status || '') !== 'Completed'
    ));
  }
  const status = normalizeBoatStatus(effectiveBoatStatus(boat));
  return status === 'active' || status === 'undermaintenance' || status === 'incident';
}

/** Ưu tiên status BE chỉ khi còn sự cố mở; không thì tin Neon DB. */
function beStatusForBoat(boatOrCode) {
  if (!boatOrCode) return null;
  if (typeof boatOrCode === 'object') {
    const code = String(boatOrCode.boatCode || '').trim();
    const id = String(boatOrCode.boatId || '').trim();
    return state.beBoatStatuses.get(code)?.status
      || state.beBoatStatuses.get(id)?.status
      || boatOrCode.beStatus
      || null;
  }
  const key = String(boatOrCode).trim();
  return state.beBoatStatuses.get(key)?.status || null;
}

function hasOpenIncidentForBoat(boatOrCode) {
  const code = String(
    typeof boatOrCode === 'object' ? (boatOrCode.boatCode || '') : boatOrCode || '',
  ).trim();
  const id = String(
    typeof boatOrCode === 'object' ? (boatOrCode.boatId || '') : '',
  ).trim();
  for (const row of state.openIncidents.values()) {
    if (code && String(row.boatCode || '').trim() === code) return true;
    if (id && String(row.boatId || '') === id) return true;
  }
  return false;
}

function clearBeBoatStatus(boatOrCode) {
  const boat = typeof boatOrCode === 'object' ? boatOrCode : boatByIdOrCode(boatOrCode);
  const code = String(boat?.boatCode || (typeof boatOrCode === 'string' ? boatOrCode : '') || '').trim();
  const id = String(boat?.boatId || '').trim();
  if (code) state.beBoatStatuses.delete(code);
  if (id) state.beBoatStatuses.delete(id);
  if (boat) boat.beStatus = null;
  if (code && state.hubBoats.has(code)) {
    const hub = state.hubBoats.get(code);
    state.hubBoats.set(code, { ...hub, boatStatus: null, beStatus: null });
  }
}

function effectiveBoatStatus(boatOrCode) {
  const boat = typeof boatOrCode === 'object' ? boatOrCode : boatByIdOrCode(boatOrCode);
  const neon = canonicalBoatStatus(boat?.dbStatus) || boat?.dbStatus || null;
  // Còn sự cố mở → hiện Sự cố / Bảo trì.
  if (hasOpenIncidentForBoat(boatOrCode) || hasOpenIncidentForBoat(boat)) {
    return beStatusForBoat(boatOrCode) || 'Incident';
  }
  // Neon đã là Incident → giữ hiện đỏ trên map.
  if (normalizeBoatStatus(neon) === 'incident') return 'Incident';
  return neon;
}

function applyBeBoatStatus({ boatId = null, boatCode = null, status, source = 'be' } = {}) {
  const canon = canonicalBoatStatus(status);
  if (!canon) return false;
  const boat = boatByIdOrCode(boatId || boatCode);
  const code = String(boat?.boatCode || boatCode || '').trim();
  const id = String(boat?.boatId || boatId || '').trim();
  if (!code && !id) return false;

  const row = {
    status: canon,
    boatId: id || null,
    boatCode: code || null,
    source,
    updatedAt: new Date().toISOString(),
  };
  if (code) state.beBoatStatuses.set(code, row);
  if (id) state.beBoatStatuses.set(id, row);

  if (boat) {
    boat.beStatus = canon;
  }
  if (code && state.hubBoats.has(code)) {
    const hub = state.hubBoats.get(code);
    state.hubBoats.set(code, { ...hub, boatStatus: canon, beStatus: canon });
  }
  return true;
}

function applyBoatStatusesFromBePayload(payload, source = 'be') {
  if (!payload || typeof payload !== 'object') return;
  const rows = extractIncidentRows(payload);
  if (!rows.length) rows.push(payload);

  for (const row of rows) {
    const nested = row.incident && typeof row.incident === 'object' ? row.incident : row;
    const boatId = nested.boatId || nested.BoatId || row.boatId || null;
    const boatCode = nested.boatCode || nested.BoatCode || row.boatCode || boatCodeFromId(boatId);
    const resolution = String(
      nested.resolutionStatus || nested.ResolutionStatus || row.resolutionStatus || '',
    ).toLowerCase();
    const explicit = nested.boatStatus || nested.BoatStatus
      || row.boatStatus || row.BoatStatus
      || nested.status || nested.Status
      || null;

    if (explicit && canonicalBoatStatus(explicit)) {
      applyBeBoatStatus({ boatId, boatCode, status: explicit, source });
      continue;
    }
    if (resolution === 'open' || source === 'IncidentUpdated' || source === 'RescueDispatched') {
      if (!resolution || resolution === 'open') {
        applyBeBoatStatus({ boatId, boatCode, status: 'Incident', source });
      } else {
        applyBeBoatStatus({ boatId, boatCode, status: 'Active', source });
      }
    }
  }
}

/**
 * Đồng bộ nhẹ với Neon — KHÔNG tự đóng sự cố hook/FE.
 * Sự cố chỉ đóng khi: IncidentResolved / clear-stale / BoatStatusUpdated Active từ hook.
 */
function syncStatusesWithNeon() {
  let changed = false;

  for (const boat of state.boats.values()) {
    const code = String(boat.boatCode || '').trim();
    if (!code) continue;
    const neon = normalizeBoatStatus(boat.dbStatus);

    if (hasOpenIncidentForBoat(boat)) {
      // FE/Manager đang có sự cố mở → giữ Sự cố + hiện map (không ẩn).
      if (beStatusForBoat(boat) !== 'Incident' && beStatusForBoat(boat) !== 'UnderMaintenance') {
        applyBeBoatStatus({
          boatId: boat.boatId,
          boatCode: boat.boatCode,
          status: 'Incident',
          source: 'open-incident',
        });
        changed = true;
      }
      boat.beStatus = 'Incident';
      continue;
    }

    // Không còn sự cố → tin Neon (Incident trên DB vẫn hiện).
    if (neon === 'active') {
      if (beStatusForBoat(boat)) {
        clearBeBoatStatus(boat);
        changed = true;
      }
      boat.beStatus = null;
    } else if (neon === 'incident') {
      boat.beStatus = 'Incident';
    }
  }
  return changed;
}

function reapplyBeBoatStatusesToCatalog() {
  syncStatusesWithNeon();
  for (const boat of state.boats.values()) {
    const effective = effectiveBoatStatus(boat);
    boat.beStatus = hasOpenIncidentForBoat(boat) ? (beStatusForBoat(boat) || 'Incident') : null;
    void effective;
  }
}

/**
 * Lọc nhảy/teleport trước khi cập nhật hub (SignalR / boats.latest / live GPS).
 * - speed≈0 mà Δpos lớn → giữ điểm cũ
 * - Δpos > speed*Δt*2.5 + buffer → bỏ
 */
function shouldAcceptHubJump(prev, next) {
  if (!prev || !Number.isFinite(Number(prev.lat)) || !Number.isFinite(Number(prev.lng))) {
    return { ok: true };
  }
  const lat = Number(next.lat);
  const lng = Number(next.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, reason: 'invalid-coords' };

  const moved = distanceMeters(
    { lat: Number(prev.lat), lng: Number(prev.lng) },
    { lat, lng },
  );
  if (!Number.isFinite(moved)) return { ok: true };

  const speed = Number.isFinite(Number(next.speedKmh))
    ? Number(next.speedKmh)
    : (Number.isFinite(Number(prev.speedKmh)) ? Number(prev.speedKmh) : 0);

  const prevAt = Date.parse(prev.recordedAt || '') || 0;
  const nextAt = Date.parse(next.recordedAt || '') || Date.now();
  // Chỉ dùng recordedAt cho Δt — không dùng receivedAt (reject path từng refresh receivedAt → teleport ảo).
  const dtSec = prevAt > 0 ? Math.max(0.5, (nextAt - prevAt) / 1000) : 5;

  // Đứng yên / tốc thấp: không nhận lệch > 40m (tránh nhảy ~350m speed=0).
  if (speed < 2 && moved > 40) {
    return { ok: false, reason: `idle-jump ${Math.round(moved)}m speed=${speed}` };
  }
  // Công thức: Δpos > speed(m/s)*Δt*2.5 + buffer
  const maxM = (Math.max(0, speed) / 3.6) * dtSec * 2.5 + 80;
  if (moved > maxM) {
    return { ok: false, reason: `teleport ${Math.round(moved)}m > max ${Math.round(maxM)}m` };
  }

  // Sequence / thời gian cũ hơn điểm đang giữ → bỏ.
  const prevSeq = Number(prev.sequence);
  const nextSeq = Number(next.sequence);
  if (Number.isFinite(prevSeq) && Number.isFinite(nextSeq) && nextSeq < prevSeq) {
    return { ok: false, reason: `stale-sequence ${nextSeq}<${prevSeq}` };
  }
  if (prevAt > 0 && nextAt > 0 && nextAt < prevAt - 2000) {
    return { ok: false, reason: 'stale-recordedAt' };
  }

  return { ok: true, moved };
}

function upsertHubBoat(payload) {
  if (!payload || typeof payload !== 'object') return;
  const code = String(payload.boatCode || '').trim();
  const lat = Number(payload.lat);
  const lng = Number(payload.lng);
  if (!code || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  // Không hiện / giữ hub cho tàu không thuộc Live map (Active / UnderMaintenance / đang sự cố).
  if (!isLiveMapBoatCode(code)) {
    state.hubBoats.delete(code);
    return;
  }
  const suppressUntil = hubBoatSuppressUntil.get(code) || 0;
  const forceAccept = payload.forceAccept === true || payload._forceAccept === true;
  // Suppress chỉ chặn Azure/echo — KHÔNG chặn live/trip/rescue forceAccept
  // (trước đây set suppress rồi upsert → lần kéo bị return, hub giữ chỗ cũ → FE nhảy về).
  if (!forceAccept && suppressUntil > Date.now()) return;
  if (!forceAccept && suppressUntil) hubBoatSuppressUntil.delete(code);
  // Đang survey cùng mã → không hiện / không nhận GPS Live (Azure echo / heartbeat).
  if (activeSurveyBoatCode() === code) {
    state.hubBoats.delete(code);
    return;
  }

  // Đang cứu hộ / trip lịch: chỉ nhận GPS từ publishLiveGpsPosition (forceAccept), bỏ echo Azure cũ.
  if (!forceAccept && isBoatInActiveRescueMission(code)) return;
  if (!forceAccept && tripAutorun.isBoatInActiveTripMission(code)) return;
  // Vừa nhận GPS Live/trip: bỏ Azure echo cũ trong cửa sổ ngắn.
  const liveAuthUntil = hubLiveAuthorityUntil.get(code) || 0;
  if (!forceAccept && liveAuthUntil > Date.now()) return;

  const prev = state.hubBoats.get(code);
  const incoming = {
    lat,
    lng,
    speedKmh: Number.isFinite(Number(payload.speedKmh)) ? Number(payload.speedKmh) : null,
    heading: Number.isFinite(Number(payload.heading)) ? Number(payload.heading) : null,
    recordedAt: payload.recordedAt || null,
    receivedAt: payload.receivedAt || null,
    sequence: payload.sequence ?? null,
  };
  const gate = forceAccept ? { ok: true } : shouldAcceptHubJump(prev, incoming);
  if (!gate.ok) {
    if (gate.reason && !String(gate.reason).startsWith('stale')) {
      console.warn(`[hub-jump] ${code}: keep previous — ${gate.reason}`);
    }
    // Chỉ đánh dấu online — KHÔNG refresh receivedAt (tránh dtSec phình → teleport sau này).
    if (prev) {
      state.hubBoats.set(code, {
        ...prev,
        isOnline: payload.isOnline !== false,
        updatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  // Đứng yên: giữ heading cũ (tránh xoay 0↔360) — TRỪ khi nhận từ Azure (SoT chung).
  let heading = incoming.heading;
  const fromAzure = Boolean(payload.fromAzure)
    || String(payload.source || '').startsWith('azure');
  if (
    !fromAzure
    && prev
    && Number.isFinite(Number(prev.heading))
    && (incoming.speedKmh == null || incoming.speedKmh < 2)
    && (gate.moved == null || gate.moved < 8)
  ) {
    heading = Number(prev.heading);
  } else if (!Number.isFinite(Number(heading)) && prev && Number.isFinite(Number(prev.heading))) {
    heading = Number(prev.heading);
  }

  state.hubBoats.set(code, {
    boatCode: code,
    boatName: payload.boatName || prev?.boatName || null,
    boatId: payload.boatId || prev?.boatId || null,
    deviceId: payload.deviceId || prev?.deviceId || null,
    routeId: payload.routeId || null,
    routeCode: payload.routeCode || null,
    tripId: payload.tripId || null,
    tripCode: payload.tripCode || null,
    lat,
    lng,
    speedKmh: incoming.speedKmh,
    heading,
    recordedAt: incoming.recordedAt,
    receivedAt: incoming.receivedAt || new Date().toISOString(),
    sequence: incoming.sequence,
    isOnline: payload.isOnline !== false,
    source: payload.source || (payload.fromAzure ? 'azure' : (prev?.source || null)),
    updatedAt: new Date().toISOString(),
  });
  // Chỉ giữ quyền Live khi user kéo / trip / rescue — không phải heartbeat quiet.
  if (forceAccept && payload.holdAuthority === true) {
    hubLiveAuthorityUntil.set(code, Date.now() + Number(env.HUB_LIVE_AUTHORITY_MS || 30_000));
  }
  rememberLastPosition(code, state.hubBoats.get(code));
  // Đồng bộ lat/lng vào state.boats — snapshot/FE không còn dùng vị trí stagger route giả.
  const boat = [...state.boats.values()].find((b) => String(b.boatCode || '').trim() === code);
  if (boat) {
    boat.lat = lat;
    boat.lng = lng;
    if (Number.isFinite(Number(heading))) boat.heading = Number(heading);
    if (Number.isFinite(Number(incoming.speedKmh))) boat.speedKmh = Number(incoming.speedKmh);
    boat.updatedAt = new Date().toISOString();
  }
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
    // Tàu đang sự cố: luôn giữ marker (đỏ), không ẩn vì mất ping.
    if (hasOpenIncidentForBoat(code)) continue;
    // SOS / tàu đang cứu hoặc còn gán trên sự cố mở — không prune (heartbeat bị skip khi cứu).
    if (isBoatLinkedToOpenRescue(code)) continue;
    if (!isLiveMapBoatCode(code)) {
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

function isBoatLinkedToOpenRescue(boatCode) {
  const code = String(boatCode || '').trim();
  if (!code) return false;
  for (const mission of state.rescueMissions.values()) {
    const status = String(mission?.status || '');
    if (status === 'Completed') continue;
    if (String(mission.rescueBoatCode || '').trim() === code) return true;
    if (String(mission.incidentBoatCode || '').trim() === code) return true;
  }
  for (const row of state.openIncidents.values()) {
    if (String(row.rescueBoatCode || '').trim() === code) return true;
    if (String(row.replacementBoatCode || '').trim() === code) return true;
  }
  return false;
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
    const firstSeed = !azurePositionsSeeded;
    for (const row of rows) {
      const code = String(row.boatCode || '').trim();
      const before = state.hubBoats.get(code);
      // Giữ chỗ kéo tay / trip / last-pos mới hơn Azure stale — tránh F5 về vị trí cũ.
      if (shouldKeepHubOverAzure(code, row)) {
        continue;
      }
      if (firstSeed && code) hubLiveAuthorityUntil.delete(code);
      upsertHubBoat({
        ...row,
        fromAzure: true,
        source: 'azure-latest',
        // Lần seed đầu: luôn nhận Azure để local/Railway cùng map.
        forceAccept: firstSeed || shouldForceAcceptAzurePosition(row),
        holdAuthority: false,
      });
      const after = state.hubBoats.get(code);
      if (after && (!before || before.lat !== after.lat || before.lng !== after.lng || before.updatedAt !== after.updatedAt)) {
        changed = true;
      }
    }
    boatsLatestLastOkAt = new Date().toISOString();
    boatsLatestLastError = null;
    if (rows.length) azurePositionsSeeded = true;
    if (firstSeed && rows.length) {
      console.log(`[boats-latest] seeded ${rows.length} boat position(s) from Azure`);
    }
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

async function refreshBoatStatusesFromDatabase() {
  if (!dbPool) return;
  const rows = await queryJson(boatStatusSql);
  if (!Array.isArray(rows)) return;

  let changed = false;
  let needFullRefresh = false;
  const activeLikeIds = new Set();

  for (const row of rows) {
    const id = row.boatId;
    const code = String(row.boatCode || '').trim();
    if (!id || !code) continue;
    const status = String(row.status || '').trim();
    const statusNorm = normalizeBoatStatus(status);

    if (statusNorm === 'active' || statusNorm === 'undermaintenance' || statusNorm === 'incident') {
      activeLikeIds.add(id);
    }

    let boat = state.boats.get(id);
    if (!boat) {
      boat = [...state.boats.values()].find((b) => String(b.boatCode) === code);
    }
    if (!boat) {
      if (statusNorm === 'active' || statusNorm === 'undermaintenance' || statusNorm === 'incident') {
        needFullRefresh = true;
      }
      continue;
    }

    const prevStatus = String(boat.dbStatus || '');
    if (prevStatus !== status) {
      boat.dbStatus = status;
      changed = true;
      console.log(`[boat-status] ${code}: ${prevStatus || '—'} → ${status}`);
    }
    if (row.boatName && boat.boatName !== row.boatName) {
      boat.boatName = row.boatName;
      changed = true;
    }
    if (Number.isFinite(Number(row.maxSpeedKmh))) {
      boat.maxSpeedKmh = Number(row.maxSpeedKmh);
    }
    if (Number.isFinite(Number(row.numberOfDecks))) {
      boat.numberOfDecks = Number(row.numberOfDecks) || 1;
    }

    // Inactive trên DB → bỏ khỏi catalog live, TRỪ khi đang có sự cố mở (vẫn phải hiện đỏ).
    if (statusNorm === 'inactive' || statusNorm === 'retired') {
      if (hasOpenIncidentForBoat(boat) || hasOpenIncidentForBoat(code)) {
        boat.dbStatus = status;
        applyBeBoatStatus({
          boatId: boat.boatId,
          boatCode: code,
          status: 'Incident',
          source: 'incident-keep-visible',
        });
        changed = true;
      } else {
        state.boats.delete(boat.boatId);
        clearBeBoatStatus(boat);
        if (code) state.hubBoats.delete(code);
        changed = true;
      }
    }
  }

  if (needFullRefresh) {
    await refreshFromDatabase();
    return;
  }
  if (changed) {
    syncStatusesWithNeon();
    broadcast();
  }
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
      const row = state.boats.get(boatId);
      if (hasOpenIncidentForBoat(row) || hasOpenIncidentForBoat(row?.boatCode)) continue;
      if (!activeBoatIds.has(boatId) && !String(boatId).startsWith('collector-') && boatId !== 'fallback-boat') {
        state.boats.delete(boatId);
      }
    }
    // Tàu Inactive: bỏ hub — trừ tàu đang sự cố (vẫn hiện đỏ).
    for (const code of [...state.hubBoats.keys()]) {
      if (hasOpenIncidentForBoat(code)) continue;
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
    // Neon là nguồn truth; bỏ cache Bảo trì/sự cố hook khi DB đã Active.
    reapplyBeBoatStatusesToCatalog();
    restoreLastPositionsToHub();
    broadcast();
  } catch (error) {
    state.dbStatus = { ok: false, message: error.message, loadedAt: new Date().toISOString() };
    ensureFallbackData();
    restoreLastPositionsToHub();
    broadcast();
  }
}

function tickSimulator() {
  // Live GPS: tàu không tự chạy trên tuyến.
  // Survey: chỉ collector chạy sau khi user bấm ghi GPS.
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
    // Dừng đúng điểm cuối đường vẽ — không nhảy về tâm bến.
    const end = pointAtDistance(collector.coordinates, collector.lengthMeters);
    collector.lat = end.lat;
    collector.lng = end.lng;
    collector.heading = end.heading;
    collector.progressMeters = collector.lengthMeters;
    collector.speedKmh = 0;
    collector.status = 'completed';
    collector.gpsEndStatus = 'idle';
  } else {
    collector.status = 'moving';
  }
  hideSurveyBoatFromLiveHub();
}

/** Mã tàu đang ghi GPS survey (vẽ tuyến) — tạm ẩn khỏi Live + không đẩy GPS Live. */
function activeSurveyBoatCode() {
  const code = String(state.collector?.boatCode || '').trim();
  if (!code) return '';
  const status = String(state.collector?.status || '').toLowerCase();
  if (!['moving', 'paused', 'running', 'completed'].includes(status)) return '';
  return code;
}

/** Survey: ẩn tàu đó khỏi Live hub (marker/GPS Live). Survey vẫn gửi GPS riêng. */
function hideSurveyBoatFromLiveHub() {
  const code = activeSurveyBoatCode();
  if (!code) return;
  state.hubBoats.delete(code);
}

async function publishGpsPositions() {
  // Mặc định không POST tàu live — chỉ survey collector (tránh 400 spam trên Azure).
  if (!parseBool(env.PUBLISH_LIVE_BOATS || 'false')) return;

  const surveyCode = activeSurveyBoatCode();
  const payloads = [...state.boats.values()]
    .filter((boat) => {
      const code = String(boat.boatCode || '').trim();
      // Chỉ loại tàu đang survey — tàu khác vẫn cập nhật GPS.
      if (surveyCode && code === surveyCode) return false;
      return true;
    })
    .map(buildTargetPayload);
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

  if (!isLiveMapBoatCode(boatCode)) {
    state.hubBoats.delete(boatCode);
    return {
      ok: false,
      status: 403,
      error: `Tàu ${boatCode} không hoạt động (Inactive) — không gửi GPS / không hiện map.`,
    };
  }

  if (activeSurveyBoatCode() === boatCode) {
    hideSurveyBoatFromLiveHub();
    return {
      ok: false,
      skipped: true,
      soft: true,
      status: 200,
      error: `Tàu ${boatCode} đang vẽ/ghi GPS survey — tạm ẩn trên Live và không cập nhật GPS Live (tránh đụng sequence). Các tàu khác vẫn chạy bình thường.`,
    };
  }

  // Chỉ tạm dừng Live GPS khi đang vẽ/survey. Trip + cứu hộ vẫn phải gửi liên tục
  // để FE (LIVE TRACKING) luôn thấy tàu — heartbeat/rescue/trip cùng publish.
  const fromRescue = body.fromRescue === true || body._fromRescue === true;
  const fromTrip = body.fromTrip === true || body._fromTrip === true;

  const matched = [...state.boats.values()].find((boat) => (
    String(boat.boatCode) === boatCode
    && !String(boat.boatId || '').startsWith('collector-')
    && isLiveMapBoatCode(boatCode)
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
  const tripId = fromTrip
    ? (cleanOptionalText(body.tripId) || null)
    : null;
  const routeCode = fromTrip
    ? (cleanOptionalText(body.routeCode) || null)
    : null;
  const nextStationId = fromTrip
    ? (cleanOptionalText(body.nextStationId) || null)
    : null;
  const nextStationName = fromTrip
    ? (cleanOptionalText(body.nextStationName) || null)
    : null;
  const remainingDistanceKmToNextStation = fromTrip && Number.isFinite(Number(body.remainingDistanceKmToNextStation))
    ? round(Number(body.remainingDistanceKmToNextStation), 3)
    : null;
  const remainingMinutesToNextStation = fromTrip && Number.isFinite(Number(body.remainingMinutesToNextStation))
    ? round(Number(body.remainingMinutesToNextStation), 1)
    : null;

  const sequence = bumpDeviceSequence(deviceId, matched || null);
  // Contract FE/BE: locations = tripId/routeCode/nextStation/remaining* — không có plannedArrivalTime
  // (lịch đọc từ GET /api/operations/schedule).
  const payload = {
    messageId: randomUUID(),
    deviceId,
    boatId: matched?.boatId || body.boatId || null,
    boatCode,
    boatName: matched?.boatName || body.boatName || null,
    tripId,
    routeId: null,
    routeCode,
    nextStationId,
    nextStationName,
    remainingDistanceKmToNextStation,
    remainingMinutesToNextStation,
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

  // Optimistic local hub marker (SSE) — cập nhật hub TRƯỚC, rồi mới suppress Azure echo.
  const allowAzureWrite = liveAzureWriteEnabled();
  // Local follow-only: CHỈ cập nhật hub khi user kéo tay / trip / rescue.
  // Heartbeat (kể cả FE cũ thiếu quiet) không được đè Azure → tránh lệch Railway.
  const userOrMissionWrite = fromTrip || fromRescue
    || (body.holdAuthority === true && body.quiet !== true);
  const followOnly = !allowAzureWrite;
  const updateLocalHub = !followOnly || userOrMissionWrite;
  const holdAuthority = userOrMissionWrite;

  if (updateLocalHub) {
    upsertHubBoat({
      ...payload,
      isOnline: true,
      recordedAt: payload.recordedAt,
      receivedAt: new Date().toISOString(),
      forceAccept: true,
      holdAuthority,
      source: holdAuthority ? 'live' : 'live-heartbeat',
    });
    broadcast();
  }

  // Chặn Azure echo cũ sau khi hub đã nhận vị trí kéo/trip.
  const authMs = Number(env.HUB_LIVE_AUTHORITY_MS || 30_000);
  if (holdAuthority) {
    hubBoatSuppressUntil.set(boatCode, Date.now() + Math.max(authMs, 8_000));
  }

  const sendToTarget = allowAzureWrite
    && (azurePositionsSeeded || fromTrip || fromRescue || holdAuthority)
    && (
      body.sendToTarget !== undefined
        ? Boolean(body.sendToTarget)
        : Boolean(state.senderEnabled && getTargetEndpoint())
    );

  if (!sendToTarget || !getTargetEndpoint()) {
    return {
      ok: true,
      status: 200,
      mode: followOnly ? 'follow-azure' : 'local',
      sequence: payload.sequence,
      payload,
      warning: !allowAzureWrite
        ? 'Local chỉ đọc vị trí Azure (LIVE_AZURE_WRITE=false) — Railway ghi GPS.'
        : (!azurePositionsSeeded && !fromTrip && !fromRescue
          ? 'Chưa seed boats/latest từ Azure — tạm chưa ghi GPS.'
          : 'Chưa gửi Azure (SEND_TO_TARGET tắt hoặc chưa cấu hình endpoint).'),
    };
  }

  try {
    const azurePayload = sanitizeGpsPayloadForAzure(payload, { keepTrip: fromTrip });
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
          status: 200,
          azureStatus: 409,
          sequence: payload.sequence,
          payload,
          warning: 'Sequence lệch BE — điểm đã cập nhật local map.',
        };
      }
      // Soft fail không còn — vẫn không trả HTTP 409 cho trình duyệt (tránh spam console).
      if (!ok) {
        return {
          ok: true,
          soft: true,
          status: 200,
          azureStatus: 409,
          sequence: payload.sequence,
          payload,
          warning: errorText || 'Sequence conflict — giữ vị trí local.',
        };
      }
    }
    // 400: thử bỏ tripId trước (giữ ETA), rồi mới chỉ vị trí — contract muốn tripId nhưng BE từng reject.
    if (!ok && statusCode === 400 && fromTrip && (
      azurePayload.tripId
      || azurePayload.routeCode
      || azurePayload.nextStationId
      || azurePayload.remainingDistanceKmToNextStation != null
      || azurePayload.remainingMinutesToNextStation != null
    )) {
      const retryBodies = [];
      if (azurePayload.tripId || azurePayload.routeCode) {
        retryBodies.push({
          ...azurePayload,
          tripId: null,
          routeCode: null,
          routeId: null,
          label: 'ETA không tripId',
        });
      }
      retryBodies.push({
        ...azurePayload,
        nextStationId: null,
        nextStationName: null,
        remainingDistanceKmToNextStation: null,
        remainingMinutesToNextStation: null,
        tripId: null,
        routeCode: null,
        routeId: null,
        label: 'chỉ vị trí',
      });
      for (const stripped of retryBodies) {
        const label = stripped.label;
        delete stripped.label;
        try {
          const retryRes = await fetch(getTargetEndpoint(), {
            method: 'POST',
            headers: buildGpsHeaders(stripped),
            body: JSON.stringify(stripped),
          });
          const retryText = await retryRes.text();
          let retryData = null;
          if (retryText) {
            try { retryData = JSON.parse(retryText); } catch { retryData = { message: retryText }; }
          }
          if (retryRes.status >= 200 && retryRes.status < 300) {
            pushApiCallLog({
              method: 'POST',
              url: getTargetEndpoint(),
              path: '/api/tracking/locations',
              ok: true,
              status: retryRes.status,
              error: null,
              at: new Date().toISOString(),
              request: summarizeApiPayload(stripped),
              response: summarizeApiPayload(retryData),
              deviceId,
            });
            console.warn(`[live-gps] ${boatCode}: BE 400 → retry ${label}.`);
            return {
              ok: true,
              soft: true,
              status: 200,
              azureStatus: 400,
              sequence: payload.sequence,
              payload: stripped,
              warning: label === 'chỉ vị trí'
                ? 'BE từ chối ETA trên locations — đã gửi vị trí; ETA chưa vào boats/latest.'
                : 'BE từ chối tripId trên locations — đã gửi ETA không tripId.',
            };
          }
        } catch {
          // thử body tiếp theo
        }
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
 * POST /tracking/locations (contract FE/BE):
 * - Trip: gửi tripId + routeCode + nextStation + remaining*
 * - Không gửi plannedArrivalTime (FE lấy lịch từ /operations/schedule)
 * - AZURE_GPS_STRIP_TRIP_ON_LOCATION=true → bỏ tripId/routeCode nếu BE còn 400
 */
function sanitizeGpsPayloadForAzure(payload, { keepTrip = false } = {}) {
  const out = { ...payload };
  const azureMaxSpeed = Math.max(1, Number(env.AZURE_MAX_SPEED_KMH || 80));
  if (Number.isFinite(Number(out.speedKmh))) {
    out.speedKmh = round(Math.min(Math.max(0, Number(out.speedKmh)), azureMaxSpeed), 1);
  }

  out.routeId = null;
  // Field ngoài contract — đừng gửi lên Azure.
  delete out.plannedArrivalTime;
  delete out.nextStopPlannedArrivalAt;

  if (!keepTrip) {
    out.tripId = null;
    out.routeCode = null;
    out.nextStationId = null;
    out.nextStationName = null;
    out.remainingDistanceKmToNextStation = null;
    out.remainingMinutesToNextStation = null;
    return out;
  }

  const stripTrip = parseBool(env.AZURE_GPS_STRIP_TRIP_ON_LOCATION ?? 'false');
  if (stripTrip) {
    out.tripId = null;
    out.routeCode = null;
  }
  return out;
}

function buildHookHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const secret = String(state.liveHookSecret || env.LIVE_HOOK_SECRET || '').trim();
  if (secret) headers['X-Live-Hook-Secret'] = secret;
  if (state.targetApiKey) headers['X-Api-Key'] = state.targetApiKey;
  return headers;
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

/** Azure thường bắt standardTravelMin là int ≥ 1 (segment). */
function azureTravelMinutes(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.round(n));
}

/** Giữ đúng phút lúc vẽ (vd 0.22) — không làm tròn lên 1. */
function exactDurationMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number(n.toFixed(2));
}

/** Tốc độ chạy survey: ưu tiên tốc độ cài lúc vẽ/ghi — bỏ 0/1 (sau khi tàu dừng). */
function resolveSurveySpeedKmh(body = {}, session = null, boatCode = null) {
  const maxSpeed = maxSpeedForBoatCode(boatCode || body.boatCode || session?.boatCode);
  const candidates = [
    body.averageSpeedKmh,
    body.speedKmh,
    body.cruiseSpeedKmh,
    session?.cruiseSpeedKmh,
    session?.averageSpeedKmh,
    session?.speedKmh,
    env.DEFAULT_SPEED_KMH,
    16,
  ];
  let raw = null;
  for (const value of candidates) {
    const n = Number(value);
    // 0 = đã dừng; clamp min=1 biến 0 → 1 (sai). Chỉ nhận tốc độ chạy thật.
    if (Number.isFinite(n) && n >= 2) {
      raw = n;
      break;
    }
  }
  if (raw == null) raw = Number(env.DEFAULT_SPEED_KMH || 16);
  return clampSpeedToBoatMax(raw, maxSpeed);
}

async function getFromTargetApi(pathname, deviceId, { silent = false } = {}) {
  return requestTargetApi({
    method: 'GET',
    pathname,
    deviceId,
    silent,
    auth: 'gps',
  });
}

async function requestTargetApi({
  method = 'GET',
  pathname,
  payload = null,
  deviceId = null,
  silent = false,
  auth = 'gps',
} = {}) {
  const url = targetApiUrl(pathname);
  if (!url) {
    const result = {
      ok: false,
      error: 'Chua cau hinh TARGET_GPS_ENDPOINT',
      status: 400,
      at: new Date().toISOString(),
      path: pathname,
      data: null,
    };
    if (!silent) pushApiCallLog({ method, ...result, request: summarizeApiPayload(payload), url: null });
    return result;
  }
  try {
    let headers;
    if (auth === 'bearer') headers = buildBearerHeaders();
    else if (auth === 'hook') headers = buildHookHeaders();
    else headers = buildGpsHeaders({ deviceId });
    const init = { method, headers };
    if (payload != null && method !== 'GET' && method !== 'HEAD') {
      init.body = JSON.stringify(payload);
    }
    const response = await fetch(url, init);
    let data = null;
    const textBody = await response.text();
    if (textBody) {
      try { data = JSON.parse(textBody); } catch { data = { message: textBody }; }
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
      if (response.status === 401 && auth === 'bearer') {
        result.error = `${result.error} · Cần TARGET_BEARER_TOKEN (JWT Staff/Admin)`;
      }
      if ((response.status === 401 || response.status === 403) && auth === 'hook') {
        result.error = `${result.error} · Cần LIVE_HOOK_SECRET khớp BE`;
      }
    }
    if (!silent) {
      pushApiCallLog({
        method,
        url,
        path: pathname,
        ok: result.ok,
        status: result.status,
        error: result.error,
        at: result.at,
        request: summarizeApiPayload(payload),
        response: summarizeApiPayload(data),
        deviceId: deviceId || null,
        auth,
      });
    }
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
    if (!silent) {
      pushApiCallLog({
        method,
        url,
        path: pathname,
        ok: false,
        status: 502,
        error: error.message,
        at: result.at,
        request: summarizeApiPayload(payload),
        response: null,
        deviceId: deviceId || null,
        auth,
      });
    }
    return result;
  }
}

function buildBearerHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const token = String(state.targetBearerToken || '').trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (state.targetApiKey) headers['X-Api-Key'] = state.targetApiKey;
  return headers;
}

function boatByIdOrCode(boatIdOrCode) {
  const key = String(boatIdOrCode || '').trim();
  if (!key) return null;
  return [...state.boats.values()].find((b) => (
    String(b.boatId || '') === key
    || String(b.boatCode || '').trim() === key
  )) || null;
}

function boatCodeFromId(boatId) {
  const boat = boatByIdOrCode(boatId);
  return boat?.boatCode || null;
}

/** Tàu cứu chính: ưu tiên rescueBoatCode (SOS_*), fallback replacementBoatCode (contract cũ). */
function pickRescueBoatCode(src = {}) {
  const direct = String(
    src.rescueBoatCode
    || src.RescueBoatCode
    || src.rescue_boat_code
    || '',
  ).trim();
  if (direct) return direct;
  const fromId = boatCodeFromId(src.rescueBoatId || src.RescueBoatId || src.rescue_boat_id);
  if (fromId) return fromId;
  return String(
    src.replacementBoatCode
    || src.ReplacementBoatCode
    || '',
  ).trim() || '';
}

function pickReplacementBoatCode(src = {}) {
  return String(
    src.replacementBoatCode
    || src.ReplacementBoatCode
    || '',
  ).trim() || '';
}

/**
 * Đảm bảo tàu cứu (vd SOS_001) có trong catalog + hub để Live hiện và POST tracking được.
 * Nếu chưa có GPS: seed đúng tọa độ hiện trường/bến — được đè/chồng trong phạm vi chuẩn, không đẩy ~350m ra ngoài.
 */
function ensureRescueBoatOnMap(boatCode, nearLat = null, nearLng = null) {
  const code = String(boatCode || '').trim();
  if (!code) return null;
  let boat = boatByIdOrCode(code);
  let lat = Number(nearLat);
  let lng = Number(nearLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const station = (state.stations || []).find((s) => (
      Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng))
    ));
    lat = Number(station?.lat) || 10.776;
    lng = Number(station?.lng) || 106.705;
  }
  // Không lệch seed — nhiều tàu cùng bến được chồng trong phạm vi chuẩn.
  if (!boat) {
    const id = randomUUID();
    boat = {
      boatId: id,
      boatCode: code,
      boatName: /^SOS[_-]?/i.test(code) ? `Tàu cứu ${code}` : code,
      dbStatus: 'Active',
      beStatus: 'Active',
      numberOfDecks: 1,
      maxSpeedKmh: Math.max(1, Number(env.RESCUE_SPEED_KMH || env.DEFAULT_SPEED_KMH || 16)),
      lat,
      lng,
      heading: 0,
      speedKmh: 0,
      status: 'idle',
      paused: true,
      updatedAt: new Date().toISOString(),
    };
    state.boats.set(id, boat);
  } else {
    boat.dbStatus = boat.dbStatus || 'Active';
    boat.beStatus = boat.beStatus || 'Active';
    if (!Number.isFinite(Number(boat.lat)) || !Number.isFinite(Number(boat.lng))) {
      boat.lat = lat;
      boat.lng = lng;
    }
  }
  const hub = state.hubBoats.get(code);
  const hubLat = Number(hub?.lat ?? boat.lat);
  const hubLng = Number(hub?.lng ?? boat.lng);
  if (!Number.isFinite(hubLat) || !Number.isFinite(hubLng)) {
    state.hubBoats.set(code, {
      ...(hub || {}),
      boatCode: code,
      boatName: boat.boatName,
      boatId: boat.boatId,
      lat,
      lng,
      speedKmh: 0,
      heading: Number(hub?.heading ?? boat.heading ?? 0),
      isOnline: true,
      source: 'rescue-seed',
      updatedAt: new Date().toISOString(),
    });
  } else if (!hub) {
    state.hubBoats.set(code, {
      boatCode: code,
      boatName: boat.boatName,
      boatId: boat.boatId,
      lat: hubLat,
      lng: hubLng,
      speedKmh: 0,
      heading: Number(boat.heading || 0),
      isOnline: true,
      source: 'rescue-seed',
      updatedAt: new Date().toISOString(),
    });
  }
  return boat;
}

function extractIncidentRows(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of ['items', 'data', 'incidents', 'results', 'value']) {
    if (Array.isArray(data[key])) return data[key];
  }
  if (data.incidentId || data.id || data.IncidentId) return [data];
  return [];
}

function normalizeIncident(row, source = 'api') {
  if (!row || typeof row !== 'object') return null;
  const nested = row.incident && typeof row.incident === 'object' ? row.incident : row;
  const incidentId = String(
    nested.incidentId || nested.id || nested.IncidentId || nested.Id || '',
  ).trim();
  if (!incidentId) return null;

  const boatId = nested.boatId || nested.BoatId || row.boatId || null;
  const boatCode = String(
    nested.boatCode || nested.BoatCode || boatCodeFromId(boatId) || '',
  ).trim() || null;
  const replacementBoatId = nested.replacementBoatId
    || nested.ReplacementBoatId
    || row.replacementBoatId
    || null;
  const rescueBoatCode = pickRescueBoatCode(nested) || pickRescueBoatCode(row) || null;
  const replacementBoatCode = pickReplacementBoatCode(nested)
    || pickReplacementBoatCode(row)
    || (rescueBoatCode ? '' : boatCodeFromId(replacementBoatId))
    || null;
  // Contract mới: rescue ≠ replacement. Chỉ fallback cũ khi BE chưa gửi rescueBoatCode.
  const effectiveRescue = rescueBoatCode
    || String(replacementBoatCode || boatCodeFromId(replacementBoatId) || '').trim()
    || null;

  const lat = Number(
    nested.lat ?? nested.latitude ?? nested.Latitude
    ?? nested.location?.lat ?? nested.Location?.lat
    ?? row.lat ?? row.latitude,
  );
  const lng = Number(
    nested.lng ?? nested.longitude ?? nested.Longitude
    ?? nested.location?.lng ?? nested.Location?.lng
    ?? row.lng ?? row.longitude,
  );

  const resolutionStatus = String(
    nested.resolutionStatus || nested.ResolutionStatus || 'Open',
  ).trim() || 'Open';

  return {
    incidentId,
    boatId: boatId || null,
    boatCode,
    boatName: nested.boatName || nested.BoatName || boatByIdOrCode(boatId)?.boatName || null,
    tripId: nested.tripId || nested.TripId || null,
    incidentType: nested.incidentType || nested.IncidentType || null,
    severity: nested.severity || nested.Severity || null,
    description: nested.description || nested.Description || null,
    resolutionStatus,
    resolutionNote: nested.resolutionNote || nested.ResolutionNote || null,
    replacementBoatId: replacementBoatId || null,
    replacementBoatCode: replacementBoatCode || null,
    rescueBoatCode: effectiveRescue,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    occurredAt: nested.occurredAt || nested.OccurredAt || nested.createdAt || null,
    updatedAt: nested.updatedAt || nested.UpdatedAt || new Date().toISOString(),
    source,
    raw: nested,
  };
}

function upsertIncidentRecord(incident, { removeIfResolved = true } = {}) {
  if (!incident?.incidentId) return false;
  const status = String(incident.resolutionStatus || '').toLowerCase();
  const isOpen = !status || status === 'open';
  if (removeIfResolved && !isOpen) {
    return state.openIncidents.delete(incident.incidentId);
  }
  const prev = state.openIncidents.get(incident.incidentId) || {};
  const nextLat = incident.lat ?? prev.lat ?? null;
  const nextLng = incident.lng ?? prev.lng ?? null;
  const sceneLat = prev.sceneLat
    ?? incident.sceneLat
    ?? (Number.isFinite(Number(nextLat)) ? Number(nextLat) : null);
  const sceneLng = prev.sceneLng
    ?? incident.sceneLng
    ?? (Number.isFinite(Number(nextLng)) ? Number(nextLng) : null);
  state.openIncidents.set(incident.incidentId, {
    ...prev,
    ...incident,
    lat: nextLat,
    lng: nextLng,
    sceneLat,
    sceneLng,
    boatCode: incident.boatCode || prev.boatCode || null,
    replacementBoatCode: incident.replacementBoatCode || prev.replacementBoatCode || null,
    rescueBoatCode: incident.rescueBoatCode || prev.rescueBoatCode || null,
  });
  return true;
}

function rescueMissionPublic(mission) {
  if (!mission) return null;
  const { publishing, pathCoordinates, ...publicMission } = mission;
  const path = Array.isArray(pathCoordinates) ? pathCoordinates : [];
  return {
    ...publicMission,
    pathCoordinates: path.map((p) => ({
      lat: round(Number(p.lat), 6),
      lng: round(Number(p.lng), 6),
    })),
    pathLengthMeters: Number.isFinite(Number(mission.pathLengthMeters))
      ? round(Number(mission.pathLengthMeters), 0)
      : null,
    pathProgressMeters: Number.isFinite(Number(mission.pathProgressMeters))
      ? round(Number(mission.pathProgressMeters), 0)
      : null,
  };
}

function getRescueRiverBasePath() {
  return resolveRiverBasePath({
    stations: state.stations || [],
    routes: [...state.routes.values()],
    osmCorridor: state.osmWaterbusCorridor || osmWaterbusCorridor || [],
  });
}

async function loadOsmWaterbusCorridor() {
  try {
    const filePath = path.join(rootDir, 'data', 'saigon-waterbus-corridor.json');
    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    const coords = (raw.coordinates || [])
      .map((p) => {
        const lat = Number(p?.lat);
        const lng = Number(p?.lng ?? p?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return { lat, lng };
      })
      .filter(Boolean);
    if (coords.length >= 2) {
      console.log(`[river] OSM Saigon Waterbus corridor loaded: ${coords.length} pts`);
    }
    return coords;
  } catch (error) {
    console.warn(`[river] OSM corridor missing: ${error.message}`);
    return [];
  }
}

function sanitizeRequestPoint(value) {
  const lat = Number(value?.lat ?? value?.latitude);
  const lng = Number(value?.lng ?? value?.lon ?? value?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** A→B (không vòng): ép path lên hành lang sông Waterbus. */
function snapCoordinatesToRiver(coordinates, { force = false } = {}) {
  const pts = Array.isArray(coordinates)
    ? coordinates
      .map((p) => sanitizeRequestPoint(p))
      .filter(Boolean)
    : [];
  if (pts.length < 2) return pts;
  const start = pts[0];
  const end = pts[pts.length - 1];
  // Vòng sightseeing (đầu ≈ cuối) giữ nguyên đường vẽ.
  if (!force && distanceMeters(start, end) < 80) return pts;
  const built = buildRiverPath(start, end, getRescueRiverBasePath(), { joinMeters: 90 });
  if (built.coordinates.length >= 2) return built.coordinates;
  return pts;
}

/** Gán đường bo sông từ from → to (cứu hộ InTransit / Towing). */
function assignRescueRiverPath(mission, from, to) {
  if (!mission) return null;
  const built = buildRiverPath(from, to, getRescueRiverBasePath(), { joinMeters: 90 });
  mission.pathCoordinates = built.coordinates;
  mission.pathLengthMeters = built.lengthMeters;
  mission.pathProgressMeters = 0;
  mission.pathUpdatedAt = new Date().toISOString();
  return built;
}

function completeRescueMission(incidentId, reason = 'IncidentResolved') {
  const id = String(incidentId || '').trim();
  if (!id) return null;
  const mission = state.rescueMissions.get(id);
  if (mission) {
    Object.assign(mission, {
      status: 'Completed',
      completedReason: reason,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      publishing: false,
    });
  }
  // Đóng luôn mission tàu thay khách (nếu có).
  const transfer = state.rescueMissions.get(`${id}__xfer`);
  if (transfer && transfer.status !== 'Completed') {
    Object.assign(transfer, {
      status: 'Completed',
      completedReason: reason,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      publishing: false,
    });
  }
  return mission || transfer || null;
}

function nearestStationTo(point) {
  let nearest = null;
  for (const station of state.stations || []) {
    const lat = Number(station?.lat);
    const lng = Number(station?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const meters = distanceMeters(point, { lat, lng });
    if (!nearest || meters < nearest.meters) {
      nearest = { station, lat, lng, meters };
    }
  }
  return nearest;
}

/** Bến gần nhất nhưng cách ít nhất minMeters — tránh Towing “về bến” ngay chỗ đang đứng. */
function nearestStationBeyond(point, minMeters = 80) {
  let nearestAny = null;
  let nearestFar = null;
  for (const station of state.stations || []) {
    const lat = Number(station?.lat);
    const lng = Number(station?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const meters = distanceMeters(point, { lat, lng });
    const row = { station, lat, lng, meters };
    if (!nearestAny || meters < nearestAny.meters) nearestAny = row;
    if (meters >= minMeters && (!nearestFar || meters < nearestFar.meters)) nearestFar = row;
  }
  return nearestFar || nearestAny;
}

/**
 * Tọa độ mục tiêu cứu hộ: ưu tiên GPS live tàu sự cố (hub) → vị trí cuối → scene → payload.
 */
function resolveIncidentTargetCoords({
  incidentBoatCode = null,
  sceneLat = null,
  sceneLng = null,
  fallbackLat = null,
  fallbackLng = null,
  from = null,
} = {}) {
  const code = String(incidentBoatCode || '').trim();
  const hub = code ? state.hubBoats.get(code) : null;
  const hubLat = Number(hub?.lat);
  const hubLng = Number(hub?.lng);
  if (Number.isFinite(hubLat) && Number.isFinite(hubLng)) {
    const metersFromRescue = (from && Number.isFinite(Number(from.lat)))
      ? distanceMeters(from, { lat: hubLat, lng: hubLng })
      : null;
    return {
      lat: hubLat,
      lng: hubLng,
      source: 'hub',
      metersFromRescue,
    };
  }
  const saved = code ? lastPositions[code] : null;
  const savedLat = Number(saved?.lat);
  const savedLng = Number(saved?.lng);
  if (Number.isFinite(savedLat) && Number.isFinite(savedLng)) {
    const metersFromRescue = (from && Number.isFinite(Number(from.lat)))
      ? distanceMeters(from, { lat: savedLat, lng: savedLng })
      : null;
    return {
      lat: savedLat,
      lng: savedLng,
      source: 'last',
      metersFromRescue,
    };
  }
  const sLat = Number(sceneLat);
  const sLng = Number(sceneLng);
  if (Number.isFinite(sLat) && Number.isFinite(sLng)) {
    return { lat: sLat, lng: sLng, source: 'scene', metersFromRescue: null };
  }
  return {
    lat: Number(fallbackLat),
    lng: Number(fallbackLng),
    source: 'payload',
    metersFromRescue: null,
  };
}

function isBoatInActiveRescueMission(boatCode) {
  const code = String(boatCode || '').trim();
  if (!code) return false;
  for (const mission of state.rescueMissions.values()) {
    const status = String(mission?.status || '');
    // AtStation/Completed: đã nhả — không còn khóa GPS/kéo.
    if (!['Dispatched', 'InTransit', 'Arrived', 'Towing'].includes(status)) continue;
    if (String(mission.rescueBoatCode || '').trim() === code) return true;
    // Tàu sự cố cũng bị rescue sở hữu GPS (neo hiện trường / kéo).
    if (String(mission.incidentBoatCode || '').trim() === code) return true;
  }
  return false;
}

function pointBehind(position, heading, meters) {
  const reverseRad = ((Number(heading) + 180) % 360) * Math.PI / 180;
  const lat = Number(position.lat);
  const lng = Number(position.lng);
  const northMeters = Math.cos(reverseRad) * meters;
  const eastMeters = Math.sin(reverseRad) * meters;
  const latOffset = northMeters / 111320;
  const lngScale = 111320 * Math.max(0.2, Math.cos(lat * Math.PI / 180));
  return {
    lat: lat + latOffset,
    lng: lng + (eastMeters / lngScale),
  };
}

/**
 * Contract BE: khi kéo về bến xong, GPS callback để BE quyết định status
 * (Resolved + UnderMaintenance + SOS Active). GPS không tự sửa DB BE.
 * POST {apiRoot}/api/incidents/rescue-mission-completed
 * Header: X-Live-Hook-Secret
 */
async function notifyBeRescueMissionCompleted(mission) {
  if (!mission || mission.beCallbackSent) return { ok: false, skipped: true, reason: 'already-sent' };
  const incidentId = String(mission.incidentId || '').trim();
  // Bỏ mission transfer (__xfer) — chỉ callback incident gốc.
  if (!incidentId || incidentId.endsWith('__xfer')) {
    return { ok: false, skipped: true, reason: 'no-incident' };
  }
  const secret = String(state.liveHookSecret || env.LIVE_HOOK_SECRET || '').trim();
  const root = getTargetApiRoot();
  if (!root) {
    console.warn('[rescue-callback] thiếu TARGET_GPS_ENDPOINT — bỏ qua callback BE');
    return { ok: false, skipped: true, reason: 'no-api-root' };
  }
  if (!secret) {
    console.warn('[rescue-callback] thiếu LIVE_HOOK_SECRET — bỏ qua callback BE');
    return { ok: false, skipped: true, reason: 'no-secret' };
  }

  const path = String(env.RESCUE_COMPLETED_PATH || '/api/incidents/rescue-mission-completed').trim()
    || '/api/incidents/rescue-mission-completed';
  const url = targetApiUrl(path);
  // Body đúng contract BE — dùng boatCode/rescueBoatCode (không dùng boatName).
  const payload = {
    incidentId,
    boatCode: mission.incidentBoatCode || null,
    rescueBoatCode: mission.rescueBoatCode || null,
    completedAt: formatRecordedAt(new Date()),
    note: mission.destinationStationName
      ? `Tàu đã được kéo về ${mission.destinationStationName}`
      : 'Tàu đã được kéo về bến',
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Live-Hook-Secret': secret,
      },
      body: JSON.stringify(payload),
    });
    let data = null;
    const text = await response.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = { message: text }; }
    }
    const ok = response.status >= 200 && response.status < 300;
    mission.beCallbackSent = true;
    mission.beCallbackAt = new Date().toISOString();
    mission.beCallbackOk = ok;
    mission.beCallbackStatus = response.status;
    mission.beCallbackError = ok ? null : formatTargetApiError(data, response.status);
    pushApiCallLog({
      method: 'POST',
      url,
      path,
      ok,
      status: response.status,
      error: mission.beCallbackError,
      at: mission.beCallbackAt,
      request: summarizeApiPayload(payload),
      response: summarizeApiPayload(data),
      deviceId: null,
    });
    console.log(
      `[rescue-callback] ${ok ? 'OK' : 'FAIL'} ${response.status} `
      + `${mission.rescueBoatCode} · ${mission.incidentBoatCode} · ${incidentId}`,
    );
    // BE đã Resolved — đồng bộ local (không chờ IncidentResolved hook).
    if (ok) {
      state.openIncidents.delete(incidentId);
      state.resolvedIncidentIds.set(incidentId, Date.now());
      clearBeBoatStatus(mission.rescueBoatCode);
      if (mission.incidentBoatCode) {
        applyBeBoatStatus({
          boatCode: mission.incidentBoatCode,
          status: 'UnderMaintenance',
          source: 'rescue-mission-completed',
        });
      }
      broadcast();
    }
    return { ok, status: response.status, data, error: mission.beCallbackError };
  } catch (error) {
    mission.beCallbackSent = true;
    mission.beCallbackAt = new Date().toISOString();
    mission.beCallbackOk = false;
    mission.beCallbackError = error.message;
    pushApiCallLog({
      method: 'POST',
      url,
      path,
      ok: false,
      status: 502,
      error: error.message,
      at: mission.beCallbackAt,
      request: summarizeApiPayload(payload),
      response: null,
      deviceId: null,
    });
    console.warn(`[rescue-callback] error: ${error.message}`);
    return { ok: false, status: 502, error: error.message };
  }
}

/**
 * Nhận RescueDispatched → kéo tàu cứu tới hiện trường, rồi kéo tàu lỗi về bến gần nhất.
 * Đang chạy (InTransit/Towing): chỉ cập nhật target (idempotent).
 * Đã AtStation/Completed: cho phép Điều tàu lại → tạo mission mới.
 */
function startRescueAutomation(incident) {
  const incidentId = String(incident?.incidentId || '').trim();
  const rescueBoatCode = pickRescueBoatCode(incident)
    || String(incident?.rescueBoatCode || incident?.replacementBoatCode || '').trim();
  const replacementBoatCode = pickReplacementBoatCode(incident)
    || String(incident?.replacementBoatCode || '').trim()
    || null;
  const targetLat = Number(incident?.lat);
  const targetLng = Number(incident?.lng);
  if (!incidentId || !rescueBoatCode) {
    return { started: false, error: 'Thiếu incidentId / rescueBoatCode' };
  }
  if (!Number.isFinite(targetLat) || !Number.isFinite(targetLng)) {
    return { started: false, error: 'Chưa có tọa độ tàu sự cố' };
  }

  const existing = state.rescueMissions.get(incidentId);
  if (existing) {
    const status = String(existing.status || '');
    const stillRunning = ['Dispatched', 'InTransit', 'Arrived', 'Towing'].includes(status);
    const sameRescue = existing.rescueBoatCode === rescueBoatCode;
    if (stillRunning && sameRescue) {
      existing.targetLat = targetLat;
      existing.targetLng = targetLng;
      existing.incidentLat = targetLat;
      existing.incidentLng = targetLng;
      existing.updatedAt = new Date().toISOString();
      console.log(`[rescue-gps] skip duplicate (đang ${status}) ${rescueBoatCode} · ${incidentId}`);
      return { started: false, duplicate: true, mission: rescueMissionPublic(existing) };
    }
    // AtStation / Completed / đổi tàu cứu → xóa mission cũ để chạy lại.
    state.rescueMissions.delete(incidentId);
    state.rescueMissions.delete(`${incidentId}__xfer`);
    console.log(`[rescue-gps] restart sau ${status || 'none'} · ${rescueBoatCode} → ${incident.boatCode || incidentId}`);
  }

  // Target: ưu tiên GPS live tàu sự cố (tọa độ gần nhất hiện tại), không bám sceneLat stale ở bến.
  const incidentBoatCode = String(incident.boatCode || '').trim() || null;
  const openExisting = state.openIncidents.get(incidentId);
  const sceneLat = Number(openExisting?.sceneLat ?? incident?.sceneLat ?? targetLat);
  const sceneLng = Number(openExisting?.sceneLng ?? incident?.sceneLng ?? targetLng);

  ensureRescueBoatOnMap(rescueBoatCode, sceneLat, sceneLng);
  const rescueBoat = boatByIdOrCode(rescueBoatCode);
  const hub = state.hubBoats.get(rescueBoatCode);
  const startLat = Number(hub?.lat ?? rescueBoat?.lat);
  const startLng = Number(hub?.lng ?? rescueBoat?.lng);
  if (!Number.isFinite(startLat) || !Number.isFinite(startLng)) {
    return { started: false, error: `Chưa có GPS tàu cứu ${rescueBoatCode}` };
  }

  const resolved = resolveIncidentTargetCoords({
    incidentBoatCode,
    sceneLat,
    sceneLng,
    fallbackLat: targetLat,
    fallbackLng: targetLng,
    from: { lat: startLat, lng: startLng },
  });
  let resolvedTargetLat = resolved.lat;
  let resolvedTargetLng = resolved.lng;
  if (resolved.source === 'hub' || resolved.source === 'last') {
    console.log(
      `[rescue-gps] target ${resolved.source} ${incidentBoatCode}: `
      + `${sceneLat},${sceneLng} → ${resolvedTargetLat},${resolvedTargetLng} `
      + `(${Math.round(resolved.metersFromRescue || 0)}m từ SOS)`,
    );
  }

  const arrivalMeters = Math.max(3, Number(env.RESCUE_ARRIVE_METERS || 15));
  const distToScene = distanceMeters(
    { lat: startLat, lng: startLng },
    { lat: resolvedTargetLat, lng: resolvedTargetLng },
  );
  // Chỉ bỏ qua đoạn ra hiện trường khi SOS đã ĐÚNG tại chỗ (< arrive). Không dùng ngưỡng 40m
  // (dễ nhảy thẳng Towing về bến khác → FE không thấy chạy rồi mất badge CỨU).
  const alreadyAtScene = distToScene <= arrivalMeters;
  let initialStatus = 'Dispatched';
  let missionTargetLat = resolvedTargetLat;
  let missionTargetLng = resolvedTargetLng;
  let destinationMeta = null;
  if (alreadyAtScene) {
    // Sát hiện trường + sát bến → kéo vào đúng bến gần nhất (không đẩy sang bến ≥80m).
    const towDest = nearestStationTo({ lat: startLat, lng: startLng });
    if (towDest) {
      initialStatus = 'Towing';
      missionTargetLat = towDest.lat;
      missionTargetLng = towDest.lng;
      destinationMeta = towDest;
      console.log(
        `[rescue-gps] SOS đã sát hiện trường (${Math.round(distToScene)}m) `
        + `→ Towing vào ${towDest.station?.stationCode || 'bến'} (${Math.round(towDest.meters)}m)`,
      );
    }
  }

  const now = new Date().toISOString();
  const configuredSpeed = Math.max(1, Number(env.RESCUE_SPEED_KMH || 32));
  const rescueMaxSpeed = Number(rescueBoat?.maxSpeedKmh);
  const mission = {
    incidentId,
    incidentBoatCode,
    rescueBoatCode,
    replacementBoatCode: replacementBoatCode && replacementBoatCode !== rescueBoatCode
      ? replacementBoatCode
      : null,
    status: initialStatus,
    currentLat: startLat,
    currentLng: startLng,
    startLat,
    startLng,
    targetLat: missionTargetLat,
    targetLng: missionTargetLng,
    incidentLat: resolvedTargetLat,
    incidentLng: resolvedTargetLng,
    traveledMeters: 0,
    speedKmh: Number.isFinite(rescueMaxSpeed)
      ? Math.min(configuredSpeed, rescueMaxSpeed)
      : configuredSpeed,
    startedAt: now,
    updatedAt: now,
    lastTickAt: Date.now(),
    publishing: false,
    lastSequence: null,
    lastPublishMode: null,
    lastError: null,
    pathCoordinates: [],
    pathLengthMeters: 0,
    pathProgressMeters: 0,
  };
  assignRescueRiverPath(
    mission,
    { lat: startLat, lng: startLng },
    { lat: missionTargetLat, lng: missionTargetLng },
  );
  if (destinationMeta) {
    mission.destinationStationId = destinationMeta.station?.stationId || null;
    mission.destinationStationCode = destinationMeta.station?.stationCode || null;
    mission.destinationStationName = destinationMeta.station?.stationName || null;
    mission.destinationDistanceMeters = Math.round(destinationMeta.meters);
    mission.towingStartedAt = now;
    const towHeading = bearingDegrees(
      { lat: startLat, lng: startLng },
      { lat: missionTargetLat, lng: missionTargetLng },
    ) || 0;
    const towRopeMeters = Math.max(12, Number(env.TOW_ROPE_METERS || 18));
    const behind = pointBehind({ lat: startLat, lng: startLng }, towHeading, towRopeMeters);
    mission.incidentCurrentLat = behind.lat;
    mission.incidentCurrentLng = behind.lng;
    mission.lastHeading = towHeading;
  }
  state.rescueMissions.set(incidentId, mission);
  const open = state.openIncidents.get(incidentId);
  if (open) {
    open.missionStatus = initialStatus;
    open.rescueBoatCode = rescueBoatCode;
    open.replacementBoatCode = mission.replacementBoatCode;
    // Giữ sceneLat gốc; không đè bằng hub đã về bến.
    if (!Number.isFinite(Number(open.sceneLat))) {
      open.sceneLat = resolvedTargetLat;
      open.sceneLng = resolvedTargetLng;
    }
    open.updatedAt = now;
  }
  console.log(
    `[rescue-gps] START ${rescueBoatCode} → ${incidentBoatCode || incidentId} `
    + `@ ${resolvedTargetLat},${resolvedTargetLng} (${initialStatus}, ${Math.round(distToScene)}m)`,
  );

  // Publish ngay điểm xuất phát — FE/SSE nhận SOS trước tick 2s (tránh đứng rồi "biến mất").
  publishLiveGpsPosition({
    boatCode: rescueBoatCode,
    lat: startLat,
    lng: startLng,
    heading: destinationMeta
      ? bearingDegrees(
        { lat: startLat, lng: startLng },
        { lat: missionTargetLat, lng: missionTargetLng },
      )
      : bearingDegrees(
        { lat: startLat, lng: startLng },
        { lat: resolvedTargetLat, lng: resolvedTargetLng },
      ),
    speedKmh: mission.speedKmh,
    status: 'moving',
    sendToTarget: true,
    fromRescue: true,
  }).catch((error) => {
    console.warn(`[rescue-gps] publish start failed: ${error.message}`);
  });
  // Gửi luôn GPS tàu sự cố tại hiện trường (Azure/map thấy SC, không chỉ badge FE).
  if (incidentBoatCode) {
    const incHeading = Number(state.hubBoats.get(incidentBoatCode)?.heading) || 0;
    if (destinationMeta && Number.isFinite(Number(mission.incidentCurrentLat))) {
      publishLiveGpsPosition({
        boatCode: incidentBoatCode,
        lat: mission.incidentCurrentLat,
        lng: mission.incidentCurrentLng,
        heading: mission.lastHeading || incHeading,
        speedKmh: mission.speedKmh,
        status: 'moving',
        sendToTarget: true,
        fromRescue: true,
      }).catch((error) => {
        console.warn(`[rescue-gps] publish incident tow-start failed: ${error.message}`);
      });
    } else {
      publishLiveGpsPosition({
        boatCode: incidentBoatCode,
        lat: resolvedTargetLat,
        lng: resolvedTargetLng,
        heading: incHeading,
        speedKmh: 0,
        status: 'idle',
        sendToTarget: true,
        fromRescue: true,
      }).catch((error) => {
        console.warn(`[rescue-gps] publish incident scene failed: ${error.message}`);
      });
    }
  }
  broadcast();

  // Có tàu thay khách riêng → điều thêm (không kéo tàu sự cố).
  let transferAutomation = null;
  if (mission.replacementBoatCode) {
    transferAutomation = startRescueAutomation({
      incidentId: `${incidentId}__xfer`,
      boatCode: null,
      rescueBoatCode: mission.replacementBoatCode,
      replacementBoatCode: null,
      lat: resolvedTargetLat,
      lng: resolvedTargetLng,
    });
  }

  return {
    started: true,
    mission: rescueMissionPublic(mission),
    transferAutomation,
  };
}

async function tickRescueMissions() {
  const nowMs = Date.now();
  const arrivalMeters = Math.max(3, Number(env.RESCUE_ARRIVE_METERS || 15));
  // Bản cũ giữ AtStation → SOS bị khóa; nhả ngay.
  for (const [id, mission] of state.rescueMissions) {
    if (String(mission?.status || '') === 'AtStation') {
      clearBeBoatStatus(mission.rescueBoatCode);
      completeRescueMission(id, 'ArrivedAtStation');
    }
  }
  const active = [...state.rescueMissions.values()].filter((mission) => (
    (mission.status === 'Dispatched' || mission.status === 'InTransit' || mission.status === 'Towing')
    && !mission.publishing
  ));

  await Promise.all(active.map(async (mission) => {
    mission.publishing = true;
    try {
      const current = { lat: Number(mission.currentLat), lng: Number(mission.currentLng) };
      const target = { lat: Number(mission.targetLat), lng: Number(mission.targetLng) };
      if (!Number.isFinite(current.lat) || !Number.isFinite(target.lat)) return;

      // Đường bo sông: tạo mới hoặc làm lại khi đích lệch cuối path.
      const path = Array.isArray(mission.pathCoordinates) ? mission.pathCoordinates : [];
      const pathEnd = path.length ? path[path.length - 1] : null;
      const endDrift = pathEnd
        ? distanceMeters(pathEnd, target)
        : Infinity;
      if (path.length < 2 || endDrift > 45) {
        assignRescueRiverPath(mission, current, target);
      }

      const elapsedSeconds = Math.max(
        1,
        Math.min(10, (nowMs - Number(mission.lastTickAt || nowMs - 2000)) / 1000),
      );
      const stepMeters = Math.max(2, (Number(mission.speedKmh) * 1000 / 3600) * elapsedSeconds);
      const adv = advanceAlongCoordinates(
        mission.pathCoordinates,
        mission.pathProgressMeters || 0,
        stepMeters,
      );
      mission.pathProgressMeters = adv.progressMeters;
      const lat = adv.lat;
      const lng = adv.lng;
      const heading = adv.heading || Number(mission.lastHeading || 0);
      const remaining = Number.isFinite(adv.remainingMeters)
        ? adv.remainingMeters
        : distanceMeters({ lat, lng }, target);
      const arrived = remaining <= arrivalMeters || adv.arrived;

      // Cập bến: snap đúng tọa độ station (không đứng giữa sông trên corridor).
      const berthLat = Number(mission.targetLat);
      const berthLng = Number(mission.targetLng);
      const dockAtBerth = arrived
        && mission.status === 'Towing'
        && Number.isFinite(berthLat)
        && Number.isFinite(berthLng);
      const publishLat = dockAtBerth ? berthLat : lat;
      const publishLng = dockAtBerth ? berthLng : lng;

      const rescueResult = await publishLiveGpsPosition({
        boatCode: mission.rescueBoatCode,
        lat: publishLat,
        lng: publishLng,
        heading,
        speedKmh: arrived ? 0 : mission.speedKmh,
        status: arrived ? 'idle' : 'moving',
        sendToTarget: true,
        fromRescue: true,
      });
      let incidentResult = null;
      if (mission.incidentBoatCode) {
        if (mission.status === 'Towing') {
          // Khi kéo: tàu lỗi đi sau tàu cứu. Cập bến: cả hai tại bến (cách berthGap).
          const towRopeMeters = Math.max(12, Number(env.TOW_ROPE_METERS || 18));
          const berthGapMeters = Math.max(8, Number(env.TOW_BERTH_GAP_METERS || 12));
          const towHeading = heading || Number(mission.lastHeading || 0);
          const lead = { lat: publishLat, lng: publishLng };
          const towedPosition = arrived
            ? pointBehind(lead, towHeading || bearingDegrees(current, target) || 0, berthGapMeters)
            : pointBehind(lead, towHeading, towRopeMeters);
          mission.incidentCurrentLat = towedPosition.lat;
          mission.incidentCurrentLng = towedPosition.lng;
          mission.lastHeading = towHeading;
          incidentResult = await publishLiveGpsPosition({
            boatCode: mission.incidentBoatCode,
            lat: towedPosition.lat,
            lng: towedPosition.lng,
            heading: towHeading,
            speedKmh: arrived ? 0 : mission.speedKmh,
            status: arrived ? 'idle' : 'moving',
            sendToTarget: true,
            fromRescue: true,
          });
        } else {
          // Dispatched/InTransit: neo GPS tàu sự cố tại hiện trường (gửi Azure liên tục).
          const sceneLat = Number(mission.incidentCurrentLat ?? mission.incidentLat);
          const sceneLng = Number(mission.incidentCurrentLng ?? mission.incidentLng);
          if (Number.isFinite(sceneLat) && Number.isFinite(sceneLng)) {
            mission.incidentCurrentLat = sceneLat;
            mission.incidentCurrentLng = sceneLng;
            const incHeading = Number(state.hubBoats.get(mission.incidentBoatCode)?.heading)
              || Number(mission.lastHeading || 0);
            incidentResult = await publishLiveGpsPosition({
              boatCode: mission.incidentBoatCode,
              lat: sceneLat,
              lng: sceneLng,
              heading: incHeading,
              speedKmh: 0,
              status: 'idle',
              sendToTarget: true,
              fromRescue: true,
            });
          }
          mission.lastHeading = heading;
        }
      } else {
        mission.lastHeading = heading;
      }
      const resultOk = rescueResult.ok && (!incidentResult || incidentResult.ok);

      mission.lastTickAt = nowMs;
      mission.updatedAt = new Date().toISOString();
      mission.lastSequence = rescueResult.sequence || null;
      mission.incidentBoatSequence = incidentResult?.sequence || mission.incidentBoatSequence || null;
      mission.lastPublishMode = rescueResult.mode || null;
      mission.lastError = resultOk
        ? null
        : (rescueResult.error || incidentResult?.error || 'Không gửi được GPS kéo tàu');

      // Luôn tiến vị trí mission trên map — Azure soft-fail không được đứng SOS.
      // Chỉ dừng cứng khi 401/403 (token/device inactive).
      const hardFail = !rescueResult.ok
        && (Number(rescueResult.status) === 401 || Number(rescueResult.status) === 403);
      if (hardFail) return;

      mission.currentLat = publishLat;
      mission.currentLng = publishLng;
      const stepMoved = distanceMeters(current, { lat: publishLat, lng: publishLng });
      mission.traveledMeters = Number(mission.traveledMeters || 0) + stepMoved;
      if (!arrived) {
        mission.status = mission.status === 'Towing' ? 'Towing' : 'InTransit';
        // InTransit: bám GPS live tàu sự cố nếu còn cập nhật (không chạy về sceneLat stale).
        if (mission.status === 'InTransit' && mission.incidentBoatCode) {
          const live = resolveIncidentTargetCoords({
            incidentBoatCode: mission.incidentBoatCode,
            sceneLat: mission.incidentLat,
            sceneLng: mission.incidentLng,
            fallbackLat: mission.targetLat,
            fallbackLng: mission.targetLng,
            from: { lat: publishLat, lng: publishLng },
          });
          if (
            (live.source === 'hub' || live.source === 'last')
            && Number.isFinite(live.lat)
            && Number.isFinite(live.lng)
          ) {
            const drift = distanceMeters(
              { lat: Number(mission.targetLat), lng: Number(mission.targetLng) },
              { lat: live.lat, lng: live.lng },
            );
            if (drift > 20) {
              mission.targetLat = live.lat;
              mission.targetLng = live.lng;
              mission.incidentLat = live.lat;
              mission.incidentLng = live.lng;
              // Đích đổi → làm lại path bo sông từ vị trí hiện tại.
              assignRescueRiverPath(
                mission,
                { lat: publishLat, lng: publishLng },
                { lat: live.lat, lng: live.lng },
              );
            }
          }
        }
      } else if (mission.status === 'Towing') {
        mission.status = 'AtStation';
        mission.stationArrivedAt = mission.updatedAt;
        // Snap lần cuối đúng tọa độ bến — không để SOS đứng giữa sông trên corridor.
        const finalBerthLat = Number(mission.targetLat);
        const finalBerthLng = Number(mission.targetLng);
        const berthGapMeters = Math.max(8, Number(env.TOW_BERTH_GAP_METERS || 12));
        const dockHeading = Number(mission.lastHeading || heading || 0);
        if (Number.isFinite(finalBerthLat) && Number.isFinite(finalBerthLng)) {
          mission.currentLat = finalBerthLat;
          mission.currentLng = finalBerthLng;
          await publishLiveGpsPosition({
            boatCode: mission.rescueBoatCode,
            lat: finalBerthLat,
            lng: finalBerthLng,
            heading: dockHeading,
            speedKmh: 0,
            status: 'idle',
            sendToTarget: true,
            fromRescue: true,
          });
          if (mission.incidentBoatCode) {
            const behind = pointBehind(
              { lat: finalBerthLat, lng: finalBerthLng },
              dockHeading,
              berthGapMeters,
            );
            mission.incidentCurrentLat = behind.lat;
            mission.incidentCurrentLng = behind.lng;
            await publishLiveGpsPosition({
              boatCode: mission.incidentBoatCode,
              lat: behind.lat,
              lng: behind.lng,
              heading: dockHeading,
              speedKmh: 0,
              status: 'idle',
              sendToTarget: true,
              fromRescue: true,
            });
          }
        }
        // Nhả SOS ngay khi cập bến — không giữ AtStation khóa tàu đến khi đóng sự cố.
        clearBeBoatStatus(mission.rescueBoatCode);
        const rescueBoat = boatByIdOrCode(mission.rescueBoatCode);
        if (rescueBoat && normalizeBoatStatus(rescueBoat.dbStatus) !== 'incident') {
          rescueBoat.beStatus = null;
        }
        const hubRescue = state.hubBoats.get(mission.rescueBoatCode);
        if (hubRescue) {
          hubRescue.boatStatus = rescueBoat?.dbStatus || 'Active';
          hubRescue.beStatus = null;
          if (Number.isFinite(mission.currentLat)) hubRescue.lat = mission.currentLat;
          if (Number.isFinite(mission.currentLng)) hubRescue.lng = mission.currentLng;
          hubRescue.updatedAt = new Date().toISOString();
        }
        console.log(
          `[rescue-gps] đã về ${mission.destinationStationCode || 'bến'} `
          + `@ ${Number(mission.currentLat).toFixed(5)},${Number(mission.currentLng).toFixed(5)} — `
          + `nhả ${mission.rescueBoatCode}, ${mission.incidentBoatCode} → Bảo trì (local); callback BE`,
        );
        if (mission.incidentBoatCode) {
          applyBeBoatStatus({
            boatCode: mission.incidentBoatCode,
            status: 'UnderMaintenance',
            source: 'rescue-at-station',
          });
          const incidentBoat = boatByIdOrCode(mission.incidentBoatCode);
          if (incidentBoat) {
            incidentBoat.dbStatus = 'UnderMaintenance';
            incidentBoat.beStatus = 'UnderMaintenance';
          }
          const hubInc = state.hubBoats.get(mission.incidentBoatCode);
          if (hubInc) {
            hubInc.boatStatus = 'UnderMaintenance';
            hubInc.beStatus = 'UnderMaintenance';
            if (Number.isFinite(mission.incidentCurrentLat)) hubInc.lat = mission.incidentCurrentLat;
            if (Number.isFinite(mission.incidentCurrentLng)) hubInc.lng = mission.incidentCurrentLng;
            hubInc.updatedAt = new Date().toISOString();
          }
        }
        // Contract: GPS → BE rescue-mission-completed (BE set Resolved + UnderMaintenance + SOS Active).
        await notifyBeRescueMissionCompleted(mission);
        // Luôn Completed local để nhả SOS khỏi khóa cứu hộ (kể cả callback BE lỗi).
        completeRescueMission(mission.incidentId, 'ArrivedAtStation');
        broadcast();
      } else {
        mission.arrivedAt = mission.updatedAt;
        // Luôn kéo về bến gần nhất — sát bến thì kéo vào đúng bến đó (không đẩy sang bến khác).
        const towDest = nearestStationTo({
          lat: Number(mission.incidentCurrentLat ?? mission.incidentLat ?? lat),
          lng: Number(mission.incidentCurrentLng ?? mission.incidentLng ?? lng),
        });
        if (towDest) {
          mission.status = 'Towing';
          mission.targetLat = towDest.lat;
          mission.targetLng = towDest.lng;
          mission.destinationStationId = towDest.station.stationId || null;
          mission.destinationStationCode = towDest.station.stationCode || null;
          mission.destinationStationName = towDest.station.stationName || null;
          mission.destinationDistanceMeters = Math.round(towDest.meters);
          mission.towingStartedAt = mission.updatedAt;

          if (towDest.meters <= arrivalMeters) {
            // Đã sát bến → kéo vào đúng bến, tick sau cập bến / nhả SOS.
            mission.currentLat = towDest.lat;
            mission.currentLng = towDest.lng;
            if (mission.incidentBoatCode) {
              mission.incidentCurrentLat = towDest.lat;
              mission.incidentCurrentLng = towDest.lng;
            }
            assignRescueRiverPath(
              mission,
              { lat: towDest.lat, lng: towDest.lng },
              { lat: towDest.lat, lng: towDest.lng },
            );
            mission.pathProgressMeters = mission.pathLengthMeters || 0;
            console.log(
              `[rescue-gps] sát ${towDest.station?.stationCode || 'bến'} `
              + `(${Math.round(towDest.meters)}m) → kéo vào bến luôn`,
            );
          } else {
            assignRescueRiverPath(
              mission,
              { lat, lng },
              { lat: towDest.lat, lng: towDest.lng },
            );
            // Ngay khi bắt đầu kéo: đặt tàu lỗi nối đuôi tàu cứu (không chờ tick sau).
            const towHeading = bearingDegrees(
              { lat: mission.currentLat, lng: mission.currentLng },
              { lat: towDest.lat, lng: towDest.lng },
            ) || heading;
            const towRopeMeters = Math.max(12, Number(env.TOW_ROPE_METERS || 18));
            const behind = pointBehind(
              { lat: mission.currentLat, lng: mission.currentLng },
              towHeading,
              towRopeMeters,
            );
            mission.incidentCurrentLat = behind.lat;
            mission.incidentCurrentLng = behind.lng;
            if (mission.incidentBoatCode) {
              const towStart = await publishLiveGpsPosition({
                boatCode: mission.incidentBoatCode,
                lat: behind.lat,
                lng: behind.lng,
                heading: towHeading,
                speedKmh: mission.speedKmh,
                status: 'moving',
                sendToTarget: true,
                fromRescue: true,
              });
              if (towStart.ok) mission.incidentBoatSequence = towStart.sequence || null;
            }
            console.log(
              `[rescue-gps] ${mission.rescueBoatCode} kéo ${mission.incidentBoatCode} → `
              + `${mission.destinationStationCode || mission.destinationStationName || 'bến gần nhất'} `
              + `(${Math.round(towDest.meters)}m)`,
            );
          }
        } else {
          mission.status = 'Arrived';
          mission.lastError = 'Không tìm thấy bến để kéo tàu về';
        }
      }

      const open = state.openIncidents.get(mission.incidentId);
      if (open) {
        open.missionStatus = mission.status;
        open.updatedAt = mission.updatedAt;
      }
      broadcast();
    } finally {
      mission.publishing = false;
    }
  }));
}

/**
 * Nhận lệnh sự cố/cứu hộ từ BE (nguồn sự thật). Không JWT Azure.
 * Production: chỉ BE gọi — FE không giữ secret, không gọi hook.
 * POST /api/incidents/hook + header X-Live-Hook-Secret.
 *
 * Body mẫu:
 * { "event": "IncidentCreated", "boatCode": "WB_002", "lat": 10.77, "lng": 106.70 }
 * { "event": "RescueDispatched", "incidentId": "...", "boatCode": "WB_001", "rescueBoatCode": "SOS_001", "replacementBoatCode": "WB_002", "lat": 10.77, "lng": 106.70 }
 * { "event": "IncidentResolved", "incidentId": "..." }
 *
 * RescueDispatched: kéo rescueBoatCode (SOS) tới lat/lng; replacementBoatCode optional (tàu thay khách).
 */
function ingestIncidentHook(body = {}, req = null) {
  const expected = String(state.liveHookSecret || env.LIVE_HOOK_SECRET || '').trim();
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error: 'Chưa cấu hình LIVE_HOOK_SECRET — đặt secret trong .env rồi restart',
    };
  }
  const provided = String(
    req?.headers?.['x-live-hook-secret']
    || body.secret
    || body.hookSecret
    || '',
  ).trim();
  if (provided !== expected) {
    return { ok: false, status: 401, error: 'Hook secret sai — gửi header X-Live-Hook-Secret' };
  }

  const event = String(body.event || body.type || body.action || 'IncidentUpdated').trim();
  const eventLower = event.toLowerCase();
  const incomingIncidentId = String(body.incidentId || body.id || '').trim();
  const isResolveEvent = eventLower.includes('resolve')
    || eventLower.includes('closed')
    || eventLower === 'incidentresolved';
  if (incomingIncidentId && !isResolveEvent && state.resolvedIncidentIds.has(incomingIncidentId)) {
    return {
      ok: true,
      duplicate: true,
      ignored: true,
      event,
      incidentId: incomingIncidentId,
      reason: 'Incident đã kết thúc',
    };
  }

  // Cập nhật status tàu trực tiếp (Active / UnderMaintenance) — không cần JWT.
  if (
    eventLower.includes('boatstatus')
    || eventLower === 'statusupdated'
    || (body.status && !body.incidentType && !eventLower.includes('incident') && !eventLower.includes('rescue'))
  ) {
    const boat = boatByIdOrCode(body.boatId || body.boatCode);
    const status = canonicalBoatStatus(body.status || body.boatStatus);
    if (!boat && !(body.boatCode || body.boatId)) {
      return { ok: false, status: 400, error: 'Thiếu boatCode / boatId' };
    }
    if (!status) {
      return { ok: false, status: 400, error: 'status phải là Active | Incident | UnderMaintenance | Inactive | Retired' };
    }
    if (boat) {
      boat.dbStatus = status;
      if (status === 'Active') {
        // Active lại → đóng sự cố hook/local của tàu này.
        for (const [id, row] of [...state.openIncidents.entries()]) {
          if (String(row.boatCode || '') === String(boat.boatCode)) {
            state.openIncidents.delete(id);
          }
        }
        clearBeBoatStatus(boat);
      } else if (status === 'Incident' || status === 'UnderMaintenance') {
        applyBeBoatStatus({
          boatId: boat.boatId,
          boatCode: boat.boatCode,
          status,
          source: 'hook:BoatStatusUpdated',
        });
      } else {
        clearBeBoatStatus(boat);
        state.boats.delete(boat.boatId);
        if (boat.boatCode) state.hubBoats.delete(boat.boatCode);
      }
    }
    syncStatusesWithNeon();
    broadcast();
    return {
      ok: true,
      event: 'BoatStatusUpdated',
      boatCode: boat?.boatCode || body.boatCode,
      status,
      effectiveStatus: boat ? effectiveBoatStatus(boat) : status,
    };
  }

  if (
    isResolveEvent
  ) {
    const id = String(body.incidentId || body.id || '').trim();
    if (!id) return { ok: false, status: 400, error: 'Thiếu incidentId để đóng' };
    const existing = state.openIncidents.get(id);
    state.openIncidents.delete(id);
    state.resolvedIncidentIds.set(id, Date.now());
    completeRescueMission(id);
    applyBeBoatStatus({
      boatId: existing?.boatId || body.boatId,
      boatCode: existing?.boatCode || body.boatCode,
      status: canonicalBoatStatus(body.boatStatus) || 'Active',
      source: 'hook:resolve',
    });
    broadcast();
    return {
      ok: true,
      event: 'IncidentResolved',
      incidentId: id,
      boatCode: existing?.boatCode || body.boatCode || null,
      openCount: state.openIncidents.size,
    };
  }

  const boat = boatByIdOrCode(body.boatId || body.boatCode);
  const rescueBoatCode = pickRescueBoatCode(body);
  const replacementBoatCode = pickReplacementBoatCode(body) || null;
  const rescue = boatByIdOrCode(rescueBoatCode || replacementBoatCode);
  const incidentId = String(
    body.incidentId || body.id || randomUUID(),
  ).trim();

  const lat = Number(body.lat ?? body.latitude ?? body.location?.lat);
  const lng = Number(body.lng ?? body.longitude ?? body.location?.lng);

  const incident = {
    incidentId,
    boatId: body.boatId || boat?.boatId || null,
    boatCode: body.boatCode || boat?.boatCode || null,
    boatName: body.boatName || boat?.boatName || null,
    tripId: body.tripId || boat?.tripId || null,
    incidentType: body.incidentType || 'OperationalIssue',
    severity: body.severity || 'High',
    description: body.description || `Hook ${event}`,
    resolutionStatus: 'Open',
    rescueBoatCode: rescueBoatCode || replacementBoatCode || rescue?.boatCode || null,
    replacementBoatId: body.replacementBoatId || null,
    replacementBoatCode: replacementBoatCode && replacementBoatCode !== rescueBoatCode
      ? replacementBoatCode
      : (replacementBoatCode || null),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    occurredAt: body.occurredAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'hook',
    raw: body,
  };

  if (!incident.boatCode && !incident.boatId) {
    return { ok: false, status: 400, error: 'Thiếu boatCode / boatId' };
  }

  // Đảm bảo tàu vẫn trong catalog để Live KHÔNG ẩn khi FE báo sự cố (DB = Incident).
  let liveBoat = boat || boatByIdOrCode(incident.boatCode || incident.boatId);
  if (!liveBoat && incident.boatCode) {
    const id = incident.boatId || randomUUID();
    liveBoat = {
      boatId: id,
      boatCode: incident.boatCode,
      boatName: incident.boatName || incident.boatCode,
      dbStatus: 'Incident',
      beStatus: 'Incident',
      numberOfDecks: 1,
      maxSpeedKmh: Number(env.DEFAULT_SPEED_KMH || 16),
      lat: Number.isFinite(lat) ? lat : 10.776,
      lng: Number.isFinite(lng) ? lng : 106.705,
      heading: 0,
      speedKmh: 0,
      status: 'idle',
      paused: true,
      updatedAt: new Date().toISOString(),
    };
    state.boats.set(id, liveBoat);
    incident.boatId = id;
  } else if (liveBoat) {
    liveBoat.dbStatus = 'Incident';
    liveBoat.beStatus = 'Incident';
  }

  upsertIncidentRecord(incident);
  applyBeBoatStatus({
    boatId: incident.boatId,
    boatCode: incident.boatCode,
    status: 'Incident',
    source: 'hook',
  });
  applyBoatStatusesFromBePayload(incident, event);

  // Bổ sung tọa độ từ hub nếu hook không gửi lat/lng.
  if ((incident.lat == null || incident.lng == null) && incident.boatCode) {
    const hub = state.hubBoats.get(incident.boatCode);
    if (hub && Number.isFinite(Number(hub.lat)) && Number.isFinite(Number(hub.lng))) {
      incident.lat = Number(hub.lat);
      incident.lng = Number(hub.lng);
      upsertIncidentRecord(incident);
    }
  }

  // Giữ marker hub nếu đang có — không prune vì sự cố.
  if (incident.boatCode && Number.isFinite(incident.lat) && Number.isFinite(incident.lng)) {
    const prev = state.hubBoats.get(incident.boatCode);
    state.hubBoats.set(incident.boatCode, {
      ...(prev || {}),
      boatCode: incident.boatCode,
      boatName: incident.boatName || prev?.boatName || null,
      boatId: incident.boatId || prev?.boatId || null,
      lat: incident.lat,
      lng: incident.lng,
      speedKmh: 0,
      heading: prev?.heading ?? 0,
      isOnline: true,
      boatStatus: 'Incident',
      beStatus: 'Incident',
      updatedAt: new Date().toISOString(),
    });
    // Gửi GPS tàu sự cố lên Azure ngay khi có tọa độ (không chỉ hiện SC trên FE).
    publishLiveGpsPosition({
      boatCode: incident.boatCode,
      lat: incident.lat,
      lng: incident.lng,
      heading: prev?.heading ?? 0,
      speedKmh: 0,
      status: 'idle',
      sendToTarget: true,
      fromRescue: true,
    }).catch((error) => {
      console.warn(`[hook] publish incident GPS failed: ${error.message}`);
    });
  }

  const isRescueDispatch = eventLower.includes('rescue')
    || eventLower.includes('dispatch')
    || eventLower.includes('replacement');
  // Điều tàu lại trên cùng incident đã resolve trước đó → cho phép mở lại.
  if (isRescueDispatch && incomingIncidentId) {
    state.resolvedIncidentIds.delete(incomingIncidentId);
  }
  const rescueAutomation = isRescueDispatch
    ? startRescueAutomation(incident)
    : null;
  if (isRescueDispatch) {
    console.log(
      `[hook] RescueDispatched boat=${incident.boatCode} rescue=${incident.rescueBoatCode}`
      + ` started=${Boolean(rescueAutomation?.started)}`
      + ` duplicate=${Boolean(rescueAutomation?.duplicate)}`
      + ` err=${rescueAutomation?.error || '-'}`,
    );
  }
  broadcast();
  return {
    ok: true,
    event,
    incident,
    rescueAutomation,
    boatStatus: 'Incident',
    openCount: state.openIncidents.size,
  };
}

function upsertIncidentFromHub(payload, eventName) {
  const rows = extractIncidentRows(payload);
  if (!rows.length && payload && typeof payload === 'object') rows.push(payload);
  for (const row of rows) {
    const incident = normalizeIncident(row, `hub:${eventName}`);
    if (incident) {
      upsertIncidentRecord(incident);
      applyBoatStatusesFromBePayload(incident, eventName);
    }
  }
}

async function refreshOpenIncidents({ force = false } = {}) {
  if (!getTargetApiRoot()) {
    return { ok: false, status: 400, error: 'Chưa cấu hình Azure endpoint' };
  }
  if (!state.targetBearerToken) {
    return {
      ok: false,
      status: 401,
      error: 'Thiếu TARGET_BEARER_TOKEN (JWT Staff/Admin) cho /api/incidents',
    };
  }
  const result = await requestTargetApi({
    method: 'GET',
    pathname: '/api/incidents?resolutionStatus=Open',
    auth: 'bearer',
    silent: !force,
  });
  if (!result.ok) return result;

  const next = new Map();
  for (const row of extractIncidentRows(result.data)) {
    const incident = normalizeIncident(row, 'api');
    if (!incident) continue;
    const prev = state.openIncidents.get(incident.incidentId);
    if (prev) {
      incident.lat = incident.lat ?? prev.lat ?? null;
      incident.lng = incident.lng ?? prev.lng ?? null;
      incident.boatCode = incident.boatCode || prev.boatCode || null;
      incident.replacementBoatCode = incident.replacementBoatCode || prev.replacementBoatCode || null;
      incident.rescueBoatCode = incident.rescueBoatCode || prev.rescueBoatCode || null;
    }
    if ((incident.lat == null || incident.lng == null) && incident.boatCode) {
      const hub = state.hubBoats.get(incident.boatCode);
      if (hub && Number.isFinite(Number(hub.lat)) && Number.isFinite(Number(hub.lng))) {
        incident.lat = Number(hub.lat);
        incident.lng = Number(hub.lng);
      }
    }
    next.set(incident.incidentId, incident);
  }

  for (const [id, row] of state.openIncidents) {
    if (row.source === 'local' && !next.has(id)) next.set(id, row);
  }

  state.openIncidents = next;
  for (const incident of next.values()) {
    applyBeBoatStatus({
      boatId: incident.boatId,
      boatCode: incident.boatCode,
      status: 'Incident',
      source: 'incidents:open',
    });
  }
  broadcast();
  return { ok: true, status: 200, count: next.size, data: [...next.values()] };
}

async function listIncidents({ resolutionStatus = 'Open' } = {}) {
  if (String(resolutionStatus).toLowerCase() === 'open') {
    const refreshed = await refreshOpenIncidents({ force: true });
    if (refreshed.ok) {
      return {
        ok: true,
        status: 200,
        incidents: [...state.openIncidents.values()],
        source: 'azure',
      };
    }
    return {
      ok: state.openIncidents.size > 0,
      status: refreshed.status,
      error: refreshed.error,
      incidents: [...state.openIncidents.values()],
      source: 'cache',
    };
  }

  const qs = new URLSearchParams({ resolutionStatus: String(resolutionStatus) }).toString();
  const result = await requestTargetApi({
    method: 'GET',
    pathname: `/api/incidents?${qs}`,
    auth: 'bearer',
  });
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: result.error,
      incidents: [],
    };
  }
  const incidents = extractIncidentRows(result.data)
    .map((row) => normalizeIncident(row, 'api'))
    .filter(Boolean);
  return { ok: true, status: 200, incidents, source: 'azure' };
}

async function createIncident(body = {}) {
  const boat = boatByIdOrCode(body.boatId || body.boatCode);
  const boatId = body.boatId || boat?.boatId;
  if (!boatId) {
    return { ok: false, status: 400, error: 'Thiếu boatId / boatCode hợp lệ' };
  }

  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const payload = {
    boatId,
    tripId: body.tripId || boat?.tripId || null,
    incidentType: body.incidentType || 'OperationalIssue',
    severity: body.severity || 'High',
    description: body.description
      || `Sự cố báo từ Live GPS${Number.isFinite(lat) && Number.isFinite(lng) ? ` @ ${lat.toFixed(5)},${lng.toFixed(5)}` : ''}`,
    occurredAt: body.occurredAt || new Date().toISOString(),
  };

  let azure = { ok: false, status: 401, error: 'Chưa gọi Azure' };
  if (state.targetBearerToken) {
    azure = await requestTargetApi({
      method: 'POST',
      pathname: '/api/incidents',
      payload,
      auth: 'bearer',
    });
  } else {
    azure = {
      ok: false,
      status: 401,
      error: 'Thiếu TARGET_BEARER_TOKEN — tạo sự cố local để demo',
    };
  }

  let incident = null;
  if (azure.ok) {
    incident = normalizeIncident(azure.data, 'api')
      || normalizeIncident({ ...payload, incidentId: azure.data?.incidentId || azure.data?.id }, 'api');
  }

  if (!incident) {
    incident = {
      incidentId: randomUUID(),
      boatId,
      boatCode: boat?.boatCode || body.boatCode || null,
      boatName: boat?.boatName || null,
      tripId: payload.tripId,
      incidentType: payload.incidentType,
      severity: payload.severity,
      description: payload.description,
      resolutionStatus: 'Open',
      replacementBoatId: null,
      replacementBoatCode: null,
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      occurredAt: payload.occurredAt,
      updatedAt: new Date().toISOString(),
      source: 'local',
      raw: payload,
    };
  } else {
    incident.boatCode = incident.boatCode || boat?.boatCode || body.boatCode || null;
    incident.boatName = incident.boatName || boat?.boatName || null;
    if (Number.isFinite(lat)) incident.lat = lat;
    if (Number.isFinite(lng)) incident.lng = lng;
    if (!state.targetBearerToken || !azure.ok) incident.source = 'local';
  }

  upsertIncidentRecord(incident);
  applyBeBoatStatus({
    boatId: incident.boatId,
    boatCode: incident.boatCode,
    status: 'Incident',
    source: azure.ok ? 'azure:createIncident' : 'local:createIncident',
  });
  if (boat) {
    // Mirror status DB FE dùng (Incident), không ẩn tàu.
    boat.dbStatus = 'Incident';
    boat.beStatus = 'Incident';
  }
  broadcast();
  return {
    ok: true,
    status: 200,
    azureOk: Boolean(azure.ok),
    azureStatus: azure.status,
    azureError: azure.ok ? null : azure.error,
    incident,
    boatStatus: 'Incident',
    warning: azure.ok ? null : (azure.error || 'Đã lưu sự cố local (Azure chưa nhận)'),
  };
}

async function assignReplacementBoat(incidentId, body = {}) {
  const id = String(incidentId || '').trim();
  if (!id) return { ok: false, status: 400, error: 'Thiếu incidentId' };

  const rescueBoatCode = pickRescueBoatCode(body)
    || String(body.replacementBoatCode || body.boatCode || '').trim();
  const replacementBoatCode = pickReplacementBoatCode(body) || null;
  const rescue = boatByIdOrCode(body.replacementBoatId || rescueBoatCode);
  const replacementBoatId = body.replacementBoatId || rescue?.boatId;
  if (!rescueBoatCode && !replacementBoatId) {
    return { ok: false, status: 400, error: 'Thiếu rescueBoatCode / replacementBoatCode' };
  }

  const payload = {
    replacementBoatId: replacementBoatId || undefined,
    rescueBoatCode: rescueBoatCode || undefined,
    delayMinutes: body.delayMinutes == null ? null : Number(body.delayMinutes),
    note: body.note || `Điều tàu ${rescueBoatCode || replacementBoatId} cứu hộ từ Live GPS`,
  };

  let azure = { ok: false, status: 401, error: 'Thiếu TARGET_BEARER_TOKEN' };
  if (state.targetBearerToken) {
    azure = await requestTargetApi({
      method: 'PATCH',
      pathname: `/api/incidents/${encodeURIComponent(id)}/assign-replacement-boat`,
      payload,
      auth: 'bearer',
    });
  }

  const existing = state.openIncidents.get(id) || { incidentId: id, resolutionStatus: 'Open' };
  const next = {
    ...existing,
    replacementBoatId: replacementBoatId || existing.replacementBoatId || null,
    rescueBoatCode: rescueBoatCode || rescue?.boatCode || existing.rescueBoatCode || null,
    replacementBoatCode: replacementBoatCode && replacementBoatCode !== rescueBoatCode
      ? replacementBoatCode
      : (existing.replacementBoatCode || null),
    updatedAt: new Date().toISOString(),
    source: azure.ok ? 'api' : (existing.source || 'local'),
  };
  if (azure.ok) {
    const fromAzure = normalizeIncident(azure.data, 'api');
    if (fromAzure) {
      Object.assign(next, fromAzure, {
        rescueBoatCode: fromAzure.rescueBoatCode || next.rescueBoatCode,
        replacementBoatCode: fromAzure.replacementBoatCode || next.replacementBoatCode,
        lat: fromAzure.lat ?? next.lat,
        lng: fromAzure.lng ?? next.lng,
      });
    }
  }
  upsertIncidentRecord(next);
  const rescueAutomation = startRescueAutomation(next);
  broadcast();

  return {
    ok: true,
    azureOk: Boolean(azure.ok),
    azureStatus: azure.status,
    azureError: azure.ok ? null : azure.error,
    incident: next,
    rescueAutomation,
    warning: azure.ok
      ? null
      : (azure.error || 'Đã gán tàu cứu local (Azure chưa nhận — cần tripId trên incident)'),
  };
}

async function resolveIncident(incidentId, body = {}) {
  const id = String(incidentId || '').trim();
  if (!id) return { ok: false, status: 400, error: 'Thiếu incidentId' };

  const payload = {
    resolutionNote: body.resolutionNote || 'Tàu đã được kéo về bến và chuyển sang bảo trì.',
    boatStatus: body.boatStatus || 'UnderMaintenance',
    tripStatus: Object.prototype.hasOwnProperty.call(body, 'tripStatus')
      ? body.tripStatus
      : null,
  };

  let azure = { ok: false, status: 401, error: 'Thiếu TARGET_BEARER_TOKEN' };
  if (state.targetBearerToken) {
    azure = await requestTargetApi({
      method: 'PATCH',
      pathname: `/api/incidents/${encodeURIComponent(id)}/resolve`,
      payload,
      auth: 'bearer',
    });
  }

  const existing = state.openIncidents.get(id);
  state.openIncidents.delete(id);
  state.resolvedIncidentIds.set(id, Date.now());
  completeRescueMission(id);
  const nextStatus = canonicalBoatStatus(
    azure.data?.boatStatus || azure.data?.BoatStatus || payload.boatStatus,
  ) || 'UnderMaintenance';
  applyBeBoatStatus({
    boatId: existing?.boatId,
    boatCode: existing?.boatCode,
    status: nextStatus,
    source: azure.ok ? 'azure:resolve' : 'local:resolve',
  });
  applyBoatStatusesFromBePayload(azure.data || {}, 'resolveIncident');
  broadcast();

  return {
    ok: true,
    azureOk: Boolean(azure.ok),
    azureStatus: azure.status,
    azureError: azure.ok ? null : azure.error,
    incidentId: id,
    boatCode: existing?.boatCode || null,
    boatStatus: nextStatus,
    warning: azure.ok ? null : (azure.error || 'Đã đóng sự cố local'),
  };
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
  const averageSpeedKmh = resolveSurveySpeedKmh(body, session, boatCode);
  // BE thường giới hạn tốc độ — không gửi quá AZURE_MAX_SPEED_KMH.
  const azureMaxSpeed = Math.max(1, Number(env.AZURE_MAX_SPEED_KMH || 80));
  const azureSpeedKmh = Math.min(averageSpeedKmh, azureMaxSpeed);
  const coordinates = resolveSurveyPathCoordinates(session, body, averageSpeedKmh);
  const uniqueCoordKeys = new Set(
    coordinates.map((p) => `${Number(p.lat).toFixed(6)},${Number(p.lng).toFixed(6)}`),
  );
  if (coordinates.length < 2 || uniqueCoordKeys.size < 2) {
    return {
      ok: false,
      status: 400,
      error: 'Can it nhat 2 diem GPS khac nhau de tao route_geometry.',
    };
  }

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
    // Phút đoạn = km ÷ tốc độ user cài (không dùng DEFAULT 16).
    const stopsExact = attachSegmentTravelMinutes(snapped, stops, averageSpeedKmh).map((stop) => ({
      stationId: stop.stationId,
      stationCode: stop.stationCode || null,
      stationName: stop.stationName || null,
      stopOrder: Number(stop.stopOrder) || null,
      lat: Number.isFinite(Number(stop.lat)) ? Number(stop.lat) : null,
      lng: Number.isFinite(Number(stop.lng)) ? Number(stop.lng) : null,
      isPickupAllowed: stop.isPickupAllowed !== false,
      isDropoffAllowed: stop.isDropoffAllowed !== false,
      standardTravelMin: exactDurationMinutes(stop.standardTravelMin),
      segmentDistanceKm: stop.segmentDistanceKm == null ? null : Number(stop.segmentDistanceKm),
      travelSource: stop.travelSource || 'gps',
    }));
    // Gửi BE: standardTravelMin / estimatedDurationMin là int ≥ 1 (tránh 400).
    // UI vẫn giữ bản thập phân đúng panel (vd 0.28) qua outboundStops.
    const preferExactTravel = parseBool(env.AZURE_EXACT_TRAVEL_MIN ?? 'false');
    const stopsForAzure = stopsExact.map((stop) => ({
      stationId: stop.stationId,
      stationCode: stop.stationCode,
      stationName: stop.stationName,
      stopOrder: stop.stopOrder,
      lat: stop.lat,
      lng: stop.lng,
      isPickupAllowed: stop.isPickupAllowed,
      isDropoffAllowed: stop.isDropoffAllowed,
      standardTravelMin: preferExactTravel
        ? stop.standardTravelMin
        : azureTravelMinutes(stop.standardTravelMin),
      ...(stop.segmentDistanceKm != null ? { segmentDistanceKm: stop.segmentDistanceKm } : {}),
    }));
    payload.stops = stopsForAzure;
    payload.coordinates = snapped.map((point, index) => ({
      lat: round(Number(point.lat), 7),
      lng: round(Number(point.lng), 7),
      speedKmh: azureSpeedKmh,
      sequence: index + 1,
      recordedAt: point.recordedAt || coordinates[Math.min(index, coordinates.length - 1)]?.recordedAt || formatRecordedAt(new Date()),
    }));
    // Ưu tiên đúng số panel lúc vẽ — UI giữ thập phân; BE nhận int ≥ 1.
    const pathKm = routeLength(snapped) / 1000;
    const lockedMin = exactDurationMinutes(
      body.estimatedDurationMin ?? session?.estimatedDurationMin,
    );
    const pathMinutesExact = lockedMin
      ?? exactDurationMinutes((pathKm / averageSpeedKmh) * 60);
    payload.estimatedDurationMin = preferExactTravel
      ? pathMinutesExact
      : Math.max(1, Math.round(Number(pathMinutesExact) || 1));
    console.log(
      `[from-gps] ${payload.routeCode} speed=${averageSpeedKmh} azureSpeed=${azureSpeedKmh} durationExact=${pathMinutesExact} durationAzure=${payload.estimatedDurationMin} pathKm=${round(pathKm, 3)} segments:`,
      stopsExact.map((s) => `#${s.stopOrder} ${s.stationCode || s.stationName || s.stationId}=${s.standardTravelMin ?? '-'}p/${s.segmentDistanceKm ?? '-'}km`).join(' | '),
    );
    // UI giữ bản thập phân đúng (vd 0.28).
    stops = stopsExact;
  } else {
    const pathKm = routeLength(coordinates) / 1000;
    const lockedMin = exactDurationMinutes(
      body.estimatedDurationMin ?? session?.estimatedDurationMin,
    );
    const pathMinutesExact = lockedMin
      ?? exactDurationMinutes((pathKm / averageSpeedKmh) * 60);
    const preferExactTravel = parseBool(env.AZURE_EXACT_TRAVEL_MIN ?? 'false');
    payload.estimatedDurationMin = preferExactTravel
      ? pathMinutesExact
      : Math.max(1, Math.round(Number(pathMinutesExact) || 1));
  }

  const targetResult = await postToTargetApi(
    '/api/routes/from-gps',
    payload,
    session.deviceId || deviceIdForBoat({ boatCode: session.boatCode }),
  );
  // Giữ stops/phút thập phân đúng panel cho UI — kể cả khi BE nhận bản int.
  if (targetResult && typeof targetResult === 'object') {
    targetResult.outboundStops = stops;
    const uiDuration = exactDurationMinutes(
      body.estimatedDurationMin ?? session?.estimatedDurationMin ?? payload.estimatedDurationMin,
    );
    targetResult.outboundEstimatedDurationMin = uiDuration ?? payload.estimatedDurationMin ?? null;
    targetResult.outboundCreateReverse = Boolean(payload.createReverseRoute);
    targetResult.outboundAverageSpeedKmh = averageSpeedKmh;
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
      // BE đôi khi không trả / không giữ phút từng đoạn — ưu tiên bản GPS đã tính (outbound).
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
            const travel = out?.standardTravelMin ?? stop.standardTravelMin ?? stop.standard_travel_min;
            return {
              ...stop,
              standardTravelMin: travel == null || travel === '' ? null : Number(travel),
              segmentDistanceKm: out?.segmentDistanceKm ?? stop.segmentDistanceKm ?? null,
              travelSource: out?.travelSource || stop.travelSource || null,
            };
          });
        }
      }
      const outboundMin = exactDurationMinutes(targetSave.outboundEstimatedDurationMin);
      if (outboundMin != null) {
        route.estimatedDurationMin = outboundMin;
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
      route = await saveRecordedRoute({
        ...body,
        estimatedDurationMin: body.estimatedDurationMin
          ?? targetSave.outboundEstimatedDurationMin
          ?? session?.estimatedDurationMin,
        averageSpeedKmh: body.averageSpeedKmh
          ?? targetSave.outboundAverageSpeedKmh
          ?? session?.averageSpeedKmh
          ?? session?.speedKmh,
      });
      await refreshFromDatabase();
      const lockedMin = exactDurationMinutes(
        body.estimatedDurationMin
        ?? targetSave.outboundEstimatedDurationMin
        ?? session?.estimatedDurationMin,
      );
      if (lockedMin != null) route.estimatedDurationMin = lockedMin;
      if (Array.isArray(targetSave.outboundStops) && targetSave.outboundStops.length) {
        route.stops = targetSave.outboundStops;
      }
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
      forceAccept: true,
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
    averageSpeedKmh: stopped.cruiseSpeedKmh || stopped.speedKmh || null,
    estimatedDurationMin: stopped.estimatedDurationMin ?? null,
    cruiseSpeedKmh: stopped.cruiseSpeedKmh || null,
    speedKmh: stopped.cruiseSpeedKmh || stopped.speedKmh || null,
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
    forceAccept: true,
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
      averageSpeedKmh: stopped.cruiseSpeedKmh || stopped.speedKmh,
      cruiseSpeedKmh: stopped.cruiseSpeedKmh || null,
      estimatedDurationMin: stopped.estimatedDurationMin ?? null,
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
        plannedCoordinates: state.collector.coordinates,
        startStationId: state.collector.startStationId,
        endStationId: state.collector.endStationId,
        averageSpeedKmh: state.collector.cruiseSpeedKmh || state.collector.speedKmh,
        estimatedDurationMin: state.collector.estimatedDurationMin,
        cruiseSpeedKmh: state.collector.cruiseSpeedKmh,
        speedKmh: state.collector.cruiseSpeedKmh || state.collector.speedKmh,
      }
    : state.lastRecordingSession;
  if (!session?.recordedPoints?.length && !(session?.plannedCoordinates?.length >= 2)) {
    throw userError('Chua co diem GPS nao de luu. Hay bat dau ghi truoc.');
  }
  const speed = resolveSurveySpeedKmh(body, session, body.boatCode || session.boatCode);
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
    averageSpeedKmh: speed,
    estimatedDurationMin: body.estimatedDurationMin ?? session.estimatedDurationMin ?? null,
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
  const averageSpeedKmh = resolveSurveySpeedKmh(body, null, boatCode);
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
  // phút = (km / tốc_độ_chạy) × 60 · khớp panel lúc vẽ (vd 0.22) — không ép int ≥ 1.
  const baseDistanceKm = round(lengthMeters / 1000, 3);
  const stopsWithTravel = attachSegmentTravelMinutes(points, normalizedStops, averageSpeedKmh);
  const estimatedDurationExact = exactDurationMinutes(
    body.estimatedDurationMin != null && Number(body.estimatedDurationMin) > 0
      ? Number(body.estimatedDurationMin)
      : ((baseDistanceKm / averageSpeedKmh) * 60),
  ) || 0;
  // Cột DB estimated_duration_min là int — chỉ làm tròn khi ghi DB; API trả số thập phân đúng.
  const estimatedDurationMinDb = Math.max(1, Math.round(estimatedDurationExact || 1));
  const estimatedDurationMin = estimatedDurationExact || estimatedDurationMinDb;
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
    ${estimatedDurationMinDb}::int as estimated_duration_min,
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
  'estimatedDurationMin', ${estimatedDurationExact}::numeric,
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
  const boatMax = Number.isFinite(Number(maxSpeedKmh)) && Number(maxSpeedKmh) > 0
    ? Number(maxSpeedKmh)
    : 80;
  // Trip/live thực tế không vượt trần Azure — tránh 400 + tàu bay 140km/h.
  const azureMax = Math.max(1, Number(env.AZURE_MAX_SPEED_KMH || 80));
  const tripMax = Math.max(1, Number(env.TRIP_MAX_SPEED_KMH || azureMax));
  const max = Math.min(boatMax, tripMax, azureMax);
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
  const boatCodeEarly = cleanOptionalText(body.boatCode) || `SURVEY-${routeCode}`;
  if (tripAutorun.isBoatInActiveTripMission(boatCodeEarly)) {
    const err = new Error(`Tàu ${boatCodeEarly} đang chạy trip — không ghi GPS survey.`);
    err.status = 409;
    throw err;
  }
  // Survey luôn giữ đúng đường FE vẽ — không snap corridor (tránh tàu lệch đường vẽ).
  const coordinates = validateRoutePoints(body.coordinates);
  const lengthMeters = routeLength(coordinates);
  const start = pointAtDistance(coordinates, 0);
  const boatCode = boatCodeEarly;
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
  const estimatedDurationMin = exactDurationMinutes(
    body.estimatedDurationMin != null && Number(body.estimatedDurationMin) > 0
      ? Number(body.estimatedDurationMin)
      : ((lengthMeters / 1000 / speedKmh) * 60),
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
    cruiseSpeedKmh: speedKmh,
    maxSpeedKmh,
    estimatedDurationMin,
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
 * Gắn standardTravelMin = thời gian chạy GPS×tốc độ thôi:
 * phút = (km đường GPS ÷ tốc độ) × 60 (1 số thập phân). Không lấy lịch / BE.
 */
function attachSegmentTravelMinutes(coordinates, stops, speedKmh) {
  const path = Array.isArray(coordinates)
    ? coordinates.filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng)))
    : [];
  const list = Array.isArray(stops) ? stops.map((s) => ({ ...s })) : [];
  const speed = Number(speedKmh) > 0 ? Number(speedKmh) : 16;
  const nearM = Number(env.STOP_DETECT_RADIUS_M || 200);
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
    const minutes = Number(((km / speed) * 60).toFixed(2));
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
    boats: [...state.boats.values()].map((boat) => {
      const neonStatus = boat.dbStatus || null;
      const beStatus = beStatusForBoat(boat) || boat.beStatus || null;
      const effectiveStatus = beStatus || neonStatus;
      return {
        ...boat,
        neonStatus,
        beStatus,
        dbStatus: effectiveStatus,
        effectiveStatus,
        lat: round(boat.lat, 7),
        lng: round(boat.lng, 7),
        heading: round(boat.heading, 0),
        speedKmh: round(boat.speedKmh, 1),
      };
    }),
    hubBoats: [...state.hubBoats.values()]
      .filter((boat) => {
        const surveyCode = activeSurveyBoatCode();
        if (!surveyCode) return true;
        return String(boat.boatCode || '').trim() !== surveyCode;
      })
      .map((boat) => {
      const beStatus = beStatusForBoat(boat.boatCode) || boat.beStatus || boat.boatStatus || null;
      return {
        ...boat,
        beStatus,
        boatStatus: beStatus || boat.boatStatus || null,
        lat: round(boat.lat, 7),
        lng: round(boat.lng, 7),
        heading: boat.heading == null ? null : round(boat.heading, 0),
        speedKmh: boat.speedKmh == null ? null : round(boat.speedKmh, 1),
      };
    }),
    beBoatStatuses: [...state.beBoatStatuses.entries()]
      .filter(([key, row]) => row && key === row.boatCode)
      .map(([, row]) => row),
    openIncidents: [...state.openIncidents.values()].map((row) => ({
      incidentId: row.incidentId,
      boatId: row.boatId,
      boatCode: row.boatCode,
      boatName: row.boatName,
      tripId: row.tripId,
      incidentType: row.incidentType,
      severity: row.severity,
      description: row.description,
      resolutionStatus: row.resolutionStatus,
      replacementBoatId: row.replacementBoatId,
      replacementBoatCode: row.replacementBoatCode,
      rescueBoatCode: row.rescueBoatCode || null,
      missionStatus: row.missionStatus || null,
      lat: row.lat == null ? null : round(row.lat, 7),
      lng: row.lng == null ? null : round(row.lng, 7),
      occurredAt: row.occurredAt,
      updatedAt: row.updatedAt,
      source: row.source,
    })),
    rescueMissions: [...state.rescueMissions.values()].map(rescueMissionPublic),
    tripMissions: tripAutorun.tripMissionsPublic(),
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
    riverCorridor: getRescueRiverBasePath().map((p) => ({
      lat: round(p.lat, 7),
      lng: round(p.lng, 7),
    })),
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
    commit: buildInfo.commit,
    commitShort: buildInfo.commitShort,
    builtAt: buildInfo.builtAt,
    liveAzureWrite: liveAzureWriteEnabled(),
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
    incidentsHubStatus: {
      ...state.incidentsHubStatus,
    },
    hasBearerToken: Boolean(state.targetBearerToken),
    hasLiveHookSecret: Boolean(state.liveHookSecret || env.LIVE_HOOK_SECRET),
    incidentReceiveMode: (state.liveHookSecret || env.LIVE_HOOK_SECRET)
      ? 'hook'
      : (state.targetBearerToken ? 'jwt' : 'local'),
    openIncidentCount: state.openIncidents.size,
    tripAutorun: parseBool(env.TRIP_AUTORUN ?? 'true'),
    tripDuePollMs: Number(env.TRIP_DUE_POLL_MS || 30000),
    tripGpsIntervalMs: Number(env.TRIP_GPS_INTERVAL_MS || 1000),
    tripLookaheadMinutes: Number(env.TRIP_LOOKAHEAD_MINUTES || 120),
    activeTripCount: [...state.tripMissions.values()]
      .filter((m) => !['Completed'].includes(String(m.status || ''))).length,
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

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') {
    try { res.flushHeaders(); } catch { /* ignore */ }
  }
  res.write(': connected\n\n');
  clients.add(res);
  try {
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  } catch (error) {
    console.error(`[events] initial snapshot failed: ${error.message}`);
  }
  // Railway/proxy cắt SSE nếu lâu không có data — ping thường xuyên.
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      clearInterval(heartbeat);
      clients.delete(res);
    }
  }, 10000);
  const onClose = () => {
    clearInterval(heartbeat);
    clients.delete(res);
  };
  res.on('close', onClose);
  res.on('error', onClose);
  if (req && typeof req.on === 'function') {
    req.on('close', onClose);
    req.on('aborted', onClose);
  }
}

async function serveStatic(pathname, res) {
  let requested = pathname;
  if (pathname === '/' || pathname === '/live' || pathname === '/live/') {
    requested = '/live.html';
  } else if (pathname === '/survey' || pathname === '/survey/') {
    requested = '/index.html';
  }
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) return sendJson(res, { error: 'Forbidden' }, 403);
  try {
    const content = await readFile(filePath);
    const type = contentType(filePath);
    const headers = { 'Content-Type': type };
    // HTML luôn lấy bản mới; JS/CSS đã có ?v= cache-bust.
    if (filePath.endsWith('.html')) {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
      headers.Pragma = 'no-cache';
    } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      headers['Cache-Control'] = 'public, max-age=60, must-revalidate';
    }
    res.writeHead(200, headers);
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

/**
 * Local mặc định KHÔNG ghi GPS lên Azure — chỉ Railway ghi.
 * Tránh local + deploy đụng nhau → vị trí tàu khác nhau.
 * Bật tay: LIVE_AZURE_WRITE=true
 */
function liveAzureWriteEnabled() {
  if (env.LIVE_AZURE_WRITE != null && String(env.LIVE_AZURE_WRITE).trim() !== '') {
    return parseBool(env.LIVE_AZURE_WRITE);
  }
  return Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
}

/** Azure boats/latest + SignalR: nhận vị trí idle để local/prod cùng map. */
function shouldForceAcceptAzurePosition(payload) {
  const code = String(payload?.boatCode || payload?.BoatCode || '').trim();
  if (!code) return false;
  if (activeSurveyBoatCode() === code) return false;
  // Vừa kéo tay / trip / rescue — KHÔNG forceAccept Azure cũ (kể cả local follow-only).
  const liveAuthUntil = hubLiveAuthorityUntil.get(code) || 0;
  if (liveAuthUntil > Date.now()) return false;
  // Local follow-only: luôn nhận Azure (kể cả đang trip/rescue) để map/FE đồng bộ.
  if (!liveAzureWriteEnabled()) return true;
  // Railway đang tự chạy trip/rescue: bỏ echo Azure cũ, giữ authority tick.
  if (isBoatInActiveRescueMission(code)) return false;
  if (tripAutorun.isBoatInActiveTripMission(code)) return false;
  return true;
}

/**
 * Hub live/last-pos mới hơn Azure stale → giữ hub (F5 không nhảy về chỗ cũ).
 * Azure row thiếu/trễ lat sau POST locations là case đã gặp.
 */
function shouldKeepHubOverAzure(boatCode, azureRow = {}) {
  const code = String(boatCode || '').trim();
  const hub = state.hubBoats.get(code);
  if (!hub || !Number.isFinite(Number(hub.lat)) || !Number.isFinite(Number(hub.lng))) return false;

  const liveAuthUntil = hubLiveAuthorityUntil.get(code) || 0;
  if (liveAuthUntil > Date.now()) return true;

  const src = String(hub.source || '');
  const trusted = src === 'live'
    || src === 'last-position'
    || src.startsWith('trip')
    || src.startsWith('rescue')
    || src === 'live-heartbeat';
  if (!trusted) return false;

  const keepMs = Number(env.HUB_LIVE_KEEP_MS || 600_000); // 10 phút
  const hubAt = Date.parse(hub.updatedAt || hub.receivedAt || hub.recordedAt || '') || 0;
  if (!(hubAt > 0) || Date.now() - hubAt > keepMs) return false;

  const aLat = Number(azureRow.lat ?? azureRow.latitude ?? azureRow.Latitude);
  const aLng = Number(azureRow.lng ?? azureRow.lon ?? azureRow.longitude ?? azureRow.Longitude);
  if (!Number.isFinite(aLat) || !Number.isFinite(aLng)) return true;

  const dist = distanceMeters(
    { lat: Number(hub.lat), lng: Number(hub.lng) },
    { lat: aLat, lng: aLng },
  );
  return Number.isFinite(dist) && dist > 40;
}

/** Commit đang chạy — Railway set RAILWAY_GIT_COMMIT_SHA; local lấy từ git. */
function resolveBuildInfo(envVars, projectRoot) {
  const raw = String(
    envVars.RAILWAY_GIT_COMMIT_SHA
    || process.env.RAILWAY_GIT_COMMIT_SHA
    || envVars.GIT_COMMIT
    || process.env.GIT_COMMIT
    || '',
  ).trim();
  let commit = raw;
  if (!commit) {
    try {
      commit = execSync('git rev-parse HEAD', {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      commit = 'unknown';
    }
  }
  const commitShort = commit.length > 7 ? commit.slice(0, 7) : commit;
  return {
    commit,
    commitShort,
    builtAt: new Date().toISOString(),
  };
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

async function loadLastPositions() {
  try {
    const raw = JSON.parse(await readFile(lastPositionsPath, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function rememberLastPosition(boatCode, boat) {
  const code = String(boatCode || '').trim();
  const lat = Number(boat?.lat);
  const lng = Number(boat?.lng);
  if (!code || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  lastPositions[code] = {
    boatCode: code,
    boatName: boat.boatName || lastPositions[code]?.boatName || null,
    boatId: boat.boatId || lastPositions[code]?.boatId || null,
    lat,
    lng,
    heading: Number.isFinite(Number(boat.heading)) ? Number(boat.heading) : (lastPositions[code]?.heading ?? 0),
    speedKmh: Number.isFinite(Number(boat.speedKmh)) ? Number(boat.speedKmh) : 0,
    recordedAt: boat.recordedAt || null,
    receivedAt: boat.receivedAt || null,
    sequence: boat.sequence ?? null,
    updatedAt: boat.updatedAt || new Date().toISOString(),
  };
  scheduleLastPositionsSave();
}

/** Seed hub từ vị trí cuối đã ghi — tránh restart/SSE làm tàu nhảy về bến/seed. */
function restoreLastPositionsToHub() {
  let restored = 0;
  for (const [code, row] of Object.entries(lastPositions || {})) {
    const lat = Number(row?.lat);
    const lng = Number(row?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (!isLiveMapBoatCode(code) && !hasOpenIncidentForBoat(code)) continue;
    const prev = state.hubBoats.get(code);
    if (prev && Number.isFinite(Number(prev.lat)) && Number.isFinite(Number(prev.lng))) {
      // Đã có hub mới hơn file → giữ hub, cập nhật file.
      const prevAt = Date.parse(prev.updatedAt || prev.receivedAt || '') || 0;
      const savedAt = Date.parse(row.updatedAt || row.receivedAt || '') || 0;
      if (prevAt >= savedAt) {
        rememberLastPosition(code, prev);
        continue;
      }
    }
    state.hubBoats.set(code, {
      ...(prev || {}),
      boatCode: code,
      boatName: row.boatName || prev?.boatName || null,
      boatId: row.boatId || prev?.boatId || null,
      lat,
      lng,
      heading: Number.isFinite(Number(row.heading)) ? Number(row.heading) : (prev?.heading ?? 0),
      speedKmh: Number.isFinite(Number(row.speedKmh)) ? Number(row.speedKmh) : 0,
      recordedAt: row.recordedAt || null,
      receivedAt: row.receivedAt || null,
      sequence: row.sequence ?? null,
      isOnline: true,
      source: 'last-position',
      updatedAt: row.updatedAt || new Date().toISOString(),
    });
    const boat = boatByIdOrCode(code);
    if (boat) {
      boat.lat = lat;
      boat.lng = lng;
      if (Number.isFinite(Number(row.heading))) boat.heading = Number(row.heading);
    }
    restored += 1;
  }
  if (restored) {
    console.log(`[last-pos] restore ${restored} boat position(s) from disk`);
  }
}

function scheduleLastPositionsSave() {
  if (lastPositionsSaveTimer) return;
  lastPositionsSaveTimer = setTimeout(() => {
    lastPositionsSaveTimer = null;
    writeFile(lastPositionsPath, `${JSON.stringify(lastPositions, null, 2)}\n`).catch((error) => {
      console.error(`Cannot save last positions: ${error.message}`);
    });
  }, 400);
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
