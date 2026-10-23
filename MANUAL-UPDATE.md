# Ручное обновление Servpanel из терминала

Этот способ подходит для любой версии панели. Используйте его, если:

- панель ещё на старой версии;
- кнопка обновления внутри панели не работает;
- после обновления остались локальные изменения файлов;
- нужно обновить сервер без доступа панели к GitHub.

Данные, клиенты, пароль, 2FA, профили, сессии и конфиги AmneziaWG при
обновлении сохраняются.

## 1. Подключитесь к серверу

```bash
ssh root@IP_СЕРВЕРА
```

## 2. Скачайте архив и контрольную сумму

```bash
cd /root
curl -fLO https://github.com/makar19977v-glitch/servpanel/releases/download/v2.5.0/servpanel-2.5.0.tar.gz
curl -fLO https://github.com/makar19977v-glitch/servpanel/releases/download/v2.5.0/servpanel-2.5.0.tar.gz.sha256
```

## 3. Проверьте архив

```bash
sha256sum -c servpanel-2.5.0.tar.gz.sha256
```

В выводе должно быть:

```text
servpanel-2.5.0.tar.gz: OK
```

Если проверка не прошла, не запускайте установку. Скачайте архив заново.

## 4. Распакуйте и запустите обновление

```bash
tar -xzf servpanel-2.5.0.tar.gz
bash /root/servpanel-2.5.0/upgrade.sh
```

Скрипт сам сделает бэкап, проверит новую версию на копии данных, заменит
только файлы кода и перезапустит панель. При ошибке он откатится на прежнюю
версию.

## 5. Проверьте версию

```bash
node -p "require('/root/servpanel/package.json').version"
```

Должно вывести:

```text
2.5.0
```

Проверьте, что в git нет локальных изменений кода:

```bash
git -C /root/servpanel status --porcelain --untracked-files=no
```

Команда должна ничего не вывести. После этого обновление с GitHub из панели
тоже будет работать.

## Если `curl` не установлен

Ubuntu / Debian:

```bash
apt update && apt install -y curl
```

AlmaLinux / Rocky / CentOS:

```bash
dnf install -y curl
```

## Если у сервера нет доступа к GitHub

Скачайте архив на свой компьютер и загрузите его по SCP:

```bash
scp servpanel-2.5.0.tar.gz root@IP_СЕРВЕРА:/root/
ssh root@IP_СЕРВЕРА
cd /root
tar -xzf servpanel-2.5.0.tar.gz
bash /root/servpanel-2.5.0/upgrade.sh
```

## Важно

- В панели 1.0.0 **не нажимайте** старую кнопку «Обновить с GitHub». Для
  первого перехода используйте только `upgrade.sh` из терминала.
- Если используется каскад RU → EU, сначала обновите EU-сервер, затем RU.
  Мастер каскада заново запускать не нужно.
- Если `upgrade.sh` сообщил об ошибке, не удаляйте `/root/servpanel` и не
  запускайте установку заново «с нуля» — сначала прочитайте ошибку и бэкап.
