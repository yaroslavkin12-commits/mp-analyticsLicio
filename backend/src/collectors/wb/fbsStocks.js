const dayjs = require('dayjs');
const axios = require('axios');
const { query } = require('../../db');
const { statsGet } = require('./statsClient');

// Остатки на СВОЁМ складе (FBS) на WB — это отдельный API (Маркетплейс), не
// тот же самый, что статистика по FBO-складам WB (см. stocks.js). Раньше
// FBS-остатки на WB вообще не собирались — отсюда пустая колонка WB на
// дашборде, хотя физически товар на складе есть и виден в личном кабинете.
//
// Флоу:
// 1) content-api: получаем список карточек (nmId, артикул, размеры и их баркоды)
// 2) marketplace-api: получаем список собственных складов продавца
// 3) marketplace-api: по каждому складу запрашиваем остатки по баркодам

function headers(token) {
  return { Authorization: token, 'Content-Type': 'application/json' };
}

async function fetchAllCards(token) {
  const cards = [];
  let cursor = { limit: 100 };
  while (true) {
    const { data } = await axios.post(
      'https://content-api.wildberries.ru/content/v2/get/cards/list',
      { settings: { cursor, filter: { withPhoto: -1 } } },
      { headers: headers(token), timeout: 60000 }
    );
    const batch = data?.cards || [];
    cards.push(...batch);
    const total = data?.cursor?.total || 0;
    if (total < (cursor.limit || 100)) break;
    cursor = { limit: 100, updatedAt: data.cursor.updatedAt, nmID: data.cursor.nmID };
    await new Promise(r => setTimeout(r, 500));
  }
  return cards;
}

async function collectFbsStocks() {
  const token = process.env.WB_TOKEN;
  if (!token) throw new Error('WB_TOKEN не задан');
  console.log('[WB] Остатки FBS (свой склад)...');

  const cards = await fetchAllCards(token);
  // baркод -> метаданные карточки, чтобы после ответа по остаткам восстановить nmId/артикул/размер
  const barcodeMeta = new Map();
  for (const card of cards) {
    for (const size of card.sizes || []) {
      for (const barcode of size.skus || []) {
        barcodeMeta.set(barcode, {
          nmId: card.nmID, article: card.vendorCode,
          subject: card.subjectName || null, techSize: size.techSize || null,
        });
      }
    }
  }
  if (!barcodeMeta.size) { console.log('[WB] FBS: нет карточек с баркодами'); return 0; }

  const { data: warehouses } = await axios.get(
    'https://marketplace-api.wildberries.ru/api/v3/warehouses',
    { headers: headers(token), timeout: 30000 }
  );
  if (!Array.isArray(warehouses) || !warehouses.length) {
    console.log('[WB] FBS: у продавца нет складов маркетплейса'); return 0;
  }

  const allBarcodes = [...barcodeMeta.keys()];
  const today = dayjs().format('YYYY-MM-DD');
  let total = 0;

  for (const wh of warehouses) {
    for (let i = 0; i < allBarcodes.length; i += 1000) {
      const chunk = allBarcodes.slice(i, i + 1000);
      let resp;
      try {
        const r = await axios.post(
          `https://marketplace-api.wildberries.ru/api/v3/stocks/${wh.id}`,
          { skus: chunk },
          { headers: headers(token), timeout: 60000 }
        );
        resp = r.data;
      } catch(e) {
        console.warn(`[WB] FBS склад ${wh.name || wh.id}: ${e.message}`);
        continue;
      }
      for (const s of resp?.stocks || []) {
        const meta = barcodeMeta.get(s.sku);
        if (!meta || !s.amount) continue;
        try {
          await query(
            `INSERT INTO wb_stocks
              (snapshot_date,nm_id,article,subject,supplier_article,tech_size,barcode,quantity,quantity_full,warehouse_name,stock_type)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'fbs')`,
            [today, meta.nmId, meta.article, meta.subject, meta.article, meta.techSize, s.sku, s.amount, s.amount, wh.name || null]
          );
          total++;
        } catch(e) { /* skip */ }
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }
  console.log(`[WB] Остатки FBS: ${total}`);
  return total;
}
module.exports = { collectFbsStocks };
