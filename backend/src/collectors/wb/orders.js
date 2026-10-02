const dayjs = require('dayjs');
const { query } = require('../../db');
const { statsGet } = require('./statsClient');
const { checkAndNotify } = require('../trackedArticles');

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
  const newOrders = []; // для уведомлений по отслеживаемым артикулам (см. ниже)
  for (const o of data) {
    try {
      // srid — уникальный id строки заказа у WB. ON CONFLICT (srid) DO
      // NOTHING + RETURNING даёт точный список РЕАЛЬНО новых строк в этом
      // прогоне (а не "ON CONFLICT DO NOTHING" вслепую, как было раньше) —
      // это и есть сигнал "поступил новый заказ".
      const rows = await query(
        `INSERT INTO wb_orders
          (date,last_change_date,order_id,nm_id,article,subject,category,
           brand,supplier_article,tech_size,barcode,total_price,discount_percent,
           price_with_disc,warehouse_name,oblast,is_cancel,cancel_dt,srid)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (srid) DO NOTHING
         RETURNING nm_id, article, supplier_article, subject, total_price, warehouse_name`,
        [dayjs(o.date).format('YYYY-MM-DD'), o.lastChangeDate||null, o.gNumber||null,
         o.nmId||null, o.article||null, o.subject||null, o.category||null, o.brand||null,
         o.supplierArticle||null, o.techSize||null, o.barcode||null, o.totalPrice||0,
         o.discountPercent||0, o.priceWithDisc||0, o.warehouseName||null, o.oblast||null,
         o.isCancel||false, o.cancel_dt||null, o.srid||null]
      );
      count++;
      if (rows.length && !o.isCancel) {
        const r = rows[0];
        newOrders.push({
          nm_id: r.nm_id, supplier_article: r.supplier_article, article: r.article,
          productName: r.subject, price: Number(r.total_price) || 0, warehouse: r.warehouse_name,
          orderRef: o.srid || o.gNumber || null,
        });
      }
    } catch(e) { /* skip duplicates */ }
  }
  console.log(`[WB] Заказы: ${count}`);

  checkAndNotify('licio', 'wb', newOrders).catch(e => console.error('[WB] Уведомления:', e.message));

  return count;
}
module.exports = { collectOrders };
