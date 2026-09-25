const axios = require('axios');
const { getCabinet } = require('../../config/cabinets');
const { delay } = require('./ozonHttp');

// Реальная цена на витрине Ozon с учётом Соинвестирования в скидку НЕ
// приходит из публичного Seller API (проверено на живых данных: поле
// marketing_price там просто отсутствует). Она есть только во внутреннем
// (недокументированном) методе самого кабинета продавца — том же, которым
// пользуется страница "Цены и акции" в seller.ozon.ru:
//
//   POST https://seller.ozon.ru/api/pricing-bff-service/v3/get-common-prices
//   body: { company_id, item_ids: [...] }
//   ответ: { items: [{ item_id, price, old_price,
//                       marketing_price,     — цена на сайте (обычная)
//                       marketing_oa_price,   — цена с Ozon Картой
//                       marketing_seller_price }] }
//
// item_id здесь — это тот же product_id, что отдаёт публичный Seller API
// (сверено вживую: offer_id=HoodMen-11XL → product_id=3943282677 совпадает
// с item_id в этом методе).
//
// Метод требует не Client-Id/Api-Key, а cookie авторизованной сессии
// браузера в кабинете (плюс company_id вместо client_id) — так же, как
// получают эти цифры репрайсеры. Cookie достаётся вручную один раз через
// DevTools (Network → запрос get-common-prices → Copy → Copy as cURL) и
// кладётся в переменную окружения. Раз в какое-то время сессия будет
// протухать — тогда сборщик логирует предупреждение и шлёт алерт в
// Telegram, чтобы cookie обновили.

const ENDPOINT = 'https://seller.ozon.ru/api/pricing-bff-service/v3/get-common-prices';
const BATCH = 200;

function sessionConfig(cabinet) {
  const cfg = getCabinet(cabinet);
  if (!cfg.ozonSellerCookie || !cfg.ozonCompanyId) return null;
  return { cookie: cfg.ozonSellerCookie, companyId: cfg.ozonCompanyId };
}

// Последнее известное состояние сессии по кабинету — чтобы не слать одно и
// то же предупреждение на каждый прогон (раз в 20 минут), а только когда
// статус реально меняется (была живая — стала мёртвая).
const sessionAlive = new Map(); // cabinet -> bool | undefined

async function fetchCommonPrices(cabinet, productIds) {
  const sess = sessionConfig(cabinet);
  if (!sess) return { items: [], sessionMissing: true };
  if (!productIds.length) return { items: [] };

  const items = [];
  for (let i = 0; i < productIds.length; i += BATCH) {
    const part = productIds.slice(i, i + BATCH);
    let data;
    try {
      const resp = await axios.post(ENDPOINT,
        { company_id: String(sess.companyId), item_ids: part.map(String) },
        {
          timeout: 30000,
          headers: {
            accept: 'application/json, text/plain, */*',
            'accept-language': 'ru',
            'content-type': 'application/json',
            Cookie: sess.cookie,
            origin: 'https://seller.ozon.ru',
            referer: 'https://seller.ozon.ru/app/prices/control',
            'sec-ch-ua': '"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"macOS"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
            'x-o3-app-name': 'seller-ui',
            'x-o3-company-id': String(sess.companyId),
            'x-o3-language': 'ru',
            'x-o3-page-type': 'prices',
          },
          // Ozon отдаёт HTML-страницу логина (или редирект-цепочку) вместо
          // JSON, когда сессия протухла или запрос не похож на браузерный —
          // не считаем это транспортной ошибкой, сами решаем по статусу.
          maxRedirects: 0,
          validateStatus: () => true,
        });
      if (resp.status !== 200 || typeof resp.data !== 'object') {
        if (sessionAlive.get(cabinet) !== false) {
          console.warn(`[OzonInternal:${cabinet}] сессия кабинета недоступна (статус ${resp.status}) — нужно обновить cookie`);
        }
        sessionAlive.set(cabinet, false);
        return { items, sessionExpired: true };
      }
      data = resp.data;
    } catch (e) {
      console.warn(`[OzonInternal:${cabinet}] ошибка запроса цен: ${e.message}`);
      return { items, sessionExpired: false, error: e.message };
    }
    if (sessionAlive.get(cabinet) !== true) {
      console.log(`[OzonInternal:${cabinet}] сессия кабинета активна`);
    }
    sessionAlive.set(cabinet, true);
    items.push(...(data.items || []));
    if (i + BATCH < productIds.length) await delay(400);
  }
  return { items };
}

module.exports = { fetchCommonPrices, sessionConfig };
