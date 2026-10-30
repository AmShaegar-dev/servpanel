'use strict';

/*
 * SSH-доступ для мобильного приложения: панель сама создаёт отдельного
 * пользователя с ключом и может закрыть свой порт на loopback.
 *
 * Идея: приложение генерирует ключ на телефоне и присылает только публичную
 * часть. Панель (она работает под root) ставит её в authorized_keys с
 * ограничениями, включает проброс портов при необходимости и — отдельным
 * шагом, после проверки туннеля приложением — переводит панель на 127.0.0.1
 * и закрывает порт в UFW.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const USER = 'servpanel-app';
const HOME = '/home/' + USER;
const AK = path.join(HOME, '.ssh', 'authorized_keys');
const SSH_DIR = path.join(HOME, '.ssh');
const DROPIN = '/etc/ssh/sshd_config.d/99-servpanel-app.conf';
const PM2_NAME = 'awg-admin';
const KEY_TYPES = ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'];

function run(cmd, args = [], opts = {}) {
    try {
        const out = execFileSync(cmd, args, {
            encoding: 'utf8',
            timeout: 30000,
            maxBuffer: 4 * 1024 * 1024,
            ...opts
        });
        return { ok: true, out: String(out || '') };
    } catch (e) {
        return {
            ok: false,
            out: String((e.stdout || '') + (e.stderr || '')),
            error: e.message
        };
    }
}

function isLoopback(host) {
    const h = String(host || '');
    return h === 'localhost' || h === '::1' || h === '127.0.0.1' || h.startsWith('127.');
}

function fingerprintOf(blobBase64) {
    const digest = crypto.createHash('sha256')
        .update(Buffer.from(blobBase64, 'base64'))
        .digest('base64')
        .replace(/=+$/, '');
    return 'SHA256:' + digest;
}

/** Валидирует публичный ключ и возвращает { type, blob, comment, fingerprint }. */
function parsePublicKey(input) {
    const text = String(input || '').trim();
    if (!text) throw new Error('Пустой публичный ключ');
    if (text.length > 4096) throw new Error('Слишком длинный ключ');
    if (/[\r\n]/.test(text)) throw new Error('Ключ должен быть одной строкой');
    const parts = text.split(/\s+/);
    const type = parts[0];
    const blob = parts[1] || '';
    if (!KEY_TYPES.includes(type)) {
        throw new Error('Поддерживаются ключи ssh-rsa, ssh-ed25519 и ecdsa-sha2-*');
    }
    if (!/^AAAA[A-Za-z0-9+/]+=*$/.test(blob) || blob.length < 100) {
        throw new Error('Похоже, это не публичный ключ');
    }
    let raw;
    try {
        raw = Buffer.from(blob, 'base64');
    } catch (e) {
        throw new Error('Ключ повреждён: base64 не читается');
    }
    if (raw.length < 80) throw new Error('Ключ слишком короткий');
    return {
        type,
        blob,
        comment: parts.slice(2).join(' ').slice(0, 80) || 'servpanel-android',
        fingerprint: fingerprintOf(blob)
    };
}

function authorizedLine(key, permitPort) {
    const options = [
        `permitopen="127.0.0.1:${permitPort}"`,
        'no-pty',
        'no-agent-forwarding',
        'no-X11-forwarding',
        'no-user-rc'
    ].join(',');
    return `${options} ${key.type} ${key.blob} ${key.comment}`;
}

function readAuthorizedKeys() {
    try {
        return fs.readFileSync(AK, 'utf8');
    } catch (e) {
        return '';
    }
}

function installedKeys() {
    const text = readAuthorizedKeys();
    const result = [];
    for (const line of text.split('\n')) {
        const m = /(?:^|\s)(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp\d+)\s+(AAAA[A-Za-z0-9+/]+=*)/.exec(line);
        if (!m) continue;
        result.push({
            type: m[1],
            fingerprint: fingerprintOf(m[2]),
            permitopen: (line.match(/permitopen="([^"]+)"/) || [])[1] || ''
        });
    }
    return result;
}

function sshdConfig() {
    const r = run('sshd', ['-T']);
    if (!r.ok) return { ok: false, map: {}, error: r.out.trim() || 'sshd -T недоступен' };
    const map = {};
    for (const line of r.out.split('\n')) {
        const m = /^([a-z0-9]+)\s+(.+)$/i.exec(line.trim());
        if (m) map[m[1].toLowerCase()] = m[2].trim();
    }
    return { ok: true, map };
}

function hostKeys() {
    const dir = '/etc/ssh';
    const out = [];
    try {
        for (const name of fs.readdirSync(dir)) {
            if (!/^ssh_host_.+_key\.pub$/.test(name)) continue;
            try {
                const parts = fs.readFileSync(path.join(dir, name), 'utf8').trim().split(/\s+/);
                if (parts.length < 2) continue;
                out.push({ file: name, type: parts[0], fingerprint: fingerprintOf(parts[1]) });
            } catch (e) { /* пропускаем */ }
        }
    } catch (e) { /* нет каталога */ }
    return out;
}

function hasModernHostKey() {
    return hostKeys().some((k) => k.type !== 'ssh-ed25519');
}

function ufwPortOpen(port) {
    if (!port) return null;
    const r = run('ufw', ['status']);
    if (!r.ok) return null;
    return new RegExp(`^${port}\\/tcp\\s+ALLOW`, 'm').test(r.out);
}

function ensureSshdForwarding() {
    const cfg = sshdConfig();
    if (cfg.ok && String(cfg.map.allowtcpforwarding || '').toLowerCase() !== 'no') {
        return { changed: false, value: cfg.map.allowtcpforwarding || 'yes' };
    }
    try {
        fs.mkdirSync(path.dirname(DROPIN), { recursive: true });
        fs.writeFileSync(DROPIN, 'AllowTcpForwarding yes\n', { mode: 0o644 });
    } catch (e) {
        throw new Error('Не удалось записать настройку sshd: ' + e.message);
    }
    const check = run('sshd', ['-t']);
    if (!check.ok) {
        try { fs.unlinkSync(DROPIN); } catch (e) { /* ignore */ }
        throw new Error('sshd не принял настройку: ' + check.out.trim().slice(0, 200));
    }
    run('systemctl', ['reload', 'ssh']);
    run('systemctl', ['reload', 'sshd']);
    const after = sshdConfig();
    return { changed: true, value: (after.map && after.map.allowtcpforwarding) || 'yes' };
}

function ensureHostKey() {
    if (hasModernHostKey()) return { generated: false, keys: hostKeys() };
    run('ssh-keygen', ['-A']);
    run('systemctl', ['reload', 'ssh']);
    run('systemctl', ['reload', 'sshd']);
    return { generated: true, keys: hostKeys() };
}

function ensureUser() {
    const check = run('id', ['-u', USER]);
    if (check.ok) return { created: false };
    const add = run('useradd', ['-r', '-m', '-s', '/usr/sbin/nologin', USER]);
    if (!add.ok) throw new Error('Не удалось создать пользователя: ' + add.out.trim().slice(0, 200));
    return { created: true };
}

function enable({ publicKey, permitPort }) {
    const key = parsePublicKey(publicKey);
    const port = Number(permitPort) || 3000;
    if (!(port >= 1 && port <= 65535)) throw new Error('Некорректный порт панели');

    const user = ensureUser();
    try {
        fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
        fs.chownSync(SSH_DIR, USER, USER);
        fs.chmodSync(SSH_DIR, 0o700);
    } catch (e) {
        throw new Error('Не удалось создать ~/.ssh: ' + e.message);
    }

    const line = authorizedLine(key, port);
    const existing = readAuthorizedKeys();
    const already = existing
        .split('\n')
        .some((l) => l.includes(key.blob));
    if (!already) {
        fs.appendFileSync(AK, (existing && !existing.endsWith('\n') ? '\n' : '') + line + '\n', { mode: 0o600 });
    }
    try {
        fs.chownSync(AK, USER, USER);
        fs.chmodSync(AK, 0o600);
    } catch (e) { /* на некоторых ФС не критично */ }

    const forwarding = ensureSshdForwarding();
    const host = ensureHostKey();
    const keys = installedKeys();

    return {
        success: true,
        user: USER,
        port,
        fingerprint: key.fingerprint,
        keys,
        userCreated: user.created,
        forwarding,
        hostKeys: host.keys,
        hostKeyGenerated: host.generated
    };
}

/** Перезапуск панели с новым адресом привязки, не дожидаясь ответа клиенту. */
function scheduleBindRestart(host) {
    const cmd = `sleep 1; PANEL_HOST=${host} pm2 restart ${PM2_NAME} --update-env >/dev/null 2>&1; pm2 save >/dev/null 2>&1`;
    try {
        const child = spawn('bash', ['-c', cmd], { detached: true, stdio: 'ignore', env: process.env });
        child.unref();
        return true;
    } catch (e) {
        return false;
    }
}

function restrict({ panelHost, publicPort }) {
    const keys = installedKeys();
    if (!keys.length) {
        throw new Error('Сначала добавьте ключ приложения: без него доступ будет потерян');
    }
    const cfg = sshdConfig();
    if (!cfg.ok) throw new Error('sshd не отвечает: ' + (cfg.error || '').slice(0, 120));
    if (hasModernHostKey() === false) {
        throw new Error('Нет RSA/ECDSA ключа хоста: приложение не сможет подключиться');
    }

    const wasLoopback = isLoopback(panelHost);
    let ufwClosed = false;
    if (publicPort && publicPort !== 443 && publicPort !== 80) {
        const r = run('ufw', ['delete', 'allow', `${publicPort}/tcp`]);
        ufwClosed = r.ok;
    }
    const restarted = wasLoopback ? false : scheduleBindRestart('127.0.0.1');
    return {
        success: true,
        alreadyLoopback: wasLoopback,
        restarted,
        restartInMs: wasLoopback ? 0 : 1500,
        ufwClosed,
        publicPort
    };
}

function restore({ publicPort }) {
    const restarted = scheduleBindRestart('0.0.0.0');
    let ufwOpened = false;
    if (publicPort && publicPort !== 443 && publicPort !== 80) {
        const r = run('ufw', ['allow', `${publicPort}/tcp`]);
        ufwOpened = r.ok;
    }
    return { success: true, restarted, ufwOpened, publicPort };
}

function disable({ publicPort }) {
    try {
        fs.rmSync(AK, { force: true });
    } catch (e) { /* ignore */ }
    run('userdel', ['-r', USER]);
    const restored = restore({ publicPort });
    return { success: true, removedUser: true, ...restored };
}

function status({ panelHost, panelPort, publicPort }) {
    const cfg = sshdConfig();
    const keys = installedKeys();
    return {
        user: USER,
        userExists: run('id', ['-u', USER]).ok,
        keys,
        keyCount: keys.length,
        panelHost: panelHost || '0.0.0.0',
        panelPort: Number(panelPort) || 0,
        publicPort: Number(publicPort) || 0,
        loopbackOnly: isLoopback(panelHost),
        forwarding: (cfg.map && cfg.map.allowtcpforwarding) || (cfg.ok ? 'yes' : 'unknown'),
        sshPort: Number((cfg.map && cfg.map.port) || 22) || 22,
        hostKeys: hostKeys(),
        ufwOpen: ufwPortOpen(publicPort)
    };
}

module.exports = {
    USER,
    parsePublicKey,
    installedKeys,
    fingerprintOf,
    enable,
    restrict,
    restore,
    disable,
    status
};
