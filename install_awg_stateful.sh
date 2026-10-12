#!/bin/bash
set -e

LOG_FILE="/var/log/awg_install.log"
INSTALLER_URL="https://raw.githubusercontent.com/bivlked/amneziawg-installer/main/install_amneziawg.sh"

echo "=== СТАРТ УСТАНОВКИ AMNEZIAWG ===" | tee -a "$LOG_FILE"
echo "Запрошенная версия протокола: ${AWG_VERSION:-2.0}" | tee -a "$LOG_FILE"

# 1. Скачиваем оригинальный установщик
echo "Скачиваем установщик AmneziaWG..." | tee -a "$LOG_FILE"
curl -fsSL "$INSTALLER_URL" -o /root/install_amneziawg.sh
chmod +x /root/install_amneziawg.sh

# 2. Формируем команду запуска
# Используем --yes для неинтерактивной установки
# Передаем версию через --protocol, если она задана
INSTALL_CMD="sudo bash /root/install_amneziawg.sh --yes"

if [ -n "$AWG_VERSION" ]; then
    INSTALL_CMD="$INSTALL_CMD --protocol $AWG_VERSION"
fi

echo "Выполняем команду: $INSTALL_CMD" | tee -a "$LOG_FILE"

# 3. Запускаем установку
# Так как скрипт сам уходит в перезагрузку и прописывает себя в cron, 
# мы просто даем ему отработать эту итерацию.
# Мы перенаправляем его вывод в наш лог, чтобы панель могла его читать.
eval "$INSTALL_CMD" >> "$LOG_FILE" 2>&1

# 4. Проверка завершения
# Если скрипт дошел до этой точки без перезагрузки (например, если это уже финальный шаг),
# мы помечаем установку как завершенную.
if grep -q "Установка завершена" "$LOG_FILE" || grep -q "Installation complete" "$LOG_FILE"; then
    echo "=== INSTALLATION DONE ===" | tee -a "$LOG_FILE"
    echo "Очистка временных файлов..." | tee -a "$LOG_FILE"
    rm -f /root/install_amneziawg.sh
fi
