const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const dayjs = require('dayjs');

// GET /api/analytics/ozon?dateFrom=&dateTo=&groupBy=sku|day
router.get('/ozon', async (req, res) => {
  try {
    const { dateFrom, dateTo, groupBy = 'sku' } = req.query;
    const from = dateFrom || dayjs().subtract(30,'day').format('YYYY-MM-DD');
    const to   = dateTo   || dayjs().format('YYYY-MM-DD');

    // ── График по дням ─────────────────────────────────────────────
    if (groupBy === 'day') {
      const rows = await query(`
        SELECT
          d.date::text as date,
          COALESCE(a.hits_view, 0)       as hits_view,
          COALESCE(a.hits_view_pdp, 0)   as hits_view_pdp,
          COALESCE(a.hits_tocart, 0)     as hits_tocart,
          COALESCE(a.revenue, 0)         as revenue,
          COALESCE(o.orders_item, 0)     as orders_item,
          COALESCE(o.delivered_units, 0) as delivered_units,
          COALESCE(o.returns_cnt, 0)     as returns,
          CASE WHEN COALESCE(a.hits_view,0)>0
            THEN ROUND(COALESCE(a.hits_view_pdp,0)::numeric/a.hits_view*100,2)
            ELSE 0 END as ctr_pct,
          CASE WHEN COALESCE(a.hits_view,0)>0
            THEN ROUND(COALESCE(o.orders_item,0)::numeric/a.hits_view*100,2)
            ELSE 0 END as cr_order_pct,
          CASE WHEN COALESCE(o.orders_item,0)>0
            THEN ROUND(COALESCE(o.delivered_units,0)::numeric/o.orders_item*100,1)
            ELSE 0 END as redemption_pct
        FROM (
          SELECT generate_series($1::date, $2::date, '1 day'::interval)::date as date
        ) d
        LEFT JOIN (
          SELECT date,
            SUM(hits_view) as hits_view,
            SUM(hits_view_pdp) as hits_view_pdp,
            SUM(hits_tocart) as hits_tocart,
            SUM(revenue) as revenue
          FROM ozon_analytics
          WHERE date BETWEEN $1 AND $2
          GROUP BY date
        ) a ON a.date = d.date
        LEFT JOIN (
          SELECT date,
            COUNT(*) as orders_item,
            SUM(CASE WHEN status IN ('delivered','awaiting_deliver','arbitration','client_arbitration') THEN 1 ELSE 0 END) as delivered_units,
            SUM(CASE WHEN status LIKE '%return%' THEN 1 ELSE 0 END) as returns_cnt
          FROM ozon_orders
          WHERE date BETWEEN $1 AND $2
            AND status NOT IN ('cancelled','cancelled_from_split_order','not_accepted')
          GROUP BY date
        ) o ON o.date = d.date
        WHERE COALESCE(a.revenue,0) + COALESCE(o.orders_item,0) > 0
        ORDER BY d.date
      `, [from, to]);

      return res.json({ success: true, data: rows });
    }

    // ── Таблица по SKU ──────────────────────────────────────────────
    const rows = await query(`
      SELECT
        COALESCE(a.sku::text, o.sku::text)       as sku,
        COALESCE(a.offer_id, o.offer_id)         as offer_id,
        COALESCE(a.product_name, o.product_name) as product_name,
        COALESCE(a.hits_view, 0)       as hits_view,
        COALESCE(a.hits_view_pdp, 0)   as hits_view_pdp,
        COALESCE(a.hits_tocart, 0)     as hits_tocart,
        COALESCE(o.orders_item, 0)     as orders_item,
        COALESCE(a.revenue, o.revenue, 0)         as revenue,
        COALESCE(a.revenue, o.revenue, 0)         as payout,
        COALESCE(o.delivered_units, 0) as delivered_units,
        COALESCE(a.returns, o.returns_cnt, 0)     as returns,
        COALESCE(a.cancellations, 0)   as cancellations,
        -- Конверсии
        CASE WHEN COALESCE(a.hits_view,0)>0
          THEN ROUND(COALESCE(a.hits_view_pdp,0)::numeric/a.hits_view*100,2) ELSE 0 END as ctr_pct,
        CASE WHEN COALESCE(a.hits_view,0)>0
          THEN ROUND(COALESCE(a.hits_tocart,0)::numeric/a.hits_view*100,2) ELSE 0 END as cr_cart_pct,
        CASE WHEN COALESCE(a.hits_view,0)>0
          THEN ROUND(COALESCE(o.orders_item,0)::numeric/a.hits_view*100,2) ELSE 0 END as cr_order_pct,
        CASE WHEN COALESCE(a.hits_tocart,0)>0
          THEN ROUND(COALESCE(o.orders_item,0)::numeric/a.hits_tocart*100,1) ELSE 0 END as cr_cart_to_order_pct,
        CASE WHEN COALESCE(o.orders_item,0)>0
          THEN ROUND(COALESCE(o.delivered_units,0)::numeric/o.orders_item*100,1) ELSE 0 END as redemption_pct,
        -- Реклама
        COALESCE(ads.spend, 0) as ad_spend,
        CASE WHEN COALESCE(a.revenue, o.revenue, 0)>0
          THEN ROUND(COALESCE(ads.spend,0)/COALESCE(a.revenue,o.revenue)*100,1) ELSE 0 END as drr,
        -- Себестоимость
        COALESCE(pc.cost_price, 0) as cost_price,
        -- Средняя цена
        CASE WHEN COALESCE(o.orders_item,0)>0
          THEN ROUND(COALESCE(a.revenue,o.revenue,0)/o.orders_item,0) ELSE 0 END as avg_price,
        -- Остаток
        (SELECT SUM(fbo_present+fbs_present) FROM ozon_stocks
         WHERE sku=COALESCE(a.sku,o.sku)
         AND snapshot_date=(SELECT MAX(snapshot_date) FROM ozon_stocks)) as stock_qty
      FROM (
        -- Аналитика из Analytics API (показы, воронка, выручка)
        SELECT sku, offer_id, product_name,
          SUM(hits_view) as hits_view, SUM(hits_view_pdp) as hits_view_pdp,
          SUM(hits_tocart) as hits_tocart, SUM(revenue) as revenue,
          SUM(returns) as returns, SUM(cancellations) as cancellations
        FROM ozon_analytics WHERE date BETWEEN $1 AND $2
        GROUP BY sku, offer_id, product_name
      ) a
      FULL OUTER JOIN (
        -- Заказы из Orders API (заказы, доставка, возвраты)
        SELECT sku, offer_id, product_name,
          COUNT(*) as orders_item,
          SUM(price*quantity) as revenue,
          SUM(CASE WHEN status IN ('delivered','awaiting_deliver','arbitration','client_arbitration') THEN 1 ELSE 0 END) as delivered_units,
          SUM(CASE WHEN status LIKE '%return%' THEN 1 ELSE 0 END) as returns_cnt
        FROM ozon_orders
        WHERE date BETWEEN $1 AND $2
          AND status NOT IN ('cancelled','cancelled_from_split_order','not_accepted')
        GROUP BY sku, offer_id, product_name
      ) o ON o.sku = a.sku
      LEFT JOIN (
        SELECT sku, SUM(spend) as spend FROM ozon_ads
        WHERE date BETWEEN $1 AND $2 GROUP BY sku
      ) ads ON ads.sku = COALESCE(a.sku, o.sku)
      LEFT JOIN product_costs pc
        ON pc.platform='ozon' AND pc.article = COALESCE(a.offer_id, o.offer_id)
      ORDER BY COALESCE(a.revenue, o.revenue, 0) DESC
      LIMIT 500
    `, [from, to]);

    // Итоги
    const [totals] = await query(`
      SELECT
        SUM(a.hits_view)     as hits_view,
        SUM(a.hits_view_pdp) as hits_view_pdp,
        SUM(a.hits_tocart)   as hits_tocart,
        SUM(a.revenue)       as revenue,
        COUNT(o.id)          as orders_item,
        SUM(CASE WHEN o.status IN ('delivered','awaiting_deliver','arbitration','client_arbitration') THEN 1 ELSE 0 END) as delivered_units,
        CASE WHEN SUM(a.hits_view)>0
          THEN ROUND(SUM(a.hits_view_pdp)::numeric/SUM(a.hits_view)*100,2) ELSE 0 END as ctr_pct,
        CASE WHEN SUM(a.hits_view)>0
          THEN ROUND(COUNT(o.id)::numeric/SUM(a.hits_view)*100,2) ELSE 0 END as cr_order_pct,
        CASE WHEN COUNT(o.id)>0
          THEN ROUND(SUM(CASE WHEN o.status IN ('delivered','awaiting_deliver','arbitration','client_arbitration') THEN 1 ELSE 0 END)::numeric/COUNT(o.id)*100,1)
          ELSE 0 END as redemption_pct
      FROM ozon_analytics a
      LEFT JOIN ozon_orders o
        ON o.sku = a.sku AND o.date BETWEEN $1 AND $2
          AND o.status NOT IN ('cancelled','cancelled_from_split_order','not_accepted')
      WHERE a.date BETWEEN $1 AND $2
    `, [from, to]);

    res.json({ success: true, data: rows, totals: totals || {} });
  } catch(e) {
    console.error('/analytics/ozon error:', e);
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
        SUM(a.hits_view)     as impressions,
        SUM(a.hits_view_pdp) as card_views,
        SUM(a.hits_tocart)   as cart_adds,
        COUNT(DISTINCT o.id) as orders,
        SUM(CASE WHEN o.status IN ('delivered','awaiting_deliver','arbitration','client_arbitration') THEN 1 ELSE 0 END) as delivered,
        SUM(a.revenue)       as revenue,
        CASE WHEN SUM(a.hits_view)>0
          THEN ROUND(SUM(a.hits_view_pdp)::numeric/SUM(a.hits_view)*100,1) ELSE 0 END as imp_to_card,
        CASE WHEN SUM(a.hits_view_pdp)>0
          THEN ROUND(SUM(a.hits_tocart)::numeric/SUM(a.hits_view_pdp)*100,1) ELSE 0 END as card_to_cart,
        CASE WHEN SUM(a.hits_tocart)>0
          THEN ROUND(COUNT(DISTINCT o.id)::numeric/SUM(a.hits_tocart)*100,1) ELSE 0 END as cart_to_order,
        CASE WHEN COUNT(DISTINCT o.id)>0
          THEN ROUND(SUM(CASE WHEN o.status IN ('delivered','awaiting_deliver','arbitration','client_arbitration') THEN 1 ELSE 0 END)::numeric/COUNT(DISTINCT o.id)*100,1)
          ELSE 0 END as order_to_delivered,
        CASE WHEN SUM(a.hits_view)>0
          THEN ROUND(COUNT(DISTINCT o.id)::numeric/SUM(a.hits_view)*100,2) ELSE 0 END as overall_cr
      FROM ozon_analytics a
      LEFT JOIN ozon_orders o
        ON o.sku = a.sku AND o.date BETWEEN $1 AND $2
          AND o.status NOT IN ('cancelled','cancelled_from_split_order','not_accepted')
      WHERE a.date BETWEEN $1 AND $2
    `, [from, to]);

    res.json({ success: true, data: r || {} });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
