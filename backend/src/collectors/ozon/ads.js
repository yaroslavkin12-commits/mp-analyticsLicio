const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('../../db');

async function getToken() {
  const clientId = process.env.OZON_PERF_CLIENT_ID;
  const secret = process.env.OZON_PERF_SECRET;
  if (!clientId || !secret) return null;
  try {
    const { data } = await axios.post(
      'https://performance.ozon.ru/api/client/token',
      { client_id: clientId, client_secret: secret, grant_type: 'client_credentials' },
      { timeout: 15000 }
    );
    return data?.access_token || null;
  } catch (e) {
    console.warn('[Ozon Ads] Не удалось получить токен:', e.message);
    return null;
  }
}

async function collectAds(dateFrom) {
  const token = await getToken();
  if (!token) { console.log('[Ozon Ads] Performance API не настроен, пропуск'); return 0; }

  const from = dateFrom || dayjs().subtract(7, 'day').format('YYYY-MM-DD');
  const to = dayjs().format('YYYY-MM-DD');
  console.log(`[Ozon Ads] Реклама с ${from}...`);

  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let campaigns = [];

  try {
    const { data } = await axios.get('https://performance.ozon.ru/api/client/campaign', {
      headers: authHeaders,
      params: { state: 'CAMPAIGN_STATE_RUNNING' },
      timeout: 30000,
    });
    campaigns = data?.list || [];
  } catch (e) {
    console.warn('[Ozon Ads] Ошибка получения кампаний:', e.message);
    return 0;
  }

  let count = 0;
  for (const camp of campaigns) {
    try {
      const { data } = await axios.get('https://performance.ozon.ru/api/client/statistics', {
        headers: authHeaders,
        params: { campaigns: [camp.id], dateFrom: from, dateTo: to, groupBy: 'DATE' },
        timeout: 30000,
      });

      for (const row of (data?.list || [])) {
        try {
          await query(
            `INSERT INTO ozon_ads
              (date, campaign_id, campaign_name, campaign_type, views, clicks, ctr, spend, orders, revenue)
             VALUES (?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT (date, campaign_id) DO UPDATE SET
               views=EXCLUDED.views, clicks=EXCLUDED.clicks, spend=EXCLUDED.spend`,
            [
              row.date, camp.id, camp.title || null, camp.advObjectType || null,
              row.views || 0, row.clicks || 0, row.ctr || 0,
              row.moneySpent || 0, row.orders || 0, row.ordersMoney || 0,
            ]
          );
          count++;
        } catch (e) { /* skip */ }
      }
    } catch (e) {
      console.warn(`[Ozon Ads] Кампания ${camp.id}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`[Ozon Ads] Реклама сохранено: ${count}`);
  return count;
}

module.exports = { collectAds };
