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
const DEFAULT_SPEED_KMH = 16;

const PHASES = {
  prepare: 'Chuẩn bị đi',
  departing: 'Bắt đầu đi',
  enroute: 'Đang đi',
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
const centerBoatBtn = document.querySelector('#centerBoatBtn');
const sendNowBtn = document.querySelector('#sendNowBtn');
const incidentBtn = document.querySelector('#incidentBtn');
const refreshBtn = document.querySelector('#refreshBtn');
const toastHost = document.querySelector('#toastHost');
const boatContextMenuEl = document.querySelector('#boatContextMenu');
const boatCtxTitleEl = document.querySelector('#boatCtxTitle');
const boatCtxDragBtn = document.querySelector('#boatCtxDrag');

let latest = null;
let eventsSource = null;
let selectedBoatCode = localStorage.getItem('liveGpsBoatCode') || '';
let contextMenuBoatCode = '';
let sending = false;
let dragging = false;
let hasFitRoutes = false;
let heartbeatTimer = null;
let heartbeatBusy = false;
const pinnedPositions = loadJsonMap(STORAGE_PINS);
const boatStatuses = loadJsonMap(STORAGE_STATUS);
const boatSpeeds = loadJsonMap(STORAGE_SPEEDS);
const lastSignalAt = new Map();
const openPopupCode = new Set();

const stationLayers = new Map();
const hubMarkers = new Map();
const routeLayers = new Map();

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
  const st = getStatus(code);
  if (st.incident) return false;
  const key = String(code || '').trim();
  const sent = lastSignalAt.get(key) || 0;
  if (Date.now() - sent < SIGNAL_TTL_MS) return true;
  if (hub && hub.isOnline !== false) return true;
  return Boolean(pinnedFor(key));
}

function toast(message, type = 'ok', ms = 3200) {
  if (!toastHost) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function catalogBoats(data = latest) {
  // Chỉ tàu DB Active — inactive / collector / fallback không hiện.
  return (data?.boats || [])
    .filter((boat) => {
      if (!boat.boatCode) return false;
      if (String(boat.boatId || '').startsWith('collector-')) return false;
      if (boat.boatId === 'fallback-boat') return false;
      return String(boat.dbStatus || '').trim().toLowerCase() === 'active';
    })
    .slice()
    .sort((a, b) => String(a.boatCode).localeCompare(String(b.boatCode)));
}

function catalogFingerprint(boats) {
  return (boats || [])
    .map((b) => `${b.boatCode}:${b.boatName || ''}:${b.maxSpeedKmh || ''}:${b.numberOfDecks || ''}`)
    .join('|');
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

function autoPhaseForBoat(code, lat, lng) {
  const st = getStatus(code);
  if (st.incident) return 'incident';
  const near = nearestStationAny({ lat, lng }, latest?.stations || []);
  if (near && near.dist <= SNAP_STATION_M) return 'arrived';
  if (near && near.dist <= APPROACH_M) return 'approaching';
  if (st.phase === 'departing' || st.phase === 'enroute' || st.phase === 'prepare') {
    if (st.phase === 'prepare' && near && near.dist > APPROACH_M) return 'enroute';
    return st.phase === 'prepare' ? 'prepare' : (st.phase === 'departing' ? 'departing' : 'enroute');
  }
  return near && near.dist > APPROACH_M ? 'enroute' : 'prepare';
}

function phaseLabel(code, lat, lng) {
  const phase = autoPhaseForBoat(code, lat, lng);
  if (phase === 'incident') return '';
  if (phase === 'enroute' || phase === 'departing') {
    const next = nextStationAlongCorridor({ lat, lng });
    if (next?.to) {
      const eta = next.etaMin != null ? `${next.etaMin} phút` : '…';
      const name = next.to.stationName || next.to.stationCode || 'bến kế';
      if (phase === 'departing') return `${PHASES.departing} · tới ${name}`;
      return `Còn ${eta} tới ${name}`;
    }
  }
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

function boatDisplayName(code, catalogBoat, hub) {
  return String(catalogBoat?.boatName || hub?.boatName || code || '').trim();
}

function boatPopupHtml(code, catalogBoat, hub, lat, lng) {
  const st = getStatus(code);
  const signal = hasSignal(code, hub);
  const phase = autoPhaseForBoat(code, lat, lng);
  const name = boatDisplayName(code, catalogBoat, hub);
  const label = phaseLabel(code, lat, lng);
  const decks = boatDeckCount(code, catalogBoat);
  const deckText = decks >= 2 ? '2 tầng' : '1 tầng';
  const dotClass = st.incident || phase === 'incident'
    ? 'is-incident'
    : (signal ? 'is-ok' : 'is-off');
  return `
    <div class="live-boat-popup">
      <div class="live-boat-popup-title">
        <i class="live-dot ${dotClass}" aria-hidden="true"></i>
        <span>${escapeHtml(name)}</span>
      </div>
      <div class="live-boat-popup-meta">${escapeHtml(deckText)}</div>
      ${label ? `<div class="live-boat-popup-meta">${escapeHtml(label)}</div>` : ''}
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

function boatColor({ incident, phase, decks }) {
  if (incident || phase === 'incident') return '#dc2626';
  // 1 tầng teal · 2 tầng cam (màu luôn theo tầng, không phụ thuộc tín hiệu)
  if (Number(decks) >= 2) return '#ea580c';
  return '#0f766e';
}

function boatShortLabel(code, catalogBoat) {
  const name = String(catalogBoat?.boatName || code || '').trim();
  const digits = name.match(/(\d{2,})/);
  if (digits) return digits[1];
  return String(code || '').replace(/^WB_?/i, '').slice(0, 4) || '•';
}

function boatIcon(heading = 0, opts = {}) {
  const deg = Number(heading) || 0;
  const fill = boatColor(opts);
  const size = opts.drag ? 52 : 44;
  return L.divIcon({
    className: 'live-boat-wrap',
    html: `
      <div class="live-boat-pin${opts.drag ? ' is-drag' : ''}${opts.signal ? ' has-signal' : ''}" style="--boat:${fill}">
        <div class="live-boat" style="--heading:${deg}deg">
          <span class="live-boat-ring"></span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path fill="${fill}" stroke="#fff" stroke-width="1.5" d="M12 3 L20 19 L12 15 L4 19 Z"></path>
          </svg>
        </div>
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
    className: 'live-station-wrap',
    html: `
      <div class="station-flag live-station-flag">
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

function displayOffset(index, total) {
  if (total <= 1) return { lat: 0, lng: 0 };
  const angle = (index / total) * Math.PI * 2;
  const r = 0.00028;
  return { lat: Math.cos(angle) * r, lng: Math.sin(angle) * r };
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
  return { lat: 10.776 + index * 0.0015, lng: 106.708 };
}

function resolveUniqueSeed(code, lat, lng, occupied) {
  let outLat = lat;
  let outLng = lng;
  let guard = 0;
  while (guard < 12) {
    const clash = occupied.some((p) => distMeters(p, { lat: outLat, lng: outLng }) < CLUSTER_M);
    if (!clash) break;
    const j = occupied.length + guard;
    outLat = lat + Math.cos(j) * 0.0004;
    outLng = lng + Math.sin(j) * 0.0004;
    guard += 1;
  }
  occupied.push({ lat: outLat, lng: outLng, code });
  return { lat: outLat, lng: outLng };
}

let lastBoatOptionsFp = '';

function renderBoatOptions(data) {
  const boats = catalogBoats(data);
  const fp = catalogFingerprint(boats);
  const previous = selectedBoatCode || boatSelectEl.value;

  // Tránh rebuild options mỗi SSE → dropdown khỏi nhảy.
  if (fp === lastBoatOptionsFp) {
    if (previous && boatSelectEl.value !== previous
      && [...boatSelectEl.options].some((o) => o.value === previous)) {
      boatSelectEl.value = previous;
    }
    updateDeviceHint();
    syncBoatControls();
    return;
  }
  lastBoatOptionsFp = fp;

  boatSelectEl.innerHTML = [
    '<option value="">Chọn tàu...</option>',
    ...boats.map((boat) => {
      const max = Number(boat.maxSpeedKmh) || '';
      const name = boat.boatName ? ` · ${boat.boatName}` : '';
      const maxText = max ? ` · max ${max}` : '';
      return `<option value="${escapeHtml(boat.boatCode)}">${escapeHtml(boat.boatCode)}${escapeHtml(name)}${escapeHtml(maxText)}</option>`;
    }),
  ].join('');
  if (previous && [...boatSelectEl.options].some((o) => o.value === previous)) {
    boatSelectEl.value = previous;
    selectedBoatCode = previous;
  } else if (selectedBoatCode && ![...boatSelectEl.options].some((o) => o.value === selectedBoatCode)) {
    selectedBoatCode = '';
    localStorage.removeItem('liveGpsBoatCode');
    boatSelectEl.value = '';
  }
  updateDeviceHint();
  syncBoatControls();
}

function updateDeviceHint() {
  const code = selectedBoatCode || boatSelectEl.value;
  if (!code) {
    deviceHintEl.textContent = 'Chọn tàu đã đăng ký device để kéo trên map.';
    deviceHintEl.className = 'live-hint';
    return;
  }
  const device = deviceForBoat(code);
  if (device) {
    deviceHintEl.textContent = `${code} · device ${device} · kéo marker rồi thả để gửi GPS.`;
    deviceHintEl.className = 'live-hint is-ok';
  } else {
    deviceHintEl.textContent = `${code} · chưa thấy gps_devices — server sẽ fallback device chung.`;
    deviceHintEl.className = 'live-hint is-warn';
  }
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

function syncBoatControls() {
  const code = selectedBoatCode;
  const disabled = !code;
  if (incidentBtn) incidentBtn.disabled = disabled;
  if (speedInputEl) {
    speedInputEl.disabled = disabled;
    if (code) speedInputEl.value = String(getBoatSpeedKmh(code));
    else speedInputEl.value = String(DEFAULT_SPEED_KMH);
  }
  updateIncidentButton();
}

function updateIncidentButton() {
  if (!incidentBtn) return;
  const st = getStatus(selectedBoatCode);
  incidentBtn.textContent = st.incident ? 'Hết sự cố' : 'Báo sự cố';
  incidentBtn.classList.toggle('is-danger', !st.incident);
  incidentBtn.classList.toggle('is-ok', st.incident);
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
  const hubByCode = new Map();
  for (const boat of hubBoats || []) {
    const code = String(boat.boatCode || '').trim();
    if (!code) continue;
    hubByCode.set(code, boat);
  }

  const catalog = catalogBoats();
  const activeCodes = new Set(catalog.map((b) => String(b.boatCode).trim()).filter(Boolean));
  const codes = [...activeCodes].sort();

  for (const code of [...pinnedPositions.keys()]) {
    if (!activeCodes.has(code)) pinnedPositions.delete(code);
  }

  const occupied = [];
  let index = 0;
  for (const code of codes) {
    const hub = hubByCode.get(code);
    const seed = (hub && Number.isFinite(Number(hub.lat)) && Number.isFinite(Number(hub.lng)))
      ? { lat: Number(hub.lat), lng: Number(hub.lng) }
      : fallbackLatLngForBoat(code, index, latest);
    if (!pinnedFor(code)) {
      const unique = resolveUniqueSeed(code, seed.lat, seed.lng, occupied);
      ensureSeedPin(code, unique.lat, unique.lng);
    } else {
      occupied.push(pinnedFor(code));
    }
    index += 1;
  }
  persistPins();

  // Cluster offset chỉ để nhìn — vị trí gửi vẫn dùng pin thật.
  const truePositions = codes.map((code, i) => {
    const pin = pinnedFor(code) || fallbackLatLngForBoat(code, i, latest);
    return { code, ...pin };
  });
  const displayPos = new Map();
  truePositions.forEach((item) => {
    const twins = truePositions.filter((p) => distMeters(p, item) < CLUSTER_M);
    if (twins.length <= 1 || item.code === selectedBoatCode) {
      displayPos.set(item.code, { lat: item.lat, lng: item.lng });
      return;
    }
    const myIdx = twins.findIndex((t) => t.code === item.code);
    const off = displayOffset(myIdx, twins.length);
    displayPos.set(item.code, { lat: item.lat + off.lat, lng: item.lng + off.lng });
  });

  const seen = new Set();
  const selected = selectedBoatCode;
  index = 0;

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
    const heading = Number(hub?.heading) || 0;
    const popupHtml = boatPopupHtml(code, catalogBoat, hub, trueLat, trueLng);
    const hoverTip = `${boatDisplayName(code, catalogBoat, hub)} · ${boatDeckCount(code, catalogBoat) >= 2 ? '2 tầng' : '1 tầng'}`;
    const decks = boatDeckCount(code, catalogBoat);
    const iconOpts = {
      drag: isSelected,
      signal: !st.incident && signal,
      incident: st.incident || phase === 'incident',
      phase,
      decks,
    };

    let marker = hubMarkers.get(code);
    if (!marker) {
      marker = L.marker([show.lat, show.lng], {
        icon: boatIcon(heading, iconOpts),
        draggable: isSelected,
        zIndexOffset: isSelected ? 1200 : 700 + index,
        autoPan: true,
      }).addTo(map);
      marker.bindPopup(popupHtml, {
        closeButton: true,
        autoClose: true,
        closeOnClick: true,
        className: 'live-boat-popup-wrap',
        offset: [0, -12],
      });
      marker.bindTooltip(hoverTip, {
        direction: 'top',
        offset: [0, -18],
        opacity: 1,
        className: 'live-boat-hover-tip',
      });
      marker.on('popupopen', () => openPopupCode.add(code));
      marker.on('popupclose', () => openPopupCode.delete(code));
      bindDragHandlers(marker, code);
      hubMarkers.set(code, marker);
    } else if (isDraggingSelected) {
      // đang kéo — không đụng popup/icon
    } else {
      marker.setLatLng([show.lat, show.lng]);
      marker.setIcon(boatIcon(heading, iconOpts));
      marker.dragging?.[isSelected ? 'enable' : 'disable']?.();
      marker.setZIndexOffset(isSelected ? 1200 : 700 + index);
      marker.setPopupContent(popupHtml);
      if (marker.getTooltip()) marker.setTooltipContent(hoverTip);
      else {
        marker.bindTooltip(hoverTip, {
          direction: 'top',
          offset: [0, -18],
          opacity: 1,
          className: 'live-boat-hover-tip',
        });
      }
      bindDragHandlers(marker, code);
      if (openPopupCode.has(code) && !marker.isPopupOpen()) marker.openPopup();
    }
  }

  for (const [code, marker] of hubMarkers) {
    if (!seen.has(code)) {
      marker.remove();
      hubMarkers.delete(code);
      openPopupCode.delete(code);
    }
  }

  if (selected && hubMarkers.has(selected) && !dragging) {
    const marker = hubMarkers.get(selected);
    marker.dragging?.enable?.();
    marker.setZIndexOffset(1200);
    bindDragHandlers(marker, selected);
    const pin = pinnedFor(selected);
    if (pin) coordStatusEl.textContent = `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`;
  }

  if (boatPhaseStatusEl) {
    if (selected && pinnedFor(selected)) {
      const pin = pinnedFor(selected);
      boatPhaseStatusEl.textContent = phaseLabel(selected, pin.lat, pin.lng);
    } else {
      boatPhaseStatusEl.textContent = '—';
    }
  }

  centerBoatBtn.disabled = !selected || !hubMarkers.has(selected);
  if (sendNowBtn) sendNowBtn.disabled = !selected || !hubMarkers.has(selected);
  syncBoatControls();
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
  boatContextMenuEl.hidden = false;
  const pad = 8;
  const { offsetWidth: w, offsetHeight: h } = boatContextMenuEl;
  const x = Math.min(Math.max(pad, clientX), window.innerWidth - w - pad);
  const y = Math.min(Math.max(pad, clientY), window.innerHeight - h - pad);
  boatContextMenuEl.style.left = `${x}px`;
  boatContextMenuEl.style.top = `${y}px`;
}

function selectBoatForDrag(code, { toastMessage = true } = {}) {
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
    marker.dragging?.enable?.();
    marker.setZIndexOffset(1200);
    bindDragHandlers(marker, key);
    map.panTo(marker.getLatLng(), { animate: true });
  }
  if (toastMessage) toast(`${boatDisplayName(key)} — kéo để di chuyển`, 'ok');
}

function bindDragHandlers(marker, code) {
  marker.off('dragstart');
  marker.off('drag');
  marker.off('dragend');
  marker.off('contextmenu');
  marker.on('contextmenu', (event) => {
    L.DomEvent.preventDefault(event);
    L.DomEvent.stop(event);
    const oe = event.originalEvent || event;
    showBoatContextMenu(code, oe.clientX, oe.clientY);
  });
  marker.on('dragstart', () => {
    if (code !== selectedBoatCode) return;
    hideBoatContextMenu();
    dragging = true;
  });
  marker.on('drag', () => {
    if (code !== selectedBoatCode) return;
    dragging = true;
    const { lat, lng } = marker.getLatLng();
    coordStatusEl.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  });
  marker.on('dragend', async () => {
    if (code !== selectedBoatCode) return;
    dragging = false;
    let { lat, lng } = marker.getLatLng();
    const snap = nearestStation({ lat, lng }, latest?.stations || []);
    if (snap) {
      lat = Number(snap.station.lat);
      lng = Number(snap.station.lng);
      marker.setLatLng([lat, lng]);
      toast(`Snap ${snap.station.stationCode || snap.station.stationName} (${Math.round(snap.dist)} m)`, 'ok');
      setStatus(code, { phase: 'arrived', incident: false });
    } else {
      const st = getStatus(code);
      if (!st.incident) setStatus(code, { phase: 'enroute' });
    }
    pinBoatPosition(code, lat, lng, { user: true });
    coordStatusEl.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    await sendLiveGps(code, lat, lng);
  });
}

function isCatalogActiveBoat(boatCode, data = latest) {
  const code = String(boatCode || '').trim();
  if (!code) return false;
  return catalogBoats(data).some((boat) => String(boat.boatCode).trim() === code);
}

async function sendLiveGps(boatCode, lat, lng, { quiet = false } = {}) {
  if (!isCatalogActiveBoat(boatCode)) {
    if (!quiet) toast('Tàu không hoạt động — không gửi GPS', 'warn');
    return false;
  }
  if (!quiet && sending) return;
  if (!quiet) {
    sending = true;
    sendStatusEl.textContent = 'Đang gửi…';
  }
  pinBoatPosition(boatCode, lat, lng, { user: true });
  const st = getStatus(boatCode);
  const phase = autoPhaseForBoat(boatCode, lat, lng);
  const cruise = getBoatSpeedKmh(boatCode);
  const moving = !st.incident && (phase === 'enroute' || phase === 'departing' || phase === 'approaching');
  const status = st.incident ? 'idle' : (moving ? 'moving' : 'idle');
  const speedKmh = st.incident ? 0 : (moving ? cruise : (phase === 'arrived' || phase === 'prepare' ? 0 : cruise));
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
    pinBoatPosition(boatCode, lat, lng, { user: true });
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
    // Dọn pin tàu inactive còn sót localStorage.
    for (const code of [...pinnedPositions.keys()]) {
      if (!codes.includes(code)) pinnedPositions.delete(code);
    }
    persistPins();
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i];
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

  if (sendAzureSelectEl.dataset.seeded !== '1') {
    sendAzureSelectEl.value = data?.config?.senderEnabled === false ? 'off' : 'on';
    sendAzureSelectEl.dataset.seeded = '1';
  }
}

function render(data) {
  latest = data;
  renderBoatOptions(data);
  renderRoutes(data.routes, data.stations);
  renderStations(data.stations);
  renderHubBoats(data.hubBoats);
  renderStatus(data);
}

function connectEvents() {
  if (eventsSource) {
    eventsSource.onmessage = null;
    eventsSource.onerror = null;
    eventsSource.close();
  }
  eventsSource = new EventSource('/events');
  eventsSource.onmessage = (message) => {
    try {
      const data = JSON.parse(message.data);
      render(data);
    } catch {
      // ignore
    }
  };
  eventsSource.onerror = () => {
    eventsSource.close();
    setTimeout(connectEvents, 1500);
  };
}

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

boatCtxDragBtn?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  const code = contextMenuBoatCode;
  hideBoatContextMenu();
  if (code) selectBoatForDrag(code);
});

document.addEventListener('click', (event) => {
  if (!boatContextMenuEl || boatContextMenuEl.hidden) return;
  if (boatContextMenuEl.contains(event.target)) return;
  hideBoatContextMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideBoatContextMenu();
});

map.on('movestart zoomstart click contextmenu', hideBoatContextMenu);

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
  if (!selectedBoatCode) return;
  const st = getStatus(selectedBoatCode);
  const next = !st.incident;
  setStatus(selectedBoatCode, {
    incident: next,
    phase: next ? 'incident' : 'prepare',
  });
  syncBoatControls();
  if (latest) renderHubBoats(latest.hubBoats);
  toast(next ? `${boatDisplayName(selectedBoatCode)}: báo sự cố` : `${boatDisplayName(selectedBoatCode)}: hết sự cố`, next ? 'warn' : 'ok');
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
  const snap = nearestStation({ lat, lng }, latest?.stations || []);
  if (snap) {
    lat = Number(snap.station.lat);
    lng = Number(snap.station.lng);
    marker.setLatLng([lat, lng]);
    setStatus(selectedBoatCode, { phase: 'arrived', incident: false });
  }
  pinBoatPosition(selectedBoatCode, lat, lng, { user: true });
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

connectEvents();
startHeartbeat();
