'use strict';

/*
 * Управление пользователями MTProto-прокси.
 *
 * Панель работает с двумя движками через один и тот же REST API:
 *
 *   • MTProxyL  — http://127.0.0.1:9190 (mtproxyl-api), ключ в
 *                 /etc/mtproxyl-api/servpanel.key;
 *   • telemt    — http://127.0.0.1:9091 ([server.api] в telemt.toml),
 *                 ключ берётся из auth_header этого же конфига.
 *
 * API MTProxyL совместим с API telemt: одинаковые пути, поля, конверты
 * {ok, data, revision} и коды ошибок. Поэтому адаптер один, различаются
 * только адрес, авторизация и источник статуса.
 *
 * MTProto.zig пользователей и лимиты не умеет — для него возвращается
 * backend 'zig' с capabilities.limits = false.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEMO = process.env.SERVEPANEL_DEMO === '1' || process.env.SERVPANEL_DEMO === '1';
const TEST = process.env.SERVEPANEL_TEST === '1';

const TIMEOUT_MS = 6000;
const DETECT_TTL_MS = 5000;

const MTPROXYL_URL = process.env.SERVEPANEL_MTPROXYL_URL || 'http://127.0.0.1:9190';
const TELEMT_URL = process.env.SERVEPANEL_TELEMT_URL || 'http://127.0.0.1:9091';
const MTPROXYL_KEY_FILES = [
    process.env.SERVEPANEL_MTPROXYL_KEY_FILE,
    '/etc/mtproxyl-api/servpanel.key',
    '/root/.servpanel-mtproxyl.key'
].filter(Boolean);
const TELEMT_CONFIGS = [
    process.env.SERVEPANEL_TELEMT_CONFIG,
    '/etc/telemt/telemt.toml',
    '/etc/telemt/config.toml',
    '/etc/telemt.toml',
    '/opt/telemt/telemt.toml',
    '/opt/telemt/config.toml',
    // Telemt, установленный и управляемый MTProxyL.
    '/opt/mtproxyl/mtproxy/telemt.toml',
    '/opt/mtproxyl/mtproxy/config.toml',
    '/opt/mtproxyl/telemt.toml'
].filter(Boolean);

// API telemt может слушать нестандартный порт: [server.api] port в конфиге.
// Без этого панель стучалась в 9091 по умолчанию и «не видела» прокси.
function telemtApiUrl() {
    const text = readFirst(TELEMT_CONFIGS);
    if (!text) return TELEMT_URL;
    const lines = text.split(/\r?\n/);
    let inApi = false;
    let host = '';
    let port = '';
    let tls = false;
    for (const line of lines) {
        const t = line.trim();
        if (/^\[/.test(t)) {
            inApi = /^\[server\.(api|admin_api)\]$/.test(t);
            continue;
        }
        if (!inApi) continue;
        let m = t.match(/^port\s*=\s*(\d{1,5})/);
        if (m) port = m[1];
        m = t.match(/^(?:addr|address|bind_host|listen|host)\s*=\s*"([^"]+)"/);
        if (m) host = m[1];
        if (/^tls\s*=\s*true/.test(t) || /^scheme\s*=\s*"https"/.test(t)) tls = true;
    }
    if (!port) return TELEMT_URL;
    const scheme = tls ? 'https' : 'http';
    const h = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    return `${scheme}://${h.includes(':') && !h.startsWith('[') ? '[' + h + ']' : h}:${Number(port)}`;
}

// Порт и FakeTLS-домен из конфига telemt: API не отдаёт их в /v1/system/info,
// поэтому карточка показывала «порт —» и пустой домен.
function telemtConfigMeta() {
    const text = readFirst(TELEMT_CONFIGS);
    if (!text) return { port: null, domain: '' };
    let section = '';
    let port = null;
    let domain = '';
    for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (/^\[/.test(t)) {
            section = t.replace(/^\[|\]$/g, '');
            continue;
        }
        if (section === 'server') {
            const m = t.match(/^port\s*=\s*(\d{1,5})/);
            if (m) port = Number(m[1]);
        } else if (section === 'censorship') {
            const m = t.match(/^tls_domain\s*=\s*"([^"]+)"/);
            if (m) domain = m[1];
        }
    }
    return { port, domain };
}

const MTPROXYL_BINARIES = ['/usr/local/bin/mtproxyl', '/opt/mtproxyl/mtproxyl.sh'];

let detectCache = { at: 0, value: null };

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

function readText(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}

function readFirst(fileList) {
    for (const file of fileList) {
        const text = readText(file);
        if (text) return text;
    }
    return '';
}

function stripAnsi(text) {
    return String(text || '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

function telemtAuthHeader() {
    const text = readFirst(TELEMT_CONFIGS);
    if (!text) return '';
    // Ищем [server.api] / [server.admin_api] и auth_header внутри секции.
    const lines = text.split(/\r?\n/);
    let inApi = false;
    for (const line of lines) {
        const t = line.trim();
        if (/^\[/.test(t)) {
            inApi = /^\[server\.(api|admin_api)\]$/.test(t);
            continue;
        }
        if (!inApi) continue;
        const m = t.match(/^auth_header\s*=\s*"([^"]*)"/);
        if (m) return m[1];
    }
    return '';
}

function findBinary() {
    for (const file of MTPROXYL_BINARIES) {
        if (fs.existsSync(file)) return file;
    }
    return '';
}

function zigInstalled() {
    const markers = [
        '/etc/systemd/system/mtproto.zig.service',
        '/etc/systemd/system/mtproto-zig.service',
        '/opt/mtproto.zig',
        '/etc/mtproto.zig'
    ];
    return markers.some(f => fs.existsSync(f));
}

async function httpJson(base, token, apiPath, options = {}) {
    const url = base.replace(/\/+$/, '') + apiPath;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || TIMEOUT_MS);
    try {
        const headers = { Accept: 'application/json' };
        if (token) headers.Authorization = token;
        if (options.body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(url, {
            method: options.method || 'GET',
            headers,
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: controller.signal
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
        return { status: res.status, json, text };
    } finally {
        clearTimeout(timer);
    }
}

function envelopeError(result, fallback) {
    const err = result && result.json && result.json.error;
    const code = (err && err.code) || (result && result.status === 401 ? 'unauthorized' : 'http_error');
    const message = (err && err.message) || fallback || `HTTP ${result && result.status}`;
    const e = new Error(message);
    e.code = code;
    e.status = result && result.status;
    return e;
}

// ---------------------------------------------------------------------------
// Демонстрационный бэкенд (скриншоты и локальный показ)
// ---------------------------------------------------------------------------

const demo = {
    users: new Map(),
    seq: 1,
    init() {
        const now = Math.floor(Date.now() / 1000);
        const add = (username, patch) => {
            const secret = (patch.secret || '').replace(/[^0-9a-f]/g, '').padEnd(32, '0').slice(0, 32);
            const user = {
                username,
                enabled: patch.enabled !== false,
                in_runtime: true,
                user_ad_tag: patch.user_ad_tag || null,
                max_tcp_conns: patch.max_tcp_conns ?? null,
                expiration_rfc3339: patch.expiration_rfc3339 || null,
                data_quota_bytes: patch.data_quota_bytes ?? null,
                rate_limit_up_bps: patch.rate_limit_up_bps ?? null,
                rate_limit_down_bps: patch.rate_limit_down_bps ?? null,
                max_unique_ips: patch.max_unique_ips ?? null,
                current_connections: patch.current_connections ?? 0,
                active_unique_ips: patch.active_unique_ips ?? 0,
                active_unique_ips_list: patch.active_unique_ips_list || [],
                recent_unique_ips: patch.active_unique_ips ?? 0,
                recent_unique_ips_list: patch.active_unique_ips_list || [],
                total_octets: patch.total_octets ?? 0,
                notes: patch.notes || '',
                created: patch.created || now - 86400 * 12,
                traffic: patch.traffic || { in_bytes: 0, out_bytes: 0, total_bytes: patch.total_octets || 0 },
                links: {
                    classic: [`tg://proxy?server=proxy.example.com&port=443&secret=${secret}`],
                    secure: [`tg://proxy?server=proxy.example.com&port=443&secret=dd${secret}`],
                    tls: [`tg://proxy?server=proxy.example.com&port=443&secret=ee${secret}${Buffer.from('demo.example.com').toString('hex')}`],
                    tls_domains: [],
                    web: []
                },
                secret
            };
            this.users.set(username, user);
            return user;
        };
        add('alice', {
            secret: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
            max_tcp_conns: 8,
            max_unique_ips: 3,
            data_quota_bytes: 50 * 1024 ** 3,
            expiration_rfc3339: new Date(Date.now() + 20 * 86400000).toISOString().replace('.000Z', '+00:00'),
            rate_limit_up_bps: 10_000_000,
            rate_limit_down_bps: 20_000_000,
            current_connections: 2,
            active_unique_ips: 2,
            active_unique_ips_list: ['203.0.113.24', '198.51.100.7'],
            total_octets: 12.4 * 1024 ** 3,
            notes: 'iPhone + MacBook',
            traffic: { in_bytes: 2.4 * 1024 ** 3, out_bytes: 10 * 1024 ** 3, total_bytes: 12.4 * 1024 ** 3 }
        });
        add('bob', {
            secret: '00112233445566778899aabbccddeeff',
            current_connections: 1,
            active_unique_ips: 1,
            active_unique_ips_list: ['192.0.2.44'],
            total_octets: 1.2 * 1024 ** 3,
            notes: 'Android TV',
            traffic: { in_bytes: 0.2 * 1024 ** 3, out_bytes: 1 * 1024 ** 3, total_bytes: 1.2 * 1024 ** 3 }
        });
        add('carol', {
            secret: 'ffeeddccbbaa99887766554433221100',
            enabled: false,
            max_unique_ips: 1,
            data_quota_bytes: 5 * 1024 ** 3,
            expiration_rfc3339: new Date(Date.now() - 3 * 86400000).toISOString().replace('.000Z', '+00:00'),
            total_octets: 5.1 * 1024 ** 3,
            notes: 'квота исчерпана',
            traffic: { in_bytes: 1.1 * 1024 ** 3, out_bytes: 4 * 1024 ** 3, total_bytes: 5.1 * 1024 ** 3 }
        });
    },
    nextSecret() {
        this.seq += 1;
        return (Date.now().toString(16) + String(this.seq).padStart(4, '0')).padEnd(32, '7').slice(0, 32);
    },
    user(username) {
        return this.users.get(String(username || ''));
    },
    publicUser(user) {
        return JSON.parse(JSON.stringify(user));
    }
};
demo.init();

// ---------------------------------------------------------------------------
// Определение бэкенда
// ---------------------------------------------------------------------------

function capabilitiesFor(backend) {
    const full = {
        users: true,
        limits: true,
        quota: true,
        rate: true,
        uniqueIps: true,
        connections: true,
        traffic: true,
        notes: false,
        expiry: true,
        adTag: true,
        web: false,
        restart: true
    };
    if (backend === 'mtproxyl') return { ...full, notes: true, web: true };
    if (backend === 'telemt') return { ...full };
    if (backend === 'demo') return { ...full, notes: true, web: true };
    return {
        users: false, limits: false, quota: false, rate: false, uniqueIps: false,
        connections: false, traffic: false, notes: false, expiry: false, adTag: false,
        web: false, restart: false
    };
}

async function probe(base, token) {
    try {
        const r = await httpJson(base, token, '/v1/health', { timeout: 2500 });
        if (r.status === 200 && r.json && r.json.ok) return true;
        if (r.status === 401) return 'unauthorized';
        return false;
    } catch (e) {
        return false;
    }
}

async function detect(force = false) {
    if (!force && detectCache.value && Date.now() - detectCache.at < DETECT_TTL_MS) {
        return detectCache.value;
    }

    let result;
    if (DEMO) {
        result = { backend: 'demo', url: '', token: '', limited: false, needsKey: false, capabilities: capabilitiesFor('demo') };
    } else if (TEST) {
        result = { backend: 'none', url: '', token: '', limited: true, needsKey: false, capabilities: capabilitiesFor('none'), reason: 'test' };
    } else {
        result = await detectReal();
    }
    detectCache = { at: Date.now(), value: result };
    return result;
}

async function detectReal() {
    const mtKey = readFirst(MTPROXYL_KEY_FILES).trim();
    if (mtKey) {
        const health = await probe(MTPROXYL_URL, `Bearer ${mtKey}`);
        if (health === true) {
            return {
                backend: 'mtproxyl', url: MTPROXYL_URL, token: `Bearer ${mtKey}`,
                limited: false, needsKey: false, capabilities: capabilitiesFor('mtproxyl')
            };
        }
    }

    // Порядок: адрес из конфига telemt, затем стандартный 9091.
    const telemtToken = telemtAuthHeader();
    const telemtCandidates = [...new Set([telemtApiUrl(), TELEMT_URL])];
    for (const url of telemtCandidates) {
        if (await probe(url, telemtToken)) {
            return {
                backend: 'telemt', url, token: telemtToken,
                limited: false, needsKey: false, capabilities: capabilitiesFor('telemt')
            };
        }
    }

    if (findBinary()) {
        return {
            backend: 'mtproxyl', url: MTPROXYL_URL, token: '', limited: true, needsKey: true,
            capabilities: capabilitiesFor('mtproxyl'),
            reason: 'MTProxyL установлен, но API панели ещё не подключён'
        };
    }

    if (zigInstalled()) {
        return {
            backend: 'zig', url: '', token: '', limited: true, needsKey: false,
            capabilities: capabilitiesFor('zig'),
            reason: 'MTProto.zig не поддерживает нескольких пользователей и лимиты'
        };
    }

    // Прокси мог быть установлен вручную (MEKO/telemt из исходников): конфиг
    // или служба есть, а API выключен. Говорим об этом прямо, вместо
    // «прокси не найден», хотя клиенты в панели есть.
    const telemtCfg = TELEMT_CONFIGS.find(f => {
        try { return fs.statSync(f).isFile(); } catch (e) { return false; }
    });
    if (telemtCfg) {
        return {
            backend: 'telemt', url: telemtApiUrl(), token: telemtAuthHeader() || '', limited: true, needsKey: false,
            capabilities: capabilitiesFor('telemt'),
            reason: 'Telemt установлен (' + telemtCfg + '), но его API не отвечает. ' +
                'Включите [server.api] в конфиге telemt (partner_id/port) и перезапустите службу — ' +
                'тогда здесь появятся пользователи и лимиты.'
        };
    }

    return {
        backend: 'none', url: '', token: '', limited: true, needsKey: false,
        capabilities: capabilitiesFor('none'),
        reason: 'MTProto-прокси не найден'
    };
}

// ---------------------------------------------------------------------------
// Универсальный вызов API
// ---------------------------------------------------------------------------

async function call(apiPath, options = {}) {
    const d = await detect();
    if (d.backend === 'none' || d.backend === 'zig') {
        const e = new Error(d.reason || 'Прокси не найден');
        e.code = 'no_backend';
        throw e;
    }
    if (d.needsKey) {
        const e = new Error('Нужен ключ API MTProxyL для панели');
        e.code = 'needs_key';
        throw e;
    }
    const r = await httpJson(d.url, d.token, apiPath, options);
    if (!r.json) throw envelopeError(r, 'Прокси вернул пустой ответ');
    if (r.status >= 400 || r.json.ok === false) throw envelopeError(r, 'Ошибка прокси');
    return r.json;
}

// ---------------------------------------------------------------------------
// Демонстрационная реализация API
// ---------------------------------------------------------------------------

function demoCall(apiPath, options = {}) {
    const method = options.method || 'GET';
    const body = options.body || {};
    const m = apiPath.match(/^\/v1\/users(?:\/([^/]+))?(?:\/(enable|disable|rotate-secret|reset-quota|reset-traffic|links))?$/);
    if (apiPath === '/v1/health') return { ok: true, data: { status: 'ok', read_only: false, api_version: 'demo' } };
    if (apiPath === '/v1/status') {
        const users = [...demo.users.values()];
        return {
            ok: true,
            data: {
                version: '2.8.0-demo', mode: 'manager', status: 'running', port: 443,
                domain: 'proxy.example.com', uptime: 86400 * 3,
                connections: users.reduce((s, u) => s + (u.current_connections || 0), 0),
                unique_ips: users.reduce((s, u) => s + (u.active_unique_ips || 0), 0),
                traffic_total: users.reduce((s, u) => s + (u.traffic.total_bytes || 0), 0),
                web: { enabled: false }
            }
        };
    }
    if (apiPath === '/v1/proxy/restart') return { ok: true, data: { restarted: true } };

    if (!m) {
        const e = new Error('Демо: неизвестный маршрут ' + apiPath);
        e.code = 'not_found';
        throw e;
    }
    const [, name, action] = m;

    if (!name) {
        if (method === 'GET') {
            return { ok: true, data: [...demo.users.values()].map(u => demo.publicUser(u)).sort((a, b) => a.username.localeCompare(b.username)) };
        }
        if (method === 'POST') {
            const username = String(body.username || '').trim();
            if (!username) { const e = new Error('Не указано имя пользователя'); e.code = 'bad_request'; throw e; }
            if (demo.users.has(username)) { const e = new Error('Пользователь уже существует'); e.code = 'user_exists'; throw e; }
            const secret = String(body.secret || demo.nextSecret()).toLowerCase();
            const created = {
                username, enabled: body.enabled !== false, in_runtime: true,
                user_ad_tag: body.user_ad_tag || null,
                max_tcp_conns: body.max_tcp_conns ?? null,
                expiration_rfc3339: body.expiration_rfc3339 || null,
                data_quota_bytes: body.data_quota_bytes ?? null,
                rate_limit_up_bps: body.rate_limit_up_bps ?? null,
                rate_limit_down_bps: body.rate_limit_down_bps ?? null,
                max_unique_ips: body.max_unique_ips ?? null,
                current_connections: 0, active_unique_ips: 0, active_unique_ips_list: [],
                recent_unique_ips: 0, recent_unique_ips_list: [], total_octets: 0,
                notes: body.notes || '', created: Math.floor(Date.now() / 1000),
                traffic: { in_bytes: 0, out_bytes: 0, total_bytes: 0 },
                links: {
                    classic: [`tg://proxy?server=proxy.example.com&port=443&secret=${secret}`],
                    secure: [`tg://proxy?server=proxy.example.com&port=443&secret=dd${secret}`],
                    tls: [`tg://proxy?server=proxy.example.com&port=443&secret=ee${secret}${Buffer.from('demo.example.com').toString('hex')}`],
                    tls_domains: [], web: []
                },
                secret
            };
            demo.users.set(username, created);
            return { ok: true, data: { user: demo.publicUser(created), secret }, revision: 'demo' };
        }
    }

    const user = demo.users.get(name);
    if (!user) { const e = new Error('Пользователь не найден'); e.code = 'not_found'; throw e; }

    if (method === 'GET') return { ok: true, data: demo.publicUser(user) };
    if (method === 'DELETE') {
        demo.users.delete(name);
        return { ok: true, data: { username: name, in_runtime: false }, revision: 'demo' };
    }
    if (method === 'PATCH') {
        const fields = ['max_tcp_conns', 'max_unique_ips', 'data_quota_bytes', 'expiration_rfc3339', 'user_ad_tag', 'rate_limit_up_bps', 'rate_limit_down_bps', 'notes'];
        for (const f of fields) {
            if (!(f in body)) continue;
            user[f] = body[f] === null || body[f] === '' ? null : body[f];
        }
        if ('enabled' in body) user.enabled = body.enabled !== false;
        if (body.secret) user.secret = String(body.secret).toLowerCase();
        return { ok: true, data: demo.publicUser(user), revision: 'demo' };
    }
    if (method === 'POST' && action) {
        if (action === 'enable') user.enabled = true;
        if (action === 'disable') user.enabled = false;
        if (action === 'rotate-secret') {
            user.secret = String(body.secret || demo.nextSecret()).toLowerCase();
            return { ok: true, data: { user: demo.publicUser(user), secret: user.secret }, revision: 'demo' };
        }
        if (action === 'reset-quota') return { ok: true, data: { username: name, used_bytes: 0, last_reset_epoch_secs: Math.floor(Date.now() / 1000) } };
        if (action === 'reset-traffic') {
            user.traffic = { in_bytes: 0, out_bytes: 0, total_bytes: 0 };
            user.total_octets = 0;
            return { ok: true, data: { username: name, traffic: user.traffic } };
        }
        if (action === 'links') return { ok: true, data: { username: name, links: user.links } };
        return { ok: true, data: demo.publicUser(user) };
    }
    const e = new Error('Демо: неподдерживаемый метод');
    e.code = 'bad_request';
    throw e;
}

async function api(apiPath, options = {}) {
    const d = await detect();
    if (d.backend === 'demo') return demoCall(apiPath, options);
    return call(apiPath, options);
}

// ---------------------------------------------------------------------------
// Публичные операции
// ---------------------------------------------------------------------------

let lastStatus = { at: 0, value: null };

async function statusUncached() {
    const d = await detect(true);
    const base = {
        backend: d.backend,
        limited: d.limited,
        needsKey: !!d.needsKey,
        capabilities: d.capabilities,
        reason: d.reason || ''
    };
    if (d.backend === 'none' || d.backend === 'zig') return base;
    if (d.needsKey) return base;

    try {
        if (d.backend === 'mtproxyl') {
            const r = await api('/v1/status');
            const s = r.data || {};
            return {
                ...base,
                version: s.version || '',
                mode: s.mode || 'manager',
                running: s.status === 'running',
                port: s.port || null,
                domain: s.domain || '',
                uptime: s.uptime || 0,
                connections: s.connections || 0,
                uniqueIps: s.unique_ips || 0,
                trafficTotal: s.traffic_total || 0,
                trafficIn: s.traffic_in || 0,
                trafficOut: s.traffic_out || 0,
                web: s.web || null
            };
        }
        if (d.backend === 'demo') {
            const r = await api('/v1/status');
            const s = r.data || {};
            return {
                ...base,
                version: s.version, mode: s.mode, running: true, port: s.port, domain: s.domain,
                uptime: s.uptime, connections: s.connections, uniqueIps: s.unique_ips,
                trafficTotal: s.traffic_total, web: s.web
            };
        }
        // telemt
        const info = (await api('/v1/system/info')).data || {};
        const summary = (await api('/v1/stats/summary').catch(() => null));
        const sum = (summary && summary.data) || {};
        const meta = telemtConfigMeta();
        return {
            ...base,
            version: info.version || '',
            mode: 'telemt',
            running: true,
            port: meta.port,
            domain: meta.domain,
            uptime: info.uptime_seconds || 0,
            connections: sum.connections_total || 0,
            uniqueIps: 0,
            trafficTotal: 0,
            users: sum.configured_users || 0,
            configPath: info.config_path || ''
        };
    } catch (e) {
        return { ...base, error: e.message, errorCode: e.code || '' };
    }
}

// Последний известный результат нужен карточке «MTProto-прокси»: у telemt из
// MTProxyL нет systemd-юнита, и без этого модуль показывал «не запущен»,
// хотя API отвечает и клиенты работают.
async function status() {
    const value = await statusUncached();
    lastStatus = { at: Date.now(), value };
    return value;
}

function cachedStatus(maxAgeMs = 120000) {
    if (!lastStatus.value) return null;
    if (Date.now() - lastStatus.at > maxAgeMs) return null;
    return lastStatus.value;
}

async function listUsers() {
    const r = await api('/v1/users');
    return Array.isArray(r.data) ? r.data : [];
}

async function createUser(payload) {
    const r = await api('/v1/users', { method: 'POST', body: payload });
    return r.data;
}

async function patchUser(username, patch) {
    const r = await api(`/v1/users/${encodeURIComponent(username)}`, { method: 'PATCH', body: patch });
    return r.data;
}

async function deleteUser(username) {
    const r = await api(`/v1/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
    return r.data;
}

async function userAction(username, action, body) {
    const allowed = ['enable', 'disable', 'rotate-secret', 'reset-quota', 'reset-traffic'];
    if (!allowed.includes(action)) {
        const e = new Error('Неизвестное действие');
        e.code = 'bad_request';
        throw e;
    }
    const r = await api(`/v1/users/${encodeURIComponent(username)}/${action}`, {
        method: 'POST',
        body: body === undefined ? undefined : body
    });
    return r.data;
}

async function userLinks(username) {
    const d = await detect();
    if (d.backend === 'mtproxyl' || d.backend === 'demo') {
        const r = await api(`/v1/users/${encodeURIComponent(username)}/links`);
        return (r.data && r.data.links) || {};
    }
    const r = await api(`/v1/users/${encodeURIComponent(username)}`);
    return (r.data && r.data.links) || {};
}

async function restart() {
    const d = await detect();
    if (d.backend === 'mtproxyl' || d.backend === 'demo') {
        const r = await api('/v1/proxy/restart', { method: 'POST', body: {} });
        return r.data;
    }
    if (d.backend === 'telemt') {
        const r = await api('/v1/system/reload', { method: 'POST', body: {} });
        return r.data;
    }
    const e = new Error('Прокси не найден');
    e.code = 'no_backend';
    throw e;
}

// ---------------------------------------------------------------------------
// Ключ API MTProxyL для панели
// ---------------------------------------------------------------------------

function panelKeyPath() {
    return process.env.SERVEPANEL_MTPROXYL_KEY_FILE || '/etc/mtproxyl-api/servpanel.key';
}

function rotatePanelKey() {
    const bin = findBinary();
    if (!bin) {
        const e = new Error('MTProxyL не установлен');
        e.code = 'no_backend';
        throw e;
    }
    let output = '';
    try {
        output = execFileSync(bin, ['api', 'key'], { timeout: 90000, encoding: 'utf8' });
    } catch (e) {
        const err = new Error('Не удалось выдать ключ API MTProxyL: ' + (e.message || 'ошибка'));
        err.code = 'api_key_failed';
        throw err;
    }
    const match = stripAnsi(output).match(/\b[0-9a-f]{64}\b/);
    if (!match) {
        const e = new Error('MTProxyL не вернул ключ API');
        e.code = 'api_key_failed';
        throw e;
    }
    const key = match[0];
    const file = panelKeyPath();
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, key + '\n', { mode: 0o600 });
        try { fs.chmodSync(file, 0o600); } catch (e) { /* ignore */ }
    } catch (e) {
        const err = new Error('Ключ получен, но не сохранён: ' + e.message);
        err.code = 'api_key_save_failed';
        err.key = key;
        throw err;
    }
    detectCache = { at: 0, value: null };
    return { saved: true, path: file };
}

// Диагностика: что панель проверяет, чтобы найти прокси и его API.
async function diagnose() {
    const checks = [];
    const found = (files) => files.filter(f => {
        try { return fs.statSync(f).isFile(); } catch (e) { return false; }
    });

    const keyFiles = found(MTPROXYL_KEY_FILES);
    checks.push({
        name: 'Ключ API MTProxyL',
        ok: keyFiles.length > 0,
        detail: keyFiles.length ? keyFiles.join(', ') : 'нет файла — нажмите «Выдать ключ API»'
    });

    const cfgFiles = found(TELEMT_CONFIGS);
    const token = telemtAuthHeader();
    checks.push({
        name: 'Конфиг telemt',
        ok: cfgFiles.length > 0,
        detail: cfgFiles.length ? cfgFiles[0] : 'нет файла'
    });
    checks.push({
        name: 'auth_header в [server.api]',
        ok: !!token,
        detail: token ? 'найден' : (cfgFiles.length ? 'секция API выключена или без ключа' : 'конфига нет')
    });

    const mtKey = keyFiles.length ? readTextSafe(keyFiles[0]).trim() : '';
    const targets = [];
    if (mtKey) targets.push({ name: 'MTProxyL API', url: MTPROXYL_URL, token: 'Bearer ' + mtKey });
    const telemtUrls = [...new Set([telemtApiUrl(), TELEMT_URL])];
    for (const url of telemtUrls) targets.push({ name: 'telemt API', url, token });

    for (const t of targets) {
        const h = await probe(t.url, t.token);
        checks.push({
            name: t.name,
            ok: h === true,
            detail: h === true ? t.url + ' — отвечает'
                : h === 'unauthorized' ? t.url + ' — 401, ключ не принят'
                : t.url + ' — нет ответа (служба выключена или другой порт)'
        });
    }

    const result = await detect(true);
    return {
        backend: result.backend,
        reason: result.reason || '',
        limited: !!result.limited,
        targets: targets.map(t => ({ name: t.name, url: t.url })),
        checks
    };
}

module.exports = {
    detect,
    diagnose,
    detectCached: () => detectCache.value,
    cachedStatus,
    status,
    listUsers,
    createUser,
    patchUser,
    deleteUser,
    userAction,
    userLinks,
    restart,
    rotatePanelKey,
    panelKeyPath,
    capabilitiesFor
};
