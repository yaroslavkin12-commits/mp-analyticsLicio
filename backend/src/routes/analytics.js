const express = require('express');
const router = express.Router();
const { query } = require('../db');
const dayjs = require('dayjs');

router.get('/ozon', async (req, res) => {
  try {
    const { dateFrom, dateTo, groupBy='sku' } = req.query;
    const from = dateFrom || dayjs().subtract(30,'day').format('YYYY-MM-DD');
    const to   = dateTo   || dayjs().format('YYYY-MM-DD');

    if (groupBy === 'day') {
      const rows = await query(
        `SELECT date::text as date,
           SUM(hits_view) as hits_view, SUM(hits_view_pdp) as hits_view_pdp,
           SUM(hits_tocart) as hits_tocart, SUM(orders_item) as orders_item,
           SUM(revenue) as revenue, SUM(delivered_units) as delivered_units,
           SUM(returns) as returns, SUM(cancellations) as cancellations,
           CASE WHEN SUM(hits_view)>0 THEN ROUND(SUM(hits_view_pdp)::numeric/SUM(hits_view)*100,2) ELSE 0 END as ctr_pct,
           CASE WHEN SUM(hits_view)>0 THEN ROUND(SUM(hits_tocart)::numeric/SUM(hits_view)*100,2) ELSE 0 END as cr_cart_pct,
           CASE WHEN SUM(hits_view)>0 THEN ROUND(SUM(orders_item)::numeric/SUM(hits_view)*100,2) ELSE 0 END as cr_order_pct,
           CASE WHEN SUM(orders_item)>0 THEN ROUND(SUM(delivered_units)::numeric/SUM(orders_item)*100,1) ELSE 0 END as redemption_pct
         FROM ozon_analytics WHERE date BETWEEN ? AND ?
         GROUP BY date ORDER BY date`,
        [from, to]
      );
      return res.json({ success: true, data: rows });
    }

    const rows = await query(
      `SELECT oa.sku, oa.offer_id, oa.product_name,
         SUM(oa.hits_view) as hits_view, SUM(oa.hits_view_pdp) as hits_view_pdp,
         SUM(oa.hits_tocart) as hits_tocart, SUM(oa.orders_item) as orders_item,
         SUM(oa.revenue) as revenue, SUM(oa.delivered_units) as delivered_units,
         SUM(oa.returns) as returns, SUM(oa.cancellations) as cancellations,
         CASE WHEN SUM(oa.hits_view)>0 THEN ROUND(SUM(oa.hits_view_pdp)::numeric/SUM(oa.hits_view)*100,2) ELSE 0 END as ctr_pct,
         CASE WHEN SUM(oa.hits_view)>0 THEN ROUND(SUM(oa.hits_tocart)::numeric/SUM(oa.hits_view)*100,2) ELSE 0 END as cr_cart_pct,
         CASE WHEN SUM(oa.hits_view)>0 THEN ROUND(SUM(oa.orders_item)::numeric/SUM(oa.hits_view)*100,2) ELSE 0 END as cr_order_pct,
         CASE WHEN SUM(oa.hits_tocart)>0 THEN ROUND(SUM(oa.orders_item)::numeric/SUM(oa.hits_tocart)*100,1) ELSE 0 END as cr_cart_to_order_pct,
         CASE WHEN SUM(oa.orders_item)>0 THEN ROUND(SUM(oa.delivered_units)::numeric/SUM(oa.orders_item)*100,1) ELSE 0 END as redemption_pct,
         COALESCE(ads.spend,0) as ad_spend,
         CASE WHEN SUM(oa.revenue)>0 THEN ROUND(COALESCE(ads.spend,0)/SUM(oa.revenue)*100,1) ELSE 0 END as drr,
         COALESCE(pc.cost_price,0) as cost_price,
         CASE WHEN SUM(oa.orders_item)>0 THEN ROUND(SUM(oa.revenue)/SUM(oa.orders_item),0) ELSE 0 END as avg_price,
         (SELECT SUM(fbo_present+fbs_present) FROM ozon_stocks WHERE sku=oa.sku AND snapshot_date=(SELECT MAX(snapshot_date) FROM ozon_stocks)) as stock_qty
       FROM ozon_analytics oa
       LEFT JOIN (SELECT sku, SUM(spend) as spend FROM ozon_ads WHERE date BETWEEN ? AND ? GROUP BY sku) ads ON ads.sku=oa.sku
       LEFT JOIN product_costs pc ON pc.platform='ozon' AND pc.article=oa.offer_id
       WHERE oa.date BETWEEN ? AND ?
       GROUP BY oa.sku,oa.offer_id,oa.product_name,ads.spend,pc.cost_price
       ORDER BY revenue DESC LIMIT 500`,
      [from, to, from, to]
    );

    const [totals] = await query(
      `SELECT SUM(hits_view) as hits_view, SUM(hits_view_pdp) as hits_view_pdp,
         SUM(hits_tocart) as hits_tocart, SUM(orders_item) as orders_item,
         SUM(revenue) as revenue, SUM(delivered_units) as delivered_units, SUM(returns) as returns,
         CASE WHEN SUM(hits_view)>0 THEN ROUND(SUM(hits_view_pdp)::numeric/SUM(hits_view)*100,2) ELSE 0 END as ctr_pct,
         CASE WHEN SUM(hits_view)>0 THEN ROUND(SUM(hits_tocart)::numeric/SUM(hits_view)*100,2) ELSE 0 END as cr_cart_pct,
         CASE WHEN SUM(hits_view)>0 THEN ROUND(SUM(orders_item)::numeric/SUM(hits_view)*100,2) ELSE 0 END as cr_order_pct,
         CASE WHEN SUM(orders_item)>0 THEN ROUND(SUM(delivered_units)::numeric/SUM(orders_item)*100,1) ELSE 0 END as redemption_pct
       FROM ozon_analytics WHERE date BETWEEN ? AND ?`,
      [from, to]
    );

    res.json({ success: true, data: rows, totals: totals || {} });
  } catch(e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

router.get('/ozon/funnel', async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const from = dateFrom || dayjs().subtract(30,'day').format('YYYY-MM-DD');
    const to   = dateTo   || dayjs().format('YYYY-MM-DD');
    const [r] = await query(
      `SELECT SUM(hits_view) as impressions, SUM(hits_view_pdp) as card_views,
         SUM(hits_tocart) as cart_adds, SUM(orders_item) as orders,
         SUM(delivered_units) as delivered, SUM(revenue) as revenue,
         CASE WHEN SUM(hits_view)>0 THEN ROUND(SUM(hits_view_pdp)::numeric/SUM(hits_view)*100,1) ELSE 0 END as imp_to_card,
         CASE WHEN SUM(hits_view_pdp)>0 THEN ROUND(SUM(hits_tocart)::numeric/SUM(hits_view_pdp)*100,1) ELSE 0 END as card_to_cart,
         CASE WHEN SUM(hits_tocart)>0 THEN ROUND(SUM(orders_item)::numeric/SUM(hits_tocart)*100,1) ELSE 0 END as cart_to_order,
         CASE WHEN SUM(orders_item)>0 THEN ROUND(SUM(delivered_units)::numeric/SUM(orders_item)*100,1) ELSE 0 END as order_to_delivered,
         CASE WHEN SUM(hits_view)>0 THEN ROUND(SUM(orders_item)::numeric/SUM(hits_view)*100,2) ELSE 0 END as overall_cr
       FROM ozon_analytics WHERE date BETWEEN ? AND ?`,
      [from, to]
    );
    res.json({ success: true, data: r || {} });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
