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

      // Выручка / Продажи = выкуплено покупателем (статус delivered)
      const [ozDel] = await query(`
        SELECT
          SUM(quantity)   as sales_qty,
          SUM(payout)     as revenue
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
