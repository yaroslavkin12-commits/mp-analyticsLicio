const axios = require('axios');
const { query } = require('../../db');
const { getCabinet } = require('../../config/cabinets');

const delay = ms => new Promise(r => setTimeout(r, ms));

// Обёртка с retry для вызовов api-seller.ozon.ru — этот API периодически
// отдаёт HTTP 429 / code:8 "request rate limit per second" (подтверждено
// живым тестом), причём это временная ошибка, а не постоянный сбой.
// Раньше здесь не было retry вообще — один 429 на /v3/product/list ронял
// ВЕСЬ сборщик целиком (каталог -> реклама -> аналитика), даже те шаги,
// которые сами по себе работали нормально. Теперь ждём и повторяем.
async function withRetry(fn, label) {
  for (let attempt = 0; attempt <= 5; attempt++) {
    try {
      return await fn();
    } catch(e) {
      const code = e.response?.data?.code;
      const status = e.response?.status;
      if ((code === 8 || status === 429) && attempt < 5) {
        const wait = 1500 * (attempt + 1);
        console.warn(`[Ads] ${label}: лимит запросов (429), retry ${attempt + 1}/5 через ${wait}мс`);
        await delay(wait);
        continue;
      }
      throw e;
    }
  }
}

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
    const data = await withRetry(() => axios.post('https://api-seller.ozon.ru/v3/product/list',
      { filter: {}, last_id: lastId, limit: 1000 },
      { headers, timeout: 60000 }
    ).then(r => r.data), 'Каталог: список товаров');
    const items = data?.result?.items || [];
    for (const it of items) if (it.offer_id) offerIds.push(it.offer_id);
    lastId = data?.result?.last_id || '';
    if (!lastId || !items.length) break;
    await delay(700);
  }

  if (!offerIds.length) { console.log(`[Ads:${cabinet}] Каталог: товаров не найдено`); return 0; }

  let total = 0;
  const CHUNK = 500;
  for (let i = 0; i < offerIds.length; i += CHUNK) {
    const chunk = offerIds.slice(i, i + CHUNK);
    let data;
    try {
      data = await withRetry(() => axios.post('https://api-seller.ozon.ru/v3/product/info/list',
        { offer_id: chunk },
        { headers, timeout: 60000 }
      ).then(r => r.data), 'Каталог: инфо о товарах');
    } catch(e) { console.warn(`[Ads:${cabinet}] Каталог инфо:`, e.response?.data || e.message); continue; }

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
    await delay(700);
  }
  console.log(`[Ads:${cabinet}] Каталог: ${total}`);
  return total;
}

module.exports = { collectCatalog };
