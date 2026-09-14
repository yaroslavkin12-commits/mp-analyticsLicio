const express = require('express');
const router = express.Router();
const dayjs = require('dayjs');
const { query } = require('../db');
const { listCabinets } = require('../config/cabinets');
const { collectCatalog } = require('../collectors/ads/ozonCatalog');
const { collectAdStats } = require('../collectors/ads/ozonPerf');
const { collectProductAnalytics } = require('../collectors/ads/ozonProductAnalytics');
const { saveRunStatus, isRunActive } = require('../collectors/ads/runStatus');

// GET /api/ads/cabinets — список кабинетов и что для них настроено (видно
// в интерфейсе, какие токены ещё нужно добавить в Render).
router.get('/cabinets', (req, res) => {
  res.json({ success: true, data: listCabinets() });
});

// POST /api/ads/collect?cabinet=defly&days=30 — ручной запуск сбора рекламной
// статистики для кабинета. Нужен, пока Defly не в общем расписании сборщиков.
//
// Статус последнего фонового сбора раньше хранился только в памяти процесса
// и пропадал бесследно при рестарте — вынесено в отдельный модуль
// collectors/ads/runStatus.js, общий с планировщиком (scheduler.js), чтобы
// оба места, откуда может запуститься сбор для кабинета, не запускали его
// друг на друга одновременно (см. подробности в runStatus.js).

router.post('/collect', async (req, res) => {
  const cabinet = req.query.cabinet || req.body?.cabinet;
  const days = parseInt(req.query.days || req.body?.days, 10) || 30;
  if (!cabinet) return res.status(400).json({ success: false, error: 'Нужен параметр cabinet' });

  if (await isRunActive(cabinet)) {
    return res.json({ success: false, message: `Сбор для кабинета ${cabinet} уже идёт — дождитесь завершения` });
  }

  res.json({ success: true, message: `Сбор запущен для кабинета ${cabinet}` });
  const startedAt = new Date().toISOString();
  await saveRunStatus(cabinet, { startedAt, step: 'catalog', error: null, finishedAt: null, detail: null });
  setTimeout(async () => {
    try {
      console.log(`[Ads] Сбор для ${cabinet}: каталог...`);
      await collectCatalog(cabinet);
      await saveRunStatus(cabinet, { step: 'ad_stats' });
      console.log(`[Ads] Сбор для ${cabinet}: реклама (Performance API)...`);
      await collectAdStats(cabinet, days);
      await saveRunStatus(cabinet, { step: 'product_analytics' });
      console.log(`[Ads] Сбор для ${cabinet}: аналитика по товарам...`);
      await collectProductAnalytics(cabinet, days);
      await saveRunStatus(cabinet, { step: 'done', finishedAt: new Date().toISOString() });
      console.log(`[Ads] Сбор для ${cabinet}: готово`);
    } catch(e) {
      const errMsg = JSON.stringify(e.response?.data || null) || e.message || String(e);
      await saveRunStatus(cabinet, { error: errMsg, finishedAt: new Date().toISOString() });
      console.error(`[Ads] Сбор для ${cabinet} упал:`, e.response?.data || e.message || e);
    }
  }, 100);
});

// GET /api/ads/stats?cabinet=defly&days=30 — сводка для вкладки "Реклама",
// сгруппированная по артикулу (а не по кампании), т.к. на один артикул может
// быть запущено сразу несколько РК. Внутри каждого артикула — список его
// кампаний (метаданные + расход по дням) и метрики воронки, общие для всех
// его кампаний, взятые из общей аналитики по товару (product_analytics_daily,
// та же логика, что и на Дашборде), а НЕ из статистики самой РК — так как
// поштучная статистика по кампаниям в Performance API не работает.
router.get('/stats', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'defly';
    const days = Math.min(60, Math.max(7, parseInt(req.query.days, 10) || 30));
    const from = dayjs().subtract(days, 'day').format('YYYY-MM-DD');
    const to = dayjs().format('YYYY-MM-DD');

    const [campaigns, adRows, analyticsRows, catalogRows] = await Promise.all([
      query(`SELECT campaign_id, title, state, adv_object_type, matched_offer_id, matched_sku,
                    payment_type, autopilot_strategy, placement, expense_strategy
             FROM ad_campaigns WHERE cabinet = $1 AND platform = 'ozon'`, [cabinet]),
      query(`SELECT date::text as date, campaign_id, spend
             FROM ad_stats_daily WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3`,
             [cabinet, from, to]),
      query(`SELECT date::text as date, sku, offer_id, hits_view, hits_view_search, hits_view_pdp,
                    hits_tocart, orders_item, revenue, position_category
             FROM product_analytics_daily WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3`,
             [cabinet, from, to]),
      query(`SELECT offer_id, sku, product_name FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon'`,
             [cabinet]),
    ]);

    const dates = [];
    for (let i = days; i >= 0; i--) dates.push(dayjs().subtract(i, 'day').format('YYYY-MM-DD'));

    const analyticsByKey = new Map(); // sku|date -> row
    for (const r of analyticsRows) analyticsByKey.set(`${r.sku}|${r.date}`, r);

    const spendByKey = new Map(); // campaignId|date -> spend
    for (const r of adRows) spendByKey.set(`${r.campaign_id}|${r.date}`, Number(r.spend) || 0);

    const nameByOfferId = new Map(catalogRows.map(r => [r.offer_id, r.product_name]));

    // Группируем кампании по matched_offer_id — так на один артикул попадают
    // все его РК. Кампании без привязки к артикулу идут в отдельную группу
    // "unmatched", видимую по названию кампании.
    const byArticle = new Map();
    function getArticle(offerId, sku) {
      const key = offerId || '__unmatched__';
      if (!byArticle.has(key)) {
        byArticle.set(key, {
          offerId: offerId || null,
          sku: sku || null,
          productName: offerId ? (nameByOfferId.get(offerId) || null) : null,
          campaigns: [],
        });
      }
      return byArticle.get(key);
    }

    for (const camp of campaigns) {
      const article = getArticle(camp.matched_offer_id, camp.matched_sku);
      const byDate = {};
      let totalSpend = 0;
      for (const date of dates) {
        const spend = spendByKey.get(`${camp.campaign_id}|${date}`) || 0;
        totalSpend += spend;
        byDate[date] = { spend };
      }
      article.campaigns.push({
        campaignId: camp.campaign_id,
        title: camp.title,
        state: camp.state,
        advObjectType: camp.adv_object_type,
        paymentType: camp.payment_type,
        autopilotStrategy: camp.autopilot_strategy,
        placement: camp.placement,
        expenseStrategy: camp.expense_strategy,
        totalSpend,
        byDate,
      });
    }

    // Метрики воронки по артикулу — общие для всех его кампаний, из
    // product_analytics_daily по matched_sku. Считаем по дням и суммарно за
    // весь выбранный период (для ДРР).
    const articlesOut = [];
    for (const [, article] of byArticle) {
      const byDate = {};
      let totalRevenue = 0, totalOrders = 0, totalViews = 0, totalPdpViews = 0, totalCart = 0;
      for (const date of dates) {
        const an = article.sku ? analyticsByKey.get(`${article.sku}|${date}`) : null;
        const views = an ? Number(an.hits_view) || 0 : 0;
        const pdpViews = an ? Number(an.hits_view_pdp) || 0 : 0;
        const cart = an ? Number(an.hits_tocart) || 0 : 0;
        const orders = an ? Number(an.orders_item) || 0 : 0;
        const revenue = an ? Number(an.revenue) || 0 : 0;
        const position = an?.position_category != null ? Number(an.position_category) : null;

        totalRevenue += revenue; totalOrders += orders; totalViews += views; totalPdpViews += pdpViews; totalCart += cart;

        byDate[date] = {
          views,
          pdpViews,
          ctr: views > 0 ? pdpViews / views * 100 : 0,
          cart,
          crToCart: views > 0 ? cart / views * 100 : 0,
          crToOrder: cart > 0 ? orders / cart * 100 : 0,
          orders,
          revenue,
          position,
        };
      }

      // ДРР по каждой РК: расход этой РК за период / выручка артикула за
      // период * 100. Общий ДРР артикула: сумма расходов ВСЕХ его РК за
      // период / выручка артикула за период * 100.
      let totalSpendAllCampaigns = 0;
      for (const camp of article.campaigns) {
        camp.drr = totalRevenue > 0 ? camp.totalSpend / totalRevenue * 100 : (camp.totalSpend > 0 ? 100 : 0);
        totalSpendAllCampaigns += camp.totalSpend;
      }
      const totalDrr = totalRevenue > 0 ? totalSpendAllCampaigns / totalRevenue * 100 : (totalSpendAllCampaigns > 0 ? 100 : 0);

      articlesOut.push({
        offerId: article.offerId,
        productName: article.productName,
        byDate,
        totals: { revenue: totalRevenue, orders: totalOrders, views: totalViews, pdpViews: totalPdpViews, cart: totalCart, spend: totalSpendAllCampaigns, drr: totalDrr },
        campaigns: article.campaigns,
      });
    }

    // Сначала артикулы с реальной привязкой (сортировка по расходу за
    // период — самые активные сверху), затем несматченные кампании.
    articlesOut.sort((a, b) => {
      if (!a.offerId && b.offerId) return 1;
      if (a.offerId && !b.offerId) return -1;
      return (b.totals.spend || 0) - (a.totals.spend || 0);
    });

    res.json({ success: true, data: { dates, articles: articlesOut } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ВРЕМЕННЫЙ диагностический роут — понять, почему у Defly почти всё "без
// привязки к артикулу" и все метрики нулевые. Удалить после диагностики.
router.get('/debug-raw', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'defly';
    const [catalogCount, campCount, campSample, statsCount, statsSample, analyticsCount, analyticsSample, campTitles, runRows] = await Promise.all([
      query(`SELECT COUNT(*)::int as n FROM ad_product_catalog WHERE cabinet = $1`, [cabinet]),
      query(`SELECT COUNT(*)::int as n FROM ad_campaigns WHERE cabinet = $1`, [cabinet]),
      query(`SELECT campaign_id, title, state, matched_offer_id FROM ad_campaigns WHERE cabinet = $1 ORDER BY updated_at DESC LIMIT 10`, [cabinet]),
      query(`SELECT COUNT(*)::int as n FROM ad_stats_daily WHERE cabinet = $1`, [cabinet]),
      query(`SELECT * FROM ad_stats_daily WHERE cabinet = $1 ORDER BY collected_at DESC LIMIT 10`, [cabinet]),
      query(`SELECT COUNT(*)::int as n FROM product_analytics_daily WHERE cabinet = $1`, [cabinet]),
      query(`SELECT * FROM product_analytics_daily WHERE cabinet = $1 ORDER BY collected_at DESC LIMIT 10`, [cabinet]),
      query(`SELECT title FROM ad_campaigns WHERE cabinet = $1 AND matched_offer_id IS NULL AND title IS NOT NULL LIMIT 30`, [cabinet]),
      query(`SELECT * FROM ad_collect_runs WHERE cabinet = $1`, [cabinet]),
    ]);
    res.json({
      success: true,
      data: {
        catalogRows: catalogCount[0]?.n,
        campaignsTotal: campCount[0]?.n,
        campaignSample: campSample,
        adStatsDailyTotal: statsCount[0]?.n,
        adStatsDailySample: statsSample,
        productAnalyticsDailyTotal: analyticsCount[0]?.n,
        productAnalyticsDailySample: analyticsSample,
        unmatchedTitlesSample: campTitles.map(r => r.title),
        lastCollectRun: runRows[0] || null,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ВРЕМЕННЫЙ debug-роут: сырой ответ Ozon Seller Analytics API для Defly —
// понять, почему product_analytics_daily пустая (0 строк).
router.get('/debug-analytics', async (req, res) => {
  const axios = require('axios');
  const dayjs = require('dayjs');
  const { getCabinet } = require('../config/cabinets');
  try {
    const cabinet = req.query.cabinet || 'defly';
    const cfg = getCabinet(cabinet);
    const headers = { 'Client-Id': cfg.ozonClientId, 'Api-Key': cfg.ozonApiKey, 'Content-Type': 'application/json' };
    const from = dayjs().subtract(30, 'day').format('YYYY-MM-DD');
    const to = dayjs().format('YYYY-MM-DD');

    const out = { clientIdSet: !!cfg.ozonClientId, apiKeySet: !!cfg.ozonApiKey, from, to, attempts: [] };

    for (const metric of ['hits_view', 'revenue', 'ordered_units']) {
      try {
        const { data } = await axios.post('https://api-seller.ozon.ru/v1/analytics/data', {
          date_from: from, date_to: to, metrics: [metric], dimension: ['sku', 'day'], limit: 20, offset: 0,
        }, { headers, timeout: 30000 });
        out.attempts.push({ metric, ok: true, rowCount: data?.result?.data?.length, sample: data?.result?.data?.slice(0, 3) });
      } catch (e) {
        out.attempts.push({ metric, ok: false, status: e.response?.status, body: e.response?.data || e.message });
      }
    }
    res.json({ success: true, data: out });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
