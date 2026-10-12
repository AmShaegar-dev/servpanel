#!/bin/bash
set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}=================================================${NC}"
echo -e "${GREEN}  Установка FileManager 4.0 и VPN Инфраструктуры ${NC}"
echo -e "${CYAN}=================================================${NC}"

SERVER_IP=$(curl -s ifconfig.me || wget -qO- ifconfig.me)

# 1. Интерактивный опрос пользователя
echo -e "\n${CYAN}[1/5] Выбор компонентов для установки${NC}"
read -p "Установить AmneziaWG (bivlked)? [Y/n]: " INSTALL_AWG
read -p "Установить AdGuard Home? [Y/n]: " INSTALL_ADGUARD
read -p "Установить MTProto FIX (by MEKO)? [Y/n]: " INSTALL_MTPROTO

echo -e "\n${CYAN}Настройка доступа к панели${NC}"
read -p "Придумайте пароль для входа в панель: " ADMIN_PASS
if [ -z "$ADMIN_PASS" ]; then
    ADMIN_PASS="admin123"
    echo "Вы не ввели пароль. Будет использован пароль по умолчанию: admin123"
fi

echo -e "\nКак будем заходить в панель управления?"
echo "1) По IP-адресу (например, http://$SERVER_IP:3000)"
echo "2) По Домену (с бесплатным SSL сертификатом HTTPS)"
read -p "Ваш выбор (1 или 2): " ACCESS_TYPE

if [ "$ACCESS_TYPE" == "2" ]; then
    read -p "Введите ваш домен (например, vpn.mydomain.com): " DOMAIN_NAME
else
    read -p "Укажите порт для панели (По умолчанию 3000): " PANEL_PORT
    PANEL_PORT=${PANEL_PORT:-3000}
fi

# 2. Установка зависимостей
echo -e "\n${CYAN}[2/5] Обновление системы и установка пакетов...${NC}"
apt-get update && apt-get upgrade -y
apt-get install -y curl wget git ufw zip tar nginx certbot python3-certbot-nginx

curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 3. Установка сервисов
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

# 4. Развертывание панели
echo -e "\n${CYAN}[4/5] Развертывание FileManager 4.0 из GitHub...${NC}"

GITHUB_REPO="https://github.com/makar19977v-glitch/servpanel.git"

cd /root
# Остановка старой версии, если есть
pm2 stop awg-admin 2>/dev/null || true
pm2 delete awg-admin 2>/dev/null || true
rm -rf servpanel

git clone $GITHUB_REPO servpanel
cd servpanel

echo "Применение заданного пароля..."
sed -i "s/mysecretpassword/$ADMIN_PASS/g" server.js

echo "Установка Node.js зависимостей..."
npm install
npm install -g pm2

echo "Запуск бекенда панели..."
pm2 start server.js --name awg-admin
pm2 save
pm2 startup

# 5. Настройка сети
echo -e "\n${CYAN}[5/5] Настройка сети и фаервола...${NC}"

ufw --force enable
ufw allow ssh

if [ "$ACCESS_TYPE" == "2" ] && [ -n "$DOMAIN_NAME" ]; then
    ufw allow "Nginx Full"
    
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
    
    echo -e "\n${GREEN}Панель успешно установлена!${NC}"
    echo -e "Доступ по ссылке: https://$DOMAIN_NAME"
else
    ufw allow $PANEL_PORT/tcp
    echo -e "\n${GREEN}Панель успешно установлена!${NC}"
    echo -e "Доступ по ссылке: http://$SERVER_IP:$PANEL_PORT"
fi

echo -e "Ваш пароль для входа: $ADMIN_PASS"
