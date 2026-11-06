const express = require('express');
const router = express.Router();
const dayjs = require('dayjs');
const { query } = require('../db');
const { ORDER } = require('../lib/categories');
const { meta } = require('./finance');
const { ensureFinTables } = require('../collectors/ads/sheetSync');

const num = v => Number(v) || 0;
const r2 = v => Math.round(v * 100) / 100;

// GET /api/queries/data?cabinet=&dateFrom=&dateTo= — пары «товар × запрос» за
// период: средняя позиция (взвешенная по частоте), частота, клики, заказы,
// выручка; позиция в первой и второй половине периода — для динамики.
router.get('/data', async (req, res) => {
  try {
    await ensureFinTables();
    const cabinet = req.query.cabinet || 'defly';
    const to = req.query.dateTo || dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    const from = req.query.dateFrom || dayjs(to).subtract(13, 'day').format('YYYY-MM-DD');
    const mid = dayjs(from).add(Math.floor(dayjs(to).diff(from, 'day') / 2), 'day').format('YYYY-MM-DD');
    const m = await meta(cabinet);
    const skuToOffer = new Map([...m.offerBySku.entries()]);
    const [rows, range] = await Promise.all([
      query(`SELECT sku, query, SUM(searches)::int s, SUM(clicks)::int c, SUM(orders)::int o, SUM(revenue) r,
                    SUM(position * GREATEST(searches, 1)) / NULLIF(SUM(GREATEST(searches, 1)) FILTER (WHERE position IS NOT NULL), 0) p,
                    SUM(position * GREATEST(searches, 1)) FILTER (WHERE date <= $4) / NULLIF(SUM(GREATEST(searches, 1)) FILTER (WHERE date <= $4 AND position IS NOT NULL), 0) p1,
                    SUM(position * GREATEST(searches, 1)) FILTER (WHERE date > $4) / NULLIF(SUM(GREATEST(searches, 1)) FILTER (WHERE date > $4 AND position IS NOT NULL), 0) p2
               FROM search_query_daily WHERE cabinet = $1 AND date BETWEEN $2 AND $3 GROUP BY sku, query`, [cabinet, from, to, mid]),
      query(`SELECT MIN(date)::text mn, MAX(date)::text mx FROM search_query_daily WHERE cabinet = $1`, [cabinet]),
    ]);
    const queries = [], qi = new Map();
    const out = [];
    for (const r of rows) {
      const o = skuToOffer.get(String(r.sku)); if (!o) continue;
      if (!qi.has(r.query)) { qi.set(r.query, queries.length); queries.push(r.query); }
      out.push([m.art(o), qi.get(r.query), r.p == null ? null : r2(num(r.p)), num(r.s), num(r.c), num(r.o), Math.round(num(r.r)), r.p1 == null ? null : r2(num(r.p1)), r.p2 == null ? null : r2(num(r.p2))]);
    }
    res.json({ success: true, data: { from, to, articles: m.articles, order: ORDER[cabinet] || [], queries, rows: out, available: range[0] || null } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/queries/series?cabinet=&offerId=&query=&days= — по дням: позиция и частота
// (если query не задан — все запросы товара).
router.get('/series', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'defly';
    const days = Math.min(60, Number(req.query.days) || 30);
    const from = dayjs().subtract(days, 'day').format('YYYY-MM-DD');
    const sku = await query(`SELECT sku FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon' AND offer_id = $2 AND sku IS NOT NULL`, [cabinet, req.query.offerId]);
    const skus = sku.map(r => num(r.sku));
    const params = [cabinet, from, skus];
    let cond = '';
    if (req.query.query) { params.push(req.query.query); cond = ' AND query = $4'; }
    const rows = skus.length ? await query(`SELECT date::text d, query, position, searches, clicks, orders FROM search_query_daily
      WHERE cabinet = $1 AND date >= $2 AND sku = ANY($3::bigint[])${cond} ORDER BY date`, params) : [];
    res.json({ success: true, data: rows.map(r => [r.d, r.query, r.position == null ? null : num(r.position), num(r.searches), num(r.clicks), num(r.orders)]) });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/queries/arts?cabinet=&dateFrom=&dateTo= — товары, у которых есть
// данные по запросам: [индекс артикула, запросов, искали (сумма по
// запросам), увидели, заказы, сумма]. Для выбора артикула.
router.get('/arts', async (req, res) => {
  try {
    await ensureFinTables();
    const cabinet = req.query.cabinet || 'defly';
    const to = req.query.dateTo || dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    const from = req.query.dateFrom || dayjs(to).subtract(13, 'day').format('YYYY-MM-DD');
    const m = await meta(cabinet);
    const rows = await query(`SELECT sku, COUNT(DISTINCT query)::int n, SUM(searches)::int s, SUM(views)::int v, SUM(orders)::int o, SUM(revenue) r
      FROM search_query_daily WHERE cabinet = $1 AND date BETWEEN $2 AND $3 GROUP BY sku`, [cabinet, from, to]);
    const agg = new Map();
    for (const r of rows) {
      const o = m.offerBySku.get(String(r.sku)); if (!o) continue;
      const ai = m.art(o);
      const a = agg.get(ai) || [ai, 0, 0, 0, 0, 0];
      a[1] = Math.max(a[1], num(r.n)); a[2] += num(r.s); a[3] += num(r.v); a[4] += num(r.o); a[5] += Math.round(num(r.r));
      agg.set(ai, a);
    }
    res.json({ success: true, data: { from, to, articles: m.articles, order: ORDER[cabinet] || [], rows: [...agg.values()] } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// Ручные группы запросов: app_settings query_groups:<кабинет> = { запрос: группа }.
const GROUP_KEYS = ['target', 'model', 'type', 'other'];
async function loadGroups(cabinet) {
  const rows = await query(`SELECT value FROM app_settings WHERE key = $1`, [`query_groups:${cabinet}`]).catch(() => []);
  try { return JSON.parse(rows[0]?.value || '{}') || {}; } catch (e) { return {}; }
}

// GET /api/queries/article?cabinet=&offerId=&dateFrom=&dateTo= — все запросы
// товара по дням: [дата, запрос, позиция, искали, увидели, переходы, заказы,
// сумма]. Если у артикула несколько SKU: «искали» — максимум (это одни и те
// же люди), позиция — лучшая, остальное складывается.
router.get('/article', async (req, res) => {
  try {
    await ensureFinTables();
    const cabinet = req.query.cabinet || 'defly';
    const offerId = String(req.query.offerId || '');
    const to = req.query.dateTo || dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    const from = req.query.dateFrom || dayjs(to).subtract(13, 'day').format('YYYY-MM-DD');
    const cat = await query(`SELECT sku, product_name FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon' AND offer_id = $2`, [cabinet, offerId]);
    const skus = cat.filter(r => r.sku != null).map(r => num(r.sku));
    const rows = skus.length ? await query(`SELECT date::text d, query, MIN(position) p, MAX(searches)::int s, SUM(views)::int v, SUM(clicks)::int c, SUM(orders)::int o, SUM(revenue) r
      FROM search_query_daily WHERE cabinet = $1 AND date BETWEEN $2 AND $3 AND sku = ANY($4::bigint[])
      GROUP BY date, query ORDER BY date`, [cabinet, from, to, skus]) : [];
    res.json({ success: true, data: {
      offerId, name: cat.find(r => r.product_name)?.product_name || '', from, to,
      rows: rows.map(r => [r.d, r.query, r.p == null ? null : r2(num(r.p)), num(r.s), num(r.v), num(r.c), num(r.o), Math.round(num(r.r))]),
      groups: await loadGroups(cabinet),
      freq: await loadFreq(cabinet),
    } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// Пороги частотности (искали за 30 дней): app_settings query_freq:<кабинет> = {hi, mid}.
async function loadFreq(cabinet) {
  const rows = await query(`SELECT value FROM app_settings WHERE key = $1`, [`query_freq:${cabinet}`]).catch(() => []);
  try { const v = JSON.parse(rows[0]?.value || 'null'); return v && v.hi > 0 && v.mid > 0 ? v : null; } catch (e) { return null; }
}
// POST /api/queries/freq {cabinet, hi, mid}
router.post('/freq', async (req, res) => {
  try {
    const { cabinet = 'defly' } = req.body || {};
    const hi = Math.round(Number(req.body?.hi)), mid = Math.round(Number(req.body?.mid));
    if (!(hi > 0 && mid > 0 && mid < hi)) return res.status(400).json({ success: false, error: 'Порог ВЧ должен быть больше порога СЧ' });
    await query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [`query_freq:${cabinet}`, JSON.stringify({ hi, mid })]);
    res.json({ success: true, data: { hi, mid } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/queries/groups {cabinet, query, group} — отнести запрос к группе
// вручную; group = null — вернуть автоматическую.
router.post('/groups', async (req, res) => {
  try {
    const { cabinet = 'defly', query: q, group } = req.body || {};
    if (!q || (group != null && !GROUP_KEYS.includes(group))) return res.status(400).json({ success: false, error: 'Нужны запрос и группа' });
    const g = await loadGroups(cabinet);
    if (group == null) delete g[q]; else g[String(q).slice(0, 200)] = group;
    await query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [`query_groups:${cabinet}`, JSON.stringify(g)]);
    res.json({ success: true, data: g });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/queries/season?cabinet= — продажи по месяцам: [ai, monthIdx, revenue, orders].
router.get('/season', async (req, res) => {
  try {
    await ensureFinTables();
    const cabinet = req.query.cabinet || 'defly';
    const m = await meta(cabinet);
    const rows = await query(`SELECT month, sku, revenue, orders FROM analytics_monthly WHERE cabinet = $1 ORDER BY month`, [cabinet]);
    const months = [...new Set(rows.map(r => r.month))].sort();
    const mi = new Map(months.map((x, i) => [x, i]));
    const out = [];
    const agg = new Map();
    for (const r of rows) {
      const o = m.offerBySku.get(String(r.sku)); if (!o) continue;
      const k = m.art(o) + '|' + mi.get(r.month);
      const a = agg.get(k) || [0, 0]; a[0] += num(r.revenue); a[1] += num(r.orders); agg.set(k, a);
    }
    for (const [k, [rv, o]] of agg) { const [ai, i] = k.split('|').map(Number); out.push([ai, i, Math.round(rv), o]); }
    res.json({ success: true, data: { articles: m.articles, order: ORDER[cabinet] || [], months, rows: out } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
