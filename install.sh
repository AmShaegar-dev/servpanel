#!/bin/bash
set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}=================================================${NC}"
echo -e "${GREEN}  Менеджер FileManager 4.0 и VPN Инфраструктуры  ${NC}"
echo -e "${CYAN}=================================================${NC}"

echo -e "1) Установить панель и компоненты"
echo -e "2) Выборочно удалить компоненты"
read -p "Выберите действие (1 или 2): " MAIN_ACTION < /dev/tty

if [ "$MAIN_ACTION" == "2" ]; then
    echo -e "\n${RED}Режим выборочного удаления...${NC}"
    
    read -p "Удалить саму панель FileManager 4.0? [Y/n]: " DEL_PANEL < /dev/tty
    read -p "Удалить настройки Nginx (конфиги панели и SSL)? [Y/n]: " DEL_NGINX < /dev/tty
    read -p "Удалить AdGuard Home? [Y/n]: " DEL_ADGUARD < /dev/tty
    read -p "Удалить MTProto Proxy? [Y/n]: " DEL_MTPROTO < /dev/tty
    read -p "Удалить AmneziaWG (ВНИМАНИЕ: удалит все профили)? [Y/n]: " DEL_AWG < /dev/tty

    if [[ ! "$DEL_PANEL" =~ ^[Nn]$ ]]; then
        echo "[*] Остановка и удаление панели FileManager..."
        pm2 stop awg-admin 2>/dev/null || true
        pm2 delete awg-admin 2>/dev/null || true
        pm2 save --force 2>/dev/null || true
        rm -rf /root/servpanel
    fi
    
    if [[ ! "$DEL_NGINX" =~ ^[Nn]$ ]]; then
        echo "[*] Удаление настроек Nginx..."
        rm -f /etc/nginx/sites-available/awg-admin /etc/nginx/sites-enabled/awg-admin
        systemctl restart nginx 2>/dev/null || true
    fi

    if [[ ! "$DEL_ADGUARD" =~ ^[Nn]$ ]]; then
        echo "[*] Удаление AdGuard Home..."
        if [ -f "/opt/AdGuardHome/AdGuardHome" ]; then
            /opt/AdGuardHome/AdGuardHome -s uninstall 2>/dev/null || true
            rm -rf /opt/AdGuardHome
        fi
    fi

    if [[ ! "$DEL_MTPROTO" =~ ^[Nn]$ ]]; then
        echo "[*] Удаление MTProto (Telemt/MTG)..."
        systemctl stop telemt mtg 2>/dev/null || true
        systemctl disable telemt mtg 2>/dev/null || true
        rm -rf /opt/mtproto-proxy /etc/telemt-panel /etc/systemd/system/telemt.service /etc/systemd/system/mtg.service
        systemctl daemon-reload
    fi

    if [[ ! "$DEL_AWG" =~ ^[Nn]$ ]]; then
        echo "[*] Удаление AmneziaWG..."
        if [ -f "/root/install_amneziawg.sh" ]; then
            bash /root/install_amneziawg.sh --uninstall --yes || true
        else
            wget -qO uninstall_awg.sh https://raw.githubusercontent.com/bivlked/amneziawg-installer/main/install_amneziawg.sh
            bash uninstall_awg.sh --uninstall --yes || true
            rm -f uninstall_awg.sh
        fi
    fi

    echo -e "\n${GREEN}Выборочное удаление успешно завершено!${NC}"
    exit 0
fi

# ==================== УСТАНОВКА ====================

SERVER_IP=$(curl -s ifconfig.me || wget -qO- ifconfig.me)

echo -e "\n${CYAN}[1/5] Настройка компонентов${NC}"
read -p "Установить AmneziaWG (bivlked)? [Y/n]: " INSTALL_AWG < /dev/tty
read -p "Установить AdGuard Home? [Y/n]: " INSTALL_ADGUARD < /dev/tty
read -p "Установить MTProto FIX (by MEKO)? [Y/n]: " INSTALL_MTPROTO < /dev/tty

echo -e "\n${CYAN}Настройка доступа к панели${NC}"
read -p "Придумайте пароль для входа в панель: " ADMIN_PASS < /dev/tty
if [ -z "$ADMIN_PASS" ]; then
    ADMIN_PASS="admin123"
    echo "Вы не ввели пароль. Будет использован пароль по умолчанию: admin123"
fi

echo -e "\nКак будем заходить в панель управления?"
echo "1) По IP-адресу"
echo "2) По Домену (с бесплатным SSL сертификатом HTTPS)"
read -p "Ваш выбор (1 или 2): " ACCESS_TYPE < /dev/tty

if [ "$ACCESS_TYPE" == "2" ]; then
    read -p "Введите ваш домен (например, vpn.mydomain.com): " DOMAIN_NAME < /dev/tty
    read -p "Укажите порт для HTTPS-доступа (По умолчанию 443): " PANEL_PORT < /dev/tty
    PANEL_PORT=${PANEL_PORT:-443}
else
    read -p "Укажите порт для панели (По умолчанию 3000): " PANEL_PORT < /dev/tty
    PANEL_PORT=${PANEL_PORT:-3000}
fi

echo -e "\n${CYAN}[2/5] Обновление системы и установка пакетов...${NC}"
apt-get update && apt-get upgrade -y
apt-get install -y curl wget git ufw zip tar nginx certbot python3-certbot-nginx

curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

echo -e "\n${CYAN}[3/5] Установка сторонних сервисов...${NC}"

if [[ ! "$INSTALL_AWG" =~ ^[Nn]$ ]]; then
    echo "Запуск установщика AmneziaWG..."
    wget -qO /root/install_amneziawg.sh https://raw.githubusercontent.com/bivlked/amneziawg-installer/main/install_amneziawg.sh
    chmod +x /root/install_amneziawg.sh
    bash /root/install_amneziawg.sh
fi

if [[ ! "$INSTALL_ADGUARD" =~ ^[Nn]$ ]]; then
    echo "Установка AdGuard Home..."
    curl -s -S -L https://raw.githubusercontent.com/AdguardTeam/AdGuardHome/master/scripts/install.sh | sh -s -- -v
fi

if [[ ! "$INSTALL_MTPROTO" =~ ^[Nn]$ ]]; then
    echo "Установка MTProto Proxy от MEKO..."
    curl -fsSL https://raw.githubusercontent.com/Mekotofeuka/MTPROTO_FIX_By_MEKO/main/install.sh | sudo bash
fi

echo -e "\n${CYAN}[4/5] Развертывание FileManager 4.0 из GitHub...${NC}"

GITHUB_REPO="https://github.com/makar19977v-glitch/servpanel.git"

cd /root
pm2 stop awg-admin 2>/dev/null || true
pm2 delete awg-admin 2>/dev/null || true
rm -rf servpanel

git clone $GITHUB_REPO servpanel
cd servpanel

echo "Применение заданного пароля..."
sed -i "s/mysecretpassword/$ADMIN_PASS/g" server.js

if [ "$ACCESS_TYPE" != "2" ]; then
    echo "Применение кастомного порта $PANEL_PORT..."
    sed -i "s/app.listen(3000/app.listen($PANEL_PORT/g" server.js
fi

echo "Установка Node.js зависимостей..."
npm install
npm install -g pm2

echo "Запуск бекенда панели..."
pm2 start server.js --name awg-admin
pm2 save
pm2 startup

echo -e "\n${CYAN}[5/5] Настройка сети и фаервола...${NC}"

ufw --force enable
ufw allow ssh

if [ "$ACCESS_TYPE" == "2" ] && [ -n "$DOMAIN_NAME" ]; then
    ufw allow "Nginx Full"
    if [ "$PANEL_PORT" != "443" ]; then
        ufw allow $PANEL_PORT/tcp
    fi
    
    cat << EOF > /etc/nginx/sites-available/awg-admin
server {
    listen 80;
    server_name $DOMAIN_NAME;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF
    ln -sf /etc/nginx/sites-available/awg-admin /etc/nginx/sites-enabled/
    nginx -t
    systemctl restart nginx

    echo "Получение SSL сертификата для $DOMAIN_NAME..."
    certbot --nginx -d $DOMAIN_NAME --non-interactive --agree-tos -m admin@$DOMAIN_NAME || echo -e "${RED}Ошибка получения SSL. Проверьте A-запись домена.${NC}"
    
    if [ "$PANEL_PORT" != "443" ]; then
        echo "Смена порта Nginx с 443 на $PANEL_PORT..."
        sed -i "s/ 443 ssl/ $PANEL_PORT ssl/g" /etc/nginx/sites-available/awg-admin
        systemctl restart nginx
    fi
    
    echo -e "\n${GREEN}Панель успешно установлена!${NC}"
    if [ "$PANEL_PORT" == "443" ]; then
        echo -e "Доступ по ссылке: https://$DOMAIN_NAME"
    else
        echo -e "Доступ по ссылке: https://$DOMAIN_NAME:$PANEL_PORT"
    fi
else
    ufw allow $PANEL_PORT/tcp
    echo -e "\n${GREEN}Панель успешно установлена!${NC}"
    echo -e "Доступ по ссылке: http://$SERVER_IP:$PANEL_PORT"
fi

echo -e "Ваш пароль для входа: $ADMIN_PASS"
