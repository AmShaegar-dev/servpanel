'use strict';

/*
 * Каскад RU -> EU: оркестратор двух панелей через их API.
 *
 * Главная идея: каждая сторона настраивается своим API, а панель-инициатор
 * только заказывает шаги. Поэтому каскад одинаково собирается с любой
 * стороны, а на второй панели он появляется в её собственной вкладке
 * «Каскад» без ручных действий.
 */

const { Panel, call, normalizeBase } = require('./cascade-setup');

const STEP_TITLES = {
    check: 'Проверка второй панели',
    awg: 'AmneziaWG на второй стороне',
    peer: 'Клиент для каскада',
    tunnel: 'Туннель и маршруты',
    refresh: 'Обновление второй панели',
    done: 'Готово'
};

function norm(v) { return String(v || '').trim().replace(/\/+$/, ''); }

async function withLogin(target, role) {
    const p = new Panel(target.host, target.user, target.pass);
    const res = await p.login();
    if (!res.ok) throw new Error('Не удалось войти во вторую панель: ' + res.error);
    return p;
}

// Готовность стороны: установлен ли AWG, какой у неё awg0 (порт/адрес/ключи).
async function sideInfo(panel, role) {
    const ifaces = await panel.get('/api/interfaces');
    const list = Array.isArray(ifaces.json) ? ifaces.json : [];
    const hasAwg0 = list.includes('awg0') || list.includes('amn0');
    const status = await panel.get('/api/cascade/status');
    const ready = await panel.get('/api/cascade/ready');
    return {
        hasAwg0,
        ifaces: list,
        tunnel: !!(status.json && status.json.tunnelActive),
        role: (ready.json && ready.json.role) || '',
        ownPort: (ready.json && ready.json.ownPort) || '',
        ownAddress: (ready.json && ready.json.ownAddress) || '',
        publicHost: (ready.json && ready.json.publicHost) || ''
    };
}

// Ждём завершения установки AWG на стороне (лог в /var/log/awg_install.log).
async function waitInstall(panel, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const st = await panel.get('/api/install/state');
        const j = st.json || {};
        if (j.module === 'awg' && (j.status === 'done' || j.status === 'error' || j.status === 'waiting')) {
            return j;
        }
        await new Promise(r => setTimeout(r, 5000));
    }
    return { status: 'timeout' };
}

async function ensureAwg(panel, role, version, log) {
    const info = await sideInfo(panel, role);
    if (info.hasAwg0) { log(STEP_TITLES.awg, 'AmneziaWG уже установлен'); return info; }
    log(STEP_TITLES.awg, 'Устанавливаем AmneziaWG на вторую сторону...');
    const started = await panel.post('/api/install/module', {
        module: 'awg',
        version: version || '2.0',
        route: 'all',
        ipv6: 'disallow',
        port: '443',
        awgMode: 'single'
    });
    if (started.status !== 200) {
        throw new Error('Вторая сторона не запустила установку AmneziaWG: ' +
            ((started.json && started.json.error) || 'HTTP ' + started.status));
    }
    log(STEP_TITLES.awg, 'Установка запущена, ждём завершения (обычно 2-4 минуты)...');
    const st = await waitInstall(panel, 20 * 60 * 1000);
    if (st.status === 'error') throw new Error('Установка AmneziaWG на второй стороне завершилась ошибкой (журнал ' + (st.logFile || '/var/log/awg_install.log') + ')');
    if (st.status !== 'done') throw new Error('Установка AmneziaWG на второй стороне не завершилась за 20 минут');
    log(STEP_TITLES.awg, 'AmneziaWG установлен');
    const after = await sideInfo(panel, role);
    if (!after.hasAwg0) throw new Error('После установки на второй стороне не появился интерфейс awg0');
    return after;
}

module.exports = { sideInfo, ensureAwg, withLogin, waitInstall, STEP_TITLES, norm };
