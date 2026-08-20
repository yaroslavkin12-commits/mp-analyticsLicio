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

// Запрашиваем одну метрику — возвращает Map("sku|date" -> value) или null
async function fetchOne(dateFrom, dateTo, metricName) {
  const result = new Map();
  let offset = 0;

  while (true) {
    await delay(600);
    let resp;
    try {
      resp = await axios.post('https://api-seller.ozon.ru/v1/analytics/data', {
        date_from: dateFrom,
        date_to:   dateTo,
        metrics:   [metricName],
        dimension: ['sku', 'day'],
        sort:      [{ key: metricName, order: 'DESC' }],
        limit:     1000,
        offset,
      }, { headers: headers(), timeout: 60000 });
    } catch(e) {
      const code = e.response?.data?.code;
      const msg  = e.response?.data?.message || e.message;
      if (code === 3) {
        console.log(`[Ozon] Метрика "${metricName}" устарела — пропускаем`);
      } else if (code === 8) {
        console.log(`[Ozon] Rate limit — ждём 5 сек...`);
        await delay(5000);
        continue; // повтор
      } else {
        console.warn(`[Ozon] Ошибка "${metricName}": ${msg}`);
      }
      return null;
    }

    const rows = resp.data?.result?.data || [];
    for (const row of rows) {
      const dims    = row.dimensions || [];
      const skuDim  = dims.find(d => d.id && /^\d{5,}$/.test(String(d.id)));
      const dateDim = dims.find(d => d.id && /^\d{4}-\d{2}-\d{2}$/.test(String(d.id)));
      const sku  = skuDim?.id  || dims[0]?.id;
      const date = dateDim?.id || dims[1]?.id;
      if (!sku || !date) continue;
      result.set(`${sku}|${date}`, { sku, date, value: Number(row.metrics?.[0]) || 0 });
    }

    console.log(`[Ozon] "${metricName}": ${rows.length} строк (offset ${offset})`);
    if (rows.length < 1000) break;
    offset += 1000;
  }

  return result;
}

async function collectAnalytics(dateFrom) {
  if (!process.env.OZON_CLIENT_ID) throw new Error('OZON credentials не заданы');

  const from = dateFrom || dayjs().subtract(30, 'day').format('YYYY-MM-DD');
  const to   = dayjs().format('YYYY-MM-DD');
  console.log(`[Ozon Analytics] Сбор ${from} -> ${to}`);

  // Список метрик которые пробуем
  const METRICS = [
    'hits_view',
    'hits_view_pdp',
    'hits_tocart',
    'orders_item',
    'revenue',
    'delivered_units',
    'returns',
    'cancellations',
  ];

  // Собираем данные по каждой метрике отдельно
  const data = {}; // metricName -> Map(key -> {sku, date, value})
  for (const m of METRICS) {
    const result = await fetchOne(from, to, m);
    if (result !== null && result.size > 0) {
      data[m] = result;
      console.log(`[Ozon] "${m}" — получено ${result.size} записей ✅`);
    }
  }

  // Собираем все уникальные ключи sku|date
  const allKeys = new Set();
  for (const map of Object.values(data)) {
    for (const k of map.keys()) allKeys.add(k);
  }

  console.log(`[Ozon Analytics] Уникальных sku+день: ${allKeys.size}`);
  if (allKeys.size === 0) {
    console.log('[Ozon Analytics] Нет данных');
    return 0;
  }

  // Очищаем СТАРЫЕ данные за период (включая некорректные)
  try {
    await query(`DELETE FROM ozon_analytics WHERE date >= $1 AND date <= $2`, [from, to]);
    console.log('[Ozon Analytics] Старые данные очищены');
  } catch(e) {
    console.warn('[Ozon Analytics] Очистка:', e.message);
  }

  const get = (metric, key) => data[metric]?.get(key)?.value || 0;

  let total = 0;
  for (const key of allKeys) {
    const parts = key.split('|');
    const sku   = parts[0];
    const date  = parts[1];

    const hits_view       = get('hits_view',       key);
    const hits_view_pdp   = get('hits_view_pdp',   key);
    const hits_tocart     = get('hits_tocart',      key);
    const orders_item     = get('orders_item',      key);
    const revenue         = get('revenue',          key);
    const delivered_units = get('delivered_units',  key);
    const returns         = get('returns',          key);
    const cancellations   = get('cancellations',    key);

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
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (date, sku) DO UPDATE SET
           hits_view=EXCLUDED.hits_view,
           hits_view_pdp=EXCLUDED.hits_view_pdp,
           hits_tocart=EXCLUDED.hits_tocart,
           orders_item=EXCLUDED.orders_item,
           revenue=EXCLUDED.revenue,
           delivered_units=EXCLUDED.delivered_units,
           returns=EXCLUDED.returns,
           cancellations=EXCLUDED.cancellations,
           ctr=EXCLUDED.ctr, cr_to_cart=EXCLUDED.cr_to_cart,
           cr_to_order=EXCLUDED.cr_to_order,
           redemption_rate=EXCLUDED.redemption_rate`,
        [date, sku,
         hits_view, 0, hits_view_pdp,
         hits_tocart, 0, 0,
         orders_item, revenue, delivered_units, returns, cancellations,
         ctr, cr_to_cart, cr_to_order, redemption_rate]
      );
      total++;
    } catch(e) { /* skip */ }
  }

  // Подтягиваем названия товаров из заказов
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
