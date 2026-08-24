const dayjs = require('dayjs');
const { query } = require('../../db');
const { statsGet } = require('./statsClient');

async function collectStocks() {
  const token = process.env.WB_TOKEN;
  if (!token) throw new Error('WB_TOKEN не задан');
  console.log('[WB] Остатки...');

  let data;
  try {
    // Троттлинг и повтор при 429 — общие для orders/sales/stocks, см. statsClient.js.
    // Раньше 429 здесь тихо превращался в "0 записей, success" — неотличимо от честного
    // "остатков и правда нет". Теперь statsGet сам делает повтор, а если лимит всё равно
    // не отпустил — бросает ошибку, и это видно в логе сборов как реальный сбой.
    const dateFrom = dayjs().subtract(1,'day').format('YYYY-MM-DD') + 'T00:00:00';
    data = await statsGet(
      'https://statistics-api.wildberries.ru/api/v1/supplier/stocks',
      token,
      { dateFrom }
    );
  } catch(e) {
    if (e.response?.status === 404 || /404/.test(e.message)) {
      console.log('[WB] Остатки: endpoint недоступен (404) — нужны права "Статистика" в токене WB');
      return 0;
    }
    throw e;
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
