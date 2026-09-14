const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('../../db');
const { getCabinet } = require('../../config/cabinets');

const delay = ms => new Promise(r => setTimeout(r, ms));

// Performance API Ozon — отдельный OAuth-токен (Client-Id + Client-Secret),
// не тот же Api-Key, что используется для остатков/заказов. Живёт на домене
// api-performance.ozon.ru. Токен живёт ~30 минут, поэтому получаем заново
// на каждый прогон сборщика, а не кэшируем между вызовами.
async function getToken(cfg) {
  if (!cfg.ozonPerfClientId || !cfg.ozonPerfSecret) return null;
  try {
    const { data } = await axios.post('https://api-performance.ozon.ru/api/client/token',
      { client_id: cfg.ozonPerfClientId, client_secret: cfg.ozonPerfSecret, grant_type: 'client_credentials' },
      { timeout: 15000 }
    );
    return data?.access_token || null;
  } catch(e) {
    console.warn('[Ads Perf] Токен:', e.response?.data || e.message);
    return null;
  }
}

// Запрос с retry на 429 (лимит запросов в секунду — та же проблема, что и
// у Seller API) — без этого один rate-limit на середине списка кампаний
// рвал бы привязку для всех оставшихся.
async function withRetry(fn, label) {
  for (let attempt = 0; attempt <= 4; attempt++) {
    try {
      return await fn();
    } catch(e) {
      const status = e.response?.status;
      if (status === 429 && attempt < 4) {
        const wait = 1200 * (attempt + 1);
        console.warn(`[Ads Perf] ${label}: лимит запросов (429), retry ${attempt + 1}/4 через ${wait}мс`);
        await delay(wait);
        continue;
      }
      throw e;
    }
  }
}

// Настоящая привязка кампании к товару — Ozon отдаёт список SKU, добавленных
// в конкретную РК (только для кампаний с оплатой за клик/охват по товарам;
// для остальных типов список пуст или эндпоинт недоступен). Это надёжнее,
// чем угадывать товар по названию кампании — угадывание не срабатывает,
// когда продавец называет кампанию по модели авто, а не по коду товара
// (например "1.Тест Женя Haval M6 ПОИСК" вместо "Hv4-2KR").
async function getCampaignSkus(campaignId, headers) {
  try {
    const data = await withRetry(() => axios.get(
      `https://api-performance.ozon.ru/api/client/campaign/${campaignId}/v2/products`,
      { headers, timeout: 15000 }
    ).then(r => r.data), `Товары РК ${campaignId}`);
    return (data?.products || []).map(p => String(p.sku)).filter(Boolean);
  } catch(e) {
    return [];
  }
}

// Резервный вариант для кампаний, где Ozon не отдал список товаров (баннеры,
// автопилот по всему магазину и т.п.) — угадываем по вхождению offer_id в
// название кампании, как раньше.
function matchOfferByTitle(title, catalogByOfferId) {
  if (!title) return null;
  const t = title.trim().toLowerCase();
  if (catalogByOfferId.has(t)) return catalogByOfferId.get(t);
  for (const [offerId, row] of catalogByOfferId) {
    if (offerId && t.includes(offerId)) return row;
  }
  return null;
}

// moneySpent у Ozon приходит строкой в русском формате с запятой как
// десятичным разделителем, например "4847,71".
function parseRuNumber(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  return Number(String(v).replace(',', '.')) || 0;
}

// Эта функция теперь отвечает ТОЛЬКО за метаданные кампаний и расход
// (GET .../statistics/expense/json — единственный синхронный эндпоинт,
// подтверждённый рабочим live-тестом). Воронка (показы/клики/корзины/заказы)
// берётся из общей аналитики по товару (ozonProductAnalytics.js), т.к.
// поштучная статистика по кампаниям (.../api/client/statistics) отдаёт 405 и
// не работает на этом аккаунте.
async function collectAdStats(cabinet, days) {
  const cfg = getCabinet(cabinet);
  const token = await getToken(cfg);
  if (!token) {
    console.log(`[Ads Perf:${cabinet}] Performance API не настроен`);
    return 0;
  }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const from = dayjs().subtract(days || 30, 'day').format('YYYY-MM-DD');
  const to = dayjs().format('YYYY-MM-DD');

  let campaigns = [];
  try {
    // Без фильтра по state — нужны и остановленные кампании тоже (видеть,
    // когда рекламу выключили).
    const { data } = await axios.get('https://api-performance.ozon.ru/api/client/campaign',
      { headers, timeout: 30000 });
    campaigns = data?.list || [];
  } catch(e) {
    console.warn(`[Ads Perf:${cabinet}] Список кампаний:`, e.response?.data || e.message);
    return 0;
  }

  // Каталог для сопоставления кампании с артикулом — по SKU (надёжно) и как
  // запасной вариант по вхождению offer_id в название (угадывание).
  const catalogRows = await query(
    `SELECT offer_id, sku FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon'`,
    [cabinet]
  );
  const catalogByOfferId = new Map(catalogRows.map(r => [String(r.offer_id).toLowerCase(), r]));
  const catalogBySku = new Map(catalogRows.filter(r => r.sku != null).map(r => [String(r.sku), r]));

  for (const camp of campaigns) {
    let match = null;
    // Настоящая привязка через API — только для активных/недавних кампаний
    // с оплатой за клик, чтобы не тратить сотни запросов на старые
    // архивные/выключенные кампании без шанса на успех.
    if (camp.state !== 'CAMPAIGN_STATE_ARCHIVED' && camp.state !== 'CAMPAIGN_STATE_FINISHED') {
      const skus = await getCampaignSkus(camp.id, headers);
      for (const sku of skus) {
        if (catalogBySku.has(sku)) { match = catalogBySku.get(sku); break; }
      }
      await delay(350);
    }
    if (!match) match = matchOfferByTitle(camp.title, catalogByOfferId);
    try {
      await query(
        `INSERT INTO ad_campaigns (cabinet, platform, campaign_id, title, state, adv_object_type, matched_offer_id, matched_sku,
                                    payment_type, autopilot_strategy, placement, expense_strategy, updated_at)
         VALUES ($1,'ozon',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
         ON CONFLICT (cabinet, platform, campaign_id) DO UPDATE SET
           title = EXCLUDED.title, state = EXCLUDED.state, adv_object_type = EXCLUDED.adv_object_type,
           matched_offer_id = EXCLUDED.matched_offer_id, matched_sku = EXCLUDED.matched_sku,
           payment_type = EXCLUDED.payment_type, autopilot_strategy = EXCLUDED.autopilot_strategy,
           placement = EXCLUDED.placement, expense_strategy = EXCLUDED.expense_strategy, updated_at = NOW()`,
        [cabinet, String(camp.id), camp.title || null, camp.state || null, camp.advObjectType || null,
         match?.offer_id || null, match?.sku || null,
         camp.PaymentType || camp.paymentType || null,
         camp.productAutopilotStrategy || null,
         Array.isArray(camp.placement) ? camp.placement.join(',') : (camp.placement || null),
         camp.expenseStrategy || null]
      );
    } catch(e) { console.warn(`[Ads Perf:${cabinet}] Кампания ${camp.id}:`, e.message); }
  }

  // Расход — одним вызовом на весь период; параметр campaigns на этом
  // эндпоинте на практике не фильтрует (Ozon отдаёт все кампании в любом
  // случае), поэтому запрашиваем сразу все и раскладываем по campaign_id
  // локально — так надёжнее и не требует N вызовов на N кампаний.
  let expenseRows = [];
  try {
    const { data } = await axios.get('https://api-performance.ozon.ru/api/client/statistics/expense/json',
      { headers, params: { dateFrom: from, dateTo: to }, timeout: 30000 });
    expenseRows = data?.rows || data?.list || (Array.isArray(data) ? data : []);
  } catch(e) {
    console.warn(`[Ads Perf:${cabinet}] Расход:`, e.response?.data || e.message);
  }

  let total = 0;
  for (const row of expenseRows) {
    const campaignId = String(row.id ?? row.campaignId ?? row.campaign_id ?? '');
    const date = row.date;
    if (!campaignId || !date) continue;
    const spend = parseRuNumber(row.moneySpent);
    try {
      await query(
        `INSERT INTO ad_stats_daily (cabinet, platform, date, campaign_id, spend)
         VALUES ($1,'ozon',$2,$3,$4)
         ON CONFLICT (cabinet, platform, date, campaign_id) DO UPDATE SET spend = EXCLUDED.spend`,
        [cabinet, date, campaignId, spend]
      );
      total++;
    } catch(e) { console.warn(`[Ads Perf:${cabinet}] Расход ${campaignId}/${date}:`, e.message); }
  }

  console.log(`[Ads Perf:${cabinet}] Кампаний: ${campaigns.length}, строк расхода: ${total}`);
  return total;
}

module.exports = { collectAdStats };
