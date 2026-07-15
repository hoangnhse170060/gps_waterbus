const SNAP_STATION_M = 60;
const ROUTE_STYLE = {
  color: '#0f766e',
  weight: 4,
  opacity: 0.78,
  smoothFactor: 0,
};
/** Thứ tự tuyến chính BD↔LD khi bảng routes chưa có geometry. */
const WATERBUS_CORRIDOR_CODES = [
  'ST-BD', 'ST-TT', 'ST-BA', 'ST-TD2', 'ST-TD', 'ST-HBC', 'ST-LD',
];

const map = L.map('map', { zoomControl: false }).setView([10.776, 106.708], 13);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap',
}).addTo(map);

const boatSelectEl = document.querySelector('#boatSelect');
const sendAzureSelectEl = document.querySelector('#sendAzureSelect');
const deviceHintEl = document.querySelector('#deviceHint');
const hubStatusEl = document.querySelector('#hubStatus');
const sendStatusEl = document.querySelector('#sendStatus');
const coordStatusEl = document.querySelector('#coordStatus');
const centerBoatBtn = document.querySelector('#centerBoatBtn');
const sendNowBtn = document.querySelector('#sendNowBtn');
const refreshBtn = document.querySelector('#refreshBtn');
const toastHost = document.querySelector('#toastHost');

let latest = null;
let eventsSource = null;
let selectedBoatCode = localStorage.getItem('liveGpsBoatCode') || '';
let sending = false;
let dragging = false;
let hasFitRoutes = false;
/** Vị trí cố định trên map: chỉ đổi khi user kéo/gửi đúng tàu đó. */
const STORAGE_PINS = 'liveGpsBoatPins.v1';
const pinnedPositions = loadPinnedPositions();

const stationLayers = new Map();
const hubMarkers = new Map();
const routeLayers = new Map();

function loadPinnedPositions() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_PINS) || '{}');
    return new Map(
      Object.entries(raw).filter(([, v]) => (
        v && Number.isFinite(Number(v.lat)) && Number.isFinite(Number(v.lng))
      )).map(([code, v]) => [code, {
        lat: Number(v.lat),
        lng: Number(v.lng),
        at: Number(v.at) || Date.now(),
        user: Boolean(v.user),
      }]),
    );
  } catch {
    return new Map();
  }
}

function persistPins() {
  const obj = {};
  for (const [code, pin] of pinnedPositions) {
    obj[code] = {
      lat: pin.lat,
      lng: pin.lng,
      at: pin.at,
      user: Boolean(pin.user),
    };
  }
  localStorage.setItem(STORAGE_PINS, JSON.stringify(obj));
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
  return pinnedPositions.get(String(code || '').trim()) || null;
}

/** Lần đầu thấy hub → seed pin; sau đó không bao giờ nhảy theo SSE nếu chưa đụng. */
function ensureSeedPin(code, lat, lng) {
  if (pinnedFor(code)) return;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  pinBoatPosition(code, lat, lng, { user: false });
}

function fallbackLatLngForBoat(code, index, data = latest) {
  const pin = pinnedFor(code);
  if (pin) return { lat: pin.lat, lng: pin.lng };
  const hub = (data?.hubBoats || []).find((b) => String(b.boatCode) === code);
  if (hub && Number.isFinite(Number(hub.lat)) && Number.isFinite(Number(hub.lng))) {
    return { lat: Number(hub.lat), lng: Number(hub.lng) };
  }
  const stations = (data?.stations || []).filter((s) => (
    Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng))
  ));
  if (stations.length) {
    const s = stations[index % stations.length];
    // Lệch nhẹ để 5 tàu không chồng nhau khi chưa có GPS.
    const jitter = (index - 2) * 0.00035;
    return { lat: Number(s.lat) + jitter, lng: Number(s.lng) + jitter };
  }
  return { lat: 10.776 + index * 0.002, lng: 106.708 };
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
  return (data?.boats || []).filter((boat) => (
    boat.boatCode && !String(boat.boatId || '').startsWith('collector-') && boat.boatId !== 'fallback-boat'
  ));
}

function deviceForBoat(code, data = latest) {
  const mapDevices = data?.config?.gpsDevices || {};
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

function nearestStation(latlng, stations) {
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
  return best && bestDist <= SNAP_STATION_M ? { station: best, dist: bestDist } : null;
}

function boatIcon(heading = 0, { drag = false } = {}) {
  const deg = Number(heading) || 0;
  if (drag) {
    return L.divIcon({
      className: '',
      html: `
        <div class="collector-marker">
          <div class="collector-marker-pulse"></div>
          <div class="collector-marker-inner" style="--heading:${deg}deg">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#0f766e" stroke="#fff" stroke-width="1.5" d="M12 3 L20 19 L12 15 L4 19 Z"></path>
            </svg>
          </div>
        </div>
      `,
      iconSize: [58, 58],
      iconAnchor: [29, 29],
    });
  }
  return L.divIcon({
    className: '',
    html: `
      <div class="boat-marker">
        <div class="boat-marker-pulse"></div>
        <div class="boat-marker-inner" style="--heading:${deg}deg">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#ef4444" stroke="#fff" stroke-width="1.5" d="M12 3 L20 19 L12 15 L4 19 Z"></path>
          </svg>
        </div>
        <div class="boat-marker-point"></div>
      </div>
    `,
    iconSize: [58, 58],
    iconAnchor: [29, 29],
  });
}

/** Cùng cờ bến Survey (styles.css .station-flag). */
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

function renderBoatOptions(data) {
  const boats = catalogBoats(data);
  const previous = selectedBoatCode || boatSelectEl.value;
  boatSelectEl.innerHTML = [
    '<option value="">Chọn tàu...</option>',
    ...boats.map((boat) => {
      const max = Number(boat.maxSpeedKmh) || '';
      const name = boat.boatName ? ` · ${boat.boatName}` : '';
      const maxText = max ? ` · max ${max}` : '';
      return `<option value="${escapeHtml(boat.boatCode)}">${escapeHtml(boat.boatCode)}${escapeHtml(name)}${escapeHtml(maxText)}</option>`;
    }),
  ].join('');
  const preferred = boats.some((b) => b.boatCode === previous)
    ? previous
    : '';
  boatSelectEl.value = preferred;
  selectedBoatCode = preferred;
  if (preferred) localStorage.setItem('liveGpsBoatCode', preferred);
  else localStorage.removeItem('liveGpsBoatCode');
  updateDeviceHint(data);
  centerBoatBtn.disabled = !preferred;
}

function updateDeviceHint(data = latest) {
  const code = boatSelectEl.value.trim();
  if (!code) {
    deviceHintEl.textContent = 'Chọn tàu đã đăng ký device để kéo trên map.';
    deviceHintEl.className = 'live-hint';
    return;
  }
  const device = deviceForBoat(code, data);
  if (device) {
    deviceHintEl.textContent = `${code} · device ${device} · kéo marker rồi thả để gửi GPS.`;
    deviceHintEl.className = 'live-hint is-ok';
  } else {
    deviceHintEl.textContent = `${code} · chưa thấy gps_devices — server sẽ fallback device chung.`;
    deviceHintEl.className = 'live-hint is-warn';
  }
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

/** Vẽ polyline tuyến từ DB; nếu routes trống thì nối bến DB theo lịch Waterbus. */
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
      if (!map.hasLayer(layer)) layer.addTo(map);
    }
    for (const p of latlngs) bounds.push(p);
  }

  // Fallback: DB chưa có route_geometry → vẽ hành lang bến theo lịch BD↔LD.
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
          dashArray: '8 6',
          opacity: 0.65,
        }).addTo(map);
        layer.bindTooltip('Hành lang Waterbus (bến DB · chờ geometry tuyến)');
        routeLayers.set(id, layer);
      } else {
        layer.setLatLngs(latlngs);
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
  const codes = new Set([
    ...catalog.map((b) => String(b.boatCode).trim()),
    ...hubByCode.keys(),
    ...pinnedPositions.keys(),
  ].filter(Boolean));

  // Seed pin lần đầu từ hub — sau đó đứng yên trừ khi user kéo.
  let index = 0;
  for (const code of codes) {
    const hub = hubByCode.get(code);
    if (hub && Number.isFinite(Number(hub.lat)) && Number.isFinite(Number(hub.lng))) {
      ensureSeedPin(code, Number(hub.lat), Number(hub.lng));
    } else if (!pinnedFor(code)) {
      const fb = fallbackLatLngForBoat(code, index, latest);
      ensureSeedPin(code, fb.lat, fb.lng);
    }
    index += 1;
  }

  const seen = new Set();
  const selected = selectedBoatCode;
  index = 0;

  for (const code of codes) {
    const hub = hubByCode.get(code);
    const catalogBoat = catalog.find((b) => String(b.boatCode) === code);
    const pin = pinnedFor(code) || fallbackLatLngForBoat(code, index, latest);
    ensureSeedPin(code, pin.lat, pin.lng);
    const fixed = pinnedFor(code);
    const lat = fixed.lat;
    const lng = fixed.lng;
    seen.add(code);
    index += 1;

    const isSelected = code === selected;
    const isDraggingSelected = isSelected && dragging;
    const offline = hub ? hub.isOnline === false : true;
    const heading = Number(hub?.heading) || 0;
    const tip = [
      code,
      catalogBoat?.boatName || hub?.boatName || '',
      offline ? 'đứng yên' : 'live',
      isSelected ? (dragging ? 'đang kéo' : 'kéo được') : '',
    ].filter(Boolean).join(' · ');

    let marker = hubMarkers.get(code);
    if (!marker) {
      marker = L.marker([lat, lng], {
        icon: boatIcon(heading, { drag: isSelected }),
        draggable: isSelected,
        zIndexOffset: isSelected ? 1200 : 800,
        autoPan: true,
        opacity: isSelected ? 1 : 0.85,
      }).addTo(map);
      marker.bindTooltip(tip, { permanent: true, direction: 'top', offset: [0, -20] });
      bindDragHandlers(marker, code);
      hubMarkers.set(code, marker);
    } else if (isDraggingSelected) {
      marker.setTooltipContent(tip);
    } else {
      // Không theo hub — chỉ giữ (hoặc đồng bộ) đúng vị trí đã pin.
      marker.setLatLng([lat, lng]);
      marker.setIcon(boatIcon(heading, { drag: isSelected }));
      marker.dragging?.[isSelected ? 'enable' : 'disable']?.();
      marker.setZIndexOffset(isSelected ? 1200 : 800);
      marker.setOpacity(isSelected ? 1 : 0.85);
      marker.setTooltipContent(tip);
      if (isSelected) bindDragHandlers(marker, code);
    }
  }

  for (const [code, marker] of hubMarkers) {
    if (!seen.has(code)) {
      marker.remove();
      hubMarkers.delete(code);
    }
  }

  if (selected && hubMarkers.has(selected) && !dragging) {
    const marker = hubMarkers.get(selected);
    marker.dragging?.enable?.();
    marker.setZIndexOffset(1200);
    bindDragHandlers(marker, selected);
    const { lat, lng } = marker.getLatLng();
    coordStatusEl.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }

  centerBoatBtn.disabled = !selected || !hubMarkers.has(selected);
  if (sendNowBtn) sendNowBtn.disabled = !selected || !hubMarkers.has(selected);
}

function bindDragHandlers(marker, code) {
  marker.off('dragstart');
  marker.off('drag');
  marker.off('dragend');
  marker.on('dragstart', () => {
    if (code !== selectedBoatCode) return;
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
    }
    pinBoatPosition(code, lat, lng, { user: true });
    coordStatusEl.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    await sendLiveGps(code, lat, lng);
  });
}

async function sendLiveGps(boatCode, lat, lng) {
  if (sending) return;
  sending = true;
  sendStatusEl.textContent = 'Đang gửi…';
  pinBoatPosition(boatCode, lat, lng, { user: true });
  const sendToTarget = sendAzureSelectEl.value === 'on';
  try {
    const response = await fetch('/api/live/gps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        boatCode,
        lat,
        lng,
        speedKmh: 0,
        status: 'idle',
        sendToTarget,
      }),
    });
    const body = await response.json();
    if (!response.ok || body.ok === false) {
      const msg = body.error || `HTTP ${response.status}`;
      sendStatusEl.textContent = `Lỗi ${response.status}`;
      toast(msg, 'err');
      return;
    }
    pinBoatPosition(boatCode, lat, lng, { user: true });
    const mode = body.mode === 'local' ? 'local' : `Azure ${body.status || 200}`;
    sendStatusEl.textContent = `OK · seq ${body.sequence || '—'} · ${mode}`;
    if (body.warning) toast(body.warning, 'warn');
    else toast(`Đã gửi GPS ${boatCode}`, 'ok');
    const marker = hubMarkers.get(boatCode);
    if (marker) marker.setLatLng([lat, lng]);
  } catch (error) {
    sendStatusEl.textContent = 'Lỗi mạng';
    toast(error.message, 'err');
  } finally {
    sending = false;
  }
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

  if (data?.config?.senderEnabled === false && sendAzureSelectEl.value === 'on') {
    // Respect server default but keep user's select for this page.
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
  selectedBoatCode = boatSelectEl.value.trim();
  if (selectedBoatCode) localStorage.setItem('liveGpsBoatCode', selectedBoatCode);
  else localStorage.removeItem('liveGpsBoatCode');
  updateDeviceHint();
  if (latest) renderHubBoats(latest.hubBoats);
  const marker = hubMarkers.get(selectedBoatCode);
  if (marker) {
    const { lat, lng } = marker.getLatLng();
    map.panTo([lat, lng], { animate: true });
    coordStatusEl.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }
});

centerBoatBtn.addEventListener('click', () => {
  const marker = hubMarkers.get(selectedBoatCode);
  if (!marker) return;
  map.setView(marker.getLatLng(), Math.max(map.getZoom(), 15), { animate: true });
});

sendNowBtn?.addEventListener('click', async () => {
  const marker = hubMarkers.get(selectedBoatCode);
  if (!marker || !selectedBoatCode) {
    toast('Chọn tàu trước', 'warn');
    return;
  }
  let { lat, lng } = marker.getLatLng();
  const snap = nearestStation({ lat, lng }, latest?.stations || []);
  if (snap) {
    lat = Number(snap.station.lat);
    lng = Number(snap.station.lng);
    marker.setLatLng([lat, lng]);
  }
  pinBoatPosition(selectedBoatCode, lat, lng);
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
