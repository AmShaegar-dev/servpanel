
let logInterval = null;
let lastStats = {}; let isFetching = false; 
let pollingInterval = null; let historyInterval = null; let agInterval = null;
let chartData = { global: { labels: [], rx: [], tx: [] } };
let currentChartView = 'global'; let trafficChart = null;
let sortCol = 'name'; let sortDesc = false;
let currentUser = 'admin';
let currentRole = 'admin';

async function startInstall(module, expectedLogFile, presetOptions = null) {
    let options = {};
    if (module === 'awg') {
        if (!presetOptions) {
            const check = prompt("ВНИМАНИЕ! Установка AWG перезагрузит сервер 3 раза.\n\nДля подтверждения введите слово INSTALL (большими буквами):");
            if (check !== 'INSTALL') { alert("Установка отменена."); return; }

            options = {
                version: (document.getElementById('awgInstallVersion') || document.getElementById('awgVersion') || {}).value || '',
                preset: (document.getElementById('awgInstallPreset') || document.getElementById('awgPreset') || {}).value || 'auto',
                route: (document.getElementById('awgInstallRoute') || document.getElementById('awgRoute') || {}).value || 'all',
                customRoute: (document.getElementById('awgCustomRoute') || {}).value || '',
                ipv6: (document.getElementById('awgInstallIpv6') || document.getElementById('awgIpv6') || {}).value || 'off',
                port: (document.getElementById('awgInstallPort') || document.getElementById('awgPort') || {}).value || '',
                isolation: document.getElementById('awgIsolation').checked,
                keepPackages: document.getElementById('awgKeepPackages').checked,
                noTweaks: document.getElementById('awgNoTweaks').checked,
                awgMode: document.getElementById('awgMode') ? document.getElementById('awgMode').value : 'single',
                cascadeRole: document.getElementById('cascadeRole') ? document.getElementById('cascadeRole').value : 'ru',
                remoteIp: document.getElementById('remoteIp') ? document.getElementById('remoteIp').value : '',
                remotePort: document.getElementById('remotePort') ? document.getElementById('remotePort').value : '22',
                remotePass: document.getElementById('remotePass') ? document.getElementById('remotePass').value : '',
                domain: document.getElementById('awgInstallDomain') ? document.getElementById('awgInstallDomain').value.trim() : ''
            };
        } else {
            options = { ...presetOptions };
        }

        if (options.awgMode === 'cascade' && (!options.remoteIp || !options.remotePass)) {
            alert('Для каскадной установки необходимо указать IP и пароль удаленного сервера!');
            return;
        }
    } else {
        if (!presetOptions && !confirm(`Запустить процесс установки модуля ${module}? Следите за логами в окне ниже.`)) return;
        options = presetOptions || {};
    }
    
    document.getElementById('installLogWrapper').style.display = 'block';
    document.getElementById('installLogText').value = "Инициализация...\n";
    document.getElementById('installStatusBadge').innerText = "Подготовка...";
    document.getElementById('installStatusBadge').className = "val-sys";
    const barEl = document.getElementById('installProgressBar');
    if (barEl) barEl.style.width = '0%';
    renderInstallSteps([
        { title: 'Подготовка', done: false },
        { title: 'Загрузка установщика', done: false },
        { title: 'Установка пакетов', done: false },
        { title: 'Настройка и ключи', done: false },
        { title: 'Завершение', done: false }
    ]);
    
    try {
        const res = await fetch('/api/install/module', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ module, ...options })
        });
        if (res.ok) {
            const data = await res.json().catch(() => ({}));
            const logFile = data.logFile || expectedLogFile;
            if (logInterval) clearInterval(logInterval);
            logInterval = setInterval(() => pollLog(logFile), 2000);
        } else {
            alert("Ошибка запуска установки");
        }
    } catch(e) { alert("Сетевая ошибка"); }
}
async function uninstallAwg() {
    const check = prompt("ВНИМАНИЕ! Это полностью удалит ядро AmneziaWG, все настройки и ВСЕХ клиентов!\n\nДля подтверждения введите слово DELETE (большими буквами):");
    if (check !== 'DELETE') return;
    
    document.getElementById('loaderOverlay').style.display = 'flex';
    document.getElementById('loaderText').innerText = "Удаление AmneziaWG (около 15 сек)...";
    
    try {
        const res = await fetch('/api/uninstall/awg', { method: 'POST' });
        if (res.ok) {
            setTimeout(() => {
                alert("AmneziaWG успешно удален вместе с конфигами!");
                window.location.reload();
            }, 15000); // Ждем 15 секунд, пока скрипт в фоне очистит ядро и файлы
        } else {
            alert("Ошибка при запуске удаления");
            document.getElementById('loaderOverlay').style.display = 'none';
        }
    } catch (e) {
        alert("Ошибка сети");
        document.getElementById('loaderOverlay').style.display = 'none';
    }
}

// Запуск поллинга статуса каскада
setInterval(async () => {
    try {
        const res = await fetch('/api/cascade/status');
        if (res.ok) {
            const data = await res.json();
            const statusEl = document.getElementById('cascadeStatusDash');
            if (statusEl) {
                statusEl.innerText = data.text;
                statusEl.style.color = data.color;
            }
        }
    } catch (e) {}
}, 5000);

// Перенаправляет на вкладку сети и прокручивает к новому редактору каскада
function editCascadeConfig() {
    switchTab('tab-network', document.getElementById('navNetwork'));
    loadCascadeConfig();
    document.getElementById('cascadeEditorCard').scrollIntoView({behavior: 'smooth'});
}

// Загружает конфиг транзитного туннеля в отдельное окно
async function loadCascadeConfig() {
    const el = document.getElementById('cascadeConfigText');
    if (!el) return;
    try {
        const res = await fetch('/api/cascade/config');
        if (res.ok) {
            const data = await res.json();
            el.value = data.content || '';
            el.dataset.file = data.file || '';
        } else {
            el.value = '';
        }
    } catch (e) {
        el.value = '';
    }
}

// Сохраняет конфиг транзитного туннеля через API
async function saveCascadeConfig() {
    if(!confirm("Сохранить транзитную конфигурацию и перезапустить туннель?")) return;
    const el = document.getElementById('cascadeConfigText');
    const content = el.value;
    const file = el.dataset.file || '/etc/amnezia/amneziawg/awg1.conf';
    try {
        const res = await fetch('/api/awg/config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ content: content, file: file })
        });
        if (res.ok) alert("Конфиг туннеля сохранён и интерфейс перезапущен!");
        else alert("Ошибка при сохранении конфигурации.");
    } catch(e) { alert("Ошибка сети"); }
}
    
async function pollLog(logFile) {
    try {
        const res = await fetch(`/api/install/progress?file=${encodeURIComponent(logFile)}`);
        if (!res.ok) throw new Error('bad status');
        const d = await res.json();
        const textArea = document.getElementById('installLogText');
        if (textArea.value !== d.text) {
            textArea.value = d.text;
            textArea.scrollTop = textArea.scrollHeight;
        }
        renderInstallSteps(d.steps || []);
        const bar = document.getElementById('installProgressBar');
        if (bar) bar.style.width = (d.progress || 0) + '%';

        const badge = document.getElementById('installStatusBadge');
        if (d.status === 'done') {
            clearInterval(logInterval); logInterval = null;
            badge.innerText = 'Установка завершена';
            badge.className = 'val-rx';
        } else if (d.status === 'error') {
            clearInterval(logInterval); logInterval = null;
            badge.innerText = 'Ошибка установки — смотрите лог';
            badge.className = 'val-tx';
        } else {
            badge.innerText = 'Установка идёт... ' + (d.progress || 0) + '%';
            badge.className = 'val-sys';
        }
    } catch(e) {
        const badge = document.getElementById('installStatusBadge');
        if (badge) {
            badge.innerText = "Сервер перезагружается... Ожидание (до 60 сек)";
            badge.className = "val-tx";
        }
    }
}

function renderInstallSteps(steps) {
    const box = document.getElementById('installSteps');
    if (!box) return;
    box.innerHTML = steps.map(s => `
        <span style="padding:5px 10px; border-radius:20px; font-size:12px; border:1px solid ${s.done ? '#2ea043' : 'var(--border)'}; color:${s.done ? '#3fb950' : 'var(--text-muted)'}; background:${s.done ? 'rgba(46,160,67,.12)' : 'transparent'};">
            ${s.done ? '✓' : '○'} ${s.title}
        </span>`).join('');
}

async function loadAwgConfig() {
    try {
        const res = await fetch('/api/awg/config');
        if (res.ok) {
            const data = await res.json();
            document.getElementById('awgConfigText').value = data.content;
            document.getElementById('awgConfigFile').value = data.file;
            document.getElementById('awgConfigWrapper').style.display = 'flex';
            document.getElementById('awgConfigError').style.display = 'none';
        } else {
            document.getElementById('awgConfigError').innerText = "Конфигурация AWG не найдена на сервере.";
            document.getElementById('awgConfigError').style.display = 'block';
            document.getElementById('awgConfigWrapper').style.display = 'none';
        }
    } catch(e) {
        document.getElementById('awgConfigError').innerText = "Ошибка загрузки конфигурации.";
        document.getElementById('awgConfigError').style.display = 'block';
    }
}

async function saveAwgConfig() {
    if(!confirm("Сохранить изменения и перезапустить AmneziaWG? VPN-соединения будут кратковременно разорваны.")) return;
    const content = document.getElementById('awgConfigText').value;
    const file = document.getElementById('awgConfigFile').value;
    try {
        const res = await fetch('/api/awg/config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ content, file })
        });
        if (res.ok) alert("Настройки успешно сохранены, интерфейс перезапущен!");
        else alert("Ошибка при сохранении конфигурации.");
    } catch(e) { alert("Ошибка сети"); }
}

// Старое имя оставлено совместимым: теперь это GitHub-обновление с проверкой
// локальных изменений, бэкапом и автоматическим откатом.
async function updatePanel() {
    return updGitRun();
}

function setSort(col) {
    if (sortCol === col) sortDesc = !sortDesc;
    else { sortCol = col; sortDesc = false; }
    ['name', 'status', 'traffic', 'speed'].forEach(c => {
        const el = document.getElementById('sort-' + c);
        if (el) el.innerText = '';
    });
    const currentEl = document.getElementById('sort-' + col);
    if (currentEl) currentEl.innerText = sortDesc ? '▼' : '▲';
    if (!isFetching) loadStats();
}

function toggleMenu() { document.getElementById('sidebar').classList.toggle('open'); }
function switchTab(tabId, el) {
    if (tabId === 'tab-admin' && currentRole !== 'admin') return;
    if (tabId === 'tab-install' && currentRole !== 'admin') return;
    if (tabId === 'tab-diag' && currentRole !== 'admin') return;
    if (tabId === 'tab-update' && currentRole !== 'admin') return;
    const pane = document.getElementById(tabId);
    if (!pane) return;
    document.querySelectorAll('.tab-pane').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(l => l.classList.remove('active'));
    pane.classList.add('active');
    const navEl = el || document.querySelector(`.nav-item[data-tab="${tabId}"]`);
    const title = (navEl && (navEl.dataset.title || navEl.innerText)) || 'Дашборд';
    if (navEl) navEl.classList.add('active');
    const cleanTitle = String(title).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|\s+/g, ' ').trim();
    const titleEl = document.getElementById('currentTabTitle');
    if (titleEl) titleEl.innerText = cleanTitle;
    const pageEl = document.getElementById('pageTitle');
    if (pageEl) pageEl.innerText = cleanTitle === 'Дашборд' ? 'Обзор' : cleanTitle;
    if (window.innerWidth <= 860) document.getElementById('sidebar').classList.remove('open');
    if (tabId === 'tab-services') { loadServices(); connectAdGuard(false); loadAdGuardFull(); }
    else if (agInterval) { clearInterval(agInterval); agInterval = null; }
    if (tabId === 'tab-cascade') { loadCascadeSetup(); loadCascadeStatus(true); loadCascadeHealth(); }
    if (tabId === 'tab-obf') { loadObfCurrent(); loadObfProfiles(); }
    if (tabId === 'tab-update') loadUpdatePanel();
    if (tabId === 'tab-admin') loadAdminPanel();
}

function copyMeko() {
    const cmd = "curl -fsSL https://raw.githubusercontent.com/Mekotofeuka/MTPROTO_FIX_By_MEKO/main/install.sh | sudo bash";
    navigator.clipboard.writeText(cmd).then(() => {
        alert("Команда скопирована! Теперь просто вставьте её в ваш SSH-терминал.");
    }).catch(() => { alert("Не удалось скопировать."); });
}

function formatBytes(bytes) {
    if (!bytes || isNaN(bytes)) return '0 B'; if (bytes === 0) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'], i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
function formatSpeed(bytesPerSec) { return formatBytes(bytesPerSec) + '/s'; }

async function loadServices() {
    try {
        const res = await fetch('/api/services');
        if (res.ok) {
            const services = await res.json();
            const tbody = document.getElementById('servicesTable');
            if (services.length === 0) { tbody.innerHTML = '<tr><td>Службы не найдены</td></tr>'; return; }
            tbody.innerHTML = services.map(s => {
                const statusColor = s.status === 'running' ? 'var(--rx-color)' : '#f85149';
                const statusText = s.status === 'running' ? 'Активен' : 'Остановлен';
                return `<tr>
                    <td><strong>${s.name}</strong><br><span style="color:${statusColor}; font-size:12px;">${statusText}</span></td>
                    <td style="text-align:right; width:60px;"><button class="btn-dark" style="padding: 4px 8px; font-size:11px;" onclick="restartService('${s.name}')">Restart</button></td>
                </tr>`;
            }).join('');
        }
    } catch(e) { document.getElementById('servicesTable').innerHTML = '<tr><td>Ошибка загрузки служб</td></tr>'; }
}

async function restartService(name) {
    if (!confirm(`Перезапустить службу ${name}?`)) return;
    try {
        const res = await fetch('/api/services/restart', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name}) });
        if (res.ok) { alert(`Служба ${name} успешно перезапущена`); loadServices(); }
        else alert("Ошибка при перезапуске");
    } catch (e) { alert("Ошибка соединения"); }
}

async function connectAdGuard(isManualClick = true) {
    let url = document.getElementById('agUrl').value;
    let user = document.getElementById('agUser').value;
    let pass = document.getElementById('agPass').value;
    const errEl = document.getElementById('agError');

    if (!isManualClick && !url && sessionStorage.getItem('agUrl')) {
        url = sessionStorage.getItem('agUrl'); user = sessionStorage.getItem('agUser') || ''; pass = sessionStorage.getItem('agPass') || '';
        document.getElementById('agUrl').value = url; document.getElementById('agUser').value = user; document.getElementById('agPass').value = pass;
    }
    if (!url) return;
    if (isManualClick) { sessionStorage.setItem('agUrl', url); sessionStorage.setItem('agUser', user); sessionStorage.setItem('agPass', pass); }

    try {
        const res = await fetch('/api/adguard/stats', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({url, user, pass}) });
        if (res.ok) {
            errEl.style.display = 'none';
            const data = await res.json();
            document.getElementById('agTotal').innerText = data.num_dns_queries.toLocaleString('ru-RU');
            document.getElementById('agBlocked').innerText = data.num_blocked_filtering.toLocaleString('ru-RU');
            let percent = 0;
            if (data.num_dns_queries > 0) percent = ((data.num_blocked_filtering / data.num_dns_queries) * 100).toFixed(1);
            document.getElementById('agBlockedPercent').innerText = `(${percent}%)`;
            document.getElementById('agMalware').innerText = data.num_replaced_safebrowsing.toLocaleString('ru-RU');
            if (!agInterval) agInterval = setInterval(() => connectAdGuard(false), 5000);
        } else {
            const errData = await res.json();
            errEl.innerText = errData.error; errEl.style.display = 'block';
            if (agInterval) { clearInterval(agInterval); agInterval = null; }
        }
    } catch(e) { errEl.innerText = "Ошибка запроса API."; errEl.style.display = 'block'; if (agInterval) { clearInterval(agInterval); agInterval = null; } }
}

async function changePassword() {
    const newPassword = prompt("Введите новый пароль для панели (минимум 8 символов):");
    if (!newPassword) return;
    if (newPassword.length < 8) return alert("Пароль слишком короткий! Минимум 8 символов.");
    try {
        const res = await fetch('/api/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newPassword })
        });
        if (res.ok) alert("Пароль успешно изменен! Вы можете использовать его при следующем входе.");
        else alert("Ошибка изменения пароля");
    } catch (e) { alert("Ошибка сети"); }
}

async function loadServerInfo() {
    try {
        const res = await fetch('/api/server-info');
        if (res.ok) {
            const data = await res.json();
            let html = `<div style="margin-bottom: 8px;"><span class="val-sys">Обычный DNS (IPv4):</span> ${data.ip} <span class="sub-text">(${data.country})</span></div>`;
            if (data.domain) {
                html += `<div style="margin-bottom: 8px;"><span class="val-rx">DNS-over-TLS (DoT):</span> tls://${data.domain}</div>`;
                html += `<div><span class="val-tx">DNS-over-HTTPS (DoH):</span> https://${data.domain}/dns-query</div>`;
            } else {
                html += `<div style="color: var(--text-muted); font-size: 12px; margin-top: 5px;">* Для настройки DoT и DoH (Private DNS) привяжите домен к серверу.</div>`;
            }
            document.getElementById('dnsAddressesList').innerHTML = html;

            const cascadeCard = document.getElementById('cascadeRoutingCard');
            if (cascadeCard && data.country !== 'RU' && data.country !== 'UNKNOWN') {
                cascadeCard.innerHTML = `
                    <h3 style="color: #58a6ff;">Маршрутизация Каскада</h3>
                    <div style="padding: 20px 0; text-align: center;">
                        <span style="font-size: 30px;">🌍</span>
                        <p style="color: var(--text-muted); margin-top: 10px; font-size: 14px;">
                            Панель обнаружена в регионе <b>${data.country}</b>.<br>
                            Управление маршрутами доступно только на сервере-входе (RU).
                        </p>
                    </div>
                `;
            }
        }
    } catch(e) { document.getElementById('dnsAddressesList').innerHTML = "Не удалось загрузить данные сервера"; }
}

function initChart() {
    const ctx = document.getElementById('trafficChart').getContext('2d');
    const gradRx = ctx.createLinearGradient(0, 0, 0, 300); gradRx.addColorStop(0, 'rgba(46, 160, 67, 0.5)'); gradRx.addColorStop(1, 'rgba(46, 160, 67, 0)');
    const gradTx = ctx.createLinearGradient(0, 0, 0, 300); gradTx.addColorStop(0, 'rgba(88, 166, 255, 0.5)'); gradTx.addColorStop(1, 'rgba(88, 166, 255, 0)');
    Chart.defaults.color = '#8b949e';
    trafficChart = new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [ { label: 'Прием (Rx)', data: [], borderColor: '#2ea043', backgroundColor: gradRx, fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 }, { label: 'Отдача (Tx)', data: [], borderColor: '#58a6ff', backgroundColor: gradTx, fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 } ]},
        options: { responsive: true, maintainAspectRatio: false, animation: { duration: 0 }, interaction: { mode: 'index', intersect: false }, scales: { x: { grid: { color: '#30363d' }, ticks: { maxTicksLimit: 10 } }, y: { grid: { color: '#30363d' }, ticks: { callback: function(v) { return formatSpeed(v); } } } }, plugins: { legend: { labels: { color: '#c9d1d9' } }, tooltip: { callbacks: { label: function(ctx) { return ctx.dataset.label + ': ' + formatSpeed(ctx.parsed.y); } } } } }
    });
}

function switchChart() {
    currentChartView = document.getElementById('chartSelector').value;
    if (chartData[currentChartView] && trafficChart) { 
        trafficChart.data.labels = chartData[currentChartView].labels; 
        trafficChart.data.datasets[0].data = chartData[currentChartView].rx; 
        trafficChart.data.datasets[1].data = chartData[currentChartView].tx; 
        trafficChart.update(); 
    }
}

async function loadHistory() {
    try {
        const res = await fetch('/api/history');
        if (res.ok) {
            chartData = await res.json();
            const selector = document.getElementById('chartSelector');
            const currentClients = Array.from(selector.options).map(o => o.value);
            Object.keys(chartData).forEach(k => {
                if (k !== 'global' && !currentClients.includes(k)) {
                    const opt = document.createElement('option'); opt.value = k; opt.text = 'Клиент: ' + k; selector.appendChild(opt);
                }
            });
            switchChart();
        }
    } catch (e) {}
}

function getPortDesc(pStr) {
    if (!pStr) return 'Системная служба';
    if (pStr.includes('5553')) return 'AdGuard (DNS фильтр)';
    if (pStr.includes('853')) return 'AdGuard (DoT)';
    if (pStr.includes('53')) return 'Системный DNS';
    if (pStr.includes('4444')) return 'Панель FM4.0';
    if (pStr.includes('4443')) return 'AdGuard Панель';
    if (pStr.includes('443')) return 'HTTPS (Веб)';
    if (pStr.includes('80')) return 'HTTP (Веб)';
    if (pStr.includes('37246')) return 'AmneziaWG (VPN)';
    if (pStr.includes('2233') || pStr.includes('22')) return 'SSH Терминал';
    if (pStr.includes('9090') || pStr.includes('9091')) return 'MTProto Прокси';
    return 'Процесс / Служба';
}

async function loadUfwData() {
    const res = await fetch('/api/ufw');
    if (res.ok) {
        const data = await res.json();
        const tbodyRules = document.getElementById('ufwTable');
        if (data.rules.length === 0) tbodyRules.innerHTML = '<tr><td colspan="4">Нет правил</td></tr>';
        else {
            tbodyRules.innerHTML = data.rules.map(r => {
                const portMatch = r.to.match(/\d+/);
                const desc = portMatch ? getPortDesc(portMatch[0]) : 'Маршрут / PBR';
                const statusHtml = r.action.includes('ALLOW') ? '<span class="val-rx">Открыт</span>' : '<span class="val-sys">Закрыт</span>';
                return `<tr><td style="white-space:normal; word-wrap:break-word;"><strong>[${r.id}]</strong> <span class="val-tx">${r.to}</span> <span class="val-sys">←</span> ${r.from}</td><td>${statusHtml}</td><td><span class="sub-text" style="font-size:13px">${desc}</span></td><td><button class="btn-dark" onclick="delUfwRule('${r.id}')">✕</button></td></tr>`;
            }).join('');
        }

        const tbodyPorts = document.getElementById('portsTable');
        if (data.ports.length === 0) tbodyPorts.innerHTML = '<tr><td colspan="4">Нет открытых портов</td></tr>';
        else {
            tbodyPorts.innerHTML = data.ports.map(p => {
                const portNum = p.addr.split(':').pop();
                return `<tr><td><strong class="val-sys">${p.proto}</strong><br><span style="font-size:12px;color:var(--text-muted)">${portNum}</span></td><td><span class="val-rx">${p.addr}</span></td><td>${p.proc}</td><td><span class="sub-text" style="font-size:13px">${getPortDesc(portNum)}</span></td></tr>`;
            }).join('');
        }
    }
}

async function addUfwRule() {
    const port = document.getElementById('ufwPort').value;
    const proto = document.getElementById('ufwProto').value;
    const iface = document.getElementById('ufwIface').value;
    if(!port) return alert("Введите порт");
    const res = await fetch('/api/ufw', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({port, proto, iface}) });
    if(res.ok) { document.getElementById('ufwPort').value = ''; loadUfwData(); }
}

async function delUfwRule(id) {
    if(!confirm(`Удалить правило №${id}?`)) return;
    const res = await fetch(`/api/ufw/${id}`, { method: 'DELETE' });
    if(res.ok) loadUfwData();
}

async function loadNetworkTools() {
    try {
        const ifaces = await (await fetch('/api/interfaces')).json();
        const st = await (await fetch('/api/tools/status')).json();

        // Безопасное чтение массивов на случай старой версии backend'а
        const ruIfaces = (st.ruDrop && st.ruDrop.ifaces) ? st.ruDrop.ifaces : [];
        const cascIfaces = (st.cascade && st.cascade.ifaces) ? st.cascade.ifaces : [];
        window.currentDnsIfaces = (st.dns && st.dns.ifaces) ? st.dns.ifaces : [];
        window.currentDnsTarget = (st.dns && st.dns.target) ? st.dns.target : '';

        // 1. Отрисовка чекбоксов для GeoIP
        const ruList = document.getElementById('ruDropIfacesList');
        if (ruList) {
            ruList.innerHTML = ifaces.map(i => `
                <div class="form-check form-check-inline" style="margin-right: 10px;">
                    <input class="form-check-input ru-check" type="checkbox" value="${i}" id="ru_${i}" ${ruIfaces.includes(i) ? 'checked' : ''}>
                    <label class="form-check-label text-white small" for="ru_${i}">${i}</label>
                </div>
            `).join('');
        }
        const ruEl = document.getElementById('ruDropStatus');
        if (ruEl) {
            if (st.ruDrop && st.ruDrop.active) {
                ruEl.innerHTML = `<span class="val-rx">Активно на: ${ruIfaces.join(', ')}</span> <span class="sub-text">(Правил: ${st.ruDrop.count || 0})</span>`;
            } else {
                ruEl.innerHTML = `<span class="val-tx">Выключено</span>`;
            }
        }

        // 2. Отрисовка чекбоксов для Каскада
        const cascList = document.getElementById('cascadeIfacesList');
        if (cascList) {
            cascList.innerHTML = ifaces.map(i => `
                <div class="form-check form-check-inline" style="margin-right: 10px;">
                    <input class="form-check-input casc-check" type="checkbox" value="${i}" id="casc_${i}" ${cascIfaces.includes(i) ? 'checked' : ''}>
                    <label class="form-check-label text-white small" for="casc_${i}">${i}</label>
                </div>
            `).join('');
        }
        const cascEl = document.getElementById('cascadeStatus');
        if (cascEl) {
            if (st.cascade && st.cascade.active) {
                cascEl.innerHTML = `<span class="val-rx">Каскад работает для: ${cascIfaces.join(', ')}</span>`;
            } else {
                cascEl.innerHTML = `<span class="val-tx">Маршруты каскада отключены</span>`;
            }
        }

        // 3. Отрисовка чекбоксов для DNS
        const dnsList = document.getElementById('dnsIfacesList');
        if (dnsList) {
            dnsList.innerHTML = ifaces.map(i => `
                <div class="form-check form-check-inline" style="margin-right: 10px;">
                    <input class="form-check-input dns-check" type="checkbox" value="${i}" id="dns_${i}" ${window.currentDnsIfaces.includes(i) ? 'checked' : ''}>
                    <label class="form-check-label text-white small" for="dns_${i}">${i}</label>
                </div>
            `).join('');
        }
        const dnsEl = document.getElementById('dnsStatus');
        if (dnsEl) {
            if (st.dns && st.dns.active) { 
                dnsEl.innerHTML = `<span class="val-rx">Активен на: ${window.currentDnsIfaces.join(', ')}</span> <span class="sub-text">Цель: ${window.currentDnsTarget}</span>`; 
                const targetInput = document.getElementById('dnsTarget');
                if (targetInput) targetInput.value = window.currentDnsTarget; 
            } else {
                dnsEl.innerHTML = `<span class="val-tx">Не активно</span>`;
            }
        }

        // 4. UFW остается выпадающим списком
        const ufwSel = document.getElementById('ufwIface');
        if (ufwSel) {
            ufwSel.innerHTML = '<option value="any">Все</option>';
            ifaces.forEach(i => { ufwSel.appendChild(new Option(i, i)); });
        }
    } catch (e) {
        console.error("Ошибка загрузки сетевых инструментов:", e);
    }
}

async function toggleRuDrop(enable) {
    const checkedIfaces = Array.from(document.querySelectorAll('.ru-check:checked')).map(cb => cb.value);
    if (enable && checkedIfaces.length === 0) return alert('Выберите хотя бы один интерфейс для блокировки!');
    
    const payload = {
        enable, 
        ifaces: checkedIfaces, 
        schedule: document.getElementById('ruDropSchedule').value,
        ports: document.getElementById('ruDropPorts').value.trim(),
        listMode: document.getElementById('ruDropListMode').value,
        customUrl: document.getElementById('ruDropCustomUrl').value.trim()
    };
    
    document.getElementById('ruDropStatus').innerText = "Применение (до 20 сек)...";
    const res = await fetch('/api/tools/rudrop', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    if (res.ok) loadNetworkTools();
}

async function toggleCascade(enable) {
    const checkedIfaces = Array.from(document.querySelectorAll('.casc-check:checked')).map(cb => cb.value);
    if (enable && checkedIfaces.length === 0) return alert('Выберите хотя бы один интерфейс для каскада!');
    
    const payload = {
        enable,
        ifaces: checkedIfaces
    };

    document.getElementById('cascadeStatus').innerText = "Настройка маршрутов...";
    const res = await fetch('/api/tools/cascade', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    if (res.ok) {
        const data = await res.json();
        if(data.error) alert(data.error);
        loadNetworkTools();
    } else {
        alert("Ошибка настройки каскада. Проверьте логи.");
    }
}

async function toggleDns(enable) {
    const checkedIfaces = Array.from(document.querySelectorAll('.dns-check:checked')).map(cb => cb.value);
    const target = document.getElementById('dnsTarget').value;
    if (enable && checkedIfaces.length === 0) return alert("Выберите хотя бы один интерфейс для перехвата DNS");
    if (enable && !target) return alert("Укажите IP-адрес DNS сервера");
    document.getElementById('dnsStatus').innerText = "Применение...";
    const res = await fetch('/api/tools/dns', { 
        method: 'POST', 
        headers: {'Content-Type':'application/json'}, 
        body: JSON.stringify({
            enable, 
            ifaces: checkedIfaces, 
            target, 
            oldIfaces: window.currentDnsIfaces, 
            oldTarget: window.currentDnsTarget
        }) 
    });
    if (res.ok) loadNetworkTools();
}

function applyRoleUI() {
    const isAdmin = currentRole === 'admin';
    const nav = document.getElementById('navAdmin');
    if (nav) nav.style.display = isAdmin ? '' : 'none';
    const navInstall = document.getElementById('navInstall');
    if (navInstall) navInstall.style.display = isAdmin ? '' : 'none';
    const navDiag = document.getElementById('navDiag');
    if (navDiag) navDiag.style.display = isAdmin ? '' : 'none';
    const navUpdate = document.getElementById('navUpdate');
    if (navUpdate) navUpdate.style.display = isAdmin ? '' : 'none';
    const who = document.getElementById('whoami');
    if (who) who.innerText = currentUser;
    const roleEl = document.getElementById('userRole');
    if (roleEl) roleEl.innerText = isAdmin ? (currentLang === 'en' ? 'administrator' : 'администратор') : (currentLang === 'en' ? 'view-only' : 'просмотр');
    const avatar = document.getElementById('userAvatar');
    if (avatar) avatar.innerText = String(currentUser || 'A').charAt(0).toUpperCase();
    document.querySelectorAll('[data-admin-only]').forEach(el => { el.style.display = isAdmin ? '' : 'none'; });
    if (!isAdmin) {
        const adminTab = document.getElementById('tab-admin');
        const updateTab = document.getElementById('tab-update');
        if ((adminTab && adminTab.classList.contains('active')) ||
            (updateTab && updateTab.classList.contains('active'))) {
            const first = document.querySelector('.nav-item[data-tab="tab-dashboard"]');
            if (first) switchTab('tab-dashboard', first);
        }
    }
}

async function refreshMe() {
    try {
        const res = await fetch('/api/security/status');
        if (!res.ok) return;
        const d = await res.json();
        currentUser = d.user || 'admin';
        currentRole = d.role || 'admin';
    } catch (e) { /* ignore */ }
}

function showDashboard() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('dashboardScreen').style.display = 'flex';
    if (!trafficChart) initChart();
    initExpertMode();
    refreshMe().then(() => {
        applyRoleUI();
        if (currentRole === 'admin') { loadAwgConfig(); loadAdminPanel(); loadF2bMini(); }
    });
    loadNetworkTools(); loadUfwData(); loadHistory(); loadStats(); loadServerInfo();
    checkSecurityStatus(); loadCascadeStatus(); loadObfCurrent(); loadObfProfiles();
    loadDashboardState();
    if (!pollingInterval) pollingInterval = setInterval(loadStats, 2000);
    if (!historyInterval) historyInterval = setInterval(loadHistory, 10000);
    if (!window.dashboardStateInterval) window.dashboardStateInterval = setInterval(loadDashboardState, 30000);
}

function showLogin() {
    window.__loggedIn = false;
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('dashboardScreen').style.display = 'none';
    const codeInput = document.getElementById('authCode');
    if (codeInput) codeInput.style.display = 'none';
    const codeField = document.getElementById('authCodeField');
    if (codeField) codeField.style.display = 'none';
    document.getElementById('loginError').style.display = 'none';
    if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
    if (historyInterval) { clearInterval(historyInterval); historyInterval = null; }
    if (agInterval) { clearInterval(agInterval); agInterval = null; }
    if (window.dashboardStateInterval) { clearInterval(window.dashboardStateInterval); window.dashboardStateInterval = null; }
    if (typeof closeWizard === 'function') closeWizard();
    if (typeof closePalette === 'function') closePalette();
    if (typeof closeModal === 'function') closeModal();
}

async function login() {
    const username = document.getElementById('authUsername').value.trim();
    const pass = document.getElementById('authPassword').value;
    const code = document.getElementById('authCode').value.trim();
    const err = document.getElementById('loginError');
    try {
        const res = await fetch('/api/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password: pass, code })
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok) {
            currentUser = d.user || 'admin';
            currentRole = d.role || 'admin';
            err.style.display = 'none';
            document.getElementById('authPassword').value = '';
            document.getElementById('authCode').value = '';
            document.getElementById('authCode').style.display = 'none';
            const codeField = document.getElementById('authCodeField');
            if (codeField) codeField.style.display = 'none';
            window.__loggedIn = true;
            window.__loginAt = Date.now();
            showDashboard();
            return;
        }
        if (d.need2fa) {
            const codeField = document.getElementById('authCodeField');
            if (codeField) codeField.style.display = 'block';
            document.getElementById('authCode').style.display = 'block';
            document.getElementById('authCode').focus();
        }
        err.innerText = d.error || 'Неверный пароль';
        err.style.display = 'block';
    } catch (e) {
        err.innerText = 'Сетевая ошибка';
        err.style.display = 'block';
    }
}

async function logout() { await fetch('/api/logout', { method: 'POST' }); showLogin(); }

async function restoreBackup(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!confirm(`Вы уверены, что хотите восстановить панель из файла "${file.name}"?`)) { event.target.value = ''; return; }
    document.getElementById('loaderOverlay').style.display = 'flex';
    const reader = new FileReader();
    reader.onload = async function(e) {
        const base64data = e.target.result.split(',')[1];
        try {
            const res = await fetch('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileData: base64data }) });
            if (res.ok) { document.getElementById('loaderText').innerText = "Успешно! Перезапуск..."; setTimeout(() => { window.location.reload(); }, 3500); } 
            else { const err = await res.json(); alert("Ошибка восстановления: " + err.error); document.getElementById('loaderOverlay').style.display = 'none'; }
        } catch(err) { alert("Сетевая ошибка при загрузке бэкапа"); document.getElementById('loaderOverlay').style.display = 'none'; }
        event.target.value = '';
    };
    reader.readAsDataURL(file);
}

async function loadStats() {
    if (isFetching) return;
    isFetching = true;
    try {
        const [resStats, resSys] = await Promise.all([ fetch('/api/stats'), fetch('/api/sysinfo') ]);
        if (resStats.status === 401 || resSys.status === 401) {
            const fresh = window.__loggedIn && window.__loginAt && (Date.now() - window.__loginAt < 15000);
            if (!fresh) showLogin();
            isFetching = false;
            return;
        }
        
        if (resSys.ok) {
            const sys = await resSys.json();
            const cpuEl = document.getElementById('sysCpu');
            const ramEl = document.getElementById('sysRam');
            const upEl = document.getElementById('sysUptime');
            const heroUp = document.getElementById('heroUptime');
            if (cpuEl) cpuEl.innerText = sys.cpu + '%';
            if (ramEl) ramEl.innerText = sys.ram + '%';
            if (upEl) upEl.innerText = sys.uptime;
            if (heroUp) heroUp.innerText = 'Uptime: ' + (sys.uptime || '—');
            if (sys.disk && sys.disk.total > 0) { 
                const du = document.getElementById('diskUsed'); if (du) du.innerText = formatBytes(sys.disk.used); 
                const df = document.getElementById('diskFree'); if (df) df.innerText = formatBytes(sys.disk.free); 
                const dt = document.getElementById('diskTotal'); if (dt) dt.innerText = formatBytes(sys.disk.total); 
            }
        }

        const data = await resStats.json();
        const tbody = document.getElementById('clientsTable'); const now = Date.now();
        let totalRx = 0, totalTx = 0, totalRxSpeed = 0, totalTxSpeed = 0; let activeCount = 0;

        let enrichedData = data.map(client => {
            let rxSpeed = 0, txSpeed = 0;
            if (lastStats[client.name]) {
                const prev = lastStats[client.name]; const timeDiffSec = (now - prev.time) / 1000;
                if (timeDiffSec > 0 && client.rx >= prev.rx) { rxSpeed = (client.rx - prev.rx) / timeDiffSec; txSpeed = (client.tx - prev.tx) / timeDiffSec; }
            }
            lastStats[client.name] = { rx: client.rx, tx: client.tx, time: now };
            totalRx += client.rx; totalTx += client.tx; totalRxSpeed += rxSpeed; totalTxSpeed += txSpeed;
            
            if (client.status_code === 'active' || client.status_code === 'recent') activeCount++;
            return { ...client, rxSpeed, txSpeed, totalTraffic: (client.rx || 0) + (client.tx || 0), totalSpeed: rxSpeed + txSpeed };
        });

        enrichedData.sort((a, b) => {
            let valA, valB;
            if (sortCol === 'name') {
                valA = a.name.toLowerCase(); valB = b.name.toLowerCase();
            } else if (sortCol === 'status') {
                const score = s => s === 'active' ? 2 : (s === 'recent' ? 1 : 0);
                valA = score(a.status_code); valB = score(b.status_code);
            } else if (sortCol === 'traffic') {
                valA = a.totalTraffic; valB = b.totalTraffic;
            } else if (sortCol === 'speed') {
                valA = a.totalSpeed; valB = b.totalSpeed;
            }
            if (valA < valB) return sortDesc ? 1 : -1;
            if (valA > valB) return sortDesc ? -1 : 1;
            return 0;
        });

        enrichedData.forEach((client, idx) => {
            const statusClass = client.status_code === 'active' ? 'status-active' : (client.status_code === 'recent' ? 'status-recent' : 'status-inactive');
            const safeIpId = client.ip.replace(/\./g, '-');
            
            let tr = document.getElementById('row-' + client.name);
            if (!tr) {
                tr = document.createElement('tr'); tr.id = 'row-' + client.name;
                tr.innerHTML = `
                    <td class="idx-cell" style="text-align: center; color: var(--text-muted);"></td>
                    <td><strong style="font-size:14px;">${client.name}</strong><br><span class="sub-text">${client.ip}</span></td> 
                    <td><span class="st-cell ${statusClass}">${client.status}</span></td> 
                    <td class="tr-cell"></td> 
                    <td class="sp-cell"></td>
                    <td><input type="number" id="limit-${safeIpId}" style="width:60px; padding:6px; margin-bottom:5px;" placeholder="Мб/с"><br><button class="btn-dark" style="padding:4px 10px; font-size:11px;" onclick="setLimit('${client.ip}')">Применить</button></td>
                    <td><button class="btn-success" style="margin-bottom:5px; font-size:12px; padding:6px 10px; width:100%" onclick="window.location.href='/api/download/${client.name}'">Скачать Conf</button>
                        <button class="btn-dark" style="margin-bottom:5px; font-size:12px; padding:6px 10px; width:100%" onclick="showClientKey('${client.name}')">🔑 Ключ подключения</button>
                        <button class="btn-dark" style="margin-bottom:5px; font-size:12px; padding:6px 10px; width:100%" onclick="renameClient('${client.name}')">✎ Изменить имя</button>
                        <button class="btn-danger" style="font-size:12px; padding:6px 10px; width:100%" onclick="deleteClient('${client.name}')">Удалить</button></td>
                `;
                tbody.appendChild(tr);
            }
            tr.querySelector('.idx-cell').innerText = idx + 1;
            tr.querySelector('.st-cell').className = `st-cell ${statusClass}`;
            tr.querySelector('.st-cell').innerText = client.status;
            tr.querySelector('.tr-cell').innerHTML = `<span class="val-rx">↓ ${formatBytes(client.rx)}</span><br><span class="val-tx">↑ ${formatBytes(client.tx)}</span>`;
            tr.querySelector('.sp-cell').innerHTML = `<div class="speed-cell"><span class="val-rx">↓ ${formatSpeed(client.rxSpeed)}</span> &nbsp;|&nbsp; <span class="val-tx">↑ ${formatSpeed(client.txSpeed)}</span></div>`;
        });

        enrichedData.forEach(client => { const tr = document.getElementById('row-' + client.name); if(tr) tbody.appendChild(tr); });

        // Удаляем строки клиентов, которых больше нет (после удаления/переименования)
        const alive = new Set(enrichedData.map(c => 'row-' + c.name));
        Array.from(tbody.querySelectorAll('tr')).forEach(tr => { if (!alive.has(tr.id)) tr.remove(); });

        const totalEl = document.getElementById('totalClientsCount');
        if (totalEl) totalEl.innerText = enrichedData.length;
        const activeEl = document.getElementById('activeClientsCount');
        if (activeEl) activeEl.innerText = activeCount;
        const globalTrafficEl = document.getElementById('globalTraffic');
        if (globalTrafficEl) globalTrafficEl.innerHTML = `<span class="val-rx">↓ ${formatBytes(totalRx)}</span> <span style="color:var(--text-muted)">|</span> <span class="val-tx">↑ ${formatBytes(totalTx)}</span>`;
        const globalSpeedEl = document.getElementById('globalSpeed');
        if (globalSpeedEl) globalSpeedEl.innerHTML = `<span class="val-rx">↓ ${formatSpeed(totalRxSpeed)}</span> <span style="color:var(--text-muted)">|</span> <span class="val-tx">↑ ${formatSpeed(totalTxSpeed)}</span>`;
        updateQuickClients(enrichedData, activeCount);
    } catch (e) {}
    isFetching = false;
}

async function createConfig() {
    const name = document.getElementById('clientName').value; 
    const count = document.getElementById('clientCount').value; 
    const expires = document.getElementById('clientExpires').value;
    
    if(!name) return alert("Введите имя (префикс)");
    
    if (!count || parseInt(count) <= 1) {
        // Одиночное создание (остается как было)
        const res = await fetch('/api/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, expires }) });
        if (res.ok) { 
            const a = document.createElement('a'); 
            a.href = window.URL.createObjectURL(await res.blob()); 
            a.download = `Serv_${name}.conf`; 
            a.click(); 
            document.getElementById('clientName').value = ''; 
            loadStats(); 
        }
    } else {
        // Массовое создание (Прямое скачивание файлов вместо ZIP)
        document.getElementById('loaderOverlay').style.display = 'flex'; 
        document.getElementById('loaderText').innerText = "Генерация конфигов (около 1-2 сек на каждый)...";
        
        try {
            const res = await fetch('/api/create-bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: name, count: parseInt(count), expires }) });
            if (res.ok) { 
                const data = await res.json();
                if (data.configs && data.configs.length > 0) {
                    // Запускаем поочередное скачивание всех файлов
                    data.configs.forEach((conf, index) => {
                        // Задержка 300мс между скачиваниями, чтобы браузер (Chrome/Safari) не заблокировал их как спам-попапы
                        setTimeout(() => {
                            const blob = new Blob([conf.content], { type: 'text/plain' });
                            const a = document.createElement('a');
                            a.href = window.URL.createObjectURL(blob);
                            a.download = `Serv_${conf.name}.conf`;
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                        }, index * 300);
                    });
                } else {
                    alert("Конфиги не сгенерировались. Проверьте логи.");
                }
                
                document.getElementById('clientName').value = ''; 
                document.getElementById('clientCount').value = ''; 
                loadStats(); 
            } else {
                alert('Ошибка массовой генерации на сервере');
            }
        } catch (e) {
            alert('Сетевая ошибка');
        }
        document.getElementById('loaderOverlay').style.display = 'none';
    }
}

async function deleteClient(name) {
    if (!confirm(`Точно удалить клиента ${name}?`)) return;
    const res = await fetch(`/api/delete/${name}`, { method: 'DELETE' });
    if (res.ok) { delete lastStats[name]; document.getElementById('row-' + name).remove(); }
}

async function setLimit(ip) {
    const rate = document.getElementById('limit-' + ip.replace(/\./g, '-')).value;
    if (!rate) return alert("Введите скорость в Мбит/с");
    const res = await fetch('/api/limit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip, rate: parseInt(rate) }) });
    if (res.ok) alert(`Лимит для ${ip} установлен: ${rate} Mbit/s`);
}

// ===========================================================================
// Модальное окно, ключи vpn://, переименование
// ===========================================================================
let lastKeyUri = '';

function openModal(title, html) {
    document.getElementById('modalTitle').innerText = title;
    document.getElementById('modalBody').innerHTML = html;
    document.getElementById('modalOverlay').style.display = 'flex';
}
function closeModal() {
    document.getElementById('modalOverlay').style.display = 'none';
    document.getElementById('modalBody').innerHTML = '';
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

function copyText(text) {
    navigator.clipboard.writeText(text).then(() => {
        alert('Скопировано в буфер обмена');
    }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); alert('Скопировано'); } catch (e) { alert('Не удалось скопировать'); }
        document.body.removeChild(ta);
    });
}
function copyKeyUri() { copyText(lastKeyUri); }

async function showClientKey(name) {
    lastKeyUri = '';
    openModal('Ключ подключения: ' + name, '<div style="color:var(--text-muted);">Загрузка ключа...</div>');
    try {
        const res = await fetch(`/api/clients/${encodeURIComponent(name)}/key`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            document.getElementById('modalBody').innerHTML = `<div style="color:#f85149;">${data.error || 'Не удалось получить ключ'}</div>`;
            return;
        }
        lastKeyUri = data.uri || '';
        document.getElementById('modalBody').innerHTML = `
            <p style="color:var(--text-muted); font-size:13px; margin-top:0;">
                В AmneziaVPN нажмите «+» → «Импорт из ссылки» (или отсканируйте QR). Ссылка <code>vpn://</code> содержит ключи и параметры обфускации.
            </p>
            ${data.qr ? `<img src="${data.qr}" alt="QR" style="width:220px; height:220px; background:#fff; padding:8px; border-radius:8px; display:block; margin:0 auto 14px;">` : ''}
            <textarea readonly rows="5" style="width:100%; box-sizing:border-box; font-family:monospace; font-size:11px; background:rgba(0,0,0,.35); color:#c9d1d9; border:1px solid var(--border); border-radius:6px; padding:8px; resize:vertical;">${String(data.uri).replace(/</g, '&lt;')}</textarea>
            <div class="controls-row" style="margin-top:12px; margin-bottom:0;">
                <button class="btn-primary" onclick="copyKeyUri()">📋 Скопировать vpn://</button>
                <a class="btn-dark" href="/api/download/${encodeURIComponent(name)}" style="text-decoration:none; padding:8px 14px;">⬇️ Скачать .conf</a>
                <a class="btn-dark" href="/api/clients/${encodeURIComponent(name)}/export" style="text-decoration:none; padding:8px 14px;">📄 Файл-инструкция (QR + ключ)</a>
            </div>`;
    } catch (e) {
        document.getElementById('modalBody').innerHTML = '<div style="color:#f85149;">Сетевая ошибка</div>';
    }
}

async function renameClient(name) {
    const newName = prompt(`Новое имя для «${name}» (A-Z, a-z, 0-9, _ и -):`, name);
    if (!newName || newName === name) return;
    if (!/^[A-Za-z0-9_-]{1,63}$/.test(newName)) return alert('Недопустимое имя. Разрешены буквы, цифры, _ и -, до 63 символов.');
    try {
        const res = await fetch(`/api/clients/${encodeURIComponent(name)}/rename`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ newName })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) { loadStats(); }
        else alert(data.error || 'Ошибка переименования');
    } catch (e) { alert('Сетевая ошибка'); }
}

async function bulkRename() {
    const search = document.getElementById('renameSearch').value.trim();
    const replace = document.getElementById('renameReplace').value.trim();
    if (!search) return alert('Укажите, что искать в именах клиентов');
    if (!confirm(`Переименовать всех клиентов, в имени которых есть «${search}»?`)) return;
    try {
        const res = await fetch('/api/clients/rename-bulk', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ search, replace })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return alert(data.error || 'Ошибка массового переименования');
        const skipped = (data.skipped || []).map(s => `${s.name}: ${s.reason}`).slice(0, 10).join('\n');
        alert(`Переименовано: ${(data.renamed || []).length}\nПропущено: ${(data.skipped || []).length}` + (skipped ? `\n\n${skipped}` : ''));
        document.getElementById('renameSearch').value = '';
        document.getElementById('renameReplace').value = '';
        loadStats();
    } catch (e) { alert('Сетевая ошибка'); }
}

async function checkSecurityStatus() {
    try {
        const res = await fetch('/api/security/status');
        if (!res.ok) return;
        const d = await res.json();
        const w = document.getElementById('secWarn');
        if (w) w.style.display = d.defaultPassword ? 'block' : 'none';
    } catch (e) {}
}

// ===========================================================================
// Каскад
// ===========================================================================
async function loadCascadeStatus(manual) {
    const box = document.getElementById('cascadeStatusBox');
    if (!box) return;
    try {
        const res = await fetch('/api/cascade/status');
        const d = await res.json();
        const yes = v => v ? '<span class="val-rx">да</span>' : '<span class="val-tx">нет</span>';
        const hs = d.handshakeAgo === null || d.handshakeAgo === undefined
            ? '<span class="val-tx">нет связи</span>'
            : `<span class="${d.handshakeAgo < 150 ? 'val-rx' : 'val-tx'}">${d.handshakeAgo} сек. назад</span>`;
        box.innerHTML = `
            <div style="font-size:15px; font-weight:bold; color:${d.color}; margin-bottom:12px;">${d.text}</div>
            <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px; font-size:13px;">
                <div>Конфиг awg1: ${yes(d.configured)}</div>
                <div>Туннель awg-quick@awg1: ${yes(d.tunnelActive)}</div>
                <div>Рукопожатие с EU: ${hs}</div>
                <div>Таймер маршрутов: ${yes(d.timerActive)}</div>
                <div>Интерфейсы: <span class="val-rx">${(d.ifaces || []).join(', ') || '—'}</span></div>
                <div>Записей GeoIP (ipset ru): <b>${d.ipsetCount || 0}</b></div>
                <div>Правило fwmark 0x1: ${yes(d.ruleExists)}</div>
                <div>Маршрут таблицы 100: <code>${(d.tableRoute || '—').replace(/</g, '&lt;')}</code></div>
                <div>Endpoint EU: <code>${(d.endpoint || '—').replace(/</g, '&lt;')}</code></div>
            </div>`;
        if (manual && !d.configured) {
            box.innerHTML += '<div style="margin-top:10px; color:var(--text-muted); font-size:12px;">Заполните форму ниже, чтобы включить каскад.</div>';
        }
    } catch (e) {
        box.innerHTML = '<span class="val-tx">Не удалось получить статус каскада</span>';
    }
}

async function loadCascadeSetup() {
    const box = document.getElementById('cascadeSetupIfaces');
    if (!box) return;
    try {
        const ifaces = await (await fetch('/api/interfaces')).json();
        const pref = ifaces.filter(i => /^(awg|amn|wg)/.test(i));
        const show = pref.length ? pref : ifaces;
        box.innerHTML = show.map(i => `
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:var(--text-main);">
                <input type="checkbox" class="casc-setup-check" value="${i}" ${/^(awg0|amn0)$/.test(i) ? 'checked' : ''}> ${i}
            </label>`).join('');
    } catch (e) { box.innerText = 'Ошибка загрузки интерфейсов'; }
    try {
        const res = await fetch('/api/cascade/config');
        if (res.ok) {
            const d = await res.json();
            const ta = document.getElementById('cascadeConfText');
            if (ta) ta.value = d.content || '';
        }
    } catch (e) {}
}

async function setupCascade(btn) {
    const config = document.getElementById('cascadeSetupConf').value;
    const ifaces = Array.from(document.querySelectorAll('.casc-setup-check:checked')).map(c => c.value);
    const extraRuNets = document.getElementById('cascadeExtraNets').value;
    if (!config.trim()) return alert('Вставьте конфиг клиента с EU-сервера');
    if (!ifaces.length) return alert('Выберите хотя бы один клиентский интерфейс');
    if (!confirm('Настроить каскад? Будут созданы awg1.conf, правила маршрутизации и systemd-таймер.')) return;
    if (btn) { btn.disabled = true; btn.innerText = 'Настройка...'; }
    try {
        const res = await fetch('/api/cascade/setup', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ config, ifaces, extraRuNets })
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok) {
            alert('Каскад настроен. Endpoint: ' + (d.endpoint || '—'));
            loadCascadeStatus(true);
            loadCascadeSetup();
        } else alert(d.error || 'Ошибка настройки каскада');
    } catch (e) { alert('Сетевая ошибка'); }
    finally { if (btn) { btn.disabled = false; btn.innerText = '✅ Настроить каскад'; } }
}

async function refreshCascade() {
    if (!confirm('Перезапустить обновление маршрутов и списка GeoIP?')) return;
    try {
        const res = await fetch('/api/cascade/refresh', { method: 'POST' });
        const d = await res.json().catch(() => ({}));
        if (res.ok) { alert('Маршруты обновлены.'); loadCascadeStatus(true); }
        else alert(d.error || 'Ошибка обновления');
    } catch (e) { alert('Сетевая ошибка'); }
}

async function removeCascade() {
    if (!confirm('Отключить каскад? Туннель awg1 и маршрутизация будут остановлены (конфиг awg1.conf сохранится).')) return;
    try {
        const res = await fetch('/api/cascade/remove', { method: 'POST' });
        if (res.ok) { alert('Каскад отключён'); loadCascadeStatus(true); }
        else alert('Ошибка отключения');
    } catch (e) { alert('Сетевая ошибка'); }
}

async function saveCascadeConf() {
    const content = document.getElementById('cascadeConfText').value;
    if (!content.trim()) return alert('Пустой конфиг');
    if (!confirm('Сохранить awg1.conf и перезапустить туннель?')) return;
    try {
        const res = await fetch('/api/awg/config', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ content, file: '/etc/amnezia/amneziawg/awg1.conf' })
        });
        if (res.ok) { alert('Сохранено'); loadCascadeStatus(true); }
        else alert('Ошибка сохранения');
    } catch (e) { alert('Сетевая ошибка'); }
}

// ===========================================================================
// Обфускация (Архитектор): аудит, импорт, применение
// ===========================================================================
let obfCurrentParams = {};
let obfLastAnalysis = null;

const OBF_LEVEL_META = {
    strong: { color: '#3fb950', title: 'Устойчиво', emoji: '🟢' },
    good: { color: '#d29922', title: 'Средне', emoji: '🟡' },
    weak: { color: '#f0883e', title: 'Слабо', emoji: '🟠' },
    critical: { color: '#f85149', title: 'Критично', emoji: '🔴' }
};

function obfLevelMeta(level) {
    return OBF_LEVEL_META[level] || OBF_LEVEL_META.critical;
}

function renderObfAudit(audit, version) {
    const ring = document.getElementById('obfScoreRing');
    const value = document.getElementById('obfScoreValue');
    const verdict = document.getElementById('obfVerdict');
    const meta = document.getElementById('obfMeta');
    const box = document.getElementById('obfFindings');
    if (!ring || !value || !verdict || !meta || !box) return;
    if (!audit || typeof audit.score !== 'number') {
        ring.style.background = 'conic-gradient(#30363d 0deg, #30363d 360deg)';
        value.innerText = '—';
        verdict.innerText = 'Нет данных: параметры обфускации не найдены';
        verdict.style.color = 'var(--text-muted)';
        meta.innerText = '';
        box.innerHTML = '';
        return;
    }
    const m = obfLevelMeta(audit.level);
    const deg = Math.round(audit.score * 3.6);
    ring.style.background = `conic-gradient(${m.color} ${deg}deg, #21262d ${deg}deg)`;
    value.innerText = String(audit.score);
    value.style.color = m.color;
    verdict.innerHTML = `${m.emoji} ${m.title} — ${esc(audit.score)}/100`;
    verdict.style.color = m.color;
    meta.innerHTML = `Версия: <b>AWG ${esc(version || audit.version || '—')}</b>` +
        ` · общие параметры: <b>${esc(audit.summary ? audit.summary.shared : '—')}</b>` +
        ` · клиентские: <b>${esc(audit.summary ? audit.summary.client : '—')}</b>` +
        (audit.summary ? ` · CPS: <b>${esc(audit.summary.cps)}/5</b>` : '');

    const icon = { error: '⛔', warn: '⚠️', info: 'ℹ️', ok: '✅' };
    const color = { error: '#f85149', warn: '#d29922', info: '#79c0ff', ok: '#3fb950' };
    const order = { error: 0, warn: 1, info: 2, ok: 3 };
    const list = (audit.findings || []).slice().sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9));
    const visible = list.filter(f => f.level === 'error' || f.level === 'warn');
    const rest = list.filter(f => f.level !== 'error' && f.level !== 'warn');
    const card = f => `<div style="background:rgba(0,0,0,.18); border-left:3px solid ${color[f.level] || '#30363d'}; border-radius:4px; padding:8px 10px;">
        <div style="font-size:12px; font-weight:bold; color:${color[f.level] || '#c9d1d9'};">${icon[f.level] || '•'} ${esc(f.title)}</div>
        <div style="font-size:12px; color:var(--text-muted); margin-top:3px; line-height:1.45;">${esc(f.detail)}</div>
        ${f.fix ? `<div style="font-size:11px; color:#79c0ff; margin-top:3px;">→ ${esc(f.fix)}</div>` : ''}
    </div>`;
    box.innerHTML = visible.map(card).join('') +
        (rest.length ? `<details><summary style="cursor:pointer; font-size:12px; color:var(--text-muted);">Ещё ${rest.length} замечани(й)</summary><div style="display:grid; gap:8px; margin-top:8px;">${rest.map(card).join('')}</div></details>` : '');
}

async function loadObfCurrent() {
    const el = document.getElementById('obfCurrent');
    if (!el) return;
    el.innerHTML = '<span style="color:var(--text-muted);">Загрузка...</span>';
    try {
        const res = await fetch('/api/obf/current');
        const d = await res.json();
        if (!res.ok) { el.innerText = d.error || 'Ошибка'; return; }
        obfCurrentParams = d.params || {};
        renderObfAudit(d.audit, d.version);
        const keys = Object.keys(obfCurrentParams);
        if (!keys.length) {
            el.innerHTML = '<span style="color:var(--text-muted);">Параметры обфускации не найдены в конфиге</span>';
            return;
        }
        el.innerHTML = keys.map(k => {
            const shared = ['H1', 'H2', 'H3', 'H4', 'S1', 'S2', 'S3', 'S4', 'HeaderProtectionKey', 'RandomTrailers'].includes(k);
            const color = shared ? '#79c0ff' : '#d2a8ff';
            return `<span title="${shared ? 'Общий параметр: должен совпадать у сервера и клиентов' : 'Клиентский/локальный параметр'}" style="background:${shared ? 'rgba(88,166,255,.12)' : 'rgba(188,140,255,.12)'}; border:1px solid ${shared ? 'rgba(88,166,255,.35)' : 'rgba(188,140,255,.35)'}; color:${color}; border-radius:6px; padding:4px 8px; font-family:monospace; font-size:12px;">${esc(k)} = ${esc(String(obfCurrentParams[k]))}</span>`;
        }).join('');
    } catch (e) { el.innerText = 'Сетевая ошибка'; }
}

function renderObfPreview(d) {
    const out = document.getElementById('obfPreview');
    if (!out) return;
    const fmt = {
        'architect-conf': 'AmneziaWG .conf из Архитектора',
        'architect-batch': 'Batch из Архитектора',
        'amnezia-json': 'Amnezia JSON (.json)',
        json: 'JSON с параметрами',
        vpn: 'vpn:// ключ',
        conf: 'wg-quick .conf'
    }[d.format] || d.format;
    const a = d.audit || {};
    const m = obfLevelMeta(a.level);

    const current = obfCurrentParams || {};
    const incoming = d.params || {};
    const keys = Array.from(new Set([...Object.keys(current), ...Object.keys(incoming)])).sort();
    const changes = keys.filter(k => String(current[k] ?? '') !== String(incoming[k] ?? ''));
    const added = changes.filter(k => current[k] === undefined);
    const removed = changes.filter(k => incoming[k] === undefined);
    const changed = changes.filter(k => current[k] !== undefined && incoming[k] !== undefined);

    const chips = (arr, cls) => arr.length ? arr.map(k => `<span style="font-family:monospace; font-size:11px; padding:2px 6px; border-radius:4px; background:rgba(255,255,255,.06); border:1px solid var(--border);">${esc(k)}</span>`).join(' ') : '<span style="color:var(--text-muted);">нет</span>';

    out.innerHTML = `
        <div style="display:flex; gap:14px; align-items:center; flex-wrap:wrap; background:rgba(0,0,0,.2); border:1px solid var(--border); border-radius:8px; padding:12px;">
            <div style="font-size:28px; font-weight:bold; color:${m.color};">${esc(a.score)}<span style="font-size:12px; color:var(--text-muted);">/100</span></div>
            <div style="flex:1; min-width:220px;">
                <div style="font-weight:bold; color:${m.color};">${m.emoji} ${m.title}</div>
                <div style="font-size:12px; color:var(--text-muted); margin-top:3px;">Формат: ${esc(fmt)} · версия: <b>AWG ${esc(d.version || a.version || '—')}</b> · параметров: <b>${Object.keys(incoming).length}</b></div>
            </div>
        </div>
        ${(d.warnings && d.warnings.length) ? `<div style="margin-top:10px; display:grid; gap:6px;">${d.warnings.map(w => `<div style="font-size:12px; color:#d29922; background:rgba(210,153,34,.08); border:1px solid rgba(210,153,34,.3); border-radius:6px; padding:8px 10px;">⚠️ ${esc(w)}</div>`).join('')}</div>` : ''}
        <div style="margin-top:12px; display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:12px;">
            <div>
                <div style="font-size:12px; color:var(--text-muted); margin-bottom:5px;">Будет изменено (${changed.length})</div>
                <div style="line-height:1.9;">${chips(changed)}</div>
            </div>
            <div>
                <div style="font-size:12px; color:var(--text-muted); margin-bottom:5px;">Добавлено (${added.length})</div>
                <div style="line-height:1.9;">${chips(added)}</div>
            </div>
            <div>
                <div style="font-size:12px; color:var(--text-muted); margin-bottom:5px;">Будет удалено (${removed.length})</div>
                <div style="line-height:1.9;">${chips(removed)}</div>
            </div>
        </div>
        <div style="margin-top:12px; font-size:12px; color:var(--text-muted);">
            ${(a.findings || []).filter(f => f.level === 'error' || f.level === 'warn').slice(0, 5).map(f => `<div style="margin-top:4px; color:${f.level === 'error' ? '#f85149' : '#d29922'};">${f.level === 'error' ? '⛔' : '⚠️'} ${esc(f.title)}</div>`).join('') || '<span style="color:#3fb950;">✅ Критичных замечаний нет</span>'}
        </div>`;
    const btn = document.getElementById('obfSaveImportBtn');
    if (btn) btn.style.display = 'inline-block';
}

async function analyzeObf(silent) {
    const source = document.getElementById('obfImportText').value;
    const out = document.getElementById('obfPreview');
    if (!source.trim()) {
        if (!silent) alert('Вставьте .conf, JSON или vpn:// из Архитектора');
        return null;
    }
    if (out) out.innerHTML = '<span style="color:var(--text-muted);">Разбор и проверка...</span>';
    try {
        const res = await fetch('/api/obf/analyze', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ source })
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) {
            if (out) out.innerHTML = `<span class="val-tx">${esc(d.error || 'Не удалось разобрать')}</span>`;
            if (!silent) alert(d.error || 'Не удалось разобрать');
            return null;
        }
        obfLastAnalysis = { ...d, source };
        renderObfPreview(d);
        return d;
    } catch (e) {
        if (out) out.innerHTML = '<span class="val-tx">Сетевая ошибка</span>';
        return null;
    }
}

async function applyObf() {
    const source = document.getElementById('obfImportText').value;
    const regenClients = document.getElementById('obfRegenClients').checked;
    const removeMissing = document.getElementById('obfRemoveMissing').checked;
    const out = document.getElementById('obfResult');
    if (!source.trim()) return alert('Вставьте конфиг, JSON или vpn:// из Архитектора');

    let analysis = obfLastAnalysis && obfLastAnalysis.source === source ? obfLastAnalysis : null;
    if (!analysis) analysis = await analyzeObf(true);
    if (!analysis) return;

    const score = analysis.audit ? analysis.audit.score : '—';
    const msg = `Применить параметры обфускации (AWG ${analysis.version}, оценка ${score}/100)?\n\n` +
        'Серверный интерфейс будет перезапущен. При включённой галочке конфиги всех клиентов будут пересобраны — старые копии на устройствах перестанут работать.\n\n' +
        'При ошибке панель автоматически откатит изменения.';
    if (!confirm(msg)) return;

    out.innerHTML = '<span style="color:var(--text-muted);">Применение: резервная копия → запись → перезапуск → перегенерация клиентов...</span>';
    try {
        const res = await fetch('/api/obf/apply', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ source, regenClients, removeMissing })
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) {
            out.innerHTML = `<span class="val-tx">${esc(d.error || 'Ошибка применения')}</span>` +
                (d.rollback ? '<br><span style="color:#d29922;">Изменения откатены, сервер остался на прежнем конфиге.</span>' : '');
            return;
        }
        const audit = d.audit || {};
        const m = obfLevelMeta(audit.level);
        out.innerHTML = `<span class="val-rx">✅ Применено параметров: ${d.applied}.</span>` +
            (d.removed && d.removed.length ? `<br><span style="color:var(--text-muted);">Удалено устаревших: ${d.removed.length} (${d.removed.map(esc).join(', ')})</span>` : '') +
            `<br><span style="color:var(--text-muted);">Резервная копия: <code>${esc(d.backup || '')}</code></span>` +
            (d.regenerated !== null && d.regenerated !== undefined ? `<br><span class="val-sys">Перегенерировано конфигов клиентов: ${esc(d.regenerated)}${d.simulated ? ' (демо-режим)' : ''}</span>` : '') +
            `<br><span style="color:${m.color}; font-weight:bold;">Новая оценка: ${m.emoji} ${esc(audit.score)}/100 — ${m.title}</span>` +
            (d.simulated ? '<br><span style="color:#d29922; font-size:12px;">Демо-режим: systemd и AmneziaWG не затрагивались.</span>' : '');
        obfLastAnalysis = null;
        loadObfCurrent();
        loadObfProfiles();
        if (typeof loadStats === 'function') loadStats();
    } catch (e) { out.innerHTML = '<span class="val-tx">Сетевая ошибка</span>'; }
}

async function pasteObfFromClipboard() {
    const ta = document.getElementById('obfImportText');
    try {
        const text = await navigator.clipboard.readText();
        if (!text || !text.trim()) throw new Error('empty');
        ta.value = text;
        await analyzeObf();
    } catch (e) {
        ta.focus();
        alert('Браузер не дал доступ к буферу. Нажмите в поле и вставьте вручную (Ctrl+V).');
    }
}

async function copyObfCurrentConf() {
    try {
        const res = await fetch('/api/obf/export?format=conf');
        const text = await res.text();
        if (!res.ok) throw new Error(text || 'export failed');
        await navigator.clipboard.writeText(text);
        alert('Текущий .conf скопирован в буфер обмена');
    } catch (e) {
        alert('Не удалось скопировать. Скачайте файл кнопкой «Текущий .conf» ниже.');
    }
}

async function saveObfImportAsProfile() {
    if (!obfLastAnalysis || !obfLastAnalysis.params) return alert('Сначала проверьте импорт');
    const name = prompt('Название профиля (например «Архитектор QUIC 3.1»):');
    if (!name) return;
    try {
        const res = await fetch('/api/obf/profiles', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ name, params: obfLastAnalysis.params })
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) return alert(d.error || 'Ошибка сохранения');
        loadObfProfiles();
        alert('Профиль сохранён');
    } catch (e) { alert('Сетевая ошибка'); }
}

// ===========================================================================
// AdGuard: расширенное управление
// ===========================================================================
function agCreds() {
    return {
        url: document.getElementById('agUrl').value,
        user: document.getElementById('agUser').value,
        pass: document.getElementById('agPass').value
    };
}

async function agCall(action, payload, params) {
    const res = await fetch('/api/adguard/proxy', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ ...agCreds(), action, payload: payload || null, params: params || null })
    });
    return res.json();
}

let agProtectionEnabled = true;

async function loadAdGuardFull() {
    const box = document.getElementById('agFull');
    if (!box) return;
    if (!document.getElementById('agUrl').value) {
        box.innerHTML = '<span style="color:var(--text-muted);">Укажите URL и нажмите «Подключить» в блоке выше.</span>';
        return;
    }
    box.innerHTML = '<span style="color:var(--text-muted);">Загрузка данных AdGuard...</span>';
    try {
        const [st, stats, clients, log, filters] = await Promise.all([
            agCall('status'), agCall('stats'), agCall('clients'), agCall('querylog', null, { limit: 40 }), agCall('filtering')
        ]);
        if (!st.ok) {
            box.innerHTML = `<span class="val-tx">${(st.data && st.data.error) || st.error || 'AdGuard недоступен'}</span>`;
            return;
        }
        const s = st.data || {};
        agProtectionEnabled = !!s.protection_enabled;
        const stt = stats.ok ? (stats.data || {}) : {};
        const percent = stt.num_dns_queries > 0 ? ((stt.num_blocked_filtering / stt.num_dns_queries) * 100).toFixed(1) : '0';
        const cl = (clients.ok && clients.data) ? clients.data : { clients: [], auto_clients: [] };
        const ql = (log.ok && log.data && log.data.data) ? log.data.data : [];
        const fl = (filters.ok && filters.data) ? filters.data : { filters: [], user_rules: [] };

        const clientRows = (cl.clients || []).map(c => `<tr><td><b>${String(c.name || '').replace(/</g,'&lt;')}</b></td><td>${(c.ids || []).join(', ')}</td><td>${c.filtering_enabled ? '<span class="val-rx">фильтр</span>' : '<span class="val-tx">без фильтра</span>'}</td></tr>`).join('');
        const autoRows = (cl.auto_clients || []).slice(0, 10).map(c => `<tr><td>${String(c.name || c.ip || '').replace(/</g,'&lt;')}</td><td>${c.ip || ''}</td><td><span class="sub-text">auto</span></td></tr>`).join('');
        const logRows = ql.map(e => {
            const name = e.question ? (e.question.unicode_name || e.question.name) : '';
            const blocked = /block/i.test(e.reason || '') || e.status === 'Blocked';
            return `<tr><td style="font-family:monospace; font-size:11px;">${(e.time || '').slice(11, 19)}</td><td>${String(name).replace(/</g,'&lt;')}</td><td>${String(e.client || '').replace(/</g,'&lt;')}</td><td>${blocked ? '<span class="val-tx">блок</span>' : '<span class="val-rx">ok</span>'}</td></tr>`;
        }).join('');
        const filterRows = (fl.filters || []).map(f => `<tr><td>${String(f.name || f.url || '').replace(/</g,'&lt;')}</td><td>${f.rules_count || 0}</td><td>${f.enabled ? '<span class="val-rx">вкл</span>' : '<span class="val-tx">выкл</span>'}</td></tr>`).join('');

        box.innerHTML = `
            <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:14px;">
                <div style="background:rgba(0,0,0,.2); border:1px solid var(--border); border-radius:8px; padding:14px;">
                    <div style="font-size:12px; color:var(--text-muted);">Защита DNS</div>
                    <div style="font-size:20px; font-weight:bold; color:${agProtectionEnabled ? '#3fb950' : '#f85149'}; margin:6px 0;">${agProtectionEnabled ? 'Включена' : 'Выключена'}</div>
                    <div style="font-size:12px; color:var(--text-muted);">Версия: ${String(s.version || '—').replace(/</g,'&lt;')}</div>
                    <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">DNS-порт: ${s.dns_port || '—'}</div>
                </div>
                <div style="background:rgba(0,0,0,.2); border:1px solid var(--border); border-radius:8px; padding:14px;">
                    <div style="font-size:12px; color:var(--text-muted);">Запросы / заблокировано</div>
                    <div style="font-size:20px; font-weight:bold; margin:6px 0;">${(stt.num_dns_queries || 0).toLocaleString('ru-RU')} / <span class="val-tx">${(stt.num_blocked_filtering || 0).toLocaleString('ru-RU')}</span></div>
                    <div style="font-size:12px; color:var(--text-muted);">Доля блокировок: ${percent}%</div>
                </div>
                <div style="background:rgba(0,0,0,.2); border:1px solid var(--border); border-radius:8px; padding:14px;">
                    <div style="font-size:12px; color:var(--text-muted);">Фильтры</div>
                    <div style="font-size:20px; font-weight:bold; margin:6px 0;">${(fl.filters || []).length}</div>
                    <div style="font-size:12px; color:var(--text-muted);">Своих правил: ${(fl.user_rules || []).length}</div>
                </div>
            </div>

            <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:14px; margin-top:14px;">
                <div>
                    <h4 style="margin:0 0 8px;">Клиенты AdGuard</h4>
                    <div class="table-wrapper" style="max-height:260px; overflow:auto;">
                        <table style="min-width:100%; font-size:12px;"><thead><tr><th>Имя</th><th>ID / IP</th><th>Фильтр</th></tr></thead>
                        <tbody>${clientRows || autoRows || '<tr><td colspan="3">Нет клиентов</td></tr>'}</tbody></table>
                    </div>
                </div>
                <div>
                    <h4 style="margin:0 0 8px;">Журнал запросов (40)</h4>
                    <div class="table-wrapper" style="max-height:260px; overflow:auto;">
                        <table style="min-width:100%; font-size:12px;"><thead><tr><th>Время</th><th>Домен</th><th>Клиент</th><th></th></tr></thead>
                        <tbody>${logRows || '<tr><td colspan="4">Журнал пуст</td></tr>'}</tbody></table>
                    </div>
                </div>
            </div>

            <div style="margin-top:14px;">
                <h4 style="margin:0 0 8px;">Списки фильтрации</h4>
                <div class="table-wrapper" style="max-height:220px; overflow:auto;">
                    <table style="min-width:100%; font-size:12px;"><thead><tr><th>Название</th><th>Правил</th><th>Статус</th></tr></thead>
                    <tbody>${filterRows || '<tr><td colspan="3">Нет списков</td></tr>'}</tbody></table>
                </div>
            </div>`;
    } catch (e) {
        box.innerHTML = '<span class="val-tx">Ошибка загрузки данных AdGuard</span>';
    }
}

async function agToggleProtection() {
    try {
        const r = await agCall('protection', { enabled: !agProtectionEnabled, duration: 0 });
        if (!r.ok) return alert((r.data && r.data.error) || r.error || 'Не удалось изменить защиту');
        loadAdGuardFull();
    } catch (e) { alert('Сетевая ошибка'); }
}

async function agRefreshFilters() {
    try {
        const r = await agCall('filter_refresh', { whitelist: false });
        if (!r.ok) return alert((r.data && r.data.error) || r.error || 'Не удалось обновить фильтры');
        loadAdGuardFull();
    } catch (e) { alert('Сетевая ошибка'); }
}

// При загрузке страницы проверяем, жива ли сессия: если да — сразу показываем
// панель, иначе — форму входа (иначе после F5 приходилось вводить пароль заново).
// ===========================================================================
// Здоровье каскада
// ===========================================================================
async function loadCascadeHealth() {
    const box = document.getElementById('cascadeHealthBox');
    if (!box) return;
    box.innerHTML = '<span style="color:var(--text-muted);">Проверка...</span>';
    try {
        const d = await (await fetch('/api/cascade/health')).json();
        const labels = {
            config: 'Конфиг awg1', tunnel: 'Туннель awg-quick@awg1', handshake: 'Рукопожатие с EU',
            timer: 'Таймер маршрутов', rule: 'Правило fwmark', table: 'Маршрут таблицы 100', ipset: 'GeoIP ipset'
        };
        const ok = d.ok;
        box.innerHTML = `<div style="font-weight:bold; color:${ok ? '#3fb950' : '#f85149'}; margin-bottom:10px;">${ok ? '✅ Каскад в норме' : '⚠️ Есть проблемы'}</div>` +
            Object.entries(labels).map(([k, title]) => {
                const v = d.checks && d.checks[k];
                return `<div style="display:flex; justify-content:space-between; max-width:440px; padding:3px 0; border-bottom:1px solid rgba(255,255,255,.04);">
                    <span>${title}</span><span class="${v ? 'val-rx' : 'val-tx'}">${v ? 'ок' : 'нет'}</span></div>`;
            }).join('') +
            (d.details && d.details.endpoint ? `<div style="margin-top:8px; color:var(--text-muted); font-size:12px;">Endpoint: <code>${esc(d.details.endpoint)}</code></div>` : '');
    } catch (e) { box.innerHTML = '<span class="val-tx">Ошибка проверки</span>'; }
}

// ===========================================================================
// Профили обфускации
// ===========================================================================
let obfProfilesCache = { builtin: [], custom: [] };

async function loadObfProfiles() {
    const sel = document.getElementById('obfProfileSelect');
    if (!sel) return;
    try {
        const d = await (await fetch('/api/obf/profiles')).json();
        obfProfilesCache = d;
        const picked = sel.value;
        const opts = [];
        (d.builtin || []).forEach(p => {
            const m = obfLevelMeta(p.level);
            opts.push(`<option value="${esc(p.name)}">${m.emoji} ${esc(p.score ?? '—')}/100 · ${esc(p.title)}</option>`);
        });
        (d.custom || []).forEach(p => {
            const m = obfLevelMeta(p.level);
            opts.push(`<option value="${esc(p.name)}">💾 ${m.emoji} ${esc(p.score ?? '—')}/100 · ${esc(p.title)}</option>`);
        });
        sel.innerHTML = opts.join('') || '<option value="">Нет профилей</option>';
        if (picked && Array.from(sel.options).some(o => o.value === picked)) sel.value = picked;
        sel.onchange = renderObfProfileHint;
        renderObfProfileHint();
    } catch (e) { sel.innerHTML = '<option value="">Ошибка загрузки</option>'; }
}

function renderObfProfileHint() {
    const name = document.getElementById('obfProfileSelect').value;
    const hint = document.getElementById('obfProfileHint');
    if (!hint) return;
    const p = [...(obfProfilesCache.builtin || []), ...(obfProfilesCache.custom || [])].find(x => x.name === name);
    if (!p) { hint.innerText = ''; return; }
    const m = obfLevelMeta(p.level);
    hint.innerHTML = `<span style="color:${m.color}; font-weight:bold;">${m.emoji} ${esc(p.score ?? '—')}/100 — ${m.title}</span>` +
        (p.note ? ` · ${esc(p.note)}` : '') +
        (p.level === 'weak' || p.level === 'critical'
            ? '<br><span style="color:#d29922;">⚠️ Этот профиль не рассчитан на современный ТСПУ. Для обхода используйте импорт из Архитектора.</span>'
            : '');
}

async function applyObfProfile() {
    const name = document.getElementById('obfProfileSelect').value;
    if (!name) return;
    const p = [...(obfProfilesCache.builtin || []), ...(obfProfilesCache.custom || [])].find(x => x.name === name);
    const score = p ? ` (оценка ${p.score ?? '—'}/100)` : '';
    if (!confirm(`Применить профиль «${name}»${score}? Серверный конфиг будет перезаписан, клиенты перегенерированы.`)) return;
    const out = document.getElementById('obfProfileResult');
    out.innerHTML = '<span style="color:var(--text-muted);">Применение...</span>';
    try {
        const res = await fetch(`/api/obf/profiles/${encodeURIComponent(name)}/apply`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ regenClients: true, removeMissing: false })
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) {
            out.innerHTML = `<span class="val-tx">${esc(d.error || 'Ошибка')}</span>` +
                (d.rollback ? '<br><span style="color:#d29922;">Изменения откатены.</span>' : '');
            return;
        }
        const m = obfLevelMeta(d.audit && d.audit.level);
        out.innerHTML = `<span class="val-rx">Применено параметров: ${d.applied}.</span>` +
            `<br><span style="color:var(--text-muted);">Резервная копия: ${esc(d.backup || '')}</span>` +
            (d.audit ? `<br><span style="color:${m.color};">Новая оценка: ${m.emoji} ${esc(d.audit.score)}/100</span>` : '');
        loadObfCurrent();
    } catch (e) { out.innerHTML = '<span class="val-tx">Сетевая ошибка</span>'; }
}

async function saveObfProfile() {
    const name = prompt('Название профиля (например «МТС 2026»):');
    if (!name) return;
    try {
        const cur = await (await fetch('/api/obf/current')).json();
        if (!cur.params || !Object.keys(cur.params).length) return alert('В конфиге нет параметров обфускации');
        const res = await fetch('/api/obf/profiles', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, params: cur.params })
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok) { loadObfProfiles(); alert('Профиль сохранён'); }
        else alert(d.error || 'Ошибка сохранения');
    } catch (e) { alert('Сетевая ошибка'); }
}

async function deleteObfProfile() {
    const name = document.getElementById('obfProfileSelect').value;
    const custom = (obfProfilesCache.custom || []).find(x => x.name === name);
    if (!custom) return alert('Встроенный профиль удалить нельзя');
    if (!confirm(`Удалить профиль «${name}»?`)) return;
    const res = await fetch(`/api/obf/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (res.ok) loadObfProfiles(); else alert('Ошибка удаления');
}

// ===========================================================================
// Администрирование: 2FA, пользователи, аудит, fail2ban, бэкапы, Telegram
// ===========================================================================
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function loadAdminPanel() {
    loadTwoFaStatus(); loadUsers(); loadAudit(); loadF2b(); loadBackup(); loadTelegram();
}

// --- 2FA ---
async function loadTwoFaStatus() {
    const el = document.getElementById('twoFaStatus');
    if (!el) return;
    try {
        const d = await (await fetch('/api/2fa/status')).json();
        el.innerHTML = d.enabled
            ? `<span class="val-rx">Включена</span> для пользователя <b>${esc(d.user)}</b>`
            : '<span class="val-sys">Выключена</span> — настоятельно рекомендуется включить.';
    } catch (e) { el.innerText = 'Ошибка проверки'; }
}

async function start2faSetup() {
    try {
        const res = await fetch('/api/2fa/setup', { method: 'POST' });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) return alert(d.error || 'Ошибка');
        document.getElementById('twoFaSetup').style.display = 'block';
        document.getElementById('twoFaSecret').innerText = d.secret;
        document.getElementById('twoFaCode').value = '';
        const img = document.getElementById('twoFaQr');
        if (d.qr) { img.src = d.qr; img.style.display = 'block'; } else img.style.display = 'none';
    } catch (e) { alert('Сетевая ошибка'); }
}

function cancel2faSetup() { document.getElementById('twoFaSetup').style.display = 'none'; }

async function enable2fa() {
    const code = document.getElementById('twoFaCode').value.trim();
    try {
        const res = await fetch('/api/2fa/enable', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) return alert(d.error || 'Ошибка');
        document.getElementById('twoFaSetup').style.display = 'none';
        document.getElementById('twoFaRecoveryList').innerText = (d.recoveryCodes || []).join('\n');
        document.getElementById('twoFaRecovery').style.display = 'block';
        loadTwoFaStatus();
    } catch (e) { alert('Сетевая ошибка'); }
}

async function disable2fa() {
    const password = document.getElementById('twoFaDisablePass').value;
    if (!password) return alert('Введите пароль');
    if (!confirm('Отключить двухфакторную аутентификацию?')) return;
    try {
        const res = await fetch('/api/2fa/disable', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password })
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) return alert(d.error || 'Ошибка');
        document.getElementById('twoFaDisablePass').value = '';
        document.getElementById('twoFaRecovery').style.display = 'none';
        loadTwoFaStatus();
    } catch (e) { alert('Сетевая ошибка'); }
}

// --- Пользователи ---
async function loadUsers() {
    const tbody = document.getElementById('usersTable');
    if (!tbody) return;
    try {
        const d = await (await fetch('/api/users')).json();
        const rows = [`<tr><td><b>admin</b></td><td>администратор</td><td>—</td><td>встроенный</td><td>—</td></tr>`];
        (d.users || []).forEach(u => {
            rows.push(`<tr>
                <td><b>${esc(u.username)}</b></td>
                <td>${u.role === 'admin' ? 'администратор' : 'только просмотр'}</td>
                <td>${u.totpEnabled ? '<span class="val-rx">вкл</span>' : '—'}</td>
                <td>${esc((u.createdAt || '').slice(0, 10))}</td>
                <td><button class="btn-danger" style="padding:4px 8px; font-size:11px;" onclick="deleteUser('${esc(u.username)}')">Удалить</button></td>
            </tr>`);
        });
        tbody.innerHTML = rows.join('');
    } catch (e) { tbody.innerHTML = '<tr><td colspan="5">Ошибка загрузки</td></tr>'; }
}

async function createUser() {
    const username = document.getElementById('newUserName').value.trim();
    const password = document.getElementById('newUserPass').value;
    const role = document.getElementById('newUserRole').value;
    if (!username || !password) return alert('Укажите логин и пароль');
    try {
        const res = await fetch('/api/users', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, role })
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) return alert(d.error || 'Ошибка');
        document.getElementById('newUserName').value = '';
        document.getElementById('newUserPass').value = '';
        loadUsers();
    } catch (e) { alert('Сетевая ошибка'); }
}

async function deleteUser(name) {
    if (!confirm(`Удалить пользователя «${name}»?`)) return;
    const res = await fetch(`/api/users/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const d = await res.json().catch(() => ({}));
    if (res.ok) loadUsers(); else alert(d.error || 'Ошибка удаления');
}

// --- Аудит ---
async function loadAudit() {
    const tbody = document.getElementById('auditTable');
    if (!tbody) return;
    try {
        const d = await (await fetch('/api/audit?limit=300')).json();
        if (!d.entries || !d.entries.length) { tbody.innerHTML = '<tr><td colspan="4">Записей пока нет</td></tr>'; return; }
        tbody.innerHTML = d.entries.map(e => `<tr>
            <td style="font-family:monospace; font-size:12px;">${esc(e.time)}</td>
            <td style="font-family:monospace; font-size:12px;">${esc(e.ip)}</td>
            <td>${esc(e.user)}</td>
            <td style="font-size:13px;">${esc(e.action)}</td>
        </tr>`).join('');
    } catch (e) { tbody.innerHTML = '<tr><td colspan="4">Ошибка загрузки</td></tr>'; }
}

// --- Fail2ban ---
async function loadF2b() {
    const box = document.getElementById('f2bBox');
    if (!box) return;
    try {
        const d = await (await fetch('/api/fail2ban/status')).json();
        if (!d.installed) {
            box.innerHTML = '<span class="val-sys">fail2ban не установлен.</span> Установите: <code>apt install fail2ban</code>, затем перезапустите установщик панели.';
            return;
        }
        box.innerHTML = `Jail <b>servpanel</b>: ${d.jail ? '<span class="val-rx">активен</span>' : '<span class="val-tx">не найден</span>'} ·
            неудачных попыток сейчас: <b>${d.currentlyFailed || 0}</b> · всего: <b>${d.totalFailed || 0}</b><br>
            Забанено: ${(d.banned && d.banned.length) ? d.banned.map(ip => `<code>${esc(ip)}</code>`).join(', ') : '—'}<br>
            <span class="sub-text">Лог: ${esc(d.log || '')}</span>`;
    } catch (e) { box.innerText = 'Ошибка проверки'; }
}

async function loadF2bMini() {
    const el = document.getElementById('f2bMini');
    if (!el) return;
    try {
        const d = await (await fetch('/api/fail2ban/status')).json();
        if (!d.installed) { el.innerHTML = '<span class="val-sys">fail2ban не установлен</span>'; return; }
        el.innerHTML = `Забанено IP: <b>${(d.banned || []).length}</b> · неудачных попыток: <b>${d.currentlyFailed || 0}</b>`;
    } catch (e) { el.innerText = 'Нет доступа'; }
}

async function unbanIp() {
    const ip = document.getElementById('f2bIp').value.trim();
    if (!ip) return;
    try {
        const res = await fetch('/api/fail2ban/unban', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip })
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) return alert(d.error || 'Ошибка');
        document.getElementById('f2bIp').value = '';
        loadF2b(); loadF2bMini();
    } catch (e) { alert('Сетевая ошибка'); }
}

// --- Бэкапы ---
function renderBackupList(archives) {
    const box = document.getElementById('backupList');
    if (!box) return;
    if (!archives || !archives.length) { box.innerHTML = '<span style="color:var(--text-muted);">Архивов пока нет</span>'; return; }
    box.innerHTML = '<div style="margin-bottom:6px; color:var(--text-muted);">Архивы в ' + '<code>/root/backups</code>:</div>' +
        archives.map(a => `<div style="display:flex; justify-content:space-between; gap:10px; padding:4px 0; border-bottom:1px solid rgba(255,255,255,.04);">
            <a href="/api/backup/archive/${encodeURIComponent(a.name)}" style="color:#58a6ff; text-decoration:none; font-family:monospace; font-size:12px;">${esc(a.name)}</a>
            <span style="color:var(--text-muted); font-size:12px; white-space:nowrap;">${formatBytes(a.size)}</span>
        </div>`).join('');
}

async function loadBackup() {
    const box = document.getElementById('backupBox');
    if (!box) return;
    try {
        const d = await (await fetch('/api/backup/auto')).json();
        const c = d.config || {};
        document.getElementById('bkEnabled').checked = !!c.enabled;
        document.getElementById('bkSchedule').value = c.schedule || 'daily';
        document.getElementById('bkTime').value = c.time || '04:30';
        document.getElementById('bkKeep').value = c.keep || 7;
        document.getElementById('bkEncrypt').checked = c.encrypt !== false;
        box.innerHTML = `${c.enabled ? '<span class="val-rx">Автобэкап включён</span>' : '<span class="val-sys">Автобэкап выключен</span>'} ·
            таймер: ${d.timerActive ? '<span class="val-rx">активен</span>' : 'неактивен'} ·
            пароль шифрования: ${d.passwordSet ? '<span class="val-rx">задан</span>' : '<span class="val-sys">будет создан</span>'}`;
        renderBackupList(d.archives);
    } catch (e) { box.innerText = 'Ошибка загрузки'; }
}

async function saveBackupConfig() {
    const body = {
        enabled: document.getElementById('bkEnabled').checked,
        schedule: document.getElementById('bkSchedule').value,
        time: document.getElementById('bkTime').value,
        keep: parseInt(document.getElementById('bkKeep').value, 10) || 7,
        encrypt: document.getElementById('bkEncrypt').checked
    };
    try {
        const res = await fetch('/api/backup/auto', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) return alert(d.error || 'Ошибка');
        loadBackup();
        alert('Настройки сохранены');
    } catch (e) { alert('Сетевая ошибка'); }
}

async function runBackupNow() {
    if (!confirm('Запустить резервное копирование сейчас?')) return;
    const box = document.getElementById('backupBox');
    box.innerHTML = 'Создание архива...';
    try {
        const res = await fetch('/api/backup/run', { method: 'POST' });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) { box.innerHTML = `<span class="val-tx">${esc(d.error || 'Ошибка')}</span>`; return; }
        renderBackupList(d.archives);
        loadBackup();
    } catch (e) { box.innerHTML = '<span class="val-tx">Сетевая ошибка</span>'; }
}

async function showBackupPassword() {
    try {
        const d = await (await fetch('/api/backup/password')).json();
        if (!d.password) return alert('Пароль не задан');
        prompt('Пароль для расшифровки архивов (AES-256):', d.password);
    } catch (e) { alert('Сетевая ошибка'); }
}

// --- Telegram ---
async function loadTelegram() {
    const el = document.getElementById('tgStatus');
    if (!el) return;
    try {
        const d = await (await fetch('/api/notify/status')).json();
        document.getElementById('tgEnabled').checked = !!d.enabled;
        document.getElementById('tgChat').value = d.chatId || '';
        el.innerHTML = d.enabled
            ? '<span class="val-rx">Уведомления включены</span>' + (d.lastAlertAt ? ` · последний алерт: ${new Date(d.lastAlertAt).toLocaleString()}` : '')
            : '<span class="val-sys">Выключены</span>' + (d.hasToken ? ' · токен сохранён' : '');
    } catch (e) { el.innerText = 'Ошибка загрузки'; }
}

async function saveTelegram() {
    const body = {
        enabled: document.getElementById('tgEnabled').checked,
        chatId: document.getElementById('tgChat').value.trim()
    };
    const token = document.getElementById('tgToken').value.trim();
    if (token) body.token = token;
    try {
        const res = await fetch('/api/notify/telegram', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) return alert(d.error || 'Ошибка');
        document.getElementById('tgToken').value = '';
        loadTelegram();
        alert('Сохранено');
    } catch (e) { alert('Сетевая ошибка'); }
}

async function testTelegram() {
    const el = document.getElementById('tgStatus');
    el.innerHTML = 'Отправка...';
    try {
        const res = await fetch('/api/notify/test', { method: 'POST' });
        const d = await res.json().catch(() => ({}));
        el.innerHTML = res.ok ? '<span class="val-rx">Тестовое сообщение отправлено</span>'
            : `<span class="val-tx">${esc(d.error || 'Ошибка')}${d.detail ? ': ' + esc(d.detail) : ''}</span>`;
    } catch (e) { el.innerHTML = '<span class="val-tx">Сетевая ошибка</span>'; }
}

// ===========================================================================
// i18n: русский / английский. Переводит статический интерфейс и подсказки.
// ===========================================================================
let currentLang = localStorage.getItem('panelLang') || 'ru';
const i18nOriginals = new Map();
const i18nAttrs = new Map();
const I18N_EN = {
    'Дашборд': 'Dashboard',
    'Клиенты VPN': 'VPN clients',
    'Сеть и Фаервол': 'Network & firewall',
    'Службы & DNS': 'Services & DNS',
    'Защита и Cron': 'Security & cron',
    'Диагностика': 'Diagnostics',
    'Установка Модулей': 'Module installation',
    'Каскад': 'Cascade',
    'Обфускация': 'Obfuscation',
    'Администрирование': 'Administration',
    'Общий Трафик': 'Total traffic',
    'Общая Скорость': 'Total speed',
    'Сервер (CPU / RAM)': 'Server (CPU / RAM)',
    'Диск (Занято / Свободно)': 'Disk (used / free)',
    'Мониторинг трафика (История 1ч)': 'Traffic monitor (1h history)',
    'Транзитный туннель (RU ➔ EU)': 'Transit tunnel (RU ➔ EU)',
    'Создание клиентов (Одиночно / Массово)': 'Create clients (single / bulk)',
    'Массовое переименование клиентов': 'Bulk rename clients',
    'АКТИВНЫЕ КЛИЕНТЫ': 'ACTIVE CLIENTS',
    'Редактор конфигурации AmneziaWG': 'AmneziaWG configuration editor',
    'Управление портами (UFW)': 'Port management (UFW)',
    'Прослушиваемые порты (SS)': 'Listening ports (SS)',
    'Данные для подключения устройств к AdGuard DNS': 'AdGuard DNS connection details',
    'Перехват DNS (Iptables)': 'DNS interception (iptables)',
    'Статистика AdGuard Home API': 'AdGuard Home API statistics',
    'Системные службы': 'System services',
    'AdGuard Home — управление': 'AdGuard Home — management',
    'Блокировка RU-трафика (GeoIP)': 'RU traffic blocking (GeoIP)',
    'Маршрутизация Каскада (RU ➔ EU)': 'Cascade routing (RU ➔ EU)',
    'Fail2Ban / Брутфорс': 'Fail2Ban / brute force',
    'AmneziaWG (С перезагрузками)': 'AmneziaWG (with reboots)',
    'MTProto / WEB Proxy (MEKO)': 'MTProto / WEB proxy (MEKO)',
    'AdGuard Home': 'AdGuard Home',
    'Терминал установки': 'Installation terminal',
    'Состояние каскада RU → EU': 'Cascade state RU → EU',
    'Проверка здоровья каскада': 'Cascade health check',
    'Шаг 1. Конфиг EU-сервера': 'Step 1. EU server config',
    'Шаг 2. Клиентские интерфейсы и сети РФ': 'Step 2. Client interfaces and RU networks',
    'awg1.conf на этом сервере': 'awg1.conf on this server',
    'Профили обфускации': 'Obfuscation profiles',
    'Параметры обфускации сервера': 'Server obfuscation parameters',
    'Импорт из Архитектора': 'Import from Architect',
    'Устойчивость к ТСПУ / DPI': 'TSPU / DPI resistance',
    'Интеграция с Архитектором': 'Architect integration',
    'Применение': 'Apply',
    'Проверить': 'Check',
    'Вставить из буфера': 'Paste from clipboard',
    'Сохранить как профиль': 'Save as profile',
    'Применить и перегенерировать': 'Apply and regenerate',
    'Текущий .conf': 'Current .conf',
    'Скопировать текущий .conf': 'Copy current .conf',
    'Открыть Архитектор': 'Open Architect',
    'Почему стандартная обфускация распознаётся и что меняет Архитектор': 'Why standard obfuscation is detected and what Architect changes',
    'Устойчиво': 'Strong',
    'Средне': 'Medium',
    'Слабо': 'Weak',
    'Критично': 'Critical',
    'Двухфакторная аутентификация (TOTP)': 'Two-factor authentication (TOTP)',
    'Пользователи и роли': 'Users and roles',
    'Журнал действий (аудит)': 'Audit log',
    'Автоматические резервные копии': 'Automatic backups',
    'Telegram-уведомления': 'Telegram notifications',
    'Войти': 'Sign in',
    'Выход': 'Sign out',
    'Обновить с GitHub': 'Update from GitHub',
    'Скачать бэкап': 'Download backup',
    'Загрузить архив': 'Upload archive',
    'Сменить пароль': 'Change password',
    'Сгенерировать конфигурации': 'Generate configs',
    'Переименовать': 'Rename',
    'Открыть порт': 'Open port',
    'Применить': 'Apply',
    'Удалить': 'Delete',
    'Сохранить': 'Save',
    'Обновить': 'Refresh',
    'Настроить 2FA': 'Set up 2FA',
    'Включить 2FA': 'Enable 2FA',
    'Отключить 2FA': 'Disable 2FA',
    'Добавить': 'Add',
    'Проверить сейчас': 'Check now',
    'Запустить сейчас': 'Run now',
    'Скачать зашифрованный': 'Download encrypted',
    'Тест': 'Test',
    'Скачать Conf': 'Download config',
    'Ключ подключения': 'Connection key',
    'Изменить имя': 'Rename',
    'Лимит': 'Limit',
    'Управление': 'Actions',
    'Активность': 'Activity',
    'Трафик (Rx/Tx)': 'Traffic (Rx/Tx)',
    'Скорость': 'Speed',
    'Клиент / IP': 'Client / IP',
    'Статус': 'Status',
    'Назначение': 'Destination',
    'Удал.': 'Del.',
    'Всего': 'Total',
    'В сети': 'Online',
    'Пароль доступа': 'Password',
    'Пользователь (admin)': 'Username (admin)',
    'Код 2FA (6 цифр)': '2FA code (6 digits)',
    'Неверный пароль': 'Wrong password',
    'Загрузка...': 'Loading...',
    'Загрузка': 'Loading',
    'Ошибка': 'Error',
    'Ошибка загрузки': 'Loading error'
};

function applyLanguage(lang) {
    currentLang = lang === 'en' ? 'en' : 'ru';
    try { localStorage.setItem('panelLang', currentLang); } catch (e) { /* ignore */ }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
            const p = n.parentNode && n.parentNode.nodeName;
            if (['SCRIPT', 'STYLE', 'TEXTAREA', 'PRE', 'CODE'].includes(p)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    let node;
    while ((node = walker.nextNode())) {
        if (!i18nOriginals.has(node)) i18nOriginals.set(node, node.nodeValue);
        const original = i18nOriginals.get(node);
        if (!original || !original.trim()) continue;
        if (currentLang === 'en') {
            const tr = I18N_EN[original.trim()];
            if (tr) node.nodeValue = original.replace(original.trim(), tr);
        } else {
            node.nodeValue = original;
        }
    }
    document.querySelectorAll('[placeholder],[title]').forEach(el => {
        if (!i18nAttrs.has(el)) i18nAttrs.set(el, { placeholder: el.getAttribute('placeholder'), title: el.getAttribute('title') });
        const o = i18nAttrs.get(el);
        if (currentLang === 'en') {
            if (o.placeholder && I18N_EN[o.placeholder]) el.setAttribute('placeholder', I18N_EN[o.placeholder]);
            if (o.title && I18N_EN[o.title]) el.setAttribute('title', I18N_EN[o.title]);
        } else {
            if (o.placeholder) el.setAttribute('placeholder', o.placeholder);
            if (o.title) el.setAttribute('title', o.title);
        }
    });
    document.documentElement.lang = currentLang;
    const lb = document.getElementById('langBtn');
    if (lb) lb.innerText = currentLang === 'en' ? '🌐 RU' : '🌐 EN';
    const ll = document.getElementById('loginLangBtn');
    if (ll) ll.innerText = currentLang === 'en' ? '🌐 Русский' : '🌐 English';
    applyRoleUI();
}

function toggleLang() { applyLanguage(currentLang === 'en' ? 'ru' : 'en'); }

// ===========================================================================
// Servpanel 2.3 — автоматизация, мастера и новый дашборд
// Этот блок дополняет старый app.js: все прежние функции и API сохранены.
// ===========================================================================

const panelState = {
    loaded: false,
    server: { ip: '—', domain: '', country: '—' },
    interfaces: [],
    clients: [],
    activeClients: 0,
    sys: null,
    cascade: null,
    services: [],
    obf: null,
    security: null,
    backup: null
};

function toast(title, type = 'info', message = '') {
    const host = document.getElementById('toastHost');
    if (!host) return;
    const icons = { success: '✓', error: '!', info: 'i' };
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML = `<span class="toast-ico">${icons[type] || 'i'}</span>` +
        `<div><strong>${esc(title)}</strong>${message ? `<small>${esc(message)}</small>` : ''}</div>`;
    host.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(6px)';
        el.style.transition = 'opacity .2s, transform .2s';
        setTimeout(() => el.remove(), 220);
    }, 5200);
}

async function apiJson(url, options = {}) {
    const res = await fetch(url, options);
    let data = {};
    try { data = await res.json(); } catch (e) { /* not json */ }
    if (!res.ok) {
        const err = new Error((data && data.error) || ('HTTP ' + res.status));
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
}

function safeJson(url, options = {}) {
    return apiJson(url, options).catch(() => null);
}

/* --------------------------------------------------------------------------
   Expert mode: скрывает ручные поля, пока они действительно не нужны.
   -------------------------------------------------------------------------- */
function initExpertMode() {
    let on = false;
    try { on = localStorage.getItem('panelExpert') === '1'; } catch (e) { /* ignore */ }
    document.body.classList.toggle('expert', on);
    const btn = document.getElementById('expertToggle');
    if (btn) btn.classList.toggle('active', on);
}

function setExpert(on) {
    document.body.classList.toggle('expert', !!on);
    try { localStorage.setItem('panelExpert', on ? '1' : '0'); } catch (e) { /* ignore */ }
    const btn = document.getElementById('expertToggle');
    if (btn) btn.classList.toggle('active', !!on);
}

function toggleExpert() {
    const on = !document.body.classList.contains('expert');
    setExpert(on);
    toast(on ? 'Экспертный режим включён' : 'Экспертный режим выключен', 'info',
        on ? 'Показаны ручные поля и редакторы.' : 'Оставлены только безопасные автоматические действия.');
}

/* --------------------------------------------------------------------------
   Дашборд: состояние, health-карточки и рекомендации
   -------------------------------------------------------------------------- */
async function loadDashboardState() {
    const screen = document.getElementById('dashboardScreen');
    if (!screen || screen.style.display === 'none') return;

    const serverPromise = (!panelState.server.ip || panelState.server.ip === '—')
        ? safeJson('/api/server-info') : Promise.resolve(panelState.server);

    const [interfaces, server, sys, cascade, services, obf, security, backup] = await Promise.all([
        safeJson('/api/interfaces'),
        serverPromise,
        safeJson('/api/sysinfo'),
        safeJson('/api/cascade/status'),
        safeJson('/api/services'),
        safeJson('/api/obf/current'),
        safeJson('/api/security/status'),
        safeJson('/api/backup/auto')
    ]);

    if (Array.isArray(interfaces)) panelState.interfaces = interfaces;
    if (server) panelState.server = server;
    if (sys) panelState.sys = sys;
    if (cascade) panelState.cascade = cascade;
    if (Array.isArray(services)) panelState.services = services;
    if (obf) panelState.obf = obf;
    if (security) panelState.security = security;
    if (backup) panelState.backup = backup;
    panelState.loaded = true;
    renderDashboardState();
}

function hasVpnInterface() {
    return (panelState.interfaces || []).some(i => /^(awg|amn|wg)/i.test(String(i)));
}

function vpnInterfaces() {
    return (panelState.interfaces || []).filter(i => /^(awg|amn|wg)/i.test(String(i)));
}

function adguardService() {
    return (panelState.services || []).find(s => /adguard/i.test(String(s.name || '')));
}

function obfScore() {
    return panelState.obf && panelState.obf.audit && Number.isFinite(Number(panelState.obf.audit.score))
        ? Number(panelState.obf.audit.score) : null;
}

function obfVersion() {
    return (panelState.obf && panelState.obf.version) || '—';
}

function obfLevelLabel(score) {
    if (score === null) return 'нет данных';
    if (score >= 85) return 'сильная';
    if (score >= 60) return 'средняя';
    return 'слабая';
}

function renderHealthCard(id, data) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = 'health-card ' + (data.status || '');
    el.innerHTML = `
        <div class="hc-top"><span class="hc-ico">${data.icon || '•'}</span><span class="hc-label">${esc(data.label || '')}</span></div>
        <div class="hc-value">${data.value || '—'}</div>
        <div class="hc-meta">${data.meta || ''}</div>
        ${data.action ? `<button class="hc-action" onclick="${data.action}">${esc(data.actionLabel || 'Открыть')} →</button>` : ''}`;
}

function renderDashboardState() {
    const vpn = hasVpnInterface();
    const ifaces = vpnInterfaces();
    const score = obfScore();
    const cascadeConfigured = !!(panelState.cascade && panelState.cascade.configured);
    const cascadeActive = !!(panelState.cascade && panelState.cascade.tunnelActive);
    const ag = adguardService();
    const agRunning = ag && ag.status === 'running';
    const security = panelState.security || {};
    const backup = panelState.backup;
    const backupConfig = backup && backup.config ? backup.config : null;
    const archives = backup && Array.isArray(backup.archives) ? backup.archives : [];
    const sys = panelState.sys || {};
    const server = panelState.server || {};
    const clients = panelState.clients || [];
    const online = panelState.activeClients || 0;

    // Hero
    const heroTitle = document.getElementById('heroTitle');
    const heroSub = document.getElementById('heroSub');
    const heroDot = document.getElementById('heroDot');
    const heroEyebrow = document.getElementById('heroEyebrow');
    if (heroTitle) {
        if (!vpn) heroTitle.innerText = 'VPN ещё не настроен';
        else if (cascadeConfigured && !cascadeActive) heroTitle.innerText = 'Каскад требует внимания';
        else if (score !== null && score < 60) heroTitle.innerText = 'VPN работает, но защита слабая';
        else heroTitle.innerText = 'Всё работает';
    }
    if (heroSub) {
        if (!vpn) heroSub.innerText = 'Панель проведёт через установку AmneziaWG и создаст первого клиента.';
        else if (cascadeConfigured && !cascadeActive) heroSub.innerText = 'Туннель RU → EU настроен, но нет свежего рукопожатия. Проверьте каскад.';
        else if (score !== null && score < 60) heroSub.innerText = 'Стандартные параметры обфускации легко распознаются ТСПУ. Включите готовый профиль.';
        else heroSub.innerText = `VPN поднят, клиентов: ${clients.length}, онлайн: ${online}. Всё важное — на этой странице.`;
    }
    if (heroDot) {
        heroDot.className = 'status-dot ' + (!vpn ? 'bad' : (cascadeConfigured && !cascadeActive ? 'warn' : (score !== null && score < 60 ? 'warn' : 'good')));
    }
    if (heroEyebrow) heroEyebrow.innerText = vpn ? 'СОСТОЯНИЕ СЕРВЕРА' : 'ПЕРВЫЙ ЗАПУСК';

    const heroIp = document.getElementById('heroIp');
    if (heroIp) heroIp.innerText = 'IP: ' + (server.ip || '—');
    const heroCountry = document.getElementById('heroCountry');
    if (heroCountry) heroCountry.innerText = 'Страна: ' + (server.country || '—');
    const heroUptime = document.getElementById('heroUptime');
    if (heroUptime) heroUptime.innerText = 'Uptime: ' + (sys.uptime || '—');
    const heroClients = document.getElementById('heroClients');
    if (heroClients) heroClients.innerText = 'Клиентов: ' + clients.length;
    const heroOnline = document.getElementById('heroOnline');
    if (heroOnline) heroOnline.innerText = online;
    const heroTotal = document.getElementById('heroTotal');
    if (heroTotal) heroTotal.innerText = clients.length;

    const ring = document.getElementById('heroObfRing');
    if (ring) ring.style.setProperty('--score', score === null ? 0 : score);
    const heroObfScore = document.getElementById('heroObfScore');
    if (heroObfScore) heroObfScore.innerText = score === null ? '—' : score;
    const heroObfLabel = document.getElementById('heroObfLabel');
    if (heroObfLabel) heroObfLabel.innerText = score === null ? 'нет данных' : `${obfLevelLabel(score)} · AWG ${obfVersion()}`;

    const navObfDot = document.getElementById('navObfDot');
    if (navObfDot) {
        navObfDot.className = 'nav-dot ' + (score === null ? '' : score >= 85 ? 'good' : score >= 60 ? 'warn' : 'bad');
    }

    // Health cards
    renderHealthCard('healthVpn', {
        status: vpn ? 'good' : 'bad', icon: '◍', label: 'VPN',
        value: vpn ? `${ifaces.length} интерфейс${ifaces.length === 1 ? '' : 'а'}` : 'Не установлен',
        meta: vpn ? `Клиентов: ${clients.length} · онлайн: ${online}` : 'AmneziaWG ещё не установлен',
        action: vpn ? 'openWizard(\'client\')' : 'openWizard(\'install\')',
        actionLabel: vpn ? 'Добавить клиента' : 'Установить'
    });
    renderHealthCard('healthCascade', {
        status: cascadeActive ? 'good' : cascadeConfigured ? 'warn' : 'bad', icon: '⇄', label: 'Каскад',
        value: cascadeActive ? 'Активен' : cascadeConfigured ? 'Нет связи' : 'Не настроен',
        meta: cascadeConfigured ? `EU: ${esc((panelState.cascade && panelState.cascade.endpoint) || '—')}` : 'Вход RU → выход EU',
        action: 'openWizard(\'cascade\')', actionLabel: cascadeConfigured ? 'Проверить' : 'Настроить'
    });
    renderHealthCard('healthAdguard', {
        status: agRunning ? 'good' : ag ? 'warn' : 'bad', icon: '◎', label: 'AdGuard',
        value: agRunning ? 'Работает' : ag ? 'Остановлен' : 'Не найден',
        meta: ag ? `Служба: ${esc(ag.name)}` : 'DNS-фильтр рекламы и трекеров',
        action: 'openWizard(\'adguard\')', actionLabel: agRunning ? 'Управлять' : 'Подключить'
    });
    renderHealthCard('healthObf', {
        status: score === null ? 'warn' : score >= 85 ? 'good' : score >= 60 ? 'warn' : 'bad', icon: '✦', label: 'Обфускация',
        value: score === null ? 'Нет данных' : `${score}/100`,
        meta: score === null ? 'Не удалось прочитать конфиг' : `${obfLevelLabel(score)} · AWG ${obfVersion()}`,
        action: 'openWizard(\'obf\')', actionLabel: score !== null && score >= 85 ? 'Проверить' : 'Усилить'
    });
    renderHealthCard('healthBackup', {
        status: backupConfig ? (backupConfig.enabled && archives.length ? 'good' : backupConfig.enabled ? 'warn' : 'bad') : 'warn',
        icon: '⤓', label: 'Бэкапы',
        value: backupConfig ? (backupConfig.enabled ? 'Авто включён' : 'Выключен') : 'Нет данных',
        meta: backupConfig ? `${archives.length} архив(ов) · ${backupConfig.encrypt ? 'AES-256' : 'без шифрования'}` : 'Резервные копии не настроены',
        action: 'openWizard(\'backup\')', actionLabel: 'Настроить'
    });
    renderHealthCard('healthSecurity', {
        status: security.defaultPassword ? 'bad' : security.totpEnabled ? 'good' : 'warn', icon: '◈', label: 'Безопасность',
        value: security.defaultPassword ? 'Пароль по умолчанию' : security.totpEnabled ? 'Защищено' : 'Без 2FA',
        meta: `2FA: ${security.totpEnabled ? 'вкл' : 'выкл'} · HTTPS: ${security.https ? 'да' : 'нет'}`,
        action: 'openAdminTab()', actionLabel: 'Настроить'
    });

    // Recommendations
    const recs = [];
    const addRec = (type, icon, title, desc, action, btn) => recs.push({ type, icon, title, desc, action, btn });
    if (!vpn) addRec('bad', '↓', 'Установить AmneziaWG', 'Без VPN остальные функции недоступны. Мастер подберёт версию и порт.', "openWizard('install')", 'Установить');
    if (vpn && clients.length === 0) addRec('warn', '＋', 'Создать первого клиента', 'После создания панель сразу покажет QR и ссылку vpn://.', "openWizard('client')", 'Создать');
    if (score !== null && score < 85) addRec(score < 60 ? 'bad' : 'warn', '✦', 'Усилить обфускацию', 'Готовый профиль с уникальными H1–H4 и HPK снижает распознаваемость.', "openWizard('obf')", 'Усилить');
    if (vpn && !cascadeConfigured) addRec('info', '⇄', 'Настроить каскад', 'Вход в РФ и выход в EU: панель проведёт по шагам.', "openWizard('cascade')", 'Настроить');
    if (vpn && cascadeConfigured && !cascadeActive) addRec('warn', '⇄', 'Каскад без связи', 'Проверьте рукопожатие с EU и маршруты.', "openWizard('cascade')", 'Проверить');
    if (!ag) addRec('info', '◎', 'Подключить AdGuard', 'Автопоиск адреса API и один клик для включения защиты.', "openWizard('adguard')", 'Подключить');
    if (security.defaultPassword) addRec('bad', '⚿', 'Сменить пароль по умолчанию', 'Панель доступна с паролем admin123 — это критично.', 'changePassword()', 'Сменить');
    if (!security.totpEnabled) addRec('warn', '◈', 'Включить 2FA', 'Дополнительная защита входа в панель.', 'openAdminTab()', 'Включить');
    if (backupConfig && !backupConfig.enabled) addRec('warn', '⤓', 'Включить автобэкап', 'Ежедневные зашифрованные копии конфигов и состояния.', "openWizard('backup')", 'Включить');
    if (!security.https) addRec('info', '⌁', 'Настроить HTTPS', 'Панель работает без TLS — трафик входа можно перехватить.', 'openAdminTab()', 'Открыть');
    const recBox = document.getElementById('recommendations');
    if (recBox) {
        recBox.innerHTML = recs.length
            ? recs.slice(0, 6).map(r => `
                <div class="rec-item ${r.type}">
                    <span class="rec-ico">${r.icon}</span>
                    <div class="rec-copy"><strong>${esc(r.title)}</strong><small>${esc(r.desc)}</small></div>
                    <button class="rec-btn" onclick="${r.action}">${esc(r.btn)}</button>
                </div>`).join('')
            : `<div class="rec-item"><span class="rec-ico">✓</span><div class="rec-copy"><strong>Всё настроено</strong><small>Критичных рекомендаций нет. Можно создавать клиентов и пользоваться VPN.</small></div></div>`;
    }
    const recCount = document.getElementById('recCount');
    if (recCount) recCount.innerText = recs.length;

    renderQuickClients();
    prefillSmartDefaults();
}

function renderQuickClients() {
    const box = document.getElementById('quickClients');
    if (!box) return;
    const clients = (panelState.clients || []).slice(0, 6);
    if (!clients.length) {
        box.innerHTML = `<div class="empty-state">Клиентов пока нет. <button class="link-btn" onclick="openWizard('client')">Создать первого →</button></div>`;
        return;
    }
    box.innerHTML = clients.map(c => {
        const status = c.status_code === 'active' ? 'active' : c.status_code === 'recent' ? 'recent' : '';
        return `<div class="quick-client">
            <span class="qc-avatar">${esc(String(c.name || '?').charAt(0).toUpperCase())}</span>
            <span class="qc-copy"><strong>${esc(c.name)}</strong><small>${esc(c.ip || '')}</small></span>
            <span class="qc-status ${status}" title="${esc(c.status || '')}"></span>
            <button onclick="showClientKey('${esc(c.name)}')">Ключ</button>
        </div>`;
    }).join('');
}

function updateQuickClients(clients, activeCount) {
    if (!Array.isArray(clients)) return;
    panelState.clients = clients;
    panelState.activeClients = Number(activeCount) || 0;
    const badge = document.getElementById('navClientsBadge');
    if (badge) badge.innerText = clients.length;
    const heroOnline = document.getElementById('heroOnline');
    if (heroOnline) heroOnline.innerText = panelState.activeClients;
    const heroTotal = document.getElementById('heroTotal');
    if (heroTotal) heroTotal.innerText = clients.length;
    const heroClients = document.getElementById('heroClients');
    if (heroClients) heroClients.innerText = 'Клиентов: ' + clients.length;
    renderQuickClients();
    if (panelState.loaded) {
        const changed = window._lastClientCount !== clients.length || window._lastActiveCount !== panelState.activeClients;
        window._lastClientCount = clients.length;
        window._lastActiveCount = panelState.activeClients;
        if (changed) renderDashboardState();
    }
}

function prefillSmartDefaults() {
    const server = panelState.server || {};
    const domain = document.getElementById('awgInstallDomain');
    if (domain && !domain.value && server.domain) domain.value = server.domain;
    const port = document.getElementById('awgInstallPort');
    if (port && !port.value) port.value = '443';
}

/* --------------------------------------------------------------------------
   Навигационные помощники
   -------------------------------------------------------------------------- */
function openAdminTab() { switchTab('tab-admin', document.getElementById('navAdmin')); }
function openClientsTab() { switchTab('tab-clients', document.getElementById('navClients')); }
function openServicesTab() { switchTab('tab-services', document.getElementById('navServices')); }
function openCascadeTab() { switchTab('tab-cascade', document.getElementById('navCascade')); }
function openObfTab() { switchTab('tab-obf', document.getElementById('navObf')); }
function openInstallTab() { switchTab('tab-install', document.getElementById('navInstall')); }

function openClientsRename() {
    openClientsTab();
    setExpert(true);
    setTimeout(() => {
        const el = document.getElementById('renameSearch');
        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus(); }
    }, 150);
    toast('Открыт ручной режим', 'info', 'Переименование не меняет ключи и IP клиентов.');
}

async function runDiagPing() {
    const host = (document.getElementById('diagPingHost') || {}).value || '';
    const out = document.getElementById('diagPingOut');
    if (out) { out.style.display = 'block'; out.textContent = 'Пингую ' + host + '…'; }
    try {
        const d = await apiJson('/api/diag/ping', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host })
        });
        if (out) out.textContent = d.output || (d.ok ? 'OK' : 'Нет ответа');
        toast(d.ok ? 'Связь есть' : 'Нет ответа', d.ok ? 'success' : 'error', host);
    } catch (e) {
        if (out) out.textContent = e.message;
        toast('Ошибка ping', 'error', e.message);
    }
}

async function runDiagTraceroute() {
    const host = (document.getElementById('diagTraceHost') || {}).value || '';
    const out = document.getElementById('diagTraceOut');
    if (out) { out.style.display = 'block'; out.textContent = 'Трассирую ' + host + '…'; }
    try {
        const d = await apiJson('/api/diag/traceroute', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host })
        });
        if (out) out.textContent = d.output || (d.ok ? 'OK' : 'Нет ответа');
    } catch (e) {
        if (out) out.textContent = e.message;
        toast('Ошибка traceroute', 'error', e.message);
    }
}

async function loadDiagLog() {
    const sel = document.getElementById('diagLogSelect');
    const out = document.getElementById('diagLogOut');
    if (!sel || !out) return;
    out.style.display = 'block';
    out.textContent = 'Загрузка…';
    try {
        const res = await fetch('/api/diag/log?file=' + encodeURIComponent(sel.value));
        out.textContent = await res.text();
    } catch (e) {
        out.textContent = 'Ошибка чтения лога: ' + e.message;
    }
}

function openCascadeEditorForPaste() {
    closeWizard();
    openCascadeTab();
    setExpert(true);
    setTimeout(() => {
        const el = document.getElementById('cascadeSetupConf');
        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus(); }
    }, 160);
}

function showInstallProgress() {
    closeWizard();
    openInstallTab();
    setTimeout(() => {
        const el = document.getElementById('installLogWrapper');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 180);
}

/* --------------------------------------------------------------------------
   Мастер: состояние и рендер
   -------------------------------------------------------------------------- */
let wizardState = {
    scenario: null,
    step: 0,
    data: {},
    preview: null,
    result: null,
    busy: false
};

const WIZARD_META = {
    install: { title: 'Установка VPN', icon: '↓' },
    client: { title: 'Новый клиент', icon: '＋' },
    obf: { title: 'Усиление обфускации', icon: '✦' },
    cascade: { title: 'Каскад RU → EU', icon: '⇄' },
    adguard: { title: 'AdGuard Home', icon: '◎' },
    backup: { title: 'Резервная копия', icon: '⤓' }
};

function wizardDefaults(scenario) {
    if (scenario === 'client') return { name: suggestClientName(), expires: '', count: 1, device: 'phone' };
    if (scenario === 'obf') return { preset: 'balanced', regen: true };
    if (scenario === 'cascade') return { role: 'ru', mode: 'install', remoteIp: '', remotePort: '22', remotePass: '' };
    if (scenario === 'adguard') return { action: 'auto', url: '', probe: 'loading', detected: null, enable: true, refresh: true };
    if (scenario === 'install') return { role: 'single', usage: 'mobile', version: '3.1', route: 'all', remoteIp: '', remotePort: '22', remotePass: '' };
    if (scenario === 'backup') return { enabled: true, run: true };
    return {};
}

function suggestClientName() {
    const used = new Set((panelState.clients || []).map(c => String(c.name)));
    for (let i = 1; i < 100; i++) {
        const n = 'client-' + String(i).padStart(2, '0');
        if (!used.has(n)) return n;
    }
    return 'client-' + String(Date.now()).slice(-4);
}

function openWizard(scenario) {
    if (scenario === 'health') { closeWizard(); runHealthCheck(); return; }
    if (scenario && !WIZARD_META[scenario]) scenario = null;
    if (scenario && ['install', 'cascade', 'backup'].includes(scenario) && currentRole !== 'admin') {
        toast('Недостаточно прав', 'error', 'Это действие доступно только администратору.');
        return;
    }
    wizardState = {
        scenario: scenario || null,
        step: scenario ? 1 : 0,
        data: scenario ? wizardDefaults(scenario) : {},
        preview: null,
        result: null,
        busy: false
    };
    const overlay = document.getElementById('wizardOverlay');
    if (overlay) overlay.style.display = 'flex';
    renderWizard();
    if (scenario === 'adguard') probeAdGuardWizard();
}

function closeWizard() {
    const overlay = document.getElementById('wizardOverlay');
    if (overlay) overlay.style.display = 'none';
    wizardState = { scenario: null, step: 0, data: {}, preview: null, result: null, busy: false };
}

function chooseScenario(key) {
    if (key === 'health') { closeWizard(); runHealthCheck(); return; }
    if (!WIZARD_META[key]) return;
    if (['install', 'cascade', 'backup'].includes(key) && currentRole !== 'admin') {
        toast('Недостаточно прав', 'error', 'Это действие доступно только администратору.');
        return;
    }
    wizardState.scenario = key;
    wizardState.step = 1;
    wizardState.data = wizardDefaults(key);
    wizardState.preview = null;
    wizardState.result = null;
    renderWizard();
    if (key === 'adguard') probeAdGuardWizard();
}

function wizPick(el, key, value) {
    wizardState.data[key] = value;
    const grid = el && el.parentElement;
    if (grid) grid.querySelectorAll('.choice').forEach(c => c.classList.remove('selected'));
    if (el) el.classList.add('selected');
}

function wizChoice(value, icon, title, desc, selected, key) {
    return `<button type="button" class="choice ${selected ? 'selected' : ''}" onclick="wizPick(this,'${key}','${value}')">
        <span class="choice-ico">${icon}</span><strong>${title}</strong><small>${desc}</small></button>`;
}

function wizardNext() {
    if (wizardState.busy) return;
    if (wizardState.result) { closeWizard(); return; }
    if (wizardState.step === 1) {
        if (!wizardValidate()) return;
        if (wizardState.scenario === 'obf') { wizardPrepareObf(); return; }
        wizardState.step = 2;
        renderWizard();
        return;
    }
    if (wizardState.step === 2) wizardExecute();
}

function wizardBack() {
    if (wizardState.busy) return;
    if (wizardState.result) { wizardState.result = null; wizardState.step = 1; renderWizard(); return; }
    if (wizardState.step === 2) { wizardState.step = 1; renderWizard(); return; }
    if (wizardState.step === 1) { wizardState.scenario = null; wizardState.step = 0; wizardState.data = {}; renderWizard(); return; }
    closeWizard();
}

function renderWizard() {
    const overlay = document.getElementById('wizardOverlay');
    if (!overlay || overlay.style.display === 'none') return;
    const body = document.getElementById('wizardBody');
    const title = document.getElementById('wizardTitle');
    const back = document.getElementById('wizardBack');
    const next = document.getElementById('wizardNext');
    const progress = document.getElementById('wizardProgressBar');
    const meta = WIZARD_META[wizardState.scenario];
    if (!body || !title || !next) return;

    title.innerText = wizardState.result ? 'Готово' : wizardState.step === 0 ? 'Что настроить?' : wizardState.step === 1 ? meta.title : 'Проверьте и запустите';
    if (progress) progress.style.width = wizardState.step === 0 ? '0%' : wizardState.result ? '100%' : wizardState.step === 1 ? '45%' : '78%';
    if (back) back.style.visibility = wizardState.step === 0 ? 'hidden' : 'visible';

    if (wizardState.result) {
        next.style.display = '';
        next.innerText = 'Закрыть';
        next.disabled = false;
    } else if (wizardState.step === 0) {
        next.style.display = 'none';
        next.disabled = false;
    } else {
        next.style.display = '';
        next.innerText = wizardState.step === 1 ? (wizardState.scenario === 'obf' ? 'Проверить профиль' : 'Далее') : 'Выполнить';
        next.disabled = !!wizardState.busy;
    }

    if (wizardState.busy) {
        body.innerHTML = `<div class="wizard-result"><span class="spin" style="font-size:34px;color:var(--accent);">◌</span><h3>Выполняем…</h3><p>Панель работает, подождите несколько секунд.</p></div>`;
        return;
    }
    if (wizardState.result) { body.innerHTML = wizardState.result.html; return; }
    if (wizardState.step === 0) { body.innerHTML = renderWizardHome(); return; }
    if (wizardState.step === 1) { body.innerHTML = renderWizardOptions(); return; }
    body.innerHTML = renderWizardReview();
}

function renderWizardHome() {
    const score = obfScore();
    const vpn = hasVpnInterface();
    const ag = adguardService();
    const backup = panelState.backup;
    const backupOn = !!(backup && backup.config && backup.config.enabled);
    const cards = [
        ['install', '↓', 'Установить VPN', vpn ? 'VPN уже установлен — можно переустановить' : 'AmneziaWG с рекомендованными настройками', vpn ? 'уже есть' : 'рекомендуется'],
        ['client', '＋', 'Добавить клиента', 'Ключ, QR и vpn:// сразу — без скачивания файлов', `${(panelState.clients || []).length} клиентов`],
        ['obf', '✦', 'Усилить обфускацию', 'Готовый профиль вместо стандартных параметров', score === null ? 'нет данных' : `${score}/100`],
        ['cascade', '⇄', 'Настроить каскад', 'Вход в РФ и выход в EU, с прогрессом установки', (panelState.cascade && panelState.cascade.configured) ? 'настроен' : 'не настроен'],
        ['adguard', '◎', 'Подключить AdGuard', 'Автопоиск API, защита и обновление фильтров', ag ? 'найден' : 'не найден'],
        ['backup', '⤓', 'Сделать бэкап', 'Зашифрованная копия конфигов и состояния', backupOn ? 'авто включён' : 'выключен'],
        ['health', '⌁', 'Проверить всё', 'VPN, каскад, AdGuard, обфускация, безопасность', 'диагностика']
    ];
    return `<p class="wizard-lead">Выберите задачу. Панель задаст минимум вопросов, подставит безопасные значения и всё сделает сама.</p>
        <div class="choice-grid">${cards.map(c => `
            <button type="button" class="choice" onclick="chooseScenario('${c[0]}')">
                <span class="choice-ico">${c[1]}</span>
                <strong>${c[2]}</strong><small>${c[3]}</small>
                <span class="choice-badge" style="color:var(--text-muted);background:rgba(255,255,255,.04);border-color:var(--border);">${c[4]}</span>
            </button>`).join('')}</div>
        <div class="wizard-note info" style="margin-top:18px;">
            Совет: начните с «Установить VPN», затем «Добавить клиента» и «Усилить обфускацию». Для ручных полей включите ⚙ в верхней панели.
        </div>`;
}

function renderWizardOptions() {
    if (wizardState.scenario === 'client') return renderClientOptions();
    if (wizardState.scenario === 'obf') return renderObfOptions();
    if (wizardState.scenario === 'cascade') return renderCascadeOptions();
    if (wizardState.scenario === 'adguard') return renderAdGuardOptions();
    if (wizardState.scenario === 'install') return renderInstallOptions();
    if (wizardState.scenario === 'backup') return renderBackupOptions();
    return '';
}

function renderClientOptions() {
    const d = wizardState.data;
    return `<p class="wizard-lead">Панель создаст ключи, выберет свободный IP и сразу покажет QR и ссылку <code>vpn://</code>. Скачивать файл не обязательно.</p>
        <div class="wizard-grid">
            <label class="field"><span>Имя клиента</span>
                <input id="wizClientName" value="${esc(d.name)}" maxlength="63" autocomplete="off" oninput="wizardState.data.name=this.value">
            </label>
            <label class="field"><span>Срок действия</span>
                <select id="wizClientExpires" onchange="wizardState.data.expires=this.value">
                    <option value="" ${d.expires === '' ? 'selected' : ''}>Навсегда</option>
                    <option value="1d" ${d.expires === '1d' ? 'selected' : ''}>1 день</option>
                    <option value="7d" ${d.expires === '7d' ? 'selected' : ''}>7 дней</option>
                    <option value="30d" ${d.expires === '30d' ? 'selected' : ''}>30 дней</option>
                    <option value="90d" ${d.expires === '90d' ? 'selected' : ''}>90 дней</option>
                </select>
            </label>
        </div>
        <div class="wizard-section-title">Тип устройства</div>
        <div class="choice-grid">
            ${wizChoice('phone', '▯', 'Телефон', 'AmneziaVPN / Hiddify', d.device === 'phone', 'device')}
            ${wizChoice('laptop', '▭', 'Ноутбук', 'Windows / macOS / Linux', d.device === 'laptop', 'device')}
            ${wizChoice('router', '⌂', 'Роутер', 'Keenetic / OpenWrt', d.device === 'router', 'device')}
        </div>
        <div class="wizard-grid" style="margin-top:14px;">
            <label class="field"><span>Сколько клиентов создать</span>
                <input id="wizClientCount" type="number" min="1" max="20" value="${Number(d.count) || 1}" oninput="wizardState.data.count=Math.max(1,Math.min(20,parseInt(this.value)||1))">
            </label>
            <div class="wizard-note info">Для нескольких клиентов имена получат суффикс <code>-01</code>, <code>-02</code>. Ключи можно будет показать по одному.</div>
        </div>
        <div class="wizard-note" style="margin-top:14px;">Тип устройства не меняет серверные параметры — он подсказывает, как удобнее импортировать ключ. Безопасность и обфускация общие.</div>`;
}

function renderObfOptions() {
    const d = wizardState.data;
    const score = obfScore();
    return `<p class="wizard-lead">Выберите готовый профиль. Панель сгенерирует уникальные диапазоны H1–H4, размеры S, HeaderProtectionKey, таймеры и цепочки I1–I5, затем применит их и перегенерирует клиентов.</p>
        <div class="wizard-note info">Сейчас: <b>${score === null ? 'нет данных' : score + '/100'}</b> · AWG ${obfVersion()} · ${esc(obfLevelLabel(score))}. Профили из Архитектора по-прежнему доступны во вкладке «Обфускация».</div>
        <div class="wizard-section-title">Профиль защиты</div>
        <div class="choice-grid">
            ${wizChoice('max', '✦', 'Максимум', 'AWG 3.1 · QUIC · все I1–I5 · HPK', d.preset === 'max', 'preset')}
            ${wizChoice('balanced', '◈', 'Баланс', 'AWG 3.1 · 3 цепочки · меньше нагрузки', d.preset === 'balanced', 'preset')}
            ${wizChoice('compat', '◇', 'Совместимость', 'AWG 2.0 · старые клиенты · без HPK', d.preset === 'compat', 'preset')}
        </div>
        <div class="wizard-section-title">После применения</div>
        <label class="form-check" style="margin-bottom:8px;"><input type="checkbox" id="wizObfRegen" ${d.regen ? 'checked' : ''} onchange="wizardState.data.regen=this.checked"> Перегенерировать клиентские конфиги</label>
        <div class="wizard-note">Перед изменением панель сделает резервную копию конфига. Если интерфейс не поднимется — изменения откатятся автоматически.</div>
        <div style="margin-top:14px;">
            <button type="button" class="btn btn-ghost btn-sm" onclick="closeWizard(); openObfTab(); setExpert(true); setTimeout(()=>document.getElementById('obfImportText')?.focus(),250)">Импорт из Архитектора →</button>
        </div>`;
}

function renderCascadeOptions() {
    const d = wizardState.data;
    return `<p class="wizard-lead">Каскад — это входной сервер в РФ и выходной в EU. Панель может установить и связать оба сервера по SSH либо помочь вставить готовый конфиг EU.</p>
        <div class="wizard-section-title">Что делаем</div>
        <div class="choice-grid">
            ${wizChoice('install', '↓', 'Установить с нуля', 'AWG + каскад на двух серверах, с прогрессом', d.mode === 'install', 'mode')}
            ${wizChoice('existing', '⌁', 'Настроить туннель', 'AWG уже стоит, есть конфиг EU', d.mode === 'existing', 'mode')}
        </div>
        <div class="wizard-section-title">Роль этого сервера</div>
        <div class="choice-grid">
            ${wizChoice('ru', '🇷🇺', 'Вход RU', 'Клиенты подключаются сюда, трафик уходит в EU', d.role === 'ru', 'role')}
            ${wizChoice('eu', '🇪🇺', 'Выход EU', 'Сюда приходит туннель с RU-сервера', d.role === 'eu', 'role')}
        </div>
        ${d.mode === 'install' ? `
        <div class="wizard-section-title">Второй сервер</div>
        <div class="wizard-grid">
            <label class="field"><span>IP удалённого сервера</span><input id="wizCascadeIp" placeholder="1.2.3.4" value="${esc(d.remoteIp)}" oninput="wizardState.data.remoteIp=this.value"></label>
            <label class="field"><span>SSH-порт</span><input id="wizCascadePort" type="number" value="${esc(d.remotePort || '22')}" oninput="wizardState.data.remotePort=this.value"></label>
        </div>
        <label class="field"><span>Root-пароль удалённого сервера</span><input id="wizCascadePass" type="password" placeholder="Нужен для SSH-настройки" value="${esc(d.remotePass)}" oninput="wizardState.data.remotePass=this.value"></label>
        <div class="wizard-note">Установка AWG перезагрузит серверы несколько раз. SSH-пароль используется только для настройки и не сохраняется в панели.</div>
        ` : `<div class="wizard-note info">Панель откроет вкладку «Каскад» и включит экспертный режим. Вставьте конфиг клиента, созданного на EU-сервере, — остальное панель сделает сама.</div>`}`;
}

function renderAdGuardOptions() {
    const d = wizardState.data;
    if (d.probe === 'loading') {
        return `<div class="wizard-result"><span class="spin" style="font-size:32px;color:var(--accent);">◌</span><h3>Ищем AdGuard…</h3><p>Проверяем типовые адреса API на этом сервере.</p></div>`;
    }
    const detected = d.detected;
    return `<p class="wizard-lead">AdGuard Home блокирует рекламу и трекеры на DNS-уровне. Панель сама найдёт API, включит защиту и обновит фильтры.</p>
        ${detected ? `<div class="wizard-note good">Найден AdGuard: <b>${esc(detected.url)}</b>${detected.stats ? ` · запросов: ${Number(detected.stats.num_dns_queries || 0).toLocaleString('ru-RU')}` : ''}</div>` : `<div class="wizard-note">AdGuard не найден по типовым адресам. Можно установить его или указать URL вручную.</div>`}
        <div class="wizard-section-title">Действие</div>
        <div class="choice-grid">
            ${detected ? wizChoice('connect', '◎', 'Подключить', 'Использовать найденный AdGuard', d.action === 'connect', 'action') : ''}
            ${wizChoice('install', '↓', 'Установить AdGuard', 'Если он ещё не установлен', d.action === 'install', 'action')}
            ${wizChoice('manual', '⌁', 'Указать URL', 'Нестандартный порт или контейнер', d.action === 'manual', 'action')}
        </div>
        ${d.action === 'manual' ? `<label class="field" style="margin-top:14px;"><span>URL API AdGuard</span><input id="wizAgUrl" placeholder="http://127.0.0.1:8090" value="${esc(d.url || '')}" oninput="wizardState.data.url=this.value"></label>` : ''}
        <div class="wizard-section-title">После подключения</div>
        <label class="form-check" style="margin-bottom:7px;"><input type="checkbox" id="wizAgEnable" ${d.enable ? 'checked' : ''} onchange="wizardState.data.enable=this.checked"> Включить защиту DNS</label>
        <label class="form-check"><input type="checkbox" id="wizAgRefresh" ${d.refresh ? 'checked' : ''} onchange="wizardState.data.refresh=this.checked"> Обновить списки фильтрации</label>`;
}

function renderInstallOptions() {
    const d = wizardState.data;
    const vpn = hasVpnInterface();
    return `<p class="wizard-lead">Мастер подставит рекомендованные параметры. Вам нужно выбрать только сценарий использования — остальное панель сделает сама.</p>
        ${vpn ? `<div class="wizard-note">На сервере уже есть VPN-интерфейс. Повторная установка перезапишет конфигурацию и может отключить текущих клиентов.</div>` : ''}
        <div class="wizard-section-title">Роль сервера</div>
        <div class="choice-grid">
            ${wizChoice('single', '◉', 'Один сервер', 'Весь VPN на этом сервере', d.role === 'single', 'role')}
            ${wizChoice('ru', '⇄', 'Вход RU', 'Каскад: клиенты сюда, выход в EU', d.role === 'ru', 'role')}
            ${wizChoice('eu', '⇄', 'Выход EU', 'Каскад: принимает туннель из RU', d.role === 'eu', 'role')}
        </div>
        <div class="wizard-section-title">Как будете подключаться</div>
        <div class="choice-grid">
            ${wizChoice('mobile', '▯', 'Мобильный / ТСПУ', 'Порт 443, профиль mobile, максимум совместимости', d.usage === 'mobile', 'usage')}
            ${wizChoice('home', '⌂', 'Домашний Wi-Fi', 'Случайный порт, профиль default', d.usage === 'home', 'usage')}
            ${wizChoice('universal', '◈', 'Универсально', 'Порт 443, профиль mobile, весь трафик', d.usage === 'universal', 'usage')}
        </div>
        <div class="wizard-grid" style="margin-top:14px;">
            <label class="field"><span>Версия протокола</span>
                <select id="wizInstallVersion" onchange="wizardState.data.version=this.value">
                    <option value="3.1" ${d.version === '3.1' ? 'selected' : ''}>3.1 — максимум защиты</option>
                    <option value="2.0" ${d.version === '2.0' ? 'selected' : ''}>2.0 — стабильность</option>
                    <option value="1.5" ${d.version === '1.5' ? 'selected' : ''}>1.5 — старые клиенты</option>
                </select>
            </label>
            <label class="field"><span>Маршрутизация</span>
                <select id="wizInstallRoute" onchange="wizardState.data.route=this.value">
                    <option value="all" ${d.route === 'all' ? 'selected' : ''}>Весь трафик</option>
                    <option value="amnezia" ${d.route === 'amnezia' ? 'selected' : ''}>Список Amnezia + DNS</option>
                </select>
            </label>
        </div>
        ${d.role !== 'single' ? `
        <div class="wizard-section-title">Второй сервер для каскада</div>
        <div class="wizard-grid">
            <label class="field"><span>IP удалённого сервера</span><input id="wizInstallIp" placeholder="1.2.3.4" value="${esc(d.remoteIp)}" oninput="wizardState.data.remoteIp=this.value"></label>
            <label class="field"><span>SSH-порт</span><input id="wizInstallPort" type="number" value="${esc(d.remotePort || '22')}" oninput="wizardState.data.remotePort=this.value"></label>
        </div>
        <label class="field"><span>Root-пароль удалённого сервера</span><input id="wizInstallPass" type="password" value="${esc(d.remotePass)}" oninput="wizardState.data.remotePass=this.value"></label>` : ''}
        <div class="wizard-note" style="margin-top:14px;">Установка AWG потребует несколько перезагрузок сервера. Прогресс будет виден в разделе «Установка».</div>`;
}

function renderBackupOptions() {
    const d = wizardState.data;
    const backup = panelState.backup;
    const cfg = backup && backup.config;
    return `<p class="wizard-lead">Панель создаст зашифрованный архив конфигов, ключей и состояния. При включённом автобэкапе копии будут создаваться по расписанию.</p>
        ${cfg ? `<div class="wizard-note info">Сейчас: автобэкап ${cfg.enabled ? 'включён' : 'выключен'}, расписание ${cfg.schedule === 'weekly' ? 'раз в неделю' : 'ежедневно'} в ${cfg.time}, хранить ${cfg.keep} шт., шифрование ${cfg.encrypt ? 'AES-256' : 'выключено'}.</div>` : ''}
        <div class="wizard-section-title">Параметры</div>
        <label class="form-check" style="margin-bottom:9px;"><input type="checkbox" id="wizBackupEnabled" ${d.enabled ? 'checked' : ''} onchange="wizardState.data.enabled=this.checked"> Включить ежедневный автобэкап (04:30, хранить 7)</label>
        <label class="form-check"><input type="checkbox" id="wizBackupRun" ${d.run ? 'checked' : ''} onchange="wizardState.data.run=this.checked"> Создать архив сразу</label>
        <div class="wizard-note" style="margin-top:14px;">Пароль шифрования можно посмотреть в разделе «Администрирование» → «Резервное копирование». Без него архив не расшифровать.</div>`;
}

function renderWizardReview() {
    const d = wizardState.data;
    const row = (label, value) => `<div class="wizard-summary-row"><span>${esc(label)}</span><b>${value}</b></div>`;
    if (wizardState.scenario === 'client') {
        const device = { phone: 'Телефон', laptop: 'Ноутбук', router: 'Роутер' }[d.device] || 'Телефон';
        return `<p class="wizard-lead">Проверьте параметры. После создания панель покажет QR и ссылку vpn://.</p>
            <div class="wizard-summary">
                ${row('Имя', esc(d.name))}
                ${row('Устройство', esc(device))}
                ${row('Срок', d.expires ? esc(d.expires) : 'Навсегда')}
                ${row('Количество', String(d.count))}
            </div>
            <div class="wizard-note info" style="margin-top:14px;">Ключи и IP будут уникальными. При массовом создании имена получат суффиксы -01, -02 и т.д.</div>`;
    }
    if (wizardState.scenario === 'obf') {
        const preview = wizardState.preview;
        const score = preview && preview.audit ? preview.audit.score : '—';
        const version = preview ? preview.version : '—';
        const preset = { max: 'Максимум', balanced: 'Баланс', compat: 'Совместимость' }[d.preset] || d.preset;
        return `<p class="wizard-lead">Профиль сгенерирован. Сравните оценку и запустите применение.</p>
            <div class="wizard-summary">
                ${row('Текущая оценка', (obfScore() === null ? '—' : obfScore() + '/100'))}
                ${row('Новая оценка', `<span class="val-rx">${score}/100</span>`)}
                ${row('Профиль', esc(preset))}
                ${row('Версия', 'AWG ' + esc(version))}
                ${row('Клиенты', d.regen ? 'перегенерировать' : 'не трогать')}
            </div>
            <div class="wizard-note" style="margin-top:14px;">Перед записью будет создана резервная копия. Если интерфейс не поднимется, панель откатит конфиг.</div>`;
    }
    if (wizardState.scenario === 'cascade') {
        if (d.mode === 'existing') {
            return `<p class="wizard-lead">Остался один шаг: вставить конфиг клиента, созданного на EU-сервере.</p>
                <div class="wizard-note info">Панель откроет вкладку «Каскад», включит экспертный режим и подсветит поле. Конфиг должен содержать <code>Endpoint = EU_IP:PORT</code>.</div>`;
        }
        return `<p class="wizard-lead">Проверьте параметры каскада. Установка запустится сразу после подтверждения.</p>
            <div class="wizard-summary">
                ${row('Роль', d.role === 'ru' ? 'Вход RU' : 'Выход EU')}
                ${row('Удалённый сервер', esc(d.remoteIp))}
                ${row('SSH-порт', esc(d.remotePort || '22'))}
                ${row('Пароль', d.remotePass ? 'задан' : 'не задан')}
            </div>
            <div class="wizard-note" style="margin-top:14px;">Серверы перезагрузятся, туннель и маршруты настраиваются автоматически. Прогресс — во вкладке «Установка».</div>`;
    }
    if (wizardState.scenario === 'adguard') {
        const url = d.action === 'manual' ? d.url : (d.detected && d.detected.url) || '—';
        return `<p class="wizard-lead">Проверьте действие с AdGuard.</p>
            <div class="wizard-summary">
                ${row('Действие', d.action === 'install' ? 'Установить AdGuard' : d.action === 'manual' ? 'Подключить вручную' : 'Подключить найденный')}
                ${row('URL API', esc(url))}
                ${row('Защита DNS', d.enable ? 'включить' : 'не менять')}
                ${row('Фильтры', d.refresh ? 'обновить' : 'не трогать')}
            </div>
            <div class="wizard-note" style="margin-top:14px;">Логин и пароль AdGuard не обязательны, если API доступен локально без авторизации.</div>`;
    }
    if (wizardState.scenario === 'install') {
        const usage = { mobile: 'Мобильный / ТСПУ', home: 'Домашний Wi-Fi', universal: 'Универсально' }[d.usage] || d.usage;
        const role = { single: 'Один сервер', ru: 'Вход RU (каскад)', eu: 'Выход EU (каскад)' }[d.role] || d.role;
        const port = d.usage === 'mobile' || d.usage === 'universal' ? '443' : '39743';
        return `<p class="wizard-lead">Проверьте рекомендованную конфигурацию. После запуска начнётся установка с перезагрузками.</p>
            <div class="wizard-summary">
                ${row('Роль', esc(role))}
                ${row('Версия', 'AWG ' + esc(d.version))}
                ${row('Профиль', d.usage === 'home' ? 'default' : 'mobile')}
                ${row('Маршрутизация', d.route === 'all' ? 'Весь трафик' : 'Список Amnezia + DNS')}
                ${row('UDP-порт', port)}
                ${row('Домен', esc((panelState.server && panelState.server.domain) || 'по IP'))}
            </div>
            <div class="wizard-note" style="margin-top:14px;">Установка AWG перезагрузит сервер несколько раз. Не закрывайте вкладку и дождитесь завершения.</div>`;
    }
    if (wizardState.scenario === 'backup') {
        return `<p class="wizard-lead">Проверьте параметры резервного копирования.</p>
            <div class="wizard-summary">
                ${row('Автобэкап', d.enabled ? 'включить ежедневно' : 'не включать')}
                ${row('Архив сейчас', d.run ? 'создать' : 'не создавать')}
            </div>
            <div class="wizard-note info" style="margin-top:14px;">Архив шифруется AES-256. Пароль можно посмотреть в администрировании.</div>`;
    }
    return '';
}

function wizardValidate() {
    const d = wizardState.data;
    if (wizardState.scenario === 'client') {
        const nameEl = document.getElementById('wizClientName');
        const countEl = document.getElementById('wizClientCount');
        const expEl = document.getElementById('wizClientExpires');
        if (nameEl) d.name = nameEl.value.trim();
        if (countEl) d.count = Math.max(1, Math.min(20, parseInt(countEl.value, 10) || 1));
        if (expEl) d.expires = expEl.value;
        if (!/^[A-Za-z0-9_-]{1,63}$/.test(d.name)) {
            toast('Недопустимое имя', 'error', 'Разрешены A–Z, a–z, 0–9, _ и -, до 63 символов.');
            return false;
        }
        return true;
    }
    if (wizardState.scenario === 'cascade') {
        if (d.mode === 'install') {
            const ip = document.getElementById('wizCascadeIp');
            const pass = document.getElementById('wizCascadePass');
            if (ip) d.remoteIp = ip.value.trim();
            if (pass) d.remotePass = pass.value;
            if (!isValidRemoteHost(d.remoteIp)) { toast('Проверьте IP', 'error', 'Укажите IP или домен второго сервера.'); return false; }
            if (!d.remotePass) { toast('Нужен пароль', 'error', 'Для SSH-настройки укажите root-пароль.'); return false; }
        }
        return true;
    }
    if (wizardState.scenario === 'install') {
        if (d.role !== 'single') {
            const ip = document.getElementById('wizInstallIp');
            const pass = document.getElementById('wizInstallPass');
            if (ip) d.remoteIp = ip.value.trim();
            if (pass) d.remotePass = pass.value;
            if (!isValidRemoteHost(d.remoteIp)) { toast('Проверьте IP', 'error', 'Укажите IP или домен второго сервера.'); return false; }
            if (!d.remotePass) { toast('Нужен пароль', 'error', 'Для каскада укажите root-пароль второго сервера.'); return false; }
        }
        return true;
    }
    if (wizardState.scenario === 'adguard') {
        if (d.action === 'manual') {
            const el = document.getElementById('wizAgUrl');
            if (el) d.url = el.value.trim();
            if (!d.url) { toast('Укажите URL', 'error', 'Например, http://127.0.0.1:8090'); return false; }
        }
        return true;
    }
    return true;
}

function isValidRemoteHost(v) {
    const s = String(v || '').trim();
    if (!s || s.length > 253) return false;
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(s) || /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(s);
}

function wizardPrepareObf() {
    wizardState.busy = true;
    renderWizard();
    apiJson('/api/obf/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset: wizardState.data.preset })
    }).then(preview => {
        wizardState.preview = preview;
        wizardState.step = 2;
        wizardState.busy = false;
        renderWizard();
    }).catch(e => {
        wizardState.busy = false;
        toast('Не удалось сгенерировать профиль', 'error', e.message);
        renderWizard();
    });
}

async function wizardExecute() {
    wizardState.busy = true;
    renderWizard();
    try {
        let result;
        if (wizardState.scenario === 'client') result = await executeClientWizard();
        else if (wizardState.scenario === 'obf') result = await executeObfWizard();
        else if (wizardState.scenario === 'cascade') result = await executeCascadeWizard();
        else if (wizardState.scenario === 'adguard') result = await executeAdGuardWizard();
        else if (wizardState.scenario === 'install') result = await executeInstallWizard();
        else if (wizardState.scenario === 'backup') result = await executeBackupWizard();
        else throw new Error('Неизвестный сценарий');
        wizardState.result = { html: result.html };
        if (result.toast) toast(result.toast, 'success', result.toastMessage || '');
        if (result.after) result.after();
    } catch (e) {
        wizardState.result = {
            html: `<div class="wizard-result">
                <div class="result-ico" style="background:rgba(255,107,107,.1);border-color:rgba(255,107,107,.25);color:var(--danger);">!</div>
                <h3>Не получилось</h3><p>${esc(e.message || 'Неизвестная ошибка')}</p>
                <div class="result-actions"><button class="btn btn-ghost" onclick="wizardBack()">← Вернуться</button><button class="btn btn-primary" onclick="closeWizard()">Закрыть</button></div>
            </div>`
        };
    }
    wizardState.busy = false;
    renderWizard();
}

function wizardSuccess(title, message, actions) {
    return `<div class="wizard-result">
        <div class="result-ico">✓</div>
        <h3>${esc(title)}</h3>
        <p>${message}</p>
        <div class="result-actions">${actions || ''}</div>
    </div>`;
}

function resultButton(label, onclick, primary) {
    return `<button class="btn ${primary ? 'btn-primary' : 'btn-ghost'}" onclick="${onclick}">${esc(label)}</button>`;
}

async function executeClientWizard() {
    const d = wizardState.data;
    const count = Math.max(1, Math.min(20, Number(d.count) || 1));
    const names = [];
    if (count === 1) {
        names.push(d.name);
    } else {
        for (let i = 1; i <= count; i++) {
            const suffix = '-' + String(i).padStart(2, '0');
            const base = d.name.slice(0, 63 - suffix.length);
            names.push(base + suffix);
        }
    }
    const created = [];
    for (const name of names) {
        const res = await fetch('/api/create', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, expires: d.expires || '' })
        });
        if (!res.ok) {
            let data = {};
            try { data = await res.json(); } catch (e) { /* file or text */ }
            throw new Error(data.error || `Не удалось создать клиента ${name}`);
        }
        try { await res.blob(); } catch (e) { /* ignore */ }
        created.push(name);
    }
    const keys = [];
    for (const name of created) {
        try {
            keys.push(await apiJson(`/api/clients/${encodeURIComponent(name)}/key`));
        } catch (e) {
            keys.push({ uri: '', qr: '', error: e.message });
        }
    }
    loadStats();
    if (created.length === 1) {
        const key = keys[0] || {};
        lastKeyUri = key.uri || '';
        const qr = key.qr ? `<img src="${key.qr}" alt="QR" style="width:210px;height:210px;background:#fff;padding:8px;border-radius:12px;display:block;margin:6px auto 12px;">` : '';
        return {
            html: wizardSuccess('Клиент создан', `«${esc(created[0])}» готов. Отсканируйте QR или вставьте ссылку в AmneziaVPN.`,
                resultButton('Скопировать vpn://', 'copyKeyUri()', true) +
                resultButton('Скачать .conf', `window.location.href='/api/download/${encodeURIComponent(created[0])}'`) +
                resultButton('Инструкция', `window.open('/api/clients/${encodeURIComponent(created[0])}/export','_blank')`) +
                resultButton('Ещё клиент', "openWizard('client')")
            ).replace('</h3>', `</h3>${qr}`).replace('<div class="result-actions">',
                `<textarea readonly rows="3" style="width:100%;box-sizing:border-box;font-family:monospace;font-size:11px;background:#05080e;color:#b9cdf5;border:1px solid var(--border);border-radius:8px;padding:8px;margin:8px 0 12px;">${esc(key.uri || 'Ключ не получен')}</textarea><div class="result-actions">`),
            toast: 'Клиент создан',
            toastMessage: created[0]
        };
    }
    const list = created.map((name, i) => `<div class="wizard-summary-row"><span>${esc(name)}</span><b>${keys[i] && keys[i].uri ? '<span class="val-rx">ключ готов</span>' : '<span class="val-tx">ключ не получен</span>'}</b></div>`).join('');
    return {
        html: wizardSuccess('Клиенты созданы', `Создано ${created.length} клиентов. Покажите ключ нужному устройству.`,
            resultButton('Первый ключ', `showClientKey('${esc(created[0])}')`, true) +
            resultButton('Клиенты', 'openClientsTab()') +
            resultButton('Ещё', "openWizard('client')")
        ).replace('</h3>', `</h3><div class="wizard-summary" style="width:100%;margin:10px 0;">${list}</div>`),
        toast: 'Клиенты созданы',
        toastMessage: `${created.length} шт.`
    };
}

async function executeObfWizard() {
    const d = wizardState.data;
    const preview = wizardState.preview;
    if (!preview || !preview.params) throw new Error('Профиль не сгенерирован');
    const res = await apiJson('/api/obf/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: preview.params, regenClients: !!d.regen, removeMissing: true })
    });
    const score = res.audit ? res.audit.score : '—';
    const regen = res.regenerated === null || res.regenerated === undefined ? '—' : res.regenerated;
    if (typeof loadObfCurrent === 'function') loadObfCurrent();
    if (typeof loadObfProfiles === 'function') loadObfProfiles();
    loadDashboardState();
    return {
        html: wizardSuccess('Обфускация усилена', `Новая оценка: <b class="val-rx">${score}/100</b>. Клиентов перегенерировано: ${regen}.${res.simulated ? ' (демо-режим)' : ''}`,
            resultButton('Обфускация', 'closeWizard(); openObfTab()', true) +
            resultButton('Создать клиента', "closeWizard(); openWizard('client')") +
            resultButton('Закрыть', 'closeWizard()')
        ).replace('</h3>', `</h3><div class="wizard-summary" style="width:100%;margin:10px 0;"><div class="wizard-summary-row"><span>Резервная копия</span><b class="mono" style="font-size:10px;">${esc(res.backup || '—')}</b></div><div class="wizard-summary-row"><span>Применено параметров</span><b>${res.applied || '—'}</b></div></div>`),
        toast: 'Обфускация применена',
        toastMessage: `Оценка ${score}/100`
    };
}

async function executeCascadeWizard() {
    const d = wizardState.data;
    if (d.mode === 'existing') {
        return {
            html: wizardSuccess('Готово к вставке конфига', 'Сейчас откроется вкладка «Каскад». Вставьте конфиг клиента с EU-сервера — панель создаст awg1.conf и маршруты.',
                resultButton('Открыть вкладку', 'openCascadeEditorForPaste()', true) +
                resultButton('Закрыть', 'closeWizard()')
            )
        };
    }
    const options = {
        version: '3.1', preset: 'mobile', route: 'all', customRoute: '', ipv6: 'disallow',
        port: '443', isolation: true, keepPackages: true, noTweaks: false,
        awgMode: 'cascade', cascadeRole: d.role, remoteIp: d.remoteIp,
        remotePort: d.remotePort || '22', remotePass: d.remotePass, domain: ''
    };
    await startInstall('awg', '/var/log/awg_install.log', options);
    return {
        html: wizardSuccess('Установка каскада запущена', 'Панель настраивает оба сервера. Прогресс виден в разделе «Установка».',
            resultButton('Показать прогресс', 'showInstallProgress()', true) +
            resultButton('Закрыть', 'closeWizard()')
        ),
        toast: 'Установка каскада запущена',
        toastMessage: 'Следите за прогрессом'
    };
}

async function executeInstallWizard() {
    const d = wizardState.data;
    const role = d.role || 'single';
    const options = {
        version: d.version || '3.1',
        preset: d.usage === 'home' ? 'default' : 'mobile',
        route: d.route || 'all',
        customRoute: '',
        ipv6: 'disallow',
        port: d.usage === 'mobile' || d.usage === 'universal' ? '443' : '39743',
        isolation: true,
        keepPackages: true,
        noTweaks: false,
        awgMode: role === 'single' ? 'single' : 'cascade',
        cascadeRole: role === 'eu' ? 'eu' : 'ru',
        remoteIp: d.remoteIp || '',
        remotePort: d.remotePort || '22',
        remotePass: d.remotePass || '',
        domain: (panelState.server && panelState.server.domain) || ''
    };
    await startInstall('awg', '/var/log/awg_install.log', options);
    return {
        html: wizardSuccess('Установка запущена', 'Панель скачивает установщик и настраивает AmneziaWG. Сервер может перезагрузиться несколько раз.',
            resultButton('Показать прогресс', 'showInstallProgress()', true) +
            resultButton('Закрыть', 'closeWizard()')
        ),
        toast: 'Установка AWG запущена',
        toastMessage: 'Прогресс — во вкладке «Установка»'
    };
}

async function executeBackupWizard() {
    const d = wizardState.data;
    if (d.enabled) {
        await apiJson('/api/backup/auto', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: true, schedule: 'daily', time: '04:30', keep: 7, encrypt: true })
        });
    }
    let run = null;
    if (d.run) {
        run = await apiJson('/api/backup/run', { method: 'POST' });
    }
    if (typeof loadBackup === 'function') loadBackup();
    loadDashboardState();
    const n = run && Array.isArray(run.archives) ? run.archives.length : null;
    return {
        html: wizardSuccess('Резервная копия готова', d.enabled ? 'Автобэкап включён. Архив создан и зашифрован AES-256.' : 'Архив создан.',
            resultButton('Скачать архив', "window.location.href='/api/backup/encrypted'", true) +
            resultButton('Администрирование', 'closeWizard(); openAdminTab()') +
            resultButton('Закрыть', 'closeWizard()')
        ).replace('</h3>', `</h3>${n !== null ? `<div class="wizard-note good" style="width:100%;">Архивов в хранилище: ${n}</div>` : ''}`),
        toast: 'Бэкап создан',
        toastMessage: n !== null ? `${n} архив(ов)` : ''
    };
}

async function executeAdGuardWizard() {
    const d = wizardState.data;
    if (d.action === 'install') {
        await startInstall('adguard', '/var/log/adguard_install.log', {});
        return {
            html: wizardSuccess('Установка AdGuard запущена', 'После завершения вернитесь в мастер и выберите «Подключить».',
                resultButton('Показать прогресс', 'showInstallProgress()', true) +
                resultButton('Закрыть', 'closeWizard()')
            ),
            toast: 'Установка AdGuard запущена'
        };
    }
    let url = d.action === 'manual' ? d.url : (d.detected && d.detected.url) || '';
    if (!url) throw new Error('AdGuard не найден. Установите его или укажите URL вручную.');
    const stats = await apiJson('/api/adguard/stats', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, user: '', pass: '' })
    });
    const agUrl = document.getElementById('agUrl');
    if (agUrl) agUrl.value = url;
    if (d.enable) {
        await fetch('/api/adguard/proxy', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, user: '', pass: '', action: 'protection', payload: { enabled: true, duration: 0 } })
        });
    }
    if (d.refresh) {
        await fetch('/api/adguard/proxy', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, user: '', pass: '', action: 'filter_refresh', payload: { whitelist: false } })
        });
    }
    if (typeof connectAdGuard === 'function') connectAdGuard(true);
    if (typeof loadAdGuardFull === 'function') loadAdGuardFull();
    loadDashboardState();
    const queries = Number(stats.num_dns_queries || 0).toLocaleString('ru-RU');
    const blocked = Number(stats.num_blocked_filtering || 0).toLocaleString('ru-RU');
    return {
        html: wizardSuccess('AdGuard подключён', `Запросов: <b>${queries}</b>, заблокировано: <b class="val-rx">${blocked}</b>.`,
            resultButton('Открыть AdGuard', 'closeWizard(); openServicesTab()', true) +
            resultButton('Закрыть', 'closeWizard()')
        ),
        toast: 'AdGuard подключён',
        toastMessage: url
    };
}

async function probeAdGuardWizard() {
    if (wizardState.scenario !== 'adguard') return;
    wizardState.data.probe = 'loading';
    renderWizard();
    try {
        const d = await apiJson('/api/adguard/autodetect');
        wizardState.data.detected = d && d.found ? d : null;
        wizardState.data.action = d && d.found ? 'connect' : 'install';
    } catch (e) {
        wizardState.data.detected = null;
        wizardState.data.action = 'install';
    }
    wizardState.data.probe = 'done';
    if (wizardState.scenario === 'adguard') renderWizard();
}

/* --------------------------------------------------------------------------
   Диагностика «Проверить всё»
   -------------------------------------------------------------------------- */
async function runHealthCheck() {
    openModal('Проверка сервера', `<div class="wizard-result"><span class="spin" style="font-size:34px;color:var(--accent);">◌</span><h3>Проверяем…</h3><p>VPN, каскад, AdGuard, обфускация и безопасность.</p></div>`);
    const [ifaces, stats, sys, cascade, services, obf, sec, backup] = await Promise.all([
        safeJson('/api/interfaces'), safeJson('/api/stats'), safeJson('/api/sysinfo'), safeJson('/api/cascade/status'),
        safeJson('/api/services'), safeJson('/api/obf/current'), safeJson('/api/security/status'), safeJson('/api/backup/auto')
    ]);
    const rows = [];
    const add = (status, icon, title, detail, action, btn) => rows.push({ status, icon, title, detail, action, btn });
    const vpnIfaces = (ifaces || []).filter(i => /^(awg|amn|wg)/i.test(String(i)));
    add(vpnIfaces.length ? 'good' : 'bad', '◍', 'VPN', vpnIfaces.length ? `Интерфейсы: ${vpnIfaces.join(', ')}` : 'AmneziaWG не найден', vpnIfaces.length ? '' : "openWizard('install')", vpnIfaces.length ? '' : 'Установить');
    const online = (stats || []).filter(c => c.status_code === 'active' || c.status_code === 'recent').length;
    add('info', '＋', 'Клиенты', `${(stats || []).length} всего, ${online} онлайн`, 'openClientsTab()', 'Открыть');
    if (cascade) {
        const ok = cascade.configured && cascade.tunnelActive;
        add(ok ? 'good' : cascade.configured ? 'warn' : 'bad', '⇄', 'Каскад',
            cascade.configured ? `${cascade.text || ''} · EU: ${cascade.endpoint || '—'}` : 'Не настроен',
            "openWizard('cascade')", cascade.configured ? 'Проверить' : 'Настроить');
    } else add('warn', '⇄', 'Каскад', 'Статус недоступен', "openWizard('cascade')", 'Проверить');
    const ag = (services || []).find(s => /adguard/i.test(String(s.name || '')));
    add(ag && ag.status === 'running' ? 'good' : ag ? 'warn' : 'info', '◎', 'AdGuard',
        ag ? `${ag.name}: ${ag.status === 'running' ? 'работает' : 'остановлен'}` : 'Не найден',
        "openWizard('adguard')", ag ? 'Управлять' : 'Подключить');
    if (obf && obf.audit) {
        const score = obf.audit.score;
        add(score >= 85 ? 'good' : score >= 60 ? 'warn' : 'bad', '✦', 'Обфускация',
            `${score}/100 · ${obfLevelLabel(score)} · AWG ${obf.version || '—'}`,
            "openWizard('obf')", score >= 85 ? 'Проверить' : 'Усилить');
    } else add('warn', '✦', 'Обфускация', 'Не удалось прочитать параметры', "openWizard('obf')", 'Проверить');
    if (sec) {
        const bad = sec.defaultPassword || !sec.totpEnabled;
        add(bad ? (sec.defaultPassword ? 'bad' : 'warn') : 'good', '◈', 'Безопасность',
            `2FA: ${sec.totpEnabled ? 'вкл' : 'выкл'} · HTTPS: ${sec.https ? 'да' : 'нет'} · пароль: ${sec.defaultPassword ? 'по умолчанию' : 'изменён'}`,
            'openAdminTab()', bad ? 'Настроить' : 'Открыть');
    } else add('warn', '◈', 'Безопасность', 'Статус недоступен', 'openAdminTab()', 'Открыть');
    if (backup && backup.config) {
        const n = (backup.archives || []).length;
        add(backup.config.enabled ? (n ? 'good' : 'warn') : 'warn', '⤓', 'Бэкапы',
            `${backup.config.enabled ? 'авто включён' : 'авто выключен'} · ${n} архив(ов)`, "openWizard('backup')", 'Настроить');
    } else add('warn', '⤓', 'Бэкапы', 'Нет данных (нужны права администратора)', "openWizard('backup')", 'Открыть');
    if (sys) {
        const cpu = Number(sys.cpu) || 0, ram = Number(sys.ram) || 0;
        const disk = sys.disk && sys.disk.total ? Math.round((sys.disk.used / sys.disk.total) * 100) : 0;
        add(cpu > 90 || ram > 92 || disk > 92 ? 'warn' : 'good', '▤', 'Сервер',
            `CPU ${cpu}% · RAM ${ram}% · диск ${disk}% · uptime ${sys.uptime || '—'}`, '', '');
    }
    const html = `<div class="rec-list">${rows.map(r => `
        <div class="rec-item ${r.status}">
            <span class="rec-ico">${r.icon}</span>
            <div class="rec-copy"><strong>${esc(r.title)}</strong><small>${esc(r.detail)}</small></div>
            ${r.action ? `<button class="rec-btn" onclick="${r.action}">${esc(r.btn)}</button>` : ''}
        </div>`).join('')}</div>
        <div class="divider"></div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
            <button class="btn btn-ghost btn-sm" onclick="runHealthCheck()">↻ Проверить снова</button>
            <button class="btn btn-ghost btn-sm" onclick="pingFromHealth('1.1.1.1')">Проверить связь (ping 1.1.1.1)</button>
            <button class="btn btn-ghost btn-sm" onclick="closeModal()">Закрыть</button>
        </div>
        <div id="healthPingResult" style="margin-top:12px;"></div>`;
    openModal('Проверка сервера', html);
}

async function pingFromHealth(host) {
    const box = document.getElementById('healthPingResult');
    if (box) box.innerHTML = '<span class="muted">Пингую ' + esc(host) + '…</span>';
    try {
        const d = await apiJson('/api/diag/ping', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host })
        });
        if (box) box.innerHTML = `<div class="wizard-log">${esc(d.output || (d.ok ? 'OK' : 'Нет ответа'))}</div>`;
    } catch (e) {
        if (box) box.innerHTML = `<span class="val-tx">${esc(e.message)}</span>`;
    }
}

/* --------------------------------------------------------------------------
   Command palette (Ctrl+K)
   -------------------------------------------------------------------------- */
const PALETTE_ACTIONS = [
    { id: 'dashboard', icon: '◉', title: 'Дашборд', hint: 'Обзор сервера', run: () => switchTab('tab-dashboard', document.querySelector('.nav-item[data-tab="tab-dashboard"]')) },
    { id: 'clients', icon: '◍', title: 'Клиенты VPN', hint: 'Список и ключи', run: () => openClientsTab() },
    { id: 'new-client', icon: '＋', title: 'Создать клиента', hint: 'Мастер: ключ и QR', run: () => openWizard('client') },
    { id: 'obf', icon: '✦', title: 'Обфускация', hint: 'Профили и Архитектор', run: () => openObfTab() },
    { id: 'obf-auto', icon: '✦', title: 'Усилить обфускацию', hint: 'Готовый профиль', run: () => openWizard('obf') },
    { id: 'cascade', icon: '⇄', title: 'Каскад RU → EU', hint: 'Настройка и статус', run: () => openCascadeTab() },
    { id: 'cascade-wizard', icon: '⇄', title: 'Настроить каскад', hint: 'Пошаговый мастер', run: () => openWizard('cascade') },
    { id: 'adguard', icon: '◎', title: 'AdGuard', hint: 'DNS и фильтры', run: () => openWizard('adguard') },
    { id: 'services', icon: '◎', title: 'Службы и DNS', hint: 'Статусы сервисов', run: () => openServicesTab() },
    { id: 'install', icon: '↓', title: 'Установка', hint: 'AWG и AdGuard', run: () => openInstallTab() },
    { id: 'backup', icon: '⤓', title: 'Резервная копия', hint: 'Создать сейчас', run: () => openWizard('backup') },
    { id: 'health', icon: '⌁', title: 'Проверить всё', hint: 'Диагностика', run: () => runHealthCheck() },
    { id: 'password', icon: '⚿', title: 'Сменить пароль', hint: 'Безопасность', run: () => changePassword() },
    { id: 'admin', icon: '⚿', title: 'Администрирование', hint: '2FA, пользователи, аудит', run: () => openAdminTab() },
    { id: 'expert', icon: '⚙', title: 'Экспертный режим', hint: 'Показать ручные поля', run: () => toggleExpert() }
];
let paletteIndex = 0;
let paletteFiltered = [];

function openPalette() {
    const overlay = document.getElementById('paletteOverlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    const input = document.getElementById('paletteInput');
    if (input) { input.value = ''; setTimeout(() => input.focus(), 40); }
    renderPalette();
}

function closePalette() {
    const overlay = document.getElementById('paletteOverlay');
    if (overlay) overlay.style.display = 'none';
}

function renderPalette() {
    const input = document.getElementById('paletteInput');
    const box = document.getElementById('paletteResults');
    if (!box) return;
    const q = (input && input.value || '').trim().toLowerCase();
    paletteFiltered = PALETTE_ACTIONS.filter(a => !q || (a.title + ' ' + a.hint).toLowerCase().includes(q));
    paletteIndex = Math.max(0, Math.min(paletteIndex, paletteFiltered.length - 1));
    box.innerHTML = paletteFiltered.length ? paletteFiltered.map((a, i) => `
        <button class="palette-item ${i === paletteIndex ? 'active' : ''}" onclick="paletteRun('${a.id}')">
            <span class="pi-ico">${a.icon}</span>
            <span class="pi-copy"><strong>${esc(a.title)}</strong><small>${esc(a.hint)}</small></span>
        </button>`).join('') : '<div class="palette-empty">Ничего не найдено</div>';
}

function paletteRun(id) {
    const action = PALETTE_ACTIONS.find(a => a.id === id);
    closePalette();
    if (action) action.run();
}

function paletteKey(e) {
    if (e.key === 'Escape') { closePalette(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteIndex = Math.min(paletteFiltered.length - 1, paletteIndex + 1); renderPalette(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); paletteIndex = Math.max(0, paletteIndex - 1); renderPalette(); }
    if (e.key === 'Enter' && paletteFiltered[paletteIndex]) { e.preventDefault(); paletteRun(paletteFiltered[paletteIndex].id); }
}

document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
        e.preventDefault();
        openPalette();
    }
    if (e.key === 'Escape') {
        closePalette();
        const wizard = document.getElementById('wizardOverlay');
        if (wizard && wizard.style.display !== 'none') closeWizard();
    }
});

(async function initAuth() {
    try {
        const res = await fetch('/api/security/status');
        if (res.ok) {
            const d = await res.json();
            currentUser = d.user || 'admin';
            currentRole = d.role || 'admin';
            window.__loggedIn = true;
            window.__loginAt = Date.now();
            showDashboard();
        } else if (!window.__loggedIn) {
            showLogin();
        }
    } catch (e) {
        if (!window.__loggedIn) showLogin();
    }
    applyLanguage(currentLang);
})();

/* ==========================================================================
   Обновление панели
   ========================================================================== */
let updTimer = null;
let updPolls = 0;
let updSawRunning = false;
let updInfoCache = null;
const UPD_MAX_UPLOAD = 10 * 1024 * 1024;

function updFmtSize(n) {
    const b = Number(n) || 0;
    if (b < 1024) return b + ' Б';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' КБ';
    return (b / 1024 / 1024).toFixed(1) + ' МБ';
}

function updSetBusy(busy) {
    ['updUploadBtn', 'updUrlBtn', 'updGitCheckBtn', 'updGitBtn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = !!busy;
    });
    const file = document.getElementById('updFile');
    if (file) file.disabled = !!busy;
}

function updSetStatus(text, cls) {
    const el = document.getElementById('updStatus');
    if (!el) return;
    el.className = 'update-status' + (cls ? ' ' + cls : '');
    el.innerText = text;
}

function updShowLog(lines) {
    const el = document.getElementById('updLog');
    if (!el) return;
    const arr = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/).filter(Boolean);
    if (!arr.length) { el.style.display = 'none'; el.textContent = ''; return; }
    el.style.display = 'block';
    el.textContent = arr.join('\n');
    el.scrollTop = el.scrollHeight;
}

function updRenderInfo(d) {
    updInfoCache = d;
    const el = document.getElementById('updInfo');
    if (!el) return;
    const g = d.git || {};
    const ifaces = Array.isArray(d.cascadeIfaces) ? d.cascadeIfaces : [];
    const gitText = g.available
        ? `${esc(g.branch || '?')} · ${esc(g.head || '?')}${g.remote ? ' · ' + esc(g.remote) : ''}`
        : 'git недоступен';
    const gitHub = !g.available ? '—'
        : (g.dirty && g.dirty.length ? 'локальные изменения' :
            (g.behind === 0 ? 'актуально' : (g.behind > 0 ? `доступно ${g.behind}` : '—')));
    const items = [
        ['Текущая версия', `<b>${esc(d.version || '—')}</b>`],
        ['Каталог', `<code>${esc(d.appDir || '—')}</code>`],
        ['Процесс / порт', `${esc(d.pm2Name || 'awg-admin')} · ${esc(String(d.port || '—'))}`],
        ['Node.js', esc(d.node || '—')],
        ['Git', gitText],
        ['GitHub', gitHub],
        ['Каскад', ifaces.length ? ifaces.map(x => `<code>${esc(x)}</code>`).join(', ') : 'правила не найдены'],
        ['Данные', `<code>${esc(d.dataDir || '—')}</code>`]
    ];
    el.innerHTML = items.map(([k, v]) => `<div class="update-item"><small>${k}</small>${v}</div>`).join('');
    updRenderStatus(d.status || {});
    updRenderBackups(d.backups || []);
}

function updRenderBackups(list) {
    const el = document.getElementById('updBackups');
    if (!el) return;
    if (!Array.isArray(list) || !list.length) {
        el.innerHTML = '<div class="update-item">Резервных копий пока нет.</div>';
        return;
    }
    el.innerHTML = list.map(b => {
        let date = b.mtime || '';
        try { date = new Date(b.mtime).toLocaleString(); } catch (e) { /* ignore */ }
        return `<div class="update-backup-row">
            <span class="grow"><code>${esc(b.name)}</code><br><span style="color:var(--text-dim);font-size:11px;">${esc(date)} · ${updFmtSize(b.size)}</span></span>
            <button class="btn btn-dark" data-upd-backup="${esc(b.path)}" onclick="updRollback(this.dataset.updBackup)">↩ Откатить</button>
        </div>`;
    }).join('');
}

function updRenderStatus(st) {
    st = st || {};
    const log = Array.isArray(st.log) ? st.log : [];
    if (st.running) {
        updSawRunning = true;
        updSetBusy(true);
        updSetStatus((st.message || 'Обновление выполняется') + (st.progress ? ` — ${st.progress}%` : ''), 'running');
    } else if (st.error) {
        updSetStatus('Ошибка: ' + st.error, 'err');
        updSetBusy(false);
    } else if (st.ok) {
        updSetStatus('Обновление завершено' + (st.toVersion ? ` — версия ${st.toVersion}` : '') +
            (st.backup ? `\nБэкап: ${st.backup}` : ''), 'ok');
        updSetBusy(false);
    } else {
        updSetStatus('Готово к обновлению.', '');
        updSetBusy(false);
    }
    updShowLog(log);
}

async function loadUpdatePanel(force = false) {
    if (currentRole !== 'admin') return;
    const el = document.getElementById('updInfo');
    if (el && force) el.innerHTML = 'Проверка...';
    try {
        const res = await fetch('/api/update/info');
        if (res.status === 401) { toast('Сессия истекла', 'error', 'Войдите заново'); return; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const d = await res.json();
        updRenderInfo(d);
        if (d.status && d.status.running) updStartPolling();
    } catch (e) {
        if (el) el.innerHTML = `<div class="update-item">Не удалось получить сведения: ${esc(e.message)}</div>`;
    }
}

async function updPost(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
    });
    let d = {};
    try { d = await res.json(); } catch (e) { /* ignore */ }
    if (res.status === 401) throw new Error('Сессия истекла, войдите заново');
    if (!res.ok) throw new Error(d.error || ('HTTP ' + res.status));
    return d;
}

function updStartPolling() {
    updPolls = 0;
    if (updTimer) return;
    updTimer = setTimeout(updPoll, 800);
}

async function updPoll() {
    updTimer = null;
    updPolls += 1;
    try {
        const res = await fetch('/api/update/status');
        if (res.status === 401) {
            updSetStatus('Сессия истекла. Войдите заново, чтобы увидеть результат.', 'err');
            updSetBusy(false);
            return;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const d = await res.json();
        updRenderStatus(d);
        if (d.running) {
            updTimer = setTimeout(updPoll, 1500);
            return;
        }
        updSetBusy(false);
        if (updSawRunning) {
            if (d.ok) {
                toast('Панель обновлена', 'success', 'Перезагрузка интерфейса…');
                setTimeout(() => window.location.reload(), 2500);
            } else {
                toast('Обновление не удалось', 'error', d.error || 'Проверьте журнал');
            }
        }
    } catch (e) {
        // Во время pm2 restart панель недоступна — это нормально.
        if (updPolls < 300) {
            updSetStatus('Панель перезапускается, ждём ответа…', 'running');
            updTimer = setTimeout(updPoll, 2000);
        } else {
            updSetStatus('Не удалось дождаться панели. Проверьте журнал по SSH.', 'err');
            updSetBusy(false);
        }
    }
}

function updUpload() {
    const input = document.getElementById('updFile');
    const f = input && input.files && input.files[0];
    if (!f) { toast('Выберите файл релиза', 'info', '.tar.gz из папки сборки'); return; }
    if (f.size > UPD_MAX_UPLOAD) { toast('Файл слишком большой', 'error', 'Максимум 10 МБ'); return; }
    if (!confirm('Установить новую версию панели из файла?\n\n' +
        'Будут заменены только файлы кода. Данные, клиенты, пароль, 2FA, профили обфускации, ' +
        'сессии и настройки каскада сохраняются. Перед заменой создаётся резервная копия, ' +
        'при ошибке панель автоматически откатится.')) return;

    updSetBusy(true);
    updSawRunning = true;
    updSetStatus('Читаю файл…', 'running');
    const reader = new FileReader();
    reader.onerror = () => { updSetBusy(false); updSetStatus('Не удалось прочитать файл', 'err'); };
    reader.onload = async () => {
        try {
            const b64 = String(reader.result || '').split(',')[1] || '';
            if (!b64) throw new Error('Пустой файл');
            updSetStatus('Загружаю релиз…', 'running');
            await updPost('/api/update/upload', { name: f.name, data: b64 });
            updSetStatus('Релиз принят, начинаю проверку и установку…', 'running');
            updStartPolling();
        } catch (e) {
            updSetStatus('Ошибка: ' + e.message, 'err');
            updSetBusy(false);
            toast('Не удалось запустить обновление', 'error', e.message);
        }
    };
    reader.readAsDataURL(f);
}

async function updFromUrl() {
    const el = document.getElementById('updUrl');
    const url = el ? el.value.trim() : '';
    if (!url) { toast('Укажите ссылку на релиз', 'info'); return; }
    if (!/^https?:\/\//i.test(url)) { toast('Ссылка должна начинаться с http:// или https://', 'error'); return; }
    if (!confirm('Скачать релиз по ссылке и установить его?\n\nДанные и настройки сохраняются, перед заменой создаётся бэкап.')) return;
    updSetBusy(true);
    updSawRunning = true;
    updSetStatus('Скачиваю релиз…', 'running');
    try {
        await updPost('/api/update/url', { url });
        updSetStatus('Релиз скачан, начинаю установку…', 'running');
        updStartPolling();
    } catch (e) {
        updSetStatus('Ошибка: ' + e.message, 'err');
        updSetBusy(false);
        toast('Не удалось скачать релиз', 'error', e.message);
    }
}

async function updGitCheck() {
    const box = document.getElementById('updGitResult');
    if (box) { box.style.display = 'block'; box.textContent = 'Проверяю GitHub…'; }
    try {
        const res = await fetch('/api/update/check-git');
        const d = await res.json();
        if (!res.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + res.status));
        let text;
        if (d.upToDate) {
            text = 'Установлена последняя версия из GitHub.\nКоммит: ' + (d.commit || d.current || '—');
        } else if (d.dirty && d.dirty.length) {
            text = 'Доступно обновление (' + d.behind + ' коммит(ов)), но в панели есть локальные изменения файлов.\n' +
                'GitHub-обновление отменено, чтобы ничего не потерять. Используйте установку из файла.';
        } else {
            text = 'Доступно обновление: ' + d.behind + ' коммит(ов).\nПоследний: ' + (d.commit || '—');
        }
        if (box) box.textContent = text;
    } catch (e) {
        if (box) box.textContent = 'Ошибка проверки: ' + e.message;
    }
}

async function updGitRun() {
    if (!confirm('Обновить панель с GitHub?\n\nGitHub-режим работает только при отсутствии локальных изменений файлов. ' +
        'Перед обновлением создаётся бэкап, при ошибке выполняется автоматический откат. Продолжить?')) return;
    updSetBusy(true);
    updSawRunning = true;
    updSetStatus('Запускаю GitHub-обновление…', 'running');
    try {
        await updPost('/api/update/git', {});
        updStartPolling();
    } catch (e) {
        updSetStatus('Ошибка: ' + e.message, 'err');
        updSetBusy(false);
        toast('GitHub-обновление не запущено', 'error', e.message);
    }
}

async function updRollback(backup) {
    if (!confirm('Откатить панель к резервной копии?\n\n' + backup +
        '\n\nТекущий код панели будет заменён. Данные в бэкапе — на момент его создания.')) return;
    updSetBusy(true);
    updSawRunning = true;
    updSetStatus('Запускаю откат…', 'running');
    try {
        await updPost('/api/update/rollback', { backup });
        updStartPolling();
    } catch (e) {
        updSetStatus('Ошибка: ' + e.message, 'err');
        updSetBusy(false);
        toast('Откат не запущен', 'error', e.message);
    }
}
