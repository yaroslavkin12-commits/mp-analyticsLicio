#!/usr/bin/env bash
# Самообновление из GitHub (раз в 2 минуты): новый коммит в main → сборка и перезапуск.
# Если в репозитории поменялся deploy/yandex/migrate.stamp — повторный перенос базы из Neon.
set -uo pipefail
APP=/opt/mp/app
STATE=/var/lib/mp
exec >> /var/log/mp-update.log 2>&1
st() { python3 -c "import json,sys,datetime;p='/var/lib/mp/status.json'
try: d=json.load(open(p))
except Exception: d={}
d.update(dict(a.split('=',1) for a in sys.argv[1:])); d['updated']=datetime.datetime.now().isoformat(timespec='seconds'); json.dump(d,open(p,'w'),ensure_ascii=False)" "$@"; }
cd "$APP" || exit 1
git config --system --get-all safe.directory 2>/dev/null | grep -qx "$APP" || git config --system --add safe.directory "$APP"
sudo -u mp git fetch -q origin main || { st lastError="git fetch $(date -Is)"; exit 0; }
OLD=$(git rev-parse HEAD); NEW=$(git rev-parse origin/main)
if [ "$OLD" != "$NEW" ]; then
  echo "=== $(date -Is) обновление ${OLD:0:7} → ${NEW:0:7}"
  CHANGED=$(git diff --name-only "$OLD" "$NEW")
  sudo -u mp git reset -q --hard "$NEW"
  if echo "$CHANGED" | grep -q '^backend/package'; then sudo -u mp bash -c "cd backend && npm install --omit=dev --no-audit --no-fund"; fi
  if echo "$CHANGED" | grep -q '^dashboard/'; then
    if echo "$CHANGED" | grep -q '^dashboard/package'; then sudo -u mp bash -c "cd dashboard && npm install --no-audit --no-fund"; fi
    sudo -u mp bash -c "cd dashboard && npm run build" || { st lastError="сборка ${NEW:0:7} $(date -Is)"; }
  fi
  if echo "$CHANGED" | grep -q -E '^(backend/|dashboard/src/lib/.*\.mjs)'; then systemctl restart mp.service; fi
  st commit="${NEW:0:7}" deployedAt="$(date -Is)"
fi
# Перенос базы запускается оператором отдельно после проверки источника.
# Изменение migrate.stamp больше не перезаписывает рабочую базу.
# Отметка, что обновлялка жива.
st checkedAt="$(date -Is)"

# Видимость одноразовой подготовки базы без публикации содержимого журналов.
if [ -f /var/log/mp-migrate-safe.log ]; then
  JOB_STATE=$(systemctl show mp-migration-prepare.service -p ActiveState --value 2>/dev/null || true)
  JOB_EXIT=$(systemctl show mp-migration-prepare.service -p ExecMainStatus --value 2>/dev/null || true)
  MIG_ERROR=''
  if grep -q '^Число строк изменилось:' /var/log/mp-migrate-safe.log; then MIG_ERROR='Источник изменился во время сверки';
  elif grep -qE '^(ERROR:|pg_restore: error:)' /var/log/mp-migrate-safe.log; then MIG_ERROR='Ошибка восстановления SQL'; fi
  st migrationJob="$JOB_STATE" migrationExit="$JOB_EXIT" migrationError="$MIG_ERROR"
fi
# Разовая проверка рабочего входа и отчётов; пароль остаётся внутри сервера.
if [ ! -f /var/lib/mp/verified-shared-attempted ] && grep -q 'neon-shared' /var/lib/mp/status.json; then
  touch /var/lib/mp/verified-shared-attempted
  node "$APP/deploy/yandex/verify-service.cjs"
fi
