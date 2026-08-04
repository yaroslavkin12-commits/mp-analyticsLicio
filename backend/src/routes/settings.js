const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { runAll, runWB, runOzon } = require('../scheduler');
const dayjs = require('dayjs');

router.get('/costs', async (req, res) => {
  try {
    const { platform } = req.query;
    const costs = platform
      ? await query(`SELECT * FROM product_costs WHERE platform=? ORDER BY article`, [platform])
      : await query(`SELECT * FROM product_costs ORDER BY platform, article`);
    res.json({ success: true, data: costs });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/costs', async (req, res) => {
  try {
    const { costs } = req.body;
    if (!Array.isArray(costs) || !costs.length)
      return res.status(400).json({ success: false, error: 'costs array required' });

    for (const c of costs) {
      await query(
        `INSERT INTO product_costs (platform, article, product_name, cost_price)
         VALUES (?,?,?,?)
         ON CONFLICT (platform, article) DO UPDATE SET
           product_name=EXCLUDED.product_name, cost_price=EXCLUDED.cost_price`,
        [c.platform, c.article, c.product_name || null, parseFloat(c.cost_price) || 0]
      );
    }
    res.json({ success: true, saved: costs.length });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.delete('/costs/:id', async (req, res) => {
  try {
    await query(`DELETE FROM product_costs WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/collect', async (req, res) => {
  const { platform = 'all', dateFrom } = req.body;
  res.json({ success: true, message: 'Сбор данных запущен' });
  setTimeout(async () => {
    try {
      if (platform === 'wb') await runWB(dateFrom);
      else if (platform === 'ozon') await runOzon(dateFrom);
      else await runAll(dateFrom);
    } catch (e) { console.error('Manual collect error:', e.message); }
  }, 100);
});

router.get('/status', async (req, res) => {
  try {
    const [lastWB] = await query(
      `SELECT finished_at, status, records_collected FROM collection_log
       WHERE platform='wb' ORDER BY started_at DESC LIMIT 1`);
    const [lastOzon] = await query(
      `SELECT finished_at, status, records_collected FROM collection_log
       WHERE platform='ozon' ORDER BY started_at DESC LIMIT 1`);
    res.json({
      success: true,
      data: {
        wb: { enabled: process.env.WB_ENABLED !== 'false' && !!process.env.WB_TOKEN, lastSync: lastWB || null },
        ozon: { enabled: process.env.OZON_ENABLED !== 'false' && !!process.env.OZON_CLIENT_ID, lastSync: lastOzon || null },
      },
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
