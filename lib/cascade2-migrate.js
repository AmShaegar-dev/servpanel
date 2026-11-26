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
        .filter(l => /^(H[1-4]|S[1-4]|Jc|Jmin|Jmax|I[1-5])\s*=/.test(l));
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

function buildRuTunnelConf({ obf, priv, pub, listenPort, subnets }) {
    const nets = Array.isArray(subnets) && subnets.length ? subnets : ['172.16.61.0/24'];
    const masqUp = nets.map(n => 'iptables -t nat -A POSTROUTING -s ' + n + ' -o ens3 -j MASQUERADE;').join(' ');
    const masqDown = nets.map(n => 'iptables -t nat -D POSTROUTING -s ' + n + ' -o ens3 -j MASQUERADE;').join(' ');
    return [
        '[Interface]',
        ...(Array.isArray(obf) ? obf : []),
        'PrivateKey = ' + priv,
        'Address = 172.16.62.1/24',
        'MTU = 1280',
        'ListenPort = ' + listenPort,
        'PostUp = iptables -I FORWARD -i %i -j ACCEPT; ' + masqUp + ' iptables -t mangle -A FORWARD -o %i -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu',
        'PostDown = iptables -D FORWARD -i %i -j ACCEPT; ' + masqDown,
        '',
        '[Peer]',
        '#_Name = eu_host',
        'PublicKey = ' + pub,
        'AllowedIPs = ' + nets.join(', '),
        ''
    ].join('\n');
}

function buildEuTunnelConf({ obf, priv, ruPub, ruHost, ruPort }) {
    return [
        '[Interface]',
        ...(Array.isArray(obf) ? obf : []),
        'PrivateKey = ' + priv,
        'Address = 172.16.62.2/24',
        'MTU = 1280',
        'Table = off',
        '',
        '[Peer]',
        'PublicKey = ' + ruPub,
        'Endpoint = ' + ruHost + ':' + ruPort,
        'AllowedIPs = 0.0.0.0/0, ::/0',
        'PersistentKeepalive = 25',
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
        s += 'while rule=$(iptables -t nat -S PREROUTING | grep -E -- "--dport ' + p + ' .* -j (DNAT|REDIRECT)" | head -1); do [ -z "$rule" ] && break; args=${rule#-A PREROUTING }; iptables -t nat -D PREROUTING $args 2>/dev/null || break; done\n';
        s += 'iptables -t nat -A PREROUTING -p udp --dport ' + p + ' -j DNAT --to-destination ' + euHost + ':' + dst + '\n';
        s += 'iptables -C FORWARD -d ' + euHost + ' -p udp --dport ' + p + ' -j ACCEPT 2>/dev/null || iptables -I FORWARD 1 -d ' + euHost + ' -p udp --dport ' + p + ' -j ACCEPT\n';
        s += 'iptables -C FORWARD -s ' + euHost + ' -p udp --sport ' + p + ' -j ACCEPT 2>/dev/null || iptables -I FORWARD 1 -s ' + euHost + ' -p udp --sport ' + p + ' -j ACCEPT\n';
        s += 'iptables -t nat -C POSTROUTING -p udp -d ' + euHost + ' --dport ' + p + ' -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -p udp -d ' + euHost + ' --dport ' + p + ' -j MASQUERADE\n';
        s += 'ufw allow ' + p + '/udp >/dev/null 2>&1 || true\n';
    }
    s += 'ufw allow ' + tunnelPort + '/udp >/dev/null 2>&1 || true\n';
    s += 'echo OK';
    return s;
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
    const relayPorts = (Array.isArray(opts.relayPorts) ? opts.relayPorts : [])
        .map(Number).filter(n => n > 0 && n < 65536);
    if (!relayPorts.length) relayPorts.push(3977);
    const tunnelPort = Number(opts.tunnelPort) || 4600;
    const ifaces = (Array.isArray(opts.ifaces) ? opts.ifaces : ['awg0']).filter(Boolean);

    const localConn = { host: '127.0.0.1' };
    const ruConn = role === 'ru' ? localConn : conn;
    const euConn = role === 'ru' ? conn : localConn;
    const ruHost = role === 'ru' ? String(opts.localIp || '').trim() : conn.host;
    const euHost = role === 'eu' ? String(opts.localIp || '').trim() : conn.host;
    if (!ruHost) throw new Error('Не удалось определить публичный IP RU');

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
    if (!peers.length) throw new Error('На RU в awg0.conf нет клиентских пиров');
    const clientPort = relayPorts[0];
    const subnets = clientSubnets(ruIface);
    const clientIface = buildRuClientIface(ruConf, clientPort);
    const euAwg0 = clientIface + '\n\n' + peers.join('\n\n') + '\n';
    const peerNames = [];
    for (const p of peers) {
        const m = /#_Name\s*=\s*(\S+)/.exec(p);
        if (m && !peerNames.includes(m[1])) peerNames.push(m[1]);
    }

    const ruKeys = opts.ruTunnelKeys;
    const euKeys = opts.euTunnelKeys;
    if (!ruKeys || !euKeys) throw new Error('Не переданы ключи туннеля');
    step('Туннель', 'Генерирую конфиги awg1 и переношу awg0 на EU…');
    const ruAwg1 = buildRuTunnelConf({ obf, priv: ruKeys.priv, pub: euKeys.pub, listenPort: tunnelPort, subnets });
    const euAwg1 = buildEuTunnelConf({ obf, priv: euKeys.priv, ruPub: ruKeys.pub, ruHost, ruPort: tunnelPort });

    // EU: бэкап, awg0 (ключ и обфускация RU), awg1, рестарт.
    step('EU', 'Сохраняю бэкап и записываю конфиги на EU…');
    await sh(euConn, 'cp -a ' + AWG0 + ' ' + AWG0 + '.c2bak.$(date +%s) 2>/dev/null || true; cp -a ' + AWG1 + ' ' + AWG1 + '.c2bak.$(date +%s) 2>/dev/null || true', 30000);
    await writeRemote(euConn, AWG0, euAwg0);
    await writeRemote(euConn, AWG1, euAwg1);
    await sh(euConn, 'systemctl enable awg-quick@awg0 >/dev/null 2>&1 || true; systemctl restart awg-quick@awg0', 60000, 'awg0 EU');
    await sh(euConn, 'systemctl enable --now awg-quick@awg1 >/dev/null 2>&1 || true; systemctl restart awg-quick@awg1', 60000, 'awg1 EU');
    await sh(euConn, 'ufw allow ' + clientPort + '/udp >/dev/null 2>&1 || true');

    step('Клиенты', 'Копирую файлы клиентских конфигов на EU…');
    for (const name of peerNames) {
        for (const ext of ['.conf', '.vpnuri']) {
            const remote = '/root/awg/' + name + ext;
            const content = await readRemote(ruConn, remote);
            if (!content) continue;
            await writeRemote(euConn, remote, content, 600);
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

    // RU: туннель, релей, отключение клиентского awg0.
    // RU: сначала отключаем клиентский awg0 — иначе его маршрут 172.16.17.0/24
    // конфликтует с AllowedIPs туннеля, и awg-quick@awg1 не стартует.
    step('Клиенты', 'Отключаю клиентский awg0 на RU — клиенты переходят на EU…');
    await sh(ruConn, 'systemctl disable --now awg-quick@awg0 2>/dev/null || true', 30000);

    step('RU', 'Поднимаю awg1 и релей на RU…');
    await sh(ruConn, 'cp -a ' + AWG1 + ' ' + AWG1 + '.c2bak.$(date +%s) 2>/dev/null || true', 30000);
    await writeRemote(ruConn, AWG1, ruAwg1);
    await sh(ruConn, 'systemctl enable awg-quick@awg1 >/dev/null 2>&1 || true; systemctl restart awg-quick@awg1', 60000, 'awg1 RU');
    await sh(ruConn, ruRelay(euHost, relayPorts, tunnelPort, clientPort), 60000, 'релей RU');

    // Состояние для панели.
    const state = {
        type: 'relay', enabled: true, ruPort: relayPorts[0], ruExitPort: tunnelPort,
        ports: relayPorts, euHost, ruIp: ruHost, ifaces, clientEndpoint: ''
    };
    step('Проверка', 'Жду handshake туннеля…');
    let hs = -1;
    for (let i = 0; i < 12; i++) {
        const out = await sh(euConn, 'awg show awg1 latest-handshakes 2>/dev/null | awk \'{print $2}\' | head -1', 15000);
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
        handshakeAge: hs,
        state
    };
}

module.exports = { migrate };
