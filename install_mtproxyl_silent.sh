#!/bin/bash
# ============================================================================
#  Servpanel — неинтерактивная установка MTProxyL (Liafanx/MTProxyL).
#
#  MTProxyL — менеджер MTProto-прокси на движке telemt с расширенными
#  возможностями: Manager/Reanimator, бинарник или Docker, Zapret2, NFT SYN
#  limiter, Selfmask, WEB Proxy, API управления и собственный Telegram-бот.
#
#  Панель передаёт все параметры через переменные окружения, поэтому
#  установщик MTProxyL не задаёт ни одного вопроса. Скрипт также открывает
#  нужные порты в UFW, сохраняет ключ API для панели и ссылки для подключения.
#
#  Переменные:
#    MTPROXYL_MODE=manager|reanimator        режим работы (по умолчанию manager)
#    MTPROXYL_ENGINE=binary|docker           движок telemt (по умолчанию binary)
#    MTPROXYL_PROXY_MODE=mtproto|web|combined
#    MTPROXYL_PORT=443                       порт прокси
#    MTPROXYL_HOST=                          публичный IP/домен для ссылок
#    MTPROXYL_SNI=autoscout24.ru             FakeTLS SNI
#    MTPROXYL_SECRET=                        основной секрет (32 hex)
#    MTPROXYL_AD_TAG=                        рекламная метка (32 hex)
#    MTPROXYL_USER=                          первый пользователь
#    MTPROXYL_USER_SECRET=                   секрет первого пользователя (32 hex)
#    MTPROXYL_ZAPRET2=yes|no                 Zapret2 MTProto fix
#    MTPROXYL_SYN_LIMITER=meko|classic|off   NFT SYN limiter
#    MTPROXYL_MEKO=yes|no                    обходы By-MEKO
#    MTPROXYL_SELFMASK=                      домен Selfmask (пусто = выкл)
#    MTPROXYL_SELFMASK_CERT=letsencrypt|selfsigned
#    MTPROXYL_SELFMASK_EMAIL=                e-mail для Let's Encrypt
#    MTPROXYL_WEB=yes|no                     WEB Proxy
#    MTPROXYL_WEB_DOMAIN=                    домен WEB Proxy
#    MTPROXYL_WEB_CARRIER=https|https-lanes|websocket|websocket-lanes
#    MTPROXYL_API=yes|no                     mtproxyl-api (по умолчанию yes)
#    MTPROXYL_API_LISTEN=127.0.0.1:9190      адрес API
#    MTPROXYL_TGBOT_TOKEN=                   токен встроенного бота MTProxyL
#    MTPROXYL_TGBOT_ADMIN=                   Telegram ID администратора
#    MTPROXYL_FORCE=0|1                      переустановить поверх
#    MTPROXYL_LINKS_FILE=/root/mtproto_links.txt
# ============================================================================

set -uo pipefail

LOG_FILE="${MTPROXYL_LOG:-/var/log/mtproxyl_install.log}"
LINKS_FILE="${MTPROXYL_LINKS_FILE:-/root/mtproto_links.txt}"
KEY_FILE="${MTPROXYL_KEY_FILE:-/etc/mtproxyl-api/servpanel.key}"
INSTALL_URL="https://raw.githubusercontent.com/Liafanx/MTProxyL/main/install.sh"
TMP_INSTALL="/tmp/mtproxyl-install-$$.sh"
TMP_OUT="/tmp/mtproxyl-install-$$.out"

mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
: > "$LOG_FILE" 2>/dev/null || LOG_FILE="/tmp/mtproxyl_install.log"
: > "$LINKS_FILE" 2>/dev/null || true
exec > >(tee -a "$LOG_FILE") 2>&1

cleanup() { rm -f "$TMP_INSTALL" "$TMP_OUT" 2>/dev/null || true; }
trap cleanup EXIT

say() { echo "$*"; }
fail() {
    echo ""
    echo "ERROR: $*"
    echo "=== INSTALLATION FAILED ==="
    exit 1
}

if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
        say "Требуются права root — перезапуск через sudo..."
        exec sudo -E bash "$0" "$@"
    fi
    fail "Запустите скрипт от root."
fi

is_port() {
    case "${1:-}" in ''|*[!0-9]*) return 1 ;; esac
    [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

is_domain() {
    local d="${1:-}"
    [ -n "$d" ] && [ "${#d}" -le 253 ] || return 1
    [[ "$d" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]
}

is_hex32() { [[ "${1:-}" =~ ^[0-9a-fA-F]{32}$ ]]; }

is_user() { [[ "${1:-}" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; }

is_listen() { [[ "${1:-}" =~ ^[A-Za-z0-9.:\[\]-]{3,64}$ ]]; }

gen_secret() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 16 2>/dev/null
    else
        head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'
    fi
}

open_ufw() {
    local p="${1:-}" proto="${2:-tcp}"
    [ -n "$p" ] || return 0
    is_port "$p" || return 0
    if command -v ufw >/dev/null 2>&1; then
        ufw allow "$p/$proto" >/dev/null 2>&1 || true
        say "UFW: разрешён $proto/$p"
    fi
}

open_ports() {
    open_ufw "$PORT" tcp
    if [ "$WEB" = "yes" ] || [ -n "$SELFMASK" ]; then
        open_ufw 80 tcp
        open_ufw 443 tcp
    fi
    local api_port="${API_LISTEN##*:}"
    case "$API_LISTEN" in
        127.*|"[::1]"*) ;; # API только на loopback — наружу не открываем
        *) open_ufw "$api_port" tcp ;;
    esac
    # SSH и порт панели — на случай, если UFW включат после установки.
    open_ufw 22 tcp
    open_ufw "${PANEL_PORT:-}" tcp
}

# ── Параметры ───────────────────────────────────────────────────────────────
MODE="${MTPROXYL_MODE:-manager}"
ENGINE="${MTPROXYL_ENGINE:-binary}"
PROXY_MODE="${MTPROXYL_PROXY_MODE:-mtproto}"
PORT="${MTPROXYL_PORT:-443}"
HOST="${MTPROXYL_HOST:-}"
SNI="${MTPROXYL_SNI:-autoscout24.ru}"
SECRET="${MTPROXYL_SECRET:-}"
AD_TAG="${MTPROXYL_AD_TAG:-}"
USER_NAME="${MTPROXYL_USER:-}"
USER_SECRET="${MTPROXYL_USER_SECRET:-}"
ZAPRET2="${MTPROXYL_ZAPRET2:-yes}"
SYN_LIMITER="${MTPROXYL_SYN_LIMITER:-meko}"
MEKO="${MTPROXYL_MEKO:-yes}"
SELFMASK="${MTPROXYL_SELFMASK:-}"
SELFMASK_CERT="${MTPROXYL_SELFMASK_CERT:-letsencrypt}"
SELFMASK_EMAIL="${MTPROXYL_SELFMASK_EMAIL:-}"
WEB="${MTPROXYL_WEB:-no}"
WEB_DOMAIN="${MTPROXYL_WEB_DOMAIN:-}"
WEB_CARRIER="${MTPROXYL_WEB_CARRIER:-https}"
API="${MTPROXYL_API:-yes}"
API_LISTEN="${MTPROXYL_API_LISTEN:-127.0.0.1:9190}"
TGBOT_TOKEN="${MTPROXYL_TGBOT_TOKEN:-}"
TGBOT_ADMIN="${MTPROXYL_TGBOT_ADMIN:-}"
FORCE="${MTPROXYL_FORCE:-0}"

say "=== СТАРТ УСТАНОВКИ MTPROXYL ==="
say "Дата: $(date -Is)"
say "Режим: $MODE · движок: $ENGINE · прокси: $PROXY_MODE · порт: $PORT"

# ── Проверка параметров ─────────────────────────────────────────────────────
case "$MODE" in manager|reanimator) ;; *) fail "Неизвестный режим: $MODE (manager, reanimator)" ;; esac
case "$ENGINE" in binary|docker) ;; *) fail "Неизвестный движок: $ENGINE (binary, docker)" ;; esac
case "$PROXY_MODE" in mtproto|web|combined) ;; *) fail "Неизвестный режим прокси: $PROXY_MODE" ;; esac
case "$ZAPRET2" in yes|no) ;; *) ZAPRET2="yes" ;; esac
case "$MEKO" in yes|no) ;; *) MEKO="yes" ;; esac
case "$WEB" in yes|no) ;; *) WEB="no" ;; esac
case "$API" in yes|no) ;; *) API="yes" ;; esac
case "$FORCE" in 0|1) ;; *) FORCE="0" ;; esac
case "$SYN_LIMITER" in meko|classic|off) ;; *) SYN_LIMITER="meko" ;; esac
case "$SELFMASK_CERT" in letsencrypt|selfsigned) ;; *) SELFMASK_CERT="letsencrypt" ;; esac
case "$WEB_CARRIER" in https|https-lanes|websocket|websocket-lanes) ;; *) WEB_CARRIER="https" ;; esac

is_port "$PORT" || fail "Некорректный порт прокси: $PORT"
is_domain "$SNI" || fail "Некорректный SNI-домен: $SNI"
if [ -n "$HOST" ] && ! is_domain "$HOST"; then
    fail "Некорректный публичный адрес: $HOST"
fi
if [ -n "$SECRET" ] && ! is_hex32 "$SECRET"; then
    fail "Основной секрет должен быть 32 hex-символа."
fi
if [ -n "$AD_TAG" ] && ! is_hex32 "$AD_TAG"; then
    fail "ad_tag должен быть 32 hex-символа."
fi
if [ -n "$USER_NAME" ] && ! is_user "$USER_NAME"; then
    fail "Некорректное имя пользователя: $USER_NAME"
fi
if [ -n "$USER_SECRET" ] && ! is_hex32 "$USER_SECRET"; then
    fail "Секрет пользователя должен быть 32 hex-символа."
fi
if [ -n "$USER_NAME" ] && [ -z "$USER_SECRET" ]; then
    USER_SECRET=$(gen_secret)
fi
if [ -n "$SELFMASK" ] && ! is_domain "$SELFMASK"; then
    fail "Некорректный домен Selfmask: $SELFMASK"
fi
if [ "$WEB" = "yes" ] && ! is_domain "$WEB_DOMAIN"; then
    fail "Для WEB Proxy нужен корректный домен (MTPROXYL_WEB_DOMAIN)."
fi
if [ "$API" = "yes" ] && ! is_listen "$API_LISTEN"; then
    fail "Некорректный адрес API: $API_LISTEN"
fi
if [ -n "$TGBOT_TOKEN" ] && ! [[ "$TGBOT_TOKEN" =~ ^[0-9]{5,}:[A-Za-z0-9_-]{20,}$ ]]; then
    fail "Некорректный токен Telegram-бота."
fi
if [ -n "$TGBOT_TOKEN" ] && [ -z "$TGBOT_ADMIN" ]; then
    fail "Для встроенного бота MTProxyL укажите Telegram ID администратора."
fi

# ── Порты открываем до установки: если скрипт упадёт, доступ не потеряется ──
open_ports

# ── Зависимости ─────────────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
say "[1/4] Проверка зависимостей..."
if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
    apt-get update -y >/dev/null 2>&1 || true
    apt-get install -y curl tar ca-certificates >/dev/null 2>&1 || true
fi
command -v curl >/dev/null 2>&1 || fail "curl не установлен."

# ── Загрузка установщика MTProxyL ───────────────────────────────────────────
say "[2/4] Загрузка установщика MTProxyL..."
if ! curl -fsSL "$INSTALL_URL" -o "$TMP_INSTALL" || [ ! -s "$TMP_INSTALL" ]; then
    fail "Не удалось скачать установщик MTProxyL."
fi

# ── Сборка аргументов ───────────────────────────────────────────────────────
FLAGS=(--mode "$MODE" --engine "$ENGINE" --proxy-mode "$PROXY_MODE" --port "$PORT")
FLAGS+=(--sni "$SNI" --zapret2 "$ZAPRET2" --syn-limiter "$SYN_LIMITER" --meko "$MEKO")
[ -n "$HOST" ] && FLAGS+=(--host "$HOST")
[ -n "$SECRET" ] && FLAGS+=(--secret "$SECRET")
[ -n "$AD_TAG" ] && FLAGS+=(--ad-tag "$AD_TAG")
[ -n "$SELFMASK" ] && FLAGS+=(--selfmask "$SELFMASK" --selfmask-cert "$SELFMASK_CERT")
[ -n "$SELFMASK" ] && [ -n "$SELFMASK_EMAIL" ] && FLAGS+=(--selfmask-email "$SELFMASK_EMAIL")
if [ "$WEB" = "yes" ]; then
    FLAGS+=(--web yes --web-domain "$WEB_DOMAIN" --web-carrier "$WEB_CARRIER")
fi
FLAGS+=(--api "$API" --api-listen "$API_LISTEN")
[ -n "$TGBOT_TOKEN" ] && FLAGS+=(--tgbot-token "$TGBOT_TOKEN" --tgbot-admin "$TGBOT_ADMIN")
[ "$FORCE" = "1" ] && FLAGS+=(--force)

say "[3/4] Запуск установщика MTProxyL..."
say "Команда: bash install.sh -- ${FLAGS[*]}"

set +e
DEBIAN_FRONTEND=noninteractive bash "$TMP_INSTALL" -- "${FLAGS[@]}" </dev/null 2>&1 | tee "$TMP_OUT"
INSTALL_RC=${PIPESTATUS[0]}
set -e

if [ "$INSTALL_RC" -ne 0 ]; then
    fail "Установщик MTProxyL завершился с кодом $INSTALL_RC. Смотрите лог: $LOG_FILE"
fi

MTPROXYL_BIN=""
for candidate in /usr/local/bin/mtproxyl /opt/mtproxyl/mtproxyl.sh; do
    if [ -x "$candidate" ]; then MTPROXYL_BIN="$candidate"; break; fi
done
command -v mtproxyl >/dev/null 2>&1 && MTPROXYL_BIN=$(command -v mtproxyl)
[ -n "$MTPROXYL_BIN" ] || say "WARNING: бинарник mtproxyl не найден, управление из панели может не работать."

# ── Ключ API для панели ─────────────────────────────────────────────────────
api_base() {
    local listen="${API_LISTEN:-127.0.0.1:9190}"
    case "$listen" in
        0.0.0.0:*) echo "http://127.0.0.1:${listen##*:}" ;;
        "[::]:"*)  echo "http://127.0.0.1:${listen##*:}" ;;
        *)         echo "http://${listen}" ;;
    esac
}

api_ready() {
    local key="$1" base url
    base=$(api_base)
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        if curl -fsS --max-time 3 -H "Authorization: Bearer $key" "$base/v1/health" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

save_panel_key() {
    local key="$1"
    mkdir -p "$(dirname "$KEY_FILE")" 2>/dev/null || true
    printf '%s\n' "$key" > "$KEY_FILE" || return 1
    chmod 600 "$KEY_FILE" 2>/dev/null || true
    say "Ключ API сохранён для панели: $KEY_FILE"
}

if [ "$API" = "yes" ]; then
    say "[4/4] Настройка API управления..."
    API_KEY=""
    # Свежая установка печатает ключ один раз — забираем последний 64-hex
    # из вывода и проверяем его запросом к API.
    CANDIDATE=$(grep -Eo '[0-9a-f]{64}' "$TMP_OUT" 2>/dev/null | tail -1)
    if [ -n "$CANDIDATE" ] && api_ready "$CANDIDATE"; then
        API_KEY="$CANDIDATE"
    fi

    if [ -z "$API_KEY" ]; then
        if [ -f /etc/mtproxyl-api/key.sha256 ]; then
            say "WARNING: ключ API уже существует и не может быть прочитан (хранится SHA-256)."
            say "Если панель не подключится, нажмите «Выдать ключ API» в разделе «Прокси»."
        elif [ -n "$MTPROXYL_BIN" ]; then
            say "Выдаём новый ключ API..."
            KEY_OUT=$("$MTPROXYL_BIN" api key 2>&1 || true)
            echo "$KEY_OUT" >> "$LOG_FILE"
            CANDIDATE=$(printf '%s\n' "$KEY_OUT" | grep -Eo '[0-9a-f]{64}' | tail -1)
            if [ -n "$CANDIDATE" ]; then
                if api_ready "$CANDIDATE" || true; then API_KEY="$CANDIDATE"; fi
            fi
        fi
    fi

    if [ -n "$API_KEY" ]; then
        save_panel_key "$API_KEY" || say "WARNING: не удалось сохранить ключ API."
    else
        say "WARNING: ключ API получить не удалось. Панель покажет кнопку выдачи ключа."
    fi
else
    say "[4/4] API отключён — управление пользователями из панели недоступно."
fi

# ── Первый пользователь через API ───────────────────────────────────────────
if [ -n "$API_KEY" ] && [ -n "$USER_NAME" ] && [ -n "$USER_SECRET" ]; then
    BODY=$(printf '{"username":"%s","secret":"%s"}' "$USER_NAME" "$USER_SECRET")
    if curl -fsS --max-time 10 -X POST \
        -H "Authorization: Bearer $API_KEY" \
        -H 'Content-Type: application/json' \
        -d "$BODY" "$(api_base)/v1/users" >/dev/null 2>&1; then
        say "Создан пользователь $USER_NAME"
    else
        say "WARNING: не удалось создать пользователя $USER_NAME через API (возможно, уже существует)."
    fi
fi

# ── Ссылки для подключения ──────────────────────────────────────────────────
say ""
say "Сохранение ссылок для подключения..."
: > "$LINKS_FILE"
if [ -n "$MTPROXYL_BIN" ]; then
    "$MTPROXYL_BIN" secret list --json 2>/dev/null \
        | grep -Eo 'tg://proxy\?[^"[:space:]]+' | sort -u >> "$LINKS_FILE" || true
fi
if [ ! -s "$LINKS_FILE" ] && [ -n "$API_KEY" ]; then
    curl -fsS --max-time 10 -H "Authorization: Bearer $API_KEY" \
        "$(api_base)/v1/users" 2>/dev/null \
        | grep -Eo 'tg://proxy\\?[^"[:space:]]+' | sed 's/\\u0026/\&/g' | sort -u >> "$LINKS_FILE" || true
fi
if [ -s "$LINKS_FILE" ]; then
    say "=== ССЫЛКИ ДЛЯ ПОДКЛЮЧЕНИЯ ==="
    cat "$LINKS_FILE"
    say "=== КОНЕЦ ССЫЛОК ==="
    say "Ссылки сохранены в $LINKS_FILE"
else
    say "Ссылки появятся после создания пользователей в панели: раздел «Прокси»."
fi

open_ports

if command -v ufw >/dev/null 2>&1; then
    if ufw status 2>/dev/null | grep -q "Status: active"; then
        say "UFW активен: порты MTProxyL разрешены."
    else
        say "UFW не включён. Правила добавлены и применятся после включения UFW."
    fi
fi

say ""
say "Управление: mtproxyl menu · API: mtproxyl api status"
say ""
say "=== INSTALLATION DONE ==="
exit 0
