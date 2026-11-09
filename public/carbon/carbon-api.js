'use strict';

window.__CARBON_API__ = true;

/* Carbon SPA API bridge. Keeps the final layout while using the real panel API. */

const carbon = {
  user: '',
  role: 'admin',
  stats: [],
  clients: [],
  modules: [],
  services: [],
  security: null,
  interfaces: [],
  update: null,
  server: null,
  sys: null,
  loaded: false,
  chartRange: '1h',
  history: null,
  distribution: null,
  cascadeInterfaces: null,
  cascadeSchedule: null,
  iptables: null,
  toolsStatus: null,
  fail2ban: null,
  warp: null
};

async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', ...options };
  if (opts.body && typeof opts.body !== 'string') {
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    if (res.status === 401) showCarbonLogin();
    const raw = (data && data.error) || (typeof data === 'string' ? data : 'Ошибка запроса');
    const msg = String(raw).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
    throw new Error(msg || 'Ошибка запроса');
  }
  return data;
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1099511627776) return (v / 1099511627776).toFixed(2) + ' TB';
  if (v >= 1073741824) return (v / 1073741824).toFixed(2) + ' GB';
  if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
  return v + ' B';
}

function escHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toLocaleDateString('ru-RU');
}

function fmtUptime(seconds) {
  const total = Number(seconds) || 0;
  if (total <= 0) return '—';
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  return [d ? d + 'д' : '', h ? h + 'ч' : '', m ? m + 'м' : ''].filter(Boolean).join(' ') || '—';
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'servpanel.conf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function downloadRequest(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  if (!res.ok) {
    if (res.status === 401) showCarbonLogin();
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Ошибка загрузки файла');
  }
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  return { blob: await res.blob(), filename: m ? decodeURIComponent(m[1]) : '' };
}

function showCarbonLog(title, text) {
  let modal = document.getElementById('carbonLogModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'carbonLogModal';
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-card modal-wide">
      <div class="modal-head"><div><div class="modal-title">Журнал</div><div class="modal-sub"></div></div>
      <button class="icon-btn" data-carbon-close-log aria-label="Закрыть">✕</button></div>
      <pre class="code" style="margin:0;max-height:60vh;overflow:auto;padding:12px;white-space:pre-wrap"></pre>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('[data-carbon-close-log]').addEventListener('click', () => { modal.hidden = true; });
  }
  modal.querySelector('.modal-title').textContent = title || 'Журнал';
  modal.querySelector('.modal-sub').textContent = '';
  modal.querySelector('pre').textContent = text || 'Пусто';
  modal.hidden = false;
}

function applyShellData() {
  const users = (carbon.users && carbon.users.users) || [];
  const current = (carbon.users && carbon.users.current) || carbon.user || '';
  if (current) carbon.user = current;
  const me = users.find(u => u.username === carbon.user);
  if (me && me.role) carbon.role = me.role;
  const initial = (carbon.user || '?').slice(0, 1).toUpperCase();
  document.querySelectorAll('.nav-count').forEach(el => { el.textContent = String(carbon.clients.length); });
  document.querySelectorAll('.user-name').forEach(el => { el.textContent = carbon.user || '—'; });
  document.querySelectorAll('.user-role').forEach(el => { el.textContent = carbon.role || '—'; });
  document.querySelectorAll('.avatar').forEach(el => { el.textContent = initial; });
}

function bindMobileMenu() {
  const btn = document.getElementById('mobileMenuBtn');
  const backdrop = document.getElementById('sidebarBackdrop');
  const close = () => document.body.classList.remove('menu-open');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', event => {
      event.preventDefault();
      document.body.classList.toggle('menu-open');
    });
  }
  if (backdrop && !backdrop.dataset.bound) {
    backdrop.dataset.bound = '1';
    backdrop.addEventListener('click', close);
  }
  document.querySelectorAll('.sidebar .nav-item, .sidebar .user-chip a').forEach(el => {
    if (el.dataset.menuBound) return;
    el.dataset.menuBound = '1';
    el.addEventListener('click', () => { if (window.innerWidth <= 900) close(); });
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
}

function bindGlobalSearch() {
  const input = document.getElementById('globalSearch');
  if (!input || input.dataset.bound) return;
  input.dataset.bound = '1';
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    const q = input.value.trim().toLowerCase();
    if (!q) return;
    const nav = [...document.querySelectorAll('.nav-item[data-tab]')]
      .find(b => (b.textContent || '').toLowerCase().includes(q));
    if (nav) { input.value = ''; nav.click(); return; }
    const client = (carbon.clients || []).find(c =>
      String(c.name || '').toLowerCase().includes(q) || String(c.ip || '').toLowerCase().includes(q));
    if (client) {
      input.value = '';
      document.querySelector('.nav-item[data-tab="clients"]')?.click();
      setTimeout(() => {
        const search = document.getElementById('clientSearch');
        if (search) {
          search.value = client.name;
          search.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, 60);
      return;
    }
    showToast('Ничего не найдено');
  });
}

function showCarbonLogin() {
  let modal = document.getElementById('carbonLogin');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'carbonLogin';
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-card">
      <div class="modal-head"><div><div class="modal-title">Вход в Servpanel</div><div class="modal-sub">Carbon-интерфейс использует ту же сессию панели.</div></div></div>
      <div class="form-grid" style="grid-template-columns:1fr">
        <label class="field"><span>Логин</span><input id="carbonUser" value="admin" autocomplete="username"></label>
        <label class="field"><span>Пароль</span><input id="carbonPass" type="password" autocomplete="current-password"></label>
        <label class="field"><span>Код 2FA</span><input id="carbonCode" inputmode="numeric" placeholder="Если включена"></label>
      </div>
      <div id="carbonLoginError" style="color:var(--bad);font-size:12px;margin-top:10px;display:none"></div>
      <div class="modal-actions"><button class="btn" onclick="location.href='/'">Старая панель</button><button class="btn btn-primary" id="carbonLoginBtn">Войти</button></div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#carbonLoginBtn').addEventListener('click', carbonLogin);
    modal.querySelector('#carbonPass').addEventListener('keydown', e => { if (e.key === 'Enter') carbonLogin(); });
  }
  modal.hidden = false;
  setTimeout(() => document.getElementById('carbonPass')?.focus(), 0);
}

async function carbonLogin() {
  const err = document.getElementById('carbonLoginError');
  const btn = document.getElementById('carbonLoginBtn');
  err.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Вход…';
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: {
        username: document.getElementById('carbonUser').value.trim() || 'admin',
        password: document.getElementById('carbonPass').value,
        code: document.getElementById('carbonCode').value.trim()
      }
    });
    carbon.user = data.user || 'admin';
    carbon.role = data.role || 'admin';
    document.getElementById('carbonLogin').hidden = true;
    await loadCarbonData();
    render();
    startDashboardLive();
    showToast('Вход выполнен: ' + carbon.user);
  } catch (e) {
    err.textContent = e.message || 'Неверный пароль';
    err.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Войти';
  }
}

async function carbonLogout() {
  try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
  showCarbonLogin();
}

async function loadCarbonData() {
  const safe = (p, ms = 4000) => Promise.race([
    api(p).catch(() => null),
    new Promise(resolve => setTimeout(() => resolve(null), ms))
  ]);
  // 1. Минимум для первого экрана: KPI, сервер, обновления, службы.
  // Остальные разделы догружаются в фоне и не задерживают отрисовку.
  const [stats, modules, services, security, interfaces, update, server, sys] = await Promise.all([
    safe('/api/stats'), safe('/api/modules'), safe('/api/services'),
    safe('/api/security/status'), safe('/api/interfaces'), safe('/api/update/info'),
    safe('/api/server-info'), safe('/api/sysinfo')
  ]);
  carbon.stats = Array.isArray(stats) ? stats : [];
  if (!carbon.clients.length && carbon.stats.length) carbon.clients = carbon.stats;
  carbon.modules = (modules && modules.modules) || carbon.modules;
  carbon.services = Array.isArray(services) ? services : carbon.services;
  if (security) carbon.security = security;
  carbon.interfaces = Array.isArray(interfaces) ? interfaces : carbon.interfaces;
  if (update) carbon.update = update;
  if (server) carbon.server = server;
  if (sys) carbon.sys = sys;
  carbon.loaded = true;
  applyShellData();
  // 2. Диаграмма, история и прокси — в фоне, без очереди из всех разделов.
  loadDashboardExtras();
  loadProxyData();
}

let dashboardExtrasLoading = null;

function assignCarbonPath(path, data) {
  if (!data) return false;
  const p = String(path).split('?')[0];
  if (p === '/api/stats') { if (Array.isArray(data)) { carbon.stats = data; carbon.clients = data; } else return false; }
  else if (p === '/api/sysinfo') carbon.sys = data;
  else if (p === '/api/modules') { carbon.modules = data.modules || carbon.modules; }
  else if (p === '/api/services') { if (Array.isArray(data)) carbon.services = data; else return false; }
  else if (p === '/api/security/status') carbon.security = data;
  else if (p === '/api/interfaces') { if (Array.isArray(data)) carbon.interfaces = data; else return false; }
  else if (p === '/api/update/info') carbon.update = data;
  else if (p === '/api/clients') { if (Array.isArray(data)) carbon.clients = data; else return false; }
  else if (p === '/api/ufw') carbon.ufw = data;
  else if (p === '/api/iptables') carbon.iptables = data;
  else if (p === '/api/tools/status') carbon.toolsStatus = data;
  else if (p === '/api/fail2ban/status') carbon.fail2ban = data;
  else if (p === '/api/warp/status') carbon.warp = data;
  else if (p === '/api/cascade/status') carbon.cascade = data;
  else if (p === '/api/cascade/proxy') carbon.cascadeProxy = data;
  else if (p === '/api/obf/current') carbon.obf = data;
  else if (p === '/api/obf/profiles') carbon.profiles = data;
  else if (p === '/api/ssl/status') carbon.ssl = data;
  else if (p === '/api/app/status') carbon.app = data;
  else if (p === '/api/rustdesk/status') carbon.rustdesk = data;
  else if (p === '/api/users') carbon.users = data;
  else if (p === '/api/audit') carbon.audit = data;
  else if (p === '/api/backup/auto') carbon.backup = data;
  else if (p === '/api/notify/status') carbon.notify = data;
  else if (p === '/api/awg/config') carbon.awgConfig = data;
  else if (p === '/api/history') carbon.history = data;
  else if (p === '/api/traffic/distribution') carbon.distribution = data;
  else if (p === '/api/cascade/interfaces') { if (!data.error) carbon.cascadeInterfaces = data; else return false; }
  else if (p === '/api/cascade/schedule') { if (!data.error) carbon.cascadeSchedule = data; else return false; }
  else return false;
  return true;
}

function loadDashboardExtras() {
  if (dashboardExtrasLoading) return dashboardExtrasLoading;
  const paths = [
    '/api/history?range=' + encodeURIComponent(carbon.chartRange) + '&view=global',
    '/api/traffic/distribution'
  ];
  dashboardExtrasLoading = Promise.all(paths.map(p => api(p).catch(() => null))).then(results => {
    dashboardExtrasLoading = null;
    paths.forEach((p, i) => assignCarbonPath(p, results[i]));
    if (typeof state !== 'undefined' && state.tab === 'dashboard') {
      updateDashboardSystem();
      updateDashboardDonut();
    }
  }).catch(() => { dashboardExtrasLoading = null; });
  // Если /api/stats не успел за первый проход, повторяем отдельно,
  // иначе нижняя таблица клиентов останется пустой.
  if (!carbon.clients.length) {
    api('/api/stats').then(stats => {
      if (!Array.isArray(stats)) return;
      carbon.clients = stats;
      carbonLastStatsAt = Date.now();
      if (typeof state !== 'undefined' && state.tab === 'dashboard') {
        updateDashboardClients();
        applyShellData();
      }
    }).catch(() => null);
  }
  return dashboardExtrasLoading;
}

const TAB_DATA = {
  dashboard: ['/api/stats', '/api/sysinfo', '/api/history?range=' + encodeURIComponent(carbon.chartRange) + '&view=global', '/api/traffic/distribution'],
  clients: ['/api/clients'],
  install: ['/api/modules'],
  network: ['/api/interfaces', '/api/ufw', '/api/iptables', '/api/awg/config'],
  cascade: ['/api/cascade/status', '/api/cascade/proxy', '/api/cascade/interfaces', '/api/cascade/schedule'],
  obfuscation: ['/api/obf/current', '/api/obf/profiles'],
  services: ['/api/services', '/api/warp/status'],
  domains: ['/api/ssl/status'],
  security: ['/api/security/status', '/api/ufw', '/api/tools/status', '/api/fail2ban/status'],
  admin: ['/api/users', '/api/audit?limit=50', '/api/backup/auto', '/api/notify/status'],
  app: ['/api/app/status'],
  rustdesk: ['/api/rustdesk/status'],
  update: ['/api/update/info']
};
const tabDataBusy = {};

function ensureTabData(tab) {
  if (tab === 'proxy') { ensureProxyData(); return; }
  const paths = TAB_DATA[tab];
  if (!paths || tabDataBusy[tab]) return;
  tabDataBusy[tab] = true;
  Promise.all(paths.map(p => api(p).catch(() => null))).then(results => {
    tabDataBusy[tab] = false;
    let got = false;
    paths.forEach((p, i) => { if (assignCarbonPath(p, results[i])) got = true; });
    applyShellData();
    if (got && typeof state !== 'undefined' && state.tab === tab) render();
  }).catch(() => { tabDataBusy[tab] = false; });
}

function clientStatus(c) {
  return c.status_code === 'active' || c.status_code === 'recent';
}

function clientTrafficValue(c) {
  const total = Number(c && c.total_octets);
  if (Number.isFinite(total) && total > 0) return total;
  return (Number(c && c.rx) || 0) + (Number(c && c.tx) || 0);
}

function realClientRows() {
  if (!carbon.clients.length) return `<tr class="empty-row"><td colspan="8">Клиентов пока нет. Создайте первого.</td></tr>`;
  const d = carbon.distribution || {};
  const isEu = (d.role || 'ru') === 'eu';
  const pctText = v => v >= 10 ? Math.round(v) + '%' : v >= 0.1 ? v.toFixed(1) + '%' : '0%';
  return carbon.clients.map(c => {
    const online = clientStatus(c);
    const traffic = clientTrafficValue(c);
    const cascade = Number(c.split_cascade) || 0;
    const direct = Number(c.split_direct) || 0;
    const splitTotal = cascade + direct;
    const hasSplit = splitTotal > 0;
    const cascadePct = hasSplit ? cascade / splitTotal * 100 : 0;
    const directPct = 100 - cascadePct;
    const title = hasSplit
      ? `Каскад: ${fmtBytes(cascade)} · RU: ${fmtBytes(direct)}`
      : 'Нет данных по клиенту';
    const splitCell = isEu
      ? '<span class="muted">—</span>'
      : hasSplit
        ? `<div class="split-bar" title="${escHtml(title)}"><span style="width:${cascadePct.toFixed(1)}%;background:#5b8cff"></span><span style="width:${directPct.toFixed(1)}%;background:var(--accent)"></span></div><span class="share-pct">${pctText(cascadePct)} / ${pctText(directPct)}</span>`
        : `<div class="split-bar" title="Нет данных"><span style="width:100%;background:var(--surface-3)"></span></div><span class="share-pct">нет данных</span>`;
    return `<tr data-name="${escHtml(c.name)}" data-ip="${escHtml(c.ip)}">
      <td class="name">${escHtml(c.name)}</td>
      <td class="mono">${escHtml(c.ip || '—')}</td>
      <td>${escHtml(c.status || (online ? 'Активен' : 'Неактивен'))}</td>
      <td class="mono">${fmtBytes(traffic)}</td>
      <td><div class="bar"><span style="width:${online ? 100 : 15}%"></span></div></td>
      <td>${splitCell}</td>
      <td><span class="status ${online ? '' : 'idle'}"><span class="dot"></span>${online ? 'online' : 'offline'}</span></td>
      <td><div class="page-actions"><button class="row-action" data-carbon-action="client-key" data-name="${escHtml(c.name)}" title="Ключ и QR">${icon('key')}</button><button class="row-action" data-carbon-action="client-rename" data-name="${escHtml(c.name)}" title="Переименовать">${icon('edit')}</button><button class="row-action" data-copy="${escHtml(c.ip || '')}" title="Скопировать IP">${icon('copy')}</button><button class="row-action" data-carbon-action="client-delete" data-name="${escHtml(c.name)}" title="Удалить">${icon('trash')}</button></div></td>
    </tr>`;
  }).join('');
}

function realClientsTable() {
  return `<div class="table-tools"><div class="table-search">${icon('search')}<input id="clientSearch" placeholder="Имя или IP" aria-label="Фильтр клиентов"></div><button class="tag" data-toast="Клиентов: ${carbon.clients.length}">Все клиенты ${icon('arrow', 'ico')}</button></div>
    <div class="table-scroll"><table class="table" id="clientsTable"><thead><tr><th>Клиент</th><th>IP</th><th>Статус</th><th>Трафик</th><th>Загрузка</th><th>Каскад / RU</th><th>Статус</th><th style="width:80px"></th></tr></thead><tbody>${realClientRows()}</tbody></table></div>`;
}

function smoothTraffic(values, range) {
  const arr = (values || []).map(v => Number(v) || 0);
  if (!arr.length) return arr;
  // Как в старой панели: без сглаживания на 5м/1ч/3ч и лёгкое
  // скользящее среднее только на 24ч/7д, чтобы не «съедать» пики.
  const win = range === '7d' ? 21 : range === '24h' ? 15 : 0;
  if (!win) return arr;
  return arr.map((_, i) => {
    const part = arr.slice(Math.max(0, i - win + 1), i + 1);
    return part.reduce((a, b) => a + b, 0) / Math.max(1, part.length);
  });
}

function chartPath(values, max, width, height) {
  if (!values.length) return '';
  const step = width / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => ({
    x: i * step,
    y: Math.max(0, Math.min(height, height - (v / max) * height))
  }));
  if (pts.length === 1) return `M${pts[0].x},${pts[0].y}`;
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L${pts[i].x.toFixed(1)},${pts[i].y.toFixed(1)}`;
  }
  return d;
}

function realTrafficChart() {
  const h = carbon.history || {};
  const range = carbon.chartRange || '1h';
  const labels = Array.isArray(h.labels) ? h.labels : [];
  const rx = smoothTraffic(h.rx, range);
  const tx = smoothTraffic(h.tx, range);
  const max = Math.max(1, ...rx, ...tx);
  const width = 760, height = 190;
  const rxPath = chartPath(rx, max, width, height);
  const txPath = chartPath(tx, max, width, height);
  const area = rxPath ? `${rxPath} L${width},${height} L0,${height} Z` : '';
  const names = { '5m': 'последние 5 минут', '1h': 'последний час', '3h': 'последние 3 часа', '24h': 'последние 24 часа', '7d': 'последние 7 суток' };
  const subline = labels.length ? labels[0] + ' — ' + labels[labels.length - 1] : names[range];
  const chip = (value, label) => `<button class="chip ${range === value ? 'on' : ''}" data-carbon-action="chart-range" data-range="${value}">${label}</button>`;
  return `<section class="card" id="liveChartCard" style="grid-column:span 7;position:relative"><div class="card-top"><div><div class="card-title">Трафик</div><div class="card-sub">${escHtml(subline || '')}</div></div><div class="legend"><span><i style="background:#5b8cff"></i>Rx</span><span><i style="background:var(--accent)"></i>Tx</span><div class="chips" style="margin-left:8px">${chip('5m', '5м')}${chip('1h', '1ч')}${chip('3h', '3ч')}${chip('24h', '24ч')}${chip('7d', '7д')}</div></div></div>${labels.length ? `<svg class="chart" viewBox="0 0 760 235" preserveAspectRatio="none" aria-label="График трафика" onmousemove="carbonChartHover(event)" onmouseleave="carbonChartLeave()"><rect x="0" y="0" width="760" height="235" fill="transparent" pointer-events="all"/><g stroke="var(--line)" stroke-width="1"><line x1="0" y1="${height / 4}" x2="${width}" y2="${height / 4}"/><line x1="0" y1="${height / 2}" x2="${width}" y2="${height / 2}"/><line x1="0" y1="${height * 0.75}" x2="${width}" y2="${height * 0.75}"/></g><path d="${area}" fill="rgba(91,140,255,.10)" stroke="none"/><path d="${txPath}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/><path d="${rxPath}" fill="none" stroke="#5b8cff" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/><g id="chartCross" style="display:none;pointer-events:none"><line id="chartCrossLine" x1="0" y1="0" x2="0" y2="${height}" stroke="var(--text-3)" stroke-width="1" stroke-dasharray="4 4"/><circle id="chartDotRx" r="3.5" fill="#5b8cff" stroke="var(--surface-1)" stroke-width="2"/><circle id="chartDotTx" r="3.5" fill="var(--accent)" stroke="var(--surface-1)" stroke-width="2"/></g></svg><div class="mini-grid" style="grid-template-columns:repeat(4,1fr);margin-top:10px">${mini('Пик Rx', fmtBytes(Math.round(max)) + '/s', 'сглажено')}${mini('Точек', String(labels.length), 'в окне')}${mini('Rx', fmtBytes(Math.round(rx.reduce((a, b) => a + b, 0) / Math.max(1, rx.length))) + '/s', 'среднее')}${mini('Tx', fmtBytes(Math.round(tx.reduce((a, b) => a + b, 0) / Math.max(1, tx.length))) + '/s', 'среднее')}</div>` : '<div class="empty-row">Нет данных истории за этот период</div>'}<div id="chartTip" style="position:absolute;display:none;z-index:6;pointer-events:none;background:var(--surface-1);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:11px;line-height:1.55;box-shadow:0 8px 24px rgba(0,0,0,.35);white-space:nowrap"></div></section>`;
}

function carbonChartHover(event) {
  const svg = event.target && event.target.closest ? event.target.closest('svg') : null;
  const card = svg ? svg.closest('#liveChartCard') : null;
  if (!svg || !card) return;
  const h = carbon.history || {};
  const labels = Array.isArray(h.labels) ? h.labels : [];
  const range = carbon.chartRange || '1h';
  const rx = smoothTraffic(h.rx, range);
  const tx = smoothTraffic(h.tx, range);
  const n = Math.max(rx.length, tx.length, labels.length);
  if (!n) return;
  const rect = svg.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
  const i = Math.min(n - 1, Math.round(ratio * (n - 1)));
  const rxVal = Number(rx[i]) || 0;
  const txVal = Number(tx[i]) || 0;
  const max = Math.max(1, ...rx, ...tx);
  const height = 190;
  const x = ratio * 760;
  const yRx = height - (rxVal / max) * height;
  const yTx = height - (txVal / max) * height;
  const cross = card.querySelector('#chartCross');
  if (cross) cross.style.display = '';
  const line = card.querySelector('#chartCrossLine');
  if (line) { line.setAttribute('x1', x); line.setAttribute('x2', x); }
  const dotRx = card.querySelector('#chartDotRx');
  if (dotRx) { dotRx.setAttribute('cx', x); dotRx.setAttribute('cy', yRx); }
  const dotTx = card.querySelector('#chartDotTx');
  if (dotTx) { dotTx.setAttribute('cx', x); dotTx.setAttribute('cy', yTx); }
  const tip = card.querySelector('#chartTip');
  if (!tip) return;
  tip.style.display = 'block';
  tip.innerHTML = `<b>${escHtml(labels[i] || '')}</b><br>Rx: ${fmtBytes(rxVal)}/s<br>Tx: ${fmtBytes(txVal)}/s`;
  const cardRect = card.getBoundingClientRect();
  let left = event.clientX - cardRect.left + 14;
  let top = event.clientY - cardRect.top + 14;
  if (left + 160 > cardRect.width) left = Math.max(6, cardRect.width - 166);
  if (top + 76 > cardRect.height) top = Math.max(6, event.clientY - cardRect.top - 82);
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

function carbonChartLeave() {
  const card = document.getElementById('liveChartCard');
  if (!card) return;
  const cross = card.querySelector('#chartCross');
  if (cross) cross.style.display = 'none';
  const tip = card.querySelector('#chartTip');
  if (tip) tip.style.display = 'none';
}

function realTrafficDistribution() {
  if (!carbon.distribution) {
    return `<section class="card" id="liveDistributionCard" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">Распределение трафика</div><div class="card-sub">загрузка данных…</div></div>${tag('…', 'muted')}</div><div class="empty-row" style="min-height:220px;display:flex;align-items:center;justify-content:center">Загрузка диаграммы…</div></section>`;
  }
  const d = carbon.distribution || {};
  const role = d.role || 'ru';
  const isEu = role === 'eu';
  const tunnel = Number(d.tunnel) || 0;
  const direct = Number(d.direct) || 0;
  const passed = Number(d.passed) || 0;
  const blocked = Number(d.blocked) || 0;
  const source = d.source || 'unavailable';
  const total = isEu ? passed + blocked : tunnel + direct + blocked;
  const parts = isEu
    ? [
        { key: 'passed', label: 'Прошло через EU', short: 'прошло', value: passed, color: '#5b8cff' },
        { key: 'blocked', label: 'GeoIP blocked', short: 'заблокировано', value: blocked, color: '#d29922' }
      ]
    : [
        { key: 'tunnel', label: 'В EU-туннель', short: 'в EU-туннеле', value: tunnel, color: '#5b8cff' },
        { key: 'direct', label: 'RU выход', short: 'в RU-выходе', value: direct, color: 'var(--accent)' }
      ];
  if (!isEu && blocked > 0) parts.push({ key: 'blocked', label: 'GeoIP blocked', short: 'заблокировано', value: blocked, color: '#d29922' });
  const C = 2 * Math.PI * 46;
  let offset = 0;
  const rings = parts.map(p => {
    const len = total ? C * p.value / total : 0;
    const el = `<circle cx="60" cy="60" r="46" fill="none" stroke="${p.color}" stroke-width="12" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 60 60)"/>`;
    offset += len;
    return el;
  }).join('');
  const pct = v => total ? Math.round(v / total * 100) : 0;
  const main = parts.reduce((a, b) => b.value > a.value ? b : a, parts[0]);
  const mainPct = pct(main.value);
  const legend = parts.map((p, i) => `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;${i < parts.length - 1 ? 'border-bottom:1px solid var(--line);' : ''}"><span style="display:flex;align-items:center;gap:8px;min-width:0"><i style="width:9px;height:9px;border-radius:50%;background:${p.color};display:inline-block;flex:0 0 auto"></i><b style="font-size:12px;font-weight:700">${p.label}</b></span><span class="mono" style="font-size:11px;color:var(--text-2);white-space:nowrap">${pct(p.value)}% · ${fmtBytes(p.value)}</span></div>`).join('');
  const tagText = total ? (source === 'cached' ? 'последние' : 'live') : 'нет данных';
  const tagTone = total ? (source === 'cached' ? 'warn' : 'good') : 'warn';
  const note = total
    ? (isEu ? 'Данные из интерфейса awg0 и правил GeoIP.' : (source === 'mangle' ? 'Данные из счётчиков mangle (ipset ru) и awg0/awg1.' : source === 'cached' ? 'Счётчики маршрутизации пересозданы — показаны последние известные доли.' : 'Данные из счётчиков маршрутизации.'))
    : 'Нет данных: счётчики маршрутизации ещё не накоплены.';
  return `<section class="card" id="liveDistributionCard" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">Распределение трафика</div><div class="card-sub">${isEu ? 'EU-выход · прошло / GeoIP blocked' : 'RU-вход · туннель / RU выход'}${!isEu && blocked > 0 ? ' / GeoIP' : ''}</div></div>${tag(tagText, tagTone)}</div>
    <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
      <div style="position:relative;width:196px;height:196px;flex:0 0 auto">
        <svg viewBox="0 0 120 120" style="width:100%;height:100%"><circle cx="60" cy="60" r="46" fill="none" stroke="var(--surface-3)" stroke-width="12"/>${rings}</svg>
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center">
          <b style="font-size:30px;line-height:1;font-weight:800;letter-spacing:-.04em">${mainPct}%</b>
          <span style="font:500 9px/1.4 var(--mono);color:var(--text-3);text-transform:uppercase;letter-spacing:.08em;margin-top:5px">${main.short}</span>
          <span style="font:500 9px/1.4 var(--mono);color:var(--text-3);margin-top:4px">${fmtBytes(total)}</span>
        </div>
      </div>
      <div style="width:100%;margin-top:10px">${legend}</div>
    </div>
    <div class="donut-note" style="margin-top:12px">${note}</div>
  </section>`;
}
function realDashboard() {
  const clients = carbon.clients;
  const online = clients.filter(clientStatus).length;
  const rx = clients.reduce((a, c) => a + (Number(c.rx) || 0), 0);
  const tx = clients.reduce((a, c) => a + (Number(c.tx) || 0), 0);
  const s = carbon.server || {};
  const sys = carbon.sys || {};
  const trafficTotal = rx + tx;
  const txPct = trafficTotal ? tx / trafficTotal * 100 : 0;
  const rxPct = trafficTotal ? rx / trafficTotal * 100 : 0;
  const onlinePct = clients.length ? online / clients.length * 100 : 0;
  return `
    <div class="overview">
      <div class="server-id"><span class="dot"></span><div><div class="server-name">Servpanel · ${escHtml(s.country || 'сервер')}</div><div class="server-meta">${escHtml(s.ip || 'IP —')} · uptime <span id="liveUptimeMeta">${escHtml(sys.uptime || '—')}</span> · build ${escHtml(carbon.update ? carbon.update.version : '—')}</div></div></div>
      <div class="overview-actions"><div class="live"><span class="dot"></span>API подключён</div><button class="btn" data-carbon-action="diag-check">${icon('pulse')}Проверить всё</button><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button><button class="btn btn-primary" data-action="open-client-modal">${icon('plus')}Добавить клиента</button></div>
    </div>
    <div class="grid">
      ${kpi('Исходящий', `<span id="liveTx">${fmtBytes(tx)}</span>`, 'TX всего', 'upload', '', txPct, '', 'kpiTxBar')}
      ${kpi('Входящий', `<span id="liveRx">${fmtBytes(rx)}</span>`, 'RX всего', 'download', 'amber', rxPct, 'var(--accent-2)', 'kpiRxBar')}
      ${kpi('Клиенты', `<span id="liveClients">${clients.length}</span>`, `<span id="liveOnline">${online}</span> онлайн`, 'users', 'neutral', onlinePct, 'var(--good)', 'kpiClientsBar')}
      ${kpi('Uptime', `<span id="liveUptime">${escHtml(sys.uptime || '—')}</span>`, 'с последнего запуска', 'pulse', 'neutral', null)}
      ${realTrafficChart()}
      ${realTrafficDistribution()}
      <section class="card chart-card" style="position:relative"><div class="card-top"><div><div class="card-title">Сервер</div><div class="card-sub">реальные данные API</div></div>${tag('live', 'good')}</div><div class="mini-grid" style="grid-template-columns:1fr 1fr;margin:0">${mini('CPU', `<span id="liveCpu">${sys.cpu || '—'}%</span>`, 'нагрузка')}${mini('RAM', `<span id="liveRam">${sys.ram || '—'}%</span>`, 'использование')}${mini('Скорость', `<span id="liveSpeed">—</span>`, 'Rx / Tx')}${mini('Интерфейсы', String(carbon.interfaces.length), 'сетевые')}${mini('Модули', String(carbon.modules.filter(m => m.installed).length) + ' / ' + carbon.modules.length, 'установлено')}</div></section>
      <section class="card donut-card"><div class="card-top"><div><div class="card-title">Службы</div><div class="card-sub">ключевые узлы</div></div>${tag(carbon.services.filter(x => x.state === 'active').length + ' / ' + carbon.services.length, 'good')}</div><div class="list">${carbon.services.slice(0, 6).map(s => `<div class="list-row"><b>${escHtml(s.name)}</b><span class="mono">${escHtml(s.state || s.status)}</span></div>`).join('') || '<div class="list-row"><b>Нет данных</b></div>'}</div></section>
      <section class="card table-card"><div class="card-top"><div><div class="card-title">Клиенты</div><div class="card-sub">активные подключения</div></div><button class="tag" data-tab="clients">Все ${icon('arrow', 'ico')}</button></div>${realClientsTable()}</section>
    </div>`;
}

function realClients() {
  const online = carbon.clients.filter(clientStatus).length;
  return `<div class="page-head"><div><div class="page-title">Клиенты</div><div class="page-sub">Реальный список из API. Создание, удаление и статусы.</div></div><div class="page-actions"><button class="btn" data-carbon-action="client-bulk-rename">${icon('edit')}Массовое переименование</button><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button><button class="btn btn-primary" data-action="open-client-modal">${icon('plus')}Добавить клиента</button></div></div>
    <div class="mini-grid">${mini('Всего клиентов', String(carbon.clients.length), 'в панели')}${mini('Онлайн', String(online), 'активные')}${mini('Трафик RX', fmtBytes(carbon.clients.reduce((a, c) => a + (Number(c.rx) || 0), 0)), 'всего')}${mini('Трафик TX', fmtBytes(carbon.clients.reduce((a, c) => a + (Number(c.tx) || 0), 0)), 'всего')}</div>
    <section class="card table-card"><div class="card-top"><div><div class="card-title">Все клиенты</div><div class="card-sub">API /api/clients</div></div><div class="legend"><span><i style="background:#5b8cff"></i>Каскад</span><span><i style="background:var(--accent)"></i>RU</span></div></div>${realClientsTable()}</section>`;
}

function realInstall() {
  const installed = carbon.modules.filter(m => m.installed).length;
  return `<div class="page-head"><div><div class="page-title">Установка</div><div class="page-sub">Реальные модули сервера. Установка и удаление через API.</div></div><div class="page-actions"><button class="btn" data-carbon-action="awg-install">${icon('download')}AWG</button><button class="btn" data-carbon-action="cascade-build">${icon('cascade')}Каскад</button><button class="btn" data-carbon-action="proxy-install">${icon('download')}Прокси</button><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button></div></div>
    <div class="mini-grid">${mini('Модулей', String(carbon.modules.length), 'всего')}${mini('Установлено', String(installed), 'активно')}${mini('Не установлено', String(carbon.modules.length - installed), 'доступно')}${mini('Версия панели', carbon.update ? escHtml(carbon.update.version) : '—', 'build')}</div>
    <div class="grid">${carbon.modules.map(m => `<section class="card" style="grid-column:span 4"><div class="card-top"><div><div class="card-title">${escHtml(m.title)}</div><div class="card-sub">${escHtml(m.description || '')}</div></div>${tag(m.installed ? (m.running ? 'работает' : 'остановлен') : 'не установлен', m.installed ? (m.running ? 'good' : 'warn') : '')}</div><div class="list"><div class="list-row"><b>Порт</b><span class="mono">${escHtml(m.port || m.httpPort || m.tlsPort || '—')}</span></div><div class="list-row"><b>Служба</b><span class="mono">${escHtml(m.service || '—')}</span></div><div class="list-row"><b>Конфиг</b><span class="mono">${escHtml(m.configPath || '—')}</span></div></div><div class="module-actions"><button class="btn ${m.installed ? '' : 'btn-primary'}" data-api-action="${m.installed ? 'uninstall-module' : 'install-module'}" data-module="${escHtml(m.id)}">${icon(m.installed ? 'trash' : 'download')}${m.installed ? 'Удалить' : 'Установить'}</button><button class="btn" data-api-action="module-logs" data-module="${escHtml(m.id)}">${icon('terminal')}Логи</button></div></section>`).join('') || '<section class="card"><div class="empty-row">Нет данных о модулях</div></section>'}</div>`;
}

function realServices() {
  const wst = carbon.warp || {};
  const wservices = Array.isArray(wst.services) ? wst.services : [];
  const allWarp = wst.mode === 'v1';
  const routeRows = wservices.map(s => {
    const route = allWarp ? 'warp' : (s.route || (s.id === 'gemini' ? 'direct' : (s.selected ? 'warp' : 'direct')));
    return `<tr><td>${escHtml(s.label)}${s.custom ? ' <span class="tag" style="margin-left:6px">свой</span>' : ''}</td><td class="mono">${route === 'warp' ? '✓' : '—'}</td><td class="mono">${route === 'direct' ? '✓' : '—'}</td><td class="mono">${route === 'off' ? '✓' : '—'}</td></tr>`;
  }).join('');
  return `<div class="page-head"><div><div class="page-title">Службы и DNS</div><div class="page-sub">Системные службы. Перезапуск через API.</div></div><div class="page-actions"><button class="btn" data-carbon-action="adguard-stats">${icon('shield')}AdGuard</button><button class="btn" data-carbon-action="warp-panel">${icon('globe')}WARP/Xray</button><button class="btn" data-carbon-action="dns-capture">${icon('link')}DNS-перехват</button><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button></div></div>
    <section class="card table-card"><div class="card-top"><div><div class="card-title">Системные службы</div><div class="card-sub">/api/services</div></div>${tag(carbon.services.filter(s => s.state === 'active').length + ' / ' + carbon.services.length, 'good')}</div><div class="table-scroll"><table class="table"><thead><tr><th>Служба</th><th>Назначение</th><th>Состояние</th><th>Автозапуск</th><th></th></tr></thead><tbody>${carbon.services.map(s => `<tr><td class="name">${escHtml(s.name)}</td><td>${escHtml(s.desc || '')}</td><td><span class="status ${s.state === 'active' ? '' : 'idle'}"><span class="dot"></span>${escHtml(s.state || s.status)}</span></td><td class="mono">${s.enabled ? 'enabled' : 'disabled'}</td><td><button class="row-action" data-api-action="restart-service" data-name="${escHtml(s.name)}" title="Перезапустить">${icon('refresh')}</button></td></tr>`).join('') || '<tr><td colspan="5">Служб нет</td></tr>'}</tbody></table></div></section>
    <section class="card" style="margin-top:16px"><div class="card-top"><div><div class="card-title">WARP + Xray: маршруты</div><div class="card-sub">${allWarp ? 'Вариант 1 — весь трафик через WARP' : 'Вариант 2 — выбранные сервисы через WARP'}</div></div><div class="page-actions">${tag(wst.connected ? 'WARP подключён' : (wst.installed ? 'WARP не подключён' : 'WARP не установлен'), wst.connected ? 'good' : 'warn')}<button class="btn btn-sm" data-carbon-action="warp-panel">Настроить</button></div></div><div class="table-scroll"><table class="table"><thead><tr><th>Сервис</th><th>В WARP</th><th>Напрямую</th><th>Отключено</th></tr></thead><tbody>${routeRows || '<tr><td colspan="4">Сервисы не найдены</td></tr>'}</tbody></table></div><div class="donut-note" style="margin-top:10px">Gemini сейчас напрямую с IP сервера. Маршруты и свои сервисы — в окне «Настроить».</div></section>`;
}

function realSecurity() {
  const sec = carbon.security || {};
  const ifaces = carbon.interfaces || [];
  const tools = carbon.toolsStatus || {};
  const ru = tools.ruDrop || {};
  const activeIfaces = Array.isArray(ru.ifaces) ? ru.ifaces : [];
  const f2b = carbon.fail2ban || {};
  const banned = Array.isArray(f2b.banned) ? f2b.banned : [];
  const ifaceChips = ifaces.map(i => `<label class="chip ${activeIfaces.includes(i) ? 'on' : ''}" style="cursor:pointer"><input type="checkbox" value="${escHtml(i)}" ${activeIfaces.includes(i) ? 'checked' : ''}> ${escHtml(i)}</label>`).join('') || '<span class="muted">Интерфейсы не найдены</span>';
  const bannedRows = banned.map(ip => `<tr><td class="mono">${escHtml(ip)}</td><td><button class="row-action" data-carbon-action="fail2ban-unban" data-name="${escHtml(ip)}" title="Разблокировать">${icon('play')}</button></td></tr>`).join('');
  const geoActive = !!ru.active;
  return `<div class="page-head"><div><div class="page-title">Защита и GeoIP</div><div class="page-sub">Блокировка RU, GeoIP и Fail2Ban.</div></div><div class="page-actions"><button class="btn" data-carbon-action="fail2ban">${icon('shield')}Fail2Ban</button><button class="btn" data-carbon-action="fail2ban-refresh">${icon('refresh')}Обновить список IP</button><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button></div></div>
    <div class="mini-grid">${mini('Панель', sec.https ? 'HTTPS' : 'HTTP', 'порт ' + (sec.panelPublicPort || '—'))}${mini('2FA', sec.totpEnabled ? 'включена' : 'выключена', 'TOTP')}${mini('GeoIP', geoActive ? 'активна' : 'выключена', ru.count ? ru.count + ' IP' : 'правила')}${mini('Fail2Ban', f2b.installed ? (f2b.jail ? 'активен' : 'jail нет') : 'не установлен', banned.length + ' забанено')}</div>
    <div class="grid">
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">GeoIP: блокировка RU</div><div class="card-sub">Правила применяются к выбранным интерфейсам целиком</div></div>${tag(geoActive ? 'активна' : 'выключена', geoActive ? 'good' : 'warn')}</div>
        <div class="form-grid"><div class="field" style="grid-column:1/-1"><span>Интерфейсы</span><div class="chips" id="carbonGeoIfaces">${ifaceChips}</div></div>
          <label class="field"><span>Расписание</span><select id="carbonGeoSchedule"><option value="weekly">Раз в неделю</option><option value="daily">Каждый день</option><option value="none">Не обновлять</option></select></label>
          <label class="field"><span>Источник списка</span><select id="carbonGeoListMode"><option value="antifilter">Antifilter / ipdeny</option><option value="opencck">OpenCCK</option><option value="custom">Свой URL</option></select></label>
          <label class="field"><span>Свой URL списка</span><input id="carbonGeoCustomUrl" placeholder="https://example.com/ru.txt"></label>
          <label class="field"><span>Порты (пусто — все)</span><input id="carbonGeoPorts" placeholder="443, 80"></label></div>
        <div class="file-row"><input id="carbonRuDropFile" type="file" accept=".txt,.list,.cidr" style="display:none" onchange="document.getElementById('carbonRuDropFileName').textContent=this.files[0]?this.files[0].name:'Файл не выбран'"><label class="btn" for="carbonRuDropFile">${icon('upload')}Выбрать файл</label><span id="carbonRuDropFileName" class="mono">Файл не выбран</span><button class="btn" data-carbon-action="rudrop-upload">${icon('upload')}Загрузить список</button></div>
        <div class="page-actions" style="margin-top:14px"><button class="btn btn-primary" data-api-action="geoip-enable">${icon('shield')}Включить</button><button class="btn btn-danger" data-api-action="geoip-disable">${icon('stop')}Отключить</button><button class="btn" data-carbon-action="rudrop-refresh">${icon('refresh')}Обновить правила</button></div>
        <div class="donut-note">Порты не используются — блокировка только по интерфейсам, если поле портов пустое.${ru.count ? ' Сейчас в ipset: ' + ru.count + ' IP.' : ''}</div>
      </section>
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Fail2Ban</div><div class="card-sub">Заблокированные IP и статус jail servpanel</div></div><div class="page-actions"><button class="btn btn-sm" data-carbon-action="fail2ban-refresh">${icon('refresh')}Обновить список</button>${tag(f2b.installed ? (f2b.jail ? 'активен' : 'jail нет') : 'не установлен', f2b.installed && f2b.jail ? 'good' : 'warn')}</div></div>
        <div class="mini-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:12px">${mini('Jail', f2b.jail ? 'активен' : 'не найден', 'servpanel')}${mini('Сейчас', String(f2b.currentlyFailed || 0), 'неудачных')}${mini('Забанено', String(banned.length), 'IP')}</div>
        <div class="table-scroll"><table class="table"><thead><tr><th>IP</th><th></th></tr></thead><tbody>${bannedRows || '<tr><td colspan="2">Заблокированных IP нет</td></tr>'}</tbody></table></div>
      </section>
    </div>`;
}

function realUpdate() {
  const u = carbon.update || {};
  const st = u.status || {};
  const backups = u.backups || [];
  const progress = st.running ? (Number(st.progress) || 0) : (st.ok ? 100 : 0);
  return `<div class="page-head"><div><div class="page-title">Обновление</div><div class="page-sub">Реальная версия, Git, архив и резервные копии.</div></div><div class="page-actions"><button class="btn" data-carbon-action="update-check">${icon('search')}Проверить GitHub</button><button class="btn btn-primary" data-carbon-action="update-git">${icon('download')}Обновить с GitHub</button><button class="btn" data-carbon-action="update-git-force">${icon('refresh')}Сбросить и обновить</button><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button></div></div>
    <div class="mini-grid">${mini('Версия', escHtml(u.version || '—'), 'установлена')}${mini('Git', u.git && u.git.available ? 'доступен' : 'нет', u.git && u.git.branch ? escHtml(u.git.branch) : '—')}${mini('Бэкапы', String(backups.length), 'архивов')}${mini('Порт', String(u.port || '—'), 'панель')}</div>
    <section class="card"><div class="card-top"><div><div class="card-title">Статус обновления</div><div class="card-sub">${escHtml(st.message || 'Нет активного обновления')}</div></div>${tag(st.running ? 'выполняется' : (st.ok ? 'готово' : 'ожидание'), st.running ? 'warn' : (st.ok ? 'good' : ''))}</div><div class="progress" style="margin:4px 0 12px"><span style="width:${progress}%"></span></div><div class="list"><div class="list-row"><b>Каталог</b><span class="mono">${escHtml(u.appDir || '—')}</span></div><div class="list-row"><b>Данные</b><span class="mono">${escHtml(u.dataDir || '—')}</span></div><div class="list-row"><b>Шаг</b><span class="mono">${escHtml(st.step || '—')} · ${progress}%</span></div><div class="list-row"><b>Ошибка</b><span class="mono">${escHtml(st.error || '—')}</span></div></div><pre class="code" style="margin:12px 0 0;max-height:220px;overflow:auto;padding:10px;white-space:pre-wrap">${escHtml((st.log || []).slice(-40).join('\n') || u.logTail || 'Журнал пуст')}</pre></section>
    <div class="grid"><section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Установить архив</div><div class="card-sub">.tar.gz до 10 МБ</div></div></div><div class="file-row"><input id="carbonUpdateFile" type="file" accept=".tar.gz,.tgz,application/gzip" style="display:none" onchange="document.getElementById('carbonUpdateFileName').textContent=this.files[0]?this.files[0].name:'Файл не выбран'"><label class="btn" for="carbonUpdateFile">${icon('upload')}Выбрать файл</label><span id="carbonUpdateFileName" class="mono">Файл не выбран</span></div><div class="page-actions" style="margin-top:12px"><button class="btn btn-primary" data-carbon-action="update-upload">${icon('upload')}Загрузить и установить</button><button class="btn" data-carbon-action="update-url">${icon('link')}Из URL</button></div></section>
    <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Резервные копии</div><div class="card-sub">Откат к предыдущему коду</div></div>${tag(String(backups.length), 'muted')}</div><div class="list">${backups.slice(0, 6).map(b => `<div class="list-row"><b>${escHtml(b.name || b.path || '—')}</b><span class="mono">${fmtBytes(b.size || 0)}</span></div>`).join('') || '<div class="list-row"><b>Копий нет</b></div>'}</div><div class="page-actions" style="margin-top:12px"><button class="btn" data-carbon-action="update-rollback">${icon('refresh')}Откатить</button><button class="btn" data-carbon-action="backup-run">${icon('box')}Создать бэкап</button><button class="btn" data-carbon-action="restore-panel">${icon('upload')}Восстановить из файла</button></div></section></div>`;
}

function realNetwork() {
  const ifaces = carbon.interfaces || [];
  const ufw = carbon.ufw || {};
  const rules = Array.isArray(ufw.rules) ? ufw.rules : (Array.isArray(ufw) ? ufw : []);
  const ip = carbon.iptables || {};
  const ipRules = Array.isArray(ip.rules) ? ip.rules : [];
  const awgText = (carbon.awgConfig && (carbon.awgConfig.content || carbon.awgConfig.text)) || '';
  const ufwRows = rules.map(r => `<tr><td><span class="tag good">UFW</span></td><td class="mono">${escHtml(r.to || r.rule || r.port || (typeof r === 'string' ? r : ''))}</td><td>${escHtml(r.action || r.status || '')}</td><td class="mono">${escHtml(r.from || '')}</td><td>${r.id != null ? `<button class="row-action" data-carbon-action="ufw-delete" data-name="${escHtml(String(r.id))}" title="Удалить">${icon('trash')}</button>` : ''}</td></tr>`).join('');
  const ipRows = ipRules.map(r => `<tr><td><span class="tag warn">iptables</span></td><td class="mono" style="white-space:normal;word-break:break-word">${escHtml(r.spec || '')}</td><td>${escHtml(r.target || '-')}</td><td class="mono">${escHtml(r.chain || '')}</td><td>${r.deletable ? `<button class="row-action" data-carbon-action="iptables-delete" data-name="${escHtml(r.id || '')}" title="Удалить">${icon('trash')}</button>` : '<span class="tag" title="Правило управляется UFW">UFW</span>'}</td></tr>`).join('');
  const ruleRows = ufwRows + ipRows;
  return `<div class="page-head"><div><div class="page-title">Сеть и порты</div><div class="page-sub">Интерфейсы, UFW, iptables и конфиг AWG.</div></div><div class="page-actions"><button class="btn" data-carbon-action="ufw-add">${icon('plus')}Добавить UFW</button><button class="btn" data-carbon-action="iptables-add">${icon('plus')}Добавить iptables</button><button class="btn" data-carbon-action="awg-edit">${icon('edit')}Редактор AWG</button><button class="btn" data-carbon-action="server-name">${icon('server')}Имя сервера</button><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button></div></div>
    <div class="mini-grid">${mini('Интерфейсов', String(ifaces.length), 'системных')}${mini('UFW', rules.length ? String(rules.length) + ' правил' : 'нет правил', 'firewall')}${mini('iptables', ipRules.length ? String(ipRules.length) + ' правил' : 'нет правил', 'filter')}${mini('Публичный IP', escHtml((carbon.server && carbon.server.ip) || '-'), (carbon.server && carbon.server.country) || '')}</div>
    <div class="grid">
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Интерфейсы</div><div class="card-sub">/api/interfaces</div></div>${tag(String(ifaces.length), 'good')}</div><div class="iface-list">${ifaces.map(i => `<div class="iface-row"><span class="dot"></span><b>${escHtml(i)}</b><span class="mono">up</span></div>`).join('') || '<div class="empty-row">Интерфейсов нет</div>'}</div></section>
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Правила firewall</div><div class="card-sub">UFW и iptables · базовые цепочки INPUT / FORWARD / OUTPUT</div></div>${tag(String(rules.length + ipRules.length), rules.length + ipRules.length ? 'good' : 'warn')}</div><div class="table-scroll"><table class="table" style="min-width:0"><thead><tr><th>Источник</th><th>Правило</th><th>Действие</th><th>Цепочка / откуда</th><th></th></tr></thead><tbody>${ruleRows || '<tr><td colspan="5">Правил нет</td></tr>'}</tbody></table></div><div class="donut-note" style="margin-top:12px">Правила UFW защищены от удаления. Правила iptables применяются сразу; для сохранения после перезагрузки используйте netfilter-persistent.</div></section>
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">AmneziaWG</div><div class="card-sub">/api/awg/config</div></div><div class="page-actions">${tag('advanced', 'muted')}<button class="btn btn-sm" data-carbon-action="awg-edit">${icon('edit')}Редактировать</button></div></div><pre class="code" style="margin:0;max-height:280px;overflow:auto;padding:12px;white-space:pre-wrap">${escHtml(awgText || 'Конфиг не загружен или отсутствует')}</pre></section>
    </div>`;
}

function realCascade() {
  const c = carbon.cascade || {};
  const p = carbon.cascadeProxy || {};
  const ci = carbon.cascadeInterfaces || {};
  const ifaceList = Array.isArray(ci.available) ? ci.available : [];
  const selectedIfaces = Array.isArray(ci.selected) && ci.selected.length ? ci.selected : (c.ifaces || []);
  const cs = carbon.cascadeSchedule || {};
  const csSeconds = Number(cs.seconds) || 0;
  const csOptions = [[300, '5m', 'Каждые 5 минут'], [3600, '1h', 'Каждый час'], [21600, '6h', 'Каждые 6 часов'], [86400, '24h', 'Раз в сутки'], [0, 'off', 'Выключено']]
    .map(([sec, val, label]) => `<option value="${val}" ${csSeconds === sec ? 'selected' : ''}>${label}</option>`).join('');
  const csCard = cs.applicable === false ? '' : `<section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Обновление списков RU</div><div class="card-sub">Ручное обновление и автообновление ipset ru</div></div>${tag(cs.active ? 'авто' : 'выкл', cs.active ? 'good' : 'warn')}</div><div class="form-grid" style="grid-template-columns:minmax(220px,320px)"><label class="field"><span>Автообновление</span><select id="carbonCascadeSchedule">${csOptions}</select></label></div><div class="page-actions" style="margin-top:12px"><button class="btn btn-primary" data-carbon-action="cascade-list-refresh">${icon('refresh')}Обновить список RU</button><button class="btn" data-carbon-action="cascade-schedule-save">${icon('check')}Сохранить расписание</button></div><div class="donut-note">Скрипт скачивает свежий список RU и пересобирает ipset и маршруты.</div></section>`;
  return `<div class="page-head"><div><div class="page-title">Каскад RU → EU</div><div class="page-sub">Статус туннеля и MTProto через EU.</div></div><div class="page-actions"><button class="btn btn-primary" data-carbon-action="cascade-build">${icon('cascade')}Построить каскад</button><button class="btn" data-carbon-action="cascade-manual">${icon('edit')}Вручную</button><button class="btn" data-carbon-action="cascade-repair">${icon('refresh')}Пересобрать</button><button class="btn" data-carbon-action="cascade-proxy">${icon('send')}MTProto через EU</button><button class="btn" data-carbon-action="cascade-cleanup">${icon('trash')}Удалить каскад</button><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button></div></div>
    <div class="mini-grid">${mini('Настроен', c.configured ? 'да' : 'нет', 'awg1')}${mini('Активен', c.active ? 'да' : 'нет', 'туннель')}${mini('Endpoint', escHtml(c.endpoint || '—'), 'EU')}${mini('Handshake', c.handshakeAgo == null ? '—' : c.handshakeAgo + ' c', 'назад')}</div>
    <div class="grid"><section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">Состояние</div><div class="card-sub">/api/cascade/status</div></div>${tag(c.active ? 'активен' : 'не активен', c.active ? 'good' : 'warn')}</div><div class="list"><div class="list-row"><b>Роль</b><span class="mono">${escHtml(c.role || '—')}</span></div><div class="list-row"><b>Интерфейсы</b><span class="mono">${escHtml((c.ifaces || []).join(', ') || '—')}</span></div><div class="list-row"><b>Маршрут</b><span class="mono">${escHtml(c.tableRoute || '—')}</span></div><div class="list-row"><b>ipset</b><span class="mono">${escHtml(String(c.ipsetCount || 0))}</span></div></div></section>
    <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">MTProto через EU</div><div class="card-sub">/api/cascade/proxy</div></div>${tag(p.enabled ? 'включено' : 'выключено', p.enabled ? 'good' : 'warn')}</div><div class="list"><div class="list-row"><b>middle_proxy_nat_ip</b><span class="mono">${escHtml(p.middleProxyNatIp || p.natIp || '—')}</span></div><div class="list-row"><b>Пользователи</b><span class="mono">${escHtml((p.users || []).join(', ') || '—')}</span></div></div></section><section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Интерфейсы каскада</div><div class="card-sub">ipset ru → напрямую · MARK 0x1 → EU-туннель</div></div>${tag(String(selectedIfaces.length), selectedIfaces.length ? 'good' : 'warn')}</div><div class="chips">${ifaceList.map(i => `<label class="chip ${selectedIfaces.includes(i) ? 'on' : ''}" style="cursor:pointer"><input type="checkbox" data-cascade-iface value="${escHtml(i)}" ${selectedIfaces.includes(i) ? 'checked' : ''}> ${escHtml(i)}</label>`).join('') || '<span class="muted">Интерфейсы не найдены</span>'}</div><div class="page-actions" style="margin-top:12px"><button class="btn btn-primary" data-carbon-action="cascade-ifaces-save">${icon('check')}Применить интерфейсы</button><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button></div><div class="donut-note">К выбранным интерфейсам применяются правила RU-маршрутизации: RU-направления идут напрямую, остальное — в EU-туннель.</div>${ci.reason && !ifaceList.length ? `<div class="donut-note">${escHtml(ci.reason)}</div>` : ''}</section>${csCard}</div>`;
}

function realObfuscation() {
  const o = carbon.obf || {};
  const profiles = (carbon.profiles && (carbon.profiles.builtin || []).concat(carbon.profiles.custom || [])) || [];
  return `<div class="page-head"><div><div class="page-title">Обфускация</div><div class="page-sub">Текущий конфиг и профили из API.</div></div><div class="page-actions"><button class="btn btn-primary" data-carbon-action="obf-generate">${icon('pulse')}Сгенерировать</button><button class="btn" data-carbon-action="obf-import">${icon('upload')}Импорт из Архитектора</button><button class="btn" data-carbon-action="obf-sync">${icon('key')}Синхронизировать HPK</button><a class="btn" href="/api/obf/export?format=conf">${icon('download')}Экспорт .conf</a><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button></div></div>
    <div class="mini-grid">${mini('Версия', o.version || '—', 'AWG')}${mini('Оценка', o.audit && o.audit.score != null ? o.audit.score + '/100' : '—', 'DPI')}${mini('H1–H4', o.params && o.params.H1 ? 'заданы' : '—', 'header')}${mini('HPK', o.params && o.params.HeaderProtectionKey ? 'есть' : '—', 'ключ')}</div>
    <div class="grid"><section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">Текущий профиль</div><div class="card-sub">/api/obf/current</div></div>${tag(o.error ? 'нет конфига' : 'загружен', o.error ? 'warn' : 'good')}</div><pre class="code" style="margin:0;max-height:260px;overflow:auto;padding:12px;white-space:pre-wrap">${escHtml(o.error || JSON.stringify(o.params || o, null, 2))}</pre></section>
    <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">Профили</div><div class="card-sub">встроенные и сохранённые</div></div>${tag(String(profiles.length), 'muted')}</div><div class="list">${profiles.slice(0, 8).map(p => `<div class="list-row"><b>${escHtml(p.title || p.name)}</b><span class="mono">${escHtml(String(p.score || ''))}</span><button class="row-action" data-api-action="obf-apply" data-profile="${escHtml(p.name)}" title="Применить">${icon('check')}</button></div>`).join('') || '<div class="list-row"><b>Нет профилей</b></div>'}</div></section></div>`;
}

let proxyEnsureInFlight = false;
function loadProxyData() {
  if (proxyEnsureInFlight) return;
  proxyEnsureInFlight = true;
  Promise.all([
    api('/api/proxy/status').catch(() => null),
    api('/api/proxy/users').catch(() => null)
  ]).then(([status, users]) => {
    proxyEnsureInFlight = false;
    const got = !!(status || users);
    if (status) carbon.proxy = status;
    if (users) carbon.proxyUsers = users;
    if (got && typeof state !== 'undefined' && state.tab === 'proxy') render();
  }).catch(() => { proxyEnsureInFlight = false; });
}

function ensureProxyData() {
  if (carbon.proxy && carbon.proxyUsers) return;
  loadProxyData();
}

function realProxy() {
  ensureProxyData();
  const proxyLoading = !carbon.proxy && !carbon.proxyUsers && proxyEnsureInFlight;
  const p = carbon.proxy || {};
  const raw = carbon.proxyUsers;
  const users = Array.isArray(raw) ? raw : (raw && raw.users) || [];
  const online = users.filter(u => u.enabled !== false && Number(u.current_connections) > 0).length;
  return `<div class="page-head"><div><div class="page-title">Прокси</div><div class="page-sub">Пользователи, лимиты и состояние MTProto.</div></div><div class="page-actions"><button class="btn btn-sm btn-primary" data-carbon-action="proxy-user-add">${icon('plus')}Добавить</button><button class="btn btn-sm" data-carbon-action="proxy-settings">${icon('wrench')}Настройки</button><button class="btn btn-sm" data-carbon-action="proxy-bot">${icon('bell')}Бот</button><button class="btn btn-sm" data-carbon-action="proxy-api-key">${icon('key')}API</button><button class="btn btn-sm" data-carbon-action="proxy-fix">${icon('shield')}Фикс</button><button class="btn btn-sm" data-carbon-action="proxy-opt-apply">${icon('pulse')}Оптимизация</button><button class="btn btn-sm" data-carbon-action="proxy-diag">${icon('terminal')}Диагностика</button><button class="btn btn-sm" data-carbon-action="proxy-log">${icon('box')}Журнал</button><button class="btn btn-sm" data-api-action="refresh">${icon('refresh')}Обновить</button><button class="btn btn-sm" data-api-action="proxy-restart">${icon('refresh')}Перезапуск</button></div></div>
    <div class="mini-grid">${mini('Движок', escHtml(p.backend || '—'), 'backend')}${mini('Версия', escHtml(p.version || '—'), p.mode || 'движок')}${mini('Порт', p.port == null ? '—' : String(p.port), 'TLS')}${mini('Пользователей', String(users.length), 'всего')}${mini('Онлайн', String(online), 'сейчас')}${mini('Соединений', p.connections == null ? '—' : String(p.connections), 'всего')}${mini('Uptime', fmtUptime(p.uptime), 'без перезапуска')}${mini('API', p.limited ? 'ограничен' : 'доступен', 'управление')}</div>
    <section class="card table-card"><div class="card-top"><div><div class="card-title">Пользователи</div><div class="card-sub">/api/proxy/users</div></div>${tag(String(users.length), 'muted')}</div><div class="table-scroll"><table class="table"><thead><tr><th>Пользователь</th><th>Статус</th><th>Трафик</th><th>Соединения</th><th>Срок</th><th></th></tr></thead><tbody>${users.map(u => {
      const enabled = u.enabled !== false;
      const status = !enabled ? 'выключен' : (u.in_runtime ? 'включён' : 'не загружен');
      return `<tr><td class="name">${escHtml(u.username || u.name)}</td><td><span class="status ${enabled && u.in_runtime ? '' : 'idle'}"><span class="dot"></span>${escHtml(status)}</span></td><td class="mono">${fmtBytes(u.total_octets || u.traffic || u.total || 0)}</td><td class="mono">${u.current_connections == null ? '—' : escHtml(String(u.current_connections))}</td><td class="mono">${escHtml(u.expiration_rfc3339 ? fmtDate(u.expiration_rfc3339) : '—')}</td><td><div class="page-actions"><button class="row-action" data-carbon-action="proxy-user-edit" data-name="${escHtml(u.username || u.name)}" title="Изменить">${icon('edit')}</button><button class="row-action" data-carbon-action="proxy-user-links" data-name="${escHtml(u.username || u.name)}" title="Ссылки и QR">${icon('link')}</button><button class="row-action" data-carbon-action="proxy-user-action" data-act="${enabled ? 'disable' : 'enable'}" data-name="${escHtml(u.username || u.name)}" title="${enabled ? 'Выключить' : 'Включить'}">${icon(enabled ? 'stop' : 'play')}</button><button class="row-action" data-carbon-action="proxy-user-action" data-act="rotate-secret" data-name="${escHtml(u.username || u.name)}" title="Новый секрет">${icon('refresh')}</button><button class="row-action" data-carbon-action="proxy-user-delete" data-name="${escHtml(u.username || u.name)}" title="Удалить">${icon('trash')}</button></div></td></tr>`;
    }).join('') || `<tr><td colspan="6">${proxyLoading ? 'Загрузка данных прокси…' : 'Прокси-движок не найден или пользователей нет'}</td></tr>`}</tbody></table></div></section>`;
}

function realDomains() {
  const s = carbon.ssl || {};
  const panel = s.panel || {};
  const certs = s.certificates || [];
  const sites = s.sites || [];
  return `<div class="page-head"><div><div class="page-title">Домены и SSL</div><div class="page-sub">Сертификаты и сайты Nginx из API.</div></div><div class="page-actions"><button class="btn" data-carbon-action="ssl-deps">${icon('download')}nginx + certbot</button><button class="btn" data-carbon-action="ssl-bind">${icon('lock')}Домен панели</button><button class="btn btn-primary" data-carbon-action="ssl-site">${icon('plus')}Создать сайт</button><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button></div></div>
    <div class="mini-grid">${mini('Домен панели', escHtml(panel.domain || '—'), panel.scheme || '—')}${mini('HTTPS', panel.scheme === 'https' ? 'включён' : 'выключен', 'порт ' + (panel.publicPort || '—'))}${mini('Сертификатов', String(certs.length), 'Let\'s Encrypt')}${mini('Сайтов', String(sites.length), 'Nginx')}</div>
    <div class="grid"><section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Сертификаты</div><div class="card-sub">/api/ssl/status</div></div>${tag(String(certs.length), 'muted')}</div><div class="list">${certs.map(c => {
      const domains = Array.isArray(c.domains) ? c.domains : [];
      const label = c.domain || domains[0] || c.name || '—';
      const expires = c.validTo || c.notAfter || c.expires;
      const suffix = c.daysLeft != null ? ` · ${c.daysLeft} дн.` : '';
      return `<div class="list-row"><b>${escHtml(label)}</b><span class="mono">${escHtml(expires ? fmtDate(expires) + suffix : '')}</span><button class="row-action" data-carbon-action="ssl-renew" data-name="${escHtml(c.name || label)}" data-days="${c.daysLeft == null ? '' : c.daysLeft}" title="Продлить">${icon('refresh')}</button></div>`;
    }).join('') || '<div class="list-row"><b>Сертификатов нет</b></div>'}</div></section>
    <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Сайты</div><div class="card-sub">Nginx</div></div>${tag(String(sites.length), 'muted')}</div><div class="list">${sites.map(x => {
      const domains = Array.isArray(x.domains) ? x.domains : [];
      const label = x.domain || domains[0] || x.name || '—';
      return `<div class="list-row"><b>${escHtml(label)}</b><span class="mono">${x.ssl ? 'HTTPS' : 'HTTP'}${x.enabled === false ? ' · выкл' : ''}</span><button class="row-action" data-carbon-action="ssl-delete" data-name="${escHtml(x.name || label)}" title="Удалить сайт">${icon('trash')}</button></div>`;
    }).join('') || '<div class="list-row"><b>Сайтов нет</b></div>'}</div></section></div>`;
}

function realApp() {
  const a = carbon.app || {};
  const apk = a.apk || {};
  const m = a.metrics || {};
  return `<div class="page-head"><div><div class="page-title">Приложение</div><div class="page-sub">APK и порт метрик из API.</div></div><div class="page-actions"><button class="btn" data-carbon-action="app-metrics">${icon('wrench')}Метрики</button><button class="btn" data-carbon-action="app-metrics-token">${icon('key')}Новый токен</button><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button><a class="btn btn-primary" href="/api/app/apk">${icon('download')}Скачать APK</a></div></div>
    <div class="mini-grid">${mini('Версия APK', escHtml(apk.version || '—'), apk.source || '')}${mini('Метрики', m.enabled ? 'включены' : 'выключены', 'порт ' + (m.publicPort || '—'))}${mini('Формат', escHtml(m.format || '—'), m.path || '/metrics')}${mini('Токен', m.tokenSet ? 'задан' : 'нет', 'Bearer')}</div>
    <div class="grid"><section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">APK</div><div class="card-sub">/api/app/status</div></div>${tag(apk.available ? 'доступен' : 'нет', apk.available ? 'good' : 'warn')}</div><div class="list"><div class="list-row"><b>Файл</b><span class="mono">${escHtml(apk.name || '—')}</span></div><div class="list-row"><b>Размер</b><span class="mono">${apk.size ? fmtBytes(apk.size) : (apk.available ? 'не загружен локально' : '—')}</span></div><div class="list-row"><b>SHA256</b><span class="mono">${apk.sha256 ? escHtml(apk.sha256.slice(0, 16)) : (apk.available ? 'по ссылке GitHub' : '—')}</span></div></div></section>
    <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">Метрики</div><div class="card-sub">/api/app/metrics</div></div>${tag(m.enabled ? 'on' : 'off', m.enabled ? 'good' : 'warn')}</div><div class="list"><div class="list-row"><b>Внутренний порт</b><span class="mono">${escHtml(String(m.port || '—'))}</span></div><div class="list-row"><b>Внешний порт</b><span class="mono">${escHtml(String(m.publicPort || '—'))}</span></div><div class="list-row"><b>Адрес</b><span class="mono">${escHtml(m.host || '—')}</span></div></div></section></div>`;
}

function realRustdesk() {
  const r = carbon.rustdesk || {};
  const groups = {};
  (r.clients || []).forEach(c => {
    const g = c.group || 'Другое';
    (groups[g] = groups[g] || []).push(c);
  });
  const clientCards = Object.entries(groups).map(([group, list]) => `<section class="card rustdesk-os-card" style="grid-column:span 4"><div class="card-top"><div><div class="card-title">${escHtml(group)}</div><div class="card-sub">${escHtml(r.clientVersion || '')} · ${list.length} сборок</div></div>${tag(String(list.length), 'muted')}</div><div class="page-actions" style="flex-direction:column;align-items:stretch">${list.map(c => `<a class="btn btn-sm" href="${escHtml(c.url || ('/api/rustdesk/client/' + encodeURIComponent(c.id)))}" download style="justify-content:flex-start"><span style="flex:1;text-align:left">${escHtml(c.label || c.name || c.id)}</span><span class="mono" style="color:var(--text-3);font-weight:400">${fmtBytes(c.size || 0)}</span></a>`).join('')}</div></section>`).join('');
  const clientCount = (r.clients || []).length;
  return `<div class="page-head"><div><div class="page-title">RustDesk</div><div class="page-sub">Relay-сервер, клиенты и подключение.</div></div><div class="page-actions"><button class="btn" data-carbon-action="rustdesk-settings">${icon('wrench')}Настройки</button><button class="btn" data-carbon-action="rustdesk-ports">${icon('globe')}Порты</button><button class="btn" data-carbon-action="rustdesk-refresh">${icon('refresh')}Проверить версии</button><button class="btn" data-carbon-action="rustdesk-job" data-act="update">${icon('refresh')}Обновить сервер</button><button class="btn btn-primary" data-carbon-action="rustdesk-job" data-act="install">${icon('download')}Установить сервер</button><button class="btn btn-danger" data-carbon-action="rustdesk-job" data-act="uninstall">${icon('trash')}Удалить</button></div></div>
    <div class="mini-grid">${mini('Сервер', r.installed ? 'установлен' : 'не установлен', r.version || '—')}${mini('Relay', escHtml(r.relay || '—'), 'hbbr')}${mini('Public key', escHtml((r.publicKey || '—').slice(0, 16)), 'ключ')}${mini('Клиенты', r.clientVersion || '—', clientCount ? clientCount + ' сборок' : 'GitHub')}</div>
    <div class="grid"><section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">Конфигурация</div><div class="card-sub">/api/rustdesk/status</div></div>${tag(r.installed ? 'active' : 'не установлен', r.installed ? 'good' : 'warn')}</div><div class="list"><div class="list-row"><b>Host</b><span class="mono">${escHtml(r.host || '—')}</span></div><div class="list-row"><b>Relay</b><span class="mono">${escHtml(r.relay || '—')}</span></div><div class="list-row"><b>hbbs</b><span class="mono">${escHtml((r.services && r.services.hbbs && r.services.hbbs.state) || '—')}</span></div><div class="list-row"><b>hbbr</b><span class="mono">${escHtml((r.services && r.services.hbbr && r.services.hbbr.state) || '—')}</span></div></div></section>
    <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">Порты</div><div class="card-sub">21115–21119</div></div>${tag(String((r.ports || []).length), 'muted')}</div><div class="list">${(r.ports || []).map(p => `<div class="list-row"><b>${escHtml(String(p.port))}/${escHtml(p.proto)}</b><span class="mono">${p.open ? 'open' : 'closed'}</span></div>`).join('') || '<div class="list-row"><b>Нет данных</b></div>'}</div></section>
    ${clientCards || '<section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Клиенты RustDesk</div><div class="card-sub">Скачивание прямо из панели</div></div></div><div class="empty-row">Клиенты не найдены. Проверьте доступ панели к GitHub.</div></section>'}
    <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Подключение</div><div class="card-sub">ID/Relay Server и ключ</div></div><button class="btn btn-sm" data-carbon-action="rustdesk-instructions">${icon('link')}Полная инструкция</button></div><div class="list"><div class="list-row"><b>ID Server</b><span class="mono">${escHtml(r.host || '—')}</span></div><div class="list-row"><b>Relay Server</b><span class="mono">${escHtml(r.relay || '—')}</span></div><div class="list-row"><b>Key</b><span class="mono">${escHtml(r.publicKey || '—')}</span></div></div><div class="donut-note" style="margin-top:10px">1. Скачайте клиент для своей ОС. 2. Установите и откройте RustDesk. 3. Настройки → Сеть → ID/Relay Server. 4. Укажите ID Server, Relay Server и Key. 5. Подключитесь по ID. Источник: ${escHtml(r.source || 'github.com/rustdesk/rustdesk')}.${r.error ? ' ' + escHtml(r.error) : ''}</div></section>
    </div>`;
}

function realDiagnostics() {
  const logs = [
    ['/var/log/awg_install.log', 'Установка AWG'],
    ['/var/log/mtproto_install.log', 'Установка MTProto'],
    ['/var/log/mtproxyl_install.log', 'Установка MTProxyL'],
    ['/var/log/adguard_install.log', 'Установка AdGuard'],
    ['/var/log/warp_install.log', 'Установка WARP/Xray'],
    ['/var/log/nginx/error.log', 'Nginx error'],
    ['/var/log/nginx/access.log', 'Nginx access'],
    ['/var/log/auth.log', 'Auth'],
    ['/var/log/syslog', 'Syslog']
  ];
  return `<div class="page-head"><div><div class="page-title">Диагностика</div><div class="page-sub">Ping, traceroute и журнал через API.</div></div><div class="page-actions"><button class="btn btn-primary" data-carbon-action="diag-check">${icon('pulse')}Проверить всё</button><button class="btn" data-carbon-action="diag-tc">${icon('pulse')}TCP-проверка</button><button class="btn" data-carbon-action="diag-wan">${icon('down')}Скорость WAN</button><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button></div></div>
    <div class="grid"><section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Ping</div><div class="card-sub">/api/diag/ping</div></div></div><label class="field"><span>Хост</span><input id="carbonPingHost" value="1.1.1.1"></label><button class="btn btn-primary" style="margin-top:12px" data-api-action="diag-ping">Запустить</button><pre id="carbonPingOut" class="code" style="margin-top:12px;padding:10px;white-space:pre-wrap"></pre></section>
    <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Traceroute</div><div class="card-sub">/api/diag/traceroute</div></div></div><label class="field"><span>Хост</span><input id="carbonTraceHost" value="1.1.1.1"></label><button class="btn btn-primary" style="margin-top:12px" data-api-action="diag-trace">Запустить</button><pre id="carbonTraceOut" class="code" style="margin-top:12px;padding:10px;white-space:pre-wrap"></pre></section>
    <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Журнал</div><div class="card-sub">/api/diag/log</div></div><div class="page-actions"><label class="field" style="min-width:240px"><span>Журнал</span><select id="carbonLogFile">${logs.map(([v, l]) => `<option value="${escHtml(v)}">${escHtml(l)}</option>`).join('')}</select></label><button class="btn btn-sm" data-api-action="diag-log">${icon('refresh')}Обновить</button></div></div><pre id="carbonLogOut" class="code" style="margin:0;padding:10px;white-space:pre-wrap;color:var(--text);min-height:220px;max-height:460px;overflow:auto">Выберите журнал и нажмите «Обновить»</pre></section></div>`;
}

function realAdmin() {
  const rawUsers = (carbon.users && carbon.users.users) || [];
  const users = rawUsers.some(u => u.username === 'admin')
    ? rawUsers
    : [{ username: 'admin', role: 'admin', createdAt: null, totpEnabled: false, builtin: true }, ...rawUsers];
  const audit = (carbon.audit && carbon.audit.entries) || [];
  const b = carbon.backup || {};
  const n = carbon.notify || {};
  const bc = b.config || {};
  const archives = b.archives || [];
  const sec = carbon.security || {};
  return `<div class="page-head"><div><div class="page-title">Администрирование</div><div class="page-sub">Пользователи, 2FA, аудит, бэкапы и Telegram.</div></div><div class="page-actions"><button class="btn" data-carbon-action="user-add">${icon('plus')}Пользователь</button><button class="btn" data-carbon-action="2fa-setup">${icon('shield')}Настроить 2FA</button><button class="btn" data-carbon-action="backup-save">${icon('box')}Автобэкап</button><button class="btn" data-carbon-action="notify-save">${icon('bell')}Telegram</button><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button></div></div>
    <div class="mini-grid">${mini('Пользователей', String(users.length), 'панели')}${mini('2FA', sec.totpEnabled ? 'включена' : 'выключена', 'текущий вход')}${mini('Аудит', String(audit.length), 'записей')}${mini('Автобэкап', bc.enabled ? 'включён' : 'выключен', bc.time || '—')}${mini('Telegram', n.enabled ? 'включён' : 'выключен', n.chatId || '—')}${mini('Архивов', String(archives.length), 'бэкапов')}</div>
    <div class="grid"><section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">Пользователи</div><div class="card-sub">/api/users</div></div>${tag(String(users.length), 'muted')}</div><div class="table-scroll"><table class="table"><thead><tr><th>Логин</th><th>Роль</th><th>2FA</th><th>Создан</th><th></th></tr></thead><tbody>${users.map(u => `<tr><td class="name">${escHtml(u.username)}</td><td>${escHtml(u.role === 'admin' ? 'администратор' : u.role)}</td><td>${u.totpEnabled ? 'вкл' : 'выкл'}</td><td class="mono">${escHtml(u.builtin ? 'встроенный' : (u.createdAt ? fmtDate(u.createdAt) : (u.created || '—')))}</td><td>${u.builtin ? '' : `<button class="row-action" data-carbon-action="user-delete" data-name="${escHtml(u.username)}" title="Удалить">${icon('trash')}</button>`}</td></tr>`).join('') || '<tr><td colspan="5">Пользователей нет</td></tr>'}</tbody></table></div></section>
    <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">Аудит</div><div class="card-sub">последние действия</div></div>${tag('live', 'good')}</div><div class="list">${audit.slice(0, 10).map(e => `<div class="list-row"><b>${escHtml(e.user || '—')}</b><span class="mono">${escHtml(e.action || '')}</span></div>`).join('') || '<div class="list-row"><b>Нет записей</b></div>'}</div></section>
    <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">2FA</div><div class="card-sub">TOTP для текущего пользователя</div></div>${tag(sec.totpEnabled ? 'включена' : 'выключена', sec.totpEnabled ? 'good' : 'warn')}</div><div class="page-actions" style="margin-top:12px"><button class="btn btn-primary" data-carbon-action="2fa-setup">${icon('shield')}Настроить</button><button class="btn btn-danger" data-carbon-action="2fa-disable">${icon('stop')}Отключить</button></div></section>
    <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Автобэкап</div><div class="card-sub">${bc.schedule || 'daily'} · ${bc.time || '—'} · хранить ${bc.keep || 7}</div></div>${tag(bc.enabled ? 'включён' : 'выключен', bc.enabled ? 'good' : 'warn')}</div><div class="list"><div class="list-row"><b>Шифрование</b><span class="mono">${bc.encrypt !== false ? 'AES-256' : 'нет'}</span></div><div class="list-row"><b>Пароль</b><span class="mono">${b.passwordSet ? 'задан' : 'не задан'}</span></div><div class="list-row"><b>Таймер</b><span class="mono">${b.timerActive ? 'активен' : 'неактивен'}</span></div>${archives.slice(0, 3).map(a => `<div class="list-row"><b><a href="/api/backup/archive/${encodeURIComponent(a.name)}">${escHtml(a.name || '—')}</a></b><span class="mono">${fmtBytes(a.size || 0)}</span></div>`).join('')}</div><div class="page-actions" style="margin-top:12px"><button class="btn" data-carbon-action="backup-run">${icon('box')}Создать сейчас</button><button class="btn" data-carbon-action="backup-password">${icon('key')}Пароль</button></div></section>
    <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Telegram</div><div class="card-sub">${n.chatId ? 'chat ' + escHtml(n.chatId) : 'не настроен'}</div></div>${tag(n.enabled ? 'включён' : 'выключен', n.enabled ? 'good' : 'warn')}</div><div class="list"><div class="list-row"><b>Токен</b><span class="mono">${n.hasToken ? 'сохранён' : 'не задан'}</span></div><div class="list-row"><b>Последний алерт</b><span class="mono">${n.lastAlertAt ? fmtDate(n.lastAlertAt) : '—'}</span></div></div><div class="page-actions" style="margin-top:12px"><button class="btn" data-carbon-action="notify-save">${icon('wrench')}Настроить</button><button class="btn" data-carbon-action="notify-test">${icon('bell')}Тест</button></div></section></div>`;
}

function bindRealData() {
  tabs.dashboard = realDashboard;
  tabs.clients = realClients;
  tabs.install = realInstall;
  tabs.services = realServices;
  tabs.security = realSecurity;
  tabs.update = realUpdate;
  tabs.network = realNetwork;
  tabs.cascade = realCascade;
  tabs.obfuscation = realObfuscation;
  tabs.proxy = realProxy;
  tabs.domains = realDomains;
  tabs.app = realApp;
  tabs.rustdesk = realRustdesk;
  tabs.diagnostics = realDiagnostics;
  tabs.admin = realAdmin;
}

document.addEventListener('click', async event => {
  const logout = event.target.closest('[data-action="logout"]');
  if (logout) {
    event.preventDefault();
    event.stopImmediatePropagation();
    await carbonLogout();
    return;
  }
  const pwd = event.target.closest('[data-action="change-password"]');
  if (pwd) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const next = document.getElementById('pwdNew')?.value || '';
    const repeat = document.getElementById('pwdRepeat')?.value || '';
    if (next.length < 12) { showToast('Новый пароль — минимум 12 символов'); return; }
    if (next !== repeat) { showToast('Пароли не совпадают'); return; }
    try {
      await api('/api/users/' + encodeURIComponent(carbon.user || 'admin') + '/password', { method: 'POST', body: { password: next } });
      const modal = document.getElementById('passwordModal');
      if (modal) modal.hidden = true;
      ['pwdNew', 'pwdRepeat'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      showToast('Пароль изменён');
    } catch (e) { showToast(e.message || 'Ошибка смены пароля'); }
    return;
  }
  const create = event.target.closest('[data-action="create-client"]');
  if (create) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const name = document.getElementById('newClientName')?.value.trim();
    if (!name) { showToast('Укажите имя клиента'); return; }
    const days = Number(document.getElementById('newClientDays')?.value) || 0;
    const expires = days > 0 ? Math.floor(days) + 'd' : '';
    const count = Math.max(1, Math.min(100, parseInt(document.getElementById('newClientCount')?.value, 10) || 1));
    const epType = document.getElementById('newClientEndpoint')?.value === 'domain' ? 'domain' : 'ip';
    const domain = epType === 'domain' ? (document.getElementById('newClientDomain')?.value.trim() || '') : '';
    if (epType === 'domain' && !domain) { showToast('Укажите домен для endpoint'); return; }
    try {
      if (count > 1) {
        const data = await api('/api/create-bulk', { method: 'POST', body: { prefix: name, count, expires, endpointType: epType, domain } });
        const names = (data.configs || []).map(c => c.name);
        if (!names.length) throw new Error('Конфиги не сгенерировались');
        const file = await downloadRequest('/api/download-bulk', { names });
        saveBlob(file.blob, file.filename || 'servpanel-configs.zip');
        closeClientModal();
        await loadCarbonData();
        render();
        showToast('Создано клиентов: ' + names.length);
      } else {
        const file = await downloadRequest('/api/create', { name, expires, endpointType: epType, domain });
        saveBlob(file.blob, file.filename || (name + '.conf'));
        closeClientModal();
        await loadCarbonData();
        render();
        showToast('Клиент создан: ' + name);
      }
    } catch (e) { showToast(e.message || 'Ошибка создания клиента'); }
    return;
  }
  const btn = event.target.closest('[data-api-action]');
  if (!btn) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const action = btn.dataset.apiAction;
  const finishBusy = typeof carbonBusyStart === 'function' ? carbonBusyStart(btn) : () => {};
  try {
    if (action === 'refresh') {
      btn.disabled = true;
      await loadCarbonData();
      render();
      showToast('Данные обновлены');
    } else if (action === 'delete-client') {
      if (!confirm(`Удалить клиента ${btn.dataset.name}?`)) return;
      await api('/api/delete/' + encodeURIComponent(btn.dataset.name), { method: 'DELETE' });
      await loadCarbonData();
      render();
      showToast('Клиент удалён');
    } else if (action === 'install-module') {
      const module = btn.dataset.module;
      if (!confirm(`Установить ${module}?`)) return;
      const body = { module };
      if (module === 'mtproto') body.kind = 'telemt';
      await api('/api/install/module', { method: 'POST', body });
      showToast('Установка запущена: ' + module);
    } else if (action === 'uninstall-module') {
      const module = btn.dataset.module;
      const check = prompt(`Удалить ${module}? Введите DELETE`);
      if (check !== 'DELETE') return;
      await api('/api/modules/uninstall', { method: 'POST', body: { module } });
      await loadCarbonData();
      render();
      showToast('Модуль удалён');
    } else if (action === 'restart-service') {
      await api('/api/services/restart', { method: 'POST', body: { name: btn.dataset.name } });
      showToast('Служба перезапущена: ' + btn.dataset.name);
    } else if (action === 'geoip-enable') {
      const box = document.getElementById('carbonGeoIfaces');
      const ifaces = box ? [...box.querySelectorAll('input[type=checkbox]:checked')].map(x => x.value) : [];
      const schedule = document.getElementById('carbonGeoSchedule')?.value || 'weekly';
      const listMode = document.getElementById('carbonGeoListMode')?.value || 'antifilter';
      const customUrl = document.getElementById('carbonGeoCustomUrl')?.value.trim() || '';
      const ports = document.getElementById('carbonGeoPorts')?.value.trim() || '';
      await api('/api/tools/rudrop', { method: 'POST', body: { ifaces, schedule, enable: true, listMode, customUrl, ports } });
      showToast('GeoIP-блокировка включена');
    } else if (action === 'geoip-disable') {
      await api('/api/tools/rudrop', { method: 'POST', body: { enable: false } });
      showToast('GeoIP-блокировка отключена');
    } else if (action === 'backup-run') {
      await api('/api/backup/run', { method: 'POST' });
      showToast('Бэкап создаётся');
    } else if (action === 'module-logs') {
      const st = await api('/api/install/state').catch(() => null);
      let text = 'Журнал установки пока пуст.';
      if (st && st.logFile) {
        try {
          text = await api('/api/install/log?file=' + encodeURIComponent(st.logFile));
        } catch (e) {
          text = e.message || 'Не удалось прочитать журнал';
        }
      }
      showCarbonLog('Журнал установки', typeof text === 'string' ? text : JSON.stringify(text, null, 2));
    } else if (action === 'cascade-teardown') {
      if (prompt('Удалить каскад? Введите DELETE') !== 'DELETE') return;
      await api('/api/cascade/teardown', { method: 'POST' });
      await loadCarbonData(); render(); showToast('Каскад удалён');
    } else if (action === 'obf-apply') {
      await api('/api/obf/profiles/' + encodeURIComponent(btn.dataset.profile) + '/apply', { method: 'POST' });
      await loadCarbonData(); render(); showToast('Профиль применён');
    } else if (action === 'proxy-restart') {
      await api('/api/proxy/restart', { method: 'POST' });
      showToast('Прокси перезапущен');
    } else if (action === 'proxy-user-delete') {
      if (!confirm('Удалить пользователя ' + btn.dataset.name + '?')) return;
      await api('/api/proxy/users/' + encodeURIComponent(btn.dataset.name), { method: 'DELETE' });
      await loadCarbonData(); render(); showToast('Пользователь удалён');
    } else if (action === 'rustdesk-install') {
      await api('/api/rustdesk/install', { method: 'POST' });
      showToast('Установка RustDesk запущена');
    } else if (action === 'rustdesk-uninstall') {
      if (prompt('Удалить RustDesk? Введите DELETE') !== 'DELETE') return;
      await api('/api/rustdesk/uninstall', { method: 'POST' });
      showToast('Удаление RustDesk запущено');
    } else if (action === 'diag-ping') {
      const data = await api('/api/diag/ping', { method: 'POST', body: { host: document.getElementById('carbonPingHost').value, count: 4 } });
      document.getElementById('carbonPingOut').textContent = JSON.stringify(data, null, 2);
    } else if (action === 'diag-trace') {
      const data = await api('/api/diag/traceroute', { method: 'POST', body: { host: document.getElementById('carbonTraceHost').value } });
      document.getElementById('carbonTraceOut').textContent = JSON.stringify(data, null, 2);
    } else if (action === 'diag-log') {
      const file = document.getElementById('carbonLogFile')?.value || '/var/log/warp_install.log';
      const data = await api('/api/diag/log?file=' + encodeURIComponent(file));
      document.getElementById('carbonLogOut').textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    } else if (action === 'user-delete') {
      if (!confirm('Удалить пользователя ' + btn.dataset.name + '?')) return;
      await api('/api/users/' + encodeURIComponent(btn.dataset.name), { method: 'DELETE' });
      await loadCarbonData(); render(); showToast('Пользователь удалён');
    }
  } catch (e) {
    showToast(e.message || 'Ошибка');
  } finally {
    btn.disabled = false;
    finishBusy();
  }
}, true);

let carbonFastTimer = null;
let carbonStatsTimer = null;
let carbonFastBusy = false;
let carbonStatsBusy = false;
let carbonDistTick = 0;
let carbonLastStatsAt = 0;

function setLiveText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function updateDashboardClients() {
  const clients = carbon.clients || [];
  const online = clients.filter(clientStatus).length;
  const rx = clients.reduce((a, c) => a + (Number(c.rx) || 0), 0);
  const tx = clients.reduce((a, c) => a + (Number(c.tx) || 0), 0);
  setLiveText('liveTx', fmtBytes(tx));
  setLiveText('liveRx', fmtBytes(rx));
  setLiveText('liveClients', String(clients.length));
  setLiveText('liveOnline', String(online));
  const total = rx + tx;
  const setBar = (id, pct) => {
    const el = document.getElementById(id);
    if (el) el.style.width = pct.toFixed(1) + '%';
  };
  setBar('kpiTxBar', total ? tx / total * 100 : 0);
  setBar('kpiRxBar', total ? rx / total * 100 : 0);
  setBar('kpiClientsBar', clients.length ? online / clients.length * 100 : 0);
  const tbody = document.querySelector('#view #clientsTable tbody');
  if (tbody) tbody.innerHTML = realClientRows();
}

function updateDashboardSystem() {
  const system = carbon.sys || {};
  setLiveText('liveUptime', system.uptime || '—');
  setLiveText('liveUptimeMeta', system.uptime || '—');
  setLiveText('liveCpu', (system.cpu || '—') + '%');
  setLiveText('liveRam', (system.ram || '—') + '%');
  const hRx = (carbon.history && carbon.history.rx) || [];
  const hTx = (carbon.history && carbon.history.tx) || [];
  const lastRx = hRx.length ? hRx[hRx.length - 1] : 0;
  const lastTx = hTx.length ? hTx[hTx.length - 1] : 0;
  setLiveText('liveSpeed', '↓ ' + fmtBytes(lastRx) + '/s · ↑ ' + fmtBytes(lastTx) + '/s');
  const chart = document.getElementById('liveChartCard');
  if (chart && !chart.matches(':hover')) chart.outerHTML = realTrafficChart();
}

function updateDashboardDonut() {
  const donut = document.getElementById('liveDistributionCard');
  if (donut && !donut.matches(':hover')) donut.outerHTML = realTrafficDistribution();
}

async function refreshDashboardFast() {
  if (document.hidden || carbonFastBusy) return;
  if (typeof state !== 'undefined' && state.tab !== 'dashboard') return;
  if (typeof carbon === 'undefined' || !carbon.loaded) return;
  carbonFastBusy = true;
  try {
    // CPU/RAM/uptime и скорость — быстрый опрос каждые 2.5 с.
    // Диаграмму распределения обновляем реже, чтобы не грузить сервер.
    carbonDistTick++;
    const wantDist = carbonDistTick % 2 === 0;
    const [sys, hist, dist] = await Promise.all([
      api('/api/sysinfo').catch(() => null),
      api('/api/history?range=' + encodeURIComponent(carbon.chartRange) + '&view=global').catch(() => null),
      wantDist ? api('/api/traffic/distribution').catch(() => null) : Promise.resolve(null)
    ]);
    if (sys && !sys.error) carbon.sys = sys;
    if (hist && !hist.error) carbon.history = hist;
    if (dist && !dist.error) carbon.distribution = dist;
    updateDashboardSystem();
    if (dist && !dist.error) updateDashboardDonut();
  } catch (e) {
    /* тихо ждём следующего тика */
  } finally {
    carbonFastBusy = false;
  }
}

async function refreshDashboardStats() {
  if (document.hidden || carbonStatsBusy) return;
  if (typeof state !== 'undefined' && state.tab !== 'dashboard') return;
  if (typeof carbon === 'undefined' || !carbon.loaded) return;
  carbonStatsBusy = true;
  try {
    // manage stats на медленных VPS идёт 2-4 с — отдельный редкий опрос.
    const stats = await api('/api/stats').catch(() => null);
    if (Array.isArray(stats)) {
      carbon.clients = stats;
      carbonLastStatsAt = Date.now();
      updateDashboardClients();
      applyShellData();
    }
  } catch (e) {
    /* тихо ждём следующего тика */
  } finally {
    carbonStatsBusy = false;
  }
}

function startDashboardLive() {
  if (carbonFastTimer) return;
  carbonFastTimer = setInterval(refreshDashboardFast, 2500);
  carbonStatsTimer = setInterval(refreshDashboardStats, 15000);
}

function renderCarbonLoading() {
  const view = document.getElementById('view');
  if (view) view.innerHTML = '<div class="carbon-loading">Загрузка данных…</div>';
}

async function initCarbon() {
  bindRealData();
  bindGlobalSearch();
  bindMobileMenu();
  renderCarbonLoading();
  try {
    const sec = await api('/api/security/status');
    if (sec && sec.user) {
      carbon.user = sec.user;
      carbon.role = sec.role || carbon.role;
    }
  } catch (e) {
    if (String(e.message).includes('Unauthorized') || String(e.message).includes('401')) {
      showCarbonLogin();
      return;
    }
  }
  try {
    await loadCarbonData();
    document.getElementById('carbonLogin')?.remove();
    render();
  } catch (e) {
    render();
    showToast(e.message || 'Ошибка загрузки');
  }
  startDashboardLive();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { initCarbon(); });
} else {
  initCarbon();
}
