const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('../../db');

async function collectOrders(dateFrom) {
  const token = process.env.WB_TOKEN;
  if (!token) throw new Error('WB_TOKEN не задан');

  const from = dateFrom || dayjs().subtract(7, 'day').format('YYYY-MM-DD');
  console.log(`[WB] Заказы с ${from}...`);

  const { data } = await axios.get(
    'https://statistics-api.wildberries.ru/api/v1/supplier/orders',
    {
      headers: { Authorization: token },
      params: { dateFrom: `${from}T00:00:00`, flag: 0 },
      timeout: 60000,
    }
  );

  if (!Array.isArray(data)) return 0;

  let count = 0;
  for (const o of data) {
    try {
      await query(
        `INSERT INTO wb_orders
          (date, last_change_date, order_id, nm_id, article, subject, category,
           brand, supplier_article, tech_size, barcode, total_price, discount_percent,
           price_with_disc, warehouse_name, oblast, is_cancel, cancel_dt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT DO NOTHING`,
        [
          dayjs(o.date).format('YYYY-MM-DD'),
          o.lastChangeDate || null,
          o.gNumber || null,
          o.nmId || null,
          o.article || null,
          o.subject || null,
          o.category || null,
          o.brand || null,
          o.supplierArticle || null,
          o.techSize || null,
          o.barcode || null,
          o.totalPrice || 0,
          o.discountPercent || 0,
          o.priceWithDisc || 0,
          o.warehouseName || null,
          o.oblast || null,
          o.isCancel || false,
          o.cancel_dt || null,
        ]
      );
      count++;
    } catch (e) { /* skip */ }
  }

  console.log(`[WB] Заказы сохранено: ${count}`);
  return count;
}

module.exports = { collectOrders };
