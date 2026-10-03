/**
 * Сбор данных Ozon в Google Таблицу — обход блокировки сети на Render.
 *
 * Как устроено:
 *  - Этот скрипт живёт ВНУТРИ Google Таблицы (Расширения -> Apps Script)
 *    и ходит в Ozon с серверов Google, а не с Render. Ozon блокирует именно
 *    выход Render (см. /api/netcheck) — Google он не блокирует.
 *  - Скрипт кладёт результат во вкладки этой же таблицы (Catalog, Analytics,
 *    Stocks, Campaigns, Stats).
 *  - Backend на Render читает эти вкладки как обычный CSV по ссылке —
 *    только когда прямой запрос к Ozon не проходит (см. backend/src/
 *    collectors/ads/sheetSync.js и jobs.js). Как только сеть разблокируется,
 *    всё само вернётся на прямой сбор.
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
 *     кнопка "Выполнить") — она поставит сама себя собирать данные каждые
 *     15 минут (свежие данные) и раз в сутки (докачка истории + каталог).
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
};

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
  if (!headers) return;
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
}

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
    return r.map(function (v) { return (v === null || v === undefined) ? '' : String(v); });
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

// ---------- Точки входа ----------
function syncRecent() {
  const cabinets = getCabinets_();
  if (!cabinets.length) { Logger.log('Нет настроенных кабинетов — проверьте Свойства скрипта.'); return; }
  const analytics = [], stocks = [], campaigns = [], stats = [], campaignSkus = [];
  const from = mskDate_(ANALYTICS_WINDOW_DAYS_RECENT - 1), to = mskDate_(0);
  cabinets.forEach(function (cab) {
    try { collectAnalyticsWindow_(cab, from, to, analytics); } catch (e) { Logger.log('Аналитика ' + cab.id + ': ' + e.message); }
    try { collectStocks_(cab, stocks); } catch (e) { Logger.log('Остатки ' + cab.id + ': ' + e.message); }
    try { collectCampaignsAndStats_(cab, from, to, campaigns, stats, campaignSkus); } catch (e) { Logger.log('Кампании/расход ' + cab.id + ': ' + e.message); }
  });
  mergeIntoSheet_(SHEET_NAMES.analytics, ANALYTICS_HEADERS, analytics, [0, 1, 2], 1);
  if (stocks.length) writeRows_(SHEET_NAMES.stocks, STOCKS_HEADERS, stocks); // текущий снэпшот — перезаписываем целиком
  mergeIntoSheet_(SHEET_NAMES.campaigns, CAMPAIGNS_HEADERS, campaigns, [0, 1]);
  mergeIntoSheet_(SHEET_NAMES.stats, STATS_HEADERS, stats, [0, 1, 2], 1);
  mergeIntoSheet_(SHEET_NAMES.campaignSkus, CAMPAIGN_SKUS_HEADERS, campaignSkus, [0, 1, 2]);
  Logger.log('syncRecent: аналитика ' + analytics.length + ', остатки ' + stocks.length + ', кампании ' + campaigns.length + ', статистика ' + stats.length + ', товары РК ' + campaignSkus.length);
}

function syncDaily() {
  const cabinets = getCabinets_();
  if (!cabinets.length) { Logger.log('Нет настроенных кабинетов — проверьте Свойства скрипта.'); return; }

  const catalog = [];
  cabinets.forEach(function (cab) {
    try { collectCatalog_(cab, catalog); } catch (e) { Logger.log('Каталог ' + cab.id + ': ' + e.message); }
  });
  if (catalog.length) writeRows_(SHEET_NAMES.catalog, CATALOG_HEADERS, catalog);

  const analytics = [], stats = [], campaigns = [];
  const fromA = mskDate_(ANALYTICS_WINDOW_DAYS_FULL - 1), toA = mskDate_(0);
  const fromS = mskDate_(STATS_WINDOW_DAYS_FULL - 1), toS = mskDate_(0);
  cabinets.forEach(function (cab) {
    try { collectAnalyticsWindow_(cab, fromA, toA, analytics); } catch (e) { Logger.log('Аналитика(полная) ' + cab.id + ': ' + e.message); }
    try { collectCampaignsAndStats_(cab, fromS, toS, campaigns, stats); } catch (e) { Logger.log('Кампании(полные) ' + cab.id + ': ' + e.message); }
  });
  mergeIntoSheet_(SHEET_NAMES.analytics, ANALYTICS_HEADERS, analytics, [0, 1, 2], 1);
  mergeIntoSheet_(SHEET_NAMES.stats, STATS_HEADERS, stats, [0, 1, 2], 1);
  mergeIntoSheet_(SHEET_NAMES.campaigns, CAMPAIGNS_HEADERS, campaigns, [0, 1]);
  Logger.log('syncDaily: каталог ' + catalog.length + ', аналитика ' + analytics.length + ', кампании ' + campaigns.length + ', статистика ' + stats.length);
}

// Выполнить один раз вручную — поставит оба триггера по расписанию.
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (fn === 'syncRecent' || fn === 'syncDaily') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncRecent').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('syncDaily').timeBased().atHour(4).everyDays(1).create();
  Logger.log('Триггеры поставлены: syncRecent каждые 15 мин, syncDaily раз в сутки в 4:00.');
}
