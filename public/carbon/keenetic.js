'use strict';

/* Keenetic fleet UI: карточки роутеров, статусы, туннели и события. */

function keeneticState() {
  if (!carbon.keenetic) carbon.keenetic = { overview: null, routers: [], events: [], selected: null, tab: 'overview' };
  return carbon.keenetic;
}

function keeneticAgo(ts) {
  const n = Number(ts) || 0;
  if (!n) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - n) / 1000));
  if (sec < 10) return 'только что';
  if (sec < 60) return sec + ' сек. назад';
  if (sec < 3600) return Math.floor(sec / 60) + ' мин. назад';
  if (sec < 86400) return Math.floor(sec / 3600) + ' ч. назад';
  return Math.floor(sec / 86400) + ' дн. назад';
}

function keeneticEventTime(ts) {
  try { return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return '—'; }
}

function keeneticStatusTag(r) {
  const st = (r && r.status) || {};
  if (st.online) return `<span class="tag good keenetic-online"><span class="dot"></span>в сети</span>`;
  if (st.error) return `<span class="tag bad">ошибка</span>`;
  return `<span class="tag muted">не проверен</span>`;
}

function keeneticRouterCard(r) {
  const st = r.status || {};
  const online = !!st.online;
  const tunnels = Array.isArray(st.tunnels) ? st.tunnels : [];
  const up = tunnels.filter(t => t.up).length;
  const cpu = Math.max(0, Math.min(100, Number(st.cpu) || 0));
  const ram = Math.max(0, Math.min(100, Number(st.ram) || 0));
  return `<article class="keenetic-card ${online ? 'is-online' : 'is-offline'}" data-carbon-action="keenetic-open" data-id="${escHtml(r.id)}">
    <div class="keenetic-card-head">
      <div class="keenetic-card-name"><span class="dot ${online ? 'pulse' : ''}"></span><b>${escHtml(r.name)}</b></div>
      ${keeneticStatusTag(r)}
    </div>
    <div class="keenetic-card-model">${escHtml(st.model || st.device || 'Модель не определена')}${st.firmware ? ' · ' + escHtml(st.firmware) : ''}</div>
    <div class="keenetic-card-host">${escHtml(r.host)}:${escHtml(r.port)} · ${escHtml((st.transport || r.transport || 'auto').toUpperCase())}</div>
    <div class="keenetic-bars">
      <div class="keenetic-bar"><span>CPU</span><div><i style="width:${cpu}%"></i></div><b>${cpu}%</b></div>
      <div class="keenetic-bar"><span>RAM</span><div><i style="width:${ram}%"></i></div><b>${ram}%</b></div>
    </div>
    <div class="keenetic-card-foot">
      <span>${tunnels.length ? up + ' / ' + tunnels.length + ' туннелей' : 'туннели не найдены'}</span>
      <span>${escHtml(st.uptime || '—')}</span>
    </div>
    <div class="keenetic-card-actions">
      <button class="btn btn-sm" data-carbon-action="keenetic-test" data-id="${escHtml(r.id)}">${icon('pulse')}Проверить</button>
      <span class="keenetic-last">${st.checkedAt ? 'проверен ' + keeneticAgo(st.checkedAt) : 'ещё не проверялся'}</span>
    </div>
  </article>`;
}

function keeneticEventsCard(events, routerId) {
  const list = (events || []).filter(e => !routerId || e.routerId === routerId).slice(0, 12);
  return `<section class="card keenetic-events-card">
    <div class="card-top"><div><div class="card-title">События</div><div class="card-sub">Последние действия и изменения связи</div></div>${tag(String(list.length), 'muted')}</div>
    <div class="list">${list.map(e => `<div class="list-row keenetic-event">
      <b><span class="event-dot ${e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warn' : e.level === 'ok' ? 'good' : 'info'}"></span>${escHtml(e.message)}</b>
      <span class="mono">${escHtml(keeneticEventTime(e.at))}</span>
    </div>`).join('') || '<div class="list-row"><b>Событий пока нет</b><span class="mono">—</span></div>'}</div>
  </section>`;
}

function keeneticOverviewHtml() {
  const d = keeneticState();
  const routers = d.routers || [];
  const online = routers.filter(r => r.status && r.status.online).length;
  const tunnels = routers.flatMap(r => (r.status && r.status.tunnels) || []);
  const up = tunnels.filter(t => t.up).length;
  const down = tunnels.filter(t => !t.up).length;
  return `<div class="page-head"><div><div class="page-title">Keenetic</div><div class="page-sub">Парк роутеров, туннели и связь. До ${Math.max(6, routers.length)} роутеров.</div></div><div class="page-actions"><button class="btn" data-carbon-action="keenetic-refresh">${icon('refresh')}Обновить</button><button class="btn btn-primary" data-carbon-action="keenetic-add">${icon('plus')}Добавить роутер</button></div></div>
    <div class="mini-grid">
      ${mini('Роутеры', `${online} / ${routers.length}`, 'в сети')}
      ${mini('Туннели', `${up} / ${tunnels.length}`, down ? `${down} не в сети` : 'все в сети')}
      ${mini('Проверка', 'авто', 'каждые 30 секунд')}
      ${mini('События', String((d.events || []).length), 'последние')}
    </div>
    ${routers.length ? `<div class="keenetic-grid">${routers.map(keeneticRouterCard).join('')}</div>` : `<section class="card keenetic-empty">
      <div class="keenetic-empty-icon">${icon('cascade')}</div>
      <div><div class="card-title">Роутеров пока нет</div><div class="card-sub">Добавьте Keenetic, укажите адрес и доступ. Панель проверит связь, определит модель и прошивку.</div></div>
      <button class="btn btn-primary" data-carbon-action="keenetic-add">${icon('plus')}Добавить роутер</button>
    </section>`}
    ${keeneticEventsCard(d.events)}`;
}

function keeneticFlow(r) {
  const st = r.status || {};
  const tunnels = Array.isArray(st.tunnels) ? st.tunnels : [];
  return `<div class="keenetic-flow">
    <div class="keenetic-flow-node"><div class="keenetic-flow-ico">${icon('monitor')}</div><b>Локальная сеть</b></div>
    <div class="keenetic-flow-line"></div>
    <div class="keenetic-flow-node router"><div class="keenetic-flow-ico">${icon('cascade')}</div><b>${escHtml(r.name)}</b><span>${escHtml(r.host)}</span></div>
    <div class="keenetic-flow-line split"></div>
    <div class="keenetic-flow-tunnels">${tunnels.length ? tunnels.map(t => `<div class="keenetic-flow-tunnel ${t.up ? 'up' : 'down'}">
      <span class="dot"></span><b>${escHtml(t.name)}</b><span>${escHtml(t.state || (t.up ? 'up' : 'down'))}</span>
    </div>`).join('') : '<div class="keenetic-flow-tunnel down"><span class="dot"></span><b>Туннели не найдены</b></div>'}</div>
    <div class="keenetic-flow-line"></div>
    <div class="keenetic-flow-node"><div class="keenetic-flow-ico">${icon('globe')}</div><b>Интернет</b></div>
  </div>`;
}

function keeneticDetailHtml() {
  const d = keeneticState();
  const r = (d.routers || []).find(x => x.id === d.selected);
  if (!r) { d.selected = null; return keeneticOverviewHtml(); }
  const st = r.status || {};
  const tab = d.tab || 'overview';
  const events = (d.events || []).filter(e => e.routerId === r.id);
  const tunnels = Array.isArray(st.tunnels) ? st.tunnels : [];
  const tabs = [
    ['overview', 'Обзор'],
    ['tunnels', `Туннели${tunnels.length ? ' · ' + tunnels.length : ''}`],
    ['events', `События${events.length ? ' · ' + events.length : ''}`],
    ['settings', 'Настройки']
  ];
  let body = '';
  if (tab === 'tunnels') {
    body = `<section class="card table-card"><div class="card-top"><div><div class="card-title">Туннели</div><div class="card-sub">WireGuard / AmneziaWG, найденные на роутере</div></div>${tag(String(tunnels.length), 'muted')}</div>
      <div class="table-scroll"><table class="table"><thead><tr><th>Интерфейс</th><th>Тип</th><th>Состояние</th><th>Адрес</th><th>Пир / endpoint</th><th>Описание</th></tr></thead><tbody>${tunnels.map(t => `<tr>
        <td class="name">${escHtml(t.name)}</td><td>${escHtml(t.type || '—')}</td>
        <td><span class="status ${t.up ? '' : 'idle'}"><span class="dot"></span>${t.up ? 'в сети' : 'не в сети'}</span></td>
        <td class="mono">${escHtml(t.address || '—')}</td><td class="mono">${escHtml(t.peer || '—')}</td><td>${escHtml(t.description || '—')}</td>
      </tr>`).join('') || '<tr><td colspan="6">Туннели не найдены</td></tr>'}</tbody></table></div></section>`;
  } else if (tab === 'events') {
    body = keeneticEventsCard(events, r.id);
  } else if (tab === 'settings') {
    body = `<div class="grid">
      <section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">Подключение</div><div class="card-sub">Параметры, по которым панель ходит на Keenetic</div></div>${keeneticStatusTag(r)}</div>
        <div class="list">
          <div class="list-row"><b>Адрес</b><span class="mono">${escHtml(r.host)}:${escHtml(r.port)}</span></div>
          <div class="list-row"><b>Пользователь</b><span class="mono">${escHtml(r.user)}</span></div>
          <div class="list-row"><b>Транспорт</b><span class="mono">${escHtml(r.transport)}</span></div>
          <div class="list-row"><b>Профиль</b><span class="mono">${escHtml(st.profile || r.profile || 'auto')}</span></div>
          <div class="list-row"><b>RCI</b><span class="mono">${escHtml(r.rciScheme || 'http')} : ${escHtml(r.rciPort || 80)}</span></div>
          <div class="list-row"><b>Последняя проверка</b><span class="mono">${st.checkedAt ? keeneticAgo(st.checkedAt) : '—'}</span></div>
          ${st.error ? `<div class="list-row"><b>Ошибка</b><span class="mono" style="color:var(--bad)">${escHtml(st.error)}</span></div>` : ''}
        </div>
        <div class="page-actions" style="margin-top:14px">
          <button class="btn" data-carbon-action="keenetic-test" data-id="${escHtml(r.id)}">${icon('pulse')}Проверить</button>
          <button class="btn" data-carbon-action="keenetic-edit" data-id="${escHtml(r.id)}">${icon('edit')}Редактировать</button>
          <button class="btn btn-danger" data-carbon-action="keenetic-delete" data-id="${escHtml(r.id)}">${icon('trash')}Удалить</button>
        </div>
      </section>
      <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">Возможности</div><div class="card-sub">Что удалось определить</div></div>${tag(st.transport || '—', 'muted')}</div>
        <div class="list">
          <div class="list-row"><b>Модель</b><span class="mono">${escHtml(st.model || '—')}</span></div>
          <div class="list-row"><b>Прошивка</b><span class="mono">${escHtml(st.firmware || '—')}</span></div>
          <div class="list-row"><b>Release</b><span class="mono">${escHtml(st.release || '—')}</span></div>
          <div class="list-row"><b>Ветка</b><span class="mono">${escHtml(st.branch || '—')}</span></div>
          <div class="list-row"><b>Архитектура</b><span class="mono">${escHtml(st.arch || '—')}</span></div>
          <div class="list-row"><b>Uptime</b><span class="mono">${escHtml(st.uptime || '—')}</span></div>
        </div>
        <div class="donut-note">Управление туннелями и failover — следующий этап. Сейчас панель собирает статус и проверяет связь.</div>
      </section>
    </div>`;
  } else {
    body = `<div class="grid">
      <section class="card" style="grid-column:span 8"><div class="card-top"><div><div class="card-title">Схема трафика</div><div class="card-sub">Роутер и его туннели</div></div>${tag(st.online ? 'live' : 'offline', st.online ? 'good' : 'bad')}</div>${keeneticFlow(r)}</section>
      <section class="card" style="grid-column:span 4"><div class="card-top"><div><div class="card-title">Состояние</div><div class="card-sub">${escHtml(st.checkedAt ? 'проверено ' + keeneticAgo(st.checkedAt) : 'ещё не проверялся')}</div></div>${keeneticStatusTag(r)}</div>
        <div class="list">
          <div class="list-row"><b>Модель</b><span class="mono">${escHtml(st.model || '—')}</span></div>
          <div class="list-row"><b>Прошивка</b><span class="mono">${escHtml(st.firmware || '—')}</span></div>
          <div class="list-row"><b>Профиль</b><span class="mono">${escHtml(st.profile || r.profile || 'auto')}</span></div>
          <div class="list-row"><b>Транспорт</b><span class="mono">${escHtml(st.transport || r.transport || '—')}</span></div>
          <div class="list-row"><b>CPU</b><span class="mono">${Number(st.cpu) || 0}%</span></div>
          <div class="list-row"><b>RAM</b><span class="mono">${Number(st.ram) || 0}%</span></div>
          <div class="list-row"><b>Uptime</b><span class="mono">${escHtml(st.uptime || '—')}</span></div>
        </div>
        ${st.error ? `<div class="donut-note" style="color:var(--bad)">${escHtml(st.error)}</div>` : ''}
      </section>
    </div>`;
  }
  return `<div class="page-head keenetic-detail-head"><div><button class="btn btn-sm" data-carbon-action="keenetic-back"><span aria-hidden="true" style="margin-right:6px">←</span>Назад</button><div class="page-title" style="margin-top:10px">${escHtml(r.name)}</div><div class="page-sub">${escHtml(st.model || 'Keenetic')}${st.firmware ? ' · ' + escHtml(st.firmware) : ''} · ${escHtml(r.host)}</div></div><div class="page-actions"><button class="btn" data-carbon-action="keenetic-test" data-id="${escHtml(r.id)}">${icon('pulse')}Проверить</button><button class="btn" data-carbon-action="keenetic-refresh">${icon('refresh')}Обновить</button></div></div>
    <div class="keenetic-tabs">${tabs.map(([id, label]) => `<button class="keenetic-tab ${tab === id ? 'active' : ''}" data-carbon-action="keenetic-detail-tab" data-tab="${id}">${label}</button>`).join('')}</div>
    ${body}`;
}

function renderKeenetic() {
  const d = keeneticState();
  if (state.tab === 'keenetic') startKeeneticLive();
  if (d.selected) return keeneticDetailHtml();
  return keeneticOverviewHtml();
}

function keeneticAssign(data) {
  const d = keeneticState();
  if (data && data.routers) d.routers = data.routers;
  if (data && data.events) d.events = data.events;
  if (data && data.overview) d.overview = data.overview;
}

async function keeneticLoad(showToastMessage) {
  try {
    const [ov, ev] = await Promise.all([
      api('/api/keenetic/overview').catch(() => null),
      api('/api/keenetic/events?limit=100').catch(() => null)
    ]);
    if (ov && !ov.error) {
      keeneticState().overview = ov;
      keeneticState().routers = Array.isArray(ov.routers) ? ov.routers : [];
      keeneticState().events = Array.isArray(ov.events) ? ov.events : keeneticState().events;
    }
    if (ev && Array.isArray(ev.events)) keeneticState().events = ev.events;
    if (state.tab === 'keenetic') render();
    if (showToastMessage) showToast(showToastMessage);
  } catch (e) {
    showToast(e.message || 'Ошибка загрузки Keenetic');
  }
}

let keeneticTimer = null;
let keeneticBusy = false;
function startKeeneticLive() {
  if (keeneticTimer) return;
  keeneticTimer = setInterval(async () => {
    if (document.hidden || state.tab !== 'keenetic' || keeneticBusy) return;
    if (document.querySelector('.modal:not([hidden])')) return;
    keeneticBusy = true;
    try {
      const ov = await api('/api/keenetic/overview').catch(() => null);
      if (!ov || ov.error) return;
      const before = JSON.stringify(keeneticState().routers);
      keeneticState().overview = ov;
      keeneticState().routers = Array.isArray(ov.routers) ? ov.routers : [];
      keeneticState().events = Array.isArray(ov.events) ? ov.events : keeneticState().events;
      if (state.tab === 'keenetic' && before !== JSON.stringify(keeneticState().routers)) render();
    } finally {
      keeneticBusy = false;
    }
  }, 15000);
}

function keeneticOpen(id) {
  keeneticState().selected = String(id || '');
  keeneticState().tab = 'overview';
  render();
  window.scrollTo(0, 0);
}

function keeneticBack() {
  keeneticState().selected = null;
  render();
}

function keeneticDetailTab(tab) {
  if (!['overview', 'tunnels', 'events', 'settings'].includes(tab)) return;
  keeneticState().tab = tab;
  render();
}

function keeneticTransportOptions() {
  return [
    { value: 'auto', label: 'Авто: RCI, затем CLI' },
    { value: 'rci', label: 'Только RCI' },
    { value: 'cli', label: 'Только CLI (SSH)' }
  ];
}

function keeneticProfileOptions() {
  return [
    { value: 'auto', label: 'Автоопределение' },
    { value: '5.1', label: 'KeeneticOS 5.1' },
    { value: '5.0', label: 'KeeneticOS 5.0' },
    { value: '4.3', label: 'KeeneticOS 4.3 LTS' },
    { value: '4.1', label: 'KeeneticOS 4.1' },
    { value: '4.0', label: 'KeeneticOS 4.0' },
    { value: '3.1', label: 'KeeneticOS 3.1' }
  ];
}

function keeneticAdd() {
  showCarbonForm({
    title: 'Добавить роутер Keenetic',
    sub: 'Панель проверит связь и определит модель/прошивку. Пароль хранится в зашифрованном виде.',
    fields: [
      { name: 'name', label: 'Имя', placeholder: 'Name' },
      { name: 'host', label: 'Адрес / IP', placeholder: '192.168.1.1' },
      { name: 'port', label: 'SSH-порт', type: 'number', value: 22, min: 1, max: 65535 },
      { name: 'user', label: 'Пользователь', value: 'admin' },
      { name: 'password', label: 'Пароль', type: 'password', placeholder: 'Пароль администратора' },
      { name: 'transport', label: 'Транспорт', type: 'select', value: 'auto', options: keeneticTransportOptions() },
      { name: 'profile', label: 'Профиль KeeneticOS', type: 'select', value: 'auto', options: keeneticProfileOptions() },
      { name: 'rciScheme', label: 'RCI-схема', type: 'select', value: 'http', options: [{ value: 'http', label: 'HTTP' }, { value: 'https', label: 'HTTPS' }] },
      { name: 'rciPort', label: 'RCI-порт', type: 'number', value: 80, min: 1, max: 65535 }
    ],
    submitText: 'Добавить и проверить',
    onSubmit: async v => {
      const body = {
        name: v.name, host: v.host, port: Number(v.port) || 22, user: v.user || 'admin',
        password: v.password, transport: v.transport, profile: v.profile,
        rciScheme: v.rciScheme, rciPort: Number(v.rciPort) || 80
      };
      const d = await api('/api/keenetic/routers', { method: 'POST', body });
      const id = d.router && d.router.id;
      if (id) {
        try { await api('/api/keenetic/routers/' + encodeURIComponent(id) + '/test', { method: 'POST', body: {} }); } catch (e) { /* статус покажет ошибку */ }
      }
      await keeneticLoad('Роутер добавлен');
    }
  });
}

function keeneticEdit(id) {
  const r = (keeneticState().routers || []).find(x => x.id === id);
  if (!r) return;
  showCarbonForm({
    title: 'Настройки роутера',
    sub: 'Пароль оставьте пустым, чтобы не менять.',
    fields: [
      { name: 'name', label: 'Имя', value: r.name },
      { name: 'host', label: 'Адрес / IP', value: r.host },
      { name: 'port', label: 'SSH-порт', type: 'number', value: r.port, min: 1, max: 65535 },
      { name: 'user', label: 'Пользователь', value: r.user },
      { name: 'password', label: 'Новый пароль', type: 'password', placeholder: 'Не менять' },
      { name: 'transport', label: 'Транспорт', type: 'select', value: r.transport || 'auto', options: keeneticTransportOptions() },
      { name: 'profile', label: 'Профиль KeeneticOS', type: 'select', value: r.profile || 'auto', options: keeneticProfileOptions() },
      { name: 'rciScheme', label: 'RCI-схема', type: 'select', value: r.rciScheme || 'http', options: [{ value: 'http', label: 'HTTP' }, { value: 'https', label: 'HTTPS' }] },
      { name: 'rciPort', label: 'RCI-порт', type: 'number', value: r.rciPort || 80, min: 1, max: 65535 }
    ],
    submitText: 'Сохранить',
    onSubmit: async v => {
      const body = {
        name: v.name, host: v.host, port: Number(v.port) || 22, user: v.user || 'admin',
        transport: v.transport, profile: v.profile, rciScheme: v.rciScheme, rciPort: Number(v.rciPort) || 80
      };
      if (v.password) body.password = v.password;
      await api('/api/keenetic/routers/' + encodeURIComponent(id), { method: 'PUT', body });
      await keeneticLoad('Настройки сохранены');
    }
  });
}

async function keeneticTest(id) {
  const d = keeneticState().routers.find(x => x.id === id);
  showToast('Проверяю ' + (d ? d.name : 'роутер') + '…');
  try {
    const r = await api('/api/keenetic/routers/' + encodeURIComponent(id) + '/test', { method: 'POST', body: {} });
    await keeneticLoad(r.router && r.router.status && r.router.status.online ? 'Связь есть' : 'Роутер недоступен');
  } catch (e) {
    showToast(e.message || 'Ошибка проверки');
  }
}

async function keeneticDelete(id) {
  const r = keeneticState().routers.find(x => x.id === id);
  if (!r) return;
  if (!confirm('Удалить роутер «' + r.name + '» из панели? Настройки самого роутера не изменятся.')) return;
  try {
    await api('/api/keenetic/routers/' + encodeURIComponent(id), { method: 'DELETE' });
    keeneticState().selected = null;
    await keeneticLoad('Роутер удалён');
  } catch (e) {
    showToast(e.message || 'Ошибка удаления');
  }
}
