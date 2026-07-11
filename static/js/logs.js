// yt-dlp 插件日志查看器（设置页内）

const LOGAPI = window.SongloftPlugin || {
  apiGet: (p) => fetch(p).then(r => r.json()),
  apiPost: (p, b) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()),
};

let logEntries = [];
let logAutoTimer = null;

function fmtLogTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const pad = (n) => n.toString().padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return '';
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderLogs() {
  const viewer = document.getElementById('log-viewer');
  const emptyEl = document.getElementById('log-empty');
  if (!viewer) return;

  const filter = document.getElementById('log-level-filter')?.value || '';
  const filtered = filter ? logEntries.filter(e => e.level === filter) : logEntries;

  if (!filtered.length) {
    viewer.innerHTML = '<div class="log-empty">暂无日志</div>';
    return;
  }

  // 是否已滚动到底部（渲染后保持贴底）
  const atBottom = viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 40;

  const html = filtered.map(e => {
    const lvl = (e.level || 'info').toLowerCase();
    return `<div class="log-line log-${lvl}">` +
      `<span class="log-time">${fmtLogTime(e.ts)}</span>` +
      `<span class="log-level-tag">${escapeHtml(lvl.toUpperCase())}</span>` +
      `<span class="log-msg">${escapeHtml(e.msg)}</span>` +
      `</div>`;
  }).join('');
  viewer.innerHTML = html;

  if (atBottom) viewer.scrollTop = viewer.scrollHeight;
}

async function loadLogs() {
  try {
    const resp = await LOGAPI.apiGet('/api/logs');
    logEntries = Array.isArray(resp) ? resp : (resp.logs || []);
    renderLogs();
  } catch (e) {
    const viewer = document.getElementById('log-viewer');
    if (viewer) viewer.innerHTML = `<div class="log-empty">加载日志失败：${escapeHtml(e.message || e)}</div>`;
  }
}

async function clearLogs() {
  try {
    await LOGAPI.apiPost('/api/logs/clear', {});
    logEntries = [];
    renderLogs();
  } catch (e) {
    // ignore
  }
}

function setAutoRefresh(on) {
  const btn = document.getElementById('btn-log-auto');
  if (on) {
    if (logAutoTimer) return;
    logAutoTimer = setInterval(loadLogs, 3000);
    btn?.classList.add('active');
    loadLogs();
  } else {
    if (logAutoTimer) { clearInterval(logAutoTimer); logAutoTimer = null; }
    btn?.classList.remove('active');
  }
}

// --- 事件绑定 ---
document.getElementById('btn-log-refresh')?.addEventListener('click', loadLogs);
document.getElementById('btn-log-clear')?.addEventListener('click', clearLogs);
document.getElementById('btn-log-auto')?.addEventListener('click', () => setAutoRefresh(!logAutoTimer));
document.getElementById('log-level-filter')?.addEventListener('change', renderLogs);

// 切到「设置」页时自动加载一次；切走时停止自动刷新
document.querySelectorAll('.tab-item').forEach(tab => {
  tab.addEventListener('click', () => {
    if (tab.dataset.tab === 'settings') {
      loadLogs();
    } else if (logAutoTimer) {
      setAutoRefresh(false);
    }
  });
});
