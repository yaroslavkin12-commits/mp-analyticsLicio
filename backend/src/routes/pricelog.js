const express = require('express');
const { query } = require('../db');

// ─────────────────────────────────────────────────────────────────────────
// «Журнал цен» — недельные снимки цен для клиента из репрайсера (пока Ozon,
// магазин «Дефлай»), цели изменений и заметки по артикулам.
// В app_settings:
//   pricelog:<cab>:<platform>:snaps — [{ id, date, file, at, items: { артикул: цена } }]
//   pricelog:<cab>:<platform>:marks — { snapId: { артикул: { goal, note } } }
// ─────────────────────────────────────────────────────────────────────────
const router = express.Router();
const k = (c, p, x) => `pricelog:${c}:${p || 'ozon'}:${x}`;
async function getJson(key, def) {
  const r = await query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
  try { return r[0] ? JSON.parse(r[0].value) : def; } catch (e) { return def; }
}
async function setJson(key, v) {
  await query(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key, JSON.stringify(v)]);
}

router.get('/', async (req, res) => {
  try {
    const c = req.query.cabinet || 'defly', p = req.query.platform || 'ozon';
    const [snaps, marks] = await Promise.all([getJson(k(c, p, 'snaps'), []), getJson(k(c, p, 'marks'), {})]);
    res.json({ success: true, data: { snaps, marks } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /upload { cabinet, platform, date, file, items } — снимок на дату (та же дата — заменяется).
router.post('/upload', async (req, res) => {
  try {
    const { cabinet, platform, date, file, items } = req.body || {};
    if (!cabinet || !date || !items || typeof items !== 'object') return res.status(400).json({ success: false, error: 'Нужны cabinet, date и items' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ success: false, error: 'Дата в формате ГГГГ-ММ-ДД' });
    const clean = {};
    for (const [o, v] of Object.entries(items)) { const a = String(o).trim().slice(0, 128), n = Number(v); if (a && Number.isFinite(n) && n > 0) clean[a] = Math.round(n * 100) / 100; }
    let snaps = await getJson(k(cabinet, platform, 'snaps'), []);
    snaps = snaps.filter(s => s.date !== date);
    snaps.push({ id: date, date, file: String(file || '').slice(0, 200), at: new Date().toISOString(), items: clean });
    snaps.sort((a, b) => (a.date < b.date ? -1 : 1));
    if (snaps.length > 104) snaps = snaps.slice(-104); // два года еженедельных снимков
    await setJson(k(cabinet, platform, 'snaps'), snaps);
    res.json({ success: true, data: { snaps } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/delete', async (req, res) => {
  try {
    const { cabinet, platform, id } = req.body || {};
    const snaps = (await getJson(k(cabinet, platform, 'snaps'), [])).filter(s => s.id !== id);
    await setJson(k(cabinet, platform, 'snaps'), snaps);
    res.json({ success: true, data: { snaps } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /marks { cabinet, platform, snapId, offers: [...], goal, note } — цель/заметка для артикулов недели.
// goal = null и note = null — снять.
router.post('/marks', async (req, res) => {
  try {
    const { cabinet, platform, snapId, offers, goal, note } = req.body || {};
    if (!cabinet || !snapId || !Array.isArray(offers)) return res.status(400).json({ success: false, error: 'Нужны cabinet, snapId и offers' });
    const marks = await getJson(k(cabinet, platform, 'marks'), {});
    const m = marks[snapId] || {};
    for (const o of offers) {
      const cur = { ...(m[o] || {}) };
      if (goal !== undefined) { if (goal) cur.goal = String(goal).slice(0, 40); else delete cur.goal; }
      if (note !== undefined) { if (note) cur.note = String(note).slice(0, 500); else delete cur.note; }
      if (Object.keys(cur).length) m[o] = cur; else delete m[o];
    }
    marks[snapId] = m;
    await setJson(k(cabinet, platform, 'marks'), marks);
    res.json({ success: true, data: { marks } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
