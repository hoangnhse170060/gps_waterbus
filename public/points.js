const map = L.map('map', { zoomControl: false }).setView([10.776, 106.708], 14);
L.control.zoom({ position: 'bottomleft' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 20,
  attribution: '&copy; OpenStreetMap',
}).addTo(map);

const startStationEl = document.querySelector('#startStation');
const routeCodeEl = document.querySelector('#routeCode');
const routeNameEl = document.querySelector('#routeName');
const modeStraightEl = document.querySelector('#modeStraight');
const modeCurveEl = document.querySelector('#modeCurve');
const toolSelectEl = document.querySelector('#toolSelect');
const toolDrawEl = document.querySelector('#toolDraw');
const drawToolbarEl = document.querySelector('#drawToolbar');
const seedStartEl = document.querySelector('#seedStart');
const undoPointEl = document.querySelector('#undoPoint');
const clearDrawEl = document.querySelector('#clearDraw');
const drawCountEl = document.querySelector('#drawCount');
const drawReadyLabelEl = document.querySelector('#drawReadyLabel');
const finishDrawEl = document.querySelector('#finishDraw');
const mapStatusEl = document.querySelector('#mapStatus');
const pointListEl = document.querySelector('#pointList');
const copyPointsEl = document.querySelector('#copyPoints');
const downloadPointsEl = document.querySelector('#downloadPoints');
const dbStatusEl = document.querySelector('#dbStatus');
const segmentInfoEl = document.querySelector('#segmentInfo');
const routeDistanceEl = document.querySelector('#routeDistance');

const phaseDrawEl = document.querySelector('#phaseDraw');
const phaseRunEl = document.querySelector('#phaseRun');
const phaseDoneEl = document.querySelector('#phaseDone');
const workflowSteps = [...document.querySelectorAll('.workflow-steps .step')];
const runBadgeEl = document.querySelector('#runBadge');
const runSummaryEl = document.querySelector('#runSummary');
const gpsApiEndpointEl = document.querySelector('#gpsApiEndpoint');
const gpsApiKeyEl = document.querySelector('#gpsApiKey');
const gpsApiHintEl = document.querySelector('#gpsApiHint');
const boatSelectEl = document.querySelector('#boatSelect');
const boatDeviceHintEl = document.querySelector('#boatDeviceHint');
const boatSpeedEl = document.querySelector('#boatSpeed');
const sendIntervalEl = document.querySelector('#sendInterval');
const backToDrawFromRunEl = document.querySelector('#backToDrawFromRun');
const startBoatEl = document.querySelector('#startBoat');
const pauseBoatEl = document.querySelector('#pauseBoat');
const stopBoatEl = document.querySelector('#stopBoat');
const runControlsEl = document.querySelector('#runControls');
const gpsLiveCardEl = document.querySelector('.gps-live-card');
const gpsLiveStatusEl = document.querySelector('#gpsLiveStatus');
const gpsLiveDetailEl = document.querySelector('#gpsLiveDetail');
const lastGpsPayloadEl = document.querySelector('#lastGpsPayload');
const doneSummaryEl = document.querySelector('#doneSummary');
const doneRouteResultEl = document.querySelector('#doneRouteResult');
const saveRouteEl = document.querySelector('#saveRoute');
const backToDrawEl = document.querySelector('#backToDraw');

let stations = [];
let boats = [];
let latestSnapshot = null;
let roadLayers = { casing: null, surface: null, center: null, highlight: null };
let helperLines = [];
let drawMarkers = [];
let controlMarkers = [];
let stationLayers = new Map();
let boatMarker = null;
let lastBoatView = null;
let recordingSession = null;
let autoStopPending = false;

const workflow = { phase: 'draw', boatRunning: false };

const drawState = {
  tool: 'select',
  segmentMode: 'curve',
  selectedSegmentIndex: null,
  selectedWaypointIndex: null,
  points: [],
};

startStationEl.addEventListener('change', () => {
  seedStartEl.disabled = !startStationEl.value || !isDrawEditable();
  suggestRouteMeta();
});
routeCodeEl.addEventListener('input', updateDrawReady);
routeNameEl.addEventListener('input', updateDrawReady);
seedStartEl.addEventListener('click', () => {
  const station = getStationById(startStationEl.value);
  if (!station || !isDrawEditable()) return;
  clearDraw();
  addDrawPoint(station, { source: 'station-start', label: station.stationName, stationId: station.stationId });
  setTool('draw');
  setStatus(`Ben dau: ${station.stationName}. Ve it diem, dung net cong + keo handle.`);
  suggestRouteMeta();
});
toolSelectEl.addEventListener('click', () => { if (isDrawEditable()) setTool('select'); });
toolDrawEl.addEventListener('click', () => { if (isDrawEditable()) setTool('draw'); });
modeStraightEl.addEventListener('click', () => { if (isDrawEditable()) setSegmentMode('straight'); });
modeCurveEl.addEventListener('click', () => { if (isDrawEditable()) setSegmentMode('curve'); });
undoPointEl.addEventListener('click', () => { if (isDrawEditable()) undoLastPoint(); });
clearDrawEl.addEventListener('click', () => { if (isDrawEditable()) clearDraw(); });
finishDrawEl.addEventListener('click', finishDraw);
backToDrawFromRunEl.addEventListener('click', () => setPhase('draw'));
startBoatEl.addEventListener('click', startBoat);
pauseBoatEl.addEventListener('click', pauseBoat);
stopBoatEl.addEventListener('click', stopBoat);
saveRouteEl.addEventListener('click', saveRoute);
backToDrawEl.addEventListener('click', resetWorkflow);
copyPointsEl.addEventListener('click', copyJson);
downloadPointsEl.addEventListener('click', downloadJson);

map.on('click', (event) => {
  if (!isDrawEditable()) return;
  if (drawState.tool === 'draw') {
    if (!drawState.points.length) {
      setStatus('Chon ben xuat phat truoc.');
      return;
    }
    if (hasEndPoint()) {
      setStatus('Da co ben ket thuc. Xoa ben cuoi de ve tiep.');
      return;
    }
    addDrawPoint(event.latlng, { source: 'manual', segmentType: drawState.segmentMode });
    return;
  }
  const segmentIndex = findNearestSegment(event.latlng);
  if (segmentIndex > 0) selectSegment(segmentIndex);
  else setStatus('Click gan duong de chon doan.');
});

const events = new EventSource('/events');
events.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data);
    latestSnapshot = data;
    if (data.config) updateGpsApiHint(data.config);
    renderBoatFromSnapshot(data);
  } catch { /* ignore malformed SSE */ }
};

loadData();
loadGpsApiConfig();

async function loadGpsApiConfig() {
  try {
    const response = await fetch('/api/config');
    const config = await response.json();
    let savedEndpoint = localStorage.getItem('gpsApiEndpoint') || '';
    const serverEndpoint = config.targetEndpoint || '';

    if (savedEndpoint.includes('localhost:7175') && serverEndpoint && !serverEndpoint.includes('localhost')) {
      savedEndpoint = '';
      localStorage.removeItem('gpsApiEndpoint');
    }

    gpsApiEndpointEl.value = savedEndpoint || serverEndpoint;
  } catch {
    gpsApiEndpointEl.value = '';
  }
  updateGpsApiHint(latestSnapshot?.config || null);
}

function updateGpsApiHint(config) {
  const endpoint = gpsApiEndpointEl.value.trim();
  if (!endpoint) {
    gpsApiHintEl.textContent = 'Nhap URL API BE hoac cau hinh trong .env';
    gpsApiHintEl.style.color = 'var(--end)';
    return;
  }
  const enabled = config?.senderEnabled !== false;
  gpsApiHintEl.textContent = enabled
    ? `POST GPS den: ${endpoint}`
    : `Se bat POST khi cho tau chay`;
  gpsApiHintEl.style.color = 'var(--muted)';
}

gpsApiEndpointEl.addEventListener('input', () => {
  localStorage.setItem('gpsApiEndpoint', gpsApiEndpointEl.value.trim());
  updateGpsApiHint(latestSnapshot?.config || null);
});

boatSelectEl.addEventListener('change', updateBoatDeviceHint);

async function ensureSenderReady() {
  const endpoint = gpsApiEndpointEl.value.trim();
  const config = latestSnapshot?.config || {};
  const payload = { enabled: true };

  if (endpoint && endpoint !== config.targetEndpoint) {
    payload.endpoint = endpoint;
  }
  const apiKey = gpsApiKeyEl.value.trim();
  if (apiKey) payload.apiKey = apiKey;
  else if (config.hasApiKey) payload.apiKey = '';

  if (!config.targetEndpoint && !endpoint) {
    throw new Error('Nhap URL API BE hoac cau hinh TARGET_GPS_ENDPOINT trong .env');
  }

  if (!config.senderEnabled || payload.endpoint || payload.apiKey) {
    const response = await fetch('/api/sender', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Khong bat duoc gui GPS');
    if (payload.endpoint) localStorage.setItem('gpsApiEndpoint', payload.endpoint);
    updateGpsApiHint(body);
  }
}

async function loadData() {
  dbStatusEl.textContent = 'Dang nap...';
  try {
    const response = await fetch('/api/snapshot');
    const data = await response.json();
    latestSnapshot = data;
    stations = uniqueStations(data.stations || []);
    boats = [...(data.boats || [])].sort((a, b) => String(a.boatCode).localeCompare(String(b.boatCode), 'vi'));
    dbStatusEl.textContent = data.dbStatus?.ok ? data.dbStatus.message : `DB loi: ${data.dbStatus?.message}`;
    if (data.config) updateGpsApiHint(data.config);
    renderStationOptions();
    renderBoatOptions();
    renderStationsOnMap();
    if (stations.length) fitMapToContent();
  } catch (error) {
    dbStatusEl.textContent = `Loi: ${error.message}`;
  }
}

function isDrawEditable() {
  return workflow.phase === 'draw' && !workflow.boatRunning;
}

function setPhase(phase) {
  workflow.phase = phase;
  phaseDrawEl.classList.toggle('hidden', phase !== 'draw');
  phaseRunEl.classList.toggle('hidden', phase !== 'run');
  phaseDoneEl.classList.toggle('hidden', phase !== 'done');
  drawToolbarEl.classList.toggle('is-locked', phase !== 'draw');

  for (const step of workflowSteps) {
    const key = step.dataset.step;
    step.classList.remove('is-active', 'is-done');
    if (key === phase) step.classList.add('is-active');
    else if (
      (key === 'draw' && (phase === 'run' || phase === 'done'))
      || (key === 'run' && phase === 'done')
    ) step.classList.add('is-done');
  }

  if (phase === 'draw') {
    setStatus('Buoc 1: Chon ben dau, ve duong, chon ben cuoi.');
    backToDrawFromRunEl.classList.remove('hidden');
    startBoatEl.classList.remove('hidden');
    runControlsEl.classList.add('hidden');
    runBadgeEl.textContent = 'San sang';
    gpsLiveCardEl.classList.remove('is-live');
    gpsLiveStatusEl.textContent = 'Chua chay';
    gpsLiveDetailEl.textContent = '0 diem da gui BE';
    lastGpsPayloadEl.textContent = '{}';
  } else if (phase === 'run') {
    const expanded = expandPath(drawState.points);
    const km = (pathLengthMeters(expanded) / 1000).toFixed(2);
    runSummaryEl.textContent = `Tau se chay ${km} km doc tuyen "${routeNameEl.value.trim() || routeCodeEl.value.trim()}" va tu dong POST GPS len API BE.`;
    setStatus('Buoc 2: Nhap API BE (neu chua co) roi bam "Cho tau chay".');
    backToDrawFromRunEl.classList.toggle('hidden', workflow.boatRunning);
    startBoatEl.classList.toggle('hidden', workflow.boatRunning);
    runControlsEl.classList.toggle('hidden', !workflow.boatRunning);
    gpsApiEndpointEl.disabled = workflow.boatRunning;
    gpsApiKeyEl.disabled = workflow.boatRunning;
    boatSelectEl.disabled = workflow.boatRunning;
  } else if (phase === 'done') {
    const count = recordingSession?.recordedPoints?.length || 0;
    doneSummaryEl.textContent = count
      ? `Tau da chay xong (${count} diem GPS). Se tu dong luu len BE khi den dich.`
      : 'Tau da dung nhung chua co diem GPS. Co the ve lai va chay lai.';
    setStatus('Buoc 3: Luu route len BE hoac export JSON.');
    saveRouteEl.disabled = count < 2;
  }
  updateDrawReady();
  renderPanel();
}

function finishDraw() {
  if (!canFinishDraw()) return;
  suggestRouteMeta(true);
  setPhase('run');
}

function canFinishDraw() {
  return drawState.points.length >= 2
    && drawState.points[0]?.source === 'station-start'
    && hasEndPoint()
    && routeCodeEl.value.trim().length > 0;
}

function updateDrawReady() {
  const ready = canFinishDraw();
  drawReadyLabelEl.textContent = ready ? 'San sang' : 'Chua du';
  drawReadyLabelEl.style.color = ready ? 'var(--start)' : '';
  finishDrawEl.disabled = !ready || workflow.phase !== 'draw';
  seedStartEl.disabled = !startStationEl.value || !isDrawEditable();
  undoPointEl.disabled = !drawState.points.length || !isDrawEditable();
  clearDrawEl.disabled = !drawState.points.length || !isDrawEditable();
}

function suggestRouteMeta(force = false) {
  const start = drawState.points[0];
  const end = drawState.points.at(-1);
  if (!start?.label) return;
  const startCode = abbrevStation(start.label);
  const endCode = end?.source === 'station-end' ? abbrevStation(end.label) : '';
  if ((force || !routeCodeEl.value.trim()) && endCode) {
    routeCodeEl.value = sanitizeRouteCode(`${startCode}-${endCode}`);
  }
  if ((force || !routeNameEl.value.trim()) && end?.label) {
    routeNameEl.value = `${start.label} - ${end.label}`;
  }
}

function abbrevStation(name) {
  const ascii = String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/Đ/g, 'D')
    .replace(/đ/g, 'd');
  return ascii
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('')
    .slice(0, 6) || 'RT';
}

function sanitizeRouteCode(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/Đ/g, 'D')
    .replace(/đ/g, 'd')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase()
    .slice(0, 32) || 'ROUTE';
}

async function startBoat() {
  const routeCode = routeCodeEl.value.trim();
  const routeName = routeNameEl.value.trim() || routeCode;
  if (!routeCode) {
    setStatus('Nhap ma tuyen truoc khi cho tau chay.');
    routeCodeEl.focus();
    return;
  }

  const expanded = expandPath(drawState.points);
  if (expanded.length < 2) {
    setStatus('Tuyen qua ngan de cho tau chay.');
    return;
  }

  const sendIntervalMs = clampNumber(Number(sendIntervalEl.value || 5), 3, 10) * 1000;
  startBoatEl.disabled = true;
  startBoatEl.textContent = 'Dang bat dau...';
  workflow.boatRunning = true;
  autoStopPending = false;
  setPhase('run');

  try {
    await ensureSenderReady();

    const start = drawState.points[0];
    const end = drawState.points.at(-1);
    const response = await fetch('/api/collector/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        routeCode: sanitizeRouteCode(routeCode),
        routeName,
        boatCode: getSelectedBoatCode(),
        speedKmh: Number(boatSpeedEl.value || 16),
        sendIntervalMs,
        sendToTarget: true,
        recording: true,
        isNewRouteSurvey: true,
        startStationId: start?.stationId || startStationEl.value || null,
        endStationId: end?.source === 'station-end' ? end.stationId : null,
        coordinates: expanded.map(({ lat, lng }) => ({ lat, lng })),
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Khong bat dau duoc tau');

    runBadgeEl.textContent = 'Dang chay';
    gpsLiveCardEl.classList.add('is-live');
    gpsLiveStatusEl.textContent = `Dang chay · ${body.boatCode}`;
    if (body.targetSessionWarning) {
      setStatus(`Tau dang chay. Canh bao BE: ${body.targetSessionWarning}`);
    } else {
      setStatus(`Dang ghi GPS moi ${sendIntervalMs / 1000}s · ${body.boatCode} · device ${deviceIdForBoatCode(body.boatCode)}`);
    }
    backToDrawFromRunEl.classList.add('hidden');
    startBoatEl.classList.add('hidden');
    runControlsEl.classList.remove('hidden');
    pauseBoatEl.textContent = 'Pause';
    pauseBoatEl.disabled = false;
    stopBoatEl.disabled = false;
  } catch (error) {
    workflow.boatRunning = false;
    setStatus(`Loi: ${error.message}`);
    runBadgeEl.textContent = 'Loi';
    gpsLiveCardEl.classList.remove('is-live');
    backToDrawFromRunEl.classList.remove('hidden');
    startBoatEl.classList.remove('hidden');
    runControlsEl.classList.add('hidden');
  } finally {
    startBoatEl.disabled = false;
    startBoatEl.textContent = '▶ Cho tau chay';
  }
}

async function pauseBoat() {
  if (!latestSnapshot?.collector) return;
  await fetch('/api/collector/pause', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused: !latestSnapshot.collector.paused }),
  });
}

async function stopBoat({ autoSaveRoute = false } = {}) {
  stopBoatEl.disabled = true;
  stopBoatEl.textContent = 'Dang dung...';
  try {
    const response = await fetch('/api/collector/stop', { method: 'POST' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Khong dung duoc tau');
    recordingSession = body.session || null;
    if (body.stopped) {
      lastBoatView = {
        lat: body.stopped.lat,
        lng: body.stopped.lng,
        heading: body.stopped.heading,
        boatCode: body.stopped.boatCode,
      };
    } else if (recordingSession?.recordedPoints?.length) {
      const lastPoint = recordingSession.recordedPoints.at(-1);
      lastBoatView = {
        lat: lastPoint.lat,
        lng: lastPoint.lng,
        heading: lastBoatView?.heading || 0,
        boatCode: recordingSession.boatCode || getSelectedBoatCode(),
      };
    }
    workflow.boatRunning = false;
    runBadgeEl.textContent = 'Da dung';
    gpsLiveCardEl.classList.remove('is-live');
    gpsLiveStatusEl.textContent = 'Da dung';
    setPhase('done');

    if (autoSaveRoute && recordingSession?.recordedPoints?.length >= 2) {
      setStatus('Tau da den dich. Dang tu dong luu route len BE...');
      await saveRoute({ auto: true });
    } else if (autoSaveRoute) {
      setStatus('Tau da den dich. Chua du diem GPS de tu dong luu len BE.');
    }
  } catch (error) {
    setStatus(`Loi: ${error.message}`);
  } finally {
    stopBoatEl.disabled = false;
    stopBoatEl.textContent = 'Dung';
  }
}

async function saveRoute({ auto = false } = {}) {
  const routeCode = routeCodeEl.value.trim();
  const routeName = routeNameEl.value.trim() || routeCode;
  if (!routeCode) {
    if (!auto) setStatus('Nhap ma tuyen truoc khi luu.');
    else doneSummaryEl.textContent = 'Tau da den dich nhung chua co ma tuyen de luu len BE.';
    return;
  }
  if (!recordingSession?.recordedPoints?.length && !auto) {
    setStatus('Chua co diem GPS de luu.');
    return;
  }
  saveRouteEl.disabled = true;
  saveRouteEl.textContent = auto ? 'Dang tu dong luu...' : 'Dang luu...';
  doneRouteResultEl.classList.add('hidden');
  doneRouteResultEl.innerHTML = '';
  try {
    const response = await fetch('/api/recording/save-route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        routeCode: sanitizeRouteCode(routeCode),
        routeName,
        description: 'Captured from GPS recording session',
        status: 'Active',
        averageSpeedKmh: Number(boatSpeedEl.value || 16),
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      if (response.status === 409) {
        throw new Error(body.error || 'Ma tuyen da ton tai tren BE. Hay doi ma tuyen khac.');
      }
      throw new Error(body.error || 'Khong luu duoc route');
    }
    renderSavedRouteResult(body, routeCode);
    recordingSession = null;
    await fetch('/api/refresh', { method: 'POST' });
    await loadData();
    setStatus(`Da luu route ${body.routeCode || routeCode}.`);
  } catch (error) {
    const msg = error.message || 'Khong luu duoc route';
    if (auto) {
      doneSummaryEl.textContent = `Tau da den dich nhung luu BE loi: ${msg}. Bam "Luu route len BE" de thu lai.`;
    }
    setStatus(`Loi: ${msg}`);
  } finally {
    saveRouteEl.textContent = 'Luu route len BE';
    saveRouteEl.disabled = false;
  }
}

function renderSavedRouteResult(body, fallbackCode) {
  const savedWhere = body.savedTo === 'target' ? 'BE Azure' : 'DB local';
  const routeCode = body.routeCode || fallbackCode;
  const distance = body.baseDistanceKm ?? body.distanceKm ?? '?';
  const duration = body.estimatedDurationMin;
  doneSummaryEl.textContent = `Da luu route ${routeCode} (${distance} km) vao ${savedWhere}.`;

  if (body.savedTo !== 'target') return;

  const stops = Array.isArray(body.stops) ? body.stops : [];
  const stopLines = stops.map((stop) => {
    const travel = stop.standardTravelMin != null ? ` · ${stop.standardTravelMin} phut` : '';
    return `<li><strong>${escapeHtml(stop.stationName || `Ben ${stop.stopOrder}`)}</strong> (#${stop.stopOrder}${travel})</li>`;
  }).join('');

  doneRouteResultEl.innerHTML = `
    <div class="route-result-head">
      <strong>${escapeHtml(body.routeName || routeCode)}</strong>
      <span>${escapeHtml(routeCode)}</span>
    </div>
    <div class="route-result-meta">
      ${duration != null ? `<span>Thoi gian uoc tinh: <b>${duration} phut</b></span>` : ''}
      ${distance !== '?' ? `<span>Quang duong: <b>${distance} km</b></span>` : ''}
    </div>
    ${stops.length ? `<ul class="route-result-stops">${stopLines}</ul>` : ''}
  `;
  doneRouteResultEl.classList.remove('hidden');
}

function resetWorkflow() {
  if (workflow.boatRunning) return;
  recordingSession = null;
  workflow.boatRunning = false;
  autoStopPending = false;
  doneRouteResultEl.classList.add('hidden');
  doneRouteResultEl.innerHTML = '';
  lastBoatView = null;
  if (boatMarker) {
    boatMarker.remove();
    boatMarker = null;
  }
  setPhase('draw');
}

function showBoatMarker(view) {
  if (!view) return;
  const icon = collectorSurveyIcon(view.heading);
  if (!boatMarker) {
    boatMarker = L.marker([view.lat, view.lng], { icon, zIndexOffset: 900 }).addTo(map);
    boatMarker.bindTooltip(view.boatCode, { permanent: true, direction: 'top', offset: [0, -18] });
  } else {
    boatMarker.setLatLng([view.lat, view.lng]);
    boatMarker.setIcon(icon);
    boatMarker.setTooltipContent(view.boatCode);
  }
}

function renderBoatFromSnapshot(data) {
  const collector = data.collector;
  const lastSend = data.lastCollectorSend;
  const session = data.recordingSession;

  if (collector) {
    lastBoatView = {
      lat: collector.lat,
      lng: collector.lng,
      heading: collector.heading,
      boatCode: collector.boatCode,
    };
    showBoatMarker(lastBoatView);

    const recordedCount = lastSend?.recordedCount ?? collector.recordedCount ?? 0;
    const percent = collector.lengthMeters
      ? Math.min(100, (collector.progressMeters / collector.lengthMeters) * 100)
      : 0;
    const sendText = lastSend
      ? lastSend.ok
        ? `POST ${lastSend.status || 200} · seq ${lastSend.payload?.sequence ?? ''}`
        : `loi ${lastSend.error || lastSend.status}`
      : 'cho tin hieu';

    gpsLiveCardEl.classList.toggle('is-live', lastSend?.ok !== false);
    gpsLiveStatusEl.textContent = collector.paused
      ? 'Tam dung'
      : `Dang ghi: ${recordedCount} diem · ${percent.toFixed(1)}%`;

    const parts = [];
    if (collector.targetSessionWarning) parts.push(`Session: ${collector.targetSessionWarning}`);
    if (lastSend?.ok) parts.push(sendText);
    else if (lastSend) parts.push(`GPS: ${sendText}`);
    else parts.push('Dang gui GPS...');
    gpsLiveDetailEl.textContent = parts.join(' · ');

    mapStatusEl.textContent = `Tau ${collector.boatCode} · ${percent.toFixed(0)}% · ${parts.join(' · ')}`;

    if (lastSend?.payload) {
      lastGpsPayloadEl.textContent = JSON.stringify(lastSend.payload, null, 2);
    }
    pauseBoatEl.textContent = collector.paused ? 'Run' : 'Pause';
    pauseBoatEl.disabled = collector.status === 'completed';
    stopBoatEl.disabled = false;
    runBadgeEl.textContent = collector.paused ? 'Pause' : 'Dang chay';
    saveRouteEl.disabled = recordedCount < 2;

    if (collector.status === 'completed' && workflow.boatRunning && !autoStopPending) {
      autoStopPending = true;
      stopBoat({ autoSaveRoute: true });
    }
    return;
  }

  if (lastBoatView && (workflow.phase === 'done' || workflow.phase === 'run')) {
    showBoatMarker(lastBoatView);
  } else if (boatMarker) {
    boatMarker.remove();
    boatMarker = null;
  }

  if (session?.recordedPoints?.length && workflow.phase === 'run' && workflow.boatRunning) {
    recordingSession = session;
    workflow.boatRunning = false;
    setPhase('done');
  }
}

function collectorSurveyIcon(heading) {
  return L.divIcon({
    className: '',
    html: `
      <div class="collector-marker">
        <div class="collector-marker-pulse"></div>
        <div class="collector-marker-inner" style="--heading:${heading}deg">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3 L20 19 L12 15 L4 19 Z"></path>
          </svg>
        </div>
      </div>
    `,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function setTool(tool) {
  drawState.tool = tool;
  toolSelectEl.classList.toggle('is-active', tool === 'select');
  toolDrawEl.classList.toggle('is-active', tool === 'draw');
  setStatus(tool === 'draw' ? 'Che do ve: click them diem tren luong.' : 'Che do chon: click doan de chinh thang/cong.');
}

function setSegmentMode(mode) {
  drawState.segmentMode = mode;
  modeStraightEl.classList.toggle('is-active', mode === 'straight');
  modeCurveEl.classList.toggle('is-active', mode === 'curve');
}

function setStatus(text) {
  mapStatusEl.textContent = text;
}

function uniqueStations(items) {
  const byId = new Map();
  for (const station of items) byId.set(station.stationId, station);
  return [...byId.values()].sort((a, b) => String(a.stationName).localeCompare(String(b.stationName), 'vi'));
}

function renderBoatOptions() {
  const saved = localStorage.getItem('surveyBoatCode') || 'WB_001';
  const realBoats = boats.filter((boat) => boat.boatCode);
  const options = [
    ...realBoats.map((boat) => ({
      code: boat.boatCode,
      label: `${boat.boatCode}${boat.boatName ? ` · ${boat.boatName}` : ''}`,
    })),
    { code: 'SURVEY-01', label: 'SURVEY-01 · Khao sat (can BE dang ky rieng)' },
  ];
  boatSelectEl.innerHTML = options.map((item) => (
    `<option value="${escapeHtml(item.code)}">${escapeHtml(item.label)}</option>`
  )).join('');
  const preferred = options.some((item) => item.code === saved) ? saved : (options[0]?.code || 'WB_001');
  boatSelectEl.value = preferred;
  updateBoatDeviceHint();
}

function getSelectedBoatCode() {
  return boatSelectEl.value.trim() || 'WB_001';
}

function deviceIdForBoatCode(boatCode) {
  return `gps-${String(boatCode || 'WB_001').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function updateBoatDeviceHint() {
  const boatCode = getSelectedBoatCode();
  const deviceId = deviceIdForBoatCode(boatCode);
  localStorage.setItem('surveyBoatCode', boatCode);
  boatDeviceHintEl.textContent = `deviceId gui BE: ${deviceId} · BE can dang ky device nay trong gps_devices`;
}

function renderStationOptions() {
  const selected = startStationEl.value;
  startStationEl.innerHTML = [
    '<option value="">Chon ben...</option>',
    ...stations.map((station) => `<option value="${escapeHtml(station.stationId)}">${escapeHtml(station.stationName)}</option>`),
  ].join('');
  if (selected) startStationEl.value = selected;
  seedStartEl.disabled = !startStationEl.value || !isDrawEditable();
}

function renderStationsOnMap() {
  const seen = new Set();
  for (const station of stations) {
    seen.add(station.stationId);
    let layer = stationLayers.get(station.stationId);
    const icon = L.divIcon({
      className: 'station-icon-wrap',
      html: `<div class="station-pin">${escapeHtml(station.stationName)}</div>`,
      iconAnchor: [0, 12],
    });
    if (!layer) {
      layer = L.marker([station.lat, station.lng], { icon }).addTo(map);
      layer.on('click', (event) => {
        if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
        if (isDrawEditable()) handleStationClick(station);
      });
      stationLayers.set(station.stationId, layer);
    } else {
      layer.setLatLng([station.lat, station.lng]);
    }
  }
  for (const [id, layer] of stationLayers) {
    if (!seen.has(id)) { layer.remove(); stationLayers.delete(id); }
  }
}

function handleStationClick(station) {
  if (!drawState.points.length) {
    startStationEl.value = station.stationId;
    clearDraw();
    addDrawPoint(station, { source: 'station-start', label: station.stationName, stationId: station.stationId });
    setTool('draw');
    setStatus(`Ben dau: ${station.stationName}`);
    suggestRouteMeta();
    return;
  }
  if (station.stationId === drawState.points[0]?.stationId) {
    setStatus('Ben cuoi phai khac ben dau.');
    return;
  }
  setEndStation(station);
}

function setEndStation(station) {
  removeEndPoint();
  addDrawPoint(station, { source: 'station-end', label: station.stationName, stationId: station.stationId });
  setTool('select');
  setStatus(`Ben cuoi: ${station.stationName}. Chon doan de chinh hinh hoac "Hoan thanh ve".`);
  suggestRouteMeta();
}

function createPoint(latlng, meta = {}) {
  const point = {
    lat: roundNumber(latlng.lat, 9),
    lng: roundNumber(latlng.lng, 9),
    source: meta.source || 'manual',
    label: meta.label || '',
    stationId: meta.stationId || '',
    segmentType: meta.segmentType || drawState.segmentMode,
    controlLat: null,
    controlLng: null,
  };
  const prev = drawState.points.at(-1);
  if (prev && point.segmentType === 'curve') {
    const control = defaultControl(prev, point);
    point.controlLat = control.lat;
    point.controlLng = control.lng;
  }
  return point;
}

function addDrawPoint(latlng, meta = {}) {
  const point = createPoint(latlng, meta);
  if (!drawState.points.length) point.segmentType = null;
  drawState.points.push(point);
  drawState.selectedSegmentIndex = drawState.points.length > 1 ? drawState.points.length - 1 : null;
  drawState.selectedWaypointIndex = drawState.points.length - 1;
  renderAll();
}

function selectSegment(index) {
  if (!isDrawEditable()) return;
  drawState.selectedSegmentIndex = index;
  drawState.selectedWaypointIndex = index;
  renderAll();
  const point = drawState.points[index];
  const prev = drawState.points[index - 1];
  const type = point.segmentType === 'curve' ? 'cong' : 'thang';
  setStatus(`Doan ${index}: ${prev.label || `#${index}`} → ${point.label || `#${index + 1}`} (${type})`);
}

function toggleSegmentType(index) {
  if (!isDrawEditable()) return;
  const point = drawState.points[index];
  if (!point || index === 0) return;
  const prev = drawState.points[index - 1];
  if (point.segmentType === 'curve') {
    point.segmentType = 'straight';
    point.controlLat = null;
    point.controlLng = null;
  } else {
    point.segmentType = 'curve';
    const control = defaultControl(prev, point);
    point.controlLat = control.lat;
    point.controlLng = control.lng;
  }
  renderAll();
}

function removeEndPoint() {
  if (hasEndPoint()) drawState.points.pop();
}

function hasEndPoint() {
  return drawState.points.at(-1)?.source === 'station-end';
}

function undoLastPoint() {
  if (!drawState.points.length) return;
  drawState.points.pop();
  drawState.selectedSegmentIndex = drawState.points.length > 1 ? drawState.points.length - 1 : null;
  renderAll();
  setStatus('Da undo diem cuoi.');
}

function clearDraw() {
  drawState.points = [];
  drawState.selectedSegmentIndex = null;
  drawState.selectedWaypointIndex = null;
  renderAll();
  setStatus('Da xoa. Chon ben dau de bat dau.');
}

function clearDrawLayers() {
  for (const key of Object.keys(roadLayers)) {
    if (roadLayers[key]) { roadLayers[key].remove(); roadLayers[key] = null; }
  }
  for (const line of helperLines) line.remove();
  helperLines = [];
  for (const marker of drawMarkers) marker.remove();
  drawMarkers = [];
  for (const marker of controlMarkers) marker.remove();
  controlMarkers = [];
}

function updateDrawVisuals() {
  for (const key of Object.keys(roadLayers)) {
    if (roadLayers[key]) { roadLayers[key].remove(); roadLayers[key] = null; }
  }
  for (const line of helperLines) line.remove();
  helperLines = [];
  if (!drawState.points.length) return;

  const expanded = expandPath(drawState.points);
  const latlngs = expanded.map((p) => [p.lat, p.lng]);
  const roadStyle = { lineCap: 'round', lineJoin: 'round', smoothFactor: 1.2 };

  roadLayers.casing = L.polyline(latlngs, { ...roadStyle, color: roadLayersColor().edge, weight: 16, opacity: 0.92 }).addTo(map);
  roadLayers.surface = L.polyline(latlngs, { ...roadStyle, color: roadLayersColor().fill, weight: 10, opacity: 0.95 }).addTo(map);
  roadLayers.center = L.polyline(latlngs, { ...roadStyle, color: '#fbbf24', weight: 1.5, opacity: 0.75, dashArray: '10 14' }).addTo(map);

  if (drawState.selectedSegmentIndex > 0) {
    const seg = getSegmentLatLngs(drawState.selectedSegmentIndex);
    if (seg.length) {
      roadLayers.highlight = L.polyline(seg, { ...roadStyle, color: '#0f766e', weight: 14, opacity: 0.45 }).addTo(map);
    }
    const prev = drawState.points[drawState.selectedSegmentIndex - 1];
    const current = drawState.points[drawState.selectedSegmentIndex];
    if (current.segmentType === 'curve') {
      const control = getControlPoint(prev, current);
      helperLines.push(L.polyline(
        [[prev.lat, prev.lng], [control.lat, control.lng], [current.lat, current.lng]],
        { color: '#f59e0b', weight: 2, opacity: 0.9, dashArray: '3 5' },
      ).addTo(map));
    }
  }
}

function roadLayersColor() {
  return { edge: '#1e3a5f', fill: '#2563eb' };
}

function getSegmentLatLngs(index) {
  return getSegmentExpandedPoints(index).map((p) => [p.lat, p.lng]);
}

function getSegmentExpandedPoints(index) {
  const slice = expandPath(drawState.points.slice(0, index + 1));
  const full = expandPath(drawState.points.slice(0, index));
  return slice.slice(full.length);
}

function pathLengthMeters(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += distanceMeters(points[i - 1], points[i]);
  }
  return total;
}

function distanceMeters(a, b) {
  const earth = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function toRad(value) {
  return value * Math.PI / 180;
}

function syncControlMarkers() {
  for (const marker of controlMarkers) marker.remove();
  controlMarkers = [];
  if (!isDrawEditable()) return;
  const index = drawState.selectedSegmentIndex;
  if (!index || index < 1) return;
  const prev = drawState.points[index - 1];
  const current = drawState.points[index];
  if (current.segmentType !== 'curve') return;

  const control = getControlPoint(prev, current);
  const handle = L.marker([control.lat, control.lng], {
    draggable: true,
    icon: L.divIcon({ className: '', html: '<div class="control-handle"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }),
  }).addTo(map);

  handle.on('drag', () => {
    const latlng = handle.getLatLng();
    current.controlLat = roundNumber(latlng.lat, 9);
    current.controlLng = roundNumber(latlng.lng, 9);
    updateDrawVisuals();
    renderPanel();
  });
  handle.on('dragend', () => renderDrawMarkers());
  controlMarkers.push(handle);
}

function renderDrawMarkers() {
  for (const marker of drawMarkers) marker.remove();
  drawMarkers = [];

  const editable = isDrawEditable();
  drawMarkers = drawState.points.map((point, index) => {
    const isSelected = drawState.selectedWaypointIndex === index;
    const kind = point.source === 'station-start' ? 'is-start'
      : point.source === 'station-end' ? 'is-end'
        : isSelected ? 'is-selected' : '';
    const showLabel = point.label && (point.source === 'station-start' || point.source === 'station-end' || isSelected);
    const marker = L.marker([point.lat, point.lng], {
      draggable: editable,
      icon: L.divIcon({
        className: 'waypoint-wrap',
        html: `
          <div class="waypoint-stack">
            ${showLabel ? `<div class="waypoint-label">${escapeHtml(point.label)}</div>` : ''}
            <div class="waypoint-node ${kind}"></div>
          </div>
        `,
        iconSize: [20, showLabel ? 36 : 20],
        iconAnchor: [10, showLabel ? 30 : 10],
      }),
    }).addTo(map);

    marker.on('click', (event) => {
      if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
      if (!editable) return;
      drawState.selectedWaypointIndex = index;
      if (index > 0) drawState.selectedSegmentIndex = index;
      renderAll();
    });

    if (editable) {
      marker.on('drag', () => {
        const latlng = marker.getLatLng();
        point.lat = roundNumber(latlng.lat, 9);
        point.lng = roundNumber(latlng.lng, 9);
        updateDrawVisuals();
        renderPanel();
      });
      marker.on('dragend', () => renderDrawMarkers());
    }
    return marker;
  });
  syncControlMarkers();
}

function renderDrawLayers() {
  clearDrawLayers();
  if (!drawState.points.length) return;
  updateDrawVisuals();
  renderDrawMarkers();
}

function renderPanel() {
  const expanded = expandPath(drawState.points);
  const totalMeters = pathLengthMeters(expanded);
  drawCountEl.textContent = `${drawState.points.length} diem`;
  routeDistanceEl.textContent = formatDistance(totalMeters);
  updateDrawReady();

  copyPointsEl.disabled = drawState.points.length < 2;
  downloadPointsEl.disabled = drawState.points.length < 2;

  if (drawState.selectedSegmentIndex > 0 && isDrawEditable()) {
    const point = drawState.points[drawState.selectedSegmentIndex];
    const prev = drawState.points[drawState.selectedSegmentIndex - 1];
    const type = point.segmentType === 'curve' ? 'Cong' : 'Thang';
    segmentInfoEl.textContent = `${prev.label || `Diem ${drawState.selectedSegmentIndex}`} → ${point.label || `Diem ${drawState.selectedSegmentIndex + 1}`} · ${type} (double-click de doi)`;
  } else {
    segmentInfoEl.textContent = isDrawEditable()
      ? 'Click duong de chinh doan. Keo handle vang de uon cong.'
      : 'Tuyen da khoa. Cho tau chay hoac quay lai buoc 1.';
  }

  if (!drawState.points.length) {
    pointListEl.innerHTML = '<p class="empty">Chua ve tuyen.</p>';
    return;
  }

  pointListEl.innerHTML = drawState.points.slice(1).map((point, offset) => {
    const index = offset + 1;
    const prev = drawState.points[index - 1];
    const selected = drawState.selectedSegmentIndex === index ? 'is-selected' : '';
    const typeClass = point.segmentType === 'curve' ? '' : 'is-straight';
    const typeLabel = point.segmentType === 'curve' ? 'Cong' : 'Thang';
    const segMeters = pathLengthMeters(getSegmentExpandedPoints(index));
    return `
      <div class="segment-item ${selected}" data-segment="${index}">
        <span class="badge">${index}</span>
        <div>
          <div>${escapeHtml(prev.label || `Diem ${index}`)} → ${escapeHtml(point.label || `Diem ${index + 1}`)}</div>
          <span class="type ${typeClass}">${typeLabel} · ${formatDistance(segMeters)}</span>
        </div>
      </div>
    `;
  }).join('');

  for (const item of pointListEl.querySelectorAll('[data-segment]')) {
    item.addEventListener('click', () => selectSegment(Number(item.dataset.segment)));
    item.addEventListener('dblclick', (event) => {
      event.preventDefault();
      toggleSegmentType(Number(item.dataset.segment));
    });
  }
}

function renderAll() {
  renderDrawLayers();
  renderPanel();
}

function findNearestSegment(latlng) {
  const clickPx = map.latLngToContainerPoint(latlng);
  let best = { index: -1, dist: Infinity };
  for (let i = 1; i < drawState.points.length; i += 1) {
    const samples = getSegmentLatLngs(i);
    for (let j = 1; j < samples.length; j += 1) {
      const a = map.latLngToContainerPoint(samples[j - 1]);
      const b = map.latLngToContainerPoint(samples[j]);
      const d = pointToSegmentDistancePx(clickPx, a, b);
      if (d < best.dist) best = { index: i, dist: d };
    }
  }
  return best.dist < 18 ? best.index : -1;
}

function pointToSegmentDistancePx(p, a, b) {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  const cx = a.x + t * dx; const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

function defaultControl(start, end) {
  const midLat = (start.lat + end.lat) / 2;
  const midLng = (start.lng + end.lng) / 2;
  const dLng = end.lng - start.lng;
  const dLat = end.lat - start.lat;
  const length = Math.hypot(dLat, dLng) || 1;
  const bulge = Math.min(0.0005, length * 0.22);
  return { lat: roundNumber(midLat + (-dLng / length) * bulge, 9), lng: roundNumber(midLng + (dLat / length) * bulge, 9) };
}

function getControlPoint(start, end) {
  if (end.controlLat != null && end.controlLng != null) return { lat: end.controlLat, lng: end.controlLng };
  return defaultControl(start, end);
}

function expandPath(waypoints) {
  if (!waypoints.length) return [];
  const result = [{ lat: waypoints[0].lat, lng: waypoints[0].lng }];
  for (let i = 1; i < waypoints.length; i += 1) {
    const prev = waypoints[i - 1];
    const current = waypoints[i];
    if (current.segmentType === 'curve') {
      const curve = interpolateCurve(prev, current, getControlPoint(prev, current), 40);
      for (let j = 1; j < curve.length; j += 1) result.push(curve[j]);
    } else {
      result.push({ lat: current.lat, lng: current.lng });
    }
  }
  return result;
}

function interpolateCurve(start, end, control, steps) {
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps; const u = 1 - t;
    points.push({
      lat: roundNumber(u * u * start.lat + 2 * u * t * control.lat + t * t * end.lat, 9),
      lng: roundNumber(u * u * start.lng + 2 * u * t * control.lng + t * t * end.lng, 9),
    });
  }
  return points;
}

function getExportPayload() {
  const expanded = expandPath(drawState.points);
  const start = drawState.points[0];
  const end = drawState.points.at(-1);
  return {
    routeCode: routeCodeEl.value.trim() || null,
    routeName: routeNameEl.value.trim() || null,
    startStationId: start?.stationId || null,
    startStationName: start?.label || null,
    endStationId: end?.source === 'station-end' ? end.stationId : null,
    endStationName: end?.source === 'station-end' ? end.label : null,
    waypointCount: drawState.points.length,
    pointCount: expanded.length,
    lengthMeters: Math.round(pathLengthMeters(expanded)),
    lengthKm: roundNumber(pathLengthMeters(expanded) / 1000, 2),
    waypoints: drawState.points.map((point, index) => ({
      order: index + 1,
      lat: point.lat,
      lng: point.lng,
      source: point.source,
      label: point.label || null,
      segmentType: index === 0 ? null : point.segmentType,
      controlLat: index === 0 ? null : point.controlLat,
      controlLng: index === 0 ? null : point.controlLng,
    })),
    coordinates: expanded,
    recordedGps: recordingSession?.recordedPoints || null,
  };
}

async function copyJson() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(getExportPayload(), null, 2));
    copyPointsEl.textContent = 'Copied';
    setTimeout(() => { copyPointsEl.textContent = 'Copy JSON'; }, 1000);
  } catch { setStatus('Khong copy duoc.'); }
}

function downloadJson() {
  const blob = new Blob([JSON.stringify(getExportPayload(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `route-survey-${routeCodeEl.value.trim() || Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function fitMapToContent() {
  const bounds = stations.map((s) => [s.lat, s.lng]);
  if (bounds.length) map.fitBounds(bounds, { padding: [60, 60] });
}

function getStationById(id) { return stations.find((s) => s.stationId === id) || null; }
function formatDistance(m) { const v = Number(m || 0); return v < 1000 ? `${Math.round(v)} m` : `${(v / 1000).toFixed(1)} km`; }
function roundNumber(v, d) { const f = 10 ** d; return Math.round(Number(v) * f) / f; }
function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);
}

setTool('select');
setSegmentMode('curve');
setPhase('draw');
renderAll();
