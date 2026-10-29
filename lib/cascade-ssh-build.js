'use strict';

/*
 * Каскад RU -> EU строго по CASCADE.md (bivlked/amneziawg-installer).
 *
 * Порядок, который выполняет панель (запуск со стороны RU):
 *   1. Проверка EU по SSH и установка на нём AmneziaWG (если нужно).
 *   2. На EU создаётся клиент ru_host (`manage_amneziawg.sh add ru_host`),
 *      конфиг забирается к себе.
 *   3. На RU ставится/используется свой AmneziaWG.
 *   4. Конфиг ru_host кладётся в /etc/amnezia/amneziawg/awg1.conf: убирается
 *      DNS, добавляется Table = off, Endpoint остаётся публичный IP EU.
 *   5. Поднимается awg-quick@awg1, ставятся маршруты (ipset ru, ip rule,
 *      таблица 100, iptables mangle/nat).
 *   6. Проверка: на EU есть handshake с RU, на RU — handshake с EU и трафик.
 *
 * Внутренние адреса — как в инструкции:
 *   RU-сервер (awg0): 172.16.17.1/24, клиенты AWG0 — 172.16.17.x;
 *   EU-сервер (awg0): 172.16.61.1/24;
 *   RU -> EU туннель (awg1 на RU): адрес 172.16.61.4/32, пир 172.16.61.1.
 */

const ssh = require('./cascade-ssh');

const SUBNET_RU = '172.16.17.1/24';
const SUBNET_EU = '172.16.61.1/24';
const TUNNEL_PORT = 39743;
const AWG_CONF = '/etc/amnezia/amneziawg/awg1.conf';
const MANAGE = '/root/awg/manage_amneziawg.sh';

function shq(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Установлен ли AmneziaWG на сервере (по SSH).
async function awgInfo(conn) {
    const r = await ssh.run(conn, 'test -f /etc/amnezia/amneziawg/awg0.conf && echo yes || echo no', 30000);
    const installed = String(r.out).trim() === 'yes';
    let listenPort = '';
    let publicKey = '';
    if (installed) {
        const p = await ssh.run(conn, `awk -F= '/^ListenPort/{gsub(/[^0-9]/,"",$2); print $2; exit}' /etc/amnezia/amneziawg/awg0.conf`, 20000);
        listenPort = String(p.out).trim();
        const pub = await ssh.run(conn, 'awg show awg0 public-key 2>/dev/null || true', 20000);
        publicKey = String(pub.out).trim();
    }
    return { installed, listenPort, publicKey };
}

// Ставит AmneziaWG на сервер (неинтерактивно) и ждёт завершения.
async function installAwg(conn, { version, subnet, onLog }) {
    const cmd = [
        'export DEBIAN_FRONTEND=noninteractive',
        'curl -fsSL https://raw.githubusercontent.com/bivlked/amneziawg-installer/main/install_amneziawg.sh -o /tmp/install_amneziawg.sh',
        `bash /tmp/install_amneziawg.sh --yes --disallow-ipv6 --route-all --subnet=${subnet} --protocol ${version}`
    ].join(' && ');
    onLog && onLog(`Установка AmneziaWG ${version} на ${conn.host}...`);
    // Установщик перезагружает сервер: повторяем подключение после обрыва.
    let lastError = '';
    for (let attempt = 0; attempt < 3; attempt++) {
        const r = await ssh.run(conn, cmd, 30 * 60 * 1000);
        if (r.code === 0) return;
        lastError = r.out || `код ${r.code}`;
        onLog && onLog(`Попытка ${attempt + 1} прервалась (${String(lastError).slice(0, 160)}), ждём сервер...`);
        await ssh.waitOnline(conn, 10 * 60 * 1000);
    }
    throw new Error('Установка AmneziaWG не завершилась: ' + String(lastError).slice(0, 400));
}

// Создаёт клиента ru_host на EU и отдаёт его конфиг.
async function createRuHost(conn, onLog) {
    const created = await ssh.run(conn,
        `bash ${MANAGE} add ru_host --json >/dev/null 2>&1 || true; test -f /root/awg/ru_host.conf && echo found || echo missing`,
        180000);
    if (String(created.out).trim() !== 'found') {
        throw new Error('На EU не создался клиент ru_host (/root/awg/ru_host.conf)');
    }
    const conf = await ssh.run(conn, 'cat /root/awg/ru_host.conf', 30000);
    if (!/\[Interface\]/i.test(conf.out)) throw new Error('Конфиг ru_host пустой или повреждён');
    const pub = await ssh.run(conn, 'awg show awg0 public-key 2>/dev/null || true', 20000);
    onLog && onLog('Клиент ru_host создан на EU');
    return { conf: conf.out, publicKey: String(pub.out).trim() };
}

// Конфиг ru_host в виде для RU (по шагу 3 инструкции).
function cascadeConfig(ruHostConf) {
    let text = String(ruHostConf).replace(/\r\n/g, '\n');
    text = text.split('\n')
        .filter(l => !/^\s*DNS\s*=/i.test(l))
        .filter(l => !/^\s*Table\s*=/i.test(l))
        .filter(l => !/^\s*AllowedIPs\s*=/i.test(l))
        .filter(l => !/^\s*PersistentKeepalive\s*=/i.test(l));
    const i = text.findIndex(l => /^\s*\[Interface\]\s*$/i.test(l));
    if (i >= 0) text.splice(i + 1, 0, 'Table = off');
    const j = text.findIndex(l => /^\s*\[Peer\]\s*$/i.test(l));
    if (j >= 0) {
        text.splice(j + 1, 0, 'AllowedIPs = 0.0.0.0/0, ::/0');
        text.splice(text.length - 1, 0, 'PersistentKeepalive = 33');
    }
    return text.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// Скрипт маршрутизации с RU на EU (шаг 4 инструкции).
function routingScript(endpointHost) {
    return [
        '#!/bin/bash',
        '# Каскад RU -> EU. Сгенерировано панелью по CASCADE.md',
        'set -euo pipefail',
        'CLIENT_SUBNET="172.16.17.0/24"',
        'AWG1_IF="awg1"',
        `AWG1_ENDPOINT="${endpointHost}"`,
        'TABLE_ID=100',
        'FWMARK="0x1"',
        'RULE_PRIO=10000',
        'RU_ZONE_URL="https://www.ipdeny.com/ipblocks/data/aggregated/ru-aggregated.zone"',
        'RU_ZONE_FALLBACK_URL="https://raw.githubusercontent.com/bivlked/amneziawg-installer/main/cascade/ru.zone"',
        'AWG_DIR="/root/awg"',
        'EXTRA_RU_NETS=""',
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
        'iptables -t mangle -C PREROUTING -i awg0 -s "$CLIENT_SUBNET" -m set --match-set ru dst -j RETURN 2>/dev/null \\',
        '    || iptables -t mangle -I PREROUTING 1 -i awg0 -s "$CLIENT_SUBNET" -m set --match-set ru dst -j RETURN',
        'iptables -t mangle -C PREROUTING -i awg0 -s "$CLIENT_SUBNET" -j MARK --set-mark "$FWMARK" 2>/dev/null \\',
        '    || iptables -t mangle -A PREROUTING -i awg0 -s "$CLIENT_SUBNET" -j MARK --set-mark "$FWMARK"',
        'iptables -t nat -C POSTROUTING -s "$CLIENT_SUBNET" -o "$AWG1_IF" -j MASQUERADE 2>/dev/null \\',
        '    || iptables -t nat -A POSTROUTING -s "$CLIENT_SUBNET" -o "$AWG1_IF" -j MASQUERADE',
        '',
        'sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true',
        'echo "OK: маршруты каскада применены"'
    ].join('\n') + '\n';
}

module.exports = {
    SUBNET_RU, SUBNET_EU, TUNNEL_PORT, AWG_CONF, MANAGE, shq,
    awgInfo, installAwg, createRuHost, cascadeConfig, routingScript
};
