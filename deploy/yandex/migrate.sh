#!/usr/bin/env bash
# Сначала восстановление в отдельную базу. Переключение — только вручную с --activate.
set -euo pipefail
umask 077
STATE=/var/lib/mp
exec 9>"$STATE/migrate.lock"
flock -n 9 || { echo 'Другой перенос уже запущен'; exit 1; }
NEON_DATABASE_URL=$(grep -m1 '^NEON_DATABASE_URL=' /etc/mp/env.clean | cut -d= -f2-)
[ -n "$NEON_DATABASE_URL" ] || { echo 'Не задан источник Neon'; exit 1; }
PGBIN=/usr/lib/postgresql/$(ls /usr/lib/postgresql | sort -V | tail -1)/bin
SV=$(psql "$NEON_DATABASE_URL" -tAc 'SHOW server_version_num')
MAJ=$((SV / 10000))
[ -x /usr/lib/postgresql/$MAJ/bin/pg_dump ] || { echo "Нужен postgresql-client-$MAJ. Перенос не начат."; exit 1; }
PGBIN=/usr/lib/postgresql/$MAJ/bin
RUN=$(date +%Y%m%d%H%M%S)
STAGE="mp_import_$RUN"
OLD="mp_before_$RUN"
DUMP="/var/backups/mp/neon-$RUN.dump"
DBPASS=$(cat /etc/mp/db.pass)
export PGPASSWORD="$DBPASS"
LOCAL="postgres://mp@127.0.0.1:5432/$STAGE"
st() { python3 - "$@" <<'PY'
import json,sys,datetime
p='/var/lib/mp/status.json'
try: d=json.load(open(p))
except Exception: d={}
d.update(dict(a.split('=',1) for a in sys.argv[1:]));d['updated']=datetime.datetime.now().isoformat(timespec='seconds')
json.dump(d,open(p,'w'),ensure_ascii=False)
PY
}
trap 'st migrate=failed; echo "Перенос остановлен. Копии и исходная база сохранены."' ERR
st migrate=dumping
"$PGBIN/pg_dump" --format=custom --no-owner --no-acl -d "$NEON_DATABASE_URL" -f "$DUMP"
sudo -u postgres createdb --owner=mp "$STAGE"
st migrate=restoring stagingDb="$STAGE"
# PostgreSQL 17 и старше не знают SET transaction_timeout из дампа PG18.
# Убираем только эту настройку; любая другая ошибка прекращает восстановление.
"$PGBIN/pg_restore" --no-owner --no-acl -f - "$DUMP" | sed '/^SET transaction_timeout = /d' | psql -X -v ON_ERROR_STOP=1 -d "$LOCAL" >/dev/null
# Сверяем точные количества строк всех пользовательских таблиц.
TABLES="SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
psql -X "$NEON_DATABASE_URL" -Atc "$TABLES" > "$DUMP.tables"
psql -X "$LOCAL" -Atc "$TABLES" > "$DUMP.local-tables"
cmp "$DUMP.tables" "$DUMP.local-tables"
[ -s "$DUMP.tables" ] || { echo 'Источник не содержит таблиц'; exit 1; }
while IFS= read -r table; do
  [[ "$table" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || { echo 'Нестандартное имя таблицы требует проверки'; exit 1; }
  sql="SELECT count(*) FROM public.\"$table\""
  src=$(psql -X "$NEON_DATABASE_URL" -Atc "$sql")
  dst=$(psql -X "$LOCAL" -Atc "$sql")
  [ "$src" = "$dst" ] || { echo "Число строк изменилось: $table; повторите перенос после остановки записи в источник"; exit 1; }
done < "$DUMP.tables"
st migrate=verified stagingDb="$STAGE"
if [ "${1:-}" != '--activate' ]; then
  echo "Копия $STAGE проверена. Рабочая база не переключена."
  exit 0
fi
# Резервируем работающую базу; ни одна база не удаляется.
systemctl stop mp.service
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d postgres <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('mp', '$STAGE') AND pid <> pg_backend_pid();
ALTER DATABASE mp RENAME TO $OLD;
ALTER DATABASE $STAGE RENAME TO mp;
SQL
systemctl start mp.service
healthy=0
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 3 http://127.0.0.1:3000/health >/dev/null; then healthy=1; break; fi
  sleep 2
done
if [ "$healthy" = 0 ]; then
  systemctl stop mp.service
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d postgres <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='mp' AND pid <> pg_backend_pid();
ALTER DATABASE mp RENAME TO $STAGE;
ALTER DATABASE $OLD RENAME TO mp;
SQL
  systemctl start mp.service
  st migrate=rolled-back
  exit 1
fi
date -Is > "$STATE/migrated"
st migrate=done rollbackDb="$OLD" migratedAt="$(date -Is)"
echo "Перенос завершён. База для отката: $OLD"
