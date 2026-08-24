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
      // Сумма заказов = все заказы (price_with_disc) из wb_orders
      const [wbO] = await query(`
        SELECT
          COUNT(*) FILTER (WHERE is_cancel = false)            as orders_qty,
          SUM(price_with_disc) FILTER (WHERE is_cancel = false) as orders_sum
        FROM wb_orders WHERE date BETWEEN $1 AND $2
      `, [from, to]);

      // Выручка = фактические продажи (for_pay) из wb_sales
      const [wbS] = await query(`
        SELECT
          COUNT(*)          as sales_qty,
          SUM(for_pay)      as revenue,
          SUM(price_with_disc) as sales_sum
        FROM wb_sales WHERE date BETWEEN $1 AND $2
      `, [from, to]);

      const [wbA] = await query(`
        SELECT SUM(spend) as spend FROM wb_ads WHERE date BETWEEN $1 AND $2
      `, [from, to]);

      const ordersQty  = Number(wbO?.orders_qty  || 0);
      const ordersSum  = Number(wbO?.orders_sum  || 0);
      const salesQty   = Number(wbS?.sales_qty   || 0);
      const revenue    = Number(wbS?.revenue     || 0);
      const adSpend    = Number(wbA?.spend       || 0);

      result.wb = {
        orders_sum:       ordersSum,
        orders_qty:       ordersQty,
        revenue:          revenue,
        sales_qty:        salesQty,
        redemption_rate:  ordersQty > 0 ? (salesQty / ordersQty * 100).toFixed(1) : 0,
        ad_spend:         adSpend,
        drr:              ordersSum > 0 ? (adSpend / ordersSum * 100).toFixed(1) : 0,
      };
    }

    if (platform === 'all' || platform === 'ozon') {
      // Сумма заказов = все не отменённые заказы
      const [ozO] = await query(`
        SELECT
          SUM(quantity)           as orders_qty,
          SUM(price * quantity)   as orders_sum
        FROM ozon_orders
        WHERE date BETWEEN $1 AND $2
          AND status NOT IN ('cancelled','cancelled_from_split_order','not_accepted')
      `, [from, to]);

      // Выручка = доставленные (payout)
      const [ozD] = await query(`
        SELECT
          SUM(quantity)   as sales_qty,
          SUM(payout)     as revenue
        FROM ozon_orders
        WHERE date BETWEEN $1 AND $2
          AND status IN ('delivered','awaiting_deliver','arbitration','client_arbitration')
      `, [from, to]);

      const [ozA] = await query(`
        SELECT SUM(spend) as spend FROM ozon_ads WHERE date BETWEEN $1 AND $2
      `, [from, to]);

      const ordersQty  = Number(ozO?.orders_qty || 0);
      const ordersSum  = Number(ozO?.orders_sum || 0);
      const salesQty   = Number(ozD?.sales_qty  || 0);
      const revenue    = Number(ozD?.revenue    || 0);
      const adSpend    = Number(ozA?.spend      || 0);

      result.ozon = {
        orders_sum:       ordersSum,
        orders_qty:       ordersQty,
        revenue:          revenue,
        sales_qty:        salesQty,
        redemption_rate:  ordersQty > 0 ? (salesQty / ordersQty * 100).toFixed(1) : 0,
        ad_spend:         adSpend,
        drr:              ordersSum > 0 ? (adSpend / ordersSum * 100).toFixed(1) : 0,
      };
    }

    res.json({ success: true, data: result, period: { from, to } });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/dashboard/chart?platform=all&dateFrom=&dateTo=
router.get('/chart', async (req, res) => {
  try {
    const { platform = 'all', dateFrom, dateTo } = req.query;
    const from = dateFrom || dayjs().subtract(30,'day').format('YYYY-MM-DD');
    const to   = dateTo   || dayjs().format('YYYY-MM-DD');
    const result = {};

    if (platform === 'all' || platform === 'wb') {
      result.wb = await query(`
        SELECT
          date::text as date,
          SUM(price_with_disc) FILTER (WHERE is_cancel=false) as orders_sum,
          COUNT(*) FILTER (WHERE is_cancel=false) as orders_qty
        FROM wb_orders WHERE date BETWEEN $1 AND $2
        GROUP BY date ORDER BY date
      `, [from, to]);
    }

    if (platform === 'all' || platform === 'ozon') {
      result.ozon = await query(`
        SELECT
          date::text as date,
          SUM(price*quantity) as orders_sum,
          SUM(quantity) as orders_qty
        FROM ozon_orders
        WHERE date BETWEEN $1 AND $2
          AND status NOT IN ('cancelled','cancelled_from_split_order','not_accepted')
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
