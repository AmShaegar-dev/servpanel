'use strict';

/*
 * SSH-исполнитель для сборки каскада: панель на RU подключается к EU по IP
 * и выполняет команды. Зависимостей нет: используется sshpass + ssh.
 */

const { spawn } = require('child_process');

const DEFAULT_TIMEOUT = 120000;

function args(conn, command) {
    return [
        '-p', String(conn.pass || ''),
        'ssh',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ConnectTimeout=15',
        '-o', 'ServerAliveInterval=20',
        '-o', 'LogLevel=ERROR',
        '-p', String(Number(conn.port) || 22),
        `${conn.user || 'root'}@${conn.host}`,
        command
    ];
}

function run(conn, command, timeout = DEFAULT_TIMEOUT) {
    // Локальные команды (127.0.0.1) выполняем без SSH.
    if (String(conn.host) === '127.0.0.1' || String(conn.host) === 'localhost') {
        return new Promise((resolve) => {
            const child = spawn('sudo', ['bash', '-c', command], { windowsHide: true });
            let out = '';
            let done = false;
            const timer = setTimeout(() => {
                if (done) return;
                done = true;
                try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
                resolve({ code: 124, out: out + '\n[таймаут]' });
            }, timeout);
            child.stdout.on('data', d => { out += d.toString(); });
            child.stderr.on('data', d => { out += d.toString(); });
            child.on('error', e => { if (done) return; done = true; clearTimeout(timer); resolve({ code: 127, out: out + '\n' + e.message }); });
            child.on('close', code => { if (done) return; done = true; clearTimeout(timer); resolve({ code: code === null ? 255 : code, out }); });
        });
    }
    return new Promise((resolve) => {
        let out = '';
        let done = false;
        const child = spawn('sshpass', args(conn, command), { windowsHide: true });
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
            resolve({ code: 124, out: out + '\n[таймаут ' + Math.round(timeout / 1000) + ' с]' });
        }, timeout);
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { out += d.toString(); });
        child.on('error', (e) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ code: 127, out: out + '\n' + e.message });
        });
        child.on('close', (code) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ code: code === null ? 255 : code, out });
        });
    });
}

async function waitOnline(conn, timeout = 10 * 60 * 1000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        const r = await run(conn, 'echo ok', 15000);
        if (String(r.out).includes('ok')) return true;
        await new Promise(res => setTimeout(res, 10000));
    }
    return false;
}

module.exports = { run, waitOnline };
