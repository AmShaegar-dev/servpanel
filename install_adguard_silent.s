#!/bin/bash
set -e

LOG_FILE="/var/log/adguard_install.log"
echo "=== СТАРТ УСТАНОВКИ ADGUARD HOME ===" | tee -a "$LOG_FILE"

echo "Подготовка: смена порта первичной настройки на 3001 (т.к. 3000 занят панелью)..." | tee -a "$LOG_FILE"
sudo mkdir -p /opt/AdGuardHome
# Заранее создаем базовый конфиг, чтобы AdGuard не пытался занять 3000 порт
cat <<EOF | sudo tee /opt/AdGuardHome/AdGuardHome.yaml
bind_host: 0.0.0.0
bind_port: 3001
EOF

echo "Запускаем официальный установщик AdGuard..." | tee -a "$LOG_FILE"
# Флаг -v для тихой автоматической установки
curl -s -S -L https://raw.githubusercontent.com/AdguardTeam/AdGuardHome/master/scripts/install.sh | sh -s -- -v >> "$LOG_FILE" 2>&1

# Открываем порты для настройки (3001) и для самого DNS (53)
if command -v ufw >/dev/null 2>&1; then
    sudo ufw allow 3001/tcp >/dev/null 2>&1 || true
    sudo ufw allow 53/tcp >/dev/null 2>&1 || true
    sudo ufw allow 53/udp >/dev/null 2>&1 || true
fi

echo "=== INSTALLATION DONE ===" | tee -a "$LOG_FILE"
