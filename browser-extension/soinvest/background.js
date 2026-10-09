// Расширение «Соинвест Ozon» для сервиса MP Analytics.
//
// Что делает: раз в час (и по кнопке) берёт у сервиса список товаров
// (product_id) по кабинетам, спрашивает у кабинета seller.ozon.ru цены на
// витрине тем же внутренним методом, что и страница «Цены» кабинета
// (get-common-prices), и отправляет ответ в сервис. Запрос выполняется
// внутри вкладки seller.ozon.ru — то есть ровно так же, как это делает сам
// кабинет, с вашим входом. Пароли и cookie расширение не читает и никуда
// не передаёт: в сервис уходят только цены.

const DEFAULT_SERVER = 'https://mp-analyticslicio-1.onrender.com';
const CHUNK = 200;
const sleep = ms => new Promise(r => setTimeout(r, ms));

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('soinvest', { delayInMinutes: 1, periodInMinutes: 60 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('soinvest', { delayInMinutes: 2, periodInMinutes: 60 });
});
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'soinvest') run('по расписанию'); });
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'runNow') { run('вручную').then(() => reply({ ok: true })); return true; }
  return false;
});

async function getServer() {
  const { server } = await chrome.storage.local.get('server');
  return (server || DEFAULT_SERVER).replace(/\/+$/, '');
}

// Вкладка кабинета: берём открытую, иначе открываем фоновую и потом закрываем.
async function sellerTab() {
  const tabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
  const ready = tabs.find(t => t.status === 'complete') || tabs[0];
  if (ready) return { id: ready.id, created: false };
  const tab = await chrome.tabs.create({ url: 'https://seller.ozon.ru/app/main', active: false });
  await new Promise(resolve => {
    const t = setTimeout(resolve, 30000);
    chrome.tabs.onUpdated.addListener(function l(id, info) {
      if (id === tab.id && info.status === 'complete') { clearTimeout(t); chrome.tabs.onUpdated.removeListener(l); resolve(); }
    });
  });
  await sleep(1500);
  return { id: tab.id, created: true };
}

async function askPrices(tabId, companyId, ids) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [String(companyId), ids],
    func: async (company, itemIds) => {
      try {
        const r = await fetch('/api/pricing-bff-service/v3/get-common-prices', {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ company_id: company, item_ids: itemIds }),
        });
        return { status: r.status, text: await r.text() };
      } catch (e) { return { status: 0, text: String(e && e.message || e) }; }
    },
  });
  return res && res.result ? res.result : { status: 0, text: 'нет ответа от вкладки' };
}

async function run(reason) {
  const started = new Date().toISOString();
  const status = { at: started, reason, cabinets: {}, error: null };
  let tab = null;
  try {
    const server = await getServer();
    const tr = await fetch(server + '/api/discounts/targets');
    if (!tr.ok) throw new Error('сервис не ответил (' + tr.status + ')');
    const targets = (await tr.json()).data || [];
    if (!targets.some(t => t.productIds && t.productIds.length)) throw new Error('сервис пока не знает товаров ни одного кабинета');
    tab = await sellerTab();
    for (const t of targets) {
      const st = { asked: t.productIds.length, got: 0, matched: 0, error: null };
      status.cabinets[t.cabinet] = st;
      if (!t.productIds.length) { st.error = 'нет списка товаров'; continue; }
      const items = [];
      for (let i = 0; i < t.productIds.length; i += CHUNK) {
        const r = await askPrices(tab.id, t.companyId, t.productIds.slice(i, i + CHUNK));
        if (r.status === 401 || r.status === 403 || /^\s*</.test(r.text)) { st.error = 'нет входа в кабинет Ozon (откройте seller.ozon.ru и войдите)'; break; }
        if (r.status !== 200) { st.error = 'кабинет ответил ' + r.status + ': ' + r.text.slice(0, 120); break; }
        let data = null;
        try { data = JSON.parse(r.text); } catch (e) { st.error = 'непонятный ответ кабинета'; break; }
        items.push(...(data.items || []));
        await sleep(700);
      }
      st.got = items.length;
      if (items.length) {
        const ir = await fetch(server + '/api/discounts/ingest', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cabinet: t.cabinet, items }),
        });
        const ij = await ir.json().catch(() => ({}));
        if (!ir.ok || !ij.success) st.error = 'сервис не принял данные: ' + (ij.error || ir.status);
        else st.matched = ij.data.matched;
      } else if (!st.error) st.error = 'кабинет не вернул цен (нет доступа к этому кабинету?)';
    }
  } catch (e) {
    status.error = String(e && e.message || e);
  } finally {
    if (tab && tab.created) chrome.tabs.remove(tab.id).catch(() => {});
    status.finished = new Date().toISOString();
    await chrome.storage.local.set({ lastRun: status });
  }
}
