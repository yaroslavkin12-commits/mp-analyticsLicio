const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('../../db');

function headers() {
  return {
    'Client-Id': process.env.OZON_CLIENT_ID,
    'Api-Key': process.env.OZON_API_KEY,
    'Content-Type': 'application/json',
  };
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// Один запрос — возвращает Map: "sku|date" -> { sku, date, values: {} }
async function fetchMetrics(dateFrom, dateTo, metrics) {
  const result = new Map();
  let offset = 0;

  while (true) {
    let resp;
    try {
      await delay(600); // rate limit: max 2 req/sec
      resp = await axios.post('https://api-seller.ozon.ru/v1/analytics/data', {
        date_from: dateFrom,
        date_to:   dateTo,
        metrics,
        dimension: ['sku', 'day'],
        sort: [{ key: metrics[0], order: 'DESC' }],
        limit: 1000,
        offset,
      }, { headers: headers(), timeout: 90000 });
    } catch(e) {
      console.error('[Ozon Analytics] Ошибка запроса:', e.response?.data || e.message);
      break;
    }

    const rows = resp.data?.result?.data || [];
    console.log(`[Ozon Analytics] [${metrics[0]}...] получено ${rows.length} строк`);

    for (const row of rows) {
      const dims    = row.dimensions || [];
      const skuDim  = dims.find(d => d.id && /^\d{5,}$/.test(String(d.id)));
      const dateDim = dims.find(d => d.id && /^\d{4}-\d{2}-\d{2}$/.test(String(d.id)));
      const sku     = skuDim?.id  || dims[0]?.id;
      const date    = dateDim?.id || dims[1]?.id;
      if (!sku || !date) continue;

      const key     = `${sku}|${date}`;
      const vals    = (row.metrics || []).map(v => Number(v) || 0);
      const entry   = result.get(key) || { sku, date, values: {} };

      // Сохраняем по имени метрики
      metrics.forEach((name, i) => { entry.values[name] = vals[i] || 0; });
      result.set(key, entry);
    }

    if (rows.length < 1000) break;
    offset += 1000;
  }

  return result;
}

async function collectAnalytics(dateFrom) {
  if (!process.env.OZON_CLIENT_ID) throw new Error('OZON credentials не заданы');

  const from = dateFrom || dayjs().subtract(30, 'day').format('YYYY-MM-DD');
  const to   = dayjs().format('YYYY-MM-DD');
  console.log(`[Ozon Analytics] Сбор ${from} -> ${to}...`);

  // Запрос 1: метрики показов (только актуальные, без deprecated)
  const g1 = await fetchMetrics(from, to, ['hits_view', 'hits_view_pdp', 'hits_tocart']);

  await delay(1000);

  // Запрос 2: метрики продаж
  const g2 = await fetchMetrics(from, to, ['orders_item', 'revenue', 'delivered_units', 'returns', 'cancellations']);

  const allKeys = new Set([...g1.keys(), ...g2.keys()]);
  console.log(`[Ozon Analytics] Уникальных записей sku+день: ${allKeys.size}`);

  // Сбрасываем старые данные за этот период перед записью
  try {
    await query(`DELETE FROM ozon_analytics WHERE date BETWEEN ? AND ?`, [from, to]);
    console.log(`[Ozon Analytics] Старые данные очищены`);
  } catch(e) {
    console.warn('[Ozon Analytics] Очистка:', e.message);
  }

  let total = 0;

  for (const key of allKeys) {
    const e1 = g1.get(key);
    const e2 = g2.get(key);
    const sku  = (e1 || e2).sku;
    const date = (e1 || e2).date;

    const v1 = e1?.values || {};
    const v2 = e2?.values || {};

    const hits_view       = v1.hits_view       || 0;
    const hits_view_pdp   = v1.hits_view_pdp   || 0;
    const hits_tocart     = v1.hits_tocart      || 0;
    const orders_item     = v2.orders_item      || 0;
    const revenue         = v2.revenue          || 0;
    const delivered_units = v2.delivered_units  || 0;
    const returns         = v2.returns          || 0;
    const cancellations   = v2.cancellations    || 0;

    const ctr             = hits_view   > 0 ? hits_view_pdp  / hits_view   : 0;
    const cr_to_cart      = hits_view   > 0 ? hits_tocart    / hits_view   : 0;
    const cr_to_order     = hits_view   > 0 ? orders_item    / hits_view   : 0;
    const redemption_rate = orders_item > 0 ? delivered_units / orders_item : 0;

    try {
      await query(
        `INSERT INTO ozon_analytics
          (date, sku, hits_view, hits_view_search, hits_view_pdp,
           hits_tocart, hits_tocart_search, hits_tocart_pdp,
           orders_item, revenue, delivered_units, returns, cancellations,
           ctr, cr_to_cart, cr_to_order, redemption_rate)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (date, sku) DO UPDATE SET
           hits_view=EXCLUDED.hits_view,
           hits_view_pdp=EXCLUDED.hits_view_pdp,
           hits_tocart=EXCLUDED.hits_tocart,
           orders_item=EXCLUDED.orders_item,
           revenue=EXCLUDED.revenue,
           delivered_units=EXCLUDED.delivered_units,
           returns=EXCLUDED.returns,
           cancellations=EXCLUDED.cancellations,
           ctr=EXCLUDED.ctr,
           cr_to_cart=EXCLUDED.cr_to_cart,
           cr_to_order=EXCLUDED.cr_to_order,
           redemption_rate=EXCLUDED.redemption_rate`,
        [date, sku,
         hits_view, 0, hits_view_pdp,
         hits_tocart, 0, 0,
         orders_item, revenue, delivered_units, returns, cancellations,
         ctr, cr_to_cart, cr_to_order, redemption_rate]
      );
      total++;
    } catch(e) {}
  }

  // Подтягиваем названия товаров
  try {
    await query(`
      UPDATE ozon_analytics oa
      SET offer_id = oo.offer_id, product_name = oo.product_name
      FROM (
        SELECT DISTINCT ON (sku) sku, offer_id, product_name
        FROM ozon_orders WHERE offer_id IS NOT NULL
        ORDER BY sku, date DESC
      ) oo
      WHERE oa.sku = oo.sku AND oa.offer_id IS NULL
    `);
  } catch(e) {}

  console.log(`[Ozon Analytics] Итого сохранено: ${total}`);
  return total;
}

module.exports = { collectAnalytics };
