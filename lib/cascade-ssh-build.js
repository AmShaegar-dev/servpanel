'use strict';

/*
 * Каскад RU -> EU по CASCADE.md (bivlked/amneziawg-installer).
 *
 * Панель запускается на стороне входа (RU) и по SSH приводит вторую сторону
 * (EU) к нужному состоянию:
 *   1. Проверяет SSH и ставит AmneziaWG на EU, если его там нет.
 *   2. При необходимости применяет обфускацию (Архитектор/свои параметры).
 *   3. Создаёт на EU клиента ru_host и забирает его конфиг.
 *   4. Проверяет AmneziaWG на этом сервере (RU), применяет обфускацию.
 *   5. Кладёт конфиг ru_host в /etc/amnezia/amneziawg/awg1.conf: убирает DNS,
 *      добавляет Table = off, AllowedIPs = 0.0.0.0/0, ::/0.
 *   6. Ставит маршруты (ipset ru, ip rule fwmark, таблица 100, iptables) и
 *      поднимает awg-quick@awg1.
 *   7. Ждёт рукопожатие на обеих сторонах и трафик через awg1.
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
const ROUTING_SCRIPT = '/root/awg/awg-routing.sh';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Скрипт передаётся на сервер в base64: так в нём могут быть любые кавычки,
// $ и переводы строк, и SSH-команда не ломается.
async function runRemoteScript(conn, script, timeout = 300000) {
    const b64 = Buffer.from(String(script), 'utf8').toString('base64');
    return ssh.run(conn,
        `echo ${b64} | base64 -d > /tmp/awg-step.sh && chmod 700 /tmp/awg-step.sh && bash /tmp/awg-step.sh`,
        timeout);
}

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

function installerEnv(version, subnetNet) {
    const v = ['1.5', '2.0', '3.1'].includes(String(version)) ? String(version) : '2.0';
    return [
        `export PANEL_FRESH_INSTALL=1 AWG_VERSION=${v} AWG_ROUTE=all AWG_IPV6=disallow AWG_PORT=3977`,
        'export AWG_ISOLATION=on AWG_KEEP_PACKAGES=1 AWG_MODE=single PANEL_PORT=4444',
        subnetNet ? `export AWG_TUNNEL_SUBNET=${subnetNet}` : 'export AWG_TUNNEL_SUBNET='
    ].join('; ');
}

function installerStartScript(version, subnetNet) {
    return `#!/bin/bash
export DEBIAN_FRONTEND=noninteractive
rm -f /root/awg/setup_state /var/log/awg_install.log
${installerEnv(version, subnetNet)}
# setsid отвязывает установщик от SSH-сессии: иначе при закрытии канала
# процесс может быть убит до того, как создаст журнал и cron автопродолжения.
setsid bash /root/install_awg_stateful.sh </dev/null >>/var/log/awg_install.log 2>&1 &
sleep 1
if [ -f /var/log/awg_install.log ]; then
    echo started
else
    echo no-log
fi
`;
}

// Ставит AmneziaWG на сервер через установщик панели. Установщик перезагружает
// сервер и продолжается из cron, поэтому запускаем его отсоединённым и ждём
// маркер завершения в журнале.
async function installAwg(conn, { version, subnetNet, onLog }) {
    const log = (m) => { if (onLog) onLog(m); };
    const v = ['1.5', '2.0', '3.1'].includes(String(version)) ? String(version) : '2.0';
    log(`Установка AmneziaWG ${v} на ${conn.host}. Установщик несколько раз перезагрузит сервер — это нормально.`);

    const preflight = `#!/bin/bash
export DEBIAN_FRONTEND=noninteractive
mkdir -p /root/awg
# Снимаем зависшие установщики прошлых попыток: иначе новая сборка ждёт их
# и читает старый журнал с ошибкой.
pkill -f install_amneziawg.sh 2>/dev/null || true
pkill -f install_awg_stateful.sh 2>/dev/null || true
sleep 1
rm -f /root/awg/setup_state /root/awg_install_params.env /etc/cron.d/awg_resume \\
      /root/awg_installer_wrapper.sh /root/awg/.resume_count
rm -f /var/log/awg_install.log /root/awg/install_amneziawg.log
dpkg --configure -a >/dev/null 2>&1 || true
apt-get -f install -y >/dev/null 2>&1 || true
# Если модуль уже собран, но не грузится (Unknown symbol — обычно после
# обновления ядра), пересобираем DKMS под текущее ядро.
if ! modprobe amneziawg 2>/dev/null; then
    apt-get install -y --reinstall "linux-headers-$(uname -r)" >/dev/null 2>&1 || true
    dkms autoinstall >/dev/null 2>&1 || true
    if [ -x /root/install_amneziawg.sh ] && dpkg -s amneziawg-dkms >/dev/null 2>&1; then
        bash /root/install_amneziawg.sh --repair-module --verbose --no-color >/var/log/awg_repair.log 2>&1 || true
    fi
    modprobe -r amneziawg >/dev/null 2>&1 || true
    modprobe amneziawg >/dev/null 2>&1 || true
    echo "repair-tail:"
    tail -n 12 /var/log/awg_repair.log 2>/dev/null || true
fi
curl -fsSL ${STATE_INSTALLER} -o /root/install_awg_stateful.sh || exit 1
chmod +x /root/install_awg_stateful.sh
echo preflight-done
`;
    const pf = await runRemoteScript(conn, preflight, 900000);
    const pfOut = String(pf.out || '');
    if (!/preflight-done/.test(pfOut)) {
        throw new Error('Подготовка ' + conn.host + ' не завершилась: ' + pfOut.trim().slice(-500));
    }
    const repairTail = (pfOut.match(/repair-tail:([\s\S]*?)preflight-done/) || [])[1];
    if (repairTail && repairTail.trim()) log('Ремонт модуля: ' + repairTail.trim().replace(/\s+/g, ' ').slice(0, 400));

    const startScript = installerStartScript(v, subnetNet);
    const started = await runRemoteScript(conn, startScript, 120000);
    if (!/started/.test(String(started.out || ''))) {
        throw new Error('Не удалось запустить установщик на ' + conn.host + ': ' + String(started.out || '').trim().slice(0, 300));
    }

    const repairScript = `#!/bin/bash
export DEBIAN_FRONTEND=noninteractive
apt-get install -y --reinstall "linux-headers-$(uname -r)" >/dev/null 2>&1 || true
dkms autoinstall >/dev/null 2>&1 || true
if [ -x /root/install_amneziawg.sh ] && dpkg -s amneziawg-dkms >/dev/null 2>&1; then
    bash /root/install_amneziawg.sh --repair-module --verbose --no-color >/var/log/awg_repair.log 2>&1 || true
fi
modprobe -r amneziawg >/dev/null 2>&1 || true
modprobe amneziawg >/dev/null 2>&1 || true
echo repair-done
`;
    const purgeScript = `#!/bin/bash
export DEBIAN_FRONTEND=noninteractive
pkill -f install_amneziawg.sh 2>/dev/null || true
pkill -f install_awg_stateful.sh 2>/dev/null || true
systemctl stop awg-quick@awg0 >/dev/null 2>&1 || true
apt-get purge -y amneziawg amneziawg-dkms amneziawg-tools >/dev/null 2>&1 || true
dkms status 2>/dev/null | grep -i amneziawg | cut -d, -f1 | while read -r m; do dkms remove "$m" --all >/dev/null 2>&1 || true; done
rm -rf /var/lib/dkms/amneziawg /usr/src/amneziawg-*
find /lib/modules -path "*/updates/dkms/amneziawg.ko*" -delete 2>/dev/null || true
depmod -a >/dev/null 2>&1 || true
dpkg --configure -a >/dev/null 2>&1 || true
apt-get -f install -y >/dev/null 2>&1 || true
echo purge-done
`;

    const deadline = Date.now() + 45 * 60 * 1000;
    let lastNotice = 0;
    let lastTail = '';
    let retriedRepair = false;
    let retriedPurge = false;
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
            if (!retriedRepair) {
                retriedRepair = true;
                log('Установка не удалась — пересобираю DKMS под текущее ядро и повторяю.');
                await runRemoteScript(conn, repairScript, 900000);
                await runRemoteScript(conn, startScript, 120000);
                log('Установка перезапущена после ремонта модуля.');
                continue;
            }
            if (!retriedPurge) {
                retriedPurge = true;
                log('Ремонт не помог — полностью переустанавливаю пакеты AmneziaWG (версия ' + v + ').');
                await runRemoteScript(conn, purgeScript, 900000);
                await runRemoteScript(conn, startScript, 120000);
                log('Пакеты очищены, установка перезапущена.');
                continue;
            }
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
    throw new Error('Установка AmneziaWG на ' + conn.host + ' не завершилась за 45 минут. Посмотрите журнал ' + INSTALL_LOG + '.');
}

// Порядок параметров в .conf — как у установщика/Архитектора.
const OBF_ORDER = [
    'H1', 'H2', 'H3', 'H4', 'S1', 'S2', 'S3', 'S4',
    'Jc', 'Jmin', 'Jmax', 'I1', 'I2', 'I3', 'I4', 'I5',
    'HeaderProtectionKey', 'ContentPaddingAddition',
    'RekeyAfterTime', 'RekeyTimeout', 'RejectAfterTime',
    'KeepaliveTimeout', 'MaxHandshakeAttempts',
    'RandomTrailers', 'DisableCookies'
];

// Применяет параметры обфускации к awg0.conf и перезапускает интерфейс.
// При неудаче возвращает старый конфиг и перезапускает его обратно.
async function applyObf(conn, params, onLog) {
    const log = (m) => { if (onLog) onLog(m); };
    const keys = OBF_ORDER.filter(k => params && params[k] !== undefined && String(params[k]).trim() !== '');
    if (!keys.length) return { applied: 0 };
    const block = keys.map(k => `${k} = ${String(params[k]).trim()}`).join('\n') + '\n';
    const script = `#!/bin/bash
set -u
CONF=${AWG0_CONF}
[ -f "$CONF" ] || { echo "no-conf"; exit 2; }
cp -a "$CONF" /tmp/awg-obf.bak
cat > /tmp/awg-obf.block <<'OBFEOF'
${block}OBFEOF
sed -i -E '/^[[:space:]]*(Jc|Jmin|Jmax|S1|S2|S3|S4|H1|H2|H3|H4|I1|I2|I3|I4|I5|HeaderProtectionKey|ContentPaddingAddition|RekeyAfterTime|RekeyTimeout|RejectAfterTime|KeepaliveTimeout|MaxHandshakeAttempts|RandomTrailers|DisableCookies)[[:space:]]*=/d' "$CONF"
awk 'BEGIN{while((getline l < "/tmp/awg-obf.block")>0) b=b l "\\n"} /^\\[Interface\\][[:space:]]*$/{print; printf "%s", b; next} {print}' "$CONF" > "$CONF.new" && mv "$CONF.new" "$CONF"
chmod 600 "$CONF"
systemctl restart awg-quick@awg0
sleep 2
if systemctl is-active --quiet awg-quick@awg0; then
    echo obf-ok
else
    cp -a /tmp/awg-obf.bak "$CONF"
    systemctl restart awg-quick@awg0 >/dev/null 2>&1 || true
    echo obf-fail
    exit 1
fi
if [ -x ${MANAGE} ]; then
    bash ${MANAGE} regen --json >/tmp/awg-regen.json 2>/dev/null || true
fi
`;
    const r = await runRemoteScript(conn, script, 180000);
    const out = String(r.out || '');
    if (!/obf-ok/.test(out)) {
        throw new Error('Не удалось применить обфускацию на ' + conn.host + ': ' + out.trim().slice(-400));
    }
    log('Обфускация применена (' + keys.length + ' параметров).');
    return { applied: keys.length };
}

// Снимает автопродолжение прошлой установки: cron @reboot и её состояние.
// Нужно в самом начале сборки, иначе EU перезагружается по кругу, а SSH
// пропадает прямо посреди следующих шагов.
async function stopResume(conn, onLog) {
    const log = (m) => { if (onLog) onLog(m); };
    const script = `#!/bin/bash
pkill -f install_awg_stateful.sh 2>/dev/null || true
pkill -f install_amneziawg.sh 2>/dev/null || true
rm -f /etc/cron.d/awg_resume /root/awg_installer_wrapper.sh \\
      /root/awg_install_params.env /root/awg/.resume_count /root/awg/setup_state
echo resume-stopped
`;
    const r = await runRemoteScript(conn, script, 60000);
    if (/resume-stopped/.test(String(r.out || ''))) {
        log('Автопродолжение прошлой установки снято.');
        return true;
    }
    return false;
}

// Ждёт уже запущенный установщик (например, после перезагрузки панели или
// сервера), не запуская второй. Возвращает info, если AWG появился, иначе null.
async function waitForAwg(conn, timeoutMs, onLog) {
    const log = (m) => { if (onLog) onLog(m); };
    const deadline = Date.now() + timeoutMs;
    let last = 0;
    while (Date.now() < deadline) {
        const info = await awgInfo(conn);
        if (info.installed) return info;
        const r = await ssh.run(conn,
            'busy=0; for p in $(pgrep -f "[i]nstall_awg_stateful.sh|[i]nstall_amneziawg.sh" 2>/dev/null); do ' +
            's=$(ps -o stat= -p "$p" 2>/dev/null); case "$s" in Z*) ;; *) busy=1 ;; esac; done; echo $busy',
            20000);
        const busy = /(^|\n)1(\n|$)/.test(String(r.out || ''));
        if (!busy) return null;
        if (Date.now() - last > 30000) {
            last = Date.now();
            log('Установка уже идёт — жду её завершения...');
        }
        await sleep(15000);
    }
    return null;
}

// Создаёт (или переиспользует) клиента ru_host на EU и отдаёт его конфиг.
async function createRuHost(conn, onLog) {
    const log = (m) => { if (onLog) onLog(m); };
    // EU мог перезагружаться после установки AWG: ждём, пока SSH поднимется.
    const online = await ssh.waitOnline(conn, 5 * 60 * 1000);
    if (!online) throw new Error('SSH до ' + conn.host + ' не восстановился после перезагрузки (5 минут)');
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
    return m[1] + '.0/' + m[2];
}

// Скрипт маршрутизации входа (шаг 4 инструкции). CLIENT_IFACES — интерфейсы,
// трафик которых уходит в каскад; подсеть каждого берётся из его connected
// route, поэтому интерфейсы можно добавлять после установки.
function routingScript(endpointHost, subnet, ifaces, extraNets) {
    const clientSubnet = subnet || '10.9.9.0/24';
    const list = (Array.isArray(ifaces) && ifaces.length ? ifaces : ['awg0']).join(' ');
    const extra = (Array.isArray(extraNets) ? extraNets : []).join(' ');
    return [
        '#!/bin/bash',
        '# Каскад: маршруты входа (сгенерировано панелью Servpanel по CASCADE.md)',
        'set -euo pipefail',
        `CLIENT_SUBNET="${clientSubnet}"`,
        `CLIENT_IFACES="${list}"`,
        'AWG1_IF="awg1"',
        `AWG1_ENDPOINT="${endpointHost}"`,
        'TABLE_ID=100',
        'FWMARK="0x1"',
        'RULE_PRIO=10000',
        `EXTRA_RU_NETS="${extra}"`,
        'RU_ZONE_URL="https://www.ipdeny.com/ipblocks/data/aggregated/ru-aggregated.zone"',
        'RU_ZONE_FALLBACK_URL="https://raw.githubusercontent.com/bivlked/amneziawg-installer/main/cascade/ru.zone"',
        'AWG_DIR="/root/awg"',
        'RU_ZONE="$AWG_DIR/ru.zone"',
        'mkdir -p "$AWG_DIR"',
        'exec 9>"$AWG_DIR/awg-routing.lock"',
        'flock -w 300 9 || { echo "ERROR: другой экземпляр awg-routing.sh не завершился" >&2; exit 1; }',
        "trap 'rm -f \"$RU_ZONE.tmp\"' EXIT",
        '',
        'EP_ROUTE="$(ip -4 route get "$AWG1_ENDPOINT" 2>/dev/null | head -1)"',
        "WAN_IF=\"$(printf '%s' \"$EP_ROUTE\" | grep -oP '\\bdev \\K\\S+' || true)\"",
        "WAN_GW=\"$(printf '%s' \"$EP_ROUTE\" | grep -oP '\\bvia \\K\\S+' || true)\"",
        '{ [ -n "$WAN_IF" ] && [ "$WAN_IF" != "$AWG1_IF" ]; } || { echo "ERROR: не удалось определить WAN-интерфейс к AWG1" >&2; exit 1; }',
        '',
        'if [ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || echo 1)" = "0" ] \\',
        '   && ip -6 route show default 2>/dev/null | grep -q .; then',
        '    echo "WARN: IPv6 включён — IPv6-трафик пойдёт мимо каскада." >&2',
        'fi',
        '',
        'fetch_ru_zone() {',
        '    curl -fsS --retry 2 --retry-max-time 45 --connect-timeout 10 --max-time 30 \\',
        '        -o "$RU_ZONE.tmp" "$1" || return 1',
        '    local valid total',
        "    valid=$(grep -cE '^[0-9]{1,3}([.][0-9]{1,3}){3}(/[0-9]{1,2})?$' \"$RU_ZONE.tmp\" || true)",
        "    total=$(grep -c '[^[:space:]]' \"$RU_ZONE.tmp\" || true)",
        '    [ "$valid" -ge 1000 ] && [ "$valid" -eq "$total" ]',
        '}',
        'if fetch_ru_zone "$RU_ZONE_URL"; then',
        '    mv -f "$RU_ZONE.tmp" "$RU_ZONE"',
        'elif fetch_ru_zone "$RU_ZONE_FALLBACK_URL"; then',
        '    mv -f "$RU_ZONE.tmp" "$RU_ZONE"',
        '    echo "WARN: ipdeny недоступен — взял снимок RU-сетей из репозитория" >&2',
        'else',
        '    echo "WARN: не удалось скачать список RU-сетей — использую прежний локальный" >&2',
        'fi',
        '[ -s "$RU_ZONE" ] || { echo "ERROR: список RU-сетей пуст" >&2; exit 1; }',
        '',
        'ipset create ru hash:net -exist',
        'ipset create ru_tmp hash:net -exist',
        'ipset flush ru_tmp',
        'while read -r net; do [ -n "$net" ] && ipset add ru_tmp "$net" -exist; done < "$RU_ZONE"',
        'extra_bad=0',
        'set -f',
        'for net in $EXTRA_RU_NETS; do',
        '    ipset add ru_tmp "$net" -exist || { echo "WARN: EXTRA_RU_NETS: не добавил $net" >&2; extra_bad=$((extra_bad+1)); }',
        'done',
        'set +f',
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
        '# Подсеть интерфейса — из его connected route (например 172.16.17.0/24).',
        'iface_subnet() {',
        '    ip -4 route show dev "$1" scope link 2>/dev/null | awk \'NR==1{print $1}\'',
        '}',
        '',
        '# Снимаем старые правила со всех awg-интерфейсов, кроме туннеля awg1:',
        '# так убираются и интерфейсы, которые сняли галочкой.',
        'for if in $(ip -o link show 2>/dev/null | awk -F\': \' \'{print $2}\' | cut -d@ -f1 | grep -E \'^(awg|amn)[0-9]+$\'); do',
        '    [ "$if" = "$AWG1_IF" ] && continue',
        '    sub="$(iface_subnet "$if")"',
        '    [ -n "$sub" ] || continue',
        '    iptables -t mangle -D PREROUTING -i "$if" -s "$sub" -m set --match-set ru dst -j RETURN 2>/dev/null || true',
        '    iptables -t mangle -D PREROUTING -i "$if" -s "$sub" -j MARK --set-mark "$FWMARK" 2>/dev/null || true',
        '    iptables -t nat -D POSTROUTING -s "$sub" -o "$AWG1_IF" -j MASQUERADE 2>/dev/null || true',
        'done',
        '',
        'for if in $CLIENT_IFACES; do',
        '    sub="$(iface_subnet "$if")"',
        '    if [ -z "$sub" ] && [ "$if" = "awg0" ]; then sub="$CLIENT_SUBNET"; fi',
        '    [ -n "$sub" ] || { echo "WARN: у $if нет IPv4-подсети — пропускаю" >&2; continue; }',
        '    iptables -t mangle -C PREROUTING -i "$if" -s "$sub" -m set --match-set ru dst -j RETURN 2>/dev/null \\',
        '        || iptables -t mangle -I PREROUTING 1 -i "$if" -s "$sub" -m set --match-set ru dst -j RETURN',
        '    iptables -t mangle -C PREROUTING -i "$if" -s "$sub" -j MARK --set-mark "$FWMARK" 2>/dev/null \\',
        '        || iptables -t mangle -A PREROUTING -i "$if" -s "$sub" -j MARK --set-mark "$FWMARK"',
        '    iptables -t nat -C POSTROUTING -s "$sub" -o "$AWG1_IF" -j MASQUERADE 2>/dev/null \\',
        '        || iptables -t nat -A POSTROUTING -s "$sub" -o "$AWG1_IF" -j MASQUERADE',
        'done',
        '',
        'sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true',
        'if [ "$extra_bad" -gt 0 ]; then',
        '    echo "OK С ОГОВОРКОЙ: каскад применён, но из EXTRA_RU_NETS не добавлено $extra_bad" >&2',
        'else',
        '    echo "OK: каскадный роутинг применён (WAN=$WAN_IF, выход=$AWG1_IF, интерфейсы=$CLIENT_IFACES)"',
        'fi'
    ].join('\n') + '\n';
}

// Служба и таймер обновления маршрутов — как в CASCADE.md.
const ROUTING_SERVICE = [
    '[Unit]',
    'Description=AmneziaWG cascade routing (RU -> EU)',
    'After=awg-quick@awg0.service awg-quick@awg1.service network-online.target',
    'Requires=awg-quick@awg0.service awg-quick@awg1.service',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    // RemainAfterExit=no обязателен для таймера: иначе повторный start
    // считается выполненным и список RU-сетей не обновляется.
    'RemainAfterExit=no',
    'ExecStart=/root/awg/awg-routing.sh',
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
    'OnCalendar=*-*-* 01:00:00',
    'RandomizedDelaySec=15m',
    'Persistent=false',
    'Unit=awg-routing.service',
    '',
    '[Install]',
    'WantedBy=timers.target',
    ''
].join('\n');

module.exports = {
    AWG_CONF, AWG0_CONF, MANAGE, INSTALL_LOG, ROUTING_SCRIPT,
    ROUTING_SERVICE, ROUTING_TIMER,
    awgInfo, openUdp, installAwg, applyObf, waitForAwg, stopResume, createRuHost, cascadeConfig,
    clientSubnet, routingScript
};
