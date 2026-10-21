#!/usr/bin/env node
/*
 * update-worker.js — отдельный процесс обновления панели.
 *
 * Запускается из server.js через spawn(detached). Живёт дольше панели,
 * поэтому переживает `pm2 restart` и умеет:
 *   - проверить и распаковать релиз;
 *   - поставить зависимости во временный каталог;
 *   - запустить новую панель на копии данных и отдельном порту;
 *   - сделать бэкап;
 *   - заменить код, не трогая данные;
 *   - перезапустить pm2, проверить панель;
 *   - при ошибке откатиться из бэкапа.
 *
 * Режимы: apply (файл/URL), git, rollback.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Аргументы
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = {};
for (let i = 0; i < argv.length; i++) {
    const m = /^--([^=]+)=([\s\S]*)$/.exec(argv[i]);
    if (m) arg[m[1]] = m[2];
}

const MODE = arg.mode || 'apply';
const APP_DIR = path.resolve(arg.app || '/root/servpanel');
const DATA_DIR = path.resolve(arg.data || APP_DIR);
const PM2_NAME = arg.pm2 || 'awg-admin';
const PM2_BIN = process.env.PM2_BIN || (fs.existsSync('/usr/local/bin/pm2') ? '/usr/local/bin/pm2' : 'pm2');
const PANEL_PORT = parseInt(arg.port, 10) || 3000;
const STATUS_FILE = path.resolve(arg.status || path.join(DATA_DIR, '.update_status.json'));
const LOG_FILE = path.resolve(arg.log || '/var/log/servpanel_update.log');
const LOCK_FILE = path.resolve(arg.lock || path.join(DATA_DIR, '.update.lock'));
const BACKUP_DIR = path.resolve(arg.backupDir || process.env.SERVEPANEL_BACKUP_DIR || '/root/backups');
const APP_BASE = path.basename(APP_DIR);
const APP_PARENT = path.dirname(APP_DIR);

const DATA_FILES = [
    'admin_pass.txt', '.secrets.json', '.users.json', '.obf_profiles.json',
    '.notify.json', '.backup.json', '.backup_pass', '.install_state.json'
];
const FORBIDDEN_IN_RELEASE = new Set([
    'admin_pass.txt', '.secrets.json', '.users.json', '.obf_profiles.json',
    '.notify.json', '.backup.json', '.backup_pass', '.install_state.json',
    '.panel_port', '.panel_public_port', '.sessions', '.git'
]);
const SKIP_COPY = new Set(['upgrade.sh', 'release.json', 'manifest.json', 'node_modules']);
let APPLY_WORK = '';

// ---------------------------------------------------------------------------
// Статус и лог
// ---------------------------------------------------------------------------
const state = {
    running: true,
    ok: false,
    mode: MODE,
    step: 'start',
    message: 'Подготовка',
    progress: 0,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    fromVersion: readVersion(APP_DIR) || '',
    toVersion: '',
    backup: '',
    rolledBack: false,
    error: '',
    log: []
};

function ensureDir(dir, mode = 0o700) {
    try { fs.mkdirSync(dir, { recursive: true, mode }); } catch (e) { /* ignore */ }
}

function readVersion(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || ''; }
    catch (e) { return ''; }
}

function writeAtomic(file, text, mode = 0o600) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text, { mode });
    fs.renameSync(tmp, file);
}

function persist() {
    try {
        ensureDir(path.dirname(STATUS_FILE), 0o700);
        writeAtomic(STATUS_FILE, JSON.stringify(state, null, 2), 0o600);
    } catch (e) { /* не роняем обновление из-за статуса */ }
}

function log(line) {
    const text = String(line == null ? '' : line);
    const row = `[${new Date().toISOString()}] ${text}`;
    state.log.push(row);
    if (state.log.length > 160) state.log.splice(0, state.log.length - 160);
    try {
        ensureDir(path.dirname(LOG_FILE), 0o700);
        fs.appendFileSync(LOG_FILE, row + '\n', { mode: 0o600 });
    } catch (e) { /* ignore */ }
    try { process.stdout.write(row + '\n'); } catch (e) { /* ignore */ }
    persist();
}

function setStep(step, message, progress) {
    state.step = step;
    state.message = message;
    if (progress !== undefined) state.progress = progress;
    log(`[${step}] ${message}`);
}

function finish(ok, error) {
    state.running = false;
    state.ok = !!ok;
    state.finishedAt = new Date().toISOString();
    if (error) state.error = String(error.message || error);
    if (ok) state.progress = 100;
    persist();
    try { fs.unlinkSync(LOCK_FILE); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------
function run(cmd, args, opts = {}) {
    const res = spawnSync(cmd, args, {
        encoding: 'utf8',
        timeout: opts.timeout || 180000,
        maxBuffer: opts.maxBuffer || 64 * 1024 * 1024,
        cwd: opts.cwd,
        env: opts.env || process.env,
        shell: !!opts.shell,
        windowsHide: true
    });
    const out = String(res.stdout || '').trim();
    const err = String(res.stderr || '').trim();
    if (res.error) throw new Error(`${cmd}: ${res.error.message}`);
    if (res.status !== 0) {
        throw new Error(`${cmd} ${args.join(' ')} (код ${res.status}): ${(err || out).slice(-2500)}`);
    }
    return out;
}

function runMaybe(cmd, args, opts = {}) {
    try { return { ok: true, out: run(cmd, args, opts) }; }
    catch (e) { return { ok: false, out: String(e.message || e) }; }
}

function pm2(args, env) {
    const shell = process.platform === 'win32' && !/\.exe$/i.test(PM2_BIN);
    return run(PM2_BIN, args, { timeout: 90000, shell, env: env || process.env });
}

function pm2Restart() {
    // Не передаём --update-env: воркер запущен через systemd-run с
    // минимальным окружением, и --update-env затёр бы PANEL_PORT,
    // SERVEPANEL_DATA_DIR и другие переменные панели. Без флага pm2
    // сохраняет окружение, с которым панель работала до обновления.
    const shell = process.platform === 'win32' && !/\.exe$/i.test(PM2_BIN);
    const r = runMaybe(PM2_BIN, ['restart', PM2_NAME], { timeout: 90000, shell });
    if (r.ok) return;
    log('pm2 restart не сработал, пробую pm2 start: ' + r.out.slice(-500));
    const env = {
        ...process.env,
        SERVEPANEL_DATA_DIR: DATA_DIR,
        SERVEPANEL_PM2_NAME: PM2_NAME,
        PANEL_PORT: String(PANEL_PORT)
    };
    if (BACKUP_DIR) env.SERVEPANEL_BACKUP_DIR = BACKUP_DIR;
    pm2(['start', path.join(APP_DIR, 'server.js'), '--name', PM2_NAME, '--update-env'], env);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(port, urlPath, timeout = 3000) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', d => { if (body.length < 200000) body += d; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

async function waitPanel(port, timeoutMs, requireMarker = true) {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
        try {
            const r = await httpGet(port, '/');
            if (r.status === 200 && (!requireMarker || /panel-version/.test(r.body))) return true;
            last = 'HTTP ' + r.status;
        } catch (e) { last = e.message; }
        await sleep(500);
    }
    log('Ожидание панели не удалось: ' + last);
    return false;
}

function freePort(preferred) {
    return new Promise(resolve => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', () => resolve(freePort(0)));
        srv.listen(preferred || 0, '127.0.0.1', () => {
            const p = srv.address().port;
            srv.close(() => resolve(p));
        });
    });
}

function copyIfExists(src, dest) {
    try {
        if (!fs.existsSync(src)) return;
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        fs.cpSync(src, dest, { recursive: true, force: true, errorOnExist: false });
    } catch (e) {
        log('Не удалось скопировать ' + src + ': ' + e.message);
    }
}

function copyData(srcDir, destDir) {
    ensureDir(destDir, 0o700);
    for (const f of DATA_FILES) copyIfExists(path.join(srcDir, f), path.join(destDir, f));
    const sessions = path.join(srcDir, '.sessions');
    if (fs.existsSync(sessions)) {
        try { fs.cpSync(sessions, path.join(destDir, '.sessions'), { recursive: true, force: true }); }
        catch (e) { log('Сессии не скопированы: ' + e.message); }
    }
}

function findReleaseRoot(stage) {
    if (fs.existsSync(path.join(stage, 'server.js'))) return stage;
    const entries = fs.readdirSync(stage).filter(n => !n.startsWith('.'));
    if (entries.length === 1) {
        const only = path.join(stage, entries[0]);
        if (fs.existsSync(path.join(only, 'server.js'))) return only;
    }
    throw new Error('В архиве нет server.js (ожидается корень релиза или одна папка с ним)');
}

function assertNoSymlinks(dir) {
    const stack = [dir];
    while (stack.length) {
        const cur = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
        for (const ent of entries) {
            const p = path.join(cur, ent.name);
            const rel = path.relative(dir, p).replace(/\\/g, '/');
            if (ent.isSymbolicLink()) {
                // npm создаёт симлинки в node_modules/.bin на Linux. Они не
                // исполняются панелью и не должны мешать обновлению.
                if (rel.startsWith('node_modules/.bin/')) continue;
                throw new Error('В релизе найден симлинк: ' + p);
            }
            if (ent.isDirectory()) stack.push(p);
        }
    }
}

function validateRelease(root) {
    const required = [
        'server.js', 'package.json', 'public/index.html', 'public/style.css',
        'public/app.js', 'lib/updater.js', 'lib/update-worker.js'
    ];
    for (const f of required) {
        if (!fs.existsSync(path.join(root, f))) throw new Error('В релизе отсутствует ' + f);
    }
    const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
    if (!/name=["']panel-version["']/i.test(indexHtml)) {
        throw new Error('В public/index.html нет метки panel-version — не смогу проверить запуск новой версии');
    }
    for (const bad of FORBIDDEN_IN_RELEASE) {
        if (fs.existsSync(path.join(root, bad))) throw new Error('Релиз содержит файл данных ' + bad + ' — отменяю, чтобы не затереть настройки');
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (!pkg.version) throw new Error('В package.json нет version');
    assertNoSymlinks(root);
    run(process.execPath, ['--check', path.join(root, 'server.js')], { timeout: 30000 });
    run(process.execPath, ['--check', path.join(root, 'public/app.js')], { timeout: 30000 });
    return pkg.version;
}

function extractArchive(archive, stage) {
    if (!fs.existsSync(archive)) throw new Error('Архив не найден: ' + archive);
    const list = run('tar', ['-tzf', archive], { timeout: 120000 }).split(/\r?\n/).filter(Boolean);
    if (!list.length) throw new Error('Архив пустой');
    for (const raw of list) {
        const p = raw.replace(/\\/g, '/');
        if (p.startsWith('/') || p.split('/').includes('..')) {
            throw new Error('Небезопасный путь в архиве: ' + raw);
        }
    }
    ensureDir(stage);
    const args = ['-xzf', archive, '-C', stage];
    try {
        run('tar', [...args, '--no-same-owner', '--no-same-permissions'], { timeout: 180000 });
    } catch (e) {
        // На Windows/bsdtar этих ключей нет — распаковываем без них.
        log('tar с флагами владельца не сработал, повторяю без них');
        run('tar', args, { timeout: 180000 });
    }
}

function ensureDeps(root) {
    const nm = path.join(root, 'node_modules');
    const need = !fs.existsSync(path.join(nm, 'express')) || !fs.existsSync(path.join(nm, 'qrcode'));
    if (need) {
        setStep('deps', 'Устанавливаю зависимости во временном каталоге', 25);
        const npm = process.env.NPM_BIN || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
        const common = { cwd: root, timeout: 420000, shell: process.platform === 'win32' };
        const ci = runMaybe(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], common);
        if (!ci.ok) {
            log('npm ci не сработал, пробую npm install: ' + ci.out.slice(-600));
            run(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], common);
        }
    }
    for (const dep of ['express', 'express-session', 'qrcode']) {
        if (!fs.existsSync(path.join(nm, dep))) throw new Error('После установки нет зависимости ' + dep);
    }
}

async function testRun(root, work) {
    setStep('test', 'Пробный запуск новой версии на копии данных', 40);
    const port = await freePort(3998);
    const testData = path.join(work, 'test-data');
    copyData(DATA_DIR, testData);
    fs.writeFileSync(path.join(testData, '.panel_port'), String(port), { mode: 0o600 });
    fs.writeFileSync(path.join(testData, '.panel_public_port'), String(port), { mode: 0o600 });

    const env = {
        ...process.env,
        SERVEPANEL_DATA_DIR: testData,
        PANEL_HOST: '127.0.0.1',
        PANEL_PORT: String(port),
        PANEL_PUBLIC_PORT: String(port),
        SERVEPANEL_TEST: '1',
        SERVEPANEL_AUDIT_LOG: path.join(testData, 'audit.log'),
        SERVEPANEL_AUTH_LOG: path.join(testData, 'auth.log'),
        SERVEPANEL_BACKUP_DIR: path.join(testData, 'backups')
    };
    const child = spawn(process.execPath, [path.join(root, 'server.js')], {
        cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let out = '';
    let spawnError = '';
    child.on('error', e => { spawnError = String(e.message || e); });
    child.stdout.on('data', d => { out += String(d); });
    child.stderr.on('data', d => { out += String(d); });

    let ok = false;
    try { ok = await waitPanel(port, 25000); }
    finally {
        if (process.platform === 'win32') {
            try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch (e) { /* ignore */ }
        } else {
            try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
            await sleep(700);
            try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
        }
    }
    if (!ok) {
        throw new Error('Новая версия не запустилась на тестовом порту. ' +
            (spawnError ? spawnError + '. ' : '') + 'Вывод: ' + out.slice(-2000));
    }
    setStep('test-ok', 'Пробный запуск успешен', 50);
}

function makeBackup() {
    setStep('backup', 'Создаю резервную копию панели', 55);
    ensureDir(BACKUP_DIR, 0o700);
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const backup = path.join(BACKUP_DIR, `servpanel-pre-update-${stamp}.tar.gz`);
    run('tar', ['-czf', backup, '-C', APP_PARENT, APP_BASE], { timeout: 600000 });
    const size = fs.statSync(backup).size;
    if (size < 64) throw new Error('Бэкап получился слишком маленьким');
    state.backup = backup;
    log(`Бэкап: ${backup} (${Math.round(size / 1024 / 1024 * 10) / 10} МБ)`);
    return backup;
}

function stopPanel() {
    setStep('stop', 'Останавливаю панель', 65);
    runMaybe(PM2_BIN, ['stop', PM2_NAME],
        { timeout: 60000, shell: process.platform === 'win32' });
}

function applyRelease(root) {
    setStep('apply', 'Заменяю файлы панели (данные не трогаю)', 70);
    const entries = fs.readdirSync(root);
    for (const name of entries) {
        if (SKIP_COPY.has(name) || FORBIDDEN_IN_RELEASE.has(name)) continue;
        const src = path.join(root, name);
        const dest = path.join(APP_DIR, name);
        const st = fs.lstatSync(src);
        if (st.isDirectory()) {
            fs.rmSync(dest, { recursive: true, force: true });
            fs.cpSync(src, dest, { recursive: true, force: true });
        } else {
            fs.copyFileSync(src, dest);
            try { fs.chmodSync(dest, st.mode & 0o777); } catch (e) { /* ignore */ }
        }
    }

    // node_modules: переносим уже проверенный каталог, чтобы не ждать npm на бою.
    const newNm = path.join(root, 'node_modules');
    if (fs.existsSync(newNm)) {
        setStep('apply-deps', 'Обновляю node_modules', 78);
        fs.rmSync(path.join(APP_DIR, 'node_modules'), { recursive: true, force: true });
        try {
            fs.renameSync(newNm, path.join(APP_DIR, 'node_modules'));
        } catch (e) {
            fs.cpSync(newNm, path.join(APP_DIR, 'node_modules'), { recursive: true, force: true });
        }
    }
    try { fs.chmodSync(path.join(APP_DIR, 'server.js'), 0o644); } catch (e) { /* ignore */ }
    for (const f of ['.secrets.json', '.users.json', '.obf_profiles.json', '.notify.json', '.backup.json']) {
        try { fs.chmodSync(path.join(APP_DIR, f), 0o600); } catch (e) { /* ignore */ }
    }
    try { fs.chmodSync(path.join(APP_DIR, '.sessions'), 0o700); } catch (e) { /* ignore */ }
    try { fs.chmodSync(path.join(APP_DIR, 'admin_pass.txt'), 0o600); } catch (e) { /* ignore */ }
}

async function startAndCheck(version) {
    setStep('start', 'Запускаю панель', 85);
    pm2Restart();
    const ok = await waitPanel(PANEL_PORT, 30000);
    if (!ok) throw new Error('Панель не ответила после перезапуска');
    state.toVersion = version || readVersion(APP_DIR);
    setStep('done', 'Обновление завершено', 100);
}

function rollbackFrom(backup) {
    setStep('rollback', 'Откатываюсь из резервной копии', 90);
    stopPanel();
    let restored = false;
    try {
        run('tar', ['-xzf', backup, '-C', APP_PARENT], { timeout: 600000 });
        restored = true;
        log('Файлы восстановлены из ' + backup);
    } finally {
        pm2Restart();
        if (restored) state.rolledBack = true;
    }
}

// ---------------------------------------------------------------------------
// Режимы
// ---------------------------------------------------------------------------
async function runApply() {
    const archive = path.resolve(arg.archive || '');
    const expectedSha = String(arg.sha256 || '').toLowerCase();
    if (!archive) throw new Error('Не указан архив');

    if (expectedSha) {
        const got = require('crypto').createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
        if (got !== expectedSha) throw new Error('SHA256 архива не совпадает');
    }

    const work = path.join(APP_PARENT, '.servpanel-update-' + process.pid);
    APPLY_WORK = work;
    fs.rmSync(work, { recursive: true, force: true });
    ensureDir(work, 0o700);
    const stage = path.join(work, 'stage');

    setStep('unpack', 'Распаковываю архив', 10);
    extractArchive(archive, stage);
    const root = findReleaseRoot(stage);

    setStep('validate', 'Проверяю файлы релиза', 18);
    const version = validateRelease(root);
    state.toVersion = version;
    log(`Новый релиз: ${version}`);

    ensureDeps(root);
    await testRun(root, work);
    if (arg.dryRun === '1') {
        setStep('dry-run', 'Проверка завершена (dry-run): файлы и данные в порядке', 60);
        state.toVersion = version;
        try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        return { dryRun: true };
    }
    const backup = makeBackup();
    stopPanel();
    applyRelease(root);
    await startAndCheck(version);

    // После успеха архив загрузки больше не нужен.
    if (arg.cleanupArchive === '1') {
        try { fs.unlinkSync(archive); } catch (e) { /* ignore */ }
    }
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    log(`Готово: ${state.fromVersion || '?'} -> ${version}`);
    log(`Бэкап для отката: ${backup}`);
    return { backup };
}

async function runGit() {
    const branch = arg.branch || 'main';
    const remote = arg.remote || 'origin';
    const force = MODE === 'git-force';
    setStep('git-fetch', 'Проверяю GitHub', 10);
    run('git', ['-C', APP_DIR, 'fetch', '--prune', remote], { timeout: 120000 });
    const current = run('git', ['-C', APP_DIR, 'rev-parse', 'HEAD']).trim();
    const latest = run('git', ['-C', APP_DIR, 'rev-parse', `${remote}/${branch}`]).trim();
    if (current === latest && !force) throw new Error('Уже установлена последняя версия из GitHub');

    const dirty = run('git', ['-C', APP_DIR, 'status', '--porcelain', '--untracked-files=no']).trim();
    if (dirty && !force) {
        throw new Error('В панели есть локальные изменения файлов, поэтому GitHub-обновление отменено. ' +
            'Нажмите «Сбросить локальные изменения и обновить» — данные, клиенты, пароли, 2FA, сессии и конфиги AWG сохранятся, будет создан бэкап.');
    }

    setStep('git-merge', force ? 'Сбрасываю локальные изменения и обновляюсь' : 'Скачиваю обновление из GitHub', 30);
    makeBackup();
    stopPanel();
    try {
        if (force) {
            run('git', ['-C', APP_DIR, 'reset', '--hard', `${remote}/${branch}`], { timeout: 120000 });
        } else {
            run('git', ['-C', APP_DIR, 'merge', '--ff-only', `${remote}/${branch}`], { timeout: 120000 });
        }
        setStep('deps', 'Устанавливаю зависимости', 60);
        const npm = process.env.NPM_BIN || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
        const common = { cwd: APP_DIR, timeout: 420000, shell: process.platform === 'win32' };
        const ci = runMaybe(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], common);
        if (!ci.ok) run(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], common);
        await startAndCheck(readVersion(APP_DIR));
    } catch (e) {
        rollbackFrom(state.backup);
        throw e;
    }
    return { backup: state.backup };
}

async function runRollback() {
    const backup = path.resolve(arg.backup || '');
    if (!backup || !fs.existsSync(backup)) throw new Error('Файл бэкапа не найден');
    if (!backup.startsWith(BACKUP_DIR + path.sep)) throw new Error('Бэкап вне каталога резервных копий');
    stopPanel();
    run('tar', ['-xzf', backup, '-C', APP_PARENT], { timeout: 600000 });
    state.backup = backup;
    state.rolledBack = true;
    state.toVersion = readVersion(APP_DIR);
    setStep('start', 'Запускаю восстановленную панель', 90);
    pm2Restart();
    if (!(await waitPanel(PANEL_PORT, 30000, false))) throw new Error('Панель не ответила после отката');
    setStep('done', 'Откат завершён', 100);
    return { backup };
}

(async () => {
    try {
        // Защита от двух одновременных обновлений. Файл создаёт сервер, но
        // если воркер запущен вручную — создаём сами.
        try {
            if (!fs.existsSync(LOCK_FILE)) fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
        } catch (e) { /* lock уже есть — сервер проверил */ }

        log(`Режим: ${MODE}; панель: ${APP_DIR}; данные: ${DATA_DIR}`);
        if (MODE === 'apply') await runApply();
        else if (MODE === 'git' || MODE === 'git-force') await runGit();
        else if (MODE === 'rollback') await runRollback();
        else throw new Error('Неизвестный режим: ' + MODE);
        finish(true);
        process.exit(0);
    } catch (e) {
        log('ОШИБКА: ' + (e && e.message ? e.message : e));
        // Если панель уже остановлена/заменена — пытаемся вернуть бэкап.
        if (MODE !== 'rollback' && state.backup && fs.existsSync(state.backup)) {
            try { rollbackFrom(state.backup); }
            catch (e2) {
                log('ОТКАТ НЕ УДАЛСЯ: ' + (e2 && e2.message ? e2.message : e2));
                state.error += '; откат не удался: ' + (e2 && e2.message ? e2.message : e2);
            }
        }
        if (MODE === 'apply' && arg.cleanupArchive === '1' && arg.archive) {
            try { fs.unlinkSync(path.resolve(arg.archive)); } catch (e2) { /* ignore */ }
        }
        if (APPLY_WORK) {
            try { fs.rmSync(APPLY_WORK, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
        }
        finish(false, e);
        process.exit(1);
    }
})();
