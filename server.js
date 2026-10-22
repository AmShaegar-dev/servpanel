'use strict';

/*
 * Servpanel / FileManager 4.0 — backend
 * Управление AmneziaWG, каскадом (RU -> EU), AdGuard Home, UFW и DNS.
 *
 * Что переработано:
 *  - убран process.env.NODE_TLS_REJECT_UNAUTHORIZED
 *  - секрет сессии генерируется случайно (.secrets.json, 0600)
 *  - все внешние команды вызываются через execFile/execFileSync (без shell-инъекций)
 *  - валидация ВСЕХ пользовательских данных (интерфейсы, IP, порты, имена, URL, id)
 *  - whitelist путей для конфигов AWG, логов и восстановления из архива
 *  - защита от подбора пароля, SameSite-cookie, CSRF-проверка Origin, Security-headers
 *  - переименование клиентов, показ vpn://, импорт/экспорт обфускации (Архитектор),
 *    настройка каскада по CASCADE.md, прогресс установки, расширенный AdGuard.
 */

const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { exec, execFile, execFileSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const updater = require('./lib/updater');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const APP_DIR = __dirname;
// Каталог для изменяемых данных (секреты, сессии, пользователи, профили).
// По умолчанию — каталог панели; в тестах переопределяется переменной окружения.
const DATA_DIR = process.env.SERVEPANEL_DATA_DIR
    ? path.resolve(process.env.SERVEPANEL_DATA_DIR)
    : APP_DIR;
const TEST_MODE = process.env.SERVEPANEL_TEST === '1';
// Демонстрационный режим: панель работает с локальным файлом-макетом и не
// трогает systemd/AmneziaWG. Нужен только для скриншотов и локального показа.
const DEMO_MODE = process.env.SERVPANEL_DEMO === '1';
const AWG_DIR = '/root/awg';
const MANAGE = path.join(AWG_DIR, 'manage_amneziawg.sh');
const AWG_CONF_DIR = '/etc/amnezia/amneziawg';
const ROUTING_SCRIPT = path.join(AWG_DIR, 'awg-routing.sh');
const AUDIT_LOG = process.env.SERVEPANEL_AUDIT_LOG
    || (process.platform === 'win32' ? path.join(DATA_DIR, 'awg_audit.log') : '/var/log/awg_audit.log');
// Журнал попыток входа в формате, который понимает fail2ban
const AUTH_LOG = process.env.SERVEPANEL_AUTH_LOG
    || (process.platform === 'win32' ? path.join(DATA_DIR, 'servpanel_auth.log') : '/var/log/servpanel_auth.log');
const SESSIONS_DIR = path.join(DATA_DIR, '.sessions');
const USERS_FILE = path.join(DATA_DIR, '.users.json');
const OBF_PROFILES_FILE = path.join(DATA_DIR, '.obf_profiles.json');
const NOTIFY_FILE = path.join(DATA_DIR, '.notify.json');
const BACKUP_CONFIG_FILE = path.join(DATA_DIR, '.backup.json');
const BACKUP_DIR = process.env.SERVEPANEL_BACKUP_DIR || '/root/backups';
const BACKUP_SCRIPT = path.join(AWG_DIR, 'panel-backup.sh');
const BACKUP_PASS_FILE = path.join(DATA_DIR, '.backup_pass');
// Имя pm2-процесса и журнал обновлений. Можно переопределить переменными
// окружения, если панель развёрнута под другим именем.
const PM2_NAME = process.env.SERVEPANEL_PM2_NAME || 'awg-admin';
const UPDATE_LOG = process.env.SERVEPANEL_UPDATE_LOG
    || (process.platform === 'win32' ? path.join(DATA_DIR, 'panel_update.log') : '/var/log/servpanel_update.log');

const AWG_CONF_PATHS = [
    path.join(AWG_CONF_DIR, 'amn0.conf'),
    path.join(AWG_CONF_DIR, 'awg0.conf'),
    '/etc/wireguard/wg0.conf',
    path.join(AWG_CONF_DIR, 'awg1.conf'),
    path.join(AWG_CONF_DIR, 'awg-eu.conf')
];
const EDITABLE_CONF = new Set(AWG_CONF_PATHS);
const CASCADE_CONF = path.join(AWG_CONF_DIR, 'awg1.conf');          // по CASCADE.md
const CASCADE_CONF_LEGACY = path.join(AWG_CONF_DIR, 'awg-eu.conf'); // старый путь панели
const RENAME_SCRIPT = path.join(AWG_DIR, '.panel-rename.sh');
const INSTALL_STATE = path.join(DATA_DIR, '.install_state.json');

// Опциональный WARP + Xray для AdGuard Home. Ничего не ставится автоматически:
// компонент запускается только по кнопке на вкладке «Службы и DNS».
const WARP_INSTALLER = path.join(APP_DIR, 'install_warp_xray.sh');
const WARP_ENV_FILE = '/root/awg/warp.env';
const WARP_STATE_FILE = '/root/awg/warp-adguard.json';
const WARP_LOG = '/var/log/warp_install.log';
const WARP_DOMAINS_FILE = path.join(APP_DIR, 'warp-domains.txt');

function existingCascadeConf() {
    if (fs.existsSync(CASCADE_CONF)) return CASCADE_CONF;
    if (fs.existsSync(CASCADE_CONF_LEGACY)) return CASCADE_CONF_LEGACY;
    return null;
}
function demoConfPath() {
    const p = path.join(DATA_DIR, 'demo-awg0.conf');
    if (!fs.existsSync(p)) {
        try {
            fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
            fs.writeFileSync(p, [
                '[Interface]',
                'PrivateKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
                'Address = 10.8.0.1/24',
                'ListenPort = 51820',
                'Jc = 4',
                'Jmin = 40',
                'Jmax = 70',
                'S1 = 50',
                'S2 = 100',
                'H1 = 1',
                'H2 = 2',
                'H3 = 3',
                'H4 = 4',
                '',
                '[Peer]',
                'PublicKey = BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
                'AllowedIPs = 10.8.0.2/32',
                ''
            ].join('\n'), { mode: 0o600 });
        } catch (e) { /* ignore */ }
    }
    return p;
}

// Демо-клиенты: дают живые цифры и позволяют пройти мастер создания клиента
// без sudo/AmneziaWG. В обычном режиме этот массив не используется.
const demoClients = [
    { name: 'iphone-alice', ip: '10.8.1.2', status: 'Активен', status_code: 'active', rx: 734003200, tx: 183500800, last_handshake: Math.floor(Date.now() / 1000) - 35 },
    { name: 'macbook-bob', ip: '10.8.1.3', status: 'Активен', status_code: 'active', rx: 418381824, tx: 96468992, last_handshake: Math.floor(Date.now() / 1000) - 90 },
    { name: 'android-carol', ip: '10.8.1.4', status: 'Недавно', status_code: 'recent', rx: 157286400, tx: 41943040, last_handshake: Math.floor(Date.now() / 1000) - 540 },
    { name: 'router-home', ip: '10.8.1.5', status: 'Неактивен', status_code: 'inactive', rx: 17825792, tx: 6291456, last_handshake: Math.floor(Date.now() / 1000) - 86400 }
];
function demoClientConf(name, ip) {
    return [
        '[Interface]',
        'PrivateKey = Q09NTUVOVEFWQU5aRU1JQVdHREVNT0NMSUVOVEtFWTEyMzQ1Ng==',
        `Address = ${ip}/32`,
        'DNS = 10.8.1.1',
        'Jc = 7',
        'Jmin = 48',
        'Jmax = 97',
        'S1 = 73',
        'S2 = 119',
        'S3 = 41',
        'S4 = 12',
        'H1 = 1938475621',
        'H2 = 2847561930',
        'H3 = 3756192847',
        'H4 = 4661938572',
        'HeaderProtectionKey = 7f3a9c2e5b8d1f4a6c0e9b3d7a2f5c8e1b4d6a9f0c3e5b8d2a7f4c1e9b6d3a5f',
        'RandomTrailers = true',
        '',
        '[Peer]',
        'PublicKey = Q09NTUVOVEFWQU5aRU1JQVdHREVNT1NFUlZFUlBVQkxJQ0tFWTEyMzQ1Ng==',
        'PresharedKey = U0hBUkVEX0RFTU9fUFJFU0hBUkVEX0tFWV8xMjM0NTY3ODkwMTI=',
        'Endpoint = 127.0.0.1:51820',
        'AllowedIPs = 0.0.0.0/0',
        'PersistentKeepalive = 25',
        ''
    ].join('\n');
}
function serverConfPath() {
    if (DEMO_MODE) return demoConfPath();
    return AWG_CONF_PATHS.find(p => fs.existsSync(p)) || null;
}

// ---------------------------------------------------------------------------
// Обёртки запуска процессов. Только execFile — аргументы передаются массивом,
// поэтому shell-инъекции невозможны в принципе.
// ---------------------------------------------------------------------------
function sh(cmd, args = [], opts = {}) {
    return execFileSync(cmd, args, {
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 32 * 1024 * 1024,
        ...opts
    });
}
function shTry(cmd, args = [], opts = {}) {
    try { return sh(cmd, args, opts); }
    catch (e) { return String(e.stdout || ''); }
}
// Панель обычно работает от root через pm2. Если sudo не установлен или
// настроен с паролем, вызовы через sudo ломают даже простые операции.
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
function rootSh(cmd, args = [], opts = {}) {
    return IS_ROOT ? sh(cmd, args, opts) : sh('sudo', [cmd, ...args], opts);
}
function rootShTry(cmd, args = [], opts = {}) {
    try { return rootSh(cmd, args, opts); }
    catch (e) { return String(e.stdout || ''); }
}
function rootExecFile(cmd, args = [], opts = {}, cb) {
    return IS_ROOT ? execFile(cmd, args, opts, cb) : execFile('sudo', [cmd, ...args], opts, cb);
}
function isActive(unit) {
    try { return sh('systemctl', ['is-active', unit]).trim(); }
    catch (e) { return String(e.stdout || 'inactive').trim() || 'inactive'; }
}
function isEnabled(unit) {
    try { return sh('systemctl', ['is-enabled', unit]).trim(); }
    catch (e) { return String(e.stdout || 'disabled').trim() || 'disabled'; }
}
function manage(args, opts) { return sh('sudo', ['bash', MANAGE, ...args], opts); }
function manageJson(args) { return JSON.parse(manage([...args, '--json'])); }
function writeRootFile(target, content, mode = '0644') {
    if (DEMO_MODE) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, { mode: parseInt(mode, 8) || 0o600 });
        return;
    }
    const tmp = path.join(os.tmpdir(), 'panel-' + crypto.randomBytes(8).toString('hex') + '.tmp');
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    try {
        // На минимальных VPS каталога /root/awg может не быть: создаём его
        // заранее, иначе install падает и GeoIP показывает «Ошибка установки».
        rootSh('mkdir', ['-p', path.dirname(target)], { timeout: 15000 });
        rootSh('install', ['-m', mode, '-o', 'root', '-g', 'root', tmp, target]);
    } finally {
        try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    }
}
async function fetchWithTimeout(url, opts = {}, ms = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------------------
// Валидация
// ---------------------------------------------------------------------------
const NAME_RE = /^[A-Za-z0-9_-]{1,63}$/;
const IFACE_RE = /^[A-Za-z0-9_.:@-]{1,32}$/;
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const CIDR_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\/(3[0-2]|[12]?\d)$/;
const SERVICE_RE = /^[A-Za-z0-9@_.-]{1,64}$/;

function isPort(v) { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 65535; }
function isIpOrHost(v) { return IPV4_RE.test(v) || HOST_RE.test(v); }
function isDnsTarget(v) {
    if (typeof v !== 'string') return false;
    const parts = v.split(':');
    if (parts.length > 2) return false;
    if (!IPV4_RE.test(parts[0])) return false;
    return parts[1] === undefined || isPort(parts[1]);
}
function existingIfaces() { return Object.keys(os.networkInterfaces()); }
function validIfaces(arr) {
    return Array.isArray(arr) && arr.length > 0 &&
        arr.every(i => typeof i === 'string' && IFACE_RE.test(i) && existingIfaces().includes(i));
}

// Источники списка RU-адресов для GeoIP-блокировки.
// OpenCCK отдаёт обычный text/cidr4 — его можно парсить тем же скриптом.
const RU_GEOIP_SOURCES = {
    opencck: 'https://russia.iplist.opencck.org/?format=text&data=cidr4',
    antifilter: 'https://www.ipdeny.com/ipblocks/data/aggregated/ru-aggregated.zone'
};

// Достаём IPv4/CIDR из произвольного текста: txt, csv, json, html,
// списков вида "1.2.3.0/24, 5.6.7.8" или ipset "ipset=/1.2.3.0/24/name".
// JSON-формат OpenCCK экранирует слэш как \/, поэтому сначала нормализуем.
function parseIpList(text) {
    const raw = String(text == null ? '' : text).replace(/\\\//g, '/');
    const re = /(?<![\d.])(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?:\/(?:3[0-2]|[12]?\d))?(?![\d.]|\/\d)/g;
    const seen = new Set();
    let m;
    while ((m = re.exec(raw)) !== null) {
        const value = m[0];
        if (!IPV4_RE.test(value) && !CIDR_RE.test(value)) continue;
        seen.add(value);
        if (seen.size > 2000000) break;
    }
    return [...seen];
}

// URL списка GeoIP. OpenCCK умеет длинные ссылки с десятками site=...,
// поэтому старый лимит в 300 символов здесь не подходит.
function validGeoUrl(value) {
    const s = String(value == null ? '' : value).trim();
    if (s.length < 10 || s.length > 8192) return false;
    if (/\s/.test(s)) return false;
    // URL подставляется в bash-массив в двойных кавычках; $, `, \, " запрещены.
    if (!/^https:\/\/[A-Za-z0-9._~:/?#\[\]@!&'()*+,;=%-]+$/.test(s)) return false;
    try {
        const u = new URL(s);
        return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password;
    } catch (e) {
        return false;
    }
}

// --- WARP + Xray: конфигурация и список доменов для AdGuard -----------------
function readKeyValueFile(file) {
    const out = {};
    try {
        for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
            const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
            if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
        }
    } catch (e) { /* файла ещё нет */ }
    return out;
}

// WARP могли поставить вручную (пакетом Cloudflare или из snap) — тогда
// /root/awg/warp.env отсутствует. Поэтому наличие компонента определяем не
// только по флагу установщика, но и по бинарнику/юниту systemd.
function warpBinaryPresent() {
    const bins = ['/usr/bin/warp-cli', '/usr/local/bin/warp-cli', '/bin/warp-cli', '/snap/bin/warp-cli'];
    const units = [
        '/lib/systemd/system/warp-svc.service',
        '/usr/lib/systemd/system/warp-svc.service',
        '/etc/systemd/system/warp-svc.service'
    ];
    const exists = p => { try { return fs.existsSync(p); } catch (e) { return false; } };
    return bins.some(exists) || units.some(exists);
}

function warpConfig() {
    const env = readKeyValueFile(WARP_ENV_FILE);
    return {
        installed: env.WARP_INSTALLED === '1' || warpBinaryPresent(),
        listenIp: IPV4_RE.test(env.WARP_LISTEN_IP || '') ? env.WARP_LISTEN_IP : '10.8.1.1',
        listenPort: isPort(env.WARP_LISTEN_PORT) ? String(Number(env.WARP_LISTEN_PORT)) : '443',
        socksPort: isPort(env.WARP_SOCKS_PORT) ? String(Number(env.WARP_SOCKS_PORT)) : '40000',
        installedAt: env.WARP_INSTALLED_AT || ''
    };
}

function warpDomainList() {
    try {
        return [...new Set(fs.readFileSync(WARP_DOMAINS_FILE, 'utf8')
            .replace(/^\uFEFF/, '')
            .split(/\r?\n/)
            .map(s => s.trim())
            .filter(s => s && !s.startsWith('#') && HOST_RE.test(s)))];
    } catch (e) { return []; }
}

function warpAdguardState() {
    try { return JSON.parse(fs.readFileSync(WARP_STATE_FILE, 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { return null; }
}
function parseCidrList(str) {
    const out = [];
    for (const raw of String(str || '').split(/[\s,;]+/)) {
        const v = raw.trim();
        if (!v) continue;
        if (!CIDR_RE.test(v) && !IPV4_RE.test(v)) return null;
        out.push(v);
    }
    return out;
}
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    try { return crypto.timingSafeEqual(ha, hb); } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// Пароль и секреты
// ---------------------------------------------------------------------------
const PASS_FILE = path.join(DATA_DIR, 'admin_pass.txt');
const SECRETS_FILE = path.join(DATA_DIR, '.secrets.json');

function loadPassword() {
    if (process.env.ADMIN_PASSWORD) return String(process.env.ADMIN_PASSWORD).trim();
    try {
        const p = fs.readFileSync(PASS_FILE, 'utf8').trim();
        if (p) return p;
    } catch (e) { /* нет файла */ }
    // Файла нет — сохраняем совместимость со старыми установками,
    // но интерфейс покажет предупреждение и попросит сменить пароль.
    return 'admin123';
}
let ADMIN_PASSWORD = loadPassword();

function ensureDir(dir, mode = 0o700) {
    try { fs.mkdirSync(dir, { recursive: true, mode }); } catch (e) { /* ignore */ }
}
function readJson(file, def) {
    try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        return j && typeof j === 'object' ? j : def;
    } catch (e) { return def; }
}
function writeJson(file, obj, mode = 0o600) {
    const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode });
    fs.renameSync(tmp, file);
}

function loadSecrets() {
    const j = readJson(SECRETS_FILE, null);
    if (j && j.sessionSecret) return j;
    const s = { sessionSecret: crypto.randomBytes(32).toString('hex'), createdAt: new Date().toISOString() };
    try {
        ensureDir(DATA_DIR);
        writeJson(SECRETS_FILE, s, 0o600);
    } catch (e) { /* ignore */ }
    return s;
}
const SECRETS = loadSecrets();
function saveSecrets() {
    try { writeJson(SECRETS_FILE, SECRETS, 0o600); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Журнал действий (с ротацией)
// ---------------------------------------------------------------------------
function auditLog(req, action) {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || (req.socket && req.socket.remoteAddress) || '')
        .split(',')[0].trim();
    const date = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const user = (req.session && req.session.user) || '-';
    const line = `[${date}] IP: ${ip} | USER: ${user} | ACTION: ${String(action).replace(/[\r\n]+/g, ' ')}\n`;
    try {
        if (fs.existsSync(AUDIT_LOG) && fs.statSync(AUDIT_LOG).size > 5 * 1024 * 1024) {
            fs.renameSync(AUDIT_LOG, AUDIT_LOG + '.1');
        }
        fs.appendFileSync(AUDIT_LOG, line);
    } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '16mb' }));

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
        "style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
        "font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    next();
});

// Простейшая CSRF-защита: для изменяющих запросов Origin (если передан) должен
// совпадать с Host панели.
app.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin) {
            try {
                if (new URL(origin).host !== req.headers.host) {
                    return res.status(403).json({ error: 'Запрос с чужого Origin отклонён' });
                }
            } catch (e) {
                return res.status(403).json({ error: 'Некорректный Origin' });
            }
        }
    }
    next();
});

// ---------------------------------------------------------------------------
// Файловое хранилище сессий: вход в панель переживает перезапуск процесса
// ---------------------------------------------------------------------------
class FileSessionStore extends session.Store {
    constructor(dir) {
        super();
        this.dir = dir;
        ensureDir(dir, 0o700);
        this.sweepTimer = setInterval(() => this.sweep(), 15 * 60 * 1000);
        if (this.sweepTimer.unref) this.sweepTimer.unref();
        this.writeQueues = new Map();
        this.sweep();
    }
    fileFor(sid) {
        return path.join(this.dir, crypto.createHash('sha256').update(String(sid)).digest('hex') + '.json');
    }
    get(sid, cb) {
        fs.readFile(this.fileFor(sid), 'utf8', (err, txt) => {
            if (err) return cb(null, null);
            let s;
            try { s = JSON.parse(txt); } catch (e) { return cb(null, null); }
            const exp = s && s.cookie && s.cookie.expires;
            if (exp && new Date(exp).getTime() <= Date.now()) {
                return this.destroy(sid, () => cb(null, null));
            }
            cb(null, s);
        });
    }
    set(sid, sess, cb) {
        const key = String(sid);
        const previous = this.writeQueues.get(key) || Promise.resolve();
        const task = previous.catch(() => {}).then(() => new Promise((resolve, reject) => {
            const finalPath = this.fileFor(sid);
            const tmpPath = finalPath + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
            const fail = err => {
                try { fs.unlink(tmpPath, () => {}); } catch (e) { /* ignore */ }
                reject(err);
            };
            fs.writeFile(tmpPath, JSON.stringify(sess), { mode: 0o600 }, err => {
                if (err) return fail(err);
                let attempts = 0;
                const move = () => {
                    fs.rename(tmpPath, finalPath, err2 => {
                        if (!err2) return resolve();
                        if (attempts++ < 5 && ['EPERM', 'EBUSY', 'EACCES'].includes(err2.code)) {
                            return setTimeout(move, 15);
                        }
                        fail(err2);
                    });
                };
                move();
            });
        }));
        this.writeQueues.set(key, task);
        task.then(() => {
            if (this.writeQueues.get(key) === task) this.writeQueues.delete(key);
            if (cb) cb(null);
        }, err => {
            if (this.writeQueues.get(key) === task) this.writeQueues.delete(key);
            if (cb) cb(err);
        });
    }
    touch(sid, sess, cb) { this.set(sid, sess, cb); }
    destroy(sid, cb) { fs.unlink(this.fileFor(sid), () => { if (cb) cb(null); }); }
    sweep() {
        fs.readdir(this.dir, (err, files) => {
            if (err || !files) return;
            const now = Date.now();
            for (const f of files) {
                if (!f.endsWith('.json')) continue;
                const p = path.join(this.dir, f);
                fs.stat(p, (e, st) => {
                    if (!e && now - st.mtimeMs > 24 * 60 * 60 * 1000) fs.unlink(p, () => { /* ignore */ });
                });
            }
        });
    }
}

app.use(session({
    name: 'panel.sid',
    secret: SECRETS.sessionSecret,
    store: new FileSessionStore(SESSIONS_DIR),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: 'auto',
        maxAge: 12 * 60 * 60 * 1000
    }
}));

app.use(express.static(path.join(APP_DIR, 'public'), { index: 'index.html' }));

// ---------------------------------------------------------------------------
// Ограничение частоты запросов ко всем /api/* (защита от перебора и флуда)
// ---------------------------------------------------------------------------
const RATE_WINDOWS = {
    login: { max: 30, ms: 60 * 1000 },
    heavy: { max: 20, ms: 60 * 1000 },
    api: { max: 300, ms: 60 * 1000 }
};
const rateBuckets = new Map();

function clientIp(req) {
    const peer = String((req.socket && req.socket.remoteAddress) || '');
    const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
    const xff = req.headers['x-forwarded-for'];
    if (loopback && xff) {
        // nginx добавляет реальный IP последним; доверяем только локальному прокси,
        // иначе клиент мог бы подделать заголовок и обойти лимиты/fail2ban.
        const parts = String(xff).split(',').map(s => s.trim()).filter(Boolean);
        if (parts.length) return parts[parts.length - 1];
    }
    return peer || String(req.ip || '?').replace(/^::ffff:/, '');
}
function rateClass(apiPath) {
    if (apiPath === '/login' || apiPath === '/logout' || apiPath.startsWith('/2fa/')) return 'login';
    if (/^\/(backup|restore|diag|install|update|restart|services|obf\/apply)/.test(apiPath)) return 'heavy';
    return 'api';
}

app.use('/api', (req, res, next) => {
    const apiPath = req.originalUrl.replace(/^\/api/, '').split('?')[0];
    const cls = rateClass(apiPath);
    const conf = RATE_WINDOWS[cls];
    const key = cls + '|' + clientIp(req);
    const now = Date.now();
    if (rateBuckets.size > 50000 && !rateBuckets.has(key)) rateBuckets.clear();
    let b = rateBuckets.get(key);
    if (!b || now - b.start >= conf.ms) { b = { start: now, count: 0 }; rateBuckets.set(key, b); }
    b.count += 1;
    if (b.count > conf.max) {
        const retry = Math.max(1, Math.ceil((b.start + conf.ms - now) / 1000));
        res.setHeader('Retry-After', String(retry));
        return res.status(429).json({ error: `Слишком много запросов. Повторите через ${retry} с.` });
    }
    next();
});
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateBuckets) if (now - v.start > 10 * 60 * 1000) rateBuckets.delete(k);
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Аутентификация + защита от подбора
// ---------------------------------------------------------------------------
const loginFails = new Map(); // ip -> {count, until}

function loginKey(req) { return clientIp(req); }
function loginBlocked(key) {
    const e = loginFails.get(key);
    if (!e) return 0;
    // until = 0 означает «ещё не заблокирован», а не «блокировка истекла»
    if (e.until && Date.now() > e.until) { loginFails.delete(key); return 0; }
    if (!e.until) return 0;
    return Math.ceil((e.until - Date.now()) / 1000);
}
function registerLoginFail(key) {
    if (loginFails.size > 10000 && !loginFails.has(key)) loginFails.clear();
    const e = loginFails.get(key) || { count: 0, until: 0 };
    e.count += 1;
    e.last = Date.now();
    if (e.count >= 5) { e.until = Date.now() + 15 * 60 * 1000; e.count = 0; }
    loginFails.set(key, e);
}
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of loginFails) {
        if (v.until && now > v.until) loginFails.delete(k);
        else if (!v.until && now - (v.last || 0) > 15 * 60 * 1000) loginFails.delete(k);
    }
}, 10 * 60 * 1000).unref();

// Журнал входов для fail2ban (формат: "<дата> FAILED LOGIN from <IP> ...")
function authLog(ip, ok, username, note = '') {
    try {
        ensureDir(path.dirname(AUTH_LOG), 0o750);
        const date = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const line = ok
            ? `${date} SUCCESS LOGIN from ${ip} user=${username}\n`
            : `${date} FAILED LOGIN from ${ip} user=${username}${note ? ' ' + note : ''}\n`;
        fs.appendFileSync(AUTH_LOG, line, { mode: 0o640 });
    } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Пользователи и роли (admin / viewer)
// ---------------------------------------------------------------------------
function loadUsers() {
    const j = readJson(USERS_FILE, { users: [] });
    return Array.isArray(j.users) ? j.users.filter(u => u && typeof u.username === 'string') : [];
}
function saveUsers(users) {
    ensureDir(DATA_DIR);
    writeJson(USERS_FILE, { users }, 0o600);
}
function hashPassword(password, salt) {
    return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}
function makeUser(username, password, role) {
    const salt = crypto.randomBytes(16).toString('hex');
    return {
        username,
        role,
        salt,
        hash: hashPassword(password, salt),
        createdAt: new Date().toISOString()
    };
}
function verifyUserPassword(user, password) {
    if (!user || !user.salt || !user.hash) return false;
    return safeEqual(hashPassword(password, user.salt), user.hash);
}
function findUser(username) {
    const name = String(username || 'admin').trim() || 'admin';
    if (name === 'admin') return { username: 'admin', role: 'admin', builtin: true };
    return loadUsers().find(u => u.username === name) || null;
}

// ---------------------------------------------------------------------------
// TOTP (2FA, RFC 6238): без внешних зависимостей
// ---------------------------------------------------------------------------
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
    let bits = 0, value = 0, out = '';
    for (const byte of buf) {
        value = (value << 8) | byte; bits += 8;
        while (bits >= 5) { out += B32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
    return out;
}
function base32Decode(str) {
    const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0, value = 0;
    const out = [];
    for (const ch of clean) {
        const idx = B32_ALPHABET.indexOf(ch);
        if (idx === -1) continue;
        value = (value << 5) | idx; bits += 5;
        if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
    }
    return Buffer.from(out);
}
function totpAt(secret, step) {
    const key = base32Decode(secret);
    if (!key.length) return '';
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(Math.floor(step / 0x100000000), 0);
    buf.writeUInt32BE(step >>> 0, 4);
    const h = crypto.createHmac('sha1', key).update(buf).digest();
    const o = h[h.length - 1] & 0x0f;
    const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    return String(n % 1000000).padStart(6, '0');
}
function verifyTotp(secret, code, window = 1) {
    const given = String(code || '').trim();
    if (!secret || !/^\d{6}$/.test(given)) return false;
    const step = Math.floor(Date.now() / 30000);
    let ok = false;
    for (let i = -window; i <= window; i++) {
        if (safeEqual(totpAt(secret, step + i), given)) ok = true;
    }
    return ok;
}
function newTotpSecret() { return base32Encode(crypto.randomBytes(20)); }
function otpauthUri(secret, username) {
    const label = encodeURIComponent('Servpanel:' + (username || 'admin'));
    return `otpauth://totp/${label}?secret=${secret}&issuer=Servpanel&algorithm=SHA1&digits=6&period=30`;
}
function hashCode(code) {
    return crypto.createHash('sha256').update(String(code).replace(/[^A-Za-z0-9]/g, '').toLowerCase()).digest('hex');
}
function makeRecoveryCodes(n = 10) {
    return Array.from({ length: n }, () => crypto.randomBytes(5).toString('hex').match(/.{5}/g).join('-'));
}

function totpState(user) {
    if (user.builtin) {
        return {
            secret: SECRETS.totpSecret || '',
            pending: SECRETS.totpPending || '',
            enabled: !!SECRETS.totpEnabled,
            recovery: Array.isArray(SECRETS.totpRecovery) ? SECRETS.totpRecovery : []
        };
    }
    const u = loadUsers().find(x => x.username === user.username);
    return u ? {
        secret: u.totpSecret || '',
        pending: u.totpPending || '',
        enabled: !!u.totpEnabled,
        recovery: Array.isArray(u.totpRecovery) ? u.totpRecovery : []
    } : {};
}
function setTotpState(username, patch) {
    if (username === 'admin') {
        Object.assign(SECRETS, patch);
        saveSecrets();
        return;
    }
    const users = loadUsers();
    const u = users.find(x => x.username === username);
    if (!u) return;
    Object.assign(u, patch);
    saveUsers(users);
}

// QR-коды для 2FA и экспорта клиента. Пакет qrcode необязателен: без него
// панель продолжает работать, просто не рисует QR.
let QRCodeLib = null;
try { QRCodeLib = require('qrcode'); } catch (e) { QRCodeLib = null; }
async function qrDataUrl(text) {
    if (!QRCodeLib) return '';
    try { return await QRCodeLib.toDataURL(String(text), { margin: 1, width: 480, errorCorrectionLevel: 'M' }); }
    catch (e) { return ''; }
}

// ---------------------------------------------------------------------------
// Вход
// ---------------------------------------------------------------------------
app.post('/api/login', (req, res) => {
    const key = loginKey(req);
    const blocked = loginBlocked(key);
    if (blocked > 0) {
        authLog(key, false, '-', 'blocked');
        auditLog(req, 'Вход заблокирован (слишком много попыток)');
        return res.status(429).json({ error: `Слишком много попыток. Повторите через ${blocked} с.` });
    }

    const username = String((req.body && req.body.username) || 'admin').trim().slice(0, 64) || 'admin';
    const password = String((req.body && req.body.password) || '');
    const code = String((req.body && req.body.code) || '').trim();
    const user = findUser(username);

    const passwordOk = user && (user.builtin
        ? safeEqual(password, ADMIN_PASSWORD)
        : verifyUserPassword(user, password));

    if (!passwordOk) {
        registerLoginFail(key);
        authLog(key, false, username, 'bad-password');
        auditLog(req, `Неудачная попытка входа (пользователь ${username})`);
        return res.status(401).json({ error: 'Неверный пароль' });
    }

    const st = totpState(user);
    if (st.enabled) {
        let secondFactorOk = verifyTotp(st.secret, code);
        if (!secondFactorOk && code && st.recovery.length) {
            const h = hashCode(code);
            if (st.recovery.includes(h)) {
                secondFactorOk = true;
                setTotpState(user.username, { totpRecovery: st.recovery.filter(x => x !== h) });
                auditLog(req, `Использован резервный код 2FA (${user.username})`);
            }
        }
        if (!secondFactorOk) {
            registerLoginFail(key);
            authLog(key, false, username, 'bad-2fa');
            return res.status(401).json({
                error: code ? 'Неверный код 2FA' : 'Введите код из приложения-аутентификатора',
                need2fa: true
            });
        }
    }

    loginFails.delete(key);
    req.session.regenerate(err => {
        if (err) return res.status(500).json({ error: 'Ошибка сессии' });
        req.session.loggedIn = true;
        req.session.user = user.username;
        req.session.role = user.role;
        req.session.save(() => {
            auditLog(req, `Успешный вход в панель (${user.username}, ${user.role})`);
            authLog(key, true, user.username);
            res.json({
                success: true,
                user: user.username,
                role: user.role,
                defaultPassword: user.builtin && ADMIN_PASSWORD === 'admin123'
            });
        });
    });
});

app.post('/api/logout', (req, res) => {
    const who = req.session && req.session.user;
    const done = () => { res.clearCookie('panel.sid'); res.json({ success: true }); };
    try {
        req.session.destroy(() => {
            if (who) auditLog(req, `Выход из панели (${who})`);
            done();
        });
    } catch (e) { done(); }
});

const checkAuth = (req, res, next) => {
    if (req.session && req.session.loggedIn) {
        // Совместимость с сессиями, созданными до появления ролей
        if (!req.session.role) req.session.role = 'admin';
        if (!req.session.user) req.session.user = 'admin';
        return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
};
const requireAdmin = (req, res, next) => {
    if (req.session && req.session.loggedIn && req.session.role === 'admin') return next();
    res.status(403).json({ error: 'Недостаточно прав: нужно войти как администратор' });
};

// Пользователи с ролью viewer могут только смотреть: любые изменения и
// скачивание ключей/конфигов/бэкапов для них закрыты.
const VIEWER_DENIED_GET = [
    /^\/audit/, /^\/users/, /^\/backup/, /^\/fail2ban/, /^\/notify/, /^\/install\//, /^\/diag\//,
    /^\/download\//, /^\/clients\/[^/]+\/key/, /^\/clients\/[^/]+\/export/,
    /^\/awg\/config/, /^\/cascade\/config/, /^\/obf\/export/, /^\/2fa\//
];
app.use('/api', (req, res, next) => {
    if (!req.session || !req.session.loggedIn) return next();
    if ((req.session.role || 'admin') === 'admin') return next();
    const apiPath = req.originalUrl.replace(/^\/api/, '').split('?')[0];
    if (req.method === 'GET' && !VIEWER_DENIED_GET.some(re => re.test(apiPath))) return next();
    if (req.method === 'POST' && (apiPath === '/logout' || apiPath === '/change-password')) return next();
    return res.status(403).json({ error: 'Недостаточно прав: режим только просмотра' });
});

// ---------------------------------------------------------------------------
// Сбор истории трафика
// ---------------------------------------------------------------------------
// Храним скорость (байт/с), а не метки времени с «плавающей» длиной массива.
// Это даёт стабильное окно по времени и позволяет выбирать период.
//
// Две серии на каждый источник:
//   short — шаг 10 секунд, глубина 24 часа;
//   long  — шаг 5 минут, глубина 7 суток (строится сворачиванием старых short).
// Отдаём в график не более 360 точек, усредняя по «корзинам», поэтому кривая
// ровная, а число точек и подписи оси X не скачут от обновления к обновлению.
const HISTORY_STEP_MS = 10000;                 // шаг сбора — 10 секунд
const HISTORY_SHORT_POINTS = 8640;             // 24 часа по 10 секунд
const HISTORY_LONG_BUCKET = 30;                // 30 сэмплов = 5 минут
const HISTORY_LONG_POINTS = 2016;              // 7 суток по 5 минут
const HISTORY_RANGES = { '5m': 300, '1h': 3600, '3h': 10800, '24h': 86400, '7d': 604800 };
const HISTORY_RENDER_POINTS = 360;             // столько точек максимум рисует график
const HISTORY_FILE = path.join(DATA_DIR, '.traffic_history.json');
const HISTORY_SAVE_EVERY = 6;                  // сохранять файл раз в минуту

let historyData = {};                          // { global: {short, long}, <client>: {short, long} }
let lastHistoryStats = {};
let collectingHistory = false;
let historySaveTick = 0;

function historyEnsure(view) {
    if (!historyData[view]) historyData[view] = { short: [], long: [] };
    return historyData[view];
}

function historyPush(view, t, rx, tx) {
    const h = historyEnsure(view);
    h.short.push({ t, rx, tx });
    if (h.short.length > HISTORY_SHORT_POINTS) {
        // Самую старую пятёрку минут сворачиваем в одну точку длинной серии.
        const chunk = h.short.splice(0, HISTORY_LONG_BUCKET);
        const sum = chunk.reduce((a, s) => ({ rx: a.rx + s.rx, tx: a.tx + s.tx }), { rx: 0, tx: 0 });
        h.long.push({ t: chunk[Math.floor(chunk.length / 2)].t, rx: sum.rx / chunk.length, tx: sum.tx / chunk.length });
        if (h.long.length > HISTORY_LONG_POINTS) h.long.splice(0, h.long.length - HISTORY_LONG_POINTS);
    }
}

function saveTrafficHistory() {
    try {
        const out = {};
        for (const [k, v] of Object.entries(historyData)) out[k] = { short: v.short, long: v.long };
        fs.writeFile(HISTORY_FILE, JSON.stringify(out), () => { /* ignore */ });
    } catch (e) { /* ignore */ }
}

function loadTrafficHistory() {
    try {
        const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        const cutoff = Date.now() - HISTORY_RANGES['7d'] * 1000;
        for (const [k, v] of Object.entries(parsed || {})) {
            historyData[k] = {
                short: (v.short || []).filter(s => s && s.t >= cutoff),
                long: (v.long || []).filter(s => s && s.t >= cutoff)
            };
        }
    } catch (e) { /* файла нет или он битый — начинаем с чистого листа */ }
}

if (DEMO_MODE) {
    const now = Date.now();
    const g = historyEnsure('global');
    for (let i = 359; i >= 0; i--) {
        const wave = Math.sin((359 - i) / 20) * 0.4 + 0.7;
        g.short.push({ t: now - i * HISTORY_STEP_MS, rx: 3.5 * 1024 * 1024 * wave, tx: 900 * 1024 * (1.2 - wave / 2) });
    }
}

function collectHistory() {
    if (collectingHistory) return;
    collectingHistory = true;
    execFile('sudo', ['bash', MANAGE, 'stats', '--json'], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        collectingHistory = false;
        try {
            const jsonStart = String(stdout || '').indexOf('[');
            if (jsonStart === -1) return;
            const data = JSON.parse(String(stdout).substring(jsonStart));
            const t = Date.now();
            let totalRxSpeed = 0, totalTxSpeed = 0, counted = 0;

            data.forEach(client => {
                const prev = lastHistoryStats[client.name];
                lastHistoryStats[client.name] = { rx: client.rx, tx: client.tx, t };
                // Первый замер клиента пропускаем: иначе рисуется ложный ноль.
                if (!prev) return;
                const dt = (t - prev.t) / 1000;
                if (dt <= 0 || client.rx < prev.rx || client.tx < prev.tx) return;
                const rxSpeed = (client.rx - prev.rx) / dt;
                const txSpeed = (client.tx - prev.tx) / dt;
                totalRxSpeed += rxSpeed; totalTxSpeed += txSpeed; counted++;
                historyPush(client.name, t, rxSpeed, txSpeed);
            });

            if (counted > 0) historyPush('global', t, totalRxSpeed, totalTxSpeed);
            historySaveTick++;
            if (historySaveTick % HISTORY_SAVE_EVERY === 0) saveTrafficHistory();
        } catch (e) { /* ignore */ }
    });
}
if (!TEST_MODE) {
    loadTrafficHistory();
    collectHistory();
    setInterval(collectHistory, HISTORY_STEP_MS);
}

function historyFormatLabel(ms, rangeSec) {
    const d = new Date(ms);
    const p = n => String(n).padStart(2, '0');
    if (rangeSec <= 300) return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    if (rangeSec <= 86400) return `${p(d.getHours())}:${p(d.getMinutes())}`;
    return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Усредняет точки по равным корзинам, чтобы на график ушло не больше maxPoints.
function historyDownsample(samples, fromMs, toMs, maxPoints) {
    const list = samples.filter(s => s && s.t >= fromMs && s.t <= toMs);
    if (list.length <= maxPoints) return list;
    const bucketMs = (toMs - fromMs) / maxPoints;
    const out = [];
    let curIdx = -1, sumRx = 0, sumTx = 0, cnt = 0, curT = 0;
    for (const s of list) {
        const idx = Math.max(0, Math.min(maxPoints - 1, Math.floor((s.t - fromMs) / bucketMs)));
        if (idx !== curIdx) {
            if (cnt) out.push({ t: curT, rx: sumRx / cnt, tx: sumTx / cnt });
            curIdx = idx; sumRx = 0; sumTx = 0; cnt = 0;
        }
        sumRx += s.rx; sumTx += s.tx; cnt++; curT = s.t;
    }
    if (cnt) out.push({ t: curT, rx: sumRx / cnt, tx: sumTx / cnt });
    return out;
}

app.get('/api/history', checkAuth, (req, res) => {
    try {
        const rangeKey = String(req.query.range || '1h');
        const rangeSec = HISTORY_RANGES[rangeKey] || HISTORY_RANGES['1h'];
        const view = String(req.query.view || 'global');
        const h = historyData[view] || { short: [], long: [] };
        // Выравниваем окно по сетке сбора, чтобы «корзины» не съезжали между
        // обновлениями и подписи оси X не дёргались.
        const toMs = Math.floor(Date.now() / HISTORY_STEP_MS) * HISTORY_STEP_MS;
        const fromMs = toMs - rangeSec * 1000;
        const points = historyDownsample(h.long.concat(h.short), fromMs, toMs, HISTORY_RENDER_POINTS);
        res.json({
            range: rangeKey,
            view,
            labels: points.map(p => historyFormatLabel(p.t, rangeSec)),
            rx: points.map(p => Math.round(p.rx)),
            tx: points.map(p => Math.round(p.tx)),
            views: ['global', ...Object.keys(historyData).filter(k => k !== 'global')]
        });
    } catch (e) { res.status(500).json({ error: 'Ошибка истории трафика' }); }
});

// ---------------------------------------------------------------------------
// Системные метрики и статус безопасности
// ---------------------------------------------------------------------------
// loadavg — это не загрузка CPU, а число задач в очереди (включая D-state и
// I/O). На VPS с 1–2 ядрами loadavg 2.0 легко даёт «100%», хотя htop показывает
// 10–20%. Считаем реальную загрузку по дельтам /proc/stat (или os.cpus()).
function readCpuTimes() {
    if (process.platform === 'linux') {
        try {
            const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim();
            const n = line.split(/\s+/).slice(1).map(Number);
            if (n.length >= 4 && n.every(v => Number.isFinite(v))) {
                // user nice system idle iowait irq softirq steal (guest не считаем:
                // он уже входит в user/nice и дал бы двойной учёт).
                const idle = n[3] + (n[4] || 0);
                const total = n.slice(0, 8).reduce((a, b) => a + b, 0);
                if (total > 0) return { total, idle };
            }
        } catch (e) { /* not Linux / no procfs */ }
    }
    try {
        const cpus = os.cpus() || [];
        let idle = 0, total = 0;
        for (const c of cpus) {
            const t = c.times || {};
            idle += t.idle || 0;
            total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
        }
        if (total > 0) return { total, idle };
    } catch (e) { /* ignore */ }
    return null;
}
let cpuPrev = readCpuTimes();
let cpuCached = { usage: null, at: 0 };
function cpuUsagePercent() {
    const now = Date.now();
    // Не пересчитываем на каждый быстрый запрос: слишком малая дельта даёт шум.
    if (cpuCached.usage !== null && now - cpuCached.at < 900) return cpuCached.usage;
    const cur = readCpuTimes();
    if (cur && cpuPrev) {
        const dTotal = cur.total - cpuPrev.total;
        const dIdle = cur.idle - cpuPrev.idle;
        if (dTotal >= 40 && dIdle >= 0) {
            const usage = Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100));
            cpuPrev = cur;
            cpuCached = { usage, at: now };
            return usage;
        }
    }
    if (cur && cur.total > 0) {
        // Первый запрос после старта: средняя загрузка с момента boot.
        const usage = Math.max(0, Math.min(100, ((cur.total - cur.idle) / cur.total) * 100));
        cpuPrev = cur;
        if (cpuCached.usage === null) cpuCached = { usage, at: now };
        return cpuCached.usage;
    }
    const cores = os.cpus().length || 1;
    return Math.max(0, Math.min(100, (os.loadavg()[0] / cores) * 100));
}
function memoryUsage() {
    // os.freemem() на Linux — это только MemFree, без кэша. Из-за этого панель
    // показывала почти 100% RAM. MemAvailable — то же, что учитывает htop.
    try {
        const txt = fs.readFileSync('/proc/meminfo', 'utf8');
        const kb = key => {
            const m = txt.match(new RegExp('^' + key + ':\\s+(\\d+)\\s+kB', 'm'));
            return m ? parseInt(m[1], 10) * 1024 : 0;
        };
        const total = kb('MemTotal');
        const available = kb('MemAvailable') || (kb('MemFree') + kb('Buffers') + kb('Cached'));
        if (total > 0 && available > 0) {
            return { total, free: available, used: Math.max(0, total - available) };
        }
    } catch (e) { /* ignore */ }
    const total = os.totalmem(), free = os.freemem();
    return { total, free, used: Math.max(0, total - free) };
}

app.get('/api/sysinfo', checkAuth, (req, res) => {
    try {
        const mem = memoryUsage();
        const ramPercent = mem.total > 0 ? ((mem.used / mem.total) * 100).toFixed(1) : '0.0';
        const cpu = cpuUsagePercent().toFixed(1);
        const up = os.uptime();
        const d = Math.floor(up / 86400), h = Math.floor((up % 86400) / 3600), m = Math.floor((up % 3600) / 60);

        let disk = { total: 0, used: 0, free: 0, percent: '0%' };
        try {
            const dfStr = sh('bash', ['-c', "df -B1 --output=size,used,avail,pcent / | tail -1"]).trim();
            const df = dfStr.split(/\s+/);
            disk = { total: parseInt(df[0]), used: parseInt(df[1]), free: parseInt(df[2]), percent: df[3] };
        } catch (e) { /* ignore */ }

        res.json({
            cpu,
            ram: ramPercent,
            load: Number(os.loadavg()[0] || 0).toFixed(2),
            cores: os.cpus().length,
            uptime: `${d}д ${h}ч ${m}м`,
            disk
        });
    } catch (e) { res.status(500).json({ error: 'Ошибка чтения метрик' }); }
});

app.get('/api/security/status', checkAuth, (req, res) => {
    let passFileExists = false;
    try { passFileExists = fs.existsSync(PASS_FILE); } catch (e) { /* ignore */ }
    const me = findUser(req.session.user || 'admin') || { username: 'admin', role: 'admin', builtin: true };
    const st = totpState(me);
    res.json({
        defaultPassword: ADMIN_PASSWORD === 'admin123',
        passFileExists,
        secretsFileExists: fs.existsSync(SECRETS_FILE),
        https: String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https' || req.secure === true,
        node: process.version,
        panelPort: PANEL_PORT,
        panelPublicPort: PANEL_PUBLIC_PORT,
        user: req.session.user || 'admin',
        role: req.session.role || 'admin',
        users: loadUsers().length,
        totpEnabled: !!st.enabled,
        sessionStore: 'file',
        dataDir: DATA_DIR
    });
});

app.get('/api/interfaces', checkAuth, (req, res) => res.json(DEMO_MODE ? ['awg0'] : existingIfaces()));

// ---------------------------------------------------------------------------
// Администрирование: пользователи, 2FA, аудит, fail2ban, уведомления, бэкапы
// ---------------------------------------------------------------------------
app.get('/api/users', checkAuth, requireAdmin, (req, res) => {
    const users = loadUsers().map(u => ({
        username: u.username,
        role: u.role === 'admin' ? 'admin' : 'viewer',
        createdAt: u.createdAt || '',
        totpEnabled: !!u.totpEnabled
    }));
    res.json({ users, current: req.session.user || 'admin' });
});

app.post('/api/users', checkAuth, requireAdmin, (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    const role = (req.body && req.body.role) === 'viewer' ? 'viewer' : 'admin';
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username) || username === 'admin') {
        return res.status(400).json({ error: 'Имя: 3–32 символа, буквы/цифры/._-; «admin» зарезервировано' });
    }
    if (password.length < 10) return res.status(400).json({ error: 'Пароль должен быть не короче 10 символов' });
    const users = loadUsers();
    if (users.some(u => u.username === username)) return res.status(409).json({ error: 'Такой пользователь уже есть' });
    users.push(makeUser(username, password, role));
    try {
        saveUsers(users);
        auditLog(req, `Создан пользователь ${username} (${role})`);
        res.json({ success: true, username, role });
    } catch (e) { res.status(500).json({ error: 'Не удалось сохранить пользователя' }); }
});

app.delete('/api/users/:username', checkAuth, requireAdmin, (req, res) => {
    const username = String(req.params.username);
    if (username === 'admin') return res.status(400).json({ error: 'Встроенного администратора удалить нельзя' });
    if (username === req.session.user) return res.status(400).json({ error: 'Нельзя удалить самого себя' });
    const users = loadUsers();
    const next = users.filter(u => u.username !== username);
    if (next.length === users.length) return res.status(404).json({ error: 'Пользователь не найден' });
    saveUsers(next);
    auditLog(req, `Удалён пользователь ${username}`);
    res.json({ success: true });
});

app.post('/api/users/:username/password', checkAuth, requireAdmin, (req, res) => {
    const username = String(req.params.username);
    const password = String((req.body && req.body.password) || '');
    if (password.length < 10) return res.status(400).json({ error: 'Пароль должен быть не короче 10 символов' });
    if (username === 'admin') {
        try {
            fs.writeFileSync(PASS_FILE, password, { mode: 0o600 });
            ADMIN_PASSWORD = password;
            auditLog(req, 'Изменён пароль встроенного администратора');
            return res.json({ success: true });
        } catch (e) { return res.status(500).json({ error: 'Ошибка записи пароля' }); }
    }
    const users = loadUsers();
    const u = users.find(x => x.username === username);
    if (!u) return res.status(404).json({ error: 'Пользователь не найден' });
    const salt = crypto.randomBytes(16).toString('hex');
    u.salt = salt;
    u.hash = hashPassword(password, salt);
    saveUsers(users);
    auditLog(req, `Сменён пароль пользователя ${username}`);
    res.json({ success: true });
});

// --- 2FA ---
app.get('/api/2fa/status', checkAuth, (req, res) => {
    const me = findUser(req.session.user || 'admin');
    const st = totpState(me);
    res.json({ user: me.username, enabled: !!st.enabled, pending: !!st.pending });
});

app.post('/api/2fa/setup', checkAuth, (req, res) => {
    const me = findUser(req.session.user || 'admin');
    if (!me) return res.status(404).json({ error: 'Пользователь не найден' });
    const secret = newTotpSecret();
    setTotpState(me.username, { totpPending: secret });
    const uri = otpauthUri(secret, me.username);
    qrDataUrl(uri).then(qr => res.json({ secret, otpauth: uri, qr }))
        .catch(() => res.json({ secret, otpauth: uri, qr: '' }));
});

app.post('/api/2fa/enable', checkAuth, (req, res) => {
    const me = findUser(req.session.user || 'admin');
    const st = totpState(me);
    const code = String((req.body && req.body.code) || '').trim();
    if (!st.pending) return res.status(400).json({ error: 'Сначала запустите настройку 2FA' });
    if (!verifyTotp(st.pending, code)) return res.status(400).json({ error: 'Неверный код. Проверьте время на телефоне.' });
    const codes = makeRecoveryCodes(10);
    setTotpState(me.username, {
        totpSecret: st.pending,
        totpPending: '',
        totpEnabled: true,
        totpRecovery: codes.map(hashCode)
    });
    auditLog(req, `Включена 2FA для ${me.username}`);
    res.json({ success: true, recoveryCodes: codes });
});

app.post('/api/2fa/disable', checkAuth, (req, res) => {
    const me = findUser(req.session.user || 'admin');
    const password = String((req.body && req.body.password) || '');
    const passwordOk = me.builtin ? safeEqual(password, ADMIN_PASSWORD) : verifyUserPassword(me, password);
    if (!passwordOk) return res.status(401).json({ error: 'Неверный пароль' });
    setTotpState(me.username, { totpSecret: '', totpPending: '', totpEnabled: false, totpRecovery: [] });
    auditLog(req, `Отключена 2FA для ${me.username}`);
    res.json({ success: true });
});

// --- Аудит ---
app.get('/api/audit', checkAuth, requireAdmin, (req, res) => {
    let text = '';
    try { text = fs.existsSync(AUDIT_LOG) ? readLogTail(AUDIT_LOG, 512 * 1024) : ''; } catch (e) { text = ''; }
    const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 300));
    const entries = [];
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\[([^\]]+)\]\s+IP:\s*(\S*)\s*\|\s*(?:USER:\s*(\S*)\s*\|\s*)?ACTION:\s*(.*)$/);
        if (m) entries.push({ time: m[1], ip: m[2], user: m[3] || '-', action: m[4] });
    }
    const sliced = entries.slice(-limit).reverse();
    if (String(req.query.format || 'json') === 'csv') {
        const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
        const csv = ['time,ip,user,action', ...sliced.map(e => [e.time, e.ip, e.user, e.action].map(esc).join(','))].join('\n');
        res.setHeader('Content-Disposition', 'attachment; filename="audit.csv"');
        return res.type('text/csv').send(csv);
    }
    res.json({ entries: sliced, total: entries.length, file: AUDIT_LOG });
});

// --- Fail2ban ---
function fail2banStatus() {
    const jail = 'servpanel';
    const installed = ['/usr/bin/fail2ban-client', '/usr/sbin/fail2ban-client', '/usr/local/bin/fail2ban-client']
        .some(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
    if (!installed) return { installed: false, jail: false, banned: [], currentlyFailed: 0, totalFailed: 0 };
    let out = '';
    try { out = shTry('sudo', ['fail2ban-client', 'status', jail]); } catch (e) { out = ''; }
    const banned = [];
    const mBan = out.match(/Banned IP list:\s*(.*)/);
    if (mBan && mBan[1].trim()) banned.push(...mBan[1].trim().split(/\s+/));
    const current = parseInt((out.match(/Currently failed:\s*(\d+)/) || [])[1], 10) || 0;
    const total = parseInt((out.match(/Total failed:\s*(\d+)/) || [])[1], 10) || 0;
    return { installed: true, jail: /Status for the jail/.test(out), banned, currentlyFailed: current, totalFailed: total };
}

app.get('/api/fail2ban/status', checkAuth, requireAdmin, (req, res) => {
    res.json({ ...fail2banStatus(), log: AUTH_LOG });
});

app.post('/api/fail2ban/unban', checkAuth, requireAdmin, (req, res) => {
    const ip = String((req.body && req.body.ip) || '').trim();
    if (!IPV4_RE.test(ip)) return res.status(400).json({ error: 'Неверный IP' });
    try {
        sh('sudo', ['fail2ban-client', 'set', 'servpanel', 'unbanip', ip]);
        auditLog(req, `Fail2ban: разбанен ${ip}`);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Не удалось разбанить (fail2ban установлен?)' }); }
});

// --- Telegram-уведомления ---
const notifyCfg = readJson(NOTIFY_FILE, {
    telegram: { enabled: false, token: '', chatId: '' },
    lastAlertAt: 0,
    lastState: ''
});
function saveNotify() { try { writeJson(NOTIFY_FILE, notifyCfg, 0o600); } catch (e) { /* ignore */ } }
const TG_TOKEN_RE = /^\d{5,20}:[A-Za-z0-9_-]{20,80}$/;
const TG_CHAT_RE = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;

async function sendTelegram(text) {
    const t = notifyCfg.telegram || {};
    if (!t.enabled || !t.token || !t.chatId) return { ok: false, error: 'Уведомления не настроены' };
    try {
        const r = await fetchWithTimeout(`https://api.telegram.org/bot${t.token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: t.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
        }, 12000);
        const j = await r.json().catch(() => ({}));
        return { ok: r.ok && j.ok !== false, status: r.status, data: j };
    } catch (e) { return { ok: false, error: e.message }; }
}

app.get('/api/notify/status', checkAuth, requireAdmin, (req, res) => {
    const t = notifyCfg.telegram || {};
    res.json({
        enabled: !!t.enabled,
        chatId: t.chatId || '',
        hasToken: !!t.token,
        lastAlertAt: notifyCfg.lastAlertAt || 0,
        lastState: notifyCfg.lastState || ''
    });
});

app.post('/api/notify/telegram', checkAuth, requireAdmin, (req, res) => {
    const { enabled, token, chatId } = req.body || {};
    const t = notifyCfg.telegram || {};
    if (token !== undefined && String(token).trim()) {
        if (!TG_TOKEN_RE.test(String(token).trim())) return res.status(400).json({ error: 'Неверный формат токена бота' });
        t.token = String(token).trim();
    }
    if (chatId !== undefined && String(chatId).trim()) {
        if (!TG_CHAT_RE.test(String(chatId).trim())) return res.status(400).json({ error: 'Неверный chat_id' });
        t.chatId = String(chatId).trim();
    }
    if (enabled !== undefined) t.enabled = !!enabled;
    if (t.enabled && (!t.token || !t.chatId)) return res.status(400).json({ error: 'Для включения нужны токен и chat_id' });
    notifyCfg.telegram = t;
    saveNotify();
    auditLog(req, `Уведомления Telegram: ${t.enabled ? 'включены' : 'выключены'}`);
    res.json({ success: true, enabled: !!t.enabled });
});

app.post('/api/notify/test', checkAuth, requireAdmin, async (req, res) => {
    const r = await sendTelegram('🛰 <b>Servpanel</b>: тестовое уведомление. Связь есть.');
    if (r.ok) { auditLog(req, 'Отправлено тестовое уведомление Telegram'); return res.json({ success: true }); }
    res.status(502).json({ error: 'Telegram отклонил сообщение', detail: (r.data && r.data.description) || r.error || 'нет ответа' });
});

// --- Здоровье каскада ---
function cascadeHealth() {
    const d = cascadeDetails();
    const checks = {
        config: !!d.configured,
        tunnel: d.tunnelActive,
        handshake: d.handshakeAgo !== null && d.handshakeAgo < 180,
        timer: d.timerActive,
        rule: !!d.ruleExists,
        table: !!d.tableRoute,
        ipset: d.ipsetCount > 100
    };
    const critical = [checks.config, checks.tunnel, checks.handshake];
    return {
        ok: critical.every(Boolean),
        checks,
        details: {
            endpoint: d.endpoint,
            handshakeAgo: d.handshakeAgo,
            ifaces: d.ifaces,
            ipsetCount: d.ipsetCount,
            tableRoute: d.tableRoute,
            lastRun: d.lastRun
        },
        checkedAt: new Date().toISOString()
    };
}

app.get('/api/cascade/health', checkAuth, (req, res) => {
    try { res.json(cascadeHealth()); }
    catch (e) { res.json({ ok: false, error: 'Ошибка проверки' }); }
});

async function cascadeMonitor() {
    if (TEST_MODE) return;
    if (!existingCascadeConf()) return; // каскад не настроен — не дёргаем систему
    let h;
    try { h = cascadeHealth(); } catch (e) { return; }
    if (!h.details || !h.details.endpoint) return; // каскад не настроен
    if (!h.ok) {
        const last = notifyCfg.lastAlertAt || 0;
        if (notifyCfg.lastState !== 'fail' && Date.now() - last > 30 * 60 * 1000) {
            const text = `⚠️ <b>Каскад RU→EU не работает</b>\n` +
                `Endpoint: <code>${h.details.endpoint}</code>\n` +
                `Туннель: ${h.checks.tunnel ? 'ок' : 'нет'}\n` +
                `Рукопожатие: ${h.details.handshakeAgo === null ? 'нет' : h.details.handshakeAgo + ' c. назад'}\n` +
                `Маршрут таблицы 100: ${h.details.tableRoute || '—'}`;
            const r = await sendTelegram(text);
            if (r.ok) { notifyCfg.lastAlertAt = Date.now(); notifyCfg.lastState = 'fail'; saveNotify(); }
        }
    } else if (notifyCfg.lastState === 'fail') {
        const r = await sendTelegram('✅ <b>Каскад RU→EU восстановлен</b>. Рукопожатие с EU снова проходит.');
        if (r.ok) { notifyCfg.lastState = 'ok'; saveNotify(); }
    }
}
if (!TEST_MODE) {
    const t1 = setTimeout(cascadeMonitor, 60 * 1000); if (t1.unref) t1.unref();
    const t2 = setInterval(cascadeMonitor, 5 * 60 * 1000); if (t2.unref) t2.unref();
}

// --- Автоматические резервные копии ---
function backupConfig() {
    const c = readJson(BACKUP_CONFIG_FILE, {});
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(c.time || '')) ? String(c.time) : '04:30';
    return {
        enabled: !!c.enabled,
        schedule: c.schedule === 'weekly' ? 'weekly' : 'daily',
        time,
        keep: Math.min(60, Math.max(1, parseInt(c.keep, 10) || 7)),
        encrypt: c.encrypt !== false
    };
}
function backupPassword() {
    try { return fs.readFileSync(BACKUP_PASS_FILE, 'utf8').trim(); } catch (e) { return ''; }
}
function ensureBackupPassword() {
    let p = backupPassword();
    if (!p) {
        p = crypto.randomBytes(18).toString('base64url');
        ensureDir(DATA_DIR, 0o700);
        fs.writeFileSync(BACKUP_PASS_FILE, p + '\n', { mode: 0o600 });
    }
    return p;
}
function listBackups() {
    try {
        return fs.readdirSync(BACKUP_DIR)
            .filter(f => /^servpanel-\d{8}-\d{6}\.tar\.gz(\.enc)?$/.test(f))
            .map(f => {
                const st = fs.statSync(path.join(BACKUP_DIR, f));
                return { name: f, size: st.size, mtime: st.mtime.toISOString() };
            })
            .sort((a, b) => b.name.localeCompare(a.name))
            .slice(0, 100);
    } catch (e) { return []; }
}

function buildBackupScript(cfg) {
    const pass = cfg.encrypt ? ensureBackupPassword() : '';
    return `#!/bin/bash
# Автоматический бэкап Servpanel. Сгенерировано панелью.
set -euo pipefail
umask 077
DIR="${BACKUP_DIR}"
KEEP="${cfg.keep}"
PASS_FILE="${BACKUP_PASS_FILE}"
mkdir -p "$DIR"
chmod 700 "$DIR"
TS=$(date +%Y%m%d-%H%M%S)
OUT="$DIR/servpanel-$TS.tar.gz"
PATHS=()
for p in /etc/amnezia/amneziawg /root/awg /root/servpanel /etc/nginx/sites-available/awg-admin /etc/nginx/.htpasswd /etc/fail2ban/filter.d/servpanel.conf /etc/fail2ban/jail.d/servpanel.local; do
  [ -e "$p" ] && PATHS+=("$p")
done
if [ \${#PATHS[@]} -eq 0 ]; then echo "Нечего архивировать"; exit 1; fi
tar -czf "$OUT" --exclude='*/.backup_pass' --exclude='*/.sessions' --exclude='*/node_modules' "\${PATHS[@]}"
${cfg.encrypt ? `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$OUT" -out "$OUT.enc" -pass "file:$PASS_FILE"
rm -f "$OUT"
OUT="$OUT.enc"` : '# Шифрование отключено'}
find "$DIR" -maxdepth 1 -type f -name 'servpanel-*' -mtime +"$KEEP" -delete
echo "OK: $OUT"
`;
}

const BACKUP_SERVICE = `[Unit]
Description=Servpanel automatic backup
After=network-online.target

[Service]
Type=oneshot
ExecStart=${BACKUP_SCRIPT}
`;
function backupTimerUnit(cfg) {
    const [hh, mm] = cfg.time.split(':');
    const when = cfg.schedule === 'weekly'
        ? `Mon *-*-* ${hh}:${mm}:00`
        : `*-*-* ${hh}:${mm}:00`;
    return `[Unit]
Description=Servpanel automatic backup timer

[Timer]
OnCalendar=${when}
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
`;
}

function installBackupTimer(cfg) {
    if (TEST_MODE || process.platform === 'win32') return { simulated: true };
    writeRootFile(BACKUP_SCRIPT, buildBackupScript(cfg), '0755');
    writeRootFile('/etc/systemd/system/servpanel-backup.service', BACKUP_SERVICE, '0644');
    writeRootFile('/etc/systemd/system/servpanel-backup.timer', backupTimerUnit(cfg), '0644');
    sh('sudo', ['systemctl', 'daemon-reload']);
    if (cfg.enabled) sh('sudo', ['systemctl', 'enable', '--now', 'servpanel-backup.timer']);
    else {
        try { sh('sudo', ['systemctl', 'disable', '--now', 'servpanel-backup.timer']); } catch (e) { /* ignore */ }
    }
    return { simulated: false };
}

app.get('/api/backup/auto', checkAuth, requireAdmin, (req, res) => {
    res.json({
        config: backupConfig(),
        timerActive: isActive('servpanel-backup.timer') === 'active',
        passwordSet: !!backupPassword(),
        archives: listBackups(),
        dir: BACKUP_DIR
    });
});

app.post('/api/backup/auto', checkAuth, requireAdmin, (req, res) => {
    const b = req.body || {};
    const cfg = {
        enabled: !!b.enabled,
        schedule: b.schedule === 'weekly' ? 'weekly' : 'daily',
        time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.time || '')) ? String(b.time) : '04:30',
        keep: Math.min(60, Math.max(1, parseInt(b.keep, 10) || 7)),
        encrypt: b.encrypt !== false
    };
    try {
        writeJson(BACKUP_CONFIG_FILE, cfg, 0o600);
        const r = installBackupTimer(cfg);
        auditLog(req, `Автобэкап: ${cfg.enabled ? 'включён' : 'выключен'} (${cfg.schedule} ${cfg.time}, хранить ${cfg.keep}, шифрование ${cfg.encrypt ? 'да' : 'нет'})`);
        res.json({ success: true, config: cfg, ...(r.simulated ? { simulated: true } : {}) });
    } catch (e) { res.status(500).json({ error: 'Ошибка настройки автобэкапа: ' + e.message }); }
});

app.post('/api/backup/run', checkAuth, requireAdmin, (req, res) => {
    try {
        if (DEMO_MODE) {
            auditLog(req, '[DEMO] Ручной запуск автобэкапа');
            return res.json({ success: true, output: 'DEMO: архив создан (имитация)', archives: listBackups() });
        }
        if (!fs.existsSync(BACKUP_SCRIPT)) return res.status(400).json({ error: 'Сначала включите автобэкап' });
        const out = sh('sudo', ['bash', BACKUP_SCRIPT], { timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
        auditLog(req, 'Ручной запуск автобэкапа');
        res.json({ success: true, output: out, archives: listBackups() });
    } catch (e) { res.status(500).json({ error: 'Ошибка бэкапа: ' + (e.stdout || e.message) }); }
});

app.get('/api/backup/list', checkAuth, requireAdmin, (req, res) => {
    res.json({ archives: listBackups(), dir: BACKUP_DIR });
});

app.get('/api/backup/password', checkAuth, requireAdmin, (req, res) => {
    const p = ensureBackupPassword();
    auditLog(req, 'Просмотр пароля резервных копий');
    res.json({ password: p });
});

app.post('/api/backup/password', checkAuth, requireAdmin, (req, res) => {
    const p = String((req.body && req.body.password) || '');
    if (p.length < 12) return res.status(400).json({ error: 'Пароль должен быть не короче 12 символов' });
    try {
        fs.writeFileSync(BACKUP_PASS_FILE, p + '\n', { mode: 0o600 });
        const cfg = backupConfig();
        if (cfg.enabled) installBackupTimer(cfg);
        auditLog(req, 'Изменён пароль резервных копий');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Ошибка сохранения пароля' }); }
});

app.get('/api/backup/archive/:name', checkAuth, requireAdmin, (req, res) => {
    const name = String(req.params.name);
    if (!/^servpanel-\d{8}-\d{6}\.tar\.gz(\.enc)?$/.test(name)) return res.status(400).json({ error: 'Неверное имя архива' });
    const file = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Архив не найден' });
    auditLog(req, `Скачивание авто-бэкапа ${name}`);
    res.download(file, name);
});

app.get('/api/backup/encrypted', checkAuth, requireAdmin, (req, res) => {
    const pass = ensureBackupPassword();
    const stamp = new Date().toISOString().replace(/T/, '-').replace(/:/g, '-').slice(0, 16);
    const plain = path.join(os.tmpdir(), `servpanel-${stamp}.tar.gz`);
    const enc = plain + '.enc';
    const paths = BACKUP_PATHS.filter(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
    try {
        sh('sudo', ['tar', '-czf', plain,
            '--exclude=*/.backup_pass', '--exclude=*/.sessions', '--exclude=*/node_modules',
            ...paths], { timeout: 180000 });
        sh('openssl', ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-salt', '-in', plain, '-out', enc, '-pass', `pass:${pass}`], { timeout: 180000 });
        auditLog(req, 'Скачивание зашифрованной резервной копии');
        res.download(enc, `servpanel-${stamp}.tar.gz.enc`, () => {
            try { fs.unlinkSync(plain); } catch (e) { /* ignore */ }
            try { fs.unlinkSync(enc); } catch (e) { /* ignore */ }
        });
    } catch (e) {
        try { fs.unlinkSync(plain); } catch (e2) { /* ignore */ }
        try { fs.unlinkSync(enc); } catch (e2) { /* ignore */ }
        res.status(500).json({ error: 'Не удалось создать зашифрованный бэкап' });
    }
});
// ---------------------------------------------------------------------------
// Каскад: статус
// ---------------------------------------------------------------------------
function cascadeDetails() {
    const conf = existingCascadeConf();
    if (TEST_MODE) {
        // В тестах не трогаем systemd/iptables и не шумим ошибками sudo
        return {
            configured: !!conf, confPath: conf || CASCADE_CONF, tunnelActive: false, timerActive: false,
            endpoint: '', ifaces: [], ipsetCount: 0, ruleExists: false, tableRoute: '', handshakeAgo: null, lastRun: null
        };
    }
    const out = {
        configured: !!conf,
        confPath: conf || CASCADE_CONF,
        tunnelActive: isActive('awg-quick@awg1') === 'active',
        timerActive: isActive('awg-routing.timer') === 'active',
        endpoint: '',
        ifaces: [],
        ipsetCount: 0,
        ruleExists: false,
        tableRoute: '',
        handshakeAgo: null,
        lastRun: null
    };
    // Туннель (awg1): рукопожатие
    try {
        const hs = shTry('sudo', ['awg', 'show', 'awg1', 'latest-handshakes']).trim();
        if (hs) {
            const first = hs.split('\n')[0].split('\t');
            const ts = parseInt(first[1] || '0', 10);
            if (ts > 0) out.handshakeAgo = Math.floor(Date.now() / 1000) - ts;
        }
    } catch (e) { /* ignore */ }
    // Endpoint из awg1.conf
    try {
        if (conf) {
            const ini = parseIni(fs.readFileSync(conf, 'utf8'));
            if (ini.Peer && ini.Peer.Endpoint) out.endpoint = ini.Peer.Endpoint;
        }
    } catch (e) { /* ignore */ }
    // Маршрутизация: интерфейсы, ipset, ip rule, таблица
    try {
        const mangle = rootShTry('iptables', ['-t', 'mangle', '-S', 'PREROUTING']);
        const matches = [...mangle.matchAll(/-A PREROUTING.*?-i\s+(\S+).*?(?:--set-xmark|--set-mark)\s+0x1/g)];
        out.ifaces = [...new Set(matches.map(m => m[1]))];
    } catch (e) { /* ignore */ }
    try {
        const cnt = shTry('sudo', ['bash', '-c', "ipset list ru 2>/dev/null | grep -c '^[0-9]' || true"]).trim();
        out.ipsetCount = parseInt(cnt, 10) || 0;
    } catch (e) { /* ignore */ }
    try { out.ruleExists = sh('ip', ['rule', 'show']).includes('fwmark 0x1'); } catch (e) { /* ignore */ }
    try { out.tableRoute = shTry('ip', ['route', 'show', 'table', '100']).trim().split('\n')[0] || ''; } catch (e) { /* ignore */ }
    try {
        if (fs.existsSync(ROUTING_SCRIPT)) out.lastRun = fs.statSync(ROUTING_SCRIPT).mtime.toISOString();
    } catch (e) { /* ignore */ }
    return out;
}

app.get('/api/cascade/status', checkAuth, (req, res) => {
    try {
        const d = cascadeDetails();
        let text = 'Туннель EU не настроен';
        let color = '#ff4c4c';
        if (d.configured) {
            if (!d.tunnelActive) { text = 'Туннель awg1 поднят, но не активен'; color = '#ffa500'; }
            else if (d.handshakeAgo === null) { text = 'Туннель поднят, ожидание пира EU'; color = '#ffa500'; }
            else if (d.handshakeAgo < 150) { text = `Каскад работает (обмен ${d.handshakeAgo} сек. назад)`; color = '#4caf50'; }
            else { text = `Связь с EU потеряна (${d.handshakeAgo} сек. назад)`; color = '#ff4c4c'; }
        }
        res.json({ ...d, active: d.configured && d.tunnelActive && d.handshakeAgo !== null && d.handshakeAgo < 150, text, color });
    } catch (e) {
        res.json({ active: false, text: 'Ошибка проверки', color: '#ff4c4c' });
    }
});

// ---------------------------------------------------------------------------
// UFW
// ---------------------------------------------------------------------------
app.get('/api/ufw', checkAuth, (req, res) => {
    try {
        const ufwOut = sh('sudo', ['ufw', 'status', 'numbered']).split('\n');
        const rules = [];
        ufwOut.forEach(line => {
            const match = line.match(/^\[\s*(\d+)\]\s+(.*?)\s+(ALLOW IN|DENY IN|REJECT IN|ALLOW|DENY|REJECT)\s+(.*)$/);
            if (match) rules.push({ id: match[1], to: match[2].trim(), action: match[3], from: match[4].trim() });
        });
        const ssOut = sh('sudo', ['ss', '-tunlp']).trim().split('\n').slice(1);
        const ports = ssOut.filter(l => l).map(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 6) return null;
            const procMatch = (parts[6] || '').match(/"([^"]+)"/);
            return { proto: parts[0], addr: parts[4], proc: procMatch ? procMatch[1] : 'Система' };
        }).filter(Boolean);
        res.json({ rules, ports });
    } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/ufw', checkAuth, (req, res) => {
    const { port, proto, iface } = req.body || {};
    if (!isPort(port)) return res.status(400).json({ error: 'Укажите корректный порт (1-65535)' });
    if (proto && !['tcp', 'udp', 'any'].includes(proto)) return res.status(400).json({ error: 'Неверный протокол' });
    if (iface && iface !== 'any' && !(IFACE_RE.test(iface) && existingIfaces().includes(iface))) {
        return res.status(400).json({ error: 'Неверный интерфейс' });
    }
    try {
        const args = ['ufw', 'allow'];
        if (iface && iface !== 'any') args.push('in', 'on', iface);
        args.push('to', 'any', 'port', String(port));
        if (proto && proto !== 'any') args.push('proto', proto);
        sh('sudo', args);
        sh('sudo', ['ufw', 'reload']);
        auditLog(req, `UFW: открыт порт ${port}/${proto || 'any'}`);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Ошибка добавления' }); }
});

app.delete('/api/ufw/:id', checkAuth, (req, res) => {
    const id = String(req.params.id);
    if (!/^\d{1,5}$/.test(id)) return res.status(400).json({ error: 'Неверный номер правила' });
    try {
        sh('sudo', ['ufw', '--force', 'delete', id]);
        auditLog(req, `UFW: удалено правило ${id}`);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Ошибка удаления' }); }
});

// ---------------------------------------------------------------------------
// Сетевые инструменты: статус
// ---------------------------------------------------------------------------
app.get('/api/tools/status', checkAuth, (req, res) => {
    let ruCount = 0, ruActive = false, ruIfaces = [], ruAllPorts = false;
    try {
        const count = rootShTry('bash', ['-c', "ipset list ru_block 2>/dev/null | grep -c '^[0-9]' || true"]).trim();
        ruCount = parseInt(count, 10) || 0;
        const forward = rootShTry('iptables', ['-S', 'FORWARD']);
        // Ищем ru_block в любом месте правила: в режиме «только порты» перед
        // --match-set стоит -p tcp/udp, а не -m set сразу после -i.
        const matches = [...forward.matchAll(/-A FORWARD .*?-i\s+(\S+).*?--match-set ru_block/g)];
        ruIfaces = [...new Set(matches.map(m => m[1]))];
        // Правило без --dport блокирует все порты; с --dport — только выбранные.
        ruAllPorts = forward.split('\n').some(l => l.includes('ru_block') && /-i\s+\S+\s+-m set --match-set ru_block\s+dst\s+-j DROP/.test(l));
        // Без правил в FORWARD один ipset ничего не блокирует — не показываем
        // «активно» только из-за непустого списка.
        ruActive = ruCount > 0 && ruIfaces.length > 0;
    } catch (e) { /* ignore */ }

    let cascActive = false, cascIfaces = [];
    try {
        const mangle = rootShTry('iptables', ['-t', 'mangle', '-S', 'PREROUTING']);
        const matches = [...mangle.matchAll(/-A PREROUTING.*?-i\s+(\S+).*?(?:--set-xmark|--set-mark)\s+0x1/g)];
        cascIfaces = [...new Set(matches.map(m => m[1]))];
        cascActive = cascIfaces.length > 0;
    } catch (e) { /* ignore */ }

    let dnsActive = false, dnsTarget = '', dnsIfaces = [];
    try {
        const nat = rootShTry('iptables', ['-t', 'nat', '-S', 'PREROUTING']);
        const dnat = [...nat.matchAll(/-A PREROUTING -i\s+(\S+).*?--dport 53 -j DNAT --to-destination\s+(\S+)/g)];
        const redirect = [...nat.matchAll(/-A PREROUTING -i\s+(\S+).*?--dport 53 -j REDIRECT --to-ports\s+(\d+)/g)];
        dnsIfaces = [...new Set([...dnat, ...redirect].map(m => m[1]))];
        if (dnat.length > 0) dnsTarget = dnat[0][2];
        else if (redirect.length > 0) dnsTarget = `127.0.0.1:${redirect[0][2]}`;
        dnsActive = dnsIfaces.length > 0;
    } catch (e) { /* ignore */ }

    // Каскад и GeoIP-блокировка на одном интерфейсе противоречат друг другу:
    // каскад отправляет RU-адреса напрямую, а ru_block их дропает.
    const conflictIfaces = ruIfaces.filter(i => cascIfaces.includes(i));

    res.json({
        ruDrop: { active: ruActive, count: ruCount, ifaces: ruIfaces, allPorts: ruAllPorts },
        cascade: { active: cascActive, ifaces: cascIfaces },
        dns: { active: dnsActive, ifaces: dnsIfaces, target: dnsTarget },
        conflictIfaces
    });
});

// ---------------------------------------------------------------------------
// GeoIP-блокировка RU-трафика
// ---------------------------------------------------------------------------
app.post('/api/tools/rudrop', checkAuth, (req, res) => {
    const { ifaces, schedule, enable } = req.body || {};

    // Сначала всегда снимаем старые правила/ipset. Важно: удаляем и
    // портовые правила, иначе при повторном включении они дублируются.
    const removeRuRules = () => {
        try {
            const forward = rootShTry('iptables', ['-S', 'FORWARD']);
            forward.split('\n').forEach(rule => {
                if (rule.includes('ru_block')) {
                    const args = rule.replace(/^-A FORWARD /, '').split(/\s+/).filter(Boolean);
                    if (args.length) { try { rootSh('iptables', ['-D', 'FORWARD', ...args]); } catch (e) { /* ignore */ } }
                }
            });
        } catch (e) { /* ignore */ }
    };
    removeRuRules();

    if (!enable) {
        try { rootSh('rm', ['-f', '/etc/cron.d/ru-drop-refresh', '/root/awg/ru-drop.sh']); } catch (e) { /* ignore */ }
        try { rootSh('ipset', ['destroy', 'ru_block']); } catch (e) { /* ignore */ }
        auditLog(req, 'GeoIP-блокировка выключена');
        return res.json({ success: true });
    }

    if (!validIfaces(ifaces)) return res.status(400).json({ error: 'Выберите существующие интерфейсы' });
    const scheduleVal = String(schedule || 'weekly');
    const cronLine = scheduleVal === 'daily' ? '0 4 * * *' : (scheduleVal === 'weekly' ? '0 4 * * 1' : '');
    const ports = String((req.body && req.body.ports) || '').trim();
    const portsArr = ports ? [...new Set(ports.split(',').map(p => p.trim()).filter(Boolean))] : [];
    if (!portsArr.every(p => isPort(p))) return res.status(400).json({ error: 'Неверный список портов' });
    const mode = portsArr.length ? 'ports' : 'all';
    const customUrl = String((req.body && req.body.customUrl) || '').trim();
    const listMode = String((req.body && req.body.listMode) || 'opencck');
    let sourceType = 'url';
    let zoneUrl = RU_GEOIP_SOURCES.opencck;
    let fallbackUrls = [RU_GEOIP_SOURCES.antifilter];
    let minValid = 1000;
    if (listMode === 'standard' || listMode === 'antifilter') {
        zoneUrl = RU_GEOIP_SOURCES.antifilter;
        fallbackUrls = [RU_GEOIP_SOURCES.opencck];
    } else if (listMode === 'custom') {
        if (!customUrl) return res.status(400).json({ error: 'Укажите URL списка' });
        if (!validGeoUrl(customUrl)) {
            return res.status(400).json({
                error: 'Неверный URL списка',
                detail: 'Нужен https:// URL без пробелов и кавычек, длиной до 8192 символов.'
            });
        }
        zoneUrl = customUrl;
        fallbackUrls = [];
        minValid = 1;
    } else if (listMode === 'upload' || listMode === 'file') {
        sourceType = 'file';
        zoneUrl = '';
        fallbackUrls = [];
        minValid = 1;
    } else if (listMode !== 'opencck') {
        return res.status(400).json({ error: 'Неизвестный источник списка' });
    }

    // URL уже прошли проверку; подставляем в bash-массив в кавычках.
    const urlsLiteral = [zoneUrl, ...fallbackUrls].filter(Boolean).map(u => `"${u}"`).join(' ');
    const cronContent =
        `@reboot root sleep 30 && /bin/bash /root/awg/ru-drop.sh >/var/log/ru-drop.log 2>&1\n` +
        (cronLine ? `${cronLine} root /bin/bash /root/awg/ru-drop.sh >/var/log/ru-drop.log 2>&1\n` : '');

    const scriptContent = `#!/bin/bash
set -euo pipefail
IFACES=(${ifaces.join(' ')})
MODE="${mode}"
PORTS="${portsArr.join(' ')}"
SOURCE_TYPE="${sourceType}"
MIN_VALID="${minValid}"
URLS=(${urlsLiteral})
AWG_DIR="/root/awg"
# Отдельный файл: не перетираем ru.zone, который использует каскад.
RU_ZONE="$AWG_DIR/ru-drop.zone"
mkdir -p "$AWG_DIR"
exec 9>"$AWG_DIR/ru-drop.lock"
flock -n 9 || { echo "Уже запущен" >&2; exit 1; }

# На минимальных образах ipset не установлен — ставим его сами.
ensure_ipset() {
  command -v ipset >/dev/null 2>&1 && return 0
  echo "ipset не найден, устанавливаю..." >&2
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ipset || true
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y ipset || true
  elif command -v yum >/dev/null 2>&1; then
    yum install -y ipset || true
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache ipset || true
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm ipset || true
  fi
  command -v ipset >/dev/null 2>&1
}
ensure_ipset || { echo "Не удалось установить ipset. Установите вручную: apt install ipset (или dnf install ipset)" >&2; exit 3; }

if [ "$SOURCE_TYPE" = "file" ]; then
  [ -s "$RU_ZONE" ] || { echo "Файл списка не найден. Загрузите его заново." >&2; exit 2; }
  valid=$(grep -cE '^[0-9]{1,3}(\\.[0-9]{1,3}){3}(/[0-9]{1,2})?$' "$RU_ZONE" || true)
  [ "$valid" -ge "$MIN_VALID" ] || { echo "В файле нет IPv4/CIDR." >&2; exit 2; }
else
  ok=0
  last_err=""
  for url in "\${URLS[@]}"; do
    if curl -fsS --retry 2 --connect-timeout 10 --max-time 60 -o "$RU_ZONE.tmp" "$url"; then
      valid=$(grep -cE '^[0-9]{1,3}(\\.[0-9]{1,3}){3}(/[0-9]{1,2})?$' "$RU_ZONE.tmp" || true)
      if [ "$valid" -ge "$MIN_VALID" ]; then
        mv -f "$RU_ZONE.tmp" "$RU_ZONE"
        ok=1
        break
      fi
      last_err="Источник $url: найдено $valid адресов, нужно минимум $MIN_VALID"
    else
      last_err="Не удалось скачать источник: $url"
    fi
  done
  if [ "$ok" -ne 1 ]; then
    rm -f "$RU_ZONE.tmp"
    echo "\${last_err:-Не удалось загрузить список}" >&2
    exit 1
  fi
fi
ipset create ru_block hash:net -exist
ipset create ru_tmp hash:net -exist
ipset flush ru_tmp
while read -r net; do
  [ -n "$net" ] && ipset add ru_tmp "$net" -exist
done < "$RU_ZONE"
ipset swap ru_tmp ru_block
ipset destroy ru_tmp

# Убираем все прежние правила ru_block (включая портовые), чтобы не плодить дубли.
while IFS= read -r rule; do
  [ -n "$rule" ] || continue
  # shellcheck disable=SC2086
  iptables -w 5 -D FORWARD \${rule#-A FORWARD } 2>/dev/null || true
done < <(iptables -S FORWARD | grep 'ru_block' || true)

for AWG_IF in "\${IFACES[@]}"; do
  if [ "$MODE" = "ports" ]; then
    for PORT in $PORTS; do
      iptables -w 5 -I FORWARD 1 -i "$AWG_IF" -p tcp --dport "$PORT" -m set --match-set ru_block dst -j DROP
      iptables -w 5 -I FORWARD 1 -i "$AWG_IF" -p udp --dport "$PORT" -m set --match-set ru_block dst -j DROP
    done
  else
    iptables -w 5 -I FORWARD 1 -i "$AWG_IF" -m set --match-set ru_block dst -j DROP
  fi
done
# Разрешаем уже установленные соединения (правило должно быть выше DROP).
for AWG_IF in "\${IFACES[@]}"; do
  iptables -w 5 -I FORWARD 1 -i "$AWG_IF" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
done
echo "OK"
`;
    try {
        writeRootFile('/root/awg/ru-drop.sh', scriptContent, '0755');
        // Cron — только автообновление. Если /etc/cron.d недоступен, сама
        // блокировка всё равно должна включиться, поэтому не валим запрос.
        let cronWarning = '';
        try {
            writeRootFile('/etc/cron.d/ru-drop-refresh', cronContent, '0644');
        } catch (e) {
            cronWarning = String(e.stderr || e.message || '').trim().slice(-800) ||
                'не удалось записать /etc/cron.d/ru-drop-refresh';
        }
        // 5 минут: на минимальных образах первый запуск может доустанавливать ipset.
        rootExecFile('/root/awg/ru-drop.sh', [], { timeout: 300000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                let detail = String(stderr || stdout || err.message || '').trim();
                if (!detail) {
                    try {
                        detail = fs.readFileSync('/var/log/ru-drop.log', 'utf8').trim().split(/\r?\n/).slice(-8).join('\n');
                    } catch (e) { /* ignore */ }
                }
                detail = detail.slice(-1200);
                auditLog(req, `GeoIP-блокировка: ошибка загрузки списка ${detail}`.slice(0, 900));
                return res.status(500).json({ error: 'Ошибка загрузки базы GeoIP', detail });
            }
            auditLog(req, `GeoIP-блокировка включена для: ${ifaces.join(', ')}`);
            const payload = { success: true };
            if (cronWarning) {
                payload.warning = 'Блокировка включена, но автообновление не настроено: ' + cronWarning;
            }
            res.json(payload);
        });
    } catch (e) {
        let detail = String(e.stderr || e.stdout || e.message || '').trim().slice(-1200);
        if (!detail) detail = 'Не удалось записать /root/awg/ru-drop.sh.';
        auditLog(req, `GeoIP-блокировка: ошибка установки скрипта ${detail}`.slice(0, 900));
        res.status(500).json({ error: 'Ошибка установки скрипта', detail });
    }
});

// Загрузка своего списка IP/CIDR. Принимаем любой текстовый формат:
// из файла извлекаются все IPv4 и подсети, остальное игнорируется.
app.post('/api/tools/rudrop/upload', checkAuth, requireAdmin, (req, res) => {
    const body = req.body || {};
    const name = String(body.name || 'list.txt').replace(/[\r\n]/g, ' ').slice(0, 120);
    const data = String(body.data || '');
    if (!data) return res.status(400).json({ error: 'Файл не передан' });
    if (data.length > 14 * 1024 * 1024) return res.status(413).json({ error: 'Файл слишком большой (максимум 10 МБ)' });

    let text;
    try {
        text = Buffer.from(data, 'base64').toString('utf8');
    } catch (e) {
        return res.status(400).json({ error: 'Не удалось прочитать файл' });
    }
    const list = parseIpList(text);
    if (!list.length) return res.status(400).json({ error: 'В файле не найдено IPv4-адресов или подсетей' });
    if (list.length > 2000000) return res.status(413).json({ error: 'Слишком много адресов (максимум 2 000 000)' });

    if (TEST_MODE || DEMO_MODE) {
        return res.json({ success: true, count: list.length, name, demo: true });
    }
    try {
        writeRootFile('/root/awg/ru-drop.zone', list.join('\n') + '\n', '0644');
        auditLog(req, `GeoIP: загружен свой список «${name}» (${list.length} адресов)`);
        res.json({ success: true, count: list.length, name });
    } catch (e) {
        res.status(500).json({ error: 'Не удалось сохранить список на сервере' });
    }
});

// ---------------------------------------------------------------------------
// Перехват DNS
// ---------------------------------------------------------------------------
// Удаляем все DNS-правила панели на интерфейсе (DNAT/REDIRECT :53 и DROP :853).
// Перечисляем правила через iptables -S, а не полагаемся только на oldIfaces:
// так не остаются дубли, если предыдущее состояние не прочиталось.
function removeDnsRules(iface, target) {
    if (!IFACE_RE.test(String(iface))) return;
    try {
        const nat = rootShTry('iptables', ['-t', 'nat', '-S', 'PREROUTING']);
        nat.split('\n').forEach(rule => {
            if (!rule.startsWith('-A PREROUTING ') || !rule.includes('--dport 53')) return;
            if (!new RegExp(`-i\\s+${iface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(rule)) return;
            if (!rule.includes('DNAT') && !rule.includes('REDIRECT')) return;
            const args = rule.replace(/^-A PREROUTING /, '').split(/\s+/).filter(Boolean);
            if (args.length) { try { sh('sudo', ['iptables', '-t', 'nat', '-D', 'PREROUTING', ...args]); } catch (e) { /* ignore */ } }
        });
    } catch (e) { /* ignore */ }
    // На случай, если iptables -S недоступен, пробуем удалить точное правило.
    if (isDnsTarget(target)) {
        const parts = String(target).split(':');
        const ip = parts[0], port = parts[1] || '53';
        for (const proto of ['udp', 'tcp']) {
            try {
                if (ip.startsWith('127.')) {
                    sh('sudo', ['iptables', '-t', 'nat', '-D', 'PREROUTING', '-i', iface, '-p', proto,
                        '--dport', '53', '-j', 'REDIRECT', '--to-ports', port]);
                } else {
                    sh('sudo', ['iptables', '-t', 'nat', '-D', 'PREROUTING', '-i', iface, '-p', proto,
                        '--dport', '53', '-j', 'DNAT', '--to-destination', target]);
                }
            } catch (e) { /* ignore */ }
        }
    }
    try {
        const forward = rootShTry('iptables', ['-S', 'FORWARD']);
        forward.split('\n').forEach(rule => {
            if (!rule.startsWith('-A FORWARD ') || !rule.includes('--dport 853') || !rule.includes('-j DROP')) return;
            if (!new RegExp(`-i\\s+${iface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(rule)) return;
            const args = rule.replace(/^-A FORWARD /, '').split(/\s+/).filter(Boolean);
            if (args.length) { try { sh('sudo', ['iptables', '-D', 'FORWARD', ...args]); } catch (e) { /* ignore */ } }
        });
    } catch (e) { /* ignore */ }
}

app.post('/api/tools/dns', checkAuth, (req, res) => {
    const { ifaces, target, enable, oldIfaces, oldTarget } = req.body || {};

    // Снятие старых правил (и на старых интерфейсах, и на выбранных — чтобы
    // смена цели не оставляла второе правило с прежним IP).
    if (Array.isArray(oldIfaces) && oldIfaces.length > 0) {
        oldIfaces.forEach(oldIface => removeDnsRules(oldIface, oldTarget));
    }

    if (enable) {
        if (!validIfaces(ifaces)) return res.status(400).json({ error: 'Выберите существующие интерфейсы' });
        if (!isDnsTarget(target)) return res.status(400).json({ error: 'Неверный IP DNS (ожидается IP или IP:порт)' });
        const parts = String(target).split(':');
        const ip = parts[0], port = parts[1] || '53';
        if (ip === '0.0.0.0') return res.status(400).json({ error: 'Укажите конкретный IP AdGuard, а не 0.0.0.0' });
        const loopback = ip.startsWith('127.');

        try {
            const fwd = shTry('sudo', ['sysctl', '-n', 'net.ipv4.ip_forward']).trim();
            if (fwd !== '1') {
                return res.status(400).json({ error: 'Включите IP-форвардинг: sysctl -w net.ipv4.ip_forward=1 (обычно его включает AWG)' });
            }
        } catch (e) { /* ignore */ }

        ifaces.forEach(iface => {
            removeDnsRules(iface, target);
            for (const proto of ['udp', 'tcp']) {
                try {
                    if (loopback) {
                        // REDIRECT приводит пакет на локальный порт. AdGuard должен
                        // слушать 0.0.0.0 (а не только 127.0.0.1), иначе ответа не будет.
                        sh('sudo', ['iptables', '-t', 'nat', '-I', 'PREROUTING', '1', '-i', iface, '-p', proto,
                            '--dport', '53', '-j', 'REDIRECT', '--to-ports', port]);
                    } else {
                        sh('sudo', ['iptables', '-t', 'nat', '-I', 'PREROUTING', '1', '-i', iface, '-p', proto,
                            '--dport', '53', '-j', 'DNAT', '--to-destination', `${ip}:${port}`]);
                    }
                } catch (e) { /* ignore */ }
            }
            // DoT (tcp/853) и DoQ (udp/853) — иначе клиент обойдёт перехват.
            for (const proto of ['tcp', 'udp']) {
                try {
                    sh('sudo', ['iptables', '-I', 'FORWARD', '1', '-i', iface, '-p', proto,
                        '--dport', '853', '-j', 'DROP']);
                } catch (e) { /* ignore */ }
            }
        });
        auditLog(req, `Перехват DNS включён (${ifaces.join(', ')}) -> ${loopback ? '127.0.0.1:' + port : ip + ':' + port}`);
        res.json({ success: true, target: loopback ? `127.0.0.1:${port}` : `${ip}:${port}`, warning: loopback ? 'AdGuard должен слушать 0.0.0.0, иначе REDIRECT не сработает' : undefined });
    } else {
        auditLog(req, 'Перехват DNS выключен');
        res.json({ success: true });
    }
});
// ---------------------------------------------------------------------------
// Каскад: генерация скрипта маршрутизации (по CASCADE.md от bivlked)
// ---------------------------------------------------------------------------
function cascadeEndpoint() {
    const conf = existingCascadeConf();
    if (!conf) return null;
    try {
        const ini = parseIni(fs.readFileSync(conf, 'utf8'));
        const ep = ini.Peer && ini.Peer.Endpoint;
        if (!ep) return null;
        const m = String(ep).match(/^([A-Za-z0-9.\-]+):(\d{1,5})$/);
        if (!m || !isIpOrHost(m[1]) || !isPort(m[2])) return null;
        return { host: m[1], port: m[2], raw: `${m[1]}:${m[2]}` };
    } catch (e) { return null; }
}

function buildRoutingScript(ifaces, extraRuNets) {
    const ep = cascadeEndpoint();
    if (!ep) throw new Error('Не удалось определить Endpoint туннеля awg1 (проверьте awg1.conf)');
    const extra = (extraRuNets || []).join('\n');
    return `#!/bin/bash
# Каскад RU -> EU. Сгенерировано панелью (схема: bivlked/amneziawg-installer/CASCADE.md)
set -euo pipefail
CASC_IFACES=(${ifaces.join(' ')})
AWG1_IF="awg1"
AWG1_ENDPOINT="${ep.raw}"
TABLE_ID=100
FWMARK="0x1"
RULE_PRIO=10000
RU_ZONE_URL="https://www.ipdeny.com/ipblocks/data/aggregated/ru-aggregated.zone"
RU_ZONE_FALLBACK_URL="https://raw.githubusercontent.com/bivlked/amneziawg-installer/main/cascade/ru.zone"
EXTRA_RU_NETS="${extra}"
AWG_DIR="/root/awg"
RU_ZONE="$AWG_DIR/ru.zone"
mkdir -p "$AWG_DIR"
exec 9>"$AWG_DIR/awg-routing.lock"
flock -w 300 9 || exit 1
trap 'rm -f "$RU_ZONE.tmp"' EXIT

EP_ROUTE="$(ip -4 route get "$AWG1_ENDPOINT" 2>/dev/null | head -1)"
WAN_IF="$(printf '%s' "$EP_ROUTE" | grep -oP '\\bdev \\K\\S+' || true)"
WAN_GW="$(printf '%s' "$EP_ROUTE" | grep -oP '\\bvia \\K\\S+' || true)"
[ -n "$WAN_IF" ] || { echo "Не удалось определить внешний интерфейс"; exit 1; }

fetch_ru_zone() {
    curl -fsS --retry 2 --connect-timeout 10 --max-time 60 -o "$RU_ZONE.tmp" "$1" || return 1
    local valid
    valid=$(grep -cE '^[0-9]{1,3}(\\.[0-9]{1,3}){3}(/[0-9]{1,2})?$' "$RU_ZONE.tmp" || true)
    [ "$valid" -ge 1000 ]
}
if fetch_ru_zone "$RU_ZONE_URL"; then
    mv -f "$RU_ZONE.tmp" "$RU_ZONE"
elif fetch_ru_zone "$RU_ZONE_FALLBACK_URL"; then
    mv -f "$RU_ZONE.tmp" "$RU_ZONE"
fi

# Список российских сетей
if [ -f "$RU_ZONE" ] && [ -s "$RU_ZONE" ]; then
    ipset create ru hash:net -exist
    ipset create ru_tmp hash:net -exist
    ipset flush ru_tmp
    while read -r net; do [ -n "$net" ] && ipset add ru_tmp "$net" -exist; done < "$RU_ZONE"
    if [ -n "$EXTRA_RU_NETS" ]; then
        while read -r net; do [ -n "$net" ] && ipset add ru_tmp "$net" -exist; done <<< "$EXTRA_RU_NETS"
    fi
    ipset swap ru_tmp ru
    ipset destroy ru_tmp
fi

# Отдельная таблица маршрутизации для помеченного трафика -> в туннель
ip route replace default dev "$AWG1_IF" table "$TABLE_ID"
ip rule del fwmark "$FWMARK" table "$TABLE_ID" 2>/dev/null || true
ip rule add fwmark "$FWMARK" table "$TABLE_ID" priority "$RULE_PRIO"

# Маршрут до EU-сервера — всегда через основной шлюз (иначе туннель зациклится)
if [ -n "$WAN_GW" ]; then
    ip route replace "$AWG1_ENDPOINT" via "$WAN_GW" dev "$WAN_IF" onlink 2>/dev/null || \\
        ip route replace "$AWG1_ENDPOINT" via "$WAN_GW" dev "$WAN_IF"
else
    ip route replace "$AWG1_ENDPOINT" dev "$WAN_IF"
fi

# Правила для каждого клиентского интерфейса:
#   - трафик к российским сетям -> напрямую (RETURN), остальной -> в туннель (MARK)
for IFACE in "\${CASC_IFACES[@]}"; do
    SUBNET=$(ip -o -f inet addr show "$IFACE" 2>/dev/null | awk '{print $4}' | head -n 1 || true)
    [ -n "$SUBNET" ] || continue
    iptables -w 5 -t mangle -D PREROUTING -i "$IFACE" -s "$SUBNET" -m set --match-set ru dst -j RETURN 2>/dev/null || true
    iptables -w 5 -t mangle -D PREROUTING -i "$IFACE" -s "$SUBNET" -j MARK --set-xmark "$FWMARK" 2>/dev/null || true
    iptables -w 5 -t nat -D POSTROUTING -s "$SUBNET" -o "$AWG1_IF" -j MASQUERADE 2>/dev/null || true
    iptables -w 5 -t mangle -I PREROUTING 1 -i "$IFACE" -s "$SUBNET" -m set --match-set ru dst -j RETURN
    iptables -w 5 -t mangle -A PREROUTING -i "$IFACE" -s "$SUBNET" -j MARK --set-xmark "$FWMARK"
    iptables -w 5 -t nat -A POSTROUTING -s "$SUBNET" -o "$AWG1_IF" -j MASQUERADE
done

sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
echo "ОК: маршруты каскада применены ($(date '+%Y-%m-%d %H:%M:%S'))"
`;
}

const ROUTING_SERVICE = `[Unit]
Description=AmneziaWG cascade routing (RU -> EU)
After=network-online.target awg-quick@awg1.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/root/awg/awg-routing.sh
RemainAfterExit=no
`;
const ROUTING_TIMER = `[Unit]
Description=Refresh AmneziaWG cascade routing

[Timer]
OnBootSec=30s
OnUnitActiveSec=300s
AccuracySec=10s

[Install]
WantedBy=timers.target
`;

function installRouting(ifaces, extraRuNets) {
    const script = buildRoutingScript(ifaces, extraRuNets);
    writeRootFile(ROUTING_SCRIPT, script, '0755');
    writeRootFile('/etc/systemd/system/awg-routing.service', ROUTING_SERVICE, '0644');
    writeRootFile('/etc/systemd/system/awg-routing.timer', ROUTING_TIMER, '0644');
    sh('sudo', ['systemctl', 'daemon-reload']);
    sh('sudo', ['systemctl', 'enable', '--now', 'awg-quick@awg1']);
    sh('sudo', ['systemctl', 'enable', '--now', 'awg-routing.timer']);
    const out = sh('sudo', ['systemctl', 'start', 'awg-routing.service']);
    return { script, out };
}

function teardownRouting() {
    try { sh('sudo', ['systemctl', 'stop', 'awg-routing.timer', 'awg-routing.service']); } catch (e) { /* ignore */ }
    try { sh('sudo', ['systemctl', 'disable', 'awg-routing.timer']); } catch (e) { /* ignore */ }
    try {
        const mangle = rootShTry('iptables', ['-t', 'mangle', '-S', 'PREROUTING']);
        mangle.split('\n').forEach(rule => {
            if (rule.startsWith('-A PREROUTING') && (rule.includes('--set-xmark 0x1') || rule.includes('--set-mark 0x1') || rule.includes('match-set ru dst -j RETURN'))) {
                const args = rule.replace(/^-A PREROUTING /, '').split(/\s+/).filter(Boolean);
                if (args.length) { try { sh('sudo', ['iptables', '-t', 'mangle', '-D', 'PREROUTING', ...args]); } catch (e) { /* ignore */ } }
            }
        });
    } catch (e) { /* ignore */ }
    try {
        const nat = shTry('sudo', ['iptables', '-t', 'nat', '-S', 'POSTROUTING']);
        nat.split('\n').forEach(rule => {
            if (rule.startsWith('-A POSTROUTING') && rule.includes('-o awg1 -j MASQUERADE')) {
                const args = rule.replace(/^-A POSTROUTING /, '').split(/\s+/).filter(Boolean);
                if (args.length) { try { sh('sudo', ['iptables', '-t', 'nat', '-D', 'POSTROUTING', ...args]); } catch (e) { /* ignore */ } }
            }
        });
    } catch (e) { /* ignore */ }
    try { sh('sudo', ['ip', 'rule', 'del', 'fwmark', '0x1', 'table', '100']); } catch (e) { /* ignore */ }
    try { sh('sudo', ['ip', 'route', 'flush', 'table', '100']); } catch (e) { /* ignore */ }
    try { sh('sudo', ['ipset', 'destroy', 'ru']); } catch (e) { /* ignore */ }
}

// Настройка каскада из клиентского конфига EU-сервера (вставка в панель)
app.post('/api/cascade/setup', checkAuth, (req, res) => {
    const { config, ifaces, extraRuNets } = req.body || {};
    const conf = String(config || '');
    if (conf.length > 64 * 1024) return res.status(400).json({ error: 'Конфиг слишком большой' });
    if (!conf.trim()) return res.status(400).json({ error: 'Вставьте конфиг клиента с EU-сервера' });

    const ini = parseIni(conf);
    if (!ini.Interface || !ini.Peer) return res.status(400).json({ error: 'В конфиге должны быть секции [Interface] и [Peer]' });
    if (!ini.Interface.PrivateKey) return res.status(400).json({ error: 'В [Interface] нет PrivateKey' });
    if (!ini.Peer.PublicKey) return res.status(400).json({ error: 'В [Peer] нет PublicKey' });
    const epm = String(ini.Peer.Endpoint || '').match(/^([A-Za-z0-9.\-]+):(\d{1,5})$/);
    if (!epm || !isIpOrHost(epm[1]) || !isPort(epm[2])) return res.status(400).json({ error: 'Некорректный Endpoint в [Peer]' });
    if (!validIfaces(ifaces)) return res.status(400).json({ error: 'Выберите клиентские интерфейсы (обычно awg0)' });
    const extra = parseCidrList(extraRuNets);
    if (extra === null) return res.status(400).json({ error: 'Некорректная подсеть в «дополнительных сетях РФ»' });

    try {
        // Готовим awg1.conf по CASCADE.md: без DNS, с Table = off
        const lines = conf.split(/\r?\n/).filter(l => !/^\s*DNS\s*=/i.test(l) && !/^\s*Table\s*=/i.test(l));
        const idx = lines.findIndex(l => /^\s*\[Interface\]\s*$/i.test(l));
        lines.splice(idx + 1, 0, 'Table = off');
        const cleanConf = lines.join('\n').trim() + '\n';

        writeRootFile(CASCADE_CONF, cleanConf, '0600');
        // Убираем старый файл, если он мешал
        if (CASCADE_CONF_LEGACY !== CASCADE_CONF && fs.existsSync(CASCADE_CONF_LEGACY)) {
            try { sh('sudo', ['rm', '-f', CASCADE_CONF_LEGACY]); } catch (e) { /* ignore */ }
        }

        sh('sudo', ['systemctl', 'enable', '--now', 'awg-quick@awg1']);
        // Небольшая задержка на поднятие интерфейса
        try { sh('sleep', ['2']); } catch (e) { /* ignore */ }
        const r = installRouting(ifaces, extra);
        auditLog(req, `Каскад настроен: awg1 -> ${epm[1]}:${epm[2]}, интерфейсы: ${ifaces.join(', ')}`);
        res.json({ success: true, endpoint: `${epm[1]}:${epm[2]}`, output: r.out, details: cascadeDetails() });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка настройки каскада: ' + e.message });
    }
});

app.post('/api/cascade/refresh', checkAuth, (req, res) => {
    try {
        if (!fs.existsSync(ROUTING_SCRIPT)) return res.status(400).json({ error: 'Каскад ещё не настроен' });
        const out = sh('sudo', [ROUTING_SCRIPT], { timeout: 120000 });
        auditLog(req, 'Обновление маршрутов каскада');
        res.json({ success: true, output: out });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка обновления: ' + (e.stdout || e.message) });
    }
});

app.post('/api/cascade/remove', checkAuth, (req, res) => {
    try {
        teardownRouting();
        auditLog(req, 'Каскад отключён');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Ошибка отключения каскада' }); }
});

// Конфиг транзитного туннеля (awg1.conf) — чтение/запись
app.get('/api/cascade/config', checkAuth, (req, res) => {
    const conf = existingCascadeConf();
    if (!conf) return res.status(404).json({ error: 'Конфиг туннеля не найден' });
    try {
        res.json({ content: fs.readFileSync(conf, 'utf8'), file: conf });
    } catch (e) { res.status(500).json({ error: 'Ошибка чтения' }); }
});

// Совместимость со старым вызовом из вкладки «Защита и Cron»
app.post('/api/tools/cascade', checkAuth, (req, res) => {
    const { ifaces, enable } = req.body || {};
    if (enable) {
        if (!existingCascadeConf()) {
            return res.status(400).json({ error: 'Каскад не настроен. Сначала укажите конфиг EU-сервера на вкладке «Каскад».' });
        }
        if (!validIfaces(ifaces)) return res.json({ error: 'Выберите существующие интерфейсы' });
        try {
            const extra = parseCidrList('') || [];
            installRouting(ifaces, extra);
            auditLog(req, `Маршруты каскада применены: ${ifaces.join(', ')}`);
            res.json({ success: true });
        } catch (e) { res.json({ error: 'Ошибка настройки каскада: ' + e.message }); }
    } else {
        try { sh('sudo', ['systemctl', 'stop', 'awg-routing.timer', 'awg-routing.service']); } catch (e) { /* ignore */ }
        auditLog(req, 'Маршруты каскада остановлены');
        res.json({ success: true });
    }
});

// ---------------------------------------------------------------------------
// Службы
// ---------------------------------------------------------------------------
function serviceList() {
    const base = [
        { name: 'AdGuardHome', desc: 'DNS-фильтр AdGuard' },
        { name: 'nginx', desc: 'Веб-сервер / панель' },
        { name: 'sshd', desc: 'SSH-доступ' },
        { name: 'cron', desc: 'Планировщик задач' },
        { name: 'awg-routing.timer', desc: 'Обновление маршрутов каскада' }
    ];
    // Показываем WARP/Xray только если они действительно установлены.
    if (fs.existsSync('/usr/local/etc/xray/config.json') || fs.existsSync('/usr/local/bin/xray') ||
        fs.existsSync('/etc/systemd/system/xray.service') || fs.existsSync('/lib/systemd/system/xray.service')) {
        base.push({ name: 'xray', desc: 'Xray — WARP для AdGuard' });
    }
    if (fs.existsSync('/usr/bin/warp-cli') || fs.existsSync('/usr/local/bin/warp-cli') ||
        fs.existsSync('/lib/systemd/system/warp-svc.service') || fs.existsSync('/etc/systemd/system/warp-svc.service')) {
        base.push({ name: 'warp-svc', desc: 'Cloudflare WARP' });
    }
    for (const iface of ['awg0', 'amn0', 'awg1']) {
        if (fs.existsSync(path.join(AWG_CONF_DIR, iface + '.conf'))) {
            base.push({ name: `awg-quick@${iface}`, desc: `AmneziaWG туннель ${iface}` });
        }
    }
    return base.map(s => {
        const act = isActive(s.name);
        return {
            name: s.name,
            desc: s.desc,
            status: act === 'active' ? 'running' : 'stopped',
            state: act,
            enabled: isEnabled(s.name) === 'enabled'
        };
    });
}

app.get('/api/services', checkAuth, (req, res) => {
    try { res.json(serviceList()); }
    catch (e) { res.status(500).json({ error: 'Ошибка чтения служб' }); }
});

app.post('/api/services/restart', checkAuth, (req, res) => {
    const name = String((req.body && req.body.name) || '');
    const allowed = serviceList().map(s => s.name);
    if (!SERVICE_RE.test(name) || !allowed.includes(name)) {
        return res.status(400).json({ error: 'Неверное имя службы' });
    }
    try {
        sh('sudo', ['systemctl', 'restart', name]);
        auditLog(req, `Перезапуск службы ${name}`);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Ошибка перезапуска' }); }
});
// ---------------------------------------------------------------------------
// AdGuard Home: прокси к API (Basic-auth). Наружу отдаём только нужные вызовы.
// ---------------------------------------------------------------------------
const AG_ACTIONS = {
    status: { m: 'GET', p: '/control/status' },
    stats: { m: 'GET', p: '/control/stats', q: ['recent'] },
    clients: { m: 'GET', p: '/control/clients' },
    client_add: { m: 'POST', p: '/control/clients/add' },
    client_update: { m: 'POST', p: '/control/clients/update' },
    client_delete: { m: 'POST', p: '/control/clients/delete' },
    filtering: { m: 'GET', p: '/control/filtering/status' },
    filter_add: { m: 'POST', p: '/control/filtering/add_url' },
    filter_remove: { m: 'POST', p: '/control/filtering/remove_url' },
    filter_refresh: { m: 'POST', p: '/control/filtering/refresh' },
    filter_rules: { m: 'POST', p: '/control/filtering/set_rules' },
    querylog: { m: 'GET', p: '/control/querylog', q: ['limit', 'search', 'older_than', 'offset'] },
    querylog_clear: { m: 'POST', p: '/control/querylog_clear' },
    rewrites: { m: 'GET', p: '/control/rewrite/list' },
    rewrite_add: { m: 'POST', p: '/control/rewrite/add' },
    rewrite_delete: { m: 'POST', p: '/control/rewrite/delete' },
    protection: { m: 'POST', p: '/control/protection' },
    safebrowsing: { m: 'GET', p: '/control/safebrowsing/status' },
    safebrowsing_enable: { m: 'POST', p: '/control/safebrowsing/enable' },
    parental: { m: 'GET', p: '/control/parental/status' },
    parental_enable: { m: 'POST', p: '/control/parental/enable' },
    version: { m: 'POST', p: '/control/version.json' }
};

function normalizeAgUrl(u) {
    let s = String(u || '').trim();
    if (!s || /\s/.test(s)) return null;
    const scheme = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
    if (scheme) {
        if (!/^https?$/i.test(scheme[1])) return null;
    } else {
        if (s.includes('://')) return null;
        s = (/:(443|4443)\b/.test(s) ? 'https://' : 'http://') + s;
    }
    try {
        const p = new URL(s);
        if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
        return (p.origin + p.pathname.replace(/\/+$/, '')).replace(/\/+$/, '');
    } catch (e) { return null; }
}

app.post('/api/adguard/proxy', checkAuth, async (req, res) => {
    const body = req.body || {};
    const base = normalizeAgUrl(body.url);
    if (!base) return res.status(400).json({ error: 'Некорректный URL AdGuard' });
    const action = Object.prototype.hasOwnProperty.call(AG_ACTIONS, body.action) ? AG_ACTIONS[body.action] : null;
    if (!action) return res.status(400).json({ error: 'Неизвестное действие' });

    let target = base + action.p;
    if (action.q) {
        const qs = new URLSearchParams();
        for (const key of action.q) {
            const v = body.params && body.params[key];
            if (v !== undefined && v !== null && v !== '') qs.set(key, String(v));
        }
        const s = qs.toString();
        if (s) target += '?' + s;
    }

    const headers = { 'Accept': 'application/json' };
    if (body.user && body.pass) {
        headers['Authorization'] = 'Basic ' + Buffer.from(String(body.user) + ':' + String(body.pass)).toString('base64');
    }

    const opts = { method: action.m, headers };
    if (body.payload && action.m !== 'GET') {
        headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body.payload);
    }

    try {
        const response = await fetchWithTimeout(target, opts, 10000);
        const text = await response.text();
        let data = null;
        if (text) { try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 4096) }; } }
        if (!response.ok) {
            return res.status(200).json({ ok: false, httpStatus: response.status, data });
        }
        return res.json({ ok: true, httpStatus: response.status, data });
    } catch (e) {
        return res.status(200).json({ ok: false, error: 'Не удалось подключиться к AdGuard: ' + e.message });
    }
});

// Совместимость со старым вызовом (вкладка «Службы»)
app.post('/api/adguard/stats', checkAuth, async (req, res) => {
    const { url, user, pass } = req.body || {};
    const base = normalizeAgUrl(url);
    if (!base) return res.status(400).json({ error: 'Укажите URL API' });
    const headers = { 'Accept': 'application/json' };
    if (user && pass) headers['Authorization'] = 'Basic ' + Buffer.from(String(user) + ':' + String(pass)).toString('base64');
    try {
        const response = await fetchWithTimeout(base + '/control/stats', { headers }, 8000);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        res.json(await response.json());
    } catch (e) {
        res.status(500).json({ error: 'Не удалось подключиться к AdGuard: ' + e.message });
    }
});

// Автопоиск AdGuard Home по типовым адресам. Проверяем параллельно, чтобы
// мастер не ждал 4 × timeout. Возвращаем первый рабочий API и его статистику.
app.get('/api/adguard/autodetect', checkAuth, async (req, res) => {
    const candidates = [
        'http://127.0.0.1:8090',
        'http://172.17.0.1:4443',
        'http://127.0.0.1:4443',
        'http://127.0.0.1:3000'
    ];
    const results = await Promise.all(candidates.map(async url => {
        try {
            const response = await fetchWithTimeout(url + '/control/stats', {
                headers: { 'Accept': 'application/json' }
            }, 2500);
            if (!response.ok) return null;
            const stats = await response.json();
            return { url, stats };
        } catch (e) { return null; }
    }));
    const found = results.find(Boolean);
    if (!found) return res.json({ found: false, tried: candidates });
    res.json({ found: true, ...found });
});

// ---------------------------------------------------------------------------
// WARP + Xray для AdGuard (опционально)
// ---------------------------------------------------------------------------
app.get('/api/warp/status', checkAuth, (req, res) => {
    const cfg = warpConfig();
    const domains = warpDomainList();
    const adguard = warpAdguardState();

    if (TEST_MODE || DEMO_MODE) {
        return res.json({
            ...cfg,
            installed: false,
            warpActive: false,
            xrayActive: false,
            connected: false,
            warpStatus: 'demo',
            domains: domains.length,
            adguard,
            testMode: true
        });
    }

    let warpActive = false, xrayActive = false, connected = false, warpStatus = '';
    try { warpActive = isActive('warp-svc') === 'active'; } catch (e) { /* ignore */ }
    try { xrayActive = isActive('xray') === 'active'; } catch (e) { /* ignore */ }
    try {
        warpStatus = String(shTry('bash', ['-c', 'warp-cli status 2>&1'], { timeout: 8000 }) || '').trim();
        connected = /(^|\s)Connected(\s|$)/i.test(warpStatus) && !/Disconnected/i.test(warpStatus);
    } catch (e) { /* ignore */ }

    res.json({
        ...cfg,
        installed: cfg.installed || warpActive,
        warpActive,
        xrayActive,
        connected,
        warpStatus: warpStatus.slice(0, 2000),
        domains: domains.length,
        adguard
    });
});

app.get('/api/warp/domains', checkAuth, (req, res) => {
    const domains = warpDomainList();
    res.json({ count: domains.length, domains });
});

// Включение/выключение WARP и Xray. Пакеты при выключении не удаляются:
// компонент остаётся установленным, но перестаёт принимать трафик.
app.post('/api/warp/power', checkAuth, requireAdmin, (req, res) => {
    const enable = !!(req.body && req.body.enable);
    if (TEST_MODE || DEMO_MODE) return res.json({ success: true, enabled: enable, demo: true });
    try {
        if (enable) {
            sh('sudo', ['systemctl', 'enable', '--now', 'xray'], { timeout: 30000 });
            sh('sudo', ['warp-cli', '--accept-tos', 'connect'], { timeout: 30000 });
        } else {
            try { sh('sudo', ['warp-cli', '--accept-tos', 'disconnect'], { timeout: 30000 }); } catch (e) { /* ignore */ }
            sh('sudo', ['systemctl', 'disable', '--now', 'xray'], { timeout: 30000 });
        }
        auditLog(req, enable ? 'WARP/Xray включены' : 'WARP/Xray выключены');
        res.json({ success: true, enabled: enable });
    } catch (e) {
        res.status(500).json({ error: 'Не удалось переключить WARP/Xray: ' + (e.stderr || e.message || 'ошибка') });
    }
});

app.post('/api/warp/test', checkAuth, requireAdmin, (req, res) => {
    const cfg = warpConfig();
    const body = req.body || {};
    const socksPort = isPort(body.socksPort) ? String(Number(body.socksPort)) : cfg.socksPort;
    if (TEST_MODE || DEMO_MODE) {
        return res.json({ ok: true, demo: true, ip: '203.0.113.10', org: 'Cloudflare, Inc.', country: 'NL' });
    }
    execFile('curl', [
        '-fsS', '--max-time', '15',
        '-x', `socks5h://127.0.0.1:${socksPort}`,
        'https://ipinfo.io/json'
    ], { timeout: 25000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
            return res.json({ ok: false, error: String(stderr || err.message || 'WARP не ответил').slice(0, 1000) });
        }
        try {
            const data = JSON.parse(stdout);
            res.json({
                ok: true,
                ip: data.ip || '',
                org: data.org || '',
                country: data.country || '',
                city: data.city || ''
            });
        } catch (e) {
            res.json({ ok: false, error: 'WARP вернул не JSON', raw: String(stdout).slice(0, 1000) });
        }
    });
});

// Записывает правила dnsrewrite в пользовательские правила AdGuard.
// Старый блок панели удаляется по маркерам, остальные правила не затрагиваются.
app.post('/api/warp/adguard', checkAuth, requireAdmin, async (req, res) => {
    const body = req.body || {};
    const base = normalizeAgUrl(body.url);
    if (!base) return res.status(400).json({ error: 'Укажите корректный URL AdGuard API' });

    const cfg = warpConfig();
    let rewriteIp = String(body.rewriteIp || '').trim();
    if (!rewriteIp || rewriteIp === '0.0.0.0') rewriteIp = String(cfg.listenIp || '10.8.1.1').trim();
    if (rewriteIp === '0.0.0.0') rewriteIp = '10.8.1.1';
    if (!IPV4_RE.test(rewriteIp) || rewriteIp.startsWith('127.')) {
        return res.status(400).json({ error: 'Укажите IP туннеля для dnsrewrite (например, 10.8.1.1)' });
    }

    let domains;
    if (Array.isArray(body.domains)) domains = body.domains;
    else if (typeof body.domains === 'string' && body.domains.trim()) {
        domains = body.domains.split(/[\s,;]+/);
    } else {
        domains = warpDomainList();
    }
    domains = [...new Set(domains
        .map(d => String(d).trim().toLowerCase())
        .filter(d => d && !d.startsWith('#') && HOST_RE.test(d)))];
    if (!domains.length) return res.status(400).json({ error: 'Список доменов пуст' });
    if (TEST_MODE || DEMO_MODE) {
        return res.json({
            success: true, demo: true, count: domains.length,
            totalRules: domains.length, rewriteIp, syncedAt: new Date().toISOString()
        });
    }

    const headers = { 'Accept': 'application/json' };
    if (body.user) {
        headers['Authorization'] = 'Basic ' + Buffer.from(String(body.user) + ':' + String(body.pass || '')).toString('base64');
    }

    const BEGIN = '# BEGIN SERVEPANEL WARP';
    const END = '# END SERVEPANEL WARP';
    try {
        const cur = await fetchWithTimeout(base + '/control/filtering/status', { headers }, 10000);
        if (!cur.ok) throw new Error('AdGuard HTTP ' + cur.status);
        const data = await cur.json();
        const current = Array.isArray(data.user_rules) ? data.user_rules : [];

        const kept = [];
        const hasBegin = current.some(rule => String(rule).trim() === BEGIN);
        const hasEnd = current.some(rule => String(rule).trim() === END);
        if (hasBegin && hasEnd) {
            let inBlock = false;
            for (const rule of current) {
                const t = String(rule).trim();
                if (t === BEGIN) { inBlock = true; continue; }
                if (t === END) { inBlock = false; continue; }
                if (!inBlock) kept.push(rule);
            }
        } else {
            kept.push(...current);
        }

        const block = [
            BEGIN,
            ...domains.map(d => `||${d}^$dnsrewrite=NOERROR;A;${rewriteIp}`),
            END
        ];
        const next = [...kept, ...block];
        const set = await fetchWithTimeout(base + '/control/filtering/set_rules', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ rules: next })
        }, 10000);
        if (!set.ok) throw new Error('AdGuard set_rules HTTP ' + set.status);

        const syncedAt = new Date().toISOString();
        if (!TEST_MODE) {
            try {
                writeRootFile(WARP_STATE_FILE, JSON.stringify({
                    syncedAt, count: domains.length, rewriteIp, totalRules: next.length
                }, null, 2), '0600');
            } catch (e) { /* статус не критичен */ }
        }
        auditLog(req, `WARP: правила AdGuard обновлены (${domains.length} доменов -> ${rewriteIp})`);
        res.json({ success: true, count: domains.length, totalRules: next.length, rewriteIp, syncedAt });
    } catch (e) {
        res.status(502).json({ error: 'Не удалось обновить AdGuard: ' + e.message });
    }
});

// ---------------------------------------------------------------------------
// Клиенты: создание
// ---------------------------------------------------------------------------
function guessDomain() {
    try {
        if (fs.existsSync('/root/awg_domain.txt')) {
            const d = fs.readFileSync('/root/awg_domain.txt', 'utf8').trim();
            if (d && HOST_RE.test(d)) return d;
        }
        const nginx = shTry('cat', ['/etc/nginx/sites-available/awg-admin']);
        const m = nginx.match(/server_name\s+([^;]+);/);
        if (m && m[1] && m[1].trim() !== '_' && HOST_RE.test(m[1].trim())) return m[1].trim();
    } catch (e) { /* ignore */ }
    return '';
}

function replaceEndpointWithDomain(confPath) {
    const domain = guessDomain();
    if (!domain) return;
    try {
        sh('sudo', ['sed', '-i', '-E', `s/Endpoint = [0-9.]+(:[0-9]+)/Endpoint = ${domain}\\1/g`, confPath]);
    } catch (e) { /* ignore */ }
}

app.post('/api/create', checkAuth, (req, res) => {
    const { name, expires } = req.body || {};
    if (!name || !NAME_RE.test(name)) return res.status(400).json({ error: 'Недопустимое имя' });
    if (DEMO_MODE) {
        if (demoClients.some(c => c.name === name)) return res.status(409).json({ error: 'Клиент с таким именем уже есть' });
        const ip = '10.8.1.' + (10 + demoClients.length);
        demoClients.push({ name, ip, status: 'Активен', status_code: 'active', rx: 0, tx: 0, last_handshake: Math.floor(Date.now() / 1000) });
        auditLog(req, `[DEMO] Создан клиент ${name}`);
        return res.attachment(`Serv_${name}.conf`).type('text/plain').send(demoClientConf(name, ip));
    }
    const args = ['add', name];
    if (expires && /^[0-9]+[hdw]$/.test(expires)) args.push(`--expires=${expires}`);
    execFile('sudo', ['bash', MANAGE, ...args, '--json'], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        try {
            const response = JSON.parse(String(stdout || ''));
            if (!response.ok) return res.status(500).json({ error: response.error || 'Ошибка создания' });
            const r = (response.results || [])[0];
            if (!r || !r.conf) return res.status(500).json({ error: 'Скрипт не вернул путь к конфигу' });
            replaceEndpointWithDomain(r.conf);
            auditLog(req, `Создан клиент ${name}`);
            res.download(r.conf, `Serv_${name}.conf`);
        } catch (e) { res.status(500).json({ error: 'Ошибка обработки' }); }
    });
});

app.post('/api/create-bulk', checkAuth, (req, res) => {
    const { prefix, count, expires } = req.body || {};
    const n = parseInt(count, 10);
    if (!prefix || !NAME_RE.test(prefix) || !Number.isInteger(n) || n < 1 || n > 100) {
        return res.status(400).json({ error: 'Недопустимые параметры' });
    }
    const generated = [];
    for (let i = 1; i <= n; i++) {
        const clientName = `${prefix}-${i}`;
        const args = ['add', clientName];
        if (expires && /^[0-9]+[hdw]$/.test(expires)) args.push(`--expires=${expires}`);
        try {
            const result = sh('sudo', ['bash', MANAGE, ...args, '--json'], { maxBuffer: 16 * 1024 * 1024 });
            const response = JSON.parse(result);
            const r = (response.results || [])[0];
            if (response.ok && r && r.conf) {
                replaceEndpointWithDomain(r.conf);
                generated.push({ name: clientName, content: sh('sudo', ['cat', r.conf]) });
            }
        } catch (e) { /* пропускаем неудачные */ }
    }
    auditLog(req, `Массовое создание клиентов: ${prefix}-1..${n}`);
    res.json({ success: true, configs: generated });
});

// ---------------------------------------------------------------------------
// Клиенты: список (list + stats), ключ vpn://, переименование, удаление
// ---------------------------------------------------------------------------
app.get('/api/clients', checkAuth, (req, res) => {
    if (DEMO_MODE) {
        return res.json(demoClients.map(c => ({
            name: c.name, ip: c.ip, client_ipv6: '', status: c.status, status_code: c.status_code,
            expires_at: null, rx: c.rx, tx: c.tx, last_handshake: c.last_handshake, has_vpnuri: true
        })));
    }
    try {
        let list = [];
        let stats = [];
        try { list = JSON.parse(sh('sudo', ['bash', MANAGE, 'list', '--json'], { maxBuffer: 16 * 1024 * 1024 })); } catch (e) { list = []; }
        try {
            const s = sh('sudo', ['bash', MANAGE, 'stats', '--json'], { maxBuffer: 16 * 1024 * 1024 });
            const i = s.indexOf('[');
            if (i !== -1) stats = JSON.parse(s.substring(i));
        } catch (e) { stats = []; }
        const byName = {};
        stats.forEach(s => { byName[s.name] = s; });
        const merged = list.map(l => {
            const s = byName[l.name] || {};
            return {
                name: l.name,
                ip: l.ip || s.ip || '',
                client_ipv6: l.client_ipv6 || '',
                status: l.status || s.status || '',
                status_code: l.status_code || s.status_code || 'inactive',
                expires_at: l.expires_at !== undefined ? l.expires_at : null,
                rx: s.rx || 0,
                tx: s.tx || 0,
                last_handshake: s.last_handshake || 0,
                has_vpnuri: fs.existsSync(path.join(AWG_DIR, l.name + '.vpnuri'))
            };
        });
        res.json(merged);
    } catch (e) { res.status(500).json({ error: 'Ошибка чтения клиентов' }); }
});

app.get('/api/clients/:name/key', checkAuth, async (req, res) => {
    const name = String(req.params.name);
    if (!NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid name' });
    if (DEMO_MODE) {
        const c = demoClients.find(x => x.name === name);
        const uri = buildVpnUriFromConf(name, demoClientConf(name, c ? c.ip : '10.8.1.99'));
        let qr = '';
        try { qr = await qrDataUrl(uri); } catch (e) { qr = ''; }
        return res.json({ name, uri, qr });
    }
    const uriPath = path.join(AWG_DIR, name + '.vpnuri');
    const pngPath = path.join(AWG_DIR, name + '.vpnuri.png');
    try {
        if (!fs.existsSync(uriPath)) {
            // regen не меняет ключи и клиента, просто пересобирает qr/vpnuri
            try { sh('sudo', ['bash', MANAGE, 'regen', name, '--json'], { maxBuffer: 16 * 1024 * 1024 }); } catch (e) { /* ignore */ }
        }
        let uri = '';
        if (fs.existsSync(uriPath)) uri = sh('sudo', ['cat', uriPath]).trim();
        if (!uri) {
            const confPath = path.join(AWG_DIR, name + '.conf');
            if (fs.existsSync(confPath)) {
                uri = buildVpnUriFromConf(name, sh('sudo', ['cat', confPath]));
            }
        }
        if (!uri) return res.status(404).json({ error: 'Не удалось получить ключ (нет .conf/.vpnuri)' });
        let qr = '';
        try {
            if (fs.existsSync(pngPath)) qr = 'data:image/png;base64,' + sh('sudo', ['base64', '-w', '0', pngPath]).trim();
        } catch (e) { /* ignore */ }
        if (!qr) qr = await qrDataUrl(uri);
        auditLog(req, `Просмотр ключа клиента ${name}`);
        res.json({ name, uri, qr });
    } catch (e) { res.status(500).json({ error: 'Ошибка чтения ключа' }); }
});

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Один файл на клиента: инструкция + QR + vpn:// + .conf.
// Открывается локально (в т.ч. на телефоне) без доступа к панели.
app.get('/api/clients/:name/export', checkAuth, requireAdmin, async (req, res) => {
    const name = String(req.params.name);
    if (!NAME_RE.test(name)) return res.status(400).json({ error: 'Неверное имя' });
    const confPath = path.join(AWG_DIR, name + '.conf');
    const uriPath = path.join(AWG_DIR, name + '.vpnuri');
    const pngPath = path.join(AWG_DIR, name + '.vpnuri.png');
    try {
        let conf = '';
        try { if (fs.existsSync(confPath)) conf = sh('sudo', ['cat', confPath]); } catch (e) { conf = ''; }
        if (!conf) return res.status(404).json({ error: 'Конфиг клиента не найден' });

        let uri = '';
        try { if (fs.existsSync(uriPath)) uri = sh('sudo', ['cat', uriPath]).trim(); } catch (e) { uri = ''; }
        if (!uri) uri = buildVpnUriFromConf(name, conf);

        let qr = '';
        try {
            if (fs.existsSync(pngPath)) qr = 'data:image/png;base64,' + sh('sudo', ['base64', '-w', '0', pngPath]).trim();
        } catch (e) { /* ignore */ }
        if (!qr) qr = await qrDataUrl(uri);

        if (String(req.query.format || '') === 'txt') {
            res.setHeader('Content-Disposition', `attachment; filename="Serv_${name}.txt"`);
            return res.type('text/plain').send(
                `Клиент: ${name}\n\nСсылка для AmneziaVPN:\n${uri}\n\nКонфигурация:\n${conf}\n`
            );
        }

        const safeName = escapeHtml(name);
        const safeUri = escapeHtml(uri);
        const safeConf = escapeHtml(conf);
        const html = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Подключение ${safeName}</title>
<style>
 body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0d1117;color:#c9d1d9;margin:0;padding:20px;}
 .card{max-width:640px;margin:0 auto;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:22px;}
 h1{font-size:20px;margin:0 0 6px;color:#fff;} .muted{color:#8b949e;font-size:13px;}
 img{background:#fff;padding:10px;border-radius:10px;display:block;margin:16px auto;width:240px;height:240px;}
 textarea{width:100%;box-sizing:border-box;font-family:monospace;font-size:11px;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:8px;padding:10px;resize:vertical;}
 button{background:#2f81f7;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-weight:600;cursor:pointer;margin:6px 6px 0 0;}
 pre{white-space:pre-wrap;word-break:break-all;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:10px;font-size:11px;}
 .warn{background:rgba(255,127,80,.08);border:1px solid #ff7b72;border-radius:8px;padding:10px;font-size:12px;color:#ffb3ad;margin-top:14px;}
</style></head><body><div class="card">
<h1>Подключение: ${safeName}</h1>
<p class="muted">Файл содержит всё, что нужно для настройки. Ключи действительны, пока клиент не удалён на сервере.</p>
${qr ? `<img src="${qr}" alt="QR-код подключения">` : '<p class="muted">QR-код недоступен — используйте ссылку ниже.</p>'}
<p class="muted"><b>Способ 1.</b> AmneziaVPN → «+» → «Импорт из ссылки» (или сканируйте QR).</p>
<textarea id="uri" readonly rows="4">${safeUri}</textarea>
<button onclick="navigator.clipboard.writeText(document.getElementById('uri').value)">Скопировать vpn://</button>
<button onclick="navigator.clipboard.writeText(document.getElementById('conf').value)">Скопировать .conf</button>
<p class="muted" style="margin-top:18px;"><b>Способ 2.</b> Импорт файла конфигурации:</p>
<textarea id="conf" readonly rows="10">${safeConf}</textarea>
<div class="warn">Не передавайте этот файл посторонним: он даёт доступ к вашему VPN. При утечке удалите клиента в панели и создайте нового.</div>
</div></body></html>`;
        res.setHeader('Content-Disposition', `attachment; filename="Serv_${name}.html"`);
        res.type('text/html').send(html);
        auditLog(req, `Экспорт клиента ${name} в один файл`);
    } catch (e) {
        res.status(500).json({ error: 'Ошибка экспорта клиента' });
    }
});

function runRename(oldName, newName) {
    const out = sh('sudo', ['bash', RENAME_SCRIPT, oldName, newName], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(out.trim().split('\n').pop() || '{}');
}

app.post('/api/clients/:name/rename', checkAuth, (req, res) => {
    const oldName = String(req.params.name);
    const newName = String((req.body && req.body.newName) || '').trim();
    if (!NAME_RE.test(oldName) || !NAME_RE.test(newName)) return res.status(400).json({ error: 'Недопустимое имя (A-Z, a-z, 0-9, _-, до 63 символов)' });
    if (oldName === newName) return res.json({ success: true });
    try {
        writeRootFile(RENAME_SCRIPT, RENAME_BASH, '0755');
    } catch (e) {
        return res.status(500).json({ error: 'Не удалось подготовить скрипт переименования' });
    }
    try {
        const r = runRename(oldName, newName);
        if (!r.ok) {
            const map = {
                name_exists: 'Клиент с таким именем уже существует',
                file_exists: 'Файл с таким именем уже существует',
                not_found: 'Клиент не найден'
            };
            return res.status(409).json({ error: map[r.error] || ('Не удалось переименовать: ' + r.error) });
        }
        if (historyData[oldName]) { historyData[newName] = historyData[oldName]; delete historyData[oldName]; }
        if (lastHistoryStats[oldName]) { lastHistoryStats[newName] = lastHistoryStats[oldName]; delete lastHistoryStats[oldName]; }
        auditLog(req, `Клиент ${oldName} переименован в ${newName}`);
        res.json({ success: true, name: newName });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка переименования: ' + (e.stdout || e.message) });
    }
});

app.post('/api/clients/rename-bulk', checkAuth, (req, res) => {
    const search = String((req.body && req.body.search) || '');
    const replace = String((req.body && req.body.replace) || '');
    if (!search || search.length > 63) return res.status(400).json({ error: 'Укажите что искать в именах' });
    if (replace.length > 32 || /[^A-Za-z0-9_-]/.test(replace)) return res.status(400).json({ error: 'Недопустимые символы в замене' });
    try {
        writeRootFile(RENAME_SCRIPT, RENAME_BASH, '0755');
    } catch (e) { return res.status(500).json({ error: 'Не удалось подготовить скрипт' }); }

    let names = [];
    try {
        names = JSON.parse(sh('sudo', ['bash', MANAGE, 'list', '--json'], { maxBuffer: 16 * 1024 * 1024 })).map(c => c.name);
    } catch (e) { return res.status(500).json({ error: 'Не удалось получить список клиентов' }); }

    const renamed = [], skipped = [];
    for (const oldName of names) {
        if (!oldName.toLowerCase().includes(search.toLowerCase())) continue;
        let newName = oldName.split(new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join(replace);
        newName = newName.replace(/^[-_]+|[-_]+$/g, '');
        if (!NAME_RE.test(newName)) { skipped.push({ name: oldName, reason: 'итоговое имя некорректно' }); continue; }
        if (newName === oldName) { skipped.push({ name: oldName, reason: 'имя не изменилось' }); continue; }
        try {
            const r = runRename(oldName, newName);
            if (r.ok) { renamed.push({ from: oldName, to: newName }); }
            else skipped.push({ name: oldName, reason: r.error });
        } catch (e) { skipped.push({ name: oldName, reason: 'ошибка' }); }
    }
    auditLog(req, `Массовое переименование «${search}» -> «${replace}»: ${renamed.length} шт.`);
    res.json({ success: true, renamed, skipped });
});

app.get('/api/download/:name', checkAuth, (req, res) => {
    const name = String(req.params.name);
    if (!NAME_RE.test(name)) return res.status(400).send('Invalid name');
    if (DEMO_MODE) {
        const c = demoClients.find(x => x.name === name);
        if (!c) return res.status(404).send('Конфиг не найден');
        return res.attachment(`Serv_${name}.conf`).type('text/plain').send(demoClientConf(name, c.ip));
    }
    const filePath = path.join(AWG_DIR, `${name}.conf`);
    if (fs.existsSync(filePath)) res.download(filePath, `Serv_${name}.conf`);
    else res.status(404).send('Конфиг не найден');
});

app.delete('/api/delete/:name', checkAuth, (req, res) => {
    const name = String(req.params.name);
    if (!NAME_RE.test(name)) return res.status(400).send('Invalid name');
    execFile('sudo', ['bash', MANAGE, 'remove', name, '--yes', '--json'], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        try {
            const response = JSON.parse(String(stdout || ''));
            if (!response.ok) return res.status(500).json({ error: response.error || 'Ошибка удаления' });
            delete historyData[name]; delete lastHistoryStats[name];
            auditLog(req, 'Удален клиент ' + name);
            res.json({ success: true });
        } catch (e) {
            // Скрипт мог вернуть не-JSON (старая версия) — считаем успехом, если нет ошибки
            if (error) return res.status(500).json({ error: 'Ошибка при удалении' });
            delete historyData[name]; delete lastHistoryStats[name];
            res.json({ success: true });
        }
    });
});

app.post('/api/limit', checkAuth, (req, res) => {
    const { ip, rate } = req.body || {};
    const r = parseInt(rate, 10);
    if (!IPV4_RE.test(String(ip || '')) || !Number.isInteger(r) || r < 0 || r > 100000) {
        return res.status(400).json({ error: 'Некорректный IP или скорость' });
    }
    execFile('sudo', ['bash', '/root/awg-limit.sh', String(ip), String(r)], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (error) return res.status(500).json({ error: 'Ошибка TC скрипта' });
        auditLog(req, `Лимит ${r} Мбит/с для ${ip}`);
        res.json({ success: true, message: String(stdout || '') });
    });
});
// ---------------------------------------------------------------------------
// Статистика клиентов (для таблицы на дашборде)
// ---------------------------------------------------------------------------
app.get('/api/stats', checkAuth, (req, res) => {
    if (DEMO_MODE) {
        const now = Math.floor(Date.now() / 1000);
        return res.json(demoClients.map(c => ({ ...c, latest_handshake: c.last_handshake || now - 60 })));
    }
    execFile('sudo', ['bash', MANAGE, 'stats', '--json'], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        try {
            const s = String(stdout || '');
            const i = s.indexOf('[');
            if (i === -1) return res.status(500).json({ error: 'Скрипт не вернул JSON' });
            let data = JSON.parse(s.substring(i));
            data = data.map(client => {
                let sc = client.status_code;
                if (!sc) {
                    const st = String(client.status || '').toLowerCase();
                    if (st.includes('активен') && !st.includes('неактивен') && !st.includes('не активен')) sc = 'active';
                    else if (st.includes('недавно')) sc = 'recent';
                    else sc = 'inactive';
                }
                return { ...client, status_code: sc };
            });
            res.json(data);
        } catch (e) { res.status(500).json({ error: 'Ошибка парсинга' }); }
    });
});

// ---------------------------------------------------------------------------
// Обфускация AmneziaWG: чтение/применение/экспорт (интеграция с Архитектором)
// ---------------------------------------------------------------------------
const OBF_INT_RANGES = {
    Jc: [0, 128], Jmin: [0, 1280], Jmax: [0, 1280],
    S1: [0, 1280], S2: [0, 1280], S3: [0, 1280], S4: [0, 32]
};
// Поля, которые в AWG 2.0+ могут быть диапазоном "min-max" (каждый пакет
// получает случайное значение из диапазона). Именно так их отдаёт Архитектор.
const OBF_RANGE_LIMITS = {
    H1: [0, 4294967295], H2: [0, 4294967295], H3: [0, 4294967295], H4: [0, 4294967295],
    ContentPaddingAddition: [0, 65535],
    RekeyAfterTime: [0, 86400], RekeyTimeout: [0, 3600], RejectAfterTime: [0, 86400],
    KeepaliveTimeout: [0, 3600], MaxHandshakeAttempts: [0, 100]
};
const OBF_I_KEYS = ['I1', 'I2', 'I3', 'I4', 'I5'];
const OBF_FLAG_KEYS = ['RandomTrailers', 'DisableCookies'];
const OBF_STR_KEYS = ['HeaderProtectionKey', ...OBF_FLAG_KEYS];
const OBF_ALL_KEYS = [
    ...Object.keys(OBF_INT_RANGES), ...Object.keys(OBF_RANGE_LIMITS),
    ...OBF_I_KEYS, ...OBF_STR_KEYS
];
// Общие параметры обязаны совпадать на сервере и у клиентов. Остальные —
// клиентские/локальные: их можно менять, не ломая туннель.
const OBF_SHARED_KEYS = ['H1', 'H2', 'H3', 'H4', 'S1', 'S2', 'S3', 'S4', 'HeaderProtectionKey', 'RandomTrailers'];
const OBF_VALUE_RE = /^[A-Za-z0-9+/=_.:<>\- ]{0,8192}$/;

function readObfFromConf(confText) {
    const ini = parseIni(confText);
    const sec = ini.Interface || {};
    const out = {};
    for (const k of OBF_ALL_KEYS) if (sec[k] !== undefined) out[k] = String(sec[k]).trim();
    return out;
}

function parseObfRange(value) {
    const m = /^(\d{1,10})(?:\s*-\s*(\d{1,10}))?$/.exec(String(value == null ? '' : value).trim());
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    return { min: a, max: b, single: m[2] === undefined };
}

function detectObfVersion(params) {
    const p = params || {};
    const has = k => p[k] !== undefined && String(p[k]).trim() !== '';
    if (has('RandomTrailers') || has('DisableCookies')) return '3.1';
    if (has('HeaderProtectionKey') || has('ContentPaddingAddition') || has('RekeyAfterTime') ||
        has('RekeyTimeout') || has('RejectAfterTime') || has('KeepaliveTimeout') || has('MaxHandshakeAttempts')) return '3.0';
    if (has('S3') || has('S4')) return '2.0';
    if (OBF_I_KEYS.some(has)) return '1.5';
    if (has('Jc') || has('Jmin') || has('Jmax') || has('H1') || has('S1')) return '1.0';
    return 'unknown';
}

function extractObfFromAny(text) {
    const raw = String(text || '').replace(/^\uFEFF/, '').trim();
    let obj = null;
    if (raw.startsWith('{')) {
        try { obj = JSON.parse(raw); } catch (e) { obj = null; }
    } else if (/^vpn:\/\//i.test(raw)) {
        try { obj = vpnDecode(raw); } catch (e) { obj = null; }
    }

    if (obj && typeof obj === 'object') {
        let body = null;
        if (Array.isArray(obj.containers) && obj.containers.length) {
            const c = obj.containers[0] || {};
            body = c.awg || c.wireguard || null;
        } else if (obj.awg) {
            body = obj.awg;
        } else if (obj.wireguard) {
            body = obj.wireguard;
        } else if (obj.Jc !== undefined || obj.Jmin !== undefined || obj.H1 !== undefined ||
            obj.last_config !== undefined || obj.config !== undefined) {
            body = obj;
        }
        const out = {};
        const put = (src) => {
            if (!src || typeof src !== 'object') return;
            for (const k of OBF_ALL_KEYS) {
                if (src[k] !== undefined && src[k] !== null && out[k] === undefined) out[k] = String(src[k]).trim();
            }
        };
        put(body);
        // Amnezia хранит полный набор в last_config (строкой JSON).
        let lc = body && body.last_config;
        if (typeof lc === 'string') { try { lc = JSON.parse(lc); } catch (e) { lc = null; } }
        put(lc);
        // Архитектор кладёт полный текст конфига в awg.config.
        if (body && typeof body.config === 'string') put(readObfFromConf(body.config));
        if (Object.keys(out).length) return out;
    }
    // Обычный .conf (в том числе вывод Архитектора).
    return readObfFromConf(raw);
}

function splitObfBatch(text) {
    const raw = String(text || '').replace(/^\uFEFF/, '').trim();
    const parts = raw.split(/^[ \t]*={20,}[ \t]*$/m).map(s => s.trim()).filter(Boolean);
    return parts.length ? parts : [raw];
}

function parseObfInput(text) {
    const raw = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!raw) throw new Error('Пустой ввод: вставьте .conf, JSON или vpn:// из Архитектора');
    if (raw.length > 256 * 1024) throw new Error('Слишком большой текст (максимум 256 КБ)');
    const parts = /^vpn:\/\//i.test(raw) ? [raw] : splitObfBatch(raw);
    const first = parts[0];
    let format = 'conf';
    if (/^vpn:\/\//i.test(first)) format = 'vpn';
    else if (first.startsWith('{')) {
        let j = null;
        try { j = JSON.parse(first); } catch (e) { j = null; }
        format = j && Array.isArray(j.containers) ? 'amnezia-json' : 'json';
    } else if (/^#\s*AmneziaWG\s+3\./im.test(first)) format = 'architect-conf';
    if (parts.length > 1) format = 'architect-batch';

    const params = extractObfFromAny(first);
    if (!Object.keys(params).length) {
        throw new Error('В тексте не найдены параметры обфускации (Jc/Jmin/Jmax, H1-H4, S1-S4, I1-I5, HeaderProtectionKey)');
    }
    const version = detectObfVersion(params);
    const warnings = [];
    if (parts.length > 1) {
        warnings.push(`Найдено конфигураций: ${parts.length}. Использована первая — остальные являются альтернативами для других устройств.`);
    }
    if ((version === '3.0' || version === '3.1') && !params.HeaderProtectionKey) {
        warnings.push('В конфиге нет HeaderProtectionKey. Для AWG 3.x это означает, что заголовки не шифруются: включите опцию в Архитекторе или в приложении Amnezia VPN.');
    }
    if (OBF_I_KEYS.every(k => !params[k])) {
        warnings.push('Нет цепочки I1–I5 (CPS-мимикрия). Это один из самых заметных признаков для DPI — по возможности используйте профиль Архитектора с имитацией QUIC/TLS.');
    }
    if (params.H1 && parseObfRange(params.H1) && parseObfRange(params.H1).single) {
        warnings.push('H1–H4 заданы одним числом. Начиная с AWG 2.0 лучше использовать диапазоны — тогда заголовок меняется от пакета к пакету.');
    }
    return { params, format, version, alternatives: parts.length, warnings, bytes: raw.length };
}

function validateObf(params) {
    const clean = {};
    const provided = new Set();
    for (const [k, vRaw] of Object.entries(params || {})) {
        if (!OBF_ALL_KEYS.includes(k)) continue;
        const v = String(vRaw == null ? '' : vRaw).trim();
        if (!OBF_VALUE_RE.test(v)) throw new Error(`Недопустимое значение параметра ${k}`);

        if (OBF_INT_RANGES[k]) {
            if (!/^\d{1,10}$/.test(v)) throw new Error(`${k} должен быть целым числом`);
            const n = Number(v);
            const [min, max] = OBF_INT_RANGES[k];
            if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${k} должен быть числом ${min}..${max}`);
            clean[k] = String(n);
        } else if (OBF_RANGE_LIMITS[k]) {
            const r = parseObfRange(v);
            if (!r) throw new Error(`${k}: ожидается число или диапазон вида 100-200`);
            const [min, max] = OBF_RANGE_LIMITS[k];
            if (r.min < min || r.max > max) throw new Error(`${k} должен быть в пределах ${min}..${max}`);
            if (r.max < r.min) throw new Error(`${k}: начало диапазона больше конца`);
            clean[k] = r.single ? String(r.min) : `${r.min}-${r.max}`;
        } else if (OBF_I_KEYS.includes(k)) {
            clean[k] = v; // пустая строка = удалить цепочку
        } else if (k === 'HeaderProtectionKey') {
            if (v) {
                if (!/^[A-Za-z0-9+/=_-]{40,48}$/.test(v)) throw new Error('HeaderProtectionKey должен быть base64 на 32 байта');
                const buf = Buffer.from(v, 'base64');
                if (buf.length !== 32) throw new Error('HeaderProtectionKey должен быть base64 на 32 байта');
            }
            clean[k] = v;
        } else if (OBF_FLAG_KEYS.includes(k)) {
            if (!['', '0', '1', 'true', 'false'].includes(v.toLowerCase())) {
                throw new Error(`${k} должен быть 0 или 1`);
            }
            const low = v.toLowerCase();
            clean[k] = low === 'true' ? '1' : low === 'false' ? '0' : low;
        }
        provided.add(k);
    }

    if (clean.Jmin !== undefined && clean.Jmax !== undefined &&
        Number(clean.Jmin) > Number(clean.Jmax)) {
        throw new Error('Jmin не может быть больше Jmax');
    }

    const iTotal = OBF_I_KEYS.reduce((sum, k) => sum + (clean[k] ? clean[k].length : 0), 0);
    if (iTotal > 3200) {
        throw new Error(`Суммарная длина I1–I5 — ${iTotal} символов. Ядро Linux принимает не больше 3200: сократите цепочку.`);
    }

    // Пересекающиеся диапазоны H делают тип пакета неоднозначным.
    const hRanges = ['H1', 'H2', 'H3', 'H4']
        .filter(k => provided.has(k) && clean[k])
        .map(k => ({ k, r: parseObfRange(clean[k]) }))
        .filter(x => x.r);
    for (let i = 0; i < hRanges.length; i++) {
        for (let j = i + 1; j < hRanges.length; j++) {
            const a = hRanges[i], b = hRanges[j];
            if (a.r.min <= b.r.max && b.r.min <= a.r.max) {
                throw new Error(`Диапазоны ${a.k} и ${b.k} пересекаются — приёмник не сможет различить типы пакетов`);
            }
        }
    }
    return clean;
}

// Оценка устойчивости к DPI/ТСПУ. Это эвристика, а не гарантия обхода:
// она показывает, какие параметры выдают стандартный AmneziaWG.
function auditObf(params) {
    const p = params || {};
    const findings = [];
    const has = k => p[k] !== undefined && String(p[k]).trim() !== '';
    const rng = k => parseObfRange(p[k]);
    const add = (level, id, title, detail, fix) => findings.push({ level, id, title, detail, fix });
    let score = 100;

    const version = detectObfVersion(p);

    // --- H1-H4: статические/маленькие заголовки — главная сигнатура AWG 1.0 ---
    const hKeys = ['H1', 'H2', 'H3', 'H4'];
    const hPresent = hKeys.filter(has);
    const hVals = hPresent.map(k => ({ k, r: rng(k) })).filter(x => x.r);
    if (!hPresent.length) {
        score -= 30;
        add('error', 'h-missing', 'Заголовки H1–H4 не заданы',
            'Без них пакеты AmneziaWG используют стандартные магические заголовки — DPI опознаёт протокол по первому пакету.',
            'Сгенерируйте конфиг в Архитекторе (версия 2.0+) и импортируйте его.');
    } else {
        if (hPresent.length < 4) {
            score -= 10;
            add('warn', 'h-partial', `Задано только ${hPresent.length} из 4 заголовков`,
                'Незаданные H используют значения по умолчанию.', 'Заполните все H1–H4.');
        }
        const reserved = hVals.filter(x => x.r.min <= 4 && x.r.max <= 4);
        if (reserved.length) {
            score -= 15;
            add('error', 'h-reserved', 'H1–H4 в диапазоне 1–4',
                'Значения 1–4 совпадают с типами сообщений обычного WireGuard — такой трафик распознаётся почти безошибочно.',
                'Используйте большие непересекающиеся диапазоны (Архитектор делает это автоматически).');
        }
        const singles = hVals.filter(x => x.r.single);
        if (hVals.length && singles.length === hVals.length) {
            score -= 12;
            add('warn', 'h-static', 'Все H1–H4 — фиксированные числа',
                'Заголовок одинаков во всех пакетах. Статистический анализ быстро находит такую сигнатуру.',
                'Включите диапазоны H1–H4 (AWG 2.0+) или сгенерируйте конфиг в Архитекторе.');
        } else if (singles.length) {
            score -= 5;
            add('info', 'h-mixed', `${singles.length} из ${hVals.length} заголовков без диапазона`,
                'Часть заголовков всё ещё фиксирована.', 'Переведите все H1–H4 в диапазоны.');
        }
        const narrow = hVals.filter(x => !x.r.single && (x.r.max - x.r.min) < 512);
        if (narrow.length) {
            score -= 4;
            add('info', 'h-narrow', 'Слишком узкие диапазоны H',
                `У ${narrow.map(x => x.k).join(', ')} диапазон меньше 512 значений — случайность почти не заметна.`,
                'Расширьте диапазоны до нескольких тысяч значений.');
        }
        for (let i = 0; i < hVals.length; i++) {
            for (let j = i + 1; j < hVals.length; j++) {
                const a = hVals[i], b = hVals[j];
                if (a.r.min <= b.r.max && b.r.min <= a.r.max) {
                    score -= 20;
                    add('error', 'h-overlap', `Пересечение ${a.k} и ${b.k}`,
                        'Приёмник не сможет однозначно определить тип пакета, а DPI получит простой шаблон.',
                        'Сгенерируйте непересекающиеся диапазоны в Архитекторе.');
                }
            }
        }
    }

    // --- S1-S4: паддинг и nonce для HeaderProtectionKey ---
    const sKeys = ['S1', 'S2', 'S3', 'S4'];
    const sPresent = sKeys.filter(has);
    const sVal = k => has(k) ? Number(p[k]) : null;
    if (!sPresent.length) {
        score -= 20;
        add('error', 's-missing', 'Паддинг S1–S4 не задан',
            'Размеры пакетов остаются предсказуемыми (148/92 байта), что является готовой сигнатурой WireGuard.',
            'Импортируйте конфиг Архитектора с S1–S4.');
    } else {
        if (sPresent.length < 4) {
            score -= 6;
            add('warn', 's-partial', `Задано только ${sPresent.length} из 4 размеров S`,
                'Незаданные S остаются стандартными.', 'Заполните S1–S4.');
        }
        if (has('S4') && sVal('S4') > 32) {
            score -= 10;
            add('error', 's4-max', 'S4 больше 32',
                'Ядро AmneziaWG не принимает S4 > 32 — интерфейс может не подняться.', 'Уменьшите S4 до 12–32.');
        }
        if (has('HeaderProtectionKey') && sPresent.some(k => sVal(k) < 12)) {
            score -= 18;
            add('error', 's-hpk-nonce', 'S меньше 12 при включённом HeaderProtectionKey',
                'Из S-паддинга берётся nonce для шифрования заголовка; при S < 12 его не хватает.',
                'Поднимите S1–S4 минимум до 12.');
        }
        if (has('S1') && has('S2') && sVal('S2') === sVal('S1') + 56) {
            score -= 4;
            add('info', 's-collision', 'S2 = S1 + 56',
                'Размеры пакетов могут совпасть и выдать протокол.', 'Измените S2 или S1.');
        }
    }

    // --- Jc/Jmin/Jmax: мусорные пакеты перед рукопожатием ---
    const jc = has('Jc') ? Number(p.Jc) : null;
    const jmin = has('Jmin') ? Number(p.Jmin) : null;
    const jmax = has('Jmax') ? Number(p.Jmax) : null;
    if (jc === null || jc === 0) {
        score -= 18;
        add('error', 'junk-missing', 'Нет мусорных пакетов (Jc = 0)',
            'Перед рукопожатием не отправляется ничего необычного — DPI видит чистый WireGuard handshake.',
            'Задайте Jc 3–8 и Jmin/Jmax с разбросом.');
    } else {
        if (jc < 3) {
            score -= 5;
            add('warn', 'junk-low', 'Мало мусорных пакетов',
                `Jc = ${jc}: для маскировки обычно нужно 3–8.`, 'Увеличьте Jc.');
        }
        if (jmin === null || jmax === null) {
            score -= 8;
            add('warn', 'junk-range-missing', 'Не задан Jmin или Jmax',
                'Размер мусорных пакетов будет фиксированным.', 'Задайте оба значения.');
        } else if (jmin >= jmax) {
            score -= 10;
            add('error', 'junk-range-bad', 'Jmin ≥ Jmax',
                'Диапазон размеров пуст — мусорные пакеты будут одинаковыми.', 'Сделайте Jmax больше Jmin.');
        } else if (jmax - jmin < 64) {
            score -= 5;
            add('warn', 'junk-range-narrow', 'Узкий разброс Jmin–Jmax',
                `Разница всего ${jmax - jmin} байт.`, 'Расширьте диапазон до сотен байт.');
        }
    }

    // --- I1-I5: CPS-мимикрия (клиентская сторона) ---
    const iPresent = OBF_I_KEYS.filter(has);
    const iTotal = iPresent.reduce((sum, k) => sum + String(p[k]).length, 0);
    if (!iPresent.length) {
        score -= 20;
        add('warn', 'cps-missing', 'Нет цепочки I1–I5 (CPS)',
            'AmneziaWG не имитирует чужой протокол. Для ТСПУ это один из самых устойчивых признаков: случайный UDP-поток без сигнатуры.',
            'Сгенерируйте профиль с имитацией QUIC/TLS в Архитекторе.');
    } else {
        if (iPresent.length < 3) {
            score -= 6;
            add('info', 'cps-partial', `Заполнено ${iPresent.length} из 5 цепочек I`,
                'Меньше вариантов мимикрии — шаблон заметнее.', 'Используйте все I1–I5.');
        }
        if (iTotal < 128) {
            score -= 5;
            add('info', 'cps-short', 'Короткая CPS-цепочка',
                `Суммарно ${iTotal} символов — имитация выглядит бедно.`, 'Сгенерируйте цепочку в Архитекторе.');
        }
        if (iTotal > 3200) {
            score -= 15;
            add('error', 'cps-long', 'CPS-цепочка длиннее 3200 символов',
                'Модуль ядра Linux не примет такой конфиг («Message too long»).', 'Сократите цепочку.');
        }
    }

    // --- HeaderProtectionKey ---
    if (has('HeaderProtectionKey')) {
        const buf = Buffer.from(String(p.HeaderProtectionKey), 'base64');
        if (buf.length !== 32) {
            score -= 20;
            add('error', 'hpk-bad', 'Некорректный HeaderProtectionKey',
                'Ключ должен быть base64 на 32 байта.', 'Перегенерируйте конфиг в Архитекторе.');
        } else {
            add('ok', 'hpk-ok', 'Заголовки шифруются (HeaderProtectionKey)',
                'ChaCha20 скрывает типы сообщений от DPI.', '');
        }
    } else if (version === '3.0' || version === '3.1') {
        score -= 25;
        add('error', 'hpk-missing', 'HeaderProtectionKey отсутствует',
            'Для AWG 3.x это значит, что заголовки не шифруются — версия 3.0 работает вхолостую.',
            'Включите HeaderProtectionKey в Архитекторе (или в настройках протокола Amnezia VPN).');
    } else {
        score -= 6;
        add('info', 'hpk-old', 'Нет HeaderProtectionKey (версия ниже 3.0)',
            'Шифрование заголовков появилось в AWG 3.0.', 'Для защиты от статистического анализа используйте 3.0/3.1.');
    }

    // --- Таймеры ---
    const timerKeys = ['RekeyAfterTime', 'RekeyTimeout', 'RejectAfterTime', 'KeepaliveTimeout', 'MaxHandshakeAttempts'];
    const tPresent = timerKeys.filter(has);
    if ((version === '3.0' || version === '3.1') && !tPresent.length) {
        score -= 6;
        add('warn', 'timers-missing', 'Таймеры не рандомизированы',
            'Фиксированные интервалы — ещё один канал статистического анализа.', 'Импортируйте таймеры из Архитектора.');
    } else if (tPresent.length) {
        const fixed = tPresent.filter(k => !String(p[k]).includes('-'));
        if (fixed.length === tPresent.length) {
            score -= 8;
            add('warn', 'timers-fixed', 'Все таймеры — фиксированные числа',
                'Одинаковые интервалы выдают протокол при длительном наблюдении.', 'Используйте диапазоны вида 110-130.');
        } else if (fixed.length) {
            score -= 3;
            add('info', 'timers-mixed', `${fixed.length} таймер(ов) без диапазона`,
                'Часть интервалов остаётся постоянной.', 'Переведите все таймеры в диапазоны.');
        }
    }

    // --- Флаги 3.1 ---
    const flagOn = k => has(k) && ['1', 'true', 'yes', 'on'].includes(String(p[k]).trim().toLowerCase());
    if (version === '3.1' && !flagOn('RandomTrailers')) {
        score -= 4;
        add('info', 'trailers-missing', 'RandomTrailers не включён',
            'Случайный хвост пакета усложняет анализ размеров.', 'Включите RandomTrailers = 1 в Архитекторе.');
    }
    if (version === '3.1' && !flagOn('DisableCookies')) {
        score -= 2;
        add('info', 'cookies-enabled', 'DisableCookies не включён',
            'Cookie-ответы имеют характерный размер и поведение.', 'Включите DisableCookies = 1, если клиенты поддерживают 3.1.');
    }

    score = Math.max(0, Math.min(100, score));
    const level = score >= 85 ? 'strong' : score >= 65 ? 'good' : score >= 35 ? 'weak' : 'critical';
    if (score >= 85) {
        add('ok', 'overall', 'Профиль выглядит устойчивым',
            'Диапазоны, паддинг, CPS и шифрование заголовков включены. Это не гарантия: при блокировке по IP обфускация не поможет.',
            '');
    }
    return {
        score, level, version,
        findings,
        summary: {
            shared: OBF_SHARED_KEYS.filter(has).length + '/' + OBF_SHARED_KEYS.length,
            client: (['Jc', 'Jmin', 'Jmax', 'I1', 'I2', 'I3', 'I4', 'I5', 'ContentPaddingAddition']).filter(has).length + '/9',
            cps: iPresent.length,
            hpk: has('HeaderProtectionKey')
        },
        checkedAt: new Date().toISOString()
    };
}

function applyObfToConf(content, params, opts = {}) {
    const lines = String(content || '').split(/\r?\n/);
    let start = lines.findIndex(l => /^\s*\[Interface\]\s*$/i.test(l));
    if (start === -1) throw new Error('В конфиге нет секции [Interface]');
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (/^\s*\[.+\]\s*$/.test(lines[i].trim())) { end = i; break; }
    }

    const keys = Object.keys(params);
    const remove = opts.removeMissing
        ? new Set(OBF_ALL_KEYS.filter(k => params[k] === undefined))
        : new Set();
    const used = new Set();
    const body = [];
    for (let i = start + 1; i < end; i++) {
        const line = lines[i];
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
        if (m) {
            const k = m[1];
            if (keys.includes(k)) {
                used.add(k);
                if (String(params[k]) === '') continue; // пустое значение = удалить строку
                body.push(`${k} = ${params[k]}`);
                continue;
            }
            if (remove.has(k)) continue;
        }
        body.push(line);
    }
    const missing = keys.filter(k => !used.has(k) && String(params[k]) !== '');
    if (missing.length) body.push(...missing.map(k => `${k} = ${params[k]}`));

    return [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join('\n');
}

app.get('/api/obf/current', checkAuth, (req, res) => {
    const confPath = serverConfPath();
    if (!confPath) return res.status(404).json({ error: 'Конфиг сервера не найден' });
    try {
        const content = fs.readFileSync(confPath, 'utf8');
        const params = readObfFromConf(content);
        res.json({
            file: confPath,
            params,
            version: detectObfVersion(params),
            audit: auditObf(params)
        });
    } catch (e) { res.status(500).json({ error: 'Ошибка чтения конфига' }); }
});

app.post('/api/obf/analyze', checkAuth, (req, res) => {
    const { source, params: paramsIn } = req.body || {};
    try {
        let parsed;
        if (paramsIn && typeof paramsIn === 'object') {
            const clean = validateObf(paramsIn);
            parsed = {
                params: clean, format: 'params', version: detectObfVersion(clean),
                alternatives: 1, warnings: [], bytes: 0
            };
        } else {
            parsed = parseObfInput(source);
            parsed.params = validateObf(parsed.params);
            parsed.version = detectObfVersion(parsed.params);
        }
        if (!Object.keys(parsed.params).length) throw new Error('Параметры обфускации не найдены');
        parsed.audit = auditObf(parsed.params);
        res.json(parsed);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

function reloadAwgInterface(iface) {
    if (DEMO_MODE || TEST_MODE || process.platform === 'win32') {
        return { ok: true, simulated: true };
    }
    try {
        try {
            sh('systemctl', ['restart', `awg-quick@${iface}`]);
        } catch (e) {
            // Панель может работать не от root: тогда нужен sudo.
            if (!/permission|access|not permitted|denied/i.test(String(e.stderr || e.message || ''))) throw e;
            sh('sudo', ['systemctl', 'restart', `awg-quick@${iface}`]);
        }
    } catch (e) {
        return { ok: false, error: String(e.stderr || e.message || 'systemctl restart failed').trim() };
    }
    const state = isActive(`awg-quick@${iface}`);
    return state === 'active'
        ? { ok: true, state }
        : { ok: false, state, error: `интерфейс ${iface} не активен (${state})` };
}

function regenClientsSafe() {
    if (DEMO_MODE || TEST_MODE || process.platform === 'win32') {
        return { regenerated: 3, simulated: true };
    }
    const out = sh('sudo', ['bash', MANAGE, 'regen', '--json'], { maxBuffer: 32 * 1024 * 1024 });
    const data = JSON.parse(out);
    return { regenerated: data.regenerated, simulated: false };
}

function applyObfParams(req, res, paramsIn, options = {}) {
    const opts = typeof options === 'boolean' ? { regenClients: options } : options;
    const regenClients = !!opts.regenClients;
    const removeMissing = opts.removeMissing !== false;

    let params;
    try {
        params = validateObf(paramsIn);
    } catch (e) {
        return res.status(400).json({ error: 'Не удалось разобрать параметры: ' + e.message });
    }
    if (!Object.keys(params).length) return res.status(400).json({ error: 'Параметры обфускации не найдены' });

    const confPath = serverConfPath();
    if (!confPath) return res.status(404).json({ error: 'Конфиг сервера не найден' });

    let original = '';
    let backup = '';
    try {
        original = fs.readFileSync(confPath, 'utf8');
        backup = `${confPath}.bak_${Date.now()}`;
        writeRootFile(backup, original, '0600');

        const updated = applyObfToConf(original, params, { removeMissing });
        writeRootFile(confPath, updated, '0600');

        const iface = path.basename(confPath, '.conf');
        const restart = reloadAwgInterface(iface);
        if (!restart.ok) {
            // Не оставляем сервер с конфигом, который не поднимается.
            writeRootFile(confPath, original, '0600');
            reloadAwgInterface(iface);
            return res.status(500).json({
                error: 'Интерфейс не поднялся после применения параметров — изменения откатены. ' +
                    (restart.error || ''),
                rollback: true,
                backup
            });
        }

        let regen = null;
        if (regenClients) {
            try {
                regen = regenClientsSafe();
            } catch (e) {
                // Клиенты остались бы со старыми параметрами и потеряли связь.
                writeRootFile(confPath, original, '0600');
                reloadAwgInterface(iface);
                try { regenClientsSafe(); } catch (e2) { /* ignore */ }
                return res.status(500).json({
                    error: 'Не удалось перегенерировать клиентов — изменения откатены. ' + e.message,
                    rollback: true,
                    backup
                });
            }
        }

        const appliedParams = readObfFromConf(fs.readFileSync(confPath, 'utf8'));
        const audit = auditObf(appliedParams);
        const removed = removeMissing
            ? OBF_ALL_KEYS.filter(k => params[k] === undefined && original.match(new RegExp(`^\\s*${k}\\s*=`, 'm')))
            : [];
        auditLog(req, `Применены параметры обфускации: ${Object.keys(params).join(', ')}` +
            ` (клиенты regen: ${regenClients ? 'да' : 'нет'}, удалено: ${removed.length})`);
        res.json({
            success: true,
            applied: Object.keys(params).length,
            removed,
            file: confPath,
            backup,
            regenerated: regen ? regen.regenerated : null,
            simulated: DEMO_MODE || TEST_MODE || process.platform === 'win32',
            audit,
            version: detectObfVersion(appliedParams)
        });
    } catch (e) {
        // Если запись уже успела произойти — пытаемся вернуть исходный конфиг.
        try {
            if (original) {
                writeRootFile(confPath, original, '0600');
                reloadAwgInterface(path.basename(confPath, '.conf'));
            }
        } catch (e2) { /* ignore */ }
        res.status(500).json({ error: 'Ошибка применения: ' + e.message, rollback: !!original });
    }
}

app.post('/api/obf/apply', checkAuth, (req, res) => {
    const body = req.body || {};
    let params;
    try {
        params = body.params && typeof body.params === 'object'
            ? body.params
            : parseObfInput(body.source).params;
    } catch (e) {
        return res.status(400).json({ error: 'Не удалось разобрать параметры: ' + e.message });
    }
    return applyObfParams(req, res, params, {
        regenClients: !!body.regenClients,
        removeMissing: body.removeMissing !== false
    });
});

// ---------------------------------------------------------------------------
// Профили обфускации: встроенные + сохранённые пользователем
// ---------------------------------------------------------------------------
const OBF_BUILTIN_PROFILES = {
    default: {
        title: 'Стандарт AWG 1.0 (совместимость)',
        level: 'weak',
        note: 'H1–H4 = 1–4 — сигнатура обычного WireGuard. Годится только для проверки совместимости, не для обхода ТСПУ.',
        params: { Jc: 4, Jmin: 40, Jmax: 70, S1: 50, S2: 100, H1: 1, H2: 2, H3: 3, H4: 4 }
    },
    mobile: {
        title: 'Мобильные операторы (МТС/Билайн/МегаФон)',
        level: 'weak',
        note: 'Фиксированные H и нет CPS/HPK: лучше стандарта, но современный DPI всё ещё видит шаблон.',
        params: { Jc: 3, Jmin: 10, Jmax: 50, S1: 30, S2: 60, H1: 1234567, H2: 2345678, H3: 3456789, H4: 4567890 }
    },
    aggressive: {
        title: 'Агрессивный (много шума, AWG 2.0)',
        level: 'weak',
        note: 'Больше мусора и паддинга, но H1–H4 остаются фиксированными. Для ТСПУ используйте профиль из Архитектора.',
        params: { Jc: 6, Jmin: 50, Jmax: 200, S1: 100, S2: 200, H1: 987654321, H2: 876543210, H3: 765432100, H4: 654321000 }
    }
};

// Шаблоны CPS-цепочек (формат ядра AmneziaWG). Случайные hex-байты внутри
// шаблона делают профиль уникальным, но сохраняют проверенную структуру тегов.
const OBF_CPS_TEMPLATES = [
    '<b 0xc200000001135bf9a6a22674b9cb6f926ccddf15ae5ff710430797226ea41175dd0a02cae804df38bb9b577b40b25bba82><rc 17><t><r 154>',
    '<b 0xccd0e656><t><rc 5><r 414><rd 5>',
    '<t><b 0xff7ff55bd5096330c97c08071cc9><r 10><rc 8><rd 8>',
    '<b 0xae040965><t><rc 5><r 14><rd 8>',
    '<r 26><rc 6><b 0x561ff6b71d76b5a8c88c7e><t><rd 7>'
];

function obfRandomInt(min, max) {
    return crypto.randomInt(min, max + 1);
}
function obfRandomHex(chars) {
    return crypto.randomBytes(Math.ceil(chars / 2)).toString('hex').slice(0, chars);
}
function obfRandomizeCps(template) {
    return String(template).replace(/0x([0-9a-f]+)/gi, (m, hex) => '0x' + obfRandomHex(hex.length));
}

/**
 * Генерирует готовый профиль обфускации без Архитектора.
 * max      — AWG 3.1: все I1–I5, HPK, таймеры, флаги;
 * balanced — AWG 3.1: три цепочки, меньше нагрузки;
 * compat   — AWG 2.0: без HPK/таймеров/флагов, для старых клиентов.
 */
function generateObfProfile(preset) {
    const mode = ['max', 'balanced', 'compat'].includes(preset) ? preset : 'balanced';
    const p = {};

    // Четыре непересекающихся диапазона H. Базы разнесены на 1e9, поэтому
    // даже максимальная ширина 8192 не создаёт пересечений.
    const bases = [1000000, 1100000000, 2100000000, 3100000000];
    for (let i = 0; i < 4; i++) {
        const width = obfRandomInt(4096, 8192);
        const start = bases[i] + obfRandomInt(0, 1000000);
        p['H' + (i + 1)] = `${start}-${start + width}`;
    }

    // S1–S3 не меньше 12 (nonce для HeaderProtectionKey), S4 не больше 32.
    const s1 = obfRandomInt(24, 96);
    let s2 = obfRandomInt(24, 96);
    if (s2 === s1 + 56) s2 = s1 + 55;
    p.S1 = String(s1);
    p.S2 = String(s2);
    p.S3 = String(obfRandomInt(24, 96));
    p.S4 = String(obfRandomInt(16, 32));

    const jmin = obfRandomInt(64, 256);
    p.Jmin = String(jmin);
    p.Jmax = String(jmin + obfRandomInt(160, 420));
    p.Jc = String(obfRandomInt(4, 10));

    const chains = mode === 'max' ? 5 : 3;
    for (let i = 0; i < chains; i++) p['I' + (i + 1)] = obfRandomizeCps(OBF_CPS_TEMPLATES[i]);

    if (mode !== 'compat') {
        p.HeaderProtectionKey = crypto.randomBytes(32).toString('base64');
        const cp = obfRandomInt(24, 80);
        p.ContentPaddingAddition = `${cp}-${cp + obfRandomInt(20, 80)}`;
        const ra = obfRandomInt(100, 110);
        p.RekeyAfterTime = `${ra}-${ra + obfRandomInt(10, 18)}`;
        const rt = obfRandomInt(4, 5);
        p.RekeyTimeout = `${rt}-${rt + obfRandomInt(1, 2)}`;
        const rj = obfRandomInt(170, 185);
        p.RejectAfterTime = `${rj}-${rj + obfRandomInt(8, 18)}`;
        const ka = obfRandomInt(8, 12);
        p.KeepaliveTimeout = `${ka}-${ka + obfRandomInt(3, 6)}`;
        const mh = obfRandomInt(8, 12);
        p.MaxHandshakeAttempts = `${mh}-${mh + obfRandomInt(2, 5)}`;
        p.RandomTrailers = '1';
        p.DisableCookies = '1';
    }

    return validateObf(p);
}

app.post('/api/obf/generate', checkAuth, (req, res) => {
    try {
        const preset = (req.body && req.body.preset) || 'balanced';
        const params = generateObfProfile(preset);
        res.json({
            preset: ['max', 'balanced', 'compat'].includes(preset) ? preset : 'balanced',
            params,
            version: detectObfVersion(params),
            audit: auditObf(params)
        });
    } catch (e) {
        res.status(500).json({ error: 'Не удалось сгенерировать профиль: ' + e.message });
    }
});

function loadObfProfiles() {
    const j = readJson(OBF_PROFILES_FILE, { profiles: [] });
    return Array.isArray(j.profiles) ? j.profiles.filter(p => p && typeof p.name === 'string' && p.params) : [];
}
function saveObfProfiles(list) {
    ensureDir(DATA_DIR);
    writeJson(OBF_PROFILES_FILE, { profiles: list }, 0o600);
}

app.get('/api/obf/profiles', checkAuth, (req, res) => {
    let current = {};
    try {
        const confPath = serverConfPath();
        if (confPath && fs.existsSync(confPath)) current = readObfFromConf(fs.readFileSync(confPath, 'utf8'));
    } catch (e) { current = {}; }
    res.json({
        builtin: Object.entries(OBF_BUILTIN_PROFILES).map(([name, p]) => {
            const a = auditObf(p.params);
            return {
                name, title: p.title, params: p.params, builtin: true,
                level: p.level || a.level, score: a.score, note: p.note || ''
            };
        }),
        custom: loadObfProfiles().map(p => {
            const a = auditObf(p.params);
            return {
                name: p.name, title: p.title || p.name, params: p.params, builtin: false,
                level: a.level, score: a.score, note: a.version !== 'unknown' ? `AWG ${a.version}` : ''
            };
        }),
        current,
        currentAudit: auditObf(current)
    });
});

app.post('/api/obf/profiles', checkAuth, (req, res) => {
    const name = String((req.body && req.body.name) || '').trim();
    if (!/^[A-Za-z0-9А-Яа-яЁё _.-]{2,40}$/.test(name)) return res.status(400).json({ error: 'Имя профиля: 2–40 символов' });
    let params;
    try {
        params = validateObf((req.body && req.body.params) || extractObfFromAny(req.body && req.body.source));
    } catch (e) { return res.status(400).json({ error: e.message }); }
    if (!Object.keys(params).length) return res.status(400).json({ error: 'Нет параметров для сохранения' });
    const list = loadObfProfiles();
    const existing = list.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing) { existing.params = params; existing.title = name; existing.updatedAt = new Date().toISOString(); }
    else list.push({ name, title: name, params, createdAt: new Date().toISOString() });
    saveObfProfiles(list);
    auditLog(req, `Сохранён профиль обфускации «${name}»`);
    res.json({ success: true, name, params });
});

app.delete('/api/obf/profiles/:name', checkAuth, (req, res) => {
    const name = String(req.params.name);
    const list = loadObfProfiles();
    const next = list.filter(p => p.name !== name);
    if (next.length === list.length) return res.status(404).json({ error: 'Профиль не найден' });
    saveObfProfiles(next);
    auditLog(req, `Удалён профиль обфускации «${name}»`);
    res.json({ success: true });
});

app.post('/api/obf/profiles/:name/apply', checkAuth, (req, res) => {
    const name = String(req.params.name);
    const builtin = OBF_BUILTIN_PROFILES[name];
    const custom = loadObfProfiles().find(p => p.name === name);
    const src = builtin ? builtin.params : (custom && custom.params);
    if (!src) return res.status(404).json({ error: 'Профиль не найден' });
    return applyObfParams(req, res, src, {
        regenClients: !!(req.body && req.body.regenClients),
        removeMissing: !!(req.body && req.body.removeMissing)
    });
});

app.get('/api/obf/export', checkAuth, (req, res) => {
    const confPath = serverConfPath();
    if (!confPath) return res.status(404).send('Конфиг сервера не найден');
    let content = '';
    try { content = fs.readFileSync(confPath, 'utf8'); } catch (e) { return res.status(500).send('Ошибка чтения'); }
    const obf = readObfFromConf(content);
    const ini = parseIni(content);
    const format = String(req.query.format || 'conf');

    if (format === 'json') {
        // Совместимо с импортом сайта-архитектора (Amnezia VpnConfig)
        const body = { ...obf, last_config: JSON.stringify({ ...obf, hostName: (ini.Peer && ini.Peer.Endpoint || '').split(':')[0] }) };
        const cfg = {
            containers: [{ container: 'amnezia-awg', awg: body }],
            defaultContainer: 'amnezia-awg',
            description: 'Servpanel obfuscation export',
            hostName: (ini.Peer && ini.Peer.Endpoint || '').split(':')[0] || ''
        };
        res.setHeader('Content-Disposition', 'attachment; filename="obfuscation.json"');
        return res.type('application/json').send(JSON.stringify(cfg, null, 4));
    }

    const lines = ['[Interface]', 'Address = 10.0.0.2/32', 'PrivateKey = <ВСТАВЬТЕ_СВОЙ_КЛЮЧ>'];
    for (const k of OBF_ALL_KEYS) if (obf[k] !== undefined) lines.push(`${k} = ${obf[k]}`);
    lines.push('', '[Peer]', 'PublicKey = <ПУБЛИЧНЫЙ_КЛЮЧ_СЕРВЕРА>',
        'AllowedIPs = 0.0.0.0/0, ::/0', 'Endpoint = <IP_СЕРВЕРА>:<ПОРТ>', 'PersistentKeepalive = 25', '');
    res.setHeader('Content-Disposition', 'attachment; filename="obfuscation-template.conf"');
    res.type('text/plain').send(lines.join('\n'));
});

// ---------------------------------------------------------------------------
// Конфиг AmneziaWG
// ---------------------------------------------------------------------------
app.get('/api/awg/config', checkAuth, (req, res) => {
    try {
        let confPath = null;
        if (req.query.file) {
            if (!EDITABLE_CONF.has(String(req.query.file))) return res.status(400).json({ error: 'Недопустимый путь' });
            if (fs.existsSync(String(req.query.file))) confPath = String(req.query.file);
        }
        if (!confPath) confPath = serverConfPath() || existingCascadeConf();
        if (!confPath) return res.status(404).json({ error: 'Конфиг не найден' });
        res.json({ content: fs.readFileSync(confPath, 'utf8'), file: confPath });
    } catch (e) { res.status(500).json({ error: 'Ошибка чтения конфига' }); }
});

app.post('/api/awg/config', checkAuth, (req, res) => {
    const { content, file } = req.body || {};
    if (!content || !file) return res.status(400).json({ error: 'Пустой конфиг' });
    if (!EDITABLE_CONF.has(String(file))) return res.status(400).json({ error: 'Недопустимый путь конфига' });
    if (String(content).length > 256 * 1024) return res.status(400).json({ error: 'Конфиг слишком большой' });
    if (!/^\s*\[Interface\]/im.test(content)) return res.status(400).json({ error: 'Конфиг должен содержать [Interface]' });
    try {
        auditLog(req, `Изменение конфигурации AWG: ${file}`);
        if (fs.existsSync(file)) writeRootFile(`${file}.bak_${Date.now()}`, fs.readFileSync(file, 'utf8'), '0600');
        writeRootFile(file, content, '0600');

        // Синхронизация ключей сервера (без shell-инъекций)
        try {
            const hpk = content.match(/HeaderProtectionKey\s*=\s*([^\r\n]+)/);
            const priv = content.match(/PrivateKey\s*=\s*([^\r\n]+)/);
            if (hpk) writeRootFile(path.join(AWG_DIR, 'server_hpk.key'), hpk[1].trim() + '\n', '0600');
            if (priv) {
                const cleanPriv = priv[1].trim();
                if (/^[A-Za-z0-9+/=]{20,128}$/.test(cleanPriv)) {
                    writeRootFile(path.join(AWG_DIR, 'server_priv.key'), cleanPriv + '\n', '0600');
                    try {
                        const privTmp = path.join(os.tmpdir(), 'panel-priv-' + crypto.randomBytes(6).toString('hex'));
                        fs.writeFileSync(privTmp, cleanPriv + '\n', { mode: 0o600 });
                        const pub = execFileSync('sudo', ['bash', '-c', `awg pubkey < ${privTmp}`], { encoding: 'utf8' }).trim();
                        try { fs.unlinkSync(privTmp); } catch (e2) { /* ignore */ }
                        if (pub) writeRootFile(path.join(AWG_DIR, 'server_pub.key'), pub + '\n', '0600');
                    } catch (e) { /* ignore */ }
                }
            }
        } catch (e) { /* ignore */ }

        const iface = path.basename(file, '.conf');
        try { sh('sudo', ['systemctl', 'restart', `awg-quick@${iface}`]); }
        catch (e) {
            try { sh('sudo', ['docker', 'restart', 'amnezia-awg']); } catch (e2) { /* ignore */ }
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Ошибка сохранения конфига' }); }
});

// ---------------------------------------------------------------------------
// Резервные копии
// ---------------------------------------------------------------------------
const BACKUP_PATHS = [
    '/etc/amnezia/amneziawg', '/root/awg', '/root/servpanel', '/root/awg-admin',
    '/etc/nginx/sites-available/awg-admin', '/etc/nginx/.htpasswd'
];
const RESTORE_ALLOWED_PREFIXES = [
    'etc/amnezia/amneziawg/', 'root/awg/', 'root/servpanel/', 'root/awg-admin',
    'etc/nginx/sites-available/awg-admin', 'etc/nginx/.htpasswd'
];

app.get('/api/backup', checkAuth, (req, res) => {
    const dateStr = new Date().toISOString().replace(/T/, '-').replace(/:/g, '-').slice(0, 16);
    const fileName = `awg-full-backup-${dateStr}.tar.gz`;
    const tempPath = path.join(os.tmpdir(), fileName);
    const args = ['-czf', tempPath, ...BACKUP_PATHS];
    execFile('sudo', ['tar', ...args], { timeout: 180000 }, () => {
        if (!fs.existsSync(tempPath)) return res.status(500).send('Не удалось создать архив');
        auditLog(req, 'Скачивание резервной копии');
        res.download(tempPath, fileName, () => { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); });
    });
});

app.post('/api/restore', checkAuth, (req, res) => {
    const { fileData } = req.body || {};
    if (!fileData || typeof fileData !== 'string') return res.status(400).json({ error: 'Нет данных файла' });
    if (fileData.length > 48 * 1024 * 1024) return res.status(400).json({ error: 'Архив слишком большой' });
    let buffer;
    try { buffer = Buffer.from(fileData, 'base64'); }
    catch (e) { return res.status(400).json({ error: 'Некорректный base64' }); }

    const tempPath = path.join(os.tmpdir(), 'restore-' + crypto.randomBytes(6).toString('hex') + '.tar.gz');
    try {
        fs.writeFileSync(tempPath, buffer);
        // Проверяем содержимое архива ДО распаковки (защита от tar-инъекций)
        const listing = sh('tar', ['-tzf', tempPath], { maxBuffer: 32 * 1024 * 1024 });
        for (const raw of listing.split('\n')) {
            const p = raw.replace(/^\.\//, '').trim();
            if (!p || p.endsWith('/')) continue;
            if (p.startsWith('/') || p.split('/').includes('..') || p.includes('\0')) {
                return res.status(400).json({ error: 'Архив содержит недопустимые пути' });
            }
            if (!RESTORE_ALLOWED_PREFIXES.some(pre => p === pre || p.startsWith(pre))) {
                return res.status(400).json({ error: 'Архив содержит файлы вне разрешённых каталогов: ' + p });
            }
        }
        sh('sudo', ['tar', '-xzf', tempPath, '-C', '/'], { timeout: 180000 });
        auditLog(req, 'Восстановление из резервной копии');
        res.json({ success: true });
        setTimeout(() => {
            try { sh('sudo', ['bash', '-c', 'pm2 restart awg-admin']); } catch (e) { /* ignore */ }
        }, 1000);
    } catch (e) {
        res.status(500).json({ error: 'Ошибка распаковки: ' + e.message });
    } finally {
        try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
    }
});

// ---------------------------------------------------------------------------
// Пароль и информация о сервере
// ---------------------------------------------------------------------------
app.post('/api/change-password', checkAuth, (req, res) => {
    const { newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 8) return res.status(400).json({ error: 'Пароль должен быть не короче 8 символов' });
    const me = req.session.user || 'admin';
    try {
        if (me === 'admin') {
            fs.writeFileSync(PASS_FILE, String(newPassword), { mode: 0o600 });
            try { fs.chmodSync(PASS_FILE, 0o600); } catch (e2) { /* ignore */ }
            ADMIN_PASSWORD = String(newPassword);
        } else {
            const users = loadUsers();
            const u = users.find(x => x.username === me);
            if (!u) return res.status(404).json({ error: 'Пользователь не найден' });
            const salt = crypto.randomBytes(16).toString('hex');
            u.salt = salt;
            u.hash = hashPassword(String(newPassword), salt);
            saveUsers(users);
        }
        auditLog(req, `Изменён пароль пользователя ${me}`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка изменения пароля' });
    }
});

app.get('/api/server-info', checkAuth, (req, res) => {
    if (DEMO_MODE) return res.json({ ip: '203.0.113.10', domain: 'vpn.example.com', country: 'NL' });
    try {
        const domain = guessDomain();
        let ip = 'Неизвестно';
        let country = 'UNKNOWN';
        try {
            const out = sh('curl', ['-s', '--max-time', '8', 'https://ipinfo.io/json']);
            const info = JSON.parse(out || '{}');
            ip = info.ip || ip;
            country = info.country || country;
        } catch (e) { /* ignore */ }
        if (ip === 'Неизвестно') {
            try { ip = sh('curl', ['-4s', '--max-time', '8', 'https://ifconfig.me']).trim(); } catch (e) { /* ignore */ }
        }
        res.json({ ip, domain, country });
    } catch (e) {
        res.json({ ip: 'Неизвестно', domain: '', country: 'UNKNOWN' });
    }
});

// ---------------------------------------------------------------------------
// Обновление панели (безопасное, с бэкапом и откатом)
//
// Важно: сам процесс обновления выполняется отдельным detached-процессом
// lib/update-worker.js. Он переживает `pm2 restart`, поэтому успевает
// проверить новую версию и откатиться, если она не поднялась.
// Данные, конфиги AWG, каскад, nginx, fail2ban и AdGuard не изменяются.
// ---------------------------------------------------------------------------
const UPDATE_BACKUP_DIR = BACKUP_DIR;
const UPDATE_TMP_PREFIX = '.update-upload-';

function updateConfig() {
    return {
        appDir: APP_DIR,
        dataDir: DATA_DIR,
        port: PANEL_PORT,
        pm2Name: PM2_NAME,
        backupDir: UPDATE_BACKUP_DIR,
        logFile: UPDATE_LOG
    };
}

function safeUpdateError(res, e) {
    const msg = String((e && e.message) || e || 'Ошибка обновления');
    if (/уже выполняется/.test(msg)) return res.status(409).json({ error: msg });
    return res.status(500).json({ error: msg });
}

// Извлекаем интерфейсы из mangle-правил, чтобы показать в интерфейсе,
// что каскад действительно настроен и обновление его не затрагивает.
function detectedCascadeIfaces() {
    const found = new Set();
    try {
        const out = shTry('sudo', ['iptables', '-t', 'mangle', '-S', 'PREROUTING'], { timeout: 5000 });
        for (const line of String(out).split(/\r?\n/)) {
            if (!/\s-A\s+PREROUTING\s/.test(line)) continue;
            if (!/MARK|RETURN/.test(line)) continue;
            const m = /\s-i\s+([A-Za-z0-9_.:@-]+)/.exec(line);
            if (m) found.add(m[1]);
        }
    } catch (e) { /* ignore */ }
    for (const iface of ['awg0', 'amn0', 'awg1']) {
        if (fs.existsSync(path.join(AWG_CONF_DIR, iface + '.conf'))) found.add(iface);
    }
    return Array.from(found).sort();
}

function updateStatusPayload() {
    const st = updater.readStatus(DATA_DIR);
    let version = '';
    try { version = String(JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version || ''); }
    catch (e) { /* ignore */ }
    return {
        ...st,
        log: Array.isArray(st.log) ? st.log.slice(-80) : [],
        version,
        backups: updater.listBackups(UPDATE_BACKUP_DIR),
        logTail: updater.readLog(UPDATE_LOG, 80)
    };
}

app.get('/api/update/info', checkAuth, requireAdmin, (req, res) => {
    try {
        const info = updater.updateInfo(updateConfig());
        res.json({
            ...info,
            status: updater.readStatus(DATA_DIR),
            backups: updater.listBackups(UPDATE_BACKUP_DIR),
            logTail: updater.readLog(UPDATE_LOG, 120),
            cascadeIfaces: detectedCascadeIfaces(),
            cascadeConf: !!existingCascadeConf(),
            limits: { uploadMb: 10 }
        });
    } catch (e) {
        safeUpdateError(res, e);
    }
});

app.get('/api/update/status', checkAuth, requireAdmin, (req, res) => {
    try { res.json(updateStatusPayload()); }
    catch (e) { safeUpdateError(res, e); }
});

app.get('/api/update/check-git', checkAuth, requireAdmin, (req, res) => {
    try {
        const g = updater.gitCheck(APP_DIR, 'origin', 'main');
        res.json(g);
    } catch (e) {
        safeUpdateError(res, e);
    }
});

function startUpdateWorker(res, req, opts, auditText) {
    if (process.env.SERVPANEL_DEMO === '1') {
        res.status(400).json({ error: 'В демо-режиме обновление отключено' });
        return false;
    }
    try {
        const worker = updater.startWorker({
            ...updateConfig(),
            ...opts
        });
        auditLog(req, auditText || 'Запущено обновление панели');
        res.json({
            success: true,
            pid: worker && worker.pid ? worker.pid : null,
            unit: worker && worker.unit ? worker.unit : '',
            runner: worker && worker.runner ? worker.runner : ''
        });
        return true;
    } catch (e) {
        safeUpdateError(res, e);
        return false;
    }
}

// Обновление из загруженного .tar.gz (base64 в JSON, без multer).
app.post('/api/update/upload', checkAuth, requireAdmin, (req, res) => {
    const body = req.body || {};
    const name = String(body.name || 'servpanel.tar.gz').replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
    const data = String(body.data || '');
    if (!data) return res.status(400).json({ error: 'Файл не передан' });
    if (data.length > 10 * 1024 * 1024 * 1.4) return res.status(413).json({ error: 'Файл больше 10 МБ' });
    let buf;
    try { buf = Buffer.from(data, 'base64'); }
    catch (e) { return res.status(400).json({ error: 'Некорректный base64' }); }
    if (!buf.length) return res.status(400).json({ error: 'Пустой файл' });
    if (buf.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'Файл больше 10 МБ' });

    const archive = path.join(DATA_DIR, UPDATE_TMP_PREFIX + Date.now() + '-' + name);
    try {
        fs.writeFileSync(archive, buf, { mode: 0o600 });
        const started = startUpdateWorker(res, req, {
            mode: 'apply',
            archive,
            sha256: String(body.sha256 || ''),
            cleanupArchive: true
        }, `Загружен релиз панели ${name}`);
        if (!started) {
            try { fs.unlinkSync(archive); } catch (e2) { /* ignore */ }
        }
    } catch (e) {
        try { fs.unlinkSync(archive); } catch (e2) { /* ignore */ }
        safeUpdateError(res, e);
    }
});

// Обновление по URL (например, свой сервер раздачи релизов).
app.post('/api/update/url', checkAuth, requireAdmin, async (req, res) => {
    const raw = String((req.body && req.body.url) || '');
    let u;
    try { u = new URL(raw); } catch (e) { return res.status(400).json({ error: 'Некорректный URL' }); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return res.status(400).json({ error: 'Разрешены только http/https' });
    let archive = '';
    try {
        const r = await fetchWithTimeout(u.toString(), {}, 60000);
        if (!r.ok) return res.status(502).json({ error: 'Сервер отдал HTTP ' + r.status });
        const len = parseInt(r.headers.get('content-length') || '0', 10);
        if (len > 10 * 1024 * 1024) return res.status(413).json({ error: 'Файл больше 10 МБ' });
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'Файл больше 10 МБ' });
        archive = path.join(DATA_DIR, UPDATE_TMP_PREFIX + Date.now() + '-url.tar.gz');
        fs.writeFileSync(archive, buf, { mode: 0o600 });
        const started = startUpdateWorker(res, req, {
            mode: 'apply',
            archive,
            sha256: String((req.body && req.body.sha256) || ''),
            cleanupArchive: true
        }, 'Запущено обновление панели по URL');
        if (!started) {
            try { fs.unlinkSync(archive); } catch (e2) { /* ignore */ }
        }
    } catch (e) {
        if (archive) {
            try { fs.unlinkSync(archive); } catch (e2) { /* ignore */ }
        }
        safeUpdateError(res, e);
    }
});

// GitHub-обновление: только fast-forward, без reset --hard.
app.post('/api/update/git', checkAuth, requireAdmin, (req, res) => {
    startUpdateWorker(res, req, { mode: 'git', branch: 'main', remote: 'origin' },
        'Запущено обновление панели с GitHub');
});

// Принудительное GitHub-обновление: сбрасывает только отслеживаемые файлы кода
// к origin/main. Данные панели и конфиги AWG не входят в git и не затрагиваются.
app.post('/api/update/git-force', checkAuth, requireAdmin, (req, res) => {
    startUpdateWorker(res, req, { mode: 'git-force', branch: 'main', remote: 'origin' },
        'Запущено принудительное обновление панели с GitHub (сброс локальных изменений кода)');
});

// Старый вызов оставлен совместимым, но теперь он тоже безопасный.
app.post('/api/update', checkAuth, requireAdmin, (req, res) => {
    startUpdateWorker(res, req, { mode: 'git', branch: 'main', remote: 'origin' },
        'Запущено обновление панели с GitHub (совместимый вызов)');
});

app.post('/api/update/rollback', checkAuth, requireAdmin, (req, res) => {
    try {
        let backup = String((req.body && req.body.backup) || '');
        if (!backup) {
            const list = updater.listBackups(UPDATE_BACKUP_DIR, 1);
            if (!list.length) return res.status(404).json({ error: 'Резервных копий панели нет' });
            backup = list[0].path;
        }
        const resolved = path.resolve(backup);
        if (!resolved.startsWith(path.resolve(UPDATE_BACKUP_DIR) + path.sep)) {
            return res.status(400).json({ error: 'Бэкап вне каталога резервных копий' });
        }
        if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Бэкап не найден' });
        startUpdateWorker(res, req, { mode: 'rollback', backup: resolved },
            'Запущен откат панели из резервной копии');
    } catch (e) {
        safeUpdateError(res, e);
    }
});

// ---------------------------------------------------------------------------
// Установка модулей с отслеживанием прогресса
// ---------------------------------------------------------------------------
const MODULES = {
    awg: {
        url: 'https://raw.githubusercontent.com/makar19977v-glitch/servpanel/main/install_awg_stateful.sh',
        log: '/var/log/awg_install.log',
        title: 'AmneziaWG'
    },
    mtproto: {
        url: 'https://raw.githubusercontent.com/makar19977v-glitch/servpanel/main/install_mtproto_silent.sh',
        log: '/var/log/mtproto_install.log',
        title: 'MTProto'
    },
    adguard: {
        url: 'https://raw.githubusercontent.com/makar19977v-glitch/servpanel/main/install_adguard_silent.sh',
        log: '/var/log/adguard_install.log',
        title: 'AdGuard Home'
    },
    warp: {
        local: WARP_INSTALLER,
        log: WARP_LOG,
        title: 'Cloudflare WARP + Xray'
    }
};
const LOG_WHITELIST = [
    '/var/log/awg_install.log', '/var/log/mtproto_install.log', '/var/log/adguard_install.log',
    '/var/log/awg_uninstall.log', '/var/log/ru-drop.log', '/var/log/awg_audit.log',
    WARP_LOG,
    '/var/log/nginx/error.log', '/var/log/nginx/access.log', '/var/log/auth.log', '/var/log/syslog'
];

function installEnv(data) {
    const env = { ...process.env, PANEL_PORT: String(PANEL_PUBLIC_PORT) };
    if (data.domain && HOST_RE.test(String(data.domain))) env.SERVER_PUB_IP = String(data.domain);
    env.AWG_VERSION = ['1.5', '2.0', '3.1'].includes(String(data.version)) ? String(data.version) : '2.0';
    env.AWG_PRESET = ['default', 'mobile'].includes(String(data.preset)) ? String(data.preset) : 'default';
    env.AWG_ROUTE = ['all', 'amnezia', 'custom'].includes(String(data.route)) ? String(data.route) : 'all';
    if (data.customRoute) {
        const nets = parseCidrList(data.customRoute);
        if (nets && nets.length) env.AWG_CUSTOM_ROUTE = nets.join(',');
    }
    env.AWG_IPV6 = ['disallow', 'allow', 'tunnel'].includes(String(data.ipv6)) ? String(data.ipv6) : 'disallow';
    if (isPort(data.port)) env.AWG_PORT = String(data.port);
    env.AWG_ISOLATION = data.isolation === false ? 'off' : 'on';
    env.AWG_KEEP_PACKAGES = data.keepPackages === false ? '0' : '1';
    env.AWG_NO_TWEAKS = data.noTweaks ? '1' : '0';
    env.AWG_MODE = ['single', 'cascade'].includes(String(data.awgMode)) ? String(data.awgMode) : 'single';
    env.CASCADE_ROLE = ['ru', 'eu'].includes(String(data.cascadeRole)) ? String(data.cascadeRole) : 'ru';
    if (data.remoteIp && isIpOrHost(String(data.remoteIp))) env.REMOTE_IP = String(data.remoteIp);
    env.REMOTE_PORT = isPort(data.remotePort) ? String(data.remotePort) : '22';
    if (data.remotePass) env.REMOTE_PASS = String(data.remotePass);
    // Опциональный WARP + Xray. Значения проверяются и здесь, и в скрипте.
    env.WARP_LISTEN_IP = IPV4_RE.test(String(data.listenIp || '')) ? String(data.listenIp) : '10.8.1.1';
    const warpListenPort = Number(data.listenPort);
    const warpSocksPort = Number(data.socksPort);
    env.WARP_LISTEN_PORT = Number.isInteger(warpListenPort) && warpListenPort >= 1 && warpListenPort <= 65535
        ? String(warpListenPort) : '443';
    env.WARP_SOCKS_PORT = Number.isInteger(warpSocksPort) && warpSocksPort >= 1 && warpSocksPort <= 65535
        ? String(warpSocksPort) : '40000';
    return env;
}

app.post('/api/install/module', checkAuth, (req, res) => {
    const data = req.body || {};
    const module = data.module;
    if (typeof module !== 'string' || !Object.prototype.hasOwnProperty.call(MODULES, module)) {
        return res.status(400).json({ error: 'Неизвестный модуль' });
    }
    const mod = MODULES[module];
    if (module === 'awg' && data.awgMode === 'cascade' && (!data.remoteIp || !data.remotePass)) {
        return res.status(400).json({ error: 'Для каскадной установки нужны IP и пароль удалённого сервера' });
    }
    try {
        sh('sudo', ['bash', '-c', `rm -f ${mod.log} && touch ${mod.log} && chmod 666 ${mod.log}`]);

        if (module !== 'warp') {
            if (data.domain && HOST_RE.test(String(data.domain))) {
                try { fs.writeFileSync('/root/awg_domain.txt', String(data.domain)); } catch (e) { /* ignore */ }
            } else {
                try { fs.unlinkSync('/root/awg_domain.txt'); } catch (e) { /* ignore */ }
            }
        }

        const env = installEnv(data);
        const fd = fs.openSync(mod.log, 'a');
        let child;
        if (mod.local) {
            if (!fs.existsSync(mod.local)) {
                fs.closeSync(fd);
                return res.status(500).json({ error: 'Локальный установщик не найден: ' + path.basename(mod.local) });
            }
            child = spawn('bash', [mod.local], {
                env,
                detached: true,
                stdio: ['ignore', fd, fd]
            });
        } else {
            child = spawn('bash', ['-c',
                `curl -fsSL ${mod.url} -o /tmp/panel-installer-${module}.sh && bash /tmp/panel-installer-${module}.sh`
            ], {
                env,
                detached: true,
                stdio: ['ignore', fd, fd]
            });
        }
        child.unref();
        fs.closeSync(fd);

        try {
            fs.writeFileSync(INSTALL_STATE, JSON.stringify({
                module, logFile: mod.log, title: mod.title,
                startedAt: new Date().toISOString()
            }), { mode: 0o644 });
        } catch (e) { /* ignore */ }

        auditLog(req, `Запущена установка модуля ${module}`);
        res.json({ success: true, logFile: mod.log, title: mod.title });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка запуска установки' });
    }
});

function readLogTail(logFile, bytes = 262144) {
    const size = fs.statSync(logFile).size;
    const start = Math.max(0, size - bytes);
    const fd = fs.openSync(logFile, 'r');
    try {
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
}

const INSTALL_STEPS = [
    { key: 'prepare', title: 'Подготовка', re: /подготов|проверка|начало установки|starting/i },
    { key: 'download', title: 'Загрузка установщика', re: /скачив|download|curl|wget/i },
    { key: 'packages', title: 'Установка пакетов', re: /apt|dpkg|dkms|пакет|установка/i },
    { key: 'config', title: 'Настройка и ключи', re: /настрой|конфигурац|ключ|management|awg0|generate/i },
    { key: 'finish', title: 'Завершение', re: /INSTALLATION DONE|установка завершена|успешно завершена/i }
];

function installProgress(logFile) {
    const emptySteps = INSTALL_STEPS.map(s => ({ key: s.key, title: s.title, done: false }));
    if (!fs.existsSync(logFile)) {
        return { text: 'Ожидание старта установки...', status: 'waiting', steps: emptySteps, done: false, error: false, progress: 0 };
    }
    const text = readLogTail(logFile);
    const lines = text.split(/\r?\n/);
    const tail = lines.slice(-400).join('\n');
    const tailShort = lines.slice(-15).join('\n');

    const steps = INSTALL_STEPS.map((s, i) => ({
        key: s.key,
        title: s.title,
        done: false
    }));
    let foundUpTo = -1;
    for (let i = 0; i < INSTALL_STEPS.length; i++) {
        if (INSTALL_STEPS[i].re.test(tail)) foundUpTo = i;
    }
    for (let i = 0; i <= foundUpTo; i++) steps[i].done = true;

    const done = /INSTALLATION DONE|установка завершена|успешно завершена/i.test(tail);
    const error = /(^|\n)\s*(\[?ERROR\]?|ОШИБКА|fatal:|Error:|Failed to install|Failed to start)/i.test(tailShort);
    let status = 'running';
    if (done) status = 'done';
    else if (error) status = 'error';

    return { text, status, steps, done, error, progress: done ? 100 : Math.round(((foundUpTo + 1) / INSTALL_STEPS.length) * 90) };
}

app.get('/api/install/progress', checkAuth, (req, res) => {
    const logFile = String(req.query.file || '');
    if (!LOG_WHITELIST.includes(logFile)) return res.status(400).json({ error: 'Неверный путь' });
    try {
        res.json({ logFile, ...installProgress(logFile) });
    } catch (e) { res.status(500).json({ error: 'Ошибка чтения лога' }); }
});

app.get('/api/install/log', checkAuth, (req, res) => {
    const logFile = String(req.query.file || '');
    if (!LOG_WHITELIST.includes(logFile)) return res.status(400).send('Неверный путь');
    try {
        if (!fs.existsSync(logFile)) return res.send('Ожидание старта установки...');
        const lines = readLogTail(logFile).split(/\r?\n/);
        res.type('text/plain').send(lines.slice(-200).join('\n'));
    } catch (e) { res.send('Ошибка чтения лога...'); }
});

app.get('/api/install/state', checkAuth, (req, res) => {
    try {
        if (!fs.existsSync(INSTALL_STATE)) return res.json({ active: false });
        const st = JSON.parse(fs.readFileSync(INSTALL_STATE, 'utf8'));
        const prog = installProgress(st.logFile);
        res.json({ active: prog.status === 'running', ...st, status: prog.status, steps: prog.steps, progress: prog.progress });
    } catch (e) { res.json({ active: false }); }
});

// ---------------------------------------------------------------------------
// Полное удаление AmneziaWG
// ---------------------------------------------------------------------------
app.post('/api/uninstall/awg', checkAuth, (req, res) => {
    try {
        const script = `#!/bin/bash
echo "Начинаем удаление AmneziaWG..." > /var/log/awg_uninstall.log
if [ -f "/root/install_amneziawg.sh" ]; then
    bash /root/install_amneziawg.sh --uninstall --yes >> /var/log/awg_uninstall.log 2>&1
else
    curl -fsSL https://raw.githubusercontent.com/bivlked/amneziawg-installer/main/install_amneziawg.sh -o /tmp/uninstall_awg.sh
    bash /tmp/uninstall_awg.sh --uninstall --yes >> /var/log/awg_uninstall.log 2>&1
fi
systemctl stop awg-routing.timer awg-routing.service 2>/dev/null || true
systemctl disable awg-routing.timer 2>/dev/null || true
rm -f /etc/systemd/system/awg-routing.service /etc/systemd/system/awg-routing.timer
rm -rf /etc/amnezia/amneziawg /root/awg /root/awg_domain.txt
systemctl daemon-reload 2>/dev/null || true
echo "=== УДАЛЕНИЕ ЗАВЕРШЕНО ===" >> /var/log/awg_uninstall.log
`;
        fs.writeFileSync('/tmp/run_uninstall_awg.sh', script, { mode: 0o700 });
        const child = spawn('bash', ['/tmp/run_uninstall_awg.sh'], { detached: true, stdio: 'ignore' });
        child.unref();
        auditLog(req, 'Запущено полное удаление AmneziaWG');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка запуска удаления' });
    }
});

// ---------------------------------------------------------------------------
// Диагностика
// ---------------------------------------------------------------------------
app.post('/api/diag/ping', checkAuth, (req, res) => {
    const host = String((req.body && req.body.host) || '').trim();
    if (!host || !isIpOrHost(host)) return res.status(400).json({ error: 'Укажите корректный IP или домен' });
    if (DEMO_MODE) {
        return res.json({ ok: true, host, output: `PING ${host} (${host}) 56(84) bytes of data.\n64 bytes from ${host}: icmp_seq=1 ttl=57 time=8.4 ms\n64 bytes from ${host}: icmp_seq=2 ttl=57 time=8.1 ms\n64 bytes from ${host}: icmp_seq=3 ttl=57 time=8.7 ms\n64 bytes from ${host}: icmp_seq=4 ttl=57 time=8.2 ms\n\n--- ${host} ping statistics ---\n4 packets transmitted, 4 received, 0% packet loss, time 3004ms\nrtt min/avg/max/mdev = 8.1/8.35/8.7/0.2 ms\n` });
    }
    execFile('ping', ['-c', '4', '-W', '3', host], { timeout: 25000 }, (error, stdout, stderr) => {
        res.json({ ok: !error, host, output: String(stdout || '') + String(stderr || '') });
    });
});

app.post('/api/diag/traceroute', checkAuth, (req, res) => {
    const host = String((req.body && req.body.host) || '').trim();
    if (!host || !isIpOrHost(host)) return res.status(400).json({ error: 'Укажите корректный IP или домен' });
    if (DEMO_MODE) {
        return res.json({ ok: true, host, output: `traceroute to ${host} (${host}), 12 hops max, 60 byte packets\n 1  gateway (10.0.0.1)  0.452 ms  0.417 ms  0.401 ms\n 2  172.16.0.1 (172.16.0.1)  1.203 ms  1.187 ms  1.174 ms\n 3  ${host} (${host})  8.221 ms  8.190 ms  8.172 ms\n` });
    }
    execFile('traceroute', ['-m', '12', '-w', '2', host], { timeout: 40000 }, (error, stdout, stderr) => {
        res.json({ ok: !error, host, output: String(stdout || '') + String(stderr || '') });
    });
});

app.get('/api/diag/log', checkAuth, (req, res) => {
    const logFile = String(req.query.file || '');
    if (DEMO_MODE) {
        return res.type('text/plain').send([
            '2026-10-20 12:00:01  interface: awg0, peers: 4',
            '2026-10-20 12:00:04  handshake: iphone-alice 10.8.1.2',
            '2026-10-20 12:00:07  handshake: macbook-bob 10.8.1.3',
            '2026-10-20 12:00:11  cascade: awg1 up, endpoint 203.0.113.10:51820',
            '2026-10-20 12:00:15  adguard: protection enabled',
            '2026-10-20 12:00:20  demo: journal is simulated'
        ].join('\n'));
    }
    if (!LOG_WHITELIST.includes(logFile)) return res.status(400).json({ error: 'Неверный путь' });
    try {
        if (!fs.existsSync(logFile)) return res.send('Файл не найден');
        const lines = readLogTail(logFile).split(/\r?\n/);
        res.type('text/plain').send(lines.slice(-300).join('\n'));
    } catch (e) { res.send('Ошибка чтения лога'); }
});

// ---------------------------------------------------------------------------
// Вспомогательные функции: INI, vpn:// и скрипт переименования
// ---------------------------------------------------------------------------
function parseIni(text) {
    const out = {};
    let sec = null;
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        const m = line.match(/^\[([A-Za-z0-9_-]{1,32})\]$/);
        if (m) { sec = m[1]; if (!out[sec]) out[sec] = {}; continue; }
        const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
        if (kv && sec) out[sec][kv[1]] = kv[2].trim();
    }
    return out;
}

function vpnEncode(obj) {
    const json = Buffer.from(JSON.stringify(obj, null, 4), 'utf8');
    const defl = zlib.deflateSync(json);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(json.length, 0);
    return 'vpn://' + Buffer.concat([len, defl]).toString('base64url').replace(/=+$/, '');
}

function vpnDecode(str) {
    let b;
    try {
        b = Buffer.from(String(str).trim().replace(/^vpn:\/\//i, '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    } catch (e) { throw new Error('Некорректный vpn://'); }
    const txt = b.toString('utf8');
    if (txt.trimStart().startsWith('{')) return JSON.parse(txt);
    try { return JSON.parse(zlib.inflateSync(b.subarray(4)).toString('utf8')); }
    catch (e) { return JSON.parse(b.toString('utf8')); }
}

function buildVpnUriFromConf(name, confText) {
    const ini = parseIni(confText);
    const iface = ini.Interface || {};
    const peer = ini.Peer || {};
    const endpoint = String(peer.Endpoint || '');
    const m = endpoint.match(/^([^:]+):(\d+)$/);
    const host = m ? m[1] : endpoint;
    const port = m ? parseInt(m[2], 10) : 51820;
    const obf = {};
    for (const k of OBF_ALL_KEYS) if (iface[k] !== undefined) obf[k] = iface[k];
    const last = {
        allowed_ips: String(peer.AllowedIPs || '0.0.0.0/0').split(',').map(s => s.trim()),
        client_ip: String(iface.Address || '').split('/')[0],
        client_priv_key: iface.PrivateKey || '',
        client_pub_key: '',
        config: confText,
        hostName: host,
        mtu: iface.MTU || '1420',
        persistent_keep_alive: peer.PersistentKeepalive || '25',
        port,
        psk_key: peer.PresharedKey || '',
        server_pub_key: peer.PublicKey || '',
        ...obf
    };
    const awg = { ...obf, last_config: JSON.stringify(last), port: String(port), transport_proto: 'udp' };
    return vpnEncode({
        containers: [{ container: 'amnezia-awg', awg }],
        defaultContainer: 'amnezia-awg',
        description: name,
        hostName: host
    });
}

const RENAME_BASH = `#!/bin/bash
set -euo pipefail
OLD="$1"; NEW="$2"
AWG_DIR="/root/awg"
CONF="/etc/amnezia/amneziawg/awg0.conf"
[ -f "$CONF" ] || CONF="/etc/amnezia/amneziawg/amn0.conf"
if [ ! -f "$CONF" ]; then
  echo '{"ok":false,"error":"not_found"}'; exit 3
fi
if grep -qxF "#_Name = $NEW" "$CONF" 2>/dev/null || [ -e "$AWG_DIR/$NEW.conf" ]; then
  echo '{"ok":false,"error":"name_exists"}'; exit 3
fi
if ! grep -qxF "#_Name = $OLD" "$CONF" 2>/dev/null && [ ! -e "$AWG_DIR/$OLD.conf" ]; then
  echo '{"ok":false,"error":"not_found"}'; exit 3
fi
cp -a "$CONF" "$CONF.bak.$(date +%s)"
exec 9>"$AWG_DIR/.awg_config.lock"
flock -x -w 30 9
sed -i "s/^#_Name = \${OLD}$/#_Name = \${NEW}/" "$CONF"
cd "$AWG_DIR"
for f in "$OLD.conf" "$OLD.png" "$OLD.vpnuri" "$OLD.vpnuri.png" "$OLD.ovpn"; do
  if [ -e "$f" ]; then mv -- "$f" "\${f/#$OLD/$NEW}"; fi
done
for ext in private public; do
  if [ -e "keys/$OLD.$ext" ]; then mv -- "keys/$OLD.$ext" "keys/$NEW.$ext"; fi
done
if [ -e "expiry/$OLD" ]; then mv -- "expiry/$OLD" "expiry/$NEW"; fi
exec 9>&-
bash "$AWG_DIR/manage_amneziawg.sh" regen "$NEW" --json >/dev/null 2>&1 || true
echo '{"ok":true,"name":"'"$NEW"'"}'
`;

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------
function readPortFile() {
    try {
        const p = parseInt(fs.readFileSync(path.join(APP_DIR, '.panel_port'), 'utf8').trim(), 10);
        return Number.isInteger(p) && p > 0 && p < 65536 ? p : null;
    } catch (e) { return null; }
}
function readPublicPortFile() {
    try {
        const p = parseInt(fs.readFileSync(path.join(APP_DIR, '.panel_public_port'), 'utf8').trim(), 10);
        return Number.isInteger(p) && p > 0 && p < 65536 ? p : null;
    } catch (e) { return null; }
}
// Внутренний порт, который слушает Node. Файл важнее переменной окружения:
// так обновление панели не сбрасывает кастомный порт.
const PANEL_PORT = readPortFile() || parseInt(process.env.PANEL_PORT, 10) || 3000;
// Порт, по которому панель доступна снаружи (для правил UFW установщика).
const PANEL_PUBLIC_PORT = readPublicPortFile() || parseInt(process.env.PANEL_PUBLIC_PORT, 10) || PANEL_PORT;
const PANEL_HOST = process.env.PANEL_HOST || '0.0.0.0';

app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Файл слишком большой' });
    console.error('Ошибка запроса:', err && err.message);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

if (require.main === module) {
    app.listen(PANEL_PORT, PANEL_HOST, () => {
        console.log(`Servpanel (FileManager 4.0) слушает ${PANEL_HOST}:${PANEL_PORT}`);
        console.log(`Режим: DEMO=${process.env.SERVPANEL_DEMO || '-'} TEST=${process.env.SERVPANEL_TEST || '-'} DEMO_MODE=${DEMO_MODE}`);
        if (DEMO_MODE) console.warn('DEMO MODE: используется локальный конфиг-макет, systemd и AmneziaWG не затрагиваются.');
        if (ADMIN_PASSWORD === 'admin123') {
            console.warn('ВНИМАНИЕ: используется пароль по умолчанию admin123. Смените его в интерфейсе!');
        }
    });
}

module.exports = app;
// Экспорт внутренних функций для тестов (не влияет на работу панели)
module.exports._internals = {
    vpnEncode, vpnDecode, buildVpnUriFromConf, parseIni, validateObf, applyObfToConf,
    readObfFromConf, extractObfFromAny, parseObfInput, auditObf, detectObfVersion,
    splitObfBatch, OBF_ALL_KEYS, OBF_SHARED_KEYS, generateObfProfile,
    totpAt, verifyTotp, base32Encode, base32Decode,
    newTotpSecret, otpauthUri, hashCode, makeUser, verifyUserPassword, safeEqual,
    FileSessionStore, cascadeHealth, backupConfig, normalizeAgUrl, parseIpList, validGeoUrl
};




