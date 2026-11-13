// Страница входа: отдельная, без сборки дашборда, чтобы не отдавать его до входа.
module.exports = () => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Вход — Defly аналитика</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111318;color:#e8e9ed;font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:16px}
form{width:100%;max-width:340px;background:#191c23;border:1px solid #2a2e38;border-radius:16px;padding:28px}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 20px;color:#9aa0ad;font-size:13px}
label{display:block;font-size:12px;color:#9aa0ad;margin:12px 0 6px}
input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid #2f3440;background:#0f1115;color:inherit;font:inherit}
input:focus{outline:2px solid #7c6cf6;border-color:transparent}
button{margin-top:20px;width:100%;padding:11px;border:0;border-radius:10px;background:#7c6cf6;color:#fff;font:600 15px inherit;cursor:pointer}
button:disabled{opacity:.6}.err{color:#ff7b7b;font-size:13px;margin-top:12px;min-height:18px}
</style></head><body>
<form id="f"><h1>Defly — аналитика</h1><p>Войдите, чтобы открыть сервис</p>
<label for="l">Логин</label><input id="l" name="login" autocomplete="username" autofocus required>
<label for="p">Пароль</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<button id="b">Войти</button><div class="err" id="e" role="alert"></div></form>
<script>
document.getElementById('f').addEventListener('submit', async ev => {
  ev.preventDefault(); const b = document.getElementById('b'), e = document.getElementById('e'); b.disabled = true; e.textContent = '';
  try {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: document.getElementById('l').value, password: document.getElementById('p').value }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.success) { location.href = '/'; return; }
    e.textContent = j.error || 'Не удалось войти';
  } catch (x) { e.textContent = 'Нет связи с сервисом'; }
  b.disabled = false;
});
</script></body></html>`;
