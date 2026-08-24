const dayjs = require('dayjs');
const { query } = require('../../db');
const { statsGet } = require('./statsClient');

async function collectSales(dateFrom) {
  const token = process.env.WB_TOKEN;
  if (!token) throw new Error('WB_TOKEN не задан');
  const from = dateFrom || dayjs().subtract(7,'day').format('YYYY-MM-DD');
  console.log(`[WB] Продажи с ${from}...`);

  // Троттлинг и повтор при 429 — общие для orders/sales/stocks, см. statsClient.js
  const data = await statsGet(
    'https://statistics-api.wildberries.ru/api/v1/supplier/sales',
    token,
    { dateFrom: `${from}T00:00:00`, flag: 0 }
  );

  if (!Array.isArray(data)) return 0;

  let count = 0;
  for (const s of data) {
    try {
      await query(
        `INSERT INTO wb_sales
          (date,last_change_date,sale_id,nm_id,article,subject,category,
           brand,supplier_article,tech_size,barcode,price,discount_percent,
           price_with_disc,for_pay,finished_price,warehouse_name,oblast)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (sale_id) DO UPDATE SET
           for_pay=EXCLUDED.for_pay, finished_price=EXCLUDED.finished_price`,
        [dayjs(s.date).format('YYYY-MM-DD'), s.lastChangeDate||null, s.saleID||null,
         s.nmId||null, s.article||null, s.subject||null, s.category||null, s.brand||null,
         s.supplierArticle||null, s.techSize||null, s.barcode||null, s.totalPrice||0,
         s.discountPercent||0, s.priceWithDisc||0, s.forPay||0, s.finishedPrice||0,
         s.warehouseName||null, s.oblast||null]
      );
      count++;
    } catch(e) { /* skip */ }
  }
  console.log(`[WB] Продажи: ${count}`);
  return count;
}
module.exports = { collectSales };
