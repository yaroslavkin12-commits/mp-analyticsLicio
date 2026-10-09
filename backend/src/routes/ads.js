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

// ── Журнал изменений (заметки + автоматически найденные изменения) ──────
// Таблицу создаём и здесь, лениво, при первом обращении — initSchema() на
// старте уже однажды "пропустил" новую таблицу (см. ad_campaign_skus).
let adEventsReady = null;
function ensureAdEvents() {
  if (!adEventsReady) {
    adEventsReady = (async () => {
      await query(`CREATE TABLE IF NOT EXISTS ad_events (
        id BIGSERIAL PRIMARY KEY, cabinet VARCHAR(32) NOT NULL, platform VARCHAR(16) NOT NULL DEFAULT 'ozon',
        offer_id VARCHAR(128), date DATE NOT NULL, kind VARCHAR(32) NOT NULL DEFAULT 'note', text TEXT,
        old_value TEXT, new_value TEXT, auto BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMP DEFAULT NOW())`);
      await query(`CREATE INDEX IF NOT EXISTS idx_ad_events_lookup ON ad_events(cabinet, platform, date)`);
    })().catch(e => { adEventsReady = null; throw e; });
  }
  return adEventsReady;
}

// GET /api/ads/events?cabinet=defly&dateFrom=&dateTo=
router.get('/events', async (req, res) => {
  try {
    await ensureAdEvents();
    const cabinet = req.query.cabinet || 'defly';
    const from = req.query.dateFrom || dayjs().subtract(90, 'day').format('YYYY-MM-DD');
    const to = req.query.dateTo || dayjs().format('YYYY-MM-DD');
    const rows = await query(
      `SELECT id, offer_id, date::text AS date, kind, text, old_value, new_value, auto, created_at
         FROM ad_events WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3
        ORDER BY date DESC, id DESC`, [cabinet, from, to]);
    res.json({ success: true, data: rows.map(r => ({
      id: String(r.id), offerId: r.offer_id, date: r.date, kind: r.kind, text: r.text,
      oldValue: r.old_value, newValue: r.new_value, auto: r.auto, createdAt: r.created_at,
    })) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/ads/events {cabinet, offerId?, date?, text} — ручная заметка.
router.post('/events', async (req, res) => {
  try {
    await ensureAdEvents();
    const { cabinet, offerId, text } = req.body || {};
    const date = req.body?.date || dayjs().format('YYYY-MM-DD');
    if (!cabinet || !text || !String(text).trim()) {
      return res.status(400).json({ success: false, error: 'Нужны cabinet и text' });
    }
    const rows = await query(
      `INSERT INTO ad_events (cabinet, platform, offer_id, date, kind, text, auto)
       VALUES ($1, 'ozon', $2, $3, 'note', $4, false) RETURNING id`,
      [cabinet, offerId || null, date, String(text).trim().slice(0, 500)]);
    res.json({ success: true, data: { id: String(rows[0].id) } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// DELETE /api/ads/events/:id?cabinet=defly — только ручные заметки.
router.delete('/events/:id', async (req, res) => {
  try {
    await ensureAdEvents();
    await query(`DELETE FROM ad_events WHERE id = $1 AND cabinet = $2 AND auto = false`,
      [req.params.id, req.query.cabinet || 'defly']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
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

    // Замер времени каждого запроса — уходит в заголовок Server-Timing, чтобы
    // видеть прямо в DevTools, что именно тормозит страницу.
    const timings = [];
    const tStart = Date.now();
    const timed = (name, promise) => {
      const t = Date.now();
      return promise.then(r => { timings.push(`${name};dur=${Date.now() - t}`); return r; });
    };
    // Два шага. Сначала лёгкие справочники (кампании, каталог, товары
    // мультитоварных РК, группы) — по ним понятно, какие артикулы вообще
    // попадут на страницу. Затем тяжёлые таблицы по дням — только по этим
    // артикулам, а не по всем ~1800 товарам кабинета (раньше аналитика одна
    // тянула ~27 тыс. строк и занимала больше 2 секунд).
    const [campaigns, catalogRows, campaignSkuRows, groupsInfo, extraSkuRows] = await Promise.all([
      timed('campaigns', query(`SELECT campaign_id, title, state, adv_object_type, matched_offer_id, matched_sku,
                    payment_type, autopilot_strategy, placement, expense_strategy
             FROM ad_campaigns WHERE cabinet = $1 AND platform = 'ozon'`, [cabinet])),
      timed('catalog', query(`SELECT offer_id, sku, product_name FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon'`, [cabinet])),
      // Товары мультитоварных кампаний — одна РК продвигает сразу несколько
      // SKU (см. ad_campaign_skus в init.sql и split ниже).
      timed('campaignSkus', query(`SELECT campaign_id, sku FROM ad_campaign_skus WHERE cabinet = $1 AND platform = 'ozon' AND sku != 0`, [cabinet])),
      timed('groups', loadAdsGroups(cabinet)),
      // Товары, по которым есть точная рекламная статистика или заказы
      // "оплаты за заказ" — их аналитику тоже нужно подтянуть.
      timed('extraSkus', query(`SELECT sku::text AS sku FROM ad_sku_stats_daily WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3
             UNION SELECT COALESCE(NULLIF(promoted_sku, ''), sku) FROM ad_cpo_orders WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3`,
             [cabinet, from, to]).catch(() => [])),
    ]);

    const offerBySkuPre = new Map(catalogRows.filter(r => r.sku != null).map(r => [String(r.sku), r.offer_id]));
    const neededOffers = new Set();
    for (const c of campaigns) if (c.matched_offer_id) neededOffers.add(c.matched_offer_id);
    for (const r of campaignSkuRows) { const o = offerBySkuPre.get(String(r.sku)); if (o) neededOffers.add(o); }
    for (const o of Object.keys(groupsInfo.members || {})) neededOffers.add(o);
    for (const r of extraSkuRows) { const o = offerBySkuPre.get(String(r.sku)); if (o) neededOffers.add(o); }
    for (const o of [...neededOffers]) for (const a of getAssociatedOfferIds(cabinet, o)) neededOffers.add(a);
    const neededSkus = new Set();
    for (const r of catalogRows) if (r.sku != null && neededOffers.has(r.offer_id)) neededSkus.add(String(r.sku));
    for (const c of campaigns) if (c.matched_sku) neededSkus.add(String(c.matched_sku));
    const offerArr = [...neededOffers];
    const skuArr = [...neededSkus].map(Number).filter(Number.isFinite);

    const [adRows, analyticsRows, manualRows, stockRows, stockManualRows, stockHistoryRows, skuStatRows, cpoOrderRows, cpoProductRows] = await Promise.all([
      timed('adstats', query(`SELECT date::text as date, campaign_id, spend, clicks, views, orders, orders_money
             FROM ad_stats_daily WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3`,
             [cabinet, from, to])),
      timed('analytics', query(`SELECT date::text as date, sku, offer_id, hits_view, hits_view_search, hits_view_pdp,
                    hits_tocart, orders_item, revenue, position_category
             FROM product_analytics_daily WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3
              AND (sku = ANY($4::bigint[]) OR offer_id = ANY($5::text[]))`,
             [cabinet, from, to, skuArr, offerArr])),
      // Ручные значения — на случай, если сбор с Ozon для каких-то дат/
      // метрик так и не дал данных (см. product_analytics_manual в
      // init.sql). Приоритет всегда у данных с маркетплейса.
      timed('manual', query(`SELECT date::text as date, offer_id, metric, value
             FROM product_analytics_manual WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3`,
             [cabinet, from, to])),
      // Текущие остатки FBO/FBS — последний собранный снепшот по кабинету.
      timed('stock', query(`SELECT offer_id, fbo_present, fbo_reserved, fbs_present, fbs_reserved
             FROM ad_product_stocks
             WHERE cabinet = $1 AND platform = 'ozon' AND offer_id = ANY($2::text[])
               AND snapshot_date = (SELECT MAX(snapshot_date) FROM ad_product_stocks WHERE cabinet = $1 AND platform = 'ozon')`,
             [cabinet, offerArr])),
      // Ручные остатки — подстраховка, без периода ("текущее" значение).
      timed('stockManual', query(`SELECT offer_id, metric, value FROM ad_stock_manual WHERE cabinet = $1 AND platform = 'ozon'`, [cabinet])),
      // История остатков по дням (FBO+FBS) — с запасом на 30 дней раньше
      // периода: на день без снепшота переносим последний известный.
      timed('stockHistory', query(`SELECT snapshot_date::text as date, offer_id, fbo_present, fbs_present
             FROM ad_product_stocks
             WHERE cabinet = $1 AND platform = 'ozon' AND snapshot_date BETWEEN $2 AND $3 AND offer_id = ANY($4::text[])
             ORDER BY offer_id, snapshot_date`,
             [cabinet, dayjs(from).subtract(30, 'day').format('YYYY-MM-DD'), to, offerArr])),
      // Точные данные по товарам (Google-скрипт): расход за клик по SKU и
      // дню, заказы "оплаты за заказ" и её статус/ставка. Таблиц может ещё не
      // быть (до первого обновления скрипта) — тогда просто пусто.
      timed('skuStats', query(`SELECT date::text AS date, campaign_id, sku, views, clicks, to_cart, orders, sales, expense
             FROM ad_sku_stats_daily WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3`, [cabinet, from, to]).catch(() => [])),
      timed('cpoOrders', query(`SELECT date::text AS date, sku, promoted_sku, quantity, cost, expense
             FROM ad_cpo_orders WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3`, [cabinet, from, to]).catch(() => [])),
      timed('cpoProducts', query(`SELECT sku, offer_id, enabled, available, bid_pct, bid_rub, checked_at
             FROM ad_cpo_products WHERE cabinet = $1 AND platform = 'ozon'`, [cabinet]).catch(() => [])),
    ]);
    const tQueries = Date.now();

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
    // Метрики САМОЙ рекламы (а не всего товара): показы рекламы, заказы и
    // выручка, которые Ozon атрибутирует рекламной кампании. Нужны для
    // "рекламного" ДРР (расход / выручка с рекламы) рядом с общим.
    const adViewsByKey = new Map(), adOrdersByKey = new Map(), adRevenueByKey = new Map();
    for (const r of adRows) {
      const k = `${r.campaign_id}|${r.date}`;
      spendByKey.set(k, Number(r.spend) || 0);
      clicksByKey.set(k, Number(r.clicks) || 0);
      adViewsByKey.set(k, Number(r.views) || 0);
      adOrdersByKey.set(k, Number(r.orders) || 0);
      adRevenueByKey.set(k, Number(r.orders_money) || 0);
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

    // Остаток (FBO+FBS) НА КАЖДЫЙ день периода — для строки "Остаток" в
    // таблицах по дням (а не только "текущее" значение из computeStock
    // выше). На день без собственного снепшота переносим последний
    // известный ДО этой даты (снепшот снимается раз в день — см.
    // collectors/ads/ozonProductStocks.js, delete+insert на snapshot_date).
    const stockHistoryByOffer = new Map(); // offerId -> [{date, value}] (по возрастанию)
    for (const r of stockHistoryRows) {
      const value = (Number(r.fbo_present) || 0) + (Number(r.fbs_present) || 0);
      if (!stockHistoryByOffer.has(r.offer_id)) stockHistoryByOffer.set(r.offer_id, []);
      stockHistoryByOffer.get(r.offer_id).push({ date: r.date, value });
    }
    const stockByOfferDate = new Map(); // offerId|date -> value
    for (const [offerId, rows] of stockHistoryByOffer) {
      let idx = 0, last = null;
      for (const date of dates) {
        while (idx < rows.length && rows[idx].date <= date) { last = rows[idx].value; idx++; }
        if (last !== null) stockByOfferDate.set(`${offerId}|${date}`, last);
      }
    }
    function stockOnDate(offerId, date) {
      if (!offerId) return null;
      const v = stockByOfferDate.get(`${offerId}|${date}`);
      return v === undefined ? null : v;
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

    // Точный расход за клик по артикулу: если Google-скрипт уже прислал
    // статистику по товарам за (кампания, день) — берём её вместо деления
    // поровну. skuCovered — какие (кампания, день) покрыты этими данными.
    const skuCovered = new Set();
    const skuByCampDateOffer = new Map(); // campaign|date|offer -> {expense, clicks, views, toCart, orders, sales}
    for (const r of skuStatRows) {
      const offerId = offerBySkuCat.get(String(r.sku));
      const ck = `${r.campaign_id}|${r.date}`;
      skuCovered.add(ck);
      if (!offerId) continue;
      const k = `${ck}|${offerId}`;
      const cur = skuByCampDateOffer.get(k) || { expense: 0, clicks: 0, views: 0, toCart: 0, orders: 0, sales: 0 };
      cur.expense += Number(r.expense) || 0; cur.clicks += Number(r.clicks) || 0; cur.views += Number(r.views) || 0;
      cur.toCart += Number(r.to_cart) || 0; cur.orders += Number(r.orders) || 0; cur.sales += Number(r.sales) || 0;
      skuByCampDateOffer.set(k, cur);
      // Товар мог попасть в РК, но не в ad_campaign_skus — добавим.
      if (!campaignOfferIds.has(r.campaign_id)) campaignOfferIds.set(r.campaign_id, new Set());
      campaignOfferIds.get(r.campaign_id).add(offerId);
    }

    // "Оплата за заказ" по заказам: точный расход по продвигаемому товару и
    // дню. Пока эти данные есть, сами CPO-кампании в расход не считаем
    // (иначе задвоили бы) — только в пределах дат, покрытых отчётом.
    const cpoByOfferDate = new Map(); // offer|date -> {expense, orders, revenue}
    let cpoFrom = null, cpoTo = null;
    for (const r of cpoOrderRows) {
      const offerId = offerBySkuCat.get(String(r.promoted_sku || r.sku)) || offerBySkuCat.get(String(r.sku));
      if (!cpoFrom || r.date < cpoFrom) cpoFrom = r.date;
      if (!cpoTo || r.date > cpoTo) cpoTo = r.date;
      if (!offerId) continue;
      const k = `${offerId}|${r.date}`;
      const cur = cpoByOfferDate.get(k) || { expense: 0, orders: 0, revenue: 0 };
      cur.expense += Number(r.expense) || 0; cur.orders += Number(r.quantity) || 1; cur.revenue += Number(r.cost) || 0;
      cpoByOfferDate.set(k, cur);
    }
    const cpoCovers = date => cpoFrom && date >= cpoFrom && date <= cpoTo;

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
        const byDate = {};
        const isCpo = String(camp.payment_type || '').toUpperCase() === 'CPO';
        let totalSpend = 0, totalClicks = 0, totalAdViews = 0, totalAdOrders = 0, totalAdRevenue = 0;
        let splitDays = 0;
        for (const date of dates) {
          const k = `${camp.campaign_id}|${date}`;
          let spend, clicks, adViews, adOrders, adRevenue, adToCart = null;
          if (isCpo && cpoCovers(date)) {
            // Расход этой РК за день уже разнесён по товарам из отчёта по заказам.
            spend = 0; clicks = 0; adViews = 0; adOrders = 0; adRevenue = 0;
          } else if (skuCovered.has(k)) {
            const x = skuByCampDateOffer.get(`${k}|${offerId}`) || { expense: 0, clicks: 0, views: 0, toCart: 0, orders: 0, sales: 0 };
            spend = x.expense; clicks = x.clicks; adViews = x.views; adOrders = x.orders; adRevenue = x.sales; adToCart = x.toCart;
          } else {
            spend = (spendByKey.get(k) || 0) / splitCount;
            clicks = (clicksByKey.get(k) || 0) / splitCount;
            adViews = (adViewsByKey.get(k) || 0) / splitCount;
            adOrders = (adOrdersByKey.get(k) || 0) / splitCount;
            adRevenue = (adRevenueByKey.get(k) || 0) / splitCount;
            if (splitCount > 1 && (spendByKey.get(k) || 0) > 0) splitDays++;
          }
          totalSpend += spend; totalClicks += clicks;
          totalAdViews += adViews; totalAdOrders += adOrders; totalAdRevenue += adRevenue;
          // Средняя цена клика за день — расход / клики (клики собираются
          // отдельно через collectors/ads/ozonClicks.js, т.к. эндпоинт расхода
          // их не отдаёт). 0, если кликов не было — не делить на 0.
          byDate[date] = { spend, clicks, avgCpc: clicks > 0 ? spend / clicks : 0, adViews, adOrders, adRevenue, adToCart };
          // Тип оплаты кампании — чтобы показывать расход отдельно "за клик"
          // и "за заказ" (CPO: "Оплата за заказ"), а не только общей суммой.
          if (isCpo) byDate[date].spendCpo = spend; else byDate[date].spendCpc = spend;
        }
        // Кампании без единого рубля расхода за период — VK/блогерские
        // реф-ссылки, архивные, завершённые — раньше уходили на фронт с
        // полной историей по дням (≈780 из 920 штук, 2,5 МБ ответа) и только
        // мешали. Оставляем лишь ЗАПУЩЕННЫЕ товарные РК без расхода (только
        // что включили — пусть будут видны в карточке артикула).
        const isProductAd = ['SKU', 'SEARCH_PROMO'].includes(String(camp.adv_object_type || '').toUpperCase());
        if (totalSpend <= 0 && !(camp.state === 'CAMPAIGN_STATE_RUNNING' && isProductAd)) continue;
        const article = getArticle(offerId, sku);
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
          totalAdViews,
          totalAdOrders,
          totalAdRevenue,
          avgCpc: totalClicks > 0 ? totalSpend / totalClicks : 0,
          // Фронту — чтобы показать "расход поделен поровну на N товаров
          // кампании" вместо того, чтобы молча выдавать точную с виду цифру.
          splitAcross: splitCount > 1 && splitDays > 0 ? splitCount : null,
          byDate,
        });
      }
    }

    // Расход "оплаты за заказ" по товарам — отдельной строкой-кампанией у
    // каждого артикула (точные суммы из отчёта по заказам).
    const cpoTotalsByOffer = new Map();
    for (const [k, v] of cpoByOfferDate) {
      const [offerId] = k.split('|');
      cpoTotalsByOffer.set(offerId, (cpoTotalsByOffer.get(offerId) || 0) + v.expense);
    }
    for (const [offerId, cpoTotal] of cpoTotalsByOffer) {
      if (!(cpoTotal > 0)) continue; // без списаний — не заводим строку и карточку
      const byDate = {};
      let totalSpend = 0, totalAdOrders = 0, totalAdRevenue = 0;
      for (const date of dates) {
        const v = cpoByOfferDate.get(`${offerId}|${date}`) || { expense: 0, orders: 0, revenue: 0 };
        byDate[date] = { spend: v.expense, spendCpo: v.expense, clicks: 0, avgCpc: 0, adViews: 0, adOrders: v.orders, adRevenue: v.revenue, adToCart: null };
        totalSpend += v.expense; totalAdOrders += v.orders; totalAdRevenue += v.revenue;
      }
      const article = getArticle(offerId, skuByOfferId.get(offerId) || null);
      article.campaigns.push({
        campaignId: `cpo:${offerId}`, title: 'Оплата за заказ (по заказам)', state: 'CAMPAIGN_STATE_RUNNING',
        advObjectType: 'SEARCH_PROMO', paymentType: 'CPO', totalSpend, totalClicks: 0, totalAdViews: 0,
        totalAdOrders, totalAdRevenue, avgCpc: 0, splitAcross: null, byDate,
      });
    }

    // Статус "оплаты за заказ" на товаре и текущая ставка.
    const cpoStatusByOffer = new Map();
    for (const r of cpoProductRows) {
      const offerId = offerBySkuCat.get(String(r.sku)) || r.offer_id;
      if (offerId) cpoStatusByOffer.set(offerId, {
        enabled: !!r.enabled, available: r.available !== false,
        bidPct: r.bid_pct !== null ? Number(r.bid_pct) : null, bidRub: r.bid_rub !== null ? Number(r.bid_rub) : null,
        checkedAt: r.checked_at,
      });
    }

    // Принудительно заводим карточки для артикулов без единой РК (значит,
    // цикл по campaigns выше их не создал), но отнесённых к какой-то
    // группе — чтобы артикул склейки без своей рекламы всё равно
    // показывался внутри группы: без расхода/ДРР/кампаний, но с показами/
    // корзиной/заказами из product_analytics_daily (см. analyticsByOfferDate
    // и фолбэк на него в цикле ниже, т.к. у такого артикула нет sku из
    // ad_campaigns). Без этого "+ Добавить артикул" мог отнести артикул,
    // который потом просто не появлялся бы в списке группы.
    const groupMembersForStats = groupsInfo.members || {};
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
      let totalClicks = 0, totalAdViews = 0, totalAdOrders = 0, totalAdRevenue = 0, totalSpendCpc = 0, totalSpendCpo = 0;
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
        const sumCamp = key => article.campaigns.reduce((s, c) => s + (c.byDate[date]?.[key] || 0), 0);
        const adViews = sumCamp('adViews'), adOrders = sumCamp('adOrders'), adRevenue = sumCamp('adRevenue');
        // Корзины из рекламы есть только в статистике по товарам — если её
        // нет ни у одной РК за день, оставляем null ("нет данных"), а не 0.
        const toCartKnown = article.campaigns.some(c => c.byDate[date]?.adToCart !== null && c.byDate[date]?.adToCart !== undefined);
        const adToCart = toCartKnown ? sumCamp('adToCart') : null;
        const spendCpc = sumCamp('spendCpc'), spendCpo = sumCamp('spendCpo');
        totalSpendCpc += spendCpc; totalSpendCpo += spendCpo;
        totalClicks += mpClicks; totalAdViews += adViews; totalAdOrders += adOrders; totalAdRevenue += adRevenue;

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
          clicks: mpClicks,
          adViews, adOrders, adRevenue, adToCart, spendCpc, spendCpo,
          stock: stockOnDate(article.offerId, date),
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
      const stock = article.offerId ? computeStock(article.offerId) : null;

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
        sku: article.sku || (article.offerId ? skuByOfferId.get(article.offerId) || null : null),
        productName: article.productName,
        byDate,
        totals: {
          revenue: totalRevenue, orders: totalOrders, views: totalViews, pdpViews: totalPdpViews, cart: totalCart,
          spend: totalSpend, drr: totalDrr,
          ctr: totalCtr, crToCart: totalCrToCart, crToOrder: totalCrToOrder,
          clicks: totalClicks, adViews: totalAdViews, adOrders: totalAdOrders, adRevenue: totalAdRevenue,
          spendCpc: totalSpendCpc, spendCpo: totalSpendCpo,
          // Рекламный ДРР — расход / выручка, которую Ozon отнёс к рекламе.
          // null, если рекламной выручки не было (делить не на что).
          adDrr: totalAdRevenue > 0 ? totalSpend / totalAdRevenue * 100 : null,
          adCtr: totalAdViews > 0 ? totalClicks / totalAdViews * 100 : null,
        },
        campaigns: article.campaigns,
        stock,
        cpo: article.offerId ? (cpoStatusByOffer.get(article.offerId) || null) : null,
        // На сколько дней хватит текущего остатка при темпе заказов последних
        // 7 полных дней периода (сегодняшний неполный день не считаем).
        // null — заказов не было, оценить нельзя.
        stockDays: (() => {
          if (!stock) return null;
          const today = dayjs().format('YYYY-MM-DD');
          const full = dates.filter(d => d < today).slice(-7);
          if (!full.length) return null;
          const perDay = full.reduce((acc, d) => acc + (byDate[d]?.orders || 0), 0) / full.length;
          if (perDay <= 0) return null;
          return (stock.fboPresent + stock.fbsPresent) / perDay;
        })(),
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

    // Прошлый период той же длины (для "лучше/хуже" в воронке и сводке) —
    // только по запросу (?compare=1), лёгкими агрегатами без истории по дням.
    if (req.query.compare === '1') {
      const len = dates.length;
      const pFrom = dayjs(from).subtract(len, 'day').format('YYYY-MM-DD');
      const pTo = dayjs(from).subtract(1, 'day').format('YYYY-MM-DD');
      const [pAn, pAd] = await Promise.all([
        timed('prevAnalytics', query(
          `SELECT sku, offer_id, SUM(hits_view) v, SUM(hits_view_pdp) pv, SUM(hits_tocart) c, SUM(orders_item) o, SUM(revenue) r
             FROM product_analytics_daily WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3
              AND (sku = ANY($4::bigint[]) OR offer_id = ANY($5::text[]))
            GROUP BY sku, offer_id`, [cabinet, pFrom, pTo, skuArr, offerArr])),
        timed('prevAdstats', query(
          `SELECT campaign_id, SUM(spend) s, SUM(clicks) cl, SUM(views) av, SUM(orders) ao, SUM(orders_money) ar
             FROM ad_stats_daily WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3
            GROUP BY campaign_id`, [cabinet, pFrom, pTo])),
      ]);
      const anBySku = new Map(), anByOffer = new Map();
      for (const r of pAn) {
        anBySku.set(String(r.sku), r);
        const oid = r.offer_id || offerBySkuCat.get(String(r.sku));
        if (oid) anByOffer.set(oid, r);
      }
      const adByCamp = new Map(pAd.map(r => [String(r.campaign_id), r]));
      for (const a of articlesOut) {
        const an = (a.sku && anBySku.get(String(a.sku))) || (a.offerId && anByOffer.get(a.offerId)) || null;
        let spend = 0, clicks = 0, adViews = 0, adOrders = 0, adRevenue = 0;
        for (const c of a.campaigns) {
          const r = adByCamp.get(String(c.campaignId)); if (!r) continue;
          const k = c.splitAcross || 1;
          spend += (Number(r.s) || 0) / k; clicks += (Number(r.cl) || 0) / k;
          adViews += (Number(r.av) || 0) / k; adOrders += (Number(r.ao) || 0) / k; adRevenue += (Number(r.ar) || 0) / k;
        }
        const n = x => Number(x) || 0;
        a.prevTotals = {
          views: n(an?.v), pdpViews: n(an?.pv), cart: n(an?.c), orders: n(an?.o), revenue: n(an?.r),
          spend, clicks, adViews, adOrders, adRevenue,
        };
      }
    }

    timings.push(`compute;dur=${Date.now() - tQueries}`);
    timings.push(`total;dur=${Date.now() - tStart}`);
    res.set('Server-Timing', timings.join(', '));
    res.json({ success: true, data: { dates, articles: articlesOut } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
