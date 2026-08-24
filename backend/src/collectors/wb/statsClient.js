const axios = require('axios');

// Общий rate-limiter для статистического API WB (statistics-api.wildberries.ru).
// orders/sales/stocks используют один и тот же лимит на токен (около 1 запроса в минуту),
// а не отдельный лимит на каждый эндпоинт. Раньше каждый коллектор ждал свои 5-7 секунд
// независимо от других — этого хватало, чтобы не столкнуться с самим собой, но недостаточно,
// чтобы не столкнуться с соседним коллектором, который сработал через несколько секунд.
// В логе сборов это было видно как систематические "429 rate limit" на orders и sales.
// Здесь пауза считается от последнего запроса к statistics-api ЛЮБЫМ коллектором.
const MIN_INTERVAL_MS = 61000;
let lastCallAt = 0;

async function throttle() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) {
    console.log(`[WB] Статистика: пауза ${Math.ceil(wait / 1000)}с перед запросом (общий rate-limit)`);
    await new Promise(r => setTimeout(r, wait));
  }
}

// GET-запрос к statistics-api.wildberries.ru с общим троттлингом и повтором при 429.
async function statsGet(url, token, params, { retries = 2, timeout = 90000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle();
    lastCallAt = Date.now();
    try {
      const resp = await axios.get(url, { headers: { Authorization: token }, params, timeout });
      return resp.data;
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      if (status === 429) {
        if (attempt < retries) {
          const retryAfterSec = Number(e.response.headers?.['retry-after']) || 65;
          console.warn(`[WB] ${url}: 429, ждём ${retryAfterSec}с и повторяем (попытка ${attempt + 1}/${retries})`);
          await new Promise(r => setTimeout(r, retryAfterSec * 1000));
          lastCallAt = Date.now(); // засчитываем и это ожидание в общий лимит
          continue;
        }
        throw new Error('WB rate limit (429) — повторите позже');
      }
      if (status === 401) throw new Error('WB токен недействителен (401)');
      throw new Error(`WB stats error: ${e.message}`);
    }
  }
  throw lastErr;
}

module.exports = { statsGet };
