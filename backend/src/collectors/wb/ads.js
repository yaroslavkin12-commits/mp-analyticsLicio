const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('../../db');

async function collectAds(dateFrom) {
  const token = process.env.WB_TOKEN;
  if (!token) throw new Error('WB_TOKEN не задан');

  const from = dateFrom || dayjs().subtract(7, 'day').format('YYYY-MM-DD');
  const to = dayjs().format('YYYY-MM-DD');
  console.log(`[WB] Реклама с ${from}...`);

  // Список кампаний
  let campaigns = [];
  try {
    const { data } = await axios.get('https://advert-api.wb.ru/adv/v1/promotion/count', {
      headers: { Authorization: token },
      timeout: 30000,
    });
    if (data?.adverts) {
      for (const group of data.adverts) {
        if (group.advert_list) {
          campaigns.push(...group.advert_list.map(a => a.advertId));
        }
      }
    }
  } catch (e) {
    console.warn('[WB] Реклама: не удалось получить список кампаний:', e.message);
    return 0;
  }

  if (!campaigns.length) { console.log('[WB] Нет рекламных кампаний'); return 0; }

  let count = 0;
  const chunkSize = 100;

  for (let i = 0; i < campaigns.length; i += chunkSize) {
    const chunk = campaigns.slice(i, i + chunkSize);
    try {
      const { data } = await axios.post(
        'https://advert-api.wb.ru/adv/v2/fullstats',
        chunk.map(id => ({ id, dates: [from, to] })),
        { headers: { Authorization: token, 'Content-Type': 'application/json' }, timeout: 60000 }
      );

      for (const camp of (data || [])) {
        for (const day of (camp.days || [])) {
          for (const app of (day.apps || [{ nm: day.nm }])) {
            for (const nm of (app.nm || [])) {
              try {
                await query(
                  `INSERT INTO wb_ads
                    (date, campaign_id, campaign_name, nm_id, views, clicks, ctr, cpc, spend, orders, revenue)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT (date, campaign_id, nm_id) DO UPDATE SET
                     views=EXCLUDED.views, clicks=EXCLUDED.clicks, spend=EXCLUDED.spend`,
                  [
                    day.date, camp.advertId, camp.name || null, nm.nmId || null,
                    nm.views || 0, nm.clicks || 0, nm.ctr || 0, nm.cpc || 0,
                    nm.sum || 0, nm.orders || 0, nm.sum_price || 0,
                  ]
                );
                count++;
              } catch (e) { /* skip */ }
            }
          }
        }
      }
    } catch (e) {
      console.warn('[WB] Реклама chunk error:', e.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`[WB] Реклама сохранено: ${count}`);
  return count;
}

module.exports = { collectAds };
