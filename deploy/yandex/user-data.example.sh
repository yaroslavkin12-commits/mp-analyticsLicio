#!/bin/bash
# Вставляется в «Метаданные» → ключ user-data при создании сервера в Yandex Cloud.
# Отступы не важны. Значения — из Render → Environment. Видно только администраторам облака.
exec > >(tee -a /var/log/mp-userdata.log /dev/ttyS0) 2>&1
echo "=== user-data: старт"
mkdir -p /etc/mp
cat > /etc/mp/env.user <<'END_OF_SETTINGS'
DOMAIN=defly-analytics.ru
ADMIN_LOGIN=evgeniy
ADMIN_PASSWORD=
NEON_DATABASE_URL=
ADS_DIRECT_DISABLED=true
END_OF_SETTINGS
B=deploy/yandex/bootstrap.sh
for u in https://raw.githubusercontent.com/yaroslavkin12-commits/mp-analyticsLicio/main/$B https://cdn.jsdelivr.net/gh/yaroslavkin12-commits/mp-analyticsLicio@main/$B; do
  curl -fsSL --retry 3 -m 60 "$u" -o /root/mp-bootstrap.sh && break
  echo "=== не скачалось: $u"
done
[ -s /root/mp-bootstrap.sh ] || { git clone --depth 1 https://github.com/yaroslavkin12-commits/mp-analyticsLicio.git /root/mp-src && cp /root/mp-src/$B /root/mp-bootstrap.sh; }
bash /root/mp-bootstrap.sh
