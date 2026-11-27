#!/bin/bash
# Servpanel — запуск установки или удаления.
#
#   curl -fsSL https://raw.githubusercontent.com/AmShaegar-dev/servpanel/main/install.sh | sudo bash
#
# Скрипт показывает меню:
#   [1] Установить панель
#   [2] Удалить панель: «только панель» либо «полная очистка» с компонентами
#   [3] Выход
#
# Без вопросов (для автоматизации):
#   ACTION=install  — установка
#   ACTION=panel    — удалить только панель
#   ACTION=full     — полная очистка сервера от панели и служб
#   ACTION=uninstall — меню удаления
#
# Скрипт не хранит код панели: установщик и удаление лежат в серверной части
# (lib/server-admin.sh) и скачиваются по требованию.
set -uo pipefail

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    echo -e "${RED}Нужны права root. Запустите: curl -fsSL …/install.sh | sudo bash${NC}"
    exit 1
fi

# ---------------------------------------------------------------------------
# Источник кода: локальный каталог (если скрипт запущен из архива) или main.
# ---------------------------------------------------------------------------
SRC_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
fi

RAW_BASE="${SERVEPANEL_RAW_BASE:-https://raw.githubusercontent.com/AmShaegar-dev/servpanel/main}"
CDN_BASE="${SERVEPANEL_CDN_BASE:-https://cdn.jsdelivr.net/gh/AmShaegar-dev/servpanel@main}"
RELEASE_REPO="${SERVEPANEL_RELEASE_REPO:-https://github.com/AmShaegar-dev/servpanel}"
TMP_FILE="$(mktemp /tmp/servpanel-admin-XXXXXX.sh)"
SRC_TMP_DIR=""

cleanup() {
    rm -f "$TMP_FILE"
    [ -n "$SRC_TMP_DIR" ] && rm -rf "$SRC_TMP_DIR"
}
trap cleanup EXIT

download_part() {
    # Явные и короткие таймауты: raw.githubusercontent.com периодически
    # блокируется, и без них установка выглядит зависшей.
    curl -4 -fsSL --connect-timeout 4 --max-time 12 \
        -o "$TMP_FILE" "$1" >/dev/null 2>&1 && [ -s "$TMP_FILE" ]
}

fetch_release_source() {
    # Резервный источник: готовый архив последнего GitHub Release.
    # Внутри уже лежат lib/*.sh, поэтому отдельные запросы к raw не нужны.
    [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/lib/server-install.sh" ] && return 0

    local archive url top
    SRC_TMP_DIR="$(mktemp -d /tmp/servpanel-src-XXXXXX)" || return 1
    archive="$SRC_TMP_DIR/servpanel.tar.gz"
    url="${RELEASE_REPO}/releases/latest/download/servpanel-latest.tar.gz"

    echo -e "${YELLOW}Загрузка архива последнего релиза с GitHub...${NC}" >&2
    if ! curl -4 -fL --connect-timeout 10 --max-time 180 --retry 1 --retry-delay 1 \
        -o "$archive" "$url" >/dev/null 2>&1 || [ ! -s "$archive" ]; then
        rm -rf "$SRC_TMP_DIR"
        SRC_TMP_DIR=""
        return 1
    fi
    if ! tar -xzf "$archive" -C "$SRC_TMP_DIR" >/dev/null 2>&1; then
        rm -rf "$SRC_TMP_DIR"
        SRC_TMP_DIR=""
        return 1
    fi
    top="$(find "$SRC_TMP_DIR" -maxdepth 1 -mindepth 1 -type d -print -quit 2>/dev/null)"
    if [ -z "$top" ] || [ ! -f "$top/lib/server-install.sh" ]; then
        rm -rf "$SRC_TMP_DIR"
        SRC_TMP_DIR=""
        return 1
    fi
    SRC_DIR="$top"
    echo -e "${GREEN}Архив релиза загружен.${NC}" >&2
    return 0
}

load_part() {
    local name="$1"
    local local_file="$SRC_DIR/lib/$name"
    if [ -n "$SRC_DIR" ] && [ -f "$local_file" ]; then
        cat "$local_file"
        return 0
    fi

    echo -e "${YELLOW}Загрузка ${name}...${NC}" >&2
    # Сначала CDN: он доступен там, где raw.githubusercontent.com заблокирован.
    if download_part "${CDN_BASE}/lib/${name}"; then
        cat "$TMP_FILE"
        return 0
    fi
    if [[ "$RAW_BASE" != "$CDN_BASE" ]] && download_part "${RAW_BASE}/lib/${name}"; then
        cat "$TMP_FILE"
        return 0
    fi
    # Последний шанс — целиком архив последнего релиза.
    if fetch_release_source && [ -f "$SRC_DIR/lib/$name" ]; then
        cat "$SRC_DIR/lib/$name"
        return 0
    fi

    echo -e "${RED}Не удалось скачать ${name}.${NC}" >&2
    echo -e "Проверьте доступ к GitHub Releases или скачайте архив релиза" >&2
    echo -e "и запустите install.sh из распакованного каталога." >&2
    exit 1
}

# Восстанавливаем tty: после веб-консолей и raw-режима Enter не доходит
# до read, и установка выглядит зависшей на первом вопросе.
if [ -r /dev/tty ]; then
    stty sane < /dev/tty 2>/dev/null || true
fi

ask() {
    # ask "вопрос" "значение по умолчанию" -> печатает ответ
    local question="$1" def="${2:-}" answer=""
    if [ -t 0 ] && [ -r /dev/tty ]; then
        if [ -n "$def" ]; then
            read -r -p "$question [$def]: " answer < /dev/tty
        else
            read -r -p "$question: " answer < /dev/tty
        fi
    elif [ -r /dev/tty ]; then
        if [ -n "$def" ]; then
            read -r -p "$question [$def]: " answer < /dev/tty
        else
            read -r -p "$question: " answer < /dev/tty
        fi
    fi
    echo "${answer:-$def}"
}

show_header() {
    echo -e "${CYAN}=================================================${NC}"
    echo -e "${GREEN}              Servpanel${NC}"
    echo -e "${CYAN}=================================================${NC}"
}

main_menu() {
    show_header
    echo -e "1) ${BOLD}Установить панель${NC}"
    echo -e "2) ${BOLD}Удалить панель${NC}"
    echo "3) Выход"
    echo
    case "$(ask 'Ваш выбор (1/2/3)' '1')" in
        1) ACTION=install ;;
        2) ACTION=uninstall ;;
        3) exit 0 ;;
        *) echo -e "${RED}Нужно выбрать 1, 2 или 3.${NC}"; exit 1 ;;
    esac
}

uninstall_menu() {
    echo
    echo -e "${CYAN}Что удаляем?${NC}"
    echo "1) Только панель — службы и VPN-клиенты остаются на сервере"
    echo "2) Полная очистка — панель, AmneziaWG, AdGuard, WARP/Xray, MTProto-прокси"
    echo "3) Назад"
    echo
    case "$(ask 'Ваш выбор (1/2/3)' '3')" in
        1) ACTION=panel ;;
        2) ACTION=full ;;
        3) main_menu ;;
        *) echo -e "${RED}Нужно выбрать 1, 2 или 3.${NC}"; exit 1 ;;
    esac
}

ACTION="${ACTION:-}"
if [ -z "$ACTION" ]; then
    if [ -t 0 ] || [ -r /dev/tty ]; then
        main_menu
        if [ "$ACTION" = "uninstall" ]; then
            uninstall_menu
        fi
    else
        # Нет терминала (curl | bash без tty) — по умолчанию установка.
        ACTION=install
    fi
fi

# Если install.sh запущен из curl (рядом нет lib/), сразу берём полный
# архив последнего релиза: так установка не зависит от raw и git clone.
if [ -z "$SRC_DIR" ] || [ ! -f "$SRC_DIR/lib/server-install.sh" ]; then
    fetch_release_source || true
fi

case "$ACTION" in
    install)
        export SRC_DIR_OVERRIDE="$SRC_DIR"
        load_part server-install.sh | SRC_DIR_OVERRIDE="$SRC_DIR" bash -s
        ;;
    panel|full|uninstall)
        [ "$ACTION" = "uninstall" ] && ACTION=panel
        if [ "$ACTION" = "full" ]; then
            echo
            echo -e "${RED}Полная очистка удалит панель, все VPN-клиенты, AdGuard, WARP/Xray и MTProto-прокси.${NC}"
            echo -e "${RED}Резервная копия данных панели сохранится в /root/backups. Отменить это нельзя.${NC}"
            echo
            if [ "$(ask 'Для подтверждения введите DELETE' '')" != "DELETE" ]; then
                echo "Отменено — сервер не изменён."
                exit 0
            fi
            export CONFIRM=DELETE
        fi
        # Копия скрипта: полная очистка вызывает его же для каждого компонента.
        cp "$TMP_FILE" "${TMP_FILE%.sh}-admin.sh"
        export SELF_PATH="${TMP_FILE%.sh}-admin.sh"
        load_part server-admin.sh | SELF_PATH="$SELF_PATH" ACTION="$ACTION" CONFIRM="${CONFIRM:-}" bash -s
        rm -f "$SELF_PATH"
        exit 0
        ;;
    *)
        echo -e "${RED}Неизвестное действие: $ACTION (нужно install, panel, full).${NC}"
        exit 1
        ;;
esac
