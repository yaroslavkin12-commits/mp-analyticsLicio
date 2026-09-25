const axios = require('axios');
const { delay } = require('./ozonHttp');

// Реальная цена на витрине Ozon (с учётом Соинвестирования в скидку) — из
// ПУБЛИЧНОЙ страницы товара, без какой-либо авторизации кабинета продавца.
//
// Раньше здесь использовался внутренний (недокументированный) метод самого
// кабинета продавца — get-common-prices с cookie авторизованной сессии
// браузера (см. историю ozonInternalPrices.js). Отказались от него: даже со
// свежей валидной cookie антибот-защита Ozon блокирует запросы с серверных
// (датацентровых) IP.
//
// ВАЖНО (диагностика от 25.09): и "публичная" страница товара с IP Render
// блокируется тем же антиботом — часть запросов зацикливается на редиректах
// (ERR_FR_TOO_MANY_REDIRECTS), часть виснет без ответа до таймаута
// (ECONNABORTED). Т.е. дело не в том, что мы стучимся не туда, а в том, что
// антибот Ozon распознаёт сам факт запроса с датацентрового IP (Render,
// AWS и т.п.), а не конкретный путь/авторизацию. Ниже — попытки обойтись
// более "браузерными" запросами (полный набор заголовков, отключенные
// авторедиректы с логированием реальной Location, HTTP keep-alive агент,
// меньше параллельности) прежде чем переходить на платный residential-прокси.
//
//   GET https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=/product/<product_id>/
//   → widgetStates["webPrice-...-default-1"] = {
//       price: "4 416 ₽",       — обычная цена на витрине
//       cardPrice: "3 979 ₽",   — цена с банковской картой Ozon
//     }
//
// Разница между ценой продавца (marketing_seller_price из официального
// Seller API) и этой витринной ценой — и есть размер Соинвеста.

const http = require('http');
const https = require('https');

const ENDPOINT = 'https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2';
const CONCURRENCY = 2; // антибот может реагировать и на частоту — снижено с 6
const TIMEOUT = 12000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// keep-alive агент — обычный браузер не открывает новое TCP-соединение на
// каждый запрос, а датацентровые антиботы иногда как раз смотрят на этот
// паттерн (короткоживущие соединения пачками).
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: CONCURRENCY });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });

const BROWSER_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'accept-encoding': 'gzip, deflate, br',
  'user-agent': UA,
  'sec-ch-ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  referer: 'https://www.ozon.ru/',
  origin: 'https://www.ozon.ru',
};

function parsePrice(v) {
  if (v == null) return 0;
  const cleaned = String(v).replace(/[^\d,.-]/g, '').replace(',', '.');
  return Number(cleaned) || 0;
}

// Диагностика от 25.09 показала: КАЖДЫЙ запрос получает 307 на тот же URL с
// добавленным "&__rr=1" — это не бесконечный бан, а анти-бот, который на
// первый запрос от незнакомого клиента отвечает редиректом + Set-Cookie
// (обычно что-то вроде __Secure-ab-group / xxxxx), ожидая, что клиент
// вернётся с этой cookie на втором заходе. Обычный браузер (fetch/XHR) это
// делает автоматически и невидимо; axios без cookie-jar — нет, поэтому
// раньше (с maxRedirects по умолчанию) получался бесконечный цикл
// (ERR_FR_TOO_MANY_REDIRECTS): каждый повтор редиректа шёл БЕЗ cookie.
// Здесь эмулируем ровно то, что делает браузер: один шаг вручную — взять
// Set-Cookie из 307-ответа и повторить запрос на Location с этой cookie.
function extractCookieHeader(setCookieHeader) {
  if (!setCookieHeader) return '';
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  return arr.map(c => c.split(';')[0]).join('; ');
}

async function requestOnce(url, cookie) {
  return axios.get(url, {
    timeout: TIMEOUT,
    headers: cookie ? { ...BROWSER_HEADERS, cookie } : BROWSER_HEADERS,
    httpsAgent, httpAgent,
    maxRedirects: 0,
    validateStatus: () => true,
  });
}

// Возвращает { ok: true, data } либо { ok: false, reason, detail } — detail
// нужен только для диагностики (см. fetchPublicPrices: первый образец на
// каждую причину логируется отдельно), в основной логике не участвует.
async function fetchOne(productId) {
  const initialUrl = `${ENDPOINT}?url=${encodeURIComponent(`/product/${productId}/`)}`;
  try {
    let resp = await requestOnce(initialUrl, '');
    let cookie = '';
    let hops = 0;
    // До 3 редиректов подряд, каждый раз донося cookie дальше — обычный
    // браузер именно так и работает, никакого зацикливания при этом нет,
    // если сервер реально ожидает вернувшуюся cookie, а не банит совсем.
    while (resp.status >= 300 && resp.status < 400 && hops < 3) {
      const location = resp.headers?.location;
      if (!location) return { ok: false, reason: `redirect_${resp.status}_no_location` };
      cookie = extractCookieHeader(resp.headers?.['set-cookie']) || cookie;
      const target = location.startsWith('http') ? location : new URL(location, ENDPOINT).toString();
      resp = await requestOnce(target, cookie);
      hops++;
    }
    if (resp.status >= 300 && resp.status < 400) {
      return { ok: false, reason: `redirect_loop_${resp.status}`, detail: resp.headers?.location || '(нет Location)' };
    }
    if (resp.status !== 200) {
      const snippet = typeof resp.data === 'string' ? resp.data.slice(0, 200) : JSON.stringify(resp.data).slice(0, 200);
      return { ok: false, reason: `http_${resp.status}`, detail: snippet };
    }
    if (typeof resp.data !== 'object') {
      return { ok: false, reason: 'non_json_response', detail: String(resp.data).slice(0, 200) };
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
  const reasonSamples = {};
  let i = 0;
  async function worker() {
    while (i < productIds.length) {
      const id = productIds[i++];
      const r = await fetchOne(id);
      if (r.ok) {
        items.push(r.data);
      } else {
        reasonCounts[r.reason] = (reasonCounts[r.reason] || 0) + 1;
        if (r.detail && !reasonSamples[r.reason]) reasonSamples[r.reason] = r.detail;
      }
      await delay(250 + Math.floor(Math.random() * 200)); // джиттер вместо ровного интервала
    }
  }
  const workers = Math.min(CONCURRENCY, productIds.length) || 1;
  await Promise.all(Array.from({ length: workers }, worker));
  return { items, reasonCounts, reasonSamples };
}

module.exports = { fetchPublicPrices };
