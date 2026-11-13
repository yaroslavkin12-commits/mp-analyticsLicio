#!/usr/bin/env bash
# Перенос базы из Neon в локальную. Сервис на время останавливается.
# Запускается при первой настройке и повторно — когда в репозитории меняется migrate.stamp.
set -euo pipefail
PGBIN=/usr/lib/postgresql/$(ls /usr/lib/postgresql | sort -V | tail -1)/bin
STATE=/var/lib/mp
NEON_DATABASE_URL=$(grep -m1 "^NEON_DATABASE_URL=" /etc/mp/env.clean | cut -d= -f2-)
[ -n "${NEON_DATABASE_URL:-}" ] || { echo "нет NEON_DATABASE_URL"; exit 1; }
DBPASS=$(cat /etc/mp/db.pass)
LOCAL="postgres://mp:${DBPASS}@127.0.0.1:5432/mp"
DUMP=/var/backups/mp/neon-$(date +%Y%m%d-%H%M).dump
st() { python3 -c "import json,sys,datetime;p='/var/lib/mp/status.json'
try: d=json.load(open(p))
except Exception: d={}
d.update(dict(a.split('=',1) for a in sys.argv[1:])); d['updated']=datetime.datetime.now().isoformat(timespec='seconds'); json.dump(d,open(p,'w'),ensure_ascii=False)" "$@"; }
st migrate=running
echo "=== перенос из Neon $(date -Is)"
$PGBIN/pg_dump --format=custom --no-owner --no-acl -d "$NEON_DATABASE_URL" -f "$DUMP"
systemctl stop mp.service || true
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS mp WITH (FORCE)" -c "CREATE DATABASE mp OWNER mp"
$PGBIN/pg_restore --no-owner --no-acl --jobs 2 -d "$LOCAL" "$DUMP" || echo "pg_restore завершился с предупреждениями"
sudo -u postgres psql -d mp -c "ANALYZE" >/dev/null
ROWS=$(psql "$LOCAL" -tAc "SELECT COALESCE(SUM(n_live_tup),0) FROM pg_stat_user_tables" || echo 0)
SIZE=$(psql "$LOCAL" -tAc "SELECT pg_size_pretty(pg_database_size('mp'))" || echo '?')
date -Is > "$STATE/migrated"
st migrate=done migratedAt="$(date -Is)" migratedRows="$ROWS" dbSize="$SIZE"
systemctl start mp.service || true
echo "=== перенос готов: $SIZE"
