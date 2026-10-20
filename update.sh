#!/usr/bin/env bash
#
# CLI-обновление Servpanel из архива.
#
#   sudo bash update.sh /root/servpanel-2.4.0.tar.gz
#
# Это безопасная обёртка: она распаковывает релиз во временный каталог и
# запускает его upgrade.sh (проверка на копии данных, бэкап, откат при ошибке).
# Старый `git reset --hard` удалён намеренно: он мог стереть локальные правки
# и данные панели.
#
set -Eeuo pipefail

ARCHIVE="${1:-}"
if [ -z "$ARCHIVE" ] || [ ! -s "$ARCHIVE" ]; then
    echo "Использование: sudo bash update.sh /path/to/servpanel-<version>.tar.gz" >&2
    exit 1
fi
[ "$(id -u)" -eq 0 ] || { echo "Запустите от root: sudo bash update.sh <архив>" >&2; exit 1; }

TMP="$(mktemp -d /root/.servpanel-cli-update-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
echo "Распаковываю $ARCHIVE ..."
tar -xzf "$ARCHIVE" -C "$TMP"
SCRIPT="$(find "$TMP" -maxdepth 4 -name upgrade.sh -type f | head -n 1 || true)"
[ -n "$SCRIPT" ] || { echo "В архиве нет upgrade.sh" >&2; exit 1; }
echo "Запускаю безопасное обновление: $SCRIPT"
bash "$SCRIPT"
