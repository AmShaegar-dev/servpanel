#!/bin/bash
# Servpanel — удаление из консоли. Вызывается из install.sh.
#
#   ACTION=panel  — удалить только панель (службы, VPN-клиенты и прокси остаются)
#   ACTION=full   — полная очистка: панель + AmneziaWG, AdGuard, WARP/Xray,
#                   MTProto-прокси (Telemt/MTProxyL/MTProto.zig), их данные и
#                   правила UFW для их портов. Требует CONFIRM=DELETE.
#
# Nginx, certbot, fail2ban и UFW не удаляются в режиме «только панель»:
# ими могут пользоваться другие сайты на сервере.
set -uo pipefail

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

say()  { echo -e "$*"; }
step() { echo -e "\n${CYAN}$*${NC}"; }
warn() { echo -e "${YELLOW}$*${NC}"; }
ok()   { echo -e "${GREEN}$*${NC}"; }

ACTION="${ACTION:-panel}"
CONFIRM="${CONFIRM:-}"
PANEL_DIR="${PANEL_DIR:-/root/servpanel}"
ROOT_USER_HOME="${HOME:-/root}"

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    echo -e "${RED}Нужны права root.${NC}"
    exit 1
fi

if [ "$ACTION" = "full" ] && [ "$CONFIRM" != "DELETE" ]; then
    echo -e "${RED}Полная очистка требует подтверждения: CONFIRM=DELETE.${NC}"
    exit 1
fi
if [ "$ACTION" != "panel" ] && [ "$ACTION" != "full" ]; then
    echo -e "${RED}Неизвестный режим удаления: $ACTION${NC}"
    exit 1
fi

say ""
if [ "$ACTION" = "full" ]; then
    say "${RED}Полная очистка Servpanel${NC}: панель и все установленные службы."
else
    say "${YELLOW}Удаление Servpanel${NC}: панель и её служба. VPN-клиенты и прокси останутся."
fi

# ---------------------------------------------------------------------------
# Резервная копия данных панели (сессии, пароли, настройки) — всегда.
# ---------------------------------------------------------------------------
BACKUP_DIR="/root/backups"
BACKUP_FILE=""
if [ -d "$PANEL_DIR" ]; then
    mkdir -p "$BACKUP_DIR"
    chmod 700 "$BACKUP_DIR" 2>/dev/null || true
    BACKUP_FILE="$BACKUP_DIR/servpanel-before-remove-$(date +%Y%m%d-%H%M%S).tar.gz"
    step "[1/5] Резервная копия данных панели"
    if tar -czf "$BACKUP_FILE" -C "$PANEL_DIR" \
        .secrets.json .users.json .proxybot.json .notify.json .backup.json .backup_pass \
        .app_settings.json .app .sessions admin_pass.txt .panel_port .panel_public_port \
        .install_state.json 2>/dev/null; then
        chmod 600 "$BACKUP_FILE"
        ok "Сохранено: $BACKUP_FILE"
    else
        # Файлов могло не быть — архив всё равно создаём с тем, что есть.
        tar -czf "$BACKUP_FILE" -C "$PANEL_DIR" . 2>/dev/null || true
        chmod 600 "$BACKUP_FILE" 2>/dev/null || true
        [ -s "$BACKUP_FILE" ] && ok "Сохранено: $BACKUP_FILE"
    fi
else
    warn "Каталог $PANEL_DIR не найден — данных панели нет."
fi

# ---------------------------------------------------------------------------
# Удаление служб по отдельности (--component). Полная очистка вызывает этот
# же скрипт для каждого компонента, поэтому логика удаления одна.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--component" ]; then
    component="${2:-}"
    case "$component" in
        awg)
            if [ -f /root/install_amneziawg.sh ]; then
                bash /root/install_amneziawg.sh --uninstall --yes >/dev/null 2>&1 || true
            fi
            for iface in awg0 awg1 amn0; do
                systemctl stop "awg-quick@$iface" >/dev/null 2>&1 || true
                systemctl disable "awg-quick@$iface" >/dev/null 2>&1 || true
            done
            systemctl stop awg-routing.timer awg-routing.service >/dev/null 2>&1 || true
            systemctl disable awg-routing.timer >/dev/null 2>&1 || true
            rm -f /etc/systemd/system/awg-routing.service /etc/systemd/system/awg-routing.timer
            rm -rf /etc/amnezia /root/awg_domain.txt
            exit 0
            ;;
        adguard)
            systemctl stop AdGuardHome >/dev/null 2>&1 || true
            systemctl disable AdGuardHome >/dev/null 2>&1 || true
            [ -x /opt/AdGuardHome/AdGuardHome ] && /opt/AdGuardHome/AdGuardHome --service stop >/dev/null 2>&1
            if command -v snap >/dev/null 2>&1 && snap list 2>/dev/null | grep -q '^adguard-home'; then
                snap remove adguard-home >/dev/null 2>&1 || true
            fi
            rm -f /etc/systemd/system/AdGuardHome.service /usr/lib/systemd/system/AdGuardHome.service \
                  /lib/systemd/system/AdGuardHome.service
            rm -rf /opt/AdGuardHome /var/snap/adguard-home /etc/AdGuardHome
            rm -f /usr/bin/AdGuardHome /usr/local/bin/AdGuardHome
            rm -f /etc/systemd/resolved.conf.d/servpanel-adguard.conf
            exit 0
            ;;
        warp)
            if grep -q '"tag"[[:space:]]*:[[:space:]]*"warp"' /usr/local/etc/xray/config.json 2>/dev/null; then
                systemctl stop xray >/dev/null 2>&1 || true
                systemctl disable xray >/dev/null 2>&1 || true
                rm -rf /usr/local/etc/xray /var/log/xray
            fi
            systemctl stop warp-svc >/dev/null 2>&1 || true
            systemctl disable warp-svc >/dev/null 2>&1 || true
            command -v warp-cli >/dev/null 2>&1 && warp-cli --accept-tos registration delete >/dev/null 2>&1
            if command -v dpkg >/dev/null 2>&1 && dpkg -s cloudflare-warp >/dev/null 2>&1; then
                DEBIAN_FRONTEND=noninteractive apt-get purge -y cloudflare-warp >/dev/null 2>&1 || true
            fi
            rm -f /etc/apt/sources.list.d/cloudflare-client.list \
                  /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
            exit 0
            ;;
        mtproto)
            for unit in mtproxyl-api mtproxyl mtproto.zig mtproto-zig mtg telemt mtproto; do
                systemctl stop "$unit" >/dev/null 2>&1 || true
                systemctl disable "$unit" >/dev/null 2>&1 || true
            done
            if command -v docker >/dev/null 2>&1; then
                for c in $(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -Ei 'telemt|mtproto|mtg|mtproxyl' || true); do
                    docker rm -f "$c" >/dev/null 2>&1 || true
                done
            fi
            command -v mtproxyl >/dev/null 2>&1 && mtproxyl api uninstall >/dev/null 2>&1
            rm -rf /etc/telemt /opt/telemt /etc/mtproxyl /opt/mtproxyl /etc/mtproxyl-api \
                   /opt/mtproto.zig /etc/mtproto.zig /etc/sudoers.d/mtproxyl-api
            rm -f /usr/local/bin/telemt /usr/local/bin/mtproxyl /usr/local/bin/mtproxyl-api \
                  /usr/local/bin/mtg /usr/local/bin/mtproto.zig
            exit 0
            ;;
        *)
            echo "Неизвестный компонент: $component" >&2
            exit 2
            ;;
    esac
fi

# ---------------------------------------------------------------------------
# Удаление служб (только полная очистка).
# ---------------------------------------------------------------------------
remove_services() {
    step "[2/5] Удаление установленных служб"
    local self="$PANEL_DIR/lib/server-admin.sh"
    if [ ! -f "$self" ]; then
        # Скрипт запущен через curl — берём его копию из временного файла.
        self="${SELF_PATH:-}"
    fi
    for component in awg adguard warp mtproto; do
        if [ -n "$self" ] && [ -f "$self" ]; then
            bash "$self" --component "$component"
        else
            warn "Нет $self — компонент $component пропущен, удалите его из панели до удаления."
        fi
    done

    # Правила UFW для служб: 853 открывали только под AdGuard.
    if command -v ufw >/dev/null 2>&1; then
        ufw delete allow 853/tcp >/dev/null 2>&1 || true
        for port in $(grep -hoE 'ListenPort[[:space:]]*=[[:space:]]*[0-9]+' /etc/amnezia/amneziawg/*.conf 2>/dev/null | grep -oE '[0-9]+$'); do
            ufw delete allow "$port/udp" >/dev/null 2>&1 || true
        done
    fi
}

# ---------------------------------------------------------------------------
# Удаление самой панели.
# ---------------------------------------------------------------------------
remove_panel() {
    step "[3/5] Остановка и удаление панели"
    pm2 delete awg-admin >/dev/null 2>&1 || true
    pm2 save >/dev/null 2>&1 || true
    pm2 unstartup >/dev/null 2>&1 || true
    pm2 kill >/dev/null 2>&1 || true

    # Юнит pm2 мог остаться и перезапускать пустой список.
    if systemctl list-unit-files 2>/dev/null | grep -q '^pm2-root.service'; then
        systemctl stop pm2-root >/dev/null 2>&1 || true
        systemctl disable pm2-root >/dev/null 2>&1 || true
        rm -f /etc/systemd/system/pm2-root.service
        systemctl daemon-reload >/dev/null 2>&1 || true
    fi

    # Порт панели в UFW: читаем до удаления каталога.
    if command -v ufw >/dev/null 2>&1 && [ -d "$PANEL_DIR" ]; then
        for f in "$PANEL_DIR/.panel_public_port" "$PANEL_DIR/.panel_port"; do
            [ -f "$f" ] || continue
            local port
            port="$(tr -dc '0-9' < "$f" | head -c 6)"
            [ -n "$port" ] && ufw delete allow "$port/tcp" >/dev/null 2>&1 || true
        done
    fi

    rm -rf "$PANEL_DIR"

    # Остатки: pm2-каталоги и настройки панели в домашнем каталоге root.
    rm -rf "$ROOT_USER_HOME/.pm2"
    rm -f /root/.servpanel-mtproxyl.key
}

remove_shared_stack() {
    step "[4/5] Удаление общих пакетов и правил"
    if command -v pm2 >/dev/null 2>&1; then
        npm remove -g pm2 >/dev/null 2>&1 || true
    fi
    rm -f /etc/fail2ban/jail.d/servpanel.local /etc/fail2ban/filter.d/servpanel.conf
    if systemctl list-unit-files 2>/dev/null | grep -q '^fail2ban.service'; then
        systemctl restart fail2ban >/dev/null 2>&1 || true
    fi
    rm -f /etc/logrotate.d/servpanel
    rm -f /var/log/servpanel_auth.log /var/log/awg_audit.log
    if command -v ufw >/dev/null 2>&1; then
        ufw delete allow 22/tcp >/dev/null 2>&1 || true
    fi
}

remove_nginx_site() {
    # Конфиг Nginx и сертификат ставились только для доступа по домену.
    step "[5/5] Конфиг Nginx для панели"
    if [ -f /etc/nginx/sites-available/awg-admin ]; then
        local domain
        domain="$(awk '/^[[:space:]]*server_name/ {print $2; exit}' /etc/nginx/sites-available/awg-admin | tr -d ';' )"
        rm -f /etc/nginx/sites-enabled/awg-admin /etc/nginx/sites-available/awg-admin
        if [ -n "$domain" ] && command -v certbot >/dev/null 2>&1; then
            certbot delete --cert-name "$domain" --non-interactive >/dev/null 2>&1 || true
            say "Удалён сайт Nginx и сертификат для $domain."
        else
            say "Удалён сайт Nginx awg-admin."
        fi
        nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true
    else
        say "Конфига Nginx от панели нет — пропускаем."
    fi
}

if [ "$ACTION" = "full" ]; then
    remove_services
else
    step "[2/5] Службы"
    say "Оставляем: AmneziaWG, AdGuard, WARP/Xray, MTProto-прокси и их данные."
fi
remove_panel
remove_shared_stack
remove_nginx_site

say ""
ok "================================================="
if [ "$ACTION" = "full" ]; then
    ok "  Полная очистка завершена"
else
    ok "  Панель удалена"
fi
ok "================================================="
[ -n "$BACKUP_FILE" ] && say "Резервная копия: $BACKUP_FILE"
if [ "$ACTION" = "full" ]; then
    say "Удалены: панель, AmneziaWG, AdGuard, WARP/Xray, MTProto-прокси."
else
    say "VPN-клиенты, прокси и AdGuard остались на сервере."
    say "Удалить их тоже: повторите install.sh и выберите «Полная очистка»."
fi
say ""
say "Поставить панель заново:"
say "  curl -fsSL https://raw.githubusercontent.com/AmShaegar-dev/servpanel/main/install.sh | sudo bash"
exit 0
