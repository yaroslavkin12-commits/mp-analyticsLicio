#!/usr/bin/env bash
# Добавление дополнительного входа в существующую конфигурацию HTTPS.
set -euo pipefail
umask 077
python3 <<'PY'
from pathlib import Path
import re, subprocess, shutil
p = Path('/etc/caddy/Caddyfile')
s = p.read_text()
lines = s.splitlines(keepends=True)
# Меняем только известный заголовок сервиса, сохраняя все его настройки.
index = next((i for i, line in enumerate(lines) if 'defly-analytics.ru' in line and line.rstrip().endswith('{')), None)
if index is None:
    raise SystemExit('Не найден существующий блок домена')
header = lines[index]
if not re.search(r'(^|[\s,])app\.defly-analytics\.ru(?=[\s,{])', header):
    lines[index] = header.replace('{', ', app.defly-analytics.ru {', 1)
    candidate = p.with_name('Caddyfile.next')
    candidate.write_text(''.join(lines))
    try:
        subprocess.run(['caddy', 'validate', '--config', str(candidate), '--adapter', 'caddyfile'], check=True, stdout=subprocess.DEVNULL)
        backup = p.with_name('Caddyfile.before-app-domain')
        if not backup.exists():
            shutil.copy2(p, backup)
        candidate.replace(p)
        p.chmod(0o644)
        try:
            subprocess.run(['systemctl', 'reload', 'caddy'], check=True)
        except Exception:
            p.write_text(s)
            p.chmod(0o644)
            subprocess.run(['systemctl', 'reload', 'caddy'], check=False)
            raise
    finally:
        candidate.unlink(missing_ok=True)
PY
