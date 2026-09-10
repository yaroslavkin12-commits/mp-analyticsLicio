const axios = require('axios');
const { query } = require('../../db');
const { getCabinet } = require('../../config/cabinets');

// Справочник товаров кабинета (offer_id -> sku, название) — нужен, чтобы
// связать рекламные кампании и аналитику по SKU с конкретным артикулом.
// В отличие от collectors/ozon/catalog.js (который берёт offer_id из уже
// собранных остатков), здесь остатки могут не собираться вовсе (для Defly
// пока нужна только реклама) — поэтому тянем список товаров целиком через
// /v3/product/list, без зависимости от других сборщиков.
async function collectCatalog(cabinet) {
  const cfg = getCabinet(cabinet);
  if (!cfg.ozonClientId || !cfg.ozonApiKey) {
    console.log(`[Ads:${cabinet}] Каталог: Ozon Seller API не настроен`);
    return 0;
  }
  const headers = { 'Client-Id': cfg.ozonClientId, 'Api-Key': cfg.ozonApiKey, 'Content-Type': 'application/json' };

  const offerIds = [];
  let lastId = '';
  while (true) {
    const { data } = await axios.post('https://api-seller.ozon.ru/v3/product/list',
      { filter: {}, last_id: lastId, limit: 1000 },
      { headers, timeout: 60000 }
    );
    const items = data?.result?.items || [];
    for (const it of items) if (it.offer_id) offerIds.push(it.offer_id);
    lastId = data?.result?.last_id || '';
    if (!lastId || !items.length) break;
    await new Promise(r => setTimeout(r, 250));
  }

  if (!offerIds.length) { console.log(`[Ads:${cabinet}] Каталог: товаров не найдено`); return 0; }

  let total = 0;
  const CHUNK = 500;
  for (let i = 0; i < offerIds.length; i += CHUNK) {
    const chunk = offerIds.slice(i, i + CHUNK);
    let data;
    try {
      ({ data } = await axios.post('https://api-seller.ozon.ru/v3/product/info/list',
        { offer_id: chunk },
        { headers, timeout: 60000 }
      ));
    } catch(e) { console.warn(`[Ads:${cabinet}] Каталог инфо:`, e.message); continue; }

    for (const item of (data?.items || [])) {
      const sku = item.sku || item.fbo_sku || item.fbs_sku || null;
      try {
        await query(
          `INSERT INTO ad_product_catalog (cabinet, platform, offer_id, sku, product_name, updated_at)
           VALUES ($1,'ozon',$2,$3,$4,NOW())
           ON CONFLICT (cabinet, platform, offer_id) DO UPDATE SET
             sku = EXCLUDED.sku, product_name = EXCLUDED.product_name, updated_at = NOW()`,
          [cabinet, item.offer_id, sku, item.name || null]
        );
        total++;
      } catch(e) { /* skip */ }
    }
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(`[Ads:${cabinet}] Каталог: ${total}`);
  return total;
}

module.exports = { collectCatalog };
