const express = require('express');
const router = express.Router();
const { query } = require('../db');
const dayjs = require('dayjs');

router.get('/overview', async (req, res) => {
  try {
    const { platform = 'all', dateFrom, dateTo } = req.query;
    const from = dateFrom || dayjs().subtract(30, 'day').format('YYYY-MM-DD');
    const to = dateTo || dayjs().format('YYYY-MM-DD');
    const result = {};

    if (platform === 'all' || platform === 'wb') {
      const [wbS] = await query(
        `SELECT COUNT(*) as sales, SUM(price_with_disc) as revenue, SUM(for_pay) as payout
         FROM wb_sales WHERE date BETWEEN ? AND ?`, [from, to]);
      const [wbO] = await query(
        `SELECT COUNT(*) as total FROM wb_orders WHERE date BETWEEN ? AND ?`, [from, to]);
      const [wbA] = await query(
        `SELECT SUM(spend) as spend, SUM(orders) as ad_orders, SUM(views) as views, SUM(clicks) as clicks
         FROM wb_ads WHERE date BETWEEN ? AND ?`, [from, to]);
      result.wb = {
        sales: Number(wbS?.sales || 0),
        revenue: Number(wbS?.revenue || 0),
        payout: Number(wbS?.payout || 0),
        orders: Number(wbO?.total || 0),
        adSpend: Number(wbA?.spend || 0),
        adOrders: Number(wbA?.ad_orders || 0),
        adViews: Number(wbA?.views || 0),
        adClicks: Number(wbA?.clicks || 0),
        redemptionRate: Number(wbO?.total) > 0
          ? (Number(wbS?.sales || 0) / Number(wbO.total) * 100).toFixed(1) : 0,
        drr: Number(wbS?.revenue) > 0
          ? (Number(wbA?.spend || 0) / Number(wbS.revenue) * 100).toFixed(1) : 0,
      };
    }

    if (platform === 'all' || platform === 'ozon') {
      const [ozS] = await query(
        `SELECT COUNT(*) as orders, SUM(quantity) as units, SUM(price*quantity) as revenue, SUM(payout) as payout
         FROM ozon_orders WHERE date BETWEEN ? AND ?
           AND status NOT IN ('cancelled','cancelled_from_split_order')`, [from, to]);
      const [ozA] = await query(
        `SELECT SUM(spend) as spend, SUM(orders) as ad_orders, SUM(views) as views, SUM(clicks) as clicks
         FROM ozon_ads WHERE date BETWEEN ? AND ?`, [from, to]);
      result.ozon = {
        sales: Number(ozS?.orders || 0),
        revenue: Number(ozS?.revenue || 0),
        payout: Number(ozS?.payout || 0),
        units: Number(ozS?.units || 0),
        adSpend: Number(ozA?.spend || 0),
        adOrders: Number(ozA?.ad_orders || 0),
        adViews: Number(ozA?.views || 0),
        adClicks: Number(ozA?.clicks || 0),
        drr: Number(ozS?.revenue) > 0
          ? (Number(ozA?.spend || 0) / Number(ozS.revenue) * 100).toFixed(1) : 0,
      };
    }

    res.json({ success: true, data: result, period: { from, to } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/chart', async (req, res) => {
  try {
    const { platform = 'all', dateFrom, dateTo } = req.query;
    const from = dateFrom || dayjs().subtract(30, 'day').format('YYYY-MM-DD');
    const to = dateTo || dayjs().format('YYYY-MM-DD');
    const result = {};

    if (platform === 'all' || platform === 'wb') {
      result.wb = await query(
        `SELECT date::text as date, COUNT(*) as sales, SUM(price_with_disc) as revenue, SUM(for_pay) as payout
         FROM wb_sales WHERE date BETWEEN ? AND ?
         GROUP BY date ORDER BY date`, [from, to]);
    }
    if (platform === 'all' || platform === 'ozon') {
      result.ozon = await query(
        `SELECT date::text as date, COUNT(*) as sales, SUM(price*quantity) as revenue, SUM(payout) as payout
         FROM ozon_orders WHERE date BETWEEN ? AND ?
           AND status NOT IN ('cancelled','cancelled_from_split_order')
         GROUP BY date ORDER BY date`, [from, to]);
    }
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/stocks', async (req, res) => {
  try {
    const { platform = 'all' } = req.query;
    const result = {};

    if (platform === 'all' || platform === 'wb') {
      result.wb = await query(
        `SELECT nm_id, supplier_article as article, subject, category,
                SUM(quantity) as total_quantity, MAX(snapshot_date)::text as last_update
         FROM wb_stocks
         WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM wb_stocks)
         GROUP BY nm_id, supplier_article, subject, category
         ORDER BY total_quantity ASC LIMIT 200`);
    }
    if (platform === 'all' || platform === 'ozon') {
      result.ozon = await query(
        `SELECT sku, offer_id, product_name,
                SUM(fbo_present) as fbo_qty, SUM(fbs_present) as fbs_qty,
                SUM(fbo_present + fbs_present) as total_qty,
                MAX(snapshot_date)::text as last_update
         FROM ozon_stocks
         WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM ozon_stocks)
         GROUP BY sku, offer_id, product_name
         ORDER BY total_qty ASC LIMIT 200`);
    }
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/products', async (req, res) => {
  try {
    const { platform = 'all', dateFrom, dateTo } = req.query;
    const from = dateFrom || dayjs().subtract(30, 'day').format('YYYY-MM-DD');
    const to = dateTo || dayjs().format('YYYY-MM-DD');
    const result = {};

    if (platform === 'all' || platform === 'wb') {
      result.wb = await query(
        `SELECT s.nm_id, s.supplier_article as article, s.subject,
           COUNT(*) as sales_count,
           SUM(s.price_with_disc) as revenue,
           SUM(s.for_pay) as payout,
           COALESCE(a.spend, 0) as ad_spend,
           COALESCE(pc.cost_price, 0) as cost_price
         FROM wb_sales s
         LEFT JOIN (SELECT nm_id, SUM(spend) as spend FROM wb_ads WHERE date BETWEEN ? AND ? GROUP BY nm_id) a
           ON a.nm_id = s.nm_id
         LEFT JOIN product_costs pc ON pc.platform='wb' AND pc.article = s.supplier_article
         WHERE s.date BETWEEN ? AND ?
         GROUP BY s.nm_id, s.supplier_article, s.subject, a.spend, pc.cost_price
         ORDER BY revenue DESC LIMIT 100`,
        [from, to, from, to]);
    }
    if (platform === 'all' || platform === 'ozon') {
      result.ozon = await query(
        `SELECT o.sku, o.offer_id, o.product_name,
           COUNT(*) as sales_count,
           SUM(o.price * o.quantity) as revenue,
           SUM(o.payout) as payout,
           COALESCE(a.spend, 0) as ad_spend,
           COALESCE(pc.cost_price, 0) as cost_price
         FROM ozon_orders o
         LEFT JOIN (SELECT sku, SUM(spend) as spend FROM ozon_ads WHERE date BETWEEN ? AND ? GROUP BY sku) a
           ON a.sku = o.sku
         LEFT JOIN product_costs pc ON pc.platform='ozon' AND pc.article = o.offer_id
         WHERE o.date BETWEEN ? AND ?
           AND o.status NOT IN ('cancelled','cancelled_from_split_order')
         GROUP BY o.sku, o.offer_id, o.product_name, a.spend, pc.cost_price
         ORDER BY revenue DESC LIMIT 100`,
        [from, to, from, to]);
    }
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/collection-log', async (req, res) => {
  try {
    const logs = await query(`SELECT * FROM collection_log ORDER BY started_at DESC LIMIT 50`);
    res.json({ success: true, data: logs });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
