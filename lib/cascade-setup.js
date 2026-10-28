'use strict';

/*
 * Сборка каскада RU -> EU без участия пользователя.
 *
 * Сценарий:
 *   1. Пользователь выбирает на своей панели «Каскад», роль и адрес второй
 *      панели с её логином/паролем.
 *   2. Панель проверяет вторую сторону, при необходимости доустанавливает на
 *      ней AmneziaWG, получает (или создаёт) клиентский конфиг для входа.
 *   3. На обеих сторонах поднимается туннель awg1, включается awg-routing,
 *      чистятся старые правила и ставится выключатель каскада.
 *   4. Обе панели показывают каскад «работает».
 *
 * Модуль работает поверх REST API панели, поэтому одинаково годится для
 * «здесь и там»: каждая сторона настраивается через свой собственный API.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const DEFAULT_TIMEOUT = 20000;

function agentFor(protocol) {
    if (protocol === 'https:') return new https.Agent({ rejectUnauthorized: false, keepAlive: true });
    return new http.Agent({ keepAlive: true });
}

function call(url, { method = 'GET', body, cookie, timeout = DEFAULT_TIMEOUT, text = false } = {}) {
    return new Promise((resolve) => {
        let target;
        try { target = new URL(url); } catch (e) { return resolve({ status: 0, error: 'неверный адрес: ' + url }); }
        const lib = target.protocol === 'https:' ? https : http;
        const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const headers = { 'User-Agent': 'servpanel-cascade/1' };
        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = payload.length;
        }
        if (cookie) headers.Cookie = cookie;
        const req = lib.request({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: target.pathname + target.search,
            method,
            headers,
            agent: agentFor(target.protocol),
            rejectUnauthorized: false,
            timeout
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                const out = {
                    status: res.statusCode,
                    headers: res.headers,
                    cookies: (res.headers['set-cookie'] || []).map(c => c.split(';')[0])
                };
                if (!text) {
                    try { out.json = JSON.parse(raw); } catch (e) { out.json = null; }
                } else {
                    out.text = raw;
                }
                if (!out.text && !out.json) out.text = raw.slice(0, 400);
                resolve(out);
            });
        });
        req.on('error', (e) => resolve({ status: 0, error: e.code === 'ECONNREFUSED' ? 'соединение отклонено' : e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'таймаут ' + timeout + ' мс' }); });
        if (payload) req.write(payload);
        req.end();
    });
}

function normalizeBase(u) {
    let s = String(u || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    return s.replace(/\/+$/, '');
}

// Авторизованная сессия одной панели.
class Panel {
    constructor(base, user, pass) {
        this.base = normalizeBase(base);
        this.user = user;
        this.pass = pass;
        this.cookie = '';
    }

    async login() {
        const r = await call(this.base + '/api/login', {
            method: 'POST',
            body: { username: this.user, password: this.pass }
        });
        if (r.status === 200 && r.json && r.json.success) {
            this.cookie = r.cookies.join('; ');
            return { ok: true };
        }
        const msg = r.status === 401 ? 'неверный логин или пароль' :
            r.status === 0 ? (r.error || 'нет связи') : 'HTTP ' + r.status;
        return { ok: false, error: this.base + ': ' + msg };
    }

    get(path) { return call(this.base + path, { cookie: this.cookie }); }
    post(path, body) { return call(this.base + path, { method: 'POST', body: body || {}, cookie: this.cookie }); }
    download(path) { return call(this.base + path, { cookie: this.cookie, text: true, timeout: 30000 }); }
}

// Публичный адрес панели для ссылок и маршрутов (без схемы).
function publicHostOf(panel) {
    try {
        const u = new URL(panel.base);
        return u.hostname;
    } catch (e) { return ''; }
}

module.exports = { call, normalizeBase, Panel, publicHostOf };
