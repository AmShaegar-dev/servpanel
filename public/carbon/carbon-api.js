'use strict';

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
  loaded: false
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
    const msg = (data && data.error) || (typeof data === 'string' ? data : 'Ошибка запроса');
    throw new Error(msg);
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
  const safe = p => api(p).catch(() => null);
  const [stats, clients, modules, services, security, interfaces, update, server, sys, ufw, cascade, cascadeProxy, obf, profiles, proxy, proxyUsers, ssl, app, rustdesk, users, audit, backup, notify, awgConfig] = await Promise.all([
    safe('/api/stats'), safe('/api/clients'), safe('/api/modules'), safe('/api/services'),
    safe('/api/security/status'), safe('/api/interfaces'), safe('/api/update/info'),
    safe('/api/server-info'), safe('/api/sysinfo'), safe('/api/ufw'), safe('/api/cascade/status'),
    safe('/api/cascade/proxy'), safe('/api/obf/current'), safe('/api/obf/profiles'),
    safe('/api/proxy/status'), safe('/api/proxy/users'), safe('/api/ssl/status'),
    safe('/api/app/status'), safe('/api/rustdesk/status'), safe('/api/users'),
    safe('/api/audit?limit=50'), safe('/api/backup/auto'), safe('/api/notify/status'),
    safe('/api/awg/config')
  ]);
  carbon.stats = Array.isArray(stats) ? stats : [];
  carbon.clients = Array.isArray(clients) ? clients : carbon.stats;
  carbon.modules = (modules && modules.modules) || [];
  carbon.services = Array.isArray(services) ? services : [];
  carbon.security = security;
  carbon.interfaces = Array.isArray(interfaces) ? interfaces : [];
  carbon.update = update;
  carbon.server = server;
  carbon.sys = sys;
  carbon.ufw = ufw;
  carbon.cascade = cascade;
  carbon.cascadeProxy = cascadeProxy;
  carbon.obf = obf;
  carbon.profiles = profiles;
  carbon.proxy = proxy;
  carbon.proxyUsers = proxyUsers;
  carbon.ssl = ssl;
  carbon.app = app;
  carbon.rustdesk = rustdesk;
  carbon.users = users;
  carbon.audit = audit;
  carbon.backup = backup;
  carbon.notify = notify;
  carbon.awgConfig = awgConfig;
  carbon.loaded = true;
}

function clientStatus(c) {
  return c.status_code === 'active' || c.status_code === 'recent';
}

function realClientRows() {
  if (!carbon.clients.length) return `<tr class="empty-row"><td colspan="7">Клиентов пока нет. Создайте первого.</td></tr>`;
  return carbon.clients.map(c => {
    const online = clientStatus(c);
    const total = (Number(c.rx) || 0) + (Number(c.tx) || 0);
    return `<tr data-name="${escHtml(c.name)}" data-ip="${escHtml(c.ip)}">
      <td class="name">${escHtml(c.name)}</td>
      <td class="mono">${escHtml(c.ip || '—')}</td>
      <td>${escHtml(c.status || (online ? 'Активен' : 'Неактивен'))}</td>
      <td class="mono">${fmtBytes(total)}</td>
      <td><div class="bar"><span style="width:${online ? 100 : 15}%"></span></div></td>
      <td><span class="status ${online ? '' : 'idle'}"><span class="dot"></span>${online ? 'online' : 'offline'}</span></td>
      <td><div class="page-actions"><button class="row-action" data-copy="${escHtml(c.ip || '')}" title="Скопировать IP">${icon('copy')}</button><button class="row-action" data-api-action="delete-client" data-name="${escHtml(c.name)}" title="Удалить">${icon('trash')}</button></div></td>
    </tr>`;
  }).join('');
}

function realClientsTable() {
  return `<div class="table-tools"><div class="table-search">${icon('search')}<input id="clientSearch" placeholder="Имя или IP" aria-label="Фильтр клиентов"></div><button class="tag" data-toast="Клиентов: ${carbon.clients.length}">Все клиенты ${icon('arrow', 'ico')}</button></div>
    <div class="table-scroll"><table class="table" id="clientsTable"><thead><tr><th>Клиент</th><th>IP</th><th>Статус</th><th>Трафик</th><th>Загрузка</th><th>Статус</th><th style="width:80px"></th></tr></thead><tbody>${realClientRows()}</tbody></table></div>`;
}

function realDashboard() {
  const clients = carbon.clients;
  const online = clients.filter(clientStatus).length;
  const rx = clients.reduce((a, c) => a + (Number(c.rx) || 0), 0);
  const tx = clients.reduce((a, c) => a + (Number(c.tx) || 0), 0);
  const s = carbon.server || {};
  const sys = carbon.sys || {};
  return `
    <div class="overview">
      <div class="server-id"><span class="dot"></span><div><div class="server-name">Servpanel · ${escHtml(s.country || 'сервер')}</div><div class="server-meta">${escHtml(s.ip || 'IP —')} · uptime ${escHtml(sys.uptime || '—')} · build ${escHtml(carbon.update ? carbon.update.version : '—')}</div></div></div>
      <div class="overview-actions"><div class="live"><span class="dot"></span>API подключён</div><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button><button class="btn btn-primary" data-action="open-client-modal">${icon('plus')}Добавить клиента</button></div>
    </div>
    <div class="grid">
      ${kpi('Исходящий', fmtBytes(tx), 'TX всего', 'upload', '', 70)}
      ${kpi('Входящий', fmtBytes(rx), 'RX всего', 'download', 'amber', 45, 'var(--accent-2)')}
      ${kpi('Клиенты', String(clients.length), online + ' онлайн', 'users', 'neutral', clients.length ? 60 : 5, 'var(--good)')}
      ${kpi('Uptime', escHtml(sys.uptime || '—'), 'с последнего запуска', 'pulse', 'neutral', 90, 'var(--accent-2)')}
      <section class="card chart-card" style="position:relative"><div class="card-top"><div><div class="card-title">Сервер</div><div class="card-sub">реальные данные API</div></div>${tag('live', 'good')}</div><div class="mini-grid" style="grid-template-columns:1fr 1fr;margin:0">${mini('CPU', (sys.cpu || '—') + '%', 'нагрузка')}${mini('RAM', (sys.ram || '—') + '%', 'использование')}${mini('Интерфейсы', String(carbon.interfaces.length), 'сетевые')}${mini('Модули', String(carbon.modules.filter(m => m.installed).length) + ' / ' + carbon.modules.length, 'установлено')}</div></section>
      <section class="card donut-card"><div class="card-top"><div><div class="card-title">Службы</div><div class="card-sub">ключевые узлы</div></div>${tag(carbon.services.filter(x => x.state === 'active').length + ' / ' + carbon.services.length, 'good')}</div><div class="list">${carbon.services.slice(0, 6).map(s => `<div class="list-row"><b>${escHtml(s.name)}</b><span class="mono">${escHtml(s.state || s.status)}</span></div>`).join('') || '<div class="list-row"><b>Нет данных</b></div>'}</div></section>
      <section class="card table-card"><div class="card-top"><div><div class="card-title">Клиенты</div><div class="card-sub">активные подключения</div></div><button class="tag" data-tab="clients">Все ${icon('arrow', 'ico')}</button></div>${realClientsTable()}</section>
    </div>`;
}

function realClients() {
  const online = carbon.clients.filter(clientStatus).length;
  return `<div class="page-head"><div><div class="page-title">Клиенты</div><div class="page-sub">Реальный список из API. Создание, удаление и статусы.</div></div><div class="page-actions"><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button><button class="btn btn-primary" data-action="open-client-modal">${icon('plus')}Добавить клиента</button></div></div>
    <div class="mini-grid">${mini('Всего клиентов', String(carbon.clients.length), 'в панели')}${mini('Онлайн', String(online), 'активные')}${mini('Трафик RX', fmtBytes(carbon.clients.reduce((a, c) => a + (Number(c.rx) || 0), 0)), 'всего')}${mini('Трафик TX', fmtBytes(carbon.clients.reduce((a, c) => a + (Number(c.tx) || 0), 0)), 'всего')}</div>
    <section class="card table-card"><div class="card-top"><div><div class="card-title">Все клиенты</div><div class="card-sub">API /api/clients</div></div></div>${realClientsTable()}</section>`;
}

function realInstall() {
  const installed = carbon.modules.filter(m => m.installed).length;
  return `<div class="page-head"><div><div class="page-title">Установка</div><div class="page-sub">Реальные модули сервера. Установка и удаление через API.</div></div><div class="page-actions"><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button></div></div>
    <div class="mini-grid">${mini('Модулей', String(carbon.modules.length), 'всего')}${mini('Установлено', String(installed), 'активно')}${mini('Не установлено', String(carbon.modules.length - installed), 'доступно')}${mini('Версия панели', carbon.update ? escHtml(carbon.update.version) : '—', 'build')}</div>
    <div class="grid">${carbon.modules.map(m => `<section class="card" style="grid-column:span 4"><div class="card-top"><div><div class="card-title">${escHtml(m.title)}</div><div class="card-sub">${escHtml(m.description || '')}</div></div>${tag(m.installed ? (m.running ? 'работает' : 'остановлен') : 'не установлен', m.installed ? (m.running ? 'good' : 'warn') : '')}</div><div class="list"><div class="list-row"><b>Порт</b><span class="mono">${escHtml(m.port || '—')}</span></div><div class="list-row"><b>Служба</b><span class="mono">${escHtml(m.service || '—')}</span></div><div class="list-row"><b>Конфиг</b><span class="mono">${escHtml(m.configPath || '—')}</span></div></div><div class="module-actions"><button class="btn ${m.installed ? '' : 'btn-primary'}" data-api-action="${m.installed ? 'uninstall-module' : 'install-module'}" data-module="${escHtml(m.id)}">${icon(m.installed ? 'trash' : 'download')}${m.installed ? 'Удалить' : 'Установить'}</button><button class="btn" data-api-action="module-logs" data-module="${escHtml(m.id)}">${icon('terminal')}Логи</button></div></section>`).join('') || '<section class="card"><div class="empty-row">Нет данных о модулях</div></section>'}</div>`;
}

function realServices() {
  return `<div class="page-head"><div><div class="page-title">Службы и DNS</div><div class="page-sub">Реальные systemd-службы. Перезапуск через API.</div></div><div class="page-actions"><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button></div></div>
    <section class="card table-card"><div class="card-top"><div><div class="card-title">Системные службы</div><div class="card-sub">/api/services</div></div>${tag(carbon.services.filter(s => s.state === 'active').length + ' / ' + carbon.services.length, 'good')}</div><div class="table-scroll"><table class="table"><thead><tr><th>Служба</th><th>Описание</th><th>Состояние</th><th>Автозапуск</th><th></th></tr></thead><tbody>${carbon.services.map(s => `<tr><td class="name">${escHtml(s.name)}</td><td>${escHtml(s.desc || '')}</td><td><span class="status ${s.state === 'active' ? '' : 'idle'}"><span class="dot"></span>${escHtml(s.state || s.status)}</span></td><td class="mono">${s.enabled ? 'enabled' : 'disabled'}</td><td><button class="row-action" data-api-action="restart-service" data-name="${escHtml(s.name)}" title="Перезапустить">${icon('refresh')}</button></td></tr>`).join('') || '<tr><td colspan="5">Нет данных</td></tr>'}</tbody></table></div></section>`;
}

function realSecurity() {
  const sec = carbon.security || {};
  const active = (carbon.interfaces || []).map(i => `<option>${escHtml(i)}</option>`).join('');
  return `<div class="page-head"><div><div class="page-title">Защита и GeoIP</div><div class="page-sub">Реальные настройки безопасности и GeoIP.</div></div><div class="page-actions"><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button></div></div>
    <div class="mini-grid">${mini('Панель', sec.https ? 'HTTPS' : 'HTTP', 'порт ' + (sec.panelPublicPort || '—'))}${mini('2FA', sec.totpEnabled ? 'включена' : 'выключена', 'TOTP')}${mini('Пользователи', String(sec.users || 0), 'панели')}${mini('Node', sec.node || '—', 'runtime')}</div>
    <section class="card"><div class="card-top"><div><div class="card-title">GeoIP: блокировка RU</div><div class="card-sub">Правила применяются к выбранным интерфейсам целиком</div></div>${tag('API', 'good')}</div><div class="form-grid"><label class="field"><span>Интерфейсы</span><select id="carbonGeoIfaces" multiple size="4">${active}</select></label><label class="field"><span>Расписание</span><select id="carbonGeoSchedule"><option value="weekly">Раз в неделю</option><option value="daily">Каждый день</option><option value="none">Не обновлять</option></select></label></div><div class="page-actions" style="margin-top:14px"><button class="btn btn-primary" data-api-action="geoip-enable">${icon('shield')}Включить</button><button class="btn btn-danger" data-api-action="geoip-disable">${icon('stop')}Отключить</button></div><div class="donut-note">Порты не используются — блокировка только по интерфейсам.</div></section>`;
}

function realUpdate() {
  const u = carbon.update || {};
  return `<div class="page-head"><div><div class="page-title">Обновление</div><div class="page-sub">Реальная версия, Git и резервные копии.</div></div><div class="page-actions"><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button></div></div>
    <div class="mini-grid">${mini('Версия', escHtml(u.version || '—'), 'установлена')}${mini('Git', u.git && u.git.available ? 'доступен' : 'нет', u.git && u.git.branch ? escHtml(u.git.branch) : '—')}${mini('Бэкапы', String((u.backups || []).length), 'архивов')}${mini('Порт', String(u.port || '—'), 'панель')}</div>
    <section class="card"><div class="card-top"><div><div class="card-title">Что нового</div><div class="card-sub">${escHtml(u.version || '')}</div></div>${tag('stable', 'good')}</div><div class="list"><div class="list-row"><b>Каталог</b><span class="mono">${escHtml(u.appDir || '—')}</span></div><div class="list-row"><b>Данные</b><span class="mono">${escHtml(u.dataDir || '—')}</span></div><div class="list-row"><b>Обновление</b><span class="mono">${escHtml((u.status && u.status.message) || '—')}</span></div><div class="list-row"><b>Лимит загрузки</b><span class="mono">${escHtml(String((u.limits && u.limits.uploadMb) || '—'))} MB</span></div></div><div class="page-actions" style="margin-top:14px"><button class="btn" data-api-action="backup-run">${icon('box')}Создать бэкап</button><a class="btn" href="/">${icon('external')}Старая панель для обновления</a></div></section>`;
}

function realNetwork() {
  const ifaces = carbon.interfaces || [];
  const ufw = carbon.ufw || {};
  const rules = Array.isArray(ufw.rules) ? ufw.rules : (Array.isArray(ufw) ? ufw : []);
  return `<div class="page-head"><div><div class="page-title">Сеть и порты</div><div class="page-sub">Интерфейсы, UFW и конфиг AWG из API.</div></div><div class="page-actions"><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button></div></div>
    <div class="mini-grid">${mini('Интерфейсов', String(ifaces.length), 'системных')}${mini('UFW', rules.length ? String(rules.length) + ' правил' : 'нет данных', 'firewall')}${mini('AWG', carbon.awgConfig && carbon.awgConfig.text ? 'конфиг есть' : 'нет конфига', 'awg0')}${mini('Внешний IP', escHtml((carbon.server && carbon.server.ip) || '—'), (carbon.server && carbon.server.country) || '')}</div>
    <div class="grid"><section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">Интерфейсы</div><div class="card-sub">/api/interfaces</div></div>${tag(String(ifaces.length), 'good')}</div><div class="service-list">${ifaces.map(i => `<div class="service"><div class="service-ico">${icon('globe')}</div><div><div class="service-name">${escHtml(i)}</div><div class="service-desc">системный интерфейс</div></div><div class="service-state"><span class="dot"></span>up</div></div>`).join('') || '<div class="service"><div class="service-name">Нет данных</div></div>'}</div></section>
    <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">UFW</div><div class="card-sub">/api/ufw</div></div>${tag(rules.length ? 'active' : 'нет данных', rules.length ? 'good' : 'warn')}</div><div class="table-scroll"><table class="table" style="min-width:0"><thead><tr><th>Правило</th><th>Действие</th></tr></thead><tbody>${rules.map(r => `<tr><td class="mono">${escHtml(r.rule || r.port || r)}</td><td>${escHtml(r.action || r.status || '')}</td></tr>`).join('') || '<tr><td colspan="2">UFW недоступен</td></tr>'}</tbody></table></div></section>
    <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">AmneziaWG</div><div class="card-sub">/api/awg/config</div></div>${tag('advanced', 'muted')}</div><pre class="code" style="margin:0;max-height:280px;overflow:auto;padding:12px;white-space:pre-wrap">${escHtml((carbon.awgConfig && carbon.awgConfig.text) || 'Конфиг не найден или недоступен')}</pre></section></div>`;
}

function realCascade() {
  const c = carbon.cascade || {};
  const p = carbon.cascadeProxy || {};
  return `<div class="page-head"><div><div class="page-title">Каскад RU → EU</div><div class="page-sub">Статус туннеля и MTProto через EU.</div></div><div class="page-actions"><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button><button class="btn btn-danger" data-api-action="cascade-teardown">${icon('trash')}Удалить каскад</button></div></div>
    <div class="mini-grid">${mini('Настроен', c.configured ? 'да' : 'нет', 'awg1')}${mini('Активен', c.active ? 'да' : 'нет', 'туннель')}${mini('Endpoint', escHtml(c.endpoint || '—'), 'EU')}${mini('Handshake', c.handshakeAgo == null ? '—' : c.handshakeAgo + ' c', 'назад')}</div>
    <div class="grid"><section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">Состояние</div><div class="card-sub">/api/cascade/status</div></div>${tag(c.active ? 'активен' : 'не активен', c.active ? 'good' : 'warn')}</div><div class="list"><div class="list-row"><b>Роль</b><span class="mono">${escHtml(c.role || '—')}</span></div><div class="list-row"><b>Интерфейсы</b><span class="mono">${escHtml((c.ifaces || []).join(', ') || '—')}</span></div><div class="list-row"><b>Маршрут</b><span class="mono">${escHtml(c.tableRoute || '—')}</span></div><div class="list-row"><b>ipset</b><span class="mono">${escHtml(String(c.ipsetCount || 0))}</span></div></div></section>
    <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">MTProto через EU</div><div class="card-sub">/api/cascade/proxy</div></div>${tag(p.enabled ? 'включено' : 'выключено', p.enabled ? 'good' : 'warn')}</div><div class="list"><div class="list-row"><b>middle_proxy_nat_ip</b><span class="mono">${escHtml(p.middleProxyNatIp || p.natIp || '—')}</span></div><div class="list-row"><b>Пользователи</b><span class="mono">${escHtml((p.users || []).join(', ') || '—')}</span></div></div></section></div>`;
}

function realObfuscation() {
  const o = carbon.obf || {};
  const profiles = (carbon.profiles && (carbon.profiles.builtin || []).concat(carbon.profiles.custom || [])) || [];
  return `<div class="page-head"><div><div class="page-title">Обфускация</div><div class="page-sub">Текущий конфиг и профили из API.</div></div><div class="page-actions"><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button></div></div>
    <div class="mini-grid">${mini('Версия', o.version || '—', 'AWG')}${mini('Оценка', o.audit && o.audit.score != null ? o.audit.score + '/100' : '—', 'DPI')}${mini('H1–H4', o.params && o.params.H1 ? 'заданы' : '—', 'header')}${mini('HPK', o.params && o.params.HeaderProtectionKey ? 'есть' : '—', 'ключ')}</div>
    <div class="grid"><section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">Текущий профиль</div><div class="card-sub">/api/obf/current</div></div>${tag(o.error ? 'нет конфига' : 'загружен', o.error ? 'warn' : 'good')}</div><pre class="code" style="margin:0;max-height:260px;overflow:auto;padding:12px;white-space:pre-wrap">${escHtml(o.error || JSON.stringify(o.params || o, null, 2))}</pre></section>
    <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">Профили</div><div class="card-sub">встроенные и сохранённые</div></div>${tag(String(profiles.length), 'muted')}</div><div class="list">${profiles.slice(0, 8).map(p => `<div class="list-row"><b>${escHtml(p.title || p.name)}</b><span class="mono">${escHtml(String(p.score || ''))}</span><button class="row-action" data-api-action="obf-apply" data-profile="${escHtml(p.name)}" title="Применить">${icon('check')}</button></div>`).join('') || '<div class="list-row"><b>Нет профилей</b></div>'}</div></section></div>`;
}

function realProxy() {
  const p = carbon.proxy || {};
  const users = (carbon.proxyUsers && carbon.proxyUsers.users) || [];
  return `<div class="page-head"><div><div class="page-title">Прокси</div><div class="page-sub">Пользователи и состояние MTProto.</div></div><div class="page-actions"><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button><button class="btn" data-api-action="proxy-restart">${icon('refresh')}Перезапустить</button></div></div>
    <div class="mini-grid">${mini('Движок', escHtml(p.backend || '—'), 'backend')}${mini('Пользователей', String(users.length), 'всего')}${mini('Онлайн', String(users.filter(u => u.status === 'online' || u.online).length), 'сейчас')}${mini('API', p.limited ? 'ограничен' : 'доступен', 'управление')}</div>
    <section class="card table-card"><div class="card-top"><div><div class="card-title">Пользователи</div><div class="card-sub">/api/proxy/users</div></div>${tag(String(users.length), 'muted')}</div><div class="table-scroll"><table class="table"><thead><tr><th>Пользователь</th><th>Статус</th><th>Трафик</th><th>Соединения</th><th>Срок</th><th></th></tr></thead><tbody>${users.map(u => `<tr><td class="name">${escHtml(u.username || u.name)}</td><td><span class="status ${u.status === 'online' ? '' : 'idle'}"><span class="dot"></span>${escHtml(u.status || '—')}</span></td><td class="mono">${fmtBytes(u.traffic || u.total || 0)}</td><td class="mono">${escHtml(String(u.connections || '—'))}</td><td class="mono">${escHtml(u.expires || '—')}</td><td><button class="row-action" data-api-action="proxy-user-delete" data-name="${escHtml(u.username || u.name)}" title="Удалить">${icon('trash')}</button></td></tr>`).join('') || '<tr><td colspan="6">Прокси-движок не найден или пользователей нет</td></tr>'}</tbody></table></div></section>`;
}

function realDomains() {
  const s = carbon.ssl || {};
  const panel = s.panel || {};
  const certs = s.certificates || [];
  const sites = s.sites || [];
  return `<div class="page-head"><div><div class="page-title">Домены и SSL</div><div class="page-sub">Сертификаты и сайты Nginx из API.</div></div><div class="page-actions"><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button></div></div>
    <div class="mini-grid">${mini('Домен панели', escHtml(panel.domain || '—'), panel.scheme || '—')}${mini('HTTPS', panel.scheme === 'https' ? 'включён' : 'выключен', 'порт ' + (panel.publicPort || '—'))}${mini('Сертификатов', String(certs.length), 'Let\'s Encrypt')}${mini('Сайтов', String(sites.length), 'Nginx')}</div>
    <div class="grid"><section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Сертификаты</div><div class="card-sub">/api/ssl/status</div></div>${tag(String(certs.length), 'muted')}</div><div class="list">${certs.map(c => `<div class="list-row"><b>${escHtml(c.domain || c.name)}</b><span class="mono">${escHtml(c.expires || c.notAfter || '')}</span></div>`).join('') || '<div class="list-row"><b>Сертификатов нет</b></div>'}</div></section>
    <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Сайты</div><div class="card-sub">Nginx</div></div>${tag(String(sites.length), 'muted')}</div><div class="list">${sites.map(x => `<div class="list-row"><b>${escHtml(x.domain || x.name)}</b><span class="mono">${escHtml(x.type || 'site')}</span></div>`).join('') || '<div class="list-row"><b>Сайтов нет</b></div>'}</div></section></div>`;
}

function realApp() {
  const a = carbon.app || {};
  const apk = a.apk || {};
  const m = a.metrics || {};
  return `<div class="page-head"><div><div class="page-title">Приложение</div><div class="page-sub">APK и порт метрик из API.</div></div><div class="page-actions"><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button><a class="btn btn-primary" href="/api/app/apk">${icon('download')}Скачать APK</a></div></div>
    <div class="mini-grid">${mini('Версия APK', escHtml(apk.version || '—'), apk.source || '')}${mini('Метрики', m.enabled ? 'включены' : 'выключены', 'порт ' + (m.publicPort || '—'))}${mini('Формат', escHtml(m.format || '—'), m.path || '/metrics')}${mini('Токен', m.tokenSet ? 'задан' : 'нет', 'Bearer')}</div>
    <div class="grid"><section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">APK</div><div class="card-sub">/api/app/status</div></div>${tag(apk.available ? 'доступен' : 'нет', apk.available ? 'good' : 'warn')}</div><div class="list"><div class="list-row"><b>Файл</b><span class="mono">${escHtml(apk.name || '—')}</span></div><div class="list-row"><b>Размер</b><span class="mono">${apk.size ? fmtBytes(apk.size) : '—'}</span></div><div class="list-row"><b>SHA256</b><span class="mono">${escHtml((apk.sha256 || '').slice(0, 16) || '—')}</span></div></div></section>
    <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">Метрики</div><div class="card-sub">/api/app/metrics</div></div>${tag(m.enabled ? 'on' : 'off', m.enabled ? 'good' : 'warn')}</div><div class="list"><div class="list-row"><b>Внутренний порт</b><span class="mono">${escHtml(String(m.port || '—'))}</span></div><div class="list-row"><b>Внешний порт</b><span class="mono">${escHtml(String(m.publicPort || '—'))}</span></div><div class="list-row"><b>Адрес</b><span class="mono">${escHtml(m.host || '—')}</span></div></div></section></div>`;
}

function realRustdesk() {
  const r = carbon.rustdesk || {};
  return `<div class="page-head"><div><div class="page-title">RustDesk</div><div class="page-sub">Relay-сервер и клиенты из API.</div></div><div class="page-actions"><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button><button class="btn btn-primary" data-api-action="rustdesk-install">${icon('download')}Установить</button><button class="btn btn-danger" data-api-action="rustdesk-uninstall">${icon('trash')}Удалить</button></div></div>
    <div class="mini-grid">${mini('Сервер', r.installed ? 'установлен' : 'не установлен', r.version || '—')}${mini('Relay', escHtml(r.relay || '—'), 'hbbr')}${mini('Public key', escHtml((r.publicKey || '—').slice(0, 16)), 'ключ')}${mini('Обновление', r.updateAvailable ? 'доступно' : 'нет', r.latestVersion || '—')}</div>
    <div class="grid"><section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">Конфигурация</div><div class="card-sub">/api/rustdesk/status</div></div>${tag(r.installed ? 'active' : 'не установлен', r.installed ? 'good' : 'warn')}</div><div class="list"><div class="list-row"><b>Host</b><span class="mono">${escHtml(r.host || '—')}</span></div><div class="list-row"><b>Relay</b><span class="mono">${escHtml(r.relay || '—')}</span></div><div class="list-row"><b>hbbs</b><span class="mono">${escHtml((r.services && r.services.hbbs && r.services.hbbs.state) || '—')}</span></div><div class="list-row"><b>hbbr</b><span class="mono">${escHtml((r.services && r.services.hbbr && r.services.hbbr.state) || '—')}</span></div></div></section>
    <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">Порты</div><div class="card-sub">21115–21119</div></div>${tag(String((r.ports || []).length), 'muted')}</div><div class="list">${(r.ports || []).map(p => `<div class="list-row"><b>${escHtml(String(p.port))}/${escHtml(p.proto)}</b><span class="mono">${p.open ? 'open' : 'closed'}</span></div>`).join('') || '<div class="list-row"><b>Нет данных</b></div>'}</div></section></div>`;
}

function realDiagnostics() {
  return `<div class="page-head"><div><div class="page-title">Диагностика</div><div class="page-sub">Ping, traceroute и журнал через API.</div></div><div class="page-actions"><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button></div></div>
    <div class="grid"><section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Ping</div><div class="card-sub">/api/diag/ping</div></div></div><label class="field"><span>Хост</span><input id="carbonPingHost" value="1.1.1.1"></label><button class="btn btn-primary" style="margin-top:12px" data-api-action="diag-ping">Запустить</button><pre id="carbonPingOut" class="code" style="margin-top:12px;padding:10px;white-space:pre-wrap"></pre></section>
    <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Traceroute</div><div class="card-sub">/api/diag/traceroute</div></div></div><label class="field"><span>Хост</span><input id="carbonTraceHost" value="1.1.1.1"></label><button class="btn btn-primary" style="margin-top:12px" data-api-action="diag-trace">Запустить</button><pre id="carbonTraceOut" class="code" style="margin-top:12px;padding:10px;white-space:pre-wrap"></pre></section>
    <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Журнал</div><div class="card-sub">/api/diag/log</div></div><button class="btn btn-sm" data-api-action="diag-log">${icon('refresh')}Обновить</button></div><pre id="carbonLogOut" class="code" style="margin:0;padding:10px;white-space:pre-wrap">Нажмите «Обновить»</pre></section></div>`;
}

function realAdmin() {
  const users = (carbon.users && carbon.users.users) || [];
  const audit = (carbon.audit && carbon.audit.entries) || [];
  const b = carbon.backup || {};
  const n = carbon.notify || {};
  return `<div class="page-head"><div><div class="page-title">Администрирование</div><div class="page-sub">Пользователи, аудит, бэкапы и Telegram из API.</div></div><div class="page-actions"><button class="btn" data-api-action="refresh">${icon('refresh')}Обновить</button></div></div>
    <div class="mini-grid">${mini('Пользователей', String(users.length), 'панели')}${mini('Аудит', String(audit.length), 'записей')}${mini('Автобэкап', b.config && b.config.enabled ? 'включён' : 'выключен', b.config ? b.config.time : '—')}${mini('Telegram', n.enabled ? 'включён' : 'выключен', n.chatId || '—')}</div>
    <div class="grid"><section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">Пользователи</div><div class="card-sub">/api/users</div></div>${tag(String(users.length), 'muted')}</div><div class="table-scroll"><table class="table"><thead><tr><th>Логин</th><th>Роль</th><th>Создан</th><th></th></tr></thead><tbody>${users.map(u => `<tr><td class="name">${escHtml(u.username)}</td><td>${escHtml(u.role)}</td><td class="mono">${escHtml(u.created || '—')}</td><td><button class="row-action" data-api-action="user-delete" data-name="${escHtml(u.username)}">${icon('trash')}</button></td></tr>`).join('') || '<tr><td colspan="4">Пользователей нет</td></tr>'}</tbody></table></div></section>
    <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">Аудит</div><div class="card-sub">последние действия</div></div>${tag('live', 'good')}</div><div class="list">${audit.slice(0, 8).map(e => `<div class="list-row"><b>${escHtml(e.user || '—')}</b><span class="mono">${escHtml(e.action || '')}</span></div>`).join('') || '<div class="list-row"><b>Нет записей</b></div>'}</div></section></div>`;
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
  const create = event.target.closest('[data-action="create-client"]');
  if (create) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const name = document.getElementById('newClientName')?.value.trim();
    if (!name) { showToast('Укажите имя клиента'); return; }
    try {
      await api('/api/create', { method: 'POST', body: { name, expires: '', endpointType: 'ip' } });
      closeClientModal();
      await loadCarbonData();
      render();
      showToast('Клиент создан: ' + name);
    } catch (e) { showToast(e.message); }
    return;
  }
  const btn = event.target.closest('[data-api-action]');
  if (!btn) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const action = btn.dataset.apiAction;
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
      const sel = document.getElementById('carbonGeoIfaces');
      const ifaces = sel ? [...sel.selectedOptions].map(o => o.value) : [];
      const schedule = document.getElementById('carbonGeoSchedule')?.value || 'weekly';
      await api('/api/tools/rudrop', { method: 'POST', body: { ifaces, schedule, enable: true } });
      showToast('GeoIP-блокировка включена');
    } else if (action === 'geoip-disable') {
      await api('/api/tools/rudrop', { method: 'POST', body: { enable: false } });
      showToast('GeoIP-блокировка отключена');
    } else if (action === 'backup-run') {
      await api('/api/backup/run', { method: 'POST' });
      showToast('Бэкап создаётся');
    } else if (action === 'module-logs') {
      location.href = '/#install';
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
      const data = await api('/api/diag/log?name=warp_install.log');
      document.getElementById('carbonLogOut').textContent = JSON.stringify(data, null, 2);
    } else if (action === 'user-delete') {
      if (!confirm('Удалить пользователя ' + btn.dataset.name + '?')) return;
      await api('/api/users/' + encodeURIComponent(btn.dataset.name), { method: 'DELETE' });
      await loadCarbonData(); render(); showToast('Пользователь удалён');
    }
  } catch (e) {
    showToast(e.message || 'Ошибка');
  } finally {
    btn.disabled = false;
  }
}, true);

async function initCarbon() {
  bindRealData();
  try {
    await api('/api/security/status');
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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { initCarbon(); });
} else {
  initCarbon();
}
