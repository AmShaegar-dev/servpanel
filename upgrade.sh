#!/usr/bin/env bash
#
# Servpanel 2.5.0 — безопасное обновление существующей панели.
#
# Что делает:
#   1. проверяет релиз и запускает его на КОПИИ данных и отдельном порту;
#   2. останавливает панель и делает два бэкапа: панель целиком и системные
#      конфиги каскада (только для ручного восстановления);
#   3. заменяет файлы кода, НЕ трогая данные, .git, конфиги AWG, iptables,
#      ipset, systemd, fail2ban и AdGuard; у сайта панели в Nginx исправляет
#      только Host на $http_host (иначе нестандартный порт ломает CSRF-проверку);
#   4. запускает pm2 и проверяет HTTP;
#   5. при ошибке автоматически откатывается из бэкапа.
#
# Использование:
#   sudo bash upgrade.sh
#   sudo bash upgrade.sh --rollback /root/backups/servpanel-pre-update-YYYYMMDD-HHMMSS.tar.gz
#
# Переменные (необязательно):
#   APP_DIR=/root/servpanel PM2_NAME=awg-admin BACKUP_DIR=/root/backups
#
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/root/servpanel}"
PM2_NAME="${PM2_NAME:-awg-admin}"
BACKUP_DIR="${BACKUP_DIR:-/root/backups}"
LOG="${SERVEPANEL_UPDATE_LOG:-/var/log/servpanel_update.log}"
SRC_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
STAGE=""
TEST_DATA=""
TEST_PID=""

mkdir -p "$BACKUP_DIR" 2>/dev/null || true
if ! touch "$LOG" 2>/dev/null; then
    LOG="$BACKUP_DIR/panel_update.log"
    touch "$LOG"
fi
chmod 600 "$LOG" 2>/dev/null || true

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG"; }
die() { log "ОШИБКА: $*"; exit 1; }

cleanup() {
    if [ -n "$TEST_PID" ]; then
        kill "$TEST_PID" 2>/dev/null || true
        wait "$TEST_PID" 2>/dev/null || true
    fi
    [ -n "$STAGE" ] && rm -rf "$STAGE" 2>/dev/null || true
    [ -n "$TEST_DATA" ] && rm -rf "$TEST_DATA" 2>/dev/null || true
}
trap cleanup EXIT

[ "$(id -u)" -eq 0 ] || die "запустите от root: sudo bash upgrade.sh"
[ -d "$APP_DIR" ] || die "нет каталога панели $APP_DIR"
command -v node >/dev/null 2>&1 || die "не найден node"
command -v tar >/dev/null 2>&1 || die "не найден tar"
command -v curl >/dev/null 2>&1 || die "не найден curl"
NODE="$(command -v node)"
TAR="$(command -v tar)"
CURL="$(command -v curl)"
PM2="$(command -v pm2 2>/dev/null || true)"
[ -n "$PM2" ] || PM2="/usr/local/bin/pm2"
[ -x "$PM2" ] || die "не найден pm2"

PORT="$(cat "$APP_DIR/.panel_port" 2>/dev/null | tr -dc '0-9' || true)"
[ -n "$PORT" ] || PORT="${PANEL_PORT:-3000}"
case "$PORT" in ''|*[!0-9]*) die "некорректный порт панели: $PORT" ;; esac
NGINX_PANEL_CONF="${NGINX_PANEL_CONF:-/etc/nginx/sites-available/awg-admin}"

# ---------------------------------------------------------------------------
# Nginx: панель за прокси на нестандартном порту.
# $host в Nginx не содержит порт, а браузер присылает Origin с :4444.
# Панель отклоняет такой POST как CSRF. Меняем только одну строку в сайте
# панели, с бэкапом и проверкой nginx -t; остальные сайты не трогаем.
# ---------------------------------------------------------------------------
# shellcheck disable=SC2016  # $host/$http_host должны остаться для Nginx
fix_panel_nginx_host() {
    local conf="$NGINX_PANEL_CONF"
    local backup="$BACKUP_DIR/nginx-awg-admin-$STAMP.conf"
    [ -f "$conf" ] || return 0
    grep -Fq "proxy_pass http://127.0.0.1:${PORT};" "$conf" 2>/dev/null || return 0
    grep -Fq 'proxy_set_header Host $host;' "$conf" 2>/dev/null || return 0
    command -v nginx >/dev/null 2>&1 || return 0

    cp -a "$conf" "$backup" || {
        log "Nginx: не удалось сделать бэкап $conf; строку Host не меняю."
        return 1
    }
    sed -i -E 's#^([[:space:]]*)proxy_set_header[[:space:]]+Host[[:space:]]+\$host;[[:space:]]*$#\1proxy_set_header Host $http_host;#' "$conf"

    if ! nginx -t >>"$LOG" 2>&1; then
        cp -a "$backup" "$conf" 2>/dev/null || true
        log "Nginx: nginx -t не прошёл; конфиг восстановлен из $backup."
        return 1
    fi
    if ! systemctl reload nginx >>"$LOG" 2>&1; then
        cp -a "$backup" "$conf" 2>/dev/null || true
        systemctl reload nginx >>"$LOG" 2>&1 || true
        log "Nginx: reload не удался; конфиг восстановлен из $backup."
        return 1
    fi
    log "Nginx: Host для сайта панели теперь \$http_host (порт сохраняется). Бэкап: $backup"
    return 0
}

health_generic() {
    for _ in $(seq 1 30); do
        if "$CURL" -fsS --max-time 2 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
            return 0
        fi
        sleep 0.5
    done
    return 1
}

health_ok() {
    local body
    for _ in $(seq 1 60); do
        if body=$("$CURL" -fsS --max-time 2 "http://127.0.0.1:${PORT}/" 2>/dev/null); then
            case "$body" in
                *panel-version*) return 0 ;;
            esac
        fi
        sleep 0.5
    done
    return 1
}

pm2_start() {
    "$PM2" restart "$PM2_NAME" --update-env >/dev/null 2>&1 ||
        "$PM2" start "$APP_DIR/server.js" --name "$PM2_NAME" --update-env >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Режим отката
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--rollback" ]; then
    BACKUP="${2:-}"
    [ -n "$BACKUP" ] || die "укажите путь к бэкапу: --rollback /root/backups/....tar.gz"
    [ -s "$BACKUP" ] || die "бэкап не найден: $BACKUP"
    log "Откат панели из $BACKUP"
    "$PM2" stop "$PM2_NAME" >/dev/null 2>&1 || true
    if ! "$TAR" -xzf "$BACKUP" -C "$(dirname "$APP_DIR")"; then
        pm2_start || true
        die "не удалось распаковать бэкап $BACKUP"
    fi
    pm2_start || true
    health_generic || die "панель не ответила после отката"
    log "Откат завершён. Версия: $("$NODE" -e 'process.stdout.write(require(process.argv[1]).version)' "$APP_DIR/package.json" 2>/dev/null || echo '?')"
    exit 0
fi

# ---------------------------------------------------------------------------
# Проверки релиза и исходников
# ---------------------------------------------------------------------------
[ -s "$SRC_DIR/server.js" ] || die "в $SRC_DIR нет server.js — запустите скрипт из распакованного релиза"
[ -s "$SRC_DIR/public/index.html" ] || die "в релизе нет public/index.html"
[ -s "$SRC_DIR/public/style.css" ] || die "в релизе нет public/style.css"
[ -s "$SRC_DIR/public/app.js" ] || die "в релизе нет public/app.js"
[ -s "$SRC_DIR/lib/updater.js" ] || die "в релизе нет lib/updater.js"
[ -s "$SRC_DIR/lib/update-worker.js" ] || die "в релизе нет lib/update-worker.js"
[ -s "$SRC_DIR/package.json" ] || die "в релизе нет package.json"
[ -s "$APP_DIR/admin_pass.txt" ] || die "нет $APP_DIR/admin_pass.txt — остановлено, чтобы не потерять пароль"

OLD_VER="$("$NODE" -e 'process.stdout.write(require(process.argv[1]).version)' "$APP_DIR/package.json" 2>/dev/null || echo '?')"
NEW_VER="$("$NODE" -e 'process.stdout.write(require(process.argv[1]).version)' "$SRC_DIR/package.json")"
log "Обновление Servpanel: $OLD_VER -> $NEW_VER"
log "Каталог: $APP_DIR; pm2: $PM2_NAME; порт: $PORT"

# ---------------------------------------------------------------------------
# staging: копия релиза, чтобы ничего не менять в распакованном архиве
# ---------------------------------------------------------------------------
STAGE="$(mktemp -d /root/.servpanel-stage-XXXXXX)"
for item in server.js package.json package-lock.json public lib tests node_modules \
            README.md DEMO.md "ИЗМЕНЕНИЯ.md" "ОБНОВЛЕНИЕ-2.4.md" install.sh install_adguard_silent.sh \
            install_awg_stateful.sh install_warp_xray.sh warp-domains.txt update.sh LICENSE .gitignore; do
    if [ -e "$SRC_DIR/$item" ]; then
        cp -a "$SRC_DIR/$item" "$STAGE/$item"
    fi
done
[ -f "$STAGE/server.js" ] || die "staging не удался"
[ -f "$STAGE/public/app.js" ] || die "staging: нет public/app.js"

# ---------------------------------------------------------------------------
# зависимости: релиз везёт node_modules; если нет — ставим во временный каталог
# ---------------------------------------------------------------------------
if [ ! -f "$STAGE/node_modules/express/package.json" ] || [ ! -f "$STAGE/node_modules/qrcode/package.json" ]; then
    command -v npm >/dev/null 2>&1 || die "в релизе нет node_modules, а npm не найден"
    log "Ставлю зависимости во временный каталог…"
    if ! (cd "$STAGE" && npm ci --omit=dev --no-audit --no-fund --ignore-scripts >>"$LOG" 2>&1); then
        log "npm ci не сработал, пробую npm install…"
        (cd "$STAGE" && npm install --omit=dev --no-audit --no-fund --ignore-scripts >>"$LOG" 2>&1) ||
            die "не удалось установить зависимости; панель не изменена"
    fi
fi
[ -f "$STAGE/node_modules/express/package.json" ] || die "нет зависимости express; панель не изменена"
[ -f "$STAGE/node_modules/qrcode/package.json" ] || die "нет зависимости qrcode; панель не изменена"

# ---------------------------------------------------------------------------
# пробный запуск на копии данных и свободном порту
# ---------------------------------------------------------------------------
TEST_PORT=3998
while command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep ":${TEST_PORT} " >/dev/null; do
    TEST_PORT=$((TEST_PORT + 1))
    [ "$TEST_PORT" -lt 4100 ] || die "нет свободного тестового порта"
done

TEST_DATA="$(mktemp -d /root/.servpanel-test-XXXXXX)"
for f in admin_pass.txt .secrets.json .users.json .obf_profiles.json .notify.json \
         .backup.json .backup_pass .install_state.json; do
    if [ -e "$APP_DIR/$f" ]; then
        cp -a "$APP_DIR/$f" "$TEST_DATA/$f"
    fi
done
if [ -d "$APP_DIR/.sessions" ]; then
    cp -a "$APP_DIR/.sessions" "$TEST_DATA/.sessions" 2>/dev/null || true
fi
printf '%s' "$TEST_PORT" > "$TEST_DATA/.panel_port"
printf '%s' "$TEST_PORT" > "$TEST_DATA/.panel_public_port"

log "Пробный запуск новой версии на порту $TEST_PORT (данные — копия)…"
TEST_LOG="$TEST_DATA/test.log"
(
    cd "$STAGE" || exit 1
    exec env SERVEPANEL_DATA_DIR="$TEST_DATA" \
        PANEL_HOST=127.0.0.1 \
        PANEL_PORT="$TEST_PORT" \
        PANEL_PUBLIC_PORT="$TEST_PORT" \
        SERVEPANEL_TEST=1 \
        SERVEPANEL_AUDIT_LOG="$TEST_DATA/audit.log" \
        SERVEPANEL_AUTH_LOG="$TEST_DATA/auth.log" \
        SERVEPANEL_BACKUP_DIR="$TEST_DATA/backups" \
        "$NODE" server.js >"$TEST_LOG" 2>&1
) &
TEST_PID=$!

TEST_OK=0
for _ in $(seq 1 60); do
    if ! kill -0 "$TEST_PID" 2>/dev/null; then break; fi
    if TEST_BODY=$("$CURL" -fsS --max-time 2 "http://127.0.0.1:${TEST_PORT}/" 2>/dev/null); then
        case "$TEST_BODY" in
            *panel-version*) TEST_OK=1; break ;;
        esac
    fi
    sleep 0.4
done
kill "$TEST_PID" 2>/dev/null || true
wait "$TEST_PID" 2>/dev/null || true
TEST_PID=""
if [ "$TEST_OK" -ne 1 ]; then
    tail -n 50 "$TEST_LOG" 2>/dev/null || true
    die "новая версия не прошла пробный запуск; панель не изменена"
fi
log "Пробный запуск успешен."

# ---------------------------------------------------------------------------
# снимок системных конфигов (не восстанавливается автоматически)
# ---------------------------------------------------------------------------
CONFIG_BACKUP="$BACKUP_DIR/system-config-$STAMP.tar.gz"
{
    "$TAR" -czf "$CONFIG_BACKUP" -C / \
        etc/amnezia/amneziawg \
        root/awg \
        etc/systemd/system/awg-routing.service \
        etc/systemd/system/awg-routing.timer \
        etc/nginx/sites-enabled \
        etc/nginx/sites-available/awg-admin 2>/dev/null
} || true
if [ -s "$CONFIG_BACKUP" ]; then
    log "Снимок конфигов: $CONFIG_BACKUP"
fi

iptables-save > "$BACKUP_DIR/iptables-$STAMP.rules" 2>/dev/null || true
ipset save > "$BACKUP_DIR/ipset-$STAMP.txt" 2>/dev/null || true
ip rule show > "$BACKUP_DIR/ip-rule-$STAMP.txt" 2>/dev/null || true
hash_files() {
    for f in /etc/amnezia/amneziawg/*.conf /root/awg/awg-routing.sh; do
        if [ -f "$f" ]; then
            sha256sum "$f"
        fi
    done
}
hash_files > "$BACKUP_DIR/config-hashes-before-$STAMP.txt" 2>/dev/null || true

# ---------------------------------------------------------------------------
# остановка, бэкап панели, замена кода
# ---------------------------------------------------------------------------
log "Останавливаю панель…"
"$PM2" stop "$PM2_NAME" >/dev/null 2>&1 || true

BACKUP="$BACKUP_DIR/servpanel-pre-update-$STAMP.tar.gz"
log "Делаю бэкап панели: $BACKUP"
if ! "$TAR" -czf "$BACKUP" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")"; then
    log "Бэкап не создан — возвращаю старую панель"
    pm2_start || true
    die "обновление отменено: не удалось создать бэкап"
fi
[ -s "$BACKUP" ] || { pm2_start || true; die "обновление отменено: бэкап пустой"; }

restore_backup() {
    log "Останавливаю панель для отката…"
    "$PM2" stop "$PM2_NAME" >/dev/null 2>&1 || true
    if "$TAR" -xzf "$BACKUP" -C "$(dirname "$APP_DIR")"; then
        log "Файлы восстановлены из $BACKUP"
    else
        log "ВНИМАНИЕ: не удалось распаковать бэкап $BACKUP"
    fi
    pm2_start || true
    if health_generic; then
        log "Откат успешен, работает версия $OLD_VER"
    else
        log "ВНИМАНИЕ: после отката панель не ответила. Проверьте: $PM2 logs $PM2_NAME"
    fi
}

log "Заменяю файлы кода (данные и .git не трогаю)…"
apply_files() {
    for item in server.js package.json package-lock.json public lib tests node_modules \
                README.md DEMO.md "ИЗМЕНЕНИЯ.md" "ОБНОВЛЕНИЕ-2.4.md" install.sh install_adguard_silent.sh \
                install_awg_stateful.sh install_warp_xray.sh warp-domains.txt update.sh LICENSE .gitignore; do
        if [ -e "$STAGE/$item" ]; then
            rm -rf "${APP_DIR:?}/$item" || return 1
            cp -a "$STAGE/$item" "$APP_DIR/$item" || return 1
        fi
    done
    chmod 644 "$APP_DIR/server.js" 2>/dev/null || true
    chmod 600 "$APP_DIR/admin_pass.txt" "$APP_DIR/.secrets.json" 2>/dev/null || true
    chmod 700 "$APP_DIR/.sessions" 2>/dev/null || true
    return 0
}
if ! apply_files; then
    log "Ошибка при замене файлов — возвращаю старую версию"
    restore_backup
    die "обновление отменено: не удалось заменить файлы"
fi

# ---------------------------------------------------------------------------
# Nginx: исправляем Host только у сайта панели (нестандартный порт).
# ---------------------------------------------------------------------------
log "Проверяю Host в Nginx для сайта панели…"
if fix_panel_nginx_host; then
    :
else
    log "Nginx не изменён. Если панель на порту не 443 и вход даёт «чужой Origin»,"
    log "замените в $NGINX_PANEL_CONF строку Host \$host на Host \$http_host."
fi

# ---------------------------------------------------------------------------
# запуск и проверка
# ---------------------------------------------------------------------------
log "Запускаю панель…"
if ! pm2_start || ! health_ok; then
    log "Панель не ответила — откатываюсь…"
    restore_backup
    die "обновление отменено, выполнен откат"
fi

# ---------------------------------------------------------------------------
# проверка, что конфиги каскада не изменились
# ---------------------------------------------------------------------------
hash_files > "$BACKUP_DIR/config-hashes-after-$STAMP.txt" 2>/dev/null || true
if ! diff -q "$BACKUP_DIR/config-hashes-before-$STAMP.txt" \
             "$BACKUP_DIR/config-hashes-after-$STAMP.txt" >/dev/null 2>&1; then
    log "ВНИМАНИЕ: хэши конфигов AWG/awg-routing.sh отличаются. Проверьте:"
    log "  diff $BACKUP_DIR/config-hashes-before-$STAMP.txt $BACKUP_DIR/config-hashes-after-$STAMP.txt"
else
    log "Проверка конфигов: /etc/amnezia/amneziawg/*.conf и awg-routing.sh не изменены."
fi

# Если файлы кода после установки полностью совпадают с origin/main, приводим
# индекс .git к этому коммиту. Тогда встроенное GitHub-обновление снова видит
# чистое дерево. Если есть отличия (например, релиз ещё не опубликован или
# остались ручные правки), ничего не сбрасываем.
sync_git_if_clean() {
    command -v git >/dev/null 2>&1 || return 0
    [ -d "$APP_DIR/.git" ] || return 0
    local origin_url branch
    origin_url="$(git -C "$APP_DIR" remote get-url origin 2>/dev/null || true)"
    case "$origin_url" in
        *makar19977v-glitch/servpanel*) ;;
        *) return 0 ;;
    esac
    branch="$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    [ "$branch" = "main" ] || return 0
    if ! git -C "$APP_DIR" fetch --prune origin main >>"$LOG" 2>&1; then
        log "Git: не удалось проверить origin/main, .git оставлен без изменений."
        return 0
    fi
    if git -C "$APP_DIR" diff --quiet origin/main -- 2>/dev/null; then
        if git -C "$APP_DIR" reset --hard origin/main >>"$LOG" 2>&1; then
            log "Git: рабочее дерево синхронизировано с origin/main."
        fi
    else
        log "Git: код отличается от origin/main — автосинхронизация пропущена."
        log "     Обновление из панели доступно кнопкой сброса локальных изменений."
    fi
}
sync_git_if_clean || true

log "ГОТОВО. Версия: $NEW_VER"
log "Бэкап панели: $BACKUP"
log "Откат: sudo bash $SRC_DIR/upgrade.sh --rollback $BACKUP"
log "Журнал: $LOG"
