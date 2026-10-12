#!/bin/bash
set -e

LOG_FILE="/var/log/awg_install.log"
INSTALLER_URL="https://raw.githubusercontent.com/bivlked/amneziawg-installer/main/install_amneziawg.sh"

# --- СИСТЕМА АВТОВОЗОБНОВЛЕНИЯ ПОСЛЕ ПЕРЕЗАГРУЗКИ ---
STATE_ENV="/root/awg_install_params.env"
WRAPPER_SCRIPT="/root/awg_installer_wrapper.sh"
CRON_FILE="/etc/cron.d/awg_resume"

# Если файл состояния существует, значит мы проснулись после ребута
if [ -f "$STATE_ENV" ]; then
    echo "=== [Авто-продолжение] Восстановление после перезагрузки... ==="
    source "$STATE_ENV"
else
    echo "=== СТАРТ УСТАНОВКИ AMNEZIAWG (Через Панель) ==="
    # Сохраняем настройки панели и переданные флаги в файл
    env | grep -E '^(AWG_|PANEL_PORT)' > "$STATE_ENV" || true
    # Копируем этот скрипт, чтобы он не удалился панелью
    cp "$0" "$WRAPPER_SCRIPT"
    chmod +x "$WRAPPER_SCRIPT"
    # Создаем задачу для автоматического запуска после перезагрузки
    echo "@reboot root bash $WRAPPER_SCRIPT >> $LOG_FILE 2>&1" > "$CRON_FILE"
fi

PORT_TO_OPEN="${PANEL_PORT:-4444}"
echo "Проверка портов панели (${PORT_TO_OPEN}, 80, 443, 22, 2233, 4443)..."
if command -v ufw >/dev/null 2>&1; then
    sudo ufw allow ${PORT_TO_OPEN}/tcp >/dev/null 2>&1 || true
    sudo ufw allow 80/tcp >/dev/null 2>&1 || true
    sudo ufw allow 443/tcp >/dev/null 2>&1 || true
    sudo ufw allow 22/tcp >/dev/null 2>&1 || true
    sudo ufw allow 2233/tcp >/dev/null 2>&1 || true
fi

echo "Скачиваем оригинальный скрипт AmneziaWG..."
curl -fsSL "$INSTALLER_URL" -o /root/install_amneziawg.sh
chmod +x /root/install_amneziawg.sh

INSTALL_CMD="sudo bash /root/install_amneziawg.sh --yes"

[ -n "$AWG_VERSION" ] && INSTALL_CMD="$INSTALL_CMD --protocol $AWG_VERSION"
[ -n "$AWG_PRESET" ] && [ "$AWG_PRESET" != "default" ] && INSTALL_CMD="$INSTALL_CMD --preset=$AWG_PRESET"

if [ "$AWG_ROUTE" = "amnezia" ]; then
    INSTALL_CMD="$INSTALL_CMD --route-amnezia"
elif [ "$AWG_ROUTE" = "custom" ] && [ -n "$AWG_CUSTOM_ROUTE" ]; then
    INSTALL_CMD="$INSTALL_CMD --route-custom=$AWG_CUSTOM_ROUTE"
else
    INSTALL_CMD="$INSTALL_CMD --route-all"
fi

if [ "$AWG_IPV6" = "allow" ]; then
    INSTALL_CMD="$INSTALL_CMD --allow-ipv6"
elif [ "$AWG_IPV6" = "tunnel" ]; then
    INSTALL_CMD="$INSTALL_CMD --allow-ipv6-tunnel"
else
    INSTALL_CMD="$INSTALL_CMD --disallow-ipv6"
fi

[ -n "$AWG_ISOLATION" ] && INSTALL_CMD="$INSTALL_CMD --isolation=$AWG_ISOLATION"
[ -n "$AWG_PORT" ] && INSTALL_CMD="$INSTALL_CMD --port=$AWG_PORT"
[ "$AWG_KEEP_PACKAGES" = "1" ] && INSTALL_CMD="$INSTALL_CMD --keep-packages"
[ "$AWG_NO_TWEAKS" = "1" ] && INSTALL_CMD="$INSTALL_CMD --no-tweaks"

echo "Команда: $INSTALL_CMD"
echo "--- Вывод установщика ---"

# Запускаем установку. При ребуте этот процесс будет убит системой.
eval "$INSTALL_CMD"

# Этот блок выполнится только когда установщик полностью закончит работу без ребутов
if grep -q "Установка завершена" "$LOG_FILE" || grep -q "Installation complete" "$LOG_FILE"; then
    echo "=== INSTALLATION DONE ==="
    if command -v ufw >/dev/null 2>&1; then
        sudo ufw allow ${PORT_TO_OPEN}/tcp >/dev/null 2>&1 || true
    fi
    # Убираем за собой следы авто-возобновления
    rm -f /root/install_amneziawg.sh
    rm -f "$STATE_ENV"
    rm -f "$CRON_FILE"
    rm -f "$WRAPPER_SCRIPT"
fi
