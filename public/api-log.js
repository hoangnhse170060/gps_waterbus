const listEl = document.querySelector('#callList');
const summaryEl = document.querySelector('#summary');
const filterSelectEl = document.querySelector('#filterSelect');
const refreshBtn = document.querySelector('#refreshBtn');
const clearBtn = document.querySelector('#clearBtn');

let calls = [];

async function loadCalls() {
  summaryEl.textContent = 'Đang tải…';
  try {
    const response = await fetch('/api/debug/calls');
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Không tải được log');
    calls = Array.isArray(body.calls) ? body.calls : [];
    render();
  } catch (error) {
    summaryEl.textContent = `Lỗi: ${error.message}`;
    listEl.innerHTML = '';
  }
}

function matchesFilter(call, filter) {
  if (filter === 'all') return true;
  if (filter === 'error') return !call.ok;
  if (filter === 'from-gps') return String(call.path || '').includes('from-gps');
  if (filter === 'session') return String(call.path || '').includes('tracking/sessions');
  return true;
}

function render() {
  const filter = filterSelectEl.value;
  const visible = calls.filter((call) => matchesFilter(call, filter));
  const errors = calls.filter((call) => !call.ok).length;
  const fromGps = calls.filter((call) => String(call.path || '').includes('from-gps')).length;

  summaryEl.innerHTML = `
    <span>Tổng: <b>${calls.length}</b></span>
    <span>Đang hiện: <b>${visible.length}</b></span>
    <span>Lỗi: <b>${errors}</b></span>
    <span>from-gps: <b>${fromGps}</b></span>
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
    return `
      <article class="api-call${!call.ok ? ' is-error' : ''}" data-id="${escapeHtml(call.id)}">
        <div class="api-call-head">
          <span class="api-badge ${okClass}">${okLabel} ${call.status ?? ''}</span>
          <span class="api-method">${escapeHtml(call.method || 'POST')}</span>
          <span class="api-path">${escapeHtml(call.path || '')}</span>
          <span class="api-time">${escapeHtml(time)}</span>
          ${err}
        </div>
        <div class="api-call-body">
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
      head.parentElement.classList.toggle('is-open');
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

refreshBtn.addEventListener('click', loadCalls);
filterSelectEl.addEventListener('change', render);
clearBtn.addEventListener('click', async () => {
  if (!confirm('Xóa toàn bộ log API trong bộ nhớ server?')) return;
  await fetch('/api/debug/calls', { method: 'DELETE' });
  await loadCalls();
});

loadCalls();
setInterval(loadCalls, 5000);
