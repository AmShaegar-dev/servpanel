'use strict';

/*
 * Keenetic fleet: реестр роутеров, проверка связи, RCI/CLI-транспорт,
 * статусы и события. Модуль не зависит от UI и не трогает системные
 * настройки, пока роутер не добавлен явно.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const { execFile } = require('child_process');

function createKeenetic(opts) {
    const {
        DATA_DIR, SECRETS, TEST_MODE, DEMO_MODE, checkAuth, requireAdmin, auditLog
    } = opts;
    const ROUTERS_FILE = path.join(DATA_DIR, '.keenetic_routers.json');
    const EVENTS_FILE = path.join(DATA_DIR, '.keenetic_events.json');
    const MAX_EVENTS = 300;
    const POLL_MS = 30000;
    const rciSessions = new Map();
    const rciIpCache = new Map();
    const refreshing = new Set();
    let pollTimer = null;

    function readJson(file, def) {
        try {
            const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
            return j && typeof j === 'object' ? j : def;
        } catch (e) { return def; }
    }
    function writeJson(file, obj) {
        const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, file);
    }
    function ensureDataDir() {
        try { fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); } catch (e) { /* ignore */ }
    }

    function secretKey() {
        return crypto.createHash('sha256')
            .update(String((SECRETS && SECRETS.sessionSecret) || 'servpanel-keenetic'))
            .digest();
    }
    function encryptSecret(value) {
        const text = String(value || '');
        if (!text) return '';
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
        const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
        return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
    }
    function decryptSecret(value) {
        const parts = String(value || '').split('.');
        if (parts.length !== 3) return '';
        try {
            const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(parts[0], 'base64'));
            decipher.setAuthTag(Buffer.from(parts[1], 'base64'));
            return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64')), decipher.final()]).toString('utf8');
        } catch (e) { return ''; }
    }

    function readRouters() {
        const raw = readJson(ROUTERS_FILE, []);
        return Array.isArray(raw) ? raw.filter(r => r && r.id) : [];
    }
    function writeRouters(list) {
        ensureDataDir();
        writeJson(ROUTERS_FILE, Array.isArray(list) ? list : []);
    }
    function readEvents() {
        const raw = readJson(EVENTS_FILE, []);
        return Array.isArray(raw) ? raw : [];
    }
    function writeEvents(list) {
        ensureDataDir();
        writeJson(EVENTS_FILE, (Array.isArray(list) ? list : []).slice(0, MAX_EVENTS));
    }
    function addEvent(routerId, level, message) {
        const list = readEvents();
        list.unshift({
            id: crypto.randomBytes(6).toString('hex'),
            at: Date.now(),
            routerId: String(routerId || ''),
            level: ['ok', 'warn', 'error', 'info'].includes(level) ? level : 'info',
            message: String(message || '').slice(0, 500)
        });
        writeEvents(list);
    }

    function routerById(id) {
        return readRouters().find(r => r.id === String(id || '')) || null;
    }
    function sanitize(router) {
        if (!router) return null;
        return {
            id: router.id,
            name: router.name,
            host: router.host,
            port: Number(router.port) || 22,
            user: router.user || 'admin',
            transport: router.transport || 'auto',
            profile: router.profile || 'auto',
            rciScheme: router.rciScheme || 'auto',
            rciPort: Number(router.rciPort) || 0,
            enabled: router.enabled !== false,
            createdAt: router.createdAt || 0,
            updatedAt: router.updatedAt || 0,
            hasPassword: !!router.password_enc,
            hasKey: !!router.key_enc,
            status: router.status || { online: false, error: 'Ещё не проверялся' }
        };
    }

    function validHost(host) {
        const h = String(host || '').trim();
        if (!h || h.length > 255 || /\s/.test(h)) return false;
        return /^[A-Za-z0-9._:[\]-]+$/.test(h);
    }
    function validPort(port) {
        const n = Number(port);
        return Number.isInteger(n) && n >= 1 && n <= 65535;
    }
    function profileFromFirmware(text) {
        const s = String(text || '');
        const m = s.match(/(\d+)\.(\d+)/);
        if (!m) return 'unknown';
        const major = Number(m[1]);
        const minor = Number(m[2]);
        if (major >= 5) return `${major}.${minor}`;
        if (major === 4 && (minor === 0 || minor === 1 || minor === 3)) return `4.${minor}`;
        if (major === 3) return '3.1';
        return `${major}.${minor}`;
    }
    function uptimeText(seconds) {
        const n = Math.max(0, Math.floor(Number(seconds) || 0));
        if (!n) return '—';
        const d = Math.floor(n / 86400);
        const h = Math.floor((n % 86400) / 3600);
        const m = Math.floor((n % 3600) / 60);
        if (d) return `${d}д ${h}ч ${m}м`;
        if (h) return `${h}ч ${m}м`;
        return `${m}м`;
    }

    function request(opts) {
        const mod = opts.scheme === 'https' ? https : http;
        const body = opts.body ? Buffer.from(String(opts.body)) : null;
        const headers = { ...(opts.headers || {}) };
        if (body) headers['Content-Length'] = String(body.length);
        return new Promise((resolve, reject) => {
            const req = mod.request({
                host: opts.host,
                port: opts.port,
                path: opts.path,
                method: opts.method || 'GET',
                headers,
                timeout: opts.timeout || 12000,
                servername: opts.servername || undefined,
                rejectUnauthorized: false
            }, res => {
                let out = '';
                res.setEncoding('utf8');
                res.on('data', c => { out += c; });
                res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: out }));
            });
            req.on('timeout', () => req.destroy(new Error('Таймаут соединения')));
            req.on('error', reject);
            if (body) req.write(body);
            req.end();
        });
    }
    function cookieFrom(headers) {
        const raw = headers && headers['set-cookie'];
        const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        return list.map(s => String(s).split(';')[0]).filter(Boolean).join('; ');
    }
    function stripHtml(text) {
        return String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    function isPrivateHost(host) {
        const h = String(host || '');
        if (h === 'localhost' || h === '::1') return true;
        return /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^127\./.test(h);
    }
    function privateHostHint(router) {
        return isPrivateHost(router && router.host)
            ? `Адрес ${router.host} приватный (VPN/локальная сеть). Панель не в этой сети — укажите публичный KeenDNS-домен или настройте обратный туннель. `
            : '';
    }

    async function requestRci(router, opts) {
        const original = String(router.host || '').replace(/^\[|\]$/g, '');
        let addresses = [original];
        if (!net.isIP(original)) {
            try {
                const list = await dns.promises.lookup(original, { all: true });
                const unique = [...new Set(list.map(x => x.address).filter(Boolean))];
                if (unique.length) addresses = unique;
            } catch (e) { /* оставляем имя */ }
        }
        const cached = rciIpCache.get(original);
        if (cached) addresses = [cached, ...addresses.filter(a => a !== cached)];
        let lastError = null;
        let lastResponse = null;
        for (const ip of addresses) {
            try {
                const res = await request({
                    ...opts,
                    host: ip,
                    servername: original,
                    headers: {
                        'User-Agent': 'Servpanel-Keenetic/1.0',
                        Accept: 'application/json',
                        ...(opts.headers || {}),
                        Host: String(router.host || original)
                    }
                });
                res._ip = ip;
                // 400/5xx от одного из KeenDNS-релеев не должен скрывать
                // рабочий адрес — пробуем следующий IP.
                if (res.status === 400 || res.status >= 500) {
                    lastResponse = res;
                    continue;
                }
                rciIpCache.set(original, ip);
                return res;
            } catch (e) {
                lastError = e;
            }
        }
        if (lastResponse) return lastResponse;
        throw lastError || new Error('RCI: не удалось подключиться');
    }

    function friendlyRciError(error) {
        const s = stripHtml(error && error.message ? error.message : error);
        if (/EPROTO|wrong version|ssl3_get_record|SSL routines/i.test(s)) {
            return 'на этом порту отвечает HTTP, а выбрана HTTPS — попробуйте HTTP или «Авто»';
        }
        if (/ECONNREFUSED/i.test(s)) return 'соединение отклонено — проверьте RCI-порт';
        if (/ETIMEDOUT|timeout|таймаут/i.test(s)) return 'таймаут — адрес или порт RCI недоступен из панели';
        if (/401|Unauthorized|неверный логин/i.test(s)) return 'неверный логин или пароль RCI';
        return s.slice(0, 300);
    }
    function friendlyCliError(error) {
        const s = stripHtml(error && error.message ? error.message : error);
        if (/Connection timed out|ETIMEDOUT|timeout/i.test(s)) return 'SSH-порт не отвечает (таймаут) — проверьте адрес, порт и доступность из панели';
        if (/Connection refused|ECONNREFUSED/i.test(s)) return 'SSH-порт закрыт или SSH отключён на роутере';
        if (/Permission denied|Authentication failed/i.test(s)) return 'неверный пользователь или пароль SSH';
        if (/sshpass/i.test(s)) return 'на сервере не установлен sshpass';
        return s.slice(0, 300);
    }
    function rciCandidates(router) {
        const scheme = ['auto', 'http', 'https'].includes(router.rciScheme) ? router.rciScheme : 'auto';
        const port = Number(router.rciPort) || 0;
        const list = [];
        const add = (s, p) => {
            if (!validPort(p)) return;
            if (!list.some(x => x.scheme === s && x.port === p)) list.push({ scheme: s, port: p });
        };
        if (scheme === 'auto') {
            add('http', 80);
            add('https', 443);
            if (port) { add('http', port); add('https', port); }
        } else {
            if (port) add(scheme, port);
            if (scheme === 'https' && port === 80) add('http', 80);
            if (scheme === 'http' && port === 443) add('https', 443);
            if (!port) add(scheme === 'https' ? 'https' : 'http', scheme === 'https' ? 443 : 80);
        }
        return list;
    }

    async function rciLogin(router) {
        const password = decryptSecret(router.password_enc);
        if (!password) throw new Error('Не задан пароль RCI/SSH');
        const base = {
            scheme: router.rciScheme === 'https' ? 'https' : 'http',
            host: String(router.host || '').replace(/^\[|\]$/g, ''),
            port: Number(router.rciPort) || (router.rciScheme === 'https' ? 443 : 80),
            timeout: 12000
        };
        let res = await requestRci(router, { ...base, path: '/auth' });
        let cookie = cookieFrom(res.headers);
        if (res.status === 200) return cookie;
        if (res.status !== 401) {
            const snippet = stripHtml(res.body || '').slice(0, 180);
            throw new Error(`RCI: HTTP ${res.status}${res._ip ? ' (' + res._ip + ')' : ''}${snippet ? ': ' + snippet : ''}`);
        }
        const auth = String(res.headers['www-authenticate'] || '');
        const challenge = res.headers['x-ndm-challenge'] || (auth.match(/challenge="([^"]+)"/) || [])[1] || '';
        const realm = res.headers['x-ndm-realm'] || (auth.match(/realm="([^"]+)"/) || [])[1] || '';
        if (!/x-ndw2-interactive/i.test(auth) || !challenge || !realm) {
            if (/x-ndw4-interactive/i.test(auth)) {
                throw new Error('RCI использует x-ndw4 (SCRAM/Argon2id) — выберите CLI/SSH');
            }
            throw new Error('RCI: не удалось начать авторизацию');
        }
        const md5 = crypto.createHash('md5').update(`${router.user || 'admin'}:${realm}:${password}`).digest('hex');
        const hashed = crypto.createHash('sha256').update(challenge + md5).digest('hex');
        res = await requestRci(router, {
            ...base,
            path: '/auth',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ login: router.user || 'admin', password: hashed })
        });
        if (res.status !== 200) throw new Error('RCI: неверный логин или пароль');
        return cookieFrom(res.headers) || cookie;
    }

    async function rciGet(router, resource, retry = true) {
        let session = rciSessions.get(router.id);
        if (!session || Date.now() - session.at > 4 * 60 * 1000 || !session.cookie) {
            session = { cookie: await rciLogin(router), at: Date.now() };
            rciSessions.set(router.id, session);
        }
        const res = await requestRci(router, {
            scheme: router.rciScheme === 'https' ? 'https' : 'http',
            port: Number(router.rciPort) || (router.rciScheme === 'https' ? 443 : 80),
            path: '/rci/' + resource.replace(/^\/+/, ''),
            headers: { Cookie: session.cookie, Accept: 'application/json' },
            timeout: 12000
        });
        if (res.status === 401 && retry) {
            rciSessions.delete(router.id);
            return rciGet(router, resource, false);
        }
        if (res.status !== 200) throw new Error(`RCI ${resource}: HTTP ${res.status}`);
        try { return JSON.parse(res.body); }
        catch (e) { throw new Error(`RCI ${resource}: ответ не JSON`); }
    }

    function parseVersionJson(v) {
        const data = v && typeof v === 'object' ? v : {};
        const desc = String(data.description || '');
        const model = String(data.hw_id || (desc.match(/\((KN-[^)]+)\)/i) || [])[1] || data.device || '');
        const firmware = String(data.title || data.release || '').trim();
        return {
            model,
            firmware,
            release: String(data.release || ''),
            branch: String(data.sandbox || ''),
            arch: String(data.arch || ''),
            device: String(data.device || ''),
            region: String(data.region || ''),
            profile: profileFromFirmware(firmware + ' ' + (data.release || ''))
        };
    }
    function parseSystemJson(s) {
        const data = s && typeof s === 'object' ? s : {};
        const cpu = Math.max(0, Math.min(100, Number(data.cpuload) || 0));
        let ram = 0;
        const mem = String(data.memory || '');
        const memMatch = mem.match(/(\d+)\s*\/\s*(\d+)/);
        if (memMatch) {
            const used = Number(memMatch[1]);
            const total = Number(memMatch[2]);
            if (total > 0) ram = Math.round(used / total * 100);
        } else if (Number(data.memtotal) > 0) {
            ram = Math.round((Number(data.memtotal) - Number(data.memfree)) / Number(data.memtotal) * 100);
        }
        const uptimeSeconds = Number(data.uptime) || 0;
        return { cpu, ram, uptimeSeconds, uptime: uptimeText(uptimeSeconds) };
    }
    function parseCliVersion(text) {
        const s = String(text || '');
        const firmware = (s.match(/KeeneticOS(?:\s+version)?\s*[:=]?\s*([0-9][0-9A-Za-z._-]*)/i) || [])[1]
            || (s.match(/NDMS(?:\s+version)?\s*[:=]?\s*([0-9][0-9A-Za-z._-]*)/i) || [])[1]
            || (s.match(/release\s*[:=]?\s*([0-9][0-9A-Za-z._-]*)/i) || [])[1]
            || '';
        const model = (s.match(/\b(KN-\d{3,4})\b/i) || [])[1]
            || (s.match(/(?:model|device)\s*[:=]\s*([^\r\n]+)/i) || [])[1]?.trim()
            || '';
        return { model, firmware, release: firmware, branch: '', arch: '', device: '', region: '', profile: profileFromFirmware(firmware) };
    }
    function parseCliSystem(text) {
        const s = String(text || '');
        const cpu = Number((s.match(/cpuload\s*[:=]\s*(\d+)/i) || [])[1]) || 0;
        let ram = 0;
        const mem = s.match(/memory\s*[:=]\s*(\d+)\s*\/\s*(\d+)/i);
        if (mem) {
            const used = Number(mem[1]), total = Number(mem[2]);
            if (total > 0) ram = Math.round(used / total * 100);
        }
        const uptimeSeconds = Number((s.match(/uptime\s*[:=]\s*(\d+)/i) || [])[1]) || 0;
        return { cpu, ram, uptimeSeconds, uptime: uptimeText(uptimeSeconds) };
    }
    function parseInterfacesJson(obj) {
        const root = obj && obj.interface && typeof obj.interface === 'object' ? obj.interface : obj;
        const out = [];
        if (!root || typeof root !== 'object') return out;
        for (const [name, value] of Object.entries(root)) {
            if (!value || typeof value !== 'object') continue;
            const type = String(value.type || '').trim();
            const isWg = /wireguard|amnezia/i.test(type) || /^(wireguard|amnezia|wg)/i.test(name);
            if (!isWg) continue;
            const state = String(value.state || value.status || '').toLowerCase();
            const up = value.up !== false && !/down|disabled|inactive/.test(state);
            const address = value.address || value.ip?.address || value['ipv4']?.address || value.ip?.static || '';
            const peer = value.peer || value.endpoint || value.remote || value['remote-address'] || '';
            out.push({
                name,
                type: type || (/amnezia/i.test(name) ? 'AmneziaWG' : 'WireGuard'),
                state: up ? 'up' : 'down',
                up,
                address: String(address || ''),
                peer: String(peer || ''),
                description: String(value.description || '')
            });
        }
        return out;
    }
    function parseCliInterfaces(text) {
        const lines = String(text || '').split(/\r?\n/);
        const out = [];
        let current = null;
        for (const line of lines) {
            const m = line.match(/^\s*(?:Interface\s*:?\s*)?(Wireguard\w*|Amnezia\w*|WG\w*)\b/i);
            if (m) {
                current = { name: m[1], type: /amnezia/i.test(m[1]) ? 'AmneziaWG' : 'WireGuard', state: 'unknown', up: false, address: '', peer: '', description: '' };
                out.push(current);
                continue;
            }
            if (!current) continue;
            const st = line.match(/\bstate\s*[:=]\s*(\w+)/i);
            if (st) {
                current.state = st[1].toLowerCase();
                current.up = !/down|disabled|inactive/.test(current.state);
            } else if (/\b(up|down)\b/i.test(line) && current.state === 'unknown') {
                current.state = (line.match(/\b(up|down)\b/i) || [])[1].toLowerCase();
                current.up = current.state === 'up';
            }
            const addr = line.match(/\baddress\s*[:=]\s*([0-9a-fA-F:.\/]+)/i);
            if (addr) current.address = addr[1];
            const peer = line.match(/\b(?:peer|endpoint)\s*[:=]\s*([^\s]+)/i);
            if (peer) current.peer = peer[1];
        }
        return out;
    }

    function demoStatus(router) {
        return {
            online: true,
            checkedAt: Date.now(),
            latencyMs: 24,
            transport: 'demo',
            model: 'KN-1010',
            firmware: '5.1',
            release: '5.01.A.0.0-0',
            branch: 'stable',
            arch: 'mips',
            device: 'Giga',
            region: 'RU',
            profile: '5.1',
            cpu: 12,
            ram: 38,
            uptimeSeconds: 86400 * 3 + 3600 * 4,
            uptime: '3д 4ч 0м',
            tunnels: [
                { name: 'Wireguard0', type: 'WireGuard', state: 'up', up: true, address: '10.9.0.2', peer: '203.0.113.20:3478', description: 'Steklm' },
                { name: 'Wireguard1', type: 'WireGuard', state: 'down', up: false, address: '10.8.1.40', peer: '203.0.113.21:3478', description: 'VD-AVG3-39' }
            ],
            error: ''
        };
    }

    function cliArgs(router, command) {
        const args = [
            '-T',
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'ConnectTimeout=12',
            '-o', 'ServerAliveInterval=15',
            '-o', 'LogLevel=ERROR',
            '-p', String(Number(router.port) || 22)
        ];
        if (router.authType === 'key' && router.key_enc) {
            const keyFile = path.join(DATA_DIR, '.keenetic-key-' + router.id);
            try {
                fs.writeFileSync(keyFile, decryptSecret(router.key_enc), { mode: 0o600 });
                args.push('-i', keyFile);
            } catch (e) { /* ignore */ }
        }
        args.push(`${router.user || 'admin'}@${router.host}`, command);
        return args;
    }
    function cliRun(router, command) {
        const password = decryptSecret(router.password_enc);
        const args = cliArgs(router, command);
        const useSshpass = router.authType !== 'key' && password;
        const cmd = useSshpass ? 'sshpass' : 'ssh';
        const fullArgs = useSshpass ? ['-p', password, 'ssh', ...args] : args;
        return new Promise((resolve, reject) => {
            execFile(cmd, fullArgs, { timeout: 25000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (router.authType === 'key') {
                    try { fs.rmSync(path.join(DATA_DIR, '.keenetic-key-' + router.id), { force: true }); } catch (e) { /* ignore */ }
                }
                const out = String(stdout || '') + String(stderr || '');
                if (error) return reject(new Error(stripHtml(out) || error.message));
                resolve(out);
            });
        });
    }

    async function inspectRci(router) {
        let lastError = null;
        for (const candidate of rciCandidates(router)) {
            const r = { ...router, rciScheme: candidate.scheme, rciPort: candidate.port };
            try {
                rciSessions.delete(router.id);
                const version = parseVersionJson(await rciGet(r, 'show/version'));
                const system = parseSystemJson(await rciGet(r, 'show/system'));
                let tunnels = [];
                try { tunnels = parseInterfacesJson(await rciGet(r, 'show/interface')); }
                catch (e) { tunnels = []; }
                return {
                    ...version, ...system, tunnels, transport: 'rci',
                    rciScheme: candidate.scheme, rciPort: candidate.port
                };
            } catch (e) {
                lastError = e;
                if (/x-ndw4|SCRAM|Argon2|неверный логин|401|Unauthorized/i.test(String(e.message || e))) break;
            }
        }
        throw new Error(privateHostHint(router) + friendlyRciError(lastError));
    }
    async function inspectCli(router) {
        try {
            const versionText = await cliRun(router, 'show version');
            const systemText = await cliRun(router, 'show system');
            const version = parseCliVersion(versionText);
            const system = parseCliSystem(systemText);
            let tunnels = [];
            try { tunnels = parseCliInterfaces(await cliRun(router, 'show interface')); }
            catch (e) { tunnels = []; }
            return { ...version, ...system, tunnels, transport: 'cli', rawVersion: versionText.slice(0, 2000) };
        } catch (e) {
            throw new Error(privateHostHint(router) + friendlyCliError(e));
        }
    }

    async function refreshRouter(id, reason = '') {
        const router = routerById(id);
        if (!router) throw new Error('Роутер не найден');
        if (refreshing.has(router.id)) return sanitize(router);
        refreshing.add(router.id);
        const started = Date.now();
        const prev = router.status || {};
        let status;
        try {
            if (router.transport === 'demo') {
                status = demoStatus(router);
            } else if (router.transport === 'rci') {
                status = { ...(await inspectRci(router)), online: true };
            } else if (router.transport === 'cli') {
                status = { ...(await inspectCli(router)), online: true };
            } else {
                try {
                    status = { ...(await inspectRci(router)), online: true };
                } catch (rciError) {
                    try {
                        status = { ...(await inspectCli(router)), online: true };
                    } catch (cliError) {
                        throw new Error(`RCI: ${rciError.message}. CLI: ${cliError.message}`);
                    }
                }
            }
            status.latencyMs = Math.max(1, Date.now() - started);
            status.checkedAt = Date.now();
            status.error = '';
        } catch (e) {
            status = {
                online: false,
                checkedAt: Date.now(),
                latencyMs: Math.max(1, Date.now() - started),
                transport: router.transport,
                error: String(e.message || e).slice(0, 500),
                tunnels: []
            };
        }
        try {
            const list = readRouters();
            const idx = list.findIndex(r => r.id === router.id);
            if (idx >= 0) {
                list[idx].status = status;
                list[idx].updatedAt = Date.now();
                // Запоминаем реально рабочий RCI endpoint, чтобы не гадать
                // при следующей проверке (например, HTTP вместо HTTPS).
                if (status.online && status.rciScheme && status.rciPort) {
                    list[idx].rciScheme = status.rciScheme;
                    list[idx].rciPort = status.rciPort;
                }
                writeRouters(list);
            }
        } catch (e) { /* ignore */ }
        if (prev.online !== status.online || (prev.error || '') !== (status.error || '')) {
            addEvent(router.id, status.online ? 'ok' : 'error',
                status.online ? `${router.name}: связь восстановлена` : `${router.name}: ${status.error || 'нет связи'}`);
        }
        if (reason) addEvent(router.id, 'info', `${router.name}: ${reason}`);
        refreshing.delete(router.id);
        return sanitize(routerById(router.id));
    }

    function overview() {
        const routers = readRouters().map(sanitize);
        const online = routers.filter(r => r.status && r.status.online).length;
        const tunnels = routers.flatMap(r => (r.status && r.status.tunnels) || []);
        return {
            total: routers.length,
            online,
            offline: routers.length - online,
            tunnelsUp: tunnels.filter(t => t.up).length,
            tunnelsDown: tunnels.filter(t => !t.up).length,
            routers,
            events: readEvents().slice(0, 12)
        };
    }

    function createRouter(body) {
        const b = body || {};
        const name = String(b.name || '').trim().slice(0, 64);
        const host = String(b.host || '').trim();
        const transport = ['auto', 'rci', 'cli', 'demo'].includes(String(b.transport)) ? String(b.transport) : 'auto';
        const profile = ['auto', '5.1', '5.0', '4.3', '4.1', '4.0', '3.1', 'unknown'].includes(String(b.profile)) ? String(b.profile) : 'auto';
        if (!name) throw new Error('Укажите имя роутера');
        if (!validHost(host)) throw new Error('Некорректный адрес роутера');
        if (!validPort(b.port || 22)) throw new Error('Некорректный SSH-порт');
        if (transport === 'demo' && !(TEST_MODE || DEMO_MODE)) throw new Error('Демо-транспорт доступен только в тестовом режиме');
        const authType = b.authType === 'key' ? 'key' : 'password';
        if (authType === 'password' && !String(b.password || '').trim()) throw new Error('Укажите пароль');
        const router = {
            id: crypto.randomBytes(6).toString('hex'),
            name,
            host,
            port: Number(b.port) || 22,
            user: String(b.user || 'admin').trim().slice(0, 64) || 'admin',
            authType,
            password_enc: authType === 'password' ? encryptSecret(b.password) : '',
            key_enc: authType === 'key' ? encryptSecret(b.key || '') : '',
            transport,
            profile,
            rciScheme: ['auto', 'http', 'https'].includes(String(b.rciScheme)) ? String(b.rciScheme) : 'auto',
            rciPort: Number(b.rciPort) || 0,
            enabled: b.enabled !== false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            status: { online: false, error: 'Ещё не проверялся' }
        };
        if (router.rciPort && !validPort(router.rciPort)) throw new Error('Некорректный RCI-порт');
        const list = readRouters();
        list.push(router);
        writeRouters(list);
        addEvent(router.id, 'info', `${router.name}: роутер добавлен`);
        if (auditLog) { /* auditLog требует req; вызывается в route */ }
        return sanitize(router);
    }

    function updateRouter(id, body) {
        const list = readRouters();
        const idx = list.findIndex(r => r.id === String(id || ''));
        if (idx < 0) throw new Error('Роутер не найден');
        const r = list[idx];
        const b = body || {};
        if (b.name !== undefined) {
            const name = String(b.name || '').trim().slice(0, 64);
            if (!name) throw new Error('Укажите имя роутера');
            r.name = name;
        }
        if (b.host !== undefined) {
            const host = String(b.host || '').trim();
            if (!validHost(host)) throw new Error('Некорректный адрес роутера');
            r.host = host;
        }
        if (b.port !== undefined) {
            if (!validPort(b.port)) throw new Error('Некорректный SSH-порт');
            r.port = Number(b.port);
        }
        if (b.user !== undefined) r.user = String(b.user || 'admin').trim().slice(0, 64) || 'admin';
        if (b.transport !== undefined && ['auto', 'rci', 'cli', 'demo'].includes(String(b.transport))) {
            if (b.transport === 'demo' && !(TEST_MODE || DEMO_MODE)) throw new Error('Демо-транспорт доступен только в тестовом режиме');
            r.transport = String(b.transport);
        }
        if (b.profile !== undefined && ['auto', '5.1', '5.0', '4.3', '4.1', '4.0', '3.1', 'unknown'].includes(String(b.profile))) r.profile = String(b.profile);
        if (b.rciScheme !== undefined) r.rciScheme = ['auto', 'http', 'https'].includes(String(b.rciScheme)) ? String(b.rciScheme) : 'auto';
        if (b.rciPort !== undefined) {
            const p = Number(b.rciPort) || 0;
            if (p && !validPort(p)) throw new Error('Некорректный RCI-порт');
            r.rciPort = p;
        }
        if (b.enabled !== undefined) r.enabled = b.enabled !== false;
        if (b.password) {
            r.authType = b.authType === 'key' ? 'key' : 'password';
            r.password_enc = encryptSecret(b.password);
        } else if (b.authType === 'key' && b.key) {
            r.authType = 'key';
            r.key_enc = encryptSecret(b.key);
        }
        r.updatedAt = Date.now();
        writeRouters(list);
        rciSessions.delete(r.id);
        addEvent(r.id, 'info', `${r.name}: настройки обновлены`);
        return sanitize(r);
    }

    function removeRouter(id) {
        const list = readRouters();
        const router = list.find(r => r.id === String(id || ''));
        if (!router) throw new Error('Роутер не найден');
        writeRouters(list.filter(r => r.id !== router.id));
        rciSessions.delete(router.id);
        addEvent(router.id, 'warn', `${router.name}: удалён из панели`);
        return { success: true };
    }

    function registerRoutes(app) {
        app.get('/api/keenetic/overview', checkAuth, (req, res) => {
            try { res.json(overview()); }
            catch (e) { res.status(500).json({ error: 'Не удалось получить сводку Keenetic' }); }
        });
        app.get('/api/keenetic/routers', checkAuth, (req, res) => {
            try {
                const routers = readRouters().map(sanitize);
                res.json({ routers, events: readEvents().slice(0, 12) });
            } catch (e) { res.status(500).json({ error: 'Не удалось прочитать роутеры' }); }
        });
        app.get('/api/keenetic/routers/:id', checkAuth, (req, res) => {
            const r = sanitize(routerById(req.params.id));
            if (!r) return res.status(404).json({ error: 'Роутер не найден' });
            const events = readEvents().filter(e => e.routerId === r.id).slice(0, 100);
            res.json({ router: r, events });
        });
        app.post('/api/keenetic/routers', checkAuth, requireAdmin, (req, res) => {
            try {
                const router = createRouter(req.body);
                if (auditLog) auditLog(req, `Keenetic: добавлен роутер ${router.name} (${router.host})`);
                res.status(201).json({ success: true, router });
            } catch (e) { res.status(400).json({ error: e.message }); }
        });
        app.put('/api/keenetic/routers/:id', checkAuth, requireAdmin, (req, res) => {
            try {
                const router = updateRouter(req.params.id, req.body);
                if (auditLog) auditLog(req, `Keenetic: изменён роутер ${router.name} (${router.host})`);
                res.json({ success: true, router });
            } catch (e) { res.status(400).json({ error: e.message }); }
        });
        app.delete('/api/keenetic/routers/:id', checkAuth, requireAdmin, (req, res) => {
            try {
                const r = routerById(req.params.id);
                removeRouter(req.params.id);
                if (auditLog && r) auditLog(req, `Keenetic: удалён роутер ${r.name}`);
                res.json({ success: true });
            } catch (e) { res.status(400).json({ error: e.message }); }
        });
        app.post('/api/keenetic/routers/:id/test', checkAuth, requireAdmin, async (req, res) => {
            try {
                const r = await refreshRouter(req.params.id, 'проверка связи');
                if (auditLog) auditLog(req, `Keenetic: проверка ${r.name} — ${r.status && r.status.online ? 'online' : 'offline'}`);
                res.json({ success: true, router: r });
            } catch (e) { res.status(400).json({ error: e.message }); }
        });
        app.post('/api/keenetic/routers/:id/refresh', checkAuth, async (req, res) => {
            try { res.json({ success: true, router: await refreshRouter(req.params.id) }); }
            catch (e) { res.status(400).json({ error: e.message }); }
        });
        app.get('/api/keenetic/events', checkAuth, (req, res) => {
            const routerId = String(req.query.router || '');
            const limit = Math.max(1, Math.min(300, Number(req.query.limit) || 100));
            const events = readEvents().filter(e => !routerId || e.routerId === routerId).slice(0, limit);
            res.json({ events });
        });
    }

    function start() {
        if (pollTimer || TEST_MODE) return;
        let polling = false;
        pollTimer = setInterval(async () => {
            if (polling) return;
            polling = true;
            try {
                const routers = readRouters().filter(r => r.enabled !== false);
                for (const r of routers) {
                    if (refreshing.has(r.id)) continue;
                    try { await refreshRouter(r.id); } catch (e) { /* ignore */ }
                }
            } finally {
                polling = false;
            }
        }, POLL_MS);
        if (pollTimer.unref) pollTimer.unref();
    }

    return {
        registerRoutes,
        start,
        stop: () => { if (pollTimer) clearInterval(pollTimer); pollTimer = null; },
        refreshRouter,
        overview,
        createRouter,
        updateRouter,
        removeRouter,
        _test: { parseVersionJson, parseSystemJson, parseCliVersion, parseCliSystem, parseInterfacesJson, parseCliInterfaces, profileFromFirmware }
    };
}

module.exports = { createKeenetic };
