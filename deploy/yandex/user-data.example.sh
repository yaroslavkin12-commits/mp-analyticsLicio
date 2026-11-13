#!/bin/bash
# Вставляется в «Метаданные» → ключ user-data при создании сервера в Yandex Cloud.
# Отступы не важны. Значения — из Render → Environment. Видно только администраторам облака.
mkdir -p /etc/mp
cat > /etc/mp/env.user <<'END_OF_SETTINGS'
DOMAIN=defly-analytics.ru
ADMIN_LOGIN=evgeniy
ADMIN_PASSWORD=
NEON_DATABASE_URL=
ADS_DIRECT_DISABLED=true
END_OF_SETTINGS
curl -fsSL https://raw.githubusercontent.com/yaroslavkin12-commits/mp-analyticsLicio/main/deploy/yandex/bootstrap.sh -o /root/mp-bootstrap.sh && bash /root/mp-bootstrap.sh
