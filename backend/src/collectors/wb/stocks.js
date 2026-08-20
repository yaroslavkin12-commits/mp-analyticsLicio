const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('../../db');

async function collectStocks() {
  const token = process.env.WB_TOKEN;
  if (!token) throw new Error('WB_TOKEN не задан');
  console.log('[WB] Остатки...');

  let data;
  try {
    // Пробуем основной endpoint со вчерашней датой
    const dateFrom = dayjs().subtract(1,'day').format('YYYY-MM-DD') + 'T00:00:00';
    const resp = await axios.get('https://statistics-api.wildberries.ru/api/v1/supplier/stocks', {
      headers: { Authorization: token },
      params: { dateFrom },
      timeout: 60000,
    });
    data = resp.data;
  } catch(e) {
    const status = e.response?.status;
    if (status === 404) {
      console.log('[WB] Остатки: endpoint недоступен (404) — нужны права "Статистика" в токене WB');
      return 0;
    }
    if (status === 429) {
      console.log('[WB] Остатки: rate limit (429)');
      return 0;
    }
    console.warn('[WB] Остатки error:', e.message);
    return 0;
  }

  if (!Array.isArray(data)) {
    console.warn('[WB] Остатки: неожиданный формат');
    return 0;
  }

  const today = dayjs().format('YYYY-MM-DD');
  let count = 0;
  for (const s of data) {
    try {
      await query(
        `INSERT INTO wb_stocks
          (snapshot_date,nm_id,article,subject,category,supplier_article,
           tech_size,barcode,quantity,quantity_full,warehouse_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [today, s.nmId||null, s.article||null, s.subject||null, s.category||null,
         s.supplierArticle||null, s.techSize||null, s.barcode||null,
         s.quantity||0, s.quantityFull||0, s.warehouseName||null]
      );
      count++;
    } catch(e) { /* skip */ }
  }
  console.log(`[WB] Остатки: ${count}`);
  return count;
}
module.exports = { collectStocks };
