const listEl = document.querySelector('#callList');
const summaryEl = document.querySelector('#summary');
const filterSelectEl = document.querySelector('#filterSelect');
const refreshBtn = document.querySelector('#refreshBtn');
const clearBtn = document.querySelector('#clearBtn');
const autoRefreshEl = document.querySelector('#autoRefresh');

let calls = [];
/** Giữ các log đang mở — tránh auto-refresh đóng request body đang xem. */
const openIds = new Set();
let autoRefresh = true;

async function loadCalls({ silent = false } = {}) {
  if (!silent) summaryEl.textContent = 'Đang tải…';
  try {
    const response = await fetch('/api/debug/calls');
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Không tải được log');
    calls = Array.isArray(body.calls) ? body.calls : [];
    // Lần đầu / log lỗi mới → mặc định mở để xem (không tự đóng).
    for (const call of calls) {
      if (call?.id && call.ok === false) openIds.add(call.id);
    }
    render();
  } catch (error) {
    summaryEl.textContent = `Lỗi: ${error.message}`;
    listEl.innerHTML = '';
  }
}

function isFromGps(call) {
  return String(call.path || '').includes('from-gps');
}

function isSessionStart(call) {
  return String(call.path || '').includes('tracking/sessions/start');
}

function reverseInfo(call) {
  const req = call?.request && typeof call.request === 'object' ? call.request : {};
  const res = call?.response && typeof call.response === 'object' ? call.response : {};
  const asked = Boolean(req.createReverseRoute);
  const reverseCode = req.reverseRouteCode || null;
  const reverseName = req.reverseRouteName || null;
  const created = res.reverseRoute && typeof res.reverseRoute === 'object'
    ? res.reverseRoute
    : null;
  return { asked, reverseCode, reverseName, created };
}

function matchesFilter(call, filter) {
  if (filter === 'all') return true;
  if (filter === 'error') return !call.ok;
  if (filter === 'from-gps') return isFromGps(call);
  if (filter === 'reverse') {
    const info = reverseInfo(call);
    return isFromGps(call) && (info.asked || info.created);
  }
  if (filter === 'session') return String(call.path || '').includes('tracking/sessions');
  return true;
}

function reverseBadgeHtml(call) {
  if (!isFromGps(call)) {
    if (isSessionStart(call) && !call.ok) {
      return '<span class="api-reverse is-blocked">Chiếu về: chưa gọi được — session start lỗi → from-gps bỏ qua</span>';
    }
    return '';
  }

  const info = reverseInfo(call);
  if (!info.asked && !info.created) {
    return '<span class="api-reverse is-off">Chiếu về: không gửi createReverseRoute</span>';
  }
  if (info.created) {
    const code = info.created.routeCode || info.created.code || info.reverseCode || '?';
    const id = info.created.routeId || info.created.id || '';
    return `<span class="api-reverse is-ok">Bản sao chiều về: ĐÃ TẠO <b>${escapeHtml(code)}</b>${id ? ` · id ${escapeHtml(id)}` : ''}</span>`;
  }
  if (call.ok) {
    return `<span class="api-reverse is-warn">Đã gửi reverse <b>${escapeHtml(info.reverseCode || '?')}</b> nhưng BE không trả reverseRoute</span>`;
  }
  return `<span class="api-reverse is-err">Gửi reverse <b>${escapeHtml(info.reverseCode || '?')}</b> — lỗi, bản sao chưa lên BE</span>`;
}

function reversePanelHtml(call) {
  if (!isFromGps(call)) return '';
  const info = reverseInfo(call);
  if (!info.asked && !info.created) return '';

  const lines = [
    `createReverseRoute: ${info.asked ? 'true' : 'false'}`,
    `reverseRouteCode gửi lên: ${info.reverseCode || '(không có)'}`,
    `reverseRouteName gửi lên: ${info.reverseName || '(không có)'}`,
  ];
  if (info.created) {
    lines.push(`BE trả reverseRoute.routeCode: ${info.created.routeCode || info.created.code || '?'}`);
    lines.push(`BE trả reverseRoute.routeId: ${info.created.routeId || info.created.id || '?'}`);
    lines.push('Kết luận: BẢN SAO ĐÃ LÊN BE');
  } else if (call.ok) {
    lines.push('Kết luận: gửi reverse nhưng response không có reverseRoute');
  } else {
    lines.push(`Kết luận: CHƯA LÊN BE — ${call.error || `HTTP ${call.status}`}`);
  }

  return `
    <div class="api-block api-reverse-panel">
      <h3>Bản sao / chiều về</h3>
      <pre>${escapeHtml(lines.join('\n'))}</pre>
    </div>
  `;
}

function captureOpenState() {
  for (const el of listEl.querySelectorAll('.api-call')) {
    const id = el.dataset.id;
    if (!id) continue;
    if (el.classList.contains('is-open')) openIds.add(id);
    else openIds.delete(id);
  }
}

function render() {
  captureOpenState();
  const filter = filterSelectEl.value;
  const visible = calls.filter((call) => matchesFilter(call, filter));
  const errors = calls.filter((call) => !call.ok).length;
  const fromGps = calls.filter((call) => isFromGps(call)).length;
  const reverseAsked = calls.filter((call) => isFromGps(call) && reverseInfo(call).asked).length;
  const reverseCreated = calls.filter((call) => isFromGps(call) && reverseInfo(call).created).length;
  const sessionFails = calls.filter((call) => isSessionStart(call) && !call.ok).length;

  summaryEl.innerHTML = `
    <span>Tổng: <b>${calls.length}</b></span>
    <span>Đang hiện: <b>${visible.length}</b></span>
    <span>Lỗi: <b>${errors}</b></span>
    <span>from-gps: <b>${fromGps}</b></span>
    <span>Gửi chiều về: <b>${reverseAsked}</b></span>
    <span>BE tạo bản sao: <b>${reverseCreated}</b></span>
    ${sessionFails ? `<span class="api-sum-warn">session start lỗi: <b>${sessionFails}</b> → from-gps/chiều về chưa chạy</span>` : ''}
    <span class="api-sum-hint">${autoRefresh ? 'Auto-refresh: bật (giữ dòng đang mở)' : 'Auto-refresh: tắt'}</span>
  `;

  if (!visible.length) {
    listEl.innerHTML = '<div class="api-empty">Chưa có log. Chạy ghi GPS + lưu (Azure BE bật) rồi bấm Làm mới.</div>';
    return;
  }

  listEl.innerHTML = visible.map((call) => {
    const okClass = call.ok ? 'ok' : 'err';
    const okLabel = call.ok ? 'OK' : 'LỖI';
    const time = formatTime(call.at);
    const err = call.error ? `<div class="api-error-line">${escapeHtml(call.error)}</div>` : '';
    const reverseBadge = reverseBadgeHtml(call);
    const isOpen = openIds.has(call.id);
    return `
      <article class="api-call${!call.ok ? ' is-error' : ''}${isOpen ? ' is-open' : ''}" data-id="${escapeHtml(call.id)}">
        <div class="api-call-head">
          <span class="api-badge ${okClass}">${okLabel} ${call.status ?? ''}</span>
          <span class="api-method">${escapeHtml(call.method || 'POST')}</span>
          <span class="api-path">${escapeHtml(call.path || '')}</span>
          <span class="api-time">${escapeHtml(time)}</span>
          ${err}
          ${reverseBadge ? `<div class="api-reverse-row">${reverseBadge}</div>` : ''}
        </div>
        <div class="api-call-body">
          ${reversePanelHtml(call)}
          <div class="api-block">
            <h3>Request body (đã rút gọn coordinates)</h3>
            <pre>${escapeHtml(stringify(call.request))}</pre>
          </div>
          <div class="api-block">
            <h3>Response</h3>
            <pre>${escapeHtml(stringify(call.response))}</pre>
          </div>
          ${call.url ? `<div class="api-block"><h3>URL</h3><pre>${escapeHtml(call.url)}</pre></div>` : ''}
        </div>
      </article>
    `;
  }).join('');

  for (const head of listEl.querySelectorAll('.api-call-head')) {
    head.addEventListener('click', () => {
      const article = head.parentElement;
      article.classList.toggle('is-open');
      const id = article.dataset.id;
      if (!id) return;
      if (article.classList.contains('is-open')) openIds.add(id);
      else openIds.delete(id);
    });
  }
}

function stringify(value) {
  if (value == null) return '(empty)';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTime(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString('vi-VN');
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

refreshBtn.addEventListener('click', () => loadCalls());
filterSelectEl.addEventListener('change', render);
clearBtn.addEventListener('click', async () => {
  if (!confirm('Xóa toàn bộ log API trong bộ nhớ server?')) return;
  openIds.clear();
  await fetch('/api/debug/calls', { method: 'DELETE' });
  await loadCalls();
});

autoRefreshEl?.addEventListener('change', () => {
  autoRefresh = Boolean(autoRefreshEl.checked);
  render();
});

loadCalls();
setInterval(() => {
  if (autoRefresh) loadCalls({ silent: true });
}, 5000);
