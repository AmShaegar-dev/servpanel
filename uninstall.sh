#!/bin/bash
# Servpanel — вызов удаления из консоли:
#   bash /root/servpanel/uninstall.sh              — меню
#   ACTION=panel bash uninstall.sh                 — только панель
#   ACTION=full  bash uninstall.sh                 — полная очистка (спросит DELETE)
#   ACTION=full CONFIRM=DELETE bash uninstall.sh   — без вопросов
set -uo pipefail

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

PANEL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo /root/servpanel)"

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    echo -e "${RED}Нужны права root: sudo bash $PANEL_DIR/uninstall.sh${NC}"
    exit 1
fi

ask() {
    local question="$1" answer=""
    if [ -r /dev/tty ]; then
        read -r -p "$question: " answer < /dev/tty
    fi
    echo "$answer"
}

ACTION="${ACTION:-}"
if [ -z "$ACTION" ]; then
    echo -e "${CYAN}=================================================${NC}"
    echo -e "${RED}            Servpanel — удаление${NC}"
    echo -e "${CYAN}=================================================${NC}"
    echo "1) Только панель — службы и VPN-клиенты остаются"
    echo "2) Полная очистка — панель, AmneziaWG, AdGuard, WARP/Xray, MTProto-прокси"
    echo "3) Выход"
    case "$(ask 'Ваш выбор (1/2/3)')" in
        1) ACTION=panel ;;
        2) ACTION=full ;;
        *) exit 0 ;;
    esac
fi

case "$ACTION" in
    panel) ;;
    full)
        CONFIRM="${CONFIRM:-}"
        if [ "$CONFIRM" != "DELETE" ]; then
            echo -e "${RED}Будут удалены панель, все VPN-клиенты, AdGuard, WARP/Xray и MTProto-прокси.${NC}"
            CONFIRM="$(ask 'Для подтверждения введите DELETE')"
        fi
        ;;
    *)
        echo -e "${RED}Неизвестное действие: $ACTION (нужно panel или full).${NC}"
        exit 1
        ;;
esac

PANEL_DIR="$PANEL_DIR" ACTION="$ACTION" CONFIRM="${CONFIRM:-}" SELF_PATH="$PANEL_DIR/lib/server-admin.sh" \
    bash "$PANEL_DIR/lib/server-admin.sh"
