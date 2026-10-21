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

test('выход закрывает доступ', async () => {
    await request('/api/logout', { method: 'POST' });
    const r = await request('/api/stats');
    assert.equal(r.status, 401);
});
