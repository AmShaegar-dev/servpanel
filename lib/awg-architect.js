'use strict';

/*
 * Генератор параметров обфускации AmneziaWG по правилам Any-Tech ARCHITECT
 * (scripts/awg-gen.sh, MIT, https://architect.vai-rice.space/).
 *
 * Отличия от встроенного generateObfProfile в server.js: диапазоны H, S,
 * junk-пакеты, CPS-цепочки и таймеры берутся ровно в тех границах, что
 * использует Архитектор. Это важно для 2.0 на роутерах и для 3.x с
 * HeaderProtectionKey.
 *
 * Возвращает объект параметров в формате .conf (ключи H1.., S1.., Jc.., I1..),
 * который затем проверяется validateObf() в server.js.
 */

const crypto = require('crypto');

const NONCE_SIZE = 12;
const S4_MAX = 32;
const VERSIONS = ['1.0', '1.5', '2.0', '3.0', '3.1'];
const PROFILES = ['quic', 'tls', 'dtls', 'dtls13', 'sip', 'dns', 'noise'];
const INTENSITIES = ['low', 'medium', 'high'];

function ri(lo, hi) {
    if (hi < lo) throw new Error('awg-architect: пустой диапазон ' + lo + '..' + hi);
    return crypto.randomInt(lo, hi + 1);
}
function hex(n) {
    return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

// CPS-цепочка мимикрии (теги ядра AmneziaWG).
function cpsChain(profile, iv) {
    let chain;
    switch (profile) {
        case 'quic':
            chain = `<b 0xc00000000108${hex(8)}><rc ${ri(8, 20)}><t>`;
            break;
        case 'tls':
            chain = `<b 0x160303${hex(2)}01><r ${ri(24, 48)}><t>`;
            break;
        case 'dtls':
            chain = `<b 0x16fefd${hex(6)}><r ${ri(20, 40)}><t>`;
            break;
        case 'dtls13':
            chain = `<b 0x16fefd000000000000000000430100003700000000000000037fefd${hex(32)}0000000613011302130301000009002b000302fefc><r ${ri(20, 40)}><t>`;
            break;
        case 'sip':
            chain = `<b 0x4f5054494f4e53207369703a><rc ${ri(10, 18)}><rd ${ri(4, 8)}><t>`;
            break;
        case 'dns':
            chain = `<b 0x${hex(2)}01000001000000000000><rc ${ri(6, 14)}><rd ${ri(2, 4)}>`;
            break;
        case 'noise':
            chain = `<r ${ri(40, 90)}><t>`;
            break;
        default:
            throw new Error('awg-architect: неизвестный профиль ' + profile);
    }
    let pad = ri(20 * iv, 60 * iv);
    if (pad > 1000) pad = 1000;
    return chain + `<r ${pad}>`;
}

function entropyChain(iv) {
    return `<rc ${ri(6, 16)}><b 0x${hex(ri(3, 10))}><t><r ${ri(20, 60 * iv)}><rd ${ri(3, 8)}>`;
}

function generate(options = {}) {
    const version = VERSIONS.includes(String(options.version)) ? String(options.version) : '2.0';
    const profile = PROFILES.includes(String(options.profile)) ? String(options.profile) : 'quic';
    const intensity = INTENSITIES.includes(String(options.intensity)) ? String(options.intensity) : 'medium';
    const router = !!options.router;
    const noHpk = !!options.noHpk;
    const noPadding = !!options.noPadding;
    const noTimers = !!options.noTimers;
    const randomTrailers = !!options.randomTrailers;
    const disableCookies = !!options.disableCookies;

    if (version !== '3.1' && (randomTrailers || disableCookies)) {
        throw new Error('RandomTrailers/DisableCookies доступны только в 3.1');
    }

    const iv = intensity === 'low' ? 1 : intensity === 'high' ? 3 : 2;
    const p = {};

    // Junk train.
    let jmin, jmax;
    if (intensity === 'low') { jmin = ri(64, 256); jmax = ri(256, 512); }
    else if (intensity === 'high') { jmin = ri(256, 768); jmax = ri(768, 1280); }
    else { jmin = ri(128, 512); jmax = ri(512, 1024); }
    if (jmax <= jmin + 64) jmax = jmin + 64 + ri(64, 256);
    let jc;
    if (router) {
        jc = ri(2, 3);
        if (jmin > 40) jmin = 40;
        if (jmax > 128) jmax = 128;
    } else {
        jc = ri(3, 7);
    }
    if (version === '1.0') {
        if (jc < 4) jc = 4;
        if (jmax <= 81) jmax = 82 + ri(50, 200);
    }
    p.Jc = String(jc);
    p.Jmin = String(jmin);
    p.Jmax = String(jmax);

    // S padding.
    let s1, s2;
    if (router) { s1 = ri(1, 20); s2 = ri(1, 20); }
    else { s1 = ri(1, 150); s2 = ri(1, 150); }
    let s3 = ri(1, 64);
    let s4 = ri(1, S4_MAX);

    if ((version === '3.0' || version === '3.1') && !noHpk) {
        if (s1 < NONCE_SIZE) s1 = NONCE_SIZE;
        if (s2 < NONCE_SIZE) s2 = NONCE_SIZE;
        if (s3 < NONCE_SIZE) s3 = NONCE_SIZE;
        if (s4 < NONCE_SIZE) s4 = NONCE_SIZE;
    }
    if (s2 === s1 + 56) s2 += 1;
    if (s3 === s1 + 56) s3 += 1;
    if (s3 === s2 + 92) s3 += 1;
    if (s4 > S4_MAX) s4 = S4_MAX;

    // H1-H4: четыре непересекающихся диапазона. Для 2.0 инструменты
    // amneziawg-tools разбирают H как знаковый 32-бит (максимум 2 147 483 647),
    // поэтому зоны держим ниже этого предела. Для 3.x это тоже безопасно.
    const h = [];
    const hBases = [
        [100000000, 900000000],
        [1000000000, 1300000000],
        [1400000000, 1700000000],
        [1800000000, 2100000000]
    ];
    for (let i = 0; i < 4; i++) {
        const lo = ri(hBases[i][0], hBases[i][1]);
        const hi = lo + ri(1000, 50000);
        h.push({ lo, hi });
    }

    if (version === '2.0' || version === '3.0' || version === '3.1') {
        for (let i = 0; i < 4; i++) p['H' + (i + 1)] = `${h[i].lo}-${h[i].hi}`;
        p.S1 = String(s1); p.S2 = String(s2); p.S3 = String(s3); p.S4 = String(s4);
    } else {
        // 1.0/1.5: фиксированные H и только S1/S2.
        for (let i = 0; i < 4; i++) p['H' + (i + 1)] = String(h[i].lo);
        p.S1 = String(s1); p.S2 = String(s2);
    }

    if (version !== '1.0') {
        p.I1 = cpsChain(profile, iv);
        if (!router) {
            p.I2 = entropyChain(iv);
            p.I3 = entropyChain(iv);
            p.I4 = entropyChain(iv);
            p.I5 = entropyChain(iv);
        }
    }

    if (version === '3.0' || version === '3.1') {
        if (!noHpk) p.HeaderProtectionKey = crypto.randomBytes(32).toString('base64');
        if (!noPadding) {
            let lo, hi;
            if (router) { lo = ri(4, 16); hi = lo + ri(8, 24); }
            else { lo = ri(16, 64); hi = lo + ri(16, 120); }
            p.ContentPaddingAddition = `${lo}-${hi}`;
        }
        if (!noTimers) {
            const rtLo = ri(4, 6), rtHi = rtLo + ri(1, 4);
            const kaLo = ri(8, 14), kaHi = kaLo + ri(2, 8);
            const raLo = ri(100, 120), raHi = raLo + ri(10, 30);
            let rjLo = raHi + kaHi + rtHi + 15;
            if (rjLo < 170) rjLo = 170;
            const rjHi = rjLo + ri(10, 30);
            const atLo = ri(12, 18), atHi = atLo + ri(2, 10);
            p.RekeyAfterTime = `${raLo}-${raHi}`;
            p.RekeyTimeout = `${rtLo}-${rtHi}`;
            p.RejectAfterTime = `${rjLo}-${rjHi}`;
            p.KeepaliveTimeout = `${kaLo}-${kaHi}`;
            p.MaxHandshakeAttempts = `${atLo}-${atHi}`;
        }
        if (version === '3.1') {
            if (randomTrailers) p.RandomTrailers = '1';
            if (disableCookies) p.DisableCookies = '1';
        }
    }

    return { version, profile, intensity, params: p };
}

module.exports = { generate, VERSIONS, PROFILES, INTENSITIES };
