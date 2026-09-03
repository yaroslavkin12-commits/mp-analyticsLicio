const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const dayjs = require('dayjs');

// GET /api/dashboard/overview?platform=all&dateFrom=&dateTo=
router.get('/overview', async (req, res) => {
  try {
    const { platform = 'all', dateFrom, dateTo } = req.query;
    const from = dateFrom || dayjs().subtract(30,'day').format('YYYY-MM-DD');
    const to   = dateTo   || dayjs().format('YYYY-MM-DD');
    const result = {};

    if (platform === 'all' || platform === 'wb') {
      // Сумма заказов = ВСЕ заказы (total_price до скидки продавца — как в WB аналитике)
      const [wbO] = await query(`
        SELECT
          COUNT(*) FILTER (WHERE is_cancel = false)              as orders_qty,
          SUM(total_price) FILTER (WHERE is_cancel = false)      as orders_sum
        FROM wb_orders WHERE date BETWEEN $1 AND $2
      `, [from, to]);

      // Выручка = фактические продажи (for_pay) из wb_sales (что выкупили и оплатили)
      const [wbS] = await query(`
        SELECT
          COUNT(*)     as sales_qty,
          SUM(for_pay) as revenue
        FROM wb_sales WHERE date BETWEEN $1 AND $2
      `, [from, to]);

      const [wbA] = await query(`
        SELECT SUM(spend) as spend FROM wb_ads WHERE date BETWEEN $1 AND $2
      `, [from, to]);

      const ordersQty = Number(wbO?.orders_qty || 0);
      const ordersSum = Number(wbO?.orders_sum || 0);
      const salesQty  = Number(wbS?.sales_qty  || 0);
      const revenue   = Number(wbS?.revenue    || 0);
      const adSpend   = Number(wbA?.spend      || 0);

      result.wb = {
        orders_sum:      ordersSum,
        orders_qty:      ordersQty,
        revenue:         revenue,
        sales_qty:       salesQty,
        redemption_rate: ordersQty > 0 ? (salesQty / ordersQty * 100).toFixed(1) : 0,
        ad_spend:        adSpend,
        drr:             ordersSum > 0 ? (adSpend / ordersSum * 100).toFixed(1) : 0,
      };
    }

    if (platform === 'all' || platform === 'ozon') {
      // Сумма заказов = ВСЕ заказы включая отменённые (как в Ozon аналитике "Заказано на сумму")
      const [ozAll] = await query(`
        SELECT
          SUM(quantity)         as orders_qty,
          SUM(price * quantity) as orders_sum
        FROM ozon_orders
        WHERE date BETWEEN $1 AND $2
      `, [from, to]);

      // Выручка / Продажи = фактическая продажа — статус "delivered" (= "Доставлено" в кабинете Ozon,
      // товар получен и оплачен покупателем). "Выкуплено" в отчётах Ozon — это НЕ то же самое: туда
      // попадают заказы ещё в пути / ожидающие клиента в ПВЗ, которые ещё не факт продажи.
      // Выручку считаем по price*quantity (сумма, которую заплатил покупатель), а не по payout —
      // payout (нетто-выплата после комиссии) заполняется Ozon с задержкой и первое время после
      // доставки часто равен 0, из-за чего "Выручка" на дашборде обнулялась.
      const [ozDel] = await query(`
        SELECT
          SUM(quantity)         as sales_qty,
          SUM(price * quantity) as revenue
        FROM ozon_orders
        WHERE date BETWEEN $1 AND $2
          AND status = 'delivered'
      `, [from, to]);

      const [ozA] = await query(`
        SELECT SUM(spend) as spend FROM ozon_ads WHERE date BETWEEN $1 AND $2
      `, [from, to]);

      const ordersQty = Number(ozAll?.orders_qty || 0);
      const ordersSum = Number(ozAll?.orders_sum || 0);
      const salesQty  = Number(ozDel?.sales_qty  || 0);
      const revenue   = Number(ozDel?.revenue    || 0);
      const adSpend   = Number(ozA?.spend        || 0);

      result.ozon = {
        orders_sum:      ordersSum,
        orders_qty:      ordersQty,
        revenue:         revenue,
        sales_qty:       salesQty,
        redemption_rate: ordersQty > 0 ? (salesQty / ordersQty * 100).toFixed(1) : 0,
        ad_spend:        adSpend,
        drr:             ordersSum > 0 ? (adSpend / ordersSum * 100).toFixed(1) : 0,
      };
    }

    res.json({ success: true, data: result, period: { from, to } });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/dashboard/chart
router.get('/chart', async (req, res) => {
  try {
    const { platform = 'all', dateFrom, dateTo } = req.query;
    const from = dateFrom || dayjs().subtract(30,'day').format('YYYY-MM-DD');
    const to   = dateTo   || dayjs().format('YYYY-MM-DD');
    const result = {};

    if (platform === 'all' || platform === 'wb') {
      // WB: total_price (как в WB аналитике "Заказали на сумму")
      result.wb = await query(`
        SELECT
          date::text as date,
          SUM(total_price) FILTER (WHERE is_cancel=false) as orders_sum,
          COUNT(*) FILTER (WHERE is_cancel=false) as orders_qty
        FROM wb_orders WHERE date BETWEEN $1 AND $2
        GROUP BY date ORDER BY date
      `, [from, to]);
    }

    if (platform === 'all' || platform === 'ozon') {
      // Ozon: ВСЕ заказы (как в Ozon аналитике)
      result.ozon = await query(`
        SELECT
          date::text as date,
          SUM(price*quantity) as orders_sum,
          SUM(quantity) as orders_qty
        FROM ozon_orders
        WHERE date BETWEEN $1 AND $2
        GROUP BY date ORDER BY date
      `, [from, to]);
    }

    res.json({ success: true, data: result });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/dashboard/stocks
router.get('/stocks', async (req, res) => {
  try {
    const { platform = 'all' } = req.query;
    const result = {};
    if (platform === 'all' || platform === 'wb') {
      result.wb = await query(`
        SELECT nm_id, supplier_article as article, subject, category,
          SUM(quantity) as total_quantity, MAX(snapshot_date)::text as last_update
        FROM wb_stocks
        WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM wb_stocks)
        GROUP BY nm_id, supplier_article, subject, category
        ORDER BY total_quantity ASC LIMIT 200
      `);
    }
    if (platform === 'all' || platform === 'ozon') {
      result.ozon = await query(`
        SELECT sku, offer_id, product_name,
          SUM(fbo_present) as fbo_qty, SUM(fbs_present) as fbs_qty,
          SUM(fbo_present+fbs_present) as total_qty,
          MAX(snapshot_date)::text as last_update
        FROM ozon_stocks
        WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM ozon_stocks)
        GROUP BY sku, offer_id, product_name
        ORDER BY total_qty ASC LIMIT 200
      `);
    }
    res.json({ success: true, data: result });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/dashboard/stocks-v2
// Остатки, сгруппированные по базовому артикулу (модель+цвет), с разбивкой по
// размеру, площадке (WB/Ozon) и типу фулфилмента (FBO/FBS). Фото и категория
// подтягиваются откуда есть: фото WB — вычисляется по nmId (без похода в API),
// фото Ozon — из справочника ozon_catalog (см. collectors/ozon/catalog.js).
// Категория и пол определяются по префиксу/токенам базового артикула
// (lib/productTaxonomy.js), а не по «сырым» категориям WB/Ozon — те слишком
// разнородны между площадками для нормального фильтра.
router.get('/stocks-v2', async (req, res) => {
  try {
    const { parseArticle } = require('../lib/articleGrouping');
    const { wbPhotoUrl } = require('../lib/wbPhoto');
    const { detectCategory, detectGender, ALL_CATEGORY_LABELS } = require('../lib/productTaxonomy');

    const [wbRows, ozonRows, ozonCatalog] = await Promise.all([
      query(`
        SELECT nm_id, supplier_article, subject, category, tech_size, warehouse_name, stock_type, quantity
        FROM wb_stocks w
        WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM wb_stocks w2 WHERE w2.stock_type = w.stock_type)
          AND supplier_article IS NOT NULL
      `),
      query(`
        SELECT offer_id, sku, fbo_present, fbs_present
        FROM ozon_stocks
        WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM ozon_stocks)
          AND offer_id IS NOT NULL
      `),
      query(`SELECT offer_id, product_name, photo_url FROM ozon_catalog`),
    ]);

    const catalogByOffer = new Map(ozonCatalog.map(c => [c.offer_id, c]));
    const products = new Map(); // baseArticle -> product

    function getProduct(baseArticle) {
      if (!products.has(baseArticle)) {
        products.set(baseArticle, {
          baseArticle,
          category: detectCategory(baseArticle),
          gender: detectGender(baseArticle),
          subject: null, photoUrl: null,
          sizes: new Map(), // size -> {wb_fbo, wb_fbs, ozon_fbo, ozon_fbs}
          wbFbsWarehouses: new Map(), // склад FBS (WB) -> кол-во, для разбивки по складам
        });
      }
      return products.get(baseArticle);
    }
    function getSize(product, size) {
      const key = size || '—';
      if (!product.sizes.has(key)) {
        product.sizes.set(key, { wb_fbo: 0, wb_fbs: 0, ozon_fbo: 0, ozon_fbs: 0 });
      }
      return product.sizes.get(key);
    }

    for (const r of wbRows) {
      const p = getProduct(r.supplier_article);
      if (!p.photoUrl && r.nm_id) p.photoUrl = wbPhotoUrl(r.nm_id);
      if (!p.subject && r.subject) p.subject = r.subject;
      const s = getSize(p, r.tech_size);
      const field = r.stock_type === 'fbs' ? 'wb_fbs' : 'wb_fbo';
      const qty = Number(r.quantity) || 0;
      s[field] += qty;
      if (r.stock_type === 'fbs') {
        const wh = r.warehouse_name || 'Без названия';
        p.wbFbsWarehouses.set(wh, (p.wbFbsWarehouses.get(wh) || 0) + qty);
      }
    }

    for (const r of ozonRows) {
      const { baseArticle, size } = parseArticle(r.offer_id);
      const p = getProduct(baseArticle);
      const cat = catalogByOffer.get(r.offer_id);
      if (!p.photoUrl && cat?.photo_url) p.photoUrl = cat.photo_url;
      if (!p.subject && cat?.product_name) p.subject = cat.product_name;
      const s = getSize(p, size);
      s.ozon_fbo += Number(r.fbo_present) || 0;
      s.ozon_fbs += Number(r.fbs_present) || 0;
    }

    // FBS — это один и тот же физический остаток, который просто выгружается
    // сразу на обе площадки, а не два независимых остатка. Поэтому при
    // подсчёте «итого по обеим площадкам» его нельзя складывать (wb_fbs +
    // ozon_fbs) — берём максимум из двух значений как наиболее свежую оценку
    // (площадки синкают выгрузку с небольшой задержкой относительно друг
    // друга), и отмечаем факт расхождения, если оно есть.
    const result = [...products.values()].map(p => {
      const sizes = [...p.sizes.entries()].map(([size, q]) => {
        const fbsShared = Math.max(q.wb_fbs, q.ozon_fbs);
        return {
          size,
          wb_fbo: q.wb_fbo, wb_fbs: q.wb_fbs, ozon_fbo: q.ozon_fbo, ozon_fbs: q.ozon_fbs,
          fbs_shared: fbsShared,
          fbs_mismatch: q.wb_fbs !== q.ozon_fbs,
          wb_total: q.wb_fbo + q.wb_fbs,
          ozon_total: q.ozon_fbo + q.ozon_fbs,
          total: q.wb_fbo + q.ozon_fbo + fbsShared,
        };
      });
      const totals = sizes.reduce((a, s) => ({
        wb_fbo: a.wb_fbo + s.wb_fbo, wb_fbs: a.wb_fbs + s.wb_fbs,
        ozon_fbo: a.ozon_fbo + s.ozon_fbo, ozon_fbs: a.ozon_fbs + s.ozon_fbs,
        fbs_shared: a.fbs_shared + s.fbs_shared,
        total: a.total + s.total,
      }), { wb_fbo: 0, wb_fbs: 0, ozon_fbo: 0, ozon_fbs: 0, fbs_shared: 0, total: 0 });
      const wbFbsWarehouses = [...p.wbFbsWarehouses.entries()]
        .map(([warehouse, qty]) => ({ warehouse, qty }))
        .sort((a, b) => b.qty - a.qty);
      const { wbFbsWarehouses: _drop, ...rest } = p;
      return { ...rest, sizes, totals, wbFbsWarehouses };
    }).sort((a, b) => a.baseArticle.localeCompare(b.baseArticle));

    const categories = [...ALL_CATEGORY_LABELS];
    if (result.some(p => p.category === 'Другое')) categories.push('Другое');

    res.json({ success: true, data: { products: result, categories } });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/dashboard/collection-log
router.get('/collection-log', async (req, res) => {
  try {
    const logs = await query(`SELECT * FROM collection_log ORDER BY started_at DESC LIMIT 50`);
    res.json({ success: true, data: logs });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
