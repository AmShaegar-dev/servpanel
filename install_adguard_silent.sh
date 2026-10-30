#!/bin/bash
# Servpanel — тихая установка AdGuard Home.
#
# Раньше скрипт писал в /opt/AdGuardHome/AdGuardHome.yaml только bind_host и
# bind_port и запускал официальный установщик. Тот при непустом каталоге
# считал AdGuard не настроенным, поднимал мастер на 3000 и не укладывался в
# ожидания панели: установка «зависала» или AdGuard оставался не настроенным.
#
# Теперь скрипт готовит полноценный конфиг и только потом ставит службу.
#
# DNS работает только по DNS-over-TLS (TCP 853) — plain DNS на 53 не
# включается, systemd-resolved и /etc/resolv.conf остаются как есть.
#
# Переменные:
#   ADGUARD_PORT=<порт>   веб-интерфейс и API (по умолчанию 3000 или первый
#                         свободный, если 3000 занят панелью/другим сервисом)
#   PANEL_PORT=<порт>     порт самой панели — не занимаем его
set -uo pipefail

LOG_FILE="${ADGUARD_LOG:-/var/log/adguard_install.log}"
: > "$LOG_FILE" 2>/dev/null || LOG_FILE=/tmp/adguard_install.log

say() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }
fail() { say "ERROR: $*"; exit 1; }

WANTED_PORT="${ADGUARD_PORT:-}"
PANEL_PORT="${PANEL_PORT:-}"

port_free() {
    local p="$1"
    [ -z "$p" ] && return 1
    if command -v ss >/dev/null 2>&1; then
        ! ss -lntH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}\$"
    else
        ! (command -v netstat >/dev/null 2>&1 && netstat -lnt 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}\$")
    fi
}

is_port() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

say "=== УСТАНОВКА ADGUARD HOME ==="
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

# --- порт ---------------------------------------------------------------
chosen=""
if is_port "$WANTED_PORT" && [ "$WANTED_PORT" != "$PANEL_PORT" ]; then
    if ! port_free "$WANTED_PORT"; then
        # Порт мог занимать сам AdGuard при прошлой установке — это не ошибка.
        if systemctl is-active --quiet AdGuardHome 2>/dev/null; then
            say "Порт $WANTED_PORT уже слушает AdGuard — продолжаем с ним."
            chosen="$WANTED_PORT"
        else
            # Не валим установку из-за занятого порта: берём следующий свободный
            # и сообщаем об этом. Иначе на сервере, где 3000 занят, установка
            # обрывалась ещё до старта.
            say "Порт $WANTED_PORT занят другим процессом — подберу свободный."
        fi
    else
        chosen="$WANTED_PORT"
    fi
fi
if [ -z "$chosen" ]; then
    for p in $(seq 3000 3050) 8080 8888; do
        [ "$p" = "$PANEL_PORT" ] && continue
        if port_free "$p"; then chosen="$p"; break; fi
    done
fi
[ -n "$chosen" ] || fail "Не нашёл свободный порт для веб-интерфейса AdGuard."
say "Веб-интерфейс и API AdGuard: порт $chosen"

# --- бинарник -----------------------------------------------------------
say "[2/6] Загрузка AdGuard Home..."
AG_DIR=/opt/AdGuardHome
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

# --- конфиг -------------------------------------------------------------
say "[3/6] Конфигурация..."
mkdir -p "$AG_DIR/data"
if [ -f "$AG_DIR/AdGuardHome.yaml" ]; then
    cp -a "$AG_DIR/AdGuardHome.yaml" "$AG_DIR/AdGuardHome.yaml.bak.$(date +%Y%m%d-%H%M%S)"
fi

PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PUBLIC_IP="${PUBLIC_IP:-0.0.0.0}"
# users: [] — AdGuard при первом входе сам попросит задать логин и пароль.
# Готовый хэш пароля без bcrypt-утилиты не посчитать, поэтому включение
# мастера — самый предсказуемый вариант.
cat > "$AG_DIR/AdGuardHome.yaml" << EOF
http:
  bind_hosts:
    - 0.0.0.0
  bind_port: $chosen
  address: 0.0.0.0:$chosen
  session_ttl: 720h
users: []
auth_attempts: 5
block_auth_min: 15
http_proxy: ""
language: "ru"
theme: auto
dns:
  bind_hosts:
    - 0.0.0.0
  port: 853
  tls_port: 853
  serve_plain_dns: false
  anonymize_client_ip: false
  ratelimit: 20
  refuse_any: true
  upstream_dns:
    - https://dns.quad9.net/dns-query
    - https://dns.google/dns-query
  bootstrap_dns:
    - 9.9.9.10
    - 1.1.1.1
  fallback_dns:
    - https://dns.cloudflare.com/dns-query
  filter_servers:
    - url: https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt
      name: AdGuard DNS filter
      enabled: true
    - url: https://adguardteam.github.io/HostlistsRegistry/assets/filter_2.txt
      name: AdAway
      enabled: true
  filtering_enabled: true
  protection_enabled: true
  safebrowsing_enabled: false
  statistics_interval: 90
schema_version: 28
EOF
chmod 600 "$AG_DIR/AdGuardHome.yaml"

# --- порт 853: освобождаем только его ----------------------------------
if systemctl list-unit-files 2>/dev/null | grep -q '^systemd-resolved.service'; then
    # systemd-resolved может сам слушать 853 (DNS over TLS). Останавливаем его
    # только если порт занят, и только stub-режим — 53 и resolv.conf не трогаем.
    if command -v ss >/dev/null 2>&1 && ss -lntH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]853\$"; then
        say "Порт 853 занят systemd-resolved — отключаем его DNS-over-TLS."
        mkdir -p /etc/systemd/resolved.conf.d
        cat > /etc/systemd/resolved.conf.d/servpanel-adguard.conf << 'EOF'
[Resolve]
DNSOverTLS=no
EOF
        systemctl restart systemd-resolved >/dev/null 2>&1 || true
    fi
fi
# dnsmasq, bind9 и named не трогаем: на 853 они не слушают, а чужой
# DNS-сервер может быть нужен другим сервисам.

# --- служба -------------------------------------------------------------
say "[5/6] Служба systemd..."
cat > /etc/systemd/system/AdGuardHome.service << EOF
[Unit]
Description=AdGuard Home: Network-level ads blocking DNS server
After=network.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$AG_DIR
ExecStart=$AG_DIR/AdGuardHome --no-check-update -c $AG_DIR/AdGuardHome.yaml -w $AG_DIR/data
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure
RestartSec=5
LimitNOFILE=65536
SyslogIdentifier=AdGuardHome

[Install]
WantedBy=multi-user.target
EOF
if ! "$AG_DIR/AdGuardHome" --check-config -c "$AG_DIR/AdGuardHome.yaml" >> "$LOG_FILE" 2>&1; then
    say "ERROR: конфиг AdGuard не прошёл проверку, служба не запущена."
    exit 1
fi

systemctl daemon-reload
systemctl enable --now AdGuardHome >/dev/null 2>&1 || true
sleep 3
if ! systemctl is-active --quiet AdGuardHome; then
    say "ERROR: AdGuard Home не запустился. Журнал:"
    journalctl -u AdGuardHome -n 30 --no-pager | tee -a "$LOG_FILE" || true
    exit 1
fi

# Ждём, пока API ответит — панель сразу после этого попробует подключиться.
ready=0
for _ in $(seq 1 20); do
    if curl -fsS --max-time 3 "http://127.0.0.1:$chosen/control/status" >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
done
[ "$ready" = "1" ] || say "WARNING: API AdGuard не ответил за 20 секунд — проверьте журнал службы."

# --- UFW ----------------------------------------------------------------
say "[6/6] Порты в UFW и сохранение параметров..."
if command -v ufw >/dev/null 2>&1; then
    ufw allow "$chosen/tcp" >/dev/null 2>&1 || true
    # DNS принимается только по DNS-over-TLS (TCP 853).
    ufw allow 853/tcp >/dev/null 2>&1 || true
    say "UFW: открыты $chosen/tcp (веб-интерфейс) и 853/tcp (DNS over TLS)."
fi

mkdir -p /root/awg
cat > /root/awg/adguard.env << EOF
ADGUARD_INSTALLED=1
ADGUARD_PORT=$chosen
ADGUARD_PUBLIC_IP=$PUBLIC_IP
ADGUARD_INSTALLED_AT=$(date -Is)
EOF
chmod 600 /root/awg/adguard.env

say "AdGuard Home готов: http://$PUBLIC_IP:$chosen"
say "DNS: 853/tcp — только DNS-over-TLS (DoT). Порт 53 и systemd-resolved не меняются."
say "DoT включается в AdGuard: Настройки -> Шифрование -> DNS-over-TLS на порту 853."
say "=== INSTALLATION DONE ==="
