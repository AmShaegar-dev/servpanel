#!/bin/bash
set -e

# Цвета для вывода
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}=================================================${NC}"
echo -e "${GREEN}  Установка FileManager 4.0 и VPN Инфраструктуры ${NC}"
echo -e "${CYAN}=================================================${NC}"

# Определяем внешний IP сервера
SERVER_IP=$(curl -s ifconfig.me || wget -qO- ifconfig.me)

# 1. Запрос параметров у пользователя
echo -e "\n${CYAN}[1/5] Настройка компонентов${NC}"
read -p "Установить AmneziaWG (bivlked)? [y/N]: " INSTALL_AWG
read -p "Установить AdGuard Home? [y/N]: " INSTALL_ADGUARD
read -p "Установить MTProto FIX (by MEKO)? [y/N]: " INSTALL_MTPROTO

echo -e "\n${CYAN}Как будем заходить в панель управления?${NC}"
echo "1) По IP-адресу (например, http://$SERVER_IP:3000)"
echo "2) По Домену (с бесплатным SSL сертификатом HTTPS)"
read -p "Ваш выбор (1 или 2): " ACCESS_TYPE

if [ "$ACCESS_TYPE" == "2" ]; then
    read -p "Введите ваш домен (например, vpn.mydomain.com): " DOMAIN_NAME
else
    read -p "Укажите порт для панели (По умолчанию 3000): " PANEL_PORT
    PANEL_PORT=${PANEL_PORT:-3000}
fi

# 2. Обновление системы и установка базовых зависимостей
echo -e "\n${CYAN}[2/5] Обновление системы и установка пакетов...${NC}"
apt-get update && apt-get upgrade -y
apt-get install -y curl wget git ufw zip tar nginx certbot python3-certbot-nginx

# Установка Node.js (v20)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 3. Установка выбранных VPN компонентов
echo -e "\n${CYAN}[3/5] Установка сторонних сервисов...${NC}"

if [[ "$INSTALL_AWG" =~ ^[Yy]$ ]]; then
    echo "Запуск установщика AmneziaWG..."
    wget -O install_amneziawg.sh https://raw.githubusercontent.com/bivlked/amneziawg-installer/main/install_amneziawg.sh
    chmod +x install_amneziawg.sh
    bash install_amneziawg.sh
fi

if [[ "$INSTALL_ADGUARD" =~ ^[Yy]$ ]]; then
    echo "Установка AdGuard Home..."
    # Оригинальный скрипт установки AdGuard Home[cite: 93]
    curl -s -S -L https://raw.githubusercontent.com/AdguardTeam/AdGuardHome/master/scripts/install.sh | sh -s -- -v
fi

if [[ "$INSTALL_MTPROTO" =~ ^[Yy]$ ]]; then
    echo "Установка MTProto Proxy от MEKO..."
    # Установка MTProto менеджера[cite: 101, 102]
    curl -fsSL https://raw.githubusercontent.com/Mekotofeuka/MTPROTO_FIX_By_MEKO/main/install.sh | sudo bash
fi

# 4. Развертывание панели администрирования
echo -e "\n${CYAN}[4/5] Развертывание FileManager 4.0 из GitHub...${NC}"

# ЗАМЕНИТЕ ССЫЛКУ НИЖЕ НА ВАШ РЕПОЗИТОРИЙ GITHUB
GITHUB_REPO="https://github.com/ВАШ_ЛОГИН/ВАШ_РЕПОЗИТОРИЙ.git"

cd /root
rm -rf awg-admin
git clone $GITHUB_REPO awg-admin
cd awg-admin

echo "Установка Node.js зависимостей..."
npm install
npm install -g pm2

echo "Запуск бекенда панели..."
pm2 start server.js --name awg-admin
pm2 save
pm2 startup

# 5. Настройка сети и доступа
echo -e "\n${CYAN}[5/5] Настройка сети и фаервола...${NC}"

ufw --force enable
ufw allow ssh

if [ "$ACCESS_TYPE" == "2" ]; then
    # Настройка Nginx в качестве Reverse Proxy для домена
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
    certbot --nginx -d $DOMAIN_NAME --non-interactive --agree-tos -m admin@$DOMAIN_NAME || echo "Ошибка получения SSL. Проверьте привязку домена к IP."
    
    echo -e "\n${GREEN}Панель успешно установлена!${NC}"
    echo -e "Доступ по ссылке: https://$DOMAIN_NAME"
else
    # Открытие прямого порта для доступа по IP
    ufw allow $PANEL_PORT/tcp
    echo -e "\n${GREEN}Панель успешно установлена!${NC}"
    echo -e "Доступ по ссылке: http://$SERVER_IP:$PANEL_PORT"
fi

echo -e "Пароль по умолчанию: mysecretpassword (не забудьте сменить в server.js)"
