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
const sendTargetSelectEl = document.querySelector('#sendTargetSelect');
const senderPanelEl = document.querySelector('#senderPanel');
const senderToggleEl = document.querySelector('#senderToggle');
const senderBodyEl = document.querySelector('#senderBody');
const senderToggleTextEl = document.querySelector('#senderToggleText');
const boatCountEl = document.querySelector('#boatCount');
const sendModeEl = document.querySelector('#sendMode');
const senderBadgeEl = document.querySelector('#senderBadge');
const gpsStatusEl = document.querySelector('#gpsStatus');
const sendLogEl = document.querySelector('#sendLog');
const boatsEl = document.querySelector('#boats');
const payloadLogEl = document.querySelector('#payloadLog');
const mapLegendSelectEl = document.querySelector('#mapLegendSelect');
const mapLegendSwatchEl = document.querySelector('#mapLegendSwatch');
const mapLegendPanelEl = document.querySelector('#mapLegendPanel');
const mapLegendToggleEl = document.querySelector('#mapLegendToggle');
const mapLegendBodyEl = document.querySelector('#mapLegendBody');
const toggleSavedRoutesEl = document.querySelector('#toggleSavedRoutes');
const captureCountEl = document.querySelector('#captureCount');
const captureStatusEl = document.querySelector('#captureStatus');
const collectorStatusEl = document.querySelector('#collectorStatus');
const captureRouteCodeEl = document.querySelector('#captureRouteCode');
const captureRouteNameEl = document.querySelector('#captureRouteName');
const startStationEl = document.querySelector('#startStation');
const endStationEl = document.querySelector('#endStation');
const collectorBoatCodeEl = document.querySelector('#collectorBoatCode');
const collectorSpeedEl = document.querySelector('#collectorSpeed');
const boatSpeedHintEl = document.querySelector('#boatSpeedHint');
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
const routeTypeHintEl = document.querySelector('#routeTypeHint');
const createReverseRouteEl = document.querySelector('#createReverseRoute');
const reverseFieldsEl = document.querySelector('#reverseFields');
const reverseRouteCodeEl = document.querySelector('#reverseRouteCode');
const reverseRouteNameEl = document.querySelector('#reverseRouteName');
const reverseRouteCodeHintEl = document.querySelector('#reverseRouteCodeHint');
const stopChainPreviewEl = document.querySelector('#stopChainPreview');
const workflowStepsEl = document.querySelector('#workflowSteps');
const routeStopsListEl = document.querySelector('#routeStopsList');

const markers = new Map();
const routeLayers = new Map();
const stationLayers = new Map();
const captureMarkers = [];
const controlMarkers = [];
let captureLine = null;
let helperCurveLine = null;
let plannedRouteLine = null;
let lockedSurveyPath = null; // giữ đường vẽ suốt lúc tàu chạy — không cho auto-save cũ xóa
let collectorMarker = null;
let routeStopMarkersLayer = null;
let selectedRouteStops = [];
let selectedRouteId = '';
// Mặc định ẩn tuyến DB trên map survey — tránh lẫn với đường đang vẽ (BD-TT…).
let showSavedRoutes = false;
let latest = null;
let hasFitInitialRoutes = false;
let lastStationsFingerprint = '';
let lastRoutesFingerprint = '';
let lastBoatIds = '';
let lastLiveBoatIds = '';
let renderFrame = null;
let recordingSession = null;
let autoSaveInFlight = false;
let autoCompleteTriggered = false;
let lastHandledAutoSaveAt = '';
let recordingActive = false;
let recordingStartedAt = 0;
let routeCodeOk = true;
let selectedStartStationId = '';
let selectedEndStationId = '';
let selectedCollectorBoatCode = localStorage.getItem('surveyBoatCode') || '';

const captureState = {
  enabled: false,
  finished: false,
  // Chế độ mặc định cho đoạn mới: thẳng | cong (kéo điểm vàng để uốn).
  lineMode: 'straight',
  selectedSegmentIndex: null,
  selectedWaypointIndex: null,
  points: [],
};

const SAVED_ROUTE_STYLE = {
  color: '#0f766e',
  weight: 4,
  opacity: 0.78,
  dashArray: null,
};
const SELECTED_ROUTE_STYLE = {
  color: '#f59e0b',
  weight: 8,
  opacity: 1,
  dashArray: null,
};
const DIMMED_ROUTE_STYLE = {
  color: '#0f766e',
  weight: 3,
  opacity: 0.28,
  dashArray: null,
};
const DRAFT_ROUTE_STYLE = {
  color: '#ea580c',
  weight: 5,
  opacity: 0.95,
  dashArray: '10 8',
};
const SURVEY_ROUTE_STYLE = {
  color: '#c2410c',
  weight: 6,
  opacity: 0.98,
  dashArray: '14 10',
};

refreshRoutesEl.addEventListener('click', () => fetch('/api/refresh', { method: 'POST' }));
toggleSenderEl?.addEventListener('click', async () => {
  const enabled = !(latest?.config?.senderEnabled);
  await setSenderEnabled(enabled);
});
sendTargetSelectEl?.addEventListener('change', async () => {
  await setSenderEnabled(sendTargetSelectEl.value === 'on');
  updateSenderToggleChip();
});

senderToggleEl?.addEventListener('click', () => {
  const collapsed = !senderPanelEl?.classList.contains('is-collapsed');
  senderPanelEl?.classList.toggle('is-collapsed', collapsed);
  if (senderBodyEl) senderBodyEl.hidden = collapsed;
  senderToggleEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
});

mapLegendToggleEl?.addEventListener('click', () => {
  const collapsed = !mapLegendPanelEl?.classList.contains('is-collapsed');
  mapLegendPanelEl?.classList.toggle('is-collapsed', collapsed);
  if (mapLegendBodyEl) mapLegendBodyEl.hidden = collapsed;
  mapLegendToggleEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
});

function updateSenderToggleChip(data = latest) {
  const enabled = Boolean(data?.config?.senderEnabled);
  senderPanelEl?.classList.toggle('is-live', enabled);
  if (senderToggleTextEl) {
    senderToggleTextEl.textContent = enabled ? 'Azure BE' : 'Local';
  }
  senderToggleEl?.setAttribute(
    'title',
    enabled ? 'Đang gửi Azure BE — bấm để mở cài đặt' : 'Local only — bấm để mở cài đặt',
  );
}

async function setSenderEnabled(enabled) {
  await fetch('/api/sender', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: Boolean(enabled) }),
  });
}

startStationEl.addEventListener('change', () => {
  selectedStartStationId = startStationEl.value;
  if (startStationEl.value) seedFromStation();
  else if (latest?.stations) renderStations(latest.stations);
});
endStationEl.addEventListener('change', () => {
  selectedEndStationId = endStationEl.value;
  syncEndStationDisplay();
  if (endStationEl.value) seedToEndStation();
  else if (latest?.stations) renderStations(latest.stations);
});

const endStationDisplayEl = document.querySelector('#endStationDisplay');

const stationCombos = {
  start: {
    root: document.querySelector('[data-combo="start"]'),
    input: startStationEl,
    trigger: document.querySelector('#startStationTrigger'),
    label: document.querySelector('#startStationTrigger .combo-label'),
    panel: document.querySelector('[data-combo="start"] .combo-panel'),
    search: document.querySelector('[data-combo="start"] .combo-search'),
    list: document.querySelector('[data-combo="start"] .combo-list'),
    placeholder: 'Chọn bến...',
  },
};

let stationCatalog = [];

function closeStationCombo(exceptKey = null) {
  for (const [key, combo] of Object.entries(stationCombos)) {
    if (key === exceptKey) continue;
    if (combo.panel) combo.panel.hidden = true;
  }
}

function stationLabel(station) {
  if (!station) return '';
  const code = station.stationCode ? ` (${station.stationCode})` : '';
  return `${station.stationName || 'Bến'}${code}`;
}

function findStationInCatalog(stationId) {
  return stationCatalog.find((s) => String(s.stationId) === String(stationId)) || null;
}

function syncStationComboLabel(key) {
  const combo = stationCombos[key];
  if (!combo?.label) return;
  const station = findStationInCatalog(combo.input?.value);
  combo.label.textContent = station ? stationLabel(station) : combo.placeholder;
}

function syncEndStationDisplay() {
  if (!endStationDisplayEl) return;
  const textEl = endStationDisplayEl.querySelector('.station-map-pick-text') || endStationDisplayEl;
  const station = findStationInCatalog(endStationEl?.value)
    || (latest?.stations || []).find((s) => String(s.stationId) === String(endStationEl?.value));
  if (station) {
    textEl.textContent = stationLabel(station);
    endStationDisplayEl.classList.remove('is-empty');
  } else {
    textEl.textContent = 'Nhấn bến trên map để chọn';
    endStationDisplayEl.classList.add('is-empty');
  }
  updateRouteTypeHint();
}

function setStationComboValue(key, stationId, { emitChange = true } = {}) {
  if (key === 'end') {
    const next = stationId ? String(stationId) : '';
    const prev = endStationEl?.value || '';
    if (endStationEl) endStationEl.value = next;
    selectedEndStationId = next;
    syncEndStationDisplay();
    if (emitChange && prev !== next) {
      endStationEl?.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return;
  }
  const combo = stationCombos[key];
  if (!combo?.input) return;
  const next = stationId ? String(stationId) : '';
  const prev = combo.input.value;
  combo.input.value = next;
  if (key === 'start') selectedStartStationId = next;
  syncStationComboLabel(key);
  if (emitChange && prev !== next) {
    combo.input.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function paintStationComboList(key, query = '') {
  const combo = stationCombos[key];
  if (!combo?.list) return;
  const q = String(query || '').trim().toLowerCase();
  const items = stationCatalog.filter((station) => {
    if (!q) return true;
    const hay = `${station.stationName || ''} ${station.stationCode || ''}`.toLowerCase();
    return hay.includes(q);
  });
  if (!items.length) {
    combo.list.innerHTML = '<div class="combo-empty">Không tìm thấy bến.</div>';
    return;
  }
  const selected = combo.input?.value || '';
  combo.list.innerHTML = items.map((station) => {
    const id = String(station.stationId);
    const active = id === String(selected) ? ' is-selected' : '';
    return `<button type="button" class="combo-option${active}" data-station-id="${escapeHtml(id)}">${escapeHtml(stationLabel(station))}</button>`;
  }).join('');
}

function positionStationComboPanel(key) {
  const combo = stationCombos[key];
  if (!combo?.panel || !combo.trigger) return;
  const rect = combo.trigger.getBoundingClientRect();
  const width = Math.max(rect.width, 220);
  const left = Math.min(rect.left, window.innerWidth - width - 8);
  const maxH = Math.min(240, window.innerHeight * 0.36);
  let top = rect.bottom + 4;
  if (top + maxH > window.innerHeight - 8) {
    top = Math.max(8, rect.top - maxH - 4);
  }
  combo.panel.style.position = 'fixed';
  combo.panel.style.top = `${top}px`;
  combo.panel.style.left = `${left}px`;
  combo.panel.style.right = 'auto';
  combo.panel.style.width = `${width}px`;
  combo.panel.style.zIndex = '1200';
}

function openStationCombo(key) {
  const combo = stationCombos[key];
  if (!combo?.panel) return;
  closeStationCombo(key);
  paintStationComboList(key, combo.search?.value || '');
  combo.panel.hidden = false;
  positionStationComboPanel(key);
  combo.search?.focus();
  combo.search?.select();
}

function bindStationCombos() {
  for (const [key, combo] of Object.entries(stationCombos)) {
    combo.trigger?.addEventListener('click', (event) => {
      event.preventDefault();
      if (combo.panel?.hidden === false) {
        combo.panel.hidden = true;
        return;
      }
      openStationCombo(key);
    });
    combo.search?.addEventListener('input', () => {
      paintStationComboList(key, combo.search.value);
    });
    combo.list?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-station-id]');
      if (!btn) return;
      setStationComboValue(key, btn.dataset.stationId);
      closeStationCombo();
    });
  }
  document.addEventListener('click', (event) => {
    if (event.target.closest('.combo')) return;
    closeStationCombo();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeStationCombo();
  });
}

bindStationCombos();

startCollectorEl.addEventListener('click', startRecording);
pauseCollectorEl.addEventListener('click', pauseCollector);
stopCollectorEl.addEventListener('click', stopRecording);
saveRouteGeometryEl.addEventListener('click', saveRouteGeometry);
createReverseRouteEl?.addEventListener('change', () => {
  updateReverseRouteUi({ suggest: true });
});
captureRouteCodeEl?.addEventListener('input', () => {
  checkRouteCodeDuplicate();
  maybeSuggestReverseRoute();
  validateReverseRouteCode();
});
captureRouteNameEl?.addEventListener('input', () => {
  maybeSuggestReverseRoute();
});
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
  setDrawTool('draw');
  captureStatusEl.textContent = 'Đang vẽ: click thêm điểm. Kéo điểm để chỉnh. Thẳng/Cong = đoạn mới (hoặc đoạn đang chọn).';
  updateWorkflow('draw');
});
modeStraightEl?.addEventListener('click', () => setLineMode('straight'));
modeCurveEl?.addEventListener('click', () => setLineMode('curve'));
toolUndoEl?.addEventListener('click', () => {
  captureState.finished = false;
  undoCapturePoint();
});
toolClearEl?.addEventListener('click', () => {
  // Luôn cho bỏ highlight tuyến cam đã chọn trên legend.
  clearSelectedRouteHighlight();
  if (recordingActive) {
    captureStatusEl.textContent = 'Đã bỏ chọn tuyến. Đang chạy tàu — chưa xóa đường survey.';
    renderCaptureState();
    return;
  }
  unlockSurveyPath();
  clearCapturePoints();
  clearPlannedRoute();
  captureState.finished = false;
  captureStatusEl.textContent = 'Đã xóa đường trên bản đồ.';
  routeResultEl?.classList.add('hidden');
  updateWorkflow('draw');
  renderCaptureState();
});
finishDrawEl?.addEventListener('click', finishDraw);
collectorBoatCodeEl?.addEventListener('change', () => {
  selectedCollectorBoatCode = collectorBoatCodeEl.value.trim();
  if (selectedCollectorBoatCode) localStorage.setItem('surveyBoatCode', selectedCollectorBoatCode);
  applyBoatSpeedLimits();
  updateDrawStats();
});
collectorSpeedEl?.addEventListener('input', () => {
  applyBoatSpeedLimits();
  updateDrawStats();
});

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

  // Có đoạn đang chọn → áp thẳng/cong ngay lên đoạn đó (WYSIWYG).
  const idx = captureState.selectedSegmentIndex;
  if (idx > 0 && captureState.points[idx]) {
    applySegmentMode(idx, captureState.lineMode);
    captureStatusEl.textContent = captureState.lineMode === 'curve'
      ? `Đoạn #${idx}: cong — kéo điểm vàng để uốn.`
      : `Đoạn #${idx}: thẳng.`;
  } else {
    captureStatusEl.textContent = captureState.lineMode === 'curve'
      ? 'Chế độ Cong: điểm mới sẽ tạo đoạn cong (kéo chốt vàng để uốn).'
      : 'Chế độ Thẳng: điểm mới nối thẳng — kéo số để chỉnh.';
  }
  renderCaptureLine();
  syncControlMarkers();
  updateDrawStats();
}

function applySegmentMode(index, mode) {
  const point = captureState.points[index];
  const prev = captureState.points[index - 1];
  if (!point || !prev || index < 1) return;
  if (mode === 'curve') {
    point.segmentType = 'curve';
    if (point.controlLat == null || point.controlLng == null) {
      const control = defaultCurveControl(prev, point);
      point.controlLat = control.lat;
      point.controlLng = control.lng;
    }
  } else {
    point.segmentType = 'straight';
    point.controlLat = null;
    point.controlLng = null;
  }
  captureState.finished = false;
}

function finishDraw() {
  if (captureState.points.length < 2) {
    captureStatusEl.textContent = 'Cần ít nhất 2 điểm trước khi hoàn thành.';
    return;
  }
  ensureEndStationFromPath();
  if (endStationEl?.value) seedToEndStation();
  // Giữ đúng hình đang vẽ — không kéo điểm, không ép cong/thẳng lại.
  captureState.finished = true;
  setDrawTool('pan');
  const type = getSurveyRouteType();
  const stopCount = buildSurveyStops().length;
  captureStatusEl.textContent = `Đã xong (${stopCount} bến, loại ${type}). Kéo điểm số / chốt vàng nếu muốn chỉnh lại, rồi ghi GPS.`;
  updateWorkflow('run');
  updateRouteTypeHint();
  checkRouteCodeDuplicate();
  renderCaptureLine();
  syncControlMarkers();
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
  // Chỉ theo id + tên — tránh lat/lng float làm rebuild select liên tục.
  return uniqueStations(stations)
    .map((s) => `${s.stationId}:${s.stationName}:${s.stationCode}`)
    .sort()
    .join('|');
}

function routesFingerprint(routes) {
  return (routes || []).map((r) => {
    const stopKey = (r.stops || [])
      .map((s) => `${s.stopOrder}:${s.stationId || s.stationCode || ''}`)
      .join(',');
    return `${r.routeId}:${r.lengthMeters}:${stopKey}`;
  }).join('|');
}

function render(data) {
  const stationsFp = stationsFingerprint(data.stations);
  const routesFp = routesFingerprint(data.routes);
  if (stationsFp !== lastStationsFingerprint) {
    lastStationsFingerprint = stationsFp;
    renderStations(data.stations);
    renderStationOptions(data.stations, 'Chọn bến có sẵn...');
    restoreStationSelections();
  } else if (latest?.stations) {
    restoreStationSelections();
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

function restoreStationSelections() {
  setStationComboValue('start', selectedStartStationId, { emitChange: false });
  setStationComboValue('end', selectedEndStationId, { emitChange: false });
}

function renderStationOptions(stations, placeholder) {
  const combo = stationCombos.start;
  if (placeholder && combo) combo.placeholder = placeholder;
  stationCatalog = uniqueStations(stations).sort((a, b) =>
    String(a.stationName || '').localeCompare(String(b.stationName || ''), 'vi'),
  );
  const startSelected = selectedStartStationId || startStationEl?.value || '';
  const startValid = startSelected && stationCatalog.some((station) => String(station.stationId) === String(startSelected))
    ? startSelected
    : '';
  setStationComboValue('start', startValid, { emitChange: false });

  const endSelected = selectedEndStationId || endStationEl?.value || '';
  const endValid = endSelected && stationCatalog.some((station) => String(station.stationId) === String(endSelected))
    ? endSelected
    : '';
  setStationComboValue('end', endValid, { emitChange: false });

  if (combo && !combo.panel?.hidden) paintStationComboList('start', combo.search?.value || '');
}

function getSelectedStation() {
  if (!startStationEl?.value) return null;
  return findStationInCatalog(startStationEl.value)
    || uniqueStations(latest?.stations || []).find((s) => String(s.stationId) === String(startStationEl.value))
    || null;
}

function getSelectedEndStation() {
  if (!endStationEl?.value) return null;
  return findStationInCatalog(endStationEl.value)
    || uniqueStations(latest?.stations || []).find((s) => String(s.stationId) === String(endStationEl.value))
    || null;
}

/** Chỉ suy từ bến đầu/cuối cho UI local — BE tự phân loại, không gửi routeType. */
function getSurveyRouteType() {
  const startId = startStationEl?.value || captureState.points[0]?.stationId || '';
  const endPoint = [...captureState.points].reverse().find((p) => p.source === 'station-end');
  const endId = endStationEl?.value || endPoint?.stationId || '';
  if (startId && endId && String(startId) === String(endId)) return 'SightseeingLoop';
  return 'Regular';
}

const STOP_DETECT_RADIUS_M = 200;

function collectClickedStationStops() {
  const stationPoints = captureState.points.filter((p) => p.stationId);
  return stationPoints.map((point) => {
    const station = findStationInCatalog(point.stationId) || {
      stationId: point.stationId,
      stationName: point.label,
      stationCode: null,
      lat: point.lat,
      lng: point.lng,
    };
    return {
      stationId: String(station.stationId),
      stationCode: station.stationCode || null,
      stationName: station.stationName || point.label || null,
      lat: Number(station.lat ?? point.lat),
      lng: Number(station.lng ?? point.lng),
      source: point.source || 'station',
      pathIndex: captureState.points.indexOf(point),
      clicked: true,
    };
  });
}

/** Chỉ lấy bến đã click gắn vào path — không tự nhận bến “đi qua”. */
function collectOrderedStopsFromClicks() {
  const startId = startStationEl?.value || captureState.points[0]?.stationId || '';
  const endId = endStationEl?.value
    || [...captureState.points].reverse().find((p) => p.source === 'station-end')?.stationId
    || '';
  const clicked = collectClickedStationStops();
  const path = (() => {
    const expanded = captureState.points.length >= 2
      ? expandPath(captureState.points)
      : captureState.points;
    return (expanded || []).filter((p) => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)));
  })();

  const hits = clicked.map((stop) => {
    let pathIndex = stop.pathIndex ?? 0;
    if (path.length) {
      let best = Infinity;
      for (let i = 0; i < path.length; i += 1) {
        const dist = haversineMeters(path[i], stop);
        if (dist < best) {
          best = dist;
          pathIndex = i;
        }
      }
    }
    return { ...stop, pathIndex, dist: 0 };
  });

  hits.sort((a, b) => {
    if (String(a.stationId) === String(startId) && String(b.stationId) !== String(startId)) return -1;
    if (String(b.stationId) === String(startId) && String(a.stationId) !== String(startId)) return 1;
    if (String(a.stationId) === String(endId) && String(b.stationId) !== String(endId)) return 1;
    if (String(b.stationId) === String(endId) && String(a.stationId) !== String(endId)) return -1;
    return (a.pathIndex - b.pathIndex) || ((a.dist || 0) - (b.dist || 0));
  });

  const isLoop = Boolean(startId && endId && String(startId) === String(endId));
  const ordered = [];
  const seen = new Set();
  for (const hit of hits) {
    if (seen.has(hit.stationId)) continue;
    // Loop trùng bến đầu = bến cuối: chỉ giữ đúng bến đầu, bỏ mọi bến giữa
    // (đi lượn quanh sông, không ghé bến nào cho tới khi đóng vòng).
    if (isLoop && String(hit.stationId) !== String(startId)) continue;
    if (String(hit.stationId) === String(startId) && ordered.length > 0 && isLoop) {
      continue;
    }
    seen.add(hit.stationId);
    ordered.push(hit);
  }

  if (isLoop && ordered.length) {
    ordered.push({ ...ordered[0], source: 'station-end', clicked: true });
  } else if (endId && ordered.length && String(ordered.at(-1).stationId) !== String(endId)) {
    const endStation = findStationInCatalog(endId) || hits.find((h) => String(h.stationId) === String(endId));
    if (endStation) {
      ordered.push({
        stationId: String(endId),
        stationCode: endStation.stationCode || null,
        stationName: endStation.stationName || null,
        lat: Number(endStation.lat),
        lng: Number(endStation.lng),
        source: 'station-end',
        clicked: true,
      });
    }
  }

  return ordered.map((stop, index, arr) => ({
    ...stop,
    stopOrder: index + 1,
    isFirst: index === 0,
    isLast: index === arr.length - 1,
  }));
}

function buildSurveyStops() {
  const routeType = getSurveyRouteType();
  const ordered = collectOrderedStopsFromClicks();
  const withTravel = attachSegmentTravelMinutesFe(getPathCoordinates(), ordered, getSurveySpeedKmh());
  return withTravel.map((stop) => ({
    stationId: stop.stationId,
    stationCode: stop.stationCode,
    stationName: stop.stationName,
    stopOrder: stop.stopOrder,
    lat: stop.lat,
    lng: stop.lng,
    isPickupAllowed: stop.isFirst || routeType === 'SightseeingLoop' || !stop.isLast,
    isDropoffAllowed: stop.isLast || routeType === 'SightseeingLoop' || !stop.isFirst,
    standardTravelMin: stop.standardTravelMin,
    segmentDistanceKm: stop.segmentDistanceKm,
  }));
}

function nearestPathIndexFe(path, stop) {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < path.length; i += 1) {
    const dist = haversineMeters(path[i], stop);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  let along = 0;
  for (let i = 1; i <= bestIdx; i += 1) along += haversineMeters(path[i - 1], path[i]);
  return { index: bestIdx, alongMeters: along, distToPath: bestDist };
}

/** Phút chạy chỉ khi đường vẽ thật sự có đoạn giữa 2 bến (không bịa nối thẳng). */
function scheduleTravelMinutesFe(fromCode, toCode) {
  const segments = latest?.config?.waterbusSchedule?.segments || {};
  const from = String(fromCode || '').trim().toUpperCase();
  const to = String(toCode || '').trim().toUpperCase();
  if (!from || !to) return null;
  const value = segments[`${from}|${to}`];
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function preferWaterbusScheduleFe() {
  return latest?.config?.preferWaterbusSchedule !== false;
}

function attachSegmentTravelMinutesFe(coordinates, stops, speedKmh) {
  const path = Array.isArray(coordinates)
    ? coordinates.filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng)))
    : [];
  const list = Array.isArray(stops) ? stops.map((s) => ({ ...s })) : [];
  const speed = Number(speedKmh) > 0 ? Number(speedKmh) : 16;
  if (!list.length) return [];
  if (list.length === 1 || path.length < 2) {
    return list.map((stop) => ({ ...stop, standardTravelMin: null, segmentDistanceKm: null, travelSource: null }));
  }

  const probes = list.map((stop) => (
    Number.isFinite(Number(stop.lat))
      ? nearestPathIndexFe(path, stop)
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
    if (index === 0) return { ...stop, standardTravelMin: null, segmentDistanceKm: null, travelSource: null };
    const prevStop = list[index - 1];
    const prev = probes[index - 1];
    const cur = probes[index];
    if (prev.distToPath > STOP_DETECT_RADIUS_M || cur.distToPath > STOP_DETECT_RADIUS_M) {
      return { ...stop, standardTravelMin: null, segmentDistanceKm: null, travelSource: null };
    }
    const meters = cur.alongMeters - prev.alongMeters;
    if (!(meters > 5)) return { ...stop, standardTravelMin: null, segmentDistanceKm: null, travelSource: null };
    const km = meters / 1000;
    const scheduled = preferWaterbusScheduleFe()
      ? scheduleTravelMinutesFe(prevStop.stationCode, stop.stationCode)
      : null;
    if (scheduled != null) {
      return {
        ...stop,
        standardTravelMin: scheduled,
        segmentDistanceKm: roundNumber(km, 3),
        travelSource: 'schedule',
      };
    }
    const minutes = Number(((km / speed) * 60).toFixed(1));
    return {
      ...stop,
      standardTravelMin: minutes > 0 ? minutes : null,
      segmentDistanceKm: roundNumber(km, 3),
      travelSource: 'gps',
    };
  });
}

function updateRouteTypeHint() {
  const type = getSurveyRouteType();
  const ordered = collectOrderedStopsFromClicks();
  const viaCount = Math.max(0, ordered.length - 2);
  const isLoop = type === 'SightseeingLoop';
  if (routeTypeHintEl) {
    if (ordered.length >= 2) {
      if (isLoop) {
        routeTypeHintEl.textContent = 'Vòng sightseeing (cùng bến đầu/cuối) — BE tự lưu sightseeing loop · không ghé bến giữa.';
      } else {
        routeTypeHintEl.textContent = `Route nguồn GPS · ${ordered.length} bến đã click${viaCount ? ` · ${viaCount} bến giữa` : ''} · BE tự phân loại.`;
      }
      routeTypeHintEl.classList.add('is-ok');
      routeTypeHintEl.classList.remove('is-error');
    } else {
      routeTypeHintEl.textContent = 'Click từng bến muốn dừng. Vẽ nét thẳng giữa các bến — không tự thêm bến.';
      routeTypeHintEl.classList.remove('is-ok', 'is-error');
    }
  }
  updateStopChainPreview(ordered);
  updateReverseRouteUi();
}

function updateStopChainPreview(orderedInput) {
  if (!stopChainPreviewEl) return;
  const ordered = orderedInput || collectOrderedStopsFromClicks();
  if (!ordered.length) {
    stopChainPreviewEl.innerHTML = 'Chưa có bến — click bến hoặc vẽ qua gần bến catalog.';
    stopChainPreviewEl.classList.add('is-empty');
    return;
  }
  const withTravel = attachSegmentTravelMinutesFe(getPathCoordinates(), ordered, getSurveySpeedKmh());
  const parts = [];
  withTravel.forEach((stop, index) => {
    if (index > 0) {
      const src = stop.travelSource === 'schedule' ? ' lịch' : (stop.travelSource === 'gps' ? ' GPS' : '');
      const min = stop.standardTravelMin != null
        ? `${stop.standardTravelMin} phút${src}`
        : 'chưa đo';
      const km = stop.segmentDistanceKm != null ? ` · ${stop.segmentDistanceKm} km` : '';
      parts.push(`<span class="stop-seg${stop.standardTravelMin == null ? ' is-missing' : ''}${stop.travelSource === 'schedule' ? ' is-schedule' : ''}">${escapeHtml(min)}${escapeHtml(km)}</span>`);
      parts.push('<span class="stop-sep">→</span>');
    }
    const tag = stop.isFirst ? 'Đầu' : (stop.isLast ? 'Cuối' : (stop.source === 'path-near' ? 'Đi qua' : `Giữa ${index}`));
    const name = stop.stationName || stop.stationCode || stop.stationId;
    parts.push(`<span class="stop-chip${stop.source === 'path-near' ? ' is-auto' : ''}"><b>${tag}</b> ${escapeHtml(name)}</span>`);
    if (index < withTravel.length - 1) parts.push('<span class="stop-sep">→</span>');
  });
  stopChainPreviewEl.innerHTML = parts.join('');
  stopChainPreviewEl.classList.remove('is-empty');
}

function surveySaveFields() {
  ensureEndStationFromPath({ quiet: true });
  const fields = {
    startStationId: startStationEl.value || captureState.points[0]?.stationId || null,
    endStationId: endStationEl.value || [...captureState.points].reverse().find((p) => p.source === 'station-end')?.stationId || null,
    stops: buildSurveyStops(),
  };
  const inferredType = getSurveyRouteType();
  const wantReverse = Boolean(createReverseRouteEl?.checked)
    && inferredType !== 'SightseeingLoop'
    && (fields.stops?.length || 0) >= 2;
  if (wantReverse) {
    fields.createReverseRoute = true;
    // Luôn đảm bảo có mã/tên chiều về hợp lệ trước khi đẩy BE.
    const ensured = ensureReverseRouteFields();
    fields.reverseRouteCode = ensured.reverseCode;
    fields.reverseRouteName = ensured.reverseName;
  } else {
    fields.createReverseRoute = false;
  }
  return fields;
}

/** Điền / sửa mã chiều về cho khác routeCode và không trùng tuyến local đã biết. */
function ensureReverseRouteFields() {
  const main = captureRouteCodeEl?.value.trim() || '';
  const suggested = suggestReverseFromMain();
  let reverseCode = reverseRouteCodeEl?.value.trim() || suggested.reverseCode || (main ? `${main}-VE` : '');
  let reverseName = reverseRouteNameEl?.value.trim() || suggested.reverseName || (main ? `${main} (chiều về)` : '');
  const used = new Set(
    (latest?.routes || [])
      .map((r) => String(r.routeCode || '').trim().toLowerCase())
      .filter(Boolean),
  );
  if (main) used.add(main.toLowerCase());
  if (!reverseCode || used.has(reverseCode.toLowerCase())) {
    const base = suggested.reverseCode && suggested.reverseCode.toLowerCase() !== main.toLowerCase()
      ? suggested.reverseCode
      : (main ? `${main}-VE` : 'REV');
    reverseCode = base;
    let n = 2;
    while (used.has(reverseCode.toLowerCase())) {
      reverseCode = `${base}${n}`;
      n += 1;
    }
  }
  if (reverseRouteCodeEl) reverseRouteCodeEl.value = reverseCode;
  if (reverseRouteNameEl && !reverseRouteNameEl.value.trim()) reverseRouteNameEl.value = reverseName;
  reverseName = reverseRouteNameEl?.value.trim() || reverseName;
  validateReverseRouteCode();
  return { reverseCode, reverseName };
}

function suggestReverseFromMain() {
  const code = captureRouteCodeEl?.value.trim() || '';
  const name = captureRouteNameEl?.value.trim() || '';
  let reverseCode = '';
  let reverseName = '';
  if (code.includes('-')) {
    reverseCode = code.split('-').map((s) => s.trim()).filter(Boolean).reverse().join('-');
  } else if (code.includes(' ')) {
    reverseCode = code.split(/\s+/).filter(Boolean).reverse().join('-');
  }
  // Đảo xong vẫn trùng (vd. BA-BA) → thêm hậu tố -VE.
  if (reverseCode && reverseCode.toLowerCase() === code.toLowerCase()) {
    reverseCode = `${code}-VE`;
  }
  if (!reverseCode && code) {
    reverseCode = `${code}-VE`;
  }
  if (name.includes(' - ')) {
    reverseName = name.split(' - ').reverse().join(' - ');
  } else if (name.includes('-')) {
    reverseName = name.split('-').map((s) => s.trim()).reverse().join(' - ');
  }
  if (reverseName && reverseName.toLowerCase() === name.toLowerCase() && name) {
    reverseName = `${name} (chiều về)`;
  }
  return { reverseCode, reverseName };
}

function maybeSuggestReverseRoute() {
  if (!createReverseRouteEl?.checked) return;
  const { reverseCode, reverseName } = suggestReverseFromMain();
  if (reverseRouteCodeEl && !reverseRouteCodeEl.dataset.touched && reverseCode) {
    reverseRouteCodeEl.value = reverseCode;
  }
  if (reverseRouteNameEl && !reverseRouteNameEl.dataset.touched && reverseName) {
    reverseRouteNameEl.value = reverseName;
  }
  validateReverseRouteCode();
}

/** true = hợp lệ / không dùng chiều về; false = trùng mã → chặn gửi. */
function validateReverseRouteCode() {
  if (!createReverseRouteEl?.checked) {
    reverseRouteCodeEl?.classList.remove('is-invalid');
    if (reverseRouteCodeHintEl) {
      reverseRouteCodeHintEl.textContent = 'Khác mã tuyến chính; không trùng DB; không dùng cho vòng tham quan.';
      reverseRouteCodeHintEl.classList.remove('is-error', 'is-ok');
    }
    return true;
  }
  const main = captureRouteCodeEl?.value.trim() || '';
  const reverse = reverseRouteCodeEl?.value.trim() || '';
  if (!reverse) {
    reverseRouteCodeEl?.classList.add('is-invalid');
    if (reverseRouteCodeHintEl) {
      reverseRouteCodeHintEl.textContent = 'Thiếu mã chiều về (BE bắt buộc khi createReverseRoute = true).';
      reverseRouteCodeHintEl.classList.add('is-error');
      reverseRouteCodeHintEl.classList.remove('is-ok');
    }
    return false;
  }
  if (main && reverse.toLowerCase() === main.toLowerCase()) {
    reverseRouteCodeEl?.classList.add('is-invalid');
    if (reverseRouteCodeHintEl) {
      reverseRouteCodeHintEl.textContent = `Mã chiều về phải khác mã tuyến chính ("${main}"). Ví dụ: ${suggestReverseFromMain().reverseCode || `${main}-VE`}.`;
      reverseRouteCodeHintEl.classList.add('is-error');
      reverseRouteCodeHintEl.classList.remove('is-ok');
    }
    return false;
  }
  reverseRouteCodeEl?.classList.remove('is-invalid');
  if (reverseRouteCodeHintEl) {
    reverseRouteCodeHintEl.textContent = `OK — chiều về "${reverse}" khác tuyến chính.`;
    reverseRouteCodeHintEl.classList.add('is-ok');
    reverseRouteCodeHintEl.classList.remove('is-error');
  }
  return true;
}

function updateReverseRouteUi({ suggest = false } = {}) {
  const type = getSurveyRouteType();
  const isLoop = type === 'SightseeingLoop';
  if (isLoop && createReverseRouteEl) {
    createReverseRouteEl.checked = false;
    createReverseRouteEl.disabled = true;
  } else if (createReverseRouteEl) {
    createReverseRouteEl.disabled = false;
  }
  const show = Boolean(createReverseRouteEl?.checked) && !isLoop;
  if (reverseFieldsEl) reverseFieldsEl.hidden = !show;
  if (show && suggest) maybeSuggestReverseRoute();
  else if (show) validateReverseRouteCode();
  else validateReverseRouteCode();
}

reverseRouteCodeEl?.addEventListener('input', () => {
  if (reverseRouteCodeEl) reverseRouteCodeEl.dataset.touched = '1';
  validateReverseRouteCode();
});
reverseRouteNameEl?.addEventListener('input', () => {
  if (reverseRouteNameEl) reverseRouteNameEl.dataset.touched = '1';
});
updateReverseRouteUi();

function ensureEndStationFromPath({ quiet = false } = {}) {
  if (endStationEl?.value) return true;
  const stationPoints = captureState.points.filter((p) => p.stationId);
  if (stationPoints.length < 2) return false;
  const last = stationPoints.at(-1);
  if (!last?.stationId) return false;
  if (last.source === 'station' && stationPoints.length === 1) return false;

  // Promote last station waypoint to end (giữ tọa độ đã có trên path).
  if (last.source === 'station-via' || last.source === 'station') {
    last.source = 'station-end';
  }
  setStationComboValue('end', last.stationId, { emitChange: false });
  syncEndStationDisplay();
  updateStopChainPreview();
  if (!quiet) {
    captureStatusEl.textContent = `Đã lấy bến cuối: ${last.label || last.stationId}.`;
  }
  // Rebuild markers to refresh end styling.
  rebuildCaptureMarkers();
  return true;
}

function addViaStation(station) {
  const last = captureState.points.at(-1);
  if (last?.stationId && String(last.stationId) === String(station.stationId)) {
    captureStatusEl.textContent = 'Bến này vừa được gắn — chọn bến khác, hoặc click lại bến đầu để đóng vòng sightseeing.';
    return;
  }
  captureState.enabled = true;
  captureState.finished = false;
  const lat = Number(station.lat);
  const lng = Number(station.lng);
  // Luôn nối thẳng tới tọa độ bến (không bỏ qua dù điểm trước gần bến).
  addCapturePoint({ lat, lng }, {
    source: 'station-via',
    label: station.stationName,
    stationId: station.stationId,
  });
  map.panTo([lat, lng], { animate: true });
  updateRouteTypeHint();
  captureStatusEl.textContent = `Đã nối tới: ${station.stationName}. Vẽ tiếp hoặc double-click bến cuối / click lại bến đầu để đóng vòng.`;
}

function closeAsEndStation(station) {
  const start = captureState.points[0];
  const isLoop = Boolean(start?.stationId && String(start.stationId) === String(station.stationId));
  if (isLoop && captureState.points.length < 2) {
    captureStatusEl.textContent = 'Vòng sightseeing: vẽ đường hoặc thêm bến giữa trước, rồi click lại cùng bến đầu để đóng.';
    return;
  }
  captureState.enabled = true;
  captureState.finished = false;
  setStationComboValue('end', station.stationId, { emitChange: false });
  seedToEndStation();
}

function seedFromStation() {
  const station = getSelectedStation();
  if (!station) {
    captureStatusEl.textContent = 'Chọn bến xuất phát trước.';
    return;
  }
  clearCapturePoints();
  setStationComboValue('end', '', { emitChange: false });
  addCapturePoint({ lat: station.lat, lng: station.lng }, {
    source: 'station',
    label: station.stationName,
    stationId: station.stationId,
  });
  captureState.enabled = true;
  map.setView([station.lat, station.lng], Math.max(map.getZoom(), 16), { animate: true });
  captureStatusEl.textContent = `Điểm 1: ${station.stationName}. Click bến khác để nối, hoặc vẽ tay rồi click lại bến này để đóng vòng.`;
  maybeFillRouteCode();
  updateRouteTypeHint();
  renderCaptureState();
}

function seedToEndStation() {
  const endStation = getSelectedEndStation();
  if (!endStation) {
    captureStatusEl.textContent = 'Chọn bến kết thúc trên map.';
    return;
  }
  if (!captureState.points.length) {
    captureStatusEl.textContent = 'Cần bến xuất phát trước.';
    return;
  }
  const start = captureState.points[0];
  const isLoop = Boolean(start?.stationId && String(start.stationId) === String(endStation.stationId));
  if (isLoop && captureState.points.length < 2) {
    captureStatusEl.textContent = 'Vòng sightseeing: hãy vẽ đường vòng trước, rồi click lại cùng bến để đóng.';
    setStationComboValue('end', '', { emitChange: false });
    updateRouteTypeHint();
    return;
  }

  const endLat = Number(endStation.lat);
  const endLng = Number(endStation.lng);
  let last = captureState.points.at(-1);

  // Đã có điểm cuối đúng bến → không kéo lại tọa độ (giữ hình user đã chỉnh).
  if (last?.source === 'station-end' && String(last.stationId) === String(endStation.stationId)) {
    last.label = endStation.stationName;
    rebuildCaptureMarkers();
    updateRouteTypeHint();
    captureStatusEl.textContent = isLoop
      ? `Đã đóng vòng tại ${endStation.stationName}.`
      : `Đã gắn bến kết thúc: ${endStation.stationName}.`;
    return;
  }

  // Đổi bến cuối khác → bỏ điểm end cũ.
  if (last?.source === 'station-end') {
    captureState.points.pop();
    rebuildCaptureMarkers();
  }

  // Luôn nối thêm điểm cuối — không kéo điểm vẽ gần bến vào vị trí station (tránh biến dạng).
  addCapturePoint({ lat: endLat, lng: endLng }, {
    source: 'station-end',
    label: endStation.stationName,
    stationId: endStation.stationId,
  });
  maybeFillRouteCode();
  updateRouteTypeHint();
  captureStatusEl.textContent = isLoop
    ? `Đã nối đóng vòng sightseeing về ${endStation.stationName} (cùng bến đầu).`
    : `Đã nối tới bến kết thúc: ${endStation.stationName}.`;
  renderCaptureState();
}

function maybeFillRouteCode() {
  const start = captureState.points[0];
  const end = captureState.points.at(-1);
  if (!start?.label || !end?.label) return;
  if (captureRouteCodeEl.value.trim()) {
    checkRouteCodeDuplicate();
    updateRouteTypeHint();
    return;
  }
  const abbrev = (name) => String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  const isLoop = Boolean(start.stationId && end.stationId && String(start.stationId) === String(end.stationId));
  if (isLoop) {
    captureRouteCodeEl.value = `LOOP-${abbrev(start.label)}`;
    if (!captureRouteNameEl.value.trim()) {
      captureRouteNameEl.value = `${start.label} · Vòng sightseeing`;
    }
  } else if (start !== end) {
    captureRouteCodeEl.value = `${abbrev(start.label)}-${abbrev(end.label)}`;
    if (!captureRouteNameEl.value.trim()) {
      captureRouteNameEl.value = `${start.label} - ${end.label}`;
    }
  }
  checkRouteCodeDuplicate();
  updateRouteTypeHint();
}

function addCapturePoint(latlng, meta = {}) {
  const point = {
    lat: roundNumber(latlng.lat, 9),
    lng: roundNumber(latlng.lng, 9),
    source: meta.source || 'manual',
    label: meta.label || null,
    stationId: meta.stationId || null,
    accuracy: meta.accuracy || null,
    segmentType: null,
    controlLat: null,
    controlLng: null,
  };
  if (captureState.points.length) {
    point.segmentType = meta.segmentType || captureState.lineMode || 'straight';
    if (point.segmentType === 'curve') {
      const prev = captureState.points.at(-1);
      const control = defaultCurveControl(prev, point);
      point.controlLat = control.lat;
      point.controlLng = control.lng;
    }
  }
  captureState.points.push(point);
  captureState.finished = false;
  captureState.selectedWaypointIndex = captureState.points.length - 1;
  captureState.selectedSegmentIndex = captureState.points.length > 1
    ? captureState.points.length - 1
    : null;
  rebuildCaptureMarkers();
  updateRouteTypeHint();
}

function capturePointIcon(index, source, selected = false) {
  const roleClass = source === 'station-end'
    ? ' is-station is-end'
    : source === 'station-via'
      ? ' is-station is-via'
      : source === 'station'
        ? ' is-station'
        : '';
  const selectedClass = selected ? ' is-selected' : '';
  return L.divIcon({
    className: '',
    html: `<div class="capture-point-marker${roleClass}${selectedClass}">${index}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

function defaultCurveControl(start, end) {
  const midLat = (Number(start.lat) + Number(end.lat)) / 2;
  const midLng = (Number(start.lng) + Number(end.lng)) / 2;
  const dLng = Number(end.lng) - Number(start.lng);
  const dLat = Number(end.lat) - Number(start.lat);
  const length = Math.hypot(dLat, dLng) || 1;
  const bulge = Math.min(0.00055, length * 0.22);
  return {
    lat: roundNumber(midLat + (-dLng / length) * bulge, 9),
    lng: roundNumber(midLng + (dLat / length) * bulge, 9),
  };
}

function getCurveControl(start, end) {
  if (end?.controlLat != null && end?.controlLng != null) {
    return { lat: Number(end.controlLat), lng: Number(end.controlLng) };
  }
  return defaultCurveControl(start, end);
}

function interpolateQuadraticCurve(start, end, control, steps) {
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const u = 1 - t;
    points.push({
      lat: roundNumber(u * u * start.lat + 2 * u * t * control.lat + t * t * end.lat, 9),
      lng: roundNumber(u * u * start.lng + 2 * u * t * control.lng + t * t * end.lng, 9),
    });
  }
  return points;
}

/** Đường hiển thị = đường lưu: thẳng từng đoạn, cong = bezier qua chốt vàng. */
function expandPath(points) {
  if (!points?.length) return [];
  if (points.length === 1) return [{ lat: Number(points[0].lat), lng: Number(points[0].lng) }];
  const result = [{ lat: Number(points[0].lat), lng: Number(points[0].lng) }];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const current = points[i];
    if (current.segmentType === 'curve') {
      const curve = interpolateQuadraticCurve(
        { lat: Number(prev.lat), lng: Number(prev.lng) },
        { lat: Number(current.lat), lng: Number(current.lng) },
        getCurveControl(prev, current),
        36,
      );
      for (let j = 1; j < curve.length; j += 1) result.push(curve[j]);
    } else {
      result.push({ lat: Number(current.lat), lng: Number(current.lng) });
    }
  }
  return result;
}

function densifyPolyline(points, segmentsPerEdge) {
  if (!points?.length) return [];
  if (points.length < 2) return points.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
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

function getPathCoordinates() {
  // WYSIWYG: đúng polyline đang vẽ. Densify nhẹ để GPS chạy mượt — không đổi hình.
  const expanded = expandPath(captureState.points);
  if (expanded.length < 2) {
    return captureState.points.map(({ lat, lng }) => ({ lat: Number(lat), lng: Number(lng) }));
  }
  return densifyPolyline(expanded, 8);
}

function renderCaptureLine() {
  if (captureLine) {
    captureLine.remove();
    captureLine = null;
  }
  if (helperCurveLine) {
    helperCurveLine.remove();
    helperCurveLine = null;
  }
  if (captureState.points.length < 2) return;
  const path = expandPath(captureState.points);
  captureLine = L.polyline(
    path.map((p) => [p.lat, p.lng]),
    {
      ...DRAFT_ROUTE_STYLE,
      weight: captureState.finished ? 5.5 : 4.5,
      interactive: false,
      smoothFactor: 0,
    },
  ).addTo(map);

  const idx = captureState.selectedSegmentIndex;
  if (idx > 0 && captureState.points[idx]?.segmentType === 'curve') {
    const prev = captureState.points[idx - 1];
    const cur = captureState.points[idx];
    const control = getCurveControl(prev, cur);
    helperCurveLine = L.polyline(
      [[prev.lat, prev.lng], [control.lat, control.lng], [cur.lat, cur.lng]],
      { color: '#f59e0b', weight: 2, opacity: 0.85, dashArray: '3 5', interactive: false },
    ).addTo(map);
  }
  updateStopChainPreview();
}

function clearControlMarkers() {
  for (const marker of controlMarkers) marker.remove();
  controlMarkers.length = 0;
}

function syncControlMarkers() {
  clearControlMarkers();
  const idx = captureState.selectedSegmentIndex;
  if (!idx || idx < 1) return;
  const prev = captureState.points[idx - 1];
  const current = captureState.points[idx];
  if (!prev || !current || current.segmentType !== 'curve') return;

  const control = getCurveControl(prev, current);
  const handle = L.marker([control.lat, control.lng], {
    draggable: true,
    zIndexOffset: 800,
    icon: L.divIcon({
      className: '',
      html: '<div class="control-handle" title="Kéo để uốn cong"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    }),
  }).addTo(map);

  handle.on('drag', () => {
    const latlng = handle.getLatLng();
    current.controlLat = roundNumber(latlng.lat, 9);
    current.controlLng = roundNumber(latlng.lng, 9);
    captureState.finished = false;
    renderCaptureLine();
    updateDrawStats();
  });
  handle.on('dragend', () => {
    updateRouteTypeHint();
    renderCaptureState();
  });
  controlMarkers.push(handle);
}

function bindCaptureMarkerEvents(marker, index) {
  marker.on('click', (event) => {
    if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
    captureState.selectedWaypointIndex = index;
    captureState.selectedSegmentIndex = index > 0 ? index : (captureState.points.length > 1 ? 1 : null);
    if (captureState.selectedSegmentIndex > 0) {
      const seg = captureState.points[captureState.selectedSegmentIndex];
      captureState.lineMode = seg.segmentType === 'curve' ? 'curve' : 'straight';
      modeStraightEl?.classList.toggle('is-active', captureState.lineMode === 'straight');
      modeCurveEl?.classList.toggle('is-active', captureState.lineMode === 'curve');
    }
    rebuildCaptureMarkers();
    captureStatusEl.textContent = index === 0
      ? 'Điểm #1. Chọn điểm kế tiếp để chỉnh đoạn.'
      : `Đã chọn đoạn #${index}. Bấm Thẳng/Cong hoặc kéo điểm / chốt vàng.`;
  });

  marker.on('drag', () => {
    const latlng = marker.getLatLng();
    const point = captureState.points[index];
    if (!point) return;
    point.lat = roundNumber(latlng.lat, 9);
    point.lng = roundNumber(latlng.lng, 9);
    // Kéo điểm bến → giữ stationId (vẫn là bến đó), chỉ đổi hình đường.
    captureState.finished = false;
    renderCaptureLine();
    syncControlMarkers();
    updateDrawStats();
  });

  marker.on('dragend', () => {
    updateRouteTypeHint();
    renderCaptureState();
    captureStatusEl.textContent = `Đã chỉnh điểm #${index + 1}. Đường lưu = đường đang thấy.`;
  });
}

function rebuildCaptureMarkers() {
  for (const marker of captureMarkers) marker.remove();
  captureMarkers.length = 0;
  clearControlMarkers();
  captureState.points.forEach((point, index) => {
    const selected = captureState.selectedWaypointIndex === index;
    const marker = L.marker([point.lat, point.lng], {
      icon: capturePointIcon(index + 1, point.source, selected),
      draggable: true,
      zIndexOffset: 600,
      autoPan: true,
    }).addTo(map);
    if (point.label) marker.bindTooltip(point.label, { direction: 'top', offset: [0, -10] });
    bindCaptureMarkerEvents(marker, index);
    captureMarkers.push(marker);
  });
  renderCaptureLine();
  syncControlMarkers();
  renderCaptureState();
}

function undoCapturePoint() {
  if (!captureState.points.length) return;
  captureState.points.pop();
  captureState.selectedWaypointIndex = captureState.points.length
    ? captureState.points.length - 1
    : null;
  captureState.selectedSegmentIndex = captureState.points.length > 1
    ? captureState.points.length - 1
    : null;
  rebuildCaptureMarkers();
  updateRouteTypeHint();
}

function clearCapturePoints() {
  for (const marker of captureMarkers) marker.remove();
  captureMarkers.length = 0;
  clearControlMarkers();
  captureState.points = [];
  captureState.finished = false;
  captureState.selectedSegmentIndex = null;
  captureState.selectedWaypointIndex = null;
  if (captureLine) {
    captureLine.remove();
    captureLine = null;
  }
  if (helperCurveLine) {
    helperCurveLine.remove();
    helperCurveLine = null;
  }
}

function renderCaptureState() {
  captureCountEl.textContent = `${captureState.points.length} điểm`;
  if (toggleCaptureEl) toggleCaptureEl.textContent = captureState.enabled ? 'Đang vẽ...' : 'Bắt đầu';
  if (undoCapturePointEl) undoCapturePointEl.disabled = !captureState.points.length;
  if (clearCaptureEl) clearCaptureEl.disabled = !captureState.points.length;
  if (saveCapturedRouteEl) saveCapturedRouteEl.disabled = captureState.points.length < 2;
  if (toolUndoEl) toolUndoEl.disabled = !captureState.points.length;
  const canClear = captureState.points.length > 0
    || Boolean(lockedSurveyPath)
    || Boolean(plannedRouteLine)
    || Boolean(selectedRouteId);
  if (toolClearEl) toolClearEl.disabled = !canClear;
  if (finishDrawEl) {
    finishDrawEl.disabled = captureState.points.length < 2 || captureState.finished;
  }
  updateDrawStats();
}

function clearSelectedRouteHighlight() {
  if (mapLegendSelectEl) mapLegendSelectEl.value = '';
  selectedRouteId = '';
  applySelectedRouteHighlight('');
  clearRouteStopMarkers();
  if (routeStopsListEl) {
    routeStopsListEl.classList.add('is-empty');
    routeStopsListEl.innerHTML = '<li>Chọn tuyến để xem chuỗi bến đã lưu.</li>';
  }
  updateLegendSwatch();
  // Ẩn luôn tuyến DB trên map để không còn thấy BD-TT… sau khi Xóa/bỏ chọn.
  if (showSavedRoutes) {
    showSavedRoutes = false;
    applySavedRoutesVisibility();
  }
  renderCaptureState();
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
  // phút = (km / vận_tốc_đăng_ký_kmh) × 60
  return (km / speed) * 60;
}

function catalogBoats(data = latest) {
  return (data?.boats || []).filter((boat) => (
    boat.boatCode && !String(boat.boatId || '').startsWith('collector-')
  ));
}

function findBoatByCode(boatCode, data = latest) {
  const code = String(boatCode || '').trim();
  if (!code) return null;
  return catalogBoats(data).find((boat) => String(boat.boatCode) === code) || null;
}

function boatMaxSpeedKmh(boat) {
  const max = Number(boat?.maxSpeedKmh);
  if (Number.isFinite(max) && max > 0) return max;
  return 80;
}

function getSurveySpeedKmh() {
  const boat = findBoatByCode(collectorBoatCodeEl?.value);
  const max = boat ? boatMaxSpeedKmh(boat) : 80;
  return clampNumber(Number(collectorSpeedEl?.value || 16), 0.1, max);
}

function applyBoatSpeedLimits() {
  const boat = findBoatByCode(collectorBoatCodeEl?.value);
  const max = boat ? boatMaxSpeedKmh(boat) : 80;
  if (collectorSpeedEl) {
    collectorSpeedEl.readOnly = false;
    collectorSpeedEl.max = String(max);
    const current = Number(collectorSpeedEl.value || 16);
    if (Number.isFinite(current) && current > max) {
      collectorSpeedEl.value = String(Number(max.toFixed(1)));
    }
  }
  if (boatSpeedHintEl) {
    const surveyDev = latest?.config?.surveyDeviceId || 'gps-wb-001';
    boatSpeedHintEl.textContent = boat
      ? `Tàu ${boat.boatCode} · Azure dùng device ${surveyDev} (đã đăng ký) · max ${max} km/h · cặp bến có lịch → phút lịch`
      : `Chọn tàu — survey luôn auth bằng ${surveyDev} để không lỗi đăng ký device`;
  }
}

function renderCollectorBoatOptions(boats) {
  if (!collectorBoatCodeEl) return;
  const list = (boats || []).filter((boat) => (
    boat.boatCode && !String(boat.boatId || '').startsWith('collector-')
  ));
  const previous = selectedCollectorBoatCode || collectorBoatCodeEl.value || localStorage.getItem('surveyBoatCode') || '';
  const options = list.map((boat) => {
    const max = boatMaxSpeedKmh(boat);
    const name = boat.boatName ? ` · ${boat.boatName}` : '';
    return {
      code: boat.boatCode,
      label: `${boat.boatCode}${name} · max ${max} km/h`,
    };
  });
  collectorBoatCodeEl.innerHTML = [
    '<option value="">Chọn tàu...</option>',
    ...options.map((item) => (
      `<option value="${escapeHtml(item.code)}">${escapeHtml(item.label)}</option>`
    )),
  ].join('');
  const preferred = options.some((item) => item.code === previous)
    ? previous
    : (options[0]?.code || '');
  collectorBoatCodeEl.value = preferred;
  selectedCollectorBoatCode = preferred;
  if (preferred) localStorage.setItem('surveyBoatCode', preferred);
  applyBoatSpeedLimits();
  updateDrawStats();
}

function updateDrawStats() {
  const meters = pathLengthMeters(captureState.points);
  const speed = getSurveySpeedKmh();
  const boat = findBoatByCode(collectorBoatCodeEl?.value);
  const max = boat ? boatMaxSpeedKmh(boat) : null;
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
  if (estimateSpeedEl) {
    estimateSpeedEl.textContent = max
      ? `${speed} km/h (max ${max})`
      : `${speed} km/h`;
  }
  if (estimateMinEl) {
    estimateMinEl.textContent = meters > 0
      ? `${minutesExact.toFixed(2)} phút`
      : '0 phút';
  }
  const formulaEl = document.querySelector('#estimateFormula');
  if (formulaEl) {
    formulaEl.textContent = meters > 0
      ? (preferWaterbusScheduleFe()
        ? `Ưu tiên phút lịch Waterbus nếu khớp cặp bến; không có lịch → (${km.toFixed(3)} km ÷ ${speed} km/h) × 60 = ${minutesExact.toFixed(2)} phút`
        : `(${km.toFixed(3)} km ÷ ${speed} km/h chạy) × 60 = ${minutesExact.toFixed(2)} phút · từng đoạn A→B tính riêng`)
      : 'Ưu tiên lịch Waterbus khi khớp cặp bến; còn lại phút = (km ÷ tốc độ) × 60';
  }
  updateStopChainPreview();
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
        boatCode: collectorBoatCodeEl.value.trim() || null,
        averageSpeedKmh: getSurveySpeedKmh(),
        ...surveySaveFields(),
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
  if (!collectorBoatCodeEl?.value?.trim()) {
    captureStatusEl.textContent = 'Chọn tàu GPS trước khi ghi.';
    collectorBoatCodeEl?.focus();
    return;
  }
  if (!validateReverseRouteCode()) {
    captureStatusEl.textContent = 'Mã chiều về không hợp lệ — phải khác mã tuyến chính.';
    reverseRouteCodeEl?.focus();
    return;
  }
  applyBoatSpeedLimits();
  if (!(getSurveySpeedKmh() > 0)) {
    captureStatusEl.textContent = 'Nhập tốc độ chạy hợp lệ (≤ max đăng ký).';
    collectorSpeedEl?.focus();
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
  } else {
    ensureEndStationFromPath();
  }

  if (!ensureEndStationFromPath({ quiet: true }) && !endStationEl?.value) {
    captureStatusEl.textContent = 'Cần bến cuối: double-click bến đích hoặc thêm ≥2 bến rồi bấm Xong.';
    return;
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
        speedKmh: getSurveySpeedKmh(),
        sendIntervalMs,
        sendToTarget: true,
        recording: true,
        isNewRouteSurvey: true,
        ...surveySaveFields(),
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
  if (!validateReverseRouteCode()) {
    captureStatusEl.textContent = 'Mã chiều về trùng mã tuyến chính — đổi trước khi lưu.';
    reverseRouteCodeEl?.focus();
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
        boatCode: collectorBoatCodeEl.value.trim() || null,
        description: 'Captured from GPS recording session',
        status: 'Active',
        averageSpeedKmh: getSurveySpeedKmh(),
        // Gửi lại đúng polyline đã vẽ — tránh BE dựng lại từ mẫu GPS thưa (gãy góc vuông).
        coordinates: (lockedSurveyPath?.length >= 2
          ? lockedSurveyPath
          : (captureState.points.length >= 2 ? getPathCoordinates() : null)),
        ...surveySaveFields(),
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
  const style = recordingActive || lockedSurveyPath
    ? SURVEY_ROUTE_STYLE
    : DRAFT_ROUTE_STYLE;
  if (plannedRouteLine) {
    plannedRouteLine.setLatLngs(latlngs);
    plannedRouteLine.setStyle(style);
  } else {
    plannedRouteLine = L.polyline(latlngs, {
      ...style,
      interactive: false,
      pane: 'overlayPane',
      smoothFactor: 0,
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
  const stopLines = stops
    .slice()
    .sort((a, b) => Number(a.stopOrder) - Number(b.stopOrder))
    .map((stop, index, arr) => {
      const order = Number(stop.stopOrder) || index + 1;
      const code = stop.stationCode ? ` (${stop.stationCode})` : '';
      const prev = arr[index - 1];
      const segment = index > 0
        ? (stop.standardTravelMin != null
          ? `<div class="route-result-seg">← ${stop.standardTravelMin} phút${stop.travelSource === 'schedule' ? ' (lịch Waterbus)' : ' (GPS×tốc độ)'}${stop.segmentDistanceKm != null ? ` · ${stop.segmentDistanceKm} km` : ''} từ ${escapeHtml(prev?.stationName || prev?.stationCode || `bến ${order - 1}`)}</div>`
          : `<div class="route-result-seg is-missing">← chưa đo được đoạn (đường không nối qua bến này)</div>`)
        : '';
      return `<li><strong>#${order}</strong> ${escapeHtml(stop.stationName || stop.stationCode || `Bến ${order}`)}${escapeHtml(code)}${segment}</li>`;
    }).join('');

  routeResultEl.innerHTML = `
    <div class="route-result-head">
      <strong>${escapeHtml(body.routeName || body.routeCode || '')}</strong>
      <span>${escapeHtml(body.routeCode || '')}</span>
    </div>
    <div class="route-result-meta">
      <span>BE: <b>${escapeHtml(body.routeType || (getSurveyRouteType() === 'SightseeingLoop' ? 'SightseeingLoop' : 'route nguồn'))}</b></span>
      <span>Quãng đường: <b>${distance != null ? `${distance} km` : '?'}</b></span>
      <span>Thời gian ước tính: <b>${duration != null ? `${duration} phút` : '?'}</b></span>
      <span>Số bến: <b>${stops.length}</b></span>
    </div>
    ${stops.length
      ? `<div class="route-result-stops-title">Thứ tự bến đã đẩy lên BE</div><ol class="route-result-stops">${stopLines}</ol>`
      : '<p class="meta">Chưa có station trong route_stops — kiểm tra payload stops[] gửi BE.</p>'}
    ${body.reverseRoute
      ? `<div class="route-result-stops-title">Đã tạo chiều về</div>
      <div class="route-result-meta">
        <span><b>${escapeHtml(body.reverseRoute.routeCode || '')}</b></span>
        <span>${escapeHtml(body.reverseRoute.routeName || '')}</span>
        <span>id: ${escapeHtml(body.reverseRoute.routeId || body.reverseRoute.id || '')}</span>
      </div>`
      : (body.reverseWarning || body.warning
        ? `<p class="meta is-error">${escapeHtml(body.reverseWarning || body.warning)}</p>`
        : (body.createReverseRoute
          ? '<p class="meta">Đã gửi createReverseRoute nhưng BE chưa trả reverseRoute.</p>'
          : ''))}
    <p class="meta"><a href="/api-log.html">Xem log API đẩy BE →</a></p>
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
  if (dbStatusEl) {
    dbStatusEl.textContent = data.dbStatus?.ok
      ? `${data.dbStatus.message} · ${formatTime(data.dbStatus.loadedAt)}`
      : `DB lỗi, đang dùng fallback: ${data.dbStatus?.message || ''}`;
  }

  const endpoint = data.config?.targetEndpoint || '';
  if (targetTextEl) targetTextEl.textContent = endpoint || 'Local only';
  if (sendTargetSelectEl) {
    sendTargetSelectEl.value = data.config?.senderEnabled ? 'on' : 'off';
    sendTargetSelectEl.title = endpoint
      ? `Endpoint: ${endpoint}`
      : 'Chưa cấu hình TARGET_GPS_ENDPOINT';
  }
  if (toggleSenderEl) {
    toggleSenderEl.textContent = data.config?.senderEnabled ? 'POST on' : 'POST off';
    toggleSenderEl.classList.toggle('secondary', !data.config?.senderEnabled);
  }
  if (senderBadgeEl) {
    senderBadgeEl.textContent = data.config?.senderEnabled ? 'Live' : 'Idle';
    senderBadgeEl.classList.toggle('is-live', Boolean(data.config?.senderEnabled));
  }
  updateSenderToggleChip(data);

  const catalogFp = catalogBoats(data)
    .map((boat) => `${boat.boatId}:${boat.boatCode}:${boat.maxSpeedKmh}`)
    .join('|');
  if (catalogFp !== lastBoatIds) {
    lastBoatIds = catalogFp;
    renderCollectorBoatOptions(catalogBoats(data));
  } else {
    applyBoatSpeedLimits();
  }

  const boatIds = SHOW_LIVE_BOATS ? data.boats.map((boat) => boat.boatId).join('|') : '';
  if (!SHOW_LIVE_BOATS) {
    boatsEl.innerHTML = '';
  } else if (boatIds !== lastLiveBoatIds) {
    lastLiveBoatIds = boatIds;
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
    sendModeEl?.classList?.toggle?.('is-live', data.lastSend.mode === 'target');
    if (sendModeEl) sendModeEl.textContent = data.lastSend.mode === 'target' ? 'Target' : 'Local';
  } else if (!data.collector && !autoSaveInFlight) {
    sendLogEl.textContent = data.config?.senderEnabled
      ? 'Đang chờ lần gửi đầu tiên...'
      : 'Chọn bến → vẽ đường → bắt đầu ghi.';
    if (sendModeEl) {
      sendModeEl.textContent = 'Idle';
      sendModeEl.classList.remove('is-live');
    }
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
    if (sendModeEl) sendModeEl.textContent = data.lastCollectorSend.mode === 'target' ? 'Target' : 'Local';
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

function applySavedRoutesVisibility() {
  for (const layer of routeLayers.values()) {
    if (showSavedRoutes) {
      if (!map.hasLayer(layer)) layer.addTo(map);
    } else if (map.hasLayer(layer)) {
      map.removeLayer(layer);
    }
  }
  if (!showSavedRoutes) {
    clearRouteStopMarkers();
    if (routeStopsListEl) {
      routeStopsListEl.classList.add('is-empty');
      routeStopsListEl.innerHTML = '<li>Đang ẩn tuyến có sẵn — bật lại để xem bến.</li>';
    }
  } else if (mapLegendSelectEl?.value) {
    showSelectedRouteStops(mapLegendSelectEl.value);
  }
  if (toggleSavedRoutesEl) {
    toggleSavedRoutesEl.classList.toggle('is-on', showSavedRoutes);
    toggleSavedRoutesEl.classList.toggle('is-off', !showSavedRoutes);
    toggleSavedRoutesEl.textContent = showSavedRoutes ? 'Ẩn tuyến có sẵn' : 'Hiện tuyến có sẵn';
  }
}

toggleSavedRoutesEl?.addEventListener('click', () => {
  showSavedRoutes = !showSavedRoutes;
  applySavedRoutesVisibility();
});

function applySelectedRouteHighlight(routeId = selectedRouteId) {
  selectedRouteId = routeId ? String(routeId) : '';
  const hasSelection = Boolean(selectedRouteId);
  for (const [id, layer] of routeLayers) {
    if (!layer) continue;
    if (hasSelection && String(id) === selectedRouteId) {
      layer.setStyle({ ...SELECTED_ROUTE_STYLE, smoothFactor: 0 });
      if (typeof layer.bringToFront === 'function') layer.bringToFront();
    } else if (hasSelection) {
      layer.setStyle({ ...DIMMED_ROUTE_STYLE, smoothFactor: 0 });
    } else {
      layer.setStyle({ ...SAVED_ROUTE_STYLE, smoothFactor: 0 });
    }
  }
  if (mapLegendSwatchEl) {
    mapLegendSwatchEl.style.background = hasSelection
      ? SELECTED_ROUTE_STYLE.color
      : SAVED_ROUTE_STYLE.color;
    mapLegendSwatchEl.style.borderTop = 'none';
    mapLegendSwatchEl.style.height = hasSelection ? '6px' : '3px';
  }
}

function renderRoutes(routes) {
  const seen = new Set();
  const bounds = [];
  const previousValue = mapLegendSelectEl?.value || selectedRouteId || '';
  if (mapLegendSelectEl) {
    mapLegendSelectEl.innerHTML = '<option value="">Chọn tuyến...</option>';
  }

  routes.forEach((route) => {
    seen.add(route.routeId);
    const color = SAVED_ROUTE_STYLE.color;
    let layer = routeLayers.get(route.routeId);
    const latlngs = (route.coordinates || []).map((p) => [p.lat, p.lng]);
    if (!layer) {
      layer = L.polyline(latlngs, { ...SAVED_ROUTE_STYLE, smoothFactor: 0 });
      if (showSavedRoutes) layer.addTo(map);
      layer.bindTooltip(`${route.routeCode} · ${route.routeName}`);
      layer.on('click', () => {
        if (mapLegendSelectEl) {
          // Mở panel khi click tuyến trên map.
          if (mapLegendPanelEl?.classList.contains('is-collapsed')) {
            mapLegendPanelEl.classList.remove('is-collapsed');
            if (mapLegendBodyEl) mapLegendBodyEl.hidden = false;
            mapLegendToggleEl?.setAttribute('aria-expanded', 'true');
          }
          mapLegendSelectEl.value = String(route.routeId);
          mapLegendSelectEl.dispatchEvent(new Event('change'));
        }
      });
      routeLayers.set(route.routeId, layer);
    } else {
      layer.setLatLngs(latlngs);
      if (showSavedRoutes && !map.hasLayer(layer)) layer.addTo(map);
      if (!showSavedRoutes && map.hasLayer(layer)) map.removeLayer(layer);
    }
    for (const p of latlngs) bounds.push(p);

    if (mapLegendSelectEl) {
      const option = document.createElement('option');
      option.value = route.routeId;
      option.textContent = route.routeCode || route.routeName || route.routeId;
      option.dataset.color = color;
      mapLegendSelectEl.appendChild(option);
    }
  });

  for (const [id, layer] of routeLayers) {
    if (!seen.has(id)) {
      layer.remove();
      routeLayers.delete(id);
    }
  }

  if (mapLegendSelectEl) {
    const stillExists = [...mapLegendSelectEl.options].some((opt) => opt.value === previousValue);
    mapLegendSelectEl.value = stillExists ? previousValue : '';
    selectedRouteId = mapLegendSelectEl.value || '';
    updateLegendSwatch();
    applySelectedRouteHighlight(selectedRouteId);
    if (showSavedRoutes) showSelectedRouteStops(mapLegendSelectEl.value || '');
    else applySavedRoutesVisibility();
  }

  if (!hasFitInitialRoutes && bounds.length && !recordingActive && !lockedSurveyPath) {
    hasFitInitialRoutes = true;
    map.fitBounds(bounds, { padding: [48, 48] });
  }
}

function clearRouteStopMarkers() {
  if (routeStopMarkersLayer) {
    routeStopMarkersLayer.clearLayers();
  }
  selectedRouteStops = [];
}

function routeStopIcon(order, { isFirst = false, isLast = false } = {}) {
  const role = isFirst ? ' is-first' : (isLast ? ' is-last' : '');
  return L.divIcon({
    className: '',
    html: `<div class="route-stop-marker${role}">${order}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function showSelectedRouteStops(routeId) {
  clearRouteStopMarkers();
  if (!routeStopsListEl) return;

  if (!routeId) {
    routeStopsListEl.classList.add('is-empty');
    routeStopsListEl.innerHTML = '<li>Chọn tuyến để xem chuỗi bến đã lưu.</li>';
    return;
  }

  const route = (latest?.routes || []).find((r) => String(r.routeId) === String(routeId));
  const stops = Array.isArray(route?.stops)
    ? [...route.stops].sort((a, b) => Number(a.stopOrder) - Number(b.stopOrder))
    : [];
  selectedRouteStops = stops;

  if (!stops.length) {
    routeStopsListEl.classList.add('is-empty');
    routeStopsListEl.innerHTML = '<li>Tuyến này chưa có stops từ BE/DB.</li>';
    return;
  }

  routeStopsListEl.classList.remove('is-empty');
  routeStopsListEl.innerHTML = stops.map((stop, index) => {
    const order = Number(stop.stopOrder) || index + 1;
    const name = stop.stationName || stop.stationCode || stop.stationId || `Bến ${order}`;
    const code = stop.stationCode ? ` (${stop.stationCode})` : '';
    const travel = stop.standardTravelMin != null ? ` · ${stop.standardTravelMin} phút` : '';
    return `<li><b>#${order}</b>${escapeHtml(name)}${escapeHtml(code)}${travel}</li>`;
  }).join('');

  if (!routeStopMarkersLayer) {
    routeStopMarkersLayer = L.layerGroup().addTo(map);
  }
  stops.forEach((stop, index) => {
    const lat = Number(stop.lat);
    const lng = Number(stop.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const order = Number(stop.stopOrder) || index + 1;
    const marker = L.marker([lat, lng], {
      icon: routeStopIcon(order, {
        isFirst: index === 0,
        isLast: index === stops.length - 1,
      }),
      zIndexOffset: 500,
    });
    marker.bindTooltip(
      `#${order} · ${stop.stationName || stop.stationCode || stop.stationId}`,
      { direction: 'top', offset: [0, -10] },
    );
    routeStopMarkersLayer.addLayer(marker);
  });
}

function updateLegendSwatch() {
  if (!mapLegendSwatchEl || !mapLegendSelectEl) return;
  const selected = mapLegendSelectEl.selectedOptions?.[0];
  const hasSelection = Boolean(selected?.value);
  mapLegendSwatchEl.style.background = hasSelection
    ? SELECTED_ROUTE_STYLE.color
    : SAVED_ROUTE_STYLE.color;
  mapLegendSwatchEl.style.borderTop = 'none';
  mapLegendSwatchEl.style.height = hasSelection ? '6px' : '3px';
}

mapLegendSelectEl?.addEventListener('change', () => {
  updateLegendSwatch();
  const routeId = mapLegendSelectEl.value;
  if (!showSavedRoutes) {
    showSavedRoutes = true;
    applySavedRoutesVisibility();
  }
  applySelectedRouteHighlight(routeId);
  showSelectedRouteStops(routeId);
  renderCaptureState();
  if (!routeId) return;
  const layer = routeLayers.get(routeId);
  if (!layer) return;
  try {
    const stopBounds = selectedRouteStops
      .filter((s) => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng)))
      .map((s) => [Number(s.lat), Number(s.lng)]);
    if (stopBounds.length >= 2) {
      map.fitBounds(stopBounds, { padding: [48, 48], maxZoom: 16 });
    } else {
      map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 16 });
    }
  } catch {
    // ignore
  }
});

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
      layer.on('click', (event) => {
        if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
        handleStationClick(station);
      });
      layer.on('dblclick', (event) => {
        if (event.originalEvent) {
          L.DomEvent.stopPropagation(event.originalEvent);
          L.DomEvent.preventDefault(event.originalEvent);
        }
        handleStationDoubleClick(station);
      });
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
    setStationComboValue('start', station.stationId);
    return;
  }

  const startId = captureState.points[0]?.stationId;
  const isSameAsStart = startId && String(station.stationId) === String(startId);

  // Click lại bến đầu khi đã có đường → đóng vòng sightseeing (cùng 1 bến).
  if (isSameAsStart && captureState.points.length >= 2) {
    closeAsEndStation(station);
    return;
  }
  if (isSameAsStart) {
    captureStatusEl.textContent = 'Cùng bến đầu: hãy vẽ điểm giữa trước, rồi click lại bến này để đóng vòng.';
    return;
  }

  // Đã có bến cuối: click bến khác (không phải cuối) = chèn bến giữa trước điểm cuối.
  if (endStationEl?.value) {
    // Đang đóng vòng (end === start) mà click bến khác → đổi thành Regular tới bến đó.
    if (String(endStationEl.value) === String(startId)) {
      setStationComboValue('end', '', { emitChange: false });
      // Gỡ điểm đóng vòng cũ nếu có.
      const last = captureState.points.at(-1);
      if (last?.source === 'station-end' && String(last.stationId) === String(startId)) {
        captureState.points.pop();
        rebuildCaptureMarkers();
      }
      addViaStation(station);
      return;
    }
    if (String(station.stationId) === String(endStationEl.value)) {
      closeAsEndStation(station);
      return;
    }
    insertViaBeforeEnd(station);
    return;
  }

  // Mặc định: nối thẳng tới bến này (via). Double-click để đặt làm cuối.
  addViaStation(station);
}

function insertViaBeforeEnd(station) {
  const endId = endStationEl?.value;
  const startId = captureState.points[0]?.stationId;
  const endIdx = [...captureState.points]
    .map((p, i) => ({ p, i }))
    .reverse()
    .find((x) => x.p.stationId && String(x.p.stationId) === String(endId))?.i;
  if (endIdx == null) {
    addViaStation(station);
    return;
  }
  // Cho phép trùng bến đầu khi loop; chặn trùng bến khác đã có.
  const dup = captureState.points.some((p, i) => (
    i !== 0
    && p.stationId
    && String(p.stationId) === String(station.stationId)
    && String(station.stationId) !== String(startId)
  ));
  if (dup) {
    captureStatusEl.textContent = 'Bến này đã có trong lộ trình.';
    return;
  }
  captureState.enabled = true;
  captureState.finished = false;
  const point = {
    lat: Number(station.lat),
    lng: Number(station.lng),
    source: 'station-via',
    label: station.stationName,
    stationId: station.stationId,
    segmentType: captureState.lineMode || 'straight',
    controlLat: null,
    controlLng: null,
  };
  if (point.segmentType === 'curve' && endIdx > 0) {
    const prev = captureState.points[endIdx - 1];
    const control = defaultCurveControl(prev, point);
    point.controlLat = control.lat;
    point.controlLng = control.lng;
  }
  captureState.points.splice(endIdx, 0, point);
  rebuildCaptureMarkers();
  updateRouteTypeHint();
  captureStatusEl.textContent = `Đã chèn bến giữa: ${station.stationName} (trước bến cuối).`;
}

function handleStationDoubleClick(station) {
  if (!captureState.points.length || captureState.points[0]?.source !== 'station') {
    setStationComboValue('start', station.stationId);
    return;
  }
  closeAsEndStation(station);
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
