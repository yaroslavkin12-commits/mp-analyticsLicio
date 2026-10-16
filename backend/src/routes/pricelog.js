const express = require('express');
const { query } = require('../db');

// ─────────────────────────────────────────────────────────────────────────
// «Журнал цен» — снимки цен для клиента из репрайсера (пока Ozon, «Дефлай»),
// цели изменений и заметки по артикулам.
// В app_settings:
//   pricelog:<cab>:<platform>:index      — [{ id, date, file, at, n, fmt, up, down }]
//   pricelog:<cab>:<platform>:snap:<id>  — { id, date, file, at, fmt, items, old?, zero?, site? }
//       items — цена после изменения (стало), old — «было» из того же файла,
//       zero — артикулы с новой ценой 0, site — цена на сайте с Ozon-картой при загрузке
//   pricelog:<cab>:<platform>:marks      — { snapId: { артикул: { goal, note } } }
// Снимки лежат по отдельности: страница грузит только выбранную неделю и прошлую.
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
const metaOf = s => {
  let up = 0, down = 0;
  if (s.old) for (const [o, b] of Object.entries(s.items)) { const a = s.old[o]; if (a && Math.abs(b - a) >= 0.5) { if (b > a) up++; else down++; } }
  return { id: s.id, date: s.date, file: s.file, at: s.at, n: Object.keys(s.items).length, fmt: s.old ? 'two' : 'one', up, down };
};

// Первая версия хранила все снимки одним ключом — разложить по отдельным.
async function index(c, p) {
  let idx = await getJson(k(c, p, 'index'), null);
  if (idx) return idx;
  const legacy = await getJson(k(c, p, 'snaps'), []);
  for (const s of legacy) await setJson(k(c, p, `snap:${s.id}`), s);
  idx = legacy.map(metaOf);
  await setJson(k(c, p, 'index'), idx);
  if (legacy.length) await query(`DELETE FROM app_settings WHERE key = $1`, [k(c, p, 'snaps')]);
  return idx;
}

router.get('/', async (req, res) => {
  try {
    const c = req.query.cabinet || 'defly', p = req.query.platform || 'ozon';
    const [snaps, marks] = await Promise.all([index(c, p), getJson(k(c, p, 'marks'), {})]);
    res.json({ success: true, data: { snaps, marks } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /snap?id=… — один снимок целиком.
router.get('/snap', async (req, res) => {
  try {
    const c = req.query.cabinet || 'defly', p = req.query.platform || 'ozon';
    const s = await getJson(k(c, p, `snap:${req.query.id}`), null);
    if (!s) return res.status(404).json({ success: false, error: 'Снимок не найден' });
    res.json({ success: true, data: s });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /history?offer=… — цена артикула во всех снимках.
router.get('/history', async (req, res) => {
  try {
    const c = req.query.cabinet || 'defly', p = req.query.platform || 'ozon', o = String(req.query.offer || '');
    const rows = await query(`SELECT value FROM app_settings WHERE key LIKE $1`, [k(c, p, 'snap:%')]);
    const out = [];
    for (const r of rows) {
      let s; try { s = JSON.parse(r.value); } catch (e) { continue; }
      if (s.items?.[o] === undefined) continue;
      out.push({ id: s.id, date: s.date, p: s.items[o], a: s.old?.[o] ?? null, zero: (s.zero || []).includes(o) });
    }
    out.sort((a, b) => (a.date < b.date ? -1 : 1));
    res.json({ success: true, data: out });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /dynamics?cabinet=&days=90 — цены по дням (price_daily): по артикулу только дни, когда цена
// изменилась: { from, to, items: { артикул: [[день от from, цена реализации, цена клиента], ...] } }.
router.get('/dynamics', async (req, res) => {
  try {
    const c = req.query.cabinet || 'defly';
    const days = Math.min(400, Math.max(7, Number(req.query.days) || 90));
    const dayjs = require('dayjs');
    const to = dayjs().add(3, 'hour').format('YYYY-MM-DD'), from = dayjs(to).subtract(days - 1, 'day').format('YYYY-MM-DD');
    await require('../lib/priceEvents').ensurePriceDaily();
    const rows = await query(`SELECT offer_id, date::text AS d, seller, card FROM price_daily WHERE cabinet = $1 AND date BETWEEN $2 AND $3 ORDER BY offer_id, date`, [c, from, to]);
    const items = {}, last = {};
    const f0 = dayjs(from);
    for (const r of rows) {
      const s = r.seller !== null ? Math.round(Number(r.seller)) : null, cc = r.card !== null ? Math.round(Number(r.card)) : null;
      const l = last[r.offer_id];
      if (l && l[0] === s && l[1] === cc) continue;
      last[r.offer_id] = [s, cc];
      (items[r.offer_id] || (items[r.offer_id] = [])).push([dayjs(r.d).diff(f0, 'day'), s, cc]);
    }
    res.json({ success: true, data: { from, to, days, items } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /upload { cabinet, platform, date, file, items, old?, zero?, site? } — снимок на дату (та же дата заменяется).
router.post('/upload', async (req, res) => {
  try {
    const { cabinet, platform, date, file, items, old, zero, site } = req.body || {};
    if (!cabinet || !date || !items || typeof items !== 'object') return res.status(400).json({ success: false, error: 'Нужны cabinet, date и items' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ success: false, error: 'Дата в формате ГГГГ-ММ-ДД' });
    const cleanMap = m => {
      const out = {};
      for (const [o, v] of Object.entries(m || {})) { const a = String(o).trim().slice(0, 128), n = Number(v); if (a && Number.isFinite(n) && n > 0) out[a] = Math.round(n * 100) / 100; }
      return out;
    };
    const snap = { id: date, date, file: String(file || '').slice(0, 200), at: new Date().toISOString(), items: cleanMap(items) };
    if (old && typeof old === 'object') snap.old = cleanMap(old);
    if (Array.isArray(zero) && zero.length) snap.zero = zero.map(x => String(x).slice(0, 128)).filter(x => snap.items[x]);
    if (site && typeof site === 'object') snap.site = cleanMap(site);
    await setJson(k(cabinet, platform, `snap:${date}`), snap);
    let idx = (await index(cabinet, platform)).filter(s => s.id !== date);
    idx.push(metaOf(snap));
    idx.sort((a, b) => (a.date < b.date ? -1 : 1));
    while (idx.length > 156) { // три года еженедельных снимков
      const d = idx.shift();
      await query(`DELETE FROM app_settings WHERE key = $1`, [k(cabinet, platform, `snap:${d.id}`)]);
    }
    await setJson(k(cabinet, platform, 'index'), idx);
    res.json({ success: true, data: { snaps: idx } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/delete', async (req, res) => {
  try {
    const { cabinet, platform, id } = req.body || {};
    const idx = (await index(cabinet, platform)).filter(s => s.id !== id);
    await query(`DELETE FROM app_settings WHERE key = $1`, [k(cabinet, platform, `snap:${id}`)]);
    await setJson(k(cabinet, platform, 'index'), idx);
    res.json({ success: true, data: { snaps: idx } });
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
