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
    const POLL_MS = 60000;
    const DEFAULT_CHECK_URL = 'https://www.youtube.com/generate_204';
    const rciSessions = new Map();
    const rciIpCache = new Map();
    const refreshing = new Set();
    let pollTimer = null;
    let healthTimer = null;
    let healthRunning = false;

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
            tunnelOrder: Array.isArray(router.tunnelOrder) ? router.tunnelOrder : [],
            autoFailover: !!router.autoFailover,
            checkUrl: router.checkUrl || DEFAULT_CHECK_URL,
            checkIntervalMin: Math.max(1, Math.min(60, Number(router.checkIntervalMin) || 5)),
            health: router.health || null,
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
        if (!session || !session.cookie) {
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
        // Сессия продлевается активностью: не перелогиниваемся на каждом опросе.
        session.at = Date.now();
        try { return JSON.parse(res.body); }
        catch (e) { throw new Error(`RCI ${resource}: ответ не JSON`); }
    }

    function findRciError(node, depth = 0) {
        if (!node || typeof node !== 'object' || depth > 6) return null;
        if (Array.isArray(node)) {
            for (const item of node) {
                const found = findRciError(item, depth + 1);
                if (found) return found;
            }
            return null;
        }
        if (Array.isArray(node.status)) {
            const err = node.status.find(x => x && String(x.status).toLowerCase() === 'error');
            if (err) return err;
        }
        for (const value of Object.values(node)) {
            if (value && typeof value === 'object') {
                const found = findRciError(value, depth + 1);
                if (found) return found;
            }
        }
        return null;
    }

    async function rciPost(router, resource, body, retry = true) {
        let session = rciSessions.get(router.id);
        if (!session || !session.cookie) {
            session = { cookie: await rciLogin(router), at: Date.now() };
            rciSessions.set(router.id, session);
        }
        const path = '/rci/' + String(resource || '').replace(/^\/+/, '');
        const res = await requestRci(router, {
            method: 'POST',
            scheme: router.rciScheme === 'https' ? 'https' : 'http',
            port: Number(router.rciPort) || (router.rciScheme === 'https' ? 443 : 80),
            path,
            headers: {
                Cookie: session.cookie,
                Accept: 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body || {}),
            timeout: 12000
        });
        if (res.status === 401 && retry) {
            rciSessions.delete(router.id);
            return rciPost(router, resource, body, false);
        }
        if (res.status !== 200) {
            const snippet = stripHtml(res.body || '').slice(0, 180);
            throw new Error(`RCI ${resource || '/'}: HTTP ${res.status}${snippet ? ': ' + snippet : ''}`);
        }
        let data = {};
        try { data = JSON.parse(res.body); } catch (e) { data = {}; }
        const err = findRciError(data);
        if (err) throw new Error(String(err.message || err.ident || 'RCI вернул ошибку'));
        session.at = Date.now();
        return data;
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
            const wg = value.wireguard && typeof value.wireguard === 'object' ? value.wireguard : {};
            const peerObj = Array.isArray(wg.peer) ? (wg.peer[0] || {}) : (wg.peer && typeof wg.peer === 'object' ? wg.peer : {});
            const remoteAddr = peerObj['remote-endpoint-address'] || peerObj.remote || '';
            const remotePort = peerObj['remote-port'] || '';
            const peer = value.peer || value.endpoint || value.remote || (remoteAddr ? `${remoteAddr}${remotePort ? ':' + remotePort : ''}` : '');
            const address = value.address || value.ip?.address || value['ipv4']?.address || value.ip?.static || '';
            // Keenetic RCI отдаёт last-handshake как «сколько секунд назад»,
            // но некоторые версии — как unix-время. Приводим к timestamp.
            const hsRaw = Number(peerObj['last-handshake'] || value['last-handshake'] || 0) || 0;
            const lastHandshake = hsRaw > 1e9 ? hsRaw : (hsRaw > 0 ? Math.floor(Date.now() / 1000) - hsRaw : 0);
            const hasPeer = Array.isArray(wg.peer)
                ? wg.peer.length > 0
                : !!(wg.peer && typeof wg.peer === 'object' && Object.keys(wg.peer).length);
            out.push({
                name,
                type: type || (/amnezia/i.test(name) ? 'AmneziaWG' : 'WireGuard'),
                state: up ? 'up' : 'down',
                up,
                link: String(value.link || ''),
                empty: !hasPeer,
                address: String(address || ''),
                peer: String(peer || ''),
                description: String(value.description || ''),
                lastHandshake,
                handshakeAgo: hsRaw > 1e9 ? 0 : hsRaw,
                rx: Number(peerObj.rxbytes || value.rxbytes || 0) || 0,
                tx: Number(peerObj.txbytes || value.txbytes || 0) || 0,
                online: hasPeer ? (peerObj.online === undefined ? up : !!peerObj.online) : false,
                publicKey: String(peerObj['public-key'] || '')
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
                { name: 'Wireguard0', type: 'WireGuard', state: 'up', up: true, address: '10.9.0.2', peer: '203.0.113.20:3478', description: 'Steklm', lastHandshake: Math.floor(Date.now() / 1000) - 64, rx: 244.7 * 1024 * 1024, tx: 839.9 * 1024 * 1024, online: true },
                { name: 'Wireguard1', type: 'WireGuard', state: 'down', up: false, address: '10.8.1.40', peer: '203.0.113.21:3478', description: 'VD-AVG3-39', lastHandshake: Math.floor(Date.now() / 1000) - 120, rx: 26.3 * 1024 * 1024, tx: 28.1 * 1024 * 1024, online: false }
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
        // sshpass -e читает пароль из SSHPASS: аргумент -p виден в ps aux.
        const fullArgs = useSshpass ? ['-e', 'ssh', ...args] : args;
        const execOpts = { timeout: 25000, maxBuffer: 2 * 1024 * 1024 };
        if (useSshpass) execOpts.env = { ...process.env, SSHPASS: password };
        return new Promise((resolve, reject) => {
            execFile(cmd, fullArgs, execOpts, (error, stdout, stderr) => {
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
                const version = parseVersionJson(await rciGet(r, 'show/version'));
                const system = parseSystemJson(await rciGet(r, 'show/system'));
                let tunnels = [];
                try { tunnels = parseInterfacesJson(await rciGet(r, 'show/interface')); }
                catch (e) { tunnels = []; }
                // Основной туннель — тот, что прописан в активных правилах DNS.
                let routed = null;
                try {
                    const routes = await rciGet(r, 'show/sc/dns-proxy/route');
                    if (Array.isArray(routes)) {
                        routed = new Set(routes
                            .filter(x => x && x.interface && x.disable !== true)
                            .map(x => x.interface));
                    }
                } catch (e) { routed = null; }
                if (routed) tunnels = tunnels.map(t => ({ ...t, routed: routed.has(t.name) }));
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

    function validTunnelName(name) {
        return /^[A-Za-z0-9_.-]{1,32}$/.test(String(name || ''))
            && /^(wireguard|amnezia|wg)/i.test(String(name || ''));
    }

    async function waitTunnelState(router, name, up, attempts = 5) {
        for (let i = 0; i < attempts; i++) {
            await new Promise(resolve => setTimeout(resolve, 700));
            try {
                const tunnels = parseInterfacesJson(await rciGet(router, 'show/interface'));
                const t = tunnels.find(x => x.name === name);
                if (t && !!t.up === !!up) return true;
            } catch (e) { /* пробуем ещё */ }
        }
        return false;
    }

    async function setTunnelRci(router, name, up) {
        // Используем только адресный POST к существующему интерфейсу.
        // Вложенный POST {"interface":{name:{...}}} на Keenetic создаёт
        // новый интерфейс, если имени нет, — так делать нельзя.
        try {
            await rciPost(router, 'interface/' + encodeURIComponent(name), { up: !!up });
            if (await waitTunnelState(router, name, up)) return;
            throw new Error('роутер принял команду, но состояние туннеля не изменилось');
        } catch (e) {
            throw new Error(friendlyRciError(e));
        }
    }

    async function applyTunnelAction(id, name, action) {
        const router = routerById(id);
        if (!router) throw new Error('Роутер не найден');
        if (!validTunnelName(name)) throw new Error('Некорректное имя туннеля');
        if (!['up', 'down', 'restart'].includes(action)) throw new Error('Неизвестное действие');
        if (router.transport === 'demo') throw new Error('В демо-режиме управление туннелями недоступно');
        const viaCli = router.transport === 'cli'
            || (router.transport === 'auto' && router.status && router.status.transport === 'cli');
        // Берём рабочий RCI endpoint из последнего успешного опроса.
        const target = {
            ...router,
            rciScheme: (router.status && router.status.rciScheme) || router.rciScheme,
            rciPort: (router.status && router.status.rciPort) || router.rciPort
        };
        // Живая проверка: действие разрешаем только для туннеля,
        // который реально существует на роутере прямо сейчас.
        let liveTunnels = [];
        try {
            liveTunnels = viaCli
                ? parseCliInterfaces(await cliRun(target, 'show interface'))
                : parseInterfacesJson(await rciGet(target, 'show/interface'));
        } catch (e) {
            throw new Error('Не удалось прочитать туннели: ' + (e.message || e));
        }
        if (!liveTunnels.some(t => t.name === name)) throw new Error('Туннель не найден на роутере');
        const label = action === 'up' ? 'включён' : action === 'down' ? 'выключен' : 'перезапущен';
        try {
            if (viaCli) {
                if (action === 'down' || action === 'restart') await cliRun(target, `interface ${name} down`);
                if (action === 'restart') await new Promise(resolve => setTimeout(resolve, 800));
                if (action === 'up' || action === 'restart') await cliRun(target, `interface ${name} up`);
            } else if (action === 'restart') {
                await setTunnelRci(target, name, false);
                await new Promise(resolve => setTimeout(resolve, 1200));
                await setTunnelRci(target, name, true);
            } else {
                await setTunnelRci(target, name, action === 'up');
            }
        } catch (e) {
            throw new Error(e.message || 'Не удалось изменить туннель');
        }
        addEvent(router.id, action === 'down' ? 'warn' : 'ok', `${router.name}: туннель ${name} ${label}`);
        return refreshRouter(router.id, '', { force: true });
    }

    async function importWireguard(id, data, filename, defaultRoute) {
        const router = routerById(id);
        if (!router) throw new Error('Роутер не найден');
        if (router.transport === 'demo') throw new Error('В демо-режиме импорт недоступен');
        if (!/\.conf$/i.test(String(filename || ''))) throw new Error('Нужен файл с расширением .conf');
        const b64 = String(data || '').replace(/\s+/g, '');
        if (!b64) throw new Error('Файл пустой');
        if (b64.length > 600000) throw new Error('Файл слишком большой (максимум ~450 КБ)');
        if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw new Error('Не удалось прочитать файл');
        const target = {
            ...router,
            rciScheme: (router.status && router.status.rciScheme) || router.rciScheme,
            rciPort: (router.status && router.status.rciPort) || router.rciPort
        };
        const before = parseInterfacesJson(await rciGet(target, 'show/interface')).map(t => t.name);
        let res;
        try {
            res = await rciPost(target, 'interface/wireguard/import', {
                import: b64,
                name: '',
                filename: String(filename).slice(0, 120)
            });
        } catch (e) {
            throw new Error('Импорт не удался: ' + (e.message || e));
        }
        const after = parseInterfacesJson(await rciGet(target, 'show/interface')).map(t => t.name);
        const created = String((res && (res.created || (res.interface && res.interface.created))) || after.find(n => !before.includes(n)) || '');
        const intersects = String((res && res.intersects) || '');
        let warning = '';
        if (created) {
            try {
                await rciPost(target, 'interface/' + encodeURIComponent(created), { up: true });
            } catch (e) { /* интерфейс мог уже быть включён */ }
        }
        if (defaultRoute && created) {
            try {
                await rciPost(target, 'interface/' + encodeURIComponent(created), { ip: { global: { auto: true } } });
            } catch (e) {
                warning = 'Туннель создан, но включить выход в интернет не удалось: ' + (e.message || e);
            }
        }
        try { await rciPost(target, 'system/configuration/save', {}); } catch (e) { /* конфиг сохранится сам */ }
        addEvent(router.id, 'ok', `${router.name}: импортирован туннель ${created || filename}${defaultRoute ? ' — выход в интернет' : ''}`);
        return {
            created,
            intersects,
            warning,
            router: await refreshRouter(router.id, '', { force: true })
        };
    }

    function rciTarget(router) {
        return {
            ...router,
            rciScheme: (router.status && router.status.rciScheme) || router.rciScheme,
            rciPort: (router.status && router.status.rciPort) || router.rciPort
        };
    }

    function isIpv4Entry(value) {
        return /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(String(value || ''));
    }
    function isIpv6Entry(value) {
        return String(value || '').includes(':') && /^[0-9a-fA-F:]+(\/\d{1,3})?$/.test(String(value || ''));
    }

    async function readDnsState(id) {
        const router = routerById(id);
        if (!router) throw new Error('Роутер не найден');
        if (router.transport === 'demo') throw new Error('В демо-режиме списки недоступны');
        const target = rciTarget(router);
        const [groupsRaw, routesRaw, ifacesRaw] = await Promise.all([
            rciGet(target, 'show/sc/object-group/fqdn'),
            rciGet(target, 'show/sc/dns-proxy/route'),
            rciGet(target, 'show/interface')
        ]);
        const groups = Object.entries(groupsRaw && typeof groupsRaw === 'object' ? groupsRaw : {})
            .filter(([, g]) => g && typeof g === 'object')
            .map(([name, g]) => {
                const entries = (Array.isArray(g.include) ? g.include : [])
                    .map(x => String((x && x.address) || '')).filter(Boolean);
                const ip4 = entries.filter(isIpv4Entry).length;
                const ip6 = entries.filter(isIpv6Entry).length;
                return {
                    name,
                    description: String(g.description || name),
                    entries,
                    domains: Math.max(0, entries.length - ip4 - ip6),
                    ip4,
                    ip6
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
        const routes = (Array.isArray(routesRaw) ? routesRaw : [])
            .filter(r => r && r.group)
            .map(r => ({
                index: String(r.index || ''),
                group: String(r.group),
                interface: String(r.interface || ''),
                enabled: r.disable !== true,
                auto: !!r.auto,
                reject: !!r.reject,
                gateway: String(r.gateway || '')
            }));
        const interfaces = Object.entries(ifacesRaw && typeof ifacesRaw === 'object' ? ifacesRaw : {})
            .filter(([name, value]) => {
                if (!/^[A-Za-z]/.test(name) || name.includes('/')) return false;
                if (/^wireguard/i.test(name)) {
                    const wg = (value && value.wireguard) || {};
                    const peers = Array.isArray(wg.peer)
                        ? wg.peer.length
                        : (wg.peer && typeof wg.peer === 'object' ? Object.keys(wg.peer).length : 0);
                    if (!value.address && !peers) return false;
                }
                return true;
            })
            .map(([name, value]) => ({
                name,
                description: String((value && value.description) || '').trim()
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
        return { groups, routes, interfaces };
    }

    function cleanDnsEntries(list) {
        const out = [];
        const seen = new Set();
        for (const raw of (Array.isArray(list) ? list : [])) {
            const value = String(raw || '').trim().toLowerCase();
            if (!value) continue;
            if (value.length > 253) throw new Error('Слишком длинная запись: ' + value.slice(0, 40));
            if (!/^[a-z0-9*_.:/-]+$/i.test(value)) throw new Error('Недопустимая запись: ' + value.slice(0, 60));
            if (!seen.has(value)) { seen.add(value); out.push(value); }
            if (out.length > 5000) throw new Error('Слишком много записей (максимум 5000)');
        }
        return out;
    }

    async function saveDnsGroup(id, body) {
        const router = routerById(id);
        if (!router) throw new Error('Роутер не найден');
        const target = rciTarget(router);
        const state = await readDnsState(id);
        const rawName = String((body && body.name) || '').trim();
        let name;
        if (rawName) {
            if (!/^domain-list\d{1,3}$/.test(rawName)) throw new Error('Имя списка должно быть domain-listN');
            name = rawName;
        } else {
            let max = -1;
            for (const g of state.groups) {
                const m = /^domain-list(\d+)$/.exec(g.name);
                if (m) max = Math.max(max, Number(m[1]));
            }
            name = 'domain-list' + (max + 1);
        }
        const entries = cleanDnsEntries(body && body.entries);
        if (!entries.length) throw new Error('Добавьте хотя бы один домен или IP');
        const description = String((body && body.description) || '').trim().slice(0, 64)
            || (state.groups.find(g => g.name === name) || {}).description || name;
        const exists = state.groups.some(g => g.name === name);
        if (exists) {
            await rciPost(target, 'object-group/fqdn', { [name]: { include: { no: true } } });
        }
        await rciPost(target, 'object-group/fqdn', {
            [name]: { description, include: entries.map(address => ({ address })) }
        });
        try { await rciPost(target, 'system/configuration/save', {}); } catch (e) { /* ignore */ }
        addEvent(router.id, 'ok', `${router.name}: список ${description} сохранён (${entries.length})`);
        return { ok: true, ...(await readDnsState(id)) };
    }

    async function deleteDnsGroup(id, name) {
        const router = routerById(id);
        if (!router) throw new Error('Роутер не найден');
        const groupName = String(name || '').trim();
        if (!/^domain-list\d{1,3}$/.test(groupName)) throw new Error('Некорректное имя списка');
        const state = await readDnsState(id);
        if (!state.groups.some(g => g.name === groupName)) throw new Error('Список не найден');
        if (state.routes.some(r => r.group === groupName)) {
            throw new Error('Список используется в правилах маршрутизации — сначала удалите правила');
        }
        const target = rciTarget(router);
        await rciPost(target, 'object-group/fqdn', { [groupName]: { no: true } });
        try { await rciPost(target, 'system/configuration/save', {}); } catch (e) { /* ignore */ }
        addEvent(router.id, 'warn', `${router.name}: удалён список ${groupName}`);
        return { ok: true, ...(await readDnsState(id)) };
    }

    async function saveDnsRoute(id, body) {
        const router = routerById(id);
        if (!router) throw new Error('Роутер не найден');
        const state = await readDnsState(id);
        const group = String((body && body.group) || '').trim();
        const iface = String((body && body.interface) || '').trim();
        if (!state.groups.some(g => g.name === group)) throw new Error('Выберите список доменных имён');
        if (!state.interfaces.some(i => i.name === iface)) throw new Error('Выберите интерфейс');
        const payload = {
            group,
            gateway: String((body && body.gateway) || ''),
            auto: !!(body && body.auto),
            reject: !!(body && body.reject)
        };
        if (iface) payload.interface = iface;
        const target = rciTarget(router);
        if (body && body.index) {
            payload.index = String(body.index);
            await rciPost(target, 'dns-proxy/route', payload);
            await rciPost(target, 'dns-proxy/route', {
                disable: { index: payload.index, no: body.enabled !== false }
            });
        } else {
            payload.disable = body && body.enabled === false;
            await rciPost(target, 'dns-proxy/route', payload);
        }
        try { await rciPost(target, 'system/configuration/save', {}); } catch (e) { /* ignore */ }
        addEvent(router.id, 'ok', `${router.name}: правило ${group} → ${iface} сохранено`);
        return { ok: true, ...(await readDnsState(id)) };
    }

    async function deleteDnsRoute(id, index) {
        const router = routerById(id);
        if (!router) throw new Error('Роутер не найден');
        const idx = String(index || '').trim();
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(idx)) throw new Error('Некорректный идентификатор правила');
        const state = await readDnsState(id);
        const route = state.routes.find(r => r.index === idx);
        if (!route) throw new Error('Правило не найдено');
        const target = rciTarget(router);
        await rciPost(target, 'dns-proxy/route', { index: idx, no: true });
        try { await rciPost(target, 'system/configuration/save', {}); } catch (e) { /* ignore */ }
        addEvent(router.id, 'warn', `${router.name}: удалено правило ${route.group} → ${route.interface}`);
        return { ok: true, ...(await readDnsState(id)) };
    }

    async function setDnsRouteEnabled(id, index, enabled) {
        const router = routerById(id);
        if (!router) throw new Error('Роутер не найден');
        const idx = String(index || '').trim();
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(idx)) throw new Error('Некорректный идентификатор правила');
        const state = await readDnsState(id);
        const route = state.routes.find(r => r.index === idx);
        if (!route) throw new Error('Правило не найдено');
        const target = rciTarget(router);
        await rciPost(target, 'dns-proxy/route', {
            disable: { index: idx, no: !!enabled }
        });
        try { await rciPost(target, 'system/configuration/save', {}); } catch (e) { /* ignore */ }
        addEvent(router.id, 'info', `${router.name}: правило ${route.group} → ${route.interface} ${enabled ? 'включено' : 'выключено'}`);
        return { ok: true, ...(await readDnsState(id)) };
    }

    async function failoverDns(id, backupName) {
        const router = routerById(id);
        if (!router) throw new Error('Роутер не найден');
        if (router.transport === 'demo') throw new Error('В демо-режиме переключение недоступно');
        const target = rciTarget(router);
        const [ifacesRaw, routesRaw] = await Promise.all([
            rciGet(target, 'show/interface'),
            rciGet(target, 'show/sc/dns-proxy/route')
        ]);
        const tunnels = parseInterfacesJson(ifacesRaw);
        const backup = tunnels.find(t => t.name === String(backupName || '').trim());
        if (!backup) throw new Error('Резервный туннель не найден');
        if (!backup.up || backup.link === 'down' || backup.empty) throw new Error('Резервный туннель не подключён');
        const tunnelNames = new Set(tunnels.map(t => t.name));
        const routes = Array.isArray(routesRaw) ? routesRaw : [];
        let updated = 0;
        for (const rt of routes) {
            if (!rt || !rt.index || rt.disable === true) continue;
            if (!tunnelNames.has(rt.interface)) continue;
            if (rt.interface === backup.name) continue;
            await rciPost(target, 'dns-proxy/route', {
                index: rt.index,
                group: rt.group,
                interface: backup.name,
                gateway: rt.gateway || '',
                auto: !!rt.auto,
                reject: !!rt.reject
            });
            updated++;
        }
        if (!updated) throw new Error('Нет активных маршрутов через туннели');
        try { await rciPost(target, 'system/configuration/save', {}); } catch (e) { /* ignore */ }
        // После переключения резерв становится основным в приоритетах.
        const list = readRouters();
        const idx = list.findIndex(r => r.id === router.id);
        if (idx >= 0) {
            const cur = normalizeTunnelOrder(list[idx], list[idx].tunnelOrder);
            list[idx].tunnelOrder = [backup.name, ...cur.filter(n => n !== backup.name)];
            list[idx].updatedAt = Date.now();
            writeRouters(list);
        }
        addEvent(router.id, 'warn', `${router.name}: маршруты переведены на ${backup.name} (${updated})`);
        return {
            backup: backup.name,
            backupLabel: backup.description || backup.name,
            updated,
            router: await refreshRouter(router.id, '', { force: true })
        };
    }

    async function exportDnsState(id) {
        const router = routerById(id);
        if (!router) throw new Error('Роутер не найден');
        const state = await readDnsState(id);
        return {
            version: 1,
            exportedAt: new Date().toISOString(),
            router: router.name,
            lists: state.groups.map(g => ({
                name: g.name,
                description: g.description,
                entries: g.entries
            })),
            rules: state.routes.map(r => ({
                group: r.group,
                interface: r.interface,
                auto: r.auto,
                reject: r.reject,
                enabled: r.enabled,
                gateway: r.gateway
            }))
        };
    }

    async function importDnsState(id, text, replaceRules) {
        const router = routerById(id);
        if (!router) throw new Error('Роутер не найден');
        if (router.transport === 'demo') throw new Error('В демо-режиме импорт недоступен');
        let payload;
        try { payload = JSON.parse(String(text || '')); }
        catch (e) { throw new Error('Файл не является корректным JSON'); }
        const lists = Array.isArray(payload && payload.lists) ? payload.lists : [];
        const rules = Array.isArray(payload && payload.rules) ? payload.rules : [];
        if (!lists.length && !rules.length) throw new Error('В файле нет списков или правил');
        if (lists.length > 100 || rules.length > 500) throw new Error('Слишком много данных в файле');
        const cleanLists = [];
        const seen = new Set();
        for (const l of lists) {
            const name = String((l && l.name) || '').trim();
            if (!/^domain-list\d{1,3}$/.test(name)) throw new Error('Некорректное имя списка: ' + name);
            if (seen.has(name)) throw new Error('Список ' + name + ' повторяется');
            seen.add(name);
            const entries = cleanDnsEntries(l && l.entries);
            if (!entries.length) throw new Error('Список ' + name + ' пустой');
            const description = String((l && l.description) || name).trim().slice(0, 64) || name;
            cleanLists.push({ name, description, entries });
        }
        const state = await readDnsState(id);
        const ifaceNames = new Set(state.interfaces.map(i => i.name));
        const groupNames = new Set([...state.groups.map(g => g.name), ...cleanLists.map(l => l.name)]);
        const cleanRules = [];
        for (const r of rules) {
            const group = String((r && r.group) || '').trim();
            const iface = String((r && r.interface) || '').trim();
            if (!groupNames.has(group)) throw new Error('Правило ссылается на неизвестный список ' + group);
            if (!ifaceNames.has(iface)) throw new Error('Правило ссылается на неизвестный интерфейс ' + iface);
            cleanRules.push({
                group,
                interface: iface,
                auto: !!(r && r.auto),
                reject: !!(r && r.reject),
                enabled: !(r && r.enabled === false),
                gateway: String((r && r.gateway) || '')
            });
        }
        const target = rciTarget(router);
        for (const l of cleanLists) {
            if (state.groups.some(g => g.name === l.name)) {
                await rciPost(target, 'object-group/fqdn', { [l.name]: { include: { no: true } } });
            }
            await rciPost(target, 'object-group/fqdn', {
                [l.name]: {
                    description: l.description,
                    include: l.entries.map(address => ({ address }))
                }
            });
        }
        if (replaceRules) {
            const current = await rciGet(target, 'show/sc/dns-proxy/route');
            for (const rt of (Array.isArray(current) ? current : [])) {
                if (rt && rt.index) await rciPost(target, 'dns-proxy/route', { index: rt.index, no: true });
            }
        }
        for (const r of cleanRules) {
            await rciPost(target, 'dns-proxy/route', {
                group: r.group,
                interface: r.interface,
                gateway: r.gateway,
                auto: r.auto,
                reject: r.reject,
                disable: !r.enabled
            });
        }
        try { await rciPost(target, 'system/configuration/save', {}); } catch (e) { /* ignore */ }
        addEvent(router.id, 'ok', `${router.name}: импорт DNS — списков ${cleanLists.length}, правил ${cleanRules.length}`);
        return {
            imported: { lists: cleanLists.length, rules: cleanRules.length },
            router: await refreshRouter(router.id, '', { force: true }),
            ...(await readDnsState(id))
        };
    }

    function normalizeTunnelOrder(router, order) {
        const tunnels = (router.status && router.status.tunnels) || [];
        const known = new Set(tunnels.map(t => t.name));
        const out = [];
        for (const raw of (Array.isArray(order) ? order : [])) {
            const name = String(raw || '').trim();
            if (!validTunnelName(name) || !known.has(name) || out.includes(name)) continue;
            out.push(name);
        }
        for (const t of tunnels) {
            if (!out.includes(t.name)) out.push(t.name);
        }
        return out;
    }

    function setTunnelOrder(id, order) {
        const list = readRouters();
        const idx = list.findIndex(r => r.id === String(id || ''));
        if (idx < 0) throw new Error('Роутер не найден');
        const r = list[idx];
        r.tunnelOrder = normalizeTunnelOrder(r, order);
        r.updatedAt = Date.now();
        writeRouters(list);
        addEvent(r.id, 'info', `${r.name}: приоритеты туннелей обновлены`);
        return sanitize(r);
    }

    function updateHealthSettings(id, body) {
        const list = readRouters();
        const idx = list.findIndex(r => r.id === String(id || ''));
        if (idx < 0) throw new Error('Роутер не найден');
        const r = list[idx];
        const b = body || {};
        if (b.checkUrl !== undefined) {
            const url = String(b.checkUrl || '').trim();
            let parsed;
            try { parsed = new URL(url); } catch (e) { throw new Error('Некорректный URL проверки'); }
            if (!/^https?:$/.test(parsed.protocol)) throw new Error('URL должен начинаться с http:// или https://');
            r.checkUrl = url.slice(0, 500);
        }
        if (b.autoFailover !== undefined) r.autoFailover = !!b.autoFailover;
        if (b.checkIntervalMin !== undefined) {
            const n = Math.round(Number(b.checkIntervalMin));
            if (!Number.isFinite(n) || n < 1 || n > 60) throw new Error('Интервал проверки: от 1 до 60 минут');
            r.checkIntervalMin = n;
        }
        r.updatedAt = Date.now();
        writeRouters(list);
        addEvent(r.id, 'info', `${r.name}: настройки проверки обновлены`);
        return sanitize(r);
    }

    function httpCheck(url) {
        return new Promise(resolve => {
            let parsed;
            try { parsed = new URL(url); } catch (e) { return resolve({ ok: false, error: 'некорректный URL' }); }
            const lib = parsed.protocol === 'https:' ? https : http;
            const req = lib.get(parsed, {
                timeout: 6000,
                headers: { 'User-Agent': 'Servpanel-Keenetic/1.0' }
            }, res => {
                res.resume();
                resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, statusCode: res.statusCode || 0 });
            });
            req.on('timeout', () => { req.destroy(new Error('таймаут')); });
            req.on('error', e => resolve({ ok: false, error: String(e.message || e) }));
        });
    }

    async function autoFailoverRouter(router, health) {
        const tunnels = (router.status && router.status.tunnels) || [];
        const order = normalizeTunnelOrder(router, router.tunnelOrder);
        const ordered = order.map(n => tunnels.find(t => t.name === n)).filter(Boolean);
        const routed = ordered.find(t => t.routed === true) || null;
        const next = ordered.find(t => t !== routed && t.up && t.link !== 'down' && !t.empty);
        if (!next) {
            addEvent(router.id, 'warn', `${router.name}: проверка не прошла, но доступного резерва нет`);
            return { switched: false };
        }
        const res = await failoverDns(router.id, next.name);
        const list = readRouters();
        const idx = list.findIndex(r => r.id === router.id);
        if (idx >= 0) {
            const cur = normalizeTunnelOrder(list[idx], list[idx].tunnelOrder);
            list[idx].tunnelOrder = [next.name, ...cur.filter(n => n !== next.name)];
            list[idx].updatedAt = Date.now();
            writeRouters(list);
        }
        addEvent(router.id, 'warn', `${router.name}: авто-переключение на ${next.name}`);
        return { switched: true, backup: next.name, updated: res.updated };
    }

    async function checkRouterHealth(id) {
        const router = routerById(id);
        if (!router) throw new Error('Роутер не найден');
        const url = router.checkUrl || DEFAULT_CHECK_URL;
        const started = Date.now();
        const result = await httpCheck(url);
        const prev = router.health || null;
        const failures = result.ok ? 0 : (Number(prev && prev.failures) || 0) + 1;
        const health = {
            ok: !!result.ok,
            statusCode: result.statusCode || 0,
            latencyMs: Math.max(1, Date.now() - started),
            checkedAt: Date.now(),
            url,
            failures,
            error: result.error || ''
        };
        const list = readRouters();
        const idx = list.findIndex(r => r.id === router.id);
        if (idx >= 0) {
            list[idx].health = health;
            list[idx].updatedAt = Date.now();
            writeRouters(list);
        }
        if (prev && !!prev.ok !== health.ok) {
            addEvent(router.id, health.ok ? 'ok' : 'warn',
                `${router.name}: проверка ${health.ok ? 'успешна' : 'не удалась'} · ${url}`);
        }
        let failover = null;
        if (!health.ok && router.autoFailover && failures >= 2) {
            try { failover = await autoFailoverRouter(router, health); }
            catch (e) { failover = { switched: false, error: String(e.message || e) }; }
        }
        return { router: sanitize(routerById(id)), health, failover };
    }

    async function refreshRouter(id, reason = '', opts = {}) {
        const router = routerById(id);
        if (!router) throw new Error('Роутер не найден');
        if (refreshing.has(router.id)) {
            if (!opts.force) return sanitize(router);
            for (let i = 0; i < 20 && refreshing.has(router.id); i++) {
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            if (refreshing.has(router.id)) return sanitize(routerById(router.id));
        }
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
            tunnelOrder: [],
            autoFailover: false,
            checkUrl: DEFAULT_CHECK_URL,
            checkIntervalMin: 5,
            health: null,
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
        app.post('/api/keenetic/routers/:id/tunnels/:name/action', checkAuth, requireAdmin, async (req, res) => {
            try {
                const action = String((req.body && req.body.action) || '').toLowerCase();
                const router = await applyTunnelAction(req.params.id, req.params.name, action);
                if (auditLog) auditLog(req, `Keenetic: ${router.name} туннель ${req.params.name} — ${action}`);
                res.json({ success: true, router });
            } catch (e) { res.status(400).json({ error: e.message }); }
        });
        app.post('/api/keenetic/routers/:id/wireguard/import', checkAuth, requireAdmin, async (req, res) => {
            try {
                const body = req.body || {};
                const result = await importWireguard(req.params.id, body.data, body.filename, !!body.defaultRoute);
                if (auditLog) auditLog(req, `Keenetic: импорт WireGuard ${result.created || body.filename}`);
                res.json({ success: true, ...result });
            } catch (e) { res.status(400).json({ error: e.message }); }
        });
        app.get('/api/keenetic/routers/:id/dns', checkAuth, async (req, res) => {
            try { res.json({ success: true, ...(await readDnsState(req.params.id)) }); }
            catch (e) { res.status(400).json({ error: e.message }); }
        });
        app.post('/api/keenetic/routers/:id/dns/lists', checkAuth, requireAdmin, async (req, res) => {
            try {
                const result = await saveDnsGroup(req.params.id, req.body || {});
                if (auditLog) auditLog(req, `Keenetic: сохранён список DNS ${(req.body && req.body.name) || ''}`);
                res.json({ success: true, ...result });
            } catch (e) { res.status(400).json({ error: e.message }); }
        });
        app.delete('/api/keenetic/routers/:id/dns/lists/:name', checkAuth, requireAdmin, async (req, res) => {
            try {
                const result = await deleteDnsGroup(req.params.id, req.params.name);
                if (auditLog) auditLog(req, `Keenetic: удалён список DNS ${req.params.name}`);
                res.json({ success: true, ...result });
            } catch (e) { res.status(400).json({ error: e.message }); }
        });
        app.post('/api/keenetic/routers/:id/dns/routes', checkAuth, requireAdmin, async (req, res) => {
            try {
                const result = await saveDnsRoute(req.params.id, req.body || {});
                if (auditLog) auditLog(req, `Keenetic: сохранено DNS-правило ${(req.body && req.body.group) || ''}`);
                res.json({ success: true, ...result });
            } catch (e) { res.status(400).json({ error: e.message }); }
        });
        app.delete('/api/keenetic/routers/:id/dns/routes/:index', checkAuth, requireAdmin, async (req, res) => {
            try {
                const result = await deleteDnsRoute(req.params.id, req.params.index);
                if (auditLog) auditLog(req, `Keenetic: удалено DNS-правило ${req.params.index}`);
                res.json({ success: true, ...result });
            } catch (e) { res.status(400).json({ error: e.message }); }
        });
        app.post('/api/keenetic/routers/:id/dns/routes/:index/toggle', checkAuth, requireAdmin, async (req, res) => {
            try {
                const result = await setDnsRouteEnabled(req.params.id, req.params.index, !!(req.body && req.body.enabled));
                if (auditLog) auditLog(req, `Keenetic: DNS-правило ${req.params.index} ${req.body && req.body.enabled ? 'включено' : 'выключено'}`);
                res.json({ success: true, ...result });
            } catch (e) { res.status(400).json({ error: e.message }); }
        });
        app.put('/api/keenetic/routers/:id/tunnels/order', checkAuth, requireAdmin, (req, res) => {
            try {
                const router = setTunnelOrder(req.params.id, req.body && req.body.order);
                if (auditLog) auditLog(req, `Keenetic: приоритеты туннелей ${router.name}`);
                res.json({ success: true, router });
            } catch (e) { res.status(400).json({ error: e.message }); }
        });
        app.put('/api/keenetic/routers/:id/health', checkAuth, requireAdmin, (req, res) => {
            try {
                const router = updateHealthSettings(req.params.id, req.body || {});
                if (auditLog) auditLog(req, `Keenetic: настройки проверки ${router.name}`);
                res.json({ success: true, router });
            } catch (e) { res.status(400).json({ error: e.message }); }
        });
        app.post('/api/keenetic/routers/:id/health/check', checkAuth, requireAdmin, async (req, res) => {
            try {
                const result = await checkRouterHealth(req.params.id);
                res.json({ success: true, ...result });
            } catch (e) { res.status(400).json({ error: e.message }); }
        });
        app.post('/api/keenetic/routers/:id/failover', checkAuth, requireAdmin, async (req, res) => {
            try {
                const result = await failoverDns(req.params.id, req.body && req.body.backup);
                if (auditLog) auditLog(req, `Keenetic: маршруты переведены на ${result.backup} (${result.updated})`);
                res.json({ success: true, ...result });
            } catch (e) { res.status(400).json({ error: e.message }); }
        });
        app.get('/api/keenetic/routers/:id/dns/export', checkAuth, requireAdmin, async (req, res) => {
            try {
                const data = await exportDnsState(req.params.id);
                res.json({ success: true, export: data });
            } catch (e) { res.status(400).json({ error: e.message }); }
        });
        app.post('/api/keenetic/routers/:id/dns/import', checkAuth, requireAdmin, async (req, res) => {
            try {
                const result = await importDnsState(req.params.id, req.body && req.body.text, !!(req.body && req.body.replace));
                if (auditLog) auditLog(req, `Keenetic: импорт DNS-списков (${result.imported.lists} списков, ${result.imported.rules} правил)`);
                res.json({ success: true, ...result });
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
        const runHealth = async () => {
            if (healthRunning) return;
            healthRunning = true;
            try {
                const routers = readRouters().filter(r => r.enabled !== false);
                for (const r of routers) {
                    const interval = Math.max(1, Math.min(60, Number(r.checkIntervalMin) || 5)) * 60 * 1000;
                    const last = (r.health && Number(r.health.checkedAt)) || 0;
                    if (last && Date.now() - last < interval) continue;
                    try { await checkRouterHealth(r.id); } catch (e) { /* ignore */ }
                }
            } finally {
                healthRunning = false;
            }
        };
        setTimeout(runHealth, 20000);
        healthTimer = setInterval(runHealth, 60000);
        if (healthTimer.unref) healthTimer.unref();
    }

    return {
        registerRoutes,
        start,
        stop: () => {
            if (pollTimer) clearInterval(pollTimer);
            if (healthTimer) clearInterval(healthTimer);
            pollTimer = null;
            healthTimer = null;
        },
        refreshRouter,
        overview,
        createRouter,
        updateRouter,
        removeRouter,
        _test: { parseVersionJson, parseSystemJson, parseCliVersion, parseCliSystem, parseInterfacesJson, parseCliInterfaces, profileFromFirmware, validTunnelName, isIpv4Entry, isIpv6Entry, cleanDnsEntries }
    };
}

module.exports = { createKeenetic };
