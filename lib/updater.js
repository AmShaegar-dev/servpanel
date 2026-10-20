'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const STATUS_NAME = '.update_status.json';
const LOCK_NAME = '.update.lock';
const DEFAULT_LOG = '/var/log/servpanel_update.log';

function readJson(file, def) {
    try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        return j && typeof j === 'object' ? j : def;
    } catch (e) { return def; }
}

function statusFile(dataDir) { return path.join(dataDir, STATUS_NAME); }
function lockFile(dataDir) { return path.join(dataDir, LOCK_NAME); }

// Проверяем, что PID из status-файла — это действительно update-worker,
// а не переиспользованный системой PID другого процесса.
function pidLooksLikeWorker(pid) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return false;
    if (process.platform === 'linux') {
        try {
            const cmd = fs.readFileSync(`/proc/${n}/cmdline`, 'utf8');
            return cmd.includes('update-worker.js');
        } catch (e) { /* fallback ниже */ }
    }
    try {
        process.kill(n, 0);
        return true;
    } catch (e) {
        return !!(e && e.code === 'EPERM');
    }
}

function readStatus(dataDir) {
    const s = readJson(statusFile(dataDir), null);
    if (!s) return { running: false, ok: false, step: 'idle', message: 'Обновление ещё не запускалось', log: [] };
    if (!s.running) return s;

    const hasPid = Number.isInteger(Number(s.pid)) && Number(s.pid) > 0;
    const started = Date.parse(s.startedAt || '') || 0;
    // У старых версий в статусе не было PID. Шаг stop/start не должен
    // длиться 15 минут: если процесс пропал, это уже зависание.
    const noPidTimeout = (s.step === 'stop' || s.step === 'start')
        ? 15 * 60 * 1000
        : 60 * 60 * 1000;
    const old = started > 0 && Date.now() - started > noPidTimeout;
    // Если PID уже мёртв — worker убили (например, pm2 stop),
    // и статус навсегда остался бы running:true. Показываем это как
    // аварийное завершение, чтобы UI не блокировался навсегда.
    if ((hasPid && !pidLooksLikeWorker(s.pid)) || (!hasPid && old)) {
        return {
            ...s,
            running: false,
            ok: false,
            stale: true,
            finishedAt: s.finishedAt || new Date().toISOString(),
            message: 'Обновление прервано',
            error: s.error || 'Процесс обновления завершился аварийно. Проверьте журнал и запустите обновление снова.'
        };
    }
    return s;
}

function readLog(logFile, maxLines = 120) {
    try {
        const buf = fs.readFileSync(logFile, 'utf8');
        const lines = buf.split(/\r?\n/).filter(Boolean);
        return lines.slice(-maxLines).join('\n');
    } catch (e) { return ''; }
}

function listBackups(dir, limit = 12) {
    try {
        return fs.readdirSync(dir)
            .filter(n => /^servpanel-pre-update-.*\.tar\.gz$/.test(n))
            .map(n => {
                const p = path.join(dir, n);
                try {
                    const st = fs.statSync(p);
                    return { name: n, path: p, size: st.size, mtime: st.mtime.toISOString() };
                } catch (e) { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))
            .slice(0, limit);
    } catch (e) { return []; }
}

function version(dir) {
    return String(readJson(path.join(dir, 'package.json'), {}).version || '');
}

function gitLocal(appDir) {
    const run = (args) => spawnSync('git', ['-C', appDir, ...args], {
        encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024
    });
    const out = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');
    const branch = out(run(['rev-parse', '--abbrev-ref', 'HEAD']));
    const remote = out(run(['remote', 'get-url', 'origin']));
    const head = out(run(['rev-parse', '--short', 'HEAD']));
    const subject = out(run(['log', '-1', '--format=%s']));
    const dirty = out(run(['status', '--porcelain', '--untracked-files=no']));
    let behind = null;
    if (branch) {
        const b = out(run(['rev-list', '--count', `HEAD..origin/${branch}`]));
        if (/^\d+$/.test(b)) behind = parseInt(b, 10);
    }
    return {
        available: !!branch,
        branch, remote, head, subject,
        dirty: dirty.split(/\r?\n/).filter(Boolean),
        behind
    };
}

function gitCheck(appDir, remote = 'origin', branch = 'main') {
    const run = (args, timeout = 30000) => spawnSync('git', ['-C', appDir, ...args], {
        encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024
    });
    const out = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');
    const err = (r) => String(r.stderr || r.error && r.error.message || '').trim();
    if (spawnSync('git', ['--version'], { timeout: 5000 }).status !== 0) {
        return { ok: false, error: 'git не установлен на сервере' };
    }
    const fetch = run(['fetch', '--prune', remote], 60000);
    if (fetch.status !== 0) return { ok: false, error: 'git fetch: ' + err(fetch).slice(-800) };
    const current = out(run(['rev-parse', 'HEAD']));
    const latest = out(run(['rev-parse', `${remote}/${branch}`]));
    if (!current || !latest) return { ok: false, error: 'Не найден HEAD или ' + remote + '/' + branch };
    const behind = parseInt(out(run(['rev-list', '--count', `HEAD..${remote}/${branch}`])) || '0', 10) || 0;
    const dirty = out(run(['status', '--porcelain', '--untracked-files=no'])).split(/\r?\n/).filter(Boolean);
    return {
        ok: true,
        current, latest, behind,
        upToDate: current === latest,
        dirty,
        commit: out(run(['log', '-1', '--format=%h %s', `${remote}/${branch}`])),
        branch,
        remote
    };
}

function acquireLock(dataDir) {
    const file = lockFile(dataDir);
    const tryCreate = () => {
        try {
            fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
            return true;
        } catch (e) {
            return false;
        }
    };
    if (tryCreate()) return file;

    let age = 0;
    try { age = Date.now() - fs.statSync(file).mtimeMs; } catch (e) { /* ignore */ }

    // Если worker умер, status останется running:true. readStatus()
    // помечает такой статус как stale — тогда lock можно снять сразу,
    // не ожидая час.
    const s = readStatus(dataDir);
    let stale = !!(s && s.stale);
    if (!stale && s && !s.running && age > 60 * 1000) stale = true;
    if (!stale && age > 60 * 60 * 1000) stale = true;

    if (stale) {
        try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
        if (tryCreate()) return file;
    }
    throw new Error('Обновление уже выполняется (есть ' + LOCK_NAME + ')');
}

function releaseLock(file) {
    try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
}

function systemdRunBin() {
    for (const p of ['/usr/bin/systemd-run', '/bin/systemd-run']) {
        try { if (fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
    }
    return 'systemd-run';
}

let systemdRunCache = null;
function systemdRunUsable() {
    if (systemdRunCache !== null) return systemdRunCache;
    if (process.platform !== 'linux' || !fs.existsSync('/run/systemd/system')) {
        systemdRunCache = false;
        return systemdRunCache;
    }
    const r = spawnSync(systemdRunBin(), ['--version'], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024
    });
    systemdRunCache = !r.error && r.status === 0;
    return systemdRunCache;
}

function startWorker(opts) {
    const {
        appDir, dataDir, mode = 'apply', archive = '', sha256 = '',
        backup = '', branch = 'main', remote = 'origin',
        port = 3000, pm2Name = 'awg-admin', logFile = DEFAULT_LOG,
        backupDir = '', cleanupArchive = false
    } = opts || {};
    const worker = path.join(appDir, 'lib', 'update-worker.js');
    if (!fs.existsSync(worker)) throw new Error('Не найден lib/update-worker.js');

    const lock = acquireLock(dataDir);
    // Старый статус от убитого worker не должен мешать новому запуску.
    try { fs.unlinkSync(statusFile(dataDir)); } catch (e) { /* ignore */ }
    const args = [
        worker,
        `--mode=${mode}`,
        `--app=${appDir}`,
        `--data=${dataDir}`,
        `--pm2=${pm2Name}`,
        `--port=${port}`,
        `--log=${logFile}`,
        `--status=${statusFile(dataDir)}`,
        `--lock=${lock}`
    ];
    if (backupDir) args.push(`--backupDir=${backupDir}`);
    if (archive) args.push(`--archive=${archive}`);
    if (sha256) args.push(`--sha256=${sha256}`);
    if (backup) args.push(`--backup=${backup}`);
    if (branch) args.push(`--branch=${branch}`);
    if (remote) args.push(`--remote=${remote}`);
    if (cleanupArchive) args.push('--cleanupArchive=1');

    try {
        if (process.platform === 'linux') {
            // Главная защита от старого бага: worker нельзя запускать
            // дочерним процессом панели. Иначе `pm2 stop awg-admin`
            // убивает его вместе с деревом процессов, и обновление
            // навсегда застревает на шаге "stop".
            if (!systemdRunUsable()) {
                throw new Error('systemd-run недоступен. Обновление из панели отключено; используйте upgrade.sh по SSH.');
            }
            const unit = `servpanel-update-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
            const env = process.env;
            const setEnv = [
                `HOME=${env.HOME || '/root'}`,
                `PATH=${env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}`
            ];
            if (env.PM2_BIN) setEnv.push(`PM2_BIN=${env.PM2_BIN}`);
            if (env.PM2_HOME) setEnv.push(`PM2_HOME=${env.PM2_HOME}`);
            const command = [
                `--unit=${unit}`,
                '--collect',
                '--quiet',
                `--property=WorkingDirectory=${appDir}`,
                ...setEnv.map(v => `--setenv=${v}`),
                process.execPath,
                ...args
            ];
            const r = spawnSync(systemdRunBin(), command, {
                encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024
            });
            if (r.error || r.status !== 0) {
                const detail = String(r.stderr || r.error && r.error.message || '').trim();
                throw new Error('systemd-run: ' + (detail || 'не удалось запустить unit обновления'));
            }
            return { pid: null, unit, runner: 'systemd-run' };
        }

        // Windows/не-Linux: оставляем старый detached-запуск. На Linux
        // он небезопасен из-за pm2 stop, поэтому там используется только
        // systemd-run.
        const child = spawn(process.execPath, args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env: { ...process.env }
        });
        child.on('error', () => releaseLock(lock));
        child.unref();
        if (!child.pid) {
            releaseLock(lock);
            throw new Error('Не удалось запустить процесс обновления');
        }
        return { pid: child.pid, unit: '', runner: 'detached' };
    } catch (e) {
        releaseLock(lock);
        throw e;
    }
}

function updateInfo({ appDir, dataDir, port, pm2Name, backupDir, logFile }) {
    const st = readStatus(dataDir);
    return {
        version: version(appDir) || '0.0.0',
        appDir,
        dataDir,
        port,
        pm2Name,
        backupDir,
        node: process.version,
        git: gitLocal(appDir),
        backups: listBackups(backupDir),
        status: st,
        logTail: readLog(logFile, 80)
    };
}

module.exports = {
    readStatus,
    readLog,
    listBackups,
    updateInfo,
    gitCheck,
    startWorker,
    acquireLock,
    releaseLock,
    statusFile,
    lockFile,
    DEFAULT_LOG
};
