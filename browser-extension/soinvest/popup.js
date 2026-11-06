const DEFAULT_SERVER = 'https://mp-analyticslicio-1.onrender.com';
const NAMES = { licio: 'Licio', defly: 'Defly', nabauto: 'NABauto', alex: 'Alex', fullgas: 'Fullgas', accent: 'Accent Line' };
const fmt = iso => iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

async function renderCards() {
  const { lastCards: c } = await chrome.storage.local.get('lastCards');
  const el = document.getElementById('cards');
  let html = '<div class="row"><b>Карточки конкурентов</b><span></span></div>';
  if (!c) html += '<div class="muted">Ещё не собирались — нажмите кнопку ниже.</div>';
  else if (c.running) html += `<div class="muted">Идёт сбор… ${c.got || 0} из ${c.asked || '?'}</div>`;
  else {
    html += `<div class="row"><span>${fmt(c.finished || c.at)}</span>${c.asked ? `<span class="${c.got ? 'ok' : 'bad'}">${c.got} из ${c.asked} карточек</span>` : '<span class="muted">в сервисе нет конкурентов</span>'}</div>`;
    if (c.error) html += `<div class="bad" style="margin-top:6px">${c.error}</div>`;
  }
  el.innerHTML = html;
}
async function render() {
  renderCards();
  document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  const { lastRun, server } = await chrome.storage.local.get(['lastRun', 'server']);
  const srv = document.getElementById('server'); if (document.activeElement !== srv) srv.value = server || DEFAULT_SERVER;
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
  b.disabled = false; b.textContent = 'Собрать цены сейчас';
  render();
});
document.getElementById('server').addEventListener('change', e => chrome.storage.local.set({ server: e.target.value.trim() }));
render();
setInterval(render, 2000);

document.getElementById('runCards').addEventListener('click', async () => {
  const b = document.getElementById('runCards');
  b.disabled = true; b.textContent = 'Собираю карточки…';
  await chrome.runtime.sendMessage({ type: 'runCards' }).catch(() => {});
  b.disabled = false; b.textContent = 'Обновить карточки конкурентов';
  render();
});
