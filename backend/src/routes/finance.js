const express = require('express');
const router = express.Router();
const dayjs = require('dayjs');
const { query } = require('../db');
const { autoPath, carBrand, ORDER } = require('../lib/categories');
const { ensureFinTables } = require('../collectors/ads/sheetSync');

// ─────────────────────────────────────────────────────────────────────────
// Юнит-экономика, P&L и % выкупа.
//
// Источники (собирает Google-скрипт → таблица → база):
//   finance_daily  — фактические начисления/списания Ozon по дням и SKU
//                    (продажа, комиссия, каждая услуга отдельной строкой);
//   buyout_daily   — заказы по дню заказа: заказано/доставлено/отменено/в пути;
//   product_prices — комиссии и тарифы из карточки товара;
//   product_costs  — себестоимость (вкладка «Себестоимость»).
// Статьи Ozon раскладываются по группам расходов по названию (BUCKETS).
// ─────────────────────────────────────────────────────────────────────────

const BUCKETS = [
  ['sale', /^Продажа$/],
  ['return', /^Возврат выручки$/],
  ['commission', /комисси/i],
  ['acquiring', /acquiring|эквайр/i],
  // Реклама Ozon (оплата за клик / за заказ) — списывается из начислений.
  ['ads', /payperclick|costperorder|^promotion$|оплата за клик|оплата за заказ|трафарет|продвижение в поиске/i],
  ['logistics', /logistic|deliv|directflowtrans|drop-?off|pick-?up|fulfillment|returnflow|returnnotdeliv|returnafterdeliv|returnpartgoods|redistribution|cross-?dock|lastmile|last ?mile|packing|package|handover|supplyinbound|rfbs|логистик|доставк|обратн|магистрал|кросс-?док|сборк|обработк|упаков/i],
  ['storage', /storage|placement|хранени|размещени/i],
  ['promo', /marketing|продвиж|cashback|кешбэк|баллы|брендир|отзыв|review|label|star|bonus|premium|analytics/i],
  ['other', /.*/],
];
const bucketOf = name => (BUCKETS.find(([, re]) => re.test(String(name || ''))) || ['other'])[0];
const BUCKET_KEYS = BUCKETS.map(b => b[0]);

function period(q, defDays = 30) {
  let from, to;
  if (q.dateFrom && q.dateTo) {
    from = dayjs(q.dateFrom).format('YYYY-MM-DD'); to = dayjs(q.dateTo).format('YYYY-MM-DD');
    if (dayjs(to).isBefore(from)) [from, to] = [to, from];
    if (dayjs(to).diff(from, 'day') > 92) from = dayjs(to).subtract(92, 'day').format('YYYY-MM-DD');
  } else { to = dayjs().format('YYYY-MM-DD'); from = dayjs().subtract(defDays - 1, 'day').format('YYYY-MM-DD'); }
  const dates = [];
  for (let d = dayjs(from); !d.isAfter(to, 'day'); d = d.add(1, 'day')) dates.push(d.format('YYYY-MM-DD'));
  return { from, to, dates };
}
const num = v => Number(v) || 0;
const r2 = v => Math.round(v * 100) / 100;

async function meta(cabinet) {
  const [catalog, overrides] = await Promise.all([
    query(`SELECT offer_id, sku, product_name FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon'`, [cabinet]),
    query(`SELECT offer_id, path FROM product_category_override WHERE cabinet = $1`, [cabinet]).catch(() => []),
  ]);
  const ov = new Map(overrides.map(r => [r.offer_id, r.path]));
  const articles = [], idx = new Map();
  const art = (o, name) => {
    if (idx.has(o)) return idx.get(o);
    const n = name || '';
    idx.set(o, articles.length);
    articles.push({ o, n, cat: ov.get(o) || autoPath(cabinet, n, o).join(' / '), brand: cabinet === 'defly' ? carBrand(n) : null });
    return articles.length - 1;
  };
  for (const r of catalog) art(r.offer_id, r.product_name);
  const offerBySku = new Map(catalog.filter(r => r.sku != null).map(r => [String(r.sku), r.offer_id]));
  return { articles, art, offerBySku };
}

// GET /api/finance/coefs?cabinet= — средние за последние 30 дней по каждому
// артикулу: суммы из финансов, выкуп, комиссия/эквайринг из карточки,
// себестоимость. Коэффициенты (с подстраховкой по категории) считает страница.
router.get('/coefs', async (req, res) => {
  try {
    await ensureFinTables();
    const cabinet = req.query.cabinet || 'defly';
    const since = dayjs().subtract(30, 'day').format('YYYY-MM-DD');
    const bFrom = dayjs().subtract(45, 'day').format('YYYY-MM-DD'), bTo = dayjs().subtract(5, 'day').format('YYYY-MM-DD');
    const m = await meta(cabinet);
    const [fin, buy, ord, prices, costs, names] = await Promise.all([
      query(`SELECT sku, name, SUM(amount) a, SUM(qty) q FROM finance_daily WHERE cabinet = $1 AND date >= $2 GROUP BY sku, name`, [cabinet, since]),
      query(`SELECT offer_id, SUM(delivered)::int d, SUM(cancelled)::int c, SUM(in_progress)::int p FROM buyout_daily
              WHERE cabinet = $1 AND date BETWEEN $2 AND $3 GROUP BY offer_id`, [cabinet, bFrom, bTo]),
      query(`SELECT offer_id, SUM(ordered)::int o, SUM(COALESCE(ordered_fbs, 0))::int f FROM buyout_daily WHERE cabinet = $1 AND date >= $2 GROUP BY offer_id`, [cabinet, since]),
      query(`SELECT offer_id, price, seller_price, acquiring, pct_fbo, pct_fbs FROM product_prices WHERE cabinet = $1`, [cabinet]),
      query(`SELECT article, cost_price, cabinet FROM product_costs`),
      query(`SELECT name, SUM(amount) a FROM finance_daily WHERE cabinet = $1 AND date >= $2 GROUP BY name ORDER BY SUM(amount)`, [cabinet, since]),
    ]);
    // [saleAmt, saleQty, commission, logistics, acquiring, storage, promo, other, ordered30, delivered, cancelled, pctFbo, acqPerItem, price, cost, pctFbs, ordered30Fbs, ads]
    const C = new Map();
    const get = ai => { if (!C.has(ai)) C.set(ai, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, null, null, null, null, null, 0, 0]); return C.get(ai); };
    const noSku = {};
    for (const r of fin) {
      const b = bucketOf(r.name), a = num(r.a), q = num(r.q);
      const o = r.sku ? m.offerBySku.get(String(r.sku)) : null;
      if (!o) { noSku[b] = (noSku[b] || 0) + a; continue; }
      const x = get(m.art(o));
      if (b === 'sale') { x[0] += a; x[1] += q; }
      else if (b === 'return') { x[0] += a; x[1] -= Math.abs(q); }
      else if (b === 'commission') x[2] += a;
      else if (b === 'logistics') x[3] += a;
      else if (b === 'acquiring') x[4] += a;
      else if (b === 'storage') x[5] += a;
      else if (b === 'promo') x[6] += a;
      else if (b === 'ads') x[17] += a;
      else x[7] += a;
    }
    for (const r of ord) { const x = get(m.art(r.offer_id)); x[8] = num(r.o); x[16] = num(r.f); }
    for (const r of buy) { const x = get(m.art(r.offer_id)); x[9] = num(r.d); x[10] = num(r.c); }
    for (const r of prices) { const x = get(m.art(r.offer_id)); x[11] = num(r.pct_fbo); x[12] = num(r.acquiring); x[13] = num(r.seller_price) || num(r.price); x[15] = num(r.pct_fbs) || null; }
    const fbsRows = await query(`SELECT date::text d, offer_id, ordered, COALESCE(ordered_fbs, 0) f FROM buyout_daily WHERE cabinet = $1 AND date >= $2 AND ordered > 0`,
      [cabinet, dayjs().subtract(92, 'day').format('YYYY-MM-DD')]);
    const fbsDays = fbsRows.map(r => [m.art(r.offer_id), r.d, num(r.ordered), num(r.f)]);
    const known = new Set(m.articles.map(a => a.o));
    for (const r of costs) if ((!r.cabinet || r.cabinet === cabinet) && known.has(r.article)) get(m.art(r.article))[14] = num(r.cost_price);
    const coefs = [...C.entries()].map(([ai, v]) => [ai, ...v.map(x => (x === null ? null : r2(x)))]);
    const totalSale = coefs.reduce((s, c) => s + (c[1] > 0 ? c[1] : 0), 0);
    res.json({ success: true, data: {
      articles: m.articles, coefs, noSku: Object.fromEntries(Object.entries(noSku).map(([k, v]) => [k, r2(v)])), totalSale: r2(totalSale),
      names: names.map(r => [r.name, bucketOf(r.name), r2(num(r.a))]), since, order: ORDER[cabinet] || [], fbsDays,
    } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/finance/pnl?cabinet=&dateFrom=&dateTo= — фактические начисления по
// дням: [ai, di, bucketIdx, amount, qty]; без SKU — отдельно по дням; реклама
// — по дню списания (оплата за клик — день расхода, за заказ — день выкупа).
router.get('/pnl', async (req, res) => {
  try {
    await ensureFinTables();
    const cabinet = req.query.cabinet || 'defly';
    const { from, to, dates } = period(req.query);
    const m = await meta(cabinet);
    const [fin, adRows, skuRows, cpoRows, campaigns, campSkus, costs, range] = await Promise.all([
      query(`SELECT date::text d, sku, name, SUM(amount) a, SUM(qty) q FROM finance_daily WHERE cabinet = $1 AND date BETWEEN $2 AND $3 GROUP BY date, sku, name`, [cabinet, from, to]),
      query(`SELECT date::text AS date, campaign_id, spend FROM ad_stats_daily WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3`, [cabinet, from, to]),
      query(`SELECT date::text AS date, campaign_id, sku, expense FROM ad_sku_stats_daily WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3`, [cabinet, from, to]).catch(() => []),
      query(`SELECT date::text AS date, sku, promoted_sku, expense FROM ad_cpo_orders WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3`, [cabinet, from, to]).catch(() => []),
      query(`SELECT campaign_id, matched_offer_id, payment_type FROM ad_campaigns WHERE cabinet = $1 AND platform = 'ozon'`, [cabinet]),
      query(`SELECT campaign_id, sku FROM ad_campaign_skus WHERE cabinet = $1 AND platform = 'ozon' AND sku != 0`, [cabinet]).catch(() => []),
      query(`SELECT article, cost_price, cabinet FROM product_costs`),
      query(`SELECT MIN(date)::text mn, MAX(date)::text mx FROM finance_daily WHERE cabinet = $1`, [cabinet]),
    ]);
    const di = new Map(dates.map((d, i) => [d, i]));
    const rows = [], noSku = [];
    for (const r of fin) {
      const d = di.get(r.d); if (d === undefined) continue;
      const b = BUCKET_KEYS.indexOf(bucketOf(r.name));
      const o = r.sku ? m.offerBySku.get(String(r.sku)) : null;
      if (o) rows.push([m.art(o), d, b, r2(num(r.a)), num(r.q)]);
      else noSku.push([d, b, r2(num(r.a))]);
    }
    // Реклама по дню списания.
    const ads = new Map(); // ai|d -> spend
    const addAd = (o, d, v) => { if (!o || !v) return false; const k = m.art(o) + '|' + d; ads.set(k, (ads.get(k) || 0) + v); return true; };
    let adNoSku = new Array(dates.length).fill(0);
    const covered = new Set();
    for (const r of skuRows) { const d = di.get(r.date); if (d === undefined) continue; covered.add(r.campaign_id + '|' + r.date); if (!addAd(m.offerBySku.get(String(r.sku)), d, num(r.expense))) adNoSku[d] += num(r.expense); }
    const campById = new Map(campaigns.map(c => [String(c.campaign_id), c]));
    const campOffers = new Map();
    for (const r of campSkus) { const o = m.offerBySku.get(String(r.sku)); if (!o) continue; const id = String(r.campaign_id); if (!campOffers.has(id)) campOffers.set(id, new Set()); campOffers.get(id).add(o); }
    const cpoDates = new Set(cpoRows.map(r => r.date));
    for (const r of cpoRows) { const d = di.get(r.date); if (d === undefined) continue; const o = m.offerBySku.get(String(r.promoted_sku || r.sku)) || m.offerBySku.get(String(r.sku)); if (!addAd(o, d, num(r.expense))) adNoSku[d] += num(r.expense); }
    for (const r of adRows) {
      const d = di.get(r.date); if (d === undefined) continue;
      const id = String(r.campaign_id), c = campById.get(id), v = num(r.spend);
      if (!v || covered.has(id + '|' + r.date)) continue;
      if (String(c?.payment_type || '').toUpperCase() === 'CPO' && cpoDates.has(r.date)) continue;
      const t = campOffers.has(id) ? [...campOffers.get(id)] : (c?.matched_offer_id ? [c.matched_offer_id] : []);
      if (!t.length) { adNoSku[d] += v; continue; }
      for (const o of t) addAd(o, d, v / t.length);
    }
    const adRowsOut = [...ads.entries()].map(([k, v]) => { const [ai, d] = k.split('|').map(Number); return [ai, d, r2(v)]; });
    const cost = new Map();
    for (const r of costs) if (!r.cabinet || r.cabinet === cabinet) cost.set(r.article, num(r.cost_price));
    res.json({ success: true, data: {
      dates, articles: m.articles, buckets: BUCKET_KEYS, rows, noSku, ads: adRowsOut, adNoSku: adNoSku.map(r2),
      cost: m.articles.map(a => (cost.has(a.o) ? cost.get(a.o) : null)), available: range[0] || null, order: ORDER[cabinet] || [],
    } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/finance/buyout?cabinet=&dateFrom=&dateTo= — заказы по дню заказа:
// [ai, di, ordered, delivered, cancelled, in_progress] + прошлый период.
router.get('/buyout', async (req, res) => {
  try {
    await ensureFinTables();
    const cabinet = req.query.cabinet || 'defly';
    const { from, to, dates } = period(req.query, 45);
    const pFrom = dayjs(from).subtract(dates.length, 'day').format('YYYY-MM-DD'), pTo = dayjs(from).subtract(1, 'day').format('YYYY-MM-DD');
    const m = await meta(cabinet);
    const [cur, prev, range] = await Promise.all([
      query(`SELECT date::text d, offer_id, ordered, delivered, cancelled, in_progress FROM buyout_daily WHERE cabinet = $1 AND date BETWEEN $2 AND $3`, [cabinet, from, to]),
      query(`SELECT offer_id, SUM(ordered)::int o, SUM(delivered)::int d, SUM(cancelled)::int c, SUM(in_progress)::int p FROM buyout_daily
              WHERE cabinet = $1 AND date BETWEEN $2 AND $3 GROUP BY offer_id`, [cabinet, pFrom, pTo]),
      query(`SELECT MIN(date)::text mn, MAX(date)::text mx FROM buyout_daily WHERE cabinet = $1`, [cabinet]),
    ]);
    const di = new Map(dates.map((d, i) => [d, i]));
    res.json({ success: true, data: {
      dates, articles: m.articles,
      rows: cur.filter(r => di.has(r.d)).map(r => [m.art(r.offer_id), di.get(r.d), num(r.ordered), num(r.delivered), num(r.cancelled), num(r.in_progress)]),
      prev: prev.map(r => [m.art(r.offer_id), num(r.o), num(r.d), num(r.c), num(r.p)]), available: range[0] || null, order: ORDER[cabinet] || [],
    } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
module.exports.bucketOf = bucketOf;
