const express = require('express');
const router = express.Router();
const dayjs = require('dayjs');
const { query } = require('../db');
const { listCabinets } = require('../config/cabinets');
const { collectCatalog } = require('../collectors/ads/ozonCatalog');
const { collectAdStats } = require('../collectors/ads/ozonPerf');
const { collectProductAnalytics } = require('../collectors/ads/ozonProductAnalytics');
const { collectProductStocks } = require('../collectors/ads/ozonProductStocks');
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
      await saveRunStatus(cabinet, { step: 'stocks' });
      console.log(`[Ads] Сбор для ${cabinet}: остатки...`);
      await collectProductStocks(cabinet);
      await saveRunStatus(cabinet, { step: 'done', finishedAt: new Date().toISOString() });
      console.log(`[Ads] Сбор для ${cabinet}: готово`);
    } catch(e) {
      const errMsg = JSON.stringify(e.response?.data || null) || e.message || String(e);
      await saveRunStatus(cabinet, { error: errMsg, finishedAt: new Date().toISOString() });
      console.error(`[Ads] Сбор для ${cabinet} упал:`, e.response?.data || e.message || e);
    }
  }, 100);
});

// POST /api/ads/manual — ручной ввод показателя воронки по артикулу и дате,
// когда сбор с Ozon для них так и не дал данных. Приоритет всегда у данных
// с маркетплейса (см. merge в /stats выше) — ручное значение здесь просто
// сохраняется про запас и показывается только пока собранное значение
// пустое/нулевое. metric — один из: views, pdpViews, cart, orders, revenue.
// value = null/'' удаляет ранее сохранённое ручное значение (сброс к 0, а
// для position — к "нет данных").
const MANUAL_METRICS = new Set(['views', 'pdpViews', 'cart', 'orders', 'revenue', 'position']);
router.post('/manual', async (req, res) => {
  try {
    const { cabinet, offerId, date, metric } = req.body || {};
    let { value } = req.body || {};
    if (!cabinet || !offerId || !date || !metric) {
      return res.status(400).json({ success: false, error: 'Нужны cabinet, offerId, date, metric' });
    }
    if (!MANUAL_METRICS.has(metric)) {
      return res.status(400).json({ success: false, error: `Недопустимая метрика: ${metric}` });
    }
    if (value === '' || value === null || value === undefined) {
      await query(
        `DELETE FROM product_analytics_manual WHERE cabinet=$1 AND platform='ozon' AND offer_id=$2 AND date=$3 AND metric=$4`,
        [cabinet, offerId, date, metric]
      );
      return res.json({ success: true, cleared: true });
    }
    value = Number(value);
    if (!Number.isFinite(value) || value < 0) {
      return res.status(400).json({ success: false, error: 'value должно быть неотрицательным числом' });
    }
    await query(
      `INSERT INTO product_analytics_manual (cabinet, platform, offer_id, date, metric, value, updated_at)
       VALUES ($1, 'ozon', $2, $3, $4, $5, NOW())
       ON CONFLICT (cabinet, platform, offer_id, date, metric) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [cabinet, offerId, date, metric, value]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET/POST /api/ads/order?cabinet=defly — ручной порядок артикулов в общем
// списке (drag-n-drop на фронте). Хранится как JSON-массив offerId в общей
// таблице app_settings под ключом ads_order:<cabinet>, чтобы не заводить
// отдельную таблицу под одну строку на кабинет.
router.get('/order', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'defly';
    const rows = await query('SELECT value FROM app_settings WHERE key=$1', [`ads_order:${cabinet}`]);
    const order = rows[0] ? JSON.parse(rows[0].value) : [];
    res.json({ success: true, data: order });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/order', async (req, res) => {
  try {
    const { cabinet, order } = req.body || {};
    if (!cabinet || !Array.isArray(order)) return res.status(400).json({ success: false, error: 'cabinet и order (массив) обязательны' });
    await query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [`ads_order:${cabinet}`, JSON.stringify(order)]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
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
    // Период — либо явный диапазон с календаря (dateFrom/dateTo), либо
    // старое поведение "последние N дней" (days) для обратной совместимости.
    let from, to;
    if (req.query.dateFrom && req.query.dateTo) {
      from = dayjs(req.query.dateFrom).format('YYYY-MM-DD');
      to = dayjs(req.query.dateTo).format('YYYY-MM-DD');
      if (dayjs(to).isBefore(from)) [from, to] = [to, from];
      // Не даём выбрать больше 92 дней разом — иначе таблица по дням
      // становится нечитаемой, а сам запрос — очень тяжёлым.
      if (dayjs(to).diff(from, 'day') > 92) from = dayjs(to).subtract(92, 'day').format('YYYY-MM-DD');
    } else {
      const days = Math.min(60, Math.max(7, parseInt(req.query.days, 10) || 30));
      from = dayjs().subtract(days, 'day').format('YYYY-MM-DD');
      to = dayjs().format('YYYY-MM-DD');
    }

    const [campaigns, adRows, analyticsRows, catalogRows, manualRows, stockRows] = await Promise.all([
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
      // Ручные значения — на случай, если сбор с Ozon для каких-то дат/
      // метрик так и не дал данных (см. product_analytics_manual в
      // init.sql). Приоритет всегда у данных с маркетплейса: ручное
      // значение подставляется только там, где собранное значение пустое
      // или равно нулю (см. merge ниже).
      query(`SELECT date::text as date, offer_id, metric, value
             FROM product_analytics_manual WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3`,
             [cabinet, from, to]),
      // Текущие остатки FBO/FBS — последний собранный снепшот по кабинету
      // (см. collectors/ads/ozonProductStocks.js). Не зависит от выбранного
      // периода — это "сейчас", а не история.
      query(`SELECT offer_id, fbo_present, fbo_reserved, fbs_present, fbs_reserved
             FROM ad_product_stocks
             WHERE cabinet = $1 AND platform = 'ozon'
               AND snapshot_date = (SELECT MAX(snapshot_date) FROM ad_product_stocks WHERE cabinet = $1 AND platform = 'ozon')`,
             [cabinet]),
    ]);

    const dates = [];
    for (let d = dayjs(from); !d.isAfter(to, 'day'); d = d.add(1, 'day')) dates.push(d.format('YYYY-MM-DD'));

    const analyticsByKey = new Map(); // sku|date -> row
    for (const r of analyticsRows) analyticsByKey.set(`${r.sku}|${r.date}`, r);

    const spendByKey = new Map(); // campaignId|date -> spend
    for (const r of adRows) spendByKey.set(`${r.campaign_id}|${r.date}`, Number(r.spend) || 0);

    const nameByOfferId = new Map(catalogRows.map(r => [r.offer_id, r.product_name]));

    const stockByOfferId = new Map(stockRows.map(r => [r.offer_id, {
      fboPresent: Number(r.fbo_present) || 0,
      fboReserved: Number(r.fbo_reserved) || 0,
      fbsPresent: Number(r.fbs_present) || 0,
      fbsReserved: Number(r.fbs_reserved) || 0,
    }]));

    // Ручные значения — сгруппированы по offerId|date|metric, метрики те же
    // ключи, что и в byDate ниже (views/pdpViews/cart/orders/revenue).
    const manualByKey = new Map(); // offerId|date|metric -> value
    for (const r of manualRows) manualByKey.set(`${r.offer_id}|${r.date}|${r.metric}`, Number(r.value));

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
        const mpViews = an ? Number(an.hits_view) || 0 : 0;
        const mpPdpViews = an ? Number(an.hits_view_pdp) || 0 : 0;
        const mpCart = an ? Number(an.hits_tocart) || 0 : 0;
        const mpOrders = an ? Number(an.orders_item) || 0 : 0;
        const mpRevenue = an ? Number(an.revenue) || 0 : 0;
        const mpPosition = an?.position_category != null ? Number(an.position_category) : null;

        // Приоритет всегда у данных с маркетплейса — ручное значение
        // подставляется, только если Ozon для этой даты/метрики отдал 0
        // (или сбора вообще не было). Как только сбор реально соберёт
        // ненулевое значение, оно автоматически заменит ручное в выдаче —
        // ручное значение из БД при этом никуда не удаляется (на случай,
        // если сбор снова перестанет что-то отдавать). Для позиции в поиске
        // "пусто" — это null (а не 0, там 0 была бы отличной позицией),
        // поэтому у неё своя проверка.
        const manualOf = metric => article.offerId ? manualByKey.get(`${article.offerId}|${date}|${metric}`) : undefined;
        function pick(mpValue, metric) {
          if (mpValue) return { value: mpValue, manual: false };
          const m = manualOf(metric);
          return m !== undefined ? { value: m, manual: true } : { value: mpValue, manual: false };
        }
        function pickNullable(mpValue, metric) {
          if (mpValue !== null && mpValue !== undefined) return { value: mpValue, manual: false };
          const m = manualOf(metric);
          return m !== undefined ? { value: m, manual: true } : { value: null, manual: false };
        }
        const views = pick(mpViews, 'views');
        const pdpViews = pick(mpPdpViews, 'pdpViews');
        const cart = pick(mpCart, 'cart');
        const orders = pick(mpOrders, 'orders');
        const revenue = pick(mpRevenue, 'revenue');
        const position = pickNullable(mpPosition, 'position');

        totalRevenue += revenue.value; totalOrders += orders.value; totalViews += views.value; totalPdpViews += pdpViews.value; totalCart += cart.value;

        byDate[date] = {
          views: views.value,
          pdpViews: pdpViews.value,
          ctr: views.value > 0 ? pdpViews.value / views.value * 100 : 0,
          cart: cart.value,
          // СР в корзину — доля переходов в карточку, которые закончились
          // добавлением в корзину: корзины / переходы (было ошибочно
          // корзины / показы).
          crToCart: pdpViews.value > 0 ? cart.value / pdpViews.value * 100 : 0,
          crToOrder: cart.value > 0 ? orders.value / cart.value * 100 : 0,
          orders: orders.value,
          revenue: revenue.value,
          position: position.value,
          manual: {
            views: views.manual, pdpViews: pdpViews.manual, cart: cart.manual,
            orders: orders.manual, revenue: revenue.manual, position: position.manual,
          },
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

      // Общая конверсия за весь период (не среднее по дням — сумма/сумма,
      // это корректнее на низких абсолютных числах).
      const totalCtr       = totalViews > 0 ? totalPdpViews / totalViews * 100 : 0;
      const totalCrToCart  = totalPdpViews > 0 ? totalCart / totalPdpViews * 100 : 0;
      const totalCrToOrder = totalCart > 0 ? totalOrders / totalCart * 100 : 0;

      articlesOut.push({
        offerId: article.offerId,
        productName: article.productName,
        byDate,
        totals: {
          revenue: totalRevenue, orders: totalOrders, views: totalViews, pdpViews: totalPdpViews, cart: totalCart,
          spend: totalSpendAllCampaigns, drr: totalDrr,
          ctr: totalCtr, crToCart: totalCrToCart, crToOrder: totalCrToOrder,
        },
        campaigns: article.campaigns,
        stock: article.offerId ? (stockByOfferId.get(article.offerId) || null) : null,
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

// ВРЕМЕННЫЙ debug-роут: сырой ответ Ozon Performance API (statistics/expense/json)
// для кабинета — посмотреть, какие поля реально приходят (клики/показы/CPC),
// т.к. текущий сборщик (ozonPerf.js) сохраняет только moneySpent.
router.get('/debug-expense', async (req, res) => {
  const axios = require('axios');
  const dayjs = require('dayjs');
  const { getCabinet } = require('../config/cabinets');
  try {
    const cabinet = req.query.cabinet || 'defly';
    const cfg = getCabinet(cabinet);
    const { data: tokenData } = await axios.post('https://api-performance.ozon.ru/api/client/token',
      { client_id: cfg.ozonPerfClientId, client_secret: cfg.ozonPerfSecret, grant_type: 'client_credentials' },
      { timeout: 15000 });
    const token = tokenData?.access_token;
    if (!token) return res.json({ success: false, error: 'Нет токена Performance API' });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const from = dayjs().subtract(parseInt(req.query.days, 10) || 3, 'day').format('YYYY-MM-DD');
    const to = dayjs().format('YYYY-MM-DD');
    const { data } = await axios.get('https://api-performance.ozon.ru/api/client/statistics/expense/json',
      { headers, params: { dateFrom: from, dateTo: to }, timeout: 30000 });
    const rows = data?.rows || data?.list || (Array.isArray(data) ? data : []);
    res.json({ success: true, data: { from, to, rowCount: rows.length, keysSample: rows[0] ? Object.keys(rows[0]) : [], sample: rows.slice(0, 5) } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.response?.data || e.message });
  }
});

// ВРЕМЕННЫЙ debug-роут: пробуем синхронный GET .../api/client/statistics
// (даёт views/clicks/ctr по дням на кампанию — то, что нужно для CPC) на
// обоих известных доменах Performance API, т.к. "родной" сборщик Licio
// (collectors/ozon/ads.js) успешно ходит на performance.ozon.ru, а
// мультикабинетный (ozonPerf.js) — на api-performance.ozon.ru, и раньше
// решили, что statistics отдаёт 405 "на этом аккаунте", хотя, возможно,
// дело было в домене, а не в аккаунте.
router.get('/debug-statistics', async (req, res) => {
  const axios = require('axios');
  const dayjs = require('dayjs');
  const { getCabinet } = require('../config/cabinets');
  const out = { attempts: [] };
  try {
    const cabinet = req.query.cabinet || 'defly';
    const cfg = getCabinet(cabinet);
    const { data: tokenData } = await axios.post('https://api-performance.ozon.ru/api/client/token',
      { client_id: cfg.ozonPerfClientId, client_secret: cfg.ozonPerfSecret, grant_type: 'client_credentials' },
      { timeout: 15000 });
    const token = tokenData?.access_token;
    if (!token) return res.json({ success: false, error: 'Нет токена Performance API' });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const from = dayjs().subtract(parseInt(req.query.days, 10) || 3, 'day').format('YYYY-MM-DD');
    const to = dayjs().format('YYYY-MM-DD');

    // Нужен ID хотя бы одной активной кампании — берём из списка.
    let campaignId = req.query.campaignId;
    if (!campaignId) {
      const { data: campData } = await axios.get('https://api-performance.ozon.ru/api/client/campaign',
        { headers, params: { state: 'CAMPAIGN_STATE_RUNNING' }, timeout: 30000 });
      campaignId = campData?.list?.[0]?.id;
    }
    out.campaignId = campaignId;

    // GET на api-performance.ozon.ru отдаёт 405 — пробуем POST (Ozon Performance
    // API v2/v3 обычно требует POST для запуска отчёта, а не синхронный GET).
    try {
      const { data } = await axios.post('https://api-performance.ozon.ru/api/client/statistics',
        { campaigns: [campaignId], dateFrom: from, dateTo: to, groupBy: 'DATE' },
        { headers, timeout: 30000 });
      out.attempts.push({ method: 'POST', domain: 'api-performance.ozon.ru', path: '/api/client/statistics', ok: true, body: data });
    } catch (e) {
      out.attempts.push({ method: 'POST', domain: 'api-performance.ozon.ru', path: '/api/client/statistics', ok: false, status: e.response?.status, body: e.response?.data || e.message });
    }
    // Вариант v3 (UUID-отчёт) — многие интеграции Ozon Performance API теперь
    // используют именно /api/client/statistics/json или /v3/... для отчётов.
    for (const path of ['/api/client/statistics/json', '/api/client/statistics/daily/json']) {
      try {
        const { data } = await axios.post(`https://api-performance.ozon.ru${path}`,
          { campaigns: [campaignId], dateFrom: from, dateTo: to, groupBy: 'DATE' },
          { headers, timeout: 30000 });
        out.attempts.push({ method: 'POST', domain: 'api-performance.ozon.ru', path, ok: true, body: data });
      } catch (e) {
        out.attempts.push({ method: 'POST', domain: 'api-performance.ozon.ru', path, ok: false, status: e.response?.status, body: e.response?.data || e.message });
      }
    }
    res.json({ success: true, data: out });
  } catch (e) {
    res.status(500).json({ success: false, error: e.response?.data || e.message, out });
  }
});

// ВРЕМЕННЫЙ debug-роут: POST /api/client/statistics подтверждён рабочим —
// отдаёт {UUID} (асинхронный отчёт, максимум 1 активный запрос на аккаунт).
// Этот роут запускает отчёт и сам поллит GET /api/client/statistics/{UUID}
// до готовности, чтобы увидеть реальную форму данных (CSV-ссылка или JSON?).
router.get('/debug-statistics-poll', async (req, res) => {
  const axios = require('axios');
  const dayjs = require('dayjs');
  const { getCabinet } = require('../config/cabinets');
  const delay = ms => new Promise(r => setTimeout(r, ms));
  try {
    const cabinet = req.query.cabinet || 'defly';
    const cfg = getCabinet(cabinet);
    const { data: tokenData } = await axios.post('https://api-performance.ozon.ru/api/client/token',
      { client_id: cfg.ozonPerfClientId, client_secret: cfg.ozonPerfSecret, grant_type: 'client_credentials' },
      { timeout: 15000 });
    const token = tokenData?.access_token;
    if (!token) return res.json({ success: false, error: 'Нет токена Performance API' });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const from = dayjs().subtract(parseInt(req.query.days, 10) || 3, 'day').format('YYYY-MM-DD');
    const to = dayjs().format('YYYY-MM-DD');

    let campaignId = req.query.campaignId;
    if (!campaignId) {
      const { data: campData } = await axios.get('https://api-performance.ozon.ru/api/client/campaign',
        { headers, params: { state: 'CAMPAIGN_STATE_RUNNING' }, timeout: 30000 });
      campaignId = campData?.list?.[0]?.id;
    }

    const { data: startData } = await axios.post('https://api-performance.ozon.ru/api/client/statistics',
      { campaigns: [campaignId], dateFrom: from, dateTo: to, groupBy: 'DATE' },
      { headers, timeout: 30000 });
    const uuid = startData?.UUID;
    if (!uuid) return res.json({ success: false, error: 'Нет UUID', startData });

    let status = null;
    for (let i = 0; i < 10; i++) {
      await delay(2000);
      const { data } = await axios.get(`https://api-performance.ozon.ru/api/client/statistics/${uuid}`,
        { headers, timeout: 30000 });
      status = data;
      if (data?.state === 'OK' || data?.state === 'ERROR') break;
    }
    let report = null;
    if (status?.link) {
      try {
        const { data } = await axios.get(`https://api-performance.ozon.ru${status.link}`,
          { headers, timeout: 30000, responseType: 'text', transformResponse: [d => d] });
        report = String(data).slice(0, 3000);
      } catch (e) { report = `Ошибка загрузки отчёта: ${e.response?.status} ${e.message}`; }
    }
    res.json({ success: true, data: { campaignId, uuid, status, report } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.response?.data || e.message });
  }
});

module.exports = router;
