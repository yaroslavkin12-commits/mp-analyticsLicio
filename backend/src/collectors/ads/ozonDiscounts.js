const axios = require('axios');
const { query } = require('../../db');
const { delay, sellerHeaders, request, bulkInsert } = require('./ozonHttp');
const { fetchPublicPrices } = require('./ozonPublicPrice');
const { notifyDiscountChange, THRESHOLD } = require('../../telegram');

// Слежение за "Соинвестированием в скидку" на Ozon — это тот же механизм,
// что и СПП (скидка постоянного покупателя) на Wildberries: маркетплейс сам
// доплачивает часть скидки покупателю за счёт своей комиссии, продавец
// цену в кабинете не трогает. Разница между тем, что видит покупатель на
// витрине, и тем, что заложил продавец, — это и есть размер Соинвеста.
//
// ВАЖНО (проверено вживую на реальных данных): публичный Seller API
// (v5/product/info/prices) НЕ отдаёт цену на витрине с учётом Соинвеста —
// поле marketing_price там попросту отсутствует, только цена продавца
// (price/old_price/marketing_seller_price). Поэтому:
//   1) публичный Seller API (Client-Id/Api-Key) даёт список товаров и
//      offer_id → product_id — это данные продавца, авторизация обычная;
//   2) реальная цена на сайте (обычная и с банковской картой) берётся с
//      ПУБЛИЧНОЙ страницы товара на ozon.ru — см. ozonPublicPrice.js. Она
//      анонимна (доступна и незалогиненным покупателям), поэтому не требует
//      ни cookie кабинета, ни company_id — только сам product_id. Раньше
//      использовался внутренний метод кабинета продавца с cookie сессии
//      браузера, но антибот-защита Ozon блокирует такие запросы с серверных
//      IP даже с валидной свежей cookie.
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

function discountPct(sellerPrice, sitePrice) {
  const sp = Number(sellerPrice) || 0;
  const mp = Number(sitePrice) || 0;
  if (sp <= 0) return 0;
  return Math.max(0, (sp - mp) / sp * 100);
}

async function collectDiscounts(cabinet) {
  const headers = sellerHeaders(cabinet);
  if (!headers) { console.log(`[Discounts:${cabinet}] Seller API не настроен`); return { rows: 0 }; }

  const items = await fetchAllPrices(headers);

  // Реальную цену на витрине (с учётом Соинвеста Ozon) достаём с публичной
  // страницы товара — по одному запросу на product_id (см. ozonPublicPrice.js).
  const productIds = items.map(it => it.product_id).filter(Boolean);
  if (items.length && productIds.length === 0) {
    // Раньше это молча приводило к withInternal=0 без единой причины отказа в
    // логах (fetchPublicPrices просто нечего было перебирать) — похоже,
    // именно это, а не антибот, все эти сборки и было настоящей причиной
    // отсутствия реальных цен. Печатаем реальную форму первого элемента,
    // чтобы понять правильное имя поля.
    console.warn(`[Discounts:${cabinet}] ни у одного из ${items.length} товаров нет product_id — пример полей: ${Object.keys(items[0]).join(', ')}`);
  }
  const { items: publicPrices, reasonCounts, reasonSamples } = await fetchPublicPrices(productIds);
  const internalByItem = new Map(publicPrices.map(it => [it.item_id, it]));

  const prevRows = await query(
    `SELECT DISTINCT ON (offer_id) offer_id, ozon_discount_pct, source
       FROM product_discount_history
      WHERE cabinet = $1 AND platform = 'ozon'
      ORDER BY offer_id, collected_at DESC`, [cabinet]);
  const prevByOffer = new Map(prevRows.map(r => [r.offer_id, r]));

  const now = new Date();
  const toInsert = [];
  const changed = [];
  let withInternal = 0;

  for (const item of items) {
    const offerId = item.offer_id;
    if (!offerId) continue;
    const p = item.price || {};
    const sellerPrice = Number(p.marketing_seller_price ?? p.price) || 0;
    const price = Number(p.price) || 0;
    const oldPrice = Number(p.old_price) || 0;

    const inner = item.product_id ? internalByItem.get(String(item.product_id)) : null;
    let sitePrice = sellerPrice;
    let oaPrice = 0;
    let source = 'public_api'; // без публичной цены — это лишь приближение (=цена продавца, Соинвест не виден)
    if (inner) {
      sitePrice = Number(inner.marketing_price) || sellerPrice;
      oaPrice = Number(inner.marketing_oa_price) || 0;
      source = 'public_page';
      withInternal++;
    }
    const pct = Math.round(discountPct(sellerPrice, sitePrice) * 100) / 100;

    const prev = prevByOffer.get(offerId);
    const prevPct = prev ? Number(prev.ozon_discount_pct) : null;
    const prevSource = prev?.source;
    // Пишем новую строку истории, только если процент реально сдвинулся
    // (или сменился источник расчёта, или это первая запись по артикулу).
    if (prevPct === null || Math.abs(prevPct - pct) >= 0.1 || prevSource !== source) {
      toInsert.push([cabinet, 'ozon', offerId, item.product_id || null,
        price, oldPrice, sitePrice, sellerPrice, oaPrice, pct, source, now]);
      // Алертим только если оба значения посчитаны из реального Соинвеста
      // (внутренний API) — иначе на "включении" интеграции придёт лавина
      // ложных "изменений" просто из-за смены источника расчёта.
      if (prevPct !== null && prevSource === 'public_page' && source === 'public_page'
          && Math.abs(prevPct - pct) >= THRESHOLD) {
        changed.push({ offerId, prevPct, pct, marketingPrice: sitePrice, price });
      }
    }
  }

  const saved = await bulkInsert('product_discount_history',
    ['cabinet', 'platform', 'offer_id', 'product_id', 'price', 'old_price', 'marketing_price', 'marketing_seller_price', 'marketing_oa_price', 'ozon_discount_pct', 'source', 'collected_at'],
    toInsert);

  if (changed.length) {
    console.log(`[Discounts:${cabinet}] изменений Соинвеста: ${changed.length}`);
    await notifyDiscountChange(cabinet, changed).catch(e => console.warn('[Discounts] telegram:', e.message));
  }
  // Диагностика причин отказа публичного API — иначе "0 из N реальных цен" в
  // проде ничего не говорит о том, блокирует ли антибот, нет ли виджета цены
  // на странице, или это сетевая ошибка/таймаут.
  const reasonsStr = Object.entries(reasonCounts || {}).sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r}=${n}`).join(', ');
  console.log(`[Discounts:${cabinet}] проверено ${items.length} (с product_id: ${productIds.length}), из них с реальной ценой сайта ${withInternal}, записано новых строк ${saved}` +
    (reasonsStr ? ` (отказы публичной цены: ${reasonsStr})` : ''));
  for (const [reason, sample] of Object.entries(reasonSamples || {})) {
    console.log(`[Discounts:${cabinet}] образец причины "${reason}": ${sample}`);
  }
  return { rows: saved, withInternal };
}

module.exports = { collectDiscounts };
