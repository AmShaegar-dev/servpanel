process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const app = express();

const passFile = path.join(__dirname, 'admin_pass.txt');
let ADMIN_PASSWORD = fs.existsSync(passFile) ? fs.readFileSync(passFile, 'utf8').trim() : "admin123";
const AUTH_SECRET = 'awg-secure-secret-9912';

function getAuthToken(password) {
    return crypto.createHmac('sha256', AUTH_SECRET).update(password).digest('hex');
}

function auditLog(req, action) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const date = new Date().toISOString().replace(/T/, ' ').slice(0, 19);
    try { fs.appendFileSync('/var/log/awg_audit.log', `[${date}] IP: ${ip} | ACTION: ${action}\n`); } catch(e){}
}

app.use(express.json({ limit: '100mb' }));

app.use(session({
    secret: 'awg-secure-key-773',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.static('public'));

app.post('/api/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) {
        req.session.loggedIn = true;
        res.cookie('awg_auth', getAuthToken(ADMIN_PASSWORD), { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true });
        auditLog(req, 'Успешный вход в панель');
        res.json({ success: true });
    } else {
        auditLog(req, 'Неудачная попытка входа (неверный пароль)');
        res.status(401).json({ error: "Неверный пароль" });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.clearCookie('awg_auth');
    auditLog(req, 'Выход из панели');
    res.json({ success: true });
});

const checkAuth = (req, res, next) => {
    if (req.session && req.session.loggedIn) return next();
    
    const cookies = req.headers.cookie || '';
    if (cookies.includes('awg_auth=' + getAuthToken(ADMIN_PASSWORD))) {
        if (req.session) req.session.loggedIn = true;
        return next();
    }
    res.status(401).json({ error: "Unauthorized" });
};

// СБОР ИСТОРИИ ТРАФИКА
let historyData = { global: { labels: [], rx: [], tx: [] } };
let lastHistoryStats = {}; 
const MAX_HISTORY_POINTS = 360;

function collectHistory() {
    exec(`sudo bash /root/awg/manage_amneziawg.sh stats --json`, (error, stdout) => {
        try {
            const jsonStart = stdout.indexOf('[');
            if (jsonStart === -1) return;
            const data = JSON.parse(stdout.substring(jsonStart));
            const now = new Date();
            const timeLabel = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0') + ':' + now.getSeconds().toString().padStart(2, '0');
            
            let totalRxSpeed = 0;
            let totalTxSpeed = 0;

            data.forEach(client => {
                let rxSpeed = 0, txSpeed = 0;
                if (lastHistoryStats[client.name]) {
                    const prev = lastHistoryStats[client.name];
                    const timeDiffSec = (now.getTime() - prev.time) / 1000;
                    if (timeDiffSec > 0 && client.rx >= prev.rx) {
                        rxSpeed = (client.rx - prev.rx) / timeDiffSec;
                        txSpeed = (client.tx - prev.tx) / timeDiffSec;
                    }
                }
                lastHistoryStats[client.name] = { rx: client.rx, tx: client.tx, time: now.getTime() };
                totalRxSpeed += rxSpeed;
                totalTxSpeed += txSpeed;

                if (!historyData[client.name]) historyData[client.name] = { labels: [], rx: [], tx: [] };
                historyData[client.name].labels.push(timeLabel);
                historyData[client.name].rx.push(rxSpeed);
                historyData[client.name].tx.push(txSpeed);
                
                if (historyData[client.name].labels.length > MAX_HISTORY_POINTS) {
                    historyData[client.name].labels.shift();
                    historyData[client.name].rx.shift();
                    historyData[client.name].tx.shift();
                }
            });

            historyData.global.labels.push(timeLabel);
            historyData.global.rx.push(totalRxSpeed);
            historyData.global.tx.push(totalTxSpeed);
            
            if (historyData.global.labels.length > MAX_HISTORY_POINTS) {
                historyData.global.labels.shift();
                historyData.global.rx.shift();
                historyData.global.tx.shift();
            }
        } catch (e) {}
    });
}
collectHistory();
setInterval(collectHistory, 10000);

app.get('/api/history', checkAuth, (req, res) => {
    res.json(historyData);
});

// СИСТЕМНЫЕ МЕТРИКИ
app.get('/api/sysinfo', checkAuth, (req, res) => {
    try {
        const totalRAM = os.totalmem(), freeRAM = os.freemem();
        const ramPercent = (((totalRAM - freeRAM) / totalRAM) * 100).toFixed(1);
        const cores = os.cpus().length;
        let cpuLoad = ((os.loadavg()[0] / cores) * 100).toFixed(1);
        if (cpuLoad > 100) cpuLoad = 100;
        const uptimeSec = os.uptime();
        const d = Math.floor(uptimeSec / (3600*24)), h = Math.floor(uptimeSec % (3600*24) / 3600), m = Math.floor(uptimeSec % 3600 / 60);

        let disk = { total: 0, used: 0, free: 0, percent: "0%" };
        try {
            const dfStr = execSync("df -B1 --output=size,used,avail,pcent / | tail -1").toString().trim();
            const df = dfStr.split(/\s+/);
            disk = { total: parseInt(df[0]), used: parseInt(df[1]), free: parseInt(df[2]), percent: df[3] };
        } catch(e) {}

        res.json({ cpu: cpuLoad, ram: ramPercent, uptime: `${d}д ${h}ч ${m}м`, disk });
    } catch (e) { res.status(500).json({ error: "Ошибка чтения метрик" }); }
});

app.get('/api/interfaces', checkAuth, (req, res) => {
    res.json(Object.keys(os.networkInterfaces()));
});

// UFW ПОРТЫ
app.get('/api/ufw', checkAuth, (req, res) => {
    try {
        const ufwOut = execSync('sudo ufw status numbered || true').toString().split('\n');
        const rules = [];
        ufwOut.forEach(line => {
            const match = line.match(/^\[\s*(\d+)\]\s+(.*?)\s+(ALLOW IN|DENY IN|REJECT IN|ALLOW|DENY|REJECT)\s+(.*)$/);
            if(match) rules.push({ id: match[1], to: match[2].trim(), action: match[3], from: match[4].trim() });
        });
        const ssOut = execSync('sudo ss -tunlp | tail -n +2 || true').toString().trim().split('\n');
        const ports = ssOut.filter(l => l).map(line => {
            const parts = line.trim().split(/\s+/);
            if(parts.length < 6) return null;
            const procMatch = (parts[6] || '').match(/"([^"]+)"/);
            return { proto: parts[0], addr: parts[4], proc: procMatch ? procMatch[1] : 'Система' };
        }).filter(Boolean);
        res.json({ rules, ports });
    } catch(e) { res.status(500).json({ error: "Ошибка" }); }
});

app.post('/api/ufw', checkAuth, (req, res) => {
    const { port, proto, iface } = req.body;
    if (!port || isNaN(port)) return res.status(400).json({ error: "Укажите корректный порт" });
    try {
        let cmd = `sudo ufw allow `;
        if (iface && iface !== 'any') cmd += `in on ${iface} `;
        cmd += `to any port ${port}`;
        if (proto && proto !== 'any') cmd += ` proto ${proto}`;
        execSync(cmd); execSync('sudo ufw reload');
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: "Ошибка добавления" }); }
});

app.delete('/api/ufw/:id', checkAuth, (req, res) => {
    try { execSync(`sudo ufw --force delete ${req.params.id}`); res.json({ success: true }); } 
    catch(e) { res.status(500).json({ error: "Ошибка удаления" }); }
});

// СЕТЕВЫЕ ИНСТРУМЕНТЫ
app.get('/api/tools/status', checkAuth, (req, res) => {
    let ruCount = 0, ruActive = false, ruIfaces = [];
    try {
        const count = execSync("sudo ipset list ru_block | grep -c '^[0-9]' || true").toString().trim();
        ruCount = parseInt(count);
        ruActive = ruCount > 0;
        const matchStr = execSync("sudo iptables -S FORWARD || true").toString();
        const matches = [...matchStr.matchAll(/-i\s+(\S+)\s+-m set --match-set ru_block/g)];
        ruIfaces = [...new Set(matches.map(m => m[1]))];
    } catch(e) {}

    let cascActive = false, cascIfaces = [];
    try {
        const mangleStr = execSync("sudo iptables -t mangle -S PREROUTING || true").toString();
        const matches = [...mangleStr.matchAll(/-A PREROUTING.*? -i\s+(\S+).*?-j MARK --set.*mark 0x1/g)];
        cascIfaces = [...new Set(matches.map(m => m[1]))];
        cascActive = cascIfaces.length > 0;
    } catch(e) {}

    let dnsActive = false, dnsTarget = '', dnsIfaces = [];
    try {
        const natStr = execSync("sudo iptables -t nat -S PREROUTING || true").toString();
        const matches = [...natStr.matchAll(/-A PREROUTING -i\s+(\S+).*?--dport 53 -j DNAT --to-destination\s+(\S+)/g)];
        dnsIfaces = [...new Set(matches.map(m => m[1]))];
        if (matches.length > 0) dnsTarget = matches[0][2];
        dnsActive = dnsIfaces.length > 0;
    } catch(e) {}
    
    // Исправленная строчка: теперь сервер корректно возвращает массивы интерфейсов
    res.json({
        ruDrop: { active: ruActive, count: ruCount, ifaces: ruIfaces },
        cascade: { active: cascActive, ifaces: cascIfaces },
        dns: { active: dnsActive, ifaces: dnsIfaces, target: dnsTarget }
    });
});

app.post('/api/tools/rudrop', checkAuth, (req, res) => {
    const { ifaces, schedule, enable } = req.body;
    try { execSync('sudo rm -f /etc/cron.d/ru-drop-refresh /root/awg/ru-drop.sh'); } catch(e){}
    try {
        execSync("sudo iptables -S FORWARD || true").toString().split('\n').forEach(rule => {
            if(rule.includes('ru_block')) execSync(`sudo iptables -D FORWARD ${rule.replace(/^-A FORWARD /, '')} || true`);
        });
    } catch(e){}

    if (!enable) {
        try { execSync(`sudo ipset destroy ru_block`); } catch(e){}
        return res.json({success: true});
    }

    if (!ifaces || ifaces.length === 0) return res.status(400).json({error: "Выберите интерфейсы"});

    const scriptContent = `#!/bin/bash\nset -euo pipefail\nIFACES=(${ifaces.join(' ')})\nRU_ZONE_URL="https://www.ipdeny.com/ipblocks/data/aggregated/ru-aggregated.zone"\nAWG_DIR="/root/awg"\nRU_ZONE="$AWG_DIR/ru.zone"\nmkdir -p "$AWG_DIR"\nexec 9>"$AWG_DIR/ru-drop.lock"\nflock -n 9 || { echo "Уже запущен"; exit 1; }\ncurl -fsS --retry 2 --connect-timeout 10 -o "$RU_ZONE.tmp" "$RU_ZONE_URL" || exit 1\nvalid=$(grep -cE '^[0-9]{1,3}(\\.[0-9]{1,3}){3}/[0-9]{1,2}$' "$RU_ZONE.tmp" || true)\nif [ "$valid" -lt 1000 ]; then exit 1; fi\nmv -f "$RU_ZONE.tmp" "$RU_ZONE"\nipset create ru_block hash:net -exist\nipset create ru_tmp hash:net -exist\nipset flush ru_tmp\nwhile read -r net; do\n [ -n "$net" ] && ipset add ru_tmp "$net" -exist\ndone < "$RU_ZONE"\nipset swap ru_tmp ru_block\nipset destroy ru_tmp\nfor AWG_IF in "\${IFACES[@]}"; do\n iptables -D FORWARD -i "$AWG_IF" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true\n iptables -D FORWARD -i "$AWG_IF" -m set --match-set ru_block dst -j DROP 2>/dev/null || true\n iptables -I FORWARD 1 -i "$AWG_IF" -m set --match-set ru_block dst -j DROP\n iptables -I FORWARD 1 -i "$AWG_IF" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT\ndone\necho "OK"\n`;
    
    fs.writeFileSync('/tmp/ru-drop.sh', scriptContent);
    execSync('sudo mv /tmp/ru-drop.sh /root/awg/ru-drop.sh && sudo chmod +x /root/awg/ru-drop.sh');
    let cronLine = schedule === 'daily' ? "0 4 * * *" : "0 4 * * 1";
    fs.writeFileSync('/tmp/ru-drop-refresh', `@reboot root sleep 30 && /bin/bash /root/awg/ru-drop.sh >/var/log/ru-drop.log 2>&1\n${cronLine} root /bin/bash /root/awg/ru-drop.sh >/var/log/ru-drop.log 2>&1\n`);
    execSync('sudo mv /tmp/ru-drop-refresh /etc/cron.d/ru-drop-refresh && sudo chmod 644 /etc/cron.d/ru-drop-refresh');
    exec('sudo /root/awg/ru-drop.sh', (err) => {
        if(err) return res.status(500).json({error: "Ошибка загрузки базы"});
        res.json({success: true});
    });
});

app.post('/api/tools/dns', checkAuth, (req, res) => {
    const { ifaces, target, enable, oldIfaces, oldTarget } = req.body;
    
    if (oldIfaces && oldIfaces.length > 0 && oldTarget) {
        oldIfaces.forEach(oldIface => {
            try { execSync(`sudo iptables -t nat -D PREROUTING -i ${oldIface} -p udp --dport 53 -j DNAT --to-destination ${oldTarget}`); } catch(e){}
            try { execSync(`sudo iptables -t nat -D PREROUTING -i ${oldIface} -p tcp --dport 53 -j DNAT --to-destination ${oldTarget}`); } catch(e){}
            try { execSync(`sudo iptables -D FORWARD -i ${oldIface} -p tcp --dport 853 -j DROP`); } catch(e){}
        });
    }
    
    if (enable && ifaces && ifaces.length > 0 && target) {
        ifaces.forEach(iface => {
            try {
                execSync(`sudo iptables -t nat -I PREROUTING 1 -i ${iface} -p udp --dport 53 -j DNAT --to-destination ${target}`);
                execSync(`sudo iptables -t nat -I PREROUTING 1 -i ${iface} -p tcp --dport 53 -j DNAT --to-destination ${target}`);
                execSync(`sudo iptables -I FORWARD 1 -i ${iface} -p tcp --dport 853 -j DROP`);
            } catch(e) {}
        });
    }
    res.json({success: true});
});

app.post('/api/tools/cascade', checkAuth, (req, res) => {
    const { ifaces, enable } = req.body;
    const scriptPath = '/root/awg/awg-routing.sh';
    
    if (!fs.existsSync(scriptPath)) {
        return res.json({error: "Каскад не настроен. Сначала установите каскад во вкладке 'Установка Модулей'."});
    }

    try {
        const existingCode = fs.readFileSync(scriptPath, 'utf8');
        const epMatch = existingCode.match(/AWG1_ENDPOINT="([^"]+)"/);
        const ifMatch = existingCode.match(/AWG1_IF="([^"]+)"/);
        if (!epMatch || !ifMatch) return res.json({error: "Файл awg-routing.sh поврежден (нет Endpoint)."});
        
        const awg1Endpoint = epMatch[1];
        const awg1If = ifMatch[1];

        const mangleOut = execSync("sudo iptables -t mangle -S PREROUTING || true").toString();
        mangleOut.split('\n').forEach(rule => {
            if (rule.includes('match-set ru dst -j RETURN') || rule.includes('MARK --set-xmark 0x1') || rule.includes('MARK --set-mark 0x1')) {
                execSync(`sudo iptables -t mangle -D PREROUTING ${rule.replace(/^-A PREROUTING /, '')} || true`);
            }
        });
        const natOut = execSync("sudo iptables -t nat -S POSTROUTING || true").toString();
        natOut.split('\n').forEach(rule => {
            if (rule.includes(`-o ${awg1If} -j MASQUERADE`)) {
                execSync(`sudo iptables -t nat -D POSTROUTING ${rule.replace(/^-A POSTROUTING /, '')} || true`);
            }
        });

        if (!enable) {
            execSync('sudo systemctl stop awg-routing.timer awg-routing.service || true');
            return res.json({success: true});
        }

        if (!ifaces || ifaces.length === 0) return res.json({error: "Выберите интерфейсы"});

        const newScript = `#!/bin/bash
set -euo pipefail
CASC_IFACES=(${ifaces.join(' ')})
AWG1_IF="${awg1If}"
AWG1_ENDPOINT="${awg1Endpoint}"
TABLE_ID=100
FWMARK="0x1"
RULE_PRIO=10000
RU_ZONE_URL="https://www.ipdeny.com/ipblocks/data/aggregated/ru-aggregated.zone"
RU_ZONE_FALLBACK_URL="https://raw.githubusercontent.com/bivlked/amneziawg-installer/v6.0.0/cascade/ru.zone"
AWG_DIR="/root/awg"
EXTRA_RU_NETS=""
RU_ZONE="$AWG_DIR/ru.zone"
mkdir -p "$AWG_DIR"
exec 9>"$AWG_DIR/awg-routing.lock"
flock -w 300 9 || exit 1
trap 'rm -f "$RU_ZONE.tmp"' EXIT
EP_ROUTE="$(ip -4 route get "$AWG1_ENDPOINT" 2>/dev/null | head -1)"
WAN_IF="$(printf '%s' "$EP_ROUTE" | grep -oP '\\bdev \\K\\S+' || true)"
WAN_GW="$(printf '%s' "$EP_ROUTE" | grep -oP '\\bvia \\K\\S+' || true)"
fetch_ru_zone() {
    curl -fsS --retry 2 --connect-timeout 10 --max-time 30 -o "$RU_ZONE.tmp" "$1" || return 1
    local valid=$(grep -cE '^[0-9]{1,3}(\\.[0-9]{1,3}){3}/[0-9]{1,2}$' "$RU_ZONE.tmp" || true)
    if [ "$valid" -lt 1000 ]; then return 1; fi
}
if fetch_ru_zone "$RU_ZONE_URL"; then mv -f "$RU_ZONE.tmp" "$RU_ZONE"; elif fetch_ru_zone "$RU_ZONE_FALLBACK_URL"; then mv -f "$RU_ZONE.tmp" "$RU_ZONE"; fi
ipset create ru hash:net -exist
ipset create ru_tmp hash:net -exist
ipset flush ru_tmp
while read -r net; do [ -n "$net" ] && ipset add ru_tmp "$net" -exist; done < "$RU_ZONE"
ipset swap ru_tmp ru
ipset destroy ru_tmp
ip route replace default dev "$AWG1_IF" table "$TABLE_ID"
ip rule del fwmark "$FWMARK" table "$TABLE_ID" 2>/dev/null || true
ip rule add fwmark "$FWMARK" table "$TABLE_ID" priority "$RULE_PRIO"
if [ -n "$WAN_GW" ]; then
    ip route replace "$AWG1_ENDPOINT" via "$WAN_GW" dev "$WAN_IF" 2>/dev/null || ip route replace "$AWG1_ENDPOINT" via "$WAN_GW" dev "$WAN_IF" onlink
else
    ip route replace "$AWG1_ENDPOINT" dev "$WAN_IF"
fi

for IFACE in "\${CASC_IFACES[@]}"; do
    SUBNET=$(ip -o -f inet addr show \$IFACE 2>/dev/null | awk '{print \\$4}' | head -n 1 || true)
    if [ -n "\$SUBNET" ]; then
        iptables -t mangle -C PREROUTING -i \$IFACE -s "\$SUBNET" -m set --match-set ru dst -j RETURN 2>/dev/null || iptables -t mangle -I PREROUTING 1 -i \$IFACE -s "\$SUBNET" -m set --match-set ru dst -j RETURN
        iptables -t mangle -C PREROUTING -i \$IFACE -s "\$SUBNET" -j MARK --set-mark "$FWMARK" 2>/dev/null || iptables -t mangle -A PREROUTING -i \$IFACE -s "\$SUBNET" -j MARK --set-mark "$FWMARK"
        iptables -t nat -C POSTROUTING -s "\$SUBNET" -o "$AWG1_IF" -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s "\$SUBNET" -o "$AWG1_IF" -j MASQUERADE
    fi
done
echo "ОК: Каскад применен."
`;
        fs.writeFileSync(scriptPath, newScript);
        execSync(`sudo chmod +x ${scriptPath}`);
        
        execSync('sudo systemctl enable --now awg-routing.timer awg-routing.service || true');
        execSync('sudo systemctl restart awg-routing || true');
        res.json({success: true});
    } catch(e) {
        res.json({error: "Системная ошибка настройки каскада: " + e.message});
    }
});

app.post('/api/services/restart', checkAuth, (req, res) => {
    const { name } = req.body;
    if (!['AdGuardHome', 'nginx', 'sshd', 'mtproxyl-telemt'].includes(name)) return res.status(400).json({error: "Неверное имя службы"});
    try {
        execSync(`sudo systemctl restart ${name}`);
        res.json({success: true});
    } catch(e) { res.status(500).json({error: "Ошибка перезапуска"}); }
});

app.post('/api/adguard/stats', checkAuth, async (req, res) => {
    let { url, user, pass } = req.body;
    if (!url) return res.status(400).json({error: "Укажите URL API"});
    
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = (url.includes(':4443') || url.includes(':443')) ? 'https://' + url : 'http://' + url;
    }

    try {
        const headers = {};
        if (user && pass) headers['Authorization'] = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        
        const response = await fetch(`${url.replace(/\/$/, '')}/control/stats`, { headers, signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        res.json(data);
    } catch (e) {
        res.status(500).json({error: "Не удалось подключиться к AdGuard: " + e.message});
    }
});

app.post('/api/create', checkAuth, (req, res) => {
    const { name, expires } = req.body;
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).json({ error: "Недопустимое имя" });
    let cmd = `sudo bash /root/awg/manage_amneziawg.sh add ${name}`;
    if (expires && /^[0-9]+[hdw]$/.test(expires)) cmd += ` --expires=${expires}`;
    cmd += ` --json`;

    exec(cmd, (error, stdout) => {
        try {
            const response = JSON.parse(stdout);
            if (!response.ok) return res.status(500).json({ error: response.error });
            
            const confPath = response.results[0].conf;
            
            // --- УМНАЯ ЗАМЕНА IP НА ДОМЕН ---
            try {
                let domain = "";
                if (fs.existsSync('/root/awg_domain.txt')) domain = fs.readFileSync('/root/awg_domain.txt', 'utf8').trim();
                if (!domain) {
                    const match = execSync('cat /etc/nginx/sites-available/awg-admin || true').toString().match(/server_name\s+([^;]+);/);
                    if (match && match[1] && match[1] !== '_') domain = match[1].trim();
                }
                if (domain) execSync(`sudo sed -i -E 's/Endpoint = [0-9\\.]+(:[0-9]+)/Endpoint = ${domain}\\1/g' ${confPath}`);
            } catch(e) {}
            // --------------------------------

            res.download(confPath, `Serv_${name}.conf`);
        } catch (e) { res.status(500).json({ error: "Ошибка обработки" }); }
    });
});

app.post('/api/create-bulk', checkAuth, (req, res) => {
    const { prefix, count, expires } = req.body;
    if (!prefix || !/^[a-zA-Z0-9_-]+$/.test(prefix) || isNaN(count) || count < 1 || count > 50) return res.status(400).json({ error: "Недопустимые параметры" });
    try {
        const batchId = Date.now();
        const tempDir = `/tmp/awg-bulk-${batchId}`;
        execSync(`mkdir -p ${tempDir}`);
        
        // Получаем домен один раз для всего архива
        let domain = "";
        try {
            if (fs.existsSync('/root/awg_domain.txt')) domain = fs.readFileSync('/root/awg_domain.txt', 'utf8').trim();
            if (!domain) {
                const match = execSync('cat /etc/nginx/sites-available/awg-admin || true').toString().match(/server_name\s+([^;]+);/);
                if (match && match[1] && match[1] !== '_') domain = match[1].trim();
            }
        } catch(e) {}

        for (let i = 1; i <= count; i++) {
            const clientName = `${prefix}-${i}`;
            let cmd = `sudo bash /root/awg/manage_amneziawg.sh add ${clientName}`;
            if (expires && /^[0-9]+[hdw]$/.test(expires)) cmd += ` --expires=${expires}`;
            cmd += ` --json`;
            try {
                const result = execSync(cmd).toString();
                const response = JSON.parse(result);
                if (response.ok && response.results[0].conf) {
                    const confPath = response.results[0].conf;
                    if (domain) execSync(`sudo sed -i -E 's/Endpoint = [0-9\\.]+(:[0-9]+)/Endpoint = ${domain}\\1/g' ${confPath}`);
                    execSync(`sudo cp ${confPath} ${tempDir}/Serv_${clientName}.conf`);
                }
            } catch(e) {} 
        }
        const zipPath = `/tmp/Serv_Bulk_${prefix}_${count}.zip`;
        execSync(`cd ${tempDir} && zip -r ${zipPath} .`);
        execSync(`rm -rf ${tempDir}`);
        res.download(zipPath, `Serv_Bulk_${prefix}.zip`, () => { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); });
    } catch(err) { res.status(500).json({ error: "Ошибка массового создания" }); }
});

app.get('/api/stats', checkAuth, (req, res) => {
    exec(`sudo bash /root/awg/manage_amneziawg.sh stats --json`, (error, stdout) => {
        try {
            const jsonStart = stdout.indexOf('[');
            if (jsonStart !== -1) {
                let data = JSON.parse(stdout.substring(jsonStart));
                data = data.map(client => {
                    let sc = client.status_code;
                    if (!sc) {
                        let st = (client.status || '').toLowerCase();
                        if (st.includes('активен') && !st.includes('неактивен') && !st.includes('не активен')) {
                            sc = 'active';
                        } else if (st.includes('недавно')) {
                            sc = 'recent';
                        } else {
                            sc = 'inactive';
                        }
                    }
                    return { ...client, status_code: sc };
                });
                res.json(data);
            } else res.status(500).json({ error: "Скрипт не вернул JSON" });
        } catch (e) { res.status(500).json({ error: "Ошибка парсинга" }); }
    });
});

app.get('/api/download/:name', checkAuth, (req, res) => {
    const name = req.params.name;
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).send("Invalid name");
    const filePath = `/root/awg/${name}.conf`;
    if (fs.existsSync(filePath)) res.download(filePath, `Serv_${name}.conf`);
    else res.status(404).send("Конфиг не найден");
});

app.delete('/api/delete/:name', checkAuth, (req, res) => {
    const name = req.params.name;
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).send("Invalid name");
    exec(`sudo bash /root/awg/manage_amneziawg.sh remove ${name} --yes --json`, (error, stdout) => {
        try {
            const response = JSON.parse(stdout);
            if (!response.ok) return res.status(500).json({ error: response.error });
            delete historyData[name]; delete lastHistoryStats[name];
            auditLog(req, 'Удален клиент ' + name);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: "Ошибка при удалении" }); }
    });
});

app.post('/api/limit', checkAuth, (req, res) => {
    const { ip, rate } = req.body;
    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || isNaN(rate)) return res.status(400).json({ error: "Некорректный IP или скорость" });
    exec(`sudo bash /root/awg-limit.sh ${ip} ${rate}`, (error, stdout) => {
        if (error) return res.status(500).json({ error: "Ошибка TC скрипта" });
        res.json({ success: true, message: stdout });
    });
});

app.get('/api/backup', checkAuth, (req, res) => {
    const dateStr = new Date().toISOString().replace(/T/, '-').replace(/:/g, '-').slice(0, 16);
    const fileName = `awg-full-backup-${dateStr}.tar.gz`;
    const tempPath = `/tmp/${fileName}`;
    const cmd = `sudo tar -czf ${tempPath} /etc/amnezia/amneziawg /root/awg /root/servpanel /root/awg-admin /etc/nginx/sites-available/awg-admin /etc/nginx/.htpasswd 2>/dev/null || true`;
    exec(cmd, () => {
        if (!fs.existsSync(tempPath)) return res.status(500).send("Не удалось создать архив");
        res.download(tempPath, fileName, () => { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); });
    });
});

app.post('/api/restore', checkAuth, (req, res) => {
    const { fileData } = req.body;
    if (!fileData) return res.status(400).json({ error: "Нет данных файла" });
    try {
        const buffer = Buffer.from(fileData, 'base64');
        const tempPath = '/tmp/restore.tar.gz';
        fs.writeFileSync(tempPath, buffer);
        execSync('sudo tar -xzf /tmp/restore.tar.gz -C /');
        res.json({ success: true });
        setTimeout(() => { exec('sudo pm2 restart awg-admin'); }, 1000);
    } catch (e) { res.status(500).json({ error: "Ошибка распаковки: " + e.message }); }
});

app.post('/api/change-password', checkAuth, (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) return res.status(400).json({error: "Пароль слишком короткий"});
    try {
        fs.writeFileSync(passFile, newPassword);
        ADMIN_PASSWORD = newPassword;
        res.cookie('awg_auth', getAuthToken(ADMIN_PASSWORD), { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true });
        auditLog(req, 'Изменен пароль администратора');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({error: "Ошибка изменения пароля"});
    }
});

app.get('/api/server-info', checkAuth, (req, res) => {
    try {
        let domain = "";
        try {
            const nginxConf = execSync('cat /etc/nginx/sites-available/awg-admin || true').toString();
            const match = nginxConf.match(/server_name\s+([^;]+);/);
            if (match && match[1] && match[1] !== '_') domain = match[1].trim();
        } catch(e) {}

        // Запрашиваем данные через ipinfo.io
        let ip = "Неизвестно";
        let country = "UNKNOWN";
        try {
            const ipinfo = JSON.parse(execSync('curl -s https://ipinfo.io/json || echo "{}"').toString());
            ip = ipinfo.ip || execSync('curl -4s ifconfig.me || true').toString().trim();
            country = ipinfo.country || "UNKNOWN";
        } catch(e) {
            ip = execSync('curl -4s ifconfig.me || true').toString().trim();
        }

        res.json({ ip, domain, country });
    } catch(e) {
        res.json({ ip: "Неизвестно", domain: "", country: "UNKNOWN" });
    }
});

app.post('/api/update', checkAuth, (req, res) => {
    try {
        const script = `#!/bin/bash
sleep 2
cd /root/servpanel
git fetch --all
git reset --hard origin/main
export PATH=$PATH:/usr/local/bin:/usr/bin:/bin
pm2 restart awg-admin || /usr/local/bin/pm2 restart awg-admin
`;
        fs.writeFileSync('/tmp/update_panel.sh', script);
        const { spawn } = require('child_process');
        const child = spawn('bash', ['/tmp/update_panel.sh'], { detached: true, stdio: 'ignore' });
        child.unref();
        res.json({success: true});
    } catch (e) {
        res.status(500).json({error: "Ошибка запуска обновления"});
    }
});

const AWG_CONF_PATHS = ['/etc/amnezia/amneziawg/amn0.conf', '/etc/amnezia/amneziawg/awg0.conf', '/etc/wireguard/wg0.conf'];

app.get('/api/awg/config', checkAuth, (req, res) => {
    try {
        let confPath = AWG_CONF_PATHS.find(p => fs.existsSync(p));
        if (!confPath) return res.status(404).json({error: "Конфиг не найден"});
        const content = fs.readFileSync(confPath, 'utf8');
        res.json({ content, file: confPath });
    } catch (e) {
        res.status(500).json({error: "Ошибка чтения конфига"});
    }
});

app.post('/api/awg/config', checkAuth, (req, res) => {
    const { content, file } = req.body;
    if (!content || !file) return res.status(400).json({error: "Пустой конфиг"});
    try {
        auditLog(req, `Изменение конфигурации AWG: ${file}`);
        if (fs.existsSync(file)) {
            const backupPath = `${file}.bak_${Date.now()}`;
            execSync(`sudo cp ${file} ${backupPath}`);
        }
        fs.writeFileSync('/tmp/awg_tmp.conf', content);
        execSync(`sudo cp /tmp/awg_tmp.conf ${file}`);
        const iface = path.basename(file, '.conf');
        try { execSync(`sudo systemctl restart awg-quick@${iface} || sudo docker restart amnezia-awg || sudo systemctl restart amnezia-awg || true`); } catch(e){}
        res.json({success: true});
    } catch (e) { res.status(500).json({error: "Ошибка сохранения конфига"}); }
});

// УСТАНОВКА МОДУЛЕЙ (AWG, MTPROTO, ADGUARD)
app.post('/api/install/module', checkAuth, (req, res) => {
    const data = req.body;
    const module = data.module;
    let installScriptUrl = '';
    let logFile = '';

    if (module === 'awg') {
        installScriptUrl = 'https://raw.githubusercontent.com/makar19977v-glitch/servpanel/main/install_awg_stateful.sh';
        logFile = '/var/log/awg_install.log';
    } else if (module === 'mtproto') {
        installScriptUrl = 'https://raw.githubusercontent.com/makar19977v-glitch/servpanel/main/install_mtproto_silent.sh';
        logFile = '/var/log/mtproto_install.log';
    } else if (module === 'adguard') {
        installScriptUrl = 'https://raw.githubusercontent.com/makar19977v-glitch/servpanel/main/install_adguard_silent.sh';
        logFile = '/var/log/adguard_install.log';
    } else {
        return res.status(400).json({ error: "Неизвестный модуль" });
    }

    try {
        execSync(`sudo rm -f ${logFile} && sudo touch ${logFile} && sudo chmod 666 ${logFile}`);
        
        let runScript = `#!/bin/bash\n`;
        runScript += `export PANEL_PORT="4444"\n`; // Принудительно передаем ваш внешний порт Nginx для защиты UFW
        
        if (module === 'awg') {
            runScript += `export AWG_VERSION="${data.version || ''}"\n`;
            runScript += `export AWG_PRESET="${data.preset || ''}"\n`;
            runScript += `export AWG_ROUTE="${data.route || ''}"\n`;
            runScript += `export AWG_CUSTOM_ROUTE="${data.customRoute || ''}"\n`;
            runScript += `export AWG_IPV6="${data.ipv6 || ''}"\n`;
            runScript += `export AWG_PORT="${data.port || ''}"\n`;
            runScript += `export AWG_ISOLATION="${data.isolation ? 'on' : 'off'}"\n`;
            runScript += `export AWG_KEEP_PACKAGES="${data.keepPackages ? '1' : '0'}"\n`;
            runScript += `export AWG_NO_TWEAKS="${data.noTweaks ? '1' : '0'}"\n`;
            runScript += `export AWG_MODE="${data.awgMode || 'single'}"\n`;
            runScript += `export CASCADE_ROLE="${data.cascadeRole || 'ru'}"\n`;
            runScript += `export REMOTE_IP="${data.remoteIp || ''}"\n`;
            runScript += `export REMOTE_PORT="${data.remotePort || '22'}"\n`;
            runScript += `export REMOTE_PASS="${data.remotePass || ''}"\n`;
            if (data.domain) {
                runScript += `export SERVER_PUB_IP="${data.domain}"\n`;
                fs.writeFileSync('/root/awg_domain.txt', data.domain);
            } else {
                try { fs.unlinkSync('/root/awg_domain.txt'); } catch(e){}
            }
            // --------------------------
        }

        runScript += `curl -fsSL ${installScriptUrl} > /tmp/installer.sh\nbash /tmp/installer.sh > ${logFile} 2>&1\nrm -f /tmp/installer.sh\n`;
        
        fs.writeFileSync('/tmp/run_install.sh', runScript);
        
        const { spawn } = require('child_process');
        const child = spawn('bash', ['/tmp/run_install.sh'], { detached: true, stdio: 'ignore' });
        child.unref();

        auditLog(req, `Запущена установка модуля ${module}`);
        res.json({ success: true, logFile });
    } catch (e) {
        res.status(500).json({ error: "Ошибка запуска установки" });
    }
});

app.get('/api/install/log', checkAuth, (req, res) => {
    const logFile = req.query.file;
    if (!logFile || !logFile.startsWith('/var/log/')) return res.status(400).send("Неверный путь");
    try {
        if (!fs.existsSync(logFile)) return res.send("Ожидание старта установки...");
        const logContent = execSync(`tail -n 50 ${logFile}`).toString();
        res.send(logContent);
    } catch (e) {
        res.send("Ошибка чтения лога...");
    }
});
// ПОЛНОЕ УДАЛЕНИЕ AMNEZIAWG
app.post('/api/uninstall/awg', checkAuth, (req, res) => {
    try {
        const script = `#!/bin/bash
echo "Начинаем удаление AmneziaWG..." > /var/log/awg_uninstall.log
if [ -f "/root/install_amneziawg.sh" ]; then
    bash /root/install_amneziawg.sh --uninstall --yes >> /var/log/awg_uninstall.log 2>&1
else
    wget -qO /tmp/uninstall_awg.sh https://raw.githubusercontent.com/bivlked/amneziawg-installer/main/install_amneziawg.sh
    bash /tmp/uninstall_awg.sh --uninstall --yes >> /var/log/awg_uninstall.log 2>&1
fi
rm -rf /etc/amnezia/amneziawg /root/awg
systemctl stop awg-routing.timer awg-routing.service 2>/dev/null || true
`;
        fs.writeFileSync('/tmp/run_uninstall_awg.sh', script);
        const { spawn } = require('child_process');
        const child = spawn('bash', ['/tmp/run_uninstall_awg.sh'], { detached: true, stdio: 'ignore' });
        child.unref();
        
        auditLog(req, 'Запущено полное удаление AmneziaWG');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Ошибка запуска удаления" });
    }
});
app.listen(3000, () => console.log('AWG Admin v18 running on port 3000'));
