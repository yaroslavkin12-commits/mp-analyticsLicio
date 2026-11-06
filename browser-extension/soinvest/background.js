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
  chrome.alarms.create('cards', { delayInMinutes: 3, periodInMinutes: 360 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('soinvest', { delayInMinutes: 2, periodInMinutes: 60 });
  chrome.alarms.create('cards', { delayInMinutes: 5, periodInMinutes: 360 });
});
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'soinvest') run('по расписанию');
  if (a.name === 'cards') runCards('по расписанию');
});
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'runNow') { run('вручную').then(() => reply({ ok: true })); return true; }
  if (msg && msg.type === 'runCards') { runCards('вручную').then(() => reply({ ok: true })); return true; }
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
      if (!t.productIds.length) { st.error = 'кабинет пока не подключён в сервисе'; continue; }
      const items = [];
      for (let i = 0; i < t.productIds.length; i += CHUNK) {
        const r = await askPrices(tab.id, t.companyId, t.productIds.slice(i, i + CHUNK));
        if (r.status === 401 || r.status === 403 || /^\s*</.test(r.text)) { st.error = 'нет входа в кабинет Ozon (откройте seller.ozon.ru и войдите)'; break; }
        if (r.status !== 200) { st.error = 'кабинет ответил ' + r.status + ': ' + r.text.slice(0, 120); break; }
        let data = null;
        try { data = JSON.parse(r.text); } catch (e) { st.error = 'непонятный ответ кабинета'; break; }
        // В сервис — только цены (без акций и прочих полей кабинета).
        for (const it of (data.items || [])) items.push({
          item_id: it.item_id, price: it.price, old_price: it.old_price, marketing_price: it.marketing_price,
          marketing_oa_price: it.marketing_oa_price, marketing_seller_price: it.marketing_seller_price,
          // Цены по схемам доставки: покупатель видит цену той схемы, где товар в наличии.
          by_delivery_schema: (it.by_delivery_schema || []).map(x => ({
            delivery_schema: x.delivery_schema, in_stock: x.in_stock, marketing_price: x.marketing_price,
            marketing_oa_price: x.marketing_oa_price, marketing_seller_price: x.marketing_seller_price,
          })),
        });
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


// ── Карточки конкурентов с витрины ozon.ru ───────────────────────────────
// Раз в 6 часов (и по кнопке): берём у сервиса список SKU (конкуренты и наши
// товары, у которых они есть), по очереди открываем их карточки в отдельной
// фоновой вкладке ozon.ru — как обычный покупатель в вашем браузере — и
// читаем со страницы главное фото, название, цену и рейтинг. В сервис
// уходят только эти поля. Вкладка своя: ваши открытые вкладки не трогаем.
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, bad) => setTimeout(() => bad(new Error(what + ': нет ответа за ' + Math.round(ms / 1000) + ' с')), ms))]);
function waitComplete(tabId, ms) {
  return new Promise(resolve => {
    const t = setTimeout(() => { chrome.tabs.onUpdated.removeListener(l); resolve(false); }, ms);
    function l(id, info) { if (id === tabId && info.status === 'complete') { clearTimeout(t); chrome.tabs.onUpdated.removeListener(l); resolve(true); } }
    chrome.tabs.onUpdated.addListener(l);
  });
}

async function readCard(tabId, sku) {
  try {
    await chrome.tabs.update(tabId, { url: 'https://www.ozon.ru/product/' + sku + '/' });
    await waitComplete(tabId, 30000);
    await sleep(2500); // цена и рейтинг дорисовываются после загрузки
    const [res] = await withTimeout(chrome.scripting.executeScript({
      target: { tabId },
      args: [String(sku)],
      func: sku => {
        const out = { sku };
        const meta = p => (document.querySelector('meta[property="' + p + '"]') || {}).content || null;
        const w = name => document.querySelector('[data-widget="' + name + '"]');
        const title = document.title || '';
        if (/доступ ограничен|antibot|captcha|проверка/i.test(title + ' ' + (document.body ? document.body.innerText.slice(0, 300) : ''))) { out.err = 'Ozon показал проверку «я не робот» — откройте ozon.ru в браузере и пройдите её'; return out; }
        out.photo = meta('og:image');
        if (!out.photo) { const img = document.querySelector('[data-widget="webGallery"] img'); if (img) out.photo = img.currentSrc || img.src; }
        const h1 = document.querySelector('[data-widget="webProductHeading"] h1') || document.querySelector('h1');
        out.title = (h1 && h1.textContent.trim()) || meta('og:title') || title;
        const pb = w('webPrice');
        if (pb) {
          // Ozon разделяет тысячи разными «тонкими» пробелами — убираем все пробелы, иначе
          // «6 177 ₽» читалось как «77 ₽». Рассрочку («520 ₽/мес») и суммы меньше 100 ₽ не берём.
          const flat = pb.innerText.replace(/[\s\u00a0\u2000-\u200f\u202f\u205f\u3000]+/g, '');
          const nums = [...flat.matchAll(/(\d+)₽(?!\/)/g)].map(m => Number(m[1])).filter(v => v >= 100);
          // Первая цена — с Ozon-картой, вторая — без карты.
          if (nums.length) { out.cardPrice = nums[0]; out.price = nums[1] || nums[0]; }
        }
        const sc = w('webSingleProductScore') || w('webReviewProductScore');
        if (sc) {
          const m = /(\d[.,]\d)\D+(\d[\d\s\u00a0\u2000-\u200f\u202f]*)/.exec(sc.innerText);
          if (m) { out.rating = m[1].replace(',', '.'); out.reviews = m[2].replace(/\D/g, ''); }
        }
        if (!out.photo && !out.price) out.err = 'на странице не нашлись фото и цена (заголовок: «' + title.slice(0, 60) + '»)';
        if (out.photo && out.photo.startsWith('//')) out.photo = 'https:' + out.photo;
        return out;
      },
    }), 20000, 'чтение страницы');
    return res && res.result ? res.result : { sku, err: 'вкладка не ответила' };
  } catch (e) { return { sku, err: String(e && e.message || e) }; }
}

async function runCards(reason) {
  const status = { at: new Date().toISOString(), reason, asked: 0, got: 0, error: null };
  let tabId = null;
  try {
    const server = await getServer();
    const r = await withTimeout(fetch(server + '/api/competitors/skus'), 60000, 'сервис');
    if (!r.ok) throw new Error('сервис не ответил (' + r.status + ')');
    const skus = (await r.json()).data || [];
    status.asked = skus.length;
    if (!skus.length) return;
    await chrome.storage.local.set({ lastCards: { ...status, running: true } });
    tabId = (await chrome.tabs.create({ url: 'about:blank', active: false })).id;
    const cards = [];
    for (const sku of skus) {
      const c = await readCard(tabId, sku);
      if (c.photo || c.title || c.price) cards.push(c);
      if (c.err && !status.error) status.error = 'карточка ' + sku + ': ' + c.err;
      await chrome.storage.local.set({ lastCards: { ...status, got: cards.length, running: true } });
      await sleep(1000 + Math.random() * 1500);
    }
    status.got = cards.length;
    if (cards.length) {
      const ir = await withTimeout(fetch(server + '/api/competitors/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cards }) }), 60000, 'сервис');
      const ij = await ir.json().catch(() => ({}));
      if (!ir.ok || !ij.success) status.error = 'сервис не принял карточки: ' + (ij.error || ir.status);
    }
  } catch (e) {
    status.error = String(e && e.message || e);
  } finally {
    if (tabId) chrome.tabs.remove(tabId).catch(() => {});
    status.finished = new Date().toISOString();
    await chrome.storage.local.set({ lastCards: status });
  }
}

// ── Выдача по отслеживаемым запросам и «Товары на Ozon» из кабинета ─────────
// То же, что страницы кабинета «Видимость в поиске → Что влияет на место» и
// «Аналитика конкурентов → Товары на Ozon», только по расписанию: запрос идёт
// из вкладки seller.ozon.ru с вашим входом. Выдача — раз в несколько часов,
// «Товары на Ozon» — раз в день после 10:00 (если браузер был закрыт — как
// только откроется). В сервис уходят только цифры выдачи и товаров.
const mskNow = () => { const d = new Date(Date.now() + 3 * 3600e3); return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() }; };

async function inSeller(tabId, func, args) {
  const [res] = await withTimeout(chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', args, func }), 60000, 'кабинет');
  return res && res.result ? res.result : { status: 0, error: 'нет ответа от вкладки' };
}

// Выполняется внутри seller.ozon.ru: выдача по запросу в регионе → компактные строки.
async function explainInPage(companyId, query, skus, coordinates) {
  try {
    const r = await fetch('/api/search-query-analytics/v2/external/explanation_by_id', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-o3-app-name': 'seller-ui', 'x-o3-language': 'ru', 'x-o3-company-id': String(companyId), 'x-o3-page-type': 'analytics-search' },
      body: JSON.stringify({ sellerId: String(companyId), query, skus, sortOption: { headerKey: 'position', direction: 'SortDirectionAscending' }, coordinates, itemsPerPage: '200', pageNumber: '1', onlyCurSellerItems: false, applicationScope: 'SCOPE_BIG_OZON' }),
    });
    if (r.status !== 200) return { status: r.status, error: (await r.text()).slice(0, 200) };
    const o = await r.json();
    const keys = (o.headers || []).map(h => h.key);
    const cell = (it, k) => { const i = keys.indexOf(k); const v = i >= 0 && it.values[i] && it.values[i].values ? it.values[i].values[0] : null; return v || {}; };
    const txt = c => (c.label && c.label.value) || (c.badge && c.badge.text) || (c.button && c.button.text) || '';
    const num = t => { const s = String(t || '').replace(/[\s  -‏ ]/g, '').replace(',', '.').replace(/[^\d.]/g, ''); return s ? Number(s) : null; };
    const rows = (o.items || []).map(it => {
      const info = cell(it, 'itemInfo').itemInfo || {};
      const cpc = cell(it, 'promotionCpcRate'), rev = cell(it, 'reviews');
      return {
        sku: String(it.sku || info.sku || ''), position: num(txt(cell(it, 'position'))), name: info.name || '', seller: info.sellerName || '', photo: info.pictureUrl || '',
        status: txt(cell(it, 'promotionStatus')), cpc: /₽/.test(txt(cpc)) ? num(txt(cpc)) : null, strategy: /₽/.test(txt(cpc)) ? ((cpc.label && cpc.label.subvalue) || '').replace(/\s+/g, ' ') : '',
        // «Включить» — это кнопка у нашего товара: оплата за заказ выключена.
        cpo: txt(cell(it, 'promotionCpoRate')) === 'Включить' ? 'Выключено' : txt(cell(it, 'promotionCpoRate')), relevance: num(txt(cell(it, 'textRelevance'))), rating: num(txt(rev)),
        reviews: num(((rev.label && rev.label.subvalue) || '').replace(/шт.*/, '')), price: num(txt(cell(it, 'price'))), popularity: num(txt(cell(it, 'generalPopularity'))),
        promo: txt(cell(it, 'salePromotions')), delivery: txt(cell(it, 'deliveryPeriod')),
      };
    });
    return { status: 200, total: o.totalNumberOfItems, rows };
  } catch (e) { return { status: 0, error: String(e && e.message || e) }; }
}

// Выполняется внутри seller.ozon.ru: «Товары на Ozon» по одному SKU (period: weekly — 7 дней, monthly — 28).
async function marketInPage(companyId, sku, period) {
  try {
    const r = await fetch('https://api.seller.ozon.ru/api/site/seller-analytics/what_to_sell/data/v3', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-o3-app-name': 'seller-ui', 'x-o3-language': 'ru', 'x-o3-company-id': String(companyId), 'x-o3-page-type': 'analytics_platform' },
      body: JSON.stringify({ limit: '50', offset: '0', filter: { stock: 'any_stock', period, sku: String(sku) }, sort: { key: 'sum_gmv_desc' } }),
    });
    if (r.status !== 200) return { status: r.status, error: (await r.text()).slice(0, 200) };
    const o = await r.json();
    return { status: 200, items: (o.items || []).filter(x => String(x.sku) === String(sku)) };
  } catch (e) { return { status: 0, error: String(e && e.message || e) }; }
}

let agentBusy = false;
async function runAgent(reason, force) {
  if (agentBusy) return;
  agentBusy = true;
  const { agentState = {} } = await chrome.storage.local.get('agentState');
  const st = { ...agentState, at: new Date().toISOString(), reason, running: true, error: null };
  await chrome.storage.local.set({ agentState: st });
  let tab = null;
  try {
    const server = await getServer();
    const r = await withTimeout(fetch(server + '/api/competitors/agent-tasks'), 60000, 'сервис');
    if (!r.ok) throw new Error('сервис не ответил (' + r.status + ')');
    const t = (await r.json()).data || {};
    const now = mskNow();
    const done = st.serpDone || {};
    // Выдача: каждые serpEveryHours часов по каждому запросу и региону.
    const due = [];
    for (const task of t.serp || []) for (const reg of task.regions || []) {
      const key = task.cabinet + '|' + task.query + '|' + reg.title;
      if (force || !done[key] || Date.now() - done[key] > (t.serpEveryHours || 4) * 3600e3) due.push({ task, reg, key });
    }
    const marketDue = (t.market || []).length && (force || (now.hour >= (t.marketHour || 10) && st.marketDate !== now.date));
    if (!due.length && !marketDue) { st.note = 'всё уже собрано'; return; }
    tab = await sellerTab();
    st.serpOk = 0; st.serpAsked = due.length;
    for (const d of due) {
      const res = await inSeller(tab.id, explainInPage, [String(d.task.companyId), d.task.query, d.task.skus, d.reg]);
      if (res.status === 401 || res.status === 403) throw new Error('нет входа в кабинет Ozon (откройте seller.ozon.ru и войдите)');
      if (res.status !== 200) { st.error = 'выдача «' + d.task.query + '»: ' + (res.error || res.status); continue; }
      const ir = await fetch(server + '/api/competitors/agent/serp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cabinet: d.task.cabinet, query: d.task.query, region: d.reg.title, total: res.total, rows: res.rows }) });
      if (ir.ok) { done[d.key] = Date.now(); st.serpOk++; } else st.error = 'сервис не принял выдачу (' + ir.status + ')';
      st.serpDone = done;
      await chrome.storage.local.set({ agentState: { ...st } });
      await sleep(2500 + Math.random() * 2500);
    }
    if (marketDue) {
      let ok = 0, asked = 0;
      for (const g of t.market) {
        // 7 дней — period 'weekly'. Как кабинет называет «28 дней», проверяем по очереди
        // и запоминаем рабочее значение. Фильтр категорий не передаём — поиск по SKU
        // идёт по всем категориям (как после «сбросить» в кабинете).
        const { period28 } = await chrome.storage.local.get('period28');
        for (const win of [7, 28]) {
          const items = [], empty = [];
          let periods = win === 7 ? ['weekly'] : (period28 ? [period28] : ['monthly', 'four_weeks', 'month', 'days_28', 'last_28_days']);
          for (const sku of g.skus) {
            asked++;
            let res = null;
            for (const period of periods) {
              res = await inSeller(tab.id, marketInPage, [String(g.companyId), sku, period]);
              if (res.status === 200) { if (win === 28 && periods.length > 1) { periods = [period]; await chrome.storage.local.set({ period28: period }); } break; }
              if (res.status !== 400) break;
            }
            if (res && res.status === 200) {
              // Пустой ответ — за этот период у товара не было заказов: так и сохраняем.
              if (res.items.length) items.push(...res.items); else empty.push(String(sku));
              ok++;
            } else if (!st.error) st.error = '«Товары на Ozon» (' + win + ' дн.): ' + ((res && (res.error || res.status)) || 'нет ответа');
            await sleep(1500 + Math.random() * 1500);
          }
          if (items.length || empty.length) await fetch(server + '/api/competitors/agent/market', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cabinet: g.cabinet, window: win, items, empty }) });
        }
      }
      st.marketOk = ok; st.marketAsked = asked;
      if (ok) st.marketDate = now.date;
    }
  } catch (e) {
    st.error = String(e && e.message || e);
  } finally {
    if (tab && tab.created) chrome.tabs.remove(tab.id).catch(() => {});
    st.running = false; st.finished = new Date().toISOString();
    await chrome.storage.local.set({ agentState: st });
    agentBusy = false;
  }
}
chrome.alarms.get('agent', a => { if (!a) chrome.alarms.create('agent', { delayInMinutes: 4, periodInMinutes: 30 }); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'agent') runAgent('по расписанию'); });
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'runAgent') { runAgent('вручную', true).then(() => reply({ ok: true })); return true; }
  return false;
});
