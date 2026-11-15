#!/usr/bin/env bash
# Отдельный ключ шифрования паролей: не попадает в GitHub и в базу.
set -euo pipefail
KEYFILE=/etc/mp/password-vault.key
if [ ! -s "$KEYFILE" ]; then
  umask 077
  if grep -q '^USER_PASSWORD_VAULT_KEY=' /etc/mp/app.env; then
    sed -n 's/^USER_PASSWORD_VAULT_KEY=//p' /etc/mp/app.env > "$KEYFILE"
  else
    openssl rand -hex 32 > "$KEYFILE"
  fi
fi
chmod 600 "$KEYFILE"; chown root:root "$KEYFILE"
if ! grep -q '^USER_PASSWORD_VAULT_KEY=' /etc/mp/app.env; then
  printf '\nUSER_PASSWORD_VAULT_KEY=%s\n' "$(cat "$KEYFILE")" >> /etc/mp/app.env
  chmod 600 /etc/mp/app.env
  echo changed
fi
