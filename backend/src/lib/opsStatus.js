// Состояние сервера без секретов: версия, время работы, последняя выкладка и перенос базы.
// Файл /var/lib/mp/status.json пишут скрипты выкладки на сервере в Яндексе.
const fs = require('fs');
const path = require('path');
const started = new Date();
function head() {
  try {
    const dir = path.join(__dirname, '../../../.git');
    const h = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
    return h.startsWith('ref:') ? fs.readFileSync(path.join(dir, h.slice(5)), 'utf8').trim().slice(0, 7) : h.slice(0, 7);
  } catch (e) { return process.env.RENDER_GIT_COMMIT ? process.env.RENDER_GIT_COMMIT.slice(0, 7) : null; }
}
module.exports = () => {
  let deploy = null;
  try { deploy = JSON.parse(fs.readFileSync('/var/lib/mp/status.json', 'utf8')); } catch (e) { /* не сервер Яндекса */ }
  return { ok: true, commit: head(), started, uptimeMin: Math.round(process.uptime() / 60), node: process.version,
    memMb: Math.round(process.memoryUsage().rss / 1048576), auth: process.env.AUTH_ENABLED === '1', deploy };
};
