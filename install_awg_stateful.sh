#!/bin/bash
set -e

LOG_FILE="/var/log/awg_install.log"
INSTALLER_URL="https://raw.githubusercontent.com/bivlked/amneziawg-installer/main/install_amneziawg.sh"

echo "=== СТАРТ УСТАНОВКИ AMNEZIAWG (Через Панель) ===" | tee -a "$LOG_FILE"
echo "Версия: ${AWG_VERSION:-2.0}" | tee -a "$LOG_FILE"

# Защищаем порты панели ДО запуска установщика (если UFW активен)
echo "Проверка портов панели (3000, 80, 443)..." | tee -a "$LOG_FILE"
if command -v ufw >/dev/null 2>&1; then
    sudo ufw allow 3000/tcp >/dev/null 2>&1 || true
    sudo ufw allow 80/tcp >/dev/null 2>&1 || true
    sudo ufw allow 443/tcp >/dev/null 2>&1 || true
fi

# Скачиваем оригинальный установщик
echo "Скачиваем оригинальный скрипт AmneziaWG..." | tee -a "$LOG_FILE"
curl -fsSL "$INSTALLER_URL" -o /root/install_amneziawg.sh
chmod +x /root/install_amneziawg.sh

# Формируем команду запуска
# --yes отключает интерактивные вопросы
INSTALL_CMD="sudo bash /root/install_amneziawg.sh --yes"

if [ -n "$AWG_VERSION" ]; then
    INSTALL_CMD="$INSTALL_CMD --protocol $AWG_VERSION"
fi

if [ "$AWG_KEEP_PACKAGES" = "1" ]; then
    echo "Флаг: Сохранение системных пакетов (--keep-packages)" | tee -a "$LOG_FILE"
    INSTALL_CMD="$INSTALL_CMD --keep-packages"
fi

if [ "$AWG_NO_TWEAKS" = "1" ]; then
    echo "Флаг: Без UFW/Fail2Ban (--no-tweaks)" | tee -a "$LOG_FILE"
    INSTALL_CMD="$INSTALL_CMD --no-tweaks"
fi

echo "Сформированная команда: $INSTALL_CMD" | tee -a "$LOG_FILE"
echo "--- Вывод установщика ---" | tee -a "$LOG_FILE"

# Запускаем оригинальный скрипт.
# Мы не используем eval, чтобы избежать проблем с кавычками.
$INSTALL_CMD >> "$LOG_FILE" 2>&1

# Проверка завершения
if grep -q "Установка завершена" "$LOG_FILE" || grep -q "Installation complete" "$LOG_FILE"; then
    echo "=== INSTALLATION DONE ===" | tee -a "$LOG_FILE"
    # Ещё раз убеждаемся, что порты панели открыты (на всякий случай)
    if command -v ufw >/dev/null 2>&1; then
        sudo ufw allow 3000/tcp >/dev/null 2>&1 || true
    fi
    rm -f /root/install_amneziawg.sh
fi
