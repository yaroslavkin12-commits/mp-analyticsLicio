const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('../../db');

function headers() {
  return { 'Client-Id': process.env.OZON_CLIENT_ID, 'Api-Key': process.env.OZON_API_KEY, 'Content-Type': 'application/json' };
}

// Раньше здесь дёргался /v2/analytics/stock_on_warehouses — это отчёт только
// по складам Ozon (FBO), у него нет реального FBS. Поле fbs_present
// заполнялось из promised_amount (это "подтверждено, но не отгружено" на
// FBO-складе, а не остаток на своём складе) — из-за чего FBS на дашборде
// всегда показывал 0, даже если товар физически лежит на своём складе и
// продаётся через FBS. /v4/product/info/stocks — актуальный эндпоинт,
// отдаёт по каждому товару отдельно FBO и FBS остатки.
async function collectStocks() {
  if (!process.env.OZON_CLIENT_ID) throw new Error('OZON_CLIENT_ID не задан');
  console.log('[Ozon] Остатки...');
  const today = dayjs().format('YYYY-MM-DD');
  let cursor = '', total = 0;

  while (true) {
    const { data } = await axios.post('https://api-seller.ozon.ru/v4/product/info/stocks',
      { cursor, filter: { visibility: 'ALL' }, limit: 1000 },
      { headers: headers(), timeout: 60000 }
    );
    const items = data?.items || [];
    if (!items.length) break;

    for (const item of items) {
      const fbo = (item.stocks || []).find(s => s.type === 'fbo') || {};
      const fbs = (item.stocks || []).find(s => s.type === 'fbs') || {};
      try {
        await query(
          `INSERT INTO ozon_stocks (snapshot_date,sku,offer_id,product_name,fbo_present,fbo_reserved,fbs_present,fbs_reserved,warehouse_name)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [today, item.product_id||null, item.offer_id, null,
           fbo.present||0, fbo.reserved||0, fbs.present||0, fbs.reserved||0, null]
        );
        total++;
      } catch(e) { /* skip */ }
    }

    cursor = data?.cursor || '';
    if (!cursor) break;
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(`[Ozon] Остатки: ${total}`);
  return total;
}
module.exports = { collectStocks };
