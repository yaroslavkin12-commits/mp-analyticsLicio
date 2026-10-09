const express = require('express');
const router = express.Router();
const dayjs = require('dayjs');
const { query } = require('../db');
const { autoPath, carBrand, ORDER } = require('../lib/categories');

// ─────────────────────────────────────────────────────────────────────────
// «Аналитика продаж» — все артикулы кабинета по дням, с категориями.
// Данные те же, что у вкладки «Реклама» (собираются Google-скриптом в
// таблицу, оттуда в базу): воронка и заказы по товару, остатки, расход на
// рекламу. Отдаём компактно (массивы вместо объектов, только непустые дни),
// а суммирование по категориям, маркам и фильтрам делает страница — так
// любые срезы считаются мгновенно, без новых запросов.
//
// «Себестоимость» — единая себестоимость по нашему артикулу (одна на WB и
// Ozon), таблица product_costs.
// ─────────────────────────────────────────────────────────────────────────

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await query(`CREATE TABLE IF NOT EXISTS product_category_override (
        cabinet VARCHAR(32) NOT NULL, offer_id VARCHAR(128) NOT NULL, path VARCHAR(256) NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (cabinet, offer_id))`);
      await query(`ALTER TABLE product_costs ADD COLUMN IF NOT EXISTS cabinet VARCHAR(32)`);
    })().catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

function period(q) {
  let from, to;
  if (q.dateFrom && q.dateTo) {
    from = dayjs(q.dateFrom).format('YYYY-MM-DD');
    to = dayjs(q.dateTo).format('YYYY-MM-DD');
    if (dayjs(to).isBefore(from)) [from, to] = [to, from];
    if (dayjs(to).diff(from, 'day') > 92) from = dayjs(to).subtract(92, 'day').format('YYYY-MM-DD');
  } else {
    to = dayjs().format('YYYY-MM-DD');
    from = dayjs().subtract(29, 'day').format('YYYY-MM-DD');
  }
  return { from, to };
}

const num = v => Number(v) || 0;
const r2 = v => Math.round(v * 100) / 100;

// Расход на рекламу по артикулу и дню — та же логика, что на вкладке
// «Реклама»: точный расход по товарам (отчёт по кампаниям), «оплата за
// заказ» — по дню заказа, остальное — по привязке кампании к артикулу
// (мультитоварная РК делится поровну). Что не привязалось ни к одному
// артикулу — отдельной суммой «не распределено».
function allocateAds({ from, to, campaigns, campaignSkuRows, offerBySku, adRows, skuStatRows, cpoRows }) {
  const out = new Map(); // offer|date -> {cpc, cpo, clicks, adOrders, adRevenue}
  const unallocated = new Map(); // date -> spend
  const add = (offer, date, k, v) => {
    if (!v) return;
    const key = `${offer}|${date}`;
    const cur = out.get(key) || { cpc: 0, cpo: 0, clicks: 0, adOrders: 0, adRevenue: 0 };
    cur[k] += v;
    out.set(key, cur);
  };
  const lost = (date, v) => { if (v) unallocated.set(date, (unallocated.get(date) || 0) + v); };

  const campById = new Map(campaigns.map(c => [String(c.campaign_id), c]));
  const campOffers = new Map();
  for (const r of campaignSkuRows) {
    const o = offerBySku.get(String(r.sku));
    if (!o) continue;
    const id = String(r.campaign_id);
    if (!campOffers.has(id)) campOffers.set(id, new Set());
    campOffers.get(id).add(o);
  }

  // Точные данные по товарам за (кампания, день).
  const covered = new Set();
  for (const r of skuStatRows) {
    const ck = `${r.campaign_id}|${r.date}`;
    covered.add(ck);
    const o = offerBySku.get(String(r.sku));
    if (!o) { lost(r.date, num(r.expense)); continue; }
    add(o, r.date, 'cpc', num(r.expense));
    add(o, r.date, 'clicks', num(r.clicks));
    add(o, r.date, 'adOrders', num(r.orders));
    add(o, r.date, 'adRevenue', num(r.sales));
  }

  // «Оплата за заказ» — по дню заказа; дни списания, покрытые отчётом.
  let cpoFrom = null, cpoTo = null;
  for (const r of cpoRows) {
    if (!cpoFrom || r.date < cpoFrom) cpoFrom = r.date;
    if (!cpoTo || r.date > cpoTo) cpoTo = r.date;
    const day = r.order_date || r.date;
    if (day < from || day > to) continue;
    const o = offerBySku.get(String(r.promoted_sku || r.sku)) || offerBySku.get(String(r.sku));
    if (!o) { lost(day, num(r.expense)); continue; }
    add(o, day, 'cpo', num(r.expense));
    add(o, day, 'adOrders', num(r.quantity) || 1);
    add(o, day, 'adRevenue', num(r.cost));
  }
  const cpoCovers = d => cpoFrom && d >= cpoFrom && d <= cpoTo;

  for (const r of adRows) {
    const spend = num(r.spend);
    if (!spend && !num(r.clicks)) continue;
    const id = String(r.campaign_id);
    const c = campById.get(id);
    const isCpo = String(c?.payment_type || '').toUpperCase() === 'CPO';
    if (isCpo && cpoCovers(r.date)) continue;
    if (covered.has(`${id}|${r.date}`)) continue;
    const targets = campOffers.has(id) ? [...campOffers.get(id)] : (c?.matched_offer_id ? [c.matched_offer_id] : []);
    if (!targets.length) { lost(r.date, spend); continue; }
    const k = targets.length;
    for (const o of targets) {
      add(o, r.date, isCpo ? 'cpo' : 'cpc', spend / k);
      add(o, r.date, 'clicks', num(r.clicks) / k);
      add(o, r.date, 'adOrders', num(r.orders) / k);
      add(o, r.date, 'adRevenue', num(r.orders_money) / k);
    }
  }
  return { byOfferDate: out, unallocated };
}

// GET /api/sales/data?cabinet=defly&dateFrom=&dateTo=&compare=1
router.get('/data', async (req, res) => {
  try {
    await ensureSchema();
    const cabinet = req.query.cabinet || 'defly';
    const { from, to } = period(req.query);
    const dates = [];
    for (let d = dayjs(from); !d.isAfter(to, 'day'); d = d.add(1, 'day')) dates.push(d.format('YYYY-MM-DD'));
    const compare = req.query.compare === '1';
    const pFrom = dayjs(from).subtract(dates.length, 'day').format('YYYY-MM-DD');
    const pTo = dayjs(from).subtract(1, 'day').format('YYYY-MM-DD');
    const adFrom = compare ? pFrom : from;
    const P = [cabinet];
    const t0 = Date.now();

    const [catalogRows, overrideRows, anRows, stockRows, stockBaseRows, stockNowRows, campaigns, campaignSkuRows, adRows, skuStatRows, cpoRows, prevAnRows] = await Promise.all([
      query(`SELECT offer_id, sku, product_name FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon'`, P),
      query(`SELECT offer_id, path FROM product_category_override WHERE cabinet = $1`, P),
      query(`SELECT date::text AS date, sku, offer_id, hits_view, hits_view_pdp, hits_tocart, orders_item, revenue, position_category
               FROM product_analytics_daily WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3`, [cabinet, from, to]),
      query(`SELECT snapshot_date::text AS date, offer_id, SUM(fbo_present + fbs_present) AS v
               FROM ad_product_stocks WHERE cabinet = $1 AND platform = 'ozon' AND snapshot_date BETWEEN $2 AND $3
              GROUP BY snapshot_date, offer_id`, [cabinet, from, to]),
      // Остаток на начало периода — последний снимок до него.
      query(`SELECT DISTINCT ON (offer_id) offer_id, (fbo_present + fbs_present) AS v
               FROM ad_product_stocks WHERE cabinet = $1 AND platform = 'ozon' AND snapshot_date < $2 AND snapshot_date >= $3
              ORDER BY offer_id, snapshot_date DESC`, [cabinet, from, dayjs(from).subtract(30, 'day').format('YYYY-MM-DD')]),
      query(`SELECT offer_id, SUM(fbo_present + fbs_present) AS v FROM ad_product_stocks
              WHERE cabinet = $1 AND platform = 'ozon'
                AND snapshot_date = (SELECT MAX(snapshot_date) FROM ad_product_stocks WHERE cabinet = $1 AND platform = 'ozon')
              GROUP BY offer_id`, P),
      query(`SELECT campaign_id, matched_offer_id, payment_type FROM ad_campaigns WHERE cabinet = $1 AND platform = 'ozon'`, P),
      query(`SELECT campaign_id, sku FROM ad_campaign_skus WHERE cabinet = $1 AND platform = 'ozon' AND sku != 0`, P).catch(() => []),
      query(`SELECT date::text AS date, campaign_id, spend, clicks, orders, orders_money
               FROM ad_stats_daily WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3`, [cabinet, adFrom, to]),
      query(`SELECT date::text AS date, campaign_id, sku, clicks, orders, sales, expense
               FROM ad_sku_stats_daily WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3`, [cabinet, adFrom, to]).catch(() => []),
      query(`SELECT date::text AS date, order_date::text AS order_date, sku, promoted_sku, quantity, cost, expense
               FROM ad_cpo_orders WHERE cabinet = $1 AND platform = 'ozon'
                AND (date BETWEEN $2 AND $3 OR order_date BETWEEN $2 AND $3)`, [cabinet, adFrom, to]).catch(() => []),
      compare
        ? query(`SELECT sku, offer_id, SUM(hits_view) v, SUM(hits_view_pdp) pv, SUM(hits_tocart) c, SUM(orders_item) o, SUM(revenue) r
                   FROM product_analytics_daily WHERE cabinet = $1 AND platform = 'ozon' AND date BETWEEN $2 AND $3
                  GROUP BY sku, offer_id`, [cabinet, pFrom, pTo])
        : Promise.resolve([]),
    ]);
    const tQ = Date.now();

    const offerBySku = new Map(catalogRows.filter(r => r.sku != null).map(r => [String(r.sku), r.offer_id]));
    const override = new Map(overrideRows.map(r => [r.offer_id, r.path]));

    // Артикулы: весь каталог + то, что встретилось в аналитике/остатках без каталога.
    const articles = [];
    const idx = new Map();
    function art(offerId, name, sku) {
      if (idx.has(offerId)) return idx.get(offerId);
      const i = articles.length;
      const auto = autoPath(cabinet, name, offerId).join(' / ');
      articles.push({ o: offerId, n: name || '', sku: sku != null ? String(sku) : null, cat: override.get(offerId) || auto, auto, manual: override.has(offerId), brand: cabinet === 'defly' ? carBrand(name) : null, st: null });
      idx.set(offerId, i);
      return i;
    }
    for (const r of catalogRows) art(r.offer_id, r.product_name, r.sku);
    const offerOf = r => r.offer_id || offerBySku.get(String(r.sku)) || (r.sku ? `sku:${r.sku}` : null);

    const di = new Map(dates.map((d, i) => [d, i]));
    // Строка дня: [ai, di, views, pdp, cart, orders, revenue, spendCpc, spendCpo, clicks, adOrders, adRevenue, position]
    const rows = new Map();
    const row = (ai, d) => {
      const k = ai * 1000 + d;
      let r = rows.get(k);
      if (!r) { r = [ai, d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, null]; rows.set(k, r); }
      return r;
    };
    for (const r of anRows) {
      const o = offerOf(r); const d = di.get(r.date);
      if (!o || d === undefined) continue;
      // Пустые строки (товар без показов и заказов) не передаём — иначе
      // всплывают сотни архивных SKU, которых уже нет в каталоге.
      if (!num(r.hits_view) && !num(r.hits_view_pdp) && !num(r.hits_tocart) && !num(r.orders_item) && !num(r.revenue)) continue;
      // Товар не из каталога (архивный SKU) — только если по нему были заказы.
      if (!idx.has(o) && !num(r.orders_item) && !num(r.revenue)) continue;
      const x = row(art(o, '', r.sku), d);
      x[2] += num(r.hits_view); x[3] += num(r.hits_view_pdp); x[4] += num(r.hits_tocart);
      x[5] += num(r.orders_item); x[6] += num(r.revenue);
      if (r.position_category != null) x[12] = num(r.position_category);
    }

    const ads = allocateAds({ from: adFrom, to, campaigns, campaignSkuRows, offerBySku, adRows, skuStatRows, cpoRows });
    const prevSpend = new Map(); // offer -> spend за прошлый период
    let unallocatedCur = 0, unallocatedPrev = 0;
    const unallocatedByDate = {};
    for (const [d, v] of ads.unallocated) {
      if (d >= from) { unallocatedCur += v; unallocatedByDate[d] = r2(v); } else unallocatedPrev += v;
    }
    for (const [k, v] of ads.byOfferDate) {
      const [o, d] = [k.slice(0, k.lastIndexOf('|')), k.slice(k.lastIndexOf('|') + 1)];
      if (d < from) {
        const p = prevSpend.get(o) || { s: 0, ao: 0 };
        p.s += v.cpc + v.cpo; p.ao += v.adOrders;
        prevSpend.set(o, p);
        continue;
      }
      const dIdx = di.get(d);
      if (dIdx === undefined) continue;
      const x = row(art(o, '', null), dIdx);
      x[7] += v.cpc; x[8] += v.cpo; x[9] += v.clicks; x[10] += v.adOrders; x[11] += v.adRevenue;
    }
    const outRows = [];
    for (const r of rows.values()) {
      for (const k of [6, 7, 8, 11]) r[k] = r2(r[k]);
      for (const k of [9, 10]) r[k] = Math.round(r[k] * 10) / 10;
      outRows.push(r);
    }

    // Остатки: только дни, когда значение изменилось (страница переносит
    // последнее известное вперёд).
    const stockBy = new Map(); // ai -> Map(date -> v)
    for (const r of stockRows) {
      if (!idx.has(r.offer_id) && !num(r.v)) continue;
      const ai = art(r.offer_id, '', null);
      if (!stockBy.has(ai)) stockBy.set(ai, new Map());
      stockBy.get(ai).set(r.date, num(r.v));
    }
    const base = new Map(stockBaseRows.map(r => [r.offer_id, num(r.v)]));
    const stock = [];
    for (let ai = 0; ai < articles.length; ai++) {
      const m = stockBy.get(ai) || new Map();
      let last = base.has(articles[ai].o) ? base.get(articles[ai].o) : null;
      if (m.has(dates[0])) last = m.get(dates[0]);
      if (last !== null) stock.push([ai, 0, last]);
      for (let i = 1; i < dates.length; i++) {
        if (!m.has(dates[i])) continue;
        const v = m.get(dates[i]);
        if (v !== last) { stock.push([ai, i, v]); last = v; }
      }
    }
    for (const r of stockNowRows) { if (idx.has(r.offer_id) || num(r.v)) articles[art(r.offer_id, '', null)].st = num(r.v); }

    // Прошлый период — итоги по артикулу: [ai, views, pdp, cart, orders, revenue, spend, adOrders]
    let prev = null;
    if (compare) {
      const acc = new Map();
      for (const r of prevAnRows) {
        const o = offerOf(r); if (!o || !idx.has(o)) continue;
        const ai = idx.get(o);
        const p = acc.get(ai) || [ai, 0, 0, 0, 0, 0, 0, 0];
        p[1] += num(r.v); p[2] += num(r.pv); p[3] += num(r.c); p[4] += num(r.o); p[5] += num(r.r);
        acc.set(ai, p);
      }
      for (const [o, v] of prevSpend) {
        if (!idx.has(o)) continue;
        const ai = idx.get(o);
        const p = acc.get(ai) || [ai, 0, 0, 0, 0, 0, 0, 0];
        p[6] += v.s; p[7] += v.ao;
        acc.set(ai, p);
      }
      prev = [...acc.values()].map(p => p.map((v, i) => (i === 5 || i === 6) ? r2(v) : v));
    }

    res.set('Server-Timing', `queries;dur=${tQ - t0}, compute;dur=${Date.now() - tQ}`);
    res.json({
      success: true,
      data: {
        dates, articles, rows: outRows, stock, prev,
        unallocated: { cur: r2(unallocatedCur), prev: r2(unallocatedPrev), byDate: unallocatedByDate },
        order: ORDER[cabinet] || [],
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/sales/category { cabinet, offerIds: [...], path: 'Чехлы / Чехлы на сиденья' | null }
// path = null — вернуть автоматическую категорию.
router.post('/category', async (req, res) => {
  try {
    await ensureSchema();
    const { cabinet, offerIds, path } = req.body || {};
    if (!cabinet || !Array.isArray(offerIds) || !offerIds.length) return res.status(400).json({ success: false, error: 'Нужны cabinet и offerIds' });
    const clean = path ? String(path).split('/').map(s => s.trim()).filter(Boolean).join(' / ').slice(0, 250) : null;
    if (!clean) {
      await query(`DELETE FROM product_category_override WHERE cabinet = $1 AND offer_id = ANY($2::text[])`, [cabinet, offerIds]);
    } else {
      await query(`INSERT INTO product_category_override (cabinet, offer_id, path, updated_at)
                   SELECT $1, x, $3, NOW() FROM unnest($2::text[]) AS x
                   ON CONFLICT (cabinet, offer_id) DO UPDATE SET path = EXCLUDED.path, updated_at = NOW()`, [cabinet, offerIds, clean]);
    }
    res.json({ success: true, path: clean });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Себестоимость ──────────────────────────────────────────────────────
// GET /api/sales/costs?cabinet=defly — все артикулы кабинета с себестоимостью
// и средней ценой продажи за 30 дней (для ориентира).
router.get('/costs', async (req, res) => {
  try {
    await ensureSchema();
    const cabinet = req.query.cabinet || 'defly';
    const since = dayjs().subtract(30, 'day').format('YYYY-MM-DD');
    const [catalogRows, overrideRows, costRows, salesRows] = await Promise.all([
      query(`SELECT offer_id, sku, product_name FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon'`, [cabinet]),
      query(`SELECT offer_id, path FROM product_category_override WHERE cabinet = $1`, [cabinet]),
      query(`SELECT article, platform, product_name, cost_price, updated_at, cabinet FROM product_costs`),
      query(`SELECT offer_id, sku, SUM(orders_item) o, SUM(revenue) r FROM product_analytics_daily
              WHERE cabinet = $1 AND platform = 'ozon' AND date >= $2 GROUP BY offer_id, sku`, [cabinet, since]),
    ]);
    const override = new Map(overrideRows.map(r => [r.offer_id, r.path]));
    // Каталога кабинета в базе ещё нет (Licio: товары пока не собираются
    // через таблицу) — берём старый каталог Ozon и уже введённые артикулы.
    if (!catalogRows.length) {
      const seen = new Set();
      const legacy = await query(`SELECT offer_id, product_name FROM ozon_catalog`).catch(() => []);
      for (const r of legacy) { if (!seen.has(r.offer_id)) { seen.add(r.offer_id); catalogRows.push({ offer_id: r.offer_id, sku: null, product_name: r.product_name }); } }
      for (const r of costRows) { if ((!r.cabinet || r.cabinet === cabinet) && !seen.has(r.article)) { seen.add(r.article); catalogRows.push({ offer_id: r.article, sku: null, product_name: r.product_name || '' }); } }
    }
    // Одна себестоимость на артикул: берём самую свежую из записей WB/Ozon.
    const cost = new Map();
    for (const r of costRows) {
      if (r.cabinet && r.cabinet !== cabinet) continue;
      const cur = cost.get(r.article);
      if (!cur || new Date(r.updated_at) > new Date(cur.updated_at)) cost.set(r.article, r);
    }
    const offerBySku = new Map(catalogRows.filter(r => r.sku != null).map(r => [String(r.sku), r.offer_id]));
    const sales = new Map();
    for (const r of salesRows) {
      const o = r.offer_id || offerBySku.get(String(r.sku));
      if (!o) continue;
      const s = sales.get(o) || { o: 0, r: 0 };
      s.o += num(r.o); s.r += num(r.r);
      sales.set(o, s);
    }
    const items = catalogRows.map(r => {
      const c = cost.get(r.offer_id);
      const s = sales.get(r.offer_id);
      return {
        offerId: r.offer_id, name: r.product_name || '',
        category: override.get(r.offer_id) || autoPath(cabinet, r.product_name, r.offer_id).join(' / '),
        cost: c ? num(c.cost_price) : null, updatedAt: c ? c.updated_at : null,
        orders30: s ? s.o : 0, avgPrice30: s && s.o > 0 ? r2(s.r / s.o) : null,
      };
    });
    res.json({ success: true, data: { items, order: ORDER[cabinet] || [] } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/sales/costs { cabinet, items: [{ offerId, cost, name? }] } — cost пусто/null удаляет.
// Сохраняем одну и ту же себестоимость для WB и Ozon (артикул у нас общий).
router.post('/costs', async (req, res) => {
  try {
    await ensureSchema();
    const { cabinet, items } = req.body || {};
    if (!cabinet || !Array.isArray(items) || !items.length) return res.status(400).json({ success: false, error: 'Нужны cabinet и items' });
    const set = [], del = [];
    for (const it of items) {
      const id = String(it.offerId || '').trim();
      if (!id) continue;
      const v = it.cost === null || it.cost === undefined || String(it.cost).trim() === '' ? null : Number(String(it.cost).replace(/\s/g, '').replace(',', '.'));
      if (v === null) del.push(id);
      else if (Number.isFinite(v) && v >= 0) set.push({ id, v, name: it.name ? String(it.name).slice(0, 500) : null });
    }
    if (del.length) await query(`DELETE FROM product_costs WHERE article = ANY($1::text[]) AND (cabinet = $2 OR cabinet IS NULL)`, [del, cabinet]);
    for (let i = 0; i < set.length; i += 500) {
      const chunk = set.slice(i, i + 500);
      for (const platform of ['ozon', 'wb']) {
        await query(`INSERT INTO product_costs (platform, article, product_name, cost_price, cabinet, updated_at)
                     SELECT $1, a, n, c, $5, NOW() FROM unnest($2::text[], $3::text[], $4::numeric[]) AS t(a, n, c)
                     ON CONFLICT (platform, article) DO UPDATE SET cost_price = EXCLUDED.cost_price, cabinet = EXCLUDED.cabinet,
                       product_name = COALESCE(EXCLUDED.product_name, product_costs.product_name), updated_at = NOW()`,
          [platform, chunk.map(x => x.id), chunk.map(x => x.name), chunk.map(x => x.v), cabinet]);
      }
    }
    res.json({ success: true, saved: set.length, removed: del.length });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
