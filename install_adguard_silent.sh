#!/bin/bash
# Servpanel — чистая установка AdGuard Home.
#
# Панель НЕ настраивает AdGuard: не пишет конфиг, не задаёт логин/пароль,
# DNS, фильтры и шифрование. Скрипт только:
#   1) скачивает бинарник;
#   2) ставит и запускает systemd-службу;
#   3) открывает порты (веб 3001, DNS 53/tcp+udp, DoT 853/tcp).
# Дальше открывается штатный мастер AdGuard на http://IP:3001 — все настройки
# пользователь делает сам с самого начала.
set -uo pipefail

LOG_FILE="${ADGUARD_LOG:-/var/log/adguard_install.log}"
: > "$LOG_FILE" 2>/dev/null || LOG_FILE=/tmp/adguard_install.log

say() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }
fail() { say "ERROR: $*"; exit 1; }

AG_DIR=/opt/AdGuardHome
AG_CONFIG="$AG_DIR/AdGuardHome.yaml"
# Чистая установка стартует с порта 3001; панель занимает 2999.
PORT="${ADGUARD_PORT:-3001}"

port_free() {
    local p="$1"
    if command -v ss >/dev/null 2>&1; then
        ! ss -lntH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}\$"
    else
        ! (command -v netstat >/dev/null 2>&1 && netstat -lnt 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}\$")
    fi
}

say "=== УСТАНОВКА ADGUARD HOME (чистая) ==="
say "Дата: $(date -Is)"

case "$(uname -m)" in
    x86_64|amd64) AG_ARCH=amd64 ;;
    aarch64|arm64) AG_ARCH=arm64 ;;
    armv7l|armv6l) AG_ARCH=armv7 ;;
    i386|i686) AG_ARCH=386 ;;
    *) fail "Архитектура $(uname -m) не поддерживается AdGuard Home." ;;
esac

export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null 2>&1; then
    say "[1/6] Системные пакеты..."
    apt-get update -qq >/dev/null 2>&1 || say "WARNING: apt-get update завершился с ошибкой."
    apt-get install -y -qq curl tar ca-certificates >/dev/null 2>&1 || fail "Не удалось установить curl/tar."
else
    say "[1/6] apt-get не найден — пропускаем установку пакетов."
fi

# --- бинарник -----------------------------------------------------------
say "[2/6] Загрузка AdGuard Home..."
mkdir -p "$AG_DIR"
if [ ! -x "$AG_DIR/AdGuardHome" ]; then
    latest=$(curl -fsS --max-time 25 "https://api.github.com/repos/AdguardTeam/AdGuardHome/releases/latest" 2>/dev/null \
        | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d '"' -f4 || true)
    [ -n "$latest" ] || latest="v0.107.52"
    url="https://static.adtidy.org/adguardhome/release/AdGuardHome_linux_${AG_ARCH}.tar.gz"
    say "Версия: $latest, пакет: $url"
    if ! curl -fsSL --max-time 180 "$url" -o /tmp/AdGuardHome.tar.gz; then
        fail "Не удалось скачать AdGuard Home. Проверьте доступ к static.adtidy.org."
    fi
    tar -xzf /tmp/AdGuardHome.tar.gz -C /tmp >/dev/null 2>&1 || fail "Архив AdGuard Home повреждён."
    rm -rf "$AG_DIR"
    mv /tmp/AdGuardHome "$AG_DIR"
    chmod +x "$AG_DIR/AdGuardHome"
    rm -f /tmp/AdGuardHome.tar.gz
else
    say "Бинарник уже есть в $AG_DIR — обновлять не нужно."
fi
mkdir -p "$AG_DIR/data"

# Если конфиг остался от прошлой установки — не трогаем его, чтобы не потерять
# настройки пользователя. Чистая установка начинается только без конфига.
if [ -f "$AG_CONFIG" ]; then
    say "[3/6] Найден существующий конфиг — оставляем без изменений."
else
    say "[3/6] Конфига нет — AdGuard покажет мастер первичной настройки."
fi

# --- служба -------------------------------------------------------------
say "[4/6] Служба systemd..."
cat > /etc/systemd/system/AdGuardHome.service << EOF
[Unit]
Description=AdGuard Home: Network-level ads blocking DNS server
After=network.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$AG_DIR
ExecStart=$AG_DIR/AdGuardHome --no-check-update -c $AG_CONFIG -w $AG_DIR/data
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure
RestartSec=5
LimitNOFILE=65536
SyslogIdentifier=AdGuardHome

[Install]
WantedBy=multi-user.target
EOF

if [ ! -f "$AG_CONFIG" ] && ! port_free "$PORT"; then
    fail "Порт $PORT занят. Освободите его или смените внутренний порт панели (например, на 2999)."
fi

systemctl daemon-reload
systemctl enable AdGuardHome >/dev/null 2>&1 || true
systemctl restart AdGuardHome
sleep 3
if ! systemctl is-active --quiet AdGuardHome; then
    say "ERROR: AdGuard Home не запустился. Журнал:"
    journalctl -u AdGuardHome -n 30 --no-pager | tee -a "$LOG_FILE" || true
    exit 1
fi

# --- проверка ответа ----------------------------------------------------
say "[5/6] Ожидание веб-интерфейса на порту $PORT..."
ready=0
for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
done
[ "$ready" = "1" ] || say "WARNING: AdGuard не ответил за 30 секунд — откройте журнал службы."

# --- UFW ----------------------------------------------------------------
say "[6/6] Порты в UFW..."
if command -v ufw >/dev/null 2>&1; then
    ufw allow "$PORT/tcp" >/dev/null 2>&1 || true
    # DNS: обычный и DoT — откроем заранее, чтобы мастер сразу работал.
    ufw allow 53/tcp >/dev/null 2>&1 || true
    ufw allow 53/udp >/dev/null 2>&1 || true
    ufw allow 853/tcp >/dev/null 2>&1 || true
    say "UFW: открыты $PORT/tcp (веб), 53/tcp+udp (DNS), 853/tcp (DoT)."
else
    say "UFW не установлен — порты не открывались."
fi

PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PUBLIC_IP="${PUBLIC_IP:-0.0.0.0}"

mkdir -p /root/awg
cat > /root/awg/adguard.env << EOF
ADGUARD_INSTALLED=1
ADGUARD_PORT=$PORT
ADGUARD_PUBLIC_IP=$PUBLIC_IP
ADGUARD_INSTALLED_AT=$(date -Is)
EOF
chmod 600 /root/awg/adguard.env

say "AdGuard Home готов: http://$PUBLIC_IP:$PORT"
say "Откройте адрес и пройдите мастер настройки: логин, пароль, DNS и шифрование задаёте сами."
say "=== INSTALLATION DONE ==="
