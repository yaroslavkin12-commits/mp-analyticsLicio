const express = require('express');
const dayjs = require('dayjs');
const { query } = require('../db');
const OF = require('../lib/orderFeed');
const { autoPath, OV_SQL, overrideArgs } = require('../lib/categories');

// «Лента заказов»: отправления Ozon (копятся из вкладки Orders) и отметка самовыкупов.
const router = express.Router();
const num = v => (v === null || v === undefined ? 0 : Number(v) || 0);

// GET /api/orders/feed?cabinet=&dateFrom=&dateTo= — заказы за период (по времени заказа, МСК).
router.get('/feed', async (req, res) => {
  try {
    await OF.ensure();
    const cabinet = req.query.cabinet || 'defly';
    const to = req.query.dateTo || dayjs().add(3, 'hour').format('YYYY-MM-DD');
    const from = req.query.dateFrom || dayjs(to).subtract(6, 'day').format('YYYY-MM-DD');
    const rows = await query(`SELECT f.posting_number, f.sku, f.offer_id, f.name, f.price, f.qty, f.status, f.warehouse, f.created_at, f.scheme,
        (s.posting_number IS NOT NULL) AS self, s.marked_at
      FROM order_feed f LEFT JOIN self_buyouts s ON s.cabinet = f.cabinet AND s.posting_number = f.posting_number AND s.sku = f.sku
      WHERE f.cabinet = $1 AND f.created_at >= ($2::date - INTERVAL '3 hours') AND f.created_at < ($3::date + INTERVAL '21 hours')
      ORDER BY f.created_at DESC LIMIT 5000`, [cabinet, from, to]);
    const first = await query(`SELECT MIN(created_at) mn FROM order_feed WHERE cabinet = $1`, [cabinet]);
    // Категория артикула — как в аналитике (ручная, иначе по названию из каталога).
    const [ov, cat] = await Promise.all([
      query(OV_SQL, overrideArgs(cabinet)).catch(() => []),
      query(`SELECT offer_id, product_name FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon'`, [cabinet]).catch(() => []),
    ]);
    const ovm = new Map(ov.map(r => [r.offer_id, r.path])), nm = new Map(cat.map(r => [r.offer_id, r.product_name]));
    const catOf = new Map();
    const cOf = (o, n) => { if (!o) return 'Без категории'; if (!catOf.has(o)) catOf.set(o, ovm.get(o) || autoPath(cabinet, nm.get(o) || n, o).join(' / ') || 'Без категории'); return catOf.get(o); };
    // Цены в отправлении нет (новые методы Ozon отдавали её в другом виде, пока скрипт
    // этого не учитывал) — подставляем цену продавца на день заказа из истории цен, помечая «≈».
    const noPrice = [...new Set(rows.filter(r => !(Number(r.price) > 0) && r.offer_id).map(r => r.offer_id))];
    const est = new Map(), estCur = new Map();
    if (noPrice.length) {
      const [pd, pp] = await Promise.all([
        query(`SELECT offer_id, date::text d, COALESCE(seller, card) v FROM price_daily
          WHERE cabinet = $1 AND offer_id = ANY($2) AND date BETWEEN ($3::date - 30) AND $4::date AND COALESCE(seller, card) > 0 ORDER BY date`, [cabinet, noPrice, from, to]).catch(() => []),
        query(`SELECT offer_id, COALESCE(seller_price, price) v FROM product_prices WHERE cabinet = $1 AND offer_id = ANY($2)`, [cabinet, noPrice]).catch(() => []),
      ]);
      for (const r of pd) { if (!est.has(r.offer_id)) est.set(r.offer_id, []); est.get(r.offer_id).push([r.d, Number(r.v)]); }
      for (const r of pp) if (Number(r.v) > 0) estCur.set(r.offer_id, Number(r.v));
    }
    const mskDay = at => new Date(new Date(at).getTime() + 3 * 3600e3).toISOString().slice(0, 10);
    const priceOf = r => {
      if (Number(r.price) > 0) return [num(r.price), false];
      const list = est.get(r.offer_id);
      if (list && r.created_at) { const d = mskDay(r.created_at); let v = null; for (const [dd, pv] of list) { if (dd <= d) v = pv; else break; } if (v === null) v = list[0][1]; return [v, true]; }
      if (estCur.has(r.offer_id)) return [estCur.get(r.offer_id), true];
      return [0, false];
    };
    res.json({ success: true, data: {
      from, to, since: first[0]?.mn || null,
      rows: rows.map(r => { const [pr, pe] = priceOf(r); return { p: r.posting_number, sku: String(r.sku), o: r.offer_id, n: r.name, cat: cOf(r.offer_id, r.name), price: pr, est: pe || undefined, qty: num(r.qty) || 1, st: r.status, wh: r.warehouse, at: r.created_at, sch: r.scheme, self: !!r.self }; }),
    } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/orders/self { cabinet, items: [{ p, sku }], on } — отметить / снять самовыкуп.
router.post('/self', async (req, res) => {
  try {
    await OF.ensure();
    const { cabinet, items, on } = req.body || {};
    if (!cabinet || !Array.isArray(items) || !items.length) return res.status(400).json({ success: false, error: 'Нужны cabinet и items' });
    let n = 0;
    for (const it of items.slice(0, 2000)) {
      const p = String(it.p || '').slice(0, 64), sku = Math.round(Number(it.sku)) || 0;
      if (!p) continue;
      if (on) {
        const r = await query(`INSERT INTO self_buyouts (cabinet, posting_number, sku, offer_id, qty, price, order_date)
          SELECT cabinet, posting_number, sku, offer_id, qty, price, (created_at + INTERVAL '3 hours')::date FROM order_feed
           WHERE cabinet = $1 AND posting_number = $2 AND sku = $3
          ON CONFLICT (cabinet, posting_number, sku) DO NOTHING RETURNING sku`, [cabinet, p, sku]);
        n += r.length;
      } else {
        const r = await query(`DELETE FROM self_buyouts WHERE cabinet = $1 AND posting_number = $2 AND sku = $3 RETURNING sku`, [cabinet, p, sku]);
        n += r.length;
      }
    }
    require('../lib/dataVersion').bump();
    res.json({ success: true, data: { changed: n } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
