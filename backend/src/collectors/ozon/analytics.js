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

// Пробуем получить одну метрику — возвращает Map или null если deprecated
async function fetchSingleMetric(dateFrom, dateTo, metricName) {
  const result = new Map();
  let offset = 0;
  let hasError = false;

  while (true) {
    await delay(700);
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
      if (code === 3) {
        console.log(`[Ozon Analytics] Метрика "${metricName}" устарела — пропускаем`);
      } else {
        console.warn(`[Ozon Analytics] Ошибка "${metricName}":`, e.response?.data?.message || e.message);
      }
      hasError = true;
      break;
    }

    const rows = resp.data?.result?.data || [];
    console.log(`[Ozon Analytics] "${metricName}": получено ${rows.length} строк (offset ${offset})`);

    for (const row of rows) {
      const dims    = row.dimensions || [];
      const skuDim  = dims.find(d => d.id && /^\d{5,}$/.test(String(d.id)));
      const dateDim = dims.find(d => d.id && /^\d{4}-\d{2}-\d{2}$/.test(String(d.id)));
      const sku     = skuDim?.id  || dims[0]?.id;
      const date    = dateDim?.id || dims[1]?.id;
      if (!sku || !date) continue;

      const key   = `${sku}|${date}`;
      const entry = result.get(key) || { sku, date };
      entry[metricName] = Number((row.metrics || [])[0]) || 0;
      result.set(key, entry);
    }

    if (rows.length < 1000) break;
    offset += 1000;
  }

  return hasError ? null : result;
}

async function collectAnalytics(dateFrom) {
  if (!process.env.OZON_CLIENT_ID) throw new Error('OZON credentials не заданы');

  const from = dateFrom || dayjs().subtract(30, 'day').format('YYYY-MM-DD');
  const to   = dayjs().format('YYYY-MM-DD');
  console.log(`[Ozon Analytics] Сбор ${from} -> ${to}...`);

  // Пробуем все нужные метрики по одной
  const METRICS_TO_TRY = [
    'hits_view',
    'hits_view_pdp',
    'hits_tocart',
    'orders_item',
    'revenue',
    'delivered_units',
    'returns',
    'cancellations',
  ];

  const collected = {}; // metricName -> Map(key -> value)

  for (const metric of METRICS_TO_TRY) {
    const data = await fetchSingleMetric(from, to, metric);
    if (data !== null) {
      collected[metric] = data;
      console.log(`[Ozon Analytics] "${metric}" — OK, ${data.size} записей`);
    }
  }

  // Собираем все ключи sku|date
  const allKeys = new Set();
  for (const map of Object.values(collected)) {
    for (const key of map.keys()) allKeys.add(key);
  }

  console.log(`[Ozon Analytics] Уникальных sku+день: ${allKeys.size}`);
  if (allKeys.size === 0) {
    console.log('[Ozon Analytics] Нет данных для сохранения');
    return 0;
  }

  // Очищаем старые данные
  try {
    const deleted = await query(
      `DELETE FROM ozon_analytics WHERE date >= $1 AND date <= $2`,
      [from, to]
    );
    console.log(`[Ozon Analytics] Очищено старых записей`);
  } catch(e) {
    console.warn('[Ozon Analytics] Очистка:', e.message);
  }

  let total = 0;

  for (const key of allKeys) {
    const [sku, date] = key.split('|');

    const get = (metric) => {
      const map = collected[metric];
      return map ? (map.get(key)?.[metric] || 0) : 0;
    };

    const hits_view       = get('hits_view');
    const hits_view_pdp   = get('hits_view_pdp');
    const hits_tocart     = get('hits_tocart');
    const orders_item     = get('orders_item');
    const revenue         = get('revenue');
    const delivered_units = get('delivered_units');
    const returns         = get('returns');
    const cancellations   = get('cancellations');

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
    } catch(e) {
      // skip
    }
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
