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
// Раз в 6 часов: берём у сервиса список SKU (конкуренты и наши товары, у
// которых они есть), открываем карточки внутри вкладки ozon.ru — так же,
// как их открывает сам сайт, с вашего браузера — и отправляем в сервис
// только главное фото, название, цену и рейтинг. Так сервис видит, когда
// конкурент сменил главное фото или цену.
async function ozonTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.ozon.ru/*' });
  const ready = tabs.find(t => t.status === 'complete');
  if (ready) return { id: ready.id, created: false };
  const tab = await chrome.tabs.create({ url: 'https://www.ozon.ru/', active: false });
  await new Promise(resolve => {
    const t = setTimeout(resolve, 30000);
    chrome.tabs.onUpdated.addListener(function l(id, info) {
      if (id === tab.id && info.status === 'complete') { clearTimeout(t); chrome.tabs.onUpdated.removeListener(l); resolve(); }
    });
  });
  await sleep(2000);
  return { id: tab.id, created: true };
}

async function readCard(tabId, sku) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [String(sku)],
    func: async sku => {
      const out = { sku };
      const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return null; };
      try {
        const r = await fetch('/api/entrypoint-api.bx/page/json/v2?url=' + encodeURIComponent('/product/' + sku + '/'), { credentials: 'include', headers: { accept: 'application/json' } });
        out.status = r.status;
        if (r.ok) {
          const j = await r.json();
          const ws = j.widgetStates || {};
          for (const k of Object.keys(ws)) {
            let o; try { o = JSON.parse(ws[k]); } catch (e) { continue; }
            if (k.startsWith('webGallery') && !out.photo) out.photo = pick(o, 'coverImage') || (o.images && o.images[0] && (o.images[0].src || o.images[0].url)) || null;
            if (k.startsWith('webProductHeading') && !out.title) out.title = pick(o, 'title');
            if (k.startsWith('webPrice') && !out.price) { out.price = pick(o, 'price'); out.cardPrice = pick(o, 'cardPrice'); }
            if (k.startsWith('webReviewProductScore') && out.rating == null) { out.rating = pick(o, 'totalScore', 'score'); out.reviews = pick(o, 'reviewsCount', 'count'); }
          }
          if (!out.photo && j.seo && Array.isArray(j.seo.meta)) { const m = j.seo.meta.find(x => x.property === 'og:image'); if (m) out.photo = m.content; }
          if (!out.title && j.seo && j.seo.title) out.title = j.seo.title;
        }
      } catch (e) { out.err = String(e && e.message || e); }
      // Запасной путь: обычная страница товара, картинка из og:image.
      if (!out.photo) {
        try {
          const h = await (await fetch('/product/' + sku + '/', { credentials: 'include' })).text();
          const m = /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/.exec(h) || /<meta[^>]+content="([^"]+)"[^>]+property="og:image"/.exec(h);
          if (m) out.photo = m[1];
        } catch (e) { out.err = String(e && e.message || e); }
      }
      if (out.photo && out.photo.startsWith('//')) out.photo = 'https:' + out.photo;
      return out;
    },
  });
  return res && res.result ? res.result : { sku, err: 'нет ответа от вкладки' };
}

async function runCards(reason) {
  const status = { at: new Date().toISOString(), reason, asked: 0, got: 0, error: null };
  let tab = null;
  try {
    const server = await getServer();
    const r = await fetch(server + '/api/competitors/skus');
    if (!r.ok) throw new Error('сервис не ответил (' + r.status + ')');
    const skus = (await r.json()).data || [];
    status.asked = skus.length;
    if (!skus.length) return;
    await chrome.storage.local.set({ lastCards: { ...status, running: true } });
    tab = await ozonTab();
    const cards = [];
    for (const sku of skus) {
      const c = await readCard(tab.id, sku);
      if (c.photo || c.title || c.price) { cards.push(c); await chrome.storage.local.set({ lastCards: { ...status, got: cards.length, running: true } }); }
      else if (!status.error) status.error = 'не удалось прочитать карточку ' + sku + (c.status ? ' (ответ ' + c.status + ')' : '') + (c.err ? ': ' + c.err : '');
      await sleep(1500 + Math.random() * 1500);
    }
    status.got = cards.length;
    if (cards.length) {
      const ir = await fetch(server + '/api/competitors/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cards }) });
      const ij = await ir.json().catch(() => ({}));
      if (!ir.ok || !ij.success) status.error = 'сервис не принял карточки: ' + (ij.error || ir.status);
    }
  } catch (e) {
    status.error = String(e && e.message || e);
  } finally {
    if (tab && tab.created) chrome.tabs.remove(tab.id).catch(() => {});
    status.finished = new Date().toISOString();
    await chrome.storage.local.set({ lastCards: status });
  }
}
