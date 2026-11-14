const DEFAULT_SERVER = 'https://defly-analytics.ru';
const NAMES = { licio: 'Licio', defly: 'Defly', nabauto: 'NABauto', alex: 'Alex', fullgas: 'Fullgas', accent: 'Accent Line' };
const fmt = iso => iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

async function renderCards() {
  const { lastCards: c } = await chrome.storage.local.get('lastCards');
  const el = document.getElementById('cards');
  let html = '<div class="row"><b>Карточки конкурентов</b><span></span></div>';
  if (!c) html += '<div class="muted">Ещё не собирались — нажмите кнопку ниже.</div>';
  else if (c.running && Date.now() - Date.parse(c.at) > 10 * 60000) html += '<div class="bad">Сбор прервался (браузер выгрузил расширение) — нажмите кнопку ещё раз.</div>';
  else if (c.running) html += `<div class="muted">Идёт сбор… ${c.got || 0} из ${c.asked || '?'}</div>`;
  else {
    html += `<div class="row"><span>${fmt(c.finished || c.at)}</span>${c.asked ? `<span class="${c.got ? 'ok' : 'bad'}">${c.got} из ${c.asked} карточек</span>` : '<span class="muted">в сервисе нет конкурентов</span>'}</div>`;
    if (c.error) html += `<div class="bad" style="margin-top:6px">${c.error}</div>`;
  }
  el.innerHTML = html;
}
async function renderAgent() {
  const { agentState: a } = await chrome.storage.local.get('agentState');
  const el = document.getElementById('agent');
  let html = '<div class="row"><b>Выдача и «Товары на Ozon»</b><span></span></div>';
  if (!a) html += '<div class="muted">Ещё не запускалось. Сбор идёт сам: выдача — раз в 4 часа, «Товары на Ozon» — раз в день после 10:00.</div>';
  else {
    if (a.running) html += '<div class="muted">Идёт сбор… выдача ' + (a.serpOk || 0) + ' из ' + (a.serpAsked || '?') + '</div>';
    else html += `<div class="row"><span>${fmt(a.finished || a.at)}</span><span class="ok">${a.note ? a.note : 'выдача ' + (a.serpOk || 0) + ' из ' + (a.serpAsked || 0)}</span></div>`;
    if (a.qOk != null) html += `<div class="row"><span>Запросы товаров (дни)</span><span class="ok">${a.qOk} загружено${a.qLeft > 0 ? ' · осталось ' + a.qLeft : ''}</span></div>`;
    if (a.marketDate) html += `<div class="row"><span>«Товары на Ozon»</span><span class="ok">${a.marketDate.slice(8)}.${a.marketDate.slice(5, 7)} · ${a.marketOk || 0} из ${a.marketAsked || 0}</span></div>`;
    if (a.error) html += `<div class="bad" style="margin-top:6px">${a.error}</div>`;
  }
  el.innerHTML = html;
}
async function saveConnection() {
  await chrome.storage.local.set({server:document.getElementById('server').value.trim(),apiKey:document.getElementById('apiKey').value.trim()});
}
async function render() {
  renderCards(); renderAgent();
  document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  const { lastRun, server, apiKey, authError, connectionCheck } = await chrome.storage.local.get(['lastRun', 'server', 'apiKey', 'authError', 'connectionCheck']);
  const check = document.getElementById('connectionStatus');
  check.textContent = connectionCheck ? (connectionCheck.running ? 'Проверяем связь…' : connectionCheck.message) : '';
  check.className = connectionCheck?.ok ? 'ok' : 'bad';
  const ak = document.getElementById('apiKey'); if (document.activeElement !== ak) ak.value = apiKey || '';
  document.getElementById('authErr').textContent = authError || '';
  const srv = document.getElementById('server'); if (document.activeElement !== srv) srv.value = server || DEFAULT_SERVER;
  const el = document.getElementById('status');
  if (!lastRun) { el.innerHTML = '<div class="muted">Ещё не запускалось — нажмите «Собрать сейчас».</div>'; return; }
  let html = `<div class="row"><span>Последний сбор</span><b>${fmt(lastRun.finished || lastRun.at)}</b></div>`;
  if (lastRun.running) html += '<div class="muted">' + (Date.now()-Date.parse(lastRun.updatedAt || lastRun.at)>120000 ? 'Сбор прервался. Запустите заново.' : lastRun.phase || 'Идёт сбор…') + '</div>';
  if (lastRun.error) html += `<div class="bad" style="margin-top:6px">${lastRun.error}</div>`;
  for (const [cab, st] of Object.entries(lastRun.cabinets || {})) {
    html += `<div class="row"><span>${NAMES[cab] || cab}</span>${st.error
      ? `<span class="bad">${st.error}</span>`
      : `<span class="ok">${st.matched} из ${st.asked} товаров</span>`}</div>`;
  }
  el.innerHTML = html;
}

document.getElementById('run').addEventListener('click', async () => {
  await saveConnection();
  const b = document.getElementById('run');
  b.disabled = true; b.textContent = 'Собираем… (до пары минут)';
  await chrome.runtime.sendMessage({ type: 'runNow' }).catch(() => {});
  b.disabled = false; b.textContent = 'Собрать цены сейчас';
  render();
});
document.getElementById('server').addEventListener('change', e => chrome.storage.local.set({ server: e.target.value.trim() }));
document.getElementById('apiKey').addEventListener('change', e => chrome.storage.local.set({ apiKey: e.target.value.trim() }).then(() => chrome.storage.local.remove('authError')));
render();
setInterval(render, 2000);

document.getElementById('runCards').addEventListener('click', async () => {
  await saveConnection();
  const b = document.getElementById('runCards');
  b.disabled = true; b.textContent = 'Собираю карточки…';
  await chrome.runtime.sendMessage({ type: 'runCards' }).catch(() => {});
  b.disabled = false; b.textContent = 'Обновить карточки конкурентов';
  render();
});

document.getElementById('runAgent').addEventListener('click', async () => {
  await saveConnection();
  const b = document.getElementById('runAgent');
  b.disabled = true; b.textContent = 'Собираю…';
  await chrome.runtime.sendMessage({ type: 'runAgent' }).catch(() => {});
  b.disabled = false; b.textContent = 'Собрать выдачу и «Товары на Ozon» сейчас';
  render();
});

document.getElementById('checkConnection').addEventListener('click', async () => {
  await saveConnection();
  const b=document.getElementById('checkConnection'); b.disabled=true;
  try { await chrome.runtime.sendMessage({type:'checkConnection'}); } finally { b.disabled=false;render(); }
});
