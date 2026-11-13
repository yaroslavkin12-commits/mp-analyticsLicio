#!/usr/bin/env bash
# Первичная настройка сервера в Yandex Cloud (Ubuntu 24.04). Запускается один раз
# из cloud-init; можно запускать повторно — шаги проверяют, сделаны ли они.
# Настройки пользователя: /etc/mp/env.user (вставлены при создании сервера).
set -euo pipefail
# Журнал — в файл и в «Последовательный порт» консоли Яндекса (видно без входа на сервер).
exec > >(tee -a /var/log/mp-bootstrap.log /dev/ttyS0) 2>&1
trap 'echo "=== ОШИБКА в строке $LINENO: $BASH_COMMAND"' ERR
echo "=== bootstrap $(date -Is)"

REPO=https://github.com/yaroslavkin12-commits/mp-analyticsLicio.git
APP=/opt/mp/app
STATE=/var/lib/mp
mkdir -p /etc/mp "$STATE" /var/backups/mp
status() { python3 - "$@" <<'PY'
import json, sys, os, datetime
p = '/var/lib/mp/status.json'
try: d = json.load(open(p))
except Exception: d = {}
for kv in sys.argv[1:]:
    k, v = kv.split('=', 1); d[k] = v
d['updated'] = datetime.datetime.now().isoformat(timespec='seconds')
json.dump(d, open(p, 'w'), ensure_ascii=False)
PY
}
status stage=bootstrap

[ -f /etc/mp/env.user ] || { echo "нет /etc/mp/env.user"; status stage=error error="нет настроек"; exit 1; }
# Настройки как их вставили: убираем отступы, пробелы по краям, \r и пустые строки.
# Значения не «выполняем» в shell — в них бывают & ; и пробелы (адрес базы, cookie).
sed -e 's/\r$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' /etc/mp/env.user | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' > /etc/mp/env.clean || true
chmod 600 /etc/mp/env.clean
envget() { grep -m1 "^$1=" /etc/mp/env.clean | cut -d= -f2- ; }
DOMAIN=$(envget DOMAIN); NEON_DATABASE_URL=$(envget NEON_DATABASE_URL)

export DEBIAN_FRONTEND=noninteractive
# Подкачка 2 ГБ — сборка дашборда не упирается в память.
if ! swapon --show | grep -q /swapfile; then fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi
timedatectl set-timezone Europe/Moscow || true

apt-get update -y
apt-get install -y curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https python3

# PostgreSQL: официальный репозиторий (17), если недоступен — из Ubuntu (16).
if ! ls /usr/lib/postgresql/*/bin/postgres >/dev/null 2>&1; then
  echo "=== ставлю PostgreSQL"
  install -d /usr/share/postgresql-common/pgdg
  if curl -fsSL -m 60 https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc; then
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main" > /etc/apt/sources.list.d/pgdg.list
    { apt-get update -y && apt-get install -y postgresql-17; } || { rm -f /etc/apt/sources.list.d/pgdg.list; apt-get update -y; apt-get install -y postgresql; }
  else apt-get install -y postgresql; fi
fi
PGVER=$(ls /usr/lib/postgresql | sort -V | tail -1); PGBIN=/usr/lib/postgresql/$PGVER/bin
echo "=== PostgreSQL $PGVER"
# Node.js: NodeSource (22), если недоступен — из Ubuntu.
if ! node -v 2>/dev/null | grep -qE '^v(2[0-9])'; then
  echo "=== ставлю Node.js"
  { curl -fsSL -m 60 https://deb.nodesource.com/setup_22.x -o /tmp/nodesource.sh && bash /tmp/nodesource.sh && apt-get install -y nodejs; } || apt-get install -y nodejs npm
fi
echo "=== Node $(node -v)"
# Caddy — HTTPS-сертификаты сам. Официальный репозиторий, иначе из Ubuntu.
if ! command -v caddy >/dev/null; then
  echo "=== ставлю Caddy"
  { curl -1sLf -m 60 https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    && curl -1sLf -m 60 https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list \
    && apt-get update -y && apt-get install -y caddy; } || { rm -f /etc/apt/sources.list.d/caddy-stable.list; apt-get update -y; apt-get install -y caddy; }
fi

# База: настройки под 4 ГБ памяти, пользователь и пароль.
PGCONF=/etc/postgresql/$PGVER/main/conf.d/mp.conf
mkdir -p "$(dirname "$PGCONF")"
if [ ! -f "$PGCONF" ]; then
  cat > "$PGCONF" <<'EOF'
shared_buffers = 1GB
effective_cache_size = 2GB
work_mem = 32MB
maintenance_work_mem = 256MB
random_page_cost = 1.1
max_connections = 50
EOF
  systemctl restart postgresql
fi
if [ ! -f /etc/mp/db.pass ]; then
  openssl rand -hex 24 > /etc/mp/db.pass; chmod 600 /etc/mp/db.pass
  P=$(cat /etc/mp/db.pass)
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE mp LOGIN PASSWORD '$P'" -c "CREATE DATABASE mp OWNER mp"
fi
DBPASS=$(cat /etc/mp/db.pass)

# Настройки сервиса: всё из env.user + своя база + вход по паролю.
id mp >/dev/null 2>&1 || useradd --system --home /opt/mp --shell /usr/sbin/nologin mp
{
  grep -v -E '^(DATABASE_URL|NEON_DATABASE_URL|PORT|NODE_ENV|AUTH_ENABLED|DOMAIN|PUBLIC_URL|RENDER_[A-Z_]*)=' /etc/mp/env.clean | grep -v -E '^[A-Za-z_][A-Za-z0-9_]*=$' || true
  echo "DATABASE_URL=postgres://mp:${DBPASS}@127.0.0.1:5432/mp"
  echo "NODE_ENV=production"
  echo "PORT=3000"
  echo "AUTH_ENABLED=1"
  [ -n "${DOMAIN:-}" ] && echo "PUBLIC_URL=https://${DOMAIN}"
  echo "NODE_OPTIONS=--max-old-space-size=2048"
} > /etc/mp/app.env
chmod 600 /etc/mp/app.env; chown root:root /etc/mp/app.env

# Код
echo "=== код из GitHub"
if [ ! -d "$APP/.git" ]; then mkdir -p /opt/mp && git clone --depth 50 "$REPO" "$APP"; fi
chown -R mp:mp /opt/mp
cd "$APP"
echo "=== установка и сборка"
sudo -u mp bash -c "cd backend && npm install --omit=dev --no-audit --no-fund"
sudo -u mp bash -c "cd dashboard && npm install --no-audit --no-fund && npm run build"

# Сервис
cat > /etc/systemd/system/mp.service <<EOF
[Unit]
Description=Defly analytics
After=network-online.target postgresql.service
Wants=network-online.target
[Service]
User=mp
WorkingDirectory=$APP
EnvironmentFile=/etc/mp/app.env
ExecStart=/usr/bin/node backend/src/index.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
# Самообновление из GitHub раз в 2 минуты и ночная копия базы.
cat > /etc/systemd/system/mp-update.service <<EOF
[Unit]
Description=Defly: обновление из GitHub
[Service]
Type=oneshot
ExecStart=/bin/bash -c 'cp $APP/deploy/yandex/update.sh /usr/local/bin/mp-update && bash /usr/local/bin/mp-update'
EOF
cat > /etc/systemd/system/mp-update.timer <<'EOF'
[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
EOF
cat > /etc/systemd/system/mp-backup.service <<EOF
[Unit]
Description=Defly: копия базы
[Service]
Type=oneshot
ExecStart=/bin/bash $APP/deploy/yandex/backup.sh
EOF
cat > /etc/systemd/system/mp-backup.timer <<'EOF'
[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
[Install]
WantedBy=timers.target
EOF

# Перенос данных из Neon (один раз).
if [ -n "${NEON_DATABASE_URL:-}" ] && [ ! -f "$STATE/migrated" ]; then
  echo "=== перенос базы из Neon"
  bash "$APP/deploy/yandex/migrate.sh" || echo "перенос не удался — сервис стартует с пустой базой, перенос повторится по команде"
fi

# HTTPS: свой домен и запасной адрес на sslip.io (работает сразу, без DNS).
IP=$(curl -fsS -H Metadata-Flavor:Google http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip 2>/dev/null || curl -fsS https://ifconfig.me)
SSLIP="$(echo "$IP" | tr . -).sslip.io"
SITES="$SSLIP"; [ -n "${DOMAIN:-}" ] && SITES="${DOMAIN}, www.${DOMAIN}, ${SSLIP}"
cat > /etc/caddy/Caddyfile <<EOF
${SITES} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
EOF
systemctl daemon-reload
systemctl enable --now mp.service mp-update.timer mp-backup.timer
systemctl reload caddy || systemctl restart caddy
status stage=ready ip="$IP" sslip="https://$SSLIP" domain="${DOMAIN:-}" commit="$(git -C "$APP" rev-parse --short HEAD)"
echo "=== готово: https://$SSLIP ${DOMAIN:+и https://$DOMAIN}"
