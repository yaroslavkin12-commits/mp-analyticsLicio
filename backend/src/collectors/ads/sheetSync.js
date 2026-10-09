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
  for (const r of filtered) {
    if (!r.title) continue;
    const t = String(r.title).trim().toLowerCase();
    const match = offerIds.find(o => t.includes(o));
    if (match) {
      await query(
        `UPDATE ad_campaigns SET matched_offer_id = COALESCE(matched_offer_id, $3) WHERE cabinet = $1 AND platform = 'ozon' AND campaign_id = $2`,
        [cabinet, r.campaign_id, match]);
    }
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
  const out = rows.filter(r => r.cabinet === cabinet && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && (r.sku || r.promoted_sku))
    .map(r => [cabinet, 'ozon', r.date, String(r.order_id || ''), String(r.sku || ''), String(r.promoted_sku || ''),
      r.offer_id || null, num(r.quantity) || 1, num(r.cost), num(r.expense), new Date()]);
  const saved = await bulkUpsert('ad_cpo_orders',
    ['cabinet', 'platform', 'date', 'order_id', 'sku', 'promoted_sku', 'offer_id', 'quantity', 'cost', 'expense', 'updated_at'],
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

async function syncAdDetailsFromSheet(cabinet) {
  const parts = await Promise.allSettled([
    syncSkuStatsFromSheet(cabinet), syncCpoOrdersFromSheet(cabinet),
    syncCpoProductsFromSheet(cabinet), syncCpcBidsFromSheet(cabinet),
  ]);
  let rows = 0;
  const errors = [];
  parts.forEach((p, i) => {
    if (p.status === 'fulfilled') rows += p.value?.rows || 0;
    else errors.push(`${['SkuStats', 'CpoOrders', 'CpoProducts', 'CpcBids'][i]}: ${p.reason?.message || p.reason}`);
  });
  if (errors.length) console.warn(`[SheetAdDetails:${cabinet}]`, errors.join('; '));
  return { rows, warning: errors.length ? errors.join('; ').slice(0, 300) : null };
}

module.exports = {
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
