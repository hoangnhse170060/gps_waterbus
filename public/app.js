const SHOW_LIVE_BOATS = false;

const map = L.map('map', { zoomControl: false }).setView([10.776, 106.708], 13);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap',
}).addTo(map);

const dbStatusEl = document.querySelector('#dbStatus');
const targetTextEl = document.querySelector('#targetText');
const refreshRoutesEl = document.querySelector('#refreshRoutes');
const toggleSenderEl = document.querySelector('#toggleSender');
const boatCountEl = document.querySelector('#boatCount');
const sendModeEl = document.querySelector('#sendMode');
const senderBadgeEl = document.querySelector('#senderBadge');
const gpsStatusEl = document.querySelector('#gpsStatus');
const sendLogEl = document.querySelector('#sendLog');
const boatsEl = document.querySelector('#boats');
const payloadLogEl = document.querySelector('#payloadLog');
const mapLegendEl = document.querySelector('#mapLegend');
const captureCountEl = document.querySelector('#captureCount');
const captureStatusEl = document.querySelector('#captureStatus');
const collectorStatusEl = document.querySelector('#collectorStatus');
const captureRouteCodeEl = document.querySelector('#captureRouteCode');
const captureRouteNameEl = document.querySelector('#captureRouteName');
const startStationEl = document.querySelector('#startStation');
const endStationEl = document.querySelector('#endStation');
const seedFromStationEl = document.querySelector('#seedFromStation');
const seedToEndStationEl = document.querySelector('#seedToEndStation');
const collectorBoatCodeEl = document.querySelector('#collectorBoatCode');
const collectorSpeedEl = document.querySelector('#collectorSpeed');
const captureTripIdEl = document.querySelector('#captureTripId');
const sendIntervalSecEl = document.querySelector('#sendIntervalSec');
const startCollectorEl = document.querySelector('#startCollector');
const pauseCollectorEl = document.querySelector('#pauseCollector');
const stopCollectorEl = document.querySelector('#stopCollector');
const saveRouteGeometryEl = document.querySelector('#saveRouteGeometry');
const toggleCaptureEl = document.querySelector('#toggleCapture');
const undoCapturePointEl = document.querySelector('#undoCapturePoint');
const clearCaptureEl = document.querySelector('#clearCapture');
const saveCapturedRouteEl = document.querySelector('#saveCapturedRoute');
const toolPanEl = document.querySelector('#toolPan');
const toolDrawEl = document.querySelector('#toolDraw');
const toolUndoEl = document.querySelector('#toolUndo');
const toolClearEl = document.querySelector('#toolClear');
const finishDrawEl = document.querySelector('#finishDraw');
const modeStraightEl = document.querySelector('#modeStraight');
const modeCurveEl = document.querySelector('#modeCurve');
const drawDistanceEl = document.querySelector('#drawDistance');
const drawDurationEl = document.querySelector('#drawDuration');
const drawPointsEl = document.querySelector('#drawPoints');
const routeResultEl = document.querySelector('#routeResult');
const estimateKmEl = document.querySelector('#estimateKm');
const estimateSpeedEl = document.querySelector('#estimateSpeed');
const estimateMinEl = document.querySelector('#estimateMin');
const stationCountEl = document.querySelector('#stationCount');
const routeCodeHintEl = document.querySelector('#routeCodeHint');
const workflowStepsEl = document.querySelector('#workflowSteps');

const markers = new Map();
const routeLayers = new Map();
const stationLayers = new Map();
const captureMarkers = [];
let captureLine = null;
let plannedRouteLine = null;
let lockedSurveyPath = null; // giữ đường vẽ suốt lúc tàu chạy — không cho auto-save cũ xóa
let collectorMarker = null;
let latest = null;
let hasFitInitialRoutes = false;
let lastStationsFingerprint = '';
let lastRoutesFingerprint = '';
let lastBoatIds = '';
let renderFrame = null;
let recordingSession = null;
let autoSaveInFlight = false;
let autoCompleteTriggered = false;
let lastHandledAutoSaveAt = '';
let recordingActive = false;
let recordingStartedAt = 0;
let routeCodeOk = true;

const captureState = {
  enabled: false,
  finished: false,
  // Khi đang vẽ: thẳng để dễ chỉnh điểm; bấm Xong → bezierSpline
  lineMode: 'straight',
  points: [],
};

const routeColors = ['#0f766e', '#2563eb', '#d97706', '#7c3aed', '#dc2626', '#0891b2'];

refreshRoutesEl.addEventListener('click', () => fetch('/api/refresh', { method: 'POST' }));
toggleSenderEl.addEventListener('click', async () => {
  const enabled = !(latest?.config?.senderEnabled);
  await fetch('/api/sender', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
});

startStationEl.addEventListener('change', () => {
  onStartStationChange();
  if (latest?.stations) renderStations(latest.stations);
});
endStationEl.addEventListener('change', () => {
  seedToEndStationEl.disabled = !endStationEl.value;
  if (latest?.stations) renderStations(latest.stations);
});
seedFromStationEl.addEventListener('click', seedFromStation);
seedToEndStationEl.addEventListener('click', seedToEndStation);
startCollectorEl.addEventListener('click', startRecording);
pauseCollectorEl.addEventListener('click', pauseCollector);
stopCollectorEl.addEventListener('click', stopRecording);
saveRouteGeometryEl.addEventListener('click', saveRouteGeometry);
toggleCaptureEl.addEventListener('click', () => {
  captureState.enabled = !captureState.enabled;
  setDrawTool(captureState.enabled ? 'draw' : 'pan');
  renderCaptureState();
  captureStatusEl.textContent = captureState.enabled
    ? 'Dang ve: click ban do de them diem.'
    : 'Da tat che do ve tay.';
});
undoCapturePointEl.addEventListener('click', undoCapturePoint);
clearCaptureEl.addEventListener('click', () => {
  clearCapturePoints();
  captureStatusEl.textContent = 'Da xoa diem thu.';
  renderCaptureState();
});
saveCapturedRouteEl.addEventListener('click', saveCapturedRoute);
toolPanEl?.addEventListener('click', () => setDrawTool('pan'));
toolDrawEl?.addEventListener('click', () => {
  captureState.finished = false;
  captureState.lineMode = 'straight';
  setDrawTool('draw');
  captureStatusEl.textContent = 'Đang vẽ: click bản đồ thêm điểm, rồi bấm ✓ Xong để tạo nét cong.';
  updateWorkflow('draw');
});
modeStraightEl?.addEventListener('click', () => setLineMode('straight'));
modeCurveEl?.addEventListener('click', () => setLineMode('curve'));
toolUndoEl?.addEventListener('click', () => {
  captureState.finished = false;
  captureState.lineMode = 'straight';
  undoCapturePoint();
});
toolClearEl?.addEventListener('click', () => {
  if (recordingActive || lockedSurveyPath) {
    captureStatusEl.textContent = 'Đang chạy tàu — không xóa đường lúc này.';
    return;
  }
  clearCapturePoints();
  clearPlannedRoute();
  captureState.finished = false;
  captureState.lineMode = 'straight';
  captureStatusEl.textContent = 'Đã xóa đường vẽ.';
  routeResultEl?.classList.add('hidden');
  updateWorkflow('draw');
  renderCaptureState();
});
finishDrawEl?.addEventListener('click', finishDraw);
captureRouteCodeEl?.addEventListener('input', checkRouteCodeDuplicate);
collectorSpeedEl?.addEventListener('input', updateDrawStats);

function setDrawTool(tool) {
  captureState.enabled = tool === 'draw';
  toolPanEl?.classList.toggle('is-active', tool === 'pan');
  toolDrawEl?.classList.toggle('is-active', tool === 'draw');
  map.getContainer().style.cursor = tool === 'draw' ? 'crosshair' : '';
  renderCaptureState();
}

function setLineMode(mode) {
  captureState.lineMode = mode === 'straight' ? 'straight' : 'curve';
  modeStraightEl?.classList.toggle('is-active', captureState.lineMode === 'straight');
  modeCurveEl?.classList.toggle('is-active', captureState.lineMode === 'curve');
  renderCaptureLine();
  updateDrawStats();
}

function finishDraw() {
  if (captureState.points.length < 2) {
    captureStatusEl.textContent = 'Cần ít nhất 2 điểm trước khi hoàn thành.';
    return;
  }
  captureState.lineMode = 'curve';
  captureState.finished = true;
  setLineMode('curve');
  setDrawTool('pan');
  captureStatusEl.textContent = 'Đã tạo đường cong đi qua các điểm khảo sát. Kiểm tra km/phút, chỉnh tốc độ cho khớp thực tế, rồi ghi GPS.';
  updateWorkflow('run');
  checkRouteCodeDuplicate();
}

function updateWorkflow(step) {
  if (!workflowStepsEl) return;
  const order = ['draw', 'run', 'done'];
  const activeIdx = order.indexOf(step);
  workflowStepsEl.querySelectorAll('.step').forEach((el) => {
    const key = el.dataset.step;
    const idx = order.indexOf(key);
    el.classList.toggle('is-active', key === step);
    el.classList.toggle('is-done', idx >= 0 && idx < activeIdx);
  });
}

function checkRouteCodeDuplicate() {
  const code = captureRouteCodeEl.value.trim().toUpperCase();
  if (!routeCodeHintEl) return true;
  if (!code) {
    routeCodeOk = true;
    captureRouteCodeEl.classList.remove('is-invalid');
    routeCodeHintEl.textContent = 'Mã sẽ được kiểm tra trùng trên hệ thống.';
    routeCodeHintEl.classList.remove('is-error', 'is-ok');
    return true;
  }
  const existing = (latest?.routes || []).find(
    (r) => String(r.routeCode || '').trim().toUpperCase() === code,
  );
  if (existing) {
    routeCodeOk = false;
    captureRouteCodeEl.classList.add('is-invalid');
    routeCodeHintEl.textContent = `Mã "${code}" đã tồn tại (${existing.routeName || existing.routeCode}). Đổi mã khác trước khi lưu.`;
    routeCodeHintEl.classList.add('is-error');
    routeCodeHintEl.classList.remove('is-ok');
    return false;
  }
  routeCodeOk = true;
  captureRouteCodeEl.classList.remove('is-invalid');
  routeCodeHintEl.textContent = `Mã "${code}" chưa trùng — có thể dùng.`;
  routeCodeHintEl.classList.add('is-ok');
  routeCodeHintEl.classList.remove('is-error');
  return true;
}

map.on('click', (event) => {
  if (!captureState.enabled) return;
  addCapturePoint(event.latlng, { source: 'manual' });
});

let eventsSource = null;

function connectEvents() {
  if (eventsSource) {
    eventsSource.onmessage = null;
    eventsSource.onerror = null;
    eventsSource.close();
  }
  eventsSource = new EventSource('/events');
  eventsSource.onmessage = (message) => {
    try {
      latest = JSON.parse(message.data);
    } catch {
      return;
    }
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = null;
      render(latest);
    });
  };
  eventsSource.onerror = () => {
    eventsSource.close();
    setTimeout(connectEvents, 1500);
  };
}

connectEvents();

function uniqueStations(stations) {
  const mapById = new Map();
  for (const station of stations || []) {
    if (!station?.stationId) continue;
    if (!mapById.has(station.stationId)) mapById.set(station.stationId, station);
  }
  return [...mapById.values()];
}

function stationsFingerprint(stations) {
  return uniqueStations(stations)
    .map((s) => `${s.stationId}:${s.stationName}:${s.lat}:${s.lng}`)
    .sort()
    .join('|');
}

function routesFingerprint(routes) {
  return (routes || []).map((r) => `${r.routeId}:${r.lengthMeters}`).join('|');
}

function render(data) {
  const stationsFp = stationsFingerprint(data.stations);
  const routesFp = routesFingerprint(data.routes);
  if (stationsFp !== lastStationsFingerprint) {
    lastStationsFingerprint = stationsFp;
    renderStations(data.stations);
    renderStationOptions(startStationEl, data.stations, 'Chon ben co san...');
    renderStationOptions(endStationEl, data.stations, 'Chon ben dich...');
    seedFromStationEl.disabled = !startStationEl.value;
    seedToEndStationEl.disabled = !endStationEl.value;
  }
  if (routesFp !== lastRoutesFingerprint) {
    lastRoutesFingerprint = routesFp;
    renderRoutes(data.routes);
  }
  renderBoats(SHOW_LIVE_BOATS ? data.boats : []);
  renderPanelLive(data);
  renderCollector(data.collector, data.lastCollectorSend, data.recordingSession);
  handleAutoSavedRoute(data.lastAutoSavedRoute);
  ensureSurveyPathVisible();
  if (data.recordingSession) recordingSession = data.recordingSession;
}

function renderStationOptions(selectEl, stations, placeholder) {
  if (!selectEl) return;
  const focused = document.activeElement === selectEl;
  const selected = selectEl.value;
  const sorted = uniqueStations(stations).sort((a, b) =>
    String(a.stationName || '').localeCompare(String(b.stationName || ''), 'vi'),
  );
  if (focused) return;
  selectEl.innerHTML = [
    `<option value="">${escapeHtml(placeholder)}</option>`,
    ...sorted.map((station) => `
      <option value="${escapeHtml(station.stationId)}">
        ${escapeHtml(`${station.stationName} (${station.stationCode})`)}
      </option>
    `),
  ].join('');
  if (selected && sorted.some((station) => station.stationId === selected)) {
    selectEl.value = selected;
  }
}

function getSelectedStation() {
  if (!latest?.stations?.length || !startStationEl.value) return null;
  return uniqueStations(latest.stations).find((s) => s.stationId === startStationEl.value) || null;
}

function getSelectedEndStation() {
  if (!latest?.stations?.length || !endStationEl.value) return null;
  return uniqueStations(latest.stations).find((s) => s.stationId === endStationEl.value) || null;
}

function onStartStationChange() {
  seedFromStationEl.disabled = !startStationEl.value;
}

function seedFromStation() {
  const station = getSelectedStation();
  if (!station) {
    captureStatusEl.textContent = 'Chon ben xuat phat truoc.';
    return;
  }
  clearCapturePoints();
  addCapturePoint({ lat: station.lat, lng: station.lng }, {
    source: 'station',
    label: station.stationName,
    stationId: station.stationId,
  });
  captureState.enabled = true;
  map.setView([station.lat, station.lng], Math.max(map.getZoom(), 16), { animate: true });
  captureStatusEl.textContent = `Diem 1: ${station.stationName}. Them diem hoac chon ben ket thuc.`;
  maybeFillRouteCode();
  renderCaptureState();
}

function seedToEndStation() {
  const endStation = getSelectedEndStation();
  if (!endStation) {
    captureStatusEl.textContent = 'Chon ben ket thuc truoc.';
    return;
  }
  if (!captureState.points.length) {
    captureStatusEl.textContent = 'Can ben xuat phat truoc.';
    return;
  }
  const last = captureState.points.at(-1);
  if (last?.stationId === endStation.stationId) {
    captureStatusEl.textContent = 'Ben ket thuc trung ben cuoi.';
    return;
  }
  if (last?.source === 'station-end') {
    captureState.points.pop();
    const marker = captureMarkers.pop();
    if (marker) marker.remove();
  }
  addCapturePoint({ lat: endStation.lat, lng: endStation.lng }, {
    source: 'station-end',
    label: endStation.stationName,
    stationId: endStation.stationId,
  });
  maybeFillRouteCode();
  captureStatusEl.textContent = `Da gan ben ket thuc: ${endStation.stationName}.`;
  renderCaptureState();
}

function maybeFillRouteCode() {
  const start = captureState.points[0];
  const end = captureState.points.at(-1);
  if (!start?.label || !end?.label || start === end) return;
  if (captureRouteCodeEl.value.trim()) {
    checkRouteCodeDuplicate();
    return;
  }
  const abbrev = (name) => String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  captureRouteCodeEl.value = `${abbrev(start.label)}-${abbrev(end.label)}`;
  if (!captureRouteNameEl.value.trim()) {
    captureRouteNameEl.value = `${start.label} - ${end.label}`;
  }
  checkRouteCodeDuplicate();
}

function addCapturePoint(latlng, meta = {}) {
  const point = {
    lat: roundNumber(latlng.lat, 9),
    lng: roundNumber(latlng.lng, 9),
    source: meta.source || 'manual',
    label: meta.label || null,
    stationId: meta.stationId || null,
    accuracy: meta.accuracy || null,
  };
  captureState.points.push(point);
  const marker = L.marker([point.lat, point.lng], {
    icon: capturePointIcon(captureState.points.length, point.source),
  }).addTo(map);
  if (point.label) marker.bindTooltip(point.label, { direction: 'top', offset: [0, -10] });
  captureMarkers.push(marker);
  renderCaptureLine();
  renderCaptureState();
}

function capturePointIcon(index, source) {
  const isStation = source === 'station' || source === 'station-end';
  return L.divIcon({
    className: '',
    html: `<div class="capture-point-marker${isStation ? ' is-station' : ''}">${index}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

function expandPath(points) {
  if (!points?.length) return [];
  if (points.length === 1) return [{ lat: points[0].lat, lng: points[0].lng }];
  const base = points.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
  if (captureState.lineMode !== 'curve') {
    return densifyPolyline(base, 12);
  }
  // Catmull-Rom đi QUA mọi điểm khảo sát — không cắt góc như bezier (tránh lệch km thực tế).
  return catmullRomPath(base, 28);
}

function densifyPolyline(points, segmentsPerEdge) {
  if (points.length < 2) return points.slice();
  const out = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    for (let s = 0; s < segmentsPerEdge; s += 1) {
      const t = s / segmentsPerEdge;
      out.push({
        lat: roundNumber(a.lat + (b.lat - a.lat) * t, 7),
        lng: roundNumber(a.lng + (b.lng - a.lng) * t, 7),
      });
    }
  }
  out.push({ lat: roundNumber(points.at(-1).lat, 7), lng: roundNumber(points.at(-1).lng, 7) });
  return out;
}

function catmullRomPath(points, segmentsPerSpan) {
  if (points.length < 2) return points.slice();
  if (points.length === 2) return densifyPolyline(points, segmentsPerSpan);
  const padded = [points[0], ...points, points[points.length - 1]];
  const out = [];
  for (let i = 0; i < padded.length - 3; i += 1) {
    const p0 = padded[i];
    const p1 = padded[i + 1];
    const p2 = padded[i + 2];
    const p3 = padded[i + 3];
    for (let s = 0; s < segmentsPerSpan; s += 1) {
      const t = s / segmentsPerSpan;
      out.push(catmullRomPoint(p0, p1, p2, p3, t));
    }
  }
  out.push({
    lat: roundNumber(points[points.length - 1].lat, 7),
    lng: roundNumber(points[points.length - 1].lng, 7),
  });
  return out;
}

function catmullRomPoint(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const lat = 0.5 * (
    (2 * p1.lat)
    + (-p0.lat + p2.lat) * t
    + (2 * p0.lat - 5 * p1.lat + 4 * p2.lat - p3.lat) * t2
    + (-p0.lat + 3 * p1.lat - 3 * p2.lat + p3.lat) * t3
  );
  const lng = 0.5 * (
    (2 * p1.lng)
    + (-p0.lng + p2.lng) * t
    + (2 * p0.lng - 5 * p1.lng + 4 * p2.lng - p3.lng) * t2
    + (-p0.lng + 3 * p1.lng - 3 * p2.lng + p3.lng) * t3
  );
  return { lat: roundNumber(lat, 7), lng: roundNumber(lng, 7) };
}

function getPathCoordinates() {
  const expanded = expandPath(captureState.points);
  return expanded.length >= 2 ? expanded : captureState.points.map(({ lat, lng }) => ({ lat, lng }));
}

function renderCaptureLine() {
  if (captureLine) {
    captureLine.remove();
    captureLine = null;
  }
  if (captureState.points.length < 2) return;
  const path = expandPath(captureState.points);
  captureLine = L.polyline(
    path.map((p) => [p.lat, p.lng]),
    {
      color: captureState.lineMode === 'curve' ? '#0f766e' : '#334155',
      weight: captureState.lineMode === 'curve' ? 5 : 3.5,
      opacity: 0.92,
      dashArray: captureState.lineMode === 'curve' ? null : '8 6',
    },
  ).addTo(map);
}

function undoCapturePoint() {
  if (!captureState.points.length) return;
  captureState.points.pop();
  const marker = captureMarkers.pop();
  if (marker) marker.remove();
  renderCaptureLine();
  renderCaptureState();
}

function clearCapturePoints() {
  for (const marker of captureMarkers) marker.remove();
  captureMarkers.length = 0;
  captureState.points = [];
  captureState.finished = false;
  captureState.lineMode = 'straight';
  if (captureLine) {
    captureLine.remove();
    captureLine = null;
  }
}

function renderCaptureState() {
  captureCountEl.textContent = `${captureState.points.length} điểm`;
  if (toggleCaptureEl) toggleCaptureEl.textContent = captureState.enabled ? 'Đang vẽ...' : 'Bắt đầu';
  if (undoCapturePointEl) undoCapturePointEl.disabled = !captureState.points.length;
  if (clearCaptureEl) clearCaptureEl.disabled = !captureState.points.length;
  if (saveCapturedRouteEl) saveCapturedRouteEl.disabled = captureState.points.length < 2;
  if (toolUndoEl) toolUndoEl.disabled = !captureState.points.length;
  if (toolClearEl) toolClearEl.disabled = !captureState.points.length;
  if (finishDrawEl) {
    finishDrawEl.disabled = captureState.points.length < 2 || captureState.finished;
  }
  updateDrawStats();
}

function pathLengthMeters(points) {
  const path = points === captureState.points ? expandPath(points) : points;
  if (path.length < 2) return 0;
  // Haversine giống server — km/thời gian FE khớp 1:1 với DB khi lưu.
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    total += haversineMeters(path[i - 1], path[i]);
  }
  return total;
}

function haversineMeters(a, b) {
  const earth = 6371000;
  const toRad = (value) => (Number(value) * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function estimateTravelMinutes(meters, speedKmh) {
  const speed = clampNumber(Number(speedKmh) || 16, 0.1, 80);
  const km = Number(meters) / 1000;
  if (!(km > 0) || !(speed > 0)) return 0;
  // phút = (km / vận_tốc_kmh) × 60
  return (km / speed) * 60;
}

function updateDrawStats() {
  const meters = pathLengthMeters(captureState.points);
  const speed = Number(collectorSpeedEl.value || 16);
  const km = meters / 1000;
  const minutesExact = estimateTravelMinutes(meters, speed);
  const kmText = meters < 1000
    ? `${Math.round(meters)} m`
    : `${km.toFixed(3)} km`;
  if (drawDistanceEl) drawDistanceEl.textContent = kmText;
  if (drawDurationEl) {
    drawDurationEl.textContent = meters > 0
      ? `${minutesExact.toFixed(1)} phút`
      : '0 phút';
  }
  if (drawPointsEl) drawPointsEl.textContent = `${captureState.points.length} điểm`;
  if (estimateKmEl) {
    estimateKmEl.textContent = meters > 0
      ? (meters < 1000 ? `${Math.round(meters)} m` : `${km.toFixed(3)} km`)
      : '0 km';
  }
  if (estimateSpeedEl) estimateSpeedEl.textContent = `${speed} km/h`;
  if (estimateMinEl) {
    estimateMinEl.textContent = meters > 0
      ? `${minutesExact.toFixed(2)} phút`
      : '0 phút';
  }
  const formulaEl = document.querySelector('#estimateFormula');
  if (formulaEl) {
    formulaEl.textContent = meters > 0
      ? `(${km.toFixed(3)} km ÷ ${speed} km/h) × 60 = ${minutesExact.toFixed(2)} phút`
      : 'phút = (km ÷ vận tốc) × 60';
  }
}

async function saveCapturedRoute() {
  const routeCode = captureRouteCodeEl.value.trim();
  const routeName = captureRouteNameEl.value.trim() || routeCode;
  if (!routeCode) {
    captureStatusEl.textContent = 'Nhap ma tuyen.';
    return;
  }
  if (captureState.points.length < 2) {
    captureStatusEl.textContent = 'Can it nhat 2 diem.';
    return;
  }
  saveCapturedRouteEl.disabled = true;
  try {
    const response = await fetch('/api/routes/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        routeCode,
        routeName,
        averageSpeedKmh: Number(collectorSpeedEl.value || 16),
        startStationId: startStationEl.value || captureState.points[0]?.stationId || null,
        endStationId: endStationEl.value || captureState.points.at(-1)?.stationId || null,
        coordinates: getPathCoordinates(),
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Khong luu duoc');
    captureStatusEl.textContent = `Da luu DB: ${body.routeCode || routeCode}.`;
    renderRouteResult(body);
  } catch (error) {
    captureStatusEl.textContent = `Loi: ${error.message}`;
  } finally {
    renderCaptureState();
  }
}

async function startRecording() {
  const routeCode = captureRouteCodeEl.value.trim();
  const routeName = captureRouteNameEl.value.trim() || routeCode;
  if (!routeCode) {
    captureStatusEl.textContent = 'Nhập routeCode trước khi bắt đầu ghi.';
    captureRouteCodeEl.focus();
    return;
  }
  if (!checkRouteCodeDuplicate()) {
    captureStatusEl.textContent = 'Mã tuyến bị trùng — đổi mã trước khi ghi.';
    captureRouteCodeEl.focus();
    return;
  }
  if (captureState.points.length < 2) {
    if (getSelectedStation() && !captureState.points.length) seedFromStation();
    if (getSelectedEndStation()) seedToEndStation();
    if (captureState.points.length < 2) {
      captureStatusEl.textContent = 'Cần bến xuất phát + bến kết thúc (hoặc vẽ ≥ 2 điểm).';
      return;
    }
  }
  if (!captureState.finished) {
    finishDraw();
  }

  const sendIntervalMs = clampNumber(Number(sendIntervalSecEl.value || 5), 3, 10) * 1000;
  startCollectorEl.disabled = true;
  startCollectorEl.textContent = 'Đang bắt đầu...';
  captureState.enabled = false;
  renderCaptureState();
  recordingSession = null;
  autoSaveInFlight = false;
  autoCompleteTriggered = false;
  // Không reset lastHandledAutoSaveAt — tránh auto-save cũ xóa đường vừa vẽ.
  routeResultEl?.classList.add('hidden');
  updateWorkflow('run');
  const plannedCoords = getPathCoordinates();
  lockedSurveyPath = plannedCoords.map((p) => ({ lat: p.lat, lng: p.lng }));
  showPlannedRoute(lockedSurveyPath);
  recordingActive = true;
  recordingStartedAt = Date.now();
  try {
    await fetch('/api/sender', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    const response = await fetch('/api/collector/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        routeCode,
        routeName,
        boatCode: collectorBoatCodeEl.value.trim() || 'WB_001',
        tripId: captureTripIdEl.value.trim() || null,
        speedKmh: Number(collectorSpeedEl.value || 16),
        sendIntervalMs,
        sendToTarget: true,
        recording: true,
        isNewRouteSurvey: true,
        startStationId: startStationEl.value || captureState.points[0]?.stationId || null,
        endStationId: endStationEl.value || captureState.points.at(-1)?.stationId || null,
        coordinates: plannedCoords,
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Không bắt đầu ghi được GPS');
    const warn = body.targetSessionWarning ? ` ${body.targetSessionWarning}` : '';
    captureStatusEl.textContent = `Đang ghi GPS mỗi ${sendIntervalMs / 1000}s.${warn}`;
    collectorStatusEl.textContent = `Đang chạy ${body.boatCode} · ${body.deviceId}`;
    gpsStatusEl.textContent = 'Đang ghi GPS';
    ensureSurveyPathVisible();
  } catch (error) {
    recordingActive = false;
    recordingStartedAt = 0;
    lockedSurveyPath = null;
    clearPlannedRoute();
    captureStatusEl.textContent = `Lỗi: ${error.message}`;
    startCollectorEl.disabled = false;
    startCollectorEl.textContent = 'Bắt đầu ghi GPS';
  } finally {
    renderCaptureState();
    ensureSurveyPathVisible();
  }
}

async function stopRecording({ autoSave = true } = {}) {
  stopCollectorEl.disabled = true;
  stopCollectorEl.textContent = 'Đang kết thúc...';
  try {
    const response = await fetch('/api/collector/stop', { method: 'POST' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Không kết thúc ghi được');
    recordingSession = body.session || null;
    const count = recordingSession?.recordedPoints?.length || 0;
    if (!count) {
      captureStatusEl.textContent = 'Đã kết thúc ghi nhưng chưa có điểm GPS.';
      collectorStatusEl.textContent = 'Không có điểm để lưu.';
      autoCompleteTriggered = false;
      return;
    }
    captureStatusEl.textContent = `Đã lấy xong ${count} điểm GPS. Đang lưu lên DB...`;
    collectorStatusEl.textContent = `Session sẵn sàng lưu (${count} điểm).`;
    gpsStatusEl.textContent = 'Đã lấy GPS xong';
    if (autoSave) {
      const ok = await saveRouteGeometry({ silentClear: true });
      if (!ok) autoCompleteTriggered = false;
    }
  } catch (error) {
    captureStatusEl.textContent = `Lỗi: ${error.message}`;
    autoCompleteTriggered = false;
  } finally {
    stopCollectorEl.textContent = 'Kết thúc & lưu';
  }
}

async function pauseCollector() {
  if (!latest?.collector) return;
  await fetch('/api/collector/pause', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused: !latest.collector.paused }),
  });
}

async function saveRouteGeometry({ silentClear = false } = {}) {
  if (autoSaveInFlight) return false;
  const routeCode = captureRouteCodeEl.value.trim();
  const routeName = captureRouteNameEl.value.trim() || routeCode;
  if (!routeCode) {
    captureStatusEl.textContent = 'Nhập mã tuyến trước khi lưu.';
    return false;
  }
  if (!checkRouteCodeDuplicate()) {
    captureStatusEl.textContent = 'Mã tuyến bị trùng — đổi mã rồi lưu lại.';
    return false;
  }
  autoSaveInFlight = true;
  saveRouteGeometryEl.disabled = true;
  saveRouteGeometryEl.textContent = 'Đang lưu...';
  try {
    const response = await fetch('/api/recording/save-route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        routeCode,
        routeName,
        description: 'Captured from GPS recording session',
        status: 'Active',
        averageSpeedKmh: Number(collectorSpeedEl.value || 16),
        startStationId: startStationEl.value || null,
        endStationId: endStationEl.value || null,
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      if (response.status === 409 || body.code === 'ROUTE_CODE_EXISTS') {
        routeCodeOk = false;
        captureRouteCodeEl.classList.add('is-invalid');
        if (routeCodeHintEl) {
          routeCodeHintEl.textContent = body.error || 'Mã tuyến đã tồn tại trên hệ thống.';
          routeCodeHintEl.classList.add('is-error');
          routeCodeHintEl.classList.remove('is-ok');
        }
      }
      throw new Error(body.error || 'Không lưu được route');
    }
    const where = body.savedTo === 'target' ? 'BE Azure' : 'DB local';
    const warn = body.warning ? ` (Azure: ${body.warning})` : '';
    captureStatusEl.textContent = `Đã lưu ${body.routeCode || routeCode} lên ${where}.${warn}`;
    renderRouteResult(body);
    recordingSession = null;
    updateWorkflow('done');
    gpsStatusEl.textContent = 'Lưu thành công';
    sendLogEl.textContent = `Tuyến ${body.routeCode || routeCode} đã đẩy lên ${where}.`;
    unlockSurveyPath();
    clearPlannedRoute();
    if (silentClear) {
      clearCapturePoints();
      setDrawTool('pan');
      setLineMode('straight');
      captureRouteCodeEl.value = '';
      captureRouteNameEl.value = '';
      captureRouteCodeEl.classList.remove('is-invalid');
      renderCaptureState();
    }
    await fetch('/api/refresh', { method: 'POST' });
    return true;
  } catch (error) {
    captureStatusEl.textContent = `Lỗi: ${error.message}`;
    return false;
  } finally {
    autoSaveInFlight = false;
    saveRouteGeometryEl.textContent = 'Lưu';
    saveRouteGeometryEl.disabled = false;
  }
}

function resetSurveyForm({ keepResult = false } = {}) {
  // Không xóa đường khi đang ghi hoặc còn khóa đường khảo sát.
  if (recordingActive || lockedSurveyPath) return;
  clearCapturePoints();
  clearPlannedRoute();
  setDrawTool('pan');
  setLineMode('straight');
  captureRouteCodeEl.value = '';
  captureRouteNameEl.value = '';
  if (routeCodeHintEl) {
    routeCodeHintEl.textContent = 'Mã sẽ được kiểm tra trùng trên hệ thống.';
    routeCodeHintEl.classList.remove('is-error', 'is-ok');
  }
  captureRouteCodeEl.classList.remove('is-invalid');
  if (!keepResult) routeResultEl?.classList.add('hidden');
  renderCaptureState();
}

function showPlannedRoute(coordinates) {
  if (!coordinates || coordinates.length < 2) return;
  const latlngs = coordinates.map((p) => [p.lat, p.lng]);
  if (plannedRouteLine) {
    plannedRouteLine.setLatLngs(latlngs);
  } else {
    plannedRouteLine = L.polyline(latlngs, {
      color: '#0f766e',
      weight: 6,
      opacity: 0.95,
      interactive: false,
      pane: 'overlayPane',
    }).addTo(map);
  }
  plannedRouteLine.bringToFront();
}

function clearPlannedRoute() {
  if (plannedRouteLine) {
    plannedRouteLine.remove();
    plannedRouteLine = null;
  }
}

function ensureSurveyPathVisible() {
  const path = lockedSurveyPath
    || (captureState.points.length >= 2 ? getPathCoordinates() : null);
  if (!path || path.length < 2) return;
  showPlannedRoute(path);
  if (captureState.points.length >= 2) renderCaptureLine();
  if (captureLine) captureLine.bringToFront();
  if (plannedRouteLine) plannedRouteLine.bringToFront();
}

function unlockSurveyPath() {
  lockedSurveyPath = null;
  recordingActive = false;
  recordingStartedAt = 0;
}

function renderRouteResult(body) {
  if (!routeResultEl) return;
  const distance = body.baseDistanceKm ?? body.distanceKm;
  const duration = body.estimatedDurationMin;
  const stops = Array.isArray(body.stops) ? body.stops : [];
  const stopLines = stops.map((stop) => {
    const travel = stop.standardTravelMin != null ? ` · ${stop.standardTravelMin} phút` : '';
    return `<li><strong>${escapeHtml(stop.stationName || stop.stationCode || `Bến ${stop.stopOrder}`)}</strong> (#${stop.stopOrder}${travel})</li>`;
  }).join('');

  routeResultEl.innerHTML = `
    <div class="route-result-head">
      <strong>${escapeHtml(body.routeName || body.routeCode || '')}</strong>
      <span>${escapeHtml(body.routeCode || '')}</span>
    </div>
    <div class="route-result-meta">
      <span>Quãng đường: <b>${distance != null ? `${distance} km` : '?'}</b></span>
      <span>Thời gian ước tính: <b>${duration != null ? `${duration} phút` : '?'}</b></span>
      <span>Số bến: <b>${stops.length}</b></span>
    </div>
    ${stops.length ? `<ul class="route-result-stops">${stopLines}</ul>` : '<p class="meta">Chưa có station trong route_stops.</p>'}
  `;
  routeResultEl.classList.remove('hidden');
}

function handleAutoSavedRoute(autoSaved) {
  if (!autoSaved?.at || autoSaved.at === lastHandledAutoSaveAt) return;
  // Chặn tuyệt đối khi đang ghi / còn khóa đường — đây là nguyên nhân mất đường.
  if (recordingActive || lockedSurveyPath) {
    const savedAt = Date.parse(autoSaved.at);
    if (recordingStartedAt && Number.isFinite(savedAt) && savedAt < recordingStartedAt) {
      lastHandledAutoSaveAt = autoSaved.at; // đánh dấu đã xử lý bản cũ, không xóa đường
      return;
    }
    if (latest?.collector || recordingActive) return;
  }
  lastHandledAutoSaveAt = autoSaved.at;
  autoCompleteTriggered = true;
  autoSaveInFlight = false;
  recordingSession = null;

  if (autoSaved.ok === false || autoSaved.error) {
    captureStatusEl.textContent = `Lỗi tự lưu: ${autoSaved.error || 'Không lưu được'}`;
    gpsStatusEl.textContent = 'Lưu thất bại';
    updateWorkflow('run');
    return;
  }

  const where = autoSaved.savedTo === 'target' ? 'BE Azure' : 'DB local';
  const warn = autoSaved.warning ? ` (Azure: ${autoSaved.warning})` : '';
  captureStatusEl.textContent = `Đã tự lưu ${autoSaved.routeCode || ''} lên ${where}.${warn}`;
  gpsStatusEl.textContent = 'Lưu thành công';
  sendLogEl.textContent = `Tuyến ${autoSaved.routeCode || ''} đã đẩy lên ${where}.`;
  renderRouteResult(autoSaved);
  updateWorkflow('done');
  unlockSurveyPath();
  clearPlannedRoute();
  clearCapturePoints();
  setDrawTool('pan');
  setLineMode('straight');
  captureRouteCodeEl.value = '';
  captureRouteNameEl.value = '';
  captureRouteCodeEl.classList.remove('is-invalid');
  if (routeCodeHintEl) {
    routeCodeHintEl.textContent = 'Mã sẽ được kiểm tra trùng trên hệ thống.';
    routeCodeHintEl.classList.remove('is-error', 'is-ok');
  }
  renderCaptureState();
}

function renderCollector(collector, lastCollectorSend, session) {
  const activeSession = collector || session || recordingSession;
  if (!collector) {
    if (collectorMarker) {
      collectorMarker.remove();
      collectorMarker = null;
    }
    const count = activeSession?.recordedPoints?.length || activeSession?.recordedCount || 0;
    if (count && !autoSaveInFlight) {
      collectorStatusEl.textContent = `Đã kết thúc ghi: ${count} điểm GPS.`;
      stopCollectorEl.disabled = true;
      pauseCollectorEl.disabled = true;
      startCollectorEl.disabled = false;
      startCollectorEl.textContent = 'Bắt đầu ghi GPS';
      saveRouteGeometryEl.disabled = count < 2;
      return;
    }
    if (!autoSaveInFlight) {
      collectorStatusEl.textContent = 'Chưa ghi GPS.';
      pauseCollectorEl.disabled = true;
      stopCollectorEl.disabled = true;
      startCollectorEl.disabled = false;
      startCollectorEl.textContent = 'Bắt đầu ghi GPS';
      saveRouteGeometryEl.disabled = true;
    }
    return;
  }

  if (collector.status === 'completed' && !autoCompleteTriggered && !autoSaveInFlight) {
    autoCompleteTriggered = true;
    // Giữ lockedSurveyPath đến khi auto-save xong — chỉ tắt cờ recording.
    recordingActive = false;
    captureStatusEl.textContent = 'Tàu đã đến đích — đang tự lưu tuyến...';
    gpsStatusEl.textContent = 'Đang tự lưu...';
    stopCollectorEl.disabled = true;
    pauseCollectorEl.disabled = true;
    ensureSurveyPathVisible();
  }

  const icon = collectorIcon(collector.heading);
  if (!collectorMarker) {
    collectorMarker = L.marker([collector.lat, collector.lng], { icon, zIndexOffset: 800 }).addTo(map);
    collectorMarker.bindTooltip(collector.boatCode, { permanent: true, direction: 'top', offset: [0, -18] });
  } else {
    collectorMarker.setLatLng([collector.lat, collector.lng]);
    collectorMarker.setIcon(icon);
  }

  const percent = collector.lengthMeters
    ? Math.min(100, (collector.progressMeters / collector.lengthMeters) * 100)
    : 0;
  const sendText = lastCollectorSend
    ? lastCollectorSend.ok
      ? `POST ${lastCollectorSend.status || lastCollectorSend.mode} · seq ${lastCollectorSend.sequence || ''}`
      : lastCollectorSend.soft
        ? `cảnh báo sequence (vẫn ghi local)`
        : `lỗi ${lastCollectorSend.error || lastCollectorSend.status}`
    : 'đang chờ tín hiệu';
  const recordedCount = lastCollectorSend?.recordedCount ?? collector.recordedCount ?? 0;
  collectorStatusEl.textContent = `Đang ghi: ${recordedCount} điểm / ${collector.sendIntervalMs / 1000}s · ${percent.toFixed(1)}% · ${sendText}`;
  pauseCollectorEl.textContent = collector.paused ? 'Tiếp tục' : 'Tạm dừng';
  pauseCollectorEl.disabled = collector.status === 'completed';
  stopCollectorEl.disabled = collector.status === 'completed';
  startCollectorEl.disabled = true;
  startCollectorEl.textContent = 'Đang ghi...';
  saveRouteGeometryEl.disabled = recordedCount < 2;
  gpsStatusEl.textContent = collector.paused ? 'Tạm dừng' : 'Đang ghi GPS';
  ensureSurveyPathVisible();
}

function collectorIcon(heading) {
  return L.divIcon({
    className: '',
    html: `
      <div class="collector-marker">
        <div class="collector-marker-pulse"></div>
        <div class="collector-marker-inner" style="--heading:${heading}deg">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#111827" stroke="#fff" stroke-width="1.5" d="M12 3 L20 19 L12 15 L4 19 Z"></path>
          </svg>
        </div>
      </div>
    `,
    iconSize: [58, 58],
    iconAnchor: [29, 29],
  });
}

function renderPanelLive(data) {
  boatCountEl.textContent = data.boats.length;
  if (stationCountEl) stationCountEl.textContent = String(uniqueStations(data.stations).length);
  dbStatusEl.textContent = data.dbStatus?.ok
    ? `${data.dbStatus.message} · ${formatTime(data.dbStatus.loadedAt)}`
    : `DB lỗi, đang dùng fallback: ${data.dbStatus?.message || ''}`;

  targetTextEl.textContent = data.config?.targetEndpoint || 'Local only';
  toggleSenderEl.textContent = data.config?.senderEnabled ? 'POST on' : 'POST off';
  toggleSenderEl.classList.toggle('secondary', !data.config?.senderEnabled);
  senderBadgeEl.textContent = data.config?.senderEnabled ? 'Live' : 'Idle';
  senderBadgeEl.classList.toggle('is-live', Boolean(data.config?.senderEnabled));

  const boatIds = SHOW_LIVE_BOATS ? data.boats.map((boat) => boat.boatId).join('|') : '';
  if (!SHOW_LIVE_BOATS) {
    boatsEl.innerHTML = '';
    lastBoatIds = '';
  } else if (boatIds !== lastBoatIds) {
    lastBoatIds = boatIds;
    renderBoatCards(data.boats);
  } else {
    updateBoatCards(data.boats);
  }

  if (data.lastSend) {
    const summary = (data.lastSend.results || []).map((result) => {
      if (result.ok) return `${result.boatCode}: ${result.status}`;
      return `${result.boatCode}: lỗi ${result.error || result.status}`;
    }).join(', ');
    const mode = data.lastSend.mode === 'target' ? 'Đã POST BE' : 'GPS local';
    if (!data.collector) {
      sendLogEl.textContent = `${formatTime(data.lastSend.at)} · ${mode} · ${summary}`;
    }
    sendModeEl.textContent = data.lastSend.mode === 'target' ? 'Target' : 'Local';
    sendModeEl.classList.toggle('is-live', data.lastSend.mode === 'target');
  } else if (!data.collector && !autoSaveInFlight) {
    sendLogEl.textContent = data.config?.senderEnabled
      ? 'Đang chờ lần gửi đầu tiên...'
      : 'Chọn bến → vẽ đường → bắt đầu ghi.';
    sendModeEl.textContent = 'Idle';
    sendModeEl.classList.remove('is-live');
  }

  if (data.lastCollectorSend && data.collector) {
    const ok = data.lastCollectorSend.ok;
    const soft = data.lastCollectorSend.soft;
    if (ok) {
      sendLogEl.textContent = `GPS #${data.lastCollectorSend.sequence || data.lastCollectorSend.recordedCount || ''} · ${formatTime(data.lastCollectorSend.at)}`;
    } else if (soft || /sequence/i.test(String(data.lastCollectorSend.error || ''))) {
      sendLogEl.textContent = `Cảnh báo sequence — điểm vẫn ghi local · ${formatTime(data.lastCollectorSend.at)}`;
    } else {
      sendLogEl.textContent = `Lỗi gửi GPS: ${data.lastCollectorSend.error || data.lastCollectorSend.status}`;
    }
    sendModeEl.textContent = data.lastCollectorSend.mode === 'target' ? 'Target' : 'Local';
  }

  checkRouteCodeDuplicate();

  if (payloadLogEl) {
    payloadLogEl.textContent = data.lastCollectorSend
      ? JSON.stringify(data.lastCollectorSend, null, 2)
      : '{}';
  }
}

function renderBoatCards(boats) {
  boatsEl.innerHTML = boats.map((boat) => boatCardHtml(boat)).join('') || '<p class="meta">Chua co tau.</p>';
  bindBoatCardEvents(boats);
}

function updateBoatCards(boats) {
  for (const boat of boats) {
    const card = boatsEl.querySelector(`[data-boat-id="${boat.boatId}"]`);
    if (!card) continue;
    card.querySelector('[data-field="status"]').textContent = boat.status;
    card.querySelector('[data-field="speed"]').textContent = `${boat.speedKmh} km/h`;
    card.querySelector('[data-field="heading"]').textContent = `${boat.heading} deg`;
    card.querySelector('[data-field="lat"]').textContent = String(boat.lat);
    card.querySelector('[data-field="lng"]').textContent = String(boat.lng);
    card.querySelector('[data-field="direction"]').textContent = boat.direction === -1 ? 'Luot ve' : 'Luot di';
    const slider = card.querySelector('[data-speed]');
    if (slider && document.activeElement !== slider) slider.value = String(boat.speedKmh);
    const pauseButton = card.querySelector('[data-pause]');
    if (pauseButton) pauseButton.textContent = boat.paused ? 'Run' : 'Pause';
  }
}

function boatCardHtml(boat) {
  return `
    <article class="boat-card" data-boat-id="${escapeHtml(boat.boatId)}">
      <div class="boat-title">
        <div>
          <strong>${escapeHtml(boat.boatName)}</strong>
          <p class="meta">${escapeHtml(boat.boatCode)} · ${escapeHtml(boat.routeCode || '')}</p>
        </div>
        <span class="badge" data-field="status">${escapeHtml(boat.status)}</span>
      </div>
      <div class="metrics">
        <div class="metric"><span>Toc do</span><b data-field="speed">${boat.speedKmh} km/h</b></div>
        <div class="metric"><span>Huong</span><b data-field="heading">${boat.heading} deg</b></div>
        <div class="metric"><span>Latitude</span><b data-field="lat">${boat.lat}</b></div>
        <div class="metric"><span>Longitude</span><b data-field="lng">${boat.lng}</b></div>
        <div class="metric"><span>Chieu</span><b data-field="direction">${boat.direction === -1 ? 'Luot ve' : 'Luot di'}</b></div>
      </div>
      <div class="control-row">
        <input type="range" min="0" max="${Math.max(boat.maxSpeedKmh || 40, 40)}" step="1" value="${boat.speedKmh}" data-speed="${boat.boatId}">
        <button type="button" class="icon-button" data-focus-boat="${boat.boatId}" title="Xem tau">⌖</button>
        <button type="button" class="secondary" data-pause="${boat.boatId}">${boat.paused ? 'Run' : 'Pause'}</button>
      </div>
    </article>
  `;
}

function bindBoatCardEvents(boats) {
  for (const input of boatsEl.querySelectorAll('[data-speed]')) {
    input.addEventListener('change', () => updateSpeed(input.dataset.speed, input.value));
  }
  for (const button of boatsEl.querySelectorAll('[data-pause]')) {
    button.addEventListener('click', () => {
      const boat = boats.find((item) => item.boatId === button.dataset.pause);
      updatePause(button.dataset.pause, !boat?.paused);
    });
  }
  for (const button of boatsEl.querySelectorAll('[data-focus-boat]')) {
    button.addEventListener('click', () => {
      const boat = boats.find((item) => item.boatId === button.dataset.focusBoat);
      if (boat) map.setView([boat.lat, boat.lng], Math.max(map.getZoom(), 15), { animate: true });
    });
  }
}

async function updateSpeed(boatId, speedKmh) {
  await fetch(`/api/boats/${encodeURIComponent(boatId)}/speed`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ speedKmh: Number(speedKmh) }),
  });
}

async function updatePause(boatId, paused) {
  await fetch(`/api/boats/${encodeURIComponent(boatId)}/pause`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused }),
  });
}

function renderBoats(boats) {
  const seen = new Set();
  for (const boat of boats) {
    seen.add(boat.boatId);
    let marker = markers.get(boat.boatId);
    if (!marker) {
      marker = L.marker([boat.lat, boat.lng], { icon: boatIcon(boat.heading) }).addTo(map);
      marker.bindTooltip(boat.boatCode, { permanent: true, direction: 'top', offset: [0, -18] });
      marker._boatState = `${boat.lat},${boat.lng},${boat.heading}`;
      markers.set(boat.boatId, marker);
    } else {
      const nextState = `${boat.lat},${boat.lng},${boat.heading}`;
      if (marker._boatState !== nextState) {
        marker.setLatLng([boat.lat, boat.lng]);
        marker.setIcon(boatIcon(boat.heading));
        marker._boatState = nextState;
      }
    }
  }
  for (const [id, marker] of markers) {
    if (!seen.has(id)) {
      marker.remove();
      markers.delete(id);
    }
  }
}

function boatIcon(heading) {
  return L.divIcon({
    className: '',
    html: `
      <div class="boat-marker">
        <div class="boat-marker-pulse"></div>
        <div class="boat-marker-inner" style="--heading:${heading}deg">
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

function renderRoutes(routes) {
  const seen = new Set();
  const bounds = [];
  mapLegendEl.innerHTML = '';
  routes.forEach((route, index) => {
    seen.add(route.routeId);
    const color = routeColors[index % routeColors.length];
    let layer = routeLayers.get(route.routeId);
    const latlngs = (route.coordinates || []).map((p) => [p.lat, p.lng]);
    if (!layer) {
      layer = L.polyline(latlngs, { color, weight: 4, opacity: 0.7 }).addTo(map);
      layer.bindTooltip(`${route.routeCode} · ${route.routeName}`);
      routeLayers.set(route.routeId, layer);
    } else {
      layer.setLatLngs(latlngs);
      layer.setStyle({ color });
    }
    for (const p of latlngs) bounds.push(p);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'legend-item';
    item.innerHTML = `<span class="legend-line" style="background:${color}"></span><span>${escapeHtml(route.routeCode)}</span>`;
    item.addEventListener('click', () => {
      if (latlngs.length) map.fitBounds(latlngs, { padding: [40, 40] });
    });
    mapLegendEl.appendChild(item);
  });
  for (const [id, layer] of routeLayers) {
    if (!seen.has(id)) {
      layer.remove();
      routeLayers.delete(id);
    }
  }
  if (!hasFitInitialRoutes && bounds.length && !recordingActive && !lockedSurveyPath) {
    hasFitInitialRoutes = true;
    map.fitBounds(bounds, { padding: [48, 48] });
  }
}

function renderStations(stations) {
  const seen = new Set();
  const startId = startStationEl.value;
  const endId = endStationEl.value;
  for (const station of uniqueStations(stations)) {
    seen.add(station.stationId);
    const role = station.stationId === startId ? 'start'
      : station.stationId === endId ? 'end' : '';
    const icon = stationFlagIcon(station, role);
    let layer = stationLayers.get(station.stationId);
    if (!layer) {
      layer = L.marker([station.lat, station.lng], { icon, zIndexOffset: 400 }).addTo(map);
      layer.bindTooltip(`${station.stationName} (${station.stationCode})`, {
        direction: 'top',
        offset: [0, -28],
      });
      layer.on('click', () => handleStationClick(station));
      stationLayers.set(station.stationId, layer);
    } else {
      layer.setIcon(icon);
      layer.setLatLng([station.lat, station.lng]);
    }
  }
  for (const [id, layer] of stationLayers) {
    if (!seen.has(id)) {
      layer.remove();
      stationLayers.delete(id);
    }
  }
}

function stationFlagIcon(station, role = '') {
  const label = String(station.stationCode || '')
    .replace(/^ST-/i, '')
    .slice(0, 3)
    .toUpperCase() || '•';
  return L.divIcon({
    className: '',
    html: `
      <div class="station-flag${role ? ` is-${role}` : ''}">
        <div class="station-flag-pole"></div>
        <div class="station-flag-cloth">${escapeHtml(label)}</div>
      </div>
    `,
    iconSize: [28, 36],
    iconAnchor: [5, 36],
  });
}

function handleStationClick(station) {
  if (!captureState.points.length || captureState.points[0]?.source !== 'station') {
    startStationEl.value = station.stationId;
    seedFromStation();
    return;
  }
  endStationEl.value = station.stationId;
  seedToEndStation();
}

function formatTime(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleTimeString('vi-VN');
  } catch {
    return String(value);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function roundNumber(value, digits) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

renderCaptureState();
