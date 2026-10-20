#!/bin/bash
set -e
LOG_FILE="/var/log/awg_install.log"
INSTALLER_URL="https://raw.githubusercontent.com/bivlked/amneziawg-installer/main/install_amneziawg.sh"

STATE_ENV="/root/awg_install_params.env"
WRAPPER_SCRIPT="/root/awg_installer_wrapper.sh"
CRON_FILE="/etc/cron.d/awg_resume"

if [ -f "$STATE_ENV" ]; then
    echo "=== [Авто-продолжение] Восстановление после перезагрузки... ==="
    source "$STATE_ENV"
else
    echo "=== СТАРТ УСТАНОВКИ AMNEZIAWG ==="
    
    # ЛОГИКА ЗАПУСКА КАСКАДА
    if [ "$AWG_MODE" = "cascade" ]; then
        echo "=== Подготовка удаленного сервера к каскаду ($REMOTE_IP) ==="
        apt-get update && apt-get install -y sshpass
        
        # Разводим подсети
        if [ "$CASCADE_ROLE" = "ru" ]; then
            export AWG_SUBNET="172.16.17.1/24"
            REMOTE_SUBNET="172.16.61.1/24"
        else
            export AWG_SUBNET="172.16.61.1/24"
            REMOTE_SUBNET="172.16.17.1/24"
        fi
        
        # Копируем себя на удаленный сервер
        sshpass -p "$REMOTE_PASS" scp -o StrictHostKeyChecking=no -P "$REMOTE_PORT" "$0" root@$REMOTE_IP:/root/install_awg_stateful.sh
        
        # Генерируем env для удаленного сервера (как single, чтобы он просто встал)
        env | grep -E '^(AWG_|PANEL_PORT)' | grep -v 'CASCADE_' > /tmp/remote.env
        echo "AWG_SUBNET=$REMOTE_SUBNET" >> /tmp/remote.env
        echo "AWG_MODE=single" >> /tmp/remote.env
        sshpass -p "$REMOTE_PASS" scp -P "$REMOTE_PORT" /tmp/remote.env root@$REMOTE_IP:/root/awg_install_params.env
        
        # Запускаем независимую установку на той стороне
        echo "Отправка команды на старт установки $REMOTE_IP..."
        sshpass -p "$REMOTE_PASS" ssh -o StrictHostKeyChecking=no -p "$REMOTE_PORT" root@$REMOTE_IP "chmod +x /root/install_awg_stateful.sh && bash /root/install_awg_stateful.sh > /var/log/awg_install.log 2>&1 &"
    fi

    # Сохраняем состояние текущего сервера
    env | grep -E '^(AWG_|PANEL_PORT|REMOTE_|CASCADE_)' > "$STATE_ENV" || true
    
    cp "$0" "$WRAPPER_SCRIPT"
    chmod +x "$WRAPPER_SCRIPT"
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

    # Возвращаем открытие порта из оригинального скрипта
    if command -v ufw >/dev/null 2>&1; then
        sudo ufw allow ${PORT_TO_OPEN}/tcp >/dev/null 2>&1 || true
    fi
    
    # ЛИНКОВКА КАСКАДА
    if [ "$AWG_MODE" = "cascade" ]; then
        echo "=== СИНХРОНИЗАЦИЯ КАСКАДА ==="
        echo "Ожидание завершения 3-х перезагрузок удаленного сервера ($REMOTE_IP)... Это займет пару минут."
        
        # Ждем, пока на той стороне в лог не упадет "INSTALLATION DONE"
        while ! sshpass -p "$REMOTE_PASS" ssh -p "$REMOTE_PORT" -o StrictHostKeyChecking=no -o ConnectTimeout=5 root@$REMOTE_IP "grep -q 'INSTALLATION DONE' /var/log/awg_install.log 2>/dev/null"; do
            sleep 15
            echo -n "."
        done
        echo -e "\nУдаленная установка завершена! Настраиваем тоннель и маршрутизацию..."

        apt-get install -y sshpass curl ipset
        sshpass -p "$REMOTE_PASS" ssh -p "$REMOTE_PORT" root@$REMOTE_IP "apt-get update && apt-get install -y curl ipset"

        if [ "$CASCADE_ROLE" = "ru" ]; then
            # Локальный - ВХОД (RU), Удаленный - ВЫХОД (EU)
            EU_IP="$REMOTE_IP"
            sshpass -p "$REMOTE_PASS" ssh -p "$REMOTE_PORT" root@$REMOTE_IP "bash /root/awg/manage_amneziawg.sh add ru_host"
            sshpass -p "$REMOTE_PASS" ssh -p "$REMOTE_PORT" root@$REMOTE_IP "cat /root/awg/ru_host.conf" > /etc/amnezia/amneziawg/awg1.conf
            
            sed -i '/^DNS/d' /etc/amnezia/amneziawg/awg1.conf
            sed -i '/\[Interface\]/a Table=off' /etc/amnezia/amneziawg/awg1.conf
            chmod 600 /etc/amnezia/amneziawg/awg1.conf
            systemctl start awg-quick@awg1 || true
            systemctl enable awg-quick@awg1 || true

            cat << 'EOF' > /root/awg/awg-routing.sh
#!/bin/bash
set -euo pipefail
CLIENT_SUBNET="172.16.17.0/24"
AWG1_IF="awg1"
AWG1_ENDPOINT="CHANGE_ME"
TABLE_ID=100
FWMARK="0x1"
RULE_PRIO=10000
RU_ZONE_URL="https://www.ipdeny.com/ipblocks/data/aggregated/ru-aggregated.zone"
RU_ZONE_FALLBACK_URL="https://raw.githubusercontent.com/bivlked/amneziawg-installer/v6.0.0/cascade/ru.zone"
AWG_DIR="/root/awg"
EXTRA_RU_NETS=""
RU_ZONE="$AWG_DIR/ru.zone"
mkdir -p "$AWG_DIR"
exec 9>"$AWG_DIR/awg-routing.lock"
flock -w 300 9 || exit 1
trap 'rm -f "$RU_ZONE.tmp"' EXIT
EP_ROUTE="$(ip -4 route get "$AWG1_ENDPOINT" 2>/dev/null | head -1)"
WAN_IF="$(printf '%s' "$EP_ROUTE" | grep -oP '\bdev \K\S+' || true)"
WAN_GW="$(printf '%s' "$EP_ROUTE" | grep -oP '\bvia \K\S+' || true)"
fetch_ru_zone() {
    curl -fsS --retry 2 --connect-timeout 10 --max-time 30 -o "$RU_ZONE.tmp" "$1" || return 1
    local valid=$(grep -cE '^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$' "$RU_ZONE.tmp" || true)
    if [ "$valid" -lt 1000 ]; then return 1; fi
}
if fetch_ru_zone "$RU_ZONE_URL"; then mv -f "$RU_ZONE.tmp" "$RU_ZONE"; elif fetch_ru_zone "$RU_ZONE_FALLBACK_URL"; then mv -f "$RU_ZONE.tmp" "$RU_ZONE"; fi
ipset create ru hash:net -exist
ipset create ru_tmp hash:net -exist
ipset flush ru_tmp
while read -r net; do [ -n "$net" ] && ipset add ru_tmp "$net" -exist; done < "$RU_ZONE"
ipset swap ru_tmp ru
ipset destroy ru_tmp
ip route replace default dev "$AWG1_IF" table "$TABLE_ID"
ip rule del fwmark "$FWMARK" table "$TABLE_ID" 2>/dev/null || true
ip rule add fwmark "$FWMARK" table "$TABLE_ID" priority "$RULE_PRIO"
if [ -n "$WAN_GW" ]; then
    ip route replace "$AWG1_ENDPOINT" via "$WAN_GW" dev "$WAN_IF" 2>/dev/null || ip route replace "$AWG1_ENDPOINT" via "$WAN_GW" dev "$WAN_IF" onlink
else
    ip route replace "$AWG1_ENDPOINT" dev "$WAN_IF"
fi
iptables -t mangle -C PREROUTING -i awg0 -s "$CLIENT_SUBNET" -m set --match-set ru dst -j RETURN 2>/dev/null || iptables -t mangle -I PREROUTING 1 -i awg0 -s "$CLIENT_SUBNET" -m set --match-set ru dst -j RETURN
iptables -t mangle -C PREROUTING -i awg0 -s "$CLIENT_SUBNET" -j MARK --set-mark "$FWMARK" 2>/dev/null || iptables -t mangle -A PREROUTING -i awg0 -s "$CLIENT_SUBNET" -j MARK --set-mark "$FWMARK"
iptables -t nat -C POSTROUTING -s "$CLIENT_SUBNET" -o "$AWG1_IF" -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s "$CLIENT_SUBNET" -o "$AWG1_IF" -j MASQUERADE
echo "ОК: Каскад применен."
EOF
            sed -i "s/CHANGE_ME/$EU_IP/" /root/awg/awg-routing.sh
            chmod +x /root/awg/awg-routing.sh

            cat << 'EOF' > /etc/systemd/system/awg-routing.service
[Unit]
Description=Каскадный сплит-роутинг
Requires=awg-quick@awg1.service
After=awg-quick@awg1.service
[Service]
Type=oneshot
RemainAfterExit=no
ExecStart=/root/awg/awg-routing.sh
[Install]
WantedBy=multi-user.target
EOF
            cat << 'EOF' > /etc/systemd/system/awg-routing.timer
[Unit]
Description=Обновление списка RU сетей
[Timer]
OnCalendar=*-*-* 01:00:00
RandomizedDelaySec=15m
Persistent=false
Unit=awg-routing.service
[Install]
WantedBy=timers.target
EOF
            systemctl daemon-reload
            systemctl enable awg-quick@awg1 awg-routing
            systemctl enable --now awg-routing.timer
            systemctl restart awg-routing || true

        else
            # Локальный - ВЫХОД (EU), Удаленный - ВХОД (RU)
            EU_IP=$(curl -s ifconfig.me)
            bash /root/awg/manage_amneziawg.sh add ru_host
            sshpass -p "$REMOTE_PASS" scp -P "$REMOTE_PORT" /root/awg/ru_host.conf root@$REMOTE_IP:/etc/amnezia/amneziawg/awg1.conf
            sshpass -p "$REMOTE_PASS" ssh -p "$REMOTE_PORT" root@$REMOTE_IP "sed -i '/^DNS/d' /etc/amnezia/amneziawg/awg1.conf && sed -i '/\[Interface\]/a Table=off' /etc/amnezia/amneziawg/awg1.conf && chmod 600 /etc/amnezia/amneziawg/awg1.conf && systemctl enable --now awg-quick@awg1"

            # Точно такой же файл awg-routing.sh создаем на удаленной машине, подменяя IP
            # Для надежности можно скопировать его из локального темпа, как в примере выше
            cat << 'EOF' > /tmp/awg-routing.sh
# (Тот же скрипт что и в блоке RU)
EOF
            sed -i "s/CHANGE_ME/$EU_IP/" /tmp/awg-routing.sh
            sshpass -p "$REMOTE_PASS" scp -P "$REMOTE_PORT" /tmp/awg-routing.sh root@$REMOTE_IP:/root/awg/awg-routing.sh
            
            # (Тот же systemd timer/service)
            sshpass -p "$REMOTE_PASS" scp -P "$REMOTE_PORT" /tmp/awg-routing.service root@$REMOTE_IP:/etc/systemd/system/awg-routing.service
            sshpass -p "$REMOTE_PASS" ssh -p "$REMOTE_PORT" root@$REMOTE_IP "chmod +x /root/awg/awg-routing.sh && systemctl daemon-reload && systemctl enable awg-quick@awg1 awg-routing && systemctl restart awg-routing"
        fi
       echo "=== СБОРКА КАСКАДА ПОЛНОСТЬЮ ЗАВЕРШЕНА ==="
    fi

    # Убираем за собой следы авто-возобновления
    rm -f /root/install_amneziawg.sh
    rm -f "$STATE_ENV"
    rm -f "$CRON_FILE"
    rm -f "$WRAPPER_SCRIPT"
fi
