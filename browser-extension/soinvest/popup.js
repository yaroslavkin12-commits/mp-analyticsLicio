const DEFAULT_SERVER = 'https://mp-analyticslicio-1.onrender.com';
const NAMES = { licio: 'Licio', defly: 'Defly' };
const fmt = iso => iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

async function render() {
  const { lastRun, server } = await chrome.storage.local.get(['lastRun', 'server']);
  document.getElementById('server').value = server || DEFAULT_SERVER;
  const el = document.getElementById('status');
  if (!lastRun) { el.innerHTML = '<div class="muted">Ещё не запускалось — нажмите «Собрать сейчас».</div>'; return; }
  let html = `<div class="row"><span>Последний сбор</span><b>${fmt(lastRun.finished || lastRun.at)}</b></div>`;
  if (lastRun.error) html += `<div class="bad" style="margin-top:6px">${lastRun.error}</div>`;
  for (const [cab, st] of Object.entries(lastRun.cabinets || {})) {
    html += `<div class="row"><span>${NAMES[cab] || cab}</span>${st.error
      ? `<span class="bad">${st.error}</span>`
      : `<span class="ok">${st.matched} из ${st.asked} товаров</span>`}</div>`;
  }
  el.innerHTML = html;
}

document.getElementById('run').addEventListener('click', async () => {
  const b = document.getElementById('run');
  b.disabled = true; b.textContent = 'Собираем… (до пары минут)';
  await chrome.runtime.sendMessage({ type: 'runNow' }).catch(() => {});
  b.disabled = false; b.textContent = 'Собрать сейчас';
  render();
});
document.getElementById('server').addEventListener('change', e => chrome.storage.local.set({ server: e.target.value.trim() }));
render();
