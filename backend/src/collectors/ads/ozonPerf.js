const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('../../db');
const { getCabinet } = require('../../config/cabinets');

// Performance API Ozon — отдельный OAuth-токен (Client-Id + Client-Secret),
// не тот же Api-Key, что используется для остатков/заказов. Живёт на домене
// api-performance.ozon.ru (старый performance.ozon.ru — прежний домен, Ozon
// сам объявлял переезд). Токен живёт ~30 минут, поэтому получаем заново
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

// Пытаемся угадать, какому товару соответствует кампания — многие продавцы
// называют рекламную кампанию именем артикула (как в примере пользователя:
// кампания "Hv4-2KR" == артикул "Hv4-2KR"). Это эвристика: точного метода
// "кампания -> список SKU" в Performance API мы не нашли/не смогли
// подтвердить по документации (сайт закрыт для автоматического доступа),
// поэтому связываем по совпадению названия с offer_id из каталога, а если
// совпадения нет — строка просто остаётся без привязки к артикулу и видна
// в таблице по названию кампании.
function matchOfferByTitle(title, catalogByOfferId) {
  if (!title) return null;
  const t = title.trim().toLowerCase();
  if (catalogByOfferId.has(t)) return catalogByOfferId.get(t);
  for (const [offerId, row] of catalogByOfferId) {
    if (t.includes(offerId)) return row;
  }
  return null;
}

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
    // когда рекламу выключили — колонка "ОЗЗ вкл/выкл" в требуемой таблице).
    const { data } = await axios.get('https://api-performance.ozon.ru/api/client/campaign',
      { headers, timeout: 30000 });
    campaigns = data?.list || [];
  } catch(e) {
    console.warn(`[Ads Perf:${cabinet}] Список кампаний:`, e.response?.data || e.message);
    return 0;
  }

  // Каталог для попытки сматчить кампанию с артикулом.
  const catalogRows = await query(
    `SELECT offer_id, sku FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon'`,
    [cabinet]
  );
  const catalogByOfferId = new Map(catalogRows.map(r => [String(r.offer_id).toLowerCase(), r]));

  let total = 0;
  for (const camp of campaigns) {
    const match = matchOfferByTitle(camp.title, catalogByOfferId);
    try {
      await query(
        `INSERT INTO ad_campaigns (cabinet, platform, campaign_id, title, state, adv_object_type, matched_offer_id, matched_sku, updated_at)
         VALUES ($1,'ozon',$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (cabinet, platform, campaign_id) DO UPDATE SET
           title = EXCLUDED.title, state = EXCLUDED.state, adv_object_type = EXCLUDED.adv_object_type,
           matched_offer_id = EXCLUDED.matched_offer_id, matched_sku = EXCLUDED.matched_sku, updated_at = NOW()`,
        [cabinet, String(camp.id), camp.title || null, camp.state || null, camp.advObjectType || null,
         match?.offer_id || null, match?.sku || null]
      );
    } catch(e) { console.warn(`[Ads Perf:${cabinet}] Кампания ${camp.id}:`, e.message); }

    let rows = [];
    try {
      const { data } = await axios.get('https://api-performance.ozon.ru/api/client/statistics',
        { headers, params: { campaigns: [camp.id], dateFrom: from, dateTo: to, groupBy: 'DATE' }, timeout: 30000 });
      rows = data?.list || data?.rows || [];
    } catch(e) {
      console.warn(`[Ads Perf:${cabinet}] Статистика ${camp.id}:`, e.response?.data || e.message);
      await new Promise(r => setTimeout(r, 200));
      continue;
    }

    for (const row of rows) {
      const views = Number(row.views) || 0;
      const clicks = Number(row.clicks) || 0;
      try {
        await query(
          `INSERT INTO ad_stats_daily (cabinet, platform, date, campaign_id, views, clicks, ctr, spend, avg_bid, orders, orders_money)
           VALUES ($1,'ozon',$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (cabinet, platform, date, campaign_id) DO UPDATE SET
             views=EXCLUDED.views, clicks=EXCLUDED.clicks, ctr=EXCLUDED.ctr, spend=EXCLUDED.spend,
             avg_bid=EXCLUDED.avg_bid, orders=EXCLUDED.orders, orders_money=EXCLUDED.orders_money`,
          [cabinet, row.date, String(camp.id), views, clicks,
           row.ctr != null ? Number(row.ctr) : (views > 0 ? clicks / views * 100 : 0),
           Number(row.moneySpent) || 0, Number(row.avgBid) || 0,
           Number(row.orders) || 0, Number(row.ordersMoney) || 0]
        );
        total++;
      } catch(e) { /* skip */ }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`[Ads Perf:${cabinet}] Кампаний: ${campaigns.length}, строк статистики: ${total}`);
  return total;
}

module.exports = { collectAdStats };
