#!/bin/bash
set -e

LOG_FILE="/var/log/awg_install.log"
INSTALLER_URL="https://raw.githubusercontent.com/bivlked/amneziawg-installer/main/install_amneziawg.sh"

echo "=== СТАРТ УСТАНОВКИ AMNEZIAWG (Через Панель) ===" | tee -a "$LOG_FILE"

# Защищаем порты панели ДО запуска установщика (если UFW активен)
if command -v ufw >/dev/null 2>&1; then
    sudo ufw allow 3000/tcp >/dev/null 2>&1 || true
    sudo ufw allow 80/tcp >/dev/null 2>&1 || true
    sudo ufw allow 443/tcp >/dev/null 2>&1 || true
fi

echo "Скачиваем оригинальный скрипт AmneziaWG..." | tee -a "$LOG_FILE"
curl -fsSL "$INSTALLER_URL" -o /root/install_amneziawg.sh
chmod +x /root/install_amneziawg.sh

# Формируем команду запуска
INSTALL_CMD="sudo bash /root/install_amneziawg.sh --yes"

# Версия и Пресет
[ -n "$AWG_VERSION" ] && INSTALL_CMD="$INSTALL_CMD --protocol $AWG_VERSION"
[ -n "$AWG_PRESET" ] && [ "$AWG_PRESET" != "default" ] && INSTALL_CMD="$INSTALL_CMD --preset=$AWG_PRESET"

# Маршрутизация IPv4
if [ "$AWG_ROUTE" = "amnezia" ]; then
    INSTALL_CMD="$INSTALL_CMD --route-amnezia"
elif [ "$AWG_ROUTE" = "custom" ] && [ -n "$AWG_CUSTOM_ROUTE" ]; then
    INSTALL_CMD="$INSTALL_CMD --route-custom=$AWG_CUSTOM_ROUTE"
else
    INSTALL_CMD="$INSTALL_CMD --route-all" # По умолчанию
fi

# Настройки IPv6
if [ "$AWG_IPV6" = "allow" ]; then
    INSTALL_CMD="$INSTALL_CMD --allow-ipv6"
elif [ "$AWG_IPV6" = "tunnel" ]; then
    INSTALL_CMD="$INSTALL_CMD --allow-ipv6-tunnel"
else
    INSTALL_CMD="$INSTALL_CMD --disallow-ipv6" # По умолчанию
fi

# Изоляция и Порт
[ -n "$AWG_ISOLATION" ] && INSTALL_CMD="$INSTALL_CMD --isolation=$AWG_ISOLATION"
[ -n "$AWG_PORT" ] && INSTALL_CMD="$INSTALL_CMD --port=$AWG_PORT"

# Твики и пакеты
[ "$AWG_KEEP_PACKAGES" = "1" ] && INSTALL_CMD="$INSTALL_CMD --keep-packages"
[ "$AWG_NO_TWEAKS" = "1" ] && INSTALL_CMD="$INSTALL_CMD --no-tweaks"

echo "Сформированная команда: $INSTALL_CMD" | tee -a "$LOG_FILE"
echo "--- Вывод установщика ---" | tee -a "$LOG_FILE"

# Запускаем оригинальный скрипт
$INSTALL_CMD >> "$LOG_FILE" 2>&1

# Проверка завершения
if grep -q "Установка завершена" "$LOG_FILE" || grep -q "Installation complete" "$LOG_FILE"; then
    echo "=== INSTALLATION DONE ===" | tee -a "$LOG_FILE"
    if command -v ufw >/dev/null 2>&1; then
        sudo ufw allow 3000/tcp >/dev/null 2>&1 || true
    fi
    rm -f /root/install_amneziawg.sh
fi
