const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const dayjs = require('dayjs');

// Извлекаем категорию из названия товара
function extractCategory(productName) {
  if (!productName) return 'Прочее';
  const n = productName.toLowerCase();
  if (n.includes('детск') || n.includes('ребён') || n.includes('child'))
    return n.includes('футболк') ? 'Футболка детская' : 'Детское';
  if (n.includes('худи'))
    return n.includes('женск') || n.includes('w') ? 'Худи женское' : 'Худи мужское';
  if (n.includes('свитшот') || n.includes('свитер'))
    return n.includes('женск') || n.includes('w') ? 'Свитшот женский' : 'Свитшот мужской';
  if (n.includes('лонгслив') || n.includes('long'))
    return n.includes('женск') || n.includes('w') ? 'Лонгслив женский' : 'Лонгслив мужской';
  if (n.includes('футболк'))
    return n.includes('женск') || n.includes('w') ? 'Футболка женская' : 'Футболка мужская';
  if (n.includes('брюк') || n.includes('штан'))
    return n.includes('женск') || n.includes('w') ? 'Брюки женские' : 'Брюки мужские';
  if (n.includes('шорт'))
    return n.includes('женск') || n.includes('w') ? 'Шорты женские' : 'Шорты мужские';
  if (n.includes('платье')) return 'Платья';
  return 'Прочее';
}

// GET /api/analytics/ozon/categories
router.get('/ozon/categories', async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const from = dateFrom || dayjs().subtract(30,'day').format('YYYY-MM-DD');
    const to   = dateTo   || dayjs().format('YYYY-MM-DD');

    const products = await query(`
      SELECT DISTINCT
        COALESCE(a.offer_id, o.offer_id) as offer_id,
        COALESCE(a.product_name, o.product_name) as product_name,
        COALESCE(a.sku::text, o.sku::text) as sku
      FROM ozon_analytics a
      FULL OUTER JOIN ozon_orders o ON o.sku = a.sku
        AND o.date BETWEEN $1 AND $2
      WHERE a.date BETWEEN $1 AND $2 OR o.date BETWEEN $1 AND $2
      ORDER BY offer_id
    `, [from, to]);

    // Строим иерархию: категория -> цвет -> артикулы
    const tree = {};
    for (const p of products) {
      if (!p.offer_id) continue;
      const cat = extractCategory(p.product_name);
      if (!tree[cat]) tree[cat] = {};

      // Цвет — берём из имени товара (ищем цвет после запятой)
      const parts  = (p.product_name || '').split(',');
      const color  = parts.length >= 3 ? parts[2].trim() : 'Без цвета';
      const cKey   = color.split(' ').slice(0,3).join(' '); // берём первые 3 слова

      if (!tree[cat][cKey]) tree[cat][cKey] = [];
      tree[cat][cKey].push({ offer_id: p.offer_id, product_name: p.product_name, sku: p.sku });
    }

    // Преобразуем в массив для фронта
    const categories = Object.entries(tree).map(([cat, colors]) => ({
      name: cat,
      colors: Object.entries(colors).map(([color, items]) => ({ name: color, items })),
    })).sort((a,b) => a.name.localeCompare(b.name, 'ru'));

    res.json({ success: true, data: categories });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/analytics/ozon?dateFrom=&dateTo=&groupBy=sku|day&offerIds=x,y
router.get('/ozon', async (req, res) => {
  try {
    const { dateFrom, dateTo, groupBy = 'sku', offerIds } = req.query;
    const from = dateFrom || dayjs().subtract(30,'day').format('YYYY-MM-DD');
    const to   = dateTo   || dayjs().format('YYYY-MM-DD');

    // Фильтр по артикулам
    let offerFilter = '';
    let extraParams = [];
    if (offerIds) {
      const ids = offerIds.split(',').map(s => s.trim()).filter(Boolean);
      if (ids.length) {
        const placeholders = ids.map((_,i) => `$${i+3}`).join(',');
        offerFilter = `AND COALESCE(a.offer_id, o.offer_id) IN (${placeholders})`;
        extraParams = ids;
      }
    }

    // ── График по дням ─────────────────────────────────────────────
    if (groupBy === 'day') {
      const rows = await query(`
        SELECT
          d.date::text as date,
          COALESCE(a.hits_view, 0)        as hits_view,
          COALESCE(a.hits_view_pdp, 0)    as hits_view_pdp,
          COALESCE(a.hits_tocart, 0)      as hits_tocart,
          COALESCE(a.revenue, 0)          as analytics_revenue,
          COALESCE(o.orders_sum, 0)       as orders_sum,
          COALESCE(o.orders_qty, 0)       as orders_qty,
          COALESCE(o.delivered_qty, 0)    as delivered_qty,
          COALESCE(o.revenue, 0)          as revenue,
          CASE WHEN COALESCE(a.hits_view,0)>0
            THEN ROUND(COALESCE(a.hits_view_pdp,0)::numeric/a.hits_view*100,2) ELSE 0 END as ctr_pct,
          CASE WHEN COALESCE(a.hits_view,0)>0
            THEN ROUND(COALESCE(a.hits_tocart,0)::numeric/a.hits_view*100,2) ELSE 0 END as cr_cart_pct,
          CASE WHEN COALESCE(a.hits_view,0)>0
            THEN ROUND(COALESCE(o.orders_qty,0)::numeric/a.hits_view*100,2) ELSE 0 END as cr_order_pct,
          CASE WHEN COALESCE(o.orders_qty,0)>0
            THEN ROUND(COALESCE(o.delivered_qty,0)::numeric/o.orders_qty*100,1) ELSE 0 END as redemption_pct
        FROM (SELECT generate_series($1::date,$2::date,'1 day'::interval)::date as date) d
        LEFT JOIN (
          SELECT date, SUM(hits_view) as hits_view, SUM(hits_view_pdp) as hits_view_pdp,
            SUM(hits_tocart) as hits_tocart, SUM(revenue) as revenue
          FROM ozon_analytics WHERE date BETWEEN $1 AND $2
          GROUP BY date
        ) a ON a.date = d.date
        LEFT JOIN (
          SELECT date,
            SUM(price*quantity)  as orders_sum,
            SUM(quantity)        as orders_qty,
            SUM(CASE WHEN status IN ('delivered','awaiting_deliver','arbitration','client_arbitration') THEN quantity ELSE 0 END) as delivered_qty,
            SUM(CASE WHEN status IN ('delivered','awaiting_deliver','arbitration','client_arbitration') THEN payout ELSE 0 END) as revenue
          FROM ozon_orders
          WHERE date BETWEEN $1 AND $2
            AND status NOT IN ('cancelled','cancelled_from_split_order','not_accepted')
          GROUP BY date
        ) o ON o.date = d.date
        WHERE COALESCE(a.hits_view,0)+COALESCE(o.orders_qty,0) > 0
        ORDER BY d.date
      `, [from, to]);
      return res.json({ success: true, data: rows });
    }

    // ── Таблица по SKU ──────────────────────────────────────────────
    const rows = await query(`
      SELECT
        COALESCE(a.sku::text, o.sku::text)         as sku,
        COALESCE(a.offer_id, o.offer_id)           as offer_id,
        COALESCE(a.product_name, o.product_name)   as product_name,
        COALESCE(a.hits_view, 0)                   as hits_view,
        COALESCE(a.hits_view_pdp, 0)               as hits_view_pdp,
        COALESCE(a.hits_tocart, 0)                 as hits_tocart,
        COALESCE(o.orders_qty, 0)                  as orders_item,
        COALESCE(o.orders_sum, 0)                  as orders_sum,
        COALESCE(o.delivered_qty, 0)               as delivered_units,
        COALESCE(o.revenue, 0)                     as revenue,
        COALESCE(o.returns_qty, 0)                 as returns,
        COALESCE(a.cancellations, 0)               as cancellations,
        CASE WHEN COALESCE(a.hits_view,0)>0
          THEN ROUND(COALESCE(a.hits_view_pdp,0)::numeric/a.hits_view*100,2) ELSE 0 END as ctr_pct,
        CASE WHEN COALESCE(a.hits_view,0)>0
          THEN ROUND(COALESCE(a.hits_tocart,0)::numeric/a.hits_view*100,2) ELSE 0 END as cr_cart_pct,
        CASE WHEN COALESCE(a.hits_view,0)>0
          THEN ROUND(COALESCE(o.orders_qty,0)::numeric/a.hits_view*100,2) ELSE 0 END as cr_order_pct,
        CASE WHEN COALESCE(a.hits_tocart,0)>0
          THEN ROUND(COALESCE(o.orders_qty,0)::numeric/a.hits_tocart*100,1) ELSE 0 END as cr_cart_to_order_pct,
        CASE WHEN COALESCE(o.orders_qty,0)>0
          THEN ROUND(COALESCE(o.delivered_qty,0)::numeric/o.orders_qty*100,1) ELSE 0 END as redemption_pct,
        COALESCE(ads.spend, 0) as ad_spend,
        CASE WHEN COALESCE(o.orders_sum,0)>0
          THEN ROUND(COALESCE(ads.spend,0)/o.orders_sum*100,1) ELSE 0 END as drr,
        COALESCE(pc.cost_price, 0) as cost_price,
        CASE WHEN COALESCE(o.orders_qty,0)>0
          THEN ROUND(COALESCE(o.orders_sum,0)/o.orders_qty,0) ELSE 0 END as avg_price,
        (SELECT SUM(fbo_present+fbs_present) FROM ozon_stocks
         WHERE sku=COALESCE(a.sku,o.sku)
         AND snapshot_date=(SELECT MAX(snapshot_date) FROM ozon_stocks)) as stock_qty
      FROM (
        SELECT sku, offer_id, product_name,
          SUM(hits_view) as hits_view, SUM(hits_view_pdp) as hits_view_pdp,
          SUM(hits_tocart) as hits_tocart, SUM(revenue) as revenue,
          SUM(cancellations) as cancellations
        FROM ozon_analytics WHERE date BETWEEN $1 AND $2
        GROUP BY sku, offer_id, product_name
      ) a
      FULL OUTER JOIN (
        SELECT sku, offer_id, product_name,
          SUM(quantity)        as orders_qty,
          SUM(price*quantity)  as orders_sum,
          SUM(CASE WHEN status IN ('delivered','awaiting_deliver','arbitration','client_arbitration') THEN quantity ELSE 0 END) as delivered_qty,
          SUM(CASE WHEN status IN ('delivered','awaiting_deliver','arbitration','client_arbitration') THEN payout ELSE 0 END) as revenue,
          SUM(CASE WHEN status LIKE '%return%' THEN 1 ELSE 0 END) as returns_qty
        FROM ozon_orders
        WHERE date BETWEEN $1 AND $2
          AND status NOT IN ('cancelled','cancelled_from_split_order','not_accepted')
        GROUP BY sku, offer_id, product_name
      ) o ON o.sku = a.sku
      LEFT JOIN (
        SELECT sku, SUM(spend) as spend FROM ozon_ads WHERE date BETWEEN $1 AND $2 GROUP BY sku
      ) ads ON ads.sku = COALESCE(a.sku,o.sku)
      LEFT JOIN product_costs pc ON pc.platform='ozon' AND pc.article=COALESCE(a.offer_id,o.offer_id)
      ORDER BY COALESCE(o.orders_sum,0) DESC LIMIT 500
    `, [from, to, ...extraParams]);

    const [totals] = await query(`
      SELECT
        SUM(a.hits_view)       as hits_view,
        SUM(a.hits_view_pdp)   as hits_view_pdp,
        SUM(a.hits_tocart)     as hits_tocart,
        SUM(o.orders_qty)      as orders_qty,
        SUM(o.orders_sum)      as orders_sum,
        SUM(o.delivered_qty)   as delivered_qty,
        SUM(o.revenue)         as revenue,
        CASE WHEN SUM(a.hits_view)>0
          THEN ROUND(SUM(a.hits_view_pdp)::numeric/SUM(a.hits_view)*100,2) ELSE 0 END as ctr_pct,
        CASE WHEN SUM(a.hits_view)>0
          THEN ROUND(SUM(o.orders_qty)::numeric/SUM(a.hits_view)*100,2) ELSE 0 END as cr_order_pct,
        CASE WHEN SUM(o.orders_qty)>0
          THEN ROUND(SUM(o.delivered_qty)::numeric/SUM(o.orders_qty)*100,1) ELSE 0 END as redemption_pct
      FROM (
        SELECT sku, SUM(hits_view) as hits_view, SUM(hits_view_pdp) as hits_view_pdp, SUM(hits_tocart) as hits_tocart
        FROM ozon_analytics WHERE date BETWEEN $1 AND $2 GROUP BY sku
      ) a
      FULL OUTER JOIN (
        SELECT sku, SUM(quantity) as orders_qty, SUM(price*quantity) as orders_sum,
          SUM(CASE WHEN status IN ('delivered','awaiting_deliver','arbitration','client_arbitration') THEN quantity ELSE 0 END) as delivered_qty,
          SUM(CASE WHEN status IN ('delivered','awaiting_deliver','arbitration','client_arbitration') THEN payout ELSE 0 END) as revenue
        FROM ozon_orders WHERE date BETWEEN $1 AND $2
          AND status NOT IN ('cancelled','cancelled_from_split_order','not_accepted')
        GROUP BY sku
      ) o ON o.sku = a.sku
    `, [from, to]);

    res.json({ success: true, data: rows, totals: totals || {} });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/analytics/ozon/funnel
router.get('/ozon/funnel', async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const from = dateFrom || dayjs().subtract(30,'day').format('YYYY-MM-DD');
    const to   = dateTo   || dayjs().format('YYYY-MM-DD');

    const [r] = await query(`
      SELECT
        SUM(a.hits_view)        as impressions,
        SUM(a.hits_view_pdp)    as card_views,
        SUM(a.hits_tocart)      as cart_adds,
        SUM(o.orders_qty)       as orders,
        SUM(o.delivered_qty)    as delivered,
        SUM(o.orders_sum)       as orders_sum,
        SUM(o.revenue)          as revenue,
        CASE WHEN SUM(a.hits_view)>0
          THEN ROUND(SUM(a.hits_view_pdp)::numeric/SUM(a.hits_view)*100,1) ELSE 0 END as imp_to_card,
        CASE WHEN SUM(a.hits_view_pdp)>0
          THEN ROUND(SUM(a.hits_tocart)::numeric/SUM(a.hits_view_pdp)*100,1) ELSE 0 END as card_to_cart,
        CASE WHEN SUM(a.hits_tocart)>0
          THEN ROUND(SUM(o.orders_qty)::numeric/SUM(a.hits_tocart)*100,1) ELSE 0 END as cart_to_order,
        CASE WHEN SUM(o.orders_qty)>0
          THEN ROUND(SUM(o.delivered_qty)::numeric/SUM(o.orders_qty)*100,1) ELSE 0 END as order_to_delivered,
        CASE WHEN SUM(a.hits_view)>0
          THEN ROUND(SUM(o.orders_qty)::numeric/SUM(a.hits_view)*100,2) ELSE 0 END as overall_cr
      FROM (
        SELECT sku, SUM(hits_view) as hits_view, SUM(hits_view_pdp) as hits_view_pdp, SUM(hits_tocart) as hits_tocart
        FROM ozon_analytics WHERE date BETWEEN $1 AND $2 GROUP BY sku
      ) a
      FULL OUTER JOIN (
        SELECT sku,
          SUM(quantity) as orders_qty,
          SUM(price*quantity) as orders_sum,
          SUM(CASE WHEN status IN ('delivered','awaiting_deliver','arbitration','client_arbitration') THEN quantity ELSE 0 END) as delivered_qty,
          SUM(CASE WHEN status IN ('delivered','awaiting_deliver','arbitration','client_arbitration') THEN payout ELSE 0 END) as revenue
        FROM ozon_orders WHERE date BETWEEN $1 AND $2
          AND status NOT IN ('cancelled','cancelled_from_split_order','not_accepted')
        GROUP BY sku
      ) o ON o.sku = a.sku
    `, [from, to]);

    res.json({ success: true, data: r || {} });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
