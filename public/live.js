// Chỉ coi "đã cập bến" khi sát marker bến (trước 60m báo sớm khi còn ngoài sông).
const SNAP_STATION_M = 28;
const APPROACH_M = 180;
const SIGNAL_TTL_MS = 120_000;
const HEARTBEAT_MS = 5000;
const CLUSTER_M = 25;
/** Giữ pin kéo tay khi hub/Azure chưa kịp (tránh nhảy về chỗ cũ). */
const USER_PIN_HOLD_MS = 45_000;
const USER_PIN_HUB_CATCHUP_M = 40;
const ROUTE_STYLE = {
  color: '#0f766e',
  weight: 2.5,
  opacity: 0.14,
  smoothFactor: 0,
};
const WATERBUS_CORRIDOR_CODES = [
  'ST-BD', 'ST-TT', 'ST-BA', 'ST-TD2', 'ST-TD', 'ST-HBC', 'ST-LD',
];
const STORAGE_PINS = 'liveGpsBoatPins.v3'; // v3: luôn bám hub/Azure — bỏ pin lệch theo domain local/Railway
const STORAGE_STATUS = 'liveGpsBoatStatus.v1';
const STORAGE_SPEEDS = 'liveGpsBoatSpeeds.v1';
const STORAGE_RESCUE = 'liveGpsRescueMissions.v1';
const STORAGE_HEADINGS = 'liveGpsBoatHeadings.v2'; // v2: bám hub/Azure — bỏ heading lệch domain
const RESCUE_ARRIVE_M = 120;
const DEFAULT_SPEED_KMH = 16;
const HEADING_STEP_DEG = 15;

const PHASES = {
  prepare: 'Chuẩn bị đi',
  departing: 'Bắt đầu đi',
  enroute: 'Đang đi',
  stopped: 'Đang dừng trên sông',
  approaching: 'Sắp cập bến',
  arrived: 'Đã cập bến',
  incident: '', // chỉ hiện chấm đỏ — không chữ
};

const map = L.map('map', { zoomControl: false }).setView([10.776, 106.708], 13);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap',
}).addTo(map);

const boatSelectEl = document.querySelector('#boatSelect');
const sendAzureSelectEl = document.querySelector('#sendAzureSelect');
const speedInputEl = document.querySelector('#speedInput');
const deviceHintEl = document.querySelector('#deviceHint');
const hubStatusEl = document.querySelector('#hubStatus');
const sendStatusEl = document.querySelector('#sendStatus');
const gpsScanSummaryEl = document.querySelector('#gpsScanSummary');
const gpsScanDetailEl = document.querySelector('#gpsScanDetail');
let lastGpsScan = null;
const coordStatusEl = document.querySelector('#coordStatus');
const boatPhaseStatusEl = document.querySelector('#boatPhaseStatus');
const boatRouteStatusEl = document.querySelector('#boatRouteStatus');
const boatDbStatusEl = document.querySelector('#boatDbStatus');
const incidentsHubStatusEl = document.querySelector('#incidentsHubStatus');
const incidentsHubHintEl = document.querySelector('#incidentsHubHint');
const incidentsListEl = document.querySelector('#incidentsList');
const refreshIncidentsBtn = document.querySelector('#refreshIncidentsBtn');
const centerBoatBtn = document.querySelector('#centerBoatBtn');
const sendNowBtn = document.querySelector('#sendNowBtn');
const incidentBtn = document.querySelector('#incidentBtn');
const refreshBtn = document.querySelector('#refreshBtn');
const toastHost = document.querySelector('#toastHost');
const boatContextMenuEl = document.querySelector('#boatContextMenu');
const boatCtxTitleEl = document.querySelector('#boatCtxTitle');
const boatCtxToggleLockBtn = document.querySelector('#boatCtxToggleLock');
const boatCtxRotateLeftBtn = document.querySelector('#boatCtxRotateLeft');
const boatCtxRotateRightBtn = document.querySelector('#boatCtxRotateRight');
const boatCtxHeadNorthBtn = document.querySelector('#boatCtxHeadNorth');
const boatCtxHeadSouthBtn = document.querySelector('#boatCtxHeadSouth');
const boatCtxHeadEastBtn = document.querySelector('#boatCtxHeadEast');
const boatCtxHeadWestBtn = document.querySelector('#boatCtxHeadWest');
const rotateLeftBtn = document.querySelector('#rotateLeftBtn');
const rotateRightBtn = document.querySelector('#rotateRightBtn');
const headNorthBtn = document.querySelector('#headNorthBtn');
const headSouthBtn = document.querySelector('#headSouthBtn');
const headEastBtn = document.querySelector('#headEastBtn');
const headWestBtn = document.querySelector('#headWestBtn');
const headingHintEl = document.querySelector('#headingHint');

let latest = null;
let eventsSource = null;
let selectedBoatCode = localStorage.getItem('liveGpsBoatCode') || '';
let unlockedBoatCode = ''; // chỉ tàu này mới kéo được
let contextMenuBoatCode = '';
let sending = false;
let dragging = false;
let draggingBoatCode = '';
let hasFitRoutes = false;
let heartbeatTimer = null;
let heartbeatBusy = false;
let incidentBusy = false;
let incidentToastSeeded = false;
const toastedIncidentIds = new Set();
const toastedRescueKeys = new Set();
let eventsReconnectTimer = null;
let eventsBackoffMs = 1000;
let lastEventsAt = 0;
let snapshotPollTimer = null;
let snapshotPollBusy = false;
let sseAlive = false;
const pinnedPositions = loadJsonMap(STORAGE_PINS);
// Pin/heading v1 từng làm local ≠ Railway (mỗi domain nhớ riêng).
try {
  localStorage.removeItem('liveGpsBoatPins.v1');
  localStorage.removeItem('liveGpsBoatPins.v2');
  localStorage.removeItem('liveGpsBoatHeadings.v1');
} catch {
  /* ignore */
}
const boatStatuses = loadJsonMap(STORAGE_STATUS);
const boatSpeeds = loadJsonMap(STORAGE_SPEEDS);
const rescueMissions = loadJsonMap(STORAGE_RESCUE);
const boatHeadings = loadJsonMap(STORAGE_HEADINGS);
const lastSignalAt = new Map();
const openPopupCode = new Set();

const stationLayers = new Map();
const hubMarkers = new Map();
const routeLayers = new Map();
const rescueOverlays = new Map();

function loadJsonMap(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '{}');
    return new Map(Object.entries(raw || {}));
  } catch {
    return new Map();
  }
}

function persistMap(key, mapObj) {
  const obj = {};
  for (const [k, v] of mapObj) obj[k] = v;
  localStorage.setItem(key, JSON.stringify(obj));
}

function persistPins() {
  persistMap(STORAGE_PINS, pinnedPositions);
}

function persistStatuses() {
  persistMap(STORAGE_STATUS, boatStatuses);
}

function persistRescueMissions() {
  persistMap(STORAGE_RESCUE, rescueMissions);
}

function missionForRescue(code) {
  const key = String(code || '').trim();
  if (!key) return null;
  for (const mission of rescueMissions.values()) {
    if (String(mission.rescueBoatCode || '').trim() === key) return mission;
  }
  return null;
}

function missionForIncident(incidentId) {
  return rescueMissions.get(String(incidentId || '').trim()) || null;
}

function isBoatInActiveAutomatedRescue(code, data = latest) {
  const key = String(code || '').trim();
  if (!key) return false;
  return (data?.rescueMissions || []).some((mission) => {
    const status = String(mission?.status || '');
    // AtStation = đã cập bến / đã nhả — không khóa kéo nữa.
    if (!['Dispatched', 'InTransit', 'Arrived', 'Towing'].includes(status)) return false;
    if (String(mission.rescueBoatCode || '').trim() === key) return true;
    if (String(mission.incidentBoatCode || '').trim() === key) return true;
    return false;
  });
}

function syncAutomatedRescuePins(hubBoats, data = latest) {
  const missions = Array.isArray(data?.rescueMissions) ? data.rescueMissions : [];
  if (!missions.length) return;
  const hubByCode = new Map(
    (hubBoats || []).map((boat) => [String(boat.boatCode || '').trim(), boat]),
  );
  let changed = false;
  for (const mission of missions) {
    const status = String(mission.status);
    // Bám path khi đang chạy + AtStation (đưa pin SOS đúng bến thật, không kẹt pin cũ).
    if (!['Dispatched', 'InTransit', 'Arrived', 'Towing', 'AtStation'].includes(status)) continue;

    const rescueCode = String(mission.rescueBoatCode || '').trim();
    const incidentCode = String(mission.incidentBoatCode || '').trim();
    const rescueLat = Number(mission.currentLat ?? hubByCode.get(rescueCode)?.lat);
    const rescueLng = Number(mission.currentLng ?? hubByCode.get(rescueCode)?.lng);
    if (!rescueCode || !Number.isFinite(rescueLat) || !Number.isFinite(rescueLng)) continue;

    // Đang kéo tay SOS → không snap. Heartbeat/user pin cũ KHÔNG được chặn cứu hộ.
    const rescueDragging = dragging && draggingBoatCode === rescueCode;
    if (!rescueDragging) {
      pinnedPositions.set(rescueCode, { lat: rescueLat, lng: rescueLng, at: Date.now(), user: false });
      changed = true;
    }

    // Đang kéo: tàu lỗi nối đuôi — không đè cùng điểm rồi bị cluster nhảy.
    const incidentDragging = dragging && draggingBoatCode === incidentCode;
    if (incidentCode && !incidentDragging) {
      if (status === 'Towing') {
        let lat = Number(mission.incidentCurrentLat);
        let lng = Number(mission.incidentCurrentLng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          const station = {
            lat: Number(mission.targetLat),
            lng: Number(mission.targetLng),
          };
          const heading = (Number.isFinite(station.lat) && Number.isFinite(station.lng))
            ? bearingDegreesLocal({ lat: rescueLat, lng: rescueLng }, station)
            : Number(mission.lastHeading || 0);
        const gap = 15;
        const behind = pointBehindLocal({ lat: rescueLat, lng: rescueLng }, heading, gap);
          lat = behind.lat;
          lng = behind.lng;
        }
        pinnedPositions.set(incidentCode, { lat, lng, at: Date.now(), user: false });
        changed = true;
      } else if (status === 'Dispatched' || status === 'InTransit' || status === 'AtStation') {
        const lat = Number(mission.incidentCurrentLat ?? mission.incidentLat);
        const lng = Number(mission.incidentCurrentLng ?? mission.incidentLng);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          pinnedPositions.set(incidentCode, { lat, lng, at: Date.now(), user: false });
          changed = true;
        }
      }
    }

    const local = rescueMissions.get(String(mission.incidentId || '').trim());
    if (local) {
      if (status === 'Dispatched' || status === 'InTransit') {
        local.phase = 'to_incident';
        local.departureStationName = mission.destinationStationName || local.departureStationName;
      } else if (status === 'Towing') {
        local.phase = 'returning';
        local.departureStationCode = mission.destinationStationCode || null;
        local.departureStationName = mission.destinationStationName || 'bến gần nhất';
        local.departureLat = Number(mission.targetLat);
        local.departureLng = Number(mission.targetLng);
      } else if (status === 'AtStation') {
        local.phase = 'completed';
        local.departureStationCode = mission.destinationStationCode || local.departureStationCode;
        local.departureStationName = mission.destinationStationName || local.departureStationName || 'bến';
      }
      rescueMissions.set(local.incidentId, local);
      changed = true;
    }
  }
  if (changed) {
    persistPins();
    persistRescueMissions();
  }
}

function bearingDegreesLocal(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function pointBehindLocal(position, heading, meters) {
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

function syncOpenIncidentPins(data = latest) {
  const towingCodes = new Set();
  for (const mission of (data?.rescueMissions || [])) {
    const status = String(mission.status || '');
    if (status !== 'Towing' && status !== 'AtStation') continue;
    const code = String(mission.incidentBoatCode || '').trim();
    if (code) towingCodes.add(code);
  }

  let changed = false;
  for (const incident of openIncidentsList(data)) {
    const code = String(incident.boatCode || '').trim();
    // Đang bị kéo → không neo lại chấm sự cố cũ (tránh tàu đỏ đứng yên, tàu cứu đi một mình).
    if (!code || towingCodes.has(code)) continue;
    const lat = Number(incident.lat);
    const lng = Number(incident.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    // Có hub GPS mới (< 30s) → không kéo marker về tọa độ sự cố mỗi lần render (gây nhảy cũ↔mới).
    const hub = (data?.hubBoats || []).find((b) => String(b.boatCode || '').trim() === code);
    if (hub) {
      const hubMs = Date.parse(hub.receivedAt || hub.recordedAt || hub.updatedAt || '');
      if (Number.isFinite(hubMs) && Date.now() - hubMs < 30_000) continue;
    }
    const pin = pinnedFor(code);
    if (pin?.user) continue;
    pinnedPositions.set(code, { lat, lng, at: Date.now(), user: false });
    changed = true;
  }
  if (changed) persistPins();
}

function incidentTargetCoords(row) {
  const lat = Number(row?.sceneLat ?? row?.lat ?? row?.incidentLat);
  const lng = Number(row?.sceneLng ?? row?.lng ?? row?.incidentLng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  const pin = pinnedFor(row?.boatCode);
  if (pin) return { lat: pin.lat, lng: pin.lng };
  return null;
}

function startRescueMission(incident, { announce = true } = {}) {
  const rescueCode = String(
    incident?.rescueBoatCode || incident?.replacementBoatCode || '',
  ).trim();
  const incidentId = String(incident?.incidentId || '').trim();
  if (!incidentId || !rescueCode) return null;

  const target = incidentTargetCoords(incident);
  if (!target) {
    if (announce) toast('Chưa có tọa độ sự cố — chờ GPS tàu lỗi', 'warn');
    return null;
  }

  const rescuePin = pinnedFor(rescueCode) || fallbackLatLngForBoat(rescueCode, 0, latest);
  ensureSeedPin(rescueCode, rescuePin.lat, rescuePin.lng);
  const fixedRescue = pinnedFor(rescueCode) || rescuePin;
  const depNear = nearestStationAny(fixedRescue, latest?.stations || []);

  const mission = {
    incidentId,
    incidentBoatCode: incident.boatCode || null,
    rescueBoatCode: rescueCode,
    incidentLat: target.lat,
    incidentLng: target.lng,
    departureStationCode: depNear?.station?.stationCode || null,
    departureStationName: depNear?.station?.stationName || null,
    departureLat: fixedRescue.lat,
    departureLng: fixedRescue.lng,
    phase: 'to_incident',
    updatedAt: Date.now(),
  };
  rescueMissions.set(incidentId, mission);
  persistRescueMissions();

  unlockBoat(rescueCode);
  selectBoat(rescueCode, { toastMessage: false });
  if (announce) {
    toast(`Cứu hộ ${rescueCode}: kéo tới hiện trường sự cố`, 'ok', 5000);
  }
  return mission;
}

function syncRescueMissionsFromIncidents(data = latest) {
  const openIds = new Set();
  for (const row of openIncidentsList(data)) {
    openIds.add(row.incidentId);
    const assignedRescue = String(row.rescueBoatCode || row.replacementBoatCode || '').trim();
    if (!assignedRescue) continue;
    const existing = missionForIncident(row.incidentId);
    if (!existing || existing.rescueBoatCode !== assignedRescue) {
      startRescueMission(row, { announce: !existing });
      continue;
    }
    const target = incidentTargetCoords(row);
    if (target) {
      existing.incidentLat = target.lat;
      existing.incidentLng = target.lng;
      rescueMissions.set(row.incidentId, existing);
    }
  }
  for (const id of [...rescueMissions.keys()]) {
    if (!openIds.has(id)) rescueMissions.delete(id);
  }
  persistRescueMissions();
}

function rescuePhaseLabel(code) {
  const key = String(code || '').trim();
  const auto = (latest?.rescueMissions || []).find(
    (mission) => String(mission.rescueBoatCode || '').trim() === key,
  );
  if (auto) {
    const st = String(auto.status || '');
    const dep = auto.destinationStationName || auto.destinationStationCode || 'bến';
    if (st === 'Dispatched' || st === 'InTransit') return 'Cứu hộ → hiện trường';
    if (st === 'Towing') return `Đang về ${dep}`;
    if (st === 'AtStation') return `Đã về ${dep}`;
    if (st === 'Completed') return `Đã về ${dep}`;
  }
  const m = missionForRescue(code);
  if (!m) return null;
  const dep = m.departureStationName || m.departureStationCode || 'bến xuất phát';
  if (m.phase === 'to_incident') return `Cứu hộ → hiện trường`;
  if (m.phase === 'at_incident') return `Tại hiện trường · kéo về ${dep}`;
  if (m.phase === 'returning') return `Đang về ${dep}`;
  if (m.phase === 'completed') return `Đã về ${dep}`;
  return null;
}

function handleRescueDragEnd(code, lat, lng) {
  const mission = missionForRescue(code);
  if (!mission || mission.phase === 'completed') return { handled: false, lat, lng };

  const atIncident = Number.isFinite(mission.incidentLat)
    && distMeters({ lat, lng }, { lat: mission.incidentLat, lng: mission.incidentLng }) <= RESCUE_ARRIVE_M;

  const depStation = stationByCode(mission.departureStationCode, latest?.stations || []);
  let atDeparture = false;
  if (depStation) {
    atDeparture = distMeters({ lat, lng }, depStation) <= SNAP_STATION_M;
    // Không snap tọa độ — để user đặt đâu cũng được.
  } else if (Number.isFinite(mission.departureLat)) {
    atDeparture = distMeters({ lat, lng }, { lat: mission.departureLat, lng: mission.departureLng }) <= SNAP_STATION_M;
  }

  if (mission.phase === 'to_incident' && atIncident) {
    mission.phase = 'at_incident';
    mission.updatedAt = Date.now();
    rescueMissions.set(mission.incidentId, mission);
    persistRescueMissions();
    const dep = mission.departureStationName || mission.departureStationCode || 'bến xuất phát';
    toast(`Đã tới hiện trường · kéo ${code} về ${dep}`, 'ok', 5000);
    return { handled: true, lat, lng };
  }
  if ((mission.phase === 'at_incident' || mission.phase === 'returning') && atDeparture) {
    mission.phase = 'completed';
    mission.updatedAt = Date.now();
    rescueMissions.set(mission.incidentId, mission);
    persistRescueMissions();
    toast(`Tàu cứu ${code} đã về bến`, 'ok');
    return { handled: true, lat, lng };
  }
  if (mission.phase === 'at_incident') {
    mission.phase = 'returning';
    mission.updatedAt = Date.now();
    rescueMissions.set(mission.incidentId, mission);
    persistRescueMissions();
  }
  return { handled: false, lat, lng };
}

function renderRescueOverlays(data = latest) {
  const seen = new Set();
  const autoById = new Map(
    (data?.rescueMissions || []).map((row) => [String(row.incidentId || '').trim(), row]),
  );

  for (const row of openIncidentsList(data)) {
    const target = incidentTargetCoords(row);
    if (!target) continue;
    seen.add(row.incidentId);

    const localMission = missionForIncident(row.incidentId);
    const autoMission = autoById.get(String(row.incidentId || '').trim());
    const rescueCode = String(
      autoMission?.rescueBoatCode || localMission?.rescueBoatCode || row.rescueBoatCode || row.replacementBoatCode || '',
    ).trim();
    const incidentCode = String(autoMission?.incidentBoatCode || row.boatCode || '').trim();
    const rescuePin = rescueCode ? pinnedFor(rescueCode) : null;
    const incidentPin = incidentCode ? pinnedFor(incidentCode) : null;
    const autoStatus = String(autoMission?.status || '');

    let overlay = rescueOverlays.get(row.incidentId);
    if (!overlay) {
      overlay = {
        toLine: null,
        returnLine: null,
        towLine: null,
      };
      rescueOverlays.set(row.incidentId, overlay);
    }
    // Bỏ chấm đỏ scene thừa — tàu sự cố đã có badge SC trên marker.
    if (overlay.incidentDot) {
      overlay.incidentDot.remove();
      overlay.incidentDot = null;
    }

    // Đã về bến (server hoặc local): xóa đường — không để localMission vẽ tím khi SOS đứng yên.
    const openMissionStatus = String(row.missionStatus || '');
    if (
      autoStatus === 'AtStation'
      || autoStatus === 'Completed'
      || openMissionStatus === 'AtStation'
      || openMissionStatus === 'Completed'
      || localMission?.phase === 'completed'
    ) {
      overlay.toLine?.remove();
      overlay.toLine = null;
      overlay.returnLine?.remove();
      overlay.returnLine = null;
      overlay.towLine?.remove();
      overlay.towLine = null;
      if (localMission) {
        localMission.phase = 'completed';
        rescueMissions.set(row.incidentId, localMission);
        persistRescueMissions();
      }
      continue;
    }

    // Server đang chạy: không vẽ đường corridor lên map (chỉ pin tàu).
    if (
      (autoStatus === 'Dispatched' || autoStatus === 'InTransit')
      && rescuePin
    ) {
      overlay.toLine?.remove();
      overlay.toLine = null;
      overlay.returnLine?.remove();
      overlay.returnLine = null;
      overlay.towLine?.remove();
      overlay.towLine = null;
      continue;
    }

    // Đang kéo: chỉ nối ngắn tàu cứu → tàu lỗi (dây kéo), không vẽ path sông.
    if (autoStatus === 'Towing' && rescuePin && incidentPin) {
      const towPoints = [
        [rescuePin.lat, rescuePin.lng],
        [incidentPin.lat, incidentPin.lng],
      ];
      if (!overlay.towLine) {
        overlay.towLine = L.polyline(towPoints, {
          color: '#7c3aed',
          weight: 3,
          opacity: 0.35,
        }).addTo(map);
      } else {
        overlay.towLine.setLatLngs(towPoints);
        if (!map.hasLayer(overlay.towLine)) overlay.towLine.addTo(map);
      }
      overlay.toLine?.remove();
      overlay.toLine = null;
      overlay.returnLine?.remove();
      overlay.returnLine = null;
      continue;
    }

    if (overlay.towLine) {
      overlay.towLine.remove();
      overlay.towLine = null;
    }

    if (!localMission || localMission.phase === 'completed' || !rescueCode || !rescuePin) continue;
    // Không vẽ path local — chỉ pin tàu.
    if (autoMission && autoStatus) continue;
    overlay.toLine?.remove();
    overlay.toLine = null;
    overlay.returnLine?.remove();
    overlay.returnLine = null;
  }

  for (const [id, overlay] of rescueOverlays) {
    if (!seen.has(id)) {
      overlay.toLine?.remove();
      overlay.returnLine?.remove();
      overlay.towLine?.remove();
      overlay.incidentDot?.remove();
      rescueOverlays.delete(id);
    }
  }
}

function pinBoatPosition(code, lat, lng, { user = true } = {}) {
  const key = String(code || '').trim();
  if (!key || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  pinnedPositions.set(key, {
    lat: Number(lat),
    lng: Number(lng),
    at: Date.now(),
    user: Boolean(user),
  });
  persistPins();
}

function pinnedFor(code) {
  const pin = pinnedPositions.get(String(code || '').trim());
  if (!pin) return null;
  if (!Number.isFinite(Number(pin.lat)) || !Number.isFinite(Number(pin.lng))) return null;
  return {
    lat: Number(pin.lat),
    lng: Number(pin.lng),
    at: Number(pin.at) || 0,
    user: Boolean(pin.user),
  };
}

function ensureSeedPin(code, lat, lng) {
  if (pinnedFor(code)) return;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  pinBoatPosition(code, lat, lng, { user: false });
}

/** Tàu đang ghi GPS survey — tạm ẩn khỏi Live map (chỉ hiện trên Survey). */
function activeSurveyBoatCode(data = latest) {
  const collector = data?.collector;
  const code = String(collector?.boatCode || '').trim();
  if (!code) return '';
  const status = String(collector?.status || '').toLowerCase();
  if (!['moving', 'paused', 'running', 'completed'].includes(status)) return '';
  return code;
}

/** Khi đang ghi GPS survey — không hiện / không pin tàu đó trên Live. */
function clearSurveyBoatFromLive(data = latest) {
  const code = activeSurveyBoatCode(data);
  if (!code) return;
  pinnedPositions.delete(code);
  const marker = hubMarkers.get(code);
  if (marker) {
    marker.remove();
    hubMarkers.delete(code);
  }
  if (selectedBoatCode === code) {
    selectedBoatCode = null;
  }
}

/** Cập nhật pin từ hub GPS — trừ khi user đang kéo tay hoặc đang cứu hộ tự động.
 *  Giữ vị trí cuối nếu hub nhảy xa bất thường (tránh teleport khi Azure/SSE lệch).
 */
function syncLiveHubPins(hubBoats) {
  const surveyCode = activeSurveyBoatCode();
  let changed = false;
  for (const boat of hubBoats || []) {
    const code = String(boat?.boatCode || '').trim();
    if (!code) continue;
    if (surveyCode && code === surveyCode) continue;
    if (dragging && draggingBoatCode === code) continue;
    // Mission cứu hộ tự set pin từ currentLat — không để hub/Azure kéo về bến.
    if (isBoatInActiveAutomatedRescue(code)) continue;
    const pin = pinnedFor(code);
    if (pin?.user) continue;
    const lat = Number(boat.lat);
    const lng = Number(boat.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const prevLat = Number(pin?.lat);
    const prevLng = Number(pin?.lng);
    if (pin && Number.isFinite(prevLat) && Number.isFinite(prevLng)) {
      const moved = distMeters({ lat: prevLat, lng: prevLng }, { lat, lng });
      if (moved < 1.5) continue;
      // Hub/Azure là SoT — luôn bám (trừ pin user). Tránh local/prod lệch vị trí.
    }
    pinnedPositions.set(code, { lat, lng, at: Date.now(), user: false });
    changed = true;
  }
  if (changed) persistPins();
}

function getStatus(code) {
  const key = String(code || '').trim();
  const cur = boatStatuses.get(key) || {};
  return {
    phase: cur.phase || 'prepare',
    incident: Boolean(cur.incident),
    updatedAt: Number(cur.updatedAt) || 0,
  };
}

function setStatus(code, patch = {}) {
  const key = String(code || '').trim();
  if (!key) return;
  const prev = getStatus(key);
  boatStatuses.set(key, {
    ...prev,
    ...patch,
    updatedAt: Date.now(),
  });
  persistStatuses();
}

function markSignal(code) {
  const key = String(code || '').trim();
  if (!key) return;
  lastSignalAt.set(key, Date.now());
}

function hasSignal(code, hub) {
  // Hub/SSE gần đây = còn tín hiệu; không cần heartbeat POST.
  if (openIncidentForBoat(code)) return false;
  const st = getStatus(code);
  if (st.incident) return false;
  const key = String(code || '').trim();
  const sent = lastSignalAt.get(key) || 0;
  if (Date.now() - sent < SIGNAL_TTL_MS) return true;
  if (hub && hub.isOnline !== false) {
    const hubMs = Date.parse(hub.receivedAt || hub.recordedAt || hub.updatedAt || '');
    if (Number.isFinite(hubMs) && Date.now() - hubMs < SIGNAL_TTL_MS) return true;
    if (hub.isOnline !== false) return true;
  }
  if (activeTripForBoat(key) || isBoatInActiveAutomatedRescue(key)) return true;
  return Boolean(pinnedFor(key));
}

function openIncidentsList(data = latest) {
  return Array.isArray(data?.openIncidents) ? data.openIncidents : [];
}

function openIncidentForBoat(code) {
  const key = String(code || '').trim();
  if (!key) return null;
  return openIncidentsList().find((row) => String(row.boatCode || '').trim() === key) || null;
}

function isRescueBoat(code) {
  const key = String(code || '').trim();
  if (!key) return false;
  const automated = (latest?.rescueMissions || []).find(
    (mission) => String(mission.rescueBoatCode || '').trim() === key,
  );
  if (automated) {
    // Badge CỨU chỉ khi đang chạy — cập bến / Completed thì nhả.
    const status = String(automated.status || '');
    return ['Dispatched', 'InTransit', 'Arrived', 'Towing'].includes(status);
  }
  return openIncidentsList().some((row) => {
    const rescue = String(row.rescueBoatCode || row.replacementBoatCode || '').trim();
    return rescue === key;
  });
}

function syncLocalIncidentFlags() {
  const openCodes = new Set(
    openIncidentsList().map((row) => String(row.boatCode || '').trim()).filter(Boolean),
  );
  for (const code of openCodes) {
    setStatus(code, { incident: true, phase: 'incident' });
  }
  for (const [code, st] of boatStatuses) {
    if (st?.incident && !openCodes.has(code)) {
      setStatus(code, { incident: false, phase: 'stopped' });
    }
  }
}

function boatIdForCode(code) {
  const boat = catalogBoats().find((b) => String(b.boatCode) === String(code));
  return boat?.boatId || null;
}

function rescueBoatOptionsHtml(excludeCode) {
  const exclude = String(excludeCode || '').trim();
  return catalogBoats()
    .filter((b) => String(b.boatCode) !== exclude)
    .map((b) => `<option value="${escapeHtml(b.boatCode)}">${escapeHtml(b.boatName || b.boatCode)}</option>`)
    .join('');
}

function toast(message, type = 'ok', ms = 3200) {
  if (!toastHost) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function normalizeDbStatus(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function boatDbStatus(code, data = latest) {
  const boat = (data?.boats || []).find((b) => String(b.boatCode) === String(code));
  // Còn sự cố mở hoặc DB = Incident → Sự cố.
  if (openIncidentForBoat(code, data)) return 'incident';
  const neon = normalizeDbStatus(boat?.neonStatus || boat?.dbStatus || boat?.effectiveStatus);
  if (neon === 'incident') return 'incident';
  return neon;
}

function boatDbStatusLabel(code, data = latest) {
  const status = boatDbStatus(code, data);
  if (status === 'incident') return 'Sự cố';
  if (status === 'undermaintenance') return 'Bảo trì';
  if (status === 'active') return 'Hoạt động';
  if (status === 'inactive') return 'Ngưng';
  if (status === 'retired') return 'Ngừng dùng';
  return status || '—';
}

function catalogBoats(data = latest) {
  return (data?.boats || [])
    .filter((boat) => {
      if (!boat.boatCode) return false;
      if (String(boat.boatId || '').startsWith('collector-')) return false;
      if (boat.boatId === 'fallback-boat') return false;
      const status = normalizeDbStatus(boat.dbStatus || boat.neonStatus || boat.effectiveStatus);
      // Active + Bảo trì + Sự cố (FE báo → DB=Incident — vẫn hiện đỏ, không ẩn).
      return status === 'active' || status === 'undermaintenance' || status === 'incident';
    })
    .slice()
    .sort((a, b) => String(a.boatCode).localeCompare(String(b.boatCode)));
}

/** Mã tàu cần hiện trên map: catalog + tàu đang có sự cố mở.
 *  Tàu vừa cập nhật GPS/status được xếp trước (ưu tiên load / z-index).
 */
function boatUpdateMs(code, hubByCode = null, data = latest) {
  const key = String(code || '').trim();
  if (!key) return 0;
  const hub = hubByCode?.get?.(key)
    || (data?.hubBoats || []).find((b) => String(b.boatCode || '').trim() === key);
  const pin = pinnedFor(key);
  const mission = (data?.rescueMissions || []).find((m) => (
    String(m.rescueBoatCode || '').trim() === key
    || String(m.incidentBoatCode || '').trim() === key
  ));
  const open = openIncidentForBoat(key, data);
  const times = [
    Date.parse(hub?.updatedAt || ''),
    Date.parse(hub?.receivedAt || ''),
    Date.parse(hub?.recordedAt || ''),
    Number(pin?.at) || 0,
    Date.parse(mission?.updatedAt || ''),
    Date.parse(open?.updatedAt || ''),
  ].filter((n) => Number.isFinite(n) && n > 0);
  return times.length ? Math.max(...times) : 0;
}

function mapBoatCodes(data = latest, hubBoats = null) {
  const surveyCode = activeSurveyBoatCode(data);
  const codes = new Set(
    catalogBoats(data).map((b) => String(b.boatCode).trim()).filter(Boolean),
  );
  if (surveyCode) codes.delete(surveyCode);
  for (const row of openIncidentsList(data)) {
    const code = String(row.boatCode || '').trim();
    if (code && code !== surveyCode) codes.add(code);
    const rescue = String(row.rescueBoatCode || row.replacementBoatCode || '').trim();
    if (rescue && rescue !== surveyCode) codes.add(rescue);
    const transfer = String(row.replacementBoatCode || '').trim();
    if (transfer && transfer !== surveyCode) codes.add(transfer);
  }
  const hubByCode = new Map();
  for (const boat of (hubBoats || data?.hubBoats || [])) {
    const code = String(boat?.boatCode || '').trim();
    if (!code || code === surveyCode) continue;
    hubByCode.set(code, boat);
  }
  return [...codes].sort((a, b) => {
    const diff = boatUpdateMs(b, hubByCode, data) - boatUpdateMs(a, hubByCode, data);
    if (diff) return diff;
    return String(a).localeCompare(String(b));
  });
}

function boatMarkerZIndex(code, {
  selected = false,
  canDrag = false,
  rescue = false,
  incident = false,
  updateMs = 0,
  newestMs = 0,
} = {}) {
  if (selected || canDrag) return 1300;
  const recency = (newestMs > 0 && updateMs > 0)
    ? Math.min(180, Math.round((updateMs / newestMs) * 180))
    : 0;
  if (rescue) return 1100 + recency;
  if (incident) return 1000 + recency;
  return 700 + recency;
}

function deviceForBoat(code, data = latest) {
  const mapDevices = data?.config?.gpsDevices || {};
  if (Array.isArray(mapDevices)) {
    const hit = mapDevices.find((row) => String(row.boatCode || '') === String(code));
    return hit?.deviceId || data?.config?.surveyDeviceId || '';
  }
  return mapDevices[code] || data?.config?.surveyDeviceId || '';
}

function distMeters(a, b) {
  if (typeof GeoDistance !== 'undefined') return GeoDistance.distanceMeters(a, b);
  const toRad = (v) => (Number(v) * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLng = toRad(Number(b.lng) - Number(a.lng));
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function nearestStationAny(latlng, stations) {
  let best = null;
  let bestDist = Infinity;
  for (const station of stations || []) {
    if (!Number.isFinite(Number(station.lat)) || !Number.isFinite(Number(station.lng))) continue;
    const d = distMeters(latlng, station);
    if (d < bestDist) {
      bestDist = d;
      best = station;
    }
  }
  return best ? { station: best, dist: bestDist } : null;
}

function nearestStation(latlng, stations) {
  const hit = nearestStationAny(latlng, stations);
  return hit && hit.dist <= SNAP_STATION_M ? hit : null;
}

function stationByCode(code, stations = latest?.stations) {
  const key = String(code || '').toUpperCase();
  return (stations || []).find((s) => String(s.stationCode || '').toUpperCase() === key) || null;
}

function corridorStations(stations = latest?.stations) {
  return WATERBUS_CORRIDOR_CODES
    .map((code) => stationByCode(code, stations))
    .filter(Boolean);
}

function scheduleMinutes(fromCode, toCode) {
  const segments = latest?.config?.waterbusSchedule?.segments || {};
  const key = `${String(fromCode || '').toUpperCase()}|${String(toCode || '').toUpperCase()}`;
  const n = Number(segments[key]);
  return Number.isFinite(n) ? n : null;
}

function nextStationAlongCorridor(latlng, stations = latest?.stations) {
  const corridor = corridorStations(stations);
  if (corridor.length < 2) {
    const near = nearestStationAny(latlng, stations);
    return near ? { from: near.station, to: null, distToFrom: near.dist, etaMin: null } : null;
  }
  let bestIdx = 0;
  let bestDist = Infinity;
  corridor.forEach((s, i) => {
    const d = distMeters(latlng, s);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  });
  const from = corridor[bestIdx];
  const to = corridor[Math.min(bestIdx + 1, corridor.length - 1)];
  const same = String(from.stationId) === String(to.stationId);
  const etaMin = same ? 0 : scheduleMinutes(from.stationCode, to.stationCode);
  return {
    from,
    to: same ? null : to,
    distToFrom: bestDist,
    distToTo: same ? 0 : distMeters(latlng, to),
    etaMin,
  };
}

function routeLabelForBoat(code) {
  const boat = (latest?.boats || []).find((b) => String(b.boatCode) === String(code));
  const name = String(boat?.routeName || '').trim();
  const routeCode = String(boat?.routeCode || '').trim();
  if (name && routeCode) return `${routeCode} · ${name}`;
  if (name) return name;
  if (routeCode) return routeCode;
  return '';
}

function withRouteSuffix(label, code) {
  const route = routeLabelForBoat(code);
  if (!label) return route || '';
  if (!route) return label;
  return `${label} · ${route}`;
}

function autoPhaseForBoat(code, lat, lng) {
  const st = getStatus(code);
  if (openIncidentForBoat(code) || st.incident) return 'incident';
  const near = nearestStationAny({ lat, lng }, latest?.stations || []);
  if (near && near.dist <= SNAP_STATION_M) return 'arrived';
  if (near && near.dist <= APPROACH_M) return 'approaching';

  // Giữa sông: kéo hoặc tàu cứu hộ đang đi.
  if (dragging && canDragBoat(code)) return 'enroute';
  if (missionForRescue(code)?.phase === 'to_incident' || missionForRescue(code)?.phase === 'returning') {
    return 'enroute';
  }
  return 'stopped';
}

function phaseStatusText(code, lat, lng) {
  const rescueLabel = rescuePhaseLabel(code);
  if (rescueLabel) return rescueLabel;

  const trip = activeTripForBoat(code);
  if (trip) {
    const spd = Number.isFinite(Number(trip.speedKmh)) ? Math.round(Number(trip.speedKmh)) : 0;
    const nextLabel = tripNextStopLabel(trip);
    if (trip.status === 'ToDeparture') {
      return nextLabel
        ? `Trip · về bến XP · ${nextLabel} · ${spd} km/h`
        : `Trip · về bến xuất phát · ${spd} km/h`;
    }
    if (trip.status === 'Boarding') {
      return nextLabel ? `Trip · chờ xuất bến · ${nextLabel}` : `Trip · chờ xuất bến · ${spd} km/h`;
    }
    if (trip.status === 'WaitingAtStop') {
      return nextLabel ? `Trip · chờ bến · ${nextLabel}` : `Trip · chờ bến · ${spd} km/h`;
    }
    if (trip.status === 'Paused') return 'Trip · tạm dừng (cứu hộ)';
    if (trip.status === 'Running') {
      return nextLabel ? `Trip · ${nextLabel} · ${spd} km/h` : `Trip · đang chạy · ${spd} km/h`;
    }
    return nextLabel ? `Trip · ${trip.status} · ${nextLabel}` : `Trip · ${trip.status} · ${spd} km/h`;
  }

  const phase = autoPhaseForBoat(code, lat, lng);
  const dbLabel = boatDbStatusLabel(code);
  const nearBerth = nearestStationAny({ lat, lng }, latest?.stations || []);
  const atBerth = Boolean(nearBerth && nearBerth.dist <= SNAP_STATION_M);
  const berthName = nearBerth?.station?.stationName || nearBerth?.station?.stationCode || 'bến';
  if (phase === 'incident') {
    const open = openIncidentForBoat(code);
    if (atBerth) {
      if (dbLabel === 'Bảo trì') return `Đã cập bến · ${berthName} · Bảo trì`;
      return open
        ? `Đã cập bến · ${berthName} · Sự cố`
        : `Đã cập bến · ${berthName}`;
    }
    const base = (open?.rescueBoatCode || open?.replacementBoatCode)
      ? `Sự cố · cứu: ${open.rescueBoatCode || open.replacementBoatCode}`
      : 'Sự cố';
    return dbLabel === 'Bảo trì' ? `${base} · Bảo trì` : base;
  }
  // Không còn sự cố mở nhưng DB vẫn UnderMaintenance.
  if (boatDbStatus(code) === 'undermaintenance') {
    return atBerth ? `Đã cập bến · ${berthName} · Bảo trì` : 'Bảo trì';
  }
  if (phase === 'enroute' || phase === 'departing') {
    return phase === 'departing' ? PHASES.departing : PHASES.enroute;
  }
  if (phase === 'stopped') return PHASES.stopped;
  if (phase === 'approaching') {
    return `${PHASES.approaching} · ${berthName}`;
  }
  if (phase === 'arrived') {
    return `${PHASES.arrived} · ${berthName}`;
  }
  return PHASES[phase] || PHASES.prepare;
}

function phaseLabel(code, lat, lng) {
  return withRouteSuffix(phaseStatusText(code, lat, lng), code);
}

function boatDisplayName(code, catalogBoat, hub) {
  return String(
    catalogBoat?.boatName
    || openIncidentForBoat(code)?.boatName
    || hub?.boatName
    || code
    || '',
  ).trim();
}

function boatPopupHtml(code, catalogBoat, hub, lat, lng) {
  const st = getStatus(code);
  const open = openIncidentForBoat(code);
  const signal = hasSignal(code, hub);
  const phase = autoPhaseForBoat(code, lat, lng);
  const name = boatDisplayName(code, catalogBoat, hub);
  const label = phaseLabel(code, lat, lng);
  const incident = Boolean(open || st.incident || phase === 'incident');
  const rescue = isRescueBoat(code);
  const dotClass = incident
    ? 'is-incident'
    : (signal ? 'is-ok' : 'is-off');
  const extra = rescue && !incident ? 'Tàu cứu hộ' : '';
  return `
    <div class="live-boat-popup">
      <div class="live-boat-popup-title">
        <i class="live-dot ${dotClass}" aria-hidden="true"></i>
        <span>${escapeHtml(name)}</span>
      </div>
      ${label ? `<div class="live-boat-popup-meta">${escapeHtml(label)}</div>` : ''}
      ${extra ? `<div class="live-boat-popup-meta">${escapeHtml(extra)}</div>` : ''}
    </div>
  `;
}

function boatDeckCount(code, catalogBoat) {
  const fromCatalog = Number(catalogBoat?.numberOfDecks);
  if (Number.isFinite(fromCatalog) && fromCatalog > 0) return fromCatalog;
  const fromLatest = Number((latest?.boats || []).find((b) => String(b.boatCode) === String(code))?.numberOfDecks);
  if (Number.isFinite(fromLatest) && fromLatest > 0) return fromLatest;
  return 1;
}

function boatColor({ signal, incident, decks, rescue, maintenance }) {
  if (incident) return '#dc2626';
  if (rescue) return '#7c3aed';
  if (maintenance) return '#ca8a04';
  if (!signal) return '#94a3b8';
  if (Number(decks) >= 2) return '#ea580c';
  return '#0f766e';
}

function boatIcon(heading = 0, opts = {}) {
  const deg = Number(heading) || 0;
  const fill = boatColor(opts);
  const size = opts.drag ? 52 : (opts.rescue ? 50 : 44);
  const tag = opts.rescue
    ? '<span class="live-boat-tag is-rescue">CỨU</span>'
    : (opts.incident ? '<span class="live-boat-tag is-incident">SC</span>' : '');
  return L.divIcon({
    className: 'live-boat-wrap',
    html: `
      <div class="live-boat${opts.drag ? ' is-drag' : ''}${opts.signal ? ' has-signal' : ''}${opts.rescue ? ' is-rescue' : ''}" style="--heading:${deg}deg;--boat:${fill}">
        <span class="live-boat-ring"></span>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path fill="${fill}" stroke="#fff" stroke-width="1.5" d="M12 3 L20 19 L12 15 L4 19 Z"></path>
        </svg>
        ${tag}
      </div>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function stationIcon(code) {
  const label = String(code || '')
    .replace(/^ST-/i, '')
    .slice(0, 3)
    .toUpperCase() || '•';
  return L.divIcon({
    className: '',
    html: `
      <div class="station-flag">
        <div class="station-flag-pole"></div>
        <div class="station-flag-cloth">${escapeHtml(label)}</div>
      </div>
    `,
    iconSize: [28, 36],
    iconAnchor: [5, 36],
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function fallbackLatLngForBoat(code, index, data = latest) {
  const pin = pinnedFor(code);
  // Pin user đang kéo, hoặc hub chưa bắt kịp chỗ vừa kéo.
  if (pin?.user && recentUserPinHolds(code, null)) {
    return { lat: pin.lat, lng: pin.lng };
  }
  const hub = (data?.hubBoats || []).find((b) => String(b.boatCode) === code);
  if (hub && Number.isFinite(Number(hub.lat)) && Number.isFinite(Number(hub.lng))) {
    return { lat: Number(hub.lat), lng: Number(hub.lng) };
  }
  if (pin && Number.isFinite(Number(pin.lat)) && Number.isFinite(Number(pin.lng)) && !pin.user) {
    return { lat: Number(pin.lat), lng: Number(pin.lng) };
  }
  const corridor = corridorStations(data?.stations);
  if (corridor.length) {
    const s = corridor[index % corridor.length];
    return { lat: Number(s.lat), lng: Number(s.lng) };
  }
  const stations = (data?.stations || []).filter((s) => (
    Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng))
  ));
  if (stations.length) {
    const s = stations[index % stations.length];
    return { lat: Number(s.lat), lng: Number(s.lng) };
  }
  return { lat: 10.776, lng: 106.708 };
}

/** Pin kéo tay còn hiệu lực khi hub lệch / chưa cập nhật. */
function recentUserPinHolds(code, hub) {
  const pin = pinnedFor(code);
  if (!pin?.user) return false;
  if (dragging && draggingBoatCode === code) return true;
  const age = Date.now() - (Number(pin.at) || 0);
  if (!(age >= 0 && age <= USER_PIN_HOLD_MS)) return false;
  if (!hub || !Number.isFinite(Number(hub.lat)) || !Number.isFinite(Number(hub.lng))) return true;
  const dist = distMeters(
    { lat: pin.lat, lng: pin.lng },
    { lat: Number(hub.lat), lng: Number(hub.lng) },
  );
  return !(Number.isFinite(dist) && dist <= USER_PIN_HUB_CATCHUP_M);
}

/** Vị trí hiện map: ưu tiên pin kéo khi hub chưa kịp; còn lại hub/Azure. */
function boatMapLatLng(code, hub, index, data = latest) {
  const pin = pinnedFor(code);
  if (pin?.user && recentUserPinHolds(code, hub)) {
    return { lat: Number(pin.lat), lng: Number(pin.lng), source: 'user-pin' };
  }
  if (hub && Number.isFinite(Number(hub.lat)) && Number.isFinite(Number(hub.lng))) {
    return { lat: Number(hub.lat), lng: Number(hub.lng), source: hub.source || 'hub' };
  }
  const open = openIncidentForBoat(code, data);
  if (open && Number.isFinite(Number(open.lat)) && Number.isFinite(Number(open.lng))) {
    return { lat: Number(open.lat), lng: Number(open.lng), source: 'incident' };
  }
  const fb = fallbackLatLngForBoat(code, index, data);
  return { ...fb, source: 'fallback' };
}

function resolveUniqueSeed(code, lat, lng, occupied) {
  // Cho phép đè/chồng trong phạm vi bến chuẩn — không đẩy tàu khác ra ngoài.
  occupied.push({ lat, lng, code });
  return { lat, lng };
}

function renderBoatOptions(data) {
  const boats = catalogBoats(data);
  const previous = selectedBoatCode || boatSelectEl.value;
  boatSelectEl.innerHTML = [
    '<option value="">Chọn tàu...</option>',
    ...boats.map((boat) => {
      const max = Number(boat.maxSpeedKmh) || '';
      const name = boat.boatName ? ` · ${boat.boatName}` : '';
      const maxText = max ? ` · max ${max}` : '';
      const dbTag = boatDbStatusLabel(boat.boatCode, data);
      const statusTag = dbTag && dbTag !== 'Hoạt động' ? ` · ${dbTag}` : '';
      return `<option value="${escapeHtml(boat.boatCode)}">${escapeHtml(boat.boatCode)}${escapeHtml(name)}${escapeHtml(maxText)}${escapeHtml(statusTag)}</option>`;
    }),
  ].join('');
  if (previous && [...boatSelectEl.options].some((o) => o.value === previous)) {
    boatSelectEl.value = previous;
    selectedBoatCode = previous;
  }
  updateDeviceHint();
  syncBoatControls();
}

function updateDeviceHint() {
  const code = selectedBoatCode || boatSelectEl.value;
  if (!code) {
    deviceHintEl.textContent = 'Chuột phải tàu → Mở khóa kéo để di chuyển.';
    deviceHintEl.className = 'live-hint';
    return;
  }
  const trip = activeTripForBoat(code);
  if (trip) {
    const spd = Number.isFinite(Number(trip.speedKmh)) ? Math.round(Number(trip.speedKmh)) : 0;
    const nextLabel = tripNextStopLabel(trip);
    deviceHintEl.textContent = nextLabel
      ? `${code} · trip ${trip.status} · ${nextLabel} · ${spd} km/h · khóa kéo tay`
      : `${code} · trip ${trip.status} · ${spd} km/h · khóa kéo tay`;
    deviceHintEl.className = 'live-hint is-ok';
    return;
  }
  const device = deviceForBoat(code);
  const unlocked = canDragBoat(code);
  const lockText = unlocked ? 'đã mở khóa — kéo được' : (dragLockReason(code) || 'đang khóa — chuột phải → Mở khóa kéo');
  if (device) {
    deviceHintEl.textContent = `${code} · device ${device} · ${lockText}.`;
    deviceHintEl.className = `live-hint ${unlocked ? 'is-ok' : 'is-warn'}`;
  } else {
    deviceHintEl.textContent = `${code} · chưa thấy gps_devices · ${lockText}.`;
    deviceHintEl.className = 'live-hint is-warn';
  }
}

function activeTripForBoat(code, data = latest) {
  const key = String(code || '').trim();
  if (!key) return null;
  const list = Array.isArray(data?.tripMissions) ? data.tripMissions : [];
  return list.find((row) => {
    if (String(row.boatCode || '').trim() !== key) return false;
    return ['Pending', 'ToDeparture', 'Boarding', 'Running', 'WaitingAtStop', 'Paused'].includes(String(row.status || ''));
  }) || null;
}

/** Ví dụ: "Ba Son · 1.2 km · ~8p" */
function tripNextStopLabel(trip) {
  if (!trip) return '';
  const name = String(trip.nextStopName || trip.nextStopCode || '').trim();
  const km = Number(trip.nextStopDistanceKm);
  const eta = Number(trip.nextStopEtaMin);
  const parts = [];
  if (name) parts.push(name);
  if (Number.isFinite(km) && km >= 0 && km < 100) {
    parts.push(km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 1 : 0)} km`);
  }
  if (Number.isFinite(eta) && eta >= 0 && eta < 24 * 60) {
    parts.push(eta < 1 ? '<1p' : `~${Math.round(eta)}p`);
  }
  return parts.join(' · ');
}

/** Ưu tiên tốc độ trip GPS / hub; fallback tốc độ kéo tay local. */
function displaySpeedKmh(code, data = latest) {
  const trip = activeTripForBoat(code, data);
  if (trip && Number.isFinite(Number(trip.speedKmh))) {
    return Math.max(0, Math.round(Number(trip.speedKmh)));
  }
  const hub = (data?.hubBoats || []).find((b) => String(b.boatCode || '').trim() === String(code || '').trim());
  const hubSpeed = Number(hub?.speedKmh);
  if (Number.isFinite(hubSpeed) && hubSpeed > 0) {
    return Math.max(0, Math.round(hubSpeed));
  }
  return getBoatSpeedKmh(code);
}

function canDragBoat(code) {
  const key = String(code || '').trim();
  if (!key || key !== String(unlockedBoatCode || '').trim()) return false;
  // Trip GPS đang sở hữu — không cho kéo tay.
  if (activeTripForBoat(key)) return false;
  // Cứu hộ tự động cũng không kéo tay SOS / tàu sự cố.
  if (isBoatInActiveAutomatedRescue(key)) return false;
  return true;
}

function dragLockReason(code) {
  const key = String(code || '').trim();
  if (!key) return '';
  const trip = activeTripForBoat(key);
  if (trip) return `Đang trip (${trip.status}) — GPS tự chạy, không kéo tay`;
  if (isBoatInActiveAutomatedRescue(key)) return 'Đang cứu hộ tự động — không kéo tay';
  if (key === String(unlockedBoatCode || '').trim()) return '';
  return 'đang khóa — chuột phải → Mở khóa kéo';
}

function hideBoatContextMenu() {
  if (!boatContextMenuEl) return;
  boatContextMenuEl.hidden = true;
  contextMenuBoatCode = '';
}

function showBoatContextMenu(code, clientX, clientY) {
  if (!boatContextMenuEl) return;
  contextMenuBoatCode = code;
  if (boatCtxTitleEl) boatCtxTitleEl.textContent = boatDisplayName(code) || code;
  if (boatCtxToggleLockBtn) {
    const trip = activeTripForBoat(code);
    const rescue = isBoatInActiveAutomatedRescue(code);
    if (trip || rescue) {
      boatCtxToggleLockBtn.textContent = trip ? 'Đang trip — không kéo' : 'Đang cứu hộ — không kéo';
      boatCtxToggleLockBtn.disabled = true;
    } else {
      boatCtxToggleLockBtn.disabled = false;
      boatCtxToggleLockBtn.textContent = canDragBoat(code) ? 'Khóa di chuyển' : 'Mở khóa kéo';
    }
  }
  boatContextMenuEl.hidden = false;
  const pad = 8;
  const { offsetWidth: w, offsetHeight: h } = boatContextMenuEl;
  const x = Math.min(Math.max(pad, clientX), window.innerWidth - w - pad);
  const y = Math.min(Math.max(pad, clientY), window.innerHeight - h - pad);
  boatContextMenuEl.style.left = `${x}px`;
  boatContextMenuEl.style.top = `${y}px`;
}

function unlockBoat(code) {
  const key = String(code || '').trim();
  if (!key) return;
  if (activeTripForBoat(key)) {
    lockBoat(key);
    toast(`${boatDisplayName(key)} — đang trip, không mở khóa kéo`, 'warn');
    syncBoatControls();
    if (latest) renderHubBoats(latest.hubBoats);
    return;
  }
  if (isBoatInActiveAutomatedRescue(key)) {
    lockBoat(key);
    toast(`${boatDisplayName(key)} — đang cứu hộ, không mở khóa kéo`, 'warn');
    syncBoatControls();
    if (latest) renderHubBoats(latest.hubBoats);
    return;
  }
  unlockedBoatCode = key;
  selectBoat(key, { toastMessage: false });
  toast(`${boatDisplayName(key)} — đã mở khóa, kéo bằng chuột`, 'ok');
}

function lockBoat(code) {
  const key = String(code || '').trim();
  if (key && unlockedBoatCode === key) unlockedBoatCode = '';
  else if (!key) unlockedBoatCode = '';
  if (key) {
    const st = getStatus(key);
    const pin = pinnedFor(key);
    if (!st.incident && pin) {
      setStatus(key, { phase: autoPhaseForBoat(key, pin.lat, pin.lng) });
    }
  }
  updateDeviceHint();
  if (latest) renderHubBoats(latest.hubBoats);
  toast(key ? `${boatDisplayName(key)} — đã khóa di chuyển` : 'Đã khóa di chuyển', 'warn');
}

function getBoatSpeedKmh(code) {
  const key = String(code || '').trim();
  const stored = Number(boatSpeeds.get(key));
  if (Number.isFinite(stored) && stored >= 0) return Math.min(80, stored);
  return DEFAULT_SPEED_KMH;
}

function setBoatSpeedKmh(code, speed) {
  const key = String(code || '').trim();
  if (!key) return;
  const n = Number(speed);
  const value = Number.isFinite(n) ? Math.max(0, Math.min(80, n)) : DEFAULT_SPEED_KMH;
  boatSpeeds.set(key, value);
  persistMap(STORAGE_SPEEDS, boatSpeeds);
  return value;
}

function normalizeHeading(deg) {
  const n = Number(deg);
  if (!Number.isFinite(n)) return 0;
  return ((n % 360) + 360) % 360;
}

function getBoatHeading(code, hub = null) {
  const key = String(code || '').trim();
  // Hub/Azure là SoT — localStorage chỉ dùng khi chưa có hub (hoặc đang xoay tay).
  const hubRow = hub || (latest?.hubBoats || []).find((b) => String(b.boatCode) === key);
  if (hubRow && Number.isFinite(Number(hubRow.heading))) {
    return normalizeHeading(hubRow.heading);
  }
  const stored = boatHeadings.get(key);
  if (stored != null && Number.isFinite(Number(stored))) return normalizeHeading(stored);
  return 0;
}

/** Đồng bộ heading hiển thị từ hub — local/Railway cùng mũi tàu. */
function syncHeadingsFromHub(hubBoats) {
  let changed = false;
  for (const boat of hubBoats || []) {
    const code = String(boat?.boatCode || '').trim();
    if (!code || !Number.isFinite(Number(boat.heading))) continue;
    const next = normalizeHeading(boat.heading);
    const prev = boatHeadings.get(code);
    if (prev == null || Math.abs(normalizeHeading(prev) - next) > 0.5) {
      boatHeadings.set(code, next);
      changed = true;
    }
  }
  if (changed) persistMap(STORAGE_HEADINGS, boatHeadings);
}

function setBoatHeading(code, deg) {
  const key = String(code || '').trim();
  if (!key) return 0;
  const value = normalizeHeading(deg);
  boatHeadings.set(key, value);
  persistMap(STORAGE_HEADINGS, boatHeadings);
  return value;
}

async function applyBoatHeading(code, deg, { announce = true } = {}) {
  const key = String(code || '').trim();
  if (!key) return 0;
  if (activeTripForBoat(key) || isBoatInActiveAutomatedRescue(key)) {
    if (announce) toast(dragLockReason(key) || 'GPS đang tự chạy — không xoay tay', 'warn');
    return getBoatHeading(key);
  }
  const value = setBoatHeading(key, deg);
  const pin = pinnedFor(key);
  const hub = (latest?.hubBoats || []).find((b) => String(b.boatCode) === key);
  const marker = hubMarkers.get(key);
  if (marker) {
    const catalogBoat = catalogBoats().find((b) => String(b.boatCode) === key);
    const lat = pin?.lat ?? Number(hub?.lat);
    const lng = pin?.lng ?? Number(hub?.lng);
    const st = getStatus(key);
    const inIncident = Boolean(st.incident || openIncidentForBoat(key) || boatDbStatus(key) === 'incident');
    marker.setIcon(boatIcon(value, {
      drag: canDragBoat(key),
      signal: !inIncident && hasSignal(key, hub),
      incident: inIncident,
      maintenance: !inIncident && boatDbStatus(key) === 'undermaintenance',
      rescue: isRescueBoat(key),
      decks: boatDeckCount(key, catalogBoat),
    }));
  }
  if (headingHintEl && key === selectedBoatCode) {
    headingHintEl.textContent = `Hướng ${Math.round(value)}° · phím ← → xoay · ↑ Bắc · ↓ Nam`;
  }
  if (pin && Number.isFinite(pin.lat) && Number.isFinite(pin.lng)) {
    await sendLiveGps(key, pin.lat, pin.lng, { quiet: !announce });
  } else if (announce) {
    toast(`${boatDisplayName(key)} · hướng ${Math.round(value)}°`, 'ok');
  }
  return value;
}

async function rotateBoatBy(code, deltaDeg) {
  const key = String(code || '').trim();
  if (!key) return 0;
  return applyBoatHeading(key, getBoatHeading(key) + Number(deltaDeg || 0));
}

function syncBoatControls() {
  const code = selectedBoatCode;
  const disabled = !code;
  const trip = activeTripForBoat(code);
  // Trip / cứu hộ → thu hồi khóa kéo nếu đang mở.
  if (code && (trip || isBoatInActiveAutomatedRescue(code))) {
    if (String(unlockedBoatCode || '').trim() === code) unlockedBoatCode = '';
  }
  if (incidentBtn) incidentBtn.disabled = disabled;
  if (speedInputEl) {
    if (trip) {
      // GPS tự điều tốc theo lịch — chỉ hiển thị, không sửa tay.
      speedInputEl.disabled = true;
      speedInputEl.value = String(displaySpeedKmh(code));
      speedInputEl.title = `GPS tự điều theo lịch (${trip.status})`;
    } else {
      speedInputEl.disabled = disabled;
      speedInputEl.title = '';
      if (code) speedInputEl.value = String(getBoatSpeedKmh(code));
      else speedInputEl.value = String(DEFAULT_SPEED_KMH);
    }
  }
  const rotateLocked = Boolean(trip || (code && isBoatInActiveAutomatedRescue(code)));
  for (const btn of [
    rotateLeftBtn, rotateRightBtn, headNorthBtn, headSouthBtn, headEastBtn, headWestBtn,
  ]) {
    if (btn) btn.disabled = disabled || rotateLocked;
  }
  if (headingHintEl) {
    if (trip) {
      headingHintEl.textContent = `Trip ${trip.status} — GPS tự chạy, không kéo/xoay tay`;
    } else if (code && isBoatInActiveAutomatedRescue(code)) {
      headingHintEl.textContent = 'Đang cứu hộ — GPS tự chạy, không kéo/xoay tay';
    } else {
      headingHintEl.textContent = code
        ? `Hướng ${Math.round(getBoatHeading(code))}° · phím ← → xoay · ↑ Bắc · ↓ Nam`
        : 'Phím ← → xoay · ↑ Bắc · ↓ Nam (khi đã chọn tàu).';
    }
  }
  updateIncidentButton();
  updateDeviceHint();
}

function updateIncidentButton() {
  if (!incidentBtn) return;
  const open = openIncidentForBoat(selectedBoatCode);
  const st = getStatus(selectedBoatCode);
  const active = Boolean(open || st.incident);
  incidentBtn.textContent = active ? 'Đóng sự cố' : 'Báo sự cố';
  incidentBtn.classList.toggle('is-danger', !active);
  incidentBtn.classList.toggle('is-ok', active);
}

function renderStations(stations) {
  const seen = new Set();
  for (const station of stations || []) {
    if (!station?.stationId || !Number.isFinite(Number(station.lat)) || !Number.isFinite(Number(station.lng))) continue;
    seen.add(station.stationId);
    let marker = stationLayers.get(station.stationId);
    const tip = `${station.stationCode || ''} · ${station.stationName || ''}`.trim();
    if (!marker) {
      marker = L.marker([station.lat, station.lng], {
        icon: stationIcon(station.stationCode),
        zIndexOffset: 200,
        interactive: true,
      }).addTo(map);
      marker.bindTooltip(tip, { direction: 'top', offset: [0, -28] });
      stationLayers.set(station.stationId, marker);
    } else {
      marker.setLatLng([station.lat, station.lng]);
      marker.setTooltipContent(tip);
    }
  }
  for (const [id, marker] of stationLayers) {
    if (!seen.has(id)) {
      marker.remove();
      stationLayers.delete(id);
    }
  }
}

function renderRoutes(routes, stations, riverCorridor) {
  const seen = new Set();
  const bounds = [];

  // Live: không vẽ đường Neon / corridor đè lên map (tàu vẫn bám path phía server).
  // Chỉ fit bounds theo bến nếu chưa fit.
  for (const [id, layer] of [...routeLayers.entries()]) {
    layer.remove();
    routeLayers.delete(id);
  }

  for (const station of stations || []) {
    if (!Number.isFinite(Number(station?.lat)) || !Number.isFinite(Number(station?.lng))) continue;
    bounds.push([Number(station.lat), Number(station.lng)]);
  }
  // Giữ tham số để tương thích caller — không render polyline.
  void routes;
  void riverCorridor;
  void seen;

  if (!hasFitRoutes && bounds.length) {
    hasFitRoutes = true;
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 14 });
  }
}

function renderHubBoats(hubBoats) {
  // Tọa độ sự cố từ FE/BE phải giống nhau ở cả hai bản đồ, không giữ pin cũ.
  syncOpenIncidentPins();
  // Hub GPS mới (không phải pin user) → cập nhật vị trí hiển thị.
  syncLiveHubPins(hubBoats);
  // Mission cứu hộ ghi đè sau — bám currentLat/incidentCurrentLat khi đang kéo.
  syncAutomatedRescuePins(hubBoats);
  // Đang survey: tạm ẩn tàu đó khỏi Live (Survey vẫn gửi GPS riêng).
  clearSurveyBoatFromLive();
  syncHeadingsFromHub(hubBoats);
  const hubByCode = new Map();
  for (const boat of hubBoats || []) {
    const code = String(boat.boatCode || '').trim();
    if (!code) continue;
    if (code === activeSurveyBoatCode()) continue;
    hubByCode.set(code, boat);
  }

  const catalog = catalogBoats();
  const codes = mapBoatCodes(latest, hubBoats);
  const codeSet = new Set(codes);
  const updateMsByCode = new Map(
    codes.map((code) => [code, boatUpdateMs(code, hubByCode, latest)]),
  );
  const newestMs = Math.max(0, ...updateMsByCode.values());
  // Giữ pin tàu sự cố / đang trên map; chỉ xóa pin tàu thật sự không còn liên quan.
  for (const code of [...pinnedPositions.keys()]) {
    if (!codeSet.has(code) && !openIncidentForBoat(code)) pinnedPositions.delete(code);
  }
  persistPins();

  const occupied = [];
  let index = 0;
  for (const code of codes) {
    const hub = hubByCode.get(code);
    const open = openIncidentForBoat(code);
    let seed;
    if (hub && Number.isFinite(Number(hub.lat)) && Number.isFinite(Number(hub.lng))) {
      seed = { lat: Number(hub.lat), lng: Number(hub.lng) };
    } else if (open && Number.isFinite(Number(open.lat)) && Number.isFinite(Number(open.lng))) {
      seed = { lat: Number(open.lat), lng: Number(open.lng) };
    } else {
      seed = fallbackLatLngForBoat(code, index, latest);
    }
    // Neo pin theo hub — nhưng không đè pin kéo tay còn hiệu lực.
    if (!(dragging && draggingBoatCode === code && pinnedFor(code)?.user)) {
      if (!recentUserPinHolds(code, hub)) {
        pinBoatPosition(code, seed.lat, seed.lng, { user: false });
      }
    }
    occupied.push({ ...seed, code });
    index += 1;
  }

  // Hiển thị đúng GPS hub — không dùng pin localStorage lệch domain.
  const displayPos = new Map();
  index = 0;
  for (const code of codes) {
    const hub = hubByCode.get(code);
    const pos = boatMapLatLng(code, hub, index, latest);
    displayPos.set(code, { lat: pos.lat, lng: pos.lng });
    index += 1;
  }

  const seen = new Set();
  const selected = selectedBoatCode;
  index = 0;
  let topMarker = null;
  let topUpdateMs = -1;

  for (const code of codes) {
    const hub = hubByCode.get(code);
    const catalogBoat = catalog.find((b) => String(b.boatCode) === code);
    const fixed = displayPos.get(code) || boatMapLatLng(code, hub, index, latest);
    const trueLat = fixed.lat;
    const trueLng = fixed.lng;
    const show = fixed;
    seen.add(code);
    index += 1;

    const isSelected = code === selected;
    const isDraggingSelected = isSelected && dragging;
    const st = getStatus(code);
    const phase = autoPhaseForBoat(code, trueLat, trueLng);
    const signal = hasSignal(code, hub);
    const heading = getBoatHeading(code, hub);
    const decks = boatDeckCount(code, catalogBoat);
    const popupHtml = boatPopupHtml(code, catalogBoat, hub, trueLat, trueLng);
    const tip = [
      boatDisplayName(code, catalogBoat, hub),
      decks >= 2 ? '2 tầng' : '1 tầng',
      boatDbStatusLabel(code),
      canDragBoat(code) ? 'đã mở khóa' : '',
    ].filter(Boolean).join(' · ');
    const canDrag = canDragBoat(code);
    const inIncident = Boolean(st.incident || phase === 'incident' || openIncidentForBoat(code));
    const updateMs = updateMsByCode.get(code) || 0;
    const zIndex = boatMarkerZIndex(code, {
      selected: isSelected,
      canDrag,
      rescue: isRescueBoat(code),
      incident: inIncident || boatDbStatus(code) === 'incident',
      updateMs,
      newestMs,
    });

    const iconOpts = {
      drag: canDrag,
      signal: !inIncident && signal,
      incident: inIncident || boatDbStatus(code) === 'incident',
      maintenance: !inIncident && boatDbStatus(code) === 'undermaintenance',
      rescue: isRescueBoat(code),
      phase,
      decks,
    };

    let marker = hubMarkers.get(code);
    if (!marker) {
      marker = L.marker([show.lat, show.lng], {
        icon: boatIcon(heading, iconOpts),
        draggable: canDrag,
        zIndexOffset: zIndex,
        autoPan: true,
      }).addTo(map);
      marker.bindPopup(popupHtml, {
        closeButton: true,
        autoClose: true,
        closeOnClick: true,
        className: 'live-boat-popup-wrap',
        offset: [0, -12],
      });
      marker.bindTooltip(tip, {
        direction: 'top',
        offset: [0, -18],
        opacity: 1,
        className: 'live-boat-hover-tip',
      });
      marker.on('popupopen', () => openPopupCode.add(code));
      marker.on('popupclose', () => openPopupCode.delete(code));
      marker.on('click', () => selectBoat(code));
      marker.on('contextmenu', (event) => {
        L.DomEvent.preventDefault(event);
        L.DomEvent.stop(event);
        const oe = event.originalEvent || event;
        showBoatContextMenu(code, oe.clientX, oe.clientY);
      });
      bindDragHandlers(marker, code);
      hubMarkers.set(code, marker);
    } else if (isDraggingSelected && canDrag) {
      // đang kéo — không đụng popup/icon
    } else {
      marker.setLatLng([show.lat, show.lng]);
      marker.setIcon(boatIcon(heading, iconOpts));
      marker.dragging?.[canDrag ? 'enable' : 'disable']?.();
      marker.setZIndexOffset(zIndex);
      marker.setPopupContent(popupHtml);
      if (marker.getTooltip()) marker.setTooltipContent(tip);
      else {
        marker.bindTooltip(tip, {
          direction: 'top',
          offset: [0, -18],
          opacity: 1,
          className: 'live-boat-hover-tip',
        });
      }
      marker.off('click');
      marker.off('contextmenu');
      marker.on('click', () => selectBoat(code));
      marker.on('contextmenu', (event) => {
        L.DomEvent.preventDefault(event);
        L.DomEvent.stop(event);
        const oe = event.originalEvent || event;
        showBoatContextMenu(code, oe.clientX, oe.clientY);
      });
      bindDragHandlers(marker, code);
      if (openPopupCode.has(code) && !marker.isPopupOpen()) marker.openPopup();
    }

    if (marker && updateMs >= topUpdateMs && !isDraggingSelected) {
      topUpdateMs = updateMs;
      topMarker = marker;
    }
  }

  // Tàu vừa đổi GPS/status → đưa lên trên cùng khi chồng marker.
  if (topMarker && typeof topMarker.setZIndexOffset === 'function') {
    const cur = Number(topMarker.options?.zIndexOffset) || 700;
    topMarker.setZIndexOffset(Math.max(cur, 1250));
    if (typeof topMarker.bringToFront === 'function') topMarker.bringToFront();
  }

  for (const [code, marker] of hubMarkers) {
    if (!seen.has(code)) {
      marker.remove();
      hubMarkers.delete(code);
    }
  }

  if (selected && hubMarkers.has(selected) && !dragging) {
    const marker = hubMarkers.get(selected);
    if (canDragBoat(selected)) marker.dragging?.enable?.();
    else marker.dragging?.disable?.();
    marker.setZIndexOffset(1200);
    bindDragHandlers(marker, selected);
    const pin = pinnedFor(selected);
    if (pin) coordStatusEl.textContent = `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`;
  }

  if (boatPhaseStatusEl) {
    if (selected && pinnedFor(selected)) {
      const pin = pinnedFor(selected);
      boatPhaseStatusEl.textContent = phaseStatusText(selected, pin.lat, pin.lng) || '—';
    } else {
      boatPhaseStatusEl.textContent = '—';
    }
  }
  if (boatDbStatusEl) {
    boatDbStatusEl.textContent = selected ? boatDbStatusLabel(selected) : '—';
  }
  if (boatRouteStatusEl) {
    boatRouteStatusEl.textContent = selected
      ? (routeLabelForBoat(selected) || 'Chưa gán lộ trình')
      : '—';
  }

  centerBoatBtn.disabled = !selected || !hubMarkers.has(selected);
  if (sendNowBtn) {
    const tripLock = selected && (activeTripForBoat(selected) || isBoatInActiveAutomatedRescue(selected));
    sendNowBtn.disabled = !selected || !hubMarkers.has(selected) || tripLock;
    sendNowBtn.title = tripLock ? 'Đang trip/cứu hộ — GPS tự gửi' : '';
  }
  syncBoatControls();
}

function selectBoat(code, { toastMessage = false } = {}) {
  const key = String(code || '').trim();
  if (!key) return;
  selectedBoatCode = key;
  localStorage.setItem('liveGpsBoatCode', key);
  if (boatSelectEl) boatSelectEl.value = key;
  updateDeviceHint();
  syncBoatControls();
  if (latest) renderHubBoats(latest.hubBoats);
  const marker = hubMarkers.get(key);
  if (marker) {
    if (canDragBoat(key)) marker.dragging?.enable?.();
    else marker.dragging?.disable?.();
    map.panTo(marker.getLatLng(), { animate: true });
  }
  if (toastMessage) {
    toast(
      canDragBoat(key)
        ? `${boatDisplayName(key)} — kéo để di chuyển`
        : `${boatDisplayName(key)} — chuột phải → Mở khóa kéo`,
      canDragBoat(key) ? 'ok' : 'warn',
    );
  }
}

function bindDragHandlers(marker, code) {
  marker.off('dragstart');
  marker.off('drag');
  marker.off('dragend');
  marker.on('dragstart', () => {
    if (!canDragBoat(code)) {
      marker.dragging?.disable?.();
      toast(dragLockReason(code) || 'Tàu đang khóa — không kéo tay', 'warn');
      return;
    }
    hideBoatContextMenu();
    dragging = true;
    draggingBoatCode = String(code || '').trim();
  });
  marker.on('drag', () => {
    if (!canDragBoat(code)) return;
    dragging = true;
    draggingBoatCode = String(code || '').trim();
    const { lat, lng } = marker.getLatLng();
    coordStatusEl.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    if (boatPhaseStatusEl) boatPhaseStatusEl.textContent = phaseStatusText(code, lat, lng) || '—';
  });
  marker.on('dragend', async () => {
    if (!canDragBoat(code) && !dragging) return;
    dragging = false;
    draggingBoatCode = '';
    if (!canDragBoat(code)) {
      const pin = pinnedFor(code);
      if (pin) marker.setLatLng([pin.lat, pin.lng]);
      return;
    }
    let { lat, lng } = marker.getLatLng();
    const rescueResult = handleRescueDragEnd(code, lat, lng);
    lat = rescueResult.lat;
    lng = rescueResult.lng;
    if (rescueResult.handled) marker.setLatLng([lat, lng]);
    // Không auto-snap về tâm bến — đặt đâu giữ đó.
    const near = nearestStation({ lat, lng }, latest?.stations || []);
    if (near && !rescueResult.handled) {
      setStatus(code, { phase: 'arrived', incident: Boolean(openIncidentForBoat(code)) });
    } else if (!rescueResult.handled) {
      const st = getStatus(code);
      if (!st.incident) setStatus(code, { phase: missionForRescue(code) ? 'enroute' : 'stopped' });
    } else {
      setStatus(code, { phase: missionForRescue(code)?.phase === 'completed' ? 'arrived' : 'enroute' });
    }
    pinBoatPosition(code, lat, lng, { user: true });
    marker.setLatLng([lat, lng]);
    coordStatusEl.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    if (boatPhaseStatusEl) boatPhaseStatusEl.textContent = phaseStatusText(code, lat, lng) || '—';
    if (boatRouteStatusEl) {
      boatRouteStatusEl.textContent = routeLabelForBoat(code) || 'Chưa gán lộ trình';
    }
    await sendLiveGps(code, lat, lng);
  });
}

async function sendLiveGps(boatCode, lat, lng, { quiet = false } = {}) {
  if (!quiet && sending) return { ok: false, skipped: true, reason: 'busy' };
  // Kéo/gửi tay: không đè trip/rescue. Heartbeat (quiet) vẫn gửi liên tục.
  if (!quiet && (activeTripForBoat(boatCode) || isBoatInActiveAutomatedRescue(boatCode))) {
    toast(dragLockReason(boatCode) || 'GPS đang tự chạy — không gửi tay', 'warn');
    return { ok: false, skipped: true, reason: 'locked' };
  }
  if (!quiet) {
    sending = true;
    sendStatusEl.textContent = 'Đang gửi…';
  }
  // Heartbeat: không pin trước POST — tránh đè marker bằng hub cũ rồi Azure mới (nhảy qua lại).
  // Chỉ pin khi user kéo/gửi tay.
  if (!quiet) {
    pinBoatPosition(boatCode, lat, lng, { user: true });
  }
  const st = getStatus(boatCode);
  const phase = autoPhaseForBoat(boatCode, lat, lng);
  const cruise = getBoatSpeedKmh(boatCode);
  const userDriven = !quiet;
  const rescueMission = missionForRescue(boatCode);
  const trip = activeTripForBoat(boatCode);
  const moving = (userDriven || Boolean(trip) || Boolean(rescueMission))
    && !st.incident
    && (phase === 'enroute' || phase === 'departing' || phase === 'approaching'
      || rescueMission?.phase === 'to_incident' || rescueMission?.phase === 'returning'
      || (trip && ['Pending', 'ToDeparture', 'Boarding', 'Running', 'WaitingAtStop'].includes(String(trip.status || ''))));
  const status = st.incident ? 'idle' : (moving ? 'moving' : 'idle');
  const speedKmh = moving
    ? (Number(trip?.speedKmh) > 0 ? Number(trip.speedKmh) : cruise)
    : 0;
  const sendToTarget = sendAzureSelectEl.value === 'on';
  try {
    const response = await fetch('/api/live/gps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        boatCode,
        lat,
        lng,
        speedKmh,
        heading: getBoatHeading(boatCode),
        status,
        sendToTarget,
        quiet,
        holdAuthority: !quiet,
      }),
    });
    const body = await response.json();
    if (body?.skipped) {
      if (!quiet && sendStatusEl) {
        sendStatusEl.textContent = body.soft
          ? `Skip survey · ${boatCode}`
          : `Skip · ${body.mode || 'owned'}`;
      } else if (sendStatusEl && String(selectedBoatCode || '') === String(boatCode)) {
        sendStatusEl.textContent = body.soft
          ? `Đang survey — tạm dừng Live GPS`
          : `Skip · ${body.mode || 'owned'}`;
      }
      const reason = body.soft
        ? 'survey'
        : (body.mode === 'rescue-owned' ? 'rescue' : (body.mode === 'trip-owned' ? 'trip' : 'skip'));
      return {
        ok: Boolean(body.ok) || Boolean(body.soft),
        skipped: true,
        soft: Boolean(body.soft),
        reason,
        status: body.status || response.status,
        error: body.error || null,
      };
    }
    if (!response.ok || body.ok === false) {
      if (!quiet) {
        const msg = body.error || `HTTP ${response.status}`;
        sendStatusEl.textContent = `Lỗi ${response.status}`;
        toast(msg, 'err');
      } else if (sendStatusEl && String(selectedBoatCode || '') === String(boatCode)) {
        sendStatusEl.textContent = `Heartbeat lỗi · ${body.status || response.status}`;
      }
      return {
        ok: false,
        skipped: false,
        reason: 'error',
        status: body.status || response.status,
        error: body.error || `HTTP ${response.status}`,
      };
    }
    markSignal(boatCode);
    if (!quiet) {
      pinBoatPosition(boatCode, lat, lng, { user: true });
      // Cập nhật latest.hubBoats ngay — tránh renderHubBoats(stale) nhảy về chỗ cũ.
      if (latest) {
        const hubs = Array.isArray(latest.hubBoats) ? [...latest.hubBoats] : [];
        const idx = hubs.findIndex((b) => String(b.boatCode) === String(boatCode));
        const merged = {
          ...(idx >= 0 ? hubs[idx] : {}),
          boatCode,
          lat: Number(lat),
          lng: Number(lng),
          speedKmh,
          heading: getBoatHeading(boatCode),
          status,
          source: 'live',
          recordedAt: new Date().toISOString(),
          receivedAt: new Date().toISOString(),
          isOnline: true,
        };
        if (idx >= 0) hubs[idx] = merged;
        else hubs.push(merged);
        latest = { ...latest, hubBoats: hubs };
      }
    }
    const mode = body.mode === 'follow-azure'
      ? 'follow Azure'
      : (body.mode === 'local' ? 'local' : `Azure ${body.status || 200}`);
    if (!quiet) {
      sendStatusEl.textContent = `OK · seq ${body.sequence || '—'} · ${mode}`;
      if (body.warning) toast(body.warning, 'warn');
      else toast(`Đã gửi GPS ${boatDisplayName(boatCode)}`, 'ok');
      if (latest) renderHubBoats(latest.hubBoats);
    } else if (sendStatusEl && String(selectedBoatCode || '') === String(boatCode)) {
      sendStatusEl.textContent = `Heartbeat · seq ${body.sequence || '—'} · ${mode}`;
    }
    return {
      ok: true,
      skipped: false,
      reason: 'sent',
      sequence: body.sequence || null,
      mode: body.mode || null,
      status: body.status || response.status,
    };
  } catch (error) {
    if (!quiet) {
      sendStatusEl.textContent = 'Lỗi mạng';
      toast(error.message, 'err');
    } else if (sendStatusEl && String(selectedBoatCode || '') === String(boatCode)) {
      sendStatusEl.textContent = 'Heartbeat lỗi mạng';
    }
    return { ok: false, skipped: false, reason: 'network', error: error.message };
  } finally {
    if (!quiet) sending = false;
  }
}

function renderGpsScan(scan) {
  lastGpsScan = scan;
  if (!gpsScanSummaryEl) return;
  if (!scan) {
    gpsScanSummaryEl.textContent = 'Chưa quét';
    if (gpsScanDetailEl) {
      gpsScanDetailEl.hidden = true;
      gpsScanDetailEl.innerHTML = '';
    }
    return;
  }
  const ok = scan.results.filter((r) => r.reason === 'sent').length;
  const skip = scan.results.filter((r) => r.skipped).length;
  const fail = scan.results.filter((r) => !r.ok && !r.skipped).length;
  const time = new Date(scan.at).toLocaleTimeString('vi-VN', { hour12: false });
  const parts = [`${scan.results.length} tàu`, `${ok} OK`];
  if (skip) parts.push(`${skip} skip`);
  if (fail) parts.push(`${fail} lỗi`);
  parts.push(time);
  gpsScanSummaryEl.textContent = parts.join(' · ');

  if (!gpsScanDetailEl) return;
  gpsScanDetailEl.hidden = false;
  gpsScanDetailEl.innerHTML = scan.results.map((r) => {
    let cls = 'is-fail';
    let mark = '✗';
    let note = r.status || r.error || '';
    if (r.reason === 'sent') {
      cls = 'is-ok';
      mark = '✓';
      note = r.status || '200';
    } else if (r.skipped) {
      cls = 'is-skip';
      mark = '⊘';
      note = r.reason || 'skip';
    }
    return `<span class="live-scan-chip ${cls}" title="${escapeHtml(r.error || r.reason || '')}">${escapeHtml(r.boatCode)} ${mark} ${escapeHtml(String(note))}</span>`;
  }).join('');
}

async function heartbeatAllBoats() {
  // Gửi GPS liên tục mọi tàu (kể cả đang trip / sắp cập bến) — không để "Chưa gửi".
  if (heartbeatBusy || dragging || sending) return;
  heartbeatBusy = true;
  const results = [];
  try {
    const surveyCode = activeSurveyBoatCode();
    const codes = catalogBoats().map((b) => String(b.boatCode).trim()).filter(Boolean);
    if (gpsScanSummaryEl) {
      gpsScanSummaryEl.textContent = `Đang quét ${codes.length} tàu…`;
    }
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i];
      if (surveyCode && code === surveyCode) {
        results.push({
          boatCode: code,
          ok: true,
          skipped: true,
          reason: 'survey',
          status: 200,
          error: 'Đang survey — tạm dừng Live GPS',
        });
        continue;
      }
      const pin = pinnedFor(code) || fallbackLatLngForBoat(code, i, latest);
      ensureSeedPin(code, pin.lat, pin.lng);
      const fixed = pinnedFor(code) || pin;
      // Ưu tiên pin kéo tay còn hiệu lực — tránh heartbeat gửi lại hub/Azure cũ.
      const hub = (latest?.hubBoats || []).find((b) => String(b.boatCode || '').trim() === code);
      let lat;
      let lng;
      if (fixed?.user && recentUserPinHolds(code, hub)) {
        lat = Number(fixed.lat);
        lng = Number(fixed.lng);
      } else if (Number.isFinite(Number(hub?.lat)) && Number.isFinite(Number(hub?.lng))) {
        lat = Number(hub.lat);
        lng = Number(hub.lng);
      } else {
        lat = Number(fixed.lat);
        lng = Number(fixed.lng);
      }
      const result = await sendLiveGps(
        code,
        lat,
        lng,
        { quiet: true },
      );
      results.push({
        boatCode: code,
        ok: Boolean(result?.ok),
        skipped: Boolean(result?.skipped),
        reason: result?.reason || (result?.ok ? 'sent' : 'error'),
        status: result?.status || null,
        sequence: result?.sequence || null,
        error: result?.error || null,
      });
      await new Promise((r) => setTimeout(r, 120));
    }
    renderGpsScan({ at: Date.now(), results });
    if (latest) renderHubBoats(latest.hubBoats);
  } finally {
    heartbeatBusy = false;
  }
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    heartbeatAllBoats().catch(() => {});
  }, HEARTBEAT_MS);
  // Gửi ngay vòng đầu sau khi có dữ liệu.
  setTimeout(() => heartbeatAllBoats().catch(() => {}), 800);
}

function renderStatus(data) {
  const st = data?.config?.signalrStatus || {};
  if (st.connected) {
    hubStatusEl.textContent = 'SignalR relay OK';
  } else if (st.boatsLatestOkAt) {
    hubStatusEl.textContent = `Poll latest · ${st.boatsLatestError || 'OK'}`;
  } else {
    hubStatusEl.textContent = st.lastError || 'Đang nối…';
  }

  const ih = data?.config?.incidentsHubStatus || {};
  if (incidentsHubStatusEl) {
    const mode = data?.config?.incidentReceiveMode;
    if (mode === 'hook') incidentsHubStatusEl.textContent = 'Webhook (không JWT)';
    else if (ih.connected) incidentsHubStatusEl.textContent = 'Incidents hub OK';
    else if (!data?.config?.hasBearerToken) incidentsHubStatusEl.textContent = 'Thiếu JWT / hook';
    else incidentsHubStatusEl.textContent = ih.lastError || 'Đang nối…';
  }
  if (incidentsHubHintEl) {
    const n = openIncidentsList(data).length;
    const mode = data?.config?.incidentReceiveMode;
    const modeHint = mode === 'hook'
      ? 'webhook'
      : (data?.config?.hasBearerToken ? 'JWT' : 'local/demo');
    incidentsHubHintEl.textContent = `${n} sự cố mở · nhận qua ${modeHint}`;
    incidentsHubHintEl.className = `live-hint ${n ? 'is-warn' : ''}`;
  }

  if (sendAzureSelectEl.dataset.seeded !== '1') {
    // Local mặc định tắt ghi Azure (theo config.liveAzureWrite) — tránh lệch vị trí với Railway.
    const canWrite = data?.config?.liveAzureWrite !== false && data?.config?.senderEnabled !== false;
    sendAzureSelectEl.value = canWrite ? 'on' : 'off';
    sendAzureSelectEl.dataset.seeded = '1';
  }
}

function renderIncidentsPanel(data = latest) {
  if (!incidentsListEl) return;
  const rows = openIncidentsList(data);
  if (!rows.length) {
    incidentsListEl.innerHTML = '<p class="live-incidents-empty">Chưa có sự cố mở.</p>';
    return;
  }
  incidentsListEl.innerHTML = rows.map((row) => {
    const title = row.boatName || row.boatCode || row.boatId || 'Tàu';
    const meta = [
      row.severity || null,
      row.incidentType || null,
      row.rescueBoatCode || row.replacementBoatCode
        ? `cứu: ${row.rescueBoatCode || row.replacementBoatCode}`
        : null,
      row.source === 'local' ? 'local' : null,
    ].filter(Boolean).join(' · ');
    const desc = row.description || '';
    const mission = missionForIncident(row.incidentId);
    const autoMission = (data?.rescueMissions || []).find(
      (m) => String(m.incidentId || '') === String(row.incidentId || ''),
    );
    const autoStatus = String(autoMission?.status || '');
    let missionText = '';
    if (autoStatus === 'AtStation' || autoStatus === 'Completed') {
      const stName = autoMission.destinationStationName
        || autoMission.destinationStationCode
        || 'bến';
      missionText = `Đã về ${stName} · đã nhả tàu cứu`;
    } else if (autoStatus === 'Towing') {
      const stName = autoMission.destinationStationName
        || autoMission.destinationStationCode
        || 'bến';
      missionText = `Đang kéo về ${stName}`;
    } else if (autoStatus === 'InTransit' || autoStatus === 'Dispatched') {
      missionText = `Tàu cứu đang tới hiện trường`;
    } else if (mission) {
      missionText = rescuePhaseLabel(mission.rescueBoatCode) || 'Cứu hộ';
    } else if (row.replacementBoatCode) {
      missionText = 'Chờ kéo tàu cứu';
    }
    return `
      <article class="live-incident-item" data-incident-id="${escapeHtml(row.incidentId)}">
        <strong>${escapeHtml(title)}</strong>
        <p class="live-incident-meta">${escapeHtml(meta || 'Open')}</p>
        ${missionText ? `<p class="live-incident-meta live-incident-mission">${escapeHtml(missionText)}</p>` : ''}
        ${desc ? `<p class="live-incident-meta">${escapeHtml(desc)}</p>` : ''}
        <div class="live-incident-actions">
          <select class="rescue-select" aria-label="Chọn tàu cứu">
            <option value="">Chọn tàu cứu…</option>
            ${rescueBoatOptionsHtml(row.boatCode)}
          </select>
          <div class="row">
            <button type="button" class="assign-rescue secondary">Điều tàu</button>
            <button type="button" class="resolve-incident secondary is-ok">Đóng</button>
          </div>
          <button type="button" class="focus-rescue secondary" ${(row.rescueBoatCode || row.replacementBoatCode) ? '' : 'disabled'}>Kéo tàu cứu</button>
          <button type="button" class="focus-incident secondary">Focus sự cố</button>
        </div>
      </article>
    `;
  }).join('');

  for (const item of incidentsListEl.querySelectorAll('.live-incident-item')) {
    const incidentId = item.getAttribute('data-incident-id');
    const row = rows.find((r) => r.incidentId === incidentId);
    const select = item.querySelector('.rescue-select');
    if (select && (row?.rescueBoatCode || row?.replacementBoatCode)) {
      select.value = row.rescueBoatCode || row.replacementBoatCode;
    }
    item.querySelector('.assign-rescue')?.addEventListener('click', () => {
      const code = select?.value || '';
      if (!code) {
        toast('Chọn tàu cứu trước', 'warn');
        return;
      }
      assignRescue(incidentId, code);
    });
    item.querySelector('.resolve-incident')?.addEventListener('click', () => {
      resolveOpenIncident(incidentId);
    });
    item.querySelector('.focus-rescue')?.addEventListener('click', () => {
      const code = row?.rescueBoatCode || row?.replacementBoatCode || select?.value || '';
      if (!code) {
        toast('Chưa gán tàu cứu', 'warn');
        return;
      }
      if (!missionForIncident(incidentId)) startRescueMission(row, { announce: true });
      unlockBoat(code);
      selectBoat(code, { toastMessage: true });
    });
    item.querySelector('.focus-incident')?.addEventListener('click', () => {
      focusIncident(row);
    });
  }
}

function focusIncident(row) {
  if (!row) return;
  const code = row.boatCode;
  if (code) selectBoat(code, { toastMessage: false });
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    map.setView([lat, lng], Math.max(map.getZoom(), 15), { animate: true });
    return;
  }
  const marker = code ? hubMarkers.get(code) : null;
  if (marker) map.setView(marker.getLatLng(), Math.max(map.getZoom(), 15), { animate: true });
}

async function reportIncidentForSelected() {
  if (!selectedBoatCode || incidentBusy) return;
  const open = openIncidentForBoat(selectedBoatCode);
  if (open) {
    await resolveOpenIncident(open.incidentId);
    return;
  }
  const pin = pinnedFor(selectedBoatCode);
  const boatId = boatIdForCode(selectedBoatCode);
  if (!boatId) {
    toast('Không tìm thấy boatId trong DB', 'err');
    return;
  }
  incidentBusy = true;
  try {
    const res = await fetch('/api/incidents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        boatId,
        boatCode: selectedBoatCode,
        lat: pin?.lat,
        lng: pin?.lng,
        severity: 'High',
        incidentType: 'OperationalIssue',
        description: `Báo sự cố từ Live GPS · ${boatDisplayName(selectedBoatCode)}`,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && !body.ok) {
      toast(body.error || `Báo sự cố thất bại (${res.status})`, 'err');
      return;
    }
    if (body.incident) {
      setStatus(selectedBoatCode, { incident: true, phase: 'incident' });
    }
    if (body.boatStatus) {
      toast(`${boatDisplayName(selectedBoatCode)}: ${body.boatStatus === 'Incident' ? 'Sự cố' : body.boatStatus === 'UnderMaintenance' ? 'Bảo trì' : body.boatStatus}`, 'warn');
    }
    if (body.warning) toast(body.warning, 'warn');
    else if (!body.boatStatus) toast(`${boatDisplayName(selectedBoatCode)}: đã báo sự cố`, 'warn');
    syncBoatControls();
    if (latest) renderHubBoats(latest.hubBoats);
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    incidentBusy = false;
  }
}

async function assignRescue(incidentId, rescueBoatCode) {
  if (!incidentId || !rescueBoatCode || incidentBusy) return;
  incidentBusy = true;
  try {
    const res = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}/assign-replacement-boat`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        replacementBoatCode: rescueBoatCode,
        note: `Điều ${rescueBoatCode} cứu hộ từ Live GPS`,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && !body.ok) {
      toast(body.error || `Điều tàu thất bại (${res.status})`, 'err');
      return;
    }
    if (body.warning) toast(body.warning, 'warn');
    else toast(`Đã điều ${rescueBoatCode} cứu hộ`, 'ok');
    const incident = body.incident || openIncidentsList().find((r) => r.incidentId === incidentId);
    if (incident) {
      incident.replacementBoatCode = rescueBoatCode;
      startRescueMission(incident, { announce: true });
    }
    if (latest) {
      renderHubBoats(latest.hubBoats);
      renderRescueOverlays(latest);
    }
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    incidentBusy = false;
  }
}

async function resolveOpenIncident(incidentId) {
  if (!incidentId || incidentBusy) return;
  incidentBusy = true;
  try {
    // Backup resolve khi GPS callback lỗi — body khớp contract BE.
    const res = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}/resolve`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resolutionNote: 'Tàu đã được kéo về bến và chuyển sang bảo trì.',
        boatStatus: 'UnderMaintenance',
        tripStatus: null,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && !body.ok) {
      toast(body.error || `Đóng sự cố thất bại (${res.status})`, 'err');
      return;
    }
    if (body.boatCode) setStatus(body.boatCode, { incident: false, phase: 'stopped' });
    rescueMissions.delete(incidentId);
    persistRescueMissions();
    if (body.warning) toast(body.warning, 'warn');
    else toast('Đã đóng sự cố', 'ok');
    syncBoatControls();
    await pullSnapshot({ force: true });
    // BE có thể cập nhật boat/incident chậm vài giây sau resolve.
    setTimeout(() => {
      fetch('/api/incidents/refresh', { method: 'POST' }).catch(() => {});
      pullSnapshot({ force: true }).catch(() => {});
    }, 2500);
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    incidentBusy = false;
  }
}

function maybeToastNewIncidents(data) {
  const rows = openIncidentsList(data);
  const openIds = new Set(rows.map((r) => String(r.incidentId || '').trim()).filter(Boolean));
  for (const id of [...toastedIncidentIds]) {
    if (!openIds.has(id)) toastedIncidentIds.delete(id);
  }
  for (const key of [...toastedRescueKeys]) {
    const id = key.split(':')[0];
    if (!openIds.has(id)) toastedRescueKeys.delete(key);
  }

  // Lần đầu vào trang: seed im lặng, không spam toast cho sự cố đã mở sẵn.
  if (!incidentToastSeeded) {
    for (const row of rows) {
      const id = String(row.incidentId || '').trim();
      if (!id) continue;
      toastedIncidentIds.add(id);
      const rescue = String(row.rescueBoatCode || row.replacementBoatCode || '').trim();
      if (rescue) toastedRescueKeys.add(`${id}:${rescue}`);
    }
    incidentToastSeeded = true;
    return;
  }

  for (const row of rows) {
    const id = String(row.incidentId || '').trim();
    if (!id) continue;
    const rescue = String(row.rescueBoatCode || row.replacementBoatCode || '').trim();
    if (rescue) {
      const rescueKey = `${id}:${rescue}`;
      if (toastedRescueKeys.has(rescueKey)) continue;
      toastedRescueKeys.add(rescueKey);
      toastedIncidentIds.add(id);
      toast(
        `BE điều cứu: ${rescue} → ${row.boatName || row.boatCode}`,
        'ok',
        5000,
      );
      continue;
    }
    if (toastedIncidentIds.has(id)) continue;
    toastedIncidentIds.add(id);
    const status = boatDbStatusLabel(row.boatCode, data);
    toast(
      `BE sự cố: ${row.boatName || row.boatCode || 'tàu'} · ${status}`,
      'warn',
      4500,
    );
  }
}

function render(data) {
  latest = data;
  const stamp = document.querySelector('#buildStamp');
  if (stamp && data?.config?.commitShort) {
    stamp.textContent = `build ${data.config.commitShort}`;
    stamp.title = data.config.commit || data.config.commitShort;
  }
  // Tàu vừa nhận trip / cứu hộ → thu hồi unlock tay.
  if (unlockedBoatCode) {
    const unlocked = String(unlockedBoatCode).trim();
    if (activeTripForBoat(unlocked) || isBoatInActiveAutomatedRescue(unlocked)) {
      unlockedBoatCode = '';
    }
  }
  syncLocalIncidentFlags();
  maybeToastNewIncidents(data);
  syncRescueMissionsFromIncidents(data);
  renderBoatOptions(data);
  renderRoutes(data.routes, data.stations, data.riverCorridor);
  renderStations(data.stations);
  renderHubBoats(data.hubBoats);
  renderRescueOverlays(data);
  renderIncidentsPanel(data);
  renderStatus(data);
  syncBoatControls();
}

async function pullSnapshot({ force = false } = {}) {
  if (snapshotPollBusy) return;
  // SSE đang sống và mới nhận data → không cần poll (trừ force).
  if (!force && sseAlive && lastEventsAt && (Date.now() - lastEventsAt) < 4000) return;
  snapshotPollBusy = true;
  try {
    const response = await fetch(`/api/snapshot?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    if (data && typeof data === 'object' && !data.error) {
      lastEventsAt = Date.now();
      render(data);
    }
  } catch {
    // ignore — sẽ thử lại vòng poll sau
  } finally {
    snapshotPollBusy = false;
  }
}

function startSnapshotPoll() {
  if (snapshotPollTimer) clearInterval(snapshotPollTimer);
  snapshotPollTimer = setInterval(() => {
    pullSnapshot().catch(() => {});
  }, 2000);
  // Lấy ngay 1 snapshot khi vào trang / khi SSE chết.
  pullSnapshot({ force: true }).catch(() => {});
}

function scheduleEventsReconnect() {
  if (eventsReconnectTimer) return;
  const delay = eventsBackoffMs;
  eventsBackoffMs = Math.min(15000, Math.round(eventsBackoffMs * 1.6));
  eventsReconnectTimer = setTimeout(() => {
    eventsReconnectTimer = null;
    connectEvents();
  }, delay);
}

function connectEvents() {
  if (eventsSource) {
    eventsSource.onmessage = null;
    eventsSource.onerror = null;
    try { eventsSource.close(); } catch { /* ignore */ }
    eventsSource = null;
  }
  sseAlive = false;
  try {
    eventsSource = new EventSource(`/events?t=${Date.now()}`);
  } catch {
    scheduleEventsReconnect();
    return;
  }
  eventsSource.onopen = () => {
    sseAlive = true;
    eventsBackoffMs = 1000;
  };
  eventsSource.onmessage = (message) => {
    try {
      const data = JSON.parse(message.data);
      lastEventsAt = Date.now();
      sseAlive = true;
      eventsBackoffMs = 1000;
      render(data);
    } catch {
      // ignore
    }
  };
  eventsSource.onerror = () => {
    sseAlive = false;
    try { eventsSource?.close(); } catch { /* ignore */ }
    eventsSource = null;
    // SSE chết → poll snapshot ngay để SOS vẫn chạy trên map.
    pullSnapshot({ force: true }).catch(() => {});
    scheduleEventsReconnect();
  };
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // Tab tỉnh lại sau ERR_NETWORK_IO_SUSPENDED — reconnect + snapshot.
  eventsBackoffMs = 1000;
  pullSnapshot({ force: true }).catch(() => {});
  if (!sseAlive) connectEvents();
});

window.addEventListener('online', () => {
  eventsBackoffMs = 1000;
  pullSnapshot({ force: true }).catch(() => {});
  connectEvents();
});

boatSelectEl.addEventListener('change', () => {
  hideBoatContextMenu();
  selectedBoatCode = boatSelectEl.value.trim();
  if (selectedBoatCode) localStorage.setItem('liveGpsBoatCode', selectedBoatCode);
  else localStorage.removeItem('liveGpsBoatCode');
  updateDeviceHint();
  syncBoatControls();
  if (latest) renderHubBoats(latest.hubBoats);
  const marker = hubMarkers.get(selectedBoatCode);
  if (marker) {
    map.panTo(marker.getLatLng(), { animate: true });
  }
});

boatCtxToggleLockBtn?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  const code = contextMenuBoatCode;
  hideBoatContextMenu();
  if (!code) return;
  if (activeTripForBoat(code) || isBoatInActiveAutomatedRescue(code)) {
    unlockBoat(code); // sẽ toast từ chối
    return;
  }
  if (canDragBoat(code)) lockBoat(code);
  else unlockBoat(code);
});

async function headingActionFromContext(degOrDelta, { delta = false } = {}) {
  const code = contextMenuBoatCode || selectedBoatCode;
  hideBoatContextMenu();
  if (!code) return;
  selectBoat(code, { toastMessage: false });
  if (delta) await rotateBoatBy(code, degOrDelta);
  else await applyBoatHeading(code, degOrDelta);
}

boatCtxRotateLeftBtn?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  headingActionFromContext(-HEADING_STEP_DEG, { delta: true });
});
boatCtxRotateRightBtn?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  headingActionFromContext(HEADING_STEP_DEG, { delta: true });
});
boatCtxHeadNorthBtn?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  headingActionFromContext(0);
});
boatCtxHeadEastBtn?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  headingActionFromContext(90);
});
boatCtxHeadSouthBtn?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  headingActionFromContext(180);
});
boatCtxHeadWestBtn?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  headingActionFromContext(270);
});

rotateLeftBtn?.addEventListener('click', () => {
  if (selectedBoatCode) rotateBoatBy(selectedBoatCode, -HEADING_STEP_DEG);
});
rotateRightBtn?.addEventListener('click', () => {
  if (selectedBoatCode) rotateBoatBy(selectedBoatCode, HEADING_STEP_DEG);
});
headNorthBtn?.addEventListener('click', () => {
  if (selectedBoatCode) applyBoatHeading(selectedBoatCode, 0);
});
headEastBtn?.addEventListener('click', () => {
  if (selectedBoatCode) applyBoatHeading(selectedBoatCode, 90);
});
headSouthBtn?.addEventListener('click', () => {
  if (selectedBoatCode) applyBoatHeading(selectedBoatCode, 180);
});
headWestBtn?.addEventListener('click', () => {
  if (selectedBoatCode) applyBoatHeading(selectedBoatCode, 270);
});

document.addEventListener('click', (event) => {
  if (!boatContextMenuEl || boatContextMenuEl.hidden) return;
  if (boatContextMenuEl.contains(event.target)) return;
  hideBoatContextMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    const overlay = document.querySelector('#surveyOverlay');
    if (overlay && !overlay.hidden) {
      closeSurveyOverlay();
      return;
    }
    hideBoatContextMenu();
    return;
  }
  const tag = String(event.target?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea' || event.target?.isContentEditable) {
    return;
  }
  const code = selectedBoatCode;
  if (!code) return;
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    if (event.shiftKey) applyBoatHeading(code, 270);
    else rotateBoatBy(code, -HEADING_STEP_DEG);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    if (event.shiftKey) applyBoatHeading(code, 90);
    else rotateBoatBy(code, HEADING_STEP_DEG);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    applyBoatHeading(code, 0);
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    applyBoatHeading(code, 180);
  }
});

map.on('movestart zoomstart click', hideBoatContextMenu);

speedInputEl?.addEventListener('change', () => {
  if (!selectedBoatCode) return;
  if (activeTripForBoat(selectedBoatCode)) {
    speedInputEl.value = String(displaySpeedKmh(selectedBoatCode));
    toast('Đang chạy trip — GPS tự điều tốc, không chỉnh tay', 'warn');
    return;
  }
  const value = setBoatSpeedKmh(selectedBoatCode, speedInputEl.value);
  speedInputEl.value = String(value);
  toast(`${boatDisplayName(selectedBoatCode)} · ${value} km/h`, 'ok');
});

speedInputEl?.addEventListener('input', () => {
  if (!selectedBoatCode) return;
  if (activeTripForBoat(selectedBoatCode)) {
    speedInputEl.value = String(displaySpeedKmh(selectedBoatCode));
    return;
  }
  setBoatSpeedKmh(selectedBoatCode, speedInputEl.value);
});

incidentBtn?.addEventListener('click', () => {
  reportIncidentForSelected().catch(() => {});
});

refreshIncidentsBtn?.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/incidents/refresh', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && !body.ok) toast(body.error || 'Không tải được sự cố', 'warn');
    else toast(`Đã tải ${body.count ?? 0} sự cố mở`, body.error ? 'warn' : 'ok');
  } catch (error) {
    toast(error.message, 'err');
  }
});

centerBoatBtn.addEventListener('click', () => {
  const marker = hubMarkers.get(selectedBoatCode);
  if (!marker) return;
  map.setView(marker.getLatLng(), Math.max(map.getZoom(), 15), { animate: true });
});

sendNowBtn?.addEventListener('click', async () => {
  const pin = pinnedFor(selectedBoatCode);
  const marker = hubMarkers.get(selectedBoatCode);
  if (!marker || !selectedBoatCode || !pin) {
    toast('Chọn tàu trước', 'warn');
    return;
  }
  if (activeTripForBoat(selectedBoatCode) || isBoatInActiveAutomatedRescue(selectedBoatCode)) {
    toast(dragLockReason(selectedBoatCode) || 'GPS đang tự chạy — không gửi tay', 'warn');
    return;
  }
  let { lat, lng } = pin;
  // Giữ đúng chỗ user đặt — không kéo về tâm bến khi gửi GPS.
  const near = nearestStation({ lat, lng }, latest?.stations || []);
  if (near) {
    setStatus(selectedBoatCode, {
      phase: 'arrived',
      incident: Boolean(openIncidentForBoat(selectedBoatCode)),
    });
  }
  pinBoatPosition(selectedBoatCode, lat, lng, { user: true });
  marker.setLatLng([lat, lng]);
  coordStatusEl.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  await sendLiveGps(selectedBoatCode, lat, lng);
});

refreshBtn.addEventListener('click', async () => {
  try {
    await fetch('/api/refresh', { method: 'POST' });
    toast('Đã làm mới dữ liệu', 'ok');
  } catch (error) {
    toast(error.message, 'err');
  }
});

const openSurveyBtn = document.querySelector('#openSurveyBtn');
const closeSurveyBtn = document.querySelector('#closeSurveyBtn');
const surveyOverlayEl = document.querySelector('#surveyOverlay');
const surveyFrameEl = document.querySelector('#surveyFrame');

function openSurveyOverlay() {
  if (!surveyOverlayEl || !surveyFrameEl) return;
  hideBoatContextMenu();
  if (!surveyFrameEl.src || surveyFrameEl.src === 'about:blank' || surveyFrameEl.getAttribute('src') === 'about:blank') {
    surveyFrameEl.src = '/survey?embed=1';
  }
  surveyOverlayEl.hidden = false;
  document.body.classList.add('survey-open');
}

function closeSurveyOverlay() {
  if (!surveyOverlayEl) return;
  surveyOverlayEl.hidden = true;
  document.body.classList.remove('survey-open');
  // Giải phóng SSE/map Survey khi đóng — lần mở sau load lại.
  if (surveyFrameEl) surveyFrameEl.src = 'about:blank';
}

openSurveyBtn?.addEventListener('click', openSurveyOverlay);
closeSurveyBtn?.addEventListener('click', closeSurveyOverlay);

const livePanelEl = document.querySelector('#livePanel');
const toggleLivePanelBtn = document.querySelector('#toggleLivePanelBtn');
const STORAGE_PANEL = 'liveGpsPanelCollapsed.v1';

function setLivePanelCollapsed(collapsed) {
  if (!livePanelEl || !toggleLivePanelBtn) return;
  livePanelEl.classList.toggle('is-collapsed', collapsed);
  toggleLivePanelBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  toggleLivePanelBtn.title = collapsed ? 'Mở rộng panel' : 'Thu gọn panel';
  try {
    localStorage.setItem(STORAGE_PANEL, collapsed ? '1' : '0');
  } catch {
    // ignore
  }
}

toggleLivePanelBtn?.addEventListener('click', () => {
  const next = !livePanelEl?.classList.contains('is-collapsed');
  setLivePanelCollapsed(next);
});

try {
  setLivePanelCollapsed(localStorage.getItem(STORAGE_PANEL) === '1');
} catch {
  setLivePanelCollapsed(false);
}

async function resyncAzurePositions() {
  try {
    const response = await fetch('/api/live/resync-positions', { method: 'POST' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      console.warn('[resync]', body.error || response.status);
      return false;
    }
    // Xóa pin thường; giữ pin kéo tay còn trong cửa sổ (tránh F5 về chỗ cũ).
    for (const [code, pin] of [...pinnedPositions.entries()]) {
      if (!pin?.user) {
        pinnedPositions.delete(code);
        continue;
      }
      const age = Date.now() - (Number(pin.at) || 0);
      if (!(age >= 0 && age <= USER_PIN_HOLD_MS)) pinnedPositions.delete(code);
    }
    persistPins();
    await pullSnapshot({ force: true });
    if (gpsScanSummaryEl) {
      gpsScanSummaryEl.textContent = `Đồng bộ Azure · ${body.count || 0} tàu · ${body.commit || ''}`;
    }
    return true;
  } catch (error) {
    console.warn('[resync]', error.message);
    return false;
  }
}

connectEvents();
startSnapshotPoll();
resyncAzurePositions().finally(() => {
  startHeartbeat();
});
