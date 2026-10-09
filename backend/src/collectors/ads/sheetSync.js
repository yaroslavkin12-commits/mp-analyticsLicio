const axios = require('axios');
const { query } = require('../../db');
const { bulkUpsert, bulkInsert } = require('./ozonHttp');

// Запасной источник данных Ozon, когда прямые запросы с Render блокируются
// сетью (см. /api/netcheck). Google Apps Script (другой скрипт, живёт в
// Google Таблице пользователя — см. google-apps-script/ozon-sheet-sync.gs)
// ходит в Ozon со стороны Google и кладёт результат в таблицу; мы читаем её
// как обычный CSV (вкладка "Опубликовано"/доступна по ссылке — без
// служебного аккаунта и OAuth на нашей стороне).
//
// Используется как fallback: сначала всегда пробуем настоящий запрос к Ozon
// (см. jobs.js), и только если он падает — берём то, что успел собрать
// скрипт в таблице. Как только сеть разблокируется, всё само вернётся на
// прямой сбор, никаких ручных переключений не нужно.

function sheetId() {
  return process.env.ADS_SHEET_ID || null;
}

function csvUrl(sheetName) {
  return `https://docs.google.com/spreadsheets/d/${sheetId()}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
}

// Простой CSV-парсер (с поддержкой кавычек/экранирования) — без внешней
// библиотеки, чтобы не тащить лишнюю зависимость ради одного маленького
// фида раз в 15-20 минут.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* пропускаем, перевод строки обработает \n */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

// Обязательные колонки каждой вкладки. ВАЖНО: если вкладки с таким именем
// ещё нет, Google отдаёт по ссылке ПЕРВУЮ вкладку таблицы — без этой
// проверки мы прочитали бы, например, Analytics вместо CpoProducts.
const REQUIRED_COLUMNS = {
  // CpoOrders: order_date не обязателен (старая версия скрипта его не пишет).
  Catalog: ['offer_id', 'sku'],
  Analytics: ['date', 'sku', 'hits_view'],
  Stocks: ['offer_id', 'fbo_present'],
  Campaigns: ['campaign_id', 'title'],
  Stats: ['campaign_id', 'spend'],
  CampaignSkus: ['campaign_id', 'checked_at'],
  Orders: ['posting_number', 'created_at'],
  SkuStats: ['campaign_id', 'expense', 'to_cart'],
  CpoProducts: ['enabled', 'bid_pct'],
  CpcBids: ['campaign_id', 'bid'],
  CpoOrders: ['order_id', 'promoted_sku', 'expense'],
  GeoOrders: ['cluster', 'qty', 'revenue'],
  Buyout: ['ordered', 'delivered', 'in_progress'],
  Prices: ['pct_fbo', 'fbo_deliv', 'acquiring'],
  Finance: ['name', 'amount', 'qty'],
};

async function fetchSheetRows(sheetName) {
  const id = sheetId();
  if (!id) return null; // ADS_SHEET_ID не настроен — считаем, что фоллбек не включён
  const resp = await axios.get(csvUrl(sheetName), { timeout: 20000, responseType: 'text' });
  const rows = parseCsv(String(resp.data));
  if (!rows.length) return [];
  const headers = rows[0];
  const required = REQUIRED_COLUMNS[sheetName] || [];
  if (required.some(c => !headers.includes(c))) {
    // Вкладки ещё нет (скрипт не обновлён) — Google подсунул другую.
    return null;
  }
  return rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i] !== undefined ? r[i] : ''; });
    return obj;
  });
}

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

async function syncCatalogFromSheet(cabinet) {
  const rows = await fetchSheetRows('Catalog');
  if (rows === null) return { rows: 0 };
  const filtered = rows.filter(r => r.cabinet === cabinet && r.offer_id);
  const out = filtered.map(r => [cabinet, 'ozon', r.offer_id, r.sku || null, r.product_name ? String(r.product_name).slice(0, 500) : null, new Date()]);
  const saved = await bulkUpsert('ad_product_catalog',
    ['cabinet', 'platform', 'offer_id', 'sku', 'product_name', 'updated_at'],
    out, ['cabinet', 'platform', 'offer_id']);
  console.log(`[SheetCatalog:${cabinet}] ${saved} (из Google-таблицы)`);
  return { rows: saved };
}

async function syncAnalyticsFromSheet(cabinet) {
  const rows = await fetchSheetRows('Analytics');
  if (rows === null) return { rows: 0 };
  const catalog = await query(`SELECT sku, offer_id FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon' AND sku IS NOT NULL`, [cabinet]);
  const offerBySku = new Map(catalog.map(r => [String(r.sku), r.offer_id]));
  const out = rows
    .filter(r => r.cabinet === cabinet && r.sku && /^\d{4}-\d{2}-\d{2}$/.test(r.date))
    .map(r => [
      cabinet, 'ozon', r.date, r.sku, offerBySku.get(String(r.sku)) || null,
      num(r.hits_view), num(r.hits_view_search), num(r.hits_view_pdp), num(r.hits_tocart),
      num(r.orders_item), num(r.revenue), r.position_category || null, new Date(),
    ]);
  const saved = await bulkUpsert('product_analytics_daily',
    ['cabinet', 'platform', 'date', 'sku', 'offer_id', 'hits_view', 'hits_view_search', 'hits_view_pdp',
     'hits_tocart', 'orders_item', 'revenue', 'position_category', 'collected_at'],
    out, ['cabinet', 'platform', 'date', 'sku']);
  console.log(`[SheetAnalytics:${cabinet}] ${saved} (из Google-таблицы)`);
  return { rows: saved };
}

async function syncStocksFromSheet(cabinet) {
  const rows = await fetchSheetRows('Stocks');
  if (rows === null) return { rows: 0 };
  const filtered = rows.filter(r => r.cabinet === cabinet && r.offer_id);
  if (!filtered.length) return { rows: 0 };
  const today = new Date().toISOString().slice(0, 10);
  const out = filtered.map(r => [cabinet, 'ozon', today, r.product_id || null, r.offer_id,
    num(r.fbo_present), num(r.fbo_reserved), num(r.fbs_present), num(r.fbs_reserved)]);
  await query(`DELETE FROM ad_product_stocks WHERE cabinet = $1 AND platform = 'ozon' AND snapshot_date = $2`, [cabinet, today]);
  await bulkInsert('ad_product_stocks',
    ['cabinet', 'platform', 'snapshot_date', 'sku', 'offer_id', 'fbo_present', 'fbo_reserved', 'fbs_present', 'fbs_reserved'], out);
  console.log(`[SheetStocks:${cabinet}] ${out.length} (из Google-таблицы)`);
  return { rows: out.length };
}

async function syncCampaignsFromSheet(cabinet) {
  const rows = await fetchSheetRows('Campaigns');
  if (rows === null) return { rows: 0 };
  const filtered = rows.filter(r => r.cabinet === cabinet && r.campaign_id);
  const out = filtered.map(r => [cabinet, 'ozon', r.campaign_id, r.title || null, r.state || null, r.adv_object_type || null,
    r.payment_type || null, r.autopilot_strategy || null, r.placement || null, r.expense_strategy || null, new Date()]);
  const saved = await bulkUpsert('ad_campaigns',
    ['cabinet', 'platform', 'campaign_id', 'title', 'state', 'adv_object_type', 'payment_type',
     'autopilot_strategy', 'placement', 'expense_strategy', 'updated_at'],
    out, ['cabinet', 'platform', 'campaign_id']);

  // Привязка кампании к артикулу по вхождению offer_id в название — тот же
  // запасной вариант, что и в ozonPerf.js, только без похода за товарами
  // кампании (дорого делать из Apps Script на весь список кампаний).
  const catalogRows = await query(`SELECT offer_id FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon'`, [cabinet]);
  const offerIds = catalogRows.map(r => String(r.offer_id).toLowerCase()).filter(o => o && o.length >= 4);
  const ids = [], matches = [];
  for (const r of filtered) {
    if (!r.title) continue;
    const t = String(r.title).trim().toLowerCase();
    const match = offerIds.find(o => t.includes(o));
    if (match) { ids.push(String(r.campaign_id)); matches.push(match); }
  }
  // Одним запросом, а не по UPDATE на каждую из ~900 кампаний (это одно
  // занимало десятки секунд и роняло задачу по таймауту).
  if (ids.length) {
    await query(
      `UPDATE ad_campaigns c SET matched_offer_id = COALESCE(c.matched_offer_id, m.offer_id)
         FROM unnest($2::text[], $3::text[]) AS m(campaign_id, offer_id)
        WHERE c.cabinet = $1 AND c.platform = 'ozon' AND c.campaign_id = m.campaign_id`,
      [cabinet, ids, matches]);
  }
  console.log(`[SheetCampaigns:${cabinet}] ${saved} (из Google-таблицы)`);
  return { rows: saved };
}

async function syncStatsFromSheet(cabinet) {
  const rows = await fetchSheetRows('Stats');
  if (rows === null) return { rows: 0 };
  const filtered = rows.filter(r => r.cabinet === cabinet && r.campaign_id && r.date);
  const out = filtered.map(r => [cabinet, 'ozon', r.date, r.campaign_id, num(r.views), num(r.clicks), num(r.ctr), num(r.avg_bid),
    num(r.orders), num(r.orders_money), num(r.spend), new Date()]);
  const saved = await bulkUpsert('ad_stats_daily',
    ['cabinet', 'platform', 'date', 'campaign_id', 'views', 'clicks', 'ctr', 'avg_bid', 'orders', 'orders_money', 'spend', 'collected_at'],
    out, ['cabinet', 'platform', 'date', 'campaign_id'],
    ['views', 'clicks', 'ctr', 'avg_bid', 'orders', 'orders_money', 'collected_at',
     'spend = GREATEST(COALESCE(ad_stats_daily.spend, 0), EXCLUDED.spend)']);
  console.log(`[SheetStats:${cabinet}] ${saved} (из Google-таблицы)`);
  return { rows: saved };
}

// Товары мультитоварных кампаний ("Оплата за заказ: выбранные товары" и
// подобные — см. комментарий у ad_campaign_skus в postgres/init.sql).
// sku='0' — служебная отметка Apps Script'а "кампанию проверили, товаров
// нет/Ozon не отдал" (см. google-apps-script/ozon-sheet-sync.gs), её тоже
// сохраняем как есть — нужна backend'у, чтобы не запрашивать эту кампанию
// повторно (хотя сам backend сейчас это не перезапрашивает, т.к. список
// товаров кампаний в фоллбек-режиме собирает только Apps Script).
async function syncCampaignSkusFromSheet(cabinet) {
  const rows = await fetchSheetRows('CampaignSkus');
  if (rows === null) return { rows: 0 };
  const filtered = rows.filter(r => r.cabinet === cabinet && r.campaign_id && r.sku !== '' && r.sku !== undefined);
  const out = filtered.map(r => [cabinet, 'ozon', r.campaign_id, num(r.sku), new Date()]);
  const saved = await bulkUpsert('ad_campaign_skus',
    ['cabinet', 'platform', 'campaign_id', 'sku', 'updated_at'],
    out, ['cabinet', 'platform', 'campaign_id', 'sku']);
  console.log(`[SheetCampaignSkus:${cabinet}] ${saved} (из Google-таблицы)`);
  return { rows: saved };
}

// ── Точные рекламные данные по товарам (см. google-apps-script) ──────────
async function syncSkuStatsFromSheet(cabinet) {
  const rows = await fetchSheetRows('SkuStats');
  if (rows === null) return { rows: 0 };
  const out = rows.filter(r => r.cabinet === cabinet && r.sku && /^\d{4}-\d{2}-\d{2}$/.test(r.date))
    .map(r => [cabinet, 'ozon', r.date, r.campaign_id || '', num(r.sku), num(r.views), num(r.clicks), num(r.to_cart),
      num(r.orders), num(r.sales), num(r.expense), num(r.avg_cpc), new Date()]);
  const saved = await bulkUpsert('ad_sku_stats_daily',
    ['cabinet', 'platform', 'date', 'campaign_id', 'sku', 'views', 'clicks', 'to_cart', 'orders', 'sales', 'expense', 'avg_cpc', 'updated_at'],
    out, ['cabinet', 'platform', 'date', 'campaign_id', 'sku']);
  return { rows: saved };
}

async function syncCpoOrdersFromSheet(cabinet) {
  const rows = await fetchSheetRows('CpoOrders');
  if (rows === null) return { rows: 0 };
  // Колонки дня заказа могло ещё не быть (таблица создана раньше).
  await query(`ALTER TABLE ad_cpo_orders ADD COLUMN IF NOT EXISTS order_date DATE`).catch(() => {});
  await query(`ALTER TABLE ad_cpo_orders ADD COLUMN IF NOT EXISTS order_number VARCHAR(64)`).catch(() => {});
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const out = rows.filter(r => r.cabinet === cabinet && isDate(r.date) && (r.sku || r.promoted_sku))
    .map(r => [cabinet, 'ozon', r.date, String(r.order_id || ''), String(r.sku || ''), String(r.promoted_sku || ''),
      r.offer_id || null, num(r.quantity) || 1, num(r.cost), num(r.expense),
      isDate(r.order_date) ? r.order_date : null, r.order_number || null, new Date()]);
  const saved = await bulkUpsert('ad_cpo_orders',
    ['cabinet', 'platform', 'date', 'order_id', 'sku', 'promoted_sku', 'offer_id', 'quantity', 'cost', 'expense', 'order_date', 'order_number', 'updated_at'],
    out, ['cabinet', 'platform', 'order_id', 'sku', 'promoted_sku', 'date']);
  return { rows: saved };
}

// Запись в журнал (ad_events) при реальном изменении — кто бы ни менял:
// продавец в личном кабинете или автостратегия Ozon.
async function addAutoEvent(cabinet, offerId, kind, text, oldValue, newValue) {
  await query(
    `INSERT INTO ad_events (cabinet, platform, offer_id, date, kind, text, old_value, new_value, auto)
     VALUES ($1, 'ozon', $2, (NOW() AT TIME ZONE 'Europe/Moscow')::date, $3, $4, $5, $6, true)`,
    [cabinet, offerId, kind, text, oldValue === null || oldValue === undefined ? null : String(oldValue), newValue === null || newValue === undefined ? null : String(newValue)]);
}
const fmtRub = v => `${Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;

async function syncCpoProductsFromSheet(cabinet) {
  const rows = await fetchSheetRows('CpoProducts');
  if (rows === null) return { rows: 0 };
  const list = rows.filter(r => r.cabinet === cabinet && r.sku);
  if (!list.length) return { rows: 0 };
  const prev = await query(`SELECT sku, offer_id, enabled, bid_pct FROM ad_cpo_products WHERE cabinet = $1 AND platform = 'ozon'`, [cabinet]);
  const prevBySku = new Map(prev.map(r => [String(r.sku), r]));
  const catalog = await query(`SELECT sku, offer_id FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon' AND sku IS NOT NULL`, [cabinet]);
  const offerBySku = new Map(catalog.map(r => [String(r.sku), r.offer_id]));
  const out = [];
  for (const r of list) {
    const enabled = String(r.enabled) === '1' || String(r.enabled).toLowerCase() === 'true';
    const bidPct = r.bid_pct === '' ? null : num(r.bid_pct);
    const offerId = offerBySku.get(String(r.sku)) || r.offer_id || null;
    out.push([cabinet, 'ozon', num(r.sku), offerId, enabled, String(r.available) !== '0', bidPct, r.bid_rub === '' ? null : num(r.bid_rub), new Date()]);
    const p = prevBySku.get(String(r.sku));
    if (p && offerId) {
      if (p.enabled !== enabled) {
        await addAutoEvent(cabinet, offerId, enabled ? 'cpo_on' : 'cpo_off', enabled ? 'Оплата за заказ включена' : 'Оплата за заказ выключена', p.enabled, enabled);
      } else if (enabled && bidPct !== null && p.bid_pct !== null && Math.abs(Number(p.bid_pct) - bidPct) >= 0.01) {
        await addAutoEvent(cabinet, offerId, 'bid_cpo', `Ставка за заказ ${Number(p.bid_pct)}% → ${bidPct}%`, p.bid_pct, bidPct);
      }
    }
  }
  const saved = await bulkUpsert('ad_cpo_products',
    ['cabinet', 'platform', 'sku', 'offer_id', 'enabled', 'available', 'bid_pct', 'bid_rub', 'checked_at'],
    out, ['cabinet', 'platform', 'sku']);
  return { rows: saved };
}

// Ставка за клик в Performance API приходит в миллионных долях рубля
// (15000000 = 15 ₽) — переводим в рубли, если число явно такое.
const bidToRub = v => { const n = num(v); return n > 10000 ? n / 1e6 : n; };

async function syncCpcBidsFromSheet(cabinet) {
  const rows = await fetchSheetRows('CpcBids');
  if (rows === null) return { rows: 0 };
  const list = rows.filter(r => r.cabinet === cabinet && r.sku && r.campaign_id);
  if (!list.length) return { rows: 0 };
  const prev = await query(`SELECT campaign_id, sku, bid FROM ad_cpc_bids WHERE cabinet = $1 AND platform = 'ozon'`, [cabinet]);
  const prevByKey = new Map(prev.map(r => [`${r.campaign_id}|${r.sku}`, r]));
  const catalog = await query(`SELECT sku, offer_id FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon' AND sku IS NOT NULL`, [cabinet]);
  const offerBySku = new Map(catalog.map(r => [String(r.sku), r.offer_id]));
  const out = [];
  for (const r of list) {
    const bid = bidToRub(r.bid);
    out.push([cabinet, 'ozon', String(r.campaign_id), num(r.sku), bid, new Date()]);
    const p = prevByKey.get(`${r.campaign_id}|${num(r.sku)}`);
    const offerId = offerBySku.get(String(r.sku));
    if (p && offerId && p.bid !== null && Math.abs(Number(p.bid) - bid) >= 0.01) {
      await addAutoEvent(cabinet, offerId, 'bid_cpc', `Ставка за клик ${fmtRub(p.bid)} → ${fmtRub(bid)} (РК ${r.campaign_id})`, p.bid, bid);
    }
  }
  const saved = await bulkUpsert('ad_cpc_bids', ['cabinet', 'platform', 'campaign_id', 'sku', 'bid', 'checked_at'],
    out, ['cabinet', 'platform', 'campaign_id', 'sku']);
  return { rows: saved };
}

// География заказов (вкладка GeoOrders): день × артикул × регион × город.
let geoTableReady = false;
async function syncGeoFromSheet(cabinet) {
  if (!geoTableReady) {
    await query(`CREATE TABLE IF NOT EXISTS sales_geo_daily (
      cabinet VARCHAR(32) NOT NULL, date DATE NOT NULL, offer_id VARCHAR(128) NOT NULL, sku BIGINT,
      region VARCHAR(128) NOT NULL, city VARCHAR(128) NOT NULL DEFAULT '', qty INT DEFAULT 0, revenue DECIMAL(14,2) DEFAULT 0,
      cancelled INT DEFAULT 0, updated_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (cabinet, date, offer_id, region, city))`);
    geoTableReady = true;
  }
  const rows = await fetchSheetRows('GeoOrders');
  if (rows === null) return { rows: 0 };
  // Регион Ozon в списках отправлений почти всегда пустой — тогда берём
  // кластер доставки. Таблица хранит полные данные за свои 45 дней, поэтому
  // диапазон дат из неё заменяем целиком (без дублей и «хвостов» после отмен).
  const map = new Map();
  for (const r of rows) {
    if (r.cabinet !== cabinet || !r.offer_id || !r.date) continue;
    // Только кластер доставки (регион/город Ozon отдаёт не всегда).
    const region = (String(r.cluster || '').trim() || 'Кластер не указан').slice(0, 128);
    const city = '';
    const date = String(r.date).slice(0, 10);
    const k = [date, r.offer_id, region, city].join('|');
    const cur = map.get(k) || [cabinet, date, r.offer_id, r.sku ? num(r.sku) || null : null, region, city, 0, 0, 0, new Date()];
    cur[6] += Math.round(num(r.qty)); cur[7] += num(r.revenue); cur[8] += Math.round(num(r.cancelled));
    map.set(k, cur);
  }
  const out = [...map.values()];
  if (!out.length) return { rows: 0 };
  const dates = out.map(r => r[1]).sort();
  await query(`DELETE FROM sales_geo_daily WHERE cabinet = $1 AND date BETWEEN $2 AND $3`, [cabinet, dates[0], dates[dates.length - 1]]);
  const saved = await bulkUpsert('sales_geo_daily', ['cabinet', 'date', 'offer_id', 'sku', 'region', 'city', 'qty', 'revenue', 'cancelled', 'updated_at'],
    out, ['cabinet', 'date', 'offer_id', 'region', 'city']);
  return { rows: saved };
}

// ── Выкуп, цены/комиссии и финансы (для «% выкупа», юнит-экономики и P&L) ──
let finTablesReady = false;
async function ensureFinTables() {
  if (finTablesReady) return;
  await query(`CREATE TABLE IF NOT EXISTS buyout_daily (cabinet VARCHAR(32) NOT NULL, date DATE NOT NULL, offer_id VARCHAR(128) NOT NULL, sku BIGINT,
    ordered INT DEFAULT 0, delivered INT DEFAULT 0, cancelled INT DEFAULT 0, in_progress INT DEFAULT 0, PRIMARY KEY (cabinet, date, offer_id))`);
  await query(`CREATE TABLE IF NOT EXISTS product_prices (cabinet VARCHAR(32) NOT NULL, offer_id VARCHAR(128) NOT NULL, product_id BIGINT,
    price DECIMAL(12,2), seller_price DECIMAL(12,2), acquiring DECIMAL(12,2), pct_fbo DECIMAL(6,2), pct_fbs DECIMAL(6,2),
    fbo_deliv DECIMAL(12,2), fbo_direct_max DECIMAL(12,2), fbo_return DECIMAL(12,2), fbs_deliv DECIMAL(12,2), fbs_direct_max DECIMAL(12,2), fbs_return DECIMAL(12,2),
    checked_at TIMESTAMP, PRIMARY KEY (cabinet, offer_id))`);
  await query(`CREATE TABLE IF NOT EXISTS finance_daily (cabinet VARCHAR(32) NOT NULL, date DATE NOT NULL, sku VARCHAR(32) NOT NULL DEFAULT '',
    name VARCHAR(160) NOT NULL, amount DECIMAL(14,2) DEFAULT 0, qty DECIMAL(10,2) DEFAULT 0, PRIMARY KEY (cabinet, date, sku, name))`);
  finTablesReady = true;
}
// Заменяем в базе весь диапазон дат, который есть в таблице (там полные данные).
async function replaceRange(table, cabinet, rows, columns, conflict) {
  if (!rows.length) return 0;
  const dates = rows.map(r => r[1]).sort();
  await query(`DELETE FROM ${table} WHERE cabinet = $1 AND date BETWEEN $2 AND $3`, [cabinet, dates[0], dates[dates.length - 1]]);
  return bulkUpsert(table, columns, rows, conflict);
}
const lastHeavy = new Map();
async function syncFinanceFromSheet(cabinet) {
  // Тяжёлые вкладки — не чаще раза в час.
  const k = 'fin:' + cabinet;
  if (Date.now() - (lastHeavy.get(k) || 0) < 55 * 60000) return { rows: 0 };
  await ensureFinTables();
  let total = 0;
  const buy = await fetchSheetRows('Buyout');
  if (buy) {
    const out = buy.filter(r => r.cabinet === cabinet && r.offer_id && r.date).map(r => [cabinet, String(r.date).slice(0, 10), r.offer_id,
      r.sku ? num(r.sku) || null : null, Math.round(num(r.ordered)), Math.round(num(r.delivered)), Math.round(num(r.cancelled)), Math.round(num(r.in_progress))]);
    total += await replaceRange('buyout_daily', cabinet, out, ['cabinet', 'date', 'offer_id', 'sku', 'ordered', 'delivered', 'cancelled', 'in_progress'], ['cabinet', 'date', 'offer_id']);
  }
  const pr = await fetchSheetRows('Prices');
  if (pr) {
    const out = pr.filter(r => r.cabinet === cabinet && r.offer_id).map(r => [cabinet, r.offer_id, r.product_id ? num(r.product_id) || null : null,
      num(r.price), num(r.seller_price), num(r.acquiring), num(r.pct_fbo), num(r.pct_fbs), num(r.fbo_deliv), num(r.fbo_direct_max), num(r.fbo_return),
      num(r.fbs_deliv), num(r.fbs_direct_max), num(r.fbs_return), r.checked_at ? new Date(r.checked_at) : new Date()]);
    total += await bulkUpsert('product_prices', ['cabinet', 'offer_id', 'product_id', 'price', 'seller_price', 'acquiring', 'pct_fbo', 'pct_fbs',
      'fbo_deliv', 'fbo_direct_max', 'fbo_return', 'fbs_deliv', 'fbs_direct_max', 'fbs_return', 'checked_at'], out, ['cabinet', 'offer_id']);
  }
  const fin = await fetchSheetRows('Finance');
  if (fin) {
    const map = new Map();
    for (const r of fin) {
      if (r.cabinet !== cabinet || !r.date || !r.name) continue;
      const row = [cabinet, String(r.date).slice(0, 10), String(r.sku || ''), String(r.name).slice(0, 160), num(r.amount), num(r.qty)];
      const key = row.slice(1, 4).join('|');
      const cur = map.get(key);
      if (cur) { cur[4] += row[4]; cur[5] += row[5]; } else map.set(key, row);
    }
    total += await replaceRange('finance_daily', cabinet, [...map.values()], ['cabinet', 'date', 'sku', 'name', 'amount', 'qty'], ['cabinet', 'date', 'sku', 'name']);
  }
  lastHeavy.set(k, Date.now());
  return { rows: total };
}

async function syncAdDetailsFromSheet(cabinet) {
  const parts = await Promise.allSettled([
    syncSkuStatsFromSheet(cabinet), syncCpoOrdersFromSheet(cabinet),
    syncCpoProductsFromSheet(cabinet), syncCpcBidsFromSheet(cabinet), syncGeoFromSheet(cabinet), syncFinanceFromSheet(cabinet),
  ]);
  let rows = 0;
  const errors = [];
  parts.forEach((p, i) => {
    if (p.status === 'fulfilled') rows += p.value?.rows || 0;
    else errors.push(`${['SkuStats', 'CpoOrders', 'CpoProducts', 'CpcBids', 'GeoOrders', 'Buyout/Prices/Finance'][i]}: ${p.reason?.message || p.reason}`);
  });
  if (errors.length) console.warn(`[SheetAdDetails:${cabinet}]`, errors.join('; '));
  return { rows, warning: errors.length ? errors.join('; ').slice(0, 300) : null };
}

// Разовая чистка 09.10.2026: до проверки обязательных колонок (см.
// REQUIRED_COLUMNS) сбор в 10:40 UTC прочитал вкладку Analytics вместо ещё не
// созданных SkuStats/CpoOrders/CpoProducts — всё, что попало в эти таблицы до
// 10:50 UTC, мусор (настоящие данные появятся только после обновления
// Google-скрипта). Безопасно запускать при каждом старте.
async function cleanupSheetJunk() {
  const cutoff = '2026-10-09 10:50:00';
  for (const [table, col] of [['ad_sku_stats_daily', 'updated_at'], ['ad_cpo_orders', 'updated_at'], ['ad_cpo_products', 'checked_at'], ['ad_cpc_bids', 'checked_at']]) {
    try {
      const r = await query(`DELETE FROM ${table} WHERE ${col} < $1 RETURNING 1`, [cutoff]);
      if (r.length) console.log(`[Cleanup] ${table}: удалено ${r.length} ошибочных строк`);
    } catch (e) { /* таблицы может не быть — не страшно */ }
  }
}

module.exports = {
  syncGeoFromSheet,
  syncFinanceFromSheet,
  ensureFinTables,
  cleanupSheetJunk,
  sheetId,
  fetchSheetRows,
  syncCatalogFromSheet,
  syncAnalyticsFromSheet,
  syncStocksFromSheet,
  syncCampaignsFromSheet,
  syncStatsFromSheet,
  syncCampaignSkusFromSheet,
  syncAdDetailsFromSheet,
};
