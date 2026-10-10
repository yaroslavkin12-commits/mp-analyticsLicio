/**
 * Сбор данных Ozon в Google Таблицу — обход блокировки сети на Render.
 *
 * Как устроено:
 *  - Этот скрипт живёт ВНУТРИ Google Таблицы (Расширения -> Apps Script)
 *    и ходит в Ozon с серверов Google, а не с Render. Ozon блокирует именно
 *    выход Render (см. /api/netcheck) — Google он не блокирует.
 *  - Скрипт кладёт результат во вкладки этой же таблицы (Catalog, Analytics,
 *    Stocks, Campaigns, Stats).
 *  - Backend на Render читает эти вкладки как обычный CSV по ссылке (см.
 *    backend/src/collectors/ads/sheetSync.js и jobs.js). Это ОСНОВНОЙ путь
 *    данных Ozon: сам Render в Ozon не ходит.
 *
 * Настройка (один раз):
 *  1. Создать новую Google Таблицу, Расширения -> Apps Script, вставить сюда
 *     весь этот файл (замените содержимое Code.gs).
 *  2. Настройки проекта (шестерёнка слева) -> Свойства скрипта -> добавить
 *     строки (для каждого кабинета, который нужно собирать):
 *       LICIO_SELLER_CLIENT_ID, LICIO_SELLER_API_KEY,
 *       LICIO_PERF_CLIENT_ID,   LICIO_PERF_SECRET,
 *       DEFLY_SELLER_CLIENT_ID, DEFLY_SELLER_API_KEY,
 *       DEFLY_PERF_CLIENT_ID,   DEFLY_PERF_SECRET,
 *       CABINETS = licio,defly   (список через запятую — какие кабинеты собирать)
 *     Значения — те же ключи Ozon, что уже используются на Render (Seller
 *     API Client-Id/Api-Key и Performance API Client-Id/Client-Secret).
 *     Ключи храните только здесь, в Свойствах скрипта — никогда не вставляйте
 *     их в чат.
 *  3. Выполнить функцию setupTriggers (из выпадающего списка функций вверху,
 *     кнопка "Выполнить") — она поставит расписание: заказы для уведомлений
 *     каждые 10 минут, свежие данные каждые 30 минут, отчёт «оплата за заказ»
 *     каждые 3 часа и раз в сутки докачку истории + каталог.
 *     После обновления этого файла setupTriggers нужно выполнить ещё раз.
 *     При первом запуске Google спросит разрешения — это нормально,
 *     разрешите (скрипт же ваш собственный).
 *  4. Таблицу -> кнопка "Настройки доступа" (Share) -> "Общий доступ" ->
 *     "Все, у кого есть ссылка" -> роль "Читатель". Это нужно, чтобы Render
 *     мог прочитать вкладки как CSV по прямой ссылке без пароля/OAuth.
 *     Ссылка не публикуется нигде и не ищется в Google — доступ только по
 *     ней, но учтите: любой, кто её получит, сможет посмотреть цифры.
 *  5. Скопировать ID таблицы из адресной строки браузера
 *     (https://docs.google.com/spreadsheets/d/ЭТОТ_ID/edit) и передать его
 *     в переменную окружения ADS_SHEET_ID на Render.
 *  6. Для проверки — выполнить функцию syncRecent вручную один раз, открыть
 *     "Журнал выполнения" и вкладки таблицы: там должны появиться строки.
 */

const SHEET_NAMES = {
  catalog: 'Catalog',
  analytics: 'Analytics',
  stocks: 'Stocks',
  campaigns: 'Campaigns',
  stats: 'Stats',
  campaignSkus: 'CampaignSkus',
  orders: 'Orders',
  skuStats: 'SkuStats',
  cpoProducts: 'CpoProducts',
  cpcBids: 'CpcBids',
  cpoOrders: 'CpoOrders',
  geo: 'GeoOrders',
  buyout: 'Buyout',
  prices: 'Prices',
  finance: 'Finance',
};

// Заказы (FBO+FBS) за последние 2 дня — для Telegram-уведомлений о новых
// заказах по отслеживаемым артикулам (вкладка «Уведомления» в сервисе).
const ORDERS_HEADERS = ['cabinet', 'posting_number', 'sku', 'offer_id', 'name', 'price', 'quantity', 'status', 'warehouse', 'created_at', 'scheme'];
const ORDERS_KEEP_DAYS = 3;
// Статистика «оплаты за клик» по каждому товару и дню — точный расход по
// артикулу даже в кампаниях на несколько товаров, плюс рекламная воронка.
const SKU_STATS_HEADERS = ['cabinet', 'date', 'campaign_id', 'sku', 'views', 'clicks', 'to_cart', 'orders', 'sales', 'expense', 'avg_cpc'];
// «Оплата за заказ»: включена ли на товаре и какая ставка (снимок).
const CPO_PRODUCTS_HEADERS = ['cabinet', 'sku', 'offer_id', 'enabled', 'available', 'bid_pct', 'bid_rub', 'previous_bid', 'checked_at'];
// Ставки за клик по товарам кампаний (снимок) — по изменениям сервис сам
// пишет записи «ставка изменилась» в журнал.
const CPC_BIDS_HEADERS = ['cabinet', 'campaign_id', 'sku', 'bid', 'checked_at'];
// Отчёт по заказам «оплаты за заказ»: строка = заказ, с датой, SKU и списанной суммой.
// date — день СПИСАНИЯ (Ozon списывает «оплату за заказ» в момент выкупа),
// order_date — день самого ЗАКАЗА (по номеру отправления из списка заказов).
const CPO_ORDERS_HEADERS = ['cabinet', 'date', 'order_id', 'sku', 'promoted_sku', 'offer_id', 'quantity', 'cost', 'expense', 'order_date', 'order_number'];

const CATALOG_HEADERS = ['cabinet', 'offer_id', 'sku', 'product_name'];
const ANALYTICS_HEADERS = ['cabinet', 'date', 'sku', 'hits_view', 'hits_view_search', 'hits_view_pdp', 'hits_tocart', 'orders_item', 'revenue', 'position_category'];
const STOCKS_HEADERS = ['cabinet', 'product_id', 'offer_id', 'fbo_present', 'fbo_reserved', 'fbs_present', 'fbs_reserved'];
const CAMPAIGNS_HEADERS = ['cabinet', 'campaign_id', 'title', 'state', 'adv_object_type', 'payment_type', 'autopilot_strategy', 'placement', 'expense_strategy'];
// Товары МУЛЬТИТОВАРНЫХ кампаний ("Оплата за заказ: выбранные товары" и
// подобные, где одна РК продвигает сразу пачку SKU, а не один артикул) —
// см. backend/postgres/init.sql (ad_campaign_skus) и sheetSync.js. checked_at
// нужен, чтобы не дёргать /v2/products по одной и той же кампании каждые
// 15 минут — список товаров кампании меняется редко. sku=0 — служебная
// отметка "проверили, но Ozon не отдал товары" (чтобы не ходить повторно
// слишком часто даже для пустого результата).
const CAMPAIGN_SKUS_HEADERS = ['cabinet', 'campaign_id', 'sku', 'checked_at'];
const CAMPAIGN_SKUS_RECHECK_HOURS = 20;
const STATS_HEADERS = ['cabinet', 'date', 'campaign_id', 'views', 'clicks', 'ctr', 'avg_bid', 'orders', 'orders_money', 'spend'];

// "Свежее" окно собираем часто (раз в 15 минут) — быстро, мало запросов.
const ANALYTICS_WINDOW_DAYS_RECENT = 4;
const STATS_WINDOW_DAYS_RECENT = 4;
// "Полное" окно — раз в сутки, подольше, чтобы Ozon успел задним числом
// доправить заказы/выручку. Не 60 дней, как на Render: Apps Script обрывает
// выполнение через 6 минут, а аналитика товаров пагинируется (~1000 строк
// за раз) — 14 дней безопасно укладываются по времени для 1-2 кабинетов.
const ANALYTICS_WINDOW_DAYS_FULL = 14;
const STATS_WINDOW_DAYS_FULL = 30;
// Сколько дней истории держим во вкладках Analytics/Stats, чтобы таблица не
// росла бесконечно (более старые данные на Render и так уже есть).
const RETENTION_DAYS = 45;
// География заказов: день × артикул × регион × город (по дню заказа, МСК).
// qty/revenue — без отменённых, cancelled — отменённые штуки.
// География: день заказа × артикул × кластер доставки Ozon (financial_data.cluster_to —
// он есть у всех заказов; регион и город Ozon отдаёт не всегда, поэтому их не берём).
// qty/revenue — без отменённых, cancelled — отменённые штуки.
const GEO_HEADERS = ['cabinet', 'date', 'offer_id', 'sku', 'cluster', 'qty', 'revenue', 'cancelled'];
// Выкуп: день заказа × артикул — заказано, доставлено (выкуплено), отменено, ещё в пути.
// Цены, комиссии и тарифы логистики по товару (для юнит-экономики).
const PRICES_HEADERS = ['cabinet', 'offer_id', 'product_id', 'price', 'seller_price', 'acquiring', 'pct_fbo', 'pct_fbs',
  'fbo_deliv', 'fbo_direct_max', 'fbo_return', 'fbs_deliv', 'fbs_direct_max', 'fbs_return', 'checked_at', 'volume_weight'];
// Финансы: день операции × SKU × статья (продажа, комиссия, каждая услуга
// Ozon отдельно), сумма и штуки. Операции без товара (хранение и т.п.) — sku пустой.
const FINANCE_HEADERS = ['cabinet', 'date', 'sku', 'name', 'amount', 'qty'];
const BUYOUT_HEADERS = ['cabinet', 'date', 'offer_id', 'sku', 'ordered', 'delivered', 'cancelled', 'in_progress', 'ordered_fbs'];

function getCabinets_() {
  const p = PropertiesService.getScriptProperties().getProperties();
  const ids = (p.CABINETS || 'licio,defly').split(',').map(s => s.trim()).filter(Boolean);
  return ids.map(id => {
    const up = id.toUpperCase();
    return {
      id: id,
      sellerClientId: p[up + '_SELLER_CLIENT_ID'] || '',
      sellerApiKey: p[up + '_SELLER_API_KEY'] || '',
      perfClientId: p[up + '_PERF_CLIENT_ID'] || '',
      perfSecret: p[up + '_PERF_SECRET'] || '',
    };
  }).filter(function (c) {
    return (c.sellerClientId && c.sellerApiKey) || (c.perfClientId && c.perfSecret);
  });
}

function mskDate_(offsetDays) {
  const d = new Date(Date.now() - offsetDays * 86400000);
  return Utilities.formatDate(d, 'GMT+3', 'yyyy-MM-dd');
}

function sellerHeaders_(cab) {
  if (!cab.sellerClientId || !cab.sellerApiKey) return null;
  return { 'Client-Id': cab.sellerClientId, 'Api-Key': cab.sellerApiKey };
}

const perfTokenCache_ = {};
function perfHeaders_(cab) {
  if (!cab.perfClientId || !cab.perfSecret) return null;
  const cached = perfTokenCache_[cab.id];
  if (cached && cached.until > Date.now()) return { Authorization: 'Bearer ' + cached.token };
  const resp = UrlFetchApp.fetch('https://api-performance.ozon.ru/api/client/token', {
    method: 'post',
    muteHttpExceptions: true,
    contentType: 'application/json',
    payload: JSON.stringify({ client_id: cab.perfClientId, client_secret: cab.perfSecret, grant_type: 'client_credentials' }),
  });
  const data = JSON.parse(resp.getContentText() || '{}');
  if (!data.access_token) {
    throw new Error('Performance API: нет токена (код ' + resp.getResponseCode() + ') ' + resp.getContentText().slice(0, 200));
  }
  perfTokenCache_[cab.id] = { token: data.access_token, until: Date.now() + 25 * 60 * 1000 };
  return { Authorization: 'Bearer ' + data.access_token };
}

// Повтор при временных сбоях (429/5xx), как в ozonHttp.js на Render, но
// короче — Apps Script даёт всего 6 минут на весь прогон.
function fetchJson_(url, options, label) {
  const attempts = 3;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = UrlFetchApp.fetch(url, Object.assign({ muteHttpExceptions: true }, options));
      const code = resp.getResponseCode();
      if (code === 429 || (code >= 500 && code < 600)) throw new Error('HTTP ' + code);
      if (code >= 400) {
        const err = new Error(label + ': HTTP ' + code + ' ' + resp.getContentText().slice(0, 300));
        err.permanent = true;
        throw err;
      }
      return JSON.parse(resp.getContentText() || '{}');
    } catch (e) {
      lastErr = e;
      if (e.permanent || i === attempts - 1) break;
      Utilities.sleep(1200 * (i + 1));
    }
  }
  throw new Error(label + ': ' + (lastErr && lastErr.message));
}

function parseRuNumber_(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

// ---------- Каталог ----------
function collectCatalog_(cab, out) {
  const headers = sellerHeaders_(cab);
  if (!headers) return;
  const offerIds = [];
  let lastId = '';
  for (let guard = 0; guard < 60; guard++) {
    const data = fetchJson_('https://api-seller.ozon.ru/v3/product/list', {
      method: 'post', contentType: 'application/json', headers: headers,
      payload: JSON.stringify({ filter: { visibility: 'ALL' }, last_id: lastId, limit: 1000 }),
    }, 'Каталог: список');
    const items = (data.result && data.result.items) || [];
    items.forEach(function (it) { if (it.offer_id) offerIds.push(it.offer_id); });
    lastId = (data.result && data.result.last_id) || '';
    if (!lastId || !items.length) break;
    Utilities.sleep(250);
  }
  for (let i = 0; i < offerIds.length; i += 500) {
    const chunk = offerIds.slice(i, i + 500);
    const data = fetchJson_('https://api-seller.ozon.ru/v3/product/info/list', {
      method: 'post', contentType: 'application/json', headers: headers,
      payload: JSON.stringify({ offer_id: chunk }),
    }, 'Каталог: инфо');
    (data.items || []).forEach(function (item) {
      const sku = item.sku || item.fbo_sku || item.fbs_sku || '';
      out.push([cab.id, item.offer_id, sku, String(item.name || '').slice(0, 500)]);
    });
    Utilities.sleep(250);
  }
}

// ---------- Аналитика товаров ----------
const ANALYTICS_METRICS_ = ['hits_view', 'hits_view_search', 'hits_view_pdp', 'hits_tocart', 'ordered_units', 'revenue', 'position_category'];
function collectAnalyticsWindow_(cab, from, to, out) {
  const headers = sellerHeaders_(cab);
  if (!headers) return;
  let offset = 0;
  for (let guard = 0; guard < 60; guard++) {
    const data = fetchJson_('https://api-seller.ozon.ru/v1/analytics/data', {
      method: 'post', contentType: 'application/json', headers: headers,
      payload: JSON.stringify({ date_from: from, date_to: to, metrics: ANALYTICS_METRICS_, dimension: ['sku', 'day'], limit: 1000, offset: offset }),
    }, 'Аналитика ' + from + '..' + to);
    const rows = (data.result && data.result.data) || [];
    rows.forEach(function (r) {
      const dims = r.dimensions || [];
      const sku = dims[0] && dims[0].id, date = dims[1] && dims[1].id;
      if (!sku || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return;
      const m = (r.metrics || []).map(function (v) { return Number(v) || 0; });
      out.push([cab.id, date, sku, m[0], m[1], m[2], m[3], m[4], m[5], m[6] || '']);
    });
    if (rows.length < 1000) break;
    offset += 1000;
    Utilities.sleep(350);
  }
}

// ---------- Остатки ----------
function collectStocks_(cab, out) {
  const headers = sellerHeaders_(cab);
  if (!headers) return;
  let cursor = '';
  for (let guard = 0; guard < 60; guard++) {
    const data = fetchJson_('https://api-seller.ozon.ru/v4/product/info/stocks', {
      method: 'post', contentType: 'application/json', headers: headers,
      payload: JSON.stringify({ cursor: cursor, filter: { visibility: 'ALL' }, limit: 1000 }),
    }, 'Остатки');
    const items = data.items || [];
    items.forEach(function (item) {
      const stocks = item.stocks || [];
      const fbo = stocks.filter(function (s) { return s.type === 'fbo'; })[0] || {};
      const fbs = stocks.filter(function (s) { return s.type === 'fbs'; })[0] || {};
      out.push([cab.id, item.product_id || '', item.offer_id, fbo.present || 0, fbo.reserved || 0, fbs.present || 0, fbs.reserved || 0]);
    });
    cursor = data.cursor || '';
    if (!cursor || !items.length) break;
    Utilities.sleep(250);
  }
}

// Список SKU конкретной кампании (api-performance v2/products) — нужен для
// мультитоварных РК ("Оплата за заказ: выбранные товары"), где обычное
// "offer_id встречается в названии кампании" не работает в принципе: там
// несколько товаров сразу, и название кампании их не называет.
function getCampaignProducts_(campaignId, headers) {
  try {
    const data = fetchJson_('https://api-performance.ozon.ru/api/client/campaign/' + campaignId + '/v2/products',
      { method: 'get', headers: headers }, 'Товары РК ' + campaignId);
    return (data.products || []).map(function (p) { return String(p.sku || ''); }).filter(Boolean);
  } catch (e) {
    Logger.log('Товары РК ' + campaignId + ': ' + e.message);
    return null; // null = запрос не удался, не отмечаем как "проверено"
  }
}

// ---------- Кампании + расход/клики ----------
function collectCampaignsAndStats_(cab, from, to, campaignsOut, statsOut, campaignSkusOut) {
  const headers = perfHeaders_(cab);
  if (!headers) return null;
  const listData = fetchJson_('https://api-performance.ozon.ru/api/client/campaign', { method: 'get', headers: headers }, 'Список кампаний');
  const campaigns = listData.list || [];
  campaigns.forEach(function (c) {
    campaignsOut.push([cab.id, String(c.id), String(c.title || '').slice(0, 500), c.state || '', c.advObjectType || '',
      c.PaymentType || c.paymentType || '', c.productAutopilotStrategy || '',
      Array.isArray(c.placement) ? c.placement.join(',') : (c.placement || ''), c.expenseStrategy || '']);
  });

  const expData = fetchJson_('https://api-performance.ozon.ru/api/client/statistics/expense/json?dateFrom=' + from + '&dateTo=' + to,
    { method: 'get', headers: headers }, 'Расход');
  const expenseRows = expData.rows || expData.list || (Array.isArray(expData) ? expData : []);
  const spendByKey = {};
  const campaignHasSpend = {};
  expenseRows.forEach(function (r) {
    const campaignId = String(r.id || r.campaignId || r.campaign_id || '');
    if (!campaignId || !r.date) return;
    spendByKey[campaignId + '|' + r.date] = parseRuNumber_(r.moneySpent);
    campaignHasSpend[campaignId] = true;
  });

  const dailyData = fetchJson_('https://api-performance.ozon.ru/api/client/statistics/daily/json?dateFrom=' + from + '&dateTo=' + to,
    { method: 'get', headers: headers }, 'Дневная статистика');
  const dailyRows = dailyData.rows || dailyData.list || (Array.isArray(dailyData) ? dailyData : []);
  const seen = {};
  dailyRows.forEach(function (r) {
    const campaignId = String(r.id || r.campaignId || '');
    if (!campaignId || !r.date) return;
    const views = parseRuNumber_(r.views), clicks = parseRuNumber_(r.clicks);
    const spend = Math.max(spendByKey[campaignId + '|' + r.date] || 0, parseRuNumber_(r.moneySpent));
    seen[campaignId + '|' + r.date] = true;
    statsOut.push([cab.id, r.date, campaignId, views, clicks,
      views > 0 ? (clicks / views * 100) : 0,
      clicks > 0 ? (spend / clicks) : 0,
      parseRuNumber_(r.orders), parseRuNumber_(r.ordersMoney), spend]);
  });
  // Расход есть, но в дневную статистику кампания почему-то не попала —
  // добавляем отдельной строкой, чтобы расход не потерялся.
  Object.keys(spendByKey).forEach(function (key) {
    if (seen[key]) return;
    const parts = key.split('|');
    statsOut.push([cab.id, parts[1], parts[0], 0, 0, 0, 0, 0, 0, spendByKey[key]]);
  });

  // Товары только у кампаний, по которым реально был расход в этом окне —
  // активных РК обычно пара десятков, а не все 800+ за всю историю, так что
  // укладываемся в 6-минутный лимит Apps Script. Уже проверенные недавно
  // (CAMPAIGN_SKUS_RECHECK_HOURS) — пропускаем, список товаров кампании
  // меняется редко.
  if (campaignSkusOut) {
    const checkedMap = readSheetAsMap_(SHEET_NAMES.campaignSkus, [0, 1]); // cabinet|campaign_id -> последняя строка (с checked_at)
    const lastCheckedByCampaign = {};
    Object.keys(checkedMap).forEach(function (key) {
      const row = checkedMap[key];
      const campaignId = String(row[1]);
      const checkedAt = new Date(row[3]).getTime();
      if (!lastCheckedByCampaign[campaignId] || checkedAt > lastCheckedByCampaign[campaignId]) {
        lastCheckedByCampaign[campaignId] = checkedAt;
      }
    });
    const cutoff = Date.now() - CAMPAIGN_SKUS_RECHECK_HOURS * 3600 * 1000;
    const toCheck = Object.keys(campaignHasSpend).filter(function (id) {
      return !lastCheckedByCampaign[id] || lastCheckedByCampaign[id] < cutoff;
    });
    const nowIso = new Date().toISOString();
    toCheck.forEach(function (campaignId) {
      const skus = getCampaignProducts_(campaignId, headers);
      if (skus === null) return; // запрос не удался — попробуем в следующий раз
      if (skus.length) {
        skus.forEach(function (sku) { campaignSkusOut.push([cab.id, campaignId, sku, nowIso]); });
      } else {
        campaignSkusOut.push([cab.id, campaignId, '0', nowIso]); // отметка "проверили, товаров нет/не отдал"
      }
      Utilities.sleep(250);
    });
  }
  // Для детальной статистики по товарам и снимка ставок — только кампании,
  // по которым в окне был расход (их немного, укладываемся по времени).
  return campaigns.filter(function (c) { return campaignHasSpend[String(c.id)]; }).map(function (c) {
    return { id: String(c.id), paymentType: String(c.PaymentType || c.paymentType || ''), advObjectType: String(c.advObjectType || ''), state: c.state || '' };
  });
}

// ---------- Заказы для уведомлений ----------
function collectPostings_(cab, url, scheme, since, out) {
  const headers = sellerHeaders_(cab);
  if (!headers) return;
  let offset = 0;
  for (let guard = 0; guard < 30; guard++) {
    const data = fetchJson_(url, {
      method: 'post', contentType: 'application/json', headers: headers,
      payload: JSON.stringify({ dir: 'ASC', filter: { since: since, to: new Date().toISOString(), status: '' }, limit: 100, offset: offset, with: { analytics_data: true } }),
    }, 'Заказы ' + scheme);
    let postings = data.result && data.result.postings;
    if (!Array.isArray(postings) && Array.isArray(data.result)) postings = data.result;
    postings = postings || [];
    postings.forEach(function (p) {
      (p.products || []).forEach(function (prod) {
        out.push([cab.id, p.posting_number, prod.sku || '', prod.offer_id || '', String(prod.name || '').slice(0, 200),
          prod.price || '', prod.quantity || 1, p.status || '', (p.analytics_data && p.analytics_data.warehouse_name) || '',
          p.in_process_at || p.created_at || '', scheme]);
      });
    });
    if (postings.length < 100) break;
    offset += 100;
    Utilities.sleep(300);
  }
}

// Каждые 5 минут (триггер) — заказы за 2 дня по всем кабинетам.
function syncOrders() {
  const cabinets = getCabinets_();
  const since = new Date(Date.now() - 2 * 86400000).toISOString();
  const rows = [];
  cabinets.forEach(function (cab) {
    try { collectPostings_(cab, 'https://api-seller.ozon.ru/v2/posting/fbo/list', 'fbo', since, rows); } catch (e) { Logger.log('Заказы FBO ' + cab.id + ': ' + e.message); }
    try { collectPostings_(cab, 'https://api-seller.ozon.ru/v3/posting/fbs/list', 'fbs', since, rows); } catch (e) { Logger.log('Заказы FBS ' + cab.id + ': ' + e.message); }
  });
  const map = readSheetAsMap_(SHEET_NAMES.orders, [0, 1, 2]);
  rows.forEach(function (r) { map[[r[0], r[1], r[2]].join('|')] = r; });
  const cutoff = new Date(Date.now() - ORDERS_KEEP_DAYS * 86400000).toISOString();
  const all = Object.keys(map).map(function (k) { return map[k]; })
    .filter(function (r) { return !r[9] || String(r[9]) >= cutoff; });
  writeRows_(SHEET_NAMES.orders, ORDERS_HEADERS, all);
  Logger.log('syncOrders: новых/обновлённых строк ' + rows.length + ', всего ' + all.length);
}

// ---------- Реклама: точные данные по товарам ----------
// Статистика «оплаты за клик» по товарам и дням (не тратит лимиты API).
function collectSkuStats_(cab, campaigns, out, days) {
  const headers = perfHeaders_(cab);
  if (!headers || !campaigns || !campaigns.length) return;
  const cpc = campaigns.filter(function (c) { return c.paymentType.toUpperCase() !== 'CPO'; }).map(function (c) { return c.id; });
  // Метод отдаёт только вчера и сегодня; прошлые дни — syncSkuHistory.
  const from = mskDate_((days || 2) - 1), to = mskDate_(0);
  for (let i = 0; i < cpc.length; i += 10) {
    const chunk = cpc.slice(i, i + 10);
    try {
      const data = fetchJson_('https://api-performance.ozon.ru/api/client/statistics/products/sku', {
        method: 'post', contentType: 'application/json', headers: headers,
        payload: JSON.stringify({ campaignIds: chunk, dateFrom: from, dateTo: to }),
      }, 'Статистика по товарам');
      (data.rows || []).forEach(function (r) {
        if (!r.sku || !r.date) return;
        out.push([cab.id, String(r.date).slice(0, 10), String(r.campaignId || ''), String(r.sku), parseRuNumber_(r.views), parseRuNumber_(r.clicks),
          parseRuNumber_(r.toCart), parseRuNumber_(r.orders), parseRuNumber_(r.sales), parseRuNumber_(r.expense), parseRuNumber_(r.avgCpc)]);
      });
    } catch (e) { Logger.log('Статистика по товарам ' + cab.id + ': ' + e.message); }
    Utilities.sleep(300);
  }
}

// «Оплата за заказ»: на каких товарах включена и какая ставка.
function collectCpoProducts_(cab, out) {
  const headers = perfHeaders_(cab);
  if (!headers) return;
  const nowIso = new Date().toISOString();
  for (let page = 1; page <= 50; page++) {
    const data = fetchJson_('https://api-performance.ozon.ru/api/client/campaign/search_promo/v2/products', {
      method: 'post', contentType: 'application/json', headers: headers,
      payload: JSON.stringify({ page: page, pageSize: 100 }),
    }, 'Товары оплаты за заказ');
    const products = data.products || [];
    products.forEach(function (p) {
      const prev = p.previousBid && typeof p.previousBid === 'object' ? (p.previousBid.bid || '') : (p.previousBid || '');
      out.push([cab.id, String(p.sku || ''), String(p.sourceSku || ''), p.searchPromoStatus ? 1 : 0, p.isSearchPromoAvailable === false ? 0 : 1,
        p.bid || '', p.bidPrice || '', prev, nowIso]);
    });
    if (products.length < 100) break;
    Utilities.sleep(300);
  }
}

// Ставки за клик по товарам кампаний с расходом (снимок).
function collectCpcBids_(cab, campaigns, out) {
  const headers = perfHeaders_(cab);
  if (!headers || !campaigns) return;
  const nowIso = new Date().toISOString();
  campaigns.filter(function (c) { return c.paymentType.toUpperCase() !== 'CPO' && c.state === 'CAMPAIGN_STATE_RUNNING'; }).forEach(function (c) {
    try {
      const data = fetchJson_('https://api-performance.ozon.ru/api/client/campaign/' + c.id + '/v2/products',
        { method: 'get', headers: headers }, 'Ставки РК ' + c.id);
      (data.products || []).forEach(function (p) {
        if (p.sku && p.bid !== undefined && p.bid !== null && p.bid !== '') out.push([cab.id, c.id, String(p.sku), p.bid, nowIso]);
      });
    } catch (e) { Logger.log('Ставки РК ' + c.id + ': ' + e.message); }
    Utilities.sleep(250);
  });
}

// ---------- Асинхронные отчёты Performance API ----------
function runPerfReport_(cab, url, payload, label) {
  const gen = fetchJson_(url, { method: 'post', contentType: 'application/json', headers: perfHeaders_(cab), payload: JSON.stringify(payload) }, label + ': заказ отчёта');
  const uuid = gen.UUID || gen.uuid;
  if (!uuid) throw new Error(label + ': нет UUID в ответе');
  for (let i = 0; i < 18; i++) { // до ~3 минут
    Utilities.sleep(10000);
    const st = fetchJson_('https://api-performance.ozon.ru/api/client/statistics/' + uuid, { method: 'get', headers: perfHeaders_(cab) }, label + ': статус');
    if (st.state === 'OK') {
      const resp = UrlFetchApp.fetch('https://api-performance.ozon.ru/api/client/statistics/report?UUID=' + uuid,
        { method: 'get', headers: perfHeaders_(cab), muteHttpExceptions: true });
      return resp.getContentText();
    }
    if (st.state === 'ERROR') throw new Error(label + ': Ozon вернул ошибку формирования отчёта');
  }
  throw new Error(label + ': отчёт не успел сформироваться');
}

// Ищет в разобранном JSON первый массив объектов-строк (структура ответа
// отчёта Ozon документирована не полностью).
function findRows_(obj, depth) {
  if (depth > 5 || obj === null || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) return obj.length && typeof obj[0] === 'object' ? obj : null;
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const r = findRows_(obj[keys[i]], depth + 1);
    if (r) return r;
  }
  return null;
}
function pickKey_(keys, patterns, exclude) {
  for (let p = 0; p < patterns.length; p++) {
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i].toLowerCase();
      if (exclude && exclude.test(k)) continue;
      if (patterns[p].test(k)) return keys[i];
    }
  }
  return null;
}
function normDate_(v) {
  const s = String(v || '');
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (m) return m[3] + '-' + m[2] + '-' + m[1];
  return '';
}
function parseCpoOrders_(cab, text, out) {
  let rows = null;
  try { rows = findRows_(JSON.parse(text), 0); } catch (e) { rows = null; }
  if (!rows) {
    // CSV-вариант: разделитель «;», шапка — строка, где есть SKU.
    const lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
    const hi = lines.findIndex(function (l) { return /sku/i.test(l); });
    if (hi === -1) { Logger.log('CPO-отчёт: не нашёл строк. Начало ответа: ' + text.slice(0, 500)); return 0; }
    const head = lines[hi].split(';').map(function (h) { return h.replace(/^"|"$/g, '').trim(); });
    rows = lines.slice(hi + 1).map(function (l) {
      const cells = l.split(';').map(function (c) { return c.replace(/^"|"$/g, '').trim(); });
      const o = {}; head.forEach(function (h, i) { o[h] = cells[i]; }); return o;
    });
  }
  if (!rows.length) return 0;
  const keys = Object.keys(rows[0]);
  Logger.log('CPO-отчёт: колонки ' + JSON.stringify(keys));
  const kDate = pickKey_(keys, [/^date$/, /дата/, /date/]);
  const kOrder = pickKey_(keys, [/orderid|order_id/, /id заказа/, /номер заказа|ordernumber/]);
  const kOrderNum = pickKey_(keys, [/ordernumber|номер заказа|номер отправления|posting/]);
  const kPromo = pickKey_(keys, [/promot|advsku|продвига/]);
  const kSku = pickKey_(keys, [/^sku$/, /^sku\b/, /sku/], /promot|advsku|продвига/);
  const kOffer = pickKey_(keys, [/offer|артикул/]);
  const kQty = pickKey_(keys, [/quantity|количество|qty/]);
  const kCost = pickKey_(keys, [/^cost$/, /стоимость, ₽|cost|стоимость/, /^price$/], /продаж|sale|bid|ставк/);
  const kExp = pickKey_(keys, [/expense|moneyspent|расход|spent/]);
  if (!kDate || !kExp || !(kSku || kPromo)) { Logger.log('CPO-отчёт: не распознал колонки (дата/SKU/расход) — пришлите журнал Claude'); return 0; }
  let n = 0;
  rows.forEach(function (r) {
    const date = normDate_(r[kDate]);
    if (!date) return;
    out.push([cab.id, date, kOrder ? String(r[kOrder]) : '', kSku ? String(r[kSku] || '') : '', kPromo ? String(r[kPromo] || '') : '',
      kOffer ? String(r[kOffer] || '') : '', kQty ? parseRuNumber_(r[kQty]) : 1, kCost ? parseRuNumber_(r[kCost]) : 0, parseRuNumber_(r[kExp]),
      '', kOrderNum ? String(r[kOrderNum] || '') : '']);
    n++;
  });
  return n;
}

// Каждый час (триггер) — отчёт по заказам «оплаты за заказ» за 3 дня;
// syncDaily дополнительно перезабирает 30 дней.
// Дата заказа по номеру отправления/заказа — из списков FBO и FBS за 45
// дней (товар выкупают обычно в пределах пары недель после заказа).
function orderDatesMap_(cab) {
  const headers = sellerHeaders_(cab);
  const map = {};
  if (!headers) return map;
  const since = new Date(Date.now() - 45 * 86400000).toISOString();
  const to = new Date().toISOString();
  [['https://api-seller.ozon.ru/v2/posting/fbo/list', 'FBO'], ['https://api-seller.ozon.ru/v3/posting/fbs/list', 'FBS']].forEach(function (src) {
    let offset = 0;
    for (let guard = 0; guard < 40; guard++) {
      let data;
      try {
        data = fetchJson_(src[0], {
          method: 'post', contentType: 'application/json', headers: headers,
          payload: JSON.stringify({ dir: 'ASC', filter: { since: since, to: to, status: '' }, limit: 1000, offset: offset }),
        }, 'Даты заказов ' + src[1]);
      } catch (e) { Logger.log(e.message); break; }
      let postings = data.result && data.result.postings;
      if (!Array.isArray(postings) && Array.isArray(data.result)) postings = data.result;
      postings = postings || [];
      postings.forEach(function (p) {
        const iso = p.in_process_at || p.created_at;
        if (!iso) return;
        const d = Utilities.formatDate(new Date(iso), 'GMT+3', 'yyyy-MM-dd');
        if (p.posting_number) map[String(p.posting_number)] = d;
        if (p.order_number) map[String(p.order_number)] = d;
        if (p.order_id) map[String(p.order_id)] = d;
      });
      if (postings.length < 1000) break;
      offset += 1000;
      Utilities.sleep(300);
    }
  });
  return map;
}

function syncCpoOrders(days) {
  const window = typeof days === 'number' ? days : 3;
  const cabinets = getCabinets_();
  const rows = [];
  cabinets.forEach(function (cab) {
    if (!perfHeaders_(cab)) return;
    try {
      const text = runPerfReport_(cab, 'https://api-performance.ozon.ru/api/client/statistic/orders/generate/json',
        { from: mskDate_(window - 1) + 'T00:00:00Z', to: mskDate_(0) + 'T23:59:59Z' }, 'CPO-отчёт ' + cab.id);
      const start = rows.length;
      Logger.log('CPO-отчёт ' + cab.id + ': строк ' + parseCpoOrders_(cab, text, rows));
      if (rows.length > start) {
        const dates = orderDatesMap_(cab);
        let found = 0;
        for (let i = start; i < rows.length; i++) {
          const num = String(rows[i][10] || ''), id = String(rows[i][2] || '');
          const d = dates[num] || dates[num.replace(/-\d+$/, '')] || dates[id] || '';
          rows[i][9] = d;
          if (d) found++;
        }
        Logger.log('CPO-отчёт ' + cab.id + ': дата заказа найдена для ' + found + ' из ' + (rows.length - start));
      }
    } catch (e) { Logger.log('CPO-отчёт ' + cab.id + ': ' + e.message); }
  });
  // Заказ может прийти с одинаковым id для разных SKU — ключ: кабинет+заказ+sku+продвигаемый sku.
  mergeIntoSheet_(SHEET_NAMES.cpoOrders, CPO_ORDERS_HEADERS, rows, [0, 2, 3, 4, 1], 1);
}
function syncCpoOrdersFull() { syncCpoOrders(30); }

// ---------- География заказов и выкуп ----------
// Все отправления FBO и FBS за N дней: кластер доставки и статус, сложенные
// по дню заказа и артикулу.
function collectGeo_(cab, days, agg, buy) {
  const headers = sellerHeaders_(cab);
  if (!headers) return 0;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const to = new Date().toISOString();
  let n = 0;
  [['https://api-seller.ozon.ru/v2/posting/fbo/list', 'FBO'], ['https://api-seller.ozon.ru/v3/posting/fbs/list', 'FBS']].forEach(function (src) {
    let offset = 0;
    for (let guard = 0; guard < 60; guard++) {
      let data;
      try {
        data = fetchJson_(src[0], {
          method: 'post', contentType: 'application/json', headers: headers,
          payload: JSON.stringify({ dir: 'ASC', filter: { since: since, to: to, status: '' }, limit: 1000, offset: offset, with: { analytics_data: false, financial_data: true } }),
        }, 'География ' + src[1]);
      } catch (e) { Logger.log(e.message); break; }
      let postings = data.result && data.result.postings;
      if (!Array.isArray(postings) && Array.isArray(data.result)) postings = data.result;
      postings = postings || [];
      postings.forEach(function (p) {
        const iso = p.in_process_at || p.created_at;
        if (!iso) return;
        const d = Utilities.formatDate(new Date(iso), 'GMT+3', 'yyyy-MM-dd');
        const cluster = String((p.financial_data && p.financial_data.cluster_to) || '').trim() || 'Кластер не указан';
        const st = String(p.status || '');
        const cancelled = /cancel/i.test(st);
        const delivered = st === 'delivered';
        (p.products || []).forEach(function (prod) {
          const q = Number(prod.quantity) || 1;
          const key = [cab.id, d, prod.offer_id || '', cluster].join('|');
          const r = agg[key] || (agg[key] = [cab.id, d, prod.offer_id || '', String(prod.sku || ''), cluster, 0, 0, 0]);
          if (cancelled) r[7] += q;
          else { r[5] += q; r[6] += q * (parseRuNumber_(prod.price) || 0); }
          const bk = [cab.id, d, prod.offer_id || ''].join('|');
          const b = buy[bk] || (buy[bk] = [cab.id, d, prod.offer_id || '', String(prod.sku || ''), 0, 0, 0, 0, 0]);
          b[4] += q;
          if (src[1] === 'FBS') b[8] += q;
          if (delivered) b[5] += q; else if (cancelled) b[6] += q; else b[7] += q;
          n++;
        });
      });
      if (postings.length < 1000) break;
      offset += 1000;
      Utilities.sleep(300);
    }
  });
  return n;
}

// Даты окна заменяются целиком (а не дописываются) — без дублей.
function replaceWindow_(sheetName, headers, rows, window, dateCol, keepRow) {
  const from = mskDate_(window - 1);
  // Полное окно (≥ срока хранения) — старое не нужно вовсе: не читаем
  // вкладку (большая вкладка читается дольше лимита Таблиц).
  if (window >= RETENTION_DAYS) { writeRows_(sheetName, headers, rows); return rows.length; }
  const sh = getSheet_(sheetName);
  const last = sh.getLastRow();
  const keep = last > 1 ? sh.getRange(2, 1, last - 1, Math.min(headers.length + 2, sh.getMaxColumns())).getValues() : [];
  const cutoff = mskDate_(RETENTION_DAYS);
  const old = keep.filter(function (r) {
    const d = r[dateCol] instanceof Date ? Utilities.formatDate(r[dateCol], 'GMT+3', 'yyyy-MM-dd') : String(r[dateCol]).slice(0, 10);
    return d < from && d >= cutoff && (!keepRow || keepRow(r));
  });
  writeRows_(sheetName, headers, old.concat(rows));
  return old.length + rows.length;
}

// Каждые 3 часа — последние 10 дней (статусы и отмены успевают обновиться).
// Первый раз запустите syncGeoFull вручную — заполнит 45 дней.
function syncGeo(days) {
  const window = typeof days === 'number' ? days : 10;
  const agg = {}, buy = {};
  getCabinets_().forEach(function (cab) {
    try { Logger.log('География ' + cab.id + ': позиций ' + collectGeo_(cab, window, agg, buy)); } catch (e) { Logger.log('География ' + cab.id + ': ' + e.message); }
  });
  const rows = Object.keys(agg).map(function (k) { const r = agg[k]; r[6] = Math.round(r[6] * 100) / 100; return r; });
  const brows = Object.keys(buy).map(function (k) { return buy[k]; });
  // Строки старого формата (10 колонок: регион, город, …, кластер) отбрасываем.
  const total = replaceWindow_(SHEET_NAMES.geo, GEO_HEADERS, rows, window, 1, function (r) { return r.length < 9 || r[8] === '' || r[8] === undefined; });
  const btotal = replaceWindow_(SHEET_NAMES.buyout, BUYOUT_HEADERS, brows, window, 1);
  const clusters = {};
  rows.forEach(function (r) { clusters[r[4]] = true; });
  Logger.log('syncGeo: строк за окно ' + rows.length + ' (всего ' + total + '), кластеров ' + Object.keys(clusters).length + '; выкуп: строк ' + brows.length + ' (всего ' + btotal + ')');
}
function syncGeoFull() { syncGeo(45); }

// ---------- Цены, комиссии и тарифы ----------
function collectPrices_(cab, out) {
  const headers = sellerHeaders_(cab);
  if (!headers) return;
  let cursor = '';
  const now = new Date().toISOString();
  for (let guard = 0; guard < 40; guard++) {
    const data = fetchJson_('https://api-seller.ozon.ru/v5/product/info/prices', {
      method: 'post', contentType: 'application/json', headers: headers,
      payload: JSON.stringify({ filter: { visibility: 'ALL' }, cursor: cursor, limit: 1000 }),
    }, 'Цены и комиссии');
    const items = data.items || [];
    items.forEach(function (it) {
      const c = it.commissions || {}, p = it.price || {};
      out.push([cab.id, it.offer_id || '', String(it.product_id || ''), parseRuNumber_(p.price), parseRuNumber_(p.marketing_seller_price || p.price),
        parseRuNumber_(it.acquiring), parseRuNumber_(c.sales_percent_fbo), parseRuNumber_(c.sales_percent_fbs),
        parseRuNumber_(c.fbo_deliv_to_customer_amount), parseRuNumber_(c.fbo_direct_flow_trans_max_amount), parseRuNumber_(c.fbo_return_flow_amount),
        parseRuNumber_(c.fbs_deliv_to_customer_amount), parseRuNumber_(c.fbs_direct_flow_trans_max_amount), parseRuNumber_(c.fbs_return_flow_amount), now,
        parseRuNumber_(it.volume_weight)]);
    });
    cursor = data.cursor || '';
    if (!cursor || items.length < 1000) break;
    Utilities.sleep(300);
  }
}
function syncPrices() {
  const rows = [];
  getCabinets_().forEach(function (cab) { try { collectPrices_(cab, rows); } catch (e) { Logger.log('Цены ' + cab.id + ': ' + e.message); } });
  if (rows.length) writeRows_(SHEET_NAMES.prices, PRICES_HEADERS, rows);
  Logger.log('syncPrices: товаров ' + rows.length);
}

// ---------- Финансы (начисления и списания Ozon) ----------
// Ozon отключил /v3/finance/transaction/list (сентябрь 2026). Теперь —
// /v1/finance/accrual/by-day: один день за запрос, листание по last_id;
// названия статей — из справочника /v1/finance/accrual/types.
// Разбор сделан «по форме»: в каждой записи ищем узлы со статьёй (type_id)
// и суммой, SKU берём из ближайшего товара. Остаток итоговой суммы записи
// после всех статей — выручка (продажа/возврат) или статья самой записи.
function accrualTypes_(cab) {
  const headers = sellerHeaders_(cab);
  const out = {};
  try {
    const data = fetchJson_('https://api-seller.ozon.ru/v1/finance/accrual/types', { method: 'post', contentType: 'application/json', headers: headers, payload: '{}' }, 'Типы начислений');
    const walk = function (o) {
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (!o || typeof o !== 'object') return;
      const id = o.type_id !== undefined ? o.type_id : o.id;
      const nm = o.name || o.title || o.type_name || o.description;
      if (id !== undefined && nm && typeof nm === 'string') out[String(id)] = nm;
      Object.keys(o).forEach(function (k) { if (typeof o[k] === 'object') walk(o[k]); });
    };
    walk(data);
  } catch (e) { Logger.log('Типы начислений ' + cab.id + ': ' + e.message); }
  return out;
}
function finAmount_(o) {
  if (!o || typeof o !== 'object') return null;
  const pick = function (v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v !== '' && !isNaN(Number(v))) return Number(v);
    if (typeof v === 'object') { const x = v.amount !== undefined ? v.amount : (v.value !== undefined ? v.value : v.units); return pick(x); }
    return null;
  };
  const keys = ['accrued', 'amount', 'total_amount', 'value', 'price', 'sum'];
  for (let i = 0; i < keys.length; i++) { const v = pick(o[keys[i]]); if (v !== null) return v; }
  return null;
}
function collectFinance_(cab, dates, agg, started, done) {
  const headers = sellerHeaders_(cab);
  if (!headers) return 0;
  const types = accrualTypes_(cab);
  const add = function (d, sku, name, amount, qty) {
    if (!amount && !qty) return;
    const k = [cab.id, d, sku, name].join('|');
    const r = agg[k] || (agg[k] = [cab.id, d, sku, name, 0, 0]);
    r[4] += amount; r[5] += qty;
  };
  const nameOf = function (id, fallback) { return types[String(id)] || fallback || ('Статья ' + id); };
  let n = 0, sampled = false;
  const names = {};
  for (let di = 0; di < dates.length; di++) {
    const d = dates[di];
    if (Date.now() - started > 280000) { Logger.log('Финансы ' + cab.id + ': время вышло на ' + d + ', остальные дни — в следующий запуск'); break; }
    let lastId = '', ok = true;
    for (let page = 0; page < 100; page++) {
      let data;
      try {
        data = fetchJson_('https://api-seller.ozon.ru/v1/finance/accrual/by-day', {
          method: 'post', contentType: 'application/json', headers: headers,
          payload: JSON.stringify({ date: d, last_id: lastId, limit: 1000 }),
        }, 'Финансы');
      } catch (e) { Logger.log('Финансы ' + cab.id + ' ' + d + ': ' + e.message); ok = false; break; }
      const res = data.result || data;
      const list = res.accruals || res.items || res.operations || [];
      if (!sampled && list.length) { sampled = true; Logger.log('Финансы ' + cab.id + ': пример записи ' + JSON.stringify(list[0]).slice(0, 2500)); }
      list.forEach(function (rec) {
        n++;
        const total = finAmount_({ amount: rec.total_amount }) || 0;
        let found = 0;
        // SKU записи (если товар один) — для статей вне блока товаров.
        const recSkus = [];
        const collectSkus = function (o) {
          if (Array.isArray(o)) { o.forEach(collectSkus); return; }
          if (!o || typeof o !== 'object') return;
          if (o.sku) recSkus.push(String(o.sku));
          Object.keys(o).forEach(function (k) { if (typeof o[k] === 'object') collectSkus(o[k]); });
        };
        collectSkus(rec);
        const uniq = recSkus.filter(function (v, i, a) { return a.indexOf(v) === i; });
        const recSku = uniq.length === 1 ? uniq[0] : '';
        let qty = 0;
        const hasTyped = function (o) {
          if (!o || typeof o !== 'object') return false;
          if (Array.isArray(o)) return o.some(hasTyped);
          if (o.type_id !== undefined && finAmount_(o) !== null) return true;
          return Object.keys(o).some(function (k) { return typeof o[k] === 'object' && hasTyped(o[k]); });
        };
        // Схема (FBO/FBS) — к названиям продажи и комиссии: комиссия у FBS
        // зависит от скорости отгрузки и отличается от FBO.
        const sch = rec.posting && rec.posting.delivery_schema ? ' ' + String(rec.posting.delivery_schema).toUpperCase() : '';
        const walk = function (o, sku, key, pq) {
          if (Array.isArray(o)) { o.forEach(function (x) { walk(x, sku, key, pq); }); return; }
          if (!o || typeof o !== 'object') return;
          if (o.sku) { sku = String(o.sku); pq = Number(o.quantity) || 1; if (key === 'products' || key === 'items') qty += pq; }
          const inner = Object.keys(o).some(function (k) { return typeof o[k] === 'object' && k !== 'total_amount' && hasTyped(o[k]); });
          const v = finAmount_(o);
          if (!inner && v !== null && (o.type_id !== undefined || key === 'commission')) {
            const nm = o.type_id !== undefined ? nameOf(o.type_id, o.name) : 'Комиссия' + sch;
            // Количество у услуг по товару — чтобы считать стоимость одной поездки.
            names[nm] = true; found += v; add(d, sku || recSku, nm, v, pq || 0);
            return;
          }
          Object.keys(o).forEach(function (k) { if (k !== 'total_amount' && typeof o[k] === 'object') walk(o[k], sku, k, pq); });
        };
        walk(rec, '', '', 0);
        const rest = total - found;
        if (Math.abs(rest) > 0.01) {
          const cat = String(rec.accrued_category || '');
          let nm;
          if (cat === 'POSTING' || /posting/i.test(cat)) nm = (rest > 0 ? 'Продажа' : 'Возврат выручки') + sch;
          else nm = rec.type_id !== undefined ? nameOf(rec.type_id, rec.name) : (rec.name || cat || 'Прочее');
          names[nm] = true;
          const sk = uniq.length ? uniq : [''];
          sk.forEach(function (x) { add(d, x, nm, rest / sk.length, /^Продажа/.test(nm) ? (qty || 1) / sk.length : /^Возврат выручки/.test(nm) ? -(qty || 1) / sk.length : 0); });
        }
      });
      lastId = res.last_id || '';
      if (!lastId || !list.length) break;
      Utilities.sleep(150);
    }
    if (ok) done[d] = true;
  }
  Logger.log('Финансы ' + cab.id + ': записей ' + n + ', типов в справочнике ' + Object.keys(types).length + '; статьи: ' + Object.keys(names).slice(0, 40).join(', '));
  return n;
}
// Даты, собранные полностью, заменяются целиком; остальные не трогаем.
function replaceDates_(sheetName, headers, rows, done, dateCol) {
  const sh = getSheet_(sheetName);
  const last = sh.getLastRow();
  const cutoff = mskDate_(RETENTION_DAYS);
  let old = [];
  if (last > 1) {
    old = sh.getRange(2, 1, last - 1, headers.length).getValues().filter(function (r) {
      const d = r[dateCol] instanceof Date ? Utilities.formatDate(r[dateCol], 'GMT+3', 'yyyy-MM-dd') : String(r[dateCol]).slice(0, 10);
      return d && d >= cutoff && !done[d];
    });
  }
  const fresh = rows.filter(function (r) { return done[r[dateCol]]; });
  writeRows_(sheetName, headers, old.concat(fresh));
  return old.length + fresh.length;
}
// Каждые 6 часов — последние 5 дней. Первый раз запустите syncFinanceFull —
// заполнит 30 дней (если не успеет за один прогон, сам продолжит через минуту).
function syncFinance(days) {
  const window = typeof days === 'number' ? days : 5;
  const dates = [];
  for (let i = window - 1; i >= 0; i--) dates.push(mskDate_(i));
  runFinance_(dates);
}
function runFinance_(dates) {
  const started = Date.now();
  const agg = {};
  const doneBy = {};
  getCabinets_().forEach(function (cab) {
    doneBy[cab.id] = {};
    try { collectFinance_(cab, dates, agg, started, doneBy[cab.id]); } catch (e) { Logger.log('Финансы ' + cab.id + ': ' + e.message); }
  });
  // День считается собранным, если собран во всех кабинетах.
  const cabs = Object.keys(doneBy);
  const done = {};
  dates.forEach(function (d) { if (cabs.every(function (c) { return doneBy[c][d]; })) done[d] = true; });
  const rows = Object.keys(agg).map(function (k) { const r = agg[k]; r[4] = Math.round(r[4] * 100) / 100; r[5] = Math.round(r[5] * 100) / 100; return r; });
  const total = replaceDates_(SHEET_NAMES.finance, FINANCE_HEADERS, rows, done, 1);
  const left = dates.filter(function (d) { return !done[d]; });
  Logger.log('syncFinance: дней собрано ' + Object.keys(done).length + ' из ' + dates.length + ', строк ' + rows.length + ' (всего во вкладке ' + total + ')');
  const props = PropertiesService.getScriptProperties();
  if (left.length && left.length < dates.length) {
    props.setProperty('FIN_PENDING', JSON.stringify(left));
    ScriptApp.newTrigger('syncFinanceContinue').timeBased().after(60 * 1000).create();
    Logger.log('Остальные ' + left.length + ' дн. — продолжу через минуту автоматически');
  } else props.deleteProperty('FIN_PENDING');
}
function syncFinanceContinue() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'syncFinanceContinue') ScriptApp.deleteTrigger(t); });
  const left = JSON.parse(PropertiesService.getScriptProperties().getProperty('FIN_PENDING') || '[]');
  if (left.length) runFinance_(left);
}
function syncFinanceFull() { syncFinance(30); }

// ---------- Запись в таблицу ----------
function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function writeRows_(sheetName, headers, rows) {
  const sh = getSheet_(sheetName);
  sh.clearContents();
  const all = [headers].concat(rows.map(function (r) {
    // Строки старого формата (меньше колонок) дополняем пустыми — иначе
    // setValues падает при добавлении новой колонки в шапку.
    const row = r.slice(0, headers.length);
    while (row.length < headers.length) row.push('');
    return row.map(function (v) { return (v === null || v === undefined) ? '' : String(v); });
  }));
  const range = sh.getRange(1, 1, all.length, headers.length);
  // Текстовый формат ДО записи значений — иначе Таблицы превратят длинные
  // ID кампаний/SKU в "1.23E+12", а даты — в локальный формат дат.
  range.setNumberFormat('@');
  range.setValues(all);
}

function readSheetAsMap_(sheetName, keyCols) {
  const sh = getSheet_(sheetName);
  const values = sh.getDataRange().getValues();
  const map = {};
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row.length || row.every(function (v) { return v === ''; })) continue;
    const key = keyCols.map(function (c) { return String(row[c]); }).join('|');
    map[key] = row;
  }
  return map;
}

// Сливает новые строки в уже существующие во вкладке (по ключевым колонкам),
// не трогая остальную историю, и подрезает слишком старые даты, чтобы
// вкладка не росла бесконечно.
function mergeIntoSheet_(sheetName, headers, newRows, keyCols, dateCol) {
  const map = readSheetAsMap_(sheetName, keyCols);
  newRows.forEach(function (row) {
    const key = keyCols.map(function (c) { return String(row[c]); }).join('|');
    map[key] = row;
  });
  let rows = Object.keys(map).map(function (k) { return map[k]; });
  if (dateCol !== undefined) {
    const cutoff = mskDate_(RETENTION_DAYS);
    rows = rows.filter(function (r) { return String(r[dateCol]) >= cutoff; });
  }
  writeRows_(sheetName, headers, rows);
}

// true, если с прошлого раза прошло не меньше hours часов (и отмечает запуск).
function dueEvery_(key, hours) {
  const props = PropertiesService.getScriptProperties();
  const last = Number(props.getProperty('last_' + key) || 0);
  if (Date.now() - last < hours * 3600 * 1000) return false;
  props.setProperty('last_' + key, String(Date.now()));
  return true;
}

// ---------- Точки входа ----------
function syncRecent() {
  const cabinets = getCabinets_();
  if (!cabinets.length) { Logger.log('Нет настроенных кабинетов — проверьте Свойства скрипта.'); return; }
  const analytics = [], stocks = [], campaigns = [], stats = [], campaignSkus = [];
  const skuStats = [], cpoProducts = [], cpcBids = [];
  const from = mskDate_(ANALYTICS_WINDOW_DAYS_RECENT - 1), to = mskDate_(0);
  cabinets.forEach(function (cab) {
    try { collectAnalyticsWindow_(cab, from, to, analytics); } catch (e) { Logger.log('Аналитика ' + cab.id + ': ' + e.message); }
    try { collectStocks_(cab, stocks); } catch (e) { Logger.log('Остатки ' + cab.id + ': ' + e.message); }
    let withSpend = null;
    try { withSpend = collectCampaignsAndStats_(cab, from, to, campaigns, stats, campaignSkus); } catch (e) { Logger.log('Кампании/расход ' + cab.id + ': ' + e.message); }
    try { collectSkuStats_(cab, withSpend, skuStats); } catch (e) { Logger.log('Статистика по товарам ' + cab.id + ': ' + e.message); }
    // Статус ОЗЗ и ставки меняются редко — проверяем раз в 2 часа (экономим
    // суточный лимит времени работы скрипта у Google).
    if (dueEvery_('slow_' + cab.id, 2)) {
      try { collectCpoProducts_(cab, cpoProducts); } catch (e) { Logger.log('Оплата за заказ (товары) ' + cab.id + ': ' + e.message); }
      try { collectCpcBids_(cab, withSpend, cpcBids); } catch (e) { Logger.log('Ставки ' + cab.id + ': ' + e.message); }
    }
  });
  mergeIntoSheet_(SHEET_NAMES.skuStats, SKU_STATS_HEADERS, skuStats, [0, 1, 2, 3], 1);
  if (cpoProducts.length) writeRows_(SHEET_NAMES.cpoProducts, CPO_PRODUCTS_HEADERS, cpoProducts);
  if (cpcBids.length) writeRows_(SHEET_NAMES.cpcBids, CPC_BIDS_HEADERS, cpcBids);
  mergeIntoSheet_(SHEET_NAMES.analytics, ANALYTICS_HEADERS, analytics, [0, 1, 2], 1);
  if (stocks.length) writeRows_(SHEET_NAMES.stocks, STOCKS_HEADERS, stocks); // текущий снэпшот — перезаписываем целиком
  mergeIntoSheet_(SHEET_NAMES.campaigns, CAMPAIGNS_HEADERS, campaigns, [0, 1]);
  mergeIntoSheet_(SHEET_NAMES.stats, STATS_HEADERS, stats, [0, 1, 2], 1);
  mergeIntoSheet_(SHEET_NAMES.campaignSkus, CAMPAIGN_SKUS_HEADERS, campaignSkus, [0, 1, 2]);
  Logger.log('syncRecent: аналитика ' + analytics.length + ', остатки ' + stocks.length + ', кампании ' + campaigns.length + ', статистика ' + stats.length + ', товары РК ' + campaignSkus.length
    + ', по товарам ' + skuStats.length + ', оплата за заказ ' + cpoProducts.length + ', ставки ' + cpcBids.length);
}

function syncDaily() {
  const cabinets = getCabinets_();
  if (!cabinets.length) { Logger.log('Нет настроенных кабинетов — проверьте Свойства скрипта.'); return; }

  const catalog = [];
  cabinets.forEach(function (cab) {
    try { collectCatalog_(cab, catalog); } catch (e) { Logger.log('Каталог ' + cab.id + ': ' + e.message); }
  });
  if (catalog.length) writeRows_(SHEET_NAMES.catalog, CATALOG_HEADERS, catalog);

  const analytics = [], stats = [], campaigns = [], skuStatsFull = [];
  const fromA = mskDate_(ANALYTICS_WINDOW_DAYS_FULL - 1), toA = mskDate_(0);
  const fromS = mskDate_(STATS_WINDOW_DAYS_FULL - 1), toS = mskDate_(0);
  cabinets.forEach(function (cab) {
    try { collectAnalyticsWindow_(cab, fromA, toA, analytics); } catch (e) { Logger.log('Аналитика(полная) ' + cab.id + ': ' + e.message); }
    let withSpend = null;
    try { withSpend = collectCampaignsAndStats_(cab, fromS, toS, campaigns, stats); } catch (e) { Logger.log('Кампании(полные) ' + cab.id + ': ' + e.message); }
  });
  mergeIntoSheet_(SHEET_NAMES.analytics, ANALYTICS_HEADERS, analytics, [0, 1, 2], 1);
  mergeIntoSheet_(SHEET_NAMES.stats, STATS_HEADERS, stats, [0, 1, 2], 1);
  mergeIntoSheet_(SHEET_NAMES.campaigns, CAMPAIGNS_HEADERS, campaigns, [0, 1]);
  Logger.log('syncDaily: каталог ' + catalog.length + ', аналитика ' + analytics.length + ', кампании ' + campaigns.length + ', статистика ' + stats.length);
  try { syncCpoOrders(30); } catch (e) { Logger.log('CPO-отчёт (30 дн): ' + e.message); }
  try { syncPrices(); } catch (e) { Logger.log('Цены и комиссии: ' + e.message); }
}

// Выполнить один раз вручную — поставит оба триггера по расписанию.
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (['syncRecent', 'syncDaily', 'syncOrders', 'syncCpoOrders', 'syncSkuHistory', 'syncGeo', 'syncFinance'].indexOf(fn) !== -1) ScriptApp.deleteTrigger(t);
  });
  // У бесплатного аккаунта Google суммарное время работы триггеров
  // ограничено (около 90 минут в сутки) — поэтому расписание пореже.
  ScriptApp.newTrigger('syncOrders').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('syncRecent').timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger('syncCpoOrders').timeBased().everyHours(3).create();
  ScriptApp.newTrigger('syncDaily').timeBased().atHour(4).everyDays(1).create();
  ScriptApp.newTrigger('syncSkuHistory').timeBased().atHour(5).everyDays(1).create();
  ScriptApp.newTrigger('syncGeo').timeBased().everyHours(3).create();
  ScriptApp.newTrigger('syncFinance').timeBased().everyHours(6).create();
  Logger.log('Триггеры поставлены: syncOrders каждые 10 мин, syncRecent каждые 30 мин, syncCpoOrders каждые 3 часа, syncDaily в 4:00, syncSkuHistory в 5:00, syncGeo каждые 3 часа, syncFinance каждые 6 часов.');
}

// ── История расхода «оплаты за клик» по каждому товару и дню ─────────────
// Быстрый метод statistics/products/sku отдаёт только вчера и сегодня
// (Ozon: "date range must contain only today or yesterday"). За прошлые дни —
// асинхронный отчёт по кампаниям (POST /api/client/statistics/json,
// groupBy=DATE, до 62 дней): в нём строки по каждому товару за каждый день.
// Запускается раз в сутки (триггер syncSkuHistory) и вручную.
function parseCampaignReport_(cab, text, out) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { Logger.log('Отчёт по кампаниям: не JSON. Начало: ' + text.slice(0, 300)); return 0; }
  // Ожидаем {"<id кампании>": {"report": {"rows": [...]}}}; на всякий случай
  // ищем массив строк и в других местах.
  const groups = [];
  Object.keys(obj || {}).forEach(function (k) {
    const v = obj[k];
    if (v && typeof v === 'object' && v.report && Array.isArray(v.report.rows)) groups.push([k, v.report.rows]);
  });
  if (!groups.length) { const rows = findRows_(obj, 0); if (rows) groups.push(['', rows]); }
  // В отчёте строка на каждый поисковый запрос, поэтому на один товар за
  // день по одной кампании строк бывает несколько — складываем их.
  const agg = {};
  let logged = false, campsWithRows = 0;
  groups.forEach(function (g) {
    const rows = g[1];
    if (!rows.length) return;
    campsWithRows++;
    const keys = Object.keys(rows[0]);
    if (!logged) { Logger.log('Отчёт по кампаниям: колонки ' + JSON.stringify(keys)); logged = true; }
    const kDate = pickKey_(keys, [/^date$/, /дата/, /date/], /created/);
    const kSku = pickKey_(keys, [/^sku$/, /sku/]);
    const kExp = pickKey_(keys, [/moneyspent/, /expense/, /расход/, /spent/]);
    const kViews = pickKey_(keys, [/^views$/, /показ/, /views/]);
    const kClicks = pickKey_(keys, [/^clicks$/, /клик/, /clicks/]);
    const kCart = pickKey_(keys, [/tocart/, /корзин/, /cart/]);
    const kOrders = pickKey_(keys, [/^orders$/, /^заказы/, /orders/], /money|руб|sum|стоим/);
    const kSales = pickKey_(keys, [/ordersmoney/, /sales/, /выручк|заказы, ₽|стоимость заказов/]);
    const kCamp = pickKey_(keys, [/campaignid|campaign_id/, /кампан/]);
    if (!kDate || !kSku || !kExp) { Logger.log('Отчёт по кампаниям: не распознал колонки — пришлите журнал Claude'); return; }
    rows.forEach(function (r) {
      const date = normDate_(r[kDate]);
      if (!date || !r[kSku]) return;
      const camp = String(g[0] || (kCamp ? r[kCamp] : '') || '');
      const key = date + '|' + camp + '|' + r[kSku];
      const a = agg[key] || (agg[key] = { date: date, camp: camp, sku: String(r[kSku]), v: 0, c: 0, t: 0, o: 0, s: 0, e: 0 });
      a.v += kViews ? parseRuNumber_(r[kViews]) : 0;
      a.c += kClicks ? parseRuNumber_(r[kClicks]) : 0;
      a.t += kCart ? parseRuNumber_(r[kCart]) : 0;
      a.o += kOrders ? parseRuNumber_(r[kOrders]) : 0;
      a.s += kSales ? parseRuNumber_(r[kSales]) : 0;
      a.e += parseRuNumber_(r[kExp]);
    });
  });
  let n = 0, noCamp = 0, spend = 0;
  Object.keys(agg).forEach(function (k) {
    const a = agg[k];
    if (!a.camp) noCamp++;
    spend += a.e;
    out.push([cab.id, a.date, a.camp, a.sku, a.v, a.c, a.t, a.o, a.s, Math.round(a.e * 100) / 100, a.c > 0 ? Math.round(a.e / a.c * 100) / 100 : 0]);
    n++;
  });
  Logger.log('  кампаний со строками ' + campsWithRows + ', товаро-дней ' + n + ', расход ' + Math.round(spend) + ' ₽' + (noCamp ? ', БЕЗ id кампании: ' + noCamp : ''));
  return n;
}

// Если кампаний много и не успели за один запуск (лимит Apps Script 6 мин),
// продолжение запускается само через минуту с того же места.
function syncSkuHistoryContinue() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncSkuHistoryContinue') ScriptApp.deleteTrigger(t);
  });
  syncSkuHistory(30, true);
}

function syncSkuHistory(days, resume) {
  const window = typeof days === 'number' ? days : 30;
  const props = PropertiesService.getScriptProperties();
  if (!resume) props.deleteProperty('SKU_HIST_PROGRESS');
  const progress = JSON.parse(props.getProperty('SKU_HIST_PROGRESS') || '{}');
  const started = Date.now();
  let outOfTime = false;
  const rows = [];
  getCabinets_().forEach(function (cab) {
    if (outOfTime || !perfHeaders_(cab) || progress[cab.id] >= 1e9) return;
    let withSpend = null;
    try { withSpend = collectCampaignsAndStats_(cab, mskDate_(window - 1), mskDate_(0), [], []); } catch (e) { Logger.log('Кампании ' + cab.id + ': ' + e.message); return; }
    const cpc = (withSpend || []).filter(function (c) { return c.paymentType.toUpperCase() !== 'CPO'; }).map(function (c) { return c.id; });
    Logger.log('История по товарам ' + cab.id + ': кампаний с расходом ' + cpc.length);
    // По 10 кампаний в отчёте, отчёты — по очереди (Ozon не любит параллельные).
    for (let i = progress[cab.id] || 0; i < cpc.length; i += 10) {
      if (Date.now() - started > 240000) {
        progress[cab.id] = i;
        outOfTime = true;
        break;
      }
      const chunk = cpc.slice(i, i + 10);
      try {
        const text = runPerfReport_(cab, 'https://api-performance.ozon.ru/api/client/statistics/json',
          { campaigns: chunk, dateFrom: mskDate_(window - 1), dateTo: mskDate_(0), groupBy: 'DATE' }, 'Отчёт по кампаниям ' + cab.id);
        Logger.log('Отчёт по кампаниям ' + cab.id + ' (' + chunk.length + ' РК): строк ' + parseCampaignReport_(cab, text, rows));
      } catch (e) { Logger.log('Отчёт по кампаниям ' + cab.id + ': ' + e.message); }
    }
    if (!outOfTime) progress[cab.id] = 1e9; // кабинет готов
  });
  if (outOfTime) {
    props.setProperty('SKU_HIST_PROGRESS', JSON.stringify(progress));
    ScriptApp.newTrigger('syncSkuHistoryContinue').timeBased().after(60 * 1000).create();
    Logger.log('syncSkuHistory: не успели всё за один запуск — продолжу автоматически через минуту.');
  } else {
    props.deleteProperty('SKU_HIST_PROGRESS');
  }
  mergeIntoSheet_(SHEET_NAMES.skuStats, SKU_STATS_HEADERS, rows, [0, 1, 2, 3], 1);
  const ds = {};
  rows.forEach(function (r) { ds[r[1]] = true; });
  const list = Object.keys(ds).sort();
  Logger.log('syncSkuHistory: строк ' + rows.length + ', дней ' + list.length + (list.length ? ' (' + list[0] + ' … ' + list[list.length - 1] + ')' : ''));
}
