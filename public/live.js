const SNAP_STATION_M = 60;
const APPROACH_M = 180;
const SIGNAL_TTL_MS = 120_000;
const HEARTBEAT_MS = 5000;
const CLUSTER_M = 25;
const ROUTE_STYLE = {
  color: '#0f766e',
  weight: 2.5,
  opacity: 0.14,
  smoothFactor: 0,
};
const WATERBUS_CORRIDOR_CODES = [
  'ST-BD', 'ST-TT', 'ST-BA', 'ST-TD2', 'ST-TD', 'ST-HBC', 'ST-LD',
];
const STORAGE_PINS = 'liveGpsBoatPins.v1';
const STORAGE_STATUS = 'liveGpsBoatStatus.v1';
const STORAGE_SPEEDS = 'liveGpsBoatSpeeds.v1';
const STORAGE_RESCUE = 'liveGpsRescueMissions.v1';
const STORAGE_HEADINGS = 'liveGpsBoatHeadings.v1';
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
    if (!['Dispatched', 'InTransit', 'Arrived', 'Towing', 'AtStation'].includes(status)) return false;
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

    // Server đang chạy: vẽ đường theo autoMission (không phụ thuộc localMission).
    if (
      (autoStatus === 'Dispatched' || autoStatus === 'InTransit')
      && rescuePin
    ) {
      // Ưu tiên pin tàu sự cố live (gần nhất) — không bám targetLat stale.
      const destLat = Number(
        incidentPin?.lat ?? autoMission?.targetLat ?? target.lat,
      );
      const destLng = Number(
        incidentPin?.lng ?? autoMission?.targetLng ?? target.lng,
      );
      if (!Number.isFinite(destLat) || !Number.isFinite(destLng)) continue;
      const toPoints = [
        [rescuePin.lat, rescuePin.lng],
        [destLat, destLng],
      ];
      if (!overlay.toLine) {
        overlay.toLine = L.polyline(toPoints, {
          color: '#7c3aed',
          weight: 4,
          dashArray: '10 8',
          opacity: 0.85,
        }).addTo(map);
      } else {
        overlay.toLine.setLatLngs(toPoints);
        if (!map.hasLayer(overlay.toLine)) overlay.toLine.addTo(map);
      }
      if (overlay.returnLine) {
        overlay.returnLine.remove();
        overlay.returnLine = null;
      }
      if (overlay.towLine) {
        overlay.towLine.remove();
        overlay.towLine = null;
      }
      continue;
    }

    // Đang kéo: nối đuôi tàu cứu → tàu lỗi (dây kéo), rồi tới bến.
    if (autoStatus === 'Towing' && rescuePin && incidentPin) {
      const towPoints = [
        [rescuePin.lat, rescuePin.lng],
        [incidentPin.lat, incidentPin.lng],
      ];
      if (!overlay.towLine) {
        overlay.towLine = L.polyline(towPoints, {
          color: '#7c3aed',
          weight: 5,
          opacity: 0.95,
        }).addTo(map);
      } else {
        overlay.towLine.setLatLngs(towPoints);
        if (!map.hasLayer(overlay.towLine)) overlay.towLine.addTo(map);
      }

      const stationLat = Number(autoMission.targetLat ?? localMission?.departureLat);
      const stationLng = Number(autoMission.targetLng ?? localMission?.departureLng);
      if (Number.isFinite(stationLat) && Number.isFinite(stationLng)) {
        const returnPoints = [[rescuePin.lat, rescuePin.lng], [stationLat, stationLng]];
        if (!overlay.returnLine) {
          overlay.returnLine = L.polyline(returnPoints, {
            color: '#0f766e',
            weight: 3,
            dashArray: '6 6',
            opacity: 0.55,
          }).addTo(map);
        } else {
          overlay.returnLine.setLatLngs(returnPoints);
          if (!map.hasLayer(overlay.returnLine)) overlay.returnLine.addTo(map);
        }
      }
      if (overlay.toLine) overlay.toLine.remove();
      continue;
    }

    if (overlay.towLine) {
      overlay.towLine.remove();
      overlay.towLine = null;
    }

    if (!localMission || localMission.phase === 'completed' || !rescueCode || !rescuePin) continue;
    // Có server mission đang chạy / đã xong → không vẽ path local (tránh tím ảo khi SOS đứng bến).
    if (autoMission && autoStatus) continue;

    const toPoints = [[rescuePin.lat, rescuePin.lng], [target.lat, target.lng]];
    const returnPoints = Number.isFinite(localMission.departureLat)
      ? [[target.lat, target.lng], [localMission.departureLat, localMission.departureLng]]
      : null;

    if (!overlay.toLine) {
      overlay.toLine = L.polyline(toPoints, {
        color: '#7c3aed',
        weight: 4,
        dashArray: '10 8',
        opacity: 0.85,
      }).addTo(map);
    } else {
      overlay.toLine.setLatLngs(toPoints);
      if (!map.hasLayer(overlay.toLine)) overlay.toLine.addTo(map);
    }

    if (localMission.phase === 'at_incident' || localMission.phase === 'returning') {
      if (!overlay.returnLine && returnPoints) {
        overlay.returnLine = L.polyline(returnPoints, {
          color: '#0f766e',
          weight: 3,
          dashArray: '6 6',
          opacity: 0.55,
        }).addTo(map);
      } else if (overlay.returnLine && returnPoints) {
        overlay.returnLine.setLatLngs(returnPoints);
        if (!map.hasLayer(overlay.returnLine)) overlay.returnLine.addTo(map);
      }
    } else if (overlay.returnLine) {
      overlay.returnLine.remove();
    }
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

/** Khi đang ghi GPS survey — Live theo collector, không giữ tàu tại pin bến cũ. */
function syncSurveyCollectorPin(data = latest) {
  const collector = data?.collector;
  const code = String(collector?.boatCode || '').trim();
  if (!code) return;
  const lat = Number(collector.lat);
  const lng = Number(collector.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  const status = String(collector.status || '').toLowerCase();
  if (!['moving', 'paused', 'completed'].includes(status)) return;
  pinBoatPosition(code, lat, lng, { user: false });
}

/** Cập nhật pin từ hub GPS — trừ khi user đang kéo tay hoặc đang cứu hộ tự động.
 *  Giữ vị trí cuối nếu hub nhảy xa bất thường (tránh teleport khi Azure/SSE lệch).
 */
function syncLiveHubPins(hubBoats) {
  let changed = false;
  for (const boat of hubBoats || []) {
    const code = String(boat?.boatCode || '').trim();
    if (!code) continue;
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
      const speed = Number(boat.speedKmh);
      const moving = Number.isFinite(speed) && speed >= 2;
      // Đứng yên mà nhảy > 40m → giữ pin cũ (vị trí cuối).
      if (!moving && moved > 40) continue;
      // Nhảy quá xa so với tốc độ hợp lý → giữ pin cũ.
      if (moved > 250 && !(moving && speed >= 8)) continue;
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
  // Heartbeat liên tục → mặc định coi là có tín hiệu; chỉ đỏ khi sự cố.
  if (openIncidentForBoat(code)) return false;
  const st = getStatus(code);
  if (st.incident) return false;
  const key = String(code || '').trim();
  const sent = lastSignalAt.get(key) || 0;
  if (Date.now() - sent < SIGNAL_TTL_MS) return true;
  if (hub && hub.isOnline !== false) return true;
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
    // Giữ badge CỨU đến AtStation (sự cố còn mở) — không tắt sớm nhìn như bị xóa.
    const status = String(automated.status || '');
    return ['Dispatched', 'InTransit', 'Arrived', 'Towing', 'AtStation'].includes(status);
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
  const codes = new Set(
    catalogBoats(data).map((b) => String(b.boatCode).trim()).filter(Boolean),
  );
  for (const row of openIncidentsList(data)) {
    const code = String(row.boatCode || '').trim();
    if (code) codes.add(code);
    const rescue = String(row.rescueBoatCode || row.replacementBoatCode || '').trim();
    if (rescue) codes.add(rescue);
    const transfer = String(row.replacementBoatCode || '').trim();
    if (transfer) codes.add(transfer);
  }
  const hubByCode = new Map();
  for (const boat of (hubBoats || data?.hubBoats || [])) {
    const code = String(boat?.boatCode || '').trim();
    if (code) hubByCode.set(code, boat);
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

  const phase = autoPhaseForBoat(code, lat, lng);
  const dbLabel = boatDbStatusLabel(code);
  if (phase === 'incident') {
    const open = openIncidentForBoat(code);
    const base = (open?.rescueBoatCode || open?.replacementBoatCode)
      ? `Sự cố · cứu: ${open.rescueBoatCode || open.replacementBoatCode}`
      : 'Sự cố';
    return dbLabel === 'Bảo trì' ? `${base} · Bảo trì` : base;
  }
  // Không còn sự cố mở nhưng DB vẫn UnderMaintenance.
  if (boatDbStatus(code) === 'undermaintenance') {
    return 'Bảo trì';
  }
  if (phase === 'enroute' || phase === 'departing') {
    return phase === 'departing' ? PHASES.departing : PHASES.enroute;
  }
  if (phase === 'stopped') return PHASES.stopped;
  if (phase === 'approaching') {
    const near = nearestStationAny({ lat, lng }, latest?.stations || []);
    const name = near?.station?.stationName || near?.station?.stationCode || 'bến';
    return `${PHASES.approaching} · ${name}`;
  }
  if (phase === 'arrived') {
    const near = nearestStationAny({ lat, lng }, latest?.stations || []);
    const name = near?.station?.stationName || near?.station?.stationCode || 'bến';
    return `${PHASES.arrived} · ${name}`;
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
  if (pin) return { lat: pin.lat, lng: pin.lng };
  const hub = (data?.hubBoats || []).find((b) => String(b.boatCode) === code);
  if (hub && Number.isFinite(Number(hub.lat)) && Number.isFinite(Number(hub.lng))) {
    return { lat: Number(hub.lat), lng: Number(hub.lng) };
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
  const device = deviceForBoat(code);
  const unlocked = canDragBoat(code);
  const lockText = unlocked ? 'đã mở khóa — kéo được' : 'đang khóa — chuột phải → Mở khóa kéo';
  if (device) {
    deviceHintEl.textContent = `${code} · device ${device} · ${lockText}.`;
    deviceHintEl.className = `live-hint ${unlocked ? 'is-ok' : 'is-warn'}`;
  } else {
    deviceHintEl.textContent = `${code} · chưa thấy gps_devices · ${lockText}.`;
    deviceHintEl.className = 'live-hint is-warn';
  }
}

function canDragBoat(code) {
  const key = String(code || '').trim();
  return Boolean(key) && key === String(unlockedBoatCode || '').trim();
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
    boatCtxToggleLockBtn.textContent = canDragBoat(code) ? 'Khóa di chuyển' : 'Mở khóa kéo';
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
  const stored = boatHeadings.get(key);
  if (stored != null && Number.isFinite(Number(stored))) return normalizeHeading(stored);
  if (hub && Number.isFinite(Number(hub.heading))) return normalizeHeading(hub.heading);
  const fromLatest = (latest?.hubBoats || []).find((b) => String(b.boatCode) === key);
  if (fromLatest && Number.isFinite(Number(fromLatest.heading))) {
    return normalizeHeading(fromLatest.heading);
  }
  return 0;
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
  if (incidentBtn) incidentBtn.disabled = disabled;
  if (speedInputEl) {
    speedInputEl.disabled = disabled;
    if (code) speedInputEl.value = String(getBoatSpeedKmh(code));
    else speedInputEl.value = String(DEFAULT_SPEED_KMH);
  }
  for (const btn of [
    rotateLeftBtn, rotateRightBtn, headNorthBtn, headSouthBtn, headEastBtn, headWestBtn,
  ]) {
    if (btn) btn.disabled = disabled;
  }
  if (headingHintEl) {
    headingHintEl.textContent = code
      ? `Hướng ${Math.round(getBoatHeading(code))}° · phím ← → xoay · ↑ Bắc · ↓ Nam`
      : 'Phím ← → xoay · ↑ Bắc · ↓ Nam (khi đã chọn tàu).';
  }
  updateIncidentButton();
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

function renderRoutes(routes, stations) {
  const seen = new Set();
  const bounds = [];

  for (const route of routes || []) {
    const id = route.routeId;
    const latlngs = (route.coordinates || [])
      .map((p) => [Number(p.lat), Number(p.lng)])
      .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
    if (!id || latlngs.length < 2) continue;
    seen.add(id);

    let layer = routeLayers.get(id);
    const tip = [route.routeCode, route.routeName].filter(Boolean).join(' · ');
    if (!layer) {
      layer = L.polyline(latlngs, { ...ROUTE_STYLE }).addTo(map);
      if (tip) layer.bindTooltip(tip);
      routeLayers.set(id, layer);
    } else {
      layer.setLatLngs(latlngs);
      layer.setStyle({ ...ROUTE_STYLE });
      if (!map.hasLayer(layer)) layer.addTo(map);
    }
    for (const p of latlngs) bounds.push(p);
  }

  if (!seen.size) {
    const byCode = new Map(
      (stations || [])
        .filter((s) => s?.stationCode && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng)))
        .map((s) => [String(s.stationCode).toUpperCase(), s]),
    );
    const latlngs = WATERBUS_CORRIDOR_CODES
      .map((code) => byCode.get(code))
      .filter(Boolean)
      .map((s) => [Number(s.lat), Number(s.lng)]);
    const id = '__waterbus-corridor__';
    if (latlngs.length >= 2) {
      seen.add(id);
      let layer = routeLayers.get(id);
      if (!layer) {
        layer = L.polyline(latlngs, {
          ...ROUTE_STYLE,
          dashArray: '10 10',
          opacity: 0.12,
        }).addTo(map);
        layer.bindTooltip('Hành lang Waterbus (bến DB)');
        routeLayers.set(id, layer);
      } else {
        layer.setLatLngs(latlngs);
        layer.setStyle({ ...ROUTE_STYLE, dashArray: '10 10', opacity: 0.2 });
        if (!map.hasLayer(layer)) layer.addTo(map);
      }
      for (const p of latlngs) bounds.push(p);
    }
  }

  for (const [id, layer] of routeLayers) {
    if (!seen.has(id)) {
      layer.remove();
      routeLayers.delete(id);
    }
  }

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
  // Đang survey: Live bám collector theo đường vẽ (ghi đè pin kéo tay tại bến cũ).
  syncSurveyCollectorPin();
  const hubByCode = new Map();
  for (const boat of hubBoats || []) {
    const code = String(boat.boatCode || '').trim();
    if (!code) continue;
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
    if (!pinnedFor(code)) {
      const unique = resolveUniqueSeed(code, seed.lat, seed.lng, occupied);
      ensureSeedPin(code, unique.lat, unique.lng);
    } else {
      occupied.push({ ...pinnedFor(code), code });
    }
    index += 1;
  }

  // Hiển thị đúng GPS — cho phép nhiều tàu sát/chồng cùng bến, không tách offset.
  const displayPos = new Map();
  for (const code of codes) {
    const pin = pinnedFor(code);
    if (pin) displayPos.set(code, { lat: pin.lat, lng: pin.lng });
  }

  const seen = new Set();
  const selected = selectedBoatCode;
  index = 0;
  let topMarker = null;
  let topUpdateMs = -1;

  for (const code of codes) {
    const hub = hubByCode.get(code);
    const catalogBoat = catalog.find((b) => String(b.boatCode) === code);
    const fixed = pinnedFor(code) || fallbackLatLngForBoat(code, index, latest);
    ensureSeedPin(code, fixed.lat, fixed.lng);
    const trueLat = fixed.lat;
    const trueLng = fixed.lng;
    const show = displayPos.get(code) || fixed;
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
  if (sendNowBtn) sendNowBtn.disabled = !selected || !hubMarkers.has(selected);
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
      toast('Tàu đang khóa — chuột phải → Mở khóa kéo', 'warn');
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
  if (!quiet && sending) return;
  // Đang cứu hộ tự động: server publish GPS — FE heartbeat/Gửi GPS không được đè về bến.
  if (quiet && isBoatInActiveAutomatedRescue(boatCode)) return false;
  if (!quiet) {
    sending = true;
    sendStatusEl.textContent = 'Đang gửi…';
  }
  // Heartbeat không khóa pin user — nếu không, syncAutomatedRescuePins bị chặn và SOS đứng yên.
  pinBoatPosition(boatCode, lat, lng, { user: !quiet });
  const st = getStatus(boatCode);
  const phase = autoPhaseForBoat(boatCode, lat, lng);
  const cruise = getBoatSpeedKmh(boatCode);
  const userDriven = !quiet;
  const rescueMission = missionForRescue(boatCode);
  const moving = userDriven
    && !st.incident
    && (phase === 'enroute' || phase === 'departing' || phase === 'approaching'
      || rescueMission?.phase === 'to_incident' || rescueMission?.phase === 'returning');
  const status = st.incident ? 'idle' : (moving ? 'moving' : 'idle');
  const speedKmh = moving ? cruise : 0;
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
      }),
    });
    const body = await response.json();
    if (!response.ok || body.ok === false) {
      if (!quiet) {
        const msg = body.error || `HTTP ${response.status}`;
        sendStatusEl.textContent = `Lỗi ${response.status}`;
        toast(msg, 'err');
      }
      return false;
    }
    markSignal(boatCode);
    pinBoatPosition(boatCode, lat, lng, { user: !quiet });
    if (!quiet) {
      const mode = body.mode === 'local' ? 'local' : `Azure ${body.status || 200}`;
      sendStatusEl.textContent = `OK · seq ${body.sequence || '—'} · ${mode}`;
      if (body.warning) toast(body.warning, 'warn');
      else toast(`Đã gửi GPS ${boatDisplayName(boatCode)}`, 'ok');
      if (latest) renderHubBoats(latest.hubBoats);
    } else {
      sendStatusEl.textContent = `Heartbeat · ${boatDisplayName(boatCode)} · ${body.status || 200}`;
    }
    return true;
  } catch (error) {
    if (!quiet) {
      sendStatusEl.textContent = 'Lỗi mạng';
      toast(error.message, 'err');
    }
    return false;
  } finally {
    if (!quiet) sending = false;
  }
}

async function heartbeatAllBoats() {
  if (heartbeatBusy || dragging || sending) return;
  if (sendAzureSelectEl?.value !== 'on') return;
  heartbeatBusy = true;
  try {
    const codes = catalogBoats().map((b) => String(b.boatCode).trim()).filter(Boolean);
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i];
      // SOS / tàu đang kéo: server rescue tick publish — không heartbeat đè về bến.
      if (isBoatInActiveAutomatedRescue(code)) continue;
      const pin = pinnedFor(code) || fallbackLatLngForBoat(code, i, latest);
      ensureSeedPin(code, pin.lat, pin.lng);
      const fixed = pinnedFor(code) || pin;
      await sendLiveGps(code, fixed.lat, fixed.lng, { quiet: true });
      // Nhịp nhẹ tránh đụng sequence cùng lúc.
      await new Promise((r) => setTimeout(r, 120));
    }
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
    sendAzureSelectEl.value = data?.config?.senderEnabled === false ? 'off' : 'on';
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
  syncLocalIncidentFlags();
  maybeToastNewIncidents(data);
  syncRescueMissionsFromIncidents(data);
  renderBoatOptions(data);
  renderRoutes(data.routes, data.stations);
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
  const value = setBoatSpeedKmh(selectedBoatCode, speedInputEl.value);
  speedInputEl.value = String(value);
  toast(`${boatDisplayName(selectedBoatCode)} · ${value} km/h`, 'ok');
});

speedInputEl?.addEventListener('input', () => {
  if (!selectedBoatCode) return;
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

connectEvents();
startSnapshotPoll();
startHeartbeat();
