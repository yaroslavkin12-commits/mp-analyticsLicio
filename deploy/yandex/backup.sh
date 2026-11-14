#!/usr/bin/env bash
# Ночная копия именно рабочей базы из app.env; храним 7 последних архивов.
set -euo pipefail
umask 077
exec 9>/var/lib/mp/backup.lock
flock -n 9 || exit 0
PGBIN=/usr/lib/postgresql/$(ls /usr/lib/postgresql | sort -V | tail -1)/bin
export PGBIN
node <<'NODE'
const fs = require('fs');
const { spawnSync } = require('child_process');
const env = require('/opt/mp/app/backend/node_modules/dotenv').parse(fs.readFileSync('/etc/mp/app.env'));
if (!env.DATABASE_URL || !/^postgres(?:ql)?:/.test(env.DATABASE_URL)) throw Error('Не задана рабочая база');
const dir = '/var/backups/mp';
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
const file = `${dir}/mp-${date}.dump`, temp = `${file}.tmp`;
const pgEnv = { ...process.env, PGDATABASE: env.DATABASE_URL, PGCONNECT_TIMEOUT: '30' };
// Строка подключения остаётся в окружении дочернего процесса, не в аргументах и журнале.
try {
  const dump = spawnSync(`${process.env.PGBIN}/pg_dump`, ['--format=custom', '--no-password', '--file', temp], { env: pgEnv, stdio: ['ignore', 'ignore', 'ignore'], timeout: 1800000 });
  if (dump.error || dump.status !== 0) throw Error('Не удалось создать копию рабочей базы');
  const check = spawnSync(`${process.env.PGBIN}/pg_restore`, ['--list', temp], { stdio: 'ignore' });
  if (check.error || check.status !== 0 || fs.statSync(temp).size === 0) throw Error('Архив базы не прошёл проверку');
  fs.renameSync(temp, file);
} catch (error) {
  try { fs.unlinkSync(temp); } catch {}
  console.error(error.message);
  process.exitCode = 1;
  return;
}
const copies = fs.readdirSync(dir).filter(n => /^mp-\d{8}\.dump$/.test(n)).sort().reverse();
for (const name of copies.slice(7)) fs.unlinkSync(`${dir}/${name}`);
const statusFile = '/var/lib/mp/status.json';
let status = {};
try { status = JSON.parse(fs.readFileSync(statusFile)); } catch {}
status.backupAt = new Date().toISOString();
status.backupBytes = fs.statSync(file).size;
status.backupDatabaseMode = status.databaseMode || 'configured';
fs.writeFileSync(statusFile, JSON.stringify(status));
NODE
