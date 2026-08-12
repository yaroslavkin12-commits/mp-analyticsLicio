const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('../../db');

async function collectStocks() {
  const token = process.env.WB_TOKEN;
  if (!token) throw new Error('WB_TOKEN не задан');

  console.log('[WB] Остатки...');

  // Новый эндпоинт WB API v1 (аналитика складов)
  const { data } = await axios.get(
    'https://statistics-api.wildberries.ru/api/v1/supplier/stocks',
    {
      headers: { Authorization: token },
      params: { dateFrom: dayjs().subtract(2, 'day').format('YYYY-MM-DDTHH:mm:ss') },
      timeout: 60000,
    }
  );

  if (!Array.isArray(data)) {
    console.warn('[WB] Stocks: неожиданный формат ответа', typeof data);
    return 0;
  }

  const today = dayjs().format('YYYY-MM-DD');
  let count = 0;

  for (const s of data) {
    try {
      await query(
        `INSERT INTO wb_stocks
          (snapshot_date, nm_id, article, subject, category, supplier_article,
           tech_size, barcode, quantity, quantity_full, warehouse_name)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          today,
          s.nmId || null,
          s.article || null,
          s.subject || null,
          s.category || null,
          s.supplierArticle || null,
          s.techSize || null,
          s.barcode || null,
          s.quantity || 0,
          s.quantityFull || 0,
          s.warehouseName || null,
        ]
      );
      count++;
    } catch (e) { /* skip */ }
  }

  console.log(`[WB] Остатки сохранено: ${count}`);
  return count;
}

module.exports = { collectStocks };
