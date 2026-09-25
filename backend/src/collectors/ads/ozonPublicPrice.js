const axios = require('axios');
const { delay } = require('./ozonHttp');

// Реальная цена на витрине Ozon (с учётом Соинвестирования в скидку) — из
// ПУБЛИЧНОЙ страницы товара, без какой-либо авторизации кабинета продавца.
//
// Раньше здесь использовался внутренний (недокументированный) метод самого
// кабинета продавца — get-common-prices с cookie авторизованной сессии
// браузера (см. историю ozonInternalPrices.js). Отказались от него: даже со
// свежей валидной cookie антибот-защита Ozon блокирует запросы с серверных
// (датацентровых) IP — редиректит на логин или просто держит соединение до
// таймаута, не давая ответа. Публичная же страница товара, наоборот,
// обязана открываться анонимно (её видят и незалогиненные покупатели, и
// поисковые боты), поэтому не проверяет ни cookie, ни company_id — только
// product_id.
//
//   GET https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=/product/<product_id>/
//   → widgetStates["webPrice-...-default-1"] = {
//       price: "4 416 ₽",       — обычная цена на витрине
//       cardPrice: "3 979 ₽",   — цена с банковской картой Ozon
//     }
//
// Разница между ценой продавца (marketing_seller_price из официального
// Seller API) и этой витринной ценой — и есть размер Соинвеста.
// Так же, судя по всему, устроен и мониторинг СПП/Соинвеста в TrueStats.

const ENDPOINT = 'https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2';
const CONCURRENCY = 6;
const TIMEOUT = 15000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

function parsePrice(v) {
  if (v == null) return 0;
  const cleaned = String(v).replace(/[^\d,.-]/g, '').replace(',', '.');
  return Number(cleaned) || 0;
}

// Возвращает { ok: true, data } либо { ok: false, reason } — reason нужен
// только для диагностики (см. fetchPublicPrices), в основной логике не
// участвует. ВАЖНО: раньше любая ошибка тут молча превращалась в null, и по
// логам было не отличить "заблокировали антиботом" от "просто нет виджета
// цены на странице" — при полном провале метода в проде (0 из 0) это не
// давало понять причину.
async function fetchOne(productId) {
  try {
    const resp = await axios.get(ENDPOINT, {
      params: { url: `/product/${productId}/` },
      timeout: TIMEOUT,
      headers: { accept: 'application/json', 'user-agent': UA },
      validateStatus: () => true,
    });
    if (resp.status !== 200) {
      return { ok: false, reason: `http_${resp.status}` };
    }
    if (typeof resp.data !== 'object') {
      return { ok: false, reason: 'non_json_response' };
    }
    const states = resp.data.widgetStates || {};
    const key = Object.keys(states).find(k => k.startsWith('webPrice-'));
    if (!key) return { ok: false, reason: 'no_price_widget' };
    const w = states[key];
    const price = parsePrice(w.price);
    if (!price) return { ok: false, reason: 'unparseable_price' };
    return { ok: true, data: { item_id: String(productId), marketing_price: price, marketing_oa_price: parsePrice(w.cardPrice) || 0 } };
  } catch (e) {
    return { ok: false, reason: `error_${e.code || e.message || 'unknown'}` };
  }
}

// Простой пул с ограничением параллельности: сотни товаров по одному
// запросу на страницу каждый — без ограничения одновременных соединений это
// был бы слишком резкий всплеск нагрузки на публичный API за один прогон.
async function fetchPublicPrices(productIds) {
  const items = [];
  const reasonCounts = {};
  let i = 0;
  async function worker() {
    while (i < productIds.length) {
      const id = productIds[i++];
      const r = await fetchOne(id);
      if (r.ok) items.push(r.data);
      else reasonCounts[r.reason] = (reasonCounts[r.reason] || 0) + 1;
      await delay(150);
    }
  }
  const workers = Math.min(CONCURRENCY, productIds.length) || 1;
  await Promise.all(Array.from({ length: workers }, worker));
  return { items, reasonCounts };
}

module.exports = { fetchPublicPrices };
