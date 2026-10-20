#!/bin/bash
set -euo pipefail

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}=================================================${NC}"
echo -e "${GREEN}              Servpanel — установка              ${NC}"
echo -e "${CYAN}=================================================${NC}"
echo -e "Скрипт ставит ${GREEN}только панель${NC} и её системные зависимости."
echo -e "AmneziaWG, AdGuard, каскад и остальные компоненты"
echo -e "устанавливаются потом из самой панели."
echo

# ==================== 1. ДОСТУП К ПАНЕЛИ ====================
# Единственные вопросы установщика: способ доступа (IP/домен) и порт.
ACCESS_TYPE="${ACCESS_TYPE:-}"
if [ -z "$ACCESS_TYPE" ]; then
    echo -e "${CYAN}Как будем заходить в панель?${NC}"
    echo "1) По IP-адресу"
    echo "2) По домену (бесплатный SSL от Let's Encrypt)"
    read -r -p "Ваш выбор (1 или 2): " ACCESS_TYPE < /dev/tty
fi

if [ "$ACCESS_TYPE" != "1" ] && [ "$ACCESS_TYPE" != "2" ]; then
    echo -e "${RED}Нужно выбрать 1 или 2.${NC}"
    exit 1
fi

DOMAIN_NAME="${DOMAIN_NAME:-}"
PANEL_PORT="${PANEL_PORT:-}"

if [ "$ACCESS_TYPE" == "2" ]; then
    if [ -z "$DOMAIN_NAME" ]; then
        read -r -p "Введите домен (например, panel.example.com): " DOMAIN_NAME < /dev/tty
    fi
    if ! [[ "$DOMAIN_NAME" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || [[ "$DOMAIN_NAME" != *.* ]]; then
        echo -e "${RED}Некорректный домен: $DOMAIN_NAME${NC}"
        exit 1
    fi
    if [ -z "$PANEL_PORT" ]; then
        read -r -p "Порт HTTPS для панели (по умолчанию 443): " PANEL_PORT < /dev/tty
    fi
    PANEL_PORT=${PANEL_PORT:-443}
else
    if [ -z "$PANEL_PORT" ]; then
        read -r -p "Порт панели (по умолчанию 3000): " PANEL_PORT < /dev/tty
    fi
    PANEL_PORT=${PANEL_PORT:-3000}
fi

if ! [[ "$PANEL_PORT" =~ ^[0-9]+$ ]]; then
    echo -e "${RED}Некорректный порт: $PANEL_PORT (нужно 1–65535).${NC}"
    exit 1
fi
# Убираем ведущие нули, чтобы bash не принял «0443» за восьмеричное число.
PANEL_PORT=$((10#$PANEL_PORT))
if [ "$PANEL_PORT" -lt 1 ] || [ "$PANEL_PORT" -gt 65535 ]; then
    echo -e "${RED}Некорректный порт: $PANEL_PORT (нужно 1–65535).${NC}"
    exit 1
fi
if [ "$PANEL_PORT" == "80" ]; then
    echo -e "${RED}Порт 80 занят HTTP-сервером. Выберите другой порт.${NC}"
    exit 1
fi

SERVER_IP="$(curl -fsS --max-time 10 https://ifconfig.me 2>/dev/null || true)"
if [ -z "$SERVER_IP" ]; then
    SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
if [ -z "$SERVER_IP" ]; then
    SERVER_IP="<IP сервера>"
fi

if [ "$ACCESS_TYPE" == "2" ]; then
    echo -e "\nПанель будет доступна: ${GREEN}https://${DOMAIN_NAME}:${PANEL_PORT}${NC}"
    echo -e "Проверьте, что A-запись ${DOMAIN_NAME} указывает на ${SERVER_IP}."
else
    echo -e "\nПанель будет доступна: ${GREEN}http://${SERVER_IP}:${PANEL_PORT}${NC}"
fi

# ==================== 2. ПАКЕТЫ ====================
echo -e "\n${CYAN}[1/4] Обновление списка пакетов и установка зависимостей...${NC}"
export DEBIAN_FRONTEND=noninteractive
apt-get update

# Nginx и certbot нужны только для доступа по домену. В режиме IP панель
# слушает порт напрямую, и лишний веб-сервер на 80 не запускается.
BASE_PACKAGES="curl wget git ufw zip unzip tar sshpass ipset fail2ban openssl ca-certificates"
if [ "$ACCESS_TYPE" == "2" ]; then
    apt-get install -y $BASE_PACKAGES nginx certbot python3-certbot-nginx
else
    apt-get install -y $BASE_PACKAGES
fi

echo -e "${CYAN}[2/4] Установка Node.js 20...${NC}"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# ==================== 3. ПАНЕЛЬ ====================
echo -e "\n${CYAN}[3/4] Развёртывание Servpanel...${NC}"
GITHUB_REPO="https://github.com/makar19977v-glitch/servpanel.git"

if [ -d /root/servpanel ]; then
    echo -e "${RED}/root/servpanel уже существует.${NC}"
    echo -e "Похоже, панель уже установлена. Для обновления используйте:"
    echo -e "  ${CYAN}bash /root/servpanel/upgrade.sh${NC}"
    echo -e "Установщик не будет удалять существующие данные панели."
    exit 1
fi

cd /root
# Если install.sh запущен из распакованного архива (а не через curl | bash),
# ставим именно эту версию, а не то, что сейчас лежит в main на GitHub.
SRC_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
fi
if [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/server.js" ] && [ -f "$SRC_DIR/package.json" ]; then
    echo "Источник: $SRC_DIR (локальный архив)"
    mkdir -p /root/servpanel
    cp -a "$SRC_DIR/." /root/servpanel/
else
    echo "Источник: $GITHUB_REPO"
    git clone --depth 1 "$GITHUB_REPO" servpanel
fi
cd /root/servpanel

# Не переносим в установку чужие сессии, пароли и секреты:
# панель должна стартовать с чистым состоянием.
rm -rf .sessions
rm -f .users.json .secrets.json .backup.json .backup_pass .notify.json \
    .obf_profiles.json .install_state.json admin_pass.txt

if [ "$ACCESS_TYPE" == "2" ]; then
    PANEL_INTERNAL_PORT=3000
    PANEL_PUBLIC_PORT=$PANEL_PORT
    PANEL_BIND_HOST=127.0.0.1
else
    PANEL_INTERNAL_PORT=$PANEL_PORT
    PANEL_PUBLIC_PORT=$PANEL_PORT
    PANEL_BIND_HOST=0.0.0.0
fi

# Порты хранятся в файлах: обновление панели не сбрасывает кастомный порт.
echo "$PANEL_INTERNAL_PORT" > .panel_port
echo "$PANEL_PUBLIC_PORT" > .panel_public_port

ADMIN_PASS="${ADMIN_PASS:-$(openssl rand -hex 16)}"
printf '%s\n' "$ADMIN_PASS" > admin_pass.txt
chmod 600 admin_pass.txt

echo "Установка Node.js зависимостей..."
npm install --omit=dev
npm install -g pm2

# --- Fail2ban: журнал входов панели и готовый jail -------------------------
mkdir -p /var/log /root/backups
touch /var/log/servpanel_auth.log
chmod 640 /var/log/servpanel_auth.log
chmod 700 /root/backups

if command -v fail2ban-client >/dev/null 2>&1; then
    cat > /etc/fail2ban/filter.d/servpanel.conf << 'EOF'
[Definition]
failregex = FAILED LOGIN from <HOST>
ignoreregex =
EOF
    cat > /etc/fail2ban/jail.d/servpanel.local << 'EOF'
[servpanel]
enabled = true
port = http,https
filter = servpanel
logpath = /var/log/servpanel_auth.log
maxretry = 5
findtime = 10m
bantime = 1h
EOF
    systemctl enable fail2ban >/dev/null 2>&1 || true
    systemctl restart fail2ban || true
fi

cat > /etc/logrotate.d/servpanel << 'EOF'
/var/log/servpanel_auth.log /var/log/awg_audit.log {
    weekly
    rotate 8
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF

echo "Запуск бекенда панели..."
pm2 delete awg-admin >/dev/null 2>&1 || true
PANEL_HOST=$PANEL_BIND_HOST PANEL_PORT=$PANEL_INTERNAL_PORT PANEL_PUBLIC_PORT=$PANEL_PUBLIC_PORT \
    pm2 start server.js --name awg-admin --update-env
pm2 save
env PATH="$PATH:/usr/bin" pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
pm2 save

# ==================== 4. СЕТЬ И ДОСТУП ====================
echo -e "\n${CYAN}[4/4] Настройка Nginx и фаервола...${NC}"

# UFW: не трогаем чужие правила, но открываем SSH, панель и уже
# установленные AWG-порты (если панель ставят на сервер с AWG).
ufw allow ssh >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1 || true
for conf in /etc/amnezia/amneziawg/*.conf /etc/wireguard/*.conf; do
    [ -f "$conf" ] || continue
    awg_port="$(awk -F'=' '/^[[:space:]]*ListenPort/{gsub(/[^0-9]/,"",$2); print $2; exit}' "$conf")"
    if [ -n "$awg_port" ]; then
        ufw allow "$awg_port"/udp >/dev/null 2>&1 || true
    fi
done

if [ "$ACCESS_TYPE" == "2" ] && [ -n "$DOMAIN_NAME" ]; then
    ufw allow 80/tcp >/dev/null 2>&1 || true
    ufw allow 443/tcp >/dev/null 2>&1 || true
    if [ "$PANEL_PORT" != "443" ]; then
        ufw allow "$PANEL_PORT"/tcp >/dev/null 2>&1 || true
    fi

    cat << EOF > /etc/nginx/sites-available/awg-admin
server {
    listen 80;
    server_name $DOMAIN_NAME;

    client_max_body_size 512m;

    location / {
        proxy_pass http://127.0.0.1:${PANEL_INTERNAL_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host \$http_host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF
    ln -sf /etc/nginx/sites-available/awg-admin /etc/nginx/sites-enabled/awg-admin
    nginx -t
    systemctl restart nginx

    echo "Получение SSL-сертификата для $DOMAIN_NAME..."
    if certbot --nginx -d "$DOMAIN_NAME" --non-interactive --agree-tos -m "admin@$DOMAIN_NAME"; then
        NGINX_BACKUP="/root/nginx-awg-admin-$(date +%Y%m%d-%H%M%S).conf"
        cp /etc/nginx/sites-available/awg-admin "$NGINX_BACKUP"
        if [ "$PANEL_PORT" != "443" ]; then
            echo "Смена порта HTTPS с 443 на $PANEL_PORT..."
            sed -i "s/ 443 ssl/ $PANEL_PORT ssl/g" /etc/nginx/sites-available/awg-admin
        fi
        if ! nginx -t; then
            echo -e "${RED}Конфиг Nginx не прошёл проверку. Возвращаю резервную копию.${NC}"
            cp "$NGINX_BACKUP" /etc/nginx/sites-available/awg-admin
            nginx -t || true
        fi
        systemctl restart nginx
        if [ "$PANEL_PORT" == "443" ]; then
            PANEL_URL="https://${DOMAIN_NAME}"
        else
            PANEL_URL="https://${DOMAIN_NAME}:${PANEL_PORT}"
        fi
    else
        echo -e "${YELLOW}SSL не получен. Проверьте A-запись домена и порт 80.${NC}"
        echo -e "${YELLOW}Панель пока доступна по HTTP: http://${DOMAIN_NAME}${NC}"
        PANEL_URL="http://${DOMAIN_NAME}"
    fi
else
    ufw allow "$PANEL_PORT"/tcp >/dev/null 2>&1 || true
    PANEL_URL="http://${SERVER_IP}:${PANEL_PORT}"
fi

# Не включаем UFW принудительно: на сервере с уже настроенным AWG это может
# оборвать форвардинг. Если UFW уже активен — правила выше уже применились;
# если нет — включите его из панели, когда проверите доступ.
if ufw status 2>/dev/null | grep -q "Status: active"; then
    echo "UFW активен: SSH, панель и порты AWG разрешены."
else
    echo -e "${YELLOW}UFW не включён. Включите его в панели после проверки доступа.${NC}"
fi

# ==================== ИТОГ ====================
echo
echo -e "${GREEN}=================================================${NC}"
echo -e "${GREEN}  Панель установлена${NC}"
echo -e "${GREEN}=================================================${NC}"
echo -e "Адрес:            ${CYAN}${PANEL_URL}${NC}"
echo -e "Пароль:           ${CYAN}${ADMIN_PASS}${NC}"
echo -e "Файл с паролем:   /root/servpanel/admin_pass.txt"
echo
echo -e "${YELLOW}Дальше — из панели:${NC}"
echo "  1. Войдите под admin."
echo "  2. Откройте «Установка» и установите AmneziaWG (и каскад, если нужен)."
echo "  3. На вкладке «Службы и DNS» установите AdGuard Home."
echo "  4. Смените пароль администратора в панели."
echo
echo -e "Для обновления панели в будущем: ${CYAN}bash /root/servpanel/upgrade.sh${NC}"
