'use strict';

/*
 * Каскад RU -> EU по CASCADE.md (bivlked/amneziawg-installer).
 *
 * Панель запускается на стороне входа (RU) и по SSH приводит вторую сторону
 * (EU) к нужному состоянию:
 *   1. Проверяет SSH и ставит AmneziaWG на EU, если его там нет.
 *   2. Создаёт на EU клиента ru_host и забирает его конфиг.
 *   3. Проверяет AmneziaWG на этом сервере (RU).
 *   4. Кладёт конфиг ru_host в /etc/amnezia/amneziawg/awg1.conf: убирает DNS,
 *      добавляет Table = off, AllowedIPs = 0.0.0.0/0, ::/0.
 *   5. Ставит маршруты (ipset ru, ip rule fwmark, таблица 100, iptables) и
 *      поднимает awg-quick@awg1.
 *   6. Ждёт рукопожатие на обеих сторонах и трафик через awg1.
 *
 * Все операции длинные (установка перезагружает сервер), поэтому вызывающий
 * код обязан выполнять их в фоне и показывать прогресс.
 */

const ssh = require('./cascade-ssh');

const STATE_INSTALLER = 'https://raw.githubusercontent.com/AmShaegar-dev/servpanel/main/install_awg_stateful.sh';
const AWG_CONF = '/etc/amnezia/amneziawg/awg1.conf';
const AWG0_CONF = '/etc/amnezia/amneziawg/awg0.conf';
const MANAGE = '/root/awg/manage_amneziawg.sh';
const INSTALL_LOG = '/var/log/awg_install.log';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Установлен ли AmneziaWG на сервере (по SSH или локально).
async function awgInfo(conn) {
    const r = await ssh.run(conn,
        `test -f ${AWG0_CONF} && echo yes || echo no; ` +
        `awk -F= '/^[[:space:]]*ListenPort/{gsub(/[^0-9]/,"",$2); print "port="$2; exit}' ${AWG0_CONF} 2>/dev/null; ` +
        `awk -F= '/^[[:space:]]*Address/{print "addr="$2; exit}' ${AWG0_CONF} 2>/dev/null`,
        30000);
    const out = String(r.out || '');
    const installed = /(^|\n)yes(\n|$)/.test(out);
    const port = (out.match(/port=(\d+)/) || [])[1] || '';
    const address = (out.match(/addr=([^\s]+)/) || [])[1] || '';
    return { installed, listenPort: port, address };
}

// Открывает UDP-порт AWG в UFW (и на всякий случай в iptables).
async function openUdp(conn, port) {
    if (!port) return;
    await ssh.run(conn,
        `ufw allow ${port}/udp >/dev/null 2>&1 || true; ` +
        `iptables -C INPUT -p udp --dport ${port} -j ACCEPT 2>/dev/null || ` +
        `iptables -I INPUT -p udp --dport ${port} -j ACCEPT 2>/dev/null || true`,
        30000);
}

// Ставит AmneziaWG на сервер через установщик панели. Установщик перезагружает
// сервер и продолжается из cron, поэтому запускаем его отсоединённым и ждём
// маркер завершения в журнале.
async function installAwg(conn, { version, subnetNet, onLog }) {
    const log = (m) => { if (onLog) onLog(m); };
    const v = ['1.5', '2.0', '3.1'].includes(String(version)) ? String(version) : '2.0';
    log(`Установка AmneziaWG ${v} на ${conn.host}. Установщик несколько раз перезагрузит сервер — это нормально.`);

    const env = [
        'export DEBIAN_FRONTEND=noninteractive',
        'mkdir -p /root/awg',
        // На сервере не должно быть двух установщиков одновременно: на 2 ГБ RAM
        // это ломает apt/DKMS и валит машину. Если установка уже идёт — ждём её.
        'if pgrep -f "install_amneziawg.sh" >/dev/null 2>&1 || pgrep -f "install_awg_stateful.sh" >/dev/null 2>&1; then echo busy; exit 0; fi',
        `curl -fsSL ${STATE_INSTALLER} -o /root/install_awg_stateful.sh`,
        'chmod +x /root/install_awg_stateful.sh',
        `export PANEL_FRESH_INSTALL=1 AWG_VERSION=${v} AWG_ROUTE=all AWG_IPV6=disallow AWG_PORT=3977`,
        'export AWG_ISOLATION=on AWG_KEEP_PACKAGES=1 AWG_MODE=single PANEL_PORT=4444',
        subnetNet ? `export AWG_TUNNEL_SUBNET=${subnetNet}` : 'export AWG_TUNNEL_SUBNET=',
        `rm -f ${INSTALL_LOG}`,
        `nohup bash /root/install_awg_stateful.sh > ${INSTALL_LOG} 2>&1 &`,
        'echo started'
    ].join(' && ');

    const started = await ssh.run(conn, env, 120000);
    const out0 = String(started.out || '');
    if (/busy/.test(out0)) {
        log('На ' + conn.host + ' уже идёт установка — жду её завершения, вторую не запускаю.');
    } else if (!/started/.test(out0)) {
        throw new Error('Не удалось запустить установщик на ' + conn.host + ': ' + out0.trim().slice(0, 300));
    }

    const deadline = Date.now() + 25 * 60 * 1000;
    let lastNotice = 0;
    let lastTail = '';
    while (Date.now() < deadline) {
        await sleep(10000);
        const r = await ssh.run(conn,
            `grep -q "INSTALLATION DONE" ${INSTALL_LOG} 2>/dev/null && echo done; ` +
            `grep -qE "КРИТИЧЕСКАЯ ОШИБКА|Установка прервана|Не удалось установить" ${INSTALL_LOG} 2>/dev/null && echo failed; ` +
            `test -f ${AWG0_CONF} && echo conf; ` +
            `tail -n 3 ${INSTALL_LOG} 2>/dev/null | tr '\\n' ' '`,
            30000);
        const out = String(r.out || '');
        if (/failed/.test(out)) {
            throw new Error('Установка AmneziaWG на ' + conn.host + ' прервалась: ' + out.replace(/\s+/g, ' ').trim().slice(0, 500));
        }
        if (/\bdone\b/.test(out)) {
            const info = await awgInfo(conn);
            if (!info.installed) throw new Error('Установщик сообщил о завершении, но ' + AWG0_CONF + ' нет');
            await openUdp(conn, info.listenPort);
            log(`AmneziaWG установлен на ${conn.host}, UDP-порт ${info.listenPort || '—'} открыт в UFW`);
            return info;
        }
        const tail = out.replace(/done|failed|conf/g, '').replace(/\s+/g, ' ').trim();
        if (tail && tail !== lastTail && Date.now() - lastNotice > 25000) {
            lastTail = tail;
            lastNotice = Date.now();
            log(tail.slice(-200));
        } else if (Date.now() - lastNotice > 60000) {
            lastNotice = Date.now();
            log('Установка продолжается (перезагрузки сервера)...');
        }
    }
    throw new Error('Установка AmneziaWG на ' + conn.host + ' не завершилась за 25 минут. Посмотрите журнал ' + INSTALL_LOG + '.');
}

// Создаёт (или переиспользует) клиента ru_host на EU и отдаёт его конфиг.
async function createRuHost(conn, onLog) {
    const log = (m) => { if (onLog) onLog(m); };
    const check = await ssh.run(conn,
        `if [ -f /root/awg/ru_host.conf ] && grep -q "ru_host" ${AWG0_CONF} 2>/dev/null; then echo reuse; else echo create; fi`,
        30000);
    const mode = /reuse/.test(String(check.out)) ? 'reuse' : 'create';
    if (mode === 'create') {
        log('Создаю клиента ru_host на EU...');
        const r = await ssh.run(conn,
            `bash ${MANAGE} add ru_host --yes >/tmp/ru_host_add.log 2>&1; ` +
            `test -f /root/awg/ru_host.conf && echo found || (echo missing; tail -n 5 /tmp/ru_host_add.log)`,
            240000);
        if (!/found/.test(String(r.out))) {
            throw new Error('На EU не создался клиент ru_host: ' + String(r.out || '').trim().slice(0, 400));
        }
    } else {
        log('Клиент ru_host на EU уже есть — использую его конфиг.');
    }
    const conf = await ssh.run(conn, 'cat /root/awg/ru_host.conf', 30000);
    if (!/\[Interface\]/i.test(String(conf.out || ''))) throw new Error('Конфиг ru_host пустой или повреждён');
    log('Конфиг ru_host получен с EU');
    return { conf: String(conf.out) };
}

// Конфиг ru_host в виде для входа (шаг 3 инструкции).
function cascadeConfig(ruHostConf) {
    let text = String(ruHostConf).replace(/\r\n/g, '\n');
    const lines = text.split('\n')
        .filter(l => !/^\s*DNS\s*=/i.test(l))
        .filter(l => !/^\s*Table\s*=/i.test(l))
        .filter(l => !/^\s*AllowedIPs\s*=/i.test(l))
        .filter(l => !/^\s*PersistentKeepalive\s*=/i.test(l));
    const i = lines.findIndex(l => /^\s*\[Interface\]\s*$/i.test(l));
    if (i >= 0) lines.splice(i + 1, 0, 'Table = off');
    const j = lines.findIndex(l => /^\s*\[Peer\]\s*$/i.test(l));
    if (j >= 0) {
        lines.splice(j + 1, 0, 'AllowedIPs = 0.0.0.0/0, ::/0');
        lines.splice(lines.length - 1, 0, 'PersistentKeepalive = 33');
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// Подсеть клиентов входа: из Address локального awg0 (например 10.9.9.1/24).
function clientSubnet(address) {
    const m = String(address || '').match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}\/(\d{1,2})$/);
    if (!m) return '';
    const ip = m[1] + '.0/' + m[2];
    return ip;
}

// Скрипт маршрутизации входа (шаг 4 инструкции).
function routingScript(endpointHost, subnet) {
    const clientSubnet = subnet || '10.9.9.0/24';
    return [
        '#!/bin/bash',
        '# Каскад: маршруты входа (сгенерировано панелью Servpanel)',
        'set -euo pipefail',
        `CLIENT_SUBNET="${clientSubnet}"`,
        'AWG0_IF="awg0"',
        'AWG1_IF="awg1"',
        `AWG1_ENDPOINT="${endpointHost}"`,
        'TABLE_ID=100',
        'FWMARK="0x1"',
        'RULE_PRIO=10000',
        'RU_ZONE_URL="https://www.ipdeny.com/ipblocks/data/aggregated/ru-aggregated.zone"',
        'RU_ZONE_FALLBACK_URL="https://raw.githubusercontent.com/bivlked/amneziawg-installer/main/cascade/ru.zone"',
        'AWG_DIR="/root/awg"',
        'RU_ZONE="$AWG_DIR/ru.zone"',
        'mkdir -p "$AWG_DIR"',
        'exec 9>"$AWG_DIR/awg-routing.lock"',
        'flock -w 300 9 || exit 1',
        "trap 'rm -f \"$RU_ZONE.tmp\"' EXIT",
        '',
        'EP_ROUTE="$(ip -4 route get "$AWG1_ENDPOINT" 2>/dev/null | head -1)"',
        "WAN_IF=\"$(printf '%s' \"$EP_ROUTE\" | grep -oP '(^| )dev \\K\\S+' || true)\"",
        "WAN_GW=\"$(printf '%s' \"$EP_ROUTE\" | grep -oP '(^| )via \\K\\S+' || true)\"",
        '{ [ -n "$WAN_IF" ] && [ "$WAN_IF" != "$AWG1_IF" ]; } || { echo "ERROR: не найден WAN-интерфейс"; exit 1; }',
        '',
        'fetch_ru_zone() {',
        '    curl -fsS --retry 2 --connect-timeout 10 --max-time 60 -o "$RU_ZONE.tmp" "$1" || return 1',
        '    local valid',
        "    valid=$(grep -cE '^[0-9]{1,3}([.][0-9]{1,3}){3}(/[0-9]{1,2})?$' \"$RU_ZONE.tmp\" || true)",
        '    [ "$valid" -ge 1000 ]',
        '}',
        'if fetch_ru_zone "$RU_ZONE_URL"; then',
        '    mv -f "$RU_ZONE.tmp" "$RU_ZONE"',
        'elif fetch_ru_zone "$RU_ZONE_FALLBACK_URL"; then',
        '    mv -f "$RU_ZONE.tmp" "$RU_ZONE"',
        'fi',
        '[ -s "$RU_ZONE" ] || { echo "ERROR: список RU-сетей пуст"; exit 1; }',
        '',
        'ipset create ru hash:net -exist',
        'ipset create ru_tmp hash:net -exist',
        'ipset flush ru_tmp',
        'while read -r net; do [ -n "$net" ] && ipset add ru_tmp "$net" -exist; done < "$RU_ZONE"',
        'ipset swap ru_tmp ru',
        'ipset destroy ru_tmp',
        '',
        'ip route replace default dev "$AWG1_IF" table "$TABLE_ID"',
        'ip rule del fwmark "$FWMARK" table "$TABLE_ID" 2>/dev/null || true',
        'ip rule add fwmark "$FWMARK" table "$TABLE_ID" priority "$RULE_PRIO"',
        'if [ -n "$WAN_GW" ]; then',
        '    ip route replace "$AWG1_ENDPOINT" via "$WAN_GW" dev "$WAN_IF" 2>/dev/null \\',
        '        || ip route replace "$AWG1_ENDPOINT" via "$WAN_GW" dev "$WAN_IF" onlink',
        'else',
        '    ip route replace "$AWG1_ENDPOINT" dev "$WAN_IF"',
        'fi',
        '',
        'iptables -t mangle -C PREROUTING -i "$AWG0_IF" -s "$CLIENT_SUBNET" -m set --match-set ru dst -j RETURN 2>/dev/null \\',
        '    || iptables -t mangle -I PREROUTING 1 -i "$AWG0_IF" -s "$CLIENT_SUBNET" -m set --match-set ru dst -j RETURN',
        'iptables -t mangle -C PREROUTING -i "$AWG0_IF" -s "$CLIENT_SUBNET" -j MARK --set-mark "$FWMARK" 2>/dev/null \\',
        '    || iptables -t mangle -A PREROUTING -i "$AWG0_IF" -s "$CLIENT_SUBNET" -j MARK --set-mark "$FWMARK"',
        'iptables -t nat -C POSTROUTING -s "$CLIENT_SUBNET" -o "$AWG1_IF" -j MASQUERADE 2>/dev/null \\',
        '    || iptables -t nat -A POSTROUTING -s "$CLIENT_SUBNET" -o "$AWG1_IF" -j MASQUERADE',
        '',
        'sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true',
        'echo "OK: маршруты каскада применены"'
    ].join('\n') + '\n';
}

// Служба и таймер для маршрутов (как в инструкции).
const ROUTING_SERVICE = [
    '[Unit]',
    'Description=AmneziaWG cascade routing (RU -> EU)',
    'After=network-online.target awg-quick@awg0.service',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    'ExecStart=/root/awg/awg-routing.sh',
    'TimeoutStartSec=600',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    ''
].join('\n');

const ROUTING_TIMER = [
    '[Unit]',
    'Description=Refresh AmneziaWG cascade routing',
    '',
    '[Timer]',
    'OnBootSec=2min',
    'OnUnitActiveSec=30min',
    'Unit=awg-routing.service',
    '',
    '[Install]',
    'WantedBy=timers.target',
    ''
].join('\n');

module.exports = {
    AWG_CONF, AWG0_CONF, MANAGE, INSTALL_LOG,
    ROUTING_SERVICE, ROUTING_TIMER,
    awgInfo, openUdp, installAwg, createRuHost, cascadeConfig, clientSubnet, routingScript
};
