const express = require('express');
const router = express.Router();
const dayjs = require('dayjs');
const { query } = require('../db');
const { listCabinets } = require('../config/cabinets');
const { collectCatalog } = require('../collectors/ads/ozonCatalog');
const { collectAdStats } = require('../collectors/ads/ozonPerf');
const { collectProductAnalytics } = require('../collectors/ads/ozonProductAnalytics');

// GET /api/ads/cabinets — список кабинетов и что для них настроено (видно
// в интерфейсе, какие токены ещё нужно добавить в Render).
router.get('/cabinets', (req, res) => {
  res.json({ success: true, data: listCabinets() });
});

// POST /api/ads/collect?cabinet=defly&days=30 — ручной запуск сбора рекламной
// статистики для кабинета. Нужен, пока Defly не в общем расписании сборщиков.
router.post('/collect', async (req, res) => {
  const cabinet = req.query.cabinet || req.body?.cabinet;
  const days = parseInt(req.query.days || req.body?.days, 10) || 30;
  if (!cabinet) return res.status(400).json({ success: false, error: 'Нужен параметр cabinet' });

  res.json({ success: true, message: `Сбор запущен для кабинета ${cabinet}` });
  setTimeout(async () => {
    try {
      console.log(`[Ads] Сбор для ${cabinet}: каталог...`);
      await collectCatalog(cabinet);
      console.log(`[Ads] Сбор для ${cabinet}: реклама (Performance API)...`);
      await collectAdStats(cabinet, days);
      console.log(`[Ads] Сбор для ${cabinet}: аналитика по товарам...`);
      await collectProductAnalytics(cabinet, days);
      console.log(`[Ads] Сбор для ${cabinet}: готово`);
    } catch(e) {
      console.error(`[Ads] Сбор для ${cabinet} упал:`, e.message);
    }
  }, 100);
});

// GET /api/ads/stats?cabinet=defly&days=30 — сводная таблица по дням для
// вкладки "Реклама": строка = кампания (обычно = артикул, если кампания
// названа как товар), колонки = метрики по каждому дню.
router.get('/stats', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'defly';
    const days = Math.min(60, Math.max(7, parseInt(req.query.days, 10) || 30));
    const from = dayjs().subtract(days, 'day').format('YYYY-MM-DD');
    const to = dayjs().format('YYYY-MM-DD');

    const [campaigns, adRows, analyticsRows] = await Promise.all([
      query(`SELECT campaign_id, title, state, adv_object_type, matched_offer_id, matched_sku
             FROM ad_campaigns WHERE cabinet = $1 AND platform = 'ozon'`, [cabinet]),
      query(`SELECT date::text as date, campaign_id, views, clicks, ctr, spend, avg_bid, orders, orders_money
             FROM ad_stats_daily WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3`,
             [cabinet, from, to]),
      query(`SELECT date::text as date, sku, offer_id, hits_view, hits_view_search, hits_view_pdp,
                    hits_tocart, orders_item, revenue, position_category
             FROM product_analytics_daily WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3`,
             [cabinet, from, to]),
    ]);

    const dates = [];
    for (let i = days; i >= 0; i--) dates.push(dayjs().subtract(i, 'day').format('YYYY-MM-DD'));

    // Аналитика по товару, индексированная по sku|date — джойним к кампаниям
    // через matched_sku (см. комментарий в ozonPerf.js про сопоставление по
    // названию кампании).
    const analyticsByKey = new Map();
    for (const r of analyticsRows) analyticsByKey.set(`${r.sku}|${r.date}`, r);

    const adByKey = new Map();
    for (const r of adRows) adByKey.set(`${r.campaign_id}|${r.date}`, r);

    const campaignsOut = campaigns.map(camp => {
      const byDate = {};
      for (const date of dates) {
        const ad = adByKey.get(`${camp.campaign_id}|${date}`);
        const an = camp.matched_sku ? analyticsByKey.get(`${camp.matched_sku}|${date}`) : null;

        const views = an ? Number(an.hits_view) : 0;
        const clicks = ad ? Number(ad.clicks) : 0;
        const cart = an ? Number(an.hits_tocart) : 0;
        const orders = an ? Number(an.orders_item) : (ad ? Number(ad.orders) : 0);
        const revenue = an ? Number(an.revenue) : (ad ? Number(ad.orders_money) : 0);
        const spend = ad ? Number(ad.spend) : 0;

        byDate[date] = {
          orders_money: revenue,
          orders_units: orders,
          position: an?.position_category != null ? Number(an.position_category) : null,
          views: an ? views : (ad ? Number(ad.views) : 0),
          clicks: ad ? Number(ad.clicks) : 0,
          ctr: ad ? Number(ad.ctr) : (views > 0 ? clicks / views * 100 : 0),
          cart,
          cr_to_cart: views > 0 ? cart / views * 100 : 0,
          cr_to_order: cart > 0 ? orders / cart * 100 : (views > 0 ? orders / views * 100 : 0),
          bid: ad ? Number(ad.avg_bid) : null,
          spend,
          drr: revenue > 0 ? spend / revenue * 100 : (spend > 0 ? 100 : 0),
          adOn: ad ? true : null, // была ли в этот день статистика по кампании — прокси для "ОЗЗ вкл"
        };
      }
      return {
        campaignId: camp.campaign_id,
        title: camp.title,
        state: camp.state,
        offerId: camp.matched_offer_id,
        byDate,
      };
    });

    res.json({ success: true, data: { dates, campaigns: campaignsOut } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ВРЕМЕННЫЙ debug-роут: сырые ответы Performance API без записи в базу —
// нужен, чтобы свериться с реальными именами полей (документация Ozon
// закрыта для автоматического доступа, поэтому часть парсинга — по best
// effort из вторичных источников).
router.get('/debug-raw', async (req, res) => {
  const axios = require('axios');
  const dayjs = require('dayjs');
  const { getCabinet } = require('../config/cabinets');
  try {
    const cabinet = req.query.cabinet || 'defly';
    const cfg = getCabinet(cabinet);
    const out = {};

    const tokenResp = await axios.post('https://api-performance.ozon.ru/api/client/token',
      { client_id: cfg.ozonPerfClientId, client_secret: cfg.ozonPerfSecret, grant_type: 'client_credentials' },
      { timeout: 15000 }
    ).catch(e => ({ error: e.response?.data || e.message }));
    out.token = tokenResp.error ? tokenResp : { ok: true, expires_in: tokenResp.data?.expires_in };
    const token = tokenResp.data?.access_token;
    if (!token) { return res.json({ success: true, data: out }); }

    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const campResp = await axios.get('https://api-performance.ozon.ru/api/client/campaign',
      { headers, timeout: 30000 }
    ).catch(e => ({ error: e.response?.data || e.message }));
    out.campaigns = campResp.error ? campResp : campResp.data;

    const skuCampaigns = (campResp.data?.list || []).filter(c => c.advObjectType === 'SKU');
    const firstCampaign = skuCampaigns[0] || campResp.data?.list?.[0];
    if (firstCampaign) {
      const from = dayjs().subtract(14, 'day').format('YYYY-MM-DD');
      const to = dayjs().format('YYYY-MM-DD');

      // Пробуем несколько вариантов, т.к. по вторичным источникам не удалось
      // однозначно подтвердить, GET это или POST и на каком домене.
      const attempts = [];

      const postJson = await axios.post('https://api-performance.ozon.ru/api/client/statistics/json',
        { campaigns: [String(firstCampaign.id)], dateFrom: from, dateTo: to, groupBy: 'DATE' },
        { headers, timeout: 30000 }
      ).catch(e => ({ error: e.response?.data || e.message, status: e.response?.status }));
      attempts.push({ name: 'POST /statistics/json', result: postJson.error ? postJson : postJson.data });

      const expenseResp = await axios.get('https://api-performance.ozon.ru/api/client/statistics/expense/json',
        { headers, params: { campaigns: [firstCampaign.id], dateFrom: from, dateTo: to }, timeout: 30000 }
      ).catch(e => ({ error: e.response?.data || e.message, status: e.response?.status }));
      attempts.push({ name: 'GET /statistics/expense/json', result: expenseResp.error ? expenseResp : expenseResp.data });

      out.statisticsAttempts = attempts;
      out.testedCampaignId = firstCampaign.id;
      out.testedCampaignTitle = firstCampaign.title;
    }

    res.json({ success: true, data: out });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
