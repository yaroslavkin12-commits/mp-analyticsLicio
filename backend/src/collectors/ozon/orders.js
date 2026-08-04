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

async function collectOrders(dateFrom) {
  if (!process.env.OZON_CLIENT_ID) throw new Error('OZON_CLIENT_ID не задан');

  const since = dateFrom
    ? dayjs(dateFrom).toISOString()
    : dayjs().subtract(7, 'day').toISOString();

  console.log(`[Ozon] Заказы с ${since}...`);

  let offset = 0;
  let total = 0;

  while (true) {
    const { data } = await axios.post(
      'https://api-seller.ozon.ru/v3/posting/fbo/list',
      {
        dir: 'ASC',
        filter: { since, to: new Date().toISOString(), status: '' },
        limit: 100,
        offset,
        with: { financial_data: true, analytics_data: true },
      },
      { headers: headers(), timeout: 60000 }
    );

    const postings = data?.result?.postings || [];
    if (!postings.length) break;

    for (const p of postings) {
      for (const prod of p.products || []) {
        try {
          const fin = p.financial_data?.products?.find(f => f.sku === prod.sku) || {};
          await query(
            `INSERT INTO ozon_orders
              (date, posting_number, order_id, sku, offer_id, product_name,
               price, quantity, commission_amount, commission_percent, payout, status, warehouse_name)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT (posting_number, sku) DO UPDATE SET
               status=EXCLUDED.status, payout=EXCLUDED.payout`,
            [
              dayjs(p.in_process_at || p.created_at).format('YYYY-MM-DD'),
              p.posting_number, p.order_id || null, prod.sku,
              prod.offer_id, prod.name,
              parseFloat(prod.price) || 0, prod.quantity || 1,
              fin.commission_amount || 0, fin.commission_percent || 0,
              fin.payout || 0, p.status,
              p.analytics_data?.warehouse_name || null,
            ]
          );
          total++;
        } catch (e) { /* skip */ }
      }
    }

    if (postings.length < 100) break;
    offset += 100;
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`[Ozon] Заказы сохранено: ${total}`);
  return total;
}

module.exports = { collectOrders };
