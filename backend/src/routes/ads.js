const express = require('express');
const router = express.Router();
const dayjs = require('dayjs');
const { query } = require('../db');
const { listCabinets } = require('../config/cabinets');
const { requestRefresh, currentJob, getStatus, JOBS } = require('../collectors/ads/jobs');
const { getAssociatedOfferIds, ASSOCIATED_ARTICLES } = require('../config/associatedArticles');

// GET /api/ads/cabinets — список кабинетов и что для них настроено (видно
// в интерфейсе, какие токены ещё нужно добавить в Render).
router.get('/cabinets', (req, res) => {
  res.json({ success: true, data: listCabinets() });
});

// POST /api/ads/collect?cabinet=defly&days=30 — ручное обновление с кнопки.
// Ставит в очередь планировщика (collectors/ads/jobs.js) немедленный сбор
// расхода, кликов, аналитики и остатков за нужный период. Весь сбор теперь
// занимает 1-2 минуты, поэтому отвечаем сразу, а данные подтягиваются
// следующей загрузкой страницы.
router.post('/collect', async (req, res) => {
  const cabinet = req.query.cabinet || req.body?.cabinet;
  const days = parseInt(req.query.days || req.body?.days, 10) || 30;
  if (!cabinet) return res.status(400).json({ success: false, error: 'Нужен параметр cabinet' });
  const wasBusy = requestRefresh(cabinet, days);
  res.json({ success: true, message: wasBusy
    ? `Сбор для ${cabinet} уже идёт — обновление за ${days} дн. выполнится сразу после него`
    : `Сбор запущен для кабинета ${cabinet} за ${days} дн.` });
});

// GET /api/ads/data-status?cabinet=defly — когда какая часть данных
// обновлялась последний раз (для строки статуса на странице "Реклама").
router.get('/data-status', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'defly';
    const st = await getStatus(cabinet);
    res.json({ success: true, data: {
      running: currentJob(cabinet),
      jobs: JOBS.map(j => {
        const r = st.get(j.id) || {};
        return { job: j.id, everyMin: Math.round(j.every / 60000), lastSuccessAt: r.last_success_at || null,
          lastErrorAt: r.last_error_at || null, lastError: r.last_error || null, lastWarning: r.last_warning || null,
          lastRows: r.last_rows ?? null, lastDurationMs: r.last_duration_ms ?? null };
      }),
    } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/ads/manual — ручной ввод показателя воронки по артикулу и дате,
// когда сбор с Ozon для них так и не дал данных. Приоритет всегда у данных
// с маркетплейса (см. merge в /stats выше) — ручное значение здесь просто
// сохраняется про запас и показывается только пока собранное значение
// пустое/нулевое. metric — один из: views, pdpViews, cart, orders, revenue,
// position, spend, avgCpc (последние два добавлены на время, пока не
// работает сбор с Ozon — 29.09, см. jobs.js: discounts отключены по той же
// причине). value = null/'' удаляет ранее сохранённое ручное значение
// (сброс к 0, а для position — к "нет данных").
const MANUAL_METRICS = new Set(['views', 'pdpViews', 'cart', 'orders', 'revenue', 'position', 'spend', 'avgCpc']);
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

// POST /api/ads/manual-stock — ручной ввод остатков по артикулу (без даты —
// это "текущее" значение, как и сам сбор остатков, см. ad_product_stocks).
// Та же логика приоритета: используется только пока реальный снепшот для
// этого артикула отсутствует/пустой. metric — fboPresent или fbsPresent.
const STOCK_MANUAL_METRICS = new Set(['fboPresent', 'fbsPresent']);
router.post('/manual-stock', async (req, res) => {
  try {
    const { cabinet, offerId, metric } = req.body || {};
    let { value } = req.body || {};
    if (!cabinet || !offerId || !metric) {
      return res.status(400).json({ success: false, error: 'Нужны cabinet, offerId, metric' });
    }
    if (!STOCK_MANUAL_METRICS.has(metric)) {
      return res.status(400).json({ success: false, error: `Недопустимая метрика: ${metric}` });
    }
    if (value === '' || value === null || value === undefined) {
      await query(
        `DELETE FROM ad_stock_manual WHERE cabinet=$1 AND platform='ozon' AND offer_id=$2 AND metric=$3`,
        [cabinet, offerId, metric]
      );
      return res.json({ success: true, cleared: true });
    }
    value = Number(value);
    if (!Number.isFinite(value) || value < 0) {
      return res.status(400).json({ success: false, error: 'value должно быть неотрицательным числом' });
    }
    await query(
      `INSERT INTO ad_stock_manual (cabinet, platform, offer_id, metric, value, updated_at)
       VALUES ($1, 'ozon', $2, $3, $4, NOW())
       ON CONFLICT (cabinet, platform, offer_id, metric) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [cabinet, offerId, metric, value]
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

// GET/POST/DELETE /api/ads/groups — тестируемые группы артикулов прямо на
// странице "Реклама" (например "Чехлы"): объединяют несколько артикулов в
// одну строку со сводным "Заказано"/"Расход"/ДРР сверху и списком артикулов
// под ней. Группировка всегда по offerId — это "Артикул продавца" (свой код
// товара, который продавец сам придумал, например Hv4-2KR), а НЕ SKU Ozon.
// Хранится как JSON в app_settings — тем же способом, что и ads_order выше:
//   ads_groups:<cabinet>         = [{id, name}, ...]
//   ads_group_members:<cabinet>  = { offerId: groupId, ... }
// Агрегаты по группе (сумма заказов/расхода за выбранный период) считаются
// на фронте из уже загруженных totals артикулов — отдельный запрос не нужен.
async function loadAdsGroups(cabinet) {
  const rows = await query('SELECT key, value FROM app_settings WHERE key = ANY($1::text[])',
    [[`ads_groups:${cabinet}`, `ads_group_members:${cabinet}`]]);
  const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const groups = byKey[`ads_groups:${cabinet}`] ? JSON.parse(byKey[`ads_groups:${cabinet}`]) : [];
  const members = byKey[`ads_group_members:${cabinet}`] ? JSON.parse(byKey[`ads_group_members:${cabinet}`]) : {};
  return { groups, members };
}
async function saveAdsGroupsSetting(key, value) {
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

router.get('/groups', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'defly';
    res.json({ success: true, data: await loadAdsGroups(cabinet) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/groups', async (req, res) => {
  try {
    const { cabinet, name } = req.body || {};
    if (!cabinet || !name || !String(name).trim()) {
      return res.status(400).json({ success: false, error: 'Нужны cabinet и name' });
    }
    const { groups, members } = await loadAdsGroups(cabinet);
    const id = `${Date.now()}`;
    groups.push({ id, name: String(name).trim() });
    await saveAdsGroupsSetting(`ads_groups:${cabinet}`, groups);
    res.json({ success: true, data: { groups, members } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.delete('/groups/:id', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'defly';
    const { groups, members } = await loadAdsGroups(cabinet);
    const nextGroups = groups.filter(g => g.id !== req.params.id);
    const nextMembers = Object.fromEntries(Object.entries(members).filter(([, gid]) => gid !== req.params.id));
    await saveAdsGroupsSetting(`ads_groups:${cabinet}`, nextGroups);
    await saveAdsGroupsSetting(`ads_group_members:${cabinet}`, nextMembers);
    res.json({ success: true, data: { groups: nextGroups, members: nextMembers } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/ads/groups/assign — отнести артикул (offerId = артикул продавца)
// к группе, либо убрать из группы (groupId: null/отсутствует).
router.post('/groups/assign', async (req, res) => {
  try {
    const { cabinet, offerId, groupId } = req.body || {};
    if (!cabinet || !offerId) return res.status(400).json({ success: false, error: 'Нужны cabinet и offerId' });
    const { groups, members } = await loadAdsGroups(cabinet);
    if (groupId) members[offerId] = groupId; else delete members[offerId];
    await saveAdsGroupsSetting(`ads_group_members:${cabinet}`, members);
    res.json({ success: true, data: { groups, members } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/ads/groups/reorder — переставить сами группы местами (порядок
// их показа в списке групп), а не артикулы внутри группы.
router.post('/groups/reorder', async (req, res) => {
  try {
    const { cabinet, order } = req.body || {};
    if (!cabinet || !Array.isArray(order) || !order.length) {
      return res.status(400).json({ success: false, error: 'Нужны cabinet и order' });
    }
    const { groups, members } = await loadAdsGroups(cabinet);
    const byId = new Map(groups.map(g => [g.id, g]));
    const nextGroups = order.map(id => byId.get(id)).filter(Boolean);
    // На случай рассинхрона (группа создана/удалена в другой вкладке) —
    // дописываем в конец те, что не попали в order, вместо потери.
    for (const g of groups) if (!order.includes(g.id)) nextGroups.push(g);
    await saveAdsGroupsSetting(`ads_groups:${cabinet}`, nextGroups);
    res.json({ success: true, data: { groups: nextGroups, members } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/ads/catalog?cabinet=defly — весь каталог кабинета (все офферы,
// не только те, что хоть раз рекламировались) — источник для поиска при
// добавлении артикула в группу: нужно находить и артикулы без единой РК
// (см. forced-include в /stats выше), а не только те, что уже есть в
// articlesRaw на фронте.
router.get('/catalog', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'defly';
    const rows = await query(
      `SELECT offer_id, product_name FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon' ORDER BY offer_id`,
      [cabinet]
    );
    res.json({ success: true, data: rows.map(r => ({ offerId: r.offer_id, productName: r.product_name })) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/ads/sibling-clusters?cabinet=defly — готовые "склейки" из
// config/associatedArticles.js (один рекламируемый артикул + его материалы/
// варианты той же модели) в виде, удобном для быстрого создания группы на
// фронте одной кнопкой — чтобы не собирать состав группы руками каждый раз,
// когда склейка и так уже известна и прописана в конфиге.
router.get('/sibling-clusters', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'defly';
    const map = ASSOCIATED_ARTICLES[cabinet] || {};
    const clusters = Object.entries(map).map(([primary, siblings]) => ({
      primary,
      members: [primary, ...siblings],
    }));
    const allIds = [...new Set(clusters.flatMap(c => c.members))];
    const nameRows = allIds.length
      ? await query(`SELECT offer_id, product_name FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon' AND offer_id = ANY($2::text[])`, [cabinet, allIds])
      : [];
    const nameByOfferId = new Map(nameRows.map(r => [r.offer_id, r.product_name]));
    res.json({
      success: true,
      data: clusters.map(c => ({
        ...c,
        productName: nameByOfferId.get(c.primary) || null,
      })),
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/ads/groups/from-cluster — создать группу и сразу отнести к ней
// весь список артикулов одним запросом (вместо create + N отдельных
// assign) — именно то, что нужно кнопке "Создать группу по склейке".
router.post('/groups/from-cluster', async (req, res) => {
  try {
    const { cabinet, name, offerIds } = req.body || {};
    if (!cabinet || !name || !String(name).trim() || !Array.isArray(offerIds) || !offerIds.length) {
      return res.status(400).json({ success: false, error: 'Нужны cabinet, name и offerIds' });
    }
    const { groups, members } = await loadAdsGroups(cabinet);
    const id = `${Date.now()}`;
    groups.push({ id, name: String(name).trim() });
    for (const offerId of offerIds) members[offerId] = id;
    await saveAdsGroupsSetting(`ads_groups:${cabinet}`, groups);
    await saveAdsGroupsSetting(`ads_group_members:${cabinet}`, members);
    res.json({ success: true, data: { groups, members } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
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

    const [campaigns, adRows, analyticsRows, catalogRows, manualRows, stockRows, stockManualRows, campaignSkuRows] = await Promise.all([
      query(`SELECT campaign_id, title, state, adv_object_type, matched_offer_id, matched_sku,
                    payment_type, autopilot_strategy, placement, expense_strategy
             FROM ad_campaigns WHERE cabinet = $1 AND platform = 'ozon'`, [cabinet]),
      query(`SELECT date::text as date, campaign_id, spend, clicks
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
      // Ручные остатки — подстраховка на случай, если сбор остатков с Ozon
      // не работает (см. manual-stock выше). Без периода — это "текущее"
      // значение, а не история по дням.
      query(`SELECT offer_id, metric, value FROM ad_stock_manual WHERE cabinet = $1 AND platform = 'ozon'`,
             [cabinet]),
      // Товары мультитоварных кампаний ("Оплата за заказ: выбранные товары"
      // и подобные) — одна РК продвигает сразу несколько SKU, и расход по
      // ней нужно поделить между всеми её артикулами, а не отнести целиком
      // одному (см. ad_campaign_skus в init.sql и split ниже).
      query(`SELECT campaign_id, sku FROM ad_campaign_skus WHERE cabinet = $1 AND platform = 'ozon' AND sku != 0`,
             [cabinet]),
    ]);

    const dates = [];
    for (let d = dayjs(from); !d.isAfter(to, 'day'); d = d.add(1, 'day')) dates.push(d.format('YYYY-MM-DD'));

    const analyticsByKey = new Map(); // sku|date -> row
    for (const r of analyticsRows) analyticsByKey.set(`${r.sku}|${r.date}`, r);

    // То же самое, но по offer_id — нужно для артикулов "склейки", которые
    // сами не рекламируются (у них нет строки в ad_campaigns, а значит и
    // article.sku не определён), но заказы по ним всё равно приходят и
    // попадают в product_analytics_daily (сбор идёт по ВСЕМ SKU кабинета,
    // см. collectors/ads/ozonProductAnalytics.js), просто под своим offer_id.
    const analyticsByOfferDate = new Map(); // offerId|date -> row
    // Если у строки аналитики нет offer_id (товар попал в каталог позже
    // сбора аналитики) — достраиваем его по SKU из каталога.
    const offerBySkuCat = new Map(catalogRows.filter(r => r.sku != null).map(r => [String(r.sku), r.offer_id]));
    for (const r of analyticsRows) {
      const offerId = r.offer_id || offerBySkuCat.get(String(r.sku));
      if (offerId) analyticsByOfferDate.set(`${offerId}|${r.date}`, r);
    }

    const spendByKey = new Map(); // campaignId|date -> spend
    const clicksByKey = new Map(); // campaignId|date -> clicks
    for (const r of adRows) {
      spendByKey.set(`${r.campaign_id}|${r.date}`, Number(r.spend) || 0);
      clicksByKey.set(`${r.campaign_id}|${r.date}`, Number(r.clicks) || 0);
    }

    const nameByOfferId = new Map(catalogRows.map(r => [r.offer_id, r.product_name]));
    const skuByOfferId = new Map(catalogRows.filter(r => r.sku != null).map(r => [r.offer_id, r.sku]));

    const stockByOfferId = new Map(stockRows.map(r => [r.offer_id, {
      fboPresent: Number(r.fbo_present) || 0,
      fboReserved: Number(r.fbo_reserved) || 0,
      fbsPresent: Number(r.fbs_present) || 0,
      fbsReserved: Number(r.fbs_reserved) || 0,
    }]));

    // Ручные остатки — по offerId|metric, приоритет всегда у реального
    // снепшота (см. computeStock ниже, та же идея, что и у manualByKey).
    const stockManualByKey = new Map(); // offerId|metric -> value
    for (const r of stockManualRows) stockManualByKey.set(`${r.offer_id}|${r.metric}`, Number(r.value));
    function computeStock(offerId) {
      const mp = stockByOfferId.get(offerId) || null;
      const manualFbo = stockManualByKey.get(`${offerId}|fboPresent`);
      const manualFbs = stockManualByKey.get(`${offerId}|fbsPresent`);
      if (!mp && manualFbo === undefined && manualFbs === undefined) return null;
      const fboPresent = mp?.fboPresent ? mp.fboPresent : (manualFbo !== undefined ? manualFbo : (mp?.fboPresent || 0));
      const fbsPresent = mp?.fbsPresent ? mp.fbsPresent : (manualFbs !== undefined ? manualFbs : (mp?.fbsPresent || 0));
      return {
        fboPresent, fbsPresent,
        fboReserved: mp?.fboReserved || 0,
        fbsReserved: mp?.fbsReserved || 0,
        manual: {
          fboPresent: !(mp?.fboPresent) && manualFbo !== undefined,
          fbsPresent: !(mp?.fbsPresent) && manualFbs !== undefined,
        },
      };
    }

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

    // Мультитоварные кампании ("Оплата за заказ: выбранные товары" и
    // подобные) продвигают сразу НЕСКОЛЬКО SKU в одной РК — там, где обычное
    // сопоставление "одна кампания = один артикул" (matched_offer_id) в
    // принципе неприменимо (название кампании не называет ни один из
    // товаров). ad_campaign_skus даёт реальный список SKU такой кампании;
    // переводим их в offer_id через каталог и, если таких артикулов больше
    // одного, делим расход/клики кампании поровну между ними — лучше
    // приблизительно учесть у каждого, чем потерять целиком как
    // "непривязанный". См. google-apps-script/ozon-sheet-sync.gs и
    // collectors/ads/ozonPerf.js (оба наполняют ad_campaign_skus).
    const campaignOfferIds = new Map(); // campaignId -> Set(offerId)
    for (const r of campaignSkuRows) {
      const offerId = offerBySkuCat.get(String(r.sku));
      if (!offerId) continue;
      if (!campaignOfferIds.has(r.campaign_id)) campaignOfferIds.set(r.campaign_id, new Set());
      campaignOfferIds.get(r.campaign_id).add(offerId);
    }

    for (const camp of campaigns) {
      const multiOfferIds = [...(campaignOfferIds.get(camp.campaign_id) || [])];
      // >1 — реально мультитоварная кампания, делим расход поровну между
      // артикулами. Если найден ровно 1 — это просто уточнение обычной
      // привязки (например, когда matched_offer_id не определился по
      // названию), используем его вместо matched_offer_id. Если 0 — старое
      // поведение без изменений.
      const targetOfferIds = multiOfferIds.length > 0 ? multiOfferIds : [camp.matched_offer_id];
      const splitCount = multiOfferIds.length > 1 ? multiOfferIds.length : 1;
      for (const offerId of targetOfferIds) {
        const sku = splitCount > 1 ? (skuByOfferId.get(offerId) || null) : camp.matched_sku;
        const article = getArticle(offerId, sku);
        const byDate = {};
        let totalSpend = 0, totalClicks = 0;
        for (const date of dates) {
          const spend = (spendByKey.get(`${camp.campaign_id}|${date}`) || 0) / splitCount;
          const clicks = (clicksByKey.get(`${camp.campaign_id}|${date}`) || 0) / splitCount;
          totalSpend += spend;
          totalClicks += clicks;
          // Средняя цена клика за день — расход / клики (клики собираются
          // отдельно через collectors/ads/ozonClicks.js, т.к. эндпоинт расхода
          // их не отдаёт). 0, если кликов не было — не делить на 0.
          byDate[date] = { spend, clicks, avgCpc: clicks > 0 ? spend / clicks : 0 };
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
          totalClicks,
          avgCpc: totalClicks > 0 ? totalSpend / totalClicks : 0,
          // Фронту — чтобы показать "расход поделен поровну на N товаров
          // кампании" вместо того, чтобы молча выдавать точную с виду цифру.
          splitAcross: splitCount > 1 ? splitCount : null,
          byDate,
        });
      }
    }

    // Принудительно заводим карточки для артикулов без единой РК (значит,
    // цикл по campaigns выше их не создал), но отнесённых к какой-то
    // группе — чтобы артикул склейки без своей рекламы всё равно
    // показывался внутри группы: без расхода/ДРР/кампаний, но с показами/
    // корзиной/заказами из product_analytics_daily (см. analyticsByOfferDate
    // и фолбэк на него в цикле ниже, т.к. у такого артикула нет sku из
    // ad_campaigns). Без этого "+ Добавить артикул" мог отнести артикул,
    // который потом просто не появлялся бы в списке группы.
    const { members: groupMembersForStats } = await loadAdsGroups(cabinet);
    for (const offerId of Object.keys(groupMembersForStats)) {
      if (!byArticle.has(offerId)) getArticle(offerId, null);
    }

    // Метрики воронки по артикулу — общие для всех его кампаний, из
    // product_analytics_daily по matched_sku. Считаем по дням и суммарно за
    // весь выбранный период (для ДРР).
    const articlesOut = [];
    for (const [, article] of byArticle) {
      const byDate = {};
      let totalRevenue = 0, totalOrders = 0, totalViews = 0, totalPdpViews = 0, totalCart = 0, totalSpend = 0;
      for (const date of dates) {
        // У артикула без своей РК (добавлен в группу вручную, см. forced-
        // include выше) нет sku из ad_campaigns — тогда берём ту же
        // аналитику по offer_id напрямую (analyticsByOfferDate, см. выше).
        const an = article.sku
          ? analyticsByKey.get(`${article.sku}|${date}`)
          : (article.offerId ? analyticsByOfferDate.get(`${article.offerId}|${date}`) : null);
        const mpViews = an ? Number(an.hits_view) || 0 : 0;
        const mpPdpViews = an ? Number(an.hits_view_pdp) || 0 : 0;
        const mpCart = an ? Number(an.hits_tocart) || 0 : 0;
        const mpOrders = an ? Number(an.orders_item) || 0 : 0;
        const mpRevenue = an ? Number(an.revenue) || 0 : 0;
        const mpPosition = an?.position_category != null ? Number(an.position_category) : null;
        // Расход и ср. цена клика — сумма по всем РК артикула за день (то
        // же, что попадает в article.campaigns[].byDate[date] выше).
        const mpSpend = article.campaigns.reduce((s, c) => s + (c.byDate[date]?.spend || 0), 0);
        const mpClicks = article.campaigns.reduce((s, c) => s + (c.byDate[date]?.clicks || 0), 0);
        const mpAvgCpc = mpClicks > 0 ? mpSpend / mpClicks : 0;

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
        // Расход/цена клика — та же подстраховка, что и у остальных метрик:
        // ручное значение только пока с Ozon приходит 0 (временно, пока не
        // работает сеть до Ozon — см. discounts в jobs.js).
        const spend = pick(mpSpend, 'spend');
        const avgCpc = pick(mpAvgCpc, 'avgCpc');

        totalRevenue += revenue.value; totalOrders += orders.value; totalViews += views.value; totalPdpViews += pdpViews.value; totalCart += cart.value; totalSpend += spend.value;

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
          spend: spend.value,
          avgCpc: avgCpc.value,
          manual: {
            views: views.manual, pdpViews: pdpViews.manual, cart: cart.manual,
            orders: orders.manual, revenue: revenue.manual, position: position.manual,
            spend: spend.manual, avgCpc: avgCpc.manual,
          },
        };
      }

      // ДРР по каждой РК: расход этой РК за период / выручка артикула за
      // период * 100 — считается по реальным данным РК, без учёта ручного
      // расхода (тот не привязан к конкретной кампании). Общий ДРР артикула
      // — от totalSpend (сумма по дням, с учётом ручной подстраховки, см.
      // byDate выше), чтобы сортировка и сводка сразу отражали правку.
      for (const camp of article.campaigns) {
        camp.drr = totalRevenue > 0 ? camp.totalSpend / totalRevenue * 100 : (camp.totalSpend > 0 ? 100 : 0);
      }
      const totalDrr = totalRevenue > 0 ? totalSpend / totalRevenue * 100 : (totalSpend > 0 ? 100 : 0);

      // Общая конверсия за весь период (не среднее по дням — сумма/сумма,
      // это корректнее на низких абсолютных числах).
      const totalCtr       = totalViews > 0 ? totalPdpViews / totalViews * 100 : 0;
      const totalCrToCart  = totalPdpViews > 0 ? totalCart / totalPdpViews * 100 : 0;
      const totalCrToOrder = totalCart > 0 ? totalOrders / totalCart * 100 : 0;

      // Ассоциированные конверсии — другие артикулы той же склейки (см.
      // config/associatedArticles.js). Реклама на них не крутится, поэтому
      // тут только заказы/выручка по дням из product_analytics_daily (без
      // расхода/ДРР — рекламных денег на них нет).
      const associatedIds = article.offerId ? getAssociatedOfferIds(cabinet, article.offerId) : [];
      const associated = associatedIds.map(assocId => {
        const assocByDate = {};
        let assocTotalOrders = 0, assocTotalRevenue = 0;
        for (const date of dates) {
          const an = analyticsByOfferDate.get(`${assocId}|${date}`);
          const orders = an ? Number(an.orders_item) || 0 : 0;
          const revenue = an ? Number(an.revenue) || 0 : 0;
          assocByDate[date] = { orders, revenue };
          assocTotalOrders += orders; assocTotalRevenue += revenue;
        }
        return {
          offerId: assocId,
          productName: nameByOfferId.get(assocId) || null,
          byDate: assocByDate,
          totals: { orders: assocTotalOrders, revenue: assocTotalRevenue },
        };
      });

      articlesOut.push({
        offerId: article.offerId,
        productName: article.productName,
        byDate,
        totals: {
          revenue: totalRevenue, orders: totalOrders, views: totalViews, pdpViews: totalPdpViews, cart: totalCart,
          spend: totalSpend, drr: totalDrr,
          ctr: totalCtr, crToCart: totalCrToCart, crToOrder: totalCrToOrder,
        },
        campaigns: article.campaigns,
        stock: article.offerId ? computeStock(article.offerId) : null,
        associated,
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
      query(`SELECT * FROM ad_job_status WHERE cabinet = $1 ORDER BY job`, [cabinet]),
    ]);
    // ВРЕМЕННО: кампании без matched_offer_id, у которых есть расход за
    // последние 3 дня — чтобы найти "потерянные" свежие кампании, чей
    // заголовок не совпал по подстроке ни с одним offer_id (диагностика
    // вопроса "расход не отображается по новым артикулам").
    const recentUnmatchedSpend = await query(
      `SELECT c.campaign_id, c.title, c.state, c.adv_object_type, c.payment_type, SUM(s.spend) AS spend3d, MAX(s.date) AS last_date
         FROM ad_stats_daily s
         JOIN ad_campaigns c ON c.cabinet = s.cabinet AND c.platform = s.platform AND c.campaign_id = s.campaign_id
        WHERE s.cabinet = $1 AND c.matched_offer_id IS NULL AND s.date >= (CURRENT_DATE - INTERVAL '3 days')
        GROUP BY c.campaign_id, c.title, c.state, c.adv_object_type, c.payment_type
        ORDER BY spend3d DESC
        LIMIT 20`,
      [cabinet]);
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
        recentUnmatchedSpend,
        jobStatus: runRows,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ВРЕМЕННО: прямой запрос списка товаров кампании (api-performance v2/products)
// для диагностики — используется ли эта конкретная кампания несколькими
// артикулами сразу (кампании "Оплата за заказ: выбранные товары" и т.п.
// могут продвигать сразу пачку SKU, а не один).
router.get('/debug-campaign-products', async (req, res) => {
  try {
    const axios = require('axios');
    const { perfHeaders } = require('../collectors/ads/ozonHttp');
    const cabinet = req.query.cabinet || 'defly';
    const campaignId = req.query.campaignId;
    if (!campaignId) return res.status(400).json({ success: false, error: 'campaignId required' });
    const headers = await perfHeaders(cabinet);
    if (!headers) return res.status(400).json({ success: false, error: 'Performance API не настроен' });
    const data = await axios.get(
      `https://api-performance.ozon.ru/api/client/campaign/${campaignId}/v2/products`,
      { headers, timeout: 20000 }).then(r => r.data);
    const skus = (data?.products || []).map(p => String(p.sku)).filter(Boolean);
    const catalogRows = skus.length
      ? await query(`SELECT offer_id, sku FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon' AND sku = ANY($2::text[])`, [cabinet, skus])
      : [];
    res.json({ success: true, data: { skuCount: skus.length, skus, matchedOfferIds: catalogRows, raw: data } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ВРЕМЕННЫЙ debug-роут: сырой ответ Ozon Seller Analytics API для Defly —
// понять, почему product_analytics_daily пустая (0 строк).
// ВРЕМЕННЫЙ диагностический зонд для переделки сбора Defly: проверяет на
// живом API, какие эндпоинты и лимиты реально работают (аналитика одним
// запросом на все метрики, окно лимита /v1/analytics/data, синхронная
// дневная статистика Performance API, заказы по отправлениям для сверки).
// Запускается в фоне (POST-подобно через ?start=1), результат читается GET-ом
// — длинные ожидания лимита не держат HTTP-соединение.
const probeState = { running: false, startedAt: null, steps: [] };
router.get('/debug-probe', async (req, res) => {
  if (req.query.start && !probeState.running) {
    probeState.running = true; probeState.startedAt = new Date().toISOString(); probeState.steps = [];
    runProbe(req.query.cabinet || 'defly')
      .catch(e => probeState.steps.push({ step: 'fatal', error: e.message }))
      .finally(() => { probeState.running = false; });
  }
  res.json({ success: true, data: probeState });
});

async function runProbe(cabinet) {
  const axios = require('axios');
  const dayjs = require('dayjs');
  const { getCabinet } = require('../config/cabinets');
  const cfg = getCabinet(cabinet);
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const push = o => probeState.steps.push({ at: new Date().toISOString(), ...o });
  const sh = { 'Client-Id': cfg.ozonClientId, 'Api-Key': cfg.ozonApiKey, 'Content-Type': 'application/json' };
  const y = dayjs().add(3, 'hour').subtract(1, 'day').format('YYYY-MM-DD');
  const METRICS = ['hits_view', 'hits_view_search', 'hits_view_pdp', 'hits_tocart', 'ordered_units', 'revenue', 'position_category'];
  // Проверка стабильности постраничной выдачи при разных сортировках.
  const variants = [
    ['no_sort', undefined],
    ['sort_sku_asc', [{ key: 'sku', order: 'ASC' }]],
    ['sort_views_desc', [{ key: 'hits_view', order: 'DESC' }]],
    ['sort_orders_desc', [{ key: 'ordered_units', order: 'DESC' }]],
  ];
  for (const [label, sort] of variants) {
    try {
      const seen = new Map(); let raw = 0, totals = null, pages = 0;
      for (let offset = 0; offset < 5000; offset += 1000) {
        const body = { date_from: y, date_to: y, metrics: METRICS, dimension: ['sku', 'day'], limit: 1000, offset };
        if (sort) body.sort = sort;
        const { data } = await axios.post('https://api-seller.ozon.ru/v1/analytics/data', body, { headers: sh, timeout: 60000 });
        const rows = data?.result?.data || []; pages++;
        totals = totals || data?.result?.totals;
        for (const r of rows) { raw++; seen.set(r.dimensions[0].id, r.metrics); }
        if (rows.length < 1000) break;
        await delay(300);
      }
      let ou = 0, tc = 0, hv = 0;
      for (const m of seen.values()) { ou += Number(m[4]) || 0; tc += Number(m[3]) || 0; hv += Number(m[0]) || 0; }
      push({ step: label, ok: true, pages, rawRows: raw, uniqueSkus: seen.size, dup: raw - seen.size,
        uniqOrders: ou, totalOrders: totals?.[4], uniqCart: tc, totalCart: totals?.[3], uniqViews: hv, totalViews: totals?.[0] });
    } catch (e) { push({ step: label, ok: false, status: e.response?.status, body: e.response?.data || e.message }); }
    await delay(1000);
  }
  push({ step: 'done' });
}

module.exports = router;
