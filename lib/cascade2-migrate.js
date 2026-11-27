'use strict';

// Каскад 2: мягкий перенос с каскада 1 (SSH).
// Панель копирует клиентский awg0 с RU на EU вместе с ключом, обфускацией,
// портом и пирами, поднимает туннель awg1 и настраивает релей/фильтрацию.

const ssh = require('./cascade-ssh');

const AWG_DIR = '/etc/amnezia/amneziawg';
const AWG0 = AWG_DIR + '/awg0.conf';
const AWG1 = AWG_DIR + '/awg1.conf';

function cidrNetwork(cidr) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(cidr || '').trim());
    if (!m) return '';
    const ip = ((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0;
    const bits = Math.max(0, Math.min(32, Number(m[5])));
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    const net = (ip & mask) >>> 0;
    return [net >>> 24, (net >>> 16) & 255, (net >>> 8) & 255, net & 255].join('.') + '/' + bits;
}

function clientSubnets(iface) {
    const parts = String((iface && iface.Address) || '').split(',').map(x => x.trim());
    const nets = [];
    for (const p of parts) {
        const n = cidrNetwork(p);
        if (n && !nets.includes(n)) nets.push(n);
    }
    return nets.length ? nets : ['172.16.61.0/24'];
}

function parseIni(text) {
    const out = {};
    let sec = null;
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        const m = /^\[([A-Za-z0-9_-]+)\]$/.exec(line);
        if (m) { sec = m[1]; out[sec] = out[sec] || {}; continue; }
        const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
        if (kv && sec) out[sec][kv[1]] = kv[2].trim();
    }
    return out;
}

function obfLines(text) {
    return String(text || '').split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => /^(H[1-4]|S[1-4]|Jc|Jmin|Jmax|I[1-5]|HeaderProtectionKey|ContentPaddingAddition|RekeyAfterTime|RekeyTimeout|RejectAfterTime|KeepaliveTimeout|MaxHandshakeAttempts|RandomTrailers|DisableCookies)\s*=/.test(l));
}

function peersOf(text) {
    return (String(text || '').match(/\[Peer\][\s\S]*?(?=\[Peer\]|$)/g) || [])
        .map(p => p.trim()).filter(Boolean);
}

function buildRuClientIface(text, port) {
    const ini = parseIni(text);
    const iface = ini.Interface || {};
    const addr = String(iface.Address || '172.16.17.1/24');
    return [
        '[Interface]',
        ...obfLines(text),
        'PrivateKey = ' + String(iface.PrivateKey || '').trim(),
        'Address = ' + addr,
        'MTU = ' + (iface.MTU || 1280),
        // Слушаем именно порт входа релея: на него DNAT-ят клиентские пакеты.
        'ListenPort = ' + (Number(port) || 3977)
    ].join('\n');
}

// RU — сервер туннеля: принимает подключение EU (eu_host) для фильтрации.
function buildRuTunnelServer({ obf, priv, euPub, tunnelPort, subnets }) {
    const nets = Array.isArray(subnets) && subnets.length ? subnets : ['172.16.17.0/24'];
    const masqUp = nets.map(n => 'iptables -t nat -A POSTROUTING -s ' + n + ' -o ens3 -j MASQUERADE;').join(' ');
    const masqDown = nets.map(n => 'iptables -t nat -D POSTROUTING -s ' + n + ' -o ens3 -j MASQUERADE;').join(' ');
    return [
        '[Interface]',
        ...(Array.isArray(obf) ? obf : []),
        'PrivateKey = ' + priv,
        'Address = 172.16.62.1/24',
        'MTU = 1280',
        'ListenPort = ' + tunnelPort,
        'PostUp = iptables -I FORWARD -i %i -j ACCEPT; ' + masqUp + ' iptables -t mangle -A FORWARD -o %i -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu',
        'PostDown = iptables -D FORWARD -i %i -j ACCEPT; ' + masqDown,
        '',
        '[Peer]',
        '#_Name = eu_host',
        'PublicKey = ' + euPub,
        'AllowedIPs = ' + nets.join(', '),
        ''
    ].join('\n');
}

// EU — клиент туннеля: сам подключается к RU для российского выхода.
function buildEuTunnelClient({ obf, priv, ruPub, ruHost, tunnelPort }) {
    return [
        '[Interface]',
        ...(Array.isArray(obf) ? obf : []),
        'PrivateKey = ' + priv,
        'Address = 172.16.62.2/24',
        'MTU = 1280',
        'Table = off',
        '',
        '[Peer]',
        '#_Name = ru_host',
        'PublicKey = ' + ruPub,
        'Endpoint = ' + ruHost + ':' + tunnelPort,
        'AllowedIPs = 0.0.0.0/0, ::/0',
        'PersistentKeepalive = 25',
        ''
    ].join('\n');
}

// Конфиг без пиров: остаётся на RU после переноса, чтобы панель не показывала
// клиентов, которых там уже нет. Полный конфиг лежит в бэкапе.
function buildIfaceOnly(text) {
    const ini = parseIni(text);
    const iface = ini.Interface || {};
    return [
        '[Interface]',
        ...obfLines(text),
        'PrivateKey = ' + String(iface.PrivateKey || '').trim(),
        'Address = ' + String(iface.Address || '172.16.17.1/24').trim(),
        'MTU = ' + (iface.MTU || 1280),
        'ListenPort = ' + (iface.ListenPort || 3977),
        ''
    ].join('\n');
}

function b64(text) {
    return Buffer.from(String(text || ''), 'utf8').toString('base64');
}

async function sh(conn, command, timeout = 120000, label = '') {
    const r = await ssh.run(conn, command, timeout);
    if (r.code !== 0) {
        throw new Error((label ? label + ': ' : '') + String(r.out || '').trim().slice(-500));
    }
    return String(r.out || '');
}

async function readRemote(conn, file) {
    const out = await sh(conn, 'base64 -w0 ' + file + ' 2>/dev/null || true', 30000, 'чтение ' + file);
    const raw = out.trim();
    return raw ? Buffer.from(raw, 'base64').toString('utf8') : '';
}

async function writeRemote(conn, file, text, mode = 600) {
    await sh(conn, 'mkdir -p ' + AWG_DIR + ' && echo ' + b64(text) + ' | base64 -d > ' + file + ' && chmod ' + mode + ' ' + file, 30000, 'запись ' + file);
}

// Большие файлы (ru.zone, ru-restore.txt) передаём кусками: один аргумент
// команды SSH ограничен (Windows CreateProcess ~32K), иначе spawn E2BIG.
async function writeRemoteLarge(conn, file, text, mode = 600) {
    const data = Buffer.from(String(text || ''), 'utf8').toString('base64');
    await sh(conn, 'mkdir -p $(dirname ' + file + ') && : > ' + file, 20000, 'подготовка ' + file);
    for (let i = 0; i < data.length; i += 8000) {
        const chunk = data.slice(i, i + 8000);
        await sh(conn, "printf '%s' '" + chunk + "' | base64 -d >> " + file, 30000, 'запись ' + file);
    }
    await sh(conn, 'chmod ' + mode + ' ' + file, 15000);
}

async function writeJsonRemote(conn, text) {
    const dirs = await sh(conn, 'for d in /root/servpanel /root/awg-admin; do [ -d "$d" ] && echo "$d"; done | head -1', 15000);
    const dir = String(dirs || '').trim();
    if (!dir) return '';
    await sh(conn, 'echo ' + b64(text) + ' | base64 -d > ' + dir + '/.cascade2.json && chmod 600 ' + dir + '/.cascade2.json', 20000);
    return dir;
}

// Свободные/занятые UDP-порты на стороне. AWG-порты перед выбором освобождаем,
// остановив старые интерфейсы, поэтому 3977/4600 можно переиспользовать.
async function usedUdpPorts(conn) {
    const out = await sh(conn, "ss -lunH 2>/dev/null | awk '{print $4}' | sed 's/.*://' | grep -E '^[0-9]+$' | sort -u || true", 20000);
    return new Set(String(out).split(/\s+/).map(Number).filter(n => n > 0 && n < 65536));
}

async function awgListenPorts(conn) {
    const out = await sh(conn, "grep -hE '^[[:space:]]*ListenPort[[:space:]]*=' /etc/amnezia/amneziawg/*.conf 2>/dev/null | sed 's/[^0-9]//g' | sort -u || true", 20000);
    return new Set(String(out).split(/\s+/).map(Number).filter(n => n > 0 && n < 65536));
}

function pickFreeUdp(preferred, used, exclude) {
    const ex = new Set((exclude || []).map(Number));
    const free = (p) => p > 0 && p < 65536 && !used.has(p) && !ex.has(p);
    const p = Number(preferred) || 0;
    if (free(p)) return p;
    const starts = [p > 0 ? p + 1 : 3977, 20000, 30000, 40000, 50000];
    for (const start of starts) {
        for (let q = start; q < 65536; q++) if (free(q)) return q;
    }
    throw new Error('Не удалось подобрать свободный UDP-порт');
}

async function openUfwUdp(conn, port) {
    await sh(conn, 'ufw allow ' + port + '/udp >/dev/null 2>&1 || true', 20000);
}

// Закрываем старый AWG-порт: сначала правило /udp, затем общее правило,
// если оно осталось. Возвращает true, если правило действительно было.
async function closeUfwPort(conn, port) {
    const exists = await sh(conn, 'ufw status 2>/dev/null | grep -E "(^|[[:space:]])' + port + '(/udp)?[[:space:]]" | head -1 || true', 20000);
    if (!String(exists).trim()) return false;
    const script = [
        'ufw delete allow ' + port + '/udp >/dev/null 2>&1 || true',
        'num=$(ufw status numbered 2>/dev/null | grep -E "^\\[ *[0-9]+\\] ' + port + '( |$)" | sed -n "s/^\\[ *\\([0-9]*\\)\\].*/\\1/p" | head -1)',
        '[ -n "$num" ] && yes | ufw delete "$num" >/dev/null 2>&1 || true'
    ].join('; ');
    await sh(conn, script, 30000);
    return true;
}

function euRules(ifaces) {
    const markIf = ifaces.map(i => '-i ' + i).join(' ');
    return [
        'sysctl -w net.ipv4.ip_forward=1 >/dev/null',
        'ipset create ru hash:net -exist',
        'ipset create ru_tmp hash:net -exist',
        'ipset flush ru_tmp',
        '[ -f /root/awg/ru-restore.txt ] && ipset restore -exist < /root/awg/ru-restore.txt',
        'ipset swap ru_tmp ru; ipset destroy ru_tmp 2>/dev/null || true',
        'for i in $(seq 1 12); do iptables -t mangle -D PREROUTING ' + markIf + ' -m conntrack --ctstate NEW,INVALID -m set --match-set ru dst -j MARK --set-xmark 0x3001/0xffffffff 2>/dev/null || break; done',
        'for i in $(seq 1 12); do iptables -t mangle -D PREROUTING ' + markIf + ' -m conntrack --ctstate NEW,INVALID -j CONNMARK --save-mark 2>/dev/null || break; done',
        'for i in $(seq 1 12); do iptables -t mangle -D PREROUTING ' + markIf + ' -m conntrack --ctstate ESTABLISHED,RELATED -j CONNMARK --restore-mark 2>/dev/null || break; done',
        'iptables -t mangle -I PREROUTING 1 ' + markIf + ' -m conntrack --ctstate NEW,INVALID -m set --match-set ru dst -j MARK --set-xmark 0x3001/0xffffffff',
        'iptables -t mangle -I PREROUTING 2 ' + markIf + ' -m conntrack --ctstate NEW,INVALID -j CONNMARK --save-mark',
        'iptables -t mangle -I PREROUTING 3 ' + markIf + ' -m conntrack --ctstate ESTABLISHED,RELATED -j CONNMARK --restore-mark',
        'ip rule del fwmark 0x3001 table 3001 2>/dev/null || true',
        'ip rule add fwmark 0x3001 table 3001 priority 9000',
        'ip route replace default dev awg1 table 3001',
        'iptables -C FORWARD -i awg1 -j ACCEPT 2>/dev/null || iptables -I FORWARD 1 -i awg1 -j ACCEPT',
        'iptables -C FORWARD -o awg1 -j ACCEPT 2>/dev/null || iptables -I FORWARD 2 -o awg1 -j ACCEPT',
        'echo OK'
    ].join('\n');
}

function ruRelay(euHost, ports, tunnelPort, targetPort) {
    const dst = Number(targetPort) || ports[0];
    let s = 'sysctl -w net.ipv4.ip_forward=1 >/dev/null\n';
    for (const p of ports) {
        s += 'while rule=$(iptables -t nat -S PREROUTING | grep -E -- "--dport ' + p + ' .*(DNAT|REDIRECT)" | head -1); do [ -z "$rule" ] && break; args=${rule#-A PREROUTING }; iptables -t nat -D PREROUTING $args 2>/dev/null || break; done\n';
        s += 'iptables -t nat -A PREROUTING -p udp --dport ' + p + ' -j DNAT --to-destination ' + euHost + ':' + dst + '\n';
        s += 'iptables -C FORWARD -d ' + euHost + ' -p udp --dport ' + p + ' -j ACCEPT 2>/dev/null || iptables -I FORWARD 1 -d ' + euHost + ' -p udp --dport ' + p + ' -j ACCEPT\n';
        s += 'iptables -C FORWARD -s ' + euHost + ' -p udp --sport ' + p + ' -j ACCEPT 2>/dev/null || iptables -I FORWARD 1 -s ' + euHost + ' -p udp --sport ' + p + ' -j ACCEPT\n';
        s += 'iptables -t nat -C POSTROUTING -p udp -d ' + euHost + ' --dport ' + p + ' -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -p udp -d ' + euHost + ' --dport ' + p + ' -j MASQUERADE\n';
        s += 'ufw allow ' + p + '/udp >/dev/null 2>&1 || true\n';
    }
    // RU — сервер туннеля: порт туннеля должен быть открыт для EU.
    s += 'ufw allow ' + tunnelPort + '/udp >/dev/null 2>&1 || true\n';
    s += 'echo OK';
    return s;
}

async function detectLocalRole(conn) {
    try {
        const nat = await sh(conn, "iptables -t nat -S PREROUTING 2>/dev/null | grep -c -- '-j DNAT' || true", 15000);
        if (Number(String(nat).trim())) return 'ru';
        const mg = await sh(conn, "iptables -t mangle -S PREROUTING 2>/dev/null | grep -c '0x3001' || true", 15000);
        if (Number(String(mg).trim())) return 'eu';
    } catch (e) { /* ignore */ }
    const awg1 = await readRemote(conn, AWG1).catch(() => '');
    if (awg1) {
        const endpoint = /^\s*Endpoint\s*=/m.test(awg1);
        const euPeer = /#_Name\s*=\s*eu_host\b/.test(awg1);
        const ruPeer = /#_Name\s*=\s*ru_host\b/.test(awg1);
        if (endpoint) {
            // EU-клиент каскада 2 подключается к RU; RU-клиент каскада 1 — к EU.
            if (ruPeer) return 'eu';
            if (euPeer) return 'ru';
            return 'ru';
        }
        if (euPeer && /^\s*ListenPort\s*=/m.test(awg1)) return 'ru';
        if (ruPeer && /^\s*ListenPort\s*=/m.test(awg1)) return 'eu';
        if (/^\s*\[Interface\]/m.test(awg1)) return 'eu';
    }
    const awg0 = await readRemote(conn, AWG0).catch(() => '');
    const addr = (parseIni(awg0).Interface || {}).Address || '';
    const net = clientSubnets({ Address: addr })[0];
    if (net === '172.16.17.0/24') return 'ru';
    if (net === '172.16.61.0/24') return 'eu';
    return '';
}

async function migrate(opts, onStep) {
    const step = (title, text) => { try { onStep && onStep(title, text); } catch (e) { /* ignore */ } };
    const role = opts.role === 'eu' ? 'eu' : 'ru';
    const conn = {
        host: String(opts.peerHost || '').trim(),
        port: Number(opts.peerPort) || 22,
        user: String(opts.peerUser || 'root').trim() || 'root',
        pass: String(opts.peerPass || '')
    };
    if (!conn.host) throw new Error('Не указан адрес второй стороны');
    if (!conn.pass) throw new Error('Не указан пароль root второй стороны');
    const relayPorts = [...new Set((Array.isArray(opts.relayPorts) ? opts.relayPorts : [])
        .map(Number).filter(n => n > 0 && n < 65536))];
    let tunnelPort = Number(opts.tunnelPort) || 0;
    const ifaces = (Array.isArray(opts.ifaces) ? opts.ifaces : ['awg0']).filter(Boolean);

    const localConn = { host: '127.0.0.1' };
    // Не даём перепутать стороны: на входе awg1 — клиент с Endpoint, на выходе — сервер.
    const detectedRole = await detectLocalRole(localConn);
    if (detectedRole && detectedRole !== role) {
        const name = r => r === 'ru' ? 'вход (RU)' : 'выход (EU)';
        throw new Error('Этот сервер выглядит как ' + name(detectedRole) +
            ', а в мастере выбрана роль ' + name(role) +
            '. Запустите мастер на нужной стороне или выберите правильную роль.');
    }
    const ruConn = role === 'ru' ? localConn : conn;
    const euConn = role === 'ru' ? conn : localConn;
    const ruHost = role === 'ru' ? String(opts.localIp || '').trim() : conn.host;
    const euHost = role === 'eu' ? String(opts.localIp || '').trim() : conn.host;
    if (!ruHost) throw new Error('Не удалось определить публичный IP RU');
    if (ruHost === euHost) throw new Error('Адрес второй стороны совпадает с адресом этого сервера');

    step('SSH', 'Проверяю доступ ко второй стороне…');
    await sh(conn, 'echo SSH_OK', 30000, 'SSH');

    step('Конфиг RU', 'Читаю клиентский awg0 на RU…');
    const ruConf = await readRemote(ruConn, AWG0);
    if (!/^\s*\[Interface\]/m.test(ruConf)) throw new Error('На RU не найден awg0.conf');
    const ini = parseIni(ruConf);
    const ruIface = ini.Interface || {};
    const obf = obfLines(ruConf);
    const peers = peersOf(ruConf);
    if (!ruIface.PrivateKey) throw new Error('В awg0.conf на RU нет PrivateKey');
    if (!peers.length && !opts.allowEmpty) throw new Error('На RU в awg0.conf нет клиентских пиров');

    // Порты входа — те, на которые уже настроены клиенты. Если панель знает
    // несколько портов релея, они приходят в opts.relayPorts; иначе берём
    // ListenPort клиентского awg0.
    if (!relayPorts.length) {
        const p = Number(ruIface.ListenPort) || 0;
        if (p) relayPorts.push(p);
    }
    if (!relayPorts.length) relayPorts.push(3977);

    // Старые AWG-порты на обеих сторонах — их закроем, если они больше не нужны.
    step('Порты', 'Определяю свободные UDP-порты на EU…');
    const euConfOld = await readRemote(euConn, AWG0).catch(() => '');
    const eu1ConfOld = await readRemote(euConn, AWG1).catch(() => '');
    const ru1ConfOld = await readRemote(ruConn, AWG1).catch(() => '');
    const portOf = conf => Number((parseIni(conf).Interface || {}).ListenPort) || 0;
    const oldEuPorts = [portOf(euConfOld), portOf(eu1ConfOld)].filter(Boolean);
    const oldRuPorts = [portOf(ru1ConfOld)].filter(Boolean);
    for (const p of (Array.isArray(opts.oldPorts) ? opts.oldPorts : [])) {
        const n = Number(p);
        if (n > 0 && n < 65536) oldRuPorts.push(n);
    }

    // Останавливаем старые интерфейсы EU, чтобы их порты считались свободными
    // и 3977/4600 можно было переиспользовать без лишних изменений.
    await sh(euConn, 'systemctl stop awg-quick@awg0 awg-quick@awg1 2>/dev/null || true', 30000);
    const usedEu = await usedUdpPorts(euConn);
    const clientPort = pickFreeUdp(relayPorts[0] || 3977, usedEu, []);
    usedEu.add(clientPort);
    tunnelPort = pickFreeUdp(tunnelPort || 4600, usedEu, [clientPort]);
    step('Порты', 'Вход RU: ' + relayPorts.join(', ') + ' → EU:' + clientPort +
        '; туннель EU → RU: ' + tunnelPort + ' (подобрано автоматически)');

    const subnets = clientSubnets(ruIface);
    const clientIface = buildRuClientIface(ruConf, clientPort);
    let euAwg0 = clientIface + (peers.length ? '\n\n' + peers.join('\n\n') : '') + '\n';
    let copyClientsFromRu = peers.length > 0;
    // Повторный перенос: RU awg0 уже пуст, клиенты живут на EU. Не затираем
    // их пустым конфигом — берём рабочий awg0 с EU и только меняем порт.
    const euPeersRe = peersOf(euConfOld);
    if (!peers.length && euPeersRe.length) {
        const withPort = euConfOld.replace(/^\s*ListenPort\s*=.*$/m, 'ListenPort = ' + clientPort);
        euAwg0 = /^\s*ListenPort\s*=/m.test(withPort)
            ? withPort
            : withPort.replace(/\n\s*\[Peer\]/, '\nListenPort = ' + clientPort + '\n\n[Peer]');
        copyClientsFromRu = false;
    }
    const peerNames = [];
    for (const p of (peers.length ? peers : euPeersRe)) {
        const m = /#_Name\s*=\s*(\S+)/.exec(p);
        if (m && !peerNames.includes(m[1])) peerNames.push(m[1]);
    }

    const ruKeys = opts.ruTunnelKeys;
    const euKeys = opts.euTunnelKeys;
    if (!ruKeys || !euKeys) throw new Error('Не переданы ключи туннеля');
    step('Туннель', 'Генерирую конфиги awg1: RU-сервер eu_host ← EU-клиент ru_host…');
    const ruAwg1 = buildRuTunnelServer({
        obf, priv: ruKeys.priv, euPub: euKeys.pub, tunnelPort, subnets
    });
    const euAwg1 = buildEuTunnelClient({ obf, priv: euKeys.priv, ruPub: ruKeys.pub, ruHost, tunnelPort });

    // EU: бэкап, awg0 (ключ и обфускация RU), awg1, рестарт.
    step('EU', 'Сохраняю бэкап и записываю конфиги на EU…');
    await sh(euConn, 'cp -a ' + AWG0 + ' ' + AWG0 + '.c2bak.$(date +%s) 2>/dev/null || true; cp -a ' + AWG1 + ' ' + AWG1 + '.c2bak.$(date +%s) 2>/dev/null || true', 30000);
    await writeRemote(euConn, AWG0, euAwg0);
    await writeRemote(euConn, AWG1, euAwg1);
    await sh(euConn, 'systemctl enable awg-quick@awg0 >/dev/null 2>&1 || true; systemctl restart awg-quick@awg0', 60000, 'awg0 EU');
    await sh(euConn, 'systemctl enable --now awg-quick@awg1 >/dev/null 2>&1 || true; systemctl restart awg-quick@awg1', 60000, 'awg1 EU');
    await sh(euConn, 'ufw allow ' + clientPort + '/udp >/dev/null 2>&1 || true; ufw allow ' + tunnelPort + '/udp >/dev/null 2>&1 || true');

    step('Клиенты', copyClientsFromRu ? 'Копирую файлы клиентских конфигов на EU…' : 'Клиенты уже на EU — файлы не трогаю…');
    if (copyClientsFromRu) {
        for (const name of peerNames) {
            for (const ext of ['.conf', '.vpnuri']) {
                const remote = '/root/awg/' + name + ext;
                const content = await readRemote(ruConn, remote);
                if (!content) continue;
                await writeRemote(euConn, remote, content, 600);
            }
        }
    }

    // ru.zone на EU, если нет.
    step('Фильтрация', 'Проверяю список российских сетей на EU…');
    const zoneSize = await sh(euConn, 'stat -c %s /root/awg/ru.zone 2>/dev/null || echo 0', 15000);
    if ((Number(String(zoneSize).trim()) || 0) < 2048) {
        const zone = await readRemote(ruConn, '/root/awg/ru.zone');
        if (zone.length < 2048) throw new Error('На RU нет ru.zone — нечем фильтровать');
        await writeRemoteLarge(euConn, '/root/awg/ru.zone', zone, 644);
        const nets = zone.split(/\s+/).filter(x => /^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(x));
        await writeRemoteLarge(euConn, '/root/awg/ru-restore.txt', nets.map(n => 'add ru_tmp ' + n).join('\n') + '\n', 644);
    }
    await sh(euConn, euRules(ifaces), 120000, 'правила EU');

    // EU: убираем старый клиент ru_host — теперь это пир туннеля, а не клиент.
    const stamp = Date.now();
    await sh(euConn, 'mkdir -p /root/awg/c2backup-' + stamp + '; sh -c "mv -f /root/awg/ru_host.conf /root/awg/ru_host.png /root/awg/ru_host.vpnuri /root/awg/ru_host.vpnuri.png /root/awg/c2backup-' + stamp + '/ 2>/dev/null || true"', 20000);

    // RU: клиенты переехали на EU. Гасим awg0, убираем пиров и файлы,
    // оставляя полный бэкап для отката. Иначе панель RU показывает клиентов,
    // которых там уже нет.
    step('Клиенты', 'Отключаю awg0 на RU и убираю клиентов — они теперь на EU…');
    await sh(ruConn, 'systemctl disable --now awg-quick@awg0 2>/dev/null || true', 30000);
    await sh(ruConn, 'mkdir -p /root/awg/c2backup-' + stamp + ' && cp -a ' + AWG0 + ' /root/awg/c2backup-' + stamp + '/awg0.conf', 30000);
    for (const name of [...peerNames, 'ru_host']) {
        await sh(ruConn, 'sh -c "mv -f /root/awg/' + name + '.conf /root/awg/' + name + '.png /root/awg/' + name + '.vpnuri /root/awg/' + name + '.vpnuri.png /root/awg/c2backup-' + stamp + '/ 2>/dev/null || true"', 20000);
    }
    await writeRemote(ruConn, AWG0, buildIfaceOnly(ruConf));

    step('RU', 'Поднимаю awg1 (RU-сервер, пир eu_host) и релей на RU…');
    await sh(ruConn, 'cp -a ' + AWG1 + ' ' + AWG1 + '.c2bak.$(date +%s) 2>/dev/null || true', 30000);
    await writeRemote(ruConn, AWG1, ruAwg1);
    await sh(ruConn, 'systemctl enable awg-quick@awg1 >/dev/null 2>&1 || true; systemctl restart awg-quick@awg1', 60000, 'awg1 RU');
    await sh(ruConn, ruRelay(euHost, relayPorts, tunnelPort, clientPort), 60000, 'релей RU');

    // Новый клиент на EU (для чистой установки или по желанию).
    let createdClient = '';
    if (opts.createClient) {
        const name = String(opts.createClient).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
        if (name) {
            step('Клиент', 'Создаю клиента ' + name + ' на EU…');
            await sh(euConn, 'bash /root/awg/manage_amneziawg.sh add ' + name + ' --json', 120000, 'клиент ' + name);
            const cf = await readRemote(euConn, '/root/awg/' + name + '.conf');
            if (/\[Interface\]/.test(cf)) {
                const fixed = cf.replace(/^Endpoint\s*=.*$/m, 'Endpoint = ' + ruHost + ':' + relayPorts[0]);
                await writeRemote(euConn, '/root/awg/' + name + '.conf', fixed, 600);
                createdClient = name;
            }
        }
    }

    // Каскад 1 больше не нужен: отключаем его таймер маршрутов и снимаем
    // пометки 0x1/таблицу 100. Иначе таймер вернёт правила и будет мешать.
    step('RU', 'Отключаю старые правила каскада 1…');
    await sh(ruConn, [
        'systemctl disable --now awg-routing.timer awg-routing.service 2>/dev/null || true',
        'ip rule del fwmark 0x1 table 100 2>/dev/null || true',
        'ip route flush table 100 2>/dev/null || true',
        "iptables -t mangle -S PREROUTING 2>/dev/null | grep -E 'set-mark 0x1|set-xmark 0x1' | sed 's/^-A /-D /' | xargs -r -L1 iptables -t mangle 2>/dev/null || true",
        "iptables -t nat -S POSTROUTING 2>/dev/null | grep -E -- '-o awg1 .*MASQUERADE' | sed 's/^-A /-D /' | xargs -r -L1 iptables -t nat 2>/dev/null || true",
        opts.cleanRu ? 'ipset destroy ru 2>/dev/null || true' : 'true',
        opts.cleanRu ? 'rm -f /root/awg/awg-routing.sh /etc/systemd/system/awg-routing.service /etc/systemd/system/awg-routing.timer' : 'true',
        'systemctl daemon-reload',
        'echo OK'
    ].join('; '), 60000, 'очистка каскада 1');

    // Старые AWG-порты, которые больше не используются, закрываем в UFW.
    // Активные порты и порты других служб не трогаем.
    step('Порты', 'Закрываю старые неиспользуемые порты AWG…');
    const protectedPorts = new Set([22, 80, 443, 4444, 4446, 2999, 53]);
    const euAwgPorts = await awgListenPorts(euConn);
    const euListening = await usedUdpPorts(euConn);
    const ruAwgPorts = await awgListenPorts(ruConn);
    const ruListening = await usedUdpPorts(ruConn);
    for (const p of oldEuPorts) {
        if (!euAwgPorts.has(p) && !euListening.has(p) && !protectedPorts.has(p)) {
            if (await closeUfwPort(euConn, p)) step('Порты', 'Закрыт старый порт EU ' + p + '/udp');
        }
    }
    for (const p of oldRuPorts) {
        if (!ruAwgPorts.has(p) && !ruListening.has(p) && !relayPorts.includes(p) && !protectedPorts.has(p)) {
            if (await closeUfwPort(ruConn, p)) step('Порты', 'Закрыт старый порт RU ' + p + '/udp');
        }
    }

    // Состояние для панели.
    const state = {
        type: 'relay', enabled: true, ruPort: relayPorts[0], ruExitPort: tunnelPort,
        ports: relayPorts, euPort: clientPort, euHost, ruIp: ruHost, ifaces,
        clientEndpoint: ruHost + ':' + relayPorts[0]
    };
    step('Проверка', 'Жду handshake туннеля…');
    let hs = -1;
    for (let i = 0; i < 12; i++) {
        const out = await sh(ruConn, 'awg show awg1 latest-handshakes 2>/dev/null | awk \'{print $2}\' | head -1', 15000);
        const t = Number(String(out).trim()) || 0;
        if (t > 0) { hs = Math.max(0, Math.floor(Date.now() / 1000) - t); if (hs < 120) break; }
        await new Promise(r => setTimeout(r, 2000));
    }
    step('Готово', hs >= 0 ? 'Туннель поднят, handshake ' + hs + ' с' : 'Туннель записан, но handshake пока нет');
    await writeJsonRemote(euConn, JSON.stringify(state));
    if (role === 'ru') await writeJsonRemote(localConn, JSON.stringify(state));

    return {
        success: true,
        role,
        ruHost, euHost,
        ports: relayPorts,
        tunnelPort,
        clientPort,
        peers: peers.length,
        createdClient,
        handshakeAge: hs,
        state
    };
}

const PURGE_AWG = `#!/bin/bash
export DEBIAN_FRONTEND=noninteractive
pkill -f '[i]nstall_awg_stateful.sh' 2>/dev/null || true
pkill -f '[i]nstall_amneziawg.sh' 2>/dev/null || true
systemctl disable --now awg-quick@awg0 awg-quick@awg1 2>/dev/null || true
apt-get purge -y amneziawg amneziawg-dkms amneziawg-tools >/dev/null 2>&1 || true
dkms status 2>/dev/null | grep -i amneziawg | cut -d, -f1 | while read -r m; do dkms remove "$m" --all >/dev/null 2>&1 || true; done
rm -rf /var/lib/dkms/amneziawg /usr/src/amneziawg-* /etc/amnezia/amneziawg /root/awg
find /lib/modules -path "*/updates/dkms/amneziawg.ko*" -delete 2>/dev/null || true
depmod -a >/dev/null 2>&1 || true
dpkg --configure -a >/dev/null 2>&1 || true
apt-get -f install -y >/dev/null 2>&1 || true
echo purge-done
`;

const CLEAN_AWG_KEEP = `#!/bin/bash
set -e
for u in awg-quick@awg0 awg-quick@awg1; do systemctl stop "$u" 2>/dev/null || true; systemctl disable "$u" 2>/dev/null || true; done
conf=/etc/amnezia/amneziawg/awg0.conf
if [ -f "$conf" ]; then
  cp -a "$conf" "$conf.keepawg.$(date +%s)"
  sed -i -E '/^[[:space:]]*(Jc|Jmin|Jmax|S1|S2|S3|S4|H1|H2|H3|H4|I1|I2|I3|I4|I5|HeaderProtectionKey|ContentPaddingAddition|RekeyAfterTime|RekeyTimeout|RejectAfterTime|KeepaliveTimeout|MaxHandshakeAttempts|RandomTrailers|DisableCookies)[[:space:]]*=/d' "$conf"
  awk 'BEGIN{keep=1} /^\\[Peer\\]/{keep=0} /^\\[Interface\\]/{keep=1} {if(keep) print}' "$conf" > "$conf.tmp" && mv "$conf.tmp" "$conf"
fi
rm -f /root/awg/*.conf /root/awg/*.png /root/awg/*.vpnuri /root/awg/*.vpnuri.png
rm -f /root/awg/keys/*.private /root/awg/keys/*.public /root/awg/server_hpk.key
echo keep-awg-cleaned
`;

module.exports = { migrate, detectLocalRole, PURGE_AWG, CLEAN_AWG_KEEP, closeUfwPort, usedUdpPorts, awgListenPorts };
