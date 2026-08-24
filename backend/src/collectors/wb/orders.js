const dayjs = require('dayjs');
const { query } = require('../../db');
const { statsGet } = require('./statsClient');

async function collectOrders(dateFrom) {
  const token = process.env.WB_TOKEN;
  if (!token) throw new Error('WB_TOKEN не задан');
  const from = dateFrom || dayjs().subtract(7,'day').format('YYYY-MM-DD');
  console.log(`[WB] Заказы с ${from}...`);

  // Троттлинг и повтор при 429 — общие для orders/sales/stocks, см. statsClient.js
  const data = await statsGet(
    'https://statistics-api.wildberries.ru/api/v1/supplier/orders',
    token,
    { dateFrom: `${from}T00:00:00`, flag: 0 }
  );

  if (!Array.isArray(data)) {
    console.warn('[WB] Заказы: неожиданный формат ответа');
    return 0;
  }

  let count = 0;
  for (const o of data) {
    try {
      await query(
        `INSERT INTO wb_orders
          (date,last_change_date,order_id,nm_id,article,subject,category,
           brand,supplier_article,tech_size,barcode,total_price,discount_percent,
           price_with_disc,warehouse_name,oblast,is_cancel,cancel_dt)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT DO NOTHING`,
        [dayjs(o.date).format('YYYY-MM-DD'), o.lastChangeDate||null, o.gNumber||null,
         o.nmId||null, o.article||null, o.subject||null, o.category||null, o.brand||null,
         o.supplierArticle||null, o.techSize||null, o.barcode||null, o.totalPrice||0,
         o.discountPercent||0, o.priceWithDisc||0, o.warehouseName||null, o.oblast||null,
         o.isCancel||false, o.cancel_dt||null]
      );
      count++;
    } catch(e) { /* skip duplicates */ }
  }
  console.log(`[WB] Заказы: ${count}`);
  return count;
}
module.exports = { collectOrders };
