const express = require('express');
const router = express.Router();
const dayjs = require('dayjs');
const { query } = require('../db');
const { ORDER } = require('../lib/categories');
const { districtOf, DISTRICT_ORDER } = require('../lib/regions');
const { meta } = require('./finance');
const { ensureFinTables } = require('../collectors/ads/sheetSync');

// ─────────────────────────────────────────────────────────────────────────
// «Остатки»: остатки FBO (по складам/кластерам) и FBS, спрос по кластерам
// доставки (заказы из GeoOrders), темп продаж и история остатков по дням.
// Все расчёты «на сколько хватит», сигналы и рекомендации — на странице.
// ─────────────────────────────────────────────────────────────────────────

const num = v => Number(v) || 0;
// Ключ кластера: «Москва, МО и Дальние регионы» и «Москва» — один кластер.
const ckey = name => String(name || '').toLowerCase().replace(/ё/g, 'е').split(/[ ,_(-]/)[0];

router.get('/data', async (req, res) => {
  try {
    await ensureFinTables();
    const cabinet = req.query.cabinet || 'defly';
    const days = Math.max(7, Math.min(60, Number(req.query.days) || 14));
    const today = dayjs().format('YYYY-MM-DD');
    const histFrom = dayjs().subtract(59, 'day').format('YYYY-MM-DD');
    const wFrom = dayjs().subtract(days, 'day').format('YYYY-MM-DD'), wTo = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    const pFrom = dayjs().subtract(days * 2, 'day').format('YYYY-MM-DD'), pTo = dayjs().subtract(days + 1, 'day').format('YYYY-MM-DD');
    const m = await meta(cabinet);
    const [snap, hist, clDate, geo, ord, buy] = await Promise.all([
      query(`SELECT DISTINCT ON (offer_id) offer_id, snapshot_date::text d, fbo_present, fbo_reserved, fbs_present, fbs_reserved
               FROM ad_product_stocks WHERE cabinet = $1 AND platform = 'ozon' AND snapshot_date >= $2
              ORDER BY offer_id, snapshot_date DESC, collected_at DESC`, [cabinet, dayjs().subtract(5, 'day').format('YYYY-MM-DD')]),
      query(`SELECT DISTINCT ON (offer_id, snapshot_date) offer_id, snapshot_date::text d, fbo_present, fbs_present
               FROM ad_product_stocks WHERE cabinet = $1 AND platform = 'ozon' AND snapshot_date >= $2
              ORDER BY offer_id, snapshot_date, collected_at DESC`, [cabinet, histFrom]),
      query(`SELECT MAX(date)::text d FROM stock_cluster_daily WHERE cabinet = $1`, [cabinet]),
      query(`SELECT offer_id, region cluster, SUM(CASE WHEN date BETWEEN $2 AND $3 THEN qty ELSE 0 END)::int q,
                    SUM(CASE WHEN date BETWEEN $4 AND $5 THEN qty ELSE 0 END)::int p
               FROM sales_geo_daily WHERE cabinet = $1 AND date BETWEEN $4 AND $3 GROUP BY offer_id, region`, [cabinet, wFrom, wTo, pFrom, pTo]).catch(() => []),
      query(`SELECT offer_id, date::text d, SUM(orders_item)::int q, SUM(revenue) r FROM product_analytics_daily
              WHERE cabinet = $1 AND platform = 'ozon' AND date >= $2 GROUP BY offer_id, date`, [cabinet, histFrom]),
      query(`SELECT offer_id, date::text d, ordered, COALESCE(ordered_fbs, 0) f FROM buyout_daily WHERE cabinet = $1 AND date >= $2`, [cabinet, histFrom]).catch(() => []),
    ]);
    const lastCl = clDate[0]?.d || null;
    const [cl, clHist] = await Promise.all([
      lastCl ? query(`SELECT offer_id, cluster, SUM(available)::int a, SUM(transit)::int t, SUM(reserved)::int r, MAX(ads) ads, MAX(idc) idc
                        FROM stock_cluster_daily WHERE cabinet = $1 AND date = $2 GROUP BY offer_id, cluster`, [cabinet, lastCl]) : [],
      query(`SELECT date::text d, offer_id, cluster, SUM(available)::int a FROM stock_cluster_daily WHERE cabinet = $1 AND date >= $2
              GROUP BY date, offer_id, cluster`, [cabinet, histFrom]).catch(() => []),
    ]);
    const dates = []; for (let d = dayjs(histFrom); !d.isAfter(today, 'day'); d = d.add(1, 'day')) dates.push(d.format('YYYY-MM-DD'));
    const di = new Map(dates.map((d, i) => [d, i]));
    // Кластеры: объединяем названия из остатков и из заказов.
    const clusters = [], cIdx = new Map();
    const cl_ = name => {
      const k = ckey(name); if (!k) return null;
      if (cIdx.has(k)) { const c = clusters[cIdx.get(k)]; if (String(name).length > c.name.length) c.name = String(name); return cIdx.get(k); }
      cIdx.set(k, clusters.length); clusters.push({ name: String(name) }); return clusters.length - 1;
    };
    const A = m.art;
    const out = {
      stock: snap.filter(r => r.d).map(r => [A(r.offer_id), Math.max(0, num(r.fbo_present) - num(r.fbo_reserved)), num(r.fbo_reserved), Math.max(0, num(r.fbs_present) - num(r.fbs_reserved)), num(r.fbs_reserved)]),
      hist: hist.filter(r => di.has(r.d)).map(r => [A(r.offer_id), di.get(r.d), num(r.fbo_present), num(r.fbs_present)]),
      cl: cl.map(r => [A(r.offer_id), cl_(r.cluster), num(r.a), num(r.t), num(r.r), r.ads == null ? null : num(r.ads), r.idc == null ? null : num(r.idc)]).filter(r => r[1] !== null),
      demand: geo.map(r => [A(r.offer_id), cl_(r.cluster), num(r.q), num(r.p)]).filter(r => r[1] !== null && (r[2] || r[3])),
      orders: ord.filter(r => di.has(r.d) && (num(r.q) || num(r.r))).map(r => [A(r.offer_id), di.get(r.d), num(r.q), Math.round(num(r.r))]),
      fbs: buy.filter(r => di.has(r.d) && num(r.ordered)).map(r => [A(r.offer_id), di.get(r.d), num(r.ordered), num(r.f)]),
    };
    const clTot = new Map();
    for (const r of clHist) { const d = di.get(r.d); const c = cl_(r.cluster); if (d === undefined || c === null) continue; const k = A(r.offer_id) + '|' + c + '|' + d; clTot.set(k, (clTot.get(k) || 0) + num(r.a)); }
    out.clHist = [...clTot.entries()].map(([k, v]) => { const [a, c, d] = k.split('|').map(Number); return [a, c, d, v]; });
    clusters.forEach(c => { c.district = districtOf(c.name); });
    res.json({ success: true, data: {
      ...out, dates, days, clusters, districts: DISTRICT_ORDER, articles: m.articles, order: ORDER[cabinet] || [],
      stockDate: snap.reduce((mx, r) => (r.d > mx ? r.d : mx), ''), clusterDate: lastCl,
    } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
