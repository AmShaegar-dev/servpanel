#!/bin/bash
# Cloudflare WARP (SOCKS5) + Xray (TLS-вход) для AdGuard Home.
# Опциональный компонент: запускается только по кнопке из панели.
set -euo pipefail
trap 'echo "ERROR: установка WARP/Xray прервана (код $?)"' ERR

echo "=== Cloudflare WARP + Xray для AdGuard ==="
echo "Дата: $(date -Is)"

WARP_LISTEN_IP="${WARP_LISTEN_IP:-10.8.1.1}"
WARP_LISTEN_PORT="${WARP_LISTEN_PORT:-443}"
WARP_SOCKS_PORT="${WARP_SOCKS_PORT:-40000}"

is_port() {
    case "$1" in
        ''|*[!0-9]*) return 1 ;;
    esac
    [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

is_ipv4() {
    [[ "$1" =~ ^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$ ]]
}

is_port "$WARP_LISTEN_PORT" || { echo "ERROR: неверный порт Xray: $WARP_LISTEN_PORT"; exit 1; }
is_port "$WARP_SOCKS_PORT" || { echo "ERROR: неверный порт WARP SOCKS: $WARP_SOCKS_PORT"; exit 1; }
is_ipv4 "$WARP_LISTEN_IP" || { echo "ERROR: неверный IP прослушивания: $WARP_LISTEN_IP"; exit 1; }
# Убираем ведущие нули, чтобы JSON и проверки были корректными.
WARP_LISTEN_PORT=$((10#$WARP_LISTEN_PORT))
WARP_SOCKS_PORT=$((10#$WARP_SOCKS_PORT))

if [ "$WARP_LISTEN_PORT" = "$WARP_SOCKS_PORT" ]; then
    echo "ERROR: порт Xray и порт WARP SOCKS не должны совпадать."
    exit 1
fi

export DEBIAN_FRONTEND=noninteractive
echo "[1/6] Системные пакеты..."
apt-get update
apt-get install -y curl gnupg lsb-release ca-certificates unzip iproute2

if [ "$WARP_LISTEN_IP" != "0.0.0.0" ] && ! ip -4 addr show 2>/dev/null | grep -q "inet ${WARP_LISTEN_IP}/"; then
    echo "ERROR: IP ${WARP_LISTEN_IP} не назначен ни одному интерфейсу."
    echo "Укажите IP туннеля AWG (например, 10.8.1.1) или 0.0.0.0."
    exit 1
fi

echo "[2/6] Cloudflare WARP..."
if ! command -v warp-cli >/dev/null 2>&1; then
    . /etc/os-release
    CODENAME="${VERSION_CODENAME:-}"
    if [ -z "$CODENAME" ]; then
        CODENAME="$(lsb_release -cs)"
    fi
    ARCH="$(dpkg --print-architecture)"
    install -d -m 0755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg \
        | gpg --yes --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
    echo "deb [arch=${ARCH} signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ ${CODENAME} main" \
        > /etc/apt/sources.list.d/cloudflare-client.list
    apt-get update
    apt-get install -y cloudflare-warp
fi

systemctl enable --now warp-svc >/dev/null 2>&1 || true
sleep 2
warp-cli --accept-tos registration new >/dev/null 2>&1 || true
warp-cli --accept-tos mode proxy
warp-cli --accept-tos proxy port "$WARP_SOCKS_PORT"
warp-cli --accept-tos connect >/dev/null 2>&1 || true

echo -n "Ожидание подключения WARP"
WARP_OK=0
for _ in $(seq 1 30); do
    WARP_STATUS="$(warp-cli status 2>/dev/null || true)"
    if printf '%s\n' "$WARP_STATUS" | grep -Eqi '(^|[[:space:]])Connected([[:space:]]|$)'; then
        WARP_OK=1
        break
    fi
    echo -n "."
    sleep 1
done
echo
if [ "$WARP_OK" -ne 1 ]; then
    echo "WARNING: WARP не перешёл в Connected за 30 секунд."
    echo "Проверьте: warp-cli status; journalctl -u warp-svc -n 50"
else
    echo "WARP подключён."
fi

if curl -fsS --max-time 15 -x "socks5h://127.0.0.1:${WARP_SOCKS_PORT}" https://ipinfo.io/json >/tmp/warp-check.json 2>/dev/null; then
    echo "SOCKS5 WARP отвечает:"
    cat /tmp/warp-check.json
    echo
else
    echo "WARNING: проверка socks5h://127.0.0.1:${WARP_SOCKS_PORT} не прошла."
fi

echo "[3/6] Xray-core..."
XRAY_BIN="$(command -v xray || true)"
if [ -z "$XRAY_BIN" ]; then
    bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
    XRAY_BIN="/usr/local/bin/xray"
fi
[ -x "$XRAY_BIN" ] || { echo "ERROR: бинарник Xray не найден."; exit 1; }
mkdir -p /usr/local/etc/xray /var/log/xray
chmod 755 /var/log/xray 2>/dev/null || true
chown -R nobody:nogroup /var/log/xray 2>/dev/null || true

echo "[4/6] Конфигурация Xray (${WARP_LISTEN_IP}:${WARP_LISTEN_PORT} -> SOCKS 127.0.0.1:${WARP_SOCKS_PORT})..."
CONFIG="/usr/local/etc/xray/config.json"
if [ -f "$CONFIG" ] && ! grep -q '"tag"[[:space:]]*:[[:space:]]*"warp"' "$CONFIG"; then
    echo "ERROR: $CONFIG уже существует и настроен не панелью."
    echo "Панель не перезаписывает чужой конфиг Xray. Сохраните его и удалите/переименуйте вручную."
    exit 1
fi
if [ -f "$CONFIG" ]; then
    cp -a "$CONFIG" "${CONFIG}.bak_$(date +%Y%m%d-%H%M%S)"
fi
cat > "$CONFIG" << EOF
{
  "log": {
    "loglevel": "warning",
    "access": "/var/log/xray/access.log",
    "error": "/var/log/xray/error.log"
  },
  "inbounds": [
    {
      "listen": "${WARP_LISTEN_IP}",
      "port": ${WARP_LISTEN_PORT},
      "protocol": "dokodemo-door",
      "settings": {
        "address": "1.1.1.1",
        "port": 443,
        "network": "tcp"
      },
      "sniffing": {
        "enabled": true,
        "destOverride": ["tls"],
        "routeOnly": false
      }
    }
  ],
  "outbounds": [
    {
      "tag": "warp",
      "protocol": "socks",
      "settings": {
        "servers": [
          {
            "address": "127.0.0.1",
            "port": ${WARP_SOCKS_PORT}
          }
        ]
      }
    }
  ]
}
EOF

"$XRAY_BIN" -test -config "$CONFIG"

echo "[5/6] Запуск Xray..."
systemctl enable xray >/dev/null 2>&1 || true
systemctl restart xray || true
sleep 1
if ! systemctl is-active --quiet xray; then
    echo "ERROR: Xray не запустился. Последние строки журнала:"
    journalctl -u xray -n 30 --no-pager || true
    LAST_BAK="$(ls -1t "${CONFIG}".bak_* 2>/dev/null | head -1 || true)"
    if [ -n "$LAST_BAK" ]; then
        cp -a "$LAST_BAK" "$CONFIG"
        systemctl restart xray >/dev/null 2>&1 || true
        echo "Восстановлен предыдущий конфиг Xray: $LAST_BAK"
    fi
    exit 1
fi

echo "[6/6] Сохранение параметров..."
mkdir -p /root/awg
cat > /root/awg/warp.env << EOF
WARP_INSTALLED=1
WARP_LISTEN_IP=${WARP_LISTEN_IP}
WARP_LISTEN_PORT=${WARP_LISTEN_PORT}
WARP_SOCKS_PORT=${WARP_SOCKS_PORT}
WARP_INSTALLED_AT=$(date -Is)
EOF
chmod 600 /root/awg/warp.env

if ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "${WARP_LISTEN_PORT}/tcp" >/dev/null 2>&1 || true
    echo "UFW: разрешён TCP/${WARP_LISTEN_PORT}."
fi

echo "Готово: Xray слушает ${WARP_LISTEN_IP}:${WARP_LISTEN_PORT}, WARP SOCKS — 127.0.0.1:${WARP_SOCKS_PORT}."
echo "Теперь в панели укажите IP ${WARP_LISTEN_IP} для dnsrewrite в AdGuard."
echo "INSTALLATION DONE"
