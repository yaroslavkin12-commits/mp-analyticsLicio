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
