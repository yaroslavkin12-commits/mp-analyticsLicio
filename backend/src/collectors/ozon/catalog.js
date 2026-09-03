const axios = require('axios');
const { query } = require('../../db');

function headers() {
  return { 'Client-Id': process.env.OZON_CLIENT_ID, 'Api-Key': process.env.OZON_API_KEY, 'Content-Type': 'application/json' };
}

// Название и фото карточки не приходят вместе с остатками (/v4/product/info/stocks
// отдаёт только offer_id/sku). Тянем их отдельно по уже известным offer_id
// (берём из последнего снепшота ozon_stocks) через /v3/product/info/list —
// не сборы остатков, а справочник карточек, поэтому гоняем реже основного цикла.
async function collectCatalog() {
  if (!process.env.OZON_CLIENT_ID) throw new Error('OZON_CLIENT_ID не задан');
  console.log('[Ozon] Каталог (фото/названия)...');

  const rows = await query(`
    SELECT DISTINCT offer_id FROM ozon_stocks
    WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM ozon_stocks) AND offer_id IS NOT NULL
  `);
  const offerIds = rows.map(r => r.offer_id);
  if (!offerIds.length) { console.log('[Ozon] Каталог: нет offer_id для запроса'); return 0; }

  let total = 0;
  const CHUNK = 500;
  for (let i = 0; i < offerIds.length; i += CHUNK) {
    const chunk = offerIds.slice(i, i + CHUNK);
    const { data } = await axios.post('https://api-seller.ozon.ru/v3/product/info/list',
      { offer_id: chunk },
      { headers: headers(), timeout: 60000 }
    );
    const items = data?.items || [];
    for (const item of items) {
      const photo = (item.images && item.images[0]) || item.primary_image || null;
      try {
        await query(
          `INSERT INTO ozon_catalog (offer_id,product_name,photo_url,updated_at)
           VALUES (?,?,?,NOW())
           ON CONFLICT (offer_id) DO UPDATE SET
             product_name = EXCLUDED.product_name,
             photo_url = EXCLUDED.photo_url,
             updated_at = NOW()`,
          [item.offer_id, item.name || null, photo]
        );
        total++;
      } catch(e) { /* skip */ }
    }
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(`[Ozon] Каталог: ${total}`);
  return total;
}
module.exports = { collectCatalog };
