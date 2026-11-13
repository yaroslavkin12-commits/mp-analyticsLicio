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
# Повторный перенос базы по команде из репозитория.
WANT=$(cat "$APP/deploy/yandex/migrate.stamp" 2>/dev/null || echo "")
HAVE=$(cat "$STATE/migrate.stamp" 2>/dev/null || echo "")
if [ -n "$WANT" ] && [ "$WANT" != "$HAVE" ] && [ -f "$STATE/migrated" ]; then
  echo "=== $(date -Is) повторный перенос базы: $WANT"
  bash "$APP/deploy/yandex/migrate.sh" && echo "$WANT" > "$STATE/migrate.stamp"
elif [ -n "$WANT" ] && [ -z "$HAVE" ]; then echo "$WANT" > "$STATE/migrate.stamp"; fi
# Отметка, что обновлялка жива.
st checkedAt="$(date -Is)"
