const express = require('express');
const { query } = require('../db');

// ─────────────────────────────────────────────────────────────────────────
// «Производство» — потребность в пошив чехлов на сиденья.
// Всё хранится в app_settings (JSON):
//   prod:<cab>:master    — справочник: артикул → { car, n, shop, mat, cycle, buffer, batch, top, yearOv }
//   prod:<cab>:<kind>    — загрузки из 1С: { at, file, items: { артикул: шт } },
//                          kind = year | w4 | w8 | stock;  «в пути» (Пошив) — общий
//                          список «отшивается» (sewing:<cab>, см. sales.js)
//   prod:<cab>:settings  — мощности цехов, коэффициенты
//   prod:<cab>:orders    — история поданных заказов (последние 60)
// Расчёт — на клиенте (dashboard/src/lib/production.js).
// ─────────────────────────────────────────────────────────────────────────
const router = express.Router();
router.use('/deflectors2d', require('./deflectors2d'));
const KINDS = ['year', 'w4', 'w8', 'stock'];
const key = (c, k) => `prod:${c}:${k}`;
async function getJson(k, def) {
  const r = await query(`SELECT value FROM app_settings WHERE key = $1`, [k]);
  try { return r[0] ? JSON.parse(r[0].value) : def; } catch (e) { return def; }
}
async function setJson(k, v) {
  await query(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [k, JSON.stringify(v)]);
}
const cleanItems = items => {
  const out = {};
  for (const [o, q] of Object.entries(items || {})) {
    const k = String(o).trim().slice(0, 128), n = Number(q);
    if (k && Number.isFinite(n)) out[k] = Math.round(n * 100) / 100;
  }
  return out;
};

router.get('/', async (req, res) => {
  try {
    const c = req.query.cabinet || 'defly';
    const [master, settings, orders, closed, sew, ...ups] = await Promise.all([
      getJson(key(c, 'master'), {}), getJson(key(c, 'settings'), null), getJson(key(c, 'orders'), []), getJson(key(c, 'jclosed'), {}),
      getJson(`sewing:${c}`, {}), ...KINDS.map(k => getJson(key(c, k), null)),
    ]);
    const uploads = Object.fromEntries(KINDS.map((k, i) => [k, ups[i]]));
    uploads.sew = { at: sew.updatedAt || null, items: sew.items || {} };
    res.json({ success: true, data: { master, settings, orders, closed, uploads } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /upload { cabinet, kind, items, file }
router.post('/upload', async (req, res) => {
  try {
    const { cabinet, kind, items, file } = req.body || {};
    if (!cabinet || !items) return res.status(400).json({ success: false, error: 'Нужны cabinet и items' });
    const at = new Date().toISOString();
    if (kind === 'sew') {
      // Пошив = «отшивается» в конструкторе таблицы: один общий список.
      const clean = {};
      for (const [o, q] of Object.entries(cleanItems(items))) if (q > 0) clean[o] = Math.round(q);
      await setJson(`sewing:${cabinet}`, { items: clean, updatedAt: at });
      return res.json({ success: true, data: { at, items: clean } });
    }
    if (!KINDS.includes(kind)) return res.status(400).json({ success: false, error: 'Неизвестный вид загрузки' });
    const v = { at, file: String(file || '').slice(0, 200), items: cleanItems(items) };
    await setJson(key(cabinet, kind), v);
    res.json({ success: true, data: v });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /master { cabinet, items: { артикул: {...} }, replace }
router.post('/master', async (req, res) => {
  try {
    const { cabinet, items, replace } = req.body || {};
    if (!cabinet || !items || typeof items !== 'object') return res.status(400).json({ success: false, error: 'Нужны cabinet и items' });
    const cur = replace ? {} : await getJson(key(cabinet, 'master'), {});
    for (const [o, v] of Object.entries(items)) {
      const k = String(o).trim().slice(0, 128); if (!k) continue;
      if (v === null) { delete cur[k]; continue; }
      cur[k] = { ...(cur[k] || {}), ...v };
    }
    await setJson(key(cabinet, 'master'), cur);
    res.json({ success: true, data: cur });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/settings', async (req, res) => {
  try {
    const { cabinet, settings } = req.body || {};
    if (!cabinet || !settings) return res.status(400).json({ success: false, error: 'Нужны cabinet и settings' });
    await setJson(key(cabinet, 'settings'), settings);
    res.json({ success: true, data: settings });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /orders { cabinet, order: { date, shop, tasks, pcs, items: [[артикул, шт, заданий, пошив, остаток, добор]] } }
// (пошив и остаток — на момент заявки, для журнала заявок)
router.post('/orders', async (req, res) => {
  try {
    const { cabinet, order, remove } = req.body || {};
    if (!cabinet) return res.status(400).json({ success: false, error: 'Нужен cabinet' });
    let list = await getJson(key(cabinet, 'orders'), []);
    if (remove) list = list.filter(o => o.id !== remove);
    if (order) list = [{ ...order, id: Date.now().toString(36), savedAt: new Date().toISOString() }, ...list].slice(0, 60);
    await setJson(key(cabinet, 'orders'), list);
    res.json({ success: true, data: list });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /journal { cabinet, offers: [...], close } — журнал заявок: закрыть артикулы
// (все заявки по ним до этого момента считаются выполненными) или вернуть.
router.post('/journal', async (req, res) => {
  try {
    const { cabinet, offers, close } = req.body || {};
    if (!cabinet || !Array.isArray(offers)) return res.status(400).json({ success: false, error: 'Нужны cabinet и offers' });
    const m = await getJson(key(cabinet, 'jclosed'), {});
    const at = new Date().toISOString();
    for (const o of offers) { const k = String(o).slice(0, 128); if (close) m[k] = at; else delete m[k]; }
    await setJson(key(cabinet, 'jclosed'), m);
    res.json({ success: true, data: m });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
