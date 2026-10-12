#!/bin/bash
set -e
GREEN='\033[0;32m'
NC='\033[0m'

echo "Начинаем обновление FileManager 4.0..."
cd /root/servpanel
git fetch --all
git reset --hard origin/main
npm install
pm2 restart awg-admin

echo -e "${GREEN}Панель успешно обновлена до последней версии из GitHub!${NC}"
