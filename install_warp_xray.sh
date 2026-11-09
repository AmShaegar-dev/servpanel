#!/bin/bash
# Cloudflare WARP (SOCKS5) + Xray (TLS-вход) для AdGuard Home.
# Опциональный компонент: запускается только по кнопке из панели.
set -euo pipefail
trap 'echo "ERROR: установка WARP/Xray прервана (код $?)"' ERR

echo "=== Cloudflare WARP + Xray для AdGuard ==="
echo "Дата: $(date -Is)"

WARP_LISTEN_IP="${WARP_LISTEN_IP:-0.0.0.0}"
WARP_LISTEN_PORT="${WARP_LISTEN_PORT:-443}"
WARP_SOCKS_PORT="${WARP_SOCKS_PORT:-40000}"
# v1 — первая инструкция: WARP + Xray, весь трафик через WARP.
# v2 — вторая инструкция: Google напрямую, AI через WARP, остальное напрямую.
WARP_MODE="${WARP_MODE:-v1}"
# Список доменов AI-сервисов для routing v2. Панель передаёт его в
# WARP_AI_DOMAINS; при ручном запуске берём полный warp-domains.txt.
WARP_AI_DOMAINS_FILE="${WARP_AI_DOMAINS_FILE:-$(cd "$(dirname "$0")" && pwd)/warp-domains.txt}"
case "$WARP_MODE" in
    v1|v2) ;;
    *) echo "ERROR: неизвестный WARP_MODE=$WARP_MODE"; exit 1 ;;
esac

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
apt-get update || echo "WARNING: apt-get update завершился с ошибкой, продолжаем."
apt-get install -y curl gnupg lsb-release ca-certificates unzip iproute2 python3 \
    || { echo "ERROR: не удалось установить базовые пакеты."; exit 1; }

# Порт Xray не должен быть занят чужой службой (Telemt, nginx, MTProto).
# Свой Xray на этом порту разрешён — его мы всё равно перезапустим.
PORT_LINE="$(ss -ltnp 2>/dev/null | grep -E "[:.]${WARP_LISTEN_PORT}[[:space:]]" || true)"
if [ -n "$PORT_LINE" ] && ! printf '%s' "$PORT_LINE" | grep -q 'xray'; then
    echo "ERROR: порт ${WARP_LISTEN_PORT} уже занят:"
    printf '%s\n' "$PORT_LINE" | sed 's/^/  /'
    echo "Xray не сможет слушать этот порт. Остановите службу или выберите другой порт."
    echo "На RU порт 443 часто занят Telemt; WARP/Xray лучше ставить на EU-сервере."
    exit 1
fi

# 127.0.0.1 — штатный адрес WARP-прокси (только с этого же сервера). Порт Xray
# слушает локально и его не нужно открывать наружу; если нужен доступ из
# туннеля AWG, укажите IP интерфейса — он должен существовать.
if [ "$WARP_LISTEN_IP" != "0.0.0.0" ] && [ "$WARP_LISTEN_IP" != "127.0.0.1" ] \
    && ! ip -4 addr show 2>/dev/null | grep -q "inet ${WARP_LISTEN_IP}/"; then
    echo "ERROR: IP ${WARP_LISTEN_IP} не назначен ни одному интерфейсу."
    echo "Оставьте 127.0.0.1 либо укажите существующий IP (например, адрес awg0)."
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
    if ! curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg \
        | gpg --yes --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg; then
        echo "ERROR: не удалось скачать ключ репозитория Cloudflare."
        exit 1
    fi
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ ${CODENAME} main" \
        > /etc/apt/sources.list.d/cloudflare-client.list
    if ! apt-get update || ! apt-get install -y cloudflare-warp; then
        echo "ERROR: пакет cloudflare-warp для ${CODENAME}/${ARCH} не установился."
        echo "Проверьте: apt-cache policy cloudflare-warp"
        exit 1
    fi
fi

if ! command -v warp-cli >/dev/null 2>&1; then
    echo "ERROR: warp-cli отсутствует после установки пакета."
    exit 1
fi

systemctl enable --now warp-svc >/dev/null 2>&1 || true
for _ in $(seq 1 15); do
    warp-cli --accept-tos status >/dev/null 2>&1 && break
    sleep 1
done
# Регистрация могла уже быть сделана (повторная установка) — не ошибка.
warp-cli --accept-tos registration new >/dev/null 2>&1 || true
warp-cli --accept-tos mode proxy || { echo "ERROR: не удалось включить proxy-режим WARP."; exit 1; }
warp-cli --accept-tos proxy port "$WARP_SOCKS_PORT" || { echo "ERROR: не удалось задать порт SOCKS ${WARP_SOCKS_PORT}."; exit 1; }
warp-cli --accept-tos connect >/dev/null 2>&1 || true

echo -n "Ожидание подключения WARP"
WARP_OK=0
for i in $(seq 1 60); do
    WARP_STATUS="$(warp-cli --accept-tos status 2>/dev/null || true)"
    if printf '%s\n' "$WARP_STATUS" | grep -Eqi '(^|[[:space:]])Connected([[:space:]]|$)'; then
        WARP_OK=1
        break
    fi
    if [ "$i" -eq 15 ]; then
        echo -n " (повторный connect)"
        warp-cli --accept-tos connect >/dev/null 2>&1 || true
    fi
    echo -n "."
    sleep 1
done
echo
if [ "$WARP_OK" -ne 1 ]; then
    echo "WARNING: WARP не перешёл в Connected за 60 секунд."
    echo "WARP status:"
    warp-cli --accept-tos status 2>&1 | sed 's/^/  /' || true
    echo "WARP settings:"
    warp-cli --accept-tos settings 2>&1 | head -20 | sed 's/^/  /' || true
    echo "Последние строки журнала warp-svc:"
    journalctl -u warp-svc -n 20 --no-pager 2>&1 | sed 's/^/  /' || true
    echo "WARNING: Xray будет настроен, но AI-маршруты не заработают, пока WARP не подключён."
    echo "Если WARP блокируется провайдером, устанавливайте компонент на EU-сервере."
else
    echo "WARP подключён."
fi

if curl -fsS --max-time 15 -x "socks5h://127.0.0.1:${WARP_SOCKS_PORT}" 'https://api.ipify.org?format=json' >/tmp/warp-check.json 2>/dev/null; then
    echo "SOCKS5 WARP отвечает:"
    cat /tmp/warp-check.json
    echo
else
    echo "WARNING: проверка socks5h://127.0.0.1:${WARP_SOCKS_PORT} не прошла."
    echo "WARP settings:"
    warp-cli --accept-tos settings 2>&1 | head -20 | sed 's/^/  /' || true
    ss -ltnp 2>/dev/null | grep ":${WARP_SOCKS_PORT} " | sed 's/^/  /' || true
fi

echo "[3/6] Xray-core..."
CONFIG="/usr/local/etc/xray/config.json"
XRAY_BIN="$(command -v xray || true)"
XRAY_FRESH=0
if [ -z "$XRAY_BIN" ]; then
    XRAY_FRESH=1
    # Официальный установщик Xray сам создаёт config.json и молча затирает
    # прежний. Если xray стоял раньше, сохраняем конфиг до установки.
    mkdir -p /usr/local/etc/xray
    if [ -f "$CONFIG" ]; then
        cp -a "$CONFIG" "${CONFIG}.bak_$(date +%Y%m%d-%H%M%S)"
        echo "Сохранён прежний конфиг Xray: ${CONFIG}.bak_*"
    fi
    bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
    XRAY_BIN="/usr/local/bin/xray"
fi
[ -x "$XRAY_BIN" ] || { echo "ERROR: бинарник Xray не найден."; exit 1; }
# Официальный установщик Xray мог создать /var/log/xray от root и запустить
# службу до записи конфига. Останавливаем её и готовим каталоги/файлы явно.
systemctl stop xray >/dev/null 2>&1 || true
if [ -L /var/log/xray ]; then
    rm -f /var/log/xray
fi
mkdir -p /usr/local/etc/xray /var/log/xray
XRAY_UID="$(id -u xray 2>/dev/null || true)"
XRAY_GID="$(id -g xray 2>/dev/null || true)"
XRAY_UID="${XRAY_UID:-65534}"
XRAY_GID="${XRAY_GID:-$XRAY_UID}"
chown -R "$XRAY_UID:$XRAY_GID" /var/log/xray 2>/dev/null || true
chmod 755 /var/log/xray
rm -f /var/log/xray/access.log /var/log/xray/error.log
touch /var/log/xray/access.log /var/log/xray/error.log
chown "$XRAY_UID:$XRAY_GID" /var/log/xray/access.log /var/log/xray/error.log 2>/dev/null || true
chmod 644 /var/log/xray/access.log /var/log/xray/error.log
chown root:"$XRAY_GID" /usr/local/etc/xray 2>/dev/null || true
chmod 750 /usr/local/etc/xray 2>/dev/null || true

echo "[4/6] Конфигурация Xray (${WARP_LISTEN_IP}:${WARP_LISTEN_PORT} -> SOCKS 127.0.0.1:${WARP_SOCKS_PORT})..."
# Чужой конфиг при уже установленном Xray не трогаем. Свой конфиг узнаём по
# маркеру панели или по структуре из инструкции (dokodemo 1.1.1.1 + SOCKS
# 127.0.0.1:40000) — служебных тегов в нём нет. Если Xray только что поставил
# официальный установщик (XRAY_FRESH=1), config.json — его дефолт.
IS_OURS=0
if [ -f /root/awg/warp-xray.managed ] || [ -f /root/awg/warp.env ]; then
    IS_OURS=1
fi
if [ "$IS_OURS" != "1" ] && [ -f "$CONFIG" ] \
   && grep -q '"address"[[:space:]]*:[[:space:]]*"1.1.1.1"' "$CONFIG" \
   && grep -q '"port"[[:space:]]*:[[:space:]]*40000' "$CONFIG"; then
    IS_OURS=1
fi
if [ "$XRAY_FRESH" != "1" ] && [ -f "$CONFIG" ] && [ "$IS_OURS" != "1" ]; then
    echo "ERROR: $CONFIG уже существует и настроен не панелью."
    echo "Панель не перезаписывает чужой конфиг Xray. Сохраните его и удалите/переименуйте вручную."
    exit 1
fi
if [ -f "$CONFIG" ]; then
    cp -a "$CONFIG" "${CONFIG}.bak_$(date +%Y%m%d-%H%M%S)"
fi
# Конфиг ровно как в инструкции. Если адрес не задан (0.0.0.0), поле listen
# не пишем — Xray слушает все интерфейсы, как в инструкции.
LISTEN_LINE=""
if [ "$WARP_LISTEN_IP" != "0.0.0.0" ]; then
    LISTEN_LINE="      \"listen\": \"${WARP_LISTEN_IP}\","
fi
# v1 — первая инструкция: routing нет, весь трафик идёт в первый outbound (warp).
# v2 — вторая инструкция: Google напрямую, AI через warp, остальное напрямую.
# Маршруты v2 добавляются после записи базового конфига через python3.
cat > "$CONFIG" << EOF
{
  "log": {
    "loglevel": "info",
    "access": "/var/log/xray/access.log"
  },
  "inbounds": [
    {
${LISTEN_LINE}
      "port": ${WARP_LISTEN_PORT},
      "protocol": "dokodemo-door",
      "settings": {
        "address": "1.1.1.1",
        "port": 443,
        "network": "tcp"
      },
      "sniffing": {
        "enabled": true,
        "destOverride": ["tls"]
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
    },
    {
      "tag": "direct",
      "protocol": "freedom",
      "settings": {
        "domainStrategy": "UseIPv4"
      }
    },
    {
      "tag": "block",
      "protocol": "blackhole"
    }
  ]
}
EOF

if [ "$WARP_MODE" = "v2" ]; then
python3 - "$CONFIG" <<'PY'
import json, os, sys
path = sys.argv[1]
with open(path, encoding='utf-8') as f:
    cfg = json.load(f)
ai_raw = os.environ.get('WARP_AI_DOMAINS')
if ai_raw is None:
    ai = []
    fallback = os.environ.get('WARP_AI_DOMAINS_FILE', '')
    if fallback and os.path.exists(fallback):
        with open(fallback, encoding='utf-8') as f:
            ai = [line.strip().lower() for line in f if line.strip() and not line.strip().startswith('#')]
else:
    ai = [d.strip().lower() for d in ai_raw.split(',') if d.strip()]
blocked = [d.strip().lower() for d in os.environ.get('WARP_BLOCK_DOMAINS', '').split(',') if d.strip()]
google_direct = os.environ.get('WARP_GOOGLE_DIRECT', '1') != '0'
google = [
    "domain:google.com", "domain:googleapis.com", "domain:gstatic.com",
    "domain:googleusercontent.com", "domain:gvt1.com",
    "domain:google-analytics.com", "domain:googletagmanager.com",
    "domain:gemini.google", "domain:deepmind.google"
]
rules = []
if blocked:
    rules.append({"type": "field", "domain": ["domain:" + d for d in blocked], "outboundTag": "block"})
if google_direct:
    rules.append({"type": "field", "domain": google, "outboundTag": "direct"})
if ai:
    rules.append({"type": "field", "domain": ["domain:" + d for d in ai], "outboundTag": "warp"})
rules.append({"type": "field", "network": "tcp,udp", "outboundTag": "direct"})
cfg["routing"] = {"domainStrategy": "AsIs", "rules": rules}
with open(path, 'w', encoding='utf-8') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
print("routing v2: Google direct, blocked:", len(blocked), "AI warp:", len(ai), "default direct")
PY
fi

if [ -f "$CONFIG" ]; then
    chown root:"${XRAY_GID:-65534}" "$CONFIG" 2>/dev/null || true
    chmod 640 "$CONFIG" 2>/dev/null || true
fi

"$XRAY_BIN" -test -config "$CONFIG"

echo "[5/6] Запуск Xray..."
systemctl enable xray >/dev/null 2>&1 || true
systemctl restart xray || true
sleep 3
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
if ! ss -ltn 2>/dev/null | grep -qE "[:.]${WARP_LISTEN_PORT}[[:space:]]"; then
    echo "ERROR: Xray активен, но не слушает порт ${WARP_LISTEN_PORT}."
    journalctl -u xray -n 30 --no-pager || true
    exit 1
fi

echo "[6/6] Сохранение параметров..."
mkdir -p /root/awg
cat > /root/awg/warp.env << EOF
WARP_INSTALLED=1
WARP_MODE=${WARP_MODE}
WARP_LISTEN_IP=${WARP_LISTEN_IP}
WARP_LISTEN_PORT=${WARP_LISTEN_PORT}
WARP_SOCKS_PORT=${WARP_SOCKS_PORT}
WARP_INSTALLED_AT=$(date -Is)
EOF
chmod 600 /root/awg/warp.env
# Маркер: этот config.json создан панелью. Нужен, чтобы при повторной
# установке и удалении отличить свой конфиг от чужого без служебных тегов.
touch /root/awg/warp-xray.managed

if command -v ufw >/dev/null 2>&1; then
    if [ "$WARP_LISTEN_IP" = "127.0.0.1" ]; then
        echo "UFW: TCP/${WARP_LISTEN_PORT} наружу не открываем — Xray слушает 127.0.0.1."
    else
        ufw allow "${WARP_LISTEN_PORT}/tcp" >/dev/null 2>&1 || true
        echo "UFW: разрешён TCP/${WARP_LISTEN_PORT}."
    fi
    if ! ufw status 2>/dev/null | grep -q "Status: active"; then
        echo "UFW не включён: правило добавлено и применится после включения."
    fi
else
    echo "WARNING: ufw не найден. Проверьте порт ${WARP_LISTEN_PORT} вручную."
fi

if [ "$WARP_LISTEN_IP" = "127.0.0.1" ]; then
    echo "Xray слушает 127.0.0.1:${WARP_LISTEN_PORT}, WARP SOCKS — 127.0.0.1:${WARP_SOCKS_PORT}."
    echo "Для AdGuard укажите 127.0.0.1 (localhost) вместо IP туннеля."
else
    echo "Xray слушает ${WARP_LISTEN_IP}:${WARP_LISTEN_PORT}, WARP SOCKS — 127.0.0.1:${WARP_SOCKS_PORT}."
    if [ "$WARP_LISTEN_IP" = "0.0.0.0" ]; then
        echo "Для AdGuard укажите публичный IP сервера."
    else
        echo "Для AdGuard укажите IP ${WARP_LISTEN_IP}."
    fi
fi
if [ "$WARP_MODE" = "v1" ]; then
    echo "Режим v1: весь трафик Xray идёт через WARP (первая инструкция)."
else
    echo "Режим v2: Google напрямую, AI через WARP, остальное напрямую (вторая инструкция)."
fi
echo "Правила AdGuard панель не записывает — скопируйте их из «Инструкции»."
echo "INSTALLATION DONE"
