const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('../../db');

function headers() {
  return { 'Client-Id': process.env.OZON_CLIENT_ID, 'Api-Key': process.env.OZON_API_KEY, 'Content-Type': 'application/json' };
}

async function collectAnalytics(dateFrom) {
  if (!process.env.OZON_CLIENT_ID) throw new Error('OZON credentials не заданы');
  const from = dateFrom || dayjs().subtract(30,'day').format('YYYY-MM-DD');
  const to   = dayjs().format('YYYY-MM-DD');
  console.log(`[Ozon Analytics] ${from} → ${to}...`);

  const METRICS = ['hits_view','hits_view_search','hits_view_pdp','hits_tocart','hits_tocart_search','hits_tocart_pdp','orders_item','revenue','delivered_units','returns','cancellations'];

  let offset = 0, total = 0;
  while (true) {
    let resp;
    try {
      resp = await axios.post('https://api-seller.ozon.ru/v1/analytics/data', {
        date_from: from, date_to: to,
        metrics: METRICS,
        dimension: ['sku','day'],
        sort: [{ key: 'revenue', order: 'DESC' }],
        limit: 1000, offset,
      }, { headers: headers(), timeout: 90000 });
    } catch(e) { console.error('[Ozon Analytics]', e.response?.data || e.message); break; }

    const rows = resp.data?.result?.data || [];
    if (!rows.length) break;

    for (const row of rows) {
      const sku  = row.dimensions?.[0]?.id;
      const date = row.dimensions?.[1]?.id;
      if (!sku || !date) continue;

      const m = (row.metrics || []).map(v => Number(v) || 0);
      const [hits_view,hits_view_search,hits_view_pdp,hits_tocart,hits_tocart_search,hits_tocart_pdp,orders_item,revenue,delivered_units,returns,cancellations] = m;

      const ctr             = hits_view > 0 ? hits_view_pdp / hits_view : 0;
      const cr_to_cart      = hits_view > 0 ? hits_tocart   / hits_view : 0;
      const cr_to_order     = hits_view > 0 ? orders_item   / hits_view : 0;
      const redemption_rate = orders_item > 0 ? delivered_units / orders_item : 0;

      try {
        await query(
          `INSERT INTO ozon_analytics (date,sku,hits_view,hits_view_search,hits_view_pdp,hits_tocart,hits_tocart_search,hits_tocart_pdp,orders_item,revenue,delivered_units,returns,cancellations,ctr,cr_to_cart,cr_to_order,redemption_rate)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (date,sku) DO UPDATE SET
             hits_view=EXCLUDED.hits_view,hits_view_pdp=EXCLUDED.hits_view_pdp,
             hits_tocart=EXCLUDED.hits_tocart,orders_item=EXCLUDED.orders_item,
             revenue=EXCLUDED.revenue,delivered_units=EXCLUDED.delivered_units,
             returns=EXCLUDED.returns,cancellations=EXCLUDED.cancellations,
             ctr=EXCLUDED.ctr,cr_to_cart=EXCLUDED.cr_to_cart,
             cr_to_order=EXCLUDED.cr_to_order,redemption_rate=EXCLUDED.redemption_rate`,
          [date,sku,hits_view,hits_view_search,hits_view_pdp,hits_tocart,hits_tocart_search,hits_tocart_pdp,orders_item,revenue,delivered_units,returns,cancellations,ctr,cr_to_cart,cr_to_order,redemption_rate]
        );
        total++;
      } catch(e) {}
    }

    if (rows.length < 1000) break;
    offset += 1000;
    await new Promise(r => setTimeout(r, 500));
  }

  // Подтягиваем названия из заказов
  try {
    await query(`
      UPDATE ozon_analytics oa SET offer_id=oo.offer_id, product_name=oo.product_name
      FROM (SELECT DISTINCT ON (sku) sku,offer_id,product_name FROM ozon_orders WHERE offer_id IS NOT NULL ORDER BY sku,date DESC) oo
      WHERE oa.sku=oo.sku AND oa.offer_id IS NULL
    `);
  } catch(e) {}

  console.log(`[Ozon Analytics] Сохранено: ${total}`);
  return total;
}
module.exports = { collectAnalytics };
