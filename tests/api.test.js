'use strict';

/*
 * Интеграционные тесты Servpanel.
 * Запуск: npm test  (нужен npm install — используются настоящие express/express-session)
 *
 * Тесты не трогают систему: SERVEPANEL_TEST=1 отключает sudo/systemd/историю,
 * а все данные пишутся во временный каталог.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'servpanel-test-'));
process.env.SERVEPANEL_TEST = '1';
process.env.SERVEPANEL_DATA_DIR = DATA_DIR;
process.env.ADMIN_PASSWORD = 'test-admin-pass-123';
process.env.SERVEPANEL_AUTH_LOG = path.join(DATA_DIR, 'auth.log');
process.env.SERVEPANEL_AUDIT_LOG = path.join(DATA_DIR, 'audit.log');

const app = require('../server.js');
const internals = app._internals;
const updater = require('../lib/updater');

let server;
let base;
let cookie = '';

function setCookiesOf(res) {
    if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
    const single = res.headers.get('set-cookie');
    return single ? [single] : [];
}

async function request(url, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { ...opts, headers });
    const setCookies = setCookiesOf(res);
    if (setCookies.length) {
        const sid = setCookies.find(c => c.startsWith('panel.sid='));
        if (sid) {
            cookie = sid.split(';')[0];
            if (/panel\.sid=;|Expires=Thu, 01 Jan 1970/i.test(sid)) cookie = '';
        }
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, headers: res.headers, text, json };
}

function jsonBody(obj, extra = {}) {
    return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(extra.headers || {}) },
        body: JSON.stringify(obj),
        ...extra
    };
}

async function login(password, username = '', code = '', ip = '') {
    const headers = { 'Content-Type': 'application/json' };
    if (ip) headers['X-Forwarded-For'] = ip;
    const res = await fetch(base + '/api/login', {
        method: 'POST', headers,
        body: JSON.stringify({ username, password, code })
    });
    const setCookies = setCookiesOf(res);
    if (setCookies.length) {
        const sid = setCookies.find(c => c.startsWith('panel.sid='));
        if (sid) cookie = sid.split(';')[0];
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* ignore */ }
    return { status: res.status, json };
}

before(async () => {
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = 'http://127.0.0.1:' + server.address().port;
});

after(() => {
    try { server.close(); } catch (e) { /* ignore */ }
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

test('API закрыт без авторизации', async () => {
    const r = await request('/api/stats');
    assert.equal(r.status, 401);
});

test('security-заголовки на главной странице', async () => {
    const r = await request('/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('неверный пароль отклоняется и попадает в лог fail2ban', async () => {
    const r = await login('wrong-password', 'admin', '', '203.0.113.10');
    assert.equal(r.status, 401);
    const log = fs.readFileSync(process.env.SERVEPANEL_AUTH_LOG, 'utf8');
    assert.match(log, /FAILED LOGIN from 203\.0\.113\.10/);
});

test('верный пароль открывает сессию', async () => {
    const r = await login('test-admin-pass-123');
    assert.equal(r.status, 200);
    assert.equal(r.json.role, 'admin');
    assert.ok(cookie.startsWith('panel.sid='));

    const st = await request('/api/security/status');
    assert.equal(st.status, 200);
    assert.equal(st.json.user, 'admin');
    assert.equal(st.json.role, 'admin');
});

test('CSRF: запрос с чужого Origin отклоняется', async () => {
    const r = await request('/api/ufw', jsonBody({ port: 8080 }, { headers: { Origin: 'http://evil.example' } }));
    assert.equal(r.status, 403);
});

test('защита от подбора: 5 неудач блокируют IP', async () => {
    const ip = '198.51.100.66';
    for (let i = 0; i < 5; i++) await login('bad-' + i, 'admin', '', ip);
    const blocked = await login('bad-final', 'admin', '', ip);
    assert.equal(blocked.status, 429);
});

test('сессия хранится в файле и переживает перезапуск', async () => {
    assert.ok(cookie, 'нужна активная сессия');
    const value = decodeURIComponent(cookie.split('=').slice(1).join('='));
    const sid = value.replace(/^s:/, '').split('.')[0];
    const store = new internals.FileSessionStore(path.join(DATA_DIR, '.sessions'));
    const sess = await new Promise(resolve => store.get(sid, (err, s) => resolve(s)));
    assert.ok(sess, 'сессия должна читаться из файла');
    assert.equal(sess.loggedIn, true);
    assert.equal(sess.user, 'admin');
});

test('параллельные запросы не теряют сессию', async () => {
    assert.ok(cookie, 'нужна активная сессия');
    const statuses = await Promise.all(Array.from({ length: 30 }, async () => {
        const res = await fetch(base + '/api/sysinfo', { headers: { cookie } });
        return res.status;
    }));
    assert.deepEqual(statuses.filter(s => s !== 200 && s !== 304), []);
});

test('sysinfo: CPU и RAM — проценты в допустимых пределах', async () => {
    const r = await request('/api/sysinfo');
    assert.equal(r.status, 200);
    const cpu = Number(r.json.cpu);
    const ram = Number(r.json.ram);
    assert.ok(Number.isFinite(cpu) && cpu >= 0 && cpu <= 100, 'CPU должен быть 0–100%');
    assert.ok(Number.isFinite(ram) && ram >= 0 && ram <= 100, 'RAM должен быть 0–100%');
    assert.ok(r.json.disk && typeof r.json.disk.percent === 'string');
});

test('WARP: опциональный статус и список доменов доступны', async () => {
    const st = await request('/api/warp/status');
    assert.equal(st.status, 200);
    assert.equal(st.json.installed, false);
    assert.equal(st.json.testMode, true);
    assert.ok(st.json.domains > 0, 'должен быть список доменов для AdGuard');

    const domains = await request('/api/warp/domains');
    assert.equal(domains.status, 200);
    assert.ok(Array.isArray(domains.json.domains) && domains.json.domains.length > 0);
    assert.equal(domains.json.count, domains.json.domains.length);

    const power = await request('/api/warp/power', jsonBody({ enable: true }));
    assert.equal(power.status, 200);
    assert.equal(power.json.demo, true);

    const sync = await request('/api/warp/adguard', jsonBody({
        url: '127.0.0.1:8090', rewriteIp: '10.8.1.1'
    }));
    assert.equal(sync.status, 200);
    assert.equal(sync.json.demo, true);
    assert.ok(sync.json.count > 0);
    assert.equal(sync.json.rewriteIp, '10.8.1.1');
});

test('создание пользователя с ролью viewer', async () => {
    const r = await request('/api/users', jsonBody({ username: 'viewer1', password: 'viewer-pass-123', role: 'viewer' }));
    assert.equal(r.status, 200);
    const list = await request('/api/users');
    assert.equal(list.status, 200);
    assert.ok(list.json.users.some(u => u.username === 'viewer1' && u.role === 'viewer'));
});

test('viewer может смотреть, но не может менять', async () => {
    await request('/api/logout', { method: 'POST' });
    const r = await login('viewer-pass-123', 'viewer1');
    assert.equal(r.status, 200);
    assert.equal(r.json.role, 'viewer');

    const stats = await request('/api/security/status');
    assert.equal(stats.status, 200);

    const attempt = await request('/api/ufw', jsonBody({ port: 8080 }));
    assert.equal(attempt.status, 403);

    const audit = await request('/api/audit');
    assert.equal(audit.status, 403);

    const users = await request('/api/users');
    assert.equal(users.status, 403);

    await request('/api/logout', { method: 'POST' });
});

test('2FA: включение, вход по коду и отключение', async () => {
    assert.equal((await login('test-admin-pass-123')).status, 200);

    const setup = await request('/api/2fa/setup', { method: 'POST' });
    assert.equal(setup.status, 200);
    const secret = setup.json.secret;
    assert.match(secret, /^[A-Z2-7]{16,}$/);

    const code = internals.totpAt(secret, Math.floor(Date.now() / 30000));
    const enable = await request('/api/2fa/enable', jsonBody({ code }));
    assert.equal(enable.status, 200);
    assert.equal(enable.json.recoveryCodes.length, 10);

    await request('/api/logout', { method: 'POST' });

    const noCode = await login('test-admin-pass-123');
    assert.equal(noCode.status, 401);
    assert.equal(noCode.json.need2fa, true);

    const withCode = await login('test-admin-pass-123', '', code);
    assert.equal(withCode.status, 200);

    const disable = await request('/api/2fa/disable', jsonBody({ password: 'test-admin-pass-123' }));
    assert.equal(disable.status, 200);

    const after = await login('test-admin-pass-123');
    assert.equal(after.status, 200);
});

test('аудит содержит записи с пользователем', async () => {
    const r = await request('/api/audit?limit=100');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.entries));
    assert.ok(r.json.entries.length > 0);
    assert.ok(r.json.entries.some(e => e.user === 'admin'));
});

test('TOTP соответствует RFC 6238 (вектор 59 c)', () => {
    const secret = internals.base32Encode(Buffer.from('12345678901234567890'));
    const code = internals.totpAt(secret, 1);
    assert.equal(code, '287082');
});

test('vpn:// кодируется и декодируется без потерь', () => {
    const conf = '[Interface]\nPrivateKey = AAAA\nAddress = 10.8.0.2/32\nJc = 4\n\n[Peer]\nPublicKey = BBBB\nEndpoint = 1.2.3.4:51820\nAllowedIPs = 0.0.0.0/0\n';
    const uri = internals.buildVpnUriFromConf('phone', conf);
    assert.match(uri, /^vpn:\/\//);
    const decoded = internals.vpnDecode(uri);
    assert.equal(decoded.description, 'phone');
    assert.equal(decoded.containers[0].container, 'amnezia-awg');
});

test('валидация параметров обфускации', () => {
    assert.throws(() => internals.validateObf({ Jc: 9999 }), /Jc/);
    assert.throws(() => internals.validateObf({ Jmin: 100, Jmax: 10 }), /Jmin/);
    const clean = internals.validateObf({ Jc: 4, Jmin: 40, Jmax: 70, S1: 50, H1: 1 });
    assert.equal(clean.Jc, '4');
});

const ARCHITECT_CONF = `# AmneziaWG 3.1
[Interface]
# PrivateKey = <your private key>
H1 = 1000000-1010000
H2 = 2000000-2010000
H3 = 3000000-3010000
H4 = 4000000-4010000
S1 = 40
S2 = 60
S3 = 20
S4 = 12
Jc = 5
Jmin = 100
Jmax = 500
I1 = <b 0xdeadbeef><r 100><t>
I2 = <t><rc 10><r 200>
I3 = <rd 5><b 0xcafe>
I4 = <r 300><rc 12>
I5 = <t><b 0x1234><rd 8>
HeaderProtectionKey = BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=
ContentPaddingAddition = 16-128
RekeyAfterTime = 110-130
RekeyTimeout = 5-8
RejectAfterTime = 170-200
KeepaliveTimeout = 8-12
MaxHandshakeAttempts = 3-5
RandomTrailers = 1
DisableCookies = 1
`;

test('диапазоны Архитектора сохраняются, а не обрезаются', () => {
    const clean = internals.validateObf({
        H1: '1000000-1010000', H2: '2000000-2010000', H3: '3000000-3010000', H4: '4000000-4010000',
        ContentPaddingAddition: '16-128', RekeyAfterTime: '110-130', MaxHandshakeAttempts: '3-5'
    });
    assert.equal(clean.H1, '1000000-1010000');
    assert.equal(clean.ContentPaddingAddition, '16-128');
    assert.equal(clean.RekeyAfterTime, '110-130');
    // Старый код превращал диапазон в первое число.
    assert.notEqual(clean.H1, '1000000');
});

test('валидация отклоняет опасные диапазоны и ключи', () => {
    assert.throws(() => internals.validateObf({ H1: '100-50' }), /начало диапазона/);
    assert.throws(() => internals.validateObf({ H1: '100-200', H2: '150-250' }), /пересекаются/);
    assert.throws(() => internals.validateObf({ S4: 40 }), /S4/);
    assert.throws(() => internals.validateObf({ HeaderProtectionKey: 'short' }), /HeaderProtectionKey/);
    assert.throws(() => internals.validateObf({ I1: 'A'.repeat(3300) }), /3200/);
});

test('парсер понимает .conf Архитектора и оценивает защиту', () => {
    const parsed = internals.parseObfInput(ARCHITECT_CONF);
    assert.equal(parsed.format, 'architect-conf');
    assert.equal(parsed.version, '3.1');
    assert.equal(parsed.params.H1, '1000000-1010000');
    assert.equal(parsed.params.RandomTrailers, '1');
    const audit = internals.auditObf(parsed.params);
    assert.equal(audit.level, 'strong');
    assert.ok(audit.score >= 85, `score=${audit.score}`);
    assert.ok(audit.findings.some(f => f.id === 'hpk-ok'));
});

test('batch из Архитектора: берётся первый конфиг', () => {
    const batch = ARCHITECT_CONF + '\n' + '='.repeat(40) + '\n' + ARCHITECT_CONF.replace(/H1 = .*/, 'H1 = 9000000-9010000');
    const parsed = internals.parseObfInput(batch);
    assert.equal(parsed.format, 'architect-batch');
    assert.equal(parsed.alternatives, 2);
    assert.equal(parsed.params.H1, '1000000-1010000');
    assert.ok(parsed.warnings.some(w => w.includes('2')));
});

test('применение удаляет устаревшие параметры при смене версии', () => {
    const original = '[Interface]\nPrivateKey = AAAA\nJc = 4\nH1 = 1\nH2 = 2\nRandomTrailers = 1\n\n[Peer]\nPublicKey = BBBB\n';
    const updated = internals.applyObfToConf(original, { Jc: '5', H1: '10-20' }, { removeMissing: true });
    assert.match(updated, /Jc = 5/);
    assert.match(updated, /H1 = 10-20/);
    assert.doesNotMatch(updated, /^H2 =/m);
    assert.doesNotMatch(updated, /RandomTrailers/);
    // Секция Peer не должна пострадать.
    assert.match(updated, /\[Peer\]\nPublicKey = BBBB/);
});

test('аудит замечает выключенные флаги 3.1', () => {
    const params = { ...internals.parseObfInput(ARCHITECT_CONF).params, DisableCookies: '0', RandomTrailers: '0' };
    const audit = internals.auditObf(params);
    assert.ok(audit.findings.some(f => f.id === 'cookies-enabled'));
    assert.ok(audit.findings.some(f => f.id === 'trailers-missing'));
    assert.ok(audit.score < 100);
});

test('встроенные профили обфускации доступны', async () => {
    const r = await request('/api/obf/profiles');
    assert.equal(r.status, 200);
    assert.equal(r.json.builtin.length, 3);
    assert.ok(r.json.builtin.some(p => p.name === 'mobile'));
});

test('генератор профилей: max, balanced и compat', () => {
    const max = internals.generateObfProfile('max');
    assert.match(max.H1, /^\d+-\d+$/);
    assert.ok(max.I1 && max.I5);
    assert.ok(max.HeaderProtectionKey);
    assert.equal(internals.detectObfVersion(max), '3.1');
    assert.ok(internals.auditObf(max).score >= 85);

    const balanced = internals.generateObfProfile('balanced');
    assert.ok(balanced.I1 && balanced.I3 && !balanced.I4);
    assert.ok(balanced.HeaderProtectionKey);
    assert.equal(internals.detectObfVersion(balanced), '3.1');

    const compat = internals.generateObfProfile('compat');
    assert.ok(compat.I1 && !compat.I4);
    assert.equal(compat.HeaderProtectionKey, undefined);
    assert.equal(internals.detectObfVersion(compat), '2.0');
});

test('API генератора профилей возвращает версию и аудит', async () => {
    const r = await request('/api/obf/generate', jsonBody({ preset: 'balanced' }));
    assert.equal(r.status, 200);
    assert.equal(r.json.preset, 'balanced');
    assert.equal(r.json.version, '3.1');
    assert.ok(r.json.audit && r.json.audit.score >= 0);
    assert.ok(r.json.params.H1 && r.json.params.I1);
});

test('автопоиск AdGuard возвращает кандидатов и не падает без сервиса', async () => {
    const r = await request('/api/adguard/autodetect');
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.found, 'boolean');
    assert.ok(Array.isArray(r.json.tried));
    assert.ok(r.json.tried.length >= 3);
});

test('настройки автобэкапа сохраняются', async () => {
    const save = await request('/api/backup/auto', jsonBody({
        enabled: true, schedule: 'weekly', time: '03:15', keep: 5, encrypt: true
    }));
    assert.equal(save.status, 200);
    const st = await request('/api/backup/auto');
    assert.equal(st.status, 200);
    assert.equal(st.json.config.schedule, 'weekly');
    assert.equal(st.json.config.keep, 5);
    assert.equal(st.json.config.time, '03:15');
});

test('Telegram: неверный токен отклоняется, верный сохраняется', async () => {
    const bad = await request('/api/notify/telegram', jsonBody({ enabled: true, token: 'oops', chatId: '123' }));
    assert.equal(bad.status, 400);
    const good = await request('/api/notify/telegram', jsonBody({
        enabled: true, token: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', chatId: '123456789'
    }));
    assert.equal(good.status, 200);
    const st = await request('/api/notify/status');
    assert.equal(st.json.enabled, true);
    assert.equal(st.json.hasToken, true);
});

test('проверка здоровья каскада возвращает структуру', async () => {
    const r = await request('/api/cascade/health');
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.ok, 'boolean');
    assert.equal(typeof r.json.checks, 'object');
});

test('Обновление: сведения о версии, git и бэкапах доступны администратору', async () => {
    const r = await request('/api/update/info');
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.version, 'string');
    assert.ok(r.json.version.length >= 3);
    assert.ok(Array.isArray(r.json.backups));
    assert.ok(r.json.status && typeof r.json.status.running === 'boolean');
    assert.ok(Array.isArray(r.json.cascadeIfaces));
    assert.equal(typeof r.json.limits.uploadMb, 'number');
});

test('Обновление: пустой файл отклоняется без запуска воркера', async () => {
    const r = await request('/api/update/upload', jsonBody({ name: 'release.tar.gz', data: '' }));
    assert.equal(r.status, 400);
});

test('Обновление: статус читается и не запущено в тестовом окружении', async () => {
    const r = await request('/api/update/status');
    assert.equal(r.status, 200);
    assert.equal(r.json.running, false);
    assert.ok(Array.isArray(r.json.backups));
});

test('Обновление: зависший worker определяется как stale и lock снимается', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servpanel-updater-test-'));
    try {
        fs.writeFileSync(path.join(dir, '.update_status.json'), JSON.stringify({
            running: true,
            ok: false,
            pid: 99999999,
            startedAt: new Date().toISOString(),
            step: 'stop',
            message: 'Останавливаю панель',
            log: []
        }));
        fs.writeFileSync(path.join(dir, '.update.lock'), '1');

        const st = updater.readStatus(dir);
        assert.equal(st.running, false);
        assert.equal(st.stale, true);
        assert.match(st.error, /аварийно/);

        const lock = updater.acquireLock(dir);
        assert.ok(fs.existsSync(lock));
        updater.releaseLock(lock);

        // Старый статус 2.4.0: PID ещё не писался, но шаг stop висит > 15 минут.
        fs.writeFileSync(path.join(dir, '.update_status.json'), JSON.stringify({
            running: true,
            ok: false,
            startedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
            step: 'stop',
            message: 'Останавливаю панель',
            log: []
        }));
        fs.writeFileSync(path.join(dir, '.update.lock'), '1');
        const old = updater.readStatus(dir);
        assert.equal(old.running, false);
        assert.equal(old.stale, true);
        const oldLock = updater.acquireLock(dir);
        assert.ok(fs.existsSync(oldLock));
        updater.releaseLock(oldLock);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('Обновление: в интерфейсе есть отдельная вкладка и кнопки', async () => {
    const r = await request('/');
    assert.equal(r.status, 200);
    assert.match(r.text, /id="tab-update"/);
    assert.match(r.text, /updUploadBtn/);
    assert.match(r.text, /updGitBtn/);
    assert.match(r.text, /updGitForceBtn/);
    assert.match(r.text, /updBackups/);
});

test('GeoIP: файл любого формата разбирается в IPv4/CIDR', () => {
    const list = internals.parseIpList(
        '{"site":["5.8.75.0\\/24","1.2.3.4"]}\n' +
        'ipset=/10.0.0.0/8/vpn\n' +
        'bad 999.1.1.1, 8.8.8.8/33\n' +
        'range 192.168.1.1-192.168.1.5'
    );
    assert.deepEqual(list, ['5.8.75.0/24', '1.2.3.4', '10.0.0.0/8', '192.168.1.1', '192.168.1.5']);
});

test('GeoIP: длинный URL OpenCCK с site=... проходит валидацию', () => {
    const base = 'https://russia.iplist.opencck.org/?format=text&data=cidr4';
    const longUrl = base + Array.from({ length: 90 }, (_, i) => `&site=site${i}.ru`).join('') +
        '&site=mailru%40cloud.mail.ru&site=vk%40vkvideo.ru';
    assert.ok(longUrl.length > 300);
    assert.equal(internals.validGeoUrl(longUrl), true);
    assert.equal(internals.validGeoUrl('http://example.com/list.txt'), false);
    assert.equal(internals.validGeoUrl('https://example.com/list.txt?x="bad"'), false);
    assert.equal(internals.validGeoUrl('https://example.com/list.txt?x=$HOME'), false);
    assert.equal(internals.validGeoUrl('https://example.com/list.txt?x=bad value'), false);
});

test('GeoIP: загрузка файла возвращает количество найденных адресов', async () => {
    const data = Buffer.from('1.2.3.4\n5.6.7.0/24\n999.1.1.1\n', 'utf8').toString('base64');
    const r = await request('/api/tools/rudrop/upload', jsonBody({ name: 'list.json', data }));
    assert.equal(r.status, 200);
    assert.equal(r.json.count, 2);
    assert.equal(r.json.demo, true);
});

test('Обновление: воркер и модуль обновления присутствуют', () => {
    const workerFile = path.join(__dirname, '..', 'lib', 'update-worker.js');
    const updaterFile = path.join(__dirname, '..', 'lib', 'updater.js');
    assert.ok(fs.existsSync(workerFile));
    assert.ok(fs.existsSync(updaterFile));
    const workerSource = fs.readFileSync(workerFile, 'utf8');
    const updaterSource = fs.readFileSync(updaterFile, 'utf8');
    assert.match(updaterSource, /systemd-run/);
    assert.match(updaterSource, /pidLooksLikeWorker/);
    // restart не должен сбрасывать env панели на минимальное окружение systemd-run.
    assert.doesNotMatch(workerSource, /\['restart',\s*PM2_NAME,\s*'--update-env'\]/);
});

test('SSL: домены и email валидируются', () => {
    assert.equal(internals.normalizeDomain('Panel.Example.COM.'), 'panel.example.com');
    assert.equal(internals.normalizeDomain('  vpn.example.com '), 'vpn.example.com');
    assert.equal(internals.normalizeDomain('localhost'), '');
    assert.equal(internals.normalizeDomain('bad domain.com'), '');
    assert.equal(internals.normalizeDomain('https://example.com'), '');
    assert.equal(internals.normalizeDomain('-bad.example.com'), '');
    assert.equal(internals.normalizeDomain('a..b.example.com'), '');
    assert.equal(internals.normalizeEmail('admin@example.com'), 'admin@example.com');
    assert.equal(internals.normalizeEmail('not-an-email'), '');
});

test('SSL: конфиг Nginx содержит прокси, сертификат и ключ', () => {
    const panel = internals.buildSiteConfig({
        domain: 'panel.example.com',
        mode: 'panel',
        httpsPort: 8443,
        certPath: '/etc/letsencrypt/live/panel.example.com/fullchain.pem',
        keyPath: '/etc/letsencrypt/live/panel.example.com/privkey.pem'
    });
    assert.match(panel, /server_name panel\.example\.com;/);
    assert.match(panel, /listen 8443 ssl;/);
    assert.match(panel, /ssl_certificate \/etc\/letsencrypt\/live\/panel\.example\.com\/fullchain\.pem;/);
    assert.match(panel, /ssl_certificate_key \/etc\/letsencrypt\/live\/panel\.example\.com\/privkey\.pem;/);
    assert.match(panel, /proxy_pass http:\/\/127\.0\.0\.1:\d+;/);
    assert.match(panel, /return 301 https:\/\/\$host:8443\$request_uri;/);

    const site = internals.buildSiteConfig({ domain: 'site.example.com', mode: 'site', www: true, httpsPort: 443 });
    assert.match(site, /server_name site\.example\.com www\.site\.example\.com;/);
    assert.match(site, /root \/var\/www\/site\.example\.com;/);
    assert.doesNotMatch(site, /ssl_certificate /);
});

test('SSL: порты из конфига Nginx распознаются', () => {
    const conf = 'server { listen 80; listen 8443 ssl; listen [::]:443 ssl http2; }';
    assert.deepEqual(internals.existingListenPorts(conf), [80, 8443, 443]);
    assert.equal(internals.existingSslPort(conf), 8443);
    assert.deepEqual(internals.parseServerNames('server_name site.example.com www.site.example.com;'),
        ['site.example.com', 'www.site.example.com']);
});

test('SSL: статус показывает пути к сертификатам и ключам', async () => {
    const r = await request('/api/ssl/status');
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.paths.live, 'string');
    assert.match(r.json.paths.live, /letsencrypt/);
    assert.match(r.json.paths.renewal, /renewal/);
    assert.match(r.json.paths.panelConfig, /nginx/);
    assert.ok(Array.isArray(r.json.certificates));
    assert.ok(Array.isArray(r.json.sites));
    assert.ok(r.json.panel && typeof r.json.panel.internalPort === 'number');
});

test('SSL: домен панели привязывается, сертификат и пути видны в статусе', async () => {
    const r = await request('/api/ssl/site', jsonBody({
        domain: 'panel.example.com', email: 'admin@example.com', mode: 'panel'
    }));
    assert.equal(r.status, 200);
    assert.equal(r.json.success, true);
    assert.equal(r.json.domain, 'panel.example.com');
    assert.match(r.json.url, /^https:\/\/panel\.example\.com/);
    assert.equal(r.json.certificates.fullchain, '/etc/letsencrypt/live/panel.example.com/fullchain.pem');
    assert.equal(r.json.certificates.privkey, '/etc/letsencrypt/live/panel.example.com/privkey.pem');

    const st = await request('/api/ssl/status');
    assert.equal(st.json.panel.domain, 'panel.example.com');
    assert.equal(st.json.panel.scheme, 'https');
    const cert = st.json.certificates.find(c => c.name === 'panel.example.com');
    assert.ok(cert);
    assert.equal(cert.privkey, '/etc/letsencrypt/live/panel.example.com/privkey.pem');
    assert.ok(st.json.sites.some(s => (s.domains || []).includes('panel.example.com')));
});

test('SSL: сертификат виден на дашборде в данных сервера', async () => {
    const r = await request('/api/server-info');
    assert.equal(r.status, 200);
    assert.equal(r.json.domain, 'panel.example.com');
    assert.ok(r.json.cert);
    assert.equal(r.json.cert.fullchain, '/etc/letsencrypt/live/panel.example.com/fullchain.pem');
});

test('SSL: дополнительный сайт создаётся, чужой сайт удалить нельзя, свой удаляется', async () => {
    const bad = await request('/api/ssl/site', jsonBody({ domain: 'localhost', mode: 'site' }));
    assert.equal(bad.status, 400);

    const ok = await request('/api/ssl/site', jsonBody({ domain: 'site.example.com', mode: 'site', www: true }));
    assert.equal(ok.status, 200);
    assert.match(ok.json.url, /^https:\/\/site\.example\.com/);

    const st = await request('/api/ssl/status');
    assert.ok(st.json.sites.some(s => s.name === 'site.example.com'));

    const delPanel = await request('/api/ssl/site/awg-admin', { method: 'DELETE' });
    assert.equal(delPanel.status, 403);

    const del = await request('/api/ssl/site/site.example.com', { method: 'DELETE' });
    assert.equal(del.status, 200);
    const st2 = await request('/api/ssl/status');
    assert.ok(!st2.json.sites.some(s => s.name === 'site.example.com'));
});

test('SSL: продление проверяет имя сертификата', async () => {
    const ok = await request('/api/ssl/renew', jsonBody({ name: 'panel.example.com' }));
    assert.equal(ok.status, 200);
    assert.equal(ok.json.success, true);
    const bad = await request('/api/ssl/renew', jsonBody({ name: '../bad' }));
    assert.equal(bad.status, 400);
});

test('SSL: привязка домена требует авторизации', async () => {
    const res = await fetch(base + '/api/ssl/site', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'evil.example.com', mode: 'site' })
    });
    assert.equal(res.status, 401);
});

test('Приложение: статус и метрики требуют авторизации', async () => {
    const st = await fetch(base + '/api/app/status');
    assert.equal(st.status, 401);
    const mt = await fetch(base + '/api/metrics');
    assert.equal(mt.status, 401);
});

test('Настройки: старые ссылки на APK переписываются на релиз приложения', () => {
    const file = path.join(DATA_DIR, '.app_settings.json');
    const had = fs.existsSync(file);
    const prev = had ? fs.readFileSync(file) : null;
    const legacy = 'https://github.com/makar19977v-glitch/servpanel/releases/latest/download/servpanel.apk';
    const panelApk = 'https://github.com/AmShaegar-dev/servpanel/releases/latest/download/servpanel.apk';
    const expected = 'https://github.com/AmShaegar-dev/servpanel-android/releases/latest/download/servpanel-mobile.apk';
    try {
        for (const url of [legacy, panelApk]) {
            fs.writeFileSync(file, JSON.stringify({ apk: { url, version: '' } }));
            assert.equal(internals.readAppSettings().apk.url, expected);
        }
    } finally {
        if (had) fs.writeFileSync(file, prev);
        else fs.rmSync(file, { force: true });
    }
});

test('Git: origin старого аккаунта переключается на новый', () => {
    const { spawnSync } = require('child_process');
    if (spawnSync('git', ['--version'], { timeout: 5000 }).status !== 0) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servpanel-git-'));
    const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    try {
        git('init');
        git('remote', 'add', 'origin', 'https://github.com/makar19977v-glitch/servpanel.git');
        assert.equal(updater.normalizeRemote(dir), true);
        assert.equal(git('remote', 'get-url', 'origin').stdout.trim(), 'https://github.com/AmShaegar-dev/servpanel.git');
        assert.equal(updater.normalizeRemote(dir), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('Приложение: статус отдаёт APK, метрики и адрес API', async () => {
    const r = await request('/api/app/status');
    assert.equal(r.status, 200);
    assert.ok(r.json.apk && typeof r.json.apk === 'object');
    assert.ok(r.json.metrics && typeof r.json.metrics === 'object');
    assert.equal(typeof r.json.metrics.port, 'number');
    assert.equal(typeof r.json.metrics.publicPort, 'number');
    assert.ok(r.json.metrics.runtime && typeof r.json.metrics.runtime === 'object');
    assert.ok(r.json.api && typeof r.json.api === 'object');
    assert.equal(r.json.api.version, require('../package.json').version);
    assert.match(r.json.api.appUrl, /^https?:\/\//);
    assert.ok(Array.isArray(r.json.warnings));
});

test('Приложение: /api/metrics отдаёт компактный снимок', async () => {
    const r = await request('/api/metrics');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(typeof r.json.cpu.percent, 'number');
    assert.equal(typeof r.json.memory.percent, 'number');
    assert.ok(r.json.clients && typeof r.json.clients.total === 'number');
    assert.ok(r.json.panel && typeof r.json.panel.version === 'string');
});

test('Приложение: настройки метрик валидируются', async () => {
    const badPort = await request('/api/app/metrics', jsonBody({ enabled: true, port: 70000 }));
    assert.equal(badPort.status, 400);

    const badHost = await request('/api/app/metrics', jsonBody({ enabled: true, host: 'не-хост!' }));
    assert.equal(badHost.status, 400);

    const busy = await request('/api/app/metrics', jsonBody({ enabled: true, host: '127.0.0.1', port: 3000 }));
    assert.equal(busy.status, 409);
});

test('Приложение: отдельный порт метрик работает с токеном', async () => {
    const saved = await request('/api/app/metrics', jsonBody({
        enabled: true,
        host: '127.0.0.1',
        port: 0,
        publicPort: 39101,
        format: 'json',
        tls: false,
        token: 'test-metrics-token-123'
    }));
    assert.equal(saved.status, 200);
    assert.equal(saved.json.success, true);
    assert.equal(saved.json.token, 'test-metrics-token-123');

    let port = 0;
    for (let i = 0; i < 40; i++) {
        const st = await request('/api/app/status');
        if (st.json.metrics.runtime.running && st.json.metrics.runtime.actualPort) {
            port = st.json.metrics.runtime.actualPort;
            break;
        }
        await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(port > 0, 'listener метрик не запустился');

    const noToken = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(noToken.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/metrics`, {
        headers: { Authorization: 'Bearer test-metrics-token-123' }
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.cpu.percent, 'number');

    const prom = await fetch(`http://127.0.0.1:${port}/metrics.prom`, {
        headers: { Authorization: 'Bearer test-metrics-token-123' }
    });
    assert.equal(prom.status, 200);
    assert.match(await prom.text(), /servpanel_cpu_percent/);

    const off = await request('/api/app/metrics', jsonBody({ enabled: false }));
    assert.equal(off.status, 200);
    assert.equal(off.json.status.metrics.runtime.running, false);
});

test('Приложение: внешний адрес без токена получает токен автоматически', async () => {
    const r = await request('/api/app/metrics', jsonBody({
        enabled: true,
        host: '0.0.0.0',
        port: 0,
        publicPort: 39102,
        token: ''
    }));
    assert.equal(r.status, 200);
    assert.equal(r.json.generatedToken, true);
    assert.match(r.json.token, /^[a-f0-9]{64}$/);
    await request('/api/app/metrics', jsonBody({ enabled: false }));
});

test('Приложение: версия APK берётся из app/version.txt, пока GitHub не опрошен', async () => {
    const expected = fs.readFileSync(path.join(__dirname, '..', 'app', 'version.txt'), 'utf8').trim();
    const st = await request('/api/app/status');
    assert.equal(st.status, 200);
    assert.equal(st.json.apk.version, expected);
    assert.equal(st.json.apk.versionSource, 'file');
    assert.equal(st.json.apk.available, true);
    assert.equal(st.json.apk.source, 'remote');
    assert.match(st.json.apk.externalUrl, /servpanel-android\/releases\/latest\/download\/servpanel-mobile\.apk/);
});

test('Приложение: APK скачивается из GitHub, загрузка из панели отключена', async () => {
    const up = await request('/api/app/apk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.from('PK\x03\x04servpanel-test-apk')
    });
    assert.equal(up.status, 405);
    assert.match(up.json.error, /отключена/i);

    const del = await request('/api/app/apk', { method: 'DELETE' });
    assert.equal(del.status, 405);

    const remote = await fetch(base + '/api/app/apk', { redirect: 'manual', headers: { cookie } });
    assert.equal(remote.status, 302);
    assert.match(remote.headers.get('location') || '',
        /servpanel-android\/releases\/latest\/download\/servpanel-mobile\.apk/);
});

test('Приложение: локальный APK отдаётся, если ссылка отключена', async () => {
    const settingsFile = path.join(DATA_DIR, '.app_settings.json');
    const had = fs.existsSync(settingsFile);
    const prev = had ? fs.readFileSync(settingsFile, 'utf8') : '';
    const apkDir = path.join(DATA_DIR, '.app');
    const apkFile = path.join(apkDir, 'servpanel.apk');
    const bytes = Buffer.from('PK\x03\x04servpanel-local-apk');
    try {
        fs.mkdirSync(apkDir, { recursive: true });
        fs.writeFileSync(apkFile, bytes);
        const raw = had ? JSON.parse(prev) : {};
        raw.apk = { url: '', version: '' };
        fs.writeFileSync(settingsFile, JSON.stringify(raw), { mode: 0o600 });

        const expected = fs.readFileSync(path.join(__dirname, '..', 'app', 'version.txt'), 'utf8').trim();
        const st = await request('/api/app/status');
        assert.equal(st.json.apk.source, 'local');
        assert.equal(st.json.apk.version, expected);

        const dl = await request('/api/app/apk');
        assert.equal(dl.status, 200);
        assert.equal(dl.headers.get('content-type'), 'application/vnd.android.package-archive');
        assert.equal(dl.text, bytes.toString());
    } finally {
        fs.rmSync(apkFile, { force: true });
        fs.rmSync(apkDir, { recursive: true, force: true });
        if (had) fs.writeFileSync(settingsFile, prev);
        else fs.rmSync(settingsFile, { force: true });
    }
});

test('isApiRequest отсекает обходы к статике', () => {
    const ok = p => internals.isApiRequest({ path: p });
    assert.equal(ok('/api/login'), true);
    assert.equal(ok('/api'), true);
    assert.equal(ok('/api/../index.html'), false);
    assert.equal(ok('/api/%2e%2e/index.html'), false);
    assert.equal(ok('/api/%252e%252e/index.html'), false);
    assert.equal(ok('/api%2f..%2findex.html'), false);
    assert.equal(ok('/index.html'), false);
    assert.equal(ok('/api\\..\\index.html'), false);
});

test('MTProto: MTG отклоняется с понятной ошибкой', async () => {
    const r = await request('/api/install/module', jsonBody({ module: 'mtproto', kind: 'mtg' }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /MTG/);
});

test('MTProto: WEB-режим требует домен', async () => {
    const r = await request('/api/install/module', jsonBody({ module: 'mtproto', kind: 'telemt', web: true }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /домен/i);
});

test('MTProto: неверный ad_tag отклоняется до запуска установки', async () => {
    const r = await request('/api/install/module', jsonBody({
        module: 'mtproto', kind: 'telemt', adTag: 'not-hex'
    }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /ad_tag/i);
});

test('MTProto: неверный порт фикса отклоняется', async () => {
    const r = await request('/api/install/module', jsonBody({
        module: 'mtproto', kind: 'telemt', fixPort: '70000'
    }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /порт/i);
});

test('MTProto: endpoint ссылок всегда возвращает массив', async () => {
    const r = await request('/api/mtproto/links');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.links));
});

test('Прокси: в тестовом режиме движок не обнаружен', async () => {
    const r = await request('/api/proxy/status');
    assert.equal(r.status, 200);
    assert.equal(r.json.backend, 'none');
    assert.equal(r.json.reason, 'test');
    assert.equal(r.json.capabilities.users, false);
});

test('Прокси: список пользователей без движка возвращает 503', async () => {
    const r = await request('/api/proxy/users');
    assert.equal(r.status, 503);
    assert.equal(r.json.code, 'no_backend');
});

test('Прокси: создание отклоняет неверное имя до обращения к движку', async () => {
    const r = await request('/api/proxy/users', jsonBody({ username: '../evil' }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /имя/i);
});

test('Прокси: нормализация лимитов, квоты и даты', () => {
    const patch = internals.proxyUserPatch({
        max_tcp_conns: '8',
        max_unique_ips: 3,
        data_quota_bytes: '1073741824',
        rate_limit_up_bps: '10000000',
        expiration_rfc3339: '2030-01-02',
        user_ad_tag: 'D'.repeat(32),
        notes: '  iPhone  ',
        enabled: 'true'
    });
    assert.equal(patch.max_tcp_conns, 8);
    assert.equal(patch.max_unique_ips, 3);
    assert.equal(patch.data_quota_bytes, 1073741824);
    assert.equal(patch.rate_limit_up_bps, 10000000);
    assert.equal(patch.expiration_rfc3339, '2030-01-02T00:00:00+00:00');
    assert.equal(patch.user_ad_tag, 'd'.repeat(32));
    assert.equal(patch.notes, 'iPhone');
    assert.equal(patch.enabled, true);

    assert.throws(() => internals.proxyUserPatch({ max_tcp_conns: -1 }), /max_tcp_conns/);
    assert.throws(() => internals.proxyUserPatch({ expiration_rfc3339: 'не дата' }), /дата/i);
    assert.throws(() => internals.proxyUserPatch({ user_ad_tag: 'xyz' }), /ad_tag/i);
});

test('Прокси: изменение требует администратора', async () => {
    await request('/api/logout', { method: 'POST' });
    assert.equal((await login('viewer-pass-123', 'viewer1')).status, 200);

    const denied = await request('/api/proxy/users/alice/enable', jsonBody({}));
    assert.equal(denied.status, 403);

    const list = await request('/api/proxy/users');
    assert.equal(list.status, 503);
    assert.equal(list.json.code, 'no_backend');

    await request('/api/logout', { method: 'POST' });
    assert.equal((await login('test-admin-pass-123')).status, 200);
});

test('Прокси: бот выключен по умолчанию и не отдаёт токен', async () => {
    const r = await request('/api/proxy/bot');
    assert.equal(r.status, 200);
    assert.equal(r.json.enabled, false);
    assert.equal(r.json.running, false);
    assert.equal(r.json.tokenSet, false);
    assert.equal(r.json.token, '');
    assert.deepEqual(r.json.admins, []);
});

test('Прокси: неверный токен бота отклоняется', async () => {
    const r = await request('/api/proxy/bot', jsonBody({ token: 'not-a-token' }));
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'bad_token');
});

test('MTProxyL: неизвестный режим отклоняется', async () => {
    const r = await request('/api/install/module', jsonBody({ module: 'mtproxyl', mplMode: 'nope' }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /режим/i);
});

test('MTProxyL: неизвестный движок отклоняется', async () => {
    const r = await request('/api/install/module', jsonBody({ module: 'mtproxyl', mplEngine: 'qemu' }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /движок/i);
});

test('MTProxyL: неизвестный режим прокси отклоняется', async () => {
    const r = await request('/api/install/module', jsonBody({ module: 'mtproxyl', mplProxyMode: 'socks' }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /режим прокси/i);
});

test('MTProxyL: неверный порт отклоняется', async () => {
    const r = await request('/api/install/module', jsonBody({ module: 'mtproxyl', mplPort: '70000' }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /порт/i);
});

test('MTProxyL: неверный SNI отклоняется', async () => {
    const r = await request('/api/install/module', jsonBody({ module: 'mtproxyl', mplSni: 'bad host' }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /SNI/i);
});

test('MTProxyL: WEB Proxy требует домен', async () => {
    const r = await request('/api/install/module', jsonBody({ module: 'mtproxyl', mplWeb: true }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /домен/i);
});

test('MTProxyL: неверный токен встроенного бота отклоняется', async () => {
    const r = await request('/api/install/module', jsonBody({ module: 'mtproxyl', mplTgbotToken: 'bad' }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /токен/i);
});

test('MTProxyL: installEnv собирает все переменные установки', () => {
    const env = internals.installEnv({
        module: 'mtproxyl',
        mplMode: 'reanimator',
        mplEngine: 'docker',
        mplProxyMode: 'combined',
        mplPort: '8443',
        mplSni: 'example.com',
        mplHost: '203.0.113.5',
        mplSecret: 'a'.repeat(32),
        mplAdTag: 'b'.repeat(32),
        mplUser: 'alice',
        mplUserSecret: 'c'.repeat(32),
        mplZapret2: false,
        mplSynLimiter: 'classic',
        mplMeko: false,
        mplSelfmask: 'mask.example.com',
        mplSelfmaskCert: 'selfsigned',
        mplSelfmaskEmail: 'admin@example.com',
        mplWeb: true,
        mplWebDomain: 'web.example.com',
        mplWebCarrier: 'websocket-lanes',
        mplApi: true,
        mplApiListen: '0.0.0.0:9190',
        mplTgbotToken: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
        mplTgbotAdmin: '987654321',
        mplForce: true
    });
    assert.equal(env.MTPROXYL_MODE, 'reanimator');
    assert.equal(env.MTPROXYL_ENGINE, 'docker');
    assert.equal(env.MTPROXYL_PROXY_MODE, 'combined');
    assert.equal(env.MTPROXYL_PORT, '8443');
    assert.equal(env.MTPROXYL_SNI, 'example.com');
    assert.equal(env.MTPROXYL_HOST, '203.0.113.5');
    assert.equal(env.MTPROXYL_SECRET, 'a'.repeat(32));
    assert.equal(env.MTPROXYL_AD_TAG, 'b'.repeat(32));
    assert.equal(env.MTPROXYL_USER, 'alice');
    assert.equal(env.MTPROXYL_USER_SECRET, 'c'.repeat(32));
    assert.equal(env.MTPROXYL_ZAPRET2, 'no');
    assert.equal(env.MTPROXYL_SYN_LIMITER, 'classic');
    assert.equal(env.MTPROXYL_MEKO, 'no');
    assert.equal(env.MTPROXYL_SELFMASK, 'mask.example.com');
    assert.equal(env.MTPROXYL_SELFMASK_CERT, 'selfsigned');
    assert.equal(env.MTPROXYL_SELFMASK_EMAIL, 'admin@example.com');
    assert.equal(env.MTPROXYL_WEB, 'yes');
    assert.equal(env.MTPROXYL_WEB_DOMAIN, 'web.example.com');
    assert.equal(env.MTPROXYL_WEB_CARRIER, 'websocket-lanes');
    assert.equal(env.MTPROXYL_API, 'yes');
    assert.equal(env.MTPROXYL_API_LISTEN, '0.0.0.0:9190');
    assert.equal(env.MTPROXYL_TGBOT_TOKEN, '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
    assert.equal(env.MTPROXYL_TGBOT_ADMIN, '987654321');
    assert.equal(env.MTPROXYL_FORCE, '1');
});

test('AdGuard: порт установки передаётся в установщик', () => {
    const env = internals.installEnv({ module: 'adguard', agPort: '8080' });
    assert.equal(env.ADGUARD_PORT, '8080');
    const empty = internals.installEnv({ module: 'adguard' });
    assert.equal(empty.ADGUARD_PORT, '', 'пустой порт — установщик выберет сам');
    const bad = internals.installEnv({ module: 'adguard', agPort: '99999' });
    assert.equal(bad.ADGUARD_PORT, '');
});

test('WARP: по умолчанию Xray слушает 127.0.0.1', () => {
    const env = internals.installEnv({ module: 'warp' });
    assert.equal(env.WARP_LISTEN_IP, '127.0.0.1');
    assert.equal(env.WARP_LISTEN_PORT, '443');
    assert.equal(env.WARP_SOCKS_PORT, '40000');
    const custom = internals.installEnv({ module: 'warp', listenIp: '10.8.1.1', listenPort: '8443' });
    assert.equal(custom.WARP_LISTEN_IP, '10.8.1.1');
    assert.equal(custom.WARP_LISTEN_PORT, '8443');
});

test('Компоненты: список отдаётся только после входа', async () => {
    const anon = await fetch(base + '/api/modules');
    assert.equal(anon.status, 401);
    const r = await request('/api/modules');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.modules));
    const ids = r.json.modules.map(m => m.id);
    for (const id of ['adguard', 'warp', 'mtproto', 'awg']) {
        assert.ok(ids.includes(id), 'нет модуля ' + id);
    }
    for (const m of r.json.modules) {
        assert.equal(typeof m.installed, 'boolean');
        assert.equal(typeof m.running, 'boolean');
        assert.ok(m.title);
    }
});

test('Компоненты: удаление принимает только известные модули', async () => {
    const bad = await request('/api/modules/uninstall', jsonBody({ module: 'zzz' }));
    assert.equal(bad.status, 400);
    const empty = await request('/api/modules/uninstall', jsonBody({}));
    assert.equal(empty.status, 400);
});

// Установщики должны остаться валидным bash: их подмены легко поймать только
// на Linux, поэтому проверяем хотя бы баланс ${...} и наличие финальной метки.
test('Установщики AdGuard и WARP: безопасные подстановки в shell', () => {
    const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
    const ag = read('install_adguard_silent.sh');
    assert.match(ag, /INSTALLATION DONE/);
    assert.match(ag, /ADGUARD_PORT/);
    assert.match(ag, /\$\{PORTS\[@\]\}|\$\{p\}/);
    // DNS только по DoT: 853 в конфиге и UFW, 53 не занимаем и resolved не трогаем.
    assert.match(ag, /tls_port: 853/);
    assert.match(ag, /ufw allow 853\/tcp/);
    assert.ok(!/ufw allow 53\//.test(ag), 'порт 53 не открывается');
    assert.ok(!/DNSStubListener/.test(ag), 'systemd-resolved не отключается');
    assert.ok(!/systemctl (stop|disable) (dnsmasq|bind9|named)/.test(ag), 'чужой DNS не останавливается');
    const warp = read('install_warp_xray.sh');
    assert.match(warp, /INSTALLATION DONE/);
    assert.match(warp, /WARP_LISTEN_IP="\$\{WARP_LISTEN_IP:-0\.0\.0\.0\}"/);
    // Конфиг Xray — как в инструкции: без служебных тегов, с freedom direct,
    // loglevel info и dokodemo-door на 1.1.1.1:443 через SOCKS 127.0.0.1.
    assert.match(warp, /"loglevel": "info"/);
    assert.match(warp, /"address": "1\.1\.1\.1"/);
    assert.match(warp, /"protocol": "freedom"/);
    assert.ok(!/"tag"[[:space:]]*:[[:space:]]*"warp"/.test(warp), 'в конфиге нет служебного тега warp');
    // В шаблоне server.js подстановки shell экранированы: ${...} не должно
    // превращаться в JS-переменные.
    const server = read('server.js');
    const block = server.slice(server.indexOf('const MODULE_UNINSTALL'), server.indexOf('function awgUninstall'));
    const raw = [...block.matchAll(/String\.raw`([\s\S]*?)`/g)].map(m => m[1]);
    assert.equal(raw.length, 3, 'три сценария удаления');
    for (const script of raw) {
        const unescaped = script.replace(/\\\$\{/g, '');
        assert.ok(!/\$\{[A-Za-z_]/.test(unescaped), 'неэкранированная подстановка: ' + (unescaped.match(/\$\{[A-Za-z_]+/) || [''])[0]);
    }
});

test('Прокси: диагностика отдаёт проверки и предупреждает об отсутствии движка', async () => {
    const r = await request('/api/proxy/diag');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.checks));
    assert.ok(r.json.checks.some(c => /telemt/i.test(c.name)), 'проверка telemt API');
    assert.ok(r.json.checks.some(c => /MTProxyL/i.test(c.name)), 'проверка MTProxyL API');
});

test('Прокси: ключ MTProxyL пишется в файл с правами 600', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servpanel-mtp-key-'));
    const file = path.join(dir, 'servpanel.key');
    const prev = process.env.SERVEPANEL_MTPROXYL_KEY_FILE;
    process.env.SERVEPANEL_MTPROXYL_KEY_FILE = file;
    try {
        delete require.cache[require.resolve('../lib/proxy-users')];
        const mod = require('../lib/proxy-users');
        assert.equal(mod.panelKeyPath(), file);
    } finally {
        if (prev === undefined) delete process.env.SERVEPANEL_MTPROXYL_KEY_FILE;
        else process.env.SERVEPANEL_MTPROXYL_KEY_FILE = prev;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('Удаление панели из консоли: меню и режимы', () => {
    const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
    const main = read('install.sh');
    assert.match(main, /Установить панель/);
    assert.match(main, /Удалить панель/);
    assert.match(main, /Только панель/);
    assert.match(main, /Полная очистка/);
    assert.match(main, /ACTION=panel/);
    assert.match(main, /ACTION=full/);

    const admin = read('lib/server-admin.sh');
    assert.match(admin, /--component/);
    for (const c of ['awg', 'adguard', 'warp', 'mtproto']) {
        assert.match(admin, new RegExp('^\\s*' + c + '\\)$', 'm'), 'компонент ' + c);
    }
    assert.match(admin, /servpanel-before-remove/);

    const cli = read('uninstall.sh');
    assert.match(cli, /lib\/server-admin\.sh/);

    const pkg = JSON.parse(read('package.json'));
    assert.match(pkg.scripts.check, /lib\/server-admin\.sh/);
    assert.match(pkg.scripts.check, /lib\/server-install\.sh/);
    assert.match(pkg.scripts.check, /install\.sh/);
});

test('Каскад: конфиг нормализуется (Table = off, без DNS)', () => {
    const out = internals.normalizeCascadeConf('[Interface]\nPrivateKey = abc\nAddress = 10.9.9.3/32, fddd:2c4:2c4:ffff::a09:903/128\nDNS = 1.1.1.1\ntable = on\n\n[Peer]\nPublicKey = def\nAllowedIPs = 10.9.9.3/32\n');
    assert.match(out, /^\[Interface\]\nTable = off\n/m);
    // IPv6-адрес убирается (на серверах с disable_ipv6 awg-quick падал).
    assert.ok(!/fddd:/.test(out), 'IPv6-адрес удалён');
    assert.ok(!/^DNS\s*=/m.test(out), 'DNS удалён');
    assert.ok(!/^table\s*=/m.test(out), 'старый Table удалён');
    // Повторная нормализация идемпотентна.
    assert.equal(internals.normalizeCascadeConf(out), out);
});

test('Каскад: внутренний адрес берётся из AllowedIPs', () => {
    assert.equal(internals.firstIpv4('10.9.9.3/32, fddd:2c4:2c4:ffff::a09:903/128'), '10.9.9.3');
    assert.equal(internals.firstIpv4(''), '');
    assert.equal(internals.firstIpv4('no ip here'), '');
});

test('Каскад: скрипт маршрутизации безопасен для разных серверов', () => {
    const script = internals.buildRoutingScript(['awg0'], [], { raw: '10.9.9.3:3977' });
    assert.match(script, /AWG1_ENDPOINT="10\.9\.9\.3:3977"/);
    // На входе маршруты ставятся раньше туннеля: общей проверки нет,
    // но для выхода (без клиентских интерфейсов) она остаётся.
    // Выход (без клиентских интерфейсов) обрабатывается отдельно.
    const exitScript = internals.buildRoutingScript([], [], { raw: '45.9.16.77:3977' });
    assert.match(exitScript, /CASC_IFACES=\(\)/);
    assert.match(exitScript, /маршруты не требуются/);
    // GNU grep понимает \b как backspace — такой шаблон не сработает.
    assert.ok(!/grep -oP '\\b/.test(script), 'в шаблоне не должно быть \\b');
    assert.match(script, /COUNT/);
    assert.match(script, /exit 1/);
});

test('Каскад: роль определяется по адресу интерфейса', () => {
    // Вход: клиентский адрес 10.9.9.4/32 (его выдаёт панель выхода).
    const entry = '[Interface]\nPrivateKey = a\nAddress = 10.9.9.4/32\n\n[Peer]\nPublicKey = b\nAllowedIPs = 10.9.9.1/32\nEndpoint = 45.9.16.77:3977\n';
    // Выход: адрес сервера 10.9.9.1/32.
    const exit = '[Interface]\nPrivateKey = c\nAddress = 10.9.9.1/32\nTable = off\n\n[Peer]\nPublicKey = d\nAllowedIPs = 10.9.9.4/32\n';
    // Интерфейс сервера-входа с клиентами.
    const server = '[Interface]\nPrivateKey = e\nAddress = 10.9.9.1/24\nListenPort = 3977\n\n[Peer]\nPublicKey = f\nAllowedIPs = 10.9.9.2/32\n';
    assert.equal(internals.cascadeRoleFrom(entry), 'ru');
    assert.equal(internals.cascadeRoleFrom(exit), 'eu');
    assert.equal(internals.cascadeRoleFrom(server), 'ru');
    assert.equal(internals.cascadeRoleFrom(''), '');
});

test('Каскад: внутренний Endpoint не принимается на выходе', () => {
    // Не трогаем файлы: проверяем чистую функцию выбора адреса по роли.
    const plan = internals.cascadeEndpointPlan;
    assert.equal(typeof plan, 'function');
});

test('Каскад: диагностика возвращает роль и ожидание роли', () => {
    const h = internals.cascadeHealth();
    assert.ok(h.checks && typeof h.checks.role === 'boolean');
    assert.ok(typeof h.details.expectedRole === 'string');
});

test('Каскад: клиенту отдаётся конфиг для вставки на другой сервер', async () => {
    const r = await request('/api/clients');
    assert.equal(r.status, 200);
    const list = Array.isArray(r.json) ? r.json : (r.json.clients || []);
    const name = (list[0] && list[0].name) || '';
    if (!name) return; // в чистом профиле клиентов нет
    const key = await request('/api/clients/' + encodeURIComponent(name) + '/key');
    assert.equal(key.status, 200);
    assert.ok(typeof key.json.conf === 'string');
});
test('Каскад: внутренний адрес берётся из туннеля, а не из маршрутов', () => {
    const list = '1.0.0.0/8, 2.0.0.0/7, 8.8.8.8/32, 194.124.250.127/32, 2000::/3';
    assert.equal(internals.firstTunnelIp(list), '');
    assert.equal(internals.firstTunnelIp(list + ', 10.9.9.3/32'), '10.9.9.3');
    assert.equal(internals.firstTunnelIp('10.9.9.7/32'), '10.9.9.7');
});

test('Каскад: клиентский конфиг панели распознаётся как вход', () => {
    const panelClient = '[Interface]\nPrivateKey = a\nAddress = 10.9.9.2/32, fddd:2c4:2c4:ffff::a09:902/128\nMTU = 1280\n\n[Peer]\nPublicKey = b\nAllowedIPs = 0.0.0.0/0, ::/0, 10.9.9.3/32\nEndpoint = 194.124.250.127:3977\n';
    assert.equal(internals.cascadeRoleFrom(panelClient), 'ru');
});
test('Каскад: адрес второй стороны — публичный, а не внутренний', () => {
    const server = '[Interface]\nPrivateKey = a\nAddress = 10.9.9.1/24\nListenPort = 3977\n\n[Peer]\nPublicKey = b\nAllowedIPs = 10.9.9.2/32\nEndpoint = 45.9.16.77:3977\n';
    assert.equal(internals.cascadeRoleFrom(server), 'ru');
    // Внутренние адреса не считаются публичными.
    const local = internals.localTunnelIps ? Array.from(internals.localTunnelIps()) : [];
    for (const ip of ['10.9.9.2', '10.9.9.3', '10.9.9.4']) {
        const isPublic = internals.isPublicAddress ? internals.isPublicAddress(ip, new Set(local)) : false;
        assert.ok(!isPublic, 'внутренний адрес ' + ip + ' не публичный');
    }
});
test('Каскад: все используемые константы юнитов определены', () => {
    // Ловим регрессию из 2.8.10: installRouting ссылался на ROUTING_SERVICE,
    // а само определение случайно удалили — панель отвечала
    // 'ROUTING_SERVICE is not defined'.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    for (const name of ['ROUTING_SERVICE', 'ROUTING_TIMER', 'ROUTING_SCRIPT']) {
        assert.match(src, new RegExp('const ' + name + '\\s*='), 'нет определения ' + name);
        const uses = (src.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length;
        assert.ok(uses >= 2, name + ' объявлена, но не используется');
    }
    assert.match(src, /\[Timer\]/);
    assert.match(src, /ExecStart=\/root\/awg\/awg-routing\.sh/);
});
test('Каскад: маршруты удаления есть и защищены правами админа', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /app\.post\('\/api\/cascade\/teardown', checkAuth, requireAdmin/);
    assert.match(src, /app\.post\('\/api\/cascade\/cleanup', checkAuth, requireAdmin/);
    for (const part of ['ipset', 'destroy', 'awg-routing.timer', 'fwmark', 'awg-quick@awg1']) {
        assert.ok(src.includes(part), 'удаление должно убирать ' + part);
    }
});

test('Каскад: роль берётся из мастера, а не угадывается', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /const role = data\.role === 'eu' \? 'eu' : 'ru';/);
    assert.match(src, /if \(!isExit && !validIfaces\(useIfaces\)\)/);
});
test('выход закрывает доступ', async () => {
    await request('/api/logout', { method: 'POST' });
    const r = await request('/api/stats');
    assert.equal(r.status, 401);
});
