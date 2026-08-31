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
const gpsLiveCardEl = document.querySelector('#gpsLiveCard');
const hubStatusEl = document.querySelector('#hubStatus');
const hubStatusModeEl = document.querySelector('#hubStatusMode');
const hubStatusEndpointEl = document.querySelector('#hubStatusEndpoint');
const hubStatusEndpointRowEl = document.querySelector('#hubStatusEndpointRow');
const hubStatusAzureEl = document.querySelector('#hubStatusAzure');
const hubStatusSignalrEl = document.querySelector('#hubStatusSignalr');
const hubStatusLastSendEl = document.querySelector('#hubStatusLastSend');
const hubStatusPointsEl = document.querySelector('#hubStatusPoints');
const hubStatusNoteEl = document.querySelector('#hubStatusNote');
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
const berthBufferMinEl = document.querySelector('#berthBufferMin');
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
const estimateCruiseMinEl = document.querySelector('#estimateCruiseMin');
const estimateBufferMinEl = document.querySelector('#estimateBufferMin');
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
const toastHostEl = document.querySelector('#toastHost');
const charterRequestListEl = document.querySelector('#charterRequestList');
const charterRefreshBtnEl = document.querySelector('#charterRefreshBtn');
const charterActiveBannerEl = document.querySelector('#charterActiveBanner');
const charterActiveTitleEl = document.querySelector('#charterActiveTitle');
const charterActiveMetaEl = document.querySelector('#charterActiveMeta');
const charterClearBtnEl = document.querySelector('#charterClearBtn');
const charterNextLegBtnEl = document.querySelector('#charterNextLegBtn');

function toast(message, type = 'info', ms = 3200) {
  const text = String(message || '').trim();
  if (!text) return;
  if (!toastHostEl) {
    console.log(`[toast:${type}]`, text);
    return;
  }
  const el = document.createElement('div');
  el.className = `toast is-${type === 'error' ? 'err' : type}`;
  el.textContent = text;
  toastHostEl.appendChild(el);
  window.setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.2s ease';
    window.setTimeout(() => el.remove(), 220);
  }, Math.max(1600, Number(ms) || 3200));
}

function notifyOk(message, ms) { toast(message, 'ok', ms); }
function notifyErr(message, ms) { toast(message, 'err', ms || 4500); }
function notifyWarn(message, ms) { toast(message, 'warn', ms || 4000); }
function notifyInfo(message, ms) { toast(message, 'info', ms); }

const markers = new Map();
const routeLayers = new Map();
const stationLayers = new Map();
const captureMarkers = [];
const controlMarkers = [];
let captureLine = null;
let captureAttachedLine = null;
let helperCurveLine = null;
let plannedRouteLine = null;
let completedRouteLine = null; // sau khi chạy xong: chỉ còn đường liền (bỏ điểm số)
let lockedSurveyPath = null; // giữ đường vẽ suốt lúc tàu chạy — không cho auto-save cũ xóa
let riverPathOverride = null; // path bo sông (hành lang Waterbus) — tàu chạy đúng vạch
let riverCorridorLine = null; // guide dashed trên map
let collectorMarker = null;
let pendingRevealRoute = null; // { routeId, routeCode } — chọn tuyến vừa lưu trên map
let routeStopMarkersLayer = null;
let selectedRouteStops = [];
let selectedRouteId = '';
// Mặc định ẩn tuyến DB trên map survey — tránh lẫn với đường đang vẽ (BD-TT…).
let showSavedRoutes = false;
/** Snapshot toggle trước khi mở CB — bỏ chọn thì trả lại. */
let showSavedRoutesBeforeCharter = null;
/**
 * Khi đang mở CB: chỉ hiện các routeId này trên map (Set rỗng = ẩn hết DB routes).
 * null = không lọc (chế độ survey thường).
 */
let charterRouteFilterIds = null;
/** Yêu cầu charter đang mở trên Bảng vẽ (preload bến / candidate). */
let activeCharterRequest = null;
/** Chặng charter đang vẽ — BE contract: 1 route = 1 chặng = đúng 2 bến / 1 lần gửi. */
let activeCharterLeg = null;
/** Set các requestId charter đã hoàn tất (route đã lưu đủ chặng) — lưu localStorage để ẩn khỏi panel. */
let charterDoneRequestIds = new Set(JSON.parse(localStorage.getItem('charterDoneIds') || '[]'));
let charterCandidateLayer = null;
let charterStopLayer = null;
/** stationId → stopOrder của yêu cầu charter đang mở (đổi màu cờ bến sẵn có). */
const charterStopOrders = new Map();
let latest = null;
let hasFitInitialRoutes = false;
let lastStationsFingerprint = '';
let lastRoutesFingerprint = '';
let lastBoatIds = '';
let lastLiveBoatIds = '';
let collectorBoatOptionsPending = false;
let collectorBoatSelectInteracting = false;
let collectorBoatOptionsInitialized = false;
let collectorBoatOptionsFlushTimer = null;
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
const BOAT_DRAFT_STORAGE_KEY = 'surveyBoatDrafts.v1';
let boatDrafts = loadBoatDrafts();
let signalrConnection = null;
let currentSignalR = null;
const signalrLiveMarkers = new Map();
let signalrConnectedOnce = false;

/** Bán kính Trái Đất WGS84 mean (mét) — dùng thống nhất FE/BE. */
const EARTH_RADIUS_M = 6371008.8;

const captureState = {
  enabled: false,
  finished: false,
  // Chế độ mặc định cho đoạn mới: thẳng | cong (kéo điểm vàng để uốn).
  lineMode: 'straight',
  selectedSegmentIndex: null,
  selectedWaypointIndex: null,
  points: [],
  /** Số điểm đầu là đoạn đã gắn từ tuyến có sẵn (đỏ mờ, ẩn marker). */
  attachedCount: 0,
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
/** Đoạn charter đã gắn từ tuyến có sẵn — đỏ mờ, không hiện điểm số. */
const ATTACHED_ROUTE_STYLE = {
  color: '#dc2626',
  weight: 4,
  opacity: 0.38,
  dashArray: null,
};
/** Tuyến DB khớp chặng CB đang mở — đỏ mờ, chỉ hiện các route của CB. */
const CHARTER_MATCHED_ROUTE_STYLE = {
  color: '#dc2626',
  weight: 5,
  opacity: 0.55,
  dashArray: null,
};
/** Đang chạy / đã xong: đường liền (không còn nét đứt + điểm số). */
const SURVEY_ROUTE_STYLE = {
  color: '#0f766e',
  weight: 6,
  opacity: 0.95,
  dashArray: null,
};
const COMPLETED_ROUTE_STYLE = {
  color: '#0f766e',
  weight: 6,
  opacity: 0.96,
  dashArray: null,
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
  const block = surveyDrawBlocked();
  if (block) {
    setDrawTool('pan');
    captureStatusEl.textContent = `Không vẽ: ${block}`;
    notifyWarn(`Không vẽ: ${block}`);
    return;
  }
  captureState.finished = false;
  clearCompletedRouteLine();
  setDrawTool('draw');
  captureStatusEl.textContent = 'Đang vẽ: click thêm điểm. Kéo điểm để chỉnh. Thẳng/Cong = đoạn mới (hoặc đoạn đang chọn).';
  updateWorkflow('draw');
  rebuildCaptureMarkers();
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
  clearCompletedRouteLine();
  pendingRevealRoute = null;
  captureState.finished = false;
  captureStatusEl.textContent = 'Đã xóa đường trên bản đồ.';
  routeResultEl?.classList.add('hidden');
  updateWorkflow('draw');
  renderCaptureState();
});
finishDrawEl?.addEventListener('click', finishDraw);
collectorBoatCodeEl?.addEventListener('pointerdown', beginCollectorBoatInteraction);
collectorBoatCodeEl?.addEventListener('mousedown', beginCollectorBoatInteraction);
collectorBoatCodeEl?.addEventListener('touchstart', beginCollectorBoatInteraction, { passive: true });
collectorBoatCodeEl?.addEventListener('keydown', beginCollectorBoatInteraction);
collectorBoatCodeEl?.addEventListener('keyup', (event) => {
  if (event.key === 'Escape') endCollectorBoatInteraction();
});
collectorBoatCodeEl?.addEventListener('pointercancel', endCollectorBoatInteraction);
collectorBoatCodeEl?.addEventListener('touchcancel', endCollectorBoatInteraction);
collectorBoatCodeEl?.addEventListener('change', () => {
  switchBoatDraft(collectorBoatCodeEl.value.trim());
  endCollectorBoatInteraction();
});
collectorBoatCodeEl?.addEventListener('blur', endCollectorBoatInteraction);
collectorSpeedEl?.addEventListener('input', () => {
  applyBoatSpeedLimits();
  updateDrawStats();
});
berthBufferMinEl?.addEventListener('input', () => {
  persistBerthBufferMin();
  updateDrawStats();
});

// Khôi phục đệm admin đã chỉnh.
try {
  const savedBuffer = localStorage.getItem('surveyBerthBufferMin');
  if (berthBufferMinEl && savedBuffer != null && savedBuffer !== '' && Number.isFinite(Number(savedBuffer))) {
    berthBufferMinEl.value = String(Number(savedBuffer));
  }
} catch {
  /* ignore */
}

function loadBoatDrafts() {
  try {
    const raw = localStorage.getItem(BOAT_DRAFT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persistBoatDrafts() {
  try {
    localStorage.setItem(BOAT_DRAFT_STORAGE_KEY, JSON.stringify(boatDrafts));
  } catch {
    // ignore quota
  }
}

function snapshotActiveDraft() {
  return {
    points: captureState.points.map((p) => ({ ...p })),
    finished: Boolean(captureState.finished),
    lineMode: captureState.lineMode || 'straight',
    routeCode: captureRouteCodeEl?.value.trim() || '',
    routeName: captureRouteNameEl?.value.trim() || '',
    startStationId: startStationEl?.value || '',
    endStationId: endStationEl?.value || '',
    createReverseRoute: Boolean(createReverseRouteEl?.checked),
    reverseRouteCode: reverseRouteCodeEl?.value.trim() || '',
    reverseRouteName: reverseRouteNameEl?.value.trim() || '',
    speedKmh: Number(collectorSpeedEl?.value || 16),
    berthBufferMin: getBerthBufferMinutes(),
    updatedAt: new Date().toISOString(),
  };
}

function saveActiveBoatDraft(boatCode = selectedCollectorBoatCode || collectorBoatCodeEl?.value.trim()) {
  const code = String(boatCode || '').trim();
  if (!code) return;
  if (captureState.points.length < 1
    && !captureRouteCodeEl?.value.trim()
    && !startStationEl?.value) {
    if (!boatDrafts[code]) return;
  }
  boatDrafts[code] = snapshotActiveDraft();
  persistBoatDrafts();
}

function applyBoatDraft(draft) {
  clearCapturePoints();
  clearPlannedRoute();
  unlockSurveyPath();
  const data = draft || {};
  captureState.finished = Boolean(data.finished);
  captureState.lineMode = data.lineMode === 'curve' ? 'curve' : 'straight';
  modeStraightEl?.classList.toggle('is-active', captureState.lineMode === 'straight');
  modeCurveEl?.classList.toggle('is-active', captureState.lineMode === 'curve');
  captureState.points = Array.isArray(data.points)
    ? data.points.map((p) => ({ ...p }))
    : [];
  if (captureRouteCodeEl) captureRouteCodeEl.value = data.routeCode || '';
  if (captureRouteNameEl) captureRouteNameEl.value = data.routeName || '';
  if (data.startStationId) setStationComboValue('start', data.startStationId, { emitChange: false });
  else setStationComboValue('start', '', { emitChange: false });
  if (data.endStationId) setStationComboValue('end', data.endStationId, { emitChange: false });
  else setStationComboValue('end', '', { emitChange: false });
  syncEndStationDisplay();
  if (createReverseRouteEl) createReverseRouteEl.checked = Boolean(data.createReverseRoute);
  if (reverseRouteCodeEl) reverseRouteCodeEl.value = data.reverseRouteCode || '';
  if (reverseRouteNameEl) reverseRouteNameEl.value = data.reverseRouteName || '';
  if (collectorSpeedEl && Number(data.speedKmh) > 0) collectorSpeedEl.value = String(data.speedKmh);
  if (berthBufferMinEl && Number.isFinite(Number(data.berthBufferMin))) {
    berthBufferMinEl.value = String(Number(data.berthBufferMin));
    persistBerthBufferMin();
  }
  updateReverseRouteUi();
  rebuildCaptureMarkers();
  renderCaptureLine();
  renderCaptureState();
  updateDrawStats();
  updateRouteTypeHint();
}

/** Chọn tàu → nạp bản vẽ của tàu đó.
 *  Cho phép vẽ trước / chọn tàu sau: nếu đang có đường trên map mà tàu mới chưa có draft
 *  → giữ nguyên đường và gắn cho tàu vừa chọn (không xóa).
 */
function switchBoatDraft(nextBoatCode) {
  const next = String(nextBoatCode || '').trim();
  const prev = String(selectedCollectorBoatCode || '').trim();
  if (recordingActive || lockedSurveyPath) {
    captureStatusEl.textContent = 'Đang ghi GPS — không đổi tàu lúc này.';
    notifyWarn('Đang ghi GPS — không đổi tàu lúc này.');
    if (collectorBoatCodeEl) collectorBoatCodeEl.value = prev || '';
    return;
  }
  if (next) {
    const block = boatSurveyBlockReason(next);
    if (block) {
      captureStatusEl.textContent = `Tàu ${next} ${block}.`;
      notifyWarn(`Không đi dò: ${next} ${block}`);
      if (collectorBoatCodeEl) collectorBoatCodeEl.value = prev || '';
      return;
    }
  }
  if (next === prev) {
    if (collectorBoatCodeEl) collectorBoatCodeEl.value = next;
    applyBoatSpeedLimits();
    renderCaptureState();
    return;
  }

  // Đổi tàu khác → lưu draft tàu cũ.
  if (prev && prev !== next) {
    saveActiveBoatDraft(prev);
  }

  selectedCollectorBoatCode = next;
  if (collectorBoatCodeEl) collectorBoatCodeEl.value = next;
  if (next) localStorage.setItem('surveyBoatCode', next);
  else localStorage.removeItem('surveyBoatCode');

  const existingDraft = next ? boatDrafts[next] : null;
  const hasCanvas = captureState.points.length > 0
    || Boolean(captureRouteCodeEl?.value.trim())
    || Boolean(startStationEl?.value);

  if (!next) {
    // Bỏ chọn tàu → xóa đường đang vẽ.
    applyBoatDraft(null);
  } else if (existingDraft && (prev || !hasCanvas)) {
    // Có draft sẵn của tàu này → nạp (trừ khi vừa gắn đường hiện tại vào tàu trống).
    applyBoatDraft(existingDraft);
  } else if (hasCanvas && !existingDraft) {
    // Vẽ trước / chọn tàu sau, hoặc tàu chưa có draft → giữ đường, gắn vào tàu.
    saveActiveBoatDraft(next);
  } else {
    applyBoatDraft(existingDraft || null);
  }

  applyBoatSpeedLimits();
  renderCaptureState();
  const pts = captureState.points.length;
  captureStatusEl.textContent = next
    ? (pts ? `Tàu ${next} · ${pts} điểm — sẵn sàng ghi GPS` : `Đã chọn ${next} — vẽ đường rồi bắt đầu ghi GPS`)
    : 'Chưa chọn tàu — chọn tàu đã đăng ký trước khi ghi GPS.';
}

function connectSignalRIfConfigured(config = latest?.config) {
  // Mặc định: server Node nối Azure hub rồi relay qua SSE (tránh CORS Railway→Azure).
  if (config?.signalrRelay !== false) {
    const st = config?.signalrStatus;
    const hub = st?.hubUrl || 'hub';
    currentSignalR = {
      connected: Boolean(st?.connected),
      hubUrl: hub,
      lastError: st?.lastError || '',
      state: st?.connected ? 'connected' : 'relay',
    };
    if (st?.connected) {
      if (!signalrConnectedOnce) {
        signalrConnectedOnce = true;
        notifyOk('SignalR relay đã nối Azure /hubs/tracking.');
      }
      if (sendLogEl) sendLogEl.textContent = `SignalR relay OK: ${hub}`;
    } else if (sendLogEl) {
      sendLogEl.textContent = `SignalR relay: ${st?.lastError || 'đang nối…'} · ${hub}`;
    }
    return;
  }

  const hubUrl = String(config?.signalrHubUrl || '').trim();
  if (!hubUrl || typeof signalR === 'undefined') return;
  if (signalrConnection) return;
  try {
    signalrConnection = new signalR.HubConnectionBuilder()
      .withUrl(hubUrl, { withCredentials: false })
      .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
      .build();

    const onBoatLocation = (payload) => {
      // Map Survey chỉ vẽ đường — không hiện tàu live (xem Live GPS).
      void payload;
    };
    signalrConnection.on('boatLocation', onBoatLocation);
    signalrConnection.on('BoatLocationUpdated', onBoatLocation);

    signalrConnection.onreconnecting((err) => {
      currentSignalR = { connected: false, hubUrl, lastError: err?.message || '', state: 'reconnecting' };
      if (sendLogEl) sendLogEl.textContent = `SignalR reconnecting… ${err?.message || ''}`.trim();
    });
    signalrConnection.onreconnected(() => {
      currentSignalR = { connected: true, hubUrl, lastError: '', state: 'connected' };
      if (sendLogEl) sendLogEl.textContent = `SignalR reconnected: ${hubUrl}`;
      notifyOk('SignalR đã kết nối lại.');
    });
    signalrConnection.onclose(() => {
      signalrConnection = null;
      signalrConnectedOnce = false;
      currentSignalR = { connected: false, hubUrl, lastError: '', state: 'closed' };
      if (sendLogEl) sendLogEl.textContent = 'SignalR disconnected';
    });

    signalrConnection.start()
      .then(() => {
        signalrConnectedOnce = true;
        currentSignalR = { connected: true, hubUrl, lastError: '', state: 'connected' };
        if (sendLogEl) sendLogEl.textContent = `SignalR connected: ${hubUrl}`;
        notifyOk('SignalR đã kết nối /hubs/tracking.');
      })
      .catch((error) => {
        console.warn('[signalr] connect failed', error.message);
        currentSignalR = { connected: false, hubUrl, lastError: error.message, state: 'error' };
        if (!signalrConnectedOnce) {
          notifyWarn(`SignalR browser CORS thất bại (${error.message}). Dùng relay SSE.`);
        }
        signalrConnection = null;
      });
  } catch (error) {
    console.warn('[signalr]', error.message);
    notifyWarn(`SignalR lỗi: ${error.message}`);
    signalrConnection = null;
  }
}

/** Mã tàu đang live GPS thật (hub online) hoặc đang ghi survey trên map. */
function activeLiveBoatCodes(data = latest) {
  const codes = new Set();
  for (const boat of data?.hubBoats || []) {
    const code = String(boat?.boatCode || '').trim();
    if (code && boat.isOnline !== false) codes.add(code);
  }
  const collectorCode = String(data?.collector?.boatCode || '').trim();
  const collectorActive = data?.collector
    && ['running', 'completed', 'paused'].includes(String(data.collector.status || ''));
  if (collectorCode && collectorActive) codes.add(collectorCode);
  return codes;
}

function collectorBoatCodeActive(data = latest) {
  const code = String(data?.collector?.boatCode || '').trim();
  if (!code) return '';
  const status = String(data?.collector?.status || '');
  return ['running', 'paused', 'completed'].includes(status) ? code : '';
}

function removeSignalRBoatMarker(code) {
  const marker = signalrLiveMarkers.get(code);
  if (!marker) return;
  marker.remove();
  signalrLiveMarkers.delete(code);
}

/**
 * Hub boats → marker map.
 * Map Survey (vẽ tuyến): KHÔNG hiện tàu live — chỉ collector khi đang ghi GPS.
 * Tàu live xem trang Live GPS.
 */
function applyHubBoatsFromSnapshot(_hubBoats, _data = latest) {
  clearAllSignalRBoatMarkers();
}

function clearAllSignalRBoatMarkers() {
  for (const code of [...signalrLiveMarkers.keys()]) {
    removeSignalRBoatMarker(code);
  }
}

function upsertSignalRBoatLocation(_payload) {
  // Không vẽ tàu live trên map Survey.
  return;
}

/** Tàu đang chạy (live GPS) hoặc đang sự cố/bảo trì → không cho đi dò (survey). */
function activeTripForSurveyBoat(boatCode, data = latest) {
  const code = String(boatCode || '').trim();
  if (!code) return null;
  const list = Array.isArray(data?.tripMissions) ? data.tripMissions : [];
  return list.find((row) => {
    if (String(row?.boatCode || '').trim() !== code) return false;
    return ['Pending', 'ToDeparture', 'Boarding', 'Running', 'WaitingAtStop', 'Paused']
      .includes(String(row?.status || ''));
  }) || null;
}

function boatSurveyBlockReason(boatCode, data = latest) {
  const code = String(boatCode || '').trim();
  if (!code) return '';

  const trip = activeTripForSurveyBoat(code, data);
  if (trip) return `đang trip (${trip.status}) · không vẽ / không đi dò`;

  const open = (data?.openIncidents || []).find((row) => String(row.boatCode || '').trim() === code);
  if (open) return `đang sự cố · không đi dò`;

  const boat = findBoatByCode(code, data);
  if (Array.isArray(data?.boats) && data.boats.length > 0 && !boat) {
    return `chưa có trong danh sách tàu · chờ đồng bộ`;
  }
  const status = String(boat?.beStatus || boat?.effectiveStatus || boat?.dbStatus || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  if (status === 'undermaintenance') return `đang bảo trì · không đi dò`;
  if (status === 'incident') return `đang sự cố · không đi dò`;

  const hub = (data?.hubBoats || []).find((row) => String(row.boatCode || '').trim() === code);
  if (hub && hub.isOnline !== false) {
    const speed = Number(hub.speedKmh);
    const moving = (Number.isFinite(speed) && speed >= 1)
      || String(hub.status || '').toLowerCase() === 'moving'
      || String(hub.boatStatus || '').toLowerCase() === 'moving';
    // Online trên hub = đang live GPS; tốc độ > 0 hoặc status moving = đang chạy.
    if (moving || hub.isOnline === true) {
      // Chỉ chặn khi đang chạy thật / ping gần đây; idle đứng yên vẫn có thể đi dò nếu không sự cố.
      if (moving) return `đang chạy live · không đi dò`;
    }
  }

  const collectorCode = String(data?.collector?.boatCode || '').trim();
  const collectorBusy = data?.collector
    && ['running', 'paused', 'moving'].includes(String(data.collector.status || ''));
  if (collectorBusy && collectorCode === code) {
    return `đang ghi GPS · không đổi tàu`;
  }

  return '';
}

function surveyDrawBlocked(data = latest) {
  const code = String(collectorBoatCodeEl?.value || selectedCollectorBoatCode || '').trim();
  if (!code) return '';
  return boatSurveyBlockReason(code, data);
}

function isBoatAvailableForSurvey(boatCode, data = latest) {
  return !boatSurveyBlockReason(boatCode, data);
}

function setDrawTool(tool) {
  if (tool === 'draw') {
    const block = surveyDrawBlocked();
    if (block) {
      captureState.enabled = false;
      toolPanEl?.classList.toggle('is-active', true);
      toolDrawEl?.classList.toggle('is-active', false);
      map.getContainer().style.cursor = '';
      captureStatusEl.textContent = `Không vẽ: ${block}`;
      notifyWarn(`Không vẽ: ${block}`);
renderCaptureState();
      return;
    }
  }
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
  // Giữ hình đã vẽ: chỉ gắn nhãn bến cuối nếu điểm cuối đã gần bến.
  // Không nối thẳng thêm tới tâm bến (tránh phá path / tàu chạy lệch đường vẽ).
  const endStation = getSelectedEndStation();
  const last = captureState.points.at(-1);
  if (endStation && last && last.source !== 'station-end') {
    const near = haversineMeters(last, endStation) <= 60;
    if (near || String(last.stationId || '') === String(endStation.stationId)) {
      last.source = 'station-end';
      last.stationId = endStation.stationId;
      last.label = endStation.stationName;
    }
  }
  captureState.finished = true;
  setDrawTool('pan');
  clearCompletedRouteLine();
  const type = getSurveyRouteType();
  const stopCount = buildSurveyStops().length;
  // Luôn giữ đúng đường đang vẽ — không ép sang corridor sông.
  riverPathOverride = null;
  captureStatusEl.textContent = `Đã xong (${stopCount} bến, loại ${type}). Giữ đúng đường bạn vẽ — bấm ghi GPS để chạy.`;
  updateWorkflow('run');
  updateRouteTypeHint();
  checkRouteCodeDuplicate();
  rebuildCaptureMarkers();
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
  const block = surveyDrawBlocked();
  if (block) {
    setDrawTool('pan');
    captureStatusEl.textContent = `Không vẽ: ${block}`;
    return;
  }
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
  // Chỉ vẽ tàu DB/simulator nếu không trùng mã đang live GPS / đang ghi.
  const liveCodes = activeLiveBoatCodes(data);
  const dbBoats = SHOW_LIVE_BOATS
    ? (data.boats || []).filter((boat) => !liveCodes.has(String(boat.boatCode || '').trim()))
    : [];
  renderBoats(dbBoats);
  applyHubBoatsFromSnapshot(data.hubBoats, data);
  connectSignalRIfConfigured(data.config);
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

/** Charter đang mở → CharterReference; không thì suy từ bến đầu/cuối. */
function getSurveyRouteType() {
  const startId = startStationEl?.value || captureState.points[0]?.stationId || '';
  const endPoint = [...captureState.points].reverse().find((p) => p.source === 'station-end');
  const endId = endStationEl?.value || endPoint?.stationId || '';
  // Loop cùng bến → không gắn charter (tránh auto-complete nhầm với LOOP-*).
  if (startId && endId && String(startId) === String(endId)) return 'SightseeingLoop';
  // Chỉ coi là charter khi đang vẽ đúng 1 chặng CB (2 bến).
  if (activeCharterRequest?.requestId && activeCharterLeg?.from && activeCharterLeg?.to) {
    return 'CharterReference';
  }
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
  let ordered = collectOrderedStopsFromClicks();
  if (activeCharterLeg) {
    // Charter: mỗi lần lưu chỉ gửi đúng 2 bến của chặng đang vẽ (1→2).
    ordered = charterLegStops(activeCharterLeg);
  } else if (activeCharterRequest?.requestId) {
    // Có CB mở nhưng chưa gắn chặng → vẫn chỉ lấy 2 bến form, không lấy cả chuỗi CB.
    const startId = startStationEl?.value || captureState.points[0]?.stationId || '';
    const endId = endStationEl?.value
      || [...captureState.points].reverse().find((p) => p.source === 'station-end')?.stationId
      || '';
    if (startId && endId && String(startId) !== String(endId)) {
      const a = findStationInCatalog(startId) || { stationId: startId };
      const b = findStationInCatalog(endId) || { stationId: endId };
      ordered = charterLegStops({ from: a, to: b });
    }
  }
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
    cruiseTravelMin: stop.cruiseTravelMin,
    berthBufferMin: stop.berthBufferMin,
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
  const buffer = getBerthBufferMinutes();
  if (!list.length) return [];
  if (list.length === 1 || path.length < 2) {
    return list.map((stop) => ({
      ...stop,
      standardTravelMin: null,
      cruiseTravelMin: null,
      berthBufferMin: null,
      segmentDistanceKm: null,
      travelSource: null,
    }));
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
    if (index === 0) {
      return {
        ...stop,
        standardTravelMin: null,
        cruiseTravelMin: null,
        berthBufferMin: null,
        segmentDistanceKm: null,
        travelSource: null,
      };
    }
    const prev = probes[index - 1];
    const cur = probes[index];
    if (prev.distToPath > STOP_DETECT_RADIUS_M || cur.distToPath > STOP_DETECT_RADIUS_M) {
      return {
        ...stop,
        standardTravelMin: null,
        cruiseTravelMin: null,
        berthBufferMin: null,
        segmentDistanceKm: null,
        travelSource: null,
      };
    }
    const meters = cur.alongMeters - prev.alongMeters;
    if (!(meters > 5)) {
      return {
        ...stop,
        standardTravelMin: null,
        cruiseTravelMin: null,
        berthBufferMin: null,
        segmentDistanceKm: null,
        travelSource: null,
      };
    }
    const km = meters / 1000;
    const cruise = Number(((km / speed) * 60).toFixed(2));
    const display = Number((cruise + buffer).toFixed(2));
    return {
      ...stop,
      cruiseTravelMin: cruise > 0 ? cruise : null,
      berthBufferMin: cruise > 0 ? buffer : null,
      // Gửi BE/Charter: phút hiện = chạy + đệm admin.
      standardTravelMin: display > 0 ? display : null,
      segmentDistanceKm: roundNumber(km, 3),
      travelSource: 'gps',
    };
  });
}

function updateRouteTypeHint() {
  const type = getSurveyRouteType();
  const ordered = activeCharterRequest?.stops?.length
    ? charterStopsAsOrdered(activeCharterRequest.stops)
    : collectOrderedStopsFromClicks();
  const viaCount = Math.max(0, ordered.length - 2);
  const isLoop = type === 'SightseeingLoop';
  if (routeTypeHintEl) {
    if (type === 'CharterReference') {
      const code = activeCharterRequest?.bookingCode || activeCharterRequest?.bookingId || '';
      routeTypeHintEl.textContent = code
        ? `Charter · booking ${code} · ${ordered.length} bến theo yêu cầu · CharterReference (isBookable=false).`
        : `CharterReference · ${ordered.length} bến · isBookable=false.`;
      routeTypeHintEl.classList.add('is-ok');
      routeTypeHintEl.classList.remove('is-error');
    } else if (ordered.length >= 2) {
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
  // Charter: hiện từng chặng (matched + missing) trên 1 dòng riêng.
  // Nếu đang vẽ 1 chặng (activeCharterLeg) → chỉ hiện chặng đó (kèm context matched trước đó).
  if (activeCharterRequest?.requestId) {
    const match = activeCharterRequest._savedMatch;
    if (!match) {
      stopChainPreviewEl.innerHTML = '<span class="stop-seg is-missing">Đang tải…</span>';
      stopChainPreviewEl.classList.remove('is-empty');
      return;
    }
    // Đang vẽ 1 chặng: chỉ hiện context (các chặng đã khớp) + chặng đang vẽ + (tuỳ chọn) chặng tới.
    if (activeCharterLeg?.from && activeCharterLeg?.to) {
      const queue = activeCharterRequest._legQueue || [];
      const curIdx = activeCharterRequest._legIndex || 0;
      const allLegs = [
        ...(match.matchedLegs || []).map((l) => ({ ...l, _state: 'ok' })),
        ...(match.missingLegs || []).map((l, i) => ({ ...l, _state: curIdx === i ? 'drawing' : 'miss' })),
      ].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const head = allLegs.slice(0, curIdx + 1);
      if (!head.length) {
        stopChainPreviewEl.innerHTML = '<span class="stop-seg is-missing">Chưa có chặng nào</span>';
        stopChainPreviewEl.classList.add('is-empty');
        return;
      }
      const tail = queue.length - curIdx - 1;
      stopChainPreviewEl.innerHTML = head.map((leg, i) => {
        const from = leg.from.stationCode || leg.from.stationName || leg.from.stationId || '?';
        const to = leg.to.stationCode || leg.to.stationName || leg.to.stationId || '?';
        const isCur = i === head.length - 1;
        if (leg._state === 'ok') {
          return `<span class="stop-seg"><b>${escapeHtml(from)}</b> → <b>${escapeHtml(to)}</b> <span class="route-tag">(${escapeHtml(leg.routeCode || 'khớp')})</span></span>`;
        }
        if (isCur) {
          return `<span class="stop-seg is-drawing"><b>${escapeHtml(from)}</b> → <b>${escapeHtml(to)}</b> <span class="route-tag is-drawing">→ đang vẽ</span></span>`;
        }
        return `<span class="stop-seg is-missing"><b>${escapeHtml(from)}</b> → <b>${escapeHtml(to)}</b> <span class="route-tag is-miss">(cần vẽ)</span></span>`;
      }).join('<br>') +
        (tail > 0 ? `<br><span class="stop-seg is-muted">… còn ${tail} chặng nữa</span>` : '');
      stopChainPreviewEl.classList.remove('is-empty');
      return;
    }
    // Chưa vẽ (chỉ preview tổng): hiện tất cả.
    const allLegs = [
      ...(match.matchedLegs || []).map((l) => ({ ...l, _state: 'ok' })),
      ...(match.missingLegs || []).map((l) => ({ ...l, _state: 'miss' })),
    ].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (!allLegs.length) {
      stopChainPreviewEl.innerHTML = '<span class="stop-seg is-missing">Chưa có chặng nào</span>';
      stopChainPreviewEl.classList.add('is-empty');
      return;
    }
    stopChainPreviewEl.innerHTML = allLegs.map((leg) => {
      const from = leg.from.stationCode || leg.from.stationName || leg.from.stationId || '?';
      const to = leg.to.stationCode || leg.to.stationName || leg.to.stationId || '?';
      const badge = leg._state === 'ok'
        ? `<span class="stop-seg"><b>${escapeHtml(from)}</b> → <b>${escapeHtml(to)}</b> <span class="route-tag">(${escapeHtml(leg.routeCode || 'khớp')})</span></span>`
        : `<span class="stop-seg is-missing"><b>${escapeHtml(from)}</b> → <b>${escapeHtml(to)}</b> <span class="route-tag is-miss">(cần vẽ)</span></span>`;
      return badge;
    }).join('<br>');
    stopChainPreviewEl.classList.remove('is-empty');
    return;
  }
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
      const cruise = stop.cruiseTravelMin;
      const buf = Number(stop.berthBufferMin) || 0;
      const src = stop.travelSource === 'schedule' ? ' lịch' : (stop.travelSource === 'gps' ? ' GPS' : '');
      const min = stop.standardTravelMin != null
        ? (buf > 0 && cruise != null
          ? `${stop.standardTravelMin} phút (${cruise}+${buf} đệm)`
          : `${stop.standardTravelMin} phút${src}`)
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
  const pathMinutes = getSurveyPathEstimatedMinutes();
  const fields = {
    startStationId: startStationEl.value || captureState.points[0]?.stationId || null,
    endStationId: endStationEl.value || [...captureState.points].reverse().find((p) => p.source === 'station-end')?.stationId || null,
    stops: buildSurveyStops(),
    berthBufferMin: getBerthBufferMinutes(),
    // Phút hiện = chạy thuần + đệm cập bến (admin).
    estimatedDurationMin: pathMinutes > 0 ? Number(pathMinutes.toFixed(2)) : null,
  };
  const inferredType = getSurveyRouteType();
  if (inferredType === 'CharterReference' && activeCharterRequest?.requestId) {
    fields.routeType = 'CharterReference';
    fields.isBookable = false;
    fields.charterRequestId = activeCharterRequest.requestId;
    fields.bookingId = activeCharterRequest.bookingId || null;
    fields.createReverseRoute = false;
    if (activeCharterLeg) {
      fields.startStationId = activeCharterLeg.from.stationId;
      fields.endStationId = activeCharterLeg.to.stationId;
      fields.charterLegLabel = activeCharterLeg.label || null;
      // Tên/mã theo đúng 2 bến chặng — không dùng cả CB (BD→BS).
      const a = activeCharterLeg.from.stationCode || activeCharterLeg.from.stationName;
      const b = activeCharterLeg.to.stationCode || activeCharterLeg.to.stationName;
      if (a && b) fields.routeNameHint = `${a} - ${b}`;
    }
    // Chỉ complete khi charter đúng 2 bến. Nhiều chặng: lưu từng cặp, không compose FULL.
    fields.charterFinalLeg = isFinalCharterLeg()
      && charterStopsAsOrdered(activeCharterRequest.stops || []).length <= 2;
    return fields;
  }
  const wantReverse = Boolean(createReverseRouteEl?.checked)
    && inferredType !== 'SightseeingLoop'
    && (fields.stops?.length || 0) >= 2;
  if (wantReverse) {
    fields.createReverseRoute = true;
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
  const isCharter = type === 'CharterReference';
  if ((isLoop || isCharter) && createReverseRouteEl) {
    createReverseRouteEl.checked = false;
    createReverseRouteEl.disabled = true;
  } else if (createReverseRouteEl) {
    createReverseRouteEl.disabled = false;
  }
  const show = Boolean(createReverseRouteEl?.checked) && !isLoop && !isCharter;
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
  captureStatusEl.textContent = `Điểm 1: ${station.stationName}. Chọn bến kết thúc để bám vạch sông, hoặc vẽ tay rồi đóng vòng.`;
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
  if (isLoop) {
    riverPathOverride = null;
    captureStatusEl.textContent = `Đã nối đóng vòng sightseeing về ${endStation.stationName} (cùng bến đầu).`;
    renderCaptureState();
    return;
  }
  riverPathOverride = null;
  captureStatusEl.textContent = `Đã nối tới ${endStation.stationName} — giữ đường bạn vẽ.`;
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
  // Vẽ tay thêm điểm → bỏ override sông (user đang chỉnh path).
  if (meta.source === 'manual') riverPathOverride = null;
  const point = {
    lat: roundNumber(latlng.lat, 9),
    lng: roundNumber(latlng.lng, 9),
    source: meta.source || 'manual',
    label: meta.label || null,
    stationId: meta.stationId || null,
    accuracy: meta.accuracy || null,
    attached: Boolean(meta.attached),
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
  // Khi đang chạy: đúng path đã khóa (path GPS).
  if (Array.isArray(lockedSurveyPath) && lockedSurveyPath.length >= 2) {
    return lockedSurveyPath.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
  }
  // WYSIWYG: đúng polyline đang vẽ (không densify — densify làm lệch cảm giác “giữa đường”).
  const expanded = expandPath(captureState.points);
  if (expanded.length >= 2) {
    return expanded.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
  }
  return captureState.points.map(({ lat, lng }) => ({ lat: Number(lat), lng: Number(lng) }));
}

/** Chiếu điểm lên polyline đã vẽ — marker luôn nằm trên đường. */
function projectOntoPath(path, point) {
  const pts = (path || [])
    .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || pts.length < 1) {
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }
  if (pts.length === 1) return { ...pts[0] };
  let best = null;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const abx = b.lng - a.lng;
    const aby = b.lat - a.lat;
    const apx = lng - a.lng;
    const apy = lat - a.lat;
    const denom = abx * abx + aby * aby;
    const t = denom > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / denom)) : 0;
    const plat = a.lat + (b.lat - a.lat) * t;
    const plng = a.lng + (b.lng - a.lng) * t;
    const d = haversineMeters({ lat, lng }, { lat: plat, lng: plng });
    if (!best || d < best.d) best = { lat: plat, lng: plng, d };
  }
  return best ? { lat: best.lat, lng: best.lng } : { lat, lng };
}

async function fetchRiverPath(from, to) {
  const response = await fetch('/api/river-path', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: { lat: Number(from.lat), lng: Number(from.lng) },
      to: { lat: Number(to.lat), lng: Number(to.lng) },
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `river-path ${response.status}`);
  }
  const coords = Array.isArray(body.coordinates) ? body.coordinates : [];
  return coords
    .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

/** Snap A→B lên vạch sông; vòng sightseeing giữ đường vẽ tay. */
async function ensureRiverPathForRun({ quiet = false } = {}) {
  const start = captureState.points[0];
  const end = captureState.points.at(-1);
  if (!start || !end) return false;
  const sameStation = Boolean(
    start.stationId
    && end.stationId
    && String(start.stationId) === String(end.stationId),
  );
  const nearLoop = haversineMeters(start, end) < 80;
  if (sameStation || nearLoop) {
    riverPathOverride = null;
    return false;
  }
  try {
    const coords = await fetchRiverPath(start, end);
    if (coords.length < 2) return false;
    riverPathOverride = coords;
    renderCaptureLine();
    if (!quiet) {
      captureStatusEl.textContent = `Đã bám hành lang sông (${coords.length} điểm). Tàu sẽ chạy đúng vạch Waterbus.`;
    }
    return true;
  } catch (error) {
    console.warn('[river-path]', error.message);
    if (!quiet) notifyWarn(`Không snap được lên sông: ${error.message}`);
    return false;
  }
}

function renderRiverCorridorGuide() {
  if (riverCorridorLine) {
    riverCorridorLine.remove();
    riverCorridorLine = null;
  }
}

function renderCaptureLine() {
  if (captureLine) {
    captureLine.remove();
    captureLine = null;
  }
  if (captureAttachedLine) {
    captureAttachedLine.remove();
    captureAttachedLine = null;
  }
  if (helperCurveLine) {
    helperCurveLine.remove();
    helperCurveLine = null;
  }
  // Đang chạy / đã khóa: chỉ 1 đường = path GPS (lockedSurveyPath).
  const running = hideCaptureWaypointsForRun();
  let path;
  if (running && Array.isArray(lockedSurveyPath) && lockedSurveyPath.length >= 2) {
    path = lockedSurveyPath;
  } else if (Array.isArray(riverPathOverride) && riverPathOverride.length >= 2) {
    path = riverPathOverride;
  } else {
    path = expandPath(captureState.points);
  }
  if (!path || path.length < 2) return;

  const attachedN = Math.max(0, Math.min(
    Number(captureState.attachedCount) || 0,
    captureState.points.length,
  ));
  const showAttachedSplit = !running && !riverPathOverride && attachedN >= 2;

  if (showAttachedSplit) {
    const attachedPts = captureState.points.slice(0, attachedN);
    const attachedPath = expandPath(attachedPts);
    if (attachedPath.length >= 2) {
      captureAttachedLine = L.polyline(
        attachedPath.map((p) => [p.lat, p.lng]),
        {
          ...ATTACHED_ROUTE_STYLE,
          interactive: false,
          smoothFactor: 0,
        },
      ).addTo(map);
    }
    // Phần đang vẽ tiếp (có chồng 1 điểm nối).
    if (captureState.points.length > attachedN) {
      const restPts = captureState.points.slice(Math.max(0, attachedN - 1));
      const restPath = expandPath(restPts);
      if (restPath.length >= 2) {
        const isDone = captureState.finished;
        captureLine = L.polyline(
          restPath.map((p) => [p.lat, p.lng]),
          {
            ...(isDone ? SURVEY_ROUTE_STYLE : DRAFT_ROUTE_STYLE),
            weight: isDone ? 6 : 4.5,
            interactive: false,
            smoothFactor: 0,
          },
        );
        if (!isDone || showSavedRoutes) captureLine.addTo(map);
      }
    }
  } else {
    const isDone = captureState.finished || running;
    const style = isDone
      ? { ...SURVEY_ROUTE_STYLE }
      : { ...DRAFT_ROUTE_STYLE };
    captureLine = L.polyline(
      path.map((p) => [p.lat, p.lng]),
      {
        ...style,
        weight: isDone ? 6 : 4.5,
        interactive: false,
        smoothFactor: 0,
      },
    );
    if (!isDone || showSavedRoutes) captureLine.addTo(map);
  }

  const idx = captureState.selectedSegmentIndex;
  if (!running && !riverPathOverride && idx > 0 && captureState.points[idx]?.segmentType === 'curve') {
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

function hideCaptureWaypointsForRun() {
  // Khi chạy / đã khóa đường: chỉ còn polyline, không còn điểm số.
  return Boolean(recordingActive || lockedSurveyPath);
}

function rebuildCaptureMarkers() {
  for (const marker of captureMarkers) marker.remove();
  captureMarkers.length = 0;
  clearControlMarkers();

  if (hideCaptureWaypointsForRun()) {
    renderCaptureLine();
    renderCaptureState();
    return;
  }

  const last = captureState.points.length - 1;
  const attachedN = Math.max(0, Number(captureState.attachedCount) || 0);
  captureState.points.forEach((point, index) => {
    // Đã hoàn thành vẽ: chỉ giữ bến đầu/cuối dạng cờ, ẩn điểm trung gian.
    const isStation = point.source === 'station'
      || point.source === 'station-via'
      || point.source === 'station-end';
    // Đoạn đã gắn từ tuyến có sẵn: không hiện chấm số đen (trông như lỗi).
    if (point.attached || point.source === 'attached' || (attachedN > 0 && index < attachedN && !isStation)) {
      return;
    }
    if (captureState.finished && !isStation && index !== 0 && index !== last) return;

    const selected = captureState.selectedWaypointIndex === index;
    const marker = L.marker([point.lat, point.lng], {
      icon: capturePointIcon(index + 1, point.source, selected),
      draggable: !captureState.finished || isStation || index === 0 || index === last,
      zIndexOffset: 600,
      autoPan: true,
    }).addTo(map);
    if (point.label) marker.bindTooltip(point.label, { direction: 'top', offset: [0, -10] });
    bindCaptureMarkerEvents(marker, index);
    captureMarkers.push(marker);
  });
  renderCaptureLine();
  if (!captureState.finished) syncControlMarkers();
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
  captureState.attachedCount = 0;
  if (captureAttachedLine) {
    captureAttachedLine.remove();
    captureAttachedLine = null;
  }
  captureState.selectedSegmentIndex = null;
  captureState.selectedWaypointIndex = null;
  riverPathOverride = null;
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
  const tripBlock = surveyDrawBlocked();
  if (tripBlock && captureState.enabled) {
    captureState.enabled = false;
    map.getContainer().style.cursor = '';
    toolDrawEl?.classList.remove('is-active');
    toolPanEl?.classList.add('is-active');
  }
  if (toggleCaptureEl) {
    toggleCaptureEl.textContent = captureState.enabled ? 'Đang vẽ...' : 'Bắt đầu';
    toggleCaptureEl.disabled = Boolean(tripBlock) || recordingActive;
  }
  if (toolDrawEl) toolDrawEl.disabled = Boolean(tripBlock) || recordingActive;
  if (finishDrawEl) {
    finishDrawEl.disabled = captureState.points.length < 2 || captureState.finished || Boolean(tripBlock);
  }
  if (undoCapturePointEl) undoCapturePointEl.disabled = !captureState.points.length || Boolean(tripBlock);
  if (clearCaptureEl) clearCaptureEl.disabled = !captureState.points.length;
  if (saveCapturedRouteEl) saveCapturedRouteEl.disabled = captureState.points.length < 2;
  if (toolUndoEl) toolUndoEl.disabled = !captureState.points.length || Boolean(tripBlock);
  const canClear = captureState.points.length > 0
    || Boolean(lockedSurveyPath)
    || Boolean(plannedRouteLine)
    || Boolean(completedRouteLine)
    || Boolean(selectedRouteId);
  if (toolClearEl) toolClearEl.disabled = !canClear;
  if (startCollectorEl && !recordingActive) {
    const code = String(collectorBoatCodeEl?.value || '').trim();
    const block = code ? boatSurveyBlockReason(code) : 'chưa chọn tàu';
    startCollectorEl.disabled = Boolean(block) || captureState.points.length < 2;
    if (block && code) startCollectorEl.title = block;
    else startCollectorEl.title = '';
  }
  updateDrawStats();
  // Lưu bản vẽ theo đúng tàu đang chọn (đổi tàu = đổi route của tàu đó).
  if (!recordingActive && !lockedSurveyPath && selectedCollectorBoatCode) {
    saveActiveBoatDraft(selectedCollectorBoatCode);
  }
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
  // Turf.js WGS84 dọc polyline WYSIWYG (thẳng + cong đã expand).
  const path = expandPath(Array.isArray(points) ? points : []);
  if (typeof GeoDistance !== 'undefined') return GeoDistance.pathLengthMeters(path);
  if (path.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < path.length; i += 1) total += haversineMeters(path[i - 1], path[i]);
  return total;
}

function haversineMeters(a, b) {
  if (typeof GeoDistance !== 'undefined') return GeoDistance.distanceMeters(a, b);
  const toRad = (value) => (Number(value) * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLng = toRad(Number(b.lng) - Number(a.lng));
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function estimateTravelMinutes(meters, speedKmh) {
  const boat = findBoatByCode(collectorBoatCodeEl?.value);
  const max = boat ? boatMaxSpeedKmh(boat) : 80;
  const speed = clampNumber(Number(speedKmh) || 16, 0.1, max);
  const km = Number(meters) / 1000;
  if (!(km > 0) || !(speed > 0)) return 0;
  // phút chạy thuần = (km / vận_tốc_kmh) × 60
  return (km / speed) * 60;
}

function getBerthBufferMinutes() {
  const raw = Number(berthBufferMinEl?.value);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(60, Math.round(raw * 10) / 10);
}

function persistBerthBufferMin() {
  try {
    localStorage.setItem('surveyBerthBufferMin', String(getBerthBufferMinutes()));
  } catch {
    /* ignore */
  }
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

/** Thời gian gửi BE = chạy thuần + đệm cập bến (mỗi chặng đã cộng trong stops; tổng path cộng 1 lần đệm × số chặng). */
function getSurveyPathEstimatedMinutes(points = null) {
  const ordered = collectOrderedStopsFromClicks();
  if (ordered.length >= 2) {
    const withTravel = attachSegmentTravelMinutesFe(
      Array.isArray(points) && points.length >= 2 ? points : getPathCoordinates(),
      ordered,
      getSurveySpeedKmh(),
    );
    const sum = withTravel.reduce((acc, stop) => acc + (Number(stop.standardTravelMin) || 0), 0);
    if (sum > 0) return sum;
  }
  const path = Array.isArray(points) && points.length >= 2
    ? points
    : (lockedSurveyPath?.length >= 2 ? lockedSurveyPath : getPathCoordinates());
  const cruise = estimateTravelMinutes(pathLengthMeters(path), getSurveySpeedKmh());
  const segments = Math.max(1, ordered.length - 1);
  return cruise + getBerthBufferMinutes() * segments;
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
    const code = boat?.boatCode || '';
    const registered = latest?.config?.gpsDevices?.[code];
    const surveyDev = latest?.config?.surveyDeviceId || 'gps-wb-001';
    boatSpeedHintEl.textContent = boat
      ? (registered
        ? `Tàu ${code} · đã đăng ký device ${registered} · max ${max} km/h`
        : `Tàu ${code} · CHƯA đăng ký gps_devices — tạm dùng ${surveyDev}`)
      : 'Chọn tàu đã đăng ký trong gps_devices (vd WB_005 → gps-wb-005)';
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
    const block = boatSurveyBlockReason(boat.boatCode);
    const tag = block ? ` · ${block}` : ` · max ${max} km/h`;
    return {
      code: boat.boatCode,
      label: `${boat.boatCode}${name}${tag}`,
    };
  });
  const previousInCatalog = options.some((item) => item.code === previous);
  if (previous && !previousInCatalog) {
    options.unshift({
      code: previous,
      label: `${previous} · chưa có trong snapshot · chờ đồng bộ`,
    });
  }
  const restoreInitialDraft = !collectorBoatOptionsInitialized && (options.length > 0 || Boolean(previous));
  if (options.length > 0 || previous) collectorBoatOptionsInitialized = true;
  collectorBoatCodeEl.innerHTML = [
    '<option value="">Chọn tàu...</option>',
    ...options.map((item) => (
      `<option value="${escapeHtml(item.code)}">${escapeHtml(item.label)}</option>`
    )),
  ].join('');

  const stillInList = options.some((item) => item.code === previous);
  const preferred = stillInList ? previous : '';

  // Snapshot có thể tạm thiếu một tàu; giữ mã + draft để lần chọn tiếp theo không ghi đè nhầm tàu.
  if (preferred) {
    selectedCollectorBoatCode = preferred;
    localStorage.setItem('surveyBoatCode', preferred);
  }
  collectorBoatCodeEl.value = preferred || '';
  // Draft chỉ được khôi phục lúc catalog tải lần đầu; refresh trạng thái không được ghi đè form đang sửa.
  if (restoreInitialDraft && preferred && !captureState.points.length && boatDrafts[preferred]) {
    applyBoatDraft(boatDrafts[preferred]);
  }
  applyBoatSpeedLimits();
  renderCaptureState();
}

function collectorBoatOptionsSignature(boats) {
  return (boats || [])
    .map((boat) => `${boat.boatId}:${boat.boatCode}:${boat.boatName || ''}:${boat.maxSpeedKmh}:${boatSurveyBlockReason(boat.boatCode)}`)
    .join('|');
}

function isCollectorBoatSelectInteracting() {
  return collectorBoatSelectInteracting;
}

function beginCollectorBoatInteraction() {
  collectorBoatSelectInteracting = true;
  if (collectorBoatOptionsFlushTimer) {
    clearTimeout(collectorBoatOptionsFlushTimer);
    collectorBoatOptionsFlushTimer = null;
  }
}

function endCollectorBoatInteraction() {
  collectorBoatSelectInteracting = false;
  if (collectorBoatOptionsFlushTimer) clearTimeout(collectorBoatOptionsFlushTimer);
  // Chờ event change hoàn tất rồi mới thay option DOM; force vì select thường vẫn còn focus.
  collectorBoatOptionsFlushTimer = setTimeout(() => {
    collectorBoatOptionsFlushTimer = null;
    flushCollectorBoatOptions({ force: true });
  }, 0);
}

function flushCollectorBoatOptions({ force = false } = {}) {
  if (!collectorBoatOptionsPending || (!force && isCollectorBoatSelectInteracting()) || !latest) return;
  const boats = catalogBoats(latest);
  const signature = collectorBoatOptionsSignature(boats);
  collectorBoatOptionsPending = false;
  if (signature === lastBoatIds) return;
  lastBoatIds = signature;
  renderCollectorBoatOptions(boats);
}

function updateDrawStats() {
  const meters = pathLengthMeters(captureState.points);
  const speed = getSurveySpeedKmh();
  const boat = findBoatByCode(collectorBoatCodeEl?.value);
  const max = boat ? boatMaxSpeedKmh(boat) : null;
  const km = meters / 1000;
  const cruiseExact = estimateTravelMinutes(meters, speed);
  const buffer = getBerthBufferMinutes();
  const ordered = collectOrderedStopsFromClicks();
  const segmentCount = Math.max(ordered.length >= 2 ? ordered.length - 1 : (meters > 0 ? 1 : 0), 0);
  const totalBuffer = buffer * segmentCount;
  const totalExact = getSurveyPathEstimatedMinutes();
  const kmText = meters < 1000
    ? `${Math.round(meters)} m`
    : `${km.toFixed(3)} km`;
  if (drawDistanceEl) drawDistanceEl.textContent = kmText;
  if (drawDurationEl) {
    drawDurationEl.textContent = meters > 0
      ? `${totalExact.toFixed(2)} phút`
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
  if (estimateCruiseMinEl) {
    estimateCruiseMinEl.textContent = meters > 0
      ? `${cruiseExact.toFixed(2)} phút`
      : '0 phút';
  }
  if (estimateBufferMinEl) {
    estimateBufferMinEl.textContent = totalBuffer > 0
      ? `${totalBuffer.toFixed(1)} phút (${buffer}×${segmentCount} chặng)`
      : '0 phút';
  }
  if (estimateMinEl) {
    estimateMinEl.textContent = meters > 0
      ? `${totalExact.toFixed(2)} phút`
      : '0 phút';
  }
  const formulaEl = document.querySelector('#estimateFormula');
  if (formulaEl) {
    formulaEl.textContent = meters > 0
      ? `(${km.toFixed(3)} km ÷ ${speed} km/h)×60 = ${cruiseExact.toFixed(2)}p chạy + ${totalBuffer.toFixed(1)}p đệm = ${totalExact.toFixed(2)}p`
      : 'phút gửi BE = chạy thuần + đệm cập bến (admin chỉnh)';
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

function buildSimpleTwoStationPath() {
  const start = getSelectedStation();
  const end = getSelectedEndStation();
  if (!start || !end) return false;
  clearCapturePoints();
  clearCompletedRouteLine();
  addCapturePoint({ lat: Number(start.lat), lng: Number(start.lng) }, {
    source: 'station',
    label: start.stationName,
    stationId: start.stationId,
  });
  addCapturePoint({ lat: Number(end.lat), lng: Number(end.lng) }, {
    source: 'station-end',
    label: end.stationName,
    stationId: end.stationId,
  });
  captureState.finished = true;
  captureState.enabled = false;
  maybeFillRouteCode();
  updateRouteTypeHint();
  renderCaptureLine();
  rebuildCaptureMarkers();
  return true;
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
    captureStatusEl.textContent = 'Chọn tàu GPS (WB_001…WB_005) trước khi ghi.';
    collectorBoatCodeEl?.focus();
    return;
  }
  const busyReason = boatSurveyBlockReason(collectorBoatCodeEl.value.trim());
  if (busyReason) {
    captureStatusEl.textContent = `Tàu ${collectorBoatCodeEl.value.trim()} ${busyReason}.`;
    notifyWarn(`Không đi dò: ${collectorBoatCodeEl.value.trim()} ${busyReason}`);
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

  // Giữ đường đã vẽ. Chỉ tự tạo path 2 điểm khi chưa vẽ gì và bến đầu ≠ bến cuối.
  // Loop (cùng 1 bến): bắt buộc đã vẽ đường vòng — không thay bằng 2 điểm trùng tọa độ (Azure từ chối).
  const startStation = getSelectedStation();
  const endStation = getSelectedEndStation();
  const isSightseeingLoop = Boolean(
    startStation
    && endStation
    && String(startStation.stationId) === String(endStation.stationId),
  );
  if (captureState.points.length < 2) {
    if (startStation && endStation && !isSightseeingLoop) {
      buildSimpleTwoStationPath();
    } else if (isSightseeingLoop) {
      captureStatusEl.textContent = 'Vòng sightseeing: vẽ đường vòng rồi click lại bến đầu để đóng, sau đó mới ghi GPS.';
      notifyWarn('Loop cần đường vẽ (≥ 2 điểm khác nhau), không chỉ cùng 1 bến.');
      return;
    } else {
      if (startStation && !captureState.points.length) seedFromStation();
      if (endStation) seedToEndStation();
      if (captureState.points.length < 2) {
        captureStatusEl.textContent = 'Chọn bến xuất phát + bến kết thúc (2 điểm).';
        return;
      }
    }
  }
  if (!captureState.finished) finishDraw();
  if (!ensureEndStationFromPath({ quiet: true }) && !endStationEl?.value) {
    captureStatusEl.textContent = 'Cần bến kết thúc để tàu dừng đúng bến.';
    return;
  }

  // Luôn chạy đúng đường đang vẽ (không ép corridor sông).
  riverPathOverride = null;

  const plannedCheck = getPathCoordinates();
  const uniquePts = new Set(
    plannedCheck.map((p) => `${Number(p.lat).toFixed(6)},${Number(p.lng).toFixed(6)}`),
  );
  if (plannedCheck.length < 2 || uniquePts.size < 2) {
    captureStatusEl.textContent = 'Cần ít nhất 2 điểm GPS khác nhau trên đường vẽ (Azure không nhận path trùng tọa độ).';
    notifyWarn('Đường vẽ chưa đủ 2 điểm khác nhau — vẽ thêm rồi thử lại.');
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
  lockedSurveyPath = plannedCoords.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
  recordingActive = true;
  recordingStartedAt = Date.now();
  rebuildCaptureMarkers(); // ẩn điểm số — chỉ còn đường khi tàu chạy
  clearPlannedRoute();
  renderCaptureLine();
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
        keepDrawnPath: true,
        ...surveySaveFields(),
        coordinates: plannedCoords,
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Không bắt đầu ghi được GPS');
    // Path GPS = path đã gửi (đúng đường vẽ). Không dùng body.coordinates nếu server đổi hình.
    lockedSurveyPath = plannedCoords.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
    riverPathOverride = null;
    clearPlannedRoute(); // một đường duy nhất = captureLine
    renderCaptureLine();
    const warn = body.targetSessionWarning ? ` ${body.targetSessionWarning}` : '';
    const startName = startStation?.stationName || startStation?.stationCode || 'điểm đầu đường vẽ';
    captureStatusEl.textContent = `Tàu chạy đúng đường vẽ · ghi GPS mỗi ${sendIntervalMs / 1000}s.${warn}`;
    collectorStatusEl.textContent = `Đang chạy ${body.boatCode} · ${body.deviceId}`;
    gpsStatusEl.textContent = 'Đang ghi GPS';
    setGpsCardState('running');
    ensureSurveyPathVisible();
    if (body.targetSessionWarning) notifyWarn(`Ghi GPS: ${body.targetSessionWarning}`);
    else notifyOk(`${body.boatCode} chạy theo đường vẽ`);
  } catch (error) {
    recordingActive = false;
    recordingStartedAt = 0;
    lockedSurveyPath = null;
    clearPlannedRoute();
    captureStatusEl.textContent = `Lỗi: ${error.message}`;
    notifyErr(`Không bắt đầu ghi GPS: ${error.message}`);
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
    setGpsCardState('ok');
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
  let routeName = captureRouteNameEl.value.trim() || routeCode;
  if (activeCharterLeg) {
    const a = activeCharterLeg.from?.stationCode || activeCharterLeg.from?.stationName;
    const b = activeCharterLeg.to?.stationCode || activeCharterLeg.to?.stationName;
    if (a && b) {
      routeName = `${a} - ${b}`;
      if (captureRouteNameEl) captureRouteNameEl.value = routeName;
    }
  }
  if (!routeCode) {
    captureStatusEl.textContent = 'Nhập mã tuyến trước khi lưu.';
    notifyErr('Nhập mã tuyến trước khi lưu');
    return false;
  }
  if (!checkRouteCodeDuplicate()) {
    captureStatusEl.textContent = 'Mã tuyến bị trùng — đổi mã rồi lưu lại.';
    notifyErr('Mã tuyến bị trùng — chưa lưu');
    return false;
  }
  if (!validateReverseRouteCode()) {
    captureStatusEl.textContent = 'Mã chiều về trùng mã tuyến chính — đổi trước khi lưu.';
    reverseRouteCodeEl?.focus();
    notifyErr('Mã chiều về trùng — chưa lưu');
    return false;
  }
  // Charter: bắt buộc đúng 2 bến + có đường vẽ trước khi gửi BE.
  if (activeCharterRequest?.requestId) {
    const startId = activeCharterLeg?.from?.stationId || startStationEl?.value;
    const endId = activeCharterLeg?.to?.stationId || endStationEl?.value;
    const path = lockedSurveyPath?.length >= 2
      ? lockedSurveyPath
      : (captureState.points.length >= 2 ? getPathCoordinates() : []);
    if (!startId || !endId) {
      captureStatusEl.textContent = 'Charter: thiếu 2 bến chặng — chưa lưu.';
      notifyErr('Charter: chọn đủ 2 bến của chặng trước khi lưu');
      return false;
    }
    if (String(startId) === String(endId)) {
      captureStatusEl.textContent = 'Charter: 2 bến trùng nhau — chưa lưu.';
      notifyErr('Charter: 2 bến phải khác nhau');
      return false;
    }
    if (path.length < 2) {
      captureStatusEl.textContent = 'Charter: chưa có đường geometry — vẽ rồi lưu.';
      notifyErr('Charter: vẽ đường giữa 2 bến trước khi lưu');
      return false;
    }
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
    // Charter: chỉ coi thành công khi lên BE — local + warning = thất bại.
    if (activeCharterRequest?.requestId && body.savedTo !== 'target') {
      throw new Error(
        body.warning
          || body.error
          || 'Charter chưa lên BE — không chấp nhận lưu local. Thử lại.',
      );
    }
    if (body.charterComplete && body.charterComplete.ok === false) {
      throw new Error(
        `Complete charter lỗi: ${body.charterComplete.error || body.charterComplete.status}`
          + ' · Charter CHƯA hoàn tất.',
      );
    }
    const where = body.savedTo === 'target' ? 'BE Azure' : 'DB local';
    const warn = body.warning ? ` (Azure: ${body.warning})` : '';
    captureStatusEl.textContent = `Đã lưu ${body.routeCode || routeCode} lên ${where}.${warn}`;
    renderRouteResult(body);
    recordingSession = null;
    updateWorkflow('done');
    gpsStatusEl.textContent = 'Lưu thành công';
    setGpsCardState('ok');
    sendLogEl.textContent = `Tuyến ${body.routeCode || routeCode} đã đẩy lên ${where}.`;
    if (body.warning) notifyWarn(`Lưu ${body.routeCode || routeCode} lên ${where}${warn}`);
    else notifyOk(`Thành công: lưu ${body.routeCode || routeCode} lên ${where}`);
    const hasMoreCharterLegs = Boolean(activeCharterRequest?.requestId) && !isFinalCharterLeg();
    const savedId = body.routeId || body.id;
    if (savedId && charterRouteFilterIds) {
      charterRouteFilterIds.add(String(savedId));
      applySavedRoutesVisibility();
      applySelectedRouteHighlight(String(savedId));
    }
    if (hasMoreCharterLegs) {
      const queue = charterLegQueue();
      const done = (Number(activeCharterRequest._legIndex) || 0) + 1;
      notifyOk(`Đã lưu chặng ${done}/${queue.length} — còn ${queue.length - done} chặng`);
    } else if (body.charterComplete?.ok) {
      const doneId = activeCharterRequest?.requestId;
      if (doneId) {
        charterDoneRequestIds.add(doneId);
        localStorage.setItem('charterDoneIds', JSON.stringify([...charterDoneRequestIds]));
        removeCharterRequestFromList(doneId);
      }
      notifyOk('Charter request Done — đã gắn route vào booking');
      clearActiveCharterRequest();
      // Poll server tới khi nó cũng trả rỗng (status đã Done/Completed).
      pollCharterRequestUntilGone(doneId);
    } else if (activeCharterRequest?.requestId && isFinalCharterLeg()) {
      // Đã vẽ hết chặng thiếu → CB đủ tuyến, thoát chế độ charter (không còn hiện ở panel).
      const ids = [...(charterRouteFilterIds || [])];
      if (savedId) ids.push(String(savedId));
      // Đánh dấu request này đã hoàn tất để lần refresh sau tự ẩn khỏi panel.
      const doneId = activeCharterRequest.requestId;
      if (doneId) {
        charterDoneRequestIds.add(doneId);
        localStorage.setItem('charterDoneIds', JSON.stringify([...charterDoneRequestIds]));
        removeCharterRequestFromList(doneId);
      }
      notifyOk('CB đã đủ tuyến — đã bỏ khỏi danh sách');
      // Cập nhật match cache trước khi clear.
      activeCharterRequest._savedMatch = buildCharterPathFromSavedRoutes(activeCharterRequest.stops);
      updateStopChainPreview();
      // Clear form ngay.
      const requestToRemove = activeCharterRequest;
      activeCharterRequest = null;
      activeCharterLeg = null;
      // Poll server cho tới khi nó trả về không còn request (status Done).
      pollCharterRequestUntilGone(requestToRemove.requestId);
      exitCharterKeepRoutes(ids);
    } else if (activeCharterRequest?.requestId) {
      // Vừa lưu chặng xong (còn chặng khác) → rebuild match + preview.
      activeCharterRequest._savedMatch = buildCharterPathFromSavedRoutes(activeCharterRequest.stops);
      updateStopChainPreview();
      updateCharterActiveBanner();
    }
    if (!hasMoreCharterLegs) hideDrawingKeepGps({ routeCode: body.routeCode || routeCode });
    if (silentClear && !hasMoreCharterLegs) {
      setDrawTool('pan');
      setLineMode('straight');
      captureRouteCodeEl.value = '';
      captureRouteNameEl.value = '';
      captureRouteCodeEl.classList.remove('is-invalid');
      renderCaptureState();
    }
    await fetch('/api/refresh', { method: 'POST' });
    // KHÔNG auto-advance: user bấm nút "Chặng kế →" để chuyển sang chặng tiếp theo.
    // Sau save mà còn chặng → chỉ rebuild match + preview + show nút.
    if (hasMoreCharterLegs) {
      activeCharterRequest._savedMatch = buildCharterPathFromSavedRoutes(activeCharterRequest.stops);
      updateStopChainPreview();
      updateCharterActiveBanner();
    }
    return true;
  } catch (error) {
    captureStatusEl.textContent = `Lỗi: ${error.message}`;
    notifyErr(`Lưu thất bại: ${error.message}`);
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

function clearCompletedRouteLine() {
  if (completedRouteLine) {
    completedRouteLine.remove();
    completedRouteLine = null;
  }
}

/** Sau khi chạy xong: ẩn đường vẽ, giữ marker GPS (hub) ở bến đích. */
function hideDrawingKeepGps(body = {}) {
  const endHint = [
    body.routeCode || '',
    'đã tới bến — GPS vẫn hiện',
  ].filter(Boolean).join(' · ');
  unlockSurveyPath();
  clearCapturePoints();
  clearPlannedRoute();
  clearCompletedRouteLine();
  captureState.finished = false;
  rebuildCaptureMarkers();
  if (captureStatusEl) {
    captureStatusEl.textContent = endHint || 'Đã ẩn đường vẽ. Marker GPS giữ tại bến đích.';
  }
}

function tryRevealPendingRoute(routes = []) {
  if (!pendingRevealRoute) return;
  const id = String(pendingRevealRoute.routeId || '');
  const code = String(pendingRevealRoute.routeCode || '');
  const match = (routes || []).find((r) => (
    (id && String(r.routeId) === id) || (code && String(r.routeCode) === code)
  ));
  if (!match) return;
  pendingRevealRoute = null;
  if (mapLegendSelectEl) {
    mapLegendSelectEl.value = String(match.routeId);
    mapLegendSelectEl.dispatchEvent(new Event('change'));
  }
  // Tuyến đã có trong DB/SSE → bỏ lớp tạm.
  clearCompletedRouteLine();
}

function ensureSurveyPathVisible() {
  // Một đường duy nhất khi chạy: captureLine theo lockedSurveyPath.
  if (captureState.points.length >= 2 || (lockedSurveyPath && lockedSurveyPath.length >= 2)) {
    renderCaptureLine();
  }
  if (captureLine) captureLine.bringToFront();
  // Không chồng plannedRouteLine (tránh 2 đường lệch nhau).
  clearPlannedRoute();
}

function unlockSurveyPath() {
  lockedSurveyPath = null;
  recordingActive = false;
  recordingStartedAt = 0;
}

function renderRouteResult(body) {
  if (!routeResultEl) return;
  const distance = body.baseDistanceKm ?? body.distanceKm;
  const stops = Array.isArray(body.stops) ? body.stops : [];
  // Thời gian chạy = (quãng đường ÷ tốc độ cài) lúc vẽ — không lấy lịch/BE/tổng đoạn.
  const duration = body.estimatedDurationMin != null && body.estimatedDurationMin !== ''
    ? Number(body.estimatedDurationMin)
    : null;
  const durationText = Number.isFinite(duration) && duration > 0
    ? Number(duration.toFixed(2)).toString()
    : null;
  const stopLines = stops
    .slice()
    .sort((a, b) => Number(a.stopOrder) - Number(b.stopOrder))
    .map((stop, index, arr) => {
      const order = Number(stop.stopOrder) || index + 1;
      const code = stop.stationCode ? ` (${stop.stationCode})` : '';
      const prev = arr[index - 1];
      const segment = index > 0
        ? (stop.standardTravelMin != null
          ? `<div class="route-result-seg">← ${stop.standardTravelMin} phút (GPS×tốc độ)${stop.segmentDistanceKm != null ? ` · ${stop.segmentDistanceKm} km` : ''} từ ${escapeHtml(prev?.stationName || prev?.stationCode || `bến ${order - 1}`)}</div>`
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
      <span>Thời gian chạy: <b>${durationText != null ? `${durationText} phút` : '?'}</b></span>
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
    <p class="meta"><a href="/api-log.html" target="_blank" rel="noopener">Xem log API đẩy BE →</a></p>
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
    setGpsCardState('error');
    notifyErr(`Tự lưu thất bại: ${autoSaved.error || 'Không lưu được'}`);
    updateWorkflow('run');
    return;
  }

  const warnText = String(autoSaved.warning || '');
  const charterBroken = /complete charter|ghép route tổng|CHARTER_/i.test(warnText)
    || (Boolean(autoSaved.charterRequestId) && autoSaved.savedTo !== 'target')
    || (autoSaved.charterComplete && autoSaved.charterComplete.ok === false);
  if (charterBroken) {
    const msg = autoSaved.charterComplete?.error
      || warnText
      || 'Charter chưa hoàn tất';
    captureStatusEl.textContent = `Lỗi charter: ${msg}`;
    gpsStatusEl.textContent = 'Charter chưa Done';
    notifyErr(`Charter chưa hoàn tất: ${msg}`);
    updateWorkflow('run');
    return;
  }

  const where = autoSaved.savedTo === 'target' ? 'BE Azure' : 'DB local';
  const warn = autoSaved.warning ? ` (Azure: ${autoSaved.warning})` : '';
  captureStatusEl.textContent = `Đã tự lưu ${autoSaved.routeCode || ''} lên ${where}.${warn}`;
  gpsStatusEl.textContent = 'Lưu thành công';
    setGpsCardState('ok');
  sendLogEl.textContent = `Tuyến ${autoSaved.routeCode || ''} đã đẩy lên ${where}.`;
  if (autoSaved.warning) notifyWarn(`Tự lưu ${autoSaved.routeCode || ''} lên ${where}${warn}`);
  else notifyOk(`Tự lưu thành công: ${autoSaved.routeCode || ''} → ${where}`);
  if (autoSaved.charterComplete?.ok) {
    notifyOk('Charter request Done — đã gắn route vào booking');
    clearActiveCharterRequest({ refresh: true });
  }
  renderRouteResult(autoSaved);
  updateWorkflow('done');
  hideDrawingKeepGps({ routeCode: autoSaved.routeCode || '' });
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
    // Không xóa hub GPS — bên theo dõi vẫn thấy tàu dừng ở bến đích.
    const count = activeSession?.recordedPoints?.length || activeSession?.recordedCount || 0;
    if (count && !autoSaveInFlight) {
      collectorStatusEl.textContent = `Đã kết thúc ghi: ${count} điểm GPS · tàu dừng tại bến.`;
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
    setGpsCardState('warn');
    stopCollectorEl.disabled = true;
    pauseCollectorEl.disabled = true;
    ensureSurveyPathVisible();
  }

  const icon = collectorIcon(collector.heading);
  const tip = String(collector.boatCode || '').trim() || 'GPS';
  // Collector là nguồn live khi survey → bỏ twin SignalR cùng mã.
  removeSignalRBoatMarker(String(collector.boatCode || '').trim());
  const rawLat = Number(collector.lat);
  const rawLng = Number(collector.lng);
  const snapped = projectOntoPath(lockedSurveyPath || getPathCoordinates(), { lat: rawLat, lng: rawLng })
    || { lat: rawLat, lng: rawLng };
  if (!collectorMarker) {
    collectorMarker = L.marker([snapped.lat, snapped.lng], { icon, zIndexOffset: 800 }).addTo(map);
    collectorMarker.bindTooltip(tip, { direction: 'top', offset: [0, -18], opacity: 1 });
  } else {
    collectorMarker.setLatLng([snapped.lat, snapped.lng]);
    collectorMarker.setIcon(icon);
    collectorMarker.setTooltipContent(tip);
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
  setGpsCardState(collector.paused ? 'warn' : 'running');
  ensureSurveyPathVisible();
}

function collectorIcon(heading) {
  const h = Number(heading);
  const deg = Number.isFinite(h) ? h : 0;
  return L.divIcon({
    className: 'collector-marker-wrap',
    html: `
      <div class="collector-marker">
        <div class="collector-marker-inner" style="--heading:${deg}deg">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#111827" stroke="#fff" stroke-width="1.5" d="M12 3 L20 19 L12 15 L4 19 Z"></path>
          </svg>
        </div>
      </div>
    `,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
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
  renderHubStatus({
    config: data.config,
    lastSend: data.lastSend,
    lastCollectorSend: data.lastCollectorSend,
    signalR: data.signalR || currentSignalR || null,
    stats: data.stats,
    totalRecorded: data.totalRecorded,
    sentRecorded: data.sentRecorded,
  });

  const catalog = catalogBoats(data);
  const catalogFp = collectorBoatOptionsSignature(catalog);
  if (catalogFp !== lastBoatIds) {
    if (isCollectorBoatSelectInteracting() && collectorBoatCodeEl.options.length > 1) {
      // Không thay innerHTML khi native select đang mở — Safari/Chrome có thể mất click.
      collectorBoatOptionsPending = true;
    } else {
      lastBoatIds = catalogFp;
      collectorBoatOptionsPending = false;
      renderCollectorBoatOptions(catalog);
    }
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
  // Key theo boatCode — 1 mã tàu = 1 marker (tránh trùng boatId collector/db).
  const seen = new Set();
  for (const boat of boats) {
    const key = String(boat.boatCode || boat.boatId || '').trim();
    if (!key || !Number.isFinite(Number(boat.lat)) || !Number.isFinite(Number(boat.lng))) continue;
    seen.add(key);
    let marker = markers.get(key);
    if (!marker) {
      marker = L.marker([boat.lat, boat.lng], { icon: boatIcon(boat.heading) }).addTo(map);
      marker.bindTooltip(boat.boatCode || key, { direction: 'top', offset: [0, -18], opacity: 1 });
      marker._boatState = `${boat.lat},${boat.lng},${boat.heading}`;
      markers.set(key, marker);
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
        <div class="boat-marker-inner" style="--heading:${heading}deg">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#ef4444" stroke="#fff" stroke-width="1.5" d="M12 3 L20 19 L12 15 L4 19 Z"></path>
          </svg>
        </div>
      </div>
    `,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });
}

function isSavedRouteAllowed(routeId) {
  if (!charterRouteFilterIds) return true;
  return charterRouteFilterIds.has(String(routeId || ''));
}

function applySavedRoutesVisibility() {
  for (const [id, layer] of routeLayers) {
    const show = showSavedRoutes && isSavedRouteAllowed(id);
    if (show) {
      if (!map.hasLayer(layer)) layer.addTo(map);
    } else if (map.hasLayer(layer)) {
      map.removeLayer(layer);
    }
  }
  // Preview candidate/chặng CB theo cùng toggle Ẩn/Hiện.
  if (charterCandidateLayer) {
    if (showSavedRoutes && activeCharterRequest) {
      if (!map.hasLayer(charterCandidateLayer)) charterCandidateLayer.addTo(map);
    } else if (map.hasLayer(charterCandidateLayer)) {
      map.removeLayer(charterCandidateLayer);
    }
  }
  // Đường đang vẽ mà đã xong (hoặc đang chạy) cũng theo toggle này.
  // Đang vẽ dở (chưa finishDraw) thì luôn giữ hiện, không ẩn theo toggle.
  if (captureLine && (captureState.finished || recordingActive)) {
    if (showSavedRoutes) {
      if (!map.hasLayer(captureLine)) captureLine.addTo(map);
    } else if (map.hasLayer(captureLine)) {
      map.removeLayer(captureLine);
    }
  }
  if (!showSavedRoutes) {
    clearRouteStopMarkers();
    if (routeStopsListEl) {
      routeStopsListEl.classList.add('is-empty');
      routeStopsListEl.innerHTML = '<li>Đang ẩn tuyến có sẵn — bật lại để xem bến.</li>';
    }
  } else if (mapLegendSelectEl?.value && isSavedRouteAllowed(mapLegendSelectEl.value)) {
    showSelectedRouteStops(mapLegendSelectEl.value);
  } else {
    clearRouteStopMarkers();
  }
  if (toggleSavedRoutesEl) {
    toggleSavedRoutesEl.classList.toggle('is-on', showSavedRoutes);
    toggleSavedRoutesEl.classList.toggle('is-off', !showSavedRoutes);
    if (charterRouteFilterIds && activeCharterRequest) {
      toggleSavedRoutesEl.textContent = showSavedRoutes
        ? 'Ẩn tuyến CB'
        : 'Hiện tuyến CB';
    } else {
      toggleSavedRoutesEl.textContent = showSavedRoutes ? 'Ẩn tuyến có sẵn' : 'Hiện tuyến có sẵn';
    }
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
    if (charterRouteFilterIds?.has(String(id))) {
      layer.setStyle({ ...CHARTER_MATCHED_ROUTE_STYLE, smoothFactor: 0 });
      if (typeof layer.bringToFront === 'function') layer.bringToFront();
      continue;
    }
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
    const charterActive = Boolean(charterRouteFilterIds && activeCharterRequest);
    mapLegendSwatchEl.style.background = charterActive
      ? CHARTER_MATCHED_ROUTE_STYLE.color
      : (hasSelection ? SELECTED_ROUTE_STYLE.color : SAVED_ROUTE_STYLE.color);
    mapLegendSwatchEl.style.borderTop = 'none';
    mapLegendSwatchEl.style.height = (hasSelection || charterActive) ? '6px' : '3px';
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
      if (showSavedRoutes && isSavedRouteAllowed(route.routeId)) layer.addTo(map);
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
      const show = showSavedRoutes && isSavedRouteAllowed(route.routeId);
      if (show && !map.hasLayer(layer)) layer.addTo(map);
      if (!show && map.hasLayer(layer)) map.removeLayer(layer);
    }
    for (const p of latlngs) bounds.push(p);

    if (mapLegendSelectEl && isSavedRouteAllowed(route.routeId)) {
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

  tryRevealPendingRoute(routes);

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
  const charterOnly = charterStopOrders.size > 0;
  for (const station of uniqueStations(stations)) {
    // Đang mở yêu cầu charter → chỉ hiện bến thuộc request, ẩn bến không liên quan.
    if (charterOnly && !charterStopOrders.has(String(station.stationId))) {
      continue;
    }
    seen.add(station.stationId);
    // Bến thuộc yêu cầu charter → đổi màu chính lá cờ đó (không chèn cờ thứ 2).
    const charterOrder = charterStopOrders.get(String(station.stationId)) || null;
    let role = '';
    if (charterOrder) role = 'charter';
    else if (station.stationId === startId) role = 'start';
    else if (station.stationId === endId) role = 'end';
    const icon = stationFlagIcon(station, role, charterOrder);
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
      if (!map.hasLayer(layer)) layer.addTo(map);
    }
  }
  for (const [id, layer] of stationLayers) {
    if (!seen.has(id)) {
      layer.remove();
      stationLayers.delete(id);
    }
  }
}

function stationFlagIcon(station, role = '', order = null) {
  const code = String(station.stationCode || '')
    .replace(/^ST-/i, '')
    .slice(0, 3)
    .toUpperCase() || '•';
  const label = order ? `${order}·${code}` : code;
  const width = order ? 40 : 28;
  return L.divIcon({
    className: '',
    html: `
      <div class="station-flag${role ? ` is-${role}` : ''}">
        <div class="station-flag-pole"></div>
        <div class="station-flag-cloth">${escapeHtml(label)}</div>
      </div>
    `,
    iconSize: [width, 36],
    iconAnchor: [5, 36],
  });
}

function handleStationClick(station) {
  if (charterStopOrders.size && !charterStopOrders.has(String(station.stationId))) {
    notifyWarn('Đang mở yêu cầu charter — chỉ dùng các bến của request.');
    return;
  }
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
  if (charterStopOrders.size && !charterStopOrders.has(String(station.stationId))) {
    notifyWarn('Đang mở yêu cầu charter — chỉ dùng các bến của request.');
    return;
  }
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

function toneFor(state) {
  if (state === 'ok') return 'is-ok';
  if (state === 'warn') return 'is-warn';
  if (state === 'error') return 'is-error';
  return '';
}

function setGpsCardState(state) {
  if (!gpsLiveCardEl) return;
  gpsLiveCardEl.dataset.state = state || 'idle';
}

function hubStateFromData(data) {
  if (!data) return { state: 'idle', azure: '—', signalr: '—', lastSend: '—', note: 'Đang chờ dữ liệu từ Live.' };
  const azureEnabled = Boolean(data.config?.liveAzureWrite);
  const senderOn = Boolean(data.config?.senderEnabled);
  const signalrState = data.signalR?.state || data.signalR?.lastError || 'idle';
  const last = data.lastSend || {};
  const lastAt = last.at ? formatTime(last.at) : '';
  const total = Number(data.stats?.total || data.totalRecorded || 0);
  const sent = Number(data.stats?.sent || data.sentRecorded || 0);
  let azureLabel = 'Tắt';
  if (azureEnabled) azureLabel = senderOn ? `Bật · ${sent}/${total}` : `Bật · tạm dừng`;
  if (azureEnabled && last.status === 409) azureLabel = `Bật · cảnh báo 409`;
  if (azureEnabled && last.error && !last.ok) azureLabel = `Lỗi · ${last.error}`;
  const azureState = !azureEnabled ? 'warn' : last.ok === false && /sequence|409/i.test(String(last.error || last.status)) ? 'warn' : last.ok === false ? 'error' : 'ok';
  const signalrLabel = data.signalR?.connected ? `Kết nối · ${data.signalR?.hubUrl || ''}` : (signalrState === 'reconnecting' ? `Reconnect…` : (data.signalR?.lastError || 'Chờ'));
  const signalrStateCls = data.signalR?.connected ? 'ok' : (signalrState === 'reconnecting' ? 'warn' : 'error');
  const lastLabel = lastAt
    ? `${formatTime(last.at)} · ${last.status || last.mode || ''}${last.sequence ? ` · seq ${last.sequence}` : ''}${last.error ? ` · ${last.error}` : ''}`
    : '—';
  const lastState = !last.ok && last.error && /sequence|409/i.test(String(last.error || last.status)) ? 'warn' : !last.ok ? 'error' : (lastAt ? 'ok' : 'idle');
  let note = data.config?.senderEnabled
    ? `Sender đang hoạt động — gửi GPS theo hub.`
    : `Sender tạm dừng — chỉ giữ tại Live hub.`;
  if (last.soft || /sequence|409/i.test(String(last.error || last.status))) note = `Cảnh báo sequence — điểm vẫn ghi local.`;
  else if (last.error && !last.ok) note = `Lỗi gửi GPS: ${last.error}`;
  return {
    state: data.signalR?.connected && last.ok !== false ? 'ok' : (!last.ok ? azureState : 'ok'),
    endpoint: data.config?.targetUrl || data.targetUrl || data.config?.azureBase || '',
    mode: senderOn ? (azureEnabled ? 'Live → Azure' : 'Live · cục bộ') : (azureEnabled ? 'Azure · idle' : 'Idle'),
    azure: azureLabel, azureState,
    signalr: signalrLabel, signalrState: signalrStateCls,
    lastSend: lastLabel, lastState,
    points: `${sent} / ${total}`,
    note,
  };
}

function renderHubStatus(data) {
  if (!hubStatusEl) return;
  const view = hubStateFromData(data);
  hubStatusEl.hidden = false;
  hubStatusEl.dataset.state = view.state;
  if (hubStatusEndpointEl) hubStatusEndpointEl.textContent = view.endpoint || '—';
  if (hubStatusEndpointRowEl) hubStatusEndpointRowEl.hidden = !view.endpoint;
  if (hubStatusModeEl) {
    hubStatusModeEl.textContent = view.mode;
    hubStatusModeEl.classList.remove('is-ok', 'is-warn', 'is-error');
    hubStatusModeEl.classList.add(toneFor(view.state));
  }
  const apply = (el, label, cls) => {
    if (!el) return;
    el.textContent = label;
    el.classList.remove('is-ok', 'is-warn', 'is-error');
    el.classList.add(toneFor(cls));
  };
  apply(hubStatusAzureEl, view.azure, view.azureState);
  apply(hubStatusSignalrEl, view.signalr, view.signalrState);
  apply(hubStatusLastSendEl, view.lastSend, view.lastState);
  if (hubStatusPointsEl) hubStatusPointsEl.textContent = view.points;
  if (hubStatusNoteEl) hubStatusNoteEl.hidden = true;
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

/* —— Charter route-draw requests (BE: /api/charter-bookings/admin/...) —— */

function charterStopsAsOrdered(stops) {
  return [...(stops || [])]
    .map((stop, index, arr) => {
      const catalog = findStationInCatalog(stop.stationId) || {};
      const lat = Number.isFinite(Number(stop.latitude))
        ? Number(stop.latitude)
        : Number(stop.lat ?? catalog.lat);
      const lng = Number.isFinite(Number(stop.longitude))
        ? Number(stop.longitude)
        : Number(stop.lng ?? catalog.lng);
      return {
        stationId: String(stop.stationId || catalog.stationId || ''),
        stationCode: stop.stationCode || catalog.stationCode || null,
        stationName: stop.stationName || catalog.stationName || stop.stationCode || null,
        lat,
        lng,
        stopOrder: Number(stop.stopOrder) || index + 1,
        stayDurationMinutes: Number.isFinite(Number(stop.stayDurationMinutes))
          ? Number(stop.stayDurationMinutes)
          : null,
        note: stop.note || null,
        source: index === 0 ? 'station' : (index === arr.length - 1 ? 'station-end' : 'station-via'),
        clicked: true,
        isFirst: index === 0,
        isLast: index === arr.length - 1,
      };
    })
    .filter((s) => s.stationId)
    .sort((a, b) => a.stopOrder - b.stopOrder)
    .map((stop, index, arr) => ({
      ...stop,
      stopOrder: index + 1,
      isFirst: index === 0,
      isLast: index === arr.length - 1,
      source: index === 0 ? 'station' : (index === arr.length - 1 ? 'station-end' : 'station-via'),
    }));
}

function extractGeometryCoordinates(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    if (!raw.length) return [];
    // [[lng,lat], ...]
    if (Array.isArray(raw[0]) && Number.isFinite(Number(raw[0][0]))) {
      return raw
        .map((c) => ({ lat: Number(c[1]), lng: Number(c[0]) }))
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    }
    // [{lat,lng}, ...]
    if (raw[0] && typeof raw[0] === 'object' && !Array.isArray(raw[0])) {
      return raw
        .map((p) => ({
          lat: Number(p.lat ?? p.latitude ?? p.Latitude),
          lng: Number(p.lng ?? p.lon ?? p.longitude ?? p.Longitude),
        }))
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    }
    // single [lng, lat]
    if (typeof raw[0] === 'number' && raw.length >= 2) {
      return [{ lat: Number(raw[1]), lng: Number(raw[0]) }];
    }
    return raw.flatMap((item) => extractGeometryCoordinates(item)).filter((p) => (
      Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))
    ));
  }
  if (typeof raw !== 'object') return [];
  if (raw.type === 'Feature') return extractGeometryCoordinates(raw.geometry);
  if (raw.type === 'FeatureCollection') {
    return (raw.features || []).flatMap((f) => extractGeometryCoordinates(f));
  }
  if (raw.type === 'LineString' && Array.isArray(raw.coordinates)) {
    return raw.coordinates.map((c) => ({ lat: Number(c[1]), lng: Number(c[0]) }));
  }
  if (raw.type === 'MultiLineString' && Array.isArray(raw.coordinates)) {
    return raw.coordinates.flatMap((line) => line.map((c) => ({ lat: Number(c[1]), lng: Number(c[0]) })));
  }
  if (Array.isArray(raw.coordinates)) return extractGeometryCoordinates(raw.coordinates);
  if (Array.isArray(raw.routeGeometry)) return extractGeometryCoordinates(raw.routeGeometry);
  if (raw.routeGeometry && typeof raw.routeGeometry === 'object') {
    return extractGeometryCoordinates(raw.routeGeometry);
  }
  if (raw.geojson) return extractGeometryCoordinates(raw.geojson);
  if (Number.isFinite(Number(raw.lat)) && Number.isFinite(Number(raw.lng))) {
    return [{ lat: Number(raw.lat), lng: Number(raw.lng) }];
  }
  if (Number.isFinite(Number(raw.latitude)) && Number.isFinite(Number(raw.longitude))) {
    return [{ lat: Number(raw.latitude), lng: Number(raw.longitude) }];
  }
  return [];
}

function candidateRouteCoordinates(detail) {
  const fromRoute = extractGeometryCoordinates(detail?.candidateRoute);
  if (fromRoute.length >= 2) return fromRoute;
  const legs = detail?.candidateLegs;
  if (Array.isArray(legs) && legs.length) {
    const merged = legs.flatMap((leg) => extractGeometryCoordinates(leg?.routeGeometry || leg?.geometry || leg));
    if (merged.length >= 2) return merged;
  }
  return [];
}

function candidateRouteId(detail) {
  const route = detail?.candidateRoute;
  if (!route || typeof route !== 'object') return null;
  return route.routeId || route.id || route.RouteId || null;
}

function clearCharterMapLayers({ resetFlags = false } = {}) {
  if (charterCandidateLayer) {
    charterCandidateLayer.remove();
    charterCandidateLayer = null;
  }
  if (charterStopLayer) {
    charterStopLayer.remove();
    charterStopLayer = null;
  }
  if (resetFlags && charterStopOrders.size) {
    charterStopOrders.clear();
    if (latest?.stations) renderStations(latest.stations);
  }
}

function renderCharterStopPins(stops) {
  clearCharterMapLayers();
  charterStopOrders.clear();
  const ordered = charterStopsAsOrdered(stops);
  if (!ordered.length) {
    if (latest?.stations) renderStations(latest.stations);
    return;
  }

  const bounds = [];
  const knownIds = new Set(
    (latest?.stations || []).map((s) => String(s.stationId)),
  );
  const extras = [];
  ordered.forEach((stop) => {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lng)) return;
    bounds.push([stop.lat, stop.lng]);
    charterStopOrders.set(String(stop.stationId), stop.stopOrder);
    if (!knownIds.has(String(stop.stationId))) extras.push(stop);
  });

  // Đổi màu cờ bến sẵn có (không chèn cờ thứ 2 chồng lên).
  if (latest?.stations) renderStations(latest.stations);

  // Bến charter không có trong catalog map → mới cần vẽ cờ riêng.
  if (extras.length) {
    charterStopLayer = L.layerGroup().addTo(map);
    extras.forEach((stop) => {
      const marker = L.marker([stop.lat, stop.lng], {
        icon: stationFlagIcon(
          { stationCode: stop.stationCode || stop.stationName },
          'charter',
          stop.stopOrder,
        ),
        zIndexOffset: 900,
      });
      const stay = stop.stayDurationMinutes != null ? ` · dừng ${stop.stayDurationMinutes}p` : '';
      marker.bindTooltip(
        `#${stop.stopOrder} ${stop.stationName || stop.stationCode || stop.stationId}${stay}`,
        { direction: 'top', offset: [0, -32] },
      );
      charterStopLayer.addLayer(marker);
    });
  }

  if (bounds.length) {
    map.fitBounds(bounds, { padding: [56, 56], maxZoom: 15 });
  }
}

function renderCharterCandidatePreview(coords) {
  if (!coords || coords.length < 2) return;
  if (!charterCandidateLayer) charterCandidateLayer = L.layerGroup().addTo(map);
  const line = L.polyline(
    coords.map((p) => [p.lat, p.lng]),
    {
      color: '#2563eb',
      weight: 5,
      opacity: 0.85,
      dashArray: '8 6',
    },
  );
  charterCandidateLayer.addLayer(line);
}

function applyCharterStationsToForm(stops) {
  const ordered = charterStopsAsOrdered(stops);
  if (!ordered.length) return;
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  setStationComboValue('start', first.stationId, { emitChange: false });
  setStationComboValue('end', last.stationId, { emitChange: false });
  syncEndStationDisplay();
  const codes = ordered.map((s) => s.stationCode || s.stationName || s.stationId).filter(Boolean);
  if (captureRouteCodeEl && !captureRouteCodeEl.value.trim()) {
    const booking = activeCharterRequest?.bookingCode || 'CHARTER';
    captureRouteCodeEl.value = `${booking}`.replace(/\s+/g, '-').slice(0, 40);
  }
  if (captureRouteNameEl && !captureRouteNameEl.value.trim()) {
    captureRouteNameEl.value = codes.length >= 2
      ? `${codes[0]} - ${codes[codes.length - 1]}`
      : (activeCharterRequest?.bookingCode || 'Charter route');
  }
  if (createReverseRouteEl) {
    createReverseRouteEl.checked = false;
    createReverseRouteEl.disabled = true;
  }
  updateReverseRouteUi();
  updateRouteTypeHint();
  checkRouteCodeDuplicate();
  updateCharterActiveBanner();
  updateStopChainPreview();
}

/** 2 bến của 1 chặng charter — đúng payload 1 route được phép gửi. */
function charterLegStops(leg) {
  if (!leg?.from?.stationId || !leg?.to?.stationId) return [];
  return charterStopsAsOrdered([
    { ...leg.from, stopOrder: 1 },
    { ...leg.to, stopOrder: 2 },
  ]);
}

function charterLegQueue() {
  return Array.isArray(activeCharterRequest?._legQueue) ? activeCharterRequest._legQueue : [];
}

function isFinalCharterLeg() {
  const queue = charterLegQueue();
  if (!queue.length) return true;
  return (Number(activeCharterRequest?._legIndex) || 0) >= queue.length - 1;
}

/** Nạp 1 chặng vào form vẽ: start/end = 2 bến của chặng, mã tuyến riêng cho chặng. */
function applyCharterLegToForm(leg, total) {
  if (!leg?.from || !leg?.to) return;
  activeCharterLeg = leg;
  setStationComboValue('start', leg.from.stationId, { emitChange: false });
  setStationComboValue('end', leg.to.stationId, { emitChange: false });
  selectedStartStationId = leg.from.stationId;
  selectedEndStationId = leg.to.stationId;
  syncEndStationDisplay();
  const booking = String(activeCharterRequest?.bookingCode || 'CHARTER').replace(/\s+/g, '-');
  const suffix = total > 1 ? `-C${(Number(leg.index) || 0) + 1}` : '';
  if (captureRouteCodeEl) captureRouteCodeEl.value = `${booking}${suffix}`.slice(0, 40);
  if (captureRouteNameEl) {
    const a = leg.from.stationName || leg.from.stationCode || leg.from.stationId;
    const b = leg.to.stationName || leg.to.stationCode || leg.to.stationId;
    captureRouteNameEl.value = `${a} - ${b}`;
  }
  if (createReverseRouteEl) {
    createReverseRouteEl.checked = false;
    createReverseRouteEl.disabled = true;
  }
  updateReverseRouteUi();
  updateRouteTypeHint();
  checkRouteCodeDuplicate();
  updateCharterActiveBanner();
  updateStopChainPreview();
}

/** Lưu xong 1 chặng → mở chặng thiếu kế tiếp (không gộp, không tự nối). */
function advanceCharterLeg() {
  const queue = charterLegQueue();
  const next = (Number(activeCharterRequest?._legIndex) || 0) + 1;
  if (!activeCharterRequest || next >= queue.length) return false;
  activeCharterRequest._legIndex = next;
  const leg = queue[next];
  unlockSurveyPath();
  clearCapturePoints();
  clearPlannedRoute();
  clearCompletedRouteLine();
  captureState.finished = false;
  rebuildCaptureMarkers();
  applyCharterLegToForm(leg, queue.length);
  setDrawTool('draw');
  updateWorkflow('draw');
  captureStatusEl.textContent = `Charter: chặng ${next + 1}/${queue.length} — vẽ ${leg.label} (1 route = 2 bến).`;
  notifyInfo(`Chặng kế tiếp: ${leg.label}`);
  return true;
}

/** Chuẩn hóa mã bến để so khớp (ST-BD ≈ BD). */
function stationCodeKey(stop) {
  const raw = stop?.stationCode
    || findStationInCatalog(stop?.stationId)?.stationCode
    || '';
  const code = String(raw || '').trim().replace(/^ST-/i, '').toUpperCase();
  if (code) return code;
  return String(stop?.stationId || '').trim().toUpperCase();
}

function sameStationRef(a, b) {
  if (!a || !b) return false;
  const idA = String(a.stationId || '').trim();
  const idB = String(b.stationId || '').trim();
  if (idA && idB && idA === idB) return true;
  const codeA = stationCodeKey(a);
  const codeB = stationCodeKey(b);
  return Boolean(codeA && codeB && codeA === codeB);
}

function nearestCoordIndex(coords, point) {
  let bestIdx = -1;
  let bestDist = Infinity;
  (coords || []).forEach((c, idx) => {
    const d = haversineMeters(c, point);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = idx;
    }
  });
  return { index: bestIdx, dist: bestDist };
}

/** Cắt geometry tuyến đã lưu giữa 2 bến (theo điểm gần nhất trên path). */
function extractRouteCoordsBetween(route, fromStop, toStop) {
  const coords = Array.isArray(route?.coordinates) ? route.coordinates : [];
  if (coords.length < 2) return [];
  const fromPt = {
    lat: Number(fromStop.lat ?? fromStop.latitude),
    lng: Number(fromStop.lng ?? fromStop.longitude),
  };
  const toPt = {
    lat: Number(toStop.lat ?? toStop.latitude),
    lng: Number(toStop.lng ?? toStop.longitude),
  };
  if (![fromPt.lat, fromPt.lng, toPt.lat, toPt.lng].every(Number.isFinite)) return [];
  const a = nearestCoordIndex(coords, fromPt);
  const b = nearestCoordIndex(coords, toPt);
  if (a.index < 0 || b.index < 0) return [];
  // Chỉ nhận nếu bến thật sự nằm gần path (tránh nhầm tuyến xa).
  if (a.dist > 350 || b.dist > 350) return [];
  const lo = Math.min(a.index, b.index);
  const hi = Math.max(a.index, b.index);
  if (hi - lo < 1) return [];
  const slice = coords.slice(lo, hi + 1).map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
  // Đảm bảo hướng from → to.
  if (a.index > b.index) slice.reverse();
  return slice;
}

function routeCoordinateList(route) {
  return (Array.isArray(route?.coordinates) ? route.coordinates : [])
    .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

/**
 * Tìm route theo đúng 2 mã bến của 1 chặng (1 route = 2 bến).
 * Ưu tiên: stops đúng 2 bến from→to, hoặc startStationId/endStationId khớp.
 */
function findExactRouteForStationPair(fromStop, toStop) {
  const routes = Array.isArray(latest?.routes) ? latest.routes : [];
  let best = null;
  for (const route of routes) {
    const stops = [...(route.stops || [])].sort((a, b) => Number(a.stopOrder) - Number(b.stopOrder));
    const startId = String(route.startStationId || route.start_station_id || stops[0]?.stationId || '').trim();
    const endId = String(route.endStationId || route.end_station_id || stops[stops.length - 1]?.stationId || '').trim();
    const startOk = sameStationRef({ stationId: startId, stationCode: stops[0]?.stationCode }, fromStop)
      || (stops.length >= 1 && sameStationRef(stops[0], fromStop));
    const endOk = sameStationRef({ stationId: endId, stationCode: stops[stops.length - 1]?.stationCode }, toStop)
      || (stops.length >= 1 && sameStationRef(stops[stops.length - 1], toStop));

    // Chỉ nhận route đúng 2 bến, hoặc start/end khớp và không có bến giữa.
    const exactTwoStops = stops.length === 2
      && sameStationRef(stops[0], fromStop)
      && sameStationRef(stops[1], toStop);
    const exactStartEnd = startOk && endOk && (stops.length <= 2 || stops.length === 0);
    if (!exactTwoStops && !exactStartEnd) continue;

    let coords = extractRouteCoordsBetween(route, fromStop, toStop);
    if (coords.length < 2) coords = routeCoordinateList(route);
    if (coords.length < 2) continue;

    const score = (exactTwoStops ? 0 : 100) + coords.length;
    if (!best || score < best.score) {
      best = {
        routeId: route.routeId,
        routeCode: route.routeCode || route.routeName || route.routeId,
        coords,
        score,
        span: 1,
        exactPair: true,
      };
    }
  }
  return best;
}

/** Tìm tuyến DB cho chặng from→to — ưu tiên đúng 2 mã bến, fallback cắt từ tuyến dài hơn. */
function findSavedSegmentBetween(fromStop, toStop) {
  const exact = findExactRouteForStationPair(fromStop, toStop);
  if (exact) return exact;

  const routes = Array.isArray(latest?.routes) ? latest.routes : [];
  let best = null;
  for (const route of routes) {
    const stops = [...(route.stops || [])].sort((a, b) => Number(a.stopOrder) - Number(b.stopOrder));
    const fromIdx = stops.findIndex((s) => sameStationRef(s, fromStop));
    const toIdx = stops.findIndex((s) => sameStationRef(s, toStop));
    if (fromIdx < 0 || toIdx < 0 || fromIdx >= toIdx) continue;
    const coords = extractRouteCoordsBetween(route, fromStop, toStop);
    if (coords.length < 2) continue;
    const span = toIdx - fromIdx;
    const score = span * 10000 + coords.length;
    if (!best || score < best.score) {
      best = {
        routeId: route.routeId,
        routeCode: route.routeCode || route.routeName || route.routeId,
        coords,
        score,
        span,
        exactPair: false,
      };
    }
  }
  return best;
}

/**
 * Ghép các đoạn tuyến đã có giữa các cặp bến charter liên tiếp.
 * prefixStitched = các đoạn khớp liên tục từ bến đầu (để nạp vào bản vẽ).
 * Đoạn thiếu / đoạn khớp sau khoảng trống → missingLegs / laterMatched.
 */
function buildCharterPathFromSavedRoutes(stops) {
  const ordered = charterStopsAsOrdered(stops);
  const matchedLegs = [];
  const missingLegs = [];
  const laterMatched = [];
  const prefixStitched = [];
  let gapHit = false;

  for (let i = 0; i < ordered.length - 1; i += 1) {
    const from = ordered[i];
    const to = ordered[i + 1];
    const label = `${from.stationCode || from.stationName} → ${to.stationCode || to.stationName}`;
    const seg = findSavedSegmentBetween(from, to);
    if (!seg) {
      gapHit = true;
      missingLegs.push({ from, to, label, index: i });
      continue;
    }
    const leg = {
      from,
      to,
      label,
      index: i,
      routeCode: seg.routeCode,
      routeId: seg.routeId,
      coords: seg.coords,
      exactPair: Boolean(seg.exactPair),
    };
    matchedLegs.push(leg);
    if (!gapHit) {
      if (!prefixStitched.length) prefixStitched.push(...seg.coords);
      else prefixStitched.push(...seg.coords.slice(1));
    } else {
      laterMatched.push(leg);
    }
  }

  return {
    ordered,
    stitched: prefixStitched,
    matchedLegs,
    missingLegs,
    laterMatched,
  };
}

function loadCandidateIntoCapture(coords, stops, { markAttached = false } = {}) {
  if (!coords || coords.length < 2) return false;
  clearCapturePoints();
  coords.forEach((point) => {
    addCapturePoint({ lat: point.lat, lng: point.lng }, {
      source: markAttached ? 'attached' : 'manual',
      attached: markAttached,
    });
  });
  if (markAttached) {
    captureState.attachedCount = captureState.points.length;
  }
  // Gắn nhãn bến gần điểm path (giữ attached để ẩn chấm số).
  const ordered = charterStopsAsOrdered(stops);
  ordered.forEach((stop) => {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lng)) return;
    let bestIdx = -1;
    let bestDist = Infinity;
    captureState.points.forEach((p, idx) => {
      const d = haversineMeters(p, stop);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = idx;
      }
    });
    if (bestIdx < 0 || bestDist > 250) return;
    const point = captureState.points[bestIdx];
    point.stationId = stop.stationId;
    point.label = stop.stationName;
    point.source = stop.isFirst ? 'station' : (stop.isLast ? 'station-end' : 'station-via');
    if (markAttached) point.attached = true;
  });
  applyCharterStationsToForm(stops);
  if (markAttached) {
    // Giữ chế độ vẽ tiếp — không finishDraw (tránh rồi setDraw lại hiện hết điểm).
    captureState.finished = false;
    captureState.selectedWaypointIndex = captureState.points.length - 1;
    captureState.selectedSegmentIndex = captureState.points.length > 1
      ? captureState.points.length - 1
      : null;
    rebuildCaptureMarkers();
  } else {
    finishDraw();
  }
  renderCaptureState();
  return true;
}

function updateCharterActiveBanner() {
  if (!charterActiveBannerEl) return;
  if (!activeCharterRequest?.requestId) {
    charterActiveBannerEl.hidden = true;
    charterActiveBannerEl.classList.add('is-empty');
    return;
  }
  charterActiveBannerEl.hidden = false;
  charterActiveBannerEl.classList.remove('is-empty');
  const code = activeCharterRequest.bookingCode || activeCharterRequest.bookingId || activeCharterRequest.requestId;
  const match = activeCharterRequest._savedMatch;
  const fullyCovered = Boolean(match?.matchedLegs?.length && !match?.missingLegs?.length);
  if (charterActiveTitleEl) {
    charterActiveTitleEl.textContent = fullyCovered ? `Đang xem · ${code}` : `Đang vẽ · ${code}`;
  }
  const stopNames = charterStopsAsOrdered(activeCharterRequest.stops)
    .map((s) => s.stationCode || s.stationName)
    .filter(Boolean)
    .join(' → ');
  const hasCandidate = candidateRouteCoordinates(activeCharterRequest).length >= 2;
  if (charterActiveMetaEl) {
    if (fullyCovered) {
      const ok = match.matchedLegs.map((l) => `${l.label} (${l.routeCode})`).join(', ');
      charterActiveMetaEl.textContent = `${stopNames || '—'} · đã có sẵn: ${ok} — chỉ hiện, không chỉnh`;
    } else if (match?.missingLegs?.length) {
      const queue = charterLegQueue();
      const pos = (Number(activeCharterRequest?._legIndex) || 0) + 1;
      const ok = match.matchedLegs.map((l) => `${l.label} (${l.routeCode})`).join(', ');
      const now = activeCharterLeg ? ` · đang vẽ chặng ${pos}/${queue.length}: ${activeCharterLeg.label}` : '';
      const miss = match.missingLegs.map((l) => l.label).join(', ');
      charterActiveMetaEl.textContent = ok
        ? `${stopNames || '—'} · có sẵn: ${ok} · còn thiếu: ${miss}${now}`
        : `${stopNames || '—'} · còn thiếu: ${miss}${now}`;
    } else if (hasCandidate) {
      charterActiveMetaEl.textContent = `${stopNames || '—'} · có candidate từ BE — chỉ hiện`;
    } else {
      charterActiveMetaEl.textContent = `${stopNames || '—'} · chưa có path — vẽ rồi ghi GPS`;
    }
  }
  // Nút "Chặng kế / Hoàn tất" — hiện khi còn chặng sau chặng hiện tại.
  if (charterNextLegBtnEl) {
    const queue = charterLegQueue();
    const idx = Number(activeCharterRequest?._legIndex) || 0;
    const hasNext = idx < queue.length - 1;
    // Nếu đã đủ tuyến (fullyCovered) → ẩn nút, request tự xử lý.
    if (fullyCovered) {
      charterNextLegBtnEl.hidden = true;
    } else {
      charterNextLegBtnEl.hidden = false;
      charterNextLegBtnEl.textContent = hasNext
        ? `Chặng kế (${idx + 2}/${queue.length}) →`
        : `Hoàn tất (${queue.length}/${queue.length}) →`;
    }
  }
  charterRequestListEl?.querySelectorAll('.charter-request-item').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.requestId === activeCharterRequest.requestId);
  });
}

/** Đủ tuyến: bỏ chế độ charter (ẩn banner, cờ về thường) nhưng vẫn hiện tuyến của CB. */
async function exitCharterKeepRoutes(routeIds) {
  const ids = [...new Set(Array.from(routeIds || [], String).filter(Boolean))];
  // Cập nhật match cache trước khi refresh list - để isCharterFullyCovered đúng.
  if (activeCharterRequest?.requestId) {
    activeCharterRequest._savedMatch = buildCharterPathFromSavedRoutes(activeCharterRequest.stops);
  }
  clearActiveCharterRequest({ refresh: true });
  if (!ids.length) return;
  showSavedRoutes = true;
  applySavedRoutesVisibility();
  applySelectedRouteHighlight(ids[0]);
  if (mapLegendSelectEl) {
    mapLegendSelectEl.value = ids[0];
    selectedRouteId = ids[0];
    updateLegendSwatch();
  }
  showSelectedRouteStops(ids[0]);
  // Refresh danh sách charter request - ẩn những cái đã đủ tuyến.
  await loadCharterRequests();
}

function clearActiveCharterRequest({ refresh = false } = {}) {
  activeCharterRequest = null;
  activeCharterLeg = null;
  clearCharterMapLayers({ resetFlags: true });
  // Bỏ chọn → cờ về màu thường, xóa path gắn tạm, reset bến form.
  if (!recordingActive && !lockedSurveyPath) {
    clearCapturePoints();
    setStationComboValue('start', '', { emitChange: false });
    setStationComboValue('end', '', { emitChange: false });
    selectedStartStationId = '';
    selectedEndStationId = '';
    syncEndStationDisplay?.();
    if (captureRouteCodeEl) captureRouteCodeEl.value = '';
    if (captureRouteNameEl) captureRouteNameEl.value = '';
    if (latest?.stations) renderStations(latest.stations);
  }
  clearCharterMatchedRouteHighlight();
  updateCharterActiveBanner();
  updateRouteTypeHint();
  checkRouteCodeDuplicate();
  if (refresh) loadCharterRequests();
}

/**
 * Lấy routeId để hiện khi chọn CB: tìm theo từng cặp 2 mã bến của chặng.
 * Ví dụ BD→TNC, TNC→BS → chỉ hiện route đúng 2 bến đó.
 */
function collectCharterOwnedRouteIds(detail, savedMatch = null) {
  const ids = new Set();
  const add = (value) => {
    const id = String(value || '').trim();
    if (id) ids.add(id);
  };

  const ordered = charterStopsAsOrdered(detail?.stops);
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const exact = findExactRouteForStationPair(ordered[i], ordered[i + 1]);
    if (exact?.routeId) add(exact.routeId);
  }

  // Matched legs đã gắn exactPair từ findSavedSegmentBetween.
  for (const leg of [...(savedMatch?.matchedLegs || []), ...(savedMatch?.laterMatched || [])]) {
    if (leg?.exactPair && leg.routeId) add(leg.routeId);
  }

  // Candidate / result từ BE (nếu có).
  add(detail?.resultRouteId);
  add(detail?.resultRoute?.routeId || detail?.resultRoute?.id);
  add(detail?.candidateRouteId);
  add(candidateRouteId(detail));
  for (const leg of detail?.candidateLegs || []) {
    add(leg?.routeId || leg?.selectedRouteId || leg?.resultRouteId);
    for (const cand of leg?.candidates || []) {
      add(cand?.routeId || cand?.id);
    }
  }
  return [...ids];
}

/** Hiện map theo CB: chỉ route khớp 2 mã bến từng chặng. */
function highlightCharterMatchedRoutes(savedMatch, detail = activeCharterRequest) {
  const ownedIds = collectCharterOwnedRouteIds(detail, savedMatch);
  setCharterRouteFilter(ownedIds);
  if (showSavedRoutesBeforeCharter == null) {
    showSavedRoutesBeforeCharter = showSavedRoutes;
  }
  showSavedRoutes = true;
  applySavedRoutesVisibility();
  applySelectedRouteHighlight(ownedIds[0] || selectedRouteId || '');
  if (mapLegendSelectEl) {
    if (ownedIds[0]) {
      mapLegendSelectEl.value = ownedIds[0];
      selectedRouteId = ownedIds[0];
    } else {
      mapLegendSelectEl.value = '';
      selectedRouteId = '';
    }
    updateLegendSwatch();
  }
}

function setCharterRouteFilter(ids) {
  charterRouteFilterIds = new Set((ids || []).map(String).filter(Boolean));
}

function clearCharterRouteFilter({ restoreToggle = true } = {}) {
  charterRouteFilterIds = null;
  if (restoreToggle && showSavedRoutesBeforeCharter != null) {
    showSavedRoutes = showSavedRoutesBeforeCharter;
    showSavedRoutesBeforeCharter = null;
  }
}

function clearCharterMatchedRouteHighlight() {
  clearCharterRouteFilter({ restoreToggle: true });
  applySelectedRouteHighlight(selectedRouteId || '');
  applySavedRoutesVisibility();
}

async function completeCharterRequest(requestId, routeId) {
  if (!requestId || !routeId) return false;
  try {
    const response = await fetch(
      `/api/charter/route-draw-requests/${encodeURIComponent(requestId)}/complete`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ routeId }),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Complete HTTP ${response.status}`);
    notifyOk('Complete charter OK');
    return true;
  } catch (error) {
    notifyErr(`Complete charter thất bại: ${error.message}`);
    return false;
  }
}

async function openCharterRequest(requestId) {
  if (!requestId) return;
  try {
    const detailRes = await fetch(`/api/charter/route-draw-requests/${encodeURIComponent(requestId)}`);
    const detail = await detailRes.json();
    if (!detailRes.ok) throw new Error(detail.error || `HTTP ${detailRes.status}`);

    // BE spec: mở request → in-progress
    fetch(`/api/charter/route-draw-requests/${encodeURIComponent(requestId)}/in-progress`, {
      method: 'PATCH',
    }).catch(() => {});

    activeCharterRequest = detail;
    activeCharterLeg = null;
    detail._legQueue = [];
    detail._legIndex = 0;
    clearCharterMapLayers({ resetFlags: true });

    if (recordingActive || lockedSurveyPath) {
      notifyWarn('Đang ghi/khóa path — chỉ nổi bến charter, không đổi bản vẽ hiện tại.');
      renderCharterStopPins(detail.stops || []);
      const preview = candidateRouteCoordinates(detail);
      // Vẫn ẩn route không thuộc CB.
      const matchWhileLocked = buildCharterPathFromSavedRoutes(detail.stops || []);
      detail._savedMatch = matchWhileLocked;
      highlightCharterMatchedRoutes(matchWhileLocked);
      if (preview.length >= 2) renderCharterCandidatePreview(preview);
      updateCharterActiveBanner();
      return;
    }

    clearCapturePoints();
    applyCharterStationsToForm(detail.stops || []);
    renderCharterStopPins(detail.stops || []);

    // Route đã có → CHỈ HIỆN route của CB. Không nạp vào bản vẽ / không chỉnh lại.
    const beCoords = candidateRouteCoordinates(detail);
    let savedMatch = null;
    if (beCoords.length >= 2) {
      // Chỉ hiện route thuộc CB (nếu đã có); ẩn toàn bộ tuyến survey khác.
      setCharterRouteFilter(collectCharterOwnedRouteIds(detail));
      if (showSavedRoutesBeforeCharter == null) {
        showSavedRoutesBeforeCharter = showSavedRoutes;
      }
      showSavedRoutes = true;
      applySavedRoutesVisibility();
      applySelectedRouteHighlight(selectedRouteId || '');
      renderCharterCandidatePreview(beCoords);
      captureStatusEl.textContent = 'Charter: đã có candidate — chỉ hiện route CB, ẩn tuyến khác.';
      notifyOk('Đã hiện route CB (ẩn tuyến khác)');
      updateCharterActiveBanner();
      updateWorkflow('draw');
      return;
    }

    savedMatch = buildCharterPathFromSavedRoutes(detail.stops || []);
    detail._savedMatch = savedMatch;
    activeCharterRequest._savedMatch = savedMatch;
    highlightCharterMatchedRoutes(savedMatch);
    (savedMatch.matchedLegs || []).forEach((leg) => {
      if (leg.coords?.length >= 2) renderCharterCandidatePreview(leg.coords);
    });
    (savedMatch.laterMatched || []).forEach((leg) => {
      if (leg.coords?.length >= 2) renderCharterCandidatePreview(leg.coords);
    });

    if (savedMatch.matchedLegs?.length && !savedMatch.missingLegs?.length) {
      // Đủ tuyến → thoát chế độ charter, chỉ để lại tuyến trên map.
      const ok = savedMatch.matchedLegs.map((l) => `${l.label} (${l.routeCode})`).join(', ');
      const code = detail.bookingCode || detail.bookingId || requestId;
      const ids = collectCharterOwnedRouteIds(detail, savedMatch);
      setDrawTool('pan');
      exitCharterKeepRoutes(ids);
      captureStatusEl.textContent = `Charter ${code}: đã đủ tuyến (${ok}) — không còn việc vẽ.`;
      notifyOk(`${code} đã đủ tuyến — đã bỏ khỏi danh sách`);
      return;
    } else if (savedMatch.missingLegs?.length) {
      const miss = savedMatch.missingLegs.map((l) => l.label).join(', ');
      const ok = savedMatch.matchedLegs.map((l) => `${l.label} (${l.routeCode})`).join(', ');
      // Vẽ & gửi từng chặng: mỗi route chỉ 2 bến, hết chặng này mới sang chặng sau.
      activeCharterRequest._legQueue = savedMatch.missingLegs;
      activeCharterRequest._legIndex = 0;
      activeCharterLeg = savedMatch.missingLegs[0];
      applyCharterLegToForm(savedMatch.missingLegs[0], savedMatch.missingLegs.length);
      updateStopChainPreview();
      setDrawTool('draw');
      const first = savedMatch.missingLegs[0].label;
      captureStatusEl.textContent = ok
        ? `Charter: có sẵn ${ok} (chỉ hiện). Chặng 1/${savedMatch.missingLegs.length} cần vẽ: ${first}`
        : `Charter: chặng 1/${savedMatch.missingLegs.length} — vẽ ${first} (1 route = 2 bến).`;
      notifyInfo(savedMatch.missingLegs.length > 1
        ? `Còn thiếu ${savedMatch.missingLegs.length} chặng (${miss}) — vẽ & lưu từng chặng`
        : `Chỉ vẽ đoạn thiếu: ${miss}`);
    } else {
      setDrawTool('draw');
      captureStatusEl.textContent = 'Charter: chỉ có bến — vẽ đường giữa các bến rồi ghi GPS.';
      notifyInfo('Chưa có path sẵn — hãy vẽ tuyến giữa các bến');
    }
    updateCharterActiveBanner();
    updateWorkflow('draw');
    updateStopChainPreview();
    // Cuộn panel "Thiết lập tuyến" vào view để user thấy bảng chặng ngay.
    const sec = document.getElementById('captureSection');
    if (sec && sec.scrollIntoView) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    notifyErr(`Mở yêu cầu charter thất bại: ${error.message}`);
  }
}

/** Đủ tuyến = BE đã gắn resultRoute, hoặc mọi chặng 2 bến đều có route trong DB. */
function isCharterFullyCovered(item) {
  const has = (v) => v != null && v !== '' && v !== false;
  if (has(item?.resultRouteId) || has(item?.resultRoute)) return true;
  const ordered = charterStopsAsOrdered(item?.stops);
  if (ordered.length < 2) return false;
  const match = buildCharterPathFromSavedRoutes(item.stops);
  return Boolean(match.matchedLegs?.length) && !match.missingLegs?.length;
}

/** Trạng thái tuyến của 1 yêu cầu charter (dựa field list/detail của BE). */
function charterRouteState(item) {
  const has = (v) => v != null && v !== '' && v !== false;
  const hasResult = has(item?.resultRouteId) || has(item?.resultRoute);
  const hasCandidate = has(item?.candidateRouteId) || has(item?.candidateRoute)
    || (Array.isArray(item?.candidateLegs)
      && item.candidateLegs.some((leg) => Array.isArray(leg?.candidates) && leg.candidates.length));
  if (hasResult) return { label: '✓ Đã vẽ xong', cls: 'is-done' };
  if (hasCandidate) return { label: 'Có tuyến gợi ý', cls: 'is-candidate' };
  return { label: 'Chưa có tuyến', cls: 'is-empty-route' };
}

function renderCharterRequestList(items) {
  if (!charterRequestListEl) return;
  const all = Array.isArray(items) ? items : [];
  // Đủ tuyến rồi thì không còn việc để vẽ — bỏ khỏi danh sách.
  const covered = all.filter((item) => {
    const id = item.requestId || item.id;
    return charterDoneRequestIds.has(id) || isCharterFullyCovered(item);
  });
  const list = all.filter((item) => {
    const id = item.requestId || item.id;
    return !charterDoneRequestIds.has(id) && !isCharterFullyCovered(item);
  });
  const coveredNote = covered.length
    ? `<li class="charter-request-empty">${covered.length} yêu cầu đã đủ tuyến — đã ẩn.</li>`
    : '';
  if (!list.length) {
    charterRequestListEl.classList.add('is-empty');
    charterRequestListEl.innerHTML = coveredNote
      || '<li class="charter-request-empty">Không có yêu cầu cần vẽ (Pending / InProgress).</li>';
    return;
  }
  charterRequestListEl.classList.remove('is-empty');
  charterRequestListEl.innerHTML = coveredNote + list.map((item) => {
    const id = item.requestId || item.id || '';
    const code = item.bookingCode || item.bookingId || id;
    const stopCount = Array.isArray(item.stops) ? item.stops.length : (item.stopCount || '');
    const stopsHint = stopCount ? `${stopCount} bến` : 'mở để xem bến';
    const route = charterRouteState(item);
    const st = String(item.status || 'Pending');
    return `
      <li>
        <button type="button" class="charter-request-item${activeCharterRequest?.requestId === id ? ' is-active' : ''}" data-request-id="${escapeHtml(id)}" title="${escapeHtml(id)}">
          <span class="charter-request-code">${escapeHtml(code)}</span>
          <span class="charter-status ${route.cls}">${escapeHtml(route.label)}</span>
          <span class="charter-request-meta">${escapeHtml(st)} · ${escapeHtml(stopsHint)}</span>
        </button>
      </li>
    `;
  }).join('');
  charterRequestListEl.querySelectorAll('.charter-request-item').forEach((btn) => {
    btn.addEventListener('click', () => openCharterRequest(btn.dataset.requestId));
  });
}

/** Xóa ngay 1 request khỏi DOM panel (khi đã đủ tuyến → không chờ server refresh). */
function removeCharterRequestFromList(requestId) {
  if (!requestId || !charterRequestListEl) return;
  const btn = charterRequestListEl.querySelector(`.charter-request-item[data-request-id="${CSS.escape(requestId)}"]`);
  if (btn) {
    const li = btn.closest('li');
    if (li) li.remove();
    else btn.remove();
  }
  // Nếu rỗng → hiện placeholder.
  if (!charterRequestListEl.querySelector('.charter-request-item')) {
    charterRequestListEl.classList.add('is-empty');
    charterRequestListEl.innerHTML = '<li class="charter-request-empty">Không còn yêu cầu charter nào.</li>';
  }
}

/**
 * Poll server cho tới khi BE xác nhận request đã không còn ở Pending/InProgress
 * (tức đã chuyển Done/Completed). Gọi loadCharterRequests ở mỗi tick — filter localStorage
 * sẽ giữ request ẩn đến khi server sẵn sàng, rồi render lần cuối lấy trạng thái thật.
 */
function pollCharterRequestUntilGone(requestId, attempt = 0) {
  if (!requestId) return;
  const max = 12;
  const delay = Math.min(1500 + attempt * 500, 4000);
  setTimeout(async () => {
    try {
      const [pending, inProgress] = await Promise.all([
        fetchCharterListByStatus('Pending'),
        fetchCharterListByStatus('InProgress'),
      ]);
      const byId = new Map();
      for (const item of [...pending, ...inProgress]) {
        const id = item.requestId || item.id;
        if (id) byId.set(id, item);
      }
      if (!byId.has(requestId)) {
        // BE confirm: request không còn ở Pending/InProgress → render từ server.
        await loadCharterRequests();
        return;
      }
    } catch (error) {
      // ignore — sẽ retry.
    }
    if (attempt < max) {
      pollCharterRequestUntilGone(requestId, attempt + 1);
    } else {
      // Hết retry → render lại lần cuối.
      loadCharterRequests().catch(() => {});
    }
  }, delay);
}

async function fetchCharterListByStatus(status) {
  const response = await fetch(`/api/charter/route-draw-requests?status=${encodeURIComponent(status)}`);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return Array.isArray(body.items) ? body.items : [];
}

async function loadCharterRequests() {
  if (!charterRequestListEl) return;
  // Mở request → BE chuyển InProgress; nếu chỉ poll Pending thì reload sẽ trống.
  charterRequestListEl.classList.add('is-empty');
  charterRequestListEl.innerHTML = '<li class="charter-request-empty">Đang tải yêu cầu…</li>';
  try {
    const [pending, inProgress] = await Promise.all([
      fetchCharterListByStatus('Pending'),
      fetchCharterListByStatus('InProgress'),
    ]);
    const byId = new Map();
    for (const item of [...pending, ...inProgress]) {
      const id = item.requestId || item.id;
      if (id) byId.set(id, item);
    }
    const merged = [...byId.values()].sort((a, b) => (
      String(b.createdAt || b.inProgressAt || '').localeCompare(String(a.createdAt || a.inProgressAt || ''))
    ));
    renderCharterRequestList(merged);
  } catch (error) {
    charterRequestListEl.innerHTML = `<li class="charter-request-empty">Lỗi: ${escapeHtml(error.message)}</li>`;
  }
}

charterRefreshBtnEl?.addEventListener('click', () => loadCharterRequests());
charterClearBtnEl?.addEventListener('click', () => clearActiveCharterRequest());
charterNextLegBtnEl?.addEventListener('click', async () => {
  if (!activeCharterRequest?.requestId) return;
  const queue = charterLegQueue();
  const idx = Number(activeCharterRequest._legIndex) || 0;
  if (idx >= queue.length - 1) {
    const doneId = activeCharterRequest.requestId;
    const doneCode = activeCharterRequest.bookingCode || doneId;
    // Báo BE ẩn khỏi queue Pending/InProgress (FE khác/reload sẽ không thấy nữa).
    fetch(`/api/charter/route-draw-requests/${encodeURIComponent(doneId)}/acknowledge`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(() => {});
    // Lưu local + ẩn DOM ngay.
    charterDoneRequestIds.add(doneId);
    localStorage.setItem('charterDoneIds', JSON.stringify([...charterDoneRequestIds]));
    removeCharterRequestFromList(doneId);
    notifyOk(`CB ${doneCode} đã đủ tuyến — đã báo BE, ẩn khỏi danh sách`);
    activeCharterRequest = null;
    activeCharterLeg = null;
    updateCharterActiveBanner();
    loadCharterRequests().catch(() => {});
    return;
  }
  advanceCharterLeg();
});

loadCharterRequests();

renderCaptureState();
