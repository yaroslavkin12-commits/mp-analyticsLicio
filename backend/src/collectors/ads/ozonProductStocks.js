const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('../../db');
const { getCabinet } = require('../../config/cabinets');

// Текущие остатки (FBO/FBS) по кабинету — тот же эндпоинт и та же логика
// защиты от дублей за день, что и у "родного" сборщика Licio
// (collectors/ozon/stocks.js), но с учётом кабинета и своей таблицей
// ad_product_stocks (см. init.sql), т.к. Licio и Defly — разные аккаунты
// Ozon Seller API с разными токенами.
async function collectProductStocks(cabinet) {
  const cfg = getCabinet(cabinet);
  if (!cfg.ozonClientId || !cfg.ozonApiKey) {
    console.log(`[Ads] ${cabinet}: Seller API не настроен, остатки пропущены`);
    return 0;
  }
  console.log(`[Ads] ${cabinet}: остатки...`);
  const headers = { 'Client-Id': cfg.ozonClientId, 'Api-Key': cfg.ozonApiKey, 'Content-Type': 'application/json' };
  const today = dayjs().format('YYYY-MM-DD');

  try {
    await query(`DELETE FROM ad_product_stocks WHERE cabinet = ? AND platform = 'ozon' AND snapshot_date = ?`, [cabinet, today]);
  } catch (e) { console.warn(`[Ads] ${cabinet}: очистка старого снепшота остатков не удалась:`, e.message); }

  let cursor = '', total = 0;
  while (true) {
    const { data } = await axios.post('https://api-seller.ozon.ru/v4/product/info/stocks',
      { cursor, filter: { visibility: 'ALL' }, limit: 1000 },
      { headers, timeout: 60000 }
    );
    const items = data?.items || [];
    if (!items.length) break;

    for (const item of items) {
      const fbo = (item.stocks || []).find(s => s.type === 'fbo') || {};
      const fbs = (item.stocks || []).find(s => s.type === 'fbs') || {};
      try {
        await query(
          `INSERT INTO ad_product_stocks (cabinet, platform, snapshot_date, sku, offer_id, fbo_present, fbo_reserved, fbs_present, fbs_reserved)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [cabinet, 'ozon', today, item.product_id || null, item.offer_id,
           fbo.present || 0, fbo.reserved || 0, fbs.present || 0, fbs.reserved || 0]
        );
        total++;
      } catch (e) { /* skip */ }
    }

    cursor = data?.cursor || '';
    if (!cursor) break;
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(`[Ads] ${cabinet}: остатки собраны (${total})`);
  return total;
}

module.exports = { collectProductStocks };
