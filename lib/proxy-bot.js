'use strict';

/*
 * Telegram-бот Servpanel для управления пользователями MTProto-прокси.
 *
 * Работает поверх lib/proxy-users.js, поэтому одинаково обслуживает
 * MTProxyL и telemt. Запускается внутри процесса панели (long polling),
 * отдельная служба не нужна.
 *
 * Конфиг — .proxybot.json в DATA_DIR:
 *   { enabled, token, admins: ["123456789"], lastUpdateId }
 *
 * Бот отвечает только адресам из admins. Незнакомцу на /start он
 * показывает его Telegram ID, чтобы администратор мог его добавить.
 */

const fs = require('fs');

const API_BASE = 'https://api.telegram.org';
const MAX_MESSAGE = 3900;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function escHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v <= 0) return '0 Б';
    const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    let i = 0;
    let x = v;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
    return `${x >= 100 ? x.toFixed(0) : x.toFixed(x >= 10 ? 1 : 2)} ${units[i]}`;
}

function fmtRate(bps) {
    const v = Number(bps) || 0;
    if (v <= 0) return 'без лимита';
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 ? 1 : 0)} Мбит/с`;
    if (v >= 1000) return `${(v / 1000).toFixed(0)} кбит/с`;
    return `${v} бит/с`;
}

function fmtDate(value) {
    if (!value) return 'бессрочно';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toISOString().slice(0, 10);
}

function fmtUptime(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return `${d} д ${h} ч`;
    if (h) return `${h} ч ${m} мин`;
    return `${m} мин`;
}

function parseArgs(text) {
    const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
    const positional = [];
    const options = {};
    for (const token of tokens) {
        const m = token.match(/^([a-zA-Z_]+)=(.*)$/);
        if (m) options[m[1].toLowerCase()] = m[2];
        else positional.push(token);
    }
    return { positional, options };
}

function toInt(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function userLimits(user) {
    const parts = [];
    parts.push(`соединений: ${user.max_tcp_conns == null ? '∞' : user.max_tcp_conns}`);
    parts.push(`IP: ${user.max_unique_ips == null ? '∞' : user.max_unique_ips}`);
    parts.push(`квота: ${user.data_quota_bytes == null ? '∞' : fmtBytes(user.data_quota_bytes)}`);
    parts.push(`срок: ${fmtDate(user.expiration_rfc3339)}`);
    if (user.rate_limit_down_bps || user.rate_limit_up_bps) {
        parts.push(`скорость: ↑ ${fmtRate(user.rate_limit_up_bps)} / ↓ ${fmtRate(user.rate_limit_down_bps)}`);
    }
    return parts;
}

function userLinks(user) {
    const links = user && user.links;
    if (!links) return [];
    const out = [];
    for (const key of ['tls', 'secure', 'classic', 'web']) {
        if (Array.isArray(links[key])) out.push(...links[key]);
    }
    if (Array.isArray(links.tls_domains)) {
        for (const item of links.tls_domains) {
            if (item && item.link) out.push(item.link);
        }
    }
    return [...new Set(out.filter(Boolean))];
}

function createProxyBot(options) {
    const configFile = options.configFile;
    const users = options.users;
    const log = options.log || (() => {});
    const pollTimeoutSec = 25;

    let cfg = load();
    let stopped = true;
    let running = false;
    let loopPromise = null;
    let controller = null;
    let lastError = '';
    let lastUpdateAt = 0;
    let botUsername = '';

    function load() {
        try {
            const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
            return {
                enabled: raw.enabled === true,
                token: typeof raw.token === 'string' ? raw.token : '',
                admins: Array.isArray(raw.admins) ? raw.admins.map(String).filter(Boolean) : [],
                lastUpdateId: Number(raw.lastUpdateId) || 0
            };
        } catch (e) {
            return { enabled: false, token: '', admins: [], lastUpdateId: 0 };
        }
    }

    function save() {
        try {
            fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
            try { fs.chmodSync(configFile, 0o600); } catch (e) { /* ignore */ }
        } catch (e) {
            log('proxy-bot: не удалось сохранить конфиг — ' + e.message);
        }
    }

    function tokenValid(token) {
        return /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(String(token || ''));
    }

    async function tg(method, params, timeoutMs = 15000) {
        if (!cfg.token) throw new Error('токен бота не задан');
        const local = new AbortController();
        controller = local;
        const timer = setTimeout(() => local.abort(), timeoutMs);
        try {
            const res = await fetch(`${API_BASE}/bot${cfg.token}/${method}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params || {}),
                signal: local.signal
            });
            const text = await res.text();
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
            if (!json || json.ok !== true) {
                const desc = (json && json.description) || `HTTP ${res.status}`;
                throw new Error(desc);
            }
            return json.result;
        } finally {
            clearTimeout(timer);
            if (controller === local) controller = null;
        }
    }

    async function send(chatId, html) {
        const text = String(html || '').trim();
        if (!text) return;
        const chunks = [];
        let rest = text;
        while (rest.length > MAX_MESSAGE) {
            let cut = rest.lastIndexOf('\n', MAX_MESSAGE);
            if (cut < MAX_MESSAGE * 0.5) cut = MAX_MESSAGE;
            chunks.push(rest.slice(0, cut));
            rest = rest.slice(cut).replace(/^\n+/, '');
        }
        if (rest) chunks.push(rest);
        for (const chunk of chunks) {
            await tg('sendMessage', {
                chat_id: chatId,
                text: chunk,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            });
        }
    }

    function isAdmin(userId) {
        return cfg.admins.includes(String(userId));
    }

    function helpText() {
        return [
            '<b>Servpanel · MTProto</b>',
            '',
            'Команды:',
            '/status — состояние прокси',
            '/users — список пользователей',
            '/user <code>имя</code> — карточка и ссылки',
            '/link <code>имя</code> — ссылка для подключения',
            '/add <code>имя</code> [conns=8] [ips=3] [quota=50] [days=30] [up=10] [down=20] [tag=hex] [note=…]',
            '/del <code>имя</code> — удалить',
            '/enable <code>имя</code> · /disable <code>имя</code>',
            '/rotate <code>имя</code> — новый секрет',
            '/reset <code>имя</code> — сбросить квоту',
            '/restart — перезапустить движок',
            '',
            'quota — в ГБ, up/down — в Мбит/с, days — срок в днях.'
        ].join('\n');
    }

    async function cmdStatus(chatId) {
        const st = await users.status();
        if (st.backend === 'none' || st.backend === 'zig') {
            return send(chatId, `Прокси не найден: ${escHtml(st.reason || st.backend)}`);
        }
        if (st.error) {
            return send(chatId, `Ошибка прокси: ${escHtml(st.error)}`);
        }
        const list = await users.listUsers().catch(() => []);
        const lines = [
            '<b>Состояние прокси</b>',
            `Движок: <code>${escHtml(st.backend)}</code> ${escHtml(st.version || '')}`,
            `Порт: <code>${escHtml(st.port || '—')}</code>${st.domain ? ' · ' + escHtml(st.domain) : ''}`,
            `Пользователей: <b>${list.length}</b> · онлайн: ${list.filter(u => u.current_connections > 0).length}`,
            `Соединений: ${st.connections || 0} · IP: ${st.uniqueIps || 0}`,
            `Трафик: ${fmtBytes(st.trafficTotal)}`,
            `Uptime: ${fmtUptime(st.uptime)}`
        ];
        return send(chatId, lines.join('\n'));
    }

    async function cmdUsers(chatId) {
        const list = await users.listUsers();
        if (!list.length) return send(chatId, 'Пользователей пока нет. Добавьте: /add имя');
        const shown = list.slice(0, 40);
        const lines = [`<b>Пользователи</b> (${list.length})`, ''];
        for (const u of shown) {
            const mark = u.enabled === false ? '⛔' : (u.current_connections > 0 ? '🟢' : '⚪');
            const extra = [];
            if (u.max_unique_ips != null) extra.push(`${u.max_unique_ips} IP`);
            if (u.data_quota_bytes != null) extra.push(fmtBytes(u.data_quota_bytes));
            if (u.expiration_rfc3339) extra.push(fmtDate(u.expiration_rfc3339));
            lines.push(`${mark} <code>${escHtml(u.username)}</code>${extra.length ? ' · ' + escHtml(extra.join(' · ')) : ''}`);
        }
        if (list.length > shown.length) lines.push(`… и ещё ${list.length - shown.length}`);
        return send(chatId, lines.join('\n'));
    }

    async function cmdUser(chatId, name) {
        if (!name) return send(chatId, 'Укажите имя: /user alice');
        const list = await users.listUsers();
        const user = list.find(u => u.username === name);
        if (!user) return send(chatId, `Пользователь <code>${escHtml(name)}</code> не найден.`);
        const links = userLinks(user);
        const lines = [
            `<b>${escHtml(user.username)}</b> ${user.enabled === false ? '⛔ выключен' : '✅ включён'}`,
            `Подключений: ${user.current_connections || 0} · IP: ${user.active_unique_ips || 0}`,
            user.active_unique_ips_list && user.active_unique_ips_list.length
                ? `Адреса: <code>${escHtml(user.active_unique_ips_list.join(', '))}</code>` : '',
            `Трафик: ${fmtBytes((user.traffic && user.traffic.total_bytes) || user.total_octets)}`,
            userLimits(user).map(s => escHtml(s)).join(' · '),
            user.notes ? `Заметка: ${escHtml(user.notes)}` : '',
            links.length ? '\n' + links.map(l => `<code>${escHtml(l)}</code>`).join('\n') : ''
        ].filter(Boolean);
        return send(chatId, lines.join('\n'));
    }

    async function cmdLink(chatId, name) {
        if (!name) return send(chatId, 'Укажите имя: /link alice');
        const links = userLinks({ links: await users.userLinks(name) });
        if (!links.length) return send(chatId, 'Ссылок нет: проверьте имя и состояние пользователя.');
        return send(chatId, links.map(l => `<code>${escHtml(l)}</code>`).join('\n'));
    }

    async function cmdAdd(chatId, text) {
        const { positional, options } = parseArgs(text);
        const username = positional[0];
        if (!username) {
            return send(chatId, 'Формат: /add имя [conns=8] [ips=3] [quota=50] [days=30] [up=10] [down=20]');
        }
        const payload = { username };
        const conns = toInt(options.conns);
        const ips = toInt(options.ips);
        const quotaGb = toInt(options.quota);
        const days = toInt(options.days);
        const up = toInt(options.up);
        const down = toInt(options.down);
        if (conns !== null) payload.max_tcp_conns = conns;
        if (ips !== null) payload.max_unique_ips = ips;
        if (quotaGb !== null) payload.data_quota_bytes = quotaGb * 1024 ** 3;
        if (up !== null) payload.rate_limit_up_bps = up * 1_000_000;
        if (down !== null) payload.rate_limit_down_bps = down * 1_000_000;
        if (days !== null && days > 0) {
            payload.expiration_rfc3339 = new Date(Date.now() + days * 86400000)
                .toISOString().replace(/\.\d{3}Z$/, '+00:00');
        }
        if (options.tag) payload.user_ad_tag = options.tag;
        if (options.secret) payload.secret = options.secret;
        if (options.note) payload.notes = options.note;
        const created = await users.createUser(payload);
        const user = (created && created.user) || {};
        const secret = (created && created.secret) || user.secret || '';
        const links = userLinks(user);
        const lines = [
            `✅ Создан <b>${escHtml(username)}</b>`,
            `Секрет: <code>${escHtml(secret)}</code>`,
            userLimits(user).map(s => escHtml(s)).join(' · ')
        ];
        if (links.length) lines.push('', links.map(l => `<code>${escHtml(l)}</code>`).join('\n'));
        return send(chatId, lines.join('\n'));
    }

    async function cmdSimple(chatId, text, action, label) {
        const name = String(text || '').trim().split(/\s+/)[0];
        if (!name) return send(chatId, `Укажите имя: /${action} имя`);
        await users.userAction(name, action);
        return send(chatId, `${label}: <code>${escHtml(name)}</code>`);
    }

    async function cmdDelete(chatId, text) {
        const name = String(text || '').trim().split(/\s+/)[0];
        if (!name) return send(chatId, 'Укажите имя: /del имя');
        await users.deleteUser(name);
        return send(chatId, `🗑 Удалён <code>${escHtml(name)}</code>`);
    }

    async function cmdRotate(chatId, text) {
        const name = String(text || '').trim().split(/\s+/)[0];
        if (!name) return send(chatId, 'Укажите имя: /rotate имя');
        const data = await users.userAction(name, 'rotate-secret');
        const secret = (data && data.secret) || '';
        const links = userLinks((data && data.user) || {});
        const lines = [`🔄 Новый секрет <b>${escHtml(name)}</b>: <code>${escHtml(secret)}</code>`];
        if (links.length) lines.push('', links.map(l => `<code>${escHtml(l)}</code>`).join('\n'));
        return send(chatId, lines.join('\n'));
    }

    async function handleUpdate(update) {
        const message = update && update.message;
        if (!message || !message.text) return;
        const chatId = message.chat && message.chat.id;
        const fromId = message.from && message.from.id;
        if (!chatId || !fromId) return;
        lastUpdateAt = Date.now();

        const text = String(message.text).trim();
        if (!text.startsWith('/')) return;
        const firstSpace = text.search(/\s/);
        let command = (firstSpace === -1 ? text : text.slice(0, firstSpace)).toLowerCase();
        const rest = firstSpace === -1 ? '' : text.slice(firstSpace + 1).trim();
        command = command.replace(/@[A-Za-z0-9_]+$/, '');

        if (!cfg.admins.length) {
            return send(chatId, [
                'Бот ещё не настроен: в панели Servpanel → «Прокси» → «Telegram-бот» добавьте ваш ID администратором.',
                '',
                `Ваш Telegram ID: <code>${fromId}</code>`
            ].join('\n'));
        }
        if (!isAdmin(fromId)) {
            return send(chatId, `Нет доступа. Ваш Telegram ID: <code>${fromId}</code>`);
        }

        try {
            switch (command) {
                case '/start':
                case '/help':
                    return await send(chatId, helpText());
                case '/status':
                    return await cmdStatus(chatId);
                case '/users':
                    return await cmdUsers(chatId);
                case '/user':
                    return await cmdUser(chatId, rest.split(/\s+/)[0]);
                case '/link':
                    return await cmdLink(chatId, rest.split(/\s+/)[0]);
                case '/add':
                    return await cmdAdd(chatId, rest);
                case '/del':
                case '/delete':
                    return await cmdDelete(chatId, rest);
                case '/enable':
                    return await cmdSimple(chatId, rest, 'enable', '✅ Включён');
                case '/disable':
                    return await cmdSimple(chatId, rest, 'disable', '⛔ Выключен');
                case '/rotate':
                    return await cmdRotate(chatId, rest);
                case '/reset':
                    return await cmdSimple(chatId, rest, 'reset-quota', '♻️ Квота сброшена');
                case '/restart':
                    await users.restart();
                    return await send(chatId, '🔄 Движок перезапущен');
                default:
                    return await send(chatId, 'Неизвестная команда. /help');
            }
        } catch (e) {
            lastError = e.message;
            return send(chatId, `⚠️ ${escHtml(e.message || 'Ошибка')}`).catch(() => {});
        }
    }

    async function loop() {
        while (!stopped) {
            try {
                const updates = await tg('getUpdates', {
                    offset: cfg.lastUpdateId + 1,
                    timeout: pollTimeoutSec,
                    allowed_updates: ['message']
                }, (pollTimeoutSec + 10) * 1000);
                if (Array.isArray(updates) && updates.length) {
                    for (const update of updates) {
                        if (update.update_id > cfg.lastUpdateId) cfg.lastUpdateId = update.update_id;
                        await handleUpdate(update).catch(e => log('proxy-bot: ' + e.message));
                    }
                    save();
                }
                lastError = '';
            } catch (e) {
                if (stopped) break;
                lastError = e.message;
                log('proxy-bot: ' + e.message);
                await sleep(5000);
            }
        }
    }

    async function start() {
        if (running) return;
        cfg = load();
        if (!cfg.enabled || !tokenValid(cfg.token)) {
            running = false;
            return;
        }
        stopped = false;
        running = true;
        lastError = '';
        try {
            const me = await tg('getMe', {}, 10000);
            botUsername = (me && me.username) || '';
            log(`proxy-bot: @${botUsername} запущен`);
        } catch (e) {
            lastError = e.message;
            log('proxy-bot: не удалось проверить токен — ' + e.message);
            running = false;
            stopped = true;
            return;
        }
        loopPromise = loop();
        if (loopPromise && loopPromise.catch) loopPromise.catch(() => {});
    }

    async function stop() {
        stopped = true;
        running = false;
        if (controller) {
            try { controller.abort(); } catch (e) { /* ignore */ }
            controller = null;
        }
        if (loopPromise) {
            try { await loopPromise; } catch (e) { /* ignore */ }
            loopPromise = null;
        }
    }

    async function restart() {
        await stop();
        await start();
    }

    function status() {
        return {
            enabled: cfg.enabled,
            running,
            tokenSet: !!cfg.token,
            token: cfg.token,
            admins: cfg.admins.slice(),
            botUsername,
            lastError,
            lastUpdateAt
        };
    }

    async function update(patch) {
        const next = { ...cfg };
        if (patch && typeof patch === 'object') {
            if ('enabled' in patch) next.enabled = patch.enabled === true;
            if ('token' in patch) {
                const token = String(patch.token || '').trim();
                if (token && !tokenValid(token)) {
                    const e = new Error('Токен должен быть вида 123456789:AA...');
                    e.code = 'bad_token';
                    throw e;
                }
                if (token) next.token = token;
                if (patch.clearToken === true) next.token = '';
            }
            if ('admins' in patch) {
                const admins = Array.isArray(patch.admins) ? patch.admins : String(patch.admins || '').split(/[\s,;]+/);
                next.admins = admins.map(v => String(v).trim()).filter(v => /^\d{3,20}$/.test(v));
            }
            if ('lastUpdateId' in patch) next.lastUpdateId = Number(patch.lastUpdateId) || 0;
        }
        cfg = next;
        save();
        await restart();
        return status();
    }

    async function sendTest(text) {
        if (!tokenValid(cfg.token)) {
            const e = new Error('Сначала укажите токен бота');
            e.code = 'bad_token';
            throw e;
        }
        const target = cfg.admins[0];
        if (!target) {
            const e = new Error('Сначала добавьте хотя бы одного администратора');
            e.code = 'no_admins';
            throw e;
        }
        await send(target, text || '✅ <b>Servpanel</b>: бот на связи.');
        return { chatId: target };
    }

    return { start, stop, restart, status, update, sendTest, configFile };
}

module.exports = { createProxyBot };
