const express = require('express');
const router = express.Router();
const { query } = require('../db');

// План месяца: { 'Все': {revenue, orders, profit, sales}, 'Чехлы': {...}, 'Чехлы / Чехлы на сиденья': {...} }
// Хранится в app_settings под ключом plan:<кабинет>:<ГГГГ-ММ>.
const key = (cabinet, month) => `plan:${cabinet}:${month}`;
router.get('/', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'defly', month = String(req.query.month || '').slice(0, 7);
    const rows = await query(`SELECT value FROM app_settings WHERE key = $1`, [key(cabinet, month)]);
    res.json({ success: true, data: rows[0] ? JSON.parse(rows[0].value) : {} });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.post('/', async (req, res) => {
  try {
    const { cabinet = 'defly', month, plan } = req.body || {};
    if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return res.status(400).json({ success: false, error: 'Нужен month в формате ГГГГ-ММ' });
    const clean = {};
    for (const [k, v] of Object.entries(plan || {})) {
      const o = {};
      for (const f of ['revenue', 'orders', 'profit', 'sales']) if (v && v[f] !== undefined && v[f] !== '' && Number.isFinite(Number(v[f]))) o[f] = Number(v[f]);
      if (Object.keys(o).length) clean[String(k).slice(0, 200)] = o;
    }
    await query(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key(cabinet, month), JSON.stringify(clean)]);
    res.json({ success: true, data: clean });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
module.exports = router;
