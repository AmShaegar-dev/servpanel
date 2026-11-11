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

function keeneticTunnelState(t) {
  if (!t || !t.up) return { cls: 'disabled', label: 'отключен', code: 'OFF' };
  if (t.link === 'down' || t.empty) return { cls: 'down', label: 'упал', code: 'DOWN' };
  if (t.routed === false) return { cls: 'standby', label: 'резервный', code: 'STANDBY' };
  return { cls: 'active', label: 'основной', code: 'PRIMARY' };
}

function keeneticRouterCard(r) {
  const st = r.status || {};
  const online = !!st.online;
  const tunnels = Array.isArray(st.tunnels) ? st.tunnels : [];
  const up = tunnels.filter(t => keeneticTunnelState(t).cls === 'active').length;
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
      <span>${tunnels.length ? up + ' осн. / ' + tunnels.length : 'туннели не найдены'}</span>
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
  const up = tunnels.filter(t => keeneticTunnelState(t).cls === 'active').length;
  const down = tunnels.length - up;
  return `<div class="page-head"><div><div class="page-title">Keenetic</div><div class="page-sub">Парк роутеров, туннели и связь. До ${Math.max(6, routers.length)} роутеров.</div></div><div class="page-actions"><button class="btn" data-carbon-action="keenetic-refresh">${icon('refresh')}Обновить</button><button class="btn btn-primary" data-carbon-action="keenetic-add">${icon('plus')}Добавить роутер</button></div></div>
    <div class="mini-grid">
      ${mini('Роутеры', `${online} / ${routers.length}`, 'в сети')}
      ${mini('Основные', `${up} / ${tunnels.length}`, down ? `${down} резервных / упавших` : 'все основные')}
      ${mini('Проверка', 'авто', 'каждую минуту')}
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
  const states = tunnels.map(keeneticTunnelState);
  let flowState = 'down';
  if (states.some(x => x.cls === 'active')) flowState = 'active';
  else if (states.some(x => x.cls === 'standby')) flowState = 'standby';
  const branches = tunnels.length ? tunnels.map(t => {
    const ts = keeneticTunnelState(t);
    const label = t.description || t.name;
    return `<div class="keenetic-flow-branch ${ts.cls}" data-flow-branch="${escHtml(t.name)}">
      <div class="keenetic-flow-tunnel ${ts.cls}" data-flow-chip="${escHtml(t.name)}" title="${escHtml(label + ' · ' + t.name + (t.peer ? ' · ' + t.peer : ''))}">
        <span class="dot"></span>
        <div class="keenetic-flow-tunnel-text"><b>${escHtml(label)}</b><span>${escHtml(t.name + ' · ' + ts.code)}</span></div>
      </div>
    </div>`;
  }).join('') : `<div class="keenetic-flow-branch down" data-flow-branch="">
      <div class="keenetic-flow-tunnel down" data-flow-chip=""><span class="dot"></span><div class="keenetic-flow-tunnel-text"><b>Туннели не найдены</b><span>—</span></div></div>
    </div>`;
  return `<div class="keenetic-flow state-${flowState}" data-flow-state="${flowState}">
    <svg class="keenetic-flow-svg" aria-hidden="true"></svg>
    <div class="keenetic-flow-node" data-flow-node="local"><div class="keenetic-flow-ico">${icon('monitor')}</div><b>Локальная сеть</b></div>
    <div class="keenetic-flow-spacer"></div>
    <div class="keenetic-flow-node router" data-flow-node="router"><div class="keenetic-flow-ico">${icon('cascade')}</div><b>${escHtml(r.name)}</b><span>${escHtml(r.host)}</span></div>
    <div class="keenetic-flow-spacer"></div>
    <div class="keenetic-flow-branches">${branches}</div>
    <div class="keenetic-flow-spacer"></div>
    <div class="keenetic-flow-node" data-flow-node="wan"><div class="keenetic-flow-ico">${icon('globe')}</div><b>WAN</b></div>
  </div>`;
}

function keeneticFlowDraw() {
  const flow = document.querySelector('.keenetic-flow');
  if (!flow) return;
  const svg = flow.querySelector('.keenetic-flow-svg');
  const local = flow.querySelector('[data-flow-node="local"]');
  const router = flow.querySelector('[data-flow-node="router"]');
  const wan = flow.querySelector('[data-flow-node="wan"]');
  if (!svg || !local || !router || !wan) return;
  const box = flow.getBoundingClientRect();
  const W = Math.max(1, Math.round(box.width));
  const H = Math.max(1, Math.round(box.height));
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const cs = getComputedStyle(document.documentElement);
  const accent = cs.getPropertyValue('--accent').trim() || '#ff5a4e';
  const blue = '#5b8cff';
  const bad = cs.getPropertyValue('--bad').trim() || '#ff4d4f';
  const surface = cs.getPropertyValue('--surface-1').trim() || '#15171a';
  const ns = 'http://www.w3.org/2000/svg';
  const rel = el => {
    const r = el.getBoundingClientRect();
    return {
      l: r.left - box.left, t: r.top - box.top,
      r: r.right - box.left, b: r.bottom - box.top,
      cx: (r.left + r.right) / 2 - box.left,
      cy: (r.top + r.bottom) / 2 - box.top
    };
  };
  const vertical = getComputedStyle(flow).display === 'flex';
  let seq = 0;

  const curve = (a, b) => vertical
    ? `M ${a.cx} ${a.b} C ${a.cx} ${a.b + (b.t - a.b) * .5}, ${b.cx} ${b.t - (b.t - a.b) * .5}, ${b.cx} ${b.t}`
    : `M ${a.r} ${a.cy} C ${a.r + (b.l - a.r) * .5} ${a.cy}, ${b.l - (b.l - a.r) * .5} ${b.cy}, ${b.l} ${b.cy}`;

  const draw = (a, b, state) => {
    const d = curve(a, b);
    const id = 'kflow-' + (++seq);
    const color = state === 'active' ? accent : state === 'standby' ? blue : '#6b7078';
    if (state === 'down' || state === 'disabled') {
      const under = document.createElementNS(ns, 'path');
      under.setAttribute('d', d);
      under.setAttribute('fill', 'none');
      under.setAttribute('stroke', '#000');
      under.setAttribute('stroke-width', '4');
      under.setAttribute('stroke-linecap', 'round');
      svg.appendChild(under);
    }
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('id', id);
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', color);
    p.setAttribute('stroke-width', state === 'active' || state === 'standby' ? '1.8' : '1.5');
    p.setAttribute('stroke-linecap', 'round');
    if (state === 'active' || state === 'standby') {
      p.setAttribute('style', `filter:drop-shadow(0 0 2.5px ${color})`);
    }
    svg.appendChild(p);
    if (state === 'down' || state === 'disabled') {
      let pt = { x: 0, y: 0 };
      try { pt = p.getPointAtLength(p.getTotalLength() / 2); } catch (e) { /* ignore */ }
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('transform', `translate(${pt.x} ${pt.y})`);
      g.innerHTML = `<circle r="5.5" style="fill:${surface};stroke:${bad};stroke-width:1.5"/><path d="M-3.4 -3.4 L3.4 3.4" style="stroke:${bad};stroke-width:1.5" fill="none" stroke-linecap="round"/>`;
      svg.appendChild(g);
      return;
    }
    const ball = document.createElementNS(ns, 'circle');
    ball.setAttribute('r', '3.4');
    ball.setAttribute('fill', color);
    ball.setAttribute('style', `filter:drop-shadow(0 0 4px ${color})`);
    const anim = document.createElementNS(ns, 'animateMotion');
    anim.setAttribute('dur', (state === 'standby' ? 3.4 : 2.7) + 's');
    anim.setAttribute('repeatCount', 'indefinite');
    anim.setAttribute('begin', '-' + ((seq % 4) * 0.55).toFixed(2) + 's');
    const mpath = document.createElementNS(ns, 'mpath');
    mpath.setAttribute('href', '#' + id);
    anim.appendChild(mpath);
    ball.appendChild(anim);
    svg.appendChild(ball);
  };

  draw(rel(local), rel(router), flow.dataset.flowState || 'down');
  for (const br of [...flow.querySelectorAll('.keenetic-flow-branch')]) {
    const chip = br.querySelector('.keenetic-flow-tunnel');
    if (!chip) continue;
    const state = br.classList.contains('active') ? 'active'
      : br.classList.contains('standby') ? 'standby'
      : br.classList.contains('disabled') ? 'disabled' : 'down';
    const chipRect = rel(chip);
    draw(rel(router), chipRect, state);
    draw(chipRect, rel(wan), state);
  }
}

function scheduleKeeneticFlow() {
  window.setTimeout(keeneticFlowDraw, 30);
  window.setTimeout(keeneticFlowDraw, 260);
  window.setTimeout(keeneticFlowDraw, 620);
}

if (!window.__keeneticFlowResize) {
  window.__keeneticFlowResize = true;
  window.addEventListener('resize', () => {
    if (document.querySelector('.keenetic-flow')) scheduleKeeneticFlow();
  });
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
    ['dns', 'Маршруты DNS'],
    ['events', `События${events.length ? ' · ' + events.length : ''}`],
    ['settings', 'Настройки']
  ];
  let body = '';
  if (tab === 'tunnels') {
    body = `<section class="card table-card"><div class="card-top"><div><div class="card-title">Туннели</div><div class="card-sub">WireGuard / AmneziaWG, найденные на роутере</div></div><div class="page-actions">${tag(String(tunnels.length), 'muted')}<button class="btn btn-sm" data-carbon-action="keenetic-import">${icon('upload')}Импорт .conf</button></div></div>
      <div class="table-scroll"><table class="table keenetic-table"><thead><tr><th>Интерфейс</th><th>Тип</th><th>Состояние</th><th>Адрес</th><th>Пир / endpoint</th><th>Рукопожатие</th><th>Трафик</th><th>Описание</th><th></th></tr></thead><tbody>${tunnels.map(t => { const st = keeneticTunnelState(t); return `<tr>
        <td class="name">${escHtml(t.name)}</td><td>${escHtml(t.type || '—')}</td>
        <td><span class="status ${st.cls}"><span class="dot"></span>${st.label}</span></td>
        <td class="mono">${escHtml(t.address || '—')}</td><td class="mono">${escHtml(t.peer || '—')}</td>
        <td class="mono">${t.lastHandshake ? escHtml(lastHandshakeText(t.lastHandshake)) : '—'}</td>
        <td class="mono">${t.rx || t.tx ? '↓ ' + fmtBytes(t.rx) + ' · ↑ ' + fmtBytes(t.tx) : '—'}</td>
        <td>${escHtml(t.description || '—')}</td>
        <td><div class="keenetic-row-actions">
          ${t.empty ? `<button class="row-action" disabled title="Пустой интерфейс — управление недоступно">${icon('stop')}</button>` : `<button class="row-action" title="${t.up ? 'Выключить туннель' : 'Включить туннель'}" data-carbon-action="keenetic-tunnel-toggle" data-id="${escHtml(r.id)}" data-name="${escHtml(t.name)}" data-up="${t.up ? '1' : '0'}">${icon(t.up ? 'stop' : 'play')}</button>
          <button class="row-action" title="Перезапустить туннель" data-carbon-action="keenetic-tunnel-restart" data-id="${escHtml(r.id)}" data-name="${escHtml(t.name)}">${icon('refresh')}</button>`}
        </div></td>
      </tr>`; }).join('') || '<tr><td colspan="9">Туннели не найдены</td></tr>'}</tbody></table></div>
      <div class="keenetic-table-note">Действия применяются через RCI. Выключение туннеля прервёт связь через него.</div></section>`;
  } else if (tab === 'dns') {
    const dns = d.dns && d.dns.routerId === r.id ? d.dns : null;
    if (!dns || dns.loading) {
      body = `<section class="card keenetic-dns-loading"><div class="card-top"><div><div class="card-title">Маршруты DNS</div><div class="card-sub">Списки доменных имён и правила маршрутизации</div></div><span class="busy-ring"></span></div><div class="empty-row">Читаю списки с роутера…</div></section>`;
    } else if (dns.error) {
      body = `<section class="card"><div class="card-top"><div><div class="card-title">Маршруты DNS</div><div class="card-sub">Списки доменных имён и правила маршрутизации</div></div>${tag('ошибка', 'bad')}</div><div class="empty-row">${escHtml(dns.error)}</div><div class="page-actions" style="margin-top:10px"><button class="btn" data-carbon-action="keenetic-dns-reload">${icon('refresh')}Повторить</button></div></section>`;
    } else {
      const groups = dns.groups || [];
      const routes = dns.routes || [];
      body = `<section class="card table-card" style="margin-bottom:14px"><div class="card-top"><div><div class="card-title">Списки доменных имён</div><div class="card-sub">Домены, IP и подсети для правил маршрутизации</div></div><div class="page-actions">${tag(String(groups.length), 'muted')}<button class="btn btn-sm" data-carbon-action="keenetic-dns-add-list">${icon('plus')}Добавить список</button></div></div>
        <div class="table-scroll"><table class="table keenetic-table keenetic-dns-table"><thead><tr><th>Список</th><th>Домены</th><th>IPv4</th><th>IPv6</th><th></th></tr></thead><tbody>${groups.map(g => `<tr>
          <td class="name">${escHtml(g.description)}<div class="keenetic-sub">${escHtml(g.name)}</div></td>
          <td class="mono">${g.domains}</td><td class="mono">${g.ip4}</td><td class="mono">${g.ip6}</td>
          <td><div class="keenetic-row-actions">
            <button class="row-action" title="Редактировать список" data-carbon-action="keenetic-dns-edit-list" data-name="${escHtml(g.name)}">${icon('edit')}</button>
            <button class="row-action" title="Удалить список" data-carbon-action="keenetic-dns-delete-list" data-name="${escHtml(g.name)}" data-description="${escHtml(g.description)}">${icon('trash')}</button>
          </div></td>
        </tr>`).join('') || '<tr><td colspan="5">Списков пока нет</td></tr>'}</tbody></table></div></section>
        <section class="card table-card"><div class="card-top"><div><div class="card-title">Правила маршрутизации</div><div class="card-sub">Какой список через какой интерфейс ходит</div></div><div class="page-actions">${tag(String(routes.length), 'muted')}<button class="btn btn-sm" data-carbon-action="keenetic-dns-add-rule">${icon('plus')}Добавить правило</button></div></div>
        <div class="table-scroll"><table class="table keenetic-table keenetic-dns-table keenetic-dns-rules"><thead><tr><th>Состояние</th><th>Список</th><th>Интерфейс</th><th>Авто</th><th>Эксклюзив</th><th></th></tr></thead><tbody>${routes.map(rt => {
          const g = groups.find(x => x.name === rt.group);
          const iface = (dns.interfaces || []).find(x => x.name === rt.interface);
          const ifaceLabel = iface && iface.description ? iface.description : (rt.interface || '—');
          return `<tr>
            <td><span class="status ${rt.enabled ? '' : 'idle'}"><span class="dot"></span>${rt.enabled ? 'включено' : 'выключено'}</span></td>
            <td>${escHtml(g ? g.description : rt.group)}</td>
            <td><div class="name">${escHtml(ifaceLabel)}</div>${ifaceLabel !== rt.interface ? `<div class="keenetic-sub">${escHtml(rt.interface)}</div>` : ''}</td>
            <td>${rt.auto ? 'да' : 'нет'}</td><td>${rt.reject ? 'да' : 'нет'}</td>
            <td><div class="keenetic-row-actions">
              <button class="row-action" title="${rt.enabled ? 'Выключить правило' : 'Включить правило'}" data-carbon-action="keenetic-dns-toggle-rule" data-index="${escHtml(rt.index)}" data-enabled="${rt.enabled ? '1' : '0'}">${icon(rt.enabled ? 'stop' : 'play')}</button>
              <button class="row-action" title="Удалить правило" data-carbon-action="keenetic-dns-delete-rule" data-index="${escHtml(rt.index)}" data-group="${escHtml(g ? g.description : rt.group)}" data-interface="${escHtml(ifaceLabel)}">${icon('trash')}</button>
            </div></td>
          </tr>`;
        }).join('') || '<tr><td colspan="6">Правил пока нет</td></tr>'}</tbody></table></div>
        <div class="keenetic-table-note">Изменения применяются на роутере сразу и сохраняются в конфигурацию.</div></section>`;
    }
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
          <div class="list-row"><b>RCI</b><span class="mono">${escHtml(st.rciScheme || r.rciScheme || 'auto')} : ${escHtml(st.rciPort || r.rciPort || 'авто')}</span></div>
          <div class="list-row"><b>Последняя проверка</b><span class="mono">${st.checkedAt ? keeneticAgo(st.checkedAt) : '—'}</span></div>
          ${st.error ? `<div class="list-row"><b>Ошибка</b><span class="mono keenetic-error" style="color:var(--bad)">${escHtml(st.error)}</span></div>` : ''}
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
  if (!d.seen) { d.seen = true; d.animate = true; }
  const animate = !!d.animate;
  d.animate = false;
  const html = d.selected ? keeneticDetailHtml() : keeneticOverviewHtml();
  if (d.selected) scheduleKeeneticFlow();
  return animate ? `<div class="keenetic-view">${html}</div>` : html;
}

function keeneticAnimate() {
  keeneticState().animate = true;
}

function keeneticAssign(data) {
  const d = keeneticState();
  if (data && data.routers) d.routers = data.routers;
  if (data && data.events) d.events = data.events;
  if (data && data.overview) d.overview = data.overview;
}

async function keeneticLoad(showToastMessage) {
  try {
    if (showToastMessage) keeneticState().animate = true;
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
  keeneticState().dns = null;
  keeneticState().animate = true;
  render();
  window.scrollTo(0, 0);
}

function keeneticBack() {
  keeneticState().selected = null;
  keeneticState().animate = true;
  render();
}

function keeneticDetailTab(tab) {
  if (!['overview', 'tunnels', 'dns', 'events', 'settings'].includes(tab)) return;
  const d = keeneticState();
  d.tab = tab;
  d.animate = true;
  if (tab === 'dns' && !(d.dns && d.dns.routerId === d.selected) && !d.dnsBusy) {
    keeneticDnsLoad(d.selected);
    return;
  }
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
    sub: 'Для роутера за NAT используйте KeenDNS-домен и HTTPS:443. Панель проверит связь и определит модель/прошивку.',
    fields: [
      { name: 'name', label: 'Имя', placeholder: 'Name' },
      { name: 'host', label: 'Адрес / IP / домен', placeholder: '192.168.1.1 или name.crazedns.ru' },
      { name: 'port', label: 'SSH-порт', type: 'number', value: 22, min: 1, max: 65535 },
      { name: 'user', label: 'Пользователь', value: 'admin' },
      { name: 'password', label: 'Пароль', type: 'password', placeholder: 'Пароль администратора' },
      { name: 'transport', label: 'Транспорт', type: 'select', value: 'auto', options: keeneticTransportOptions() },
      { name: 'profile', label: 'Профиль KeeneticOS', type: 'select', value: 'auto', options: keeneticProfileOptions() },
      { name: 'rciScheme', label: 'RCI-схема', type: 'select', value: 'auto', options: [{ value: 'auto', label: 'Авто' }, { value: 'http', label: 'HTTP' }, { value: 'https', label: 'HTTPS' }] },
      { name: 'rciPort', label: 'RCI-порт (0 — авто)', type: 'number', value: 0, min: 0, max: 65535 }
    ],
    submitText: 'Добавить и проверить',
    onSubmit: async v => {
      const body = {
        name: v.name, host: v.host, port: Number(v.port) || 22, user: v.user || 'admin',
        password: v.password, transport: v.transport, profile: v.profile,
        rciScheme: v.rciScheme, rciPort: Number(v.rciPort) || 0
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
      { name: 'host', label: 'Адрес / IP / домен', value: r.host },
      { name: 'port', label: 'SSH-порт', type: 'number', value: r.port, min: 1, max: 65535 },
      { name: 'user', label: 'Пользователь', value: r.user },
      { name: 'password', label: 'Новый пароль', type: 'password', placeholder: 'Не менять' },
      { name: 'transport', label: 'Транспорт', type: 'select', value: r.transport || 'auto', options: keeneticTransportOptions() },
      { name: 'profile', label: 'Профиль KeeneticOS', type: 'select', value: r.profile || 'auto', options: keeneticProfileOptions() },
      { name: 'rciScheme', label: 'RCI-схема', type: 'select', value: r.rciScheme || 'auto', options: [{ value: 'auto', label: 'Авто' }, { value: 'http', label: 'HTTP' }, { value: 'https', label: 'HTTPS' }] },
      { name: 'rciPort', label: 'RCI-порт (0 — авто)', type: 'number', value: r.rciPort || 0, min: 0, max: 65535 }
    ],
    submitText: 'Сохранить',
    onSubmit: async v => {
      const body = {
        name: v.name, host: v.host, port: Number(v.port) || 22, user: v.user || 'admin',
        transport: v.transport, profile: v.profile, rciScheme: v.rciScheme, rciPort: Number(v.rciPort) || 0
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

function keeneticApplyRouter(router) {
  if (!router || !router.id) return;
  const d = keeneticState();
  const idx = (d.routers || []).findIndex(x => x.id === router.id);
  if (idx >= 0) d.routers[idx] = router;
  else d.routers.push(router);
}

async function keeneticTunnelAction(id, name, action, button) {
  const d = keeneticState();
  const r = (d.routers || []).find(x => x.id === id);
  if (!r) return;
  if (button) { button.disabled = true; }
  try {
    const res = await api('/api/keenetic/routers/' + encodeURIComponent(id) + '/tunnels/' + encodeURIComponent(name) + '/action', {
      method: 'POST', body: { action }
    });
    d.animate = true;
    keeneticApplyRouter(res.router);
    render();
    showToast(action === 'down' ? 'Туннель выключен' : action === 'up' ? 'Туннель включён' : 'Туннель перезапущен');
  } catch (e) {
    showToast(e.message || 'Не удалось изменить туннель');
  } finally {
    if (button) { button.disabled = false; button.classList.remove('is-busy'); }  }
}

async function keeneticTunnelToggle(id, name, isUp, button) {
  const r = keeneticState().routers.find(x => x.id === id);
  if (isUp && !confirm('Выключить туннель ' + name + ' на «' + (r ? r.name : 'роутере') + '»? Связь через него прервётся.')) return;
  await keeneticTunnelAction(id, name, isUp ? 'down' : 'up', button);
}

async function keeneticTunnelRestart(id, name) {
  const r = keeneticState().routers.find(x => x.id === id);
  if (!confirm('Перезапустить туннель ' + name + ' на «' + (r ? r.name : 'роутере') + '»? Связь прервётся на несколько секунд.')) return;
  await keeneticTunnelAction(id, name, 'restart');
}

function keeneticReadFileBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : '');
    };
    fr.onerror = () => reject(new Error('Не удалось прочитать файл'));
    fr.readAsDataURL(file);
  });
}

function keeneticDnsLoad(id) {
  const d = keeneticState();
  if (!id || d.dnsBusy) return;
  d.dnsBusy = true;
  d.dns = { routerId: id, loading: true, groups: [], routes: [], interfaces: [] };
  render();
  api('/api/keenetic/routers/' + encodeURIComponent(id) + '/dns')
    .then(res => { d.dns = { ...res, routerId: id }; })
    .catch(e => { d.dns = { routerId: id, groups: [], routes: [], interfaces: [], error: e.message || 'Ошибка загрузки' }; })
    .finally(() => {
      d.dnsBusy = false;
      if (d.tab === 'dns' && d.selected === id) render();
    });
}

function keeneticDnsApply(res) {
  const d = keeneticState();
  d.dns = { ...res, routerId: d.selected };
  const used = new Set((res.routes || []).filter(r => r.enabled).map(r => r.interface));
  const router = (d.routers || []).find(x => x.id === d.selected);
  if (router && router.status && Array.isArray(router.status.tunnels)) {
    router.status.tunnels.forEach(t => { t.routed = used.has(t.name); });
  }
  d.animate = true;
  render();
}

function keeneticDnsListForm(name) {
  const d = keeneticState();
  const dns = d.dns;
  if (!d.selected || !dns || dns.loading) return;
  const g = name ? (dns.groups || []).find(x => x.name === name) : null;
  showCarbonForm({
    title: g ? 'Список доменных имён' : 'Новый список DNS',
    sub: g
      ? 'Одна запись на строку: домен, IP-адрес или подсеть.'
      : 'Имя списка назначится автоматически (domain-listN). Одна запись на строку.',
    fields: [
      { name: 'description', label: 'Название', value: g ? g.description : '' },
      { name: 'entries', label: 'Домены и адреса', type: 'textarea', rows: 12, value: g ? g.entries.join('\n') : '', placeholder: 'example.com\n1.2.3.0/24' }
    ],
    submitText: 'Сохранить',
    onSubmit: async v => {
      const res = await api('/api/keenetic/routers/' + encodeURIComponent(d.selected) + '/dns/lists', {
        method: 'POST',
        body: {
          name: g ? g.name : '',
          description: v.description,
          entries: String(v.entries || '').split(/\r?\n/)
        }
      });
      keeneticDnsApply(res);
      showToast('Список сохранён');
    }
  });
}

async function keeneticDnsDeleteList(name, description) {
  const d = keeneticState();
  if (!d.selected) return;
  if (!confirm('Удалить список «' + description + '»? Сначала удалите правила, которые его используют.')) return;
  try {
    const res = await api('/api/keenetic/routers/' + encodeURIComponent(d.selected) + '/dns/lists/' + encodeURIComponent(name), { method: 'DELETE' });
    keeneticDnsApply(res);
    showToast('Список удалён');
  } catch (e) {
    showToast(e.message || 'Не удалось удалить список');
  }
}

function keeneticDnsRuleForm(index) {
  const d = keeneticState();
  const dns = d.dns;
  if (!d.selected || !dns || dns.loading) return;
  if (!(dns.groups || []).length) { showToast('Сначала создайте список доменных имён'); return; }
  if (!(dns.interfaces || []).length) { showToast('Не удалось получить интерфейсы роутера'); return; }
  const rt = index ? (dns.routes || []).find(x => x.index === index) : null;
  const groupOptions = dns.groups.map(g => ({ value: g.name, label: g.description + ' (' + g.name + ')' }));
  const interfaceOptions = dns.interfaces.map(i => ({
    value: i.name,
    label: i.description ? i.description + ' — ' + i.name : i.name
  }));
  showCarbonForm({
    title: rt ? 'Правило маршрутизации' : 'Новое правило DNS',
    sub: 'Выберите список и интерфейс, через который должны ходить эти домены.',
    fields: [
      { name: 'group', label: 'Список', type: 'select', value: rt ? rt.group : groupOptions[0].value, options: groupOptions },
      { name: 'interface', label: 'Интерфейс', type: 'select', value: rt ? rt.interface : interfaceOptions[0].value, options: interfaceOptions },
      { name: 'auto', label: 'Добавлять автоматически', type: 'checkbox', value: rt ? rt.auto : true },
      { name: 'reject', label: 'Эксклюзивный маршрут', type: 'checkbox', value: rt ? rt.reject : false },
      { name: 'enabled', label: 'Правило включено', type: 'checkbox', value: rt ? rt.enabled : true }
    ],
    submitText: 'Сохранить',
    onSubmit: async v => {
      const res = await api('/api/keenetic/routers/' + encodeURIComponent(d.selected) + '/dns/routes', {
        method: 'POST',
        body: {
          index: rt ? rt.index : '',
          group: v.group,
          interface: v.interface,
          auto: !!v.auto,
          reject: !!v.reject,
          enabled: !!v.enabled
        }
      });
      keeneticDnsApply(res);
      showToast('Правило сохранено');
    }
  });
}

async function keeneticDnsToggleRule(index, enabled) {
  const d = keeneticState();
  if (!d.selected) return;
  try {
    const res = await api('/api/keenetic/routers/' + encodeURIComponent(d.selected) + '/dns/routes/' + encodeURIComponent(index) + '/toggle', {
      method: 'POST', body: { enabled }
    });
    keeneticDnsApply(res);
    showToast(enabled ? 'Правило включено' : 'Правило выключено');
  } catch (e) {
    showToast(e.message || 'Не удалось изменить правило');
  }
}

async function keeneticDnsDeleteRule(index, group, iface) {
  const d = keeneticState();
  if (!d.selected) return;
  if (!confirm('Удалить правило «' + group + ' → ' + iface + '»?')) return;
  try {
    const res = await api('/api/keenetic/routers/' + encodeURIComponent(d.selected) + '/dns/routes/' + encodeURIComponent(index), { method: 'DELETE' });
    keeneticDnsApply(res);
    showToast('Правило удалено');
  } catch (e) {
    showToast(e.message || 'Не удалось удалить правило');
  }
}


function keeneticImport() {
  const d = keeneticState();
  const r = (d.routers || []).find(x => x.id === d.selected);
  if (!r) return;
  showCarbonForm({
    title: 'Импорт WireGuard .conf',
    sub: 'Роутер сам разберёт файл и создаст туннель. Имя интерфейса назначится автоматически.',
    fields: [
      { name: 'file', label: 'Файл конфигурации (.conf)', type: 'file', accept: '.conf' },
      { name: 'defaultRoute', label: 'Использовать для выхода в интернет', type: 'checkbox', value: true }
    ],
    submitText: 'Импортировать',
    onSubmit: async v => {
      if (!v.file) throw new Error('Выберите файл .conf');
      const data = await keeneticReadFileBase64(v.file);
      const res = await api('/api/keenetic/routers/' + encodeURIComponent(r.id) + '/wireguard/import', {
        method: 'POST',
        body: { data, filename: v.file.name, defaultRoute: !!v.defaultRoute }
      });
      d.animate = true;
      keeneticApplyRouter(res.router);
      render();
      if (res.warning) showToast(res.warning);
      else showToast(res.created ? 'Туннель ' + res.created + ' добавлен' : 'Туннель добавлен');
    }
  });
}
