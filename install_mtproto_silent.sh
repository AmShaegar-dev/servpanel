#!/bin/bash
# ============================================================================
#  Servpanel — неинтерактивная установка MTProto/WEB прокси из MEKO.
#
#  Панель передаёт все параметры через переменные окружения, поэтому
#  установщик MEKO не задаёт ни одного вопроса. Скрипт также открывает
#  нужные порты в UFW и сохраняет ссылки для подключения.
#
#  Переменные (все необязательные, кроме выбранного вида прокси):
#    MTPROTO_KIND=telemt|zig|fix          вид установки
#    MTPROTO_DOMAIN=ozon.ru               SNI-домен маскировки
#    MTPROTO_PORT=443                     порт прокси
#    MTPROTO_VERSION=                     версия Telemt (пусто = последняя)
#    MTPROTO_FIX_TYPE=v2|v3|v4|nft        тип фикса MEKO
#    MTPROTO_FIX_PORT=                    порт фикса (по умолчанию = порт прокси)
#    MTPROTO_NO_FIX=0|1                   не устанавливать фикс
#    MTPROTO_AD_TAG=                      ad_tag Telemt (32 hex)
#    MTPROTO_USER=                        имя пользователя Telemt
#    MTPROTO_USER_SECRET=                 секрет пользователя (32 hex)
#    MTPROTO_PUBLIC_HOST=                 public_host для ссылок Telemt
#    MTPROTO_WEB=0|1                      WEB-режим Telemt
#    MTPROTO_WEB_HOST=                    домен WEB-режима
#    MTPROTO_WEB_USER=webuser             пользователь WEB-режима
#    MTPROTO_WEB_SECRET=                  секрет WEB-режима (32 hex)
#    MTPROTO_NGINX=0|1                    установить Nginx + Certbot для WEB
# ============================================================================

set -uo pipefail

LOG_FILE="${MTPROTO_LOG:-/var/log/mtproto_install.log}"
MEKO_URL="https://raw.githubusercontent.com/Mekotofeuka/MTPROTO_FIX_By_MEKO/main/install.sh"
MEKO_TMP="/tmp/meko-install-$$.sh"
MEKO_OUT="/tmp/meko-install-$$.out"
LINKS_FILE="${MTPROTO_LINKS_FILE:-/root/mtproto_links.txt}"

# Лог должен быть доступен и панели, и при ручном запуске.
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
: > "$LOG_FILE" 2>/dev/null || LOG_FILE="/tmp/mtproto_install.log"
: > "$LINKS_FILE" 2>/dev/null || true
exec > >(tee -a "$LOG_FILE") 2>&1

cleanup() {
    rm -f "$MEKO_TMP" "$MEKO_OUT" 2>/dev/null || true
}
trap cleanup EXIT

say() { echo "$*"; }
fail() {
    echo ""
    echo "ERROR: $*"
    echo "=== INSTALLATION FAILED ==="
    exit 1
}

is_port() {
    case "${1:-}" in
        ''|*[!0-9]*) return 1 ;;
    esac
    [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

is_domain() {
    local d="${1:-}"
    [ -n "$d" ] && [ "${#d}" -le 253 ] || return 1
    [[ "$d" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]
}

is_hex32() {
    [[ "${1:-}" =~ ^[0-9a-fA-F]{32}$ ]]
}

is_user() {
    [[ "${1:-}" =~ ^[A-Za-z0-9_-]{1,64}$ ]]
}

gen_secret() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 16 2>/dev/null
    else
        head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'
    fi
}

resolve_telemt_version() {
    local v=""
    v=$(curl -fsS --max-time 15 "https://api.github.com/repos/telemt/telemt/releases/latest" 2>/dev/null \
        | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
    v="${v#v}"
    # Если GitHub недоступен — берём версию, проверенную MEKO.
    echo "${v:-3.5.6}"
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

open_mtproto_ports() {
    open_ufw "$PORT" tcp
    open_ufw "$FIX_PORT" tcp
    if [ "$WEB" = "1" ] && [ "$NGINX" = "1" ]; then
        open_ufw 80 tcp
        open_ufw 443 tcp
    fi
    # SSH и порт панели — на случай, если UFW включат после установки.
    open_ufw 22 tcp
    open_ufw "${PANEL_PORT:-}" tcp
}

telemt_config_path() {
    local f
    for f in /etc/telemt/telemt.toml /etc/telemt/config.toml /etc/telemt.toml \
             /opt/telemt/config.toml /opt/telemt/telemt.toml; do
        if [ -f "$f" ]; then
            echo "$f"
            return 0
        fi
    done
    return 1
}

# MEKO в WEB-режиме не применяет ad_tag, пользователя и public_host.
# Дописываем их сами тем же способом, что и оригинальный установщик.
apply_telemt_extras() {
    [ "$KIND" = "telemt" ] || return 0
    local cfg
    cfg=$(telemt_config_path) || return 0
    local changed=0

    if [ -n "$AD_TAG" ]; then
        if grep -q '^ad_tag[[:space:]]*=' "$cfg"; then
            sed -i "s/^ad_tag[[:space:]]*=.*/ad_tag = \"$AD_TAG\"/" "$cfg"
        elif grep -q '^\[general\]' "$cfg"; then
            sed -i "/^\[general\]/a ad_tag = \"$AD_TAG\"" "$cfg"
        else
            printf '\n[general]\nad_tag = "%s"\n' "$AD_TAG" >> "$cfg"
        fi
        say "Telemt: ad_tag применён"
        changed=1
    fi

    if [ -n "$USER_NAME" ] && [ -n "$USER_SECRET" ]; then
        if grep -q "^[[:space:]]*${USER_NAME}[[:space:]]*=" "$cfg"; then
            say "Telemt: пользователь $USER_NAME уже есть в конфиге"
        elif grep -q '^\[access\.users\]' "$cfg"; then
            sed -i "/^\[access\.users\]/a ${USER_NAME} = \"$USER_SECRET\"" "$cfg"
            say "Telemt: добавлен пользователь $USER_NAME"
            changed=1
        else
            printf '\n[access.users]\n%s = "%s"\n' "$USER_NAME" "$USER_SECRET" >> "$cfg"
            say "Telemt: создана секция [access.users], добавлен $USER_NAME"
            changed=1
        fi
    fi

    if [ -n "$PUBLIC_HOST" ]; then
        if grep -q '^public_host[[:space:]]*=' "$cfg"; then
            sed -i "s/^public_host[[:space:]]*=.*/public_host = \"$PUBLIC_HOST\"/" "$cfg"
        elif grep -q '^\[server\.links\]' "$cfg"; then
            sed -i "/^\[server\.links\]/a public_host = \"$PUBLIC_HOST\"" "$cfg"
        else
            printf '\n[server.links]\npublic_host = "%s"\n' "$PUBLIC_HOST" >> "$cfg"
        fi
        say "Telemt: public_host = $PUBLIC_HOST"
        changed=1
    fi

    if [ "$changed" = "1" ]; then
        systemctl restart telemt >/dev/null 2>&1 && say "Telemt перезапущен" || \
            say "WARNING: не удалось перезапустить telemt"
    fi

    # Официальный установщик telemt оставляет конфиг root:telemt с правами 640.
    # Служба работает под пользователем telemt, поэтому её API не может
    # сохранить нового пользователя (failed to write config: Operation not
    # permitted). Даём группе telemt право записи, не открывая файл всем.
    if [ -f "$cfg" ]; then
        chown root:telemt "$cfg" 2>/dev/null || true
        chmod 660 "$cfg" 2>/dev/null || true
    fi
}

save_links() {
    local out="$1"
    : > "$LINKS_FILE"
    grep -Eo 'tg://proxy\?[^[:space:]]+' "$out" 2>/dev/null | sort -u >> "$LINKS_FILE" || true
    grep -Eo 'https://[^[:space:]]+' "$out" 2>/dev/null | while IFS= read -r link; do
        case "$link" in
            *t.me/proxy*|*"${WEB_HOST:-__none__}"*) echo "$link" ;;
        esac
    done | sort -u >> "$LINKS_FILE" || true
    if [ -s "$LINKS_FILE" ]; then
        say ""
        say "=== ССЫЛКИ ДЛЯ ПОДКЛЮЧЕНИЯ ==="
        cat "$LINKS_FILE"
        say "=== КОНЕЦ ССЫЛОК ==="
        say "Ссылки сохранены в $LINKS_FILE"
    else
        say "WARNING: ссылки не найдены в выводе установщика."
        say "Откройте MEKO Manager: sudo mekopr"
    fi
}

# ── Параметры ───────────────────────────────────────────────────────────────
KIND="${MTPROTO_KIND:-telemt}"
DOMAIN="${MTPROTO_DOMAIN:-ozon.ru}"
PORT="${MTPROTO_PORT:-443}"
VERSION="${MTPROTO_VERSION:-}"
FIX_TYPE="${MTPROTO_FIX_TYPE:-v3}"
FIX_PORT="${MTPROTO_FIX_PORT:-$PORT}"
NO_FIX="${MTPROTO_NO_FIX:-0}"
AD_TAG="${MTPROTO_AD_TAG:-}"
USER_NAME="${MTPROTO_USER:-}"
USER_SECRET="${MTPROTO_USER_SECRET:-}"
PUBLIC_HOST="${MTPROTO_PUBLIC_HOST:-}"
WEB="${MTPROTO_WEB:-0}"
WEB_HOST="${MTPROTO_WEB_HOST:-}"
WEB_USER="${MTPROTO_WEB_USER:-webuser}"
WEB_SECRET="${MTPROTO_WEB_SECRET:-}"
NGINX="${MTPROTO_NGINX:-0}"

say "=== СТАРТ УСТАНОВКИ MTPROTO / WEB ПРОКСИ (MEKO) ==="
say "Дата: $(date -Is)"
say "Вид: $KIND · домен: $DOMAIN · порт: $PORT · фикс: $FIX_TYPE/$FIX_PORT"

case "$KIND" in
    telemt|zig|fix) ;;
    mtg)
        fail "MEKO пока не поддерживает автоматическую установку MTG. Выберите Telemt, MTProto.zig или только фикс."
        ;;
    *)
        fail "Неизвестный вид установки: $KIND"
        ;;
esac

is_port "$PORT" || fail "Некорректный порт прокси: $PORT"
is_port "$FIX_PORT" || fail "Некорректный порт фикса: $FIX_PORT"
is_domain "$DOMAIN" || fail "Некорректный SNI-домен: $DOMAIN"
case "$FIX_TYPE" in
    v2|v3|v4|nft) ;;
    *) fail "Некорректный тип фикса: $FIX_TYPE (v2, v3, v4, nft)" ;;
esac
case "$NO_FIX" in 0|1) ;; *) NO_FIX=0 ;; esac
case "$WEB" in 0|1) ;; *) WEB=0 ;; esac
case "$NGINX" in 0|1) ;; *) NGINX=0 ;; esac

if [ "$KIND" = "fix" ]; then
    NO_FIX=0
    WEB=0
fi

if [ "$WEB" = "1" ]; then
    [ "$KIND" = "telemt" ] || fail "WEB-режим поддерживается только для Telemt."
    is_domain "$WEB_HOST" || fail "Для WEB-режима нужен корректный домен (MTPROTO_WEB_HOST)."
    is_user "$WEB_USER" || fail "Некорректное имя WEB-пользователя: $WEB_USER"
    if [ -z "$WEB_SECRET" ]; then
        WEB_SECRET=$(gen_secret)
    fi
    is_hex32 "$WEB_SECRET" || fail "WEB-секрет должен быть 32 hex-символа."
fi

if [ -n "$AD_TAG" ] && ! is_hex32 "$AD_TAG"; then
    fail "ad_tag должен быть 32 hex-символа."
fi
if [ -n "$USER_NAME" ] && ! is_user "$USER_NAME"; then
    fail "Некорректное имя пользователя: $USER_NAME"
fi
if [ -n "$USER_NAME" ] && [ -z "$USER_SECRET" ]; then
    USER_SECRET=$(gen_secret)
fi
if [ -n "$USER_SECRET" ] && ! is_hex32 "$USER_SECRET"; then
    fail "Секрет пользователя должен быть 32 hex-символа."
fi
if [ -n "$PUBLIC_HOST" ] && ! is_domain "$PUBLIC_HOST"; then
    fail "Некорректный public_host: $PUBLIC_HOST"
fi

# ── Порты открываем до установки: если скрипт упадёт, доступ не потеряется ──
open_mtproto_ports

# ── Пакеты, необходимые установщику ─────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
say "[1/4] Проверка зависимостей..."
if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
    apt-get update -y >/dev/null 2>&1 || true
    apt-get install -y curl tar ca-certificates >/dev/null 2>&1 || true
fi
command -v curl >/dev/null 2>&1 || fail "curl не установлен."

# ── Версия Telemt ───────────────────────────────────────────────────────────
if [ "$KIND" = "telemt" ]; then
    if [ -z "$VERSION" ] || [ "$VERSION" = "latest" ] || [ "$VERSION" = "последняя" ]; then
        say "[2/4] Определяем последнюю версию Telemt..."
        VERSION=$(resolve_telemt_version)
    fi
    say "Версия Telemt: $VERSION"
else
    say "[2/4] Версия Telemt не требуется."
fi

# ── Скачиваем установщик MEKO ───────────────────────────────────────────────
say "[3/4] Загрузка установщика MEKO..."
if ! curl -fsSL "$MEKO_URL" -o "$MEKO_TMP" || [ ! -s "$MEKO_TMP" ]; then
    fail "Не удалось скачать установщик MEKO."
fi

# ── Собираем аргументы. Все вопросы закрыты значениями. ─────────────────────
FLAGS=()
case "$KIND" in
    telemt)
        FLAGS+=(-telemt)
        FLAGS+=(-domain "$DOMAIN" -port "$PORT" -version "$VERSION")
        ;;
    zig)
        FLAGS+=(-zig)
        FLAGS+=(-domain "$DOMAIN" -port "$PORT")
        ;;
    fix)
        ;;
esac

if [ "$NO_FIX" = "1" ] && [ "$KIND" != "fix" ]; then
    FLAGS+=(-no-fix)
else
    FLAGS+=(-fix -fix-type "$FIX_TYPE" -fix-port "$FIX_PORT")
fi

if [ "$KIND" = "telemt" ]; then
    if [ "$WEB" = "1" ]; then
        FLAGS+=(-web -web-host "$WEB_HOST" -web-user "$WEB_USER" -web-secret "$WEB_SECRET")
        [ "$NGINX" = "1" ] && FLAGS+=(-nginx)
    else
        [ -n "$AD_TAG" ] && FLAGS+=(-ad_tag "$AD_TAG")
        [ -n "$USER_NAME" ] && FLAGS+=(-user "$USER_NAME" "$USER_SECRET")
        [ -n "$PUBLIC_HOST" ] && FLAGS+=(-public_host "$PUBLIC_HOST")
    fi
fi

say "[4/4] Запуск установщика MEKO..."
say "Команда: bash install.sh ${FLAGS[*]}"

set +e
MEKOPR_NO_MENU=1 DEBIAN_FRONTEND=noninteractive \
    bash "$MEKO_TMP" "${FLAGS[@]}" </dev/null 2>&1 | tee "$MEKO_OUT"
MEKO_RC=${PIPESTATUS[0]}
set -e

if [ "$MEKO_RC" -ne 0 ]; then
    fail "Установщик MEKO завершился с кодом $MEKO_RC. Смотрите лог: $LOG_FILE"
fi

# ── Дополнительные параметры Telemt и ссылки ────────────────────────────────
if [ "$KIND" = "telemt" ]; then
    apply_telemt_extras
fi
save_links "$MEKO_OUT"
open_mtproto_ports

if command -v ufw >/dev/null 2>&1; then
    if ufw status 2>/dev/null | grep -q "Status: active"; then
        say "UFW активен: порты MTProto/WEB разрешены."
    else
        say "UFW не включён. Правила добавлены и применятся после включения UFW."
    fi
fi

say ""
say "=== INSTALLATION DONE ==="
exit 0
