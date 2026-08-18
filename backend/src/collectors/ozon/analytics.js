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

async function fetchMetrics(dateFrom, dateTo, metrics) {
  const result = new Map();
  let offset = 0;

  while (true) {
    let resp;
    try {
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
      console.error('[Ozon Analytics] Ошибка:', e.response?.data || e.message);
      break;
    }

    const rows = resp.data?.result?.data || [];
    console.log(`[Ozon Analytics] metrics=[${metrics[0]}...] получено ${rows.length}, offset=${offset}`);

    for (const row of rows) {
      const dims = row.dimensions || [];
      const skuDim  = dims.find(d => d.id && /^\d{5,}$/.test(String(d.id)));
      const dateDim = dims.find(d => d.id && /^\d{4}-\d{2}-\d{2}$/.test(String(d.id)));
      const sku  = skuDim?.id  || dims[0]?.id;
      const date = dateDim?.id || dims[1]?.id;
      if (!sku || !date) continue;

      const key = `${sku}|${date}`;
      const existing = result.get(key) || { sku, date, metrics: [] };
      existing.metrics = [...existing.metrics, ...(row.metrics || []).map(v => Number(v) || 0)];
      result.set(key, existing);
    }

    if (rows.length < 1000) break;
    offset += 1000;
    await new Promise(r => setTimeout(r, 600));
  }

  return result;
}

async function collectAnalytics(dateFrom) {
  if (!process.env.OZON_CLIENT_ID) throw new Error('OZON credentials не заданы');

  const from = dateFrom || dayjs().subtract(30, 'day').format('YYYY-MM-DD');
  const to   = dayjs().format('YYYY-MM-DD');
  console.log(`[Ozon Analytics] Сбор ${from} -> ${to}...`);

  const group1 = await fetchMetrics(from, to, [
    'hits_view', 'hits_view_search', 'hits_view_pdp',
    'hits_tocart', 'hits_tocart_search', 'hits_tocart_pdp',
  ]);

  await new Promise(r => setTimeout(r, 1000));

  const group2 = await fetchMetrics(from, to, [
    'orders_item', 'revenue', 'delivered_units', 'returns', 'cancellations',
  ]);

  const allKeys = new Set([...group1.keys(), ...group2.keys()]);
  console.log(`[Ozon Analytics] Уникальных записей: ${allKeys.size}`);

  let total = 0;

  for (const key of allKeys) {
    const d1 = group1.get(key);
    const d2 = group2.get(key);
    const sku  = (d1 || d2).sku;
    const date = (d1 || d2).date;

    const m1 = d1?.metrics || [0,0,0,0,0,0];
    const m2 = d2?.metrics || [0,0,0,0,0];

    const [hits_view=0, hits_view_search=0, hits_view_pdp=0, hits_tocart=0, hits_tocart_search=0, hits_tocart_pdp=0] = m1;
    const [orders_item=0, revenue=0, delivered_units=0, returns=0, cancellations=0] = m2;

    const ctr             = hits_view   > 0 ? hits_view_pdp   / hits_view   : 0;
    const cr_to_cart      = hits_view   > 0 ? hits_tocart      / hits_view   : 0;
    const cr_to_order     = hits_view   > 0 ? orders_item      / hits_view   : 0;
    const redemption_rate = orders_item > 0 ? delivered_units  / orders_item : 0;

    try {
      await query(
        `INSERT INTO ozon_analytics
          (date, sku, hits_view, hits_view_search, hits_view_pdp,
           hits_tocart, hits_tocart_search, hits_tocart_pdp,
           orders_item, revenue, delivered_units, returns, cancellations,
           ctr, cr_to_cart, cr_to_order, redemption_rate)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (date, sku) DO UPDATE SET
           hits_view=EXCLUDED.hits_view, hits_view_pdp=EXCLUDED.hits_view_pdp,
           hits_tocart=EXCLUDED.hits_tocart, orders_item=EXCLUDED.orders_item,
           revenue=EXCLUDED.revenue, delivered_units=EXCLUDED.delivered_units,
           returns=EXCLUDED.returns, cancellations=EXCLUDED.cancellations,
           ctr=EXCLUDED.ctr, cr_to_cart=EXCLUDED.cr_to_cart,
           cr_to_order=EXCLUDED.cr_to_order, redemption_rate=EXCLUDED.redemption_rate`,
        [date, sku, hits_view, hits_view_search, hits_view_pdp,
         hits_tocart, hits_tocart_search, hits_tocart_pdp,
         orders_item, revenue, delivered_units, returns, cancellations,
         ctr, cr_to_cart, cr_to_order, redemption_rate]
      );
      total++;
    } catch(e) {}
  }

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
