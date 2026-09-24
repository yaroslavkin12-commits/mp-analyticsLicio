const axios = require('axios');
const { delay, sellerHeaders, request, bulkUpsert } = require('./ozonHttp');

// Справочник товаров кабинета (offer_id -> sku, название) — нужен, чтобы
// связать SKU из аналитики и рекламы с артикулом. Список товаров целиком
// через /v3/product/list, детали пачками по 500 через /v3/product/info/list,
// запись в БД пачкой.
async function collectCatalog(cabinet) {
  const headers = sellerHeaders(cabinet);
  if (!headers) { console.log(`[Catalog:${cabinet}] Seller API не настроен`); return { rows: 0 }; }

  const offerIds = [];
  let lastId = '';
  while (true) {
    const data = await request(() => axios.post('https://api-seller.ozon.ru/v3/product/list',
      { filter: { visibility: 'ALL' }, last_id: lastId, limit: 1000 }, { headers, timeout: 60000 }).then(r => r.data), 'Каталог: список');
    const items = data?.result?.items || [];
    for (const it of items) if (it.offer_id) offerIds.push(it.offer_id);
    lastId = data?.result?.last_id || '';
    if (!lastId || !items.length) break;
    await delay(300);
  }

  const rows = [];
  for (let i = 0; i < offerIds.length; i += 500) {
    const chunk = offerIds.slice(i, i + 500);
    const data = await request(() => axios.post('https://api-seller.ozon.ru/v3/product/info/list',
      { offer_id: chunk }, { headers, timeout: 60000 }).then(r => r.data), 'Каталог: инфо');
    for (const item of (data?.items || [])) {
      const sku = item.sku || item.fbo_sku || item.fbs_sku || null;
      rows.push([cabinet, 'ozon', item.offer_id, sku, item.name ? String(item.name).slice(0, 500) : null, new Date()]);
    }
    await delay(300);
  }
  const saved = await bulkUpsert('ad_product_catalog', ['cabinet', 'platform', 'offer_id', 'sku', 'product_name', 'updated_at'],
    rows, ['cabinet', 'platform', 'offer_id']);
  console.log(`[Catalog:${cabinet}] ${saved}`);
  return { rows: saved };
}

module.exports = { collectCatalog };
