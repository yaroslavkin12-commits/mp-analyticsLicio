#!/usr/bin/env bash
# Ночная копия базы: /var/backups/mp/mp-ГГГГММДД.dump, храним 7 последних.
set -euo pipefail
PGBIN=/usr/lib/postgresql/$(ls /usr/lib/postgresql | sort -V | tail -1)/bin
DBPASS=$(cat /etc/mp/db.pass)
F=/var/backups/mp/mp-$(date +%Y%m%d).dump
$PGBIN/pg_dump --format=custom -d "postgres://mp:${DBPASS}@127.0.0.1:5432/mp" -f "$F.tmp" && mv "$F.tmp" "$F"
ls -1t /var/backups/mp/mp-*.dump | tail -n +8 | xargs -r rm -f
python3 -c "import json,datetime;p='/var/lib/mp/status.json'
try: d=json.load(open(p))
except Exception: d={}
d['backupAt']=datetime.datetime.now().isoformat(timespec='seconds'); json.dump(d,open(p,'w'),ensure_ascii=False)"
