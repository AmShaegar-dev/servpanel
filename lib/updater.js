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

function readStatus(dataDir) {
    const s = readJson(statusFile(dataDir), null);
    if (!s) return { running: false, ok: false, step: 'idle', message: 'Обновление ещё не запускалось', log: [] };
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
    try {
        fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
        return file;
    } catch (e) {
        let stale = false;
        try {
            const st = fs.statSync(file);
            stale = Date.now() - st.mtimeMs > 60 * 60 * 1000;
        } catch (e2) { /* ignore */ }
        if (stale) {
            try { fs.unlinkSync(file); } catch (e3) { /* ignore */ }
            try {
                fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
                return file;
            } catch (e4) { /* ignore */ }
        }
        const s = readStatus(dataDir);
        if (s && s.running) {
            const started = Date.parse(s.startedAt || '') || 0;
            if (Date.now() - started > 60 * 60 * 1000) {
                try { fs.unlinkSync(file); } catch (e5) { /* ignore */ }
                fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
                return file;
            }
        }
        throw new Error('Обновление уже выполняется (есть ' + LOCK_NAME + ')');
    }
}

function releaseLock(file) {
    try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
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
        return child.pid;
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
