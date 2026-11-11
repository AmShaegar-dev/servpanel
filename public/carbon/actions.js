'use strict';

/* Carbon actions: real API operations without the legacy panel. */

function carbonSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function carbonRefresh(message) {
  try {
    const clients = await api('/api/clients');
    if (Array.isArray(clients)) carbon.clients = mergeClientData(carbon.clients, clients);
  } catch (e) { /* обновим из /api/stats ниже */ }
  await loadCarbonData();
  render();
  if (message) showToast(message);
}

function showCarbonForm(opts) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  const fields = opts.fields || [];
  const fieldHtml = fields.map(f => {
    const name = escHtml(f.name);
    const value = f.value == null ? '' : String(f.value);
    if (f.type === 'checkbox') {
      return `<label class="switch" style="margin:6px 0"><input type="checkbox" data-field="${name}" ${f.value ? 'checked' : ''}> ${escHtml(f.label)}</label>`;
    }
    if (f.type === 'select') {
      const options = (f.options || []).map(o => {
        const val = typeof o === 'string' ? o : o.value;
        const label = typeof o === 'string' ? o : o.label;
        return `<option value="${escHtml(val)}" ${String(val) === value ? 'selected' : ''}>${escHtml(label)}</option>`;
      }).join('');
      return `<label class="field"><span>${escHtml(f.label)}</span><select data-field="${name}">${options}</select></label>`;
    }
    if (f.type === 'checkboxes') {
      const selected = new Set((Array.isArray(f.value) ? f.value : []).map(String));
      const opts = (f.options || []).map(o => {
        const val = typeof o === 'string' ? o : o.value;
        const label = typeof o === 'string' ? o : o.label;
        return `<label class="switch"><input type="checkbox" data-field="${name}" value="${escHtml(val)}" ${selected.has(String(val)) ? 'checked' : ''}> ${escHtml(label)}</label>`;
      }).join('');
      const show = f.showWhen ? ` data-show-when-field="${escHtml(f.showWhen.field)}" data-show-when-value="${escHtml(f.showWhen.value)}"` : '';
      return `<div class="field check-field"${show}><span>${escHtml(f.label)}</span><div class="switch-grid">${opts || '<span class="muted">Нет других клиентов</span>'}</div></div>`;
    }
    if (f.type === 'textarea') {
      return `<label class="field"><span>${escHtml(f.label)}</span><textarea name="carbon-${name}" data-field="${name}" rows="${f.rows || 8}" spellcheck="false" autocomplete="off" placeholder="${escHtml(f.placeholder || '')}">${escHtml(value)}</textarea></label>`;
    }
    if (f.type === 'file') {
      return `<label class="field"><span>${escHtml(f.label)}</span><input type="file" data-field="${name}" accept="${escHtml(f.accept || '')}"></label>`;
    }
    return `<label class="field"><span>${escHtml(f.label)}</span><input type="${escHtml(f.type || 'text')}" name="carbon-${name}" data-field="${name}" value="${escHtml(value)}" autocomplete="${f.type === 'password' ? 'new-password' : 'off'}" placeholder="${escHtml(f.placeholder || '')}" ${f.min != null ? `min="${escHtml(f.min)}"` : ''} ${f.max != null ? `max="${escHtml(f.max)}"` : ''} ${f.step != null ? `step="${escHtml(f.step)}"` : ''}></label>`;
  }).join('');
  modal.innerHTML = `<div class="modal-card modal-wide" role="dialog" aria-modal="true">
    <div class="modal-head"><div><div class="modal-title">${escHtml(opts.title || 'Действие')}</div><div class="modal-sub">${escHtml(opts.sub || '')}</div></div><button class="icon-btn" data-form-close aria-label="Закрыть">✕</button></div>
    <div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">${fieldHtml}</div>
    <div data-form-error style="color:var(--bad);font-size:12px;margin-top:10px;display:none"></div>
    <div class="modal-actions"><button class="btn" data-form-close>Отмена</button><button class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" data-form-submit>${escHtml(opts.submitText || 'Сохранить')}</button></div>
  </div>`;
  document.body.appendChild(modal);
  modal.hidden = false;
  modal.querySelectorAll('[data-show-when-field]').forEach(el => {
    const ctrl = modal.querySelector(`[data-field="${el.dataset.showWhenField}"]`);
    if (!ctrl) return;
    const apply = () => { el.style.display = ctrl.value === el.dataset.showWhenValue ? '' : 'none'; };
    ctrl.addEventListener('change', apply);
    apply();
  });
  const close = () => modal.remove();
  modal.querySelectorAll('[data-form-close]').forEach(b => b.addEventListener('click', close));
  const err = modal.querySelector('[data-form-error]');
  const submit = modal.querySelector('[data-form-submit]');
  submit.addEventListener('click', async () => {
    err.style.display = 'none';
    submit.disabled = true;
    const finishBusy = carbonBusyStart(submit);
    const values = {};
    try {
      for (const f of fields) {
        const el = modal.querySelector(`[data-field="${f.name}"]`);
        if (!el) continue;
        if (f.type === 'checkbox') values[f.name] = el.checked;
        else if (f.type === 'checkboxes') values[f.name] = [...modal.querySelectorAll(`[data-field="${f.name}"]`)].filter(x => x.checked).map(x => x.value);
        else if (f.type === 'file') values[f.name] = el.files && el.files[0] ? el.files[0] : null;
        else values[f.name] = el.value;
      }
      await opts.onSubmit(values, (msg) => { err.textContent = msg; err.style.display = 'block'; });
      close();
    } catch (e) {
      err.textContent = e.message || 'Ошибка';
      err.style.display = 'block';
    } finally {
      submit.disabled = false;
      finishBusy();
    }
  });
  return modal;
}

function showCarbonTextModal(title, text) {
  let modal = document.getElementById('carbonTextModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'carbonTextModal';
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-card modal-wide"><div class="modal-head"><div><div class="modal-title"></div><div class="modal-sub"></div></div><button class="icon-btn" data-text-close aria-label="Закрыть">✕</button></div><pre class="code" style="margin:0;max-height:60vh;overflow:auto;padding:12px;white-space:pre-wrap"></pre></div>`;
    document.body.appendChild(modal);
    modal.querySelector('[data-text-close]').addEventListener('click', () => { modal.remove(); });
  }
  modal.querySelector('.modal-title').textContent = title || '';
  modal.querySelector('.modal-sub').textContent = '';
  modal.querySelector('pre').textContent = text || 'Пусто';
  modal.hidden = false;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.onload = () => {
      const s = String(reader.result || '');
      resolve(s.split(',')[1] || '');
    };
    reader.readAsDataURL(file);
  });
}

function carbonUpdateModal() {
  let modal = document.getElementById('carbonUpdateProgress');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'carbonUpdateProgress';
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-card modal-wide"><div class="modal-head"><div><div class="modal-title">Обновление панели</div><div class="modal-sub" data-upd-msg>Запуск обновления…</div></div></div>
      <div class="progress" style="margin:4px 0 12px"><span data-upd-bar style="width:0%"></span></div>
      <div class="list"><div class="list-row"><b>Шаг</b><span class="mono" data-upd-step>—</span></div><div class="list-row"><b>Статус</b><span class="tag" data-upd-state>ожидание</span></div></div>
      <pre class="code" data-upd-log style="margin:12px 0 0;max-height:45vh;overflow:auto;padding:10px;white-space:pre-wrap">Журнал пуст</pre>
      <div data-upd-error style="display:none;margin-top:10px;color:var(--bad);font-size:12px"></div>
      <div class="modal-actions"><button class="btn" data-upd-close disabled>Закрыть</button></div></div>`;
    document.body.appendChild(modal);
    modal.hidden = false;
    modal.querySelector('[data-upd-close]').addEventListener('click', () => modal.remove());
  }
  return modal;
}

function renderUpdateProgress(d) {
  const modal = carbonUpdateModal();
  if (!modal) return;
  const running = !!d.running;
  const ok = !!d.ok;
  const progress = running ? (Number(d.progress) || 0) : (ok ? 100 : (Number(d.progress) || 0));
  const msg = modal.querySelector('[data-upd-msg]');
  const bar = modal.querySelector('[data-upd-bar]');
  const step = modal.querySelector('[data-upd-step]');
  const state = modal.querySelector('[data-upd-state]');
  const log = modal.querySelector('[data-upd-log]');
  const err = modal.querySelector('[data-upd-error]');
  const close = modal.querySelector('[data-upd-close]');
  if (msg) msg.textContent = d.message || (running ? 'Обновление выполняется…' : ok ? 'Готово' : 'Ожидание');
  if (bar) bar.style.width = Math.max(0, Math.min(100, progress)) + '%';
  if (step) step.textContent = d.step || '—';
  if (state) {
    state.textContent = running ? 'выполняется' : ok ? 'готово' : (d.error ? 'ошибка' : 'ожидание');
    state.className = 'tag ' + (running ? 'warn' : ok ? 'good' : d.error ? 'bad' : 'muted');
  }
  if (log) log.textContent = (Array.isArray(d.log) && d.log.length ? d.log.slice(-60).join('\n') : (d.logTail || 'Журнал пуст'));
  if (err) {
    err.textContent = d.error || '';
    err.style.display = d.error ? 'block' : 'none';
  }
  if (close) close.disabled = running;
}

async function pollUpdate() {
  renderUpdateProgress({ running: true, progress: 0, message: 'Запуск обновления…', step: 'подготовка', log: [] });
  let error = '';
  for (let i = 0; i < 600; i++) {
    await carbonSleep(1000);
    try {
      const d = await api('/api/update/status');
      renderUpdateProgress(d);
      if (!d.running) {
        if (d.ok) {
          showToast('Панель обновлена, перезагрузка…');
          await carbonSleep(2000);
          location.reload();
          return;
        }
        error = d.error || d.message || 'Обновление завершилось с ошибкой';
        break;
      }
    } catch (e) {
      const modal = carbonUpdateModal();
      const msg = modal && modal.querySelector('[data-upd-msg]');
      const state = modal && modal.querySelector('[data-upd-state]');
      if (msg) msg.textContent = 'Панель перезапускается, ждём ответа…';
      if (state) { state.textContent = 'перезапуск'; state.className = 'tag warn'; }
    }
  }
  showToast(error || 'Не дождались завершения обновления');
}

async function carbonUpdateCheck() {
  const d = await api('/api/update/check-git');
  let text = '';
  if (d.upToDate) text = 'Установлена последняя версия из GitHub.\nКоммит: ' + (d.commit || d.current || '—');
  else if (d.dirty && d.dirty.length) text = 'Доступно обновление (' + d.behind + ' коммит(ов)), но есть локальные изменения.\nМожно выполнить «Сбросить и обновить».';
  else text = 'Доступно обновление: ' + d.behind + ' коммит(ов).\nПоследний: ' + (d.commit || '—');
  showCarbonTextModal('Проверка GitHub', text);
}

async function carbonUpdateUpload(file) {
  if (!file) throw new Error('Выберите .tar.gz');
  if (file.size > 10 * 1024 * 1024) throw new Error('Файл больше 10 МБ');
  const data = await fileToBase64(file);
  await api('/api/update/upload', { method: 'POST', body: { name: file.name, data } });
  pollUpdate();
}

async function carbonUpdateFromUrl() {
  showCarbonForm({
    title: 'Обновление по URL',
    sub: 'Ссылка на servpanel-*.tar.gz',
    fields: [{ name: 'url', label: 'URL архива', placeholder: 'https://example.com/servpanel-3.1.0.tar.gz' }],
    submitText: 'Скачать и установить',
    onSubmit: async v => {
      if (!/^https?:\/\//i.test(v.url)) throw new Error('URL должен начинаться с http:// или https://');
      await api('/api/update/url', { method: 'POST', body: { url: v.url.trim() } });
      pollUpdate();
    }
  });
}

async function carbonUpdateRollback() {
  const backups = (carbon.update && carbon.update.backups) || [];
  if (!backups.length) throw new Error('Резервных копий нет');
  showCarbonForm({
    title: 'Откат панели',
    sub: 'Будет установлен код из выбранной резервной копии',
    fields: [{ name: 'backup', label: 'Резервная копия', type: 'select', options: backups.map(b => ({ value: b.path || b.name, label: b.name })) }],
    submitText: 'Откатить',
    danger: true,
    onSubmit: async v => {
      await api('/api/update/rollback', { method: 'POST', body: { backup: v.backup } });
      pollUpdate();
    }
  });
}

async function carbonSslDeps() {
  if (!confirm('Установить nginx, certbot и python3-certbot-nginx?')) return;
  await api('/api/ssl/install-deps', { method: 'POST' });
  await carbonRefresh('Компоненты установлены');
}

async function carbonSslSite(mode) {
  showCarbonForm({
    title: mode === 'panel' ? 'Привязать домен к панели' : 'Создать сайт',
    sub: mode === 'panel' ? 'Nginx и Let\'s Encrypt для панели' : 'Nginx и Let\'s Encrypt для сайта',
    fields: [
      { name: 'domain', label: 'Домен', placeholder: mode === 'panel' ? 'panel.example.com' : 'site.example.com' },
      { name: 'email', label: 'Email для Let\'s Encrypt', placeholder: 'admin@example.com' },
      ...(mode === 'panel'
        ? [{ name: 'useForVpn', label: 'Использовать домен в новых VPN-конфигах', type: 'checkbox', value: true }]
        : [{ name: 'www', label: 'Добавить www', type: 'checkbox', value: false }])
    ],
    submitText: mode === 'panel' ? 'Привязать и выпустить' : 'Создать сайт',
    onSubmit: async v => {
      const body = { domain: v.domain.trim(), email: v.email.trim(), mode };
      if (mode === 'panel') body.useForVpn = !!v.useForVpn; else body.www = !!v.www;
      const d = await api('/api/ssl/site', { method: 'POST', body });
      await carbonRefresh('Готово: ' + (d.url || v.domain));
    }
  });
}

async function carbonSslRenew(name, daysLeft) {
  let force = false;
  if (daysLeft != null && daysLeft > 30) {
    if (!confirm(`Сертификату осталось ${daysLeft} дн. Продлить принудительно?`)) return;
    force = true;
  } else if (!confirm(`Продлить сертификат ${name}?`)) return;
  const start = await api('/api/ssl/renew', { method: 'POST', body: { name, force } });
  if (start.demo) { showToast('Демо-режим: продление не выполняется'); return; }
  if (start.job && start.job.running) {
    showToast('Продление запущено, ждём…');
    for (let i = 0; i < 120; i++) {
      await carbonSleep(2000);
      const s = await api('/api/ssl/renew/status?name=' + encodeURIComponent(name)).catch(() => null);
      if (s && s.job && !s.job.running) {
        if (s.job.error) { showToast('Ошибка: ' + s.job.error); return; }
        if (s.job.notDue) { showToast('Продление не требуется'); return; }
        await carbonRefresh('Сертификат обновлён');
        return;
      }
    }
  }
  await carbonRefresh('Продление запущено');
}

async function carbonSslDelete(name) {
  if (!confirm(`Удалить сайт ${name}? Сертификат останется на диске.`)) return;
  await api('/api/ssl/site/' + encodeURIComponent(name), { method: 'DELETE' });
  await carbonRefresh('Сайт удалён');
}

async function carbonUserAdd() {
  showCarbonForm({
    title: 'Новый пользователь панели',
    fields: [
      { name: 'username', label: 'Логин', placeholder: 'operator' },
      { name: 'password', label: 'Пароль', type: 'password' },
      { name: 'role', label: 'Роль', type: 'select', options: [{ value: 'admin', label: 'Администратор' }, { value: 'viewer', label: 'Только просмотр' }] }
    ],
    submitText: 'Создать',
    onSubmit: async v => {
      if (!v.username.trim() || !v.password) throw new Error('Укажите логин и пароль');
      await api('/api/users', { method: 'POST', body: { username: v.username.trim(), password: v.password, role: v.role } });
      await carbonRefresh('Пользователь создан');
    }
  });
}

async function carbon2faSetup() {
  const d = await api('/api/2fa/setup', { method: 'POST' });
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `<div class="modal-card"><div class="modal-head"><div><div class="modal-title">Настройка 2FA</div><div class="modal-sub">Отсканируйте QR и введите код</div></div><button class="icon-btn" data-2fa-close>✕</button></div>
    ${d.qr ? `<img src="${escHtml(d.qr)}" alt="QR" style="width:220px;height:220px;background:#fff;padding:8px;border-radius:10px;display:block;margin:0 auto 12px">` : ''}
    <label class="field"><span>Секрет</span><input readonly value="${escHtml(d.secret || '')}"></label>
    <label class="field" style="margin-top:10px"><span>Код из приложения</span><input data-2fa-code inputmode="numeric" autocomplete="one-time-code"></label>
    <div data-2fa-error style="color:var(--bad);font-size:12px;margin-top:8px;display:none"></div>
    <div class="modal-actions"><button class="btn" data-2fa-close>Отмена</button><button class="btn btn-primary" data-2fa-enable>Включить</button></div></div>`;
  document.body.appendChild(modal);
  modal.hidden = false;
  const close = () => modal.remove();
  modal.querySelectorAll('[data-2fa-close]').forEach(b => b.addEventListener('click', close));
  modal.querySelector('[data-2fa-enable]').addEventListener('click', async () => {
    const err = modal.querySelector('[data-2fa-error]');
    try {
      const res = await api('/api/2fa/enable', { method: 'POST', body: { code: modal.querySelector('[data-2fa-code]').value.trim() } });
      close();
      const codes = (res.recoveryCodes || []).join('\n');
      showCarbonTextModal('2FA включена', codes ? 'Сохраните резервные коды:\n\n' + codes : '2FA включена');
      await carbonRefresh();
    } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
  });
}

async function carbon2faDisable() {
  showCarbonForm({
    title: 'Отключить 2FA',
    fields: [{ name: 'password', label: 'Пароль', type: 'password' }],
    submitText: 'Отключить',
    danger: true,
    onSubmit: async v => {
      await api('/api/2fa/disable', { method: 'POST', body: { password: v.password } });
      await carbonRefresh('2FA отключена');
    }
  });
}

async function carbonBackupSave() {
  const b = carbon.backup || {};
  const c = b.config || {};
  showCarbonForm({
    title: 'Автоматические бэкапы',
    fields: [
      { name: 'enabled', label: 'Включить автобэкап', type: 'checkbox', value: !!c.enabled },
      { name: 'schedule', label: 'Расписание', type: 'select', value: c.schedule || 'daily', options: [{ value: 'daily', label: 'Ежедневно' }, { value: 'weekly', label: 'Еженедельно' }] },
      { name: 'time', label: 'Время', value: c.time || '04:30' },
      { name: 'keep', label: 'Хранить копий', type: 'number', value: c.keep || 7, min: 1, max: 100 },
      { name: 'encrypt', label: 'Шифровать AES-256', type: 'checkbox', value: c.encrypt !== false }
    ],
    submitText: 'Сохранить',
    onSubmit: async v => {
      await api('/api/backup/auto', { method: 'POST', body: { enabled: !!v.enabled, schedule: v.schedule, time: v.time, keep: Number(v.keep) || 7, encrypt: !!v.encrypt } });
      await carbonRefresh('Настройки бэкапа сохранены');
    }
  });
}

async function carbonBackupPassword() {
  const d = await api('/api/backup/password');
  if (!d.password) throw new Error('Пароль не задан');
  showCarbonTextModal('Пароль архивов', d.password);
}

async function carbonNotifySave() {
  const n = carbon.notify || {};
  showCarbonForm({
    title: 'Telegram-уведомления',
    fields: [
      { name: 'enabled', label: 'Включить уведомления', type: 'checkbox', value: !!n.enabled },
      { name: 'token', label: 'Токен бота', type: 'password', placeholder: n.hasToken ? 'Сохранён — оставьте пустым' : '123456789:AA…' },
      { name: 'chatId', label: 'Chat ID', value: n.chatId || '' }
    ],
    submitText: 'Сохранить',
    onSubmit: async v => {
      const body = { enabled: !!v.enabled, chatId: v.chatId.trim() };
      if (v.token.trim()) body.token = v.token.trim();
      await api('/api/notify/telegram', { method: 'POST', body });
      await carbonRefresh('Настройки уведомлений сохранены');
    }
  });
}

async function carbonClientKey(name) {
  const d = await api('/api/clients/' + encodeURIComponent(name) + '/key');
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `<div class="modal-card"><div class="modal-head"><div><div class="modal-title">Ключ: ${escHtml(name)}</div><div class="modal-sub">Импорт по ссылке или QR</div></div><button class="icon-btn" data-key-close>✕</button></div>
    ${d.qr ? `<img src="${escHtml(d.qr)}" alt="QR" style="width:220px;height:220px;background:#fff;padding:8px;border-radius:10px;display:block;margin:0 auto 12px">` : ''}
    <textarea readonly rows="5" style="width:100%;box-sizing:border-box;font-family:monospace;font-size:11px">${escHtml(d.uri || '')}</textarea>
    <div class="modal-actions" style="justify-content:space-between;flex-wrap:wrap"><div class="page-actions"><button class="btn" data-key-copy>Скопировать vpn://</button></div><div class="page-actions"><a class="btn" href="/api/download/${encodeURIComponent(name)}">Скачать .conf</a><a class="btn" href="/api/clients/${encodeURIComponent(name)}/export">Инструкция</a></div></div></div>`;
  document.body.appendChild(modal);
  modal.hidden = false;
  const close = () => modal.remove();
  modal.querySelector('[data-key-close]').addEventListener('click', close);
  modal.querySelector('[data-key-copy]').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(d.uri || ''); showToast('Скопировано'); } catch (e) { showToast('Не удалось скопировать'); }
  });
}

async function carbonClientUrl(name) {
  let d;
  try {
    d = await api('/api/clients/' + encodeURIComponent(name) + '/key');
  } catch (e) {
    showToast(e.message || 'URL недоступен');
    return;
  }
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `<div class="modal-card"><div class="modal-head"><div><div class="modal-title">URL для подключения</div><div class="modal-sub">${escHtml(name)} · AmneziaVPN</div></div><button class="icon-btn" data-url-close>✕</button></div>
    ${d.qr ? `<img src="${escHtml(d.qr)}" alt="QR" style="width:220px;height:220px;background:#fff;padding:8px;border-radius:10px;display:block;margin:0 auto 12px">` : ''}
    <label class="field"><span>Ссылка vpn://</span><textarea readonly rows="5" style="width:100%;box-sizing:border-box;font-family:monospace;font-size:11px">${escHtml(d.uri || '')}</textarea></label>
    <div class="modal-actions"><button class="btn btn-primary" data-url-copy>${icon('copy')}Скопировать URL</button></div></div>`;
  document.body.appendChild(modal);
  modal.hidden = false;
  const close = () => modal.remove();
  modal.querySelector('[data-url-close]').addEventListener('click', close);
  modal.querySelector('[data-url-copy]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(d.uri || '');
      showToast('Скопировано');
    } catch (e) {
      showToast('Не удалось скопировать');
    }
  });
}

async function carbonClientRename(name) {
  let lim = {};
  try { lim = await api('/api/clients/' + encodeURIComponent(name) + '/limits'); } catch (e) { lim = {}; }
  let iso = {};
  try { iso = await api('/api/clients/' + encodeURIComponent(name) + '/isolation'); } catch (e) { iso = {}; }
  const used = Number(lim.used_bytes) || 0;
  const quota = Number(lim.quota_bytes) || 0;
  const isoText = iso.mode === 'isolated' ? ' · изолирован' : iso.mode === 'open-plus' ? ' · Открытый+' : iso.mode === 'open' ? ' · Открытый' : '';
  const gbValue = n => n ? String(Math.round((n / (1024 ** 3)) * 100) / 100) : '0';
  const peerOptions = (carbon.clients || [])
    .filter(c => c && c.name !== name && c.ip)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map(c => ({ value: c.ip, label: c.name + ' — ' + c.ip }));
  const selectedPeers = Array.isArray(iso.peers) ? iso.peers : [];
  showCarbonForm({
    title: 'Редактировать клиента',
    sub: `Использовано: ${fmtBytes(used)}${quota ? ' из ' + fmtBytes(quota) : ' · лимит не задан'}${lim.blocked ? ' · лимит исчерпан' : ''}${isoText}`,
    fields: [
      { name: 'newName', label: 'Имя клиента', value: name },
      { name: 'rate', label: 'Скорость, Мбит/с (0 — без лимита)', type: 'number', value: Number(lim.rate) || 0, min: 0, step: 1 },
      { name: 'quota', label: 'Лимит трафика, ГБ (0 — без лимита)', type: 'number', value: gbValue(quota), min: 0, step: 0.1 },
      { name: 'isolation', label: 'Изоляция от других клиентов', type: 'select', value: iso.mode || 'default', options: [
        { value: 'default', label: 'Как на сервере (по умолчанию)' },
        { value: 'isolated', label: 'Изолировать от других клиентов' },
        { value: 'open', label: 'Открытый — разрешить всем' },
        { value: 'open-plus', label: 'Открытый+ — только выбранным' }
      ] },
      { name: 'peers', label: 'Кому разрешить (для «Открытый+»)', type: 'checkboxes', value: selectedPeers, options: peerOptions, showWhen: { field: 'isolation', value: 'open-plus' } },
      { name: 'reset', label: 'Сбросить использованный трафик', type: 'checkbox', value: false }
    ],
    submitText: 'Сохранить',
    onSubmit: async v => {
      if (!/^[A-Za-z0-9_-]{1,63}$/.test(v.newName)) throw new Error('Разрешены буквы, цифры, _ и -, до 63 символов');
      const mode = ['isolated', 'open', 'open-plus'].includes(v.isolation) ? v.isolation : 'default';
      const peers = mode === 'open-plus' && Array.isArray(v.peers) ? v.peers : [];
      if (mode === 'open-plus' && !peers.length) throw new Error('Для «Открытый+» выберите хотя бы одного клиента');
      const isoRes = await api('/api/clients/' + encodeURIComponent(name) + '/isolation', { method: 'POST', body: { mode, peers } });
      if (v.newName !== name) {
        await api('/api/clients/' + encodeURIComponent(name) + '/rename', { method: 'POST', body: { newName: v.newName } });
      }
      const quotaBytes = v.quota === '' ? 0 : Math.round(Number(v.quota) * (1024 ** 3));
      const d = await api('/api/clients/' + encodeURIComponent(v.newName) + '/limits', {
        method: 'POST',
        body: {
          rate: Number(v.rate) || 0,
          quota_bytes: quotaBytes,
          reset: !!v.reset
        }
      });
      await carbonRefresh(isoRes.warning || d.warning || 'Клиент обновлён');
    }
  });
}

async function carbonClientBulkRename() {
  showCarbonForm({
    title: 'Массовое переименование',
    fields: [
      { name: 'search', label: 'Найти в имени', placeholder: 'old-' },
      { name: 'replace', label: 'Заменить на', placeholder: 'new-' }
    ],
    submitText: 'Переименовать',
    onSubmit: async v => {
      if (!v.search) throw new Error('Укажите, что искать');
      const d = await api('/api/clients/rename-bulk', { method: 'POST', body: { search: v.search, replace: v.replace } });
      await carbonRefresh(`Переименовано: ${(d.renamed || []).length}, пропущено: ${(d.skipped || []).length}`);
    }
  });
}

function carbonProxyUserForm(name) {
  const u = name ? ((carbon.proxyUsers && (Array.isArray(carbon.proxyUsers) ? carbon.proxyUsers : carbon.proxyUsers.users)) || []).find(x => x.username === name) || {} : {};
  const mbps = bps => bps == null ? '' : String(Math.round(Number(bps) / 1000000 * 10) / 10);
  const gb = b => b == null ? '' : String(Math.round(Number(b) / (1024 ** 3) * 10) / 10);
  showCarbonForm({
    title: name ? 'Пользователь ' + name : 'Новый пользователь прокси',
    fields: [
      ...(name ? [] : [{ name: 'username', label: 'Имя', placeholder: 'client-01' }]),
      { name: 'secret', label: 'Секрет (32 hex)', placeholder: 'Необязательно' },
      { name: 'conns', label: 'TCP-соединений', type: 'number', value: u.max_tcp_conns == null ? '' : u.max_tcp_conns, min: 0 },
      { name: 'ips', label: 'Уникальных IP', type: 'number', value: u.max_unique_ips == null ? '' : u.max_unique_ips, min: 0 },
      { name: 'quota', label: 'Квота, ГБ', type: 'number', value: gb(u.data_quota_bytes), min: 0, step: '0.1' },
      { name: 'up', label: 'Скорость отдачи, Мбит/с', type: 'number', value: mbps(u.rate_limit_up_bps), min: 0, step: '0.1' },
      { name: 'down', label: 'Скорость загрузки, Мбит/с', type: 'number', value: mbps(u.rate_limit_down_bps), min: 0, step: '0.1' },
      { name: 'expiry', label: 'Действует до', type: 'date', value: u.expiration_rfc3339 ? String(u.expiration_rfc3339).slice(0, 10) : '' },
      { name: 'tag', label: 'ad_tag (32 hex)', value: u.user_ad_tag || '' },
      { name: 'notes', label: 'Заметка', value: u.notes || '' },
      { name: 'enabled', label: 'Пользователь включён', type: 'checkbox', value: u.enabled !== false }
    ],
    submitText: name ? 'Сохранить' : 'Создать',
    onSubmit: async v => {
      const payload = {};
      if (!name) {
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(v.username)) throw new Error('Имя: A-Z, a-z, 0-9, _, ., - до 64 символов');
        payload.username = v.username;
      }
      if (v.secret) {
        if (!/^[0-9a-fA-F]{32}$/.test(v.secret)) throw new Error('Секрет — 32 hex-символа');
        payload.secret = v.secret.toLowerCase();
      }
      const num = x => x === '' ? null : Number(x);
      payload.max_tcp_conns = num(v.conns);
      payload.max_unique_ips = num(v.ips);
      payload.data_quota_bytes = v.quota === '' ? null : Math.round(Number(v.quota) * (1024 ** 3));
      payload.rate_limit_up_bps = v.up === '' ? null : Math.round(Number(v.up) * 1000000);
      payload.rate_limit_down_bps = v.down === '' ? null : Math.round(Number(v.down) * 1000000);
      payload.expiration_rfc3339 = v.expiry ? new Date(v.expiry + 'T23:59:59Z').toISOString().replace(/\.\d{3}Z$/, '+00:00') : null;
      if (v.tag && !/^[0-9a-fA-F]{32}$/.test(v.tag)) throw new Error('ad_tag — 32 hex-символа');
      payload.user_ad_tag = v.tag ? v.tag.toLowerCase() : null;
      payload.notes = v.notes || null;
      payload.enabled = !!v.enabled;
      if (name) await api('/api/proxy/users/' + encodeURIComponent(name), { method: 'PATCH', body: payload });
      else await api('/api/proxy/users', { method: 'POST', body: payload });
      await carbonRefresh(name ? 'Пользователь обновлён' : 'Пользователь создан');
    }
  });
}

async function carbonProxyUserAction(name, action) {
  const labels = { enable: 'включён', disable: 'выключен', 'rotate-secret': 'секрет обновлён', 'reset-quota': 'квота сброшена', 'reset-traffic': 'трафик сброшен' };
  if (action === 'rotate-secret' && !confirm(`Выдать новый секрет для «${name}»? Старые ссылки перестанут работать.`)) return;
  const d = await api('/api/proxy/users/' + encodeURIComponent(name) + '/' + action, { method: 'POST', body: {} });
  if (action === 'rotate-secret') {
    const secret = (d && (d.secret || (d.user && d.user.secret))) || '';
    if (secret) showCarbonTextModal('Новый секрет · ' + name, secret);
  }
  await carbonRefresh('Пользователь ' + (labels[action] || 'обновлён'));
}

async function carbonProxyLinks(name) {
  const d = await api('/api/proxy/users/' + encodeURIComponent(name) + '/links');
  const links = Array.isArray(d.links) ? d.links : [];
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `<div class="modal-card"><div class="modal-head"><div><div class="modal-title">Ссылки: ${escHtml(name)}</div><div class="modal-sub">tg:// для Telegram</div></div><button class="icon-btn" data-links-close>✕</button></div>
    ${links.map(l => `<label class="field" style="margin-bottom:8px"><span>Ссылка</span><input readonly value="${escHtml(l)}"></label>`).join('') || '<p>Ссылок нет. Проверьте, что пользователь включён, а движок запущен.</p>'}
    ${d.qr ? `<img src="${escHtml(d.qr)}" alt="QR" style="width:200px;height:200px;background:#fff;padding:8px;border-radius:10px;display:block;margin:12px auto 0">` : ''}
    <div class="modal-actions"><button class="btn" data-links-close>Закрыть</button></div></div>`;
  document.body.appendChild(modal);
  modal.hidden = false;
  modal.querySelectorAll('[data-links-close]').forEach(b => b.addEventListener('click', () => modal.remove()));
}

async function carbonProxySettings() {
  let s = {};
  try { s = await api('/api/proxy/settings'); } catch (e) {}
  showCarbonForm({
    title: 'Настройки прокси',
    fields: [
      { name: 'hostType', label: 'Адрес в ссылках', type: 'select', value: s.hostType || 'ip', options: [{ value: 'ip', label: 'IP сервера' }, { value: 'domain', label: 'Домен' }] },
      { name: 'domain', label: 'Домен', value: s.domain || s.detectedDomain || '' },
      { name: 'port', label: 'Порт', type: 'number', value: s.port || 443, min: 1, max: 65535 },
      { name: 'sni', label: 'SNI', value: s.sni || '', placeholder: 'vimeo.com' }
    ],
    submitText: 'Применить',
    onSubmit: async v => {
      const body = { hostType: v.hostType, domain: v.hostType === 'domain' ? v.domain.trim() : '' };
      if (Number(v.port) && Number(v.port) !== Number(s.port)) body.port = Number(v.port);
      if (v.sni.trim() && v.sni.trim() !== String(s.sni || '')) body.sni = v.sni.trim();
      await api('/api/proxy/settings', { method: 'POST', body });
      await carbonRefresh('Настройки прокси применены');
    }
  });
}

async function carbonProxyFix() {
  const d = await api('/api/proxy/fix');
  showCarbonForm({
    title: 'Фикс прокси',
    sub: d.installed ? 'Установлен: ' + (d.type || '') : 'Фикс не установлен',
    fields: [
      { name: 'type', label: 'Тип', type: 'select', value: d.type || 'v3', options: [{ value: 'v3', label: 'v3 iptables' }, { value: 'v2', label: 'v2 iptables' }, { value: 'nft', label: 'v3 nftables' }, { value: 'v4', label: 'v4 Zapret2' }] },
      { name: 'port', label: 'Порт', type: 'number', value: d.port || 443, min: 1, max: 65535 }
    ],
    submitText: 'Установить фикс',
    danger: true,
    onSubmit: async v => {
      const r = await api('/api/proxy/fix', { method: 'POST', body: { type: v.type, port: Number(v.port) } });
      showCarbonTextModal('Фикс прокси', r.output || 'Готово');
      await carbonRefresh('Фикс установлен');
    }
  });
}

async function carbonProxyOptimization(action) {
  if (!confirm(action === 'apply' ? 'Применить оптимизацию? Служба будет перезапущена.' : 'Откатить оптимизацию?')) return;
  const d = await api('/api/proxy/optimization', { method: 'POST', body: { action } });
  showCarbonTextModal('Оптимизация прокси', d.output || 'Готово');
  await carbonRefresh(action === 'apply' ? 'Оптимизация применена' : 'Оптимизация откатана');
}

async function carbonProxyApiKey() {
  if (!confirm('Перевыпустить API-ключ MTProxyL? Старый перестанет работать.')) return;
  const d = await api('/api/proxy/api-key', { method: 'POST', body: {} });
  showCarbonTextModal('API-ключ MTProxyL', typeof d === 'string' ? d : JSON.stringify(d, null, 2));
}

async function carbonProxyBot() {
  let s = {};
  try { s = await api('/api/proxy/bot'); } catch (e) {}
  showCarbonForm({
    title: 'Telegram-бот прокси',
    fields: [
      { name: 'enabled', label: 'Включить бота', type: 'checkbox', value: !!s.enabled },
      { name: 'autoClaim', label: 'Автоопределение админа по /start', type: 'checkbox', value: s.autoClaim !== false },
      { name: 'token', label: 'Токен', type: 'password', placeholder: s.tokenSet ? 'Сохранён — оставьте пустым' : '123456789:AA…' },
      { name: 'admins', label: 'Админы (ID через запятую)', value: (s.admins || []).join(', ') }
    ],
    submitText: 'Сохранить',
    onSubmit: async v => {
      const body = { enabled: !!v.enabled, autoClaim: !!v.autoClaim, admins: String(v.admins || '').split(/[,\s;]+/).filter(Boolean) };
      if (v.token.trim()) body.token = v.token.trim();
      await api('/api/proxy/bot', { method: 'POST', body });
      await carbonRefresh('Настройки бота сохранены');
    }
  });
}

async function carbonProxyDiag() {
  const d = await api('/api/proxy/diag');
  const text = (d.checks || []).map(c => (c.ok ? '✓ ' : '✗ ') + c.name + (c.detail ? ': ' + c.detail : '')).join('\n');
  showCarbonTextModal('Диагностика прокси', text || 'Проверки не выполнены');
}

async function carbonProxyLog() {
  const d = await api('/api/proxy/log');
  const text = typeof d === 'string' ? d : (d.log || d.text || JSON.stringify(d, null, 2));
  showCarbonTextModal('Журнал прокси', text);
}

async function carbonUfwAdd() {
  showCarbonForm({
    title: 'Открыть порт UFW',
    fields: [
      { name: 'port', label: 'Порт', placeholder: '443' },
      { name: 'proto', label: 'Протокол', type: 'select', options: [{ value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }] },
      { name: 'iface', label: 'Интерфейс', type: 'select', options: [{ value: '', label: 'Все' }, ...(carbon.interfaces || []).map(i => ({ value: i, label: i }))] }
    ],
    submitText: 'Добавить',
    onSubmit: async v => {
      if (!v.port) throw new Error('Укажите порт');
      await api('/api/ufw', { method: 'POST', body: { port: v.port, proto: v.proto, iface: v.iface } });
      await carbonRefresh('Правило UFW добавлено');
    }
  });
}

async function carbonIptablesAdd() {
  showCarbonForm({
    title: 'Добавить правило iptables',
    sub: 'Цепочка filter, вставка в начало',
    fields: [
      { name: 'chain', label: 'Цепочка', type: 'select', options: ['INPUT', 'FORWARD', 'OUTPUT'].map(x => ({ value: x, label: x })) },
      { name: 'proto', label: 'Протокол', type: 'select', options: [{ value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }, { value: 'icmp', label: 'ICMP' }, { value: 'any', label: 'Любой' }] },
      { name: 'port', label: 'Порт', placeholder: '443' },
      { name: 'src', label: 'Источник (IP/CIDR)', placeholder: '0.0.0.0/0' },
      { name: 'dst', label: 'Назначение (IP/CIDR)', placeholder: '0.0.0.0/0' },
      { name: 'action', label: 'Действие', type: 'select', options: ['ACCEPT', 'DROP', 'REJECT'].map(x => ({ value: x, label: x })) },
      { name: 'comment', label: 'Комментарий', placeholder: 'servpanel' },
      { name: 'insert', label: 'Вставить в начало цепочки', type: 'checkbox', value: true }
    ],
    submitText: 'Добавить',
    onSubmit: async v => {
      await api('/api/iptables', { method: 'POST', body: v });
      await carbonRefresh('Правило iptables добавлено');
    }
  });
}

async function carbonAwgEdit() {
  const a = carbon.awgConfig || {};
  showCarbonForm({
    title: 'Редактор AWG',
    sub: a.file || 'awg0.conf',
    fields: [{ name: 'content', label: 'Конфигурация', type: 'textarea', rows: 18, value: a.content || a.text || '' }],
    submitText: 'Сохранить и перезапустить',
    danger: true,
    onSubmit: async v => {
      if (!v.content.trim()) throw new Error('Пустой конфиг');
      await api('/api/awg/config', { method: 'POST', body: { content: v.content, file: a.file } });
      await carbonRefresh('Конфиг сохранён, AWG перезапущен');
    }
  });
}

async function carbonServerName() {
  let s = {};
  try { s = await api('/api/awg/server-name'); } catch (e) {}
  showCarbonForm({
    title: 'Имя сервера',
    sub: 'Используется в именах конфигов',
    fields: [{ name: 'name', label: 'Имя', value: s.name || '' }],
    submitText: 'Сохранить',
    onSubmit: async v => {
      await api('/api/awg/server-name', { method: 'POST', body: { name: v.name.trim() } });
      await carbonRefresh('Имя сервера сохранено');
    }
  });
}

async function carbonInstallMtproxyl() {
  if (!confirm('Установить MTProxyL? Это отдельный движок прокси.')) return;
  const d = await api('/api/install/module', { method: 'POST', body: { module: 'mtproxyl' } });
  showCarbonTextModal('Установка MTProxyL', d.logFile ? 'Запущено. Журнал: ' + d.logFile : 'Установка запущена');
  await carbonRefresh();
}

async function carbonCascadeIfacesSave() {
  const ifaces = [...document.querySelectorAll('[data-cascade-iface]:checked')].map(x => x.value);
  if (!ifaces.length) throw new Error('Выберите хотя бы один интерфейс');
  await api('/api/cascade/interfaces', { method: 'POST', body: { interfaces: ifaces } });
  carbon.cascadeInterfaces = { ...(carbon.cascadeInterfaces || {}), selected: ifaces };
  await carbonRefresh('Интерфейсы каскада: ' + ifaces.join(', '));
}

async function carbonCascadeBuild() {
  showCarbonForm({
    title: 'Построить каскад RU → EU',
    sub: 'Панель по SSH настроит вторую сторону. Это может занять 5–15 минут.',
    fields: [
      { name: 'role', label: 'Роль этого сервера', type: 'select', options: [{ value: 'ru', label: 'Вход (RU)' }, { value: 'eu', label: 'Выход (EU)' }] },
      { name: 'version', label: 'Версия AWG', type: 'select', options: ['3.1', '2.0', '1.5'] },
      { name: 'peerHost', label: 'IP второй стороны', placeholder: '203.0.113.20' },
      { name: 'peerPort', label: 'SSH-порт', value: '22' },
      { name: 'peerUser', label: 'SSH-пользователь', value: 'root' },
      { name: 'peerPass', label: 'Пароль root', type: 'password' },
      { name: 'obfMode', label: 'Обфускация', type: 'select', options: [{ value: 'installer', label: 'Как у установщика' }, { value: 'architect', label: 'Архитектор' }, { value: 'custom', label: 'Свои параметры' }] },
      { name: 'obfProfile', label: 'Профиль Архитектора', value: 'quic' },
      { name: 'ifaces', label: 'Клиентские интерфейсы', value: (carbon.cascadeInterfaces && carbon.cascadeInterfaces.selected && carbon.cascadeInterfaces.selected.length ? carbon.cascadeInterfaces.selected : ['awg0']).join(', ') },
      { name: 'extraRuNets', label: 'Доп. сети RU', placeholder: '10.0.0.0/8, 192.168.0.0/16' }
    ],
    submitText: 'Построить каскад',
    danger: true,
    onSubmit: async v => {
      if (!v.peerHost || !v.peerPass) throw new Error('Укажите IP второй стороны и пароль root');
      const body = {
        role: v.role, version: v.version, peerHost: v.peerHost.trim(), peerPort: v.peerPort || '22',
        peerUser: v.peerUser || 'root', peerPass: v.peerPass,
        obfMode: v.obfMode, obfProfile: v.obfProfile, obfIntensity: 'medium',
        obfSource: '', ifaces: String(v.ifaces || '').split(/[\s,]+/).filter(Boolean),
        extraRuNets: String(v.extraRuNets || '').split(/[\s,]+/).filter(Boolean)
      };
      await api('/api/cascade/ssh-install', { method: 'POST', body });
      showCarbonTextModal('Сборка каскада', 'Задача запущена, ждём шаги…');
      for (let i = 0; i < 900; i++) {
        await carbonSleep(2000);
        let job = null;
        try { job = await api('/api/cascade/ssh-progress'); } catch (e) {
          showCarbonTextModal('Сборка каскада', 'Панель перезагружается, ждём…');
          continue;
        }
        const steps = (job && job.steps) || [];
        const text = steps.map(s => s.title + ': ' + (s.text || '')).join('\n');
        showCarbonTextModal('Сборка каскада', text || 'Выполняется…');
        if (job && job.running === false && job.done) {
          if (job.error) { showToast('Каскад не собрался: ' + job.error); return; }
          showCarbonTextModal('Каскад настроен', text + '\n\nГотово.');
          await carbonRefresh('Каскад настроен');
          return;
        }
      }
      showToast('Сборка идёт дольше 30 минут — проверьте журнал');
    }
  });
}

async function carbonCascadeManual() {
  showCarbonForm({
    title: 'Каскад вручную',
    sub: 'Вставьте конфиг второй стороны и выберите интерфейсы',
    fields: [
      { name: 'config', label: 'Конфиг клиента EU', type: 'textarea', rows: 10 },
      { name: 'ifaces', label: 'Клиентские интерфейсы', value: (carbon.cascadeInterfaces && carbon.cascadeInterfaces.selected && carbon.cascadeInterfaces.selected.length ? carbon.cascadeInterfaces.selected : ['awg0']).join(', ') },
      { name: 'extraRuNets', label: 'Доп. сети RU', placeholder: '10.0.0.0/8' },
      { name: 'peerHost', label: 'IP второй стороны', placeholder: 'Необязательно' },
      { name: 'peerUser', label: 'SSH-пользователь', value: 'root' },
      { name: 'peerPass', label: 'Пароль root', type: 'password' },
      { name: 'peerClient', label: 'Имя клиента', value: 'ru_host' }
    ],
    submitText: 'Настроить каскад',
    danger: true,
    onSubmit: async v => {
      if (!v.config.trim() && !(v.peerHost.trim() && v.peerUser.trim())) throw new Error('Вставьте конфиг или заполните данные второй стороны');
      const d = await api('/api/cascade/setup', {
        method: 'POST',
        body: {
          config: v.config, ifaces: String(v.ifaces || '').split(/[\s,]+/).filter(Boolean),
          extraRuNets: v.extraRuNets, peerHost: v.peerHost.trim(), peerUser: v.peerUser.trim(),
          peerPass: v.peerPass, peerClient: v.peerClient.trim()
        }
      });
      await carbonRefresh('Каскад настроен: ' + (d.role === 'ru' ? 'RU' : 'EU') + ' · ' + (d.endpoint || '—'));
    }
  });
}

async function carbonCascadeCleanup() {
  if (!confirm('Удалить каскад на этом сервере? Клиенты VPN не пострадают.')) return;
  const d = await api('/api/cascade/cleanup', { method: 'POST', body: {} });
  const text = (d.steps || []).map(s => s.title + ': ' + s.text).join('\n') || 'Готово';
  showCarbonTextModal('Удаление каскада', text);
  await carbonRefresh('Каскад удалён');
}

async function carbonAdguardConfig() {
  let st = {};
  try { st = await api('/api/warp/status'); carbon.warp = st; } catch (e) { st = carbon.warp || {}; }
  const isIp = v => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(v || '').trim()) && String(v).split('.').every(x => Number(x) <= 255);
  let defaultIp = carbon.server && carbon.server.ip;
  if (!isIp(defaultIp)) {
    try {
      const info = await api('/api/server-info');
      carbon.server = { ...(carbon.server || {}), ...(info || {}) };
      defaultIp = info && info.ip;
    } catch (e) { /* ignore */ }
  }
  if (!isIp(defaultIp)) defaultIp = location.hostname || '';
  const services = (Array.isArray(st.services) ? st.services : []).filter(s => Array.isArray(s.domains) && s.domains.length);
  const selectedIds = new Set(services.filter(s => s.route === 'warp' || (s.route == null && s.selected)).map(s => s.id));
  const chips = services.map(s => `<label class="chip ${selectedIds.has(s.id) ? 'on' : ''}" style="cursor:pointer"><input type="checkbox" data-adg-service value="${escHtml(s.id)}" ${selectedIds.has(s.id) ? 'checked' : ''} onchange="this.closest('label').classList.toggle('on',this.checked)"> ${escHtml(s.label)}</label>`).join('');
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `<div class="modal-card modal-wide"><div class="modal-head"><div><div class="modal-title">Конфиг для AdGuard Home</div><div class="modal-sub">Пользовательские правила: домены выбранных сервисов → IP сервера</div></div><button class="icon-btn" data-adg-close>✕</button></div>
    <label class="field"><span>IP для A-записи</span><input id="carbonAdgIp" value="${escHtml(defaultIp)}" placeholder="203.0.113.10"></label>
    <div class="card-sub" style="margin:14px 0 8px">Сервисы</div>
    <div class="chips" id="carbonAdgServices">${chips || '<span class="muted">Сервисы не найдены</span>'}</div>
    <div class="page-actions" style="margin-top:12px"><button class="btn btn-sm" data-adg-all>Все</button><button class="btn btn-sm" data-adg-none>Снять все</button><button class="btn btn-primary" data-adg-build>Сформировать</button><button class="btn" data-adg-copy>${icon('copy')}Копировать</button><button class="btn" data-adg-download>${icon('download')}Скачать .txt</button></div>
    <pre class="code" data-adg-out style="margin-top:14px;padding:12px;white-space:pre-wrap;max-height:45vh;overflow:auto">Нажмите «Сформировать»</pre></div>`;
  document.body.appendChild(modal);
  modal.hidden = false;
  modal.querySelector('[data-adg-close]').addEventListener('click', () => modal.remove());
  const ipInput = modal.querySelector('#carbonAdgIp');
  const out = modal.querySelector('[data-adg-out]');
  const boxes = [...modal.querySelectorAll('[data-adg-service]')];
  const build = () => {
    const ip = ipInput.value.trim() || defaultIp;
    const ids = new Set(boxes.filter(x => x.checked).map(x => x.value));
    const names = services.filter(s => ids.has(s.id)).map(s => s.label);
    const domains = [...new Set(services.filter(s => ids.has(s.id)).flatMap(s => s.domains || [])
      .map(d => String(d).trim().replace(/^www\d*\./i, ''))
      .filter(Boolean))];
    if (!domains.length) { out.textContent = 'Выберите хотя бы один сервис'; return ''; }
    const text = `# AdGuard Home — пользовательские правила\n# IP: ${ip}\n# Сервисы: ${names.join(', ')}\n\n` + domains.map(d => `||${d}^$dnsrewrite=NOERROR;A;${ip}`).join('\n') + '\n';
    out.textContent = text;
    return text;
  };
  modal.querySelector('[data-adg-all]').addEventListener('click', () => { boxes.forEach(x => { x.checked = true; x.closest('label').classList.add('on'); }); build(); });
  modal.querySelector('[data-adg-none]').addEventListener('click', () => { boxes.forEach(x => { x.checked = false; x.closest('label').classList.remove('on'); }); build(); });
  boxes.forEach(x => x.addEventListener('change', build));
  modal.querySelector('[data-adg-build]').addEventListener('click', build);
  modal.querySelector('[data-adg-copy]').addEventListener('click', () => { const t = build(); if (t) copyText(t); });
  modal.querySelector('[data-adg-download]').addEventListener('click', () => {
    const t = build();
    if (!t) return;
    const blob = new Blob([t], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'adguard-home-rules.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    showToast('Файл adguard-home-rules.txt скачан');
  });
  build();
}

async function carbonAdguardStats() {
  let auto = null;
  try { auto = await api('/api/adguard/autodetect'); } catch (e) {}
  showCarbonForm({
    title: 'AdGuard Home',
    sub: auto && auto.found ? 'Найден: ' + auto.url : 'Укажите адрес API',
    fields: [
      { name: 'url', label: 'URL API', value: auto && auto.url ? auto.url : '', placeholder: 'http://127.0.0.1:3001' },
      { name: 'user', label: 'Логин', value: auto && auto.user ? auto.user : '' },
      { name: 'pass', label: 'Пароль', type: 'password' }
    ],
    submitText: 'Проверить',
    onSubmit: async v => {
      const d = await api('/api/adguard/stats', { method: 'POST', body: { url: v.url.trim(), user: v.user.trim(), pass: v.pass } });
      showCarbonTextModal('AdGuard: статистика', 'Запросов: ' + (d.num_dns_queries ?? '—') + '\nЗаблокировано: ' + (d.num_blocked_filtering ?? '—') + '\nSafebrowsing: ' + (d.num_replaced_safebrowsing ?? '—'));
    }
  });
}

async function carbonWarpServicesSave() {
  const services = [...document.querySelectorAll('#carbonWarpServices input[data-warp-service]:checked')].map(x => x.value);
  await api('/api/warp/services', { method: 'POST', body: { services } });
  try { carbon.warp = await api('/api/warp/status'); } catch (e) { /* ignore */ }
  render();
  showToast('Сервисы WARP сохранены: ' + services.length);
}

function carbonWarpServicesSelect(mode) {
  document.querySelectorAll('#carbonWarpServices label.chip').forEach(label => {
    const input = label.querySelector('input[data-warp-service]');
    if (!input) return;
    if (mode === 'ai' && String(label.dataset.warpGroup || '').toLowerCase() === 'ai') input.checked = true;
    if (mode === 'none') input.checked = false;
    label.classList.toggle('on', input.checked);
  });
}

async function carbonWarpPanel() {
  let st = {};
  try { st = await api('/api/warp/status'); } catch (e) {}
  const modal = document.createElement('div');
  modal.className = 'modal';
  const summary = st.installed
    ? `Xray: ${st.xrayActive ? 'активен' : 'остановлен'} (${st.listenIp || '—'}:${st.listenPort || '—'}) · WARP: ${st.connected ? 'подключён' : 'не подключён'} · SOCKS: ${st.socksPort || '—'}`
    : 'WARP не установлен.';
  const rows = (st.services || []).map(s => {
    const route = s.route || (s.id === 'gemini' ? 'direct' : (s.selected ? 'warp' : 'direct'));
    const radio = (value, label) => `<label class="warp-radio" title="${label}"><input type="radio" name="warp-route-${escHtml(s.id)}" data-warp-route data-service-id="${escHtml(s.id)}" value="${value}" ${route === value ? 'checked' : ''}><span>${label}</span></label>`;
    return `<div class="warp-route-row"><span class="warp-service-name"><b>${escHtml(s.label)}</b>${s.overridden ? '<span class="tag">изменён</span>' : ''}<button class="row-action" data-warp-custom-edit="${escHtml(s.id)}" title="Редактировать сервис">${icon('edit')}</button>${s.overridden ? `<button class="row-action" data-warp-custom-reset="${escHtml(s.id)}" title="Сбросить к стандартным">${icon('refresh')}</button>` : ''}${s.custom ? `<button class="row-action" data-warp-custom-delete="${escHtml(s.id)}" title="Удалить сервис">${icon('trash')}</button>` : ''}</span>${radio('warp', 'В WARP')}${radio('direct', 'Напрямую')}${radio('off', 'Отключено')}</div>`;
  }).join('');
  modal.innerHTML = `<div class="modal-card modal-wide"><div class="modal-head"><div><div class="modal-title">WARP + Xray</div><div class="modal-sub">${escHtml(summary)}</div></div><button class="icon-btn" data-warp-close>✕</button></div>
    <div class="page-actions" style="flex-wrap:wrap"><button class="btn btn-primary" data-warp-action="power-on">Включить</button><button class="btn" data-warp-action="power-off">Остановить</button><button class="btn" data-warp-action="test">Проверить WARP</button><button class="btn" data-warp-custom>Сервисы</button></div>
    <div class="donut-note" style="margin-top:12px">Слева — через WARP. По центру — напрямую с IP сервера (как Gemini). Справа — сервис отключён.</div>
    <div class="page-actions" style="margin-top:12px"><button class="btn btn-sm" data-warp-preset="all-warp">Все в WARP</button><button class="btn btn-sm" data-warp-preset="v2">Gemini напрямую</button><button class="btn btn-sm" data-warp-preset="all-direct">Все напрямую</button><button class="btn btn-sm" data-warp-preset="all-off">Все отключить</button></div>
    <div class="warp-route-table" style="margin-top:12px"><div class="warp-route-row head"><span>Сервис</span><span>В WARP</span><span>Напрямую</span><span>Отключено</span></div>${rows || '<div class="empty-row">Сервисы не найдены</div>'}</div>
    <div class="page-actions" style="margin-top:14px"><button class="btn btn-primary" data-warp-apply>Применить</button></div>
    <pre class="code" data-warp-out style="margin-top:14px;padding:12px;white-space:pre-wrap;max-height:36vh;overflow:auto">Готово</pre></div>`;
  document.body.appendChild(modal);
  modal.hidden = false;
  modal.querySelector('[data-warp-close]').addEventListener('click', () => modal.remove());
  const out = modal.querySelector('[data-warp-out]');
  const radios = [...modal.querySelectorAll('[data-warp-route]')];
  modal.querySelectorAll('[data-warp-preset]').forEach(b => b.addEventListener('click', () => {
    const mode = b.dataset.warpPreset;
    radios.forEach(x => {
      if (mode === 'all-warp') x.checked = x.value === 'warp';
      else if (mode === 'all-direct') x.checked = x.value === 'direct';
      else if (mode === 'all-off') x.checked = x.value === 'off';
      else if (mode === 'v2') x.checked = x.dataset.serviceId === 'gemini' ? x.value === 'direct' : x.value === 'warp';
    });
  }));
  modal.querySelector('[data-warp-custom]').addEventListener('click', () => {
    showCarbonForm({
      title: 'Свой сервис',
      sub: 'Название и домены через запятую или с новой строки',
      fields: [
        { name: 'label', label: 'Название', placeholder: 'Например, My AI' },
        { name: 'domains', label: 'Домены', type: 'textarea', rows: 6, placeholder: 'example.com\napi.example.com' }
      ],
      submitText: 'Добавить',
      onSubmit: async v => {
        if (!v.label.trim()) throw new Error('Укажите название');
        await api('/api/warp/custom', { method: 'POST', body: { label: v.label.trim(), domains: v.domains } });
        modal.remove();
        await carbonWarpPanel();
      }
    });
  });
  modal.querySelectorAll('[data-warp-custom-edit]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.warpCustomEdit;
    const svc = (st.services || []).find(x => x.id === id);
    if (!svc) return;
    showCarbonForm({
      title: 'Редактировать сервис',
      sub: 'Название и домены через запятую или с новой строки',
      fields: [
        { name: 'label', label: 'Название', value: svc.label },
        { name: 'domains', label: 'Домены', type: 'textarea', rows: 6, value: (svc.domains || []).join('\n') }
      ],
      submitText: 'Сохранить',
      onSubmit: async v => {
        if (!v.label.trim()) throw new Error('Укажите название');
        await api('/api/warp/custom', { method: 'POST', body: { id, label: v.label.trim(), domains: v.domains } });
        modal.remove();
        await carbonWarpPanel();
      }
    });
  }));
  modal.querySelectorAll('[data-warp-custom-reset]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.warpCustomReset;
    if (!confirm('Сбросить домены сервиса к стандартным?')) return;
    try {
      await api('/api/warp/override/' + encodeURIComponent(id), { method: 'DELETE' });
      modal.remove();
      await carbonWarpPanel();
    } catch (e) { out.textContent = e.message; }
  }));
  modal.querySelectorAll('[data-warp-custom-delete]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.warpCustomDelete;
    if (!confirm('Удалить свой сервис?')) return;
    try {
      await api('/api/warp/custom/' + encodeURIComponent(id), { method: 'DELETE' });
      modal.remove();
      await carbonWarpPanel();
    } catch (e) { out.textContent = e.message; }
  }));
  modal.querySelector('[data-warp-apply]').addEventListener('click', async () => {
    try {
      const routes = {};
      radios.forEach(x => { if (x.checked) routes[x.dataset.serviceId] = x.value; });
      if (!confirm('Маршруты будут применены: WARP, напрямую и отключённые. Продолжить?')) return;
      await api('/api/warp/routes', { method: 'POST', body: { routes } });
      const d = await api('/api/install/module', { method: 'POST', body: { module: 'warp', warpMode: 'v2', listenIp: '0.0.0.0', listenPort: '443', socksPort: st.socksPort || '40000' } });
      carbon.warp = await api('/api/warp/status').catch(() => null);
      render();
      out.textContent = d.logFile ? 'Маршруты сохранены, установка запущена. Журнал: ' + d.logFile : 'Маршруты сохранены, установка запущена';
    } catch (e) { out.textContent = e.message; }
  });
  modal.querySelectorAll('[data-warp-action]').forEach(b => b.addEventListener('click', async () => {
    const a = b.dataset.warpAction;
    try {
      if (a === 'power-on' || a === 'power-off') {
        const d = await api('/api/warp/power', { method: 'POST', body: { enable: a === 'power-on' } });
        out.textContent = JSON.stringify(d, null, 2);
      } else if (a === 'test') {
        const d = await api('/api/warp/test', { method: 'POST', body: { socksPort: st.socksPort || '40000' } });
        out.textContent = JSON.stringify(d, null, 2);
      }
    } catch (e) { out.textContent = e.message; }
  }));
}

async function carbonDnsCapture() {
  let status = {};
  try { status = await api('/api/tools/status'); } catch (e) {}
  const dns = status.dns || {};
  showCarbonForm({
    title: 'DNS-перехват',
    fields: [
      { name: 'enable', label: 'Включить перехват', type: 'checkbox', value: !!(dns.enabled) },
      { name: 'ifaces', label: 'Интерфейсы', value: (dns.ifaces || carbon.interfaces || []).join(', ') },
      { name: 'target', label: 'DNS-сервер', value: dns.target || '10.8.0.1' }
    ],
    submitText: 'Применить',
    onSubmit: async v => {
      const body = {
        enable: !!v.enable,
        ifaces: String(v.ifaces || '').split(/[\s,]+/).filter(Boolean),
        target: v.target.trim(),
        oldIfaces: dns.ifaces || [],
        oldTarget: dns.target || ''
      };
      await api('/api/tools/dns', { method: 'POST', body });
      await carbonRefresh('Правила DNS обновлены');
    }
  });
}

async function carbonAppMetrics() {
  const m = (carbon.app && carbon.app.metrics) || {};
  showCarbonForm({
    title: 'Метрики приложения',
    fields: [
      { name: 'enabled', label: 'Включить метрики', type: 'checkbox', value: !!m.enabled },
      { name: 'host', label: 'Адрес', value: m.host || '127.0.0.1' },
      { name: 'port', label: 'Внутренний порт', type: 'number', value: m.port || 9101, min: 1, max: 65535 },
      { name: 'publicPort', label: 'Внешний порт', type: 'number', value: m.publicPort || 9101, min: 1, max: 65535 },
      { name: 'format', label: 'Формат', type: 'select', value: m.format || 'json', options: [{ value: 'json', label: 'JSON' }, { value: 'prometheus', label: 'Prometheus' }] },
      { name: 'token', label: 'Токен (пусто — не менять)', type: 'password', placeholder: m.tokenSet ? 'Сохранён' : '' }
    ],
    submitText: 'Сохранить',
    onSubmit: async v => {
      const body = { enabled: !!v.enabled, host: v.host.trim(), port: Number(v.port), publicPort: Number(v.publicPort), format: v.format, token: v.token.trim() };
      const d = await api('/api/app/metrics', { method: 'POST', body });
      await carbonRefresh(d.generatedToken ? 'Метрики включены, токен создан' : 'Метрики сохранены');
    }
  });
}

async function carbonAppMetricsToken() {
  if (!confirm('Сгенерировать новый токен метрик? Старый перестанет работать.')) return;
  const d = await api('/api/app/metrics/token', { method: 'POST' });
  const token = (d.status && d.status.metrics && d.status.metrics.token) || d.token || '';
  showCarbonTextModal('Новый токен метрик', token || 'Токен создан');
  await carbonRefresh();
}

async function carbonRustdeskInstructions() {
  const text = await api('/api/rustdesk/instructions?format=txt');
  showCarbonTextModal('Инструкция RustDesk', typeof text === 'string' ? text : JSON.stringify(text, null, 2));
}

async function carbonRustdeskRefresh() {
  const d = await api('/api/rustdesk/status?refresh=1');
  carbon.rustdesk = d;
  render();
  showToast('Версии RustDesk обновлены');
}

async function carbonRustdeskSettings() {
  const r = carbon.rustdesk || {};
  showCarbonForm({
    title: 'Настройки RustDesk',
    fields: [
      { name: 'hostType', label: 'Адрес', type: 'select', value: r.hostType || 'domain', options: [{ value: 'domain', label: 'Домен' }, { value: 'ip', label: 'IP' }] },
      { name: 'domain', label: 'Домен', value: r.domain || r.host || '' },
      { name: 'openPorts', label: 'Открыть порты UFW', type: 'checkbox', value: true },
      { name: 'webClient', label: 'Web-клиент', type: 'checkbox', value: !!(r.settings && r.settings.webClient) }
    ],
    submitText: 'Сохранить',
    onSubmit: async v => {
      await api('/api/rustdesk/settings', { method: 'POST', body: { hostType: v.hostType, domain: v.domain.trim(), openPorts: !!v.openPorts, webClient: !!v.webClient } });
      await carbonRefresh('Настройки RustDesk сохранены');
    }
  });
}

async function carbonRustdeskJob(action) {
  const msg = action === 'uninstall' ? 'Полностью удалить RustDesk Server?' : action === 'install' ? 'Установить RustDesk Server?' : 'Обновить RustDesk Server с GitHub?';
  if (!confirm(msg)) return;
  await api('/api/rustdesk/' + action, { method: 'POST', body: {} });
  showCarbonTextModal('RustDesk', 'Выполняется…');
  for (let i = 0; i < 300; i++) {
    await carbonSleep(2000);
    let d = null;
    try { d = await api('/api/rustdesk/job'); } catch (e) { continue; }
    const job = d && d.job;
    if (!job) continue;
    showCarbonTextModal('RustDesk: ' + action, (job.log || []).join('\n') || (job.running ? 'Выполняется…' : 'Готово'));
    if (!job.running) {
      await carbonRefresh(job.ok ? 'RustDesk: готово' : 'RustDesk: ошибка');
      return;
    }
  }
}

async function carbonFail2banRefresh() {
  const d = await api('/api/fail2ban/status');
  carbon.fail2ban = d;
  render();
  showToast('Список Fail2Ban обновлён');
}

async function carbonFail2banUnban(ip) {
  if (!ip) throw new Error('Не указан IP');
  await api('/api/fail2ban/unban', { method: 'POST', body: { ip } });
  await carbonFail2banRefresh();
  showToast('IP разблокирован: ' + ip);
}

async function carbonFail2ban() {
  let d = {};
  try { d = await api('/api/fail2ban/status'); } catch (e) {}
  const text = d.installed
    ? 'Jail: ' + (d.jail ? 'активен' : 'не найден') + '\nНеудачных попыток: ' + (d.currentlyFailed || 0) + ' / всего ' + (d.totalFailed || 0) + '\nЗабанено: ' + ((d.banned || []).join(', ') || '—') + '\nЛог: ' + (d.log || '—')
    : 'fail2ban не установлен.';
  showCarbonForm({
    title: 'Fail2Ban',
    sub: 'Статус и разблокировка IP',
    fields: [{ name: 'status', label: 'Статус', type: 'textarea', rows: 6, value: text }, { name: 'ip', label: 'Разблокировать IP', placeholder: '198.51.100.7' }],
    submitText: 'Разблокировать',
    onSubmit: async v => {
      if (!v.ip.trim()) return;
      await api('/api/fail2ban/unban', { method: 'POST', body: { ip: v.ip.trim() } });
      await carbonRefresh('IP разблокирован');
    }
  });
}

async function carbonDiagCheck() {
  const services = carbon.services || [];
  const active = services.filter(s => s.state === 'active').length;
  const c = carbon.cascade || {};
  const p = carbon.proxy || {};
  const s = carbon.ssl || {};
  const mods = carbon.modules || [];
  const inst = mods.filter(m => m.installed).length;
  const sec = carbon.security || {};
  const lines = [
    'Службы: ' + active + ' / ' + services.length + ' активны',
    'Каскад: ' + (c.active ? 'активен' : 'не активен') + (c.endpoint ? ' · ' + c.endpoint : ''),
    'Прокси: ' + (p.running === false ? 'остановлен' : 'доступен') + (p.backend ? ' · ' + p.backend : ''),
    'Модули: ' + inst + ' / ' + mods.length + ' установлены',
    'HTTPS: ' + (sec.https ? 'включён' : 'выключен') + ' · сертификатов: ' + ((s.certificates || []).length),
    '2FA: ' + (sec.totpEnabled ? 'включена' : 'выключена'),
    'Версия: ' + ((carbon.update && carbon.update.version) || '—')
  ];
  showCarbonTextModal('Проверка сервера', lines.join('\n'));
}

async function carbonObfGenerate() {
  const profiles = (carbon.profiles && (carbon.profiles.builtin || []).concat(carbon.profiles.custom || [])) || [];
  showCarbonForm({
    title: 'Сгенерировать обфускацию',
    sub: 'Новые H1–H4, S1–S4, Jc/Jmin/Jmax и HPK',
    fields: [
      { name: 'preset', label: 'Профиль', type: 'select', options: profiles.map(p => ({ value: p.name, label: p.title || p.name })) },
      { name: 'sni', label: 'SNI', placeholder: 'ozon.ru' },
      { name: 'regen', label: 'Перегенерировать клиентов', type: 'checkbox', value: true }
    ],
    submitText: 'Сгенерировать и применить',
    danger: true,
    onSubmit: async v => {
      const preview = await api('/api/obf/generate', { method: 'POST', body: { preset: v.preset, sni: v.sni.trim() } });
      await api('/api/obf/apply', { method: 'POST', body: { params: preview.params, regenClients: !!v.regen, removeMissing: true } });
      await carbonRefresh('Обфускация применена');
    }
  });
}

async function carbonObfSync() {
  if (!confirm('Синхронизировать server_hpk.key с клиентскими конфигами?')) return;
  await api('/api/obf/sync-hpk', { method: 'POST', body: {} });
  await carbonRefresh('HPK синхронизирован');
}

async function carbonRuDropUpload() {
  const input = document.getElementById('carbonRuDropFile');
  const file = input && input.files && input.files[0];
  if (!file) throw new Error('Выберите файл со списком');
  if (file.size > 10 * 1024 * 1024) throw new Error('Файл больше 10 МБ');
  const data = await fileToBase64(file);
  const d = await api('/api/tools/rudrop/upload', { method: 'POST', body: { name: file.name, data } });
  showToast('Загружено адресов: ' + (d.count || 0));
}

async function carbonObfImport() {
  showCarbonForm({
    title: 'Импорт из Архитектора',
    sub: 'Вставьте .conf, JSON или vpn:// — панель проверит и применит параметры',
    fields: [
      { name: 'source', label: 'Источник', type: 'textarea', rows: 12, placeholder: '[Interface] … или JSON' },
      { name: 'regen', label: 'Перегенерировать клиентов', type: 'checkbox', value: true },
      { name: 'removeMissing', label: 'Удалить отсутствующие параметры', type: 'checkbox', value: true }
    ],
    submitText: 'Проверить и применить',
    danger: true,
    onSubmit: async v => {
      if (!v.source.trim()) throw new Error('Вставьте конфиг, JSON или vpn://');
      const analysis = await api('/api/obf/analyze', { method: 'POST', body: { source: v.source } });
      const score = analysis.audit ? analysis.audit.score : '—';
      if (!confirm(`Применить параметры (AWG ${analysis.version || '—'}, оценка ${score}/100)?`)) return;
      const d = await api('/api/obf/apply', { method: 'POST', body: { source: v.source, regenClients: !!v.regen, removeMissing: !!v.removeMissing } });
      await carbonRefresh('Применено параметров: ' + (d.applied || 0));
    }
  });
}

async function carbonCascadeProxy() {
  let d = {};
  try { d = await api('/api/cascade/proxy'); } catch (e) {}
  showCarbonForm({
    title: 'MTProto через EU',
    sub: d.available === false ? 'Telemt/MTProxyL не найден' : 'Исходящие соединения прокси через EU',
    fields: [{ name: 'enabled', label: 'Пустить прокси через EU', type: 'checkbox', value: !!d.enabled }],
    submitText: 'Применить',
    danger: true,
    onSubmit: async v => {
      const r = await api('/api/cascade/proxy', { method: 'POST', body: { enabled: !!v.enabled } });
      await carbonRefresh(r.output || (v.enabled ? 'Прокси пущен через EU' : 'Прокси возвращён напрямую'));
    }
  });
}

async function carbonCascadeProxyTest() {
  const d = await api('/api/cascade/proxy/test');
  showCarbonTextModal('Проверка выхода прокси', JSON.stringify(d, null, 2));
}

async function carbonAwgInstall() {
  showCarbonForm({
    title: 'Установка AmneziaWG',
    sub: 'Параметры установщика',
    fields: [
      { name: 'version', label: 'Версия AWG', type: 'select', options: ['3.1', '2.0', '1.5'] },
      { name: 'port', label: 'Порт', value: '443' },
      { name: 'route', label: 'Маршрут', type: 'select', options: [{ value: 'all', label: 'Весь трафик' }, { value: 'custom', label: 'Свои сети' }] },
      { name: 'awgMode', label: 'Режим', type: 'select', options: [{ value: 'single', label: 'Один сервер' }, { value: 'cascade', label: 'Каскад' }] },
      { name: 'cascadeRole', label: 'Роль в каскаде', type: 'select', options: [{ value: 'ru', label: 'RU-вход' }, { value: 'eu', label: 'EU-выход' }] },
      { name: 'remoteIp', label: 'IP второй стороны', placeholder: 'Только для каскада' },
      { name: 'remotePort', label: 'SSH-порт второй стороны', value: '22' },
      { name: 'remotePass', label: 'Пароль root второй стороны', type: 'password' },
      { name: 'domain', label: 'Домен для конфигов', placeholder: 'Необязательно' }
    ],
    submitText: 'Установить AWG',
    danger: true,
    onSubmit: async v => {
      const body = {
        module: 'awg', version: v.version, route: v.route, customRoute: '', ipv6: 'disallow', port: v.port,
        isolation: true, keepPackages: true, noTweaks: false, awgMode: v.awgMode, cascadeRole: v.cascadeRole,
        remoteIp: v.remoteIp, remotePort: v.remotePort, remotePass: v.remotePass, domain: v.domain
      };
      const d = await api('/api/install/module', { method: 'POST', body });
      showCarbonTextModal('Установка AWG', d.logFile ? 'Запущено. Журнал: ' + d.logFile : 'Установка запущена');
      await carbonRefresh();
    }
  });
}

async function carbonProxyInstall() {
  showCarbonForm({
    title: 'Установка прокси',
    sub: 'Движок, SNI и порт. Дальше — параметры выбранного движка.',
    fields: [
      { name: 'kind', label: 'Движок', type: 'select', options: [
        { value: 'telemt', label: 'Telemt (рекомендуется)' },
        { value: 'zig', label: 'MTProto.zig' },
        { value: 'mtproxyl', label: 'MTProxyL (Telemt + API)' },
        { value: 'fix', label: 'Только фикс MEKO' }
      ] },
      { name: 'domain', label: 'SNI-домен', value: 'ozon.ru' },
      { name: 'port', label: 'Порт', value: '443' }
    ],
    submitText: 'Далее',
    onSubmit: async v => {
      if (v.kind === 'mtproxyl') return carbonProxyInstallMpl(v);
      return carbonProxyInstallMt(v);
    }
  });
}

async function carbonProxyInstallMt(v) {
  const label = { telemt: 'Telemt', zig: 'MTProto.zig', fix: 'MEKO FIX' }[v.kind] || v.kind;
  showCarbonForm({
    title: 'MTProto: ' + label,
    sub: 'SNI: ' + (v.domain || 'ozon.ru') + ' · порт ' + (v.port || '443'),
    fields: [
      { name: 'version', label: 'Версия Telemt', placeholder: 'пусто — последняя' },
      { name: 'fix', label: 'Установить MEKO FIX', type: 'checkbox', value: true },
      { name: 'fixType', label: 'Тип фикса', type: 'select', options: [{ value: 'v3', label: 'v3 — рекомендуется' }, { value: 'v2', label: 'v2 — TTL + Length' }, { value: 'v4', label: 'v4 — Zapret2' }, { value: 'nft', label: 'nft — Docker' }] },
      { name: 'fixPort', label: 'Порт фикса', placeholder: 'как порт прокси' },
      { name: 'adTag', label: 'ad_tag', placeholder: '32 hex-символа' },
      { name: 'mtUser', label: 'Первый пользователь', placeholder: 'необязательно' },
      { name: 'mtUserSecret', label: 'Секрет пользователя', placeholder: 'пусто — сгенерировать' },
      { name: 'publicHost', label: 'Публичный адрес', placeholder: 'пусто — определить' },
      { name: 'web', label: 'WEB-режим (Telemt)', type: 'checkbox', value: false },
      { name: 'webHost', label: 'Домен WEB', placeholder: 'web.example.com' },
      { name: 'webUser', label: 'WEB-пользователь', value: 'webuser' },
      { name: 'webSecret', label: 'WEB-секрет', placeholder: 'пусто — сгенерировать' }
    ],
    submitText: 'Установить',
    danger: true,
    onSubmit: async d => {
      const body = {
        module: 'mtproto',
        kind: v.kind,
        mtDomain: v.domain || 'ozon.ru',
        mtPort: v.port || '443',
        mtVersion: d.version || '',
        fixType: d.fixType || 'v3',
        fixPort: d.fixPort || '',
        noFix: v.kind === 'fix' ? false : !d.fix,
        adTag: d.adTag || '',
        mtUser: d.web ? '' : (d.mtUser || ''),
        mtUserSecret: d.web ? '' : (d.mtUserSecret || ''),
        publicHost: d.publicHost || '',
        web: v.kind === 'telemt' && !!d.web,
        webHost: v.kind === 'telemt' ? (d.webHost || '') : '',
        webUser: d.webUser || 'webuser',
        webSecret: d.webSecret || '',
        nginx: true
      };
      const r = await api('/api/install/module', { method: 'POST', body });
      showCarbonTextModal('Установка ' + label, r.logFile ? 'Запущено. Журнал: ' + r.logFile : 'Установка запущена');
      await carbonRefresh('Установка прокси запущена');
    }
  });
}

async function carbonProxyInstallMpl(v) {
  showCarbonForm({
    title: 'Установка MTProxyL',
    sub: 'Telemt + менеджер MTProxyL · порт ' + (v.port || '443'),
    fields: [
      { name: 'mplMode', label: 'Режим', type: 'select', options: [{ value: 'manager', label: 'Manager — новый прокси' }, { value: 'reanimator', label: 'Reanimator — реанимация' }] },
      { name: 'mplEngine', label: 'Движок', type: 'select', options: [{ value: 'binary', label: 'Бинарник (systemd)' }, { value: 'docker', label: 'Docker' }] },
      { name: 'mplProxyMode', label: 'Режим прокси', type: 'select', options: [{ value: 'mtproto', label: 'MTProto' }, { value: 'web', label: 'WEB' }, { value: 'combined', label: 'MTProto + WEB' }] },
      { name: 'mplPort', label: 'Порт', value: v.port || '443' },
      { name: 'mplSni', label: 'SNI', value: v.domain || 'autoscout24.ru' },
      { name: 'mplHost', label: 'Публичный адрес', placeholder: 'пусто — определить' },
      { name: 'mplZapret2', label: 'Zapret2 MTProto fix', type: 'checkbox', value: false },
      { name: 'mplSynLimiter', label: 'NFT SYN limiter', type: 'select', options: [{ value: 'meko', label: 'meko — рекомендуется' }, { value: 'classic', label: 'classic' }, { value: 'off', label: 'off' }] },
      { name: 'mplMeko', label: 'Обходы By-MEKO', type: 'checkbox', value: false },
      { name: 'mplUser', label: 'Первый пользователь', placeholder: 'необязательно' },
      { name: 'mplUserSecret', label: 'Секрет пользователя', placeholder: 'пусто — сгенерировать' },
      { name: 'mplSecret', label: 'Основной секрет', placeholder: '32 hex-символа' },
      { name: 'mplAdTag', label: 'ad_tag', placeholder: '32 hex-символа' },
      { name: 'mplSelfmask', label: 'Домен Selfmask', placeholder: 'пусто — не устанавливать' },
      { name: 'mplSelfmaskCert', label: 'Сертификат Selfmask', type: 'select', options: [{ value: 'letsencrypt', label: "Let's Encrypt" }, { value: 'selfsigned', label: 'Самоподписанный' }] },
      { name: 'mplSelfmaskEmail', label: "E-mail для Let's Encrypt", placeholder: 'admin@example.com' },
      { name: 'mplWeb', label: 'WEB Proxy', type: 'checkbox', value: false },
      { name: 'mplWebDomain', label: 'Домен WEB Proxy', placeholder: 'web.example.com' },
      { name: 'mplWebCarrier', label: 'Carrier', type: 'select', options: [{ value: 'https', label: 'https' }, { value: 'http', label: 'http' }] },
      { name: 'mplApi', label: 'API MTProxyL', type: 'checkbox', value: true },
      { name: 'mplApiListen', label: 'API listen', value: '127.0.0.1:9190' },
      { name: 'mplTgbotToken', label: 'Telegram-бот: токен', placeholder: 'необязательно' },
      { name: 'mplTgbotAdmin', label: 'Telegram-бот: admin ID', placeholder: 'необязательно' },
      { name: 'mplForce', label: 'Переустановить принудительно', type: 'checkbox', value: false }
    ],
    submitText: 'Установить MTProxyL',
    danger: true,
    onSubmit: async d => {
      const body = {
        module: 'mtproxyl',
        mplMode: d.mplMode || 'manager',
        mplEngine: d.mplEngine || 'binary',
        mplProxyMode: d.mplProxyMode || 'mtproto',
        mplPort: d.mplPort || '443',
        mplSni: d.mplSni || 'autoscout24.ru',
        mplHost: d.mplHost || '',
        mplZapret2: !!d.mplZapret2,
        mplSynLimiter: d.mplSynLimiter || 'meko',
        mplMeko: !!d.mplMeko,
        mplUser: d.mplUser || '',
        mplUserSecret: d.mplUserSecret || '',
        mplSecret: d.mplSecret || '',
        mplAdTag: d.mplAdTag || '',
        mplSelfmask: d.mplSelfmask || '',
        mplSelfmaskCert: d.mplSelfmaskCert || 'letsencrypt',
        mplSelfmaskEmail: d.mplSelfmaskEmail || '',
        mplWeb: !!d.mplWeb,
        mplWebDomain: d.mplWebDomain || '',
        mplWebCarrier: d.mplWebCarrier || 'https',
        mplApi: !!d.mplApi,
        mplApiListen: d.mplApiListen || '127.0.0.1:9190',
        mplTgbotToken: d.mplTgbotToken || '',
        mplTgbotAdmin: d.mplTgbotAdmin || '',
        mplForce: !!d.mplForce
      };
      const r = await api('/api/install/module', { method: 'POST', body });
      showCarbonTextModal('Установка MTProxyL', r.logFile ? 'Запущено. Журнал: ' + r.logFile : 'Установка запущена');
      await carbonRefresh('Установка MTProxyL запущена');
    }
  });
}

async function carbonMtproxylInstall() {
  showCarbonForm({
    title: 'Установка MTProxyL',
    sub: 'Движок Telemt и менеджер MTProxyL',
    fields: [
      { name: 'mplPort', label: 'Порт', value: '443' },
      { name: 'mplSni', label: 'SNI', value: 'autoscout24.ru' },
      { name: 'mplProxyMode', label: 'Режим', type: 'select', options: [{ value: 'mtproto', label: 'MTProto' }, { value: 'socks5', label: 'SOCKS5' }] },
      { name: 'mplAdTag', label: 'ad_tag', placeholder: 'Необязательно' },
      { name: 'mplApi', label: 'API менеджера', type: 'checkbox', value: true },
      { name: 'mplWeb', label: 'Web-интерфейс', type: 'checkbox', value: false },
      { name: 'mplForce', label: 'Переустановить принудительно', type: 'checkbox', value: false }
    ],
    submitText: 'Установить MTProxyL',
    danger: true,
    onSubmit: async v => {
      const body = {
        module: 'mtproxyl', mplMode: 'manager', mplEngine: 'binary', mplProxyMode: v.mplProxyMode,
        mplPort: v.mplPort, mplSni: v.mplSni, mplAdTag: v.mplAdTag, mplApi: !!v.mplApi,
        mplApiListen: '127.0.0.1:9190', mplWeb: !!v.mplWeb, mplForce: !!v.mplForce
      };
      const d = await api('/api/install/module', { method: 'POST', body });
      showCarbonTextModal('Установка MTProxyL', d.logFile ? 'Запущено. Журнал: ' + d.logFile : 'Установка запущена');
      await carbonRefresh();
    }
  });
}

async function carbonRestorePanel() {
  showCarbonForm({
    title: 'Восстановление панели',
    sub: 'Архив бэкапа панели',
    fields: [{ name: 'file', label: 'Файл .tar.gz', type: 'file', accept: '.tar.gz,.tgz,application/gzip' }],
    submitText: 'Восстановить',
    danger: true,
    onSubmit: async v => {
      if (!v.file) throw new Error('Выберите файл бэкапа');
      const data = await fileToBase64(v.file);
      await api('/api/restore', { method: 'POST', body: { fileData: data } });
      showToast('Восстановление запущено');
    }
  });
}

async function carbonCascadeRepair() {
  if (!confirm('Пересобрать каскад? Туннель awg1 перезапустится на несколько секунд.')) return;
  const d = await api('/api/cascade/repair', { method: 'POST', body: {} });
  await carbonRefresh('Каскад пересобран: ' + (d.endpoint || '—'));
}

async function carbonDiagTc() {
  const d = await api('/api/diag/tc');
  showCarbonTextModal('TCP-проверка', JSON.stringify(d, null, 2));
}

async function carbonDiagWan() {
  showToast('Проверка скорости WAN…');
  const d = await api('/api/diag/wan-speed');
  showCarbonTextModal('Скорость WAN', JSON.stringify(d, null, 2));
}

async function carbonChartRange(range) {
  carbon.chartRange = range;
  try { carbon.history = await api('/api/history?range=' + encodeURIComponent(range) + '&view=global'); }
  catch (e) { carbon.history = null; }
  render();
}

async function carbonCascadeListRefresh() {
  const d = await api('/api/cascade/refresh', { method: 'POST', body: {} });
  const count = Number(d && d.count) || 0;
  const added = Number(d && d.added) || 0;
  const removed = Number(d && d.removed) || 0;
  const zoneLines = Number(d && d.zoneLines) || 0;
  const lines = [
    count > 0 ? 'Список RU обновлён.' : 'Список RU не обновлён: в ipset ru 0 правил.',
    `Правил в списке сейчас: ${count}`,
    `Добавлено: ${added}`,
    removed > 0 ? `Удалено: ${removed}` : '',
    zoneLines > 0 ? `Строк в загруженном списке: ${zoneLines}` : ''
  ].filter(Boolean).join('\n');
  showCarbonTextModal(count > 0 ? 'Обновление списка RU' : 'Список RU не обновлён', lines);
  await carbonRefresh(`Список RU: ${count} правил (+${added})`);
}

async function carbonCascadeScheduleSave() {
  const sel = document.getElementById('carbonCascadeSchedule');
  const interval = sel ? sel.value : '5m';
  await api('/api/cascade/schedule', { method: 'POST', body: { interval } });
  await carbonRefresh('Расписание обновления списков сохранено');
}

async function carbonRuDropRefresh() {
  const box = document.getElementById('carbonGeoIfaces');
  const ifaces = box ? [...box.querySelectorAll('input[type=checkbox]:checked')].map(x => x.value) : [];
  if (!ifaces.length) throw new Error('Выберите хотя бы один интерфейс');
  const body = {
    enable: true,
    ifaces,
    schedule: document.getElementById('carbonGeoSchedule')?.value || 'weekly',
    listMode: document.getElementById('carbonGeoListMode')?.value || 'antifilter',
    customUrl: document.getElementById('carbonGeoCustomUrl')?.value.trim() || '',
    ports: document.getElementById('carbonGeoPorts')?.value.trim() || ''
  };
  const d = await api('/api/tools/rudrop', { method: 'POST', body });
  const count = Number(d && d.count) || 0;
  const added = Number(d && d.added) || 0;
  await carbonRefresh(`GeoIP: ${count} адресов (+${added})` + (d && d.warning ? '. ' + d.warning : ''));
}

let carbonBusyCount = 0;
function carbonBusyPill(show) {
  let el = document.getElementById('carbonBusyPill');
  if (!el) {
    el = document.createElement('div');
    el.id = 'carbonBusyPill';
    el.className = 'busy-pill';
    el.innerHTML = '<span class="busy-ring"></span><span>Применение…</span>';
    document.body.appendChild(el);
  }
  el.classList.toggle('show', show);
}

function carbonBusyStart(btn) {
  if (!btn || btn.dataset.carbonBusy === '1') return () => {};
  btn.dataset.carbonBusy = '1';
  btn.classList.add('is-busy');
  btn.setAttribute('aria-busy', 'true');
  carbonBusyCount++;
  carbonBusyPill(true);
  return () => {
    btn.dataset.carbonBusy = '';
    btn.classList.remove('is-busy');
    btn.removeAttribute('aria-busy');
    carbonBusyCount = Math.max(0, carbonBusyCount - 1);
    if (!carbonBusyCount) carbonBusyPill(false);
  };
}

function carbonActionName(btn) { return btn && btn.dataset ? btn.dataset.carbonAction : ''; }

document.addEventListener('click', async event => {
  const btn = event.target.closest('[data-carbon-action]');
  if (!btn) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const action = carbonActionName(btn);
  const name = btn.dataset.name || '';
  const finishBusy = carbonBusyStart(btn);
  try {
    if (action === 'update-check') await carbonUpdateCheck();
    else if (action === 'update-git') { if (confirm('Обновить панель с GitHub? Перед обновлением создаётся бэкап.')) { await api('/api/update/git', { method: 'POST', body: {} }); pollUpdate(); } }
    else if (action === 'update-git-force') { if (confirm('Сбросить локальные изменения кода и обновить с GitHub?')) { await api('/api/update/git-force', { method: 'POST', body: {} }); pollUpdate(); } }
    else if (action === 'update-url') await carbonUpdateFromUrl();
    else if (action === 'update-upload') {
      const input = document.getElementById('carbonUpdateFile');
      await carbonUpdateUpload(input && input.files && input.files[0]);
    }
    else if (action === 'update-rollback') await carbonUpdateRollback();
    else if (action === 'ssl-deps') await carbonSslDeps();
    else if (action === 'ssl-bind') await carbonSslSite('panel');
    else if (action === 'ssl-site') await carbonSslSite('site');
    else if (action === 'ssl-renew') await carbonSslRenew(name, btn.dataset.days == null ? null : Number(btn.dataset.days));
    else if (action === 'ssl-delete') await carbonSslDelete(name);
    else if (action === 'user-add') await carbonUserAdd();
    else if (action === 'user-delete') { if (confirm('Удалить пользователя ' + name + '?')) { await api('/api/users/' + encodeURIComponent(name), { method: 'DELETE' }); await carbonRefresh('Пользователь удалён'); } }
    else if (action === '2fa-setup') await carbon2faSetup();
    else if (action === '2fa-disable') await carbon2faDisable();
    else if (action === 'backup-save') await carbonBackupSave();
    else if (action === 'backup-run') { if (confirm('Создать резервную копию сейчас?')) { await api('/api/backup/run', { method: 'POST' }); await carbonRefresh('Бэкап создаётся'); } }
    else if (action === 'backup-password') await carbonBackupPassword();
    else if (action === 'notify-save') await carbonNotifySave();
    else if (action === 'notify-test') { await api('/api/notify/test', { method: 'POST' }); showToast('Тестовое сообщение отправлено'); }
    else if (action === 'client-key') await carbonClientKey(name);
    else if (action === 'client-sort') carbonClientSort(btn.dataset.key || 'name');
    else if (action === 'client-url') await carbonClientUrl(name);
    else if (action === 'client-rename') await carbonClientRename(name);
    else if (action === 'client-bulk-rename') await carbonClientBulkRename();
    else if (action === 'client-delete') { if (confirm('Удалить клиента ' + name + '?')) { await api('/api/delete/' + encodeURIComponent(name), { method: 'DELETE' }); await carbonRefresh('Клиент удалён'); } }
    else if (action === 'proxy-user-add') carbonProxyUserForm(null);
    else if (action === 'proxy-user-edit') carbonProxyUserForm(name);
    else if (action === 'proxy-user-delete') { if (confirm('Удалить пользователя ' + name + '?')) { await api('/api/proxy/users/' + encodeURIComponent(name), { method: 'DELETE' }); await carbonRefresh('Пользователь удалён'); } }
    else if (action === 'proxy-user-action') await carbonProxyUserAction(name, btn.dataset.act || '');
    else if (action === 'proxy-user-links') await carbonProxyLinks(name);
    else if (action === 'proxy-settings') await carbonProxySettings();
    else if (action === 'proxy-fix') await carbonProxyFix();
    else if (action === 'proxy-opt-apply') await carbonProxyOptimization('apply');
    else if (action === 'proxy-opt-rollback') await carbonProxyOptimization('rollback');
    else if (action === 'proxy-bot') await carbonProxyBot();
    else if (action === 'proxy-api-key') await carbonProxyApiKey();
    else if (action === 'proxy-bot-test') { await api('/api/proxy/bot/test', { method: 'POST', body: {} }); showToast('Тест отправлен'); }
    else if (action === 'proxy-diag') await carbonProxyDiag();
    else if (action === 'proxy-log') await carbonProxyLog();
    else if (action === 'ufw-add') await carbonUfwAdd();
    else if (action === 'ufw-delete') { if (confirm('Удалить правило №' + name + '?')) { await api('/api/ufw/' + encodeURIComponent(name), { method: 'DELETE' }); await carbonRefresh('Правило удалено'); } }
    else if (action === 'iptables-add') await carbonIptablesAdd();
    else if (action === 'iptables-delete') { if (confirm('Удалить правило iptables?')) { await api('/api/iptables/' + encodeURIComponent(name), { method: 'DELETE' }); await carbonRefresh('Правило iptables удалено'); } }
    else if (action === 'awg-edit') await carbonAwgEdit();
    else if (action === 'server-name') await carbonServerName();
    else if (action === 'proxy-install') await carbonProxyInstall();
    else if (action === 'install-mtproxyl' || action === 'mtproxyl-install') await carbonMtproxylInstall();
    else if (action === 'awg-install') await carbonAwgInstall();
    else if (action === 'cascade-build') await carbonCascadeBuild();
    else if (action === 'cascade-manual') await carbonCascadeManual();
    else if (action === 'cascade-ifaces-save') await carbonCascadeIfacesSave();
    else if (action === 'cascade-list-refresh') await carbonCascadeListRefresh();
    else if (action === 'cascade-schedule-save') await carbonCascadeScheduleSave();
    else if (action === 'cascade-repair') await carbonCascadeRepair();
    else if (action === 'cascade-proxy') await carbonCascadeProxy();
    else if (action === 'cascade-proxy-test') await carbonCascadeProxyTest();
    else if (action === 'cascade-cleanup') await carbonCascadeCleanup();
    else if (action === 'adguard-stats') await carbonAdguardStats();
    else if (action === 'adguard-config') await carbonAdguardConfig();
    else if (action === 'warp-panel') await carbonWarpPanel();
    else if (action === 'warp-services-save') await carbonWarpServicesSave();
    else if (action === 'warp-services-ai') carbonWarpServicesSelect('ai');
    else if (action === 'warp-services-none') carbonWarpServicesSelect('none');
    else if (action === 'dns-capture') await carbonDnsCapture();
    else if (action === 'app-metrics') await carbonAppMetrics();
    else if (action === 'app-metrics-token') await carbonAppMetricsToken();
    else if (action === 'rustdesk-settings') await carbonRustdeskSettings();
    else if (action === 'rustdesk-instructions') await carbonRustdeskInstructions();
    else if (action === 'rustdesk-refresh') await carbonRustdeskRefresh();
    else if (action === 'rustdesk-ports') { await api('/api/rustdesk/ports', { method: 'POST', body: {} }); await carbonRefresh('Порты RustDesk открыты'); }
    else if (action === 'rustdesk-job') await carbonRustdeskJob(btn.dataset.act || 'update');
    else if (action === 'fail2ban') await carbonFail2ban();
    else if (action === 'fail2ban-refresh') await carbonFail2banRefresh();
    else if (action === 'fail2ban-unban') await carbonFail2banUnban(name);
    else if (action === 'diag-check') await carbonDiagCheck();
    else if (action === 'diag-tc') await carbonDiagTc();
    else if (action === 'diag-wan') await carbonDiagWan();
    else if (action === 'chart-range') await carbonChartRange(btn.dataset.range || '1h');
    else if (action === 'timezone') openDashboardTimezone();
    else if (action === 'keenetic-add') keeneticAdd();
    else if (action === 'keenetic-open') keeneticOpen(btn.dataset.id);
    else if (action === 'keenetic-back') keeneticBack();
    else if (action === 'keenetic-detail-tab') keeneticDetailTab(btn.dataset.tab);
    else if (action === 'keenetic-test') await keeneticTest(btn.dataset.id);
    else if (action === 'keenetic-edit') keeneticEdit(btn.dataset.id);
    else if (action === 'keenetic-delete') await keeneticDelete(btn.dataset.id);
    else if (action === 'keenetic-tunnel-toggle') await keeneticTunnelToggle(btn.dataset.id, btn.dataset.name, btn.dataset.up === '1', btn);
    else if (action === 'keenetic-tunnel-restart') await keeneticTunnelRestart(btn.dataset.id, btn.dataset.name);
    else if (action === 'keenetic-refresh') await keeneticLoad('Обновлено');
    else if (action === 'obf-generate') await carbonObfGenerate();
    else if (action === 'obf-import') await carbonObfImport();
    else if (action === 'obf-sync') await carbonObfSync();
    else if (action === 'restore-panel') await carbonRestorePanel();
    else if (action === 'rudrop-upload') await carbonRuDropUpload();
    else if (action === 'rudrop-refresh') await carbonRuDropRefresh();
  } catch (e) {
    showToast(e.message || 'Ошибка');
  } finally {
    finishBusy();
  }
}, true);
