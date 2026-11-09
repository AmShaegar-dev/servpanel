'use strict';

const state = {
  tab: 'dashboard',
  donutRole: 'ru',
  theme: localStorage.getItem('sp-theme') || 'dark',
  module: null,
  textKind: 'obf',
  pageSettingsTab: null,
  warpVariant: '2',
  deleteMessage: '',
  advanced: {}
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const icon = (name, cls = 'ico') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const tag = (text, tone = '') => `<span class="tag ${tone}">${text}</span>`;
const dotTag = (text, tone = 'good') => `<span class="tag ${tone}"><span class="dot"></span>${text}</span>`;
const btn = (label, attrs = '', variant = '') => `<button class="btn ${variant}" ${attrs}>${label}</button>`;
const btnIcon = (iconName, label, attrs = '', variant = '') => `<button class="btn ${variant}" ${attrs}>${icon(iconName)}${label}</button>`;
const card = (title, sub, body, actions = '') => `<section class="card"><div class="card-top"><div><div class="card-title">${title}</div><div class="card-sub">${sub}</div></div><div class="page-actions">${actions}</div></div>${body}</section>`;
const mini = (label, value, note = '') => `<div class="mini-card"><div class="mini-label">${label}</div><div class="mini-value">${value}</div>${note ? `<div class="mini-note">${note}</div>` : ''}</div>`;
const kpi = (label, value, foot, iconName, tone = '', bar = 0, barColor = '') => `
  <section class="card kpi">
    <div class="row"><div><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div></div><div class="kpi-ico ${tone}">${icon(iconName)}</div></div>
    <div class="kpi-foot">${foot}</div>
    <div class="bar" style="width:100%"><span style="width:${bar}%${barColor ? `;background:${barColor}` : ''}"></span></div>
  </section>`;

const fInput = (label, value = '', attrs = '') => `<label class="field"><span>${label}</span><input value="${value}" ${attrs}></label>`;
const fSelect = (label, options, selected = '') => `<label class="field"><span>${label}</span><select>${options.map(o => `<option ${o === selected ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
const fSwitch = (label, checked = true, on = 'Включено', off = 'Выключено') => `<label class="switch"><input type="checkbox" ${checked ? 'checked' : ''} data-switch data-on="${on}" data-off="${off}"> ${label}</label>`;
const fTextarea = (id, value = '', placeholder = '', rows = 9) => `<textarea id="${id}" rows="${rows}" spellcheck="false" placeholder="${placeholder}">${value}</textarea>`;
const keyBtn = (moduleId, title = 'Параметры') => `<button class="row-action" data-action="module-settings" data-module="${moduleId}" title="${title}" aria-label="${title}">${icon('wrench')}</button>`;

function obfTextPreset() {
  return `# AmneziaWG 3.1 · сервер + клиент
[Interface]
PrivateKey = <server-private-key>
Address = 10.8.0.1/24
ListenPort = 443
MTU = 1200
Jc = 6
Jmin = 438
Jmax = 819
S1 = 63
S2 = 56
S3 = 12
S4 = 18
H1 = 289984443-289986940
H2 = 1033659598-1033704092
H3 = 1420899694-1420909833
H4 = 1812870534-1812872846
HeaderProtectionKey = CNzA/T2v5eDRykrRpCo6cx7mg+V1RRZyyQXjBC1O9UA=
RekeyAfterTime = 102-114
KeepaliveTimeout = 12-14
I1 = <b 0xc000000001089b9151cd><rc 15><t><r 117>
I2 = <rc 16><b 0x7ebe><t><r 103><rd 3>
I3 = <rc 11><b 0xd05909a183><t><r 45><rd 8>
I4 = <rc 15><b 0xf4ba118f><t><r 51><rd 5>`;
}

function awgServerTextPreset() {
  return `[Interface]
Address = 10.8.0.1/24
ListenPort = 443
PrivateKey = <server-private-key>
MTU = 1200
Jc = 6
Jmin = 438
Jmax = 819
S1 = 63
S2 = 56
S3 = 12
S4 = 18
H1 = 289984443-289986940
H2 = 1033659598-1033704092
H3 = 1420899694-1420909833
H4 = 1812870534-1812872846
HeaderProtectionKey = CNzA/T2v5eDRykrRpCo6cx7mg+V1RRZyyQXjBC1O9UA=
I1 = <b 0xc000000001089b9151cd><rc 15><t><r 117>
I2 = <rc 16><b 0x7ebe><t><r 103><rd 3>

[Peer]
# client-01
PublicKey = <client-public-key>
AllowedIPs = 10.8.1.2/32`;
}

function cascadeTextPreset() {
  return `[Interface]
PrivateKey = <eu-client-private-key>
Address = 172.16.61.2/24
DNS = 1.1.1.1
MTU = 1200
Jc = 6
Jmin = 438
Jmax = 819
S1 = 63
S2 = 56
S3 = 12
S4 = 18
H1 = 289984443-289986940
H2 = 1033659598-1033704092
H3 = 1420899694-1420909833
H4 = 1812870534-1812872846
HeaderProtectionKey = CNzA/T2v5eDRykrRpCo6cx7mg+V1RRZyyQXjBC1O9UA=
I1 = <b 0xc000000001089b9151cd><rc 15><t><r 117>

[Peer]
PublicKey = <eu-server-public-key>
Endpoint = 203.0.113.10:51820
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25`;
}

const TEXT_PRESETS = {
  obf: obfTextPreset,
  'client-obf': obfTextPreset,
  awg: awgServerTextPreset,
  cascade: cascadeTextPreset,
  adguard: () => `curl -fsSL https://raw.githubusercontent.com/AmShaegar-dev/servpanel/main/install_adguard_silent.sh | sudo env ADGUARD_PORT=3001 PANEL_PORT=3000 bash`,
  telemt: () => `tg://proxy?server=203.0.113.10&port=443&secret=ee...`,
  mtproxyl: () => `# MTProxyL · API
API_LISTEN = 127.0.0.1:9190
PROXY_PORT = 443
PROXY_MODE = mtproto
SNI = autoscout24.ru
ZAPRET2 = 1
SYN_LIMITER = meko`
};

const WARP_SERVICES = [
  ['google', 'Google / YouTube / Play', 'direct'],
  ['gemini', 'Gemini / Google AI', 'direct'],
  ['chatgpt', 'ChatGPT / OpenAI', 'warp'],
  ['claude', 'Claude / Anthropic', 'warp'],
  ['grok', 'Grok / xAI', 'warp'],
  ['copilot', 'Copilot / Microsoft', 'warp'],
  ['githubcopilot', 'GitHub Copilot', 'warp'],
  ['elevenlabs', 'ElevenLabs', 'warp'],
  ['codeium', 'Codeium / Windsurf', 'warp'],
  ['deepl', 'DeepL', 'warp'],
  ['trae', 'Trae', 'warp'],
  ['jetbrains', 'JetBrains AI', 'warp'],
  ['deepseek', 'DeepSeek', 'warp'],
  ['perplexity', 'Perplexity', 'warp']
];
const WARP_DEFAULTS = Object.fromEntries(WARP_SERVICES.map(([id, , dir]) => [id, dir]));
const routeRow = ([id, label, dir]) => `<div class="route-row"><div class="route-name">${label}</div><label class="route-check"><input type="checkbox" data-route="${id}:direct" ${dir === 'direct' ? 'checked' : ''}><span>напрямую</span></label><label class="route-check"><input type="checkbox" data-route="${id}:warp" ${dir === 'warp' ? 'checked' : ''}><span>через WARP</span></label></div>`;

const MODULE_DEFS = {
  awg: {
    title: 'AmneziaWG',
    sub: 'Установка, каскад и обфускация сервера',
    body: () => `
      <div class="form-grid">
        ${fSelect('Режим установки', ['Обычная (один сервер)', 'Каскад RU → EU'])}
        ${fSelect('Роль этой панели', ['RU-вход', 'EU-выход'])}
        ${fInput('IP второго сервера', '198.51.100.20')}
        ${fInput('SSH-порт', '22', 'type="number"')}
        ${fInput('Root-пароль', '', 'type="password" placeholder="Нужен только для SSH" style="grid-column:span 2"')}
        ${fSelect('Версия протокола', ['3.1 — рекомендуется', '2.0 — стабильность', '1.5 — старые клиенты'])}
        ${fInput('UDP-порт', '443', 'type="number"')}
        ${fSelect('Маршрутизация', ['Весь трафик', 'Amnezia + DNS', 'Свой список'])}
        ${fInput('Свой список CIDR', '', 'placeholder="192.168.1.0/24, 10.50.0.0/16" style="grid-column:span 2"')}
        ${fSelect('IPv6', ['Отключить', 'Разрешить', 'Dual-stack ULA'])}
        ${fInput('Домен для подключения', 'vpn.example.com')}
        ${fInput('MTU', '1200')}
        ${fSelect('Профиль обфускации', ['balanced', 'compat', 'max'])}
      </div>
      <div class="switch-grid">
        ${fSwitch('Изолировать клиентов друг от друга', true, 'Изоляция включена', 'Изоляция выключена')}
        ${fSwitch('Сохранить системные пакеты', true, 'Пакеты сохраняются', 'Пакеты не сохраняются')}
        ${fSwitch('Без UFW, Fail2Ban и оптимизаций', false, 'Твики отключены', 'Твики включены')}
      </div>
      <div class="page-actions" style="margin-top:16px">
        <button class="btn btn-primary" data-action="module-install" data-module="awg">${icon('download')}Установить</button>
        <button class="btn" data-action="open-text-modal" data-text="awg">${icon('upload')}Вставить .conf</button>
        <button class="btn" data-action="copy-text-preset" data-text="awg">${icon('copy')}Скопировать .conf</button>
      </div>`
  },
  adguard: {
    title: 'AdGuard Home',
    sub: 'DNS-фильтр · порт 3001, потому что 3000 занят панелью',
    body: () => `
      <div class="notice warn"><b>Автоматическая установка в разработке.</b> Пока доступна ручная установка одной командой. Порт веб-интерфейса — 3001.</div>
      <div class="form-grid">
        ${fInput('Веб-порт AdGuard', '3001', 'type="number"')}
        ${fInput('DNS-порт', '53', 'type="number"')}
        ${fInput('Bootstrap DNS', '9.9.9.10, 1.1.1.1')}
        ${fInput('Кэш', '4 MB')}
        ${fSelect('Режим блокировки', ['NXDOMAIN', 'REFUSED', '0.0.0.0'])}
        ${fSelect('Обновление фильтров', ['каждые 24 часа', 'каждую неделю', 'вручную'])}
        ${fInput('Upstream 1', 'https://dns.quad9.net/dns-query')}
        ${fInput('Upstream 2', 'https://dns.google/dns-query')}
      </div>
      <div class="switch-grid">
        ${fSwitch('Защита DNS', true, 'Защита включена', 'Защита выключена')}
        ${fSwitch('Журнал запросов', true, 'Журнал включён', 'Журнал выключен')}
        ${fSwitch('Автообновление списков', true, 'Автообновление включено', 'Автообновление выключено')}
      </div>
      <div class="code" style="margin-top:14px"><div class="code-head"><span>Ручная установка · 3001</span><button class="copy" data-copy="curl -fsSL https://raw.githubusercontent.com/AmShaegar-dev/servpanel/main/install_adguard_silent.sh | sudo env ADGUARD_PORT=3001 PANEL_PORT=3000 bash">Копировать</button></div><pre>curl -fsSL https://raw.githubusercontent.com/AmShaegar-dev/servpanel/main/install_adguard_silent.sh | sudo env ADGUARD_PORT=3001 PANEL_PORT=3000 bash</pre></div>
      <div class="page-actions" style="margin-top:16px">
        <button class="btn btn-primary" data-action="module-install" data-module="adguard">${icon('download')}Установить на 3001</button>
        <button class="btn" data-action="open-text-modal" data-text="adguard">${icon('upload')}Вставить текстом</button>
        <button class="btn" data-toast="Открываю http://IP:3001">${icon('external')}Открыть 3001</button>
      </div>`
  },
  warp: {
    title: 'WARP + Xray',
    sub: 'Выход Cloudflare и маршрутизация Xray',
    body: () => `
      <div class="variant-grid" style="margin-bottom:14px">
        <div class="variant-card ${state.warpVariant === '1' ? 'active' : ''}"><b>Вариант 1</b><small>Первая инструкция · весь трафик через WARP</small><span>WARP + Xray ставятся с нуля. Xray слушает 0.0.0.0:443, весь трафик идёт в WARP через SOCKS 127.0.0.1:40000.</span><button class="btn btn-sm ${state.warpVariant === '1' ? 'btn-primary' : ''}" data-action="warp-variant" data-variant="1">${state.warpVariant === '1' ? 'Выбран' : 'Выбрать вариант 1'}</button></div>
        <div class="variant-card ${state.warpVariant === '2' ? 'active' : ''}"><b>Вариант 2</b><small>Вторая инструкция · Google/Gemini direct, AI через WARP</small><span>Google/Gemini и остальное — напрямую, выбранные AI-сервисы — через WARP. Маршруты Xray по SNI.</span><button class="btn btn-sm ${state.warpVariant === '2' ? 'btn-primary' : ''}" data-action="warp-variant" data-variant="2">${state.warpVariant === '2' ? 'Выбран' : 'Выбрать вариант 2'}</button></div>
      </div>
      <div class="form-grid">
        ${fInput('Адрес прослушивания Xray', '0.0.0.0')}
        ${fInput('Порт Xray', '443', 'type="number"')}
        ${fInput('SOCKS5 WARP', '40000', 'type="number"')}
      </div>
      ${state.warpVariant === '2' ? `
      <div class="route-head"><div><b>Куда направлять</b><span>Галочки по умолчанию — как во второй инструкции</span></div><div class="page-actions"><button class="btn btn-sm" data-action="warp-routes" data-preset="default">По инструкции</button><button class="btn btn-sm" data-action="warp-routes" data-preset="ai-warp">Все AI → WARP</button><button class="btn btn-sm" data-action="warp-routes" data-preset="ai-direct">Все AI → напрямую</button></div></div>
      <div class="route-table">
        <div class="route-row route-head-row"><div class="route-name">Сервис</div><div class="route-col">Напрямую</div><div class="route-col">Через WARP</div></div>
        ${WARP_SERVICES.map(routeRow).join('')}
        <div class="route-row"><div class="route-name">Всё остальное</div><div class="route-col"><span class="tag good">direct</span></div><div class="route-col"><span class="tag">—</span></div></div>
      </div>` : `<div class="notice">Вариант 1: весь трафик Xray идёт в WARP. Отдельные маршруты не используются — как в первой инструкции.</div>`}
      <div class="list" style="margin-top:14px"><div class="list-row"><b>WARP</b><span class="mono">104.28.211.192 · Paris</span></div><div class="list-row"><b>Xray</b><span class="mono">0.0.0.0:443</span></div><div class="list-row"><b>SOCKS5</b><span class="mono">127.0.0.1:40000</span></div><div class="list-row"><b>Маршрутизация</b><span class="mono">${state.warpVariant === '1' ? 'весь трафик через WARP' : 'Google/Gemini direct · AI warp · остальное direct'}</span></div></div>
      <div class="page-actions" style="margin-top:16px">
        <button class="btn btn-primary" data-action="module-install" data-module="warp">${icon('download')}Установить вариант ${state.warpVariant}</button>
        <button class="btn" data-toast="Проверка WARP запущена">${icon('pulse')}Проверить</button>
        <button class="btn" data-toast="Правила AdGuard — в «Инструкции»">${icon('link')}Правила AdGuard</button>
        <button class="btn btn-danger" data-toast="Удаление WARP — подтверждение в реальной панели">${icon('trash')}Удалить</button>
      </div>`
  },
  telemt: {
    title: 'MTProto / Telemt',
    sub: 'Telemt, MTProto.zig или фикс MEKO',
    body: () => `
      <div class="form-grid">
        ${fSelect('Что устанавливаем', ['Telemt', 'MTProto.zig', 'Только фикс MEKO'])}
        ${fInput('SNI-домен маскировки', 'ozon.ru')}
        ${fInput('Порт прокси', '443', 'type="number"')}
        ${fInput('Версия Telemt', '', 'placeholder="Пусто — последняя"')}
        ${fInput('ad_tag', '', 'placeholder="32 hex-символа"')}
        ${fInput('Пользователь', '', 'placeholder="например vasya"')}
        ${fInput('Секрет пользователя', '', 'placeholder="Пусто — сгенерировать"')}
        ${fInput('public_host', '', 'placeholder="my.domain.com"')}
        ${fSelect('Тип фикса MEKO', ['v3 — u32', 'v2 — TTL + Length', 'v4 — zapret2', 'nft — Docker'])}
        ${fInput('Порт фикса', '', 'placeholder="Как у прокси"')}
      </div>
      <div class="switch-grid">
        ${fSwitch('Установить фикс MEKO', true, 'Фикс включён', 'Фикс выключен')}
        ${fSwitch('WEB-режим (домен + Nginx)', false, 'WEB-режим включён', 'WEB-режим выключен')}
        ${fSwitch('Nginx + Certbot', true, 'SSL выпускается', 'SSL не выпускается')}
      </div>
      <div class="page-actions" style="margin-top:16px">
        <button class="btn btn-primary" data-action="module-install" data-module="telemt">${icon('download')}Установить</button>
        <button class="btn" data-action="open-text-modal" data-text="telemt">${icon('upload')}Вставить ссылку</button>
        <button class="btn" data-action="copy-text-preset" data-text="telemt">${icon('copy')}Скопировать tg://</button>
      </div>`
  },
  mtproxyl: {
    title: 'MTProxyL',
    sub: 'Менеджер, API, лимиты и Telegram-бот',
    body: () => `
      <div class="form-grid">
        ${fSelect('Режим MTProxyL', ['Manager — новый прокси', 'Reanimator — реанимация'])}
        ${fSelect('Движок telemt', ['Бинарник (systemd)', 'Docker'])}
        ${fSelect('Режим прокси', ['MTProto', 'WEB', 'MTProto + WEB'])}
        ${fInput('Порт прокси', '443', 'type="number"')}
        ${fInput('SNI-домен', 'autoscout24.ru')}
        ${fInput('Публичный адрес', '', 'placeholder="Пусто — определить"')}
        ${fInput('Первый пользователь', '', 'placeholder="например vasya"')}
        ${fInput('Секрет пользователя', '', 'placeholder="Пусто — сгенерировать"')}
        ${fInput('Основной секрет', '', 'placeholder="32 hex-символа"')}
        ${fInput('ad_tag', '', 'placeholder="32 hex-символа"')}
        ${fInput('Домен Selfmask', '', 'placeholder="Пусто — не ставить"')}
        ${fSelect('Сертификат Selfmask', ["Let's Encrypt", 'Самоподписанный'])}
        ${fInput('E-mail для Let\'s Encrypt', '', 'placeholder="admin@example.com"')}
        ${fInput('Домен WEB Proxy', '', 'placeholder="web.example.com"')}
        ${fInput('API listen', '127.0.0.1:9190')}
        ${fInput('Токен бота MTProxyL', '', 'placeholder="Необязательно" autocomplete="off"')}
        ${fInput('Telegram ID администратора', '', 'placeholder="Только с токеном"')}
      </div>
      <div class="switch-grid">
        ${fSwitch('Zapret2 MTProto fix', true, 'Zapret2 включён', 'Zapret2 выключен')}
        ${fSwitch('Обходы By-MEKO', true, 'Обходы включены', 'Обходы выключены')}
        ${fSwitch('WEB Proxy', false, 'WEB Proxy включён', 'WEB Proxy выключен')}
        ${fSwitch('API управления', true, 'API включён', 'API выключен')}
        ${fSwitch('Переустановить поверх (--force)', false, 'Переустановка включена', 'Переустановка выключена')}
      </div>
      <div class="page-actions" style="margin-top:16px">
        <button class="btn btn-primary" data-action="module-install" data-module="mtproxyl">${icon('download')}Установить</button>
        <button class="btn" data-action="open-text-modal" data-text="mtproxyl">${icon('upload')}Вставить текстом</button>
        <button class="btn" data-toast="Пользователи и лимиты — во вкладке «Прокси»">${icon('users')}Пользователи</button>
      </div>`
  },
  rustdesk: {
    title: 'RustDesk',
    sub: 'Собственный relay-сервер hbbs + hbbr',
    body: () => `
      <div class="form-grid">
        ${fInput('Relay host', '203.0.113.10')}
        ${fInput('Порт relay', '21117', 'type="number"')}
        ${fInput('API-порт', '21114', 'type="number"')}
        ${fInput('Диапазон портов', '21115-21119')}
        ${fInput('Public key', 'q2f3…9ab1')}
        ${fInput('Домен', '', 'placeholder="rd.example.com"')}
      </div>
      <div class="switch-grid">
        ${fSwitch('Автозапуск hbbs / hbbr', true, 'Автозапуск включён', 'Автозапуск выключен')}
        ${fSwitch('Открыть порты в UFW', true, 'Порты открыты', 'Порты закрыты')}
      </div>
      <div class="page-actions" style="margin-top:16px">
        <button class="btn btn-primary" data-action="module-install" data-module="rustdesk">${icon('download')}Установить</button>
        <button class="btn" data-toast="Ключ скопирован">${icon('copy')}Скопировать ключ</button>
        <button class="btn" data-toast="RustDesk перезапущен">${icon('refresh')}Перезапустить</button>
      </div>`
  }
};

const settingsSection = (title, body, note = '') => `<div class="settings-section"><div class="settings-section-title">${title}</div>${body}${note ? `<div class="donut-note">${note}</div>` : ''}</div>`;

const PAGE_SETTINGS = {
  dashboard: { title: 'Настройки дашборда', sub: 'Период, обновление и состав карточек', body: () => `
    ${settingsSection('Отображение', `<div class="form-grid">${fSelect('Период по умолчанию', ['1 час', '24 часа', '7 дней'])}${fSelect('Обновление', ['15 секунд', '30 секунд', '1 минута', 'вручную'])}${fSelect('Часовой пояс', ['Europe/Moscow', 'Europe/Paris', 'UTC'])}${fSelect('Плотность', ['Обычная', 'Компактная'])}</div>`)}
    ${settingsSection('Карточки', `<div class="switch-grid">${fSwitch('Показывать GeoIP-блокировки', true, 'GeoIP показан', 'GeoIP скрыт')}${fSwitch('Показывать события', true, 'События показаны', 'События скрыты')}${fSwitch('Показывать быстрые действия', true, 'Действия показаны', 'Действия скрыты')}${fSwitch('Анимация графиков', true, 'Анимация включена', 'Анимация выключена')}</div>`)}` },
  clients: { title: 'Настройки клиентов', sub: 'Лимиты, выдача и массовые операции', body: () => `
    ${settingsSection('По умолчанию', `<div class="form-grid">${fInput('Срок, дней', '30')}${fInput('Лимит соединений', '8')}${fInput('Квота, ГБ', '50')}${fInput('Количество клиентов', '1')}${fSelect('Endpoint в конфиге', ['IP сервера', 'Домен'])}${fInput('Домен для конфигов', '', 'placeholder="vpn.example.com"')}${fSelect('Тип устройства', ['Телефон', 'Ноутбук', 'Роутер'])}${fSelect('Протокол', ['AmneziaWG 3.1', 'AmneziaWG 2.0', 'AmneziaWG 1.5'])}</div>`)}
    ${settingsSection('Массовые операции', `<div class="form-grid">${fInput('Префикс имён', 'client-')}${fInput('Начать с', '1', 'type="number"')}${fInput('Имя сервера', 'RU → EU · основной узел')}${fSelect('Формат экспорта', ['.conf', 'JSON', 'vpn://', 'QR'])}</div>`)}
    ${settingsSection('Поведение', `<div class="switch-grid">${fSwitch('Автоблокировка при превышении квоты', true, 'Автоблокировка включена', 'Автоблокировка выключена')}${fSwitch('Показывать QR сразу', true, 'QR показывается', 'QR скрыт')}${fSwitch('Разрешить несколько устройств', true, 'Несколько устройств', 'Одно устройство')}</div>`)}` },
  install: { title: 'Настройки установки', sub: 'Канал, журнал, порты и поведение установщика', body: () => `
    ${settingsSection('Общие', `<div class="form-grid">${fSelect('Канал', ['stable', 'latest', 'beta'])}${fInput('Порт панели', '3000')}${fInput('Порт AdGuard', '3001')}${fInput('Строк журнала', '300')}${fSelect('Параллельные установки', ['Запрещены', 'Разрешены'])}${fSelect('Автоперезапуск после установки', ['Да', 'Нет'])}${fSelect('Открывать UFW', ['Автоматически', 'Вручную'])}${fSelect('Проверка портов', ['Перед установкой', 'После установки'])}</div>`)}
    ${settingsSection('Поведение', `<div class="switch-grid">${fSwitch('Автообновление модулей', true, 'Автообновление включено', 'Автообновление выключено')}${fSwitch('Сохранять логи установки', true, 'Логи сохраняются', 'Логи не сохраняются')}${fSwitch('Открывать UFW автоматически', true, 'Порты открываются', 'Порты не открываются')}${fSwitch('Проверять конфликты портов', true, 'Проверка включена', 'Проверка выключена')}</div>`, 'Установщик AdGuard по умолчанию берёт 3001, потому что 3000 занят панелью.')}` },
  network: { title: 'Настройки сети', sub: 'Интерфейсы, UFW и обфускация клиентов', body: () => `
    ${settingsSection('Интерфейсы', `<div class="form-grid">${fInput('MTU по умолчанию', '1200')}${fInput('MSS clamp', '1160')}${fInput('DNS для клиентов', '1.1.1.1')}${fInput('Путь к awg0.conf', '/etc/amnezia/amneziawg/awg0.conf')}${fInput('Путь к awg-eu.conf', '/etc/amnezia/amneziawg/awg-eu.conf')}${fSelect('IPv6', ['Отключить', 'Разрешить', 'Dual-stack ULA'])}</div>`)}
    ${settingsSection('UFW', `<div class="form-grid">${fSelect('Политика UFW', ['deny incoming', 'allow incoming', 'выключен'])}${fSelect('Протокол по умолчанию', ['tcp', 'udp', 'tcp/udp'])}${fSelect('Интерфейс по умолчанию', ['Все', 'awg0', 'awg1', 'ens3'])}${fSelect('Автооткрытие портов', ['Включено', 'Выключено'])}</div>`)}
    ${settingsSection('Обфускация клиентов', `<div class="form-grid">${fSelect('Применить к', ['Все клиенты', 'client-01', 'client-02', 'client-03', 'client-04'])}${fSelect('Профиль', ['custom', 'balanced', 'compat', 'max'])}${fInput('H1', '289984443-289986940')}${fInput('H2', '1033659598-1033704092')}${fInput('H3', '1420899694-1420909833')}${fInput('H4', '1812870534-1812872846')}${fInput('S1', '63')}${fInput('S2', '56')}${fInput('S3', '12')}${fInput('S4', '18')}${fInput('Jc', '6')}${fInput('Jmin', '438')}${fInput('Jmax', '819')}${fInput('MTU', '1200')}${fInput('HeaderProtectionKey', 'CNzA/T2v5eDRykrRpCo6cx7mg+V1RRZyyQXjBC1O9UA=')}${fInput('RekeyAfterTime', '102-114')}${fInput('KeepaliveTimeout', '12-14')}${fInput('I1', '<b 0xc000000001089b9151cd><rc 15><t><r 117>')}${fInput('I2', '<rc 16><b 0x7ebe><t><r 103><rd 3>')}${fInput('I3', '<rc 11><b 0xd05909a183><t><r 45><rd 8>')}${fInput('I4', '<rc 15><b 0xf4ba118f><t><r 51><rd 5>')}</div>`)}
    ${settingsSection('Поведение', `<div class="switch-grid">${fSwitch('Изоляция клиентов', true, 'Изоляция включена', 'Изоляция выключена')}${fSwitch('Автоматически открывать порты', true, 'UFW обновляется', 'UFW не трогать')}${fSwitch('Пересобрать .conf клиентов после изменения', true, 'Конфиги пересоберутся', 'Конфиги не трогать')}${fSwitch('Синхронизировать server_hpk.key', true, 'HPK синхронизируется', 'HPK не трогать')}</div>`)}` },
  cascade: { title: 'Настройки каскада', sub: 'Роль, второй сервер, интерфейсы и MTProto', body: () => `
    ${settingsSection('Режим и роль', `<div class="form-grid">${fSelect('Что делаем', ['Установить с нуля', 'Настроить существующий туннель'])}${fSelect('Роль этой панели', ['RU-вход', 'EU-выход'])}</div>`)}
    ${settingsSection('Второй сервер', `<div class="form-grid">${fInput('IP удалённого сервера', '203.0.113.10')}${fInput('SSH-порт', '22', 'type="number"')}${fInput('Root-пароль', '', 'type="password" placeholder="Нужен для SSH"')}${fInput('Домен EU', 'panel.example.com')}</div>`, 'Пароль используется только для настройки и не сохраняется.')}
    ${settingsSection('Интерфейсы и маршрут', `<div class="form-grid">${fSelect('Входной интерфейс', ['awg0', 'ens3'])}${fSelect('Выходной интерфейс', ['awg1', 'ens3'])}${fInput('EU endpoint', '203.0.113.10:51820')}${fInput('MTU', '1200')}${fInput('MSS clamp', '1160')}${fInput('Таблица маршрутизации', '100')}${fInput('AllowedIPs → EU', '0.0.0.0/0, ::/0')}${fSelect('IPv6', ['Отключить', 'Разрешить', 'Dual-stack ULA'])}</div>`)}
    ${settingsSection('MTProto через EU', `<div class="form-grid">${fInput('middle_proxy_nat_ip', '203.0.113.10')}${fInput('DC 203', '91.105.192.0/23')}${fInput('MSS для MTProto', '1160')}${fSelect('Telemt / MTProxyL', ['Оба через EU', 'Только Telemt', 'Только MTProxyL', 'Напрямую'])}</div>`)}
    ${settingsSection('Проверки и защита', `<div class="form-grid">${fSelect('Интервал проверки', ['30 секунд', '1 минута', '5 минут'])}${fSelect('Проверка утечек', ['При старте', 'Каждый час', 'Вручную'])}</div><div class="switch-grid">${fSwitch('Kill switch', true, 'Kill switch включён', 'Kill switch выключен')}${fSwitch('Пускать Telemt и MTProxyL через EU', true, 'Прокси через EU', 'Прокси напрямую')}${fSwitch('Проверять утечки', true, 'Проверка включена', 'Проверка выключена')}${fSwitch('IPv6 в туннеле', false, 'IPv6 включён', 'IPv6 выключен')}</div>`)}` },
  obfuscation: { title: 'Настройки обфускации', sub: 'Профиль, ручные параметры и применение', body: () => `
    ${settingsSection('Профиль', `<div class="form-grid">${fSelect('Профиль по умолчанию', ['balanced', 'compat', 'max'])}${fInput('SNI для TLS-мимикрии', 'ozon.ru')}${fSelect('Автоповорот параметров', ['Выключен', 'Раз в 30 дней', 'Раз в 90 дней'])}${fSelect('Импорт', ['Автоопределение', '.conf', 'JSON', 'vpn://'])}${fSelect('Версия AWG', ['3.1', '2.0', '1.5'])}${fInput('MTU', '1200')}</div>`)}
    ${settingsSection('Ручные параметры', `<div class="form-grid">${fInput('H1', '289984443-289986940')}${fInput('H2', '1033659598-1033704092')}${fInput('H3', '1420899694-1420909833')}${fInput('H4', '1812870534-1812872846')}${fInput('S1', '63')}${fInput('S2', '56')}${fInput('S3', '12')}${fInput('S4', '18')}${fInput('Jc', '6')}${fInput('Jmin', '438')}${fInput('Jmax', '819')}${fInput('HeaderProtectionKey', 'CNzA/T2v5eDRykrRpCo6cx7mg+V1RRZyyQXjBC1O9UA=')}${fInput('RekeyAfterTime', '102-114')}${fInput('KeepaliveTimeout', '12-14')}${fInput('I1', '<b 0xc000000001089b9151cd><rc 15><t><r 117>')}${fInput('I2', '<rc 16><b 0x7ebe><t><r 103><rd 3>')}${fInput('I3', '<rc 11><b 0xd05909a183><t><r 45><rd 8>')}${fInput('I4', '<rc 15><b 0xf4ba118f><t><r 51><rd 5>')}</div>`)}
    ${settingsSection('Применение', `<div class="switch-grid">${fSwitch('Перегенерировать клиентов', true, 'Клиенты перегенерируются', 'Клиенты не трогаются')}${fSwitch('Удалять отсутствующие параметры', true, 'Удалять', 'Сохранять')}${fSwitch('Резервная копия перед применением', true, 'Бэкап включён', 'Бэкап выключен')}${fSwitch('Синхронизировать HPK', true, 'HPK синхронизируется', 'HPK не трогать')}</div>`)}` },
  proxy: { title: 'Настройки прокси', sub: 'Движок, Telegram-бот и оптимизация', body: () => `
    ${settingsSection('Движок', `<div class="form-grid">${fSelect('Движок', ['Telemt', 'MTProxyL', 'MTProto.zig'])}${fInput('Порт прокси', '443')}${fInput('SNI', 'vimeo.com')}${fInput('Публичный адрес', '', 'placeholder="Пусто — определить"')}${fInput('API MTProxyL', '127.0.0.1:9190')}${fSelect('Режим MTProxyL', ['Manager', 'Reanimator'])}${fSelect('Движок MTProxyL', ['Бинарник', 'Docker'])}${fSelect('Прокси-режим', ['MTProto', 'WEB', 'MTProto + WEB'])}</div>`)}
    ${settingsSection('Telegram-бот', `<div class="form-grid">${fInput('Токен бота', '', 'placeholder="123456789:AA…" autocomplete="off"')}${fInput('Chat ID / админ', '', 'placeholder="Определять по /start"')}${fSelect('Автоопределение админа', ['По первому /start', 'Вручную', 'Выключено'])}${fSelect('Права бота', ['Пользователи', 'Ссылки', 'Полный доступ'])}</div>`)}
    ${settingsSection('Оптимизация', `<div class="form-grid">${fInput('MTU awg0', '1200')}${fInput('MSS clamp', '1160')}${fInput('TCP keepalive', '25')}${fInput('Буфер, MB', '16')}${fInput('DNS для прокси', '1.1.1.1')}${fSelect('TCP Fast Open', ['Включён', 'Выключен'])}${fSelect('Тип фикса MEKO', ['v3', 'v2', 'v4', 'nft'])}${fInput('Порт фикса', '', 'placeholder="Как у прокси"')}${fInput('Макс. соединений', '8')}${fInput('Rate limit, conn/s', '20')}</div>`)}
    ${settingsSection('Поведение', `<div class="switch-grid">${fSwitch('Автоперезапуск при падении', true, 'Автоперезапуск включён', 'Автоперезапуск выключен')}${fSwitch('Автоопределение админа по /start', true, 'Автоопределение включено', 'Автоопределение выключено')}${fSwitch('Ротация ссылок', false, 'Ротация включена', 'Ротация выключена')}${fSwitch('Zapret2', true, 'Zapret2 включён', 'Zapret2 выключен')}</div>`)}` },
  services: { title: 'Настройки служб и DNS', sub: 'AdGuard, DNS, WARP и перехват', body: () => `
    ${settingsSection('AdGuard Home', `<div class="form-grid">${fInput('Веб-порт AdGuard', '3001')}${fInput('DNS-порт', '53')}${fInput('DNS listen', '0.0.0.0:53')}${fInput('DNS-over-TLS', '0.0.0.0:853')}${fSelect('Режим блокировки', ['NXDOMAIN', 'REFUSED', '0.0.0.0'])}${fInput('Кэш', '4 MB')}${fInput('Upstream 1', 'https://dns.quad9.net/dns-query')}${fInput('Upstream 2', 'https://dns.google/dns-query')}${fInput('Bootstrap DNS', '9.9.9.10, 1.1.1.1')}${fInput('Fallback DNS', 'https://dns.cloudflare.com/dns-query')}${fSelect('Обновление фильтров', ['24 часа', 'Неделя', 'Вручную'])}${fSelect('Язык', ['ru', 'en'])}</div>`, 'Порт 3001 закреплён, потому что 3000 занят панелью.')}
    ${settingsSection('Фильтрация', `<div class="switch-grid">${fSwitch('Защита DNS', true, 'Защита включена', 'Защита выключена')}${fSwitch('Журнал запросов', true, 'Журнал включён', 'Журнал выключен')}${fSwitch('DNSSEC', true, 'DNSSEC включён', 'DNSSEC выключен')}${fSwitch('Автообновление списков', true, 'Автообновление включено', 'Автообновление выключено')}</div>`)}
    ${settingsSection('Перехват DNS', `<div class="form-grid">${fInput('DNS для клиентов', '10.8.0.1:53')}${fInput('Исключения', 'localhost, 127.0.0.1')}${fSelect('Блокировка DoH/DoT', ['Включена', 'Выключена'])}${fSelect('Интерфейс перехвата', ['awg0', 'awg1', 'Все'])}</div><div class="switch-grid">${fSwitch('Перехват DNS', true, 'Перехват включён', 'Перехват выключен')}${fSwitch('Блокировать DoH/DoT', true, 'DoH/DoT заблокированы', 'DoH/DoT разрешены')}</div>`)}
    ${settingsSection('Службы и WARP', `<div class="form-grid">${fSelect('Вариант WARP', ['Вариант 2', 'Вариант 1'])}${fInput('SOCKS5 порт', '40000')}${fInput('Порт Xray', '443')}${fSelect('Автоперезапуск служб', ['Включён', 'Выключен'])}${fSelect('Мониторинг', ['60 секунд', '30 секунд', '5 минут'])}</div><div class="switch-grid">${fSwitch('AdGuard на 3001', true, 'Порт 3001 закреплён', 'Порт выбирается автоматически')}${fSwitch('Проверять службы каждые 60 секунд', true, 'Мониторинг включён', 'Мониторинг выключен')}</div>`)}` },
  domains: { title: 'Настройки доменов и SSL', sub: 'Certbot, Nginx и проверка домена', body: () => `
    ${settingsSection('Certbot', `<div class="form-grid">${fInput("Email для Let's Encrypt", 'admin@example.com')}${fSelect('Автопродление', ['Включено', 'Выключено'])}${fSelect('Режим проверки', ['HTTP-01', 'DNS-01'])}${fSelect('Staging', ['Нет', 'Да — для тестов'])}${fInput('Webroot', '/var/www/html')}${fSelect('Срок напоминания, дней', ['30', '14', '7'])}</div>`)}
    ${settingsSection('Nginx', `<div class="switch-grid">${fSwitch('Перезагружать Nginx после выпуска', true, 'Nginx перезагружается', 'Nginx не трогать')}${fSwitch('Проверять A-запись', true, 'Проверка включена', 'Проверка выключена')}${fSwitch('Редирект HTTP → HTTPS', true, 'Редирект включён', 'Редирект выключен')}${fSwitch('HSTS', false, 'HSTS включён', 'HSTS выключен')}</div>`)}` },
  app: { title: 'Настройки приложения', sub: 'APK, API, метрики и доступ', body: () => `
    ${settingsSection('Сборка и канал', `<div class="form-grid">${fSelect('Канал APK', ['stable', 'beta'])}${fInput('Минимальная версия', '3.0.90')}${fInput('Публичный адрес панели', 'panel.example.com:4446')}${fSelect('Проверка обновлений', ['При запуске', 'Раз в сутки', 'Вручную'])}</div>`)}
    ${settingsSection('API', `<div class="form-grid">${fInput('API URL', 'https://panel.example.com:4446/api')}${fInput('Токен приложения', 'sp_live_…', 'type="password"')}${fInput('Время жизни токена, дней', '365')}${fSelect('Формат ответа', ['JSON', 'JSON + gzip'])}</div>`, 'Токен можно перевыпустить на странице приложения.')}
    ${settingsSection('Порт метрик', `<div class="form-grid">${fInput('Внутренний порт', '9101', 'type="number" min="1" max="65535"')}${fInput('Внешний порт', '9101', 'type="number" min="1" max="65535"')}${fInput('Адрес прослушивания', '127.0.0.1')}${fSelect('Формат', ['JSON', 'Prometheus'])}${fInput('Путь', '/metrics')}${fSelect('TLS', ['Авто', 'Выключен'])}${fInput('Токен метрик', 'sp_metrics_…', 'type="password" autocomplete="off" style="grid-column:span 2"')}</div><div class="switch-grid">${fSwitch('Включить отдельный порт метрик', true, 'Порт метрик включён', 'Порт метрик выключен')}${fSwitch('Требовать токен', true, 'Токен обязателен', 'Без токена')}${fSwitch('Открывать в UFW', false, 'Порт открыт в UFW', 'Только локально')}${fSwitch('Публичный доступ', false, 'Доступен извне', 'Только localhost')}</div>`, 'По умолчанию внутренний и внешний порт — 9101, адрес 127.0.0.1, путь /metrics.')}
    ${settingsSection('Поведение', `<div class="switch-grid">${fSwitch('Публичная ссылка на APK', true, 'Ссылка доступна', 'Ссылка скрыта')}${fSwitch('Сбор метрик', true, 'Метрики собираются', 'Метрики выключены')}${fSwitch('Сбор ошибок приложения', true, 'Сбор включён', 'Сбор выключен')}${fSwitch('Показывать beta-канал', false, 'Beta показана', 'Beta скрыта')}</div>`)}` },
  rustdesk: { title: 'Настройки RustDesk', sub: 'Relay, API, ключи и доступ', body: () => `
    ${settingsSection('Сервер', `<div class="form-grid">${fInput('Relay host', '203.0.113.10')}${fInput('Relay-порт', '21117')}${fInput('API-порт', '21114')}${fInput('Диапазон портов', '21115-21119')}${fInput('Public key', 'q2f3…9ab1')}${fInput('Домен', '', 'placeholder="rd.example.com"')}</div>`)}
    ${settingsSection('Доступ', `<div class="switch-grid">${fSwitch('Автозапуск hbbs / hbbr', true, 'Автозапуск включён', 'Автозапуск выключен')}${fSwitch('Открыть порты в UFW', true, 'Порты открыты', 'Порты закрыты')}${fSwitch('Разрешить подключения извне', true, 'Внешние подключения', 'Только локально')}${fSwitch('Включить API', true, 'API включён', 'API выключен')}</div>`)}` },
  security: { title: 'Настройки защиты', sub: 'GeoIP, исключения, fail2ban и доступ', body: () => `
    ${settingsSection('GeoIP', `<div class="form-grid">${fSelect('Режим GeoIP', ['RU-DROP', 'Только EU', 'Выключен'])}${fSelect('Роль сервера', ['RU-вход', 'EU-выход'])}${fSelect('Источник списка', ['OpenCCK Russia', 'Antifilter / ipdeny', 'Свой URL', 'Загруженный файл'], 'Antifilter / ipdeny')}${fSelect('Интерфейсы', ['awg0 + awg1 + ens3', 'awg0', 'awg1', 'ens3'])}${fSelect('Автообновление списка', ['Раз в неделю', 'Каждый день', 'Не обновлять'])}${fInput('Свой URL', '', 'placeholder="https://example.com/ru-list.txt"')}${fInput('Файл списка', '', 'placeholder="Путь к загруженному файлу"')}${fInput('Версия базы', '2026.11')}${fInput('Порог блокировки, GB', '0')}${fSelect('Логирование', ['Включено', 'Выключено'])}${fSelect('Пробный прогон', ['Выключен', 'Включён'])}</div>`)}
    ${settingsSection('Исключения', `<div class="form-grid">${fInput('Allowlist', '10.8.0.0/24, 172.16.61.0/24')}${fInput('Дополнительные CIDR в DROP', '', 'placeholder="95.161.76.0/24"')}${fInput('Домены-исключения', '', 'placeholder="example.ru"')}</div><div class="switch-grid">${fSwitch('Блокировать RU-адреса', true, 'RU-DROP включён', 'RU-DROP выключен')}${fSwitch('Логировать срабатывания', true, 'Логирование включено', 'Логирование выключено')}</div>`)}
    ${settingsSection('Доступ', `<div class="form-grid">${fInput('Fail2ban: попыток', '5')}${fInput('Время бана, минут', '60')}${fSelect('2FA', ['Обязательна', 'По желанию', 'Выключена'])}${fInput('IP-whitelist', '', 'placeholder="Не задан"')}${fSelect('Политика UFW', ['deny incoming', 'allow incoming', 'выключен'])}${fInput('Сессия, часов', '24')}</div><div class="switch-grid">${fSwitch('Автобан SSH', true, 'Автобан включён', 'Автобан выключен')}${fSwitch('Блокировать брутфорс панели', true, 'Защита включена', 'Защита выключена')}</div>`)}` },
  diagnostics: { title: 'Настройки диагностики', sub: 'Логи, таймауты и отображение', body: () => `
    ${settingsSection('Проверки', `<div class="form-grid">${fInput('Таймаут ping, сек', '5')}${fInput('Пакетов ping', '4')}${fInput('Макс. хопов traceroute', '12')}${fSelect('Автопроверка при открытии', ['Выключена', 'Включена'])}</div>`)}
    ${settingsSection('Журнал', `<div class="form-grid">${fInput('Строк журнала', '300')}${fSelect('Файл по умолчанию', ['warp_install.log', 'mtproto.log', 'nginx/error.log'])}${fSelect('Автообновление', ['Выключено', '10 секунд', '30 секунд'])}${fSelect('Формат времени', ['Локальное', 'UTC', 'ISO'])}</div><div class="switch-grid">${fSwitch('Показывать время', true, 'Время показано', 'Время скрыто')}${fSwitch('Подсвечивать ошибки', true, 'Подсветка включена', 'Подсветка выключена')}</div>`)}` },
  update: { title: 'Настройки обновления', sub: 'Канал, автобэкап и откат', body: () => `
    ${settingsSection('Обновление', `<div class="form-grid">${fSelect('Канал', ['stable', 'beta'])}${fSelect('Автообновление', ['Выключено', 'При выходе версии', 'Раз в неделю'])}${fSelect('Откат при ошибке', ['Автоматически', 'Вручную'])}${fSelect('Проверка обновлений', ['При входе', 'Раз в сутки', 'Вручную'])}</div>`)}
    ${settingsSection('Бэкапы', `<div class="form-grid">${fInput('Хранить бэкапов', '7')}${fInput('Время бэкапа', '04:30')}${fSelect('Шифрование', ['AES-256', 'Без шифрования'])}${fSelect('Расписание', ['Ежедневно', 'Еженедельно'])}</div><div class="switch-grid">${fSwitch('Создавать бэкап перед обновлением', true, 'Бэкап включён', 'Бэкап выключен')}${fSwitch('Уведомлять в Telegram', false, 'Уведомления включены', 'Уведомления выключены')}</div>`)}` },
  admin: { title: 'Настройки администрирования', sub: 'Сессии, бэкапы, Telegram и аудит', body: () => `
    ${settingsSection('Сессии и доступ', `<div class="form-grid">${fInput('Время жизни сессии, ч', '24')}${fInput('Макс. попыток входа', '5')}${fInput('IP-whitelist', '', 'placeholder="Не задан"')}${fInput('Хранить аудит, дней', '90')}${fSelect('Роль по умолчанию', ['viewer', 'admin'])}${fSelect('Аудит', ['Включён', 'Выключен'])}</div>`)}
    ${settingsSection('Резервные копии', `<div class="form-grid">${fSelect('Расписание', ['Ежедневно', 'Еженедельно'])}${fInput('Время', '04:30')}${fInput('Хранить копий', '7', 'type="number"')}${fInput('Пароль шифрования', '••••••••', 'type="password"')}</div><div class="switch-grid">${fSwitch('Автобэкап', true, 'Автобэкап включён', 'Автобэкап выключен')}${fSwitch('Шифрование AES-256', true, 'Шифрование включено', 'Шифрование выключено')}</div>`)}
    ${settingsSection('Telegram', `<div class="form-grid">${fInput('Токен бота', '', 'placeholder="123456789:AA…" autocomplete="off"')}${fInput('Chat ID', '', 'placeholder="123456789"')}${fSelect('События', ['Вход', 'Ошибки', 'Обновления', 'Всё'])}${fSelect('Автоопределение админа', ['По первому /start', 'Вручную', 'Выключено'])}</div><div class="switch-grid">${fSwitch('Уведомления о входе', true, 'Включены', 'Выключены')}${fSwitch('Уведомления об ошибках', true, 'Включены', 'Выключены')}${fSwitch('Уведомления об обновлениях', true, 'Включены', 'Выключены')}${fSwitch('Уведомления о бэкапах', false, 'Включены', 'Выключены')}</div>`)}
    ${settingsSection('Безопасность', `<div class="switch-grid">${fSwitch('Требовать 2FA для admin', true, '2FA обязательна', '2FA по желанию')}${fSwitch('Завершать сессии при смене пароля', true, 'Сессии завершаются', 'Сессии сохраняются')}${fSwitch('Запретить вход по IP вне whitelist', false, 'Запрет включён', 'Запрет выключен')}${fSwitch('Логировать действия пользователей', true, 'Логирование включено', 'Логирование выключено')}</div>`)}` }
};

const DELETE_TARGETS = {
  'module:awg': { title: 'Удалить AmneziaWG?', warning: 'Будут остановлены awg0/awg1, удалены конфиги, маршруты, ipset и правила UFW. Клиенты потеряют доступ.', message: 'AmneziaWG удалён (демо)' },
  'module:adguard': { title: 'Удалить AdGuard Home?', warning: 'AdGuard будет остановлен, конфиг и статистика удалены, порт 3001 закрыт.', message: 'AdGuard Home удалён (демо)' },
  'module:warp': { title: 'Удалить WARP + Xray?', warning: 'Будут удалены WARP, Xray, конфиги, systemd-службы, регистрация WARP и правило UFW для 443. Предыдущий Xray-конфиг будет восстановлен.', message: 'WARP + Xray удалён (демо)' },
  'module:telemt': { title: 'Удалить Telemt?', warning: 'Будут удалены Telemt, фиксы MEKO, GEOIP, шейпинг и оптимизация. Ссылки tg:// перестанут работать.', message: 'Telemt удалён (демо)' },
  'module:mtproxyl': { title: 'Удалить MTProxyL?', warning: 'Будут удалены MTProxyL, API, Zapret2, Selfmask, WEB Proxy и встроенный бот.', message: 'MTProxyL удалён (демо)' },
  'module:rustdesk': { title: 'Удалить RustDesk?', warning: 'Будут остановлены hbbs/hbbr, удалены конфиги, ключи и порты 21115–21119.', message: 'RustDesk удалён (демо)' },
  cascade: { title: 'Удалить каскад?', warning: 'Будут убраны awg1, маршруты, ipset, правила iptables и клиент EU. Клиенты VPN не пострадают.', message: 'Каскад удалён (демо)' },
  'admin:viewer': { title: 'Удалить пользователя панели?', warning: 'Пользователь viewer потеряет доступ к панели. Сессии будут завершены.', message: 'Пользователь viewer удалён (демо)' }
};

const TAB_META = {
  dashboard: { crumb: 'Дашборд' },
  clients: { crumb: 'Клиенты' },
  install: { crumb: 'Установка' },
  network: { crumb: 'Сеть и порты' },
  cascade: { crumb: 'Каскад RU → EU' },
  obfuscation: { crumb: 'Обфускация' },
  proxy: { crumb: 'Прокси' },
  services: { crumb: 'Службы и DNS' },
  domains: { crumb: 'Домены и SSL' },
  app: { crumb: 'Приложение' },
  rustdesk: { crumb: 'RustDesk' },
  security: { crumb: 'Защита и GeoIP' },
  diagnostics: { crumb: 'Диагностика' },
  update: { crumb: 'Обновление' },
  admin: { crumb: 'Администрирование' }
};

function clientRows() {
  const rows = [
    ['client-01', '10.8.1.2', 'Москва, RU', '312.4 MB', 78, 'online', 'online'],
    ['client-02', '10.8.1.3', 'Санкт-Петербург, RU', '184.9 MB', 46, 'online', 'online'],
    ['client-03', '10.8.1.4', 'Казань, RU', '96.2 MB', 24, 'idle', '5 мин'],
    ['client-04', '172.16.61.2', 'Paris, FR', '1.08 GB', 92, 'online', 'online']
  ];
  return rows.map(([name, ip, loc, traffic, load, status, label]) => `
    <tr data-name="${name}" data-ip="${ip}">
      <td class="name">${name}</td><td class="mono">${ip}</td><td>${loc}</td><td class="mono">${traffic}</td>
      <td><div class="bar"><span style="width:${load}%"></span></div></td>
      <td><span class="status ${status === 'idle' ? 'idle' : ''}"><span class="dot"></span>${label}</span></td>
      <td><div class="page-actions"><button class="row-action" title="Скопировать IP" aria-label="Скопировать IP" data-copy="${ip}">${icon('copy')}</button><button class="row-action" title="Детали клиента" aria-label="Детали клиента" data-toast="Детали ${name}: ${ip} · ${loc} · ${traffic}">${icon('search')}</button><button class="row-action" title="Удалить клиента" aria-label="Удалить клиента" data-action="open-delete" data-delete="client:${name}">${icon('trash')}</button></div></td>
    </tr>`).join('') + `<tr id="clientsEmpty" class="empty-row" style="display:none"><td colspan="7">Ничего не найдено. Измените фильтр.</td></tr>`;
}

function clientsTable() {
  return `
    <div class="table-tools">
      <div class="table-search">${icon('search')}<input id="clientSearch" placeholder="Имя или IP" aria-label="Фильтр клиентов"></div>
      <button class="tag" data-toast="Открыт полный список клиентов">Все клиенты ${icon('arrow', 'ico')}</button>
    </div>
    <div class="table-scroll">
      <table class="table" id="clientsTable">
        <thead><tr><th>Клиент</th><th>IP</th><th>Локация</th><th>Трафик</th><th>Загрузка</th><th>Статус</th><th style="width:104px"></th></tr></thead>
        <tbody>${clientRows()}</tbody>
      </table>
    </div>`;
}

function donutCard() {
  const isRu = state.donutRole === 'ru';
  const gradient = isRu
    ? 'background:conic-gradient(var(--accent) 0 63%,var(--accent-2) 63% 94%,var(--surface-3) 94% 100%)'
    : 'background:conic-gradient(var(--accent) 0 92%,var(--surface-3) 92% 100%)';
  return `
    <section class="card donut-card">
      <div class="card-top"><div><div class="card-title">Распределение трафика</div><div class="card-sub">${isRu ? 'RU-вход · туннель / direct / GeoIP' : 'EU-выход · exit / GeoIP'}</div></div>
        <div class="donut-switch" role="group" aria-label="Роль сервера">
          <button data-action="donut-role" data-role="ru" class="${isRu ? 'on' : ''}">RU-вход</button>
          <button data-action="donut-role" data-role="eu" class="${!isRu ? 'on' : ''}">EU-выход</button>
        </div>
      </div>
      <div class="donut-wrap"><div class="donut" style="${gradient}"><div class="donut-center"><b>${isRu ? '63%' : '92%'}</b><span>${isRu ? 'в EU-туннель' : 'выход'}</span></div></div></div>
      <div class="donut-legend">
        ${isRu ? `
          <div class="donut-row"><i></i>В EU-туннель<b>63% · 1.34 TB</b></div>
          <div class="donut-row amber"><i></i>Напрямую в RU<b>31% · 660 GB</b></div>
          <div class="donut-row gray"><i></i>GeoIP blocked<b>6% · 128 GB</b></div>` : `
          <div class="donut-row"><i></i>Выход в интернет<b>92% · 1.21 TB</b></div>
          <div class="donut-row gray"><i></i>GeoIP blocked<b>8% · 105 GB</b></div>`}
      </div>
      <div class="donut-note">${isRu ? 'RU: сколько ушло в EU-туннель, сколько осталось напрямую и сколько заблокировано GeoIP.' : 'EU-выход: только исходящий трафик и то, что заблокировано GeoIP-правилом.'}</div>
    </section>`;
}

function renderDashboard() {
  return `
    <div class="overview">
      <div class="server-id"><span class="dot"></span><div><div class="server-name">RU → EU · основной узел</div><div class="server-meta">203.0.113.10 · Paris, FR · uptime 6д 5ч · build 3.2.9</div></div></div>
      <div class="overview-actions">
        <div class="live"><span class="dot"></span>Всё в норме</div>
        <div class="chips" role="group" aria-label="Период"><button class="chip on" data-range>1ч</button><button class="chip" data-range>24ч</button><button class="chip" data-range>7д</button></div>
        <button class="btn" data-toast="Данные обновлены">${icon('refresh')}Обновить</button>
        <button class="btn btn-primary" data-action="open-client-modal">${icon('plus')}Добавить клиента</button>
      </div>
    </div>
    <div class="grid">
      ${kpi('Исходящий', '1872.75<small>MB</small>', '+12.4% к прошлому часу', 'send', '', 74)}
      ${kpi('Входящий', '890.50<small>MB</small>', '−3.1% к прошлому часу', 'arrow', 'amber', 42, 'var(--accent-2)')}
      ${kpi('Клиенты', '8<small>online 1</small>', '52 активных соединения', 'users', 'neutral', 26, 'var(--good)')}
      ${kpi('Uptime', '6д 5ч', 'с последнего перезапуска', 'pulse', 'neutral', 92, 'var(--accent-2)')}
      <section class="card chart-card" style="position:relative">
        <div class="card-top"><div><div class="card-title">Трафик</div><div class="card-sub" id="trafficPeriodLabel">Последние 7 дней</div></div><div class="legend"><span><i></i>Rx</span><span><i class="amber"></i>Tx</span><div class="chips" style="margin-left:8px"><button class="chip" data-traffic>1ч</button><button class="chip" data-traffic>24ч</button><button class="chip on" data-traffic>7д</button></div></div></div>
        <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:4px"><div style="font:800 28px/1 var(--font);letter-spacing:-.05em">2.53 <span style="font-size:11px;color:var(--text-2);letter-spacing:0">KB/s</span></div>${tag('▲ 4.8%', 'good')}</div>
        <svg class="chart" viewBox="0 0 760 235" preserveAspectRatio="none">
          <defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".16"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
          <line class="gl" x1="0" y1="35" x2="760" y2="35"/><line class="gl" x1="0" y1="90" x2="760" y2="90"/><line class="gl" x1="0" y1="145" x2="760" y2="145"/><line class="gl" x1="0" y1="200" x2="760" y2="200"/>
          <path class="area" d="M0 168 C38 150 55 128 90 136 C125 144 140 104 175 118 C210 132 225 82 260 94 C295 106 310 132 345 112 C380 92 395 66 430 78 C465 90 480 138 515 122 C550 106 565 72 600 84 C635 96 650 50 685 60 C720 70 735 42 760 48 L760 235 L0 235 Z"/>
          <path class="line" d="M0 168 C38 150 55 128 90 136 C125 144 140 104 175 118 C210 132 225 82 260 94 C295 106 310 132 345 112 C380 92 395 66 430 78 C465 90 480 138 515 122 C550 106 565 72 600 84 C635 96 650 50 685 60 C720 70 735 42 760 48"/>
          <path class="line2" d="M0 188 C50 176 80 160 120 170 C160 180 190 140 230 150 C270 160 300 190 340 172 C380 154 410 120 450 132 C490 144 520 176 560 160 C600 144 630 112 670 124 C710 136 740 104 760 110"/>
          <circle class="pt" cx="430" cy="78" r="4"/><circle class="pt" cx="685" cy="60" r="4"/>
          <text class="axis" x="0" y="228">12 ноя</text><text class="axis" x="250" y="228">13 ноя</text><text class="axis" x="500" y="228">14 ноя</text><text class="axis" x="720" y="228">15 ноя</text>
        </svg>
        <div class="tooltip">$30.5 <span style="color:var(--text-3)">· 18:42</span></div>
      </section>
      ${donutCard()}
      <section class="card" style="grid-column:span 8">
        <div class="card-top"><div><div class="card-title">Быстрые действия</div><div class="card-sub">Частые операции без перехода по меню</div></div>${tag('4 действия')}</div>
        <div class="quick-grid">
          <button class="quick" data-toast="Проверка запущена"><span class="quick-ico">${icon('pulse')}</span><span><b>Проверить всё</b><small>службы, каскад, DNS</small></span>${icon('arrow', 'ico quick-arrow')}</button>
          <button class="quick" data-action="open-client-modal"><span class="quick-ico">${icon('users')}</span><span><b>Добавить клиента</b><small>новый ключ и ссылка</small></span>${icon('arrow', 'ico quick-arrow')}</button>
          <button class="quick" data-toast="Прокси перезапускается"><span class="quick-ico">${icon('refresh')}</span><span><b>Перезапустить прокси</b><small>Telemt / MTProxyL</small></span>${icon('arrow', 'ico quick-arrow')}</button>
          <button class="quick" data-tab="diagnostics"><span class="quick-ico">${icon('terminal')}</span><span><b>Открыть журнал</b><small>последние события</small></span>${icon('arrow', 'ico quick-arrow')}</button>
        </div>
      </section>
      <section class="card events">
        <div class="card-top"><div><div class="card-title">События</div><div class="card-sub">Последние действия</div></div><button class="tag" data-tab="diagnostics">Все события ${icon('arrow', 'ico')}</button></div>
        <div class="event"><span class="event-dot"></span><div><div class="event-text"><b>Каскад RU → EU</b> поднят, handshake 18 мс</div><div class="event-time">2 мин назад</div></div></div>
        <div class="event"><span class="event-dot warn"></span><div><div class="event-text"><b>WARP</b> переподключился, выход Paris</div><div class="event-time">18 мин назад</div></div></div>
        <div class="event"><span class="event-dot"></span><div><div class="event-text"><b>Клиент client-02</b> подключился</div><div class="event-time">42 мин назад</div></div></div>
        <div class="event"><span class="event-dot"></span><div><div class="event-text"><b>Бэкап</b> создан и зашифрован</div><div class="event-time">3 ч назад</div></div></div>
      </section>
      <section class="card table-card">
        <div class="card-top"><div><div class="card-title">Клиенты</div><div class="card-sub">Активные подключения</div></div></div>
        ${clientsTable()}
      </section>
    </div>
    <div class="footnote"><span><b>Servpanel</b> · carbon ux demo</span><span>AMOLED / light · all tabs</span><span>build 3.2.9</span></div>`;
}

function renderClients() {
  return `
    <div class="page-head"><div><div class="page-title">Клиенты</div><div class="page-sub">Подключения, лимиты и ссылки. Данные обновляются каждые 15 секунд.</div></div><div class="page-actions"><button class="btn" data-toast="Список обновлён">${icon('refresh')}Обновить</button><button class="btn btn-primary" data-action="open-client-modal">${icon('plus')}Добавить клиента</button></div></div>
    <div class="mini-grid" style="margin-bottom:16px">${mini('Всего клиентов', '8', '3 устройства · 5 доверенных')}${mini('Онлайн', '1', 'client-02 · 12 сек назад')}${mini('Трафик за месяц', '1.51 TB', '↑ 4.8% к прошлому')}${mini('Средний пинг', '24 ms', 'awg0 → awg1')}</div>
    <section class="card table-card"><div class="card-top"><div><div class="card-title">Все клиенты</div><div class="card-sub">Поиск и управление</div></div></div>${clientsTable()}</section>
    <div class="grid" style="margin-top:16px">
      <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Последнее подключение</div><div class="card-sub">client-02 · 42 минуты назад</div></div>${dotTag('online')}</div><div class="list"><div class="list-row"><b>IP</b><span class="mono">10.8.1.3</span></div><div class="list-row"><b>Локация</b><span class="mono">Санкт-Петербург, RU</span></div><div class="list-row"><b>Протокол</b><span class="mono">AmneziaWG 3.1</span></div><div class="list-row"><b>Трафик</b><span class="mono">184.9 MB</span></div></div></section>
      <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Ссылка для подключения</div><div class="card-sub">vpn:// и QR</div></div>${tag('warp+awg')}</div><div class="code"><div class="code-head"><span>vpn://</span><button class="copy" data-copy="vpn://example">Копировать</button></div><pre>vpn://H4sIA...sNfQ==</pre></div><div class="switches" style="margin-top:10px"><label class="switch"><input type="checkbox" data-switch data-on="Ссылка скопирована" data-off="Отменено"> Показывать полный ключ</label></div></section>
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Массовые операции</div><div class="card-sub">Переименование, экспорт и очистка неактивных</div></div>${tag('bulk', 'muted')}</div><div class="form-grid" style="grid-template-columns:1fr 1fr 1fr auto"><label class="field"><span>Префикс имён</span><input value="client-" placeholder="client-"></label><label class="field"><span>Начать с</span><input value="1" type="number"></label><label class="field"><span>Имя сервера</span><input value="RU → EU · основной узел"></label><button class="btn btn-primary" data-toast="Клиенты переименованы">${icon('edit')}Переименовать</button></div><div class="page-actions" style="margin-top:14px"><button class="btn" data-toast="Экспорт всех .conf">${icon('download')}Экспорт .conf</button><button class="btn" data-toast="Экспорт JSON">${icon('download')}Экспорт JSON</button><button class="btn" data-toast="QR-коды открыты">${icon('external')}QR всех клиентов</button><button class="btn btn-danger" data-toast="Неактивные клиенты будут удалены после подтверждения">${icon('trash')}Удалить неактивных</button></div></section>
    </div>`;
}

function renderNetwork() {
  return `
    <div class="page-head"><div><div class="page-title">Сеть и порты</div><div class="page-sub">Интерфейсы, UFW, редактор AWG и обфускация для клиентов. Всё, что нужно для каскада.</div></div><div class="page-actions"><button class="btn" data-toast="Сеть перечитана">${icon('refresh')}Обновить</button><button class="btn" data-action="open-text-modal" data-text="awg">${icon('upload')}Вставить конфиг</button></div></div>
    <div class="mini-grid" style="margin-bottom:16px">${mini('awg0', '10.8.0.1/24', 'MTU 1200 · вход')}${mini('awg1', '172.16.61.1/24', 'MTU 1200 · EU')}${mini('Внешний IP', '203.0.113.10', 'Paris, FR')}${mini('UFW', 'active', '22 / 443 / 4446')}</div>
    <div class="grid">
      <section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">Интерфейсы</div><div class="card-sub">Состояние и MTU</div></div>${tag('3 активны', 'good')}</div><div class="service-list">
        <div class="service"><div class="service-ico">${icon('server')}</div><div><div class="service-name">awg0</div><div class="service-desc">10.8.0.1/24 · MTU 1200</div></div><div class="service-state"><span class="dot"></span>up</div></div>
        <div class="service"><div class="service-ico">${icon('cascade')}</div><div><div class="service-name">awg1</div><div class="service-desc">172.16.61.1/24 · MTU 1200</div></div><div class="service-state"><span class="dot"></span>up</div></div>
        <div class="service"><div class="service-ico">${icon('globe')}</div><div><div class="service-name">ens3</div><div class="service-desc">203.0.113.10 · MTU 1500</div></div><div class="service-state"><span class="dot"></span>up</div></div>
      </div></section>
      <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">Порты</div><div class="card-sub">TCP / UDP · процесс</div></div>${tag('UFW active', 'good')}</div><div class="table-scroll"><table class="table" style="min-width:0"><thead><tr><th>Порт</th><th>Служба</th><th>PID</th><th>Статус</th></tr></thead><tbody>
        <tr><td class="mono">443/tcp</td><td>Telemt</td><td class="mono">1841</td><td><span class="status"><span class="dot"></span>open</span></td></tr>
        <tr><td class="mono">4446/tcp</td><td>Панель</td><td class="mono">902</td><td><span class="status"><span class="dot"></span>open</span></td></tr>
        <tr><td class="mono">51820/udp</td><td>awg0</td><td class="mono">—</td><td><span class="status"><span class="dot"></span>open</span></td></tr>
        <tr><td class="mono">40000/tcp</td><td>WARP SOCKS</td><td class="mono">2210</td><td><span class="status idle"><span class="dot"></span>local</span></td></tr>
        <tr><td class="mono">3001/tcp</td><td>AdGuard</td><td class="mono">—</td><td><span class="status idle"><span class="dot"></span>план</span></td></tr>
      </tbody></table></div></section>
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Правила UFW</div><div class="card-sub">Порт, протокол и интерфейс</div></div>${tag('active', 'good')}</div><div class="form-grid" style="grid-template-columns:1fr 1fr 1fr auto;align-items:end"><label class="field"><span>Порт</span><input placeholder="8080"></label><label class="field"><span>Протокол</span><select><option>tcp</option><option>udp</option><option>tcp/udp</option></select></label><label class="field"><span>Интерфейс</span><select><option>Все</option><option>awg0</option><option>awg1</option><option>ens3</option></select></label><button class="btn btn-primary" data-toast="Правило UFW добавлено">${icon('plus')}Добавить</button></div><div class="table-scroll" style="margin-top:12px"><table class="table" style="min-width:0"><thead><tr><th>Порт</th><th>Протокол</th><th>Интерфейс</th><th>Действие</th><th></th></tr></thead><tbody><tr><td class="mono">22</td><td>tcp</td><td>Все</td><td>allow</td><td><button class="row-action" data-toast="Правило 22/tcp удалено">${icon('trash')}</button></td></tr><tr><td class="mono">443</td><td>tcp</td><td>Все</td><td>allow</td><td><button class="row-action" data-toast="Правило 443/tcp удалено">${icon('trash')}</button></td></tr><tr><td class="mono">4446</td><td>tcp</td><td>Все</td><td>allow</td><td><button class="row-action" data-toast="Правило 4446/tcp удалено">${icon('trash')}</button></td></tr><tr><td class="mono">51820</td><td>udp</td><td>awg0</td><td>allow</td><td><button class="row-action" data-toast="Правило 51820/udp удалено">${icon('trash')}</button></td></tr></tbody></table></div></section>
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Обфускация для клиентов</div><div class="card-sub">Профили клиентов · параметры меняются в настройках сети</div></div><div class="page-actions">${tag('balanced', 'good')}<button class="btn btn-sm" data-action="toggle-advanced">${icon('wrench')}Настроить</button></div></div><div class="mini-grid">${mini('Профиль', 'balanced', '4 клиента')}${mini('H1–H4', '289…940', 'уникальны')}${mini('S1–S4', '63 / 56 / 12 / 18', 'в диапазоне')}${mini('Jc / Jmin / Jmax', '6 / 438 / 819', 'клиентские')}</div><div class="chips" style="margin-top:14px"><span class="chip on">MTU 1200</span><span class="chip on">HPK задан</span><span class="chip on">I1–I4</span><span class="chip">Rekey 102–114</span></div><div class="page-actions" style="margin-top:14px"><button class="btn btn-primary" data-action="toggle-advanced">${icon('wrench')}Настроить параметры</button><button class="btn" data-action="open-text-modal" data-text="client-obf">${icon('upload')}Вставить текстом</button><button class="btn" data-action="copy-text-preset" data-text="client-obf">${icon('copy')}Скопировать текст</button><button class="btn btn-danger" data-toast="Клиентские параметры сброшены к серверным">${icon('refresh')}Сбросить</button></div>
        <div class="table-scroll" style="margin-top:14px"><table class="table"><thead><tr><th>Клиент</th><th>Профиль</th><th>H1–H4</th><th>Обновлено</th><th></th></tr></thead><tbody>
          <tr><td class="name">client-01</td><td><span class="tag good">balanced</span></td><td class="mono">289…940</td><td class="mono">08 ноя 12:10</td><td><button class="row-action" data-action="copy-text-preset" data-text="client-obf" title="Скопировать конфиг">${icon('copy')}</button></td></tr>
          <tr><td class="name">client-02</td><td><span class="tag good">balanced</span></td><td class="mono">289…940</td><td class="mono">08 ноя 12:10</td><td><button class="row-action" data-action="copy-text-preset" data-text="client-obf" title="Скопировать конфиг">${icon('copy')}</button></td></tr>
          <tr><td class="name">client-03</td><td><span class="tag warn">compat</span></td><td class="mono">1…4</td><td class="mono">07 ноя 18:42</td><td><button class="row-action" data-action="copy-text-preset" data-text="client-obf" title="Скопировать конфиг">${icon('copy')}</button></td></tr>
          <tr><td class="name">client-04</td><td><span class="tag">custom</span></td><td class="mono">свои</td><td class="mono">06 ноя 09:05</td><td><button class="row-action" data-action="copy-text-preset" data-text="client-obf" title="Скопировать конфиг">${icon('copy')}</button></td></tr>
        </tbody></table></div>
      </section>
      <section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">Редактор AmneziaWG</div><div class="card-sub">Серверный awg0.conf · параметры и ключи</div></div><div class="page-actions">${tag('advanced', 'muted')}<button class="row-action" data-action="open-text-modal" data-text="awg" title="Вставить текстом">${icon('upload')}</button></div></div><details class="advanced-block" ${state.advanced.network ? 'open' : ''}><summary>Показать редактор awg0.conf</summary><textarea id="awgConfigEditor" rows="14" spellcheck="false" placeholder="Вставьте конфигурацию [Interface] …">${awgServerTextPreset()}</textarea><div class="page-actions" style="margin-top:12px"><button class="btn btn-primary" data-toast="awg0.conf сохранён, AWG перезапущен">${icon('check')}Сохранить и перезапустить</button><button class="btn" data-action="copy-text-preset" data-text="awg">${icon('copy')}Скопировать</button></div></details><div class="donut-note">Смена H1–H4, S1–S4 или HeaderProtectionKey требует обновить клиентские конфиги.</div></section>
      <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">Конфиг EU-туннеля</div><div class="card-sub">awg-eu.conf · вставьте клиентский конфиг с EU</div></div>${tag('cascade', 'muted')}</div><details class="advanced-block" ${state.advanced.network ? 'open' : ''}><summary>Показать редактор awg-eu.conf</summary><textarea id="cascadeConfigEditor" rows="14" spellcheck="false" placeholder="# Вставьте конфиг клиента, созданного на EU-сервере"></textarea><div class="page-actions" style="margin-top:12px"><button class="btn btn-primary" data-toast="awg-eu.conf сохранён, туннель перезапущен">${icon('check')}Сохранить</button><button class="btn" data-action="open-text-modal" data-text="cascade">${icon('upload')}Вставить текстом</button></div></details><div class="donut-note">Endpoint должен указывать на EU-сервер. После сохранения панель проверит handshake.</div></section>
    </div>`;
}

function renderCascade() {
  return `
    <div class="page-head"><div><div class="page-title">Каскад RU → EU</div><div class="page-sub">Вход на RU, выход на EU. Здесь видно, сколько трафика реально ушло в туннель.</div></div><div class="page-actions"><button class="btn" data-action="open-text-modal" data-text="cascade">${icon('upload')}Вставить конфиг EU</button><button class="btn" data-toast="Проверка каскада запущена">${icon('pulse')}Проверить</button><button class="btn" data-toast="Маршруты обновлены">${icon('refresh')}Обновить маршруты</button><button class="btn btn-danger" data-action="open-delete" data-delete="cascade">${icon('trash')}Удалить каскад</button></div></div>
    <div class="mini-grid" style="margin-bottom:16px">${mini('RU endpoint', '198.51.100.20', 'awg0 · вход')}${mini('EU endpoint', '203.0.113.10', 'awg1 · выход')}${mini('Latency', '18 ms', 'handshake 42 сек назад')}${mini('Потери', '0.0%', 'за последний час')}</div>
    <div class="grid">
      <section class="card" style="grid-column:span 8"><div class="card-top"><div><div class="card-title">Куда ушёл трафик</div><div class="card-sub">RU-вход · за последние 24 часа</div></div>${tag('1.34 TB в туннель', 'good')}</div>
        <div style="display:flex;height:12px;border-radius:99px;overflow:hidden;background:var(--surface-3);margin:22px 0 14px"><span style="width:63%;background:var(--accent)"></span><span style="width:31%;background:var(--accent-2)"></span><span style="width:6%;background:var(--line-3)"></span></div>
        <div class="donut-legend"><div class="donut-row"><i></i>В EU-туннель<b>63% · 1.34 TB</b></div><div class="donut-row amber"><i></i>Напрямую в RU<b>31% · 660 GB</b></div><div class="donut-row gray"><i></i>GeoIP blocked<b>6% · 128 GB</b></div></div>
        <div class="donut-note">На EU-выходе: 92% — выход в интернет, 8% — GeoIP blocked. Если EU тупиковый, туннельного трафика дальше нет.</div>
      </section>
      <section class="card" style="grid-column:span 4"><div class="card-top"><div><div class="card-title">MTProto через EU</div><div class="card-sub">Telemt / MTProxyL</div></div>${dotTag('включено')}</div><label class="switch" style="margin-bottom:10px"><input type="checkbox" checked data-switch data-on="Прокси пущен через EU" data-off="Прокси возвращён напрямую"> Пускать Telemt и MTProxyL через EU</label><div class="list"><div class="list-row"><b>Пользователи</b><span class="mono">telemt, mtproxyl</span></div><div class="list-row"><b>middle_proxy_nat_ip</b><span class="mono">203.0.113.10</span></div><div class="list-row"><b>DC 203</b><span class="mono">91.105.192.0/23</span></div><div class="list-row"><b>MSS</b><span class="mono">1160 / clamp</span></div></div></section>
      <section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">Чек-лист каскада</div><div class="card-sub">Что проверено</div></div>${tag('5 / 6', 'warn')}</div><div class="list">
        <div class="list-row"><b>${icon('check')} awg1</b><span class="mono">active</span></div>
        <div class="list-row"><b>${icon('check')} policy routing</b><span class="mono">table 100</span></div>
        <div class="list-row"><b>${icon('check')} NAT / MASQUERADE</b><span class="mono">ok</span></div>
        <div class="list-row"><b>${icon('check')} MTU / MSS</b><span class="mono">1200 / 1160</span></div>
        <div class="list-row"><b>${icon('warn')} GeoIP</b><span class="mono">128 GB blocked</span></div>
      </div></section>
      <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">GeoIP blocked</div><div class="card-sub">Правило RU-DROP</div></div>${tag('24 ч', 'muted')}</div><div class="mini-grid" style="grid-template-columns:1fr 1fr"><div class="mini-card"><div class="mini-label">Трафик</div><div class="mini-value">128<small>GB</small></div></div><div class="mini-card"><div class="mini-label">Пакетов</div><div class="mini-value">1.2<small>M</small></div></div></div><div class="donut-note">Блокируется только RU-трафик по GeoIP. На EU-выходе это 8% от общего объёма.</div></section>
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Параметры каскада</div><div class="card-sub">Роль, интерфейсы, MTU/MSS и MTProto · всё в настройках страницы</div></div><div class="page-actions">${tag('заданы', 'good')}<button class="btn btn-sm" data-action="toggle-advanced">${icon('wrench')}Настроить</button></div></div><div class="mini-grid">${mini('Роль', 'RU-вход', 'awg0 → awg1')}${mini('EU endpoint', '203.0.113.10:51820', 'handshake ok')}${mini('MTU / MSS', '1200 / 1160', 'clamp')}${mini('Kill switch', 'вкл', 'защита от утечек')}</div><div class="chips" style="margin-top:14px"><span class="chip on">policy routing</span><span class="chip on">NAT / MASQUERADE</span><span class="chip on">MSS clamp</span><span class="chip">IPv6 off</span></div><div class="page-actions" style="margin-top:14px"><button class="btn" data-toast="Маршруты пересобраны">${icon('refresh')}Пересобрать маршруты</button><button class="btn" data-toast="Проверка утечек запущена">${icon('shield')}Проверить утечки</button></div></section>
      ${state.advanced.cascade ? `<section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">awg1.conf на этом сервере</div><div class="card-sub">Только для тонкой настройки · обычно менять здесь ничего не нужно</div></div>${tag('expert', 'warn')}</div><textarea id="cascadeAwg1Editor" rows="12" spellcheck="false" placeholder="[Interface] …">[Interface]
Table = off
PrivateKey = &lt;eu-client-private-key&gt;
Address = 172.16.61.2/32
MTU = 1200
Jc = 6
Jmin = 438
Jmax = 819
S1 = 63
S2 = 56

[Peer]
PublicKey = &lt;eu-server-public-key&gt;
Endpoint = 203.0.113.10:51820
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25</textarea><div class="page-actions" style="margin-top:12px"><button class="btn btn-primary" data-toast="awg1.conf сохранён, туннель перезапущен">${icon('check')}Сохранить awg1.conf</button><button class="btn" data-action="open-text-modal" data-text="cascade">${icon('upload')}Вставить текстом</button><button class="btn" data-action="copy-text-preset" data-text="cascade">${icon('copy')}Скопировать</button></div></section>` : ''}
    </div>`;
}

function renderObfuscation() {
  const profiles = [
    ['compat', 'Compatibility', 'Минимальные параметры для старых клиентов.', 'H1–H4 · S1/S2 · без I-цепочки', 42],
    ['balanced', 'Balanced', 'Оптимальный профиль для большинства сетей.', 'H1–H4 random · S1–S4 · I1–I3', 78],
    ['max', 'Maximum', 'Максимальная защита от DPI. Может быть медленнее.', 'полные диапазоны · I1–I5', 96]
  ];
  return `
    <div class="page-head"><div><div class="page-title">Обфускация</div><div class="page-sub">Профили AmneziaWG 3.1 и импорт из Архитектора. Применение перезапускает туннель на 2–3 секунды.</div></div><div class="page-actions"><button class="btn" data-toast="Текущий профиль сохранён">${icon('box')}Сохранить профиль</button><button class="btn" data-action="open-text-modal" data-text="obf">${icon('upload')}Вставить текстом</button><button class="btn btn-primary" data-toast="Генерация нового профиля">${icon('pulse')}Сгенерировать</button></div></div>
    <div class="grid">
      ${profiles.map(([id, name, desc, params, score]) => `<section class="card" style="grid-column:span 4"><div class="card-top"><div><div class="card-title">${name}</div><div class="card-sub">${id}</div></div>${tag(score + '/100', score > 80 ? 'good' : 'warn')}</div><p style="font-size:12px;color:var(--text-2);margin:0 0 14px;line-height:1.6">${desc}</p><div class="progress"><span style="width:${score}%"></span></div><div class="mini-note" style="margin-top:10px">${params}</div><div class="module-actions" style="margin-top:14px"><button class="btn btn-primary" data-toast="Профиль «${name}» применён">Применить</button><button class="btn btn-danger" data-action="open-delete" data-delete="profile:${id}">${icon('trash')}Удалить</button></div></section>`).join('')}
      <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">Аудит</div><div class="card-sub">Проверка текущих параметров</div></div>${tag('3 / 4', 'warn')}</div><div class="mini-grid" style="grid-template-columns:1fr 1fr;margin-bottom:10px"><div class="mini-card"><div class="mini-label">Оценка</div><div class="mini-value">78<small>/100</small></div></div><div class="mini-card"><div class="mini-label">Версия</div><div class="mini-value">3.1</div></div></div><div class="list"><div class="list-row"><b>${icon('check')} H1–H4</b><span class="mono">уникальны</span></div><div class="list-row"><b>${icon('check')} S1–S4</b><span class="mono">в диапазоне</span></div><div class="list-row"><b>${icon('check')} I1–I5</b><span class="mono">валидны</span></div><div class="list-row"><b>${icon('warn')} Keepalive</b><span class="mono">12–14 сек</span></div></div><div class="donut-note">Профиль применяется к awg0. Клиенты переподключатся автоматически.</div></section>
      <section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">Импорт из Архитектора</div><div class="card-sub">.conf, JSON или vpn:// — вставьте текстом</div></div>${tag('текстом', 'good')}</div>
        <textarea id="obfImportText" rows="11" spellcheck="false" placeholder="# AmneziaWG 3.1&#10;[Interface]&#10;H1 = 511866868-511879290&#10;...&#10;&#10;или JSON, или vpn://"></textarea>
        <div class="page-actions" style="margin-top:12px"><button class="btn" data-action="paste-to-target" data-target="obfImportText">${icon('upload')}Вставить из буфера</button><button class="btn" data-action="analyze-obf">${icon('pulse')}Проверить</button><button class="btn" data-action="apply-obf-import">${icon('check')}Применить</button><button class="btn btn-danger" data-action="clear-target" data-target="obfImportText">Очистить</button></div>
        <div class="donut-note" id="obfPreview">Панель покажет версию AWG, оценку устойчивости и различия перед применением.</div>
      </section>
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Текущий профиль</div><div class="card-sub">Параметры awg0 · меняются в настройках страницы</div></div><div class="page-actions">${tag('balanced', 'good')}<button class="btn btn-sm" data-action="toggle-advanced">${icon('wrench')}Настроить</button><button class="btn btn-sm" data-action="copy-text-preset" data-text="obf">${icon('copy')}Скопировать текстом</button><button class="btn btn-sm" data-action="open-text-modal" data-text="obf">${icon('upload')}Вставить текстом</button></div></div><div class="mini-grid">${mini('H1–H4', '289…940', 'уникальны')}${mini('S1–S4', '63 / 56 / 12 / 18', 'в диапазоне')}${mini('Jc / Jmin / Jmax', '6 / 438 / 819', 'клиентские')}${mini('MTU', '1200', 'clamp')}${mini('HPK', 'задан', '32 байта')}${mini('Rekey / Keepalive', '102–114 / 12–14', 'сек')}</div><div class="chips" style="margin-top:14px"><span class="chip on">I1</span><span class="chip on">I2</span><span class="chip on">I3</span><span class="chip on">I4</span><span class="chip">SNI ozon.ru</span></div><div class="page-actions" style="margin-top:14px"><button class="btn btn-primary" data-toast="Новые параметры сгенерированы">${icon('pulse')}Сгенерировать</button><button class="btn" data-toast="Профиль применён, туннель перезапущен">${icon('check')}Применить</button><button class="btn btn-danger" data-toast="Откат к предыдущему профилю">${icon('refresh')}Откатить</button></div></section>
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Применение</div><div class="card-sub">Что сделать после импорта или генерации</div></div>${tag('перед записью — бэкап', 'warn')}</div><div class="switch-grid">${fSwitch('Пересобрать .conf клиентов после смены параметров', true, 'Клиенты пересоберутся', 'Клиенты не трогаются')}${fSwitch('Удалить параметры, которых нет в импорте', true, 'Лишние параметры удаляются', 'Лишние параметры сохраняются')}</div><div class="notice warn" style="margin-top:12px">После смены H1–H4, S1–S4 или HeaderProtectionKey старые .conf на устройствах перестанут работать — клиентам нужно заново импортировать новые файлы. Jc/Jmin/Jmax и I1–I5 — клиентские, но панель всё равно пересоберёт файлы для единообразия.</div><div class="page-actions" style="margin-top:14px"><button class="btn btn-primary" data-toast="Профиль применён, .conf клиентов пересобраны">${icon('check')}Применить и пересобрать .conf</button><button class="btn" data-toast="Скачивание .conf">${icon('download')}Скачать .conf</button><button class="btn" data-toast="Скачивание JSON">${icon('download')}Скачать JSON</button></div></section>
    </div>`;
}

function renderProxy() {
  return `
    <div class="page-head"><div><div class="page-title">Прокси</div><div class="page-sub">Telemt и MTProxyL: пользователи, лимиты, ссылки и Telegram-бот.</div></div><div class="page-actions"><button class="btn" data-toast="Список обновлён">${icon('refresh')}Обновить</button><button class="btn" data-action="module-settings" data-module="telemt">${icon('wrench')}Telemt</button><button class="btn" data-action="module-settings" data-module="mtproxyl">${icon('wrench')}MTProxyL</button><button class="btn btn-primary" data-action="open-client-modal">${icon('plus')}Добавить пользователя</button></div></div>
    <div class="mini-grid" style="margin-bottom:16px">${mini('Движок', 'Telemt', '3.5.16 · binary')}${mini('Порт', '443', 'FakeTLS · vimeo.com')}${mini('Пользователей', '8', '2 онлайн')}${mini('Соединений', '52', 'за последние 5 мин')}</div>
    <div class="grid">
      <section class="card" style="grid-column:span 8"><div class="card-top"><div><div class="card-title">Пользователи прокси</div><div class="card-sub">Лимиты и ссылки</div></div>${tag('8', 'muted')}</div><div class="table-scroll"><table class="table"><thead><tr><th>Пользователь</th><th>Статус</th><th>Трафик</th><th>Соединения</th><th>Срок</th><th></th></tr></thead><tbody>
        ${[['default','online','6.62 MB','1 / ∞','бессрочно'],['client-05','idle','0 B','0 / ∞','бессрочно'],['client-06','idle','21.3 KB','0 / 5','бессрочно'],['client-07','online','312 MB','2 / 8','30 дек']].map(([n,s,t,c,e])=>`<tr><td class="name">${n}</td><td><span class="status ${s==='idle'?'idle':''}"><span class="dot"></span>${s}</span></td><td class="mono">${t}</td><td class="mono">${c}</td><td class="mono">${e}</td><td><div class="page-actions"><button class="row-action" data-toast="Ссылка для ${n} скопирована">${icon('link')}</button><button class="row-action" data-action="open-delete" data-delete="user:${n}" title="Удалить пользователя">${icon('trash')}</button></div></td></tr>`).join('')}
      </tbody></table></div></section>
      <section class="card" style="grid-column:span 4"><div class="card-top"><div><div class="card-title">Подключение клиентов</div><div class="card-sub">Порт и адрес в ссылках</div></div><button class="btn btn-sm" data-action="toggle-advanced">${icon('wrench')}Настроить</button></div><div class="list"><div class="list-row"><b>Порт</b><span class="mono">443</span></div><div class="list-row"><b>Адрес</b><span class="mono">домен</span></div><div class="list-row"><b>SNI</b><span class="mono">vimeo.com</span></div></div><div class="donut-note">После сохранения ссылки пересоберутся автоматически.</div></section>
      <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Telegram-бот</div><div class="card-sub">Управление прокси из Telegram</div></div><div class="page-actions">${tag('выключен')}<button class="btn btn-sm" data-action="toggle-advanced">${icon('wrench')}Настроить</button></div></div><div class="list"><div class="list-row"><b>Токен</b><span class="mono">не задан</span></div><div class="list-row"><b>ID администратора</b><span class="mono">не задан</span></div><div class="list-row"><b>Автоопределение</b><span class="mono">по /start</span></div></div><div class="page-actions" style="margin-top:12px"><button class="btn" data-action="toggle-advanced">${icon('wrench')}Настроить бота</button><button class="btn" data-toast="Тестовое сообщение отправлено">${icon('bell')}Тест</button></div><div class="donut-note">Первый /start в течение минуты назначает админа.</div></section>
      <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Ссылка для подключения</div><div class="card-sub">Пример для default</div></div>${tag('tg://', 'muted')}</div><div class="code"><div class="code-head"><span>tg://proxy</span><button class="copy" data-copy="tg://proxy?server=...&port=443&secret=ee...">Копировать</button></div><pre>tg://proxy?server=203.0.113.10&amp;port=443&amp;secret=ee...</pre></div><div class="donut-note">Ссылка одноразовая для пользователя. После ротации секрета старые ссылки перестанут работать.</div></section>
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Исправление и оптимизация</div><div class="card-sub">MTU/MSS, keepalive и Fast Open · настройки в ключе</div></div><div class="page-actions">${tag('recommended', 'good')}<button class="btn btn-sm" data-action="toggle-advanced">${icon('wrench')}Настроить</button></div></div><div class="mini-grid">${mini('MSS', '1160', 'clamp на awg0')}${mini('Keepalive', '25 s', 'TCP keepalive')}${mini('Fast Open', 'включён', 'tcp_fastopen=3')}${mini('Буфер', '16 MB', 'rmem / wmem')}</div><div class="page-actions" style="margin-top:14px"><button class="btn btn-primary" data-toast="Fix выполнен: маршруты, MTU, секреты">${icon('pulse')}Исправить автоматически</button><button class="btn" data-toast="Прокси перезапущен">${icon('refresh')}Перезапустить</button><button class="btn btn-danger" data-toast="Сброс к заводским параметрам прокси">${icon('refresh')}Сбросить</button></div><div class="donut-note">«Исправить автоматически» проверяет маршрут до DC, MTU/MSS, секрет и пересобирает ссылки. Пользователи не удаляются.</div></section>
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Чек-лист MTProto</div><div class="card-sub">Что проверяется перед выдачей ссылок</div></div>${tag('6 / 7', 'warn')}</div><div class="grid" style="gap:0"><div class="list" style="grid-column:span 6"><div class="list-row"><b>${icon('check')} Служба telemt</b><span class="mono">active</span></div><div class="list-row"><b>${icon('check')} Порт 443</b><span class="mono">listen</span></div><div class="list-row"><b>${icon('check')} FakeTLS SNI</b><span class="mono">ozon.ru</span></div><div class="list-row"><b>${icon('check')} Секрет</b><span class="mono">валиден</span></div></div><div class="list" style="grid-column:span 6"><div class="list-row"><b>${icon('check')} Маршрут до DC</b><span class="mono">ok</span></div><div class="list-row"><b>${icon('check')} MTU / MSS</b><span class="mono">1200 / 1160</span></div><div class="list-row"><b>${icon('warn')} Каскад через EU</b><span class="mono">проверить</span></div><div class="list-row"><b>${icon('check')} UFW</b><span class="mono">443 open</span></div></div></div><div class="page-actions" style="margin-top:12px"><button class="btn btn-primary" data-toast="Проверка MTProto запущена">${icon('pulse')}Проверить всё</button><button class="btn" data-toast="Ссылки пересобраны">${icon('link')}Пересобрать ссылки</button></div></section>
    </div>`;
}

function renderServices() {
  return `
    <div class="page-head"><div><div class="page-title">Службы и DNS</div><div class="page-sub">AdGuard, WARP/Xray, Telemt и системные службы. Установка AdGuard — вручную.</div></div><div class="page-actions"><button class="btn" data-toast="Состояние служб обновлено">${icon('refresh')}Обновить</button></div></div>
    <div class="grid">
      <section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">AdGuard Home</div><div class="card-sub">DNS-фильтр · порт 3001</div></div><div class="page-actions">${tag('автоматическая установка в разработке', 'warn')}${keyBtn('adguard', 'Параметры AdGuard')}</div></div><p style="font-size:12.5px;color:var(--text-2);line-height:1.65;margin:0 0 14px">Автоматическая установка в разработке. Порт <b>3001</b>, потому что <b>3000 занят панелью</b>. Пока — установка вручную одной командой.</p><div class="code"><div class="code-head"><span>curl · установка на 3001</span><button class="copy" data-copy="curl -fsSL https://raw.githubusercontent.com/AmShaegar-dev/servpanel/main/install_adguard_silent.sh | sudo env ADGUARD_PORT=3001 PANEL_PORT=3000 bash">Копировать</button></div><pre>curl -fsSL https://raw.githubusercontent.com/AmShaegar-dev/servpanel/main/install_adguard_silent.sh | sudo env ADGUARD_PORT=3001 PANEL_PORT=3000 bash</pre></div><div class="list" style="margin-top:10px"><div class="list-row"><b>1</b><span>Выполнить команду — AdGuard ставится сразу на 3001</span></div><div class="list-row"><b>2</b><span>Открыть http://IP:3001 (не 3000)</span></div><div class="list-row"><b>3</b><span>Задать логин/пароль и DNS</span></div></div><div class="page-actions" style="margin-top:14px"><button class="btn" data-action="module-settings" data-module="adguard">${icon('wrench')}Параметры</button><button class="btn" data-action="open-text-modal" data-text="adguard">${icon('upload')}Вставить текстом</button><button class="btn" data-toast="Открываю http://IP:3001">${icon('external')}Открыть 3001</button><button class="btn btn-danger" data-action="open-delete" data-delete="module:adguard">${icon('trash')}Удалить</button></div></section>
      <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">Службы</div><div class="card-sub">Ключевые узлы</div></div>${tag('6 / 7', 'warn')}</div><div class="service-list">
        <div class="service"><div class="service-ico">${icon('shield')}</div><div><div class="service-name">AdGuard Home</div><div class="service-desc">DNS · :3001</div></div><div class="service-state"><span class="dot" style="background:var(--warn)"></span>не установлен</div></div>
        <div class="service"><div class="service-ico">${icon('send')}</div><div><div class="service-name">Telemt</div><div class="service-desc">MTProto · :443</div></div><div class="service-state"><span class="dot"></span>active</div></div>
        <div class="service"><div class="service-ico">${icon('cascade')}</div><div><div class="service-name">Xray</div><div class="service-desc">WARP · :443</div></div><div class="service-state"><span class="dot"></span>active</div></div>
        <div class="service"><div class="service-ico">${icon('globe')}</div><div><div class="service-name">Cloudflare WARP</div><div class="service-desc">SOCKS5 · :40000</div></div><div class="service-state"><span class="dot"></span>active</div></div>
        <div class="service"><div class="service-ico">${icon('server')}</div><div><div class="service-name">nginx</div><div class="service-desc">HTTPS · :4446</div></div><div class="service-state"><span class="dot"></span>active</div></div>
        <div class="service"><div class="service-ico">${icon('clock')}</div><div><div class="service-name">cron</div><div class="service-desc">планировщик</div></div><div class="service-state"><span class="dot"></span>active</div></div>
      </div></section>
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">WARP + Xray</div><div class="card-sub">Вариант 2 · Google direct / AI через WARP</div></div><div class="page-actions">${dotTag('активен')}${tag('вариант 2', 'good')}${keyBtn('warp', 'Параметры WARP')}</div></div><div class="mini-grid">${mini('WARP', 'Connected', '104.28.211.192 · Paris')}${mini('Xray', 'active', '0.0.0.0:443')}${mini('SOCKS5', '40000', 'отвечает')}${mini('Сервисы', '13', '179 правил')}</div><div class="page-actions" style="margin-top:14px"><button class="btn" data-action="module-settings" data-module="warp">${icon('wrench')}Параметры</button><button class="btn" data-toast="Проверка WARP запущена">${icon('pulse')}Проверить</button><button class="btn" data-toast="Открываю инструкции">${icon('link')}Инструкции</button><button class="btn btn-danger" data-action="open-delete" data-delete="module:warp">${icon('trash')}Удалить WARP</button></div></section>
      <section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">DNS и upstreams</div><div class="card-sub">AdGuard Home · резолвинг для клиентов</div></div><div class="page-actions">${tag('2 upstream', 'muted')}<button class="btn btn-sm" data-action="toggle-advanced">${icon('wrench')}Настроить</button></div></div><div class="list"><div class="list-row"><b>DNS listen</b><span class="mono">0.0.0.0:53</span></div><div class="list-row"><b>DNS-over-TLS</b><span class="mono">0.0.0.0:853</span></div><div class="list-row"><b>Upstream</b><span class="mono">Quad9 · Google</span></div><div class="list-row"><b>Bootstrap</b><span class="mono">9.9.9.10, 1.1.1.1</span></div><div class="list-row"><b>Fallback</b><span class="mono">Cloudflare DoH</span></div><div class="list-row"><b>DNSSEC / журнал</b><span class="mono">вкл / вкл</span></div></div><div class="chips" style="margin-top:12px"><span class="chip on">NXDOMAIN</span><span class="chip on">кэш 4 MB</span><span class="chip on">DNSSEC</span><span class="chip">журнал</span></div><div class="page-actions" style="margin-top:14px"><button class="btn" data-action="toggle-advanced">${icon('wrench')}Настроить DNS</button><button class="btn" data-toast="Проверка upstream запущена">${icon('pulse')}Проверить upstream</button></div></section>
      <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">AdGuard · параметры</div><div class="card-sub">Веб-интерфейс и фильтры</div></div>${tag('3001', 'good')}</div><div class="list"><div class="list-row"><b>Web UI</b><span class="mono">0.0.0.0:3001</span></div><div class="list-row"><b>Порт 3000</b><span class="mono">занят панелью</span></div><div class="list-row"><b>Фильтров</b><span class="mono">3 списка</span></div><div class="list-row"><b>Правил</b><span class="mono">179 284</span></div><div class="list-row"><b>Обновление списков</b><span class="mono">24 ч</span></div></div><label class="switch" style="margin-top:12px"><input type="checkbox" checked data-switch data-on="Защита AdGuard включена" data-off="Защита AdGuard выключена"> Защита и фильтрация DNS</label><div class="page-actions" style="margin-top:12px"><button class="btn btn-primary" data-toast="Открываю http://IP:3001">${icon('external')}Открыть 3001</button><button class="btn" data-toast="Списки фильтров обновлены">${icon('refresh')}Обновить списки</button></div><div class="donut-note">Порт 3001 указан в установщике: <span class="mono">ADGUARD_PORT=3001</span>. 3000 не использовать.</div></section>
      <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Перехват DNS (iptables)</div><div class="card-sub">Направить DNS клиентов в AdGuard</div></div><div class="page-actions">${dotTag('готово')}<button class="btn btn-sm" data-action="toggle-advanced">${icon('wrench')}Настроить</button></div></div><div class="list"><div class="list-row"><b>DNS для клиентов</b><span class="mono">10.8.0.1:53</span></div><div class="list-row"><b>Исключения</b><span class="mono">localhost, 127.0.0.1</span></div><div class="list-row"><b>Перехват</b><span class="mono">включён</span></div><div class="list-row"><b>DoH/DoT</b><span class="mono">заблокированы</span></div></div><div class="code" style="margin-top:12px"><div class="code-head"><span>iptables</span><button class="copy" data-copy="iptables -t nat -A PREROUTING -i awg0 -p udp --dport 53 -j DNAT --to-destination 10.8.0.1:53">Копировать</button></div><pre>iptables -t nat -A PREROUTING -i awg0 -p udp --dport 53 -j DNAT --to-destination 10.8.0.1:53</pre></div><div class="page-actions" style="margin-top:12px"><button class="btn" data-action="toggle-advanced">${icon('wrench')}Настроить перехват</button><button class="btn btn-primary" data-toast="Правила DNS-перехвата применены">${icon('check')}Применить</button><button class="btn btn-danger" data-toast="Правила DNS-перехвата удалены">${icon('trash')}Убрать</button></div></section>
      <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">AdGuard · статистика</div><div class="card-sub">Последние 24 часа</div></div>${tag('API 3001', 'muted')}</div><div class="mini-grid" style="grid-template-columns:1fr 1fr 1fr"><div class="mini-card"><div class="mini-label">Запросов</div><div class="mini-value">184<small>K</small></div></div><div class="mini-card"><div class="mini-label">Заблокировано</div><div class="mini-value">23<small>%</small></div></div><div class="mini-card"><div class="mini-label">Клиентов</div><div class="mini-value">8</div></div></div><div class="list" style="margin-top:12px"><div class="list-row"><b>Топ-домен</b><span class="mono">googlevideo.com · 12.4K</span></div><div class="list-row"><b>Заблокировано</b><span class="mono">doubleclick.net · 8.2K</span></div><div class="list-row"><b>Средний ответ</b><span class="mono">18 ms</span></div><div class="list-row"><b>Фильтров</b><span class="mono">3 · 179 284 правила</span></div></div><div class="page-actions" style="margin-top:12px"><button class="btn" data-toast="Статистика обновлена">${icon('refresh')}Обновить</button><button class="btn" data-toast="Статистика AdGuard сброшена">${icon('trash')}Сбросить</button></div></section>
    </div>`;
}

function renderDomains() {
  return `
    <div class="page-head"><div><div class="page-title">Домены и SSL</div><div class="page-sub">Сертификаты Let's Encrypt и привязка доменов к панели и сайтам.</div></div><div class="page-actions"><button class="btn btn-primary" data-toast="Форма выпуска сертификата открыта">${icon('plus')}Выпустить сертификат</button></div></div>
    <div class="mini-grid" style="margin-bottom:16px">${mini('Домен панели', 'panel.example.com', 'Let\'s Encrypt')}${mini('Сертификат', '78 дней', 'действителен')}${mini('Сайтов', '2', '1 активен')}${mini('Автопродление', 'включено', 'certbot.timer')}</div>
    <div class="grid">
      <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Сертификат панели</div><div class="card-sub">panel.example.com</div></div>${dotTag('valid')}</div><div class="list"><div class="list-row"><b>Выдан</b><span class="mono">23 окт 2026</span></div><div class="list-row"><b>Истекает</b><span class="mono">23 янв 2027</span></div><div class="list-row"><b>Issuer</b><span class="mono">Let's Encrypt R11</span></div><div class="list-row"><b>Путь</b><span class="mono">/etc/letsencrypt/live/…</span></div></div><div class="page-actions" style="margin-top:12px"><button class="btn" data-toast="Сертификат продлевается">${icon('refresh')}Продлить</button><button class="btn btn-danger" data-action="open-delete" data-delete="cert:panel.example.com">${icon('trash')}Удалить сертификат</button></div></section>
      <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Сайты</div><div class="card-sub">Nginx + Certbot</div></div>${tag('2', 'muted')}</div><div class="table-scroll"><table class="table" style="min-width:0"><thead><tr><th>Домен</th><th>Тип</th><th>HTTPS</th><th></th></tr></thead><tbody><tr><td class="name">panel.example.com</td><td>панель</td><td><span class="status"><span class="dot"></span>issued</span></td><td><div class="page-actions"><button class="row-action" data-toast="Сертификат обновлён">${icon('refresh')}</button><button class="row-action" data-action="open-delete" data-delete="site:panel.example.com" title="Удалить сайт">${icon('trash')}</button></div></td></tr><tr><td class="name">site.example.com</td><td>сайт</td><td><span class="status idle"><span class="dot"></span>ожидает</span></td><td><div class="page-actions"><button class="row-action" data-toast="Сертификат запрошен">${icon('refresh')}</button><button class="row-action" data-action="open-delete" data-delete="site:site.example.com" title="Удалить сайт">${icon('trash')}</button></div></td></tr></tbody></table></div></section>
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Новый домен</div><div class="card-sub">A-запись должна указывать на IP сервера</div></div></div><div class="form-grid"><label class="field"><span>Домен</span><input placeholder="panel.example.com"></label><label class="field"><span>Режим</span><select><option>Панель</option><option>Сайт</option></select></label><label class="field"><span>Email</span><input placeholder="admin@example.com"></label><label class="field"><span>HTTP-порт</span><input value="80" readonly></label></div><button class="btn btn-primary" style="margin-top:12px" data-toast="Проверка домена запущена">${icon('lock')}Проверить и выпустить</button></section>
    </div>`;
}

function renderApp() {
  return `
    <div class="page-head"><div><div class="page-title">Приложение</div><div class="page-sub">APK, API и метрики клиентов. Сборки обновляются из GitHub Releases.</div></div><div class="page-actions"><button class="btn" data-toast="Проверка обновлений">${icon('refresh')}Проверить</button><button class="btn btn-primary" data-toast="Скачивание APK">${icon('download')}Скачать APK</button></div></div>
    <div class="mini-grid" style="margin-bottom:16px">${mini('Версия APK', '3.2.9', '12.1 MB')}${mini('Скачиваний', '1 284', 'за месяц')}${mini('API', 'online', '200 OK')}${mini('Клиентов', '8', '1 активен')}</div>
    <div class="grid">
      <section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">Последняя сборка</div><div class="card-sub">servpanel.apk</div></div>${dotTag('stable')}</div><div class="list"><div class="list-row"><b>Версия</b><span class="mono">3.2.9</span></div><div class="list-row"><b>Размер</b><span class="mono">12 156 561 B</span></div><div class="list-row"><b>SHA256</b><span class="mono">3a0b7b68…523f</span></div><div class="list-row"><b>Дата</b><span class="mono">08 ноя 2026</span></div></div><div class="code" style="margin-top:12px"><div class="code-head"><span>download</span><button class="copy" data-copy="https://github.com/AmShaegar-dev/servpanel/releases/latest/download/servpanel.apk">Копировать</button></div><pre>https://github.com/AmShaegar-dev/servpanel/releases/latest/download/servpanel.apk</pre></div></section>
      <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">API</div><div class="card-sub">Панель и приложение</div></div>${dotTag('200 OK')}</div><div class="list"><div class="list-row"><b>Endpoint</b><span class="mono">/api/stats</span></div><div class="list-row"><b>Latency</b><span class="mono">24 ms</span></div><div class="list-row"><b>Requests / 24h</b><span class="mono">18 422</span></div><div class="list-row"><b>Errors</b><span class="mono">0.02%</span></div></div><div class="progress" style="margin-top:12px"><span style="width:98%"></span></div></section>
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Метрики клиентов</div><div class="card-sub">Установки по платформам</div></div>${tag('за 30 дней')}</div><div class="quick-grid" style="grid-template-columns:repeat(3,1fr)"><div class="quick"><span class="quick-ico">${icon('phone')}</span><span><b>Android</b><small>1 042 установки</small></span></div><div class="quick"><span class="quick-ico">${icon('monitor')}</span><span><b>Windows</b><small>186 установок</small></span></div><div class="quick"><span class="quick-ico">${icon('globe')}</span><span><b>Web</b><small>56 сессий</small></span></div></div></section>
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Доступ приложения</div><div class="card-sub">API, токен и адрес панели · настройки в ключе</div></div><div class="page-actions">${tag('demo', 'muted')}<button class="btn btn-sm" data-action="toggle-advanced">${icon('wrench')}Настроить</button></div></div><div class="mini-grid">${mini('API URL', '…:4446/api', 'HTTPS')}${mini('Токен', 'sp_live_…', 'действует')}${mini('Мин. версия', '3.0.90', 'stable')}${mini('Публичная ссылка', 'включена', 'APK')}</div><div class="page-actions" style="margin-top:14px"><button class="btn" data-action="toggle-advanced">${icon('wrench')}Настроить доступ</button><button class="btn" data-toast="Токен приложения перевыпущен">${icon('refresh')}Перевыпустить токен</button><button class="btn" data-toast="API проверен: 200 OK">${icon('pulse')}Проверить API</button></div></section>
    </div>`;
}

function renderRustdesk() {
  return `
    <div class="page-head"><div><div class="page-title">RustDesk</div><div class="page-sub">Собственный relay-сервер и клиенты. Порт 21115–21119.</div></div><div class="page-actions"><button class="btn" data-toast="Состояние обновлено">${icon('refresh')}Обновить</button><button class="btn btn-primary" data-toast="Скачивание клиента">${icon('download')}Скачать клиент</button><button class="btn btn-danger" data-action="open-delete" data-delete="module:rustdesk">${icon('trash')}Удалить RustDesk</button></div></div>
    <div class="mini-grid" style="margin-bottom:16px">${mini('Сервер', 'online', 'hbbs + hbbr')}${mini('ID', '123 456 789', 'публичный')}${mini('Relay', '203.0.113.10', ':21117')}${mini('Клиентов', '3', '2 онлайн')}</div>
    <div class="grid">
      <section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">Конфигурация</div><div class="card-sub">hbbs / hbbr</div></div>${dotTag('active')}</div><div class="list"><div class="list-row"><b>Public key</b><span class="mono">q2f3…9ab1</span></div><div class="list-row"><b>Relay server</b><span class="mono">203.0.113.10:21117</span></div><div class="list-row"><b>API</b><span class="mono">:21114</span></div><div class="list-row"><b>Версия</b><span class="mono">1.4.2</span></div></div><div class="page-actions" style="margin-top:12px"><button class="btn" data-toast="Ключ скопирован">${icon('copy')}Копировать ключ</button><button class="btn" data-toast="Перезапуск RustDesk">${icon('refresh')}Перезапустить</button></div></section>
      <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">Клиенты</div><div class="card-sub">Последние подключения</div></div>${tag('3', 'muted')}</div><div class="table-scroll"><table class="table" style="min-width:0"><thead><tr><th>Устройство</th><th>ID</th><th>Статус</th></tr></thead><tbody><tr><td class="name">office-pc</td><td class="mono">884 221 019</td><td><span class="status"><span class="dot"></span>online</span></td></tr><tr><td class="name">home-mac</td><td class="mono">551 903 882</td><td><span class="status"><span class="dot"></span>online</span></td></tr><tr><td class="name">laptop</td><td class="mono">101 220 344</td><td><span class="status idle"><span class="dot"></span>офлайн</span></td></tr></tbody></table></div></section>
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Чек-лист и подключение</div><div class="card-sub">Что проверить и как подключить клиент</div></div>${tag('4 / 5', 'warn')}</div><div class="grid" style="gap:16px"><div class="list" style="grid-column:span 6"><div class="list-row"><b>${icon('check')} hbbs</b><span class="mono">active</span></div><div class="list-row"><b>${icon('check')} hbbr</b><span class="mono">active</span></div><div class="list-row"><b>${icon('check')} Порты 21115–21119</b><span class="mono">open</span></div><div class="list-row"><b>${icon('check')} Public key</b><span class="mono">совпадает</span></div><div class="list-row"><b>${icon('warn')} Домен</b><span class="mono">не задан</span></div></div><div style="grid-column:span 6"><div class="list"><div class="list-row"><b>1</b><span>Скачать RustDesk-клиент</span></div><div class="list-row"><b>2</b><span>Указать Relay: 203.0.113.10:21117</span></div><div class="list-row"><b>3</b><span>Вставить Public key</span></div><div class="list-row"><b>4</b><span>Подключиться по ID</span></div></div><div class="code" style="margin-top:10px"><div class="code-head"><span>relay</span><button class="copy" data-copy="203.0.113.10:21117">Копировать</button></div><pre>203.0.113.10:21117</pre></div></div></div></section>
    </div>`;
}

function renderSecurity() {
  return `
    <div class="page-head"><div><div class="page-title">Защита и GeoIP</div><div class="page-sub">RU-DROP, fail2ban и UFW. Здесь видно, сколько трафика заблокировано по GeoIP.</div></div><div class="page-actions"><button class="btn" data-toast="Проверка безопасности запущена">${icon('shield')}Проверить</button></div></div>
    <div class="mini-grid" style="margin-bottom:16px">${mini('GeoIP blocked', '128 GB', '1.2M пакетов · 24ч')}${mini('Fail2ban', '3 IP', '12 попыток')}${mini('UFW', 'active', '22 / 443 / 4446')}${mini('2FA', 'включена', 'TOTP')}</div>
    <div class="grid">
      <section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">GeoIP blocked</div><div class="card-sub">Правило RU-DROP · входящий трафик</div></div>${tag('24 часа', 'muted')}</div><div class="mini-grid" style="grid-template-columns:1fr 1fr 1fr"><div class="mini-card"><div class="mini-label">Трафик</div><div class="mini-value">128<small>GB</small></div></div><div class="mini-card"><div class="mini-label">Пакетов</div><div class="mini-value">1.2<small>M</small></div></div><div class="mini-card"><div class="mini-label">Доля</div><div class="mini-value">6<small>%</small></div></div></div><div class="donut-note" style="margin-top:12px">На RU-входе GeoIP блокирует 6% трафика. На EU-выходе — 8%. Это не пользовательский трафик, а фоновые сканы и RU-адреса.</div><div class="list" style="margin-top:8px"><div class="list-row"><b>Топ CIDR</b><span class="mono">95.161.76.0/24 · 42 GB</span></div><div class="list-row"><b>Второй</b><span class="mono">185.76.151.0/24 · 31 GB</span></div><div class="list-row"><b>Третий</b><span class="mono">91.108.56.0/22 · 18 GB</span></div></div></section>
      <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">Fail2ban</div><div class="card-sub">SSH и панель</div></div>${tag('3 banned', 'warn')}</div><div class="table-scroll"><table class="table" style="min-width:0"><thead><tr><th>IP</th><th>Сервис</th><th>Попытки</th></tr></thead><tbody><tr><td class="mono">203.0.113.10</td><td>ssh</td><td>8</td></tr><tr><td class="mono">198.51.100.66</td><td>panel</td><td>5</td></tr><tr><td class="mono">192.0.2.44</td><td>ssh</td><td>4</td></tr></tbody></table></div><button class="btn" style="margin-top:12px" data-toast="Список банов обновлён">${icon('refresh')}Обновить</button></section>
      <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">UFW</div><div class="card-sub">Открытые порты</div></div>${dotTag('active')}</div><div class="chips">${['22/tcp','443/tcp','4446/tcp','51820/udp','40000/tcp'].map(p=>`<span class="chip on">${p}</span>`).join('')}</div><div class="donut-note">40000/tcp слушает только localhost. AdGuard 3001 — в плане.</div></section>
      <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Двухфакторная аутентификация</div><div class="card-sub">TOTP для администратора</div></div>${dotTag('включена')}</div><div class="list"><div class="list-row"><b>Аккаунт</b><span class="mono">admin</span></div><div class="list-row"><b>Резервные коды</b><span class="mono">8 из 10</span></div><div class="list-row"><b>Последний вход</b><span class="mono">08 ноя, 09:41</span></div></div><button class="btn" style="margin-top:12px" data-toast="Настройка 2FA открыта">${icon('lock')}Управлять 2FA</button></section>
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Блокировка RU-трафика (GeoIP)</div><div class="card-sub">Источник списка, интерфейсы и автообновление</div></div><div class="page-actions">${dotTag('RU-DROP активен')}<button class="btn btn-sm" data-action="toggle-advanced">${icon('wrench')}Настроить</button></div></div><div class="mini-grid">${mini('Источник', 'Antifilter / ipdeny', 'вся зона РФ')}${mini('Автообновление', 'раз в неделю', 'список IP')}${mini('Интерфейсы', 'awg0 · awg1', 'ens3')}${mini('База GeoIP', '2026.11', '1.2 MB')}${mini('Заблокировано', '128 GB', 'за 24 часа')}</div><div class="chips" style="margin-top:14px"><span class="chip on">awg0</span><span class="chip on">awg1</span><span class="chip on">ens3</span><span class="chip on">Antifilter / ipdeny</span><span class="chip">OpenCCK</span><span class="chip">свой URL</span><span class="chip">файл</span></div><div class="page-actions" style="margin-top:14px"><button class="btn btn-primary" data-toast="Блокировка RU включена">${icon('shield')}Включить блокировку</button><button class="btn btn-danger" data-toast="Блокировка RU отключена">${icon('stop')}Отключить</button><button class="btn" data-action="toggle-advanced">${icon('wrench')}Настроить источник</button><button class="btn" data-toast="База GeoIP обновлена">${icon('refresh')}Обновить базу</button><button class="btn" data-toast="Пробный прогон: 1.2M пакетов, 128 GB">${icon('pulse')}Пробный прогон</button></div><div class="donut-note">Стандартный источник — Antifilter / ipdeny: вся зона РФ. OpenCCK блокирует только CIDR российских сервисов (Сбер, VK, Яндекс, Ozon). Маршруты каскада настраиваются на RU-входе.</div></section>
    </div>`;
}

function renderDiagnostics() {
  return `
    <div class="page-head"><div><div class="page-title">Диагностика</div><div class="page-sub">Ping, traceroute и журналы. Быстрая проверка без SSH.</div></div><div class="page-actions"><button class="btn" data-toast="Диагностика запущена">${icon('pulse')}Проверить всё</button></div></div>
    <div class="grid">
      <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Ping</div><div class="card-sub">До узла или домена</div></div></div><div class="form-grid"><label class="field"><span>Хост</span><input value="1.1.1.1"></label><label class="field"><span>Пакетов</span><input value="4"></label></div><button class="btn btn-primary" style="margin-top:12px" data-toast="Ping запущен">Запустить</button><div class="list" style="margin-top:12px"><div class="list-row"><b>1.1.1.1</b><span class="mono">18 ms · 0% loss</span></div><div class="list-row"><b>203.0.113.10</b><span class="mono">24 ms · 0% loss</span></div></div></section>
      <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Traceroute</div><div class="card-sub">Маршрут до EU</div></div></div><div class="form-grid"><label class="field"><span>Хост</span><input value="203.0.113.10"></label><label class="field"><span>Макс. хопов</span><input value="12"></label></div><button class="btn btn-primary" style="margin-top:12px" data-toast="Traceroute запущен">Запустить</button><div class="list" style="margin-top:12px"><div class="list-row"><b>1</b><span class="mono">198.51.100.1 · 1 ms</span></div><div class="list-row"><b>2</b><span class="mono">10.8.0.1 · 4 ms</span></div><div class="list-row"><b>3</b><span class="mono">203.0.113.10 · 18 ms</span></div></div></section>
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Журнал</div><div class="card-sub">Последние 200 строк</div></div><div class="page-actions"><select class="field" style="height:32px;border:1px solid var(--line);border-radius:9px;background:var(--surface-2);padding:0 9px;font-size:11px"><option>warp_install.log</option><option>mtproto.log</option><option>nginx/error.log</option></select><button class="btn btn-sm" data-toast="Журнал обновлён">${icon('refresh')}Обновить</button></div></div><div class="code"><div class="code-head"><span>/var/log/warp_install.log</span><button class="copy" data-copy="warp_install.log">Копировать путь</button></div><pre>2026-11-07 12:58:03 [4/6] Конфигурация Xray...
2026-11-07 12:58:03 routing v2: Google direct, AI warp, default direct
2026-11-07 12:58:05 [5/6] Запуск Xray...
2026-11-07 12:58:05 Xray слушает 0.0.0.0:443, WARP SOCKS — 127.0.0.1:40000
2026-11-07 12:58:05 INSTALLATION DONE</pre></div></section>
    </div>`;
}

function renderUpdate() {
  return `
    <div class="page-head"><div><div class="page-title">Обновление</div><div class="page-sub">Версия панели, бэкапы и канал обновлений.</div></div><div class="page-actions"><button class="btn" data-toast="Проверка обновлений">${icon('refresh')}Проверить</button><button class="btn btn-primary" data-toast="Обновление запущено">${icon('download')}Обновить</button></div></div>
    <div class="mini-grid" style="margin-bottom:16px">${mini('Текущая версия', '3.2.9', 'stable')}${mini('Последняя', '3.2.9', 'обновлений нет')}${mini('Бэкап', '08 ноя', 'AES-256')}${mini('Канал', 'stable', 'GitHub Releases')}</div>
    <div class="grid">
      <section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">Что нового</div><div class="card-sub">3.2.9 · 08 ноя 2026</div></div>${tag('current', 'good')}</div><div class="list"><div class="list-row"><b>WARP/Xray</b><span>проверка порта 443 и статус без TOS</span></div><div class="list-row"><b>MTProto</b><span>Telemt/MTProxyL через EU, DC 203</span></div><div class="list-row"><b>UI</b><span>Carbon, светлая тема, UX-правки</span></div><div class="list-row"><b>Telegram-бот</b><span>автоопределение админа по /start</span></div></div></section>
      <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">Бэкапы</div><div class="card-sub">Последние архивы</div></div>${tag('3', 'muted')}</div><div class="list"><div class="list-row"><b>08 ноя 09:42</b><span class="mono">3.90 MB</span><div class="page-actions"><button class="row-action" data-toast="Бэкап 08 ноя восстанавливается">${icon('refresh')}</button><button class="row-action" data-action="open-delete" data-delete="backup:08 ноя 09:42" title="Удалить бэкап">${icon('trash')}</button></div></div><div class="list-row"><b>07 ноя 22:10</b><span class="mono">3.88 MB</span><div class="page-actions"><button class="row-action" data-toast="Бэкап 07 ноя восстанавливается">${icon('refresh')}</button><button class="row-action" data-action="open-delete" data-delete="backup:07 ноя 22:10" title="Удалить бэкап">${icon('trash')}</button></div></div><div class="list-row"><b>07 ноя 12:05</b><span class="mono">3.87 MB</span><div class="page-actions"><button class="row-action" data-toast="Бэкап 07 ноя восстанавливается">${icon('refresh')}</button><button class="row-action" data-action="open-delete" data-delete="backup:07 ноя 12:05" title="Удалить бэкап">${icon('trash')}</button></div></div></div><button class="btn" style="margin-top:12px" data-toast="Бэкап создаётся">${icon('box')}Создать бэкап</button></section>
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Установить новую версию</div><div class="card-sub">Архив .tar.gz, URL релиза или GitHub</div></div>${tag('проверка + откат', 'warn')}</div><div class="form-grid"><label class="field"><span>Архив .tar.gz</span><input type="file" accept=".tar.gz,.tgz,application/gzip"></label><label class="field"><span>Ссылка на релиз</span><input placeholder="https://example.com/servpanel-3.2.9.tar.gz"></label><label class="field"><span>Канал</span><select><option>stable</option><option>beta</option></select></label><label class="field"><span>При ошибке</span><select><option>Автоматический откат</option><option>Оставить как есть</option></select></label></div><div class="page-actions" style="margin-top:14px"><button class="btn btn-primary" data-toast="Установка из файла запущена">${icon('upload')}Установить из файла</button><button class="btn" data-toast="Установка по URL запущена">${icon('link')}Установить по URL</button><button class="btn" data-toast="GitHub: обновлений нет">${icon('refresh')}Проверить GitHub</button><button class="btn btn-danger" data-toast="Сброс локальных изменений и обновление">${icon('refresh')}Сбросить и обновить</button></div><div class="donut-note">Перед заменой панель проверит архив, поставит зависимости во временный каталог, создаст бэкап и запустит новую версию на отдельном порту. Клиенты, пароль, 2FA и конфиги AWG не затрагиваются.</div></section>
    </div>`;
}

function renderAdmin() {
  return `
    <div class="page-head"><div><div class="page-title">Администрирование</div><div class="page-sub">Пользователи панели, роли, аудит и настройки сессий.</div></div><div class="page-actions"><button class="btn btn-primary" data-toast="Форма пользователя открыта">${icon('plus')}Добавить пользователя</button></div></div>
    <div class="grid">
      <section class="card" style="grid-column:span 7"><div class="card-top"><div><div class="card-title">Пользователи</div><div class="card-sub">Доступ к панели</div></div>${tag('2', 'muted')}</div><div class="table-scroll"><table class="table"><thead><tr><th>Логин</th><th>Роль</th><th>2FA</th><th>Последний вход</th><th></th></tr></thead><tbody><tr><td class="name">admin</td><td>admin</td><td><span class="status"><span class="dot"></span>вкл</span></td><td class="mono">08 ноя 09:41</td><td><button class="row-action" data-toast="Редактирование admin">${icon('edit')}</button></td></tr><tr><td class="name">viewer</td><td>viewer</td><td><span class="status idle"><span class="dot"></span>выкл</span></td><td class="mono">07 ноя 18:20</td><td><div class="page-actions"><button class="row-action" data-toast="Редактирование viewer">${icon('edit')}</button><button class="row-action" data-action="open-delete" data-delete="admin:viewer" title="Удалить пользователя">${icon('trash')}</button></div></td></tr></tbody></table></div></section>
      <section class="card" style="grid-column:span 5"><div class="card-top"><div><div class="card-title">Аудит</div><div class="card-sub">Последние действия</div></div>${tag('live', 'good')}</div><div class="list"><div class="list-row"><b>admin</b><span class="mono">обновил панель · 09:41</span></div><div class="list-row"><b>admin</b><span class="mono">создал клиента client-01 · 08:12</span></div><div class="list-row"><b>viewer</b><span class="mono">вошёл · 07 ноя 18:20</span></div><div class="list-row"><b>admin</b><span class="mono">применил WARP v2 · 07 ноя 12:58</span></div></div></section>
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Сессии и безопасность</div><div class="card-sub">Пароль, 2FA и время жизни сессии · настройки в ключе</div></div><div class="page-actions">${dotTag('2FA включена')}<button class="btn btn-sm" data-action="toggle-advanced">${icon('wrench')}Настроить</button></div></div><div class="mini-grid">${mini('Сессия', '24 часа', 'TTL')}${mini('Попыток входа', '5', 'до бана')}${mini('IP-whitelist', 'не задан', 'все IP')}${mini('Аудит', 'включён', '90 дней')}${mini('2FA', 'включена', 'TOTP')}${mini('Последний вход', '08 ноя 09:41', 'admin')}</div><div class="page-actions" style="margin-top:14px"><button class="btn" data-action="toggle-advanced">${icon('wrench')}Настроить доступ</button><button class="btn" data-action="open-password-modal">${icon('key')}Сменить пароль</button><button class="btn btn-danger" data-action="logout">${icon('logout')}Выйти</button></div></section>
      <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Автоматические резервные копии</div><div class="card-sub">Расписание и шифрование · настройки в ключе</div></div><div class="page-actions">${tag('AES-256', 'good')}<button class="btn btn-sm" data-action="toggle-advanced">${icon('wrench')}Настроить</button></div></div><div class="list"><div class="list-row"><b>Расписание</b><span class="mono">ежедневно · 04:30</span></div><div class="list-row"><b>Хранить</b><span class="mono">7 копий</span></div><div class="list-row"><b>08 ноя 04:30</b><span class="mono">3.90 MB · ok</span></div><div class="list-row"><b>07 ноя 04:30</b><span class="mono">3.88 MB · ok</span></div></div><div class="page-actions" style="margin-top:12px"><button class="btn" data-action="toggle-advanced">${icon('wrench')}Настроить бэкап</button><button class="btn btn-primary" data-toast="Бэкап создаётся">${icon('box')}Создать сейчас</button></div></section>
      <section class="card" style="grid-column:span 6"><div class="card-top"><div><div class="card-title">Telegram-уведомления</div><div class="card-sub">События панели · настройки в ключе</div></div><div class="page-actions">${tag('выключены', 'muted')}<button class="btn btn-sm" data-action="toggle-advanced">${icon('wrench')}Настроить</button></div></div><div class="list"><div class="list-row"><b>Токен бота</b><span class="mono">не задан</span></div><div class="list-row"><b>Chat ID</b><span class="mono">не задан</span></div><div class="list-row"><b>События</b><span class="mono">вход · ошибки · обновления</span></div><div class="list-row"><b>Автоопределение админа</b><span class="mono">по /start</span></div></div><div class="page-actions" style="margin-top:12px"><button class="btn" data-action="toggle-advanced">${icon('wrench')}Настроить бота</button><button class="btn" data-toast="Тестовое сообщение отправлено">${icon('bell')}Тест</button></div><div class="donut-note">Первый /start в течение минуты может назначить администратора автоматически.</div></section>
    </div>`;
}

const MODULE_FACTS = {
  awg: { port: '443/udp', service: 'awg-quick@awg0', config: '/etc/amnezia/amneziawg/awg0.conf' },
  adguard: { port: '3001/tcp', service: 'AdGuardHome', config: '/opt/AdGuardHome/AdGuardHome.yaml' },
  warp: { port: '443/tcp', service: 'xray', config: '/usr/local/etc/xray/config.json' },
  telemt: { port: '443/tcp', service: 'telemt', config: '/etc/telemt/telemt.toml' },
  mtproxyl: { port: '443/tcp', service: 'mtproxyl-api', config: '/etc/mtproxyl/config.toml' },
  rustdesk: { port: '21115–21119', service: 'hbbs + hbbr', config: '/root/rustdesk' }
};

function renderInstall() {
  const modules = [
    ['awg', 'AmneziaWG', '3.1', 'установлен', 'awg0 / awg1 · каскад', 'shield', 'good', 'Настроить'],
    ['adguard', 'AdGuard Home', '—', 'не установлен', 'DNS · порт 3001', 'server', 'warn', 'Установить'],
    ['warp', 'WARP + Xray', '2026.8', 'установлен', 'вариант 2 · :443', 'send', 'good', 'Проверить'],
    ['telemt', 'MTProto / Telemt', '3.5.16', 'установлен', 'порт 443 · ozon.ru', 'send', 'good', 'Настройки'],
    ['mtproxyl', 'MTProxyL', '—', 'не установлен', 'менеджер · API 9190', 'box', 'warn', 'Установить'],
    ['rustdesk', 'RustDesk', '1.4.2', 'установлен', 'hbbs + hbbr · 21115+', 'monitor', 'good', 'Настроить']
  ];
  return `
    <div class="page-head"><div><div class="page-title">Установка</div><div class="page-sub">У каждого модуля свои параметры. Откройте ключ на карточке — установщик подставит их сам.</div></div><div class="page-actions"><button class="btn" data-toast="Список модулей обновлён">${icon('refresh')}Обновить</button></div></div>
    <div class="mini-grid" style="margin-bottom:16px">${mini('Модулей', '6', '4 установлено · 2 доступны')}${mini('Канал', 'stable', 'GitHub Releases')}${mini('Порт панели', '3000', 'AdGuard — 3001')}${mini('Последняя установка', '08 ноя', 'WARP + Xray')}</div>
    <div class="grid">
      ${modules.map(([id, name, version, status, desc, ico, tone, action]) => `
        <section class="card" style="grid-column:span 4">
          <div class="card-top"><div><div class="card-title">${name}</div><div class="card-sub">${desc}</div></div><div class="page-actions">${tag(status, tone)}</div></div>
          <div class="list"><div class="list-row"><b>Версия</b><span class="mono">${version}</span></div><div class="list-row"><b>Состояние</b><span class="mono">${status}</span></div><div class="list-row"><b>Порт</b><span class="mono">${MODULE_FACTS[id].port}</span></div><div class="list-row"><b>Служба</b><span class="mono">${MODULE_FACTS[id].service}</span></div><div class="list-row"><b>Конфиг</b><span class="mono">${MODULE_FACTS[id].config}</span></div></div>
          <div class="module-actions">
            <button class="btn ${tone === 'warn' ? 'btn-primary' : ''}" data-action="${status.includes('не') ? 'module-install' : 'module-settings'}" data-module="${id}">${icon(status.includes('не') ? 'download' : 'wrench')}${status.includes('не') ? 'Установить' : 'Настроить'}</button>
            <button class="btn btn-danger" data-action="open-delete" data-delete="module:${id}" ${status.includes('не') ? 'disabled' : ''}>${icon('trash')}Удалить</button>
          </div>
        </section>`).join('')}
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Журнал установки</div><div class="card-sub">Последний запуск · WARP + Xray</div></div><div class="page-actions">${tag('завершено', 'good')}<button class="btn btn-sm" data-action="open-text-modal" data-text="awg">${icon('upload')}Вставить текстом</button></div></div><div class="list" style="margin-bottom:12px"><div class="list-row"><b>${icon('check')} Подготовка</b><span class="mono">готово</span></div><div class="list-row"><b>${icon('check')} Пакеты</b><span class="mono">готово</span></div><div class="list-row"><b>${icon('check')} WARP / Xray</b><span class="mono">готово</span></div><div class="list-row"><b>${icon('check')} Маршрутизация</b><span class="mono">179 доменов</span></div><div class="list-row"><b>${icon('check')} Завершение</b><span class="mono">08 ноя 12:58</span></div></div><div class="code"><div class="code-head"><span>/var/log/warp_install.log</span><button class="copy" data-copy="warp_install.log">Копировать путь</button></div><pre>2026-11-08 12:58:03 routing v2: Google direct, AI warp, default direct
2026-11-08 12:58:05 Xray слушает 0.0.0.0:443, WARP SOCKS — 127.0.0.1:40000
2026-11-08 12:58:05 INSTALLATION DONE</pre></div></section>
      <section class="card" style="grid-column:span 12"><div class="card-top"><div><div class="card-title">Ссылки MTProto</div><div class="card-sub">Создаются установщиком · можно скопировать и перенести</div></div><div class="page-actions">${tag('tg://', 'muted')}<button class="btn btn-sm" data-action="open-text-modal" data-text="telemt">${icon('upload')}Вставить текстом</button><button class="btn btn-sm" data-action="copy-text-preset" data-text="telemt">${icon('copy')}Скопировать</button></div></div><textarea id="mtprotoLinksText" rows="4" spellcheck="false" placeholder="tg://proxy?server=…">tg://proxy?server=203.0.113.10&port=443&secret=ee...
tg://proxy?server=203.0.113.10&port=443&secret=dd...</textarea><div class="donut-note">Если ссылок нет — откройте MEKO Manager командой <span class="mono">sudo mekopr</span>. Для MTProxyL ссылки появятся во вкладке «Прокси».</div></section>
    </div>`;
}

const tabs = {
  dashboard: renderDashboard,
  clients: renderClients,
  install: renderInstall,
  network: renderNetwork,
  cascade: renderCascade,
  obfuscation: renderObfuscation,
  proxy: renderProxy,
  services: renderServices,
  domains: renderDomains,
  app: renderApp,
  rustdesk: renderRustdesk,
  security: renderSecurity,
  diagnostics: renderDiagnostics,
  update: renderUpdate,
  admin: renderAdmin
};

function render() {
  const meta = TAB_META[state.tab] || TAB_META.dashboard;
  document.getElementById('crumb').textContent = meta.crumb;
  document.getElementById('view').innerHTML = tabs[state.tab]();
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.tab === state.tab));
  $$('#topTabs .top-tab').forEach(item => item.classList.toggle('active', item.dataset.tab === state.tab));
  bindClientSearch();
  decoratePageHead();
  renderAdvancedInline();
}

function bindClientSearch() {
  const search = document.getElementById('clientSearch');
  if (!search) return;
  search.addEventListener('input', () => filterClientRows(search.value));
}

function filterClientRows(query) {
  const q = String(query || '').trim().toLowerCase();
  let visible = 0;
  $$('#clientsTable tbody tr[data-name]').forEach(row => {
    const match = !q || row.dataset.name.toLowerCase().includes(q) || row.dataset.ip.toLowerCase().includes(q);
    row.style.display = match ? '' : 'none';
    if (match) visible++;
  });
  const empty = document.getElementById('clientsEmpty');
  if (empty) empty.style.display = visible ? 'none' : '';
}

function setTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('sp-theme', theme);
  $$('[data-theme-set]').forEach(btn => btn.classList.toggle('on', btn.dataset.themeSet === theme));
}

let toastTimer;
function showToast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

async function copyText(text) {
  const value = String(text ?? '');
  try {
    await navigator.clipboard.writeText(value);
    showToast('Скопировано');
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      showToast('Скопировано');
    } catch (err) {
      showToast('Не удалось скопировать');
    }
  }
}

function openClientModal() {
  const modal = document.getElementById('clientModal');
  if (!modal) return;
  modal.hidden = false;
  setTimeout(() => document.getElementById('newClientName')?.focus(), 0);
}
function closeClientModal() {
  const modal = document.getElementById('clientModal');
  if (modal) modal.hidden = true;
}
function createClient() {
  const name = document.getElementById('newClientName')?.value.trim();
  if (!name) { showToast('Укажите имя клиента'); return; }
  const count = Math.max(1, Math.min(20, Number(document.getElementById('newClientCount')?.value) || 1));
  const domain = document.getElementById('newClientEndpoint')?.value === 'Домен'
    ? (document.getElementById('newClientDomain')?.value.trim() || '')
    : '';
  closeClientModal();
  showToast('Клиент создан: ' + name + (count > 1 ? ` · ${count} шт.` : '') + (domain ? ` · ${domain}` : ''));
}
function openPasswordModal() {
  const modal = document.getElementById('passwordModal');
  if (!modal) return;
  modal.hidden = false;
  setTimeout(() => document.getElementById('pwdNew')?.focus(), 0);
}
function closePasswordModal() {
  const modal = document.getElementById('passwordModal');
  if (modal) modal.hidden = true;
}
function changePassword() {
  const current = document.getElementById('pwdCurrent')?.value || '';
  const next = document.getElementById('pwdNew')?.value || '';
  const repeat = document.getElementById('pwdRepeat')?.value || '';
  if (!current) { showToast('Введите текущий пароль'); return; }
  if (next.length < 12) { showToast('Новый пароль — минимум 12 символов'); return; }
  if (next !== repeat) { showToast('Пароли не совпадают'); return; }
  closePasswordModal();
  showToast('Пароль изменён (демо)');
}
function logout() {
  closeClientModal();
  closePasswordModal();
  showToast('Вы вышли из панели (демо)');
}

function openModuleModal(id) {
  const def = MODULE_DEFS[id];
  if (!def) return;
  state.module = id;
  const title = document.getElementById('moduleModalTitle');
  const sub = document.getElementById('moduleModalSub');
  const body = document.getElementById('moduleModalBody');
  if (title) title.textContent = def.title + ' · параметры';
  if (sub) sub.textContent = def.sub;
  if (body) body.innerHTML = def.body();
  const modal = document.getElementById('moduleModal');
  if (modal) modal.hidden = false;
}
function closeModuleModal() {
  const modal = document.getElementById('moduleModal');
  if (modal) modal.hidden = true;
}
function openTextModal(kind) {
  state.textKind = kind || 'obf';
  const titles = {
    obf: 'Обфускация · вставить текстом',
    'client-obf': 'Обфускация клиентов · вставить текстом',
    awg: 'AmneziaWG · вставить конфиг',
    cascade: 'EU-туннель · вставить конфиг',
    adguard: 'AdGuard · вставить команду или параметры',
    telemt: 'Telemt · вставить ссылку',
    mtproxyl: 'MTProxyL · вставить параметры'
  };
  const title = document.getElementById('textModalTitle');
  const textarea = document.getElementById('textImport');
  if (title) title.textContent = titles[state.textKind] || 'Вставить текстом';
  if (textarea) {
    textarea.value = TEXT_PRESETS[state.textKind] ? TEXT_PRESETS[state.textKind]() : '';
    textarea.placeholder = state.textKind === 'obf' || state.textKind === 'client-obf' || state.textKind === 'awg'
      ? 'Вставьте .conf, JSON или vpn:// — панель проверит параметры'
      : 'Вставьте текст сюда…';
  }
  const modal = document.getElementById('textModal');
  if (modal) modal.hidden = false;
  setTimeout(() => textarea && textarea.focus(), 0);
}
function closeTextModal() {
  const modal = document.getElementById('textModal');
  if (modal) modal.hidden = true;
}
async function pasteClipboard() {
  const textarea = document.getElementById('textImport');
  if (!textarea) return;
  try {
    textarea.value = await navigator.clipboard.readText();
    showToast('Вставлено из буфера');
  } catch (e) {
    showToast('Браузер не дал доступ к буферу — вставьте вручную');
    textarea.focus();
  }
}
async function pasteToTarget(targetId) {
  const target = document.getElementById(targetId);
  if (!target) return;
  try {
    target.value = await navigator.clipboard.readText();
    showToast('Вставлено из буфера');
  } catch (e) {
    showToast('Браузер не дал доступ к буферу — вставьте вручную');
    target.focus();
  }
}
function clearTarget(targetId) {
  const target = document.getElementById(targetId);
  if (target) target.value = '';
  showToast('Поле очищено');
}
function copyTextarea() {
  const textarea = document.getElementById('textImport');
  if (!textarea || !textarea.value.trim()) { showToast('Поле пустое'); return; }
  copyText(textarea.value);
}
function copyTextPreset(kind) {
  const preset = TEXT_PRESETS[kind];
  if (!preset) { showToast('Нет данных для копирования'); return; }
  copyText(preset());
}
function applyText() {
  const textarea = document.getElementById('textImport');
  const text = textarea ? textarea.value.trim() : '';
  if (!text) { showToast('Вставьте текст'); return; }
  const labels = { obf: 'Обфускация', 'client-obf': 'Обфускация клиентов', awg: 'AmneziaWG', cascade: 'EU-туннель', adguard: 'AdGuard', telemt: 'Telemt', mtproxyl: 'MTProxyL' };
  showToast((labels[state.textKind] || 'Текст') + ': проверено и применено (демо)');
  closeTextModal();
}
function analyzeObf() {
  const textarea = document.getElementById('obfImportText');
  const preview = document.getElementById('obfPreview');
  if (!textarea || !textarea.value.trim()) { showToast('Вставьте конфиг или JSON'); return; }
  const lines = textarea.value.split('\n').filter(Boolean).length;
  const hasHpk = /HeaderProtectionKey/i.test(textarea.value);
  const hasI = /^I[1-5]\s*=/mi.test(textarea.value);
  if (preview) preview.innerHTML = `<b>Проверено:</b> AWG 3.1 · строк ${lines} · HPK ${hasHpk ? 'есть' : 'нет'} · I-цепочки ${hasI ? 'есть' : 'нет'} · оценка ${hasHpk && hasI ? '96' : '78'}/100`;
  showToast('Конфиг проверен');
}
function applyObfImport() {
  const textarea = document.getElementById('obfImportText');
  if (!textarea || !textarea.value.trim()) { showToast('Вставьте конфиг или JSON'); return; }
  analyzeObf();
  showToast('Импорт применён: клиенты будут перегенерированы');
}
function openPageSettings(tab) {
  const def = PAGE_SETTINGS[tab || state.tab];
  if (!def) return;
  state.pageSettingsTab = tab || state.tab;
  const title = document.getElementById('pageSettingsTitle');
  const sub = document.getElementById('pageSettingsSub');
  const body = document.getElementById('pageSettingsBody');
  if (title) title.textContent = def.title;
  if (sub) sub.textContent = def.sub + ' · расширенный режим';
  if (body) body.innerHTML = def.body();
  const modal = document.getElementById('pageSettingsModal');
  if (modal) modal.hidden = false;
}
function closePageSettings() {
  const modal = document.getElementById('pageSettingsModal');
  if (modal) modal.hidden = true;
}
function savePageSettings() {
  closePageSettings();
  showToast('Настройки страницы сохранены (демо)');
}
function openDeleteModal(key) {
  let def = DELETE_TARGETS[key];
  if (!def) {
    const [type, name] = String(key || '').split(':');
    const labels = { client: 'клиента', user: 'пользователя прокси', site: 'сайт', profile: 'профиль', backup: 'бэкап', cert: 'сертификат' };
    def = {
      title: `Удалить ${labels[type] || 'запись'}${name ? ' ' + name : ''}?`,
      warning: 'Действие необратимо. Связанные ключи и ссылки перестанут работать.',
      message: `${name || 'Запись'} удалён (демо)`
    };
  }
  const title = document.getElementById('deleteModalTitle');
  const sub = document.getElementById('deleteModalSub');
  const input = document.getElementById('deleteConfirmInput');
  state.deleteMessage = def.message;
  if (title) title.textContent = def.title;
  if (sub) sub.textContent = def.warning;
  if (input) input.value = '';
  const modal = document.getElementById('deleteModal');
  if (modal) modal.hidden = false;
  setTimeout(() => input && input.focus(), 0);
}
function closeDeleteModal() {
  const modal = document.getElementById('deleteModal');
  if (modal) modal.hidden = true;
}
function confirmDelete() {
  const input = document.getElementById('deleteConfirmInput');
  if (!input || input.value.trim() !== 'DELETE') {
    showToast('Введите DELETE для подтверждения');
    return;
  }
  closeDeleteModal();
  showToast(state.deleteMessage || 'Удалено (демо)');
}
function moduleSave() {
  closeModuleModal();
  showToast('Параметры модуля сохранены (демо)');
}
function setWarpRoutes(preset) {
  const defaults = preset === 'default' ? WARP_DEFAULTS : null;
  $$('[data-route]').forEach(input => {
    const [id, dir] = input.dataset.route.split(':');
    const target = defaults ? defaults[id] : (preset === 'ai-warp' ? 'warp' : 'direct');
    input.checked = dir === target;
  });
  const label = preset === 'default' ? 'маршруты по инструкции' : preset === 'ai-warp' ? 'все AI через WARP' : 'все AI напрямую';
  showToast('Применено: ' + label);
}
function moduleInstall(id) {
  const name = MODULE_DEFS[id] ? MODULE_DEFS[id].title : id;
  if (id === 'adguard') {
    openModuleModal('adguard');
    showToast('Автоматическая установка в разработке — доступна ручная команда на 3001');
    return;
  }
  closeModuleModal();
  showToast('Установка «' + name + '» запущена (демо)');
}
function toggleAdvanced() {
  state.advanced[state.tab] = !state.advanced[state.tab];
  const on = !!state.advanced[state.tab];
  render();
  showToast(on ? 'Экспертный режим включён' : 'Экспертный режим выключен');
  if (on) {
    const el = document.getElementById('advancedInline');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
function renderAdvancedInline() {
  const def = PAGE_SETTINGS[state.tab];
  if (!def || !state.advanced[state.tab]) return;
  const view = document.getElementById('view');
  if (!view) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = def.body();
  const sections = Array.from(tmp.querySelectorAll('.settings-section'));
  const wrap = document.createElement('div');
  wrap.id = 'advancedInline';
  wrap.className = 'advanced-inline-wrap';
  const head = document.createElement('div');
  head.className = 'advanced-head';
  head.innerHTML = `<div><b>${def.title}</b><span>${def.sub} · расширенный режим</span></div><div class="page-actions"><button class="btn btn-sm" data-action="toggle-advanced">${icon('wrench')}Скрыть</button></div>`;
  wrap.appendChild(head);
  if (sections.length) {
    sections.forEach(section => {
      const titleEl = section.querySelector('.settings-section-title');
      const title = titleEl ? titleEl.textContent : def.title;
      if (titleEl) titleEl.remove();
      const card = document.createElement('section');
      card.className = 'card advanced-inline';
      card.innerHTML = `<div class="card-top"><div><div class="card-title">${title}</div><div class="card-sub">${def.title} · расширенный режим</div></div><div class="page-actions">${tag('advanced', 'good')}</div></div>${section.innerHTML}`;
      wrap.appendChild(card);
    });
  } else {
    const card = document.createElement('section');
    card.className = 'card advanced-inline';
    card.innerHTML = `<div class="card-top"><div><div class="card-title">${def.title}</div><div class="card-sub">${def.sub}</div></div>${tag('advanced', 'good')}</div>${def.body()}`;
    wrap.appendChild(card);
  }
  const save = document.createElement('section');
  save.className = 'card advanced-inline advanced-save';
  save.innerHTML = `<div class="page-actions"><button class="btn btn-primary" data-toast="Расширенные настройки сохранены">${icon('check')}Сохранить</button><button class="btn" data-action="toggle-advanced">${icon('wrench')}Скрыть</button></div>`;
  wrap.appendChild(save);
  const footnote = view.querySelector('.footnote');
  if (footnote) footnote.before(wrap); else view.appendChild(wrap);
}
function decoratePageHead() {
  const host = document.querySelector('#view .page-head .page-actions') || document.querySelector('#view .overview-actions');
  if (!host || host.querySelector('[data-action="toggle-advanced"]')) return;
  const active = !!state.advanced[state.tab];
  host.insertAdjacentHTML('beforeend', `<button class="btn btn-sm page-settings-btn ${active ? 'on' : ''}" data-action="toggle-advanced" title="Расширенные настройки страницы">${icon('wrench')}${active ? 'Скрыть' : 'Настройки'}</button>`);
}

document.addEventListener('click', event => {
  const themeBtn = event.target.closest('[data-theme-set]');
  if (themeBtn) { setTheme(themeBtn.dataset.themeSet); return; }
  const tabBtn = event.target.closest('[data-tab]');
  if (tabBtn) { state.tab = tabBtn.dataset.tab; render(); if (typeof ensureTabData === 'function') ensureTabData(state.tab); window.scrollTo(0, 0); return; }
  const copyBtn = event.target.closest('[data-copy]');
  if (copyBtn) { event.preventDefault(); copyText(copyBtn.dataset.copy); return; }
  const toastBtn = event.target.closest('[data-toast]');
  if (toastBtn) { showToast(toastBtn.dataset.toast); return; }
  const actionBtn = event.target.closest('[data-action]');
  if (!actionBtn) return;
  const action = actionBtn.dataset.action;
  if (action === 'open-client-modal') openClientModal();
  else if (action === 'close-modal') closeClientModal();
  else if (action === 'create-client') createClient();
  else if (action === 'open-password-modal') openPasswordModal();
  else if (action === 'close-password-modal') closePasswordModal();
  else if (action === 'change-password') changePassword();
  else if (action === 'logout') logout();
  else if (action === 'module-settings') openModuleModal(actionBtn.dataset.module);
  else if (action === 'module-install') moduleInstall(actionBtn.dataset.module);
  else if (action === 'module-save') moduleSave();
  else if (action === 'warp-routes') setWarpRoutes(actionBtn.dataset.preset);
  else if (action === 'close-module-modal') closeModuleModal();
  else if (action === 'open-text-modal') openTextModal(actionBtn.dataset.text);
  else if (action === 'close-text-modal') closeTextModal();
  else if (action === 'paste-clipboard') pasteClipboard();
  else if (action === 'copy-textarea') copyTextarea();
  else if (action === 'copy-text-preset') copyTextPreset(actionBtn.dataset.text);
  else if (action === 'apply-text') applyText();
  else if (action === 'paste-to-target') pasteToTarget(actionBtn.dataset.target);
  else if (action === 'clear-target') clearTarget(actionBtn.dataset.target);
  else if (action === 'analyze-obf') analyzeObf();
  else if (action === 'apply-obf-import') applyObfImport();
  else if (action === 'page-settings') openPageSettings(state.tab);
  else if (action === 'close-page-settings') closePageSettings();
  else if (action === 'save-page-settings') savePageSettings();
  else if (action === 'open-delete') openDeleteModal(actionBtn.dataset.delete);
  else if (action === 'toggle-advanced') toggleAdvanced();
  else if (action === 'close-delete-modal') closeDeleteModal();
  else if (action === 'confirm-delete') confirmDelete();
  else if (action === 'donut-role') { state.donutRole = actionBtn.dataset.role; render(); }
});

document.addEventListener('change', event => {
  const route = event.target.closest('[data-route]');
  if (route) {
    const [id, dir] = route.dataset.route.split(':');
    const other = document.querySelector(`[data-route="${id}:${dir === 'direct' ? 'warp' : 'direct'}"]`);
    if (route.checked) {
      if (other) other.checked = false;
    } else if (!other || !other.checked) {
      route.checked = true;
      showToast('Выберите хотя бы один маршрут');
      return;
    }
    showToast((route.checked ? 'Направление: ' : 'Снято: ') + route.parentElement.innerText.trim());
    return;
  }
  const sw = event.target.closest('[data-switch]');
  if (sw) showToast(sw.checked ? sw.dataset.on : sw.dataset.off);
});

document.addEventListener('click', event => {
  const chip = event.target.closest('.chips .chip');
  if (!chip) return;
  const group = chip.parentElement;
  if (group.dataset.range !== undefined || chip.hasAttribute('data-range')) {
    $$('.chip', group).forEach(c => c.classList.remove('on'));
    chip.classList.add('on');
  }
  if (chip.hasAttribute('data-traffic')) {
    const labels = { '1ч': 'Последний час', '24ч': 'Последние 24 часа', '7д': 'Последние 7 дней' };
    const label = document.getElementById('trafficPeriodLabel');
    if (label) label.textContent = labels[chip.textContent.trim()] || label.textContent;
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { closeClientModal(); closePasswordModal(); closeModuleModal(); closeTextModal(); closePageSettings(); closeDeleteModal(); }
});

document.addEventListener('DOMContentLoaded', () => {
  setTheme(state.theme);
  if (!window.__CARBON_API__) render();
});
