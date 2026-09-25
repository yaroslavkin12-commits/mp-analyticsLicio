const axios = require('axios');
const { query } = require('../../db');
const { delay, sellerHeaders, request, bulkInsert } = require('./ozonHttp');
const { notifyDiscountChange } = require('../../telegram');

// Слежение за "Соинвестированием в скидку" на Ozon — это тот же механизм,
// что и СПП (скидка постоянного покупателя) на Wildberries: маркетплейс сам
// доплачивает часть скидки покупателю за счёт своей комиссии, продавец
// цену в кабинете не трогает. Разница между тем, что видит покупатель на
// витрине, и тем, что заложил продавец, — это и есть размер Соинвеста.
//
// Ozon отдаёт обе цены одним и тем же методом Seller API v5/product/info/prices:
//  - price                  — цена продавца в кабинете
//  - marketing_price        — цена на витрине для покупателя со всеми акциями
//  - marketing_seller_price — цена с учётом только скидок самого продавца
// (marketing_price - marketing_seller_price) — это и есть Соинвест Ozon.
//
// История здесь ведётся "по изменениям": новая строка пишется только тогда,
// когда процент Соинвеста реально сдвинулся с прошлого раза — иначе таблица
// росла бы на тысячи одинаковых строк каждый запуск задачи.

const PAGE = 1000;

async function fetchAllPrices(headers) {
  const items = [];
  let cursor = '';
  while (true) {
    const data = await request(() => axios.post('https://api-seller.ozon.ru/v5/product/info/prices',
      { filter: { visibility: 'ALL' }, cursor, limit: PAGE },
      { headers, timeout: 60000 }).then(r => r.data), `Цены/Соинвест стр. cursor=${cursor.slice(0, 8)}`);
    const part = data?.items || [];
    items.push(...part);
    cursor = data?.cursor || '';
    if (!cursor || part.length < PAGE) break;
    await delay(300);
  }
  return items;
}

function discountPct(marketingPrice, sellerPrice) {
  const mp = Number(marketingPrice) || 0;
  const sp = Number(sellerPrice) || 0;
  if (sp <= 0) return 0;
  return Math.max(0, (sp - mp) / sp * 100);
}

async function collectDiscounts(cabinet) {
  const headers = sellerHeaders(cabinet);
  if (!headers) { console.log(`[Discounts:${cabinet}] Seller API не настроен`); return { rows: 0 }; }

  const items = await fetchAllPrices(headers);

  // Последнее сохранённое значение по каждому offer_id — чтобы понять, что
  // реально изменилось (и есть от чего считать дельту для Telegram-алерта).
  const prevRows = await query(
    `SELECT DISTINCT ON (offer_id) offer_id, ozon_discount_pct, price, marketing_price
       FROM product_discount_history
      WHERE cabinet = $1 AND platform = 'ozon'
      ORDER BY offer_id, collected_at DESC`, [cabinet]);
  const prevByOffer = new Map(prevRows.map(r => [r.offer_id, r]));

  const now = new Date();
  const toInsert = [];
  const changed = [];

  for (const item of items) {
    const offerId = item.offer_id;
    if (!offerId) continue;
    const p = item.price || {};
    const sellerPrice = Number(p.marketing_seller_price ?? p.price) || 0;
    const marketingPrice = Number(p.marketing_price ?? p.price) || 0;
    const price = Number(p.price) || 0;
    const oldPrice = Number(p.old_price) || 0;
    const pct = Math.round(discountPct(marketingPrice, sellerPrice) * 100) / 100;

    const prev = prevByOffer.get(offerId);
    const prevPct = prev ? Number(prev.ozon_discount_pct) : null;
    // Пишем новую строку истории, только если процент реально сдвинулся
    // (или это первая запись по артикулу) — иначе таблица распухнет от
    // одинаковых значений на каждый прогон задачи.
    if (prevPct === null || Math.abs(prevPct - pct) >= 0.1) {
      toInsert.push([cabinet, 'ozon', offerId, item.product_id || null,
        price, oldPrice, marketingPrice, sellerPrice, pct, now]);
      if (prevPct !== null && Math.abs(prevPct - pct) >= 1) {
        changed.push({ offerId, prevPct, pct, marketingPrice, price });
      }
    }
  }

  const saved = await bulkInsert('product_discount_history',
    ['cabinet', 'platform', 'offer_id', 'product_id', 'price', 'old_price', 'marketing_price', 'marketing_seller_price', 'ozon_discount_pct', 'collected_at'],
    toInsert);

  if (changed.length) {
    console.log(`[Discounts:${cabinet}] изменений Соинвеста: ${changed.length}`);
    await notifyDiscountChange(cabinet, changed).catch(e => console.warn('[Discounts] telegram:', e.message));
  }
  console.log(`[Discounts:${cabinet}] проверено ${items.length}, записано новых строк ${saved}`);
  return { rows: saved };
}

module.exports = { collectDiscounts };
