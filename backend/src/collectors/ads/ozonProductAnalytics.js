const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('../../db');
const { getCabinet } = require('../../config/cabinets');

const delay = ms => new Promise(r => setTimeout(r, ms));

// Аналитика по товару (Seller API, /v1/analytics/data) — показы, переходы в
// корзину, заказы и средняя позиция в поисковой выдаче/категории по SKU по
// дням. Часть метрик Ozon периодически убирает без предупреждения (см.
// комментарий в collectors/ozon/analytics.js — код 3 в ответе значит
// "метрика больше не поддерживается"), поэтому каждую метрику запрашиваем
// отдельно и просто пропускаем те, что отвалились, вместо падения сборщика
// целиком.
async function fetchMetric(headers, dateFrom, dateTo, metricName) {
  const result = new Map();
  let offset = 0;
  while (true) {
    await delay(700);
    let resp;
    let rateLimitRetries = 0;
    while (true) {
      try {
        resp = await axios.post('https://api-seller.ozon.ru/v1/analytics/data', {
          date_from: dateFrom,
          date_to: dateTo,
          metrics: [metricName],
          dimension: ['sku', 'day'],
          limit: 1000,
          offset,
        }, { headers, timeout: 60000 });
        break;
      } catch(e) {
        const code = e.response?.data?.code;
        const status = e.response?.status;
        // code 3 = метрика больше не поддерживается Ozon — пропускаем сразу,
        // без ретраев, это не временная ошибка.
        if (code === 3) {
          console.log(`[Ads Analytics] Метрика "${metricName}" недоступна — пропускаем`);
          return null;
        }
        // code 8 / HTTP 429 = превышен лимит запросов в секунду — это
        // временно, поэтому ждём и повторяем (с нарастающей паузой), а не
        // сдаёмся сразу, как раньше (из-за чего вся метрика молча терялась).
        if ((code === 8 || status === 429) && rateLimitRetries < 5) {
          rateLimitRetries++;
          const wait = 1500 * rateLimitRetries;
          console.warn(`[Ads Analytics] "${metricName}": лимит запросов (429), retry ${rateLimitRetries}/5 через ${wait}мс`);
          await delay(wait);
          continue;
        }
        console.warn(`[Ads Analytics] "${metricName}":`, e.response?.data?.message || e.message);
        return null;
      }
    }
    const rows = resp.data?.result?.data || [];
    for (const row of rows) {
      const dims = row.dimensions || [];
      const skuDim = dims.find(d => d.id && /^\d{5,}$/.test(String(d.id)));
      const dateDim = dims.find(d => d.id && /^\d{4}-\d{2}-\d{2}$/.test(String(d.id)));
      const sku = skuDim?.id || dims[0]?.id;
      const date = dateDim?.id || dims[1]?.id;
      if (!sku || !date) continue;
      const key = `${sku}|${date}`;
      const entry = result.get(key) || { sku, date };
      entry[metricName] = Number((row.metrics || [])[0]) || 0;
      result.set(key, entry);
    }
    if (rows.length < 1000) break;
    offset += 1000;
  }
  return result;
}

async function collectProductAnalytics(cabinet, days) {
  const cfg = getCabinet(cabinet);
  if (!cfg.ozonClientId || !cfg.ozonApiKey) {
    console.log(`[Ads Analytics:${cabinet}] Ozon Seller API не настроен`);
    return 0;
  }
  const headers = { 'Client-Id': cfg.ozonClientId, 'Api-Key': cfg.ozonApiKey, 'Content-Type': 'application/json' };
  const from = dayjs().subtract(days || 30, 'day').format('YYYY-MM-DD');
  const to = dayjs().format('YYYY-MM-DD');

  const METRICS = ['hits_view', 'hits_view_search', 'hits_view_pdp', 'hits_tocart', 'orders_item', 'revenue', 'position_category'];
  const collected = {};
  for (const m of METRICS) {
    const data = await fetchMetric(headers, from, to, m);
    if (data !== null) collected[m] = data;
  }

  const allKeys = new Set();
  for (const map of Object.values(collected)) for (const k of map.keys()) allKeys.add(k);
  if (!allKeys.size) { console.log(`[Ads Analytics:${cabinet}] Нет данных`); return 0; }

  const catalogRows = await query(
    `SELECT sku, offer_id FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon' AND sku IS NOT NULL`,
    [cabinet]
  );
  const offerBySku = new Map(catalogRows.map(r => [String(r.sku), r.offer_id]));

  let total = 0;
  for (const key of allKeys) {
    const [sku, date] = key.split('|');
    const get = (m) => collected[m] ? (collected[m].get(key)?.[m] || 0) : 0;
    try {
      await query(
        `INSERT INTO product_analytics_daily
          (cabinet, platform, date, sku, offer_id, hits_view, hits_view_search, hits_view_pdp,
           hits_tocart, orders_item, revenue, position_category)
         VALUES ($1,'ozon',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (cabinet, platform, date, sku) DO UPDATE SET
           offer_id=EXCLUDED.offer_id, hits_view=EXCLUDED.hits_view, hits_view_search=EXCLUDED.hits_view_search,
           hits_view_pdp=EXCLUDED.hits_view_pdp, hits_tocart=EXCLUDED.hits_tocart, orders_item=EXCLUDED.orders_item,
           revenue=EXCLUDED.revenue, position_category=EXCLUDED.position_category`,
        [cabinet, date, sku, offerBySku.get(String(sku)) || null,
         get('hits_view'), get('hits_view_search'), get('hits_view_pdp'),
         get('hits_tocart'), get('orders_item'), get('revenue'),
         collected.position_category ? (collected.position_category.get(key)?.position_category ?? null) : null]
      );
      total++;
    } catch(e) { /* skip */ }
  }
  console.log(`[Ads Analytics:${cabinet}] Сохранено: ${total}`);
  return total;
}

module.exports = { collectProductAnalytics };
