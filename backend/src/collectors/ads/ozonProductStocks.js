const axios = require('axios');
const { query } = require('../../db');
const { delay, mskDate, sellerHeaders, request, bulkInsert } = require('./ozonHttp');

// Текущие остатки FBO/FBS по кабинету — снимок на сегодняшний день
// (перезаписывается при каждом сборе за день). Запись пачкой, а не по одной
// строке (было ~1600 отдельных INSERT на каждый прогон).
async function collectProductStocks(cabinet) {
  const headers = sellerHeaders(cabinet);
  if (!headers) { console.log(`[Stocks:${cabinet}] Seller API не настроен`); return { rows: 0 }; }
  const today = mskDate(0);

  const rows = [];
  let cursor = '';
  while (true) {
    const data = await request(() => axios.post('https://api-seller.ozon.ru/v4/product/info/stocks',
      { cursor, filter: { visibility: 'ALL' }, limit: 1000 }, { headers, timeout: 60000 }).then(r => r.data), 'Остатки');
    const items = data?.items || [];
    for (const item of items) {
      const fbo = (item.stocks || []).find(s => s.type === 'fbo') || {};
      const fbs = (item.stocks || []).find(s => s.type === 'fbs') || {};
      rows.push([cabinet, 'ozon', today, item.product_id || null, item.offer_id,
        fbo.present || 0, fbo.reserved || 0, fbs.present || 0, fbs.reserved || 0]);
    }
    cursor = data?.cursor || '';
    if (!cursor || !items.length) break;
    await delay(300);
  }
  if (!rows.length) return { rows: 0 }; // не затираем вчерашний снимок пустотой

  // Удаляем сегодняшний снимок только когда новый уже полностью получен.
  await query(`DELETE FROM ad_product_stocks WHERE cabinet = $1 AND platform = 'ozon' AND snapshot_date = $2`, [cabinet, today]);
  await bulkInsert('ad_product_stocks',
    ['cabinet', 'platform', 'snapshot_date', 'sku', 'offer_id', 'fbo_present', 'fbo_reserved', 'fbs_present', 'fbs_reserved'], rows);
  console.log(`[Stocks:${cabinet}] ${rows.length}`);
  return { rows: rows.length };
}

module.exports = { collectProductStocks };
