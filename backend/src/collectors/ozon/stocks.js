const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('../../db');

function headers() {
  return { 'Client-Id': process.env.OZON_CLIENT_ID, 'Api-Key': process.env.OZON_API_KEY, 'Content-Type': 'application/json' };
}

async function collectStocks() {
  if (!process.env.OZON_CLIENT_ID) throw new Error('OZON_CLIENT_ID не задан');
  console.log('[Ozon] Остатки...');
  const today = dayjs().format('YYYY-MM-DD');
  let offset = 0, total = 0;
  while (true) {
    const { data } = await axios.post('https://api-seller.ozon.ru/v2/analytics/stock_on_warehouses',
      { limit: 500, offset, warehouse_type: 'ALL' },
      { headers: headers(), timeout: 60000 }
    );
    const rows = data?.result?.rows || [];
    if (!rows.length) break;
    for (const r of rows) {
      await query(
        `INSERT INTO ozon_stocks (snapshot_date,sku,offer_id,product_name,fbo_present,fbo_reserved,fbs_present,warehouse_id,warehouse_name)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [today,r.sku,r.item_code,r.item_name,r.free_to_sell_amount||0,r.reserved_amount||0,r.promised_amount||0,r.warehouse_id||null,r.warehouse_name||null]
      );
      total++;
    }
    if (rows.length < 500) break;
    offset += 500;
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`[Ozon] Остатки: ${total}`);
  return total;
}
module.exports = { collectStocks };
