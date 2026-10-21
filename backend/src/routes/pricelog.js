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
//   pricelog:<cab>:<platform>:plans      — { артикул: [{ c, r, rule, at }] } — новые цены с правилом,
//       выгруженные из «Набора для выгрузки» (c — цена клиента, r — цена реализации)
//   pricelog:<cab>:<platform>:rules      — [название] — запомненные правила (группы), свежие первыми
//   В снимке: rule — { артикул: правило }, ruleSrc — { артикул: 'f' (из файла) | 's' (запомнено сайтом) }
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
    const { cabinet, platform, date, file, items, old, zero, site, autoOld, rules } = req.body || {};
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
    // «Было» не передали (общий файл на все магазины) — берём цену клиента на
    // сайте (плагин Соинвест): последнюю запись до дня снимка, иначе в этот день.
    if (autoOld && !snap.old) {
      await require('../lib/priceEvents').ensurePriceDaily().catch(() => {});
      const rows = await query(`SELECT DISTINCT ON (offer_id) offer_id, card, date::text AS d FROM price_daily
          WHERE cabinet = $1 AND card IS NOT NULL AND date <= $2 AND date >= $2::date - 14
          ORDER BY offer_id, (date < $2) DESC, date DESC`, [cabinet, date]).catch(() => []);
      const cur = new Map(rows.map(r => [r.offer_id, Number(r.card)]));
      const o2 = {}, missing = [];
      for (const [o, b] of Object.entries(snap.items)) { const a = cur.get(o); if (a > 0) o2[o] = Math.round(a * 100) / 100; else missing.push(o); }
      if (Object.keys(o2).length) {
        // Без текущей цены — считаем «без изменений», чтобы не выдумывать сдвиг.
        for (const o of missing) o2[o] = snap.items[o];
        snap.old = o2;
        snap.noOld = missing;
      }
      // Цена на сайте в момент загрузки — для свежих снимков.
      if (!snap.site && Math.abs(Date.now() - Date.parse(date)) < 3 * 86400e3) {
        const lt = await query(`SELECT DISTINCT ON (offer_id) offer_id, card FROM price_daily WHERE cabinet = $1 AND card IS NOT NULL ORDER BY offer_id, date DESC`, [cabinet]).catch(() => []);
        const st = {}; for (const r of lt) if (snap.items[r.offer_id]) st[r.offer_id] = Number(r.card);
        if (Object.keys(st).length) snap.site = cleanMap(st);
      }
    }
    // Правило (группа) артикула: колонка «Правило» в файле, иначе — запомненная выгрузка из «Набора».
    {
      const plans = await getJson(k(cabinet, platform, 'plans'), {});
      const rule = {}, src = {};
      for (const [o, b] of Object.entries(snap.items)) {
        const a = snap.old?.[o];
        if (a && Math.abs(a - b) < 0.5) continue; // цена не менялась — группа не нужна
        const f = cleanRule(rules?.[o]);
        if (f) { rule[o] = f; src[o] = 'f'; continue; }
        const pr = planRule(plans, o, b, date);
        if (pr) { rule[o] = pr; src[o] = 's'; }
      }
      if (Object.keys(rule).length) { snap.rule = rule; snap.ruleSrc = src; }
      const fr = Object.entries(src).filter(([, v]) => v === 'f').map(([o]) => rule[o]);
      if (fr.length) await addRules(cabinet, platform, fr);
    }
    await setJson(k(cabinet, platform, `snap:${date}`), snap);
    let idx = (await index(cabinet, platform)).filter(s => s.id !== date);
    idx.push(metaOf(snap));
    idx.sort((a, b) => (a.date < b.date ? -1 : 1));
    while (idx.length > 156) { // три года еженедельных снимков
      const d = idx.shift();
      await query(`DELETE FROM app_settings WHERE key = $1`, [k(cabinet, platform, `snap:${d.id}`)]);
    }
    await setJson(k(cabinet, platform, 'index'), idx);
    res.json({ success: true, data: { snaps: idx, ruled: Object.keys(snap.rule || {}).length } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Правила (группы изменений) ───────────────────────────────────────────
const cleanRule = v => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
async function addRules(c, p, names) {
  const list = await getJson(k(c, p, 'rules'), []);
  const add = [...new Set(names.map(cleanRule).filter(Boolean))];
  if (!add.length) return list;
  const out = [...add, ...list.filter(x => !add.includes(x))].slice(0, 60);
  await setJson(k(c, p, 'rules'), out);
  return out;
}
router.get('/rules', async (req, res) => {
  try { res.json({ success: true, data: await getJson(k(req.query.cabinet || 'defly', req.query.platform, 'rules'), []) }); } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
// POST /rules { cabinet, add: [...] , remove: [...] } — запомнить / забыть название группы.
router.post('/rules', async (req, res) => {
  try {
    const { cabinet, platform, add, remove } = req.body || {};
    if (!cabinet) return res.status(400).json({ success: false, error: 'Нужен cabinet' });
    let list = await addRules(cabinet, platform, Array.isArray(add) ? add : []);
    if (Array.isArray(remove) && remove.length) { const rm = new Set(remove.map(cleanRule)); list = list.filter(x => !rm.has(x)); await setJson(k(cabinet, platform, 'rules'), list); }
    res.json({ success: true, data: list });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
// POST /plans { cabinet, items: [{ o, c, r, rule }] } — при выгрузке Excel из «Набора»: какие цены
// и по какому правилу поставили. По ним журнал узнаёт группу, если в файле нет колонки «Правило».
const PLAN_DAYS = 60;
router.post('/plans', async (req, res) => {
  try {
    const { cabinet, platform, items } = req.body || {};
    if (!cabinet || !Array.isArray(items)) return res.status(400).json({ success: false, error: 'Нужны cabinet и items' });
    const plans = await getJson(k(cabinet, platform, 'plans'), {});
    const at = new Date().toISOString(), old = Date.now() - PLAN_DAYS * 86400e3;
    let n = 0;
    for (const x of items) {
      const o = String(x?.o ?? '').trim().slice(0, 128), c = Number(x?.c), r = Number(x?.r), rule = cleanRule(x?.rule);
      if (!o || !rule || !(c > 0 || r > 0)) continue;
      const arr = (plans[o] || []).filter(p => Date.parse(p.at) > old && !(p.c === Math.round(c) && p.rule === rule));
      arr.push({ c: c > 0 ? Math.round(c) : null, r: r > 0 ? Math.round(r) : null, rule, at });
      plans[o] = arr.slice(-5); n++;
    }
    for (const o of Object.keys(plans)) { plans[o] = plans[o].filter(p => Date.parse(p.at) > old); if (!plans[o].length) delete plans[o]; }
    await setJson(k(cabinet, platform, 'plans'), plans);
    await addRules(cabinet, platform, items.map(x => x?.rule));
    // Сразу проставить правила в уже загруженные снимки последних 30 дней (если цены туда
    // загрузили раньше, чем выгрузили набор): только изменённым артикулам, у которых правило
    // не задано в файле или в журнале руками.
    const idx = await index(cabinet, platform), from = Date.now() - 30 * 86400e3, applied = [];
    for (const m of idx) {
      if (Date.parse(m.date) < from) continue;
      const key = k(cabinet, platform, `snap:${m.id}`), sn = await getJson(key, null);
      if (!sn?.old) continue;
      let ch = 0;
      for (const [o, b] of Object.entries(sn.items)) {
        const a = sn.old[o];
        if (!a || Math.abs(a - b) < 0.5 || !plans[o]) continue;
        const src = sn.ruleSrc?.[o];
        if (src === 'f' || src === 'm') continue;
        const pr = planRule(plans, o, b, sn.date);
        if (pr && sn.rule?.[o] !== pr) { sn.rule = sn.rule || {}; sn.ruleSrc = sn.ruleSrc || {}; sn.rule[o] = pr; sn.ruleSrc[o] = 's'; ch++; }
      }
      if (ch) { await setJson(key, sn); applied.push({ date: sn.date, n: ch }); }
    }
    res.json({ success: true, data: { saved: n, applied } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
// Правило для артикула снимка по запомненным выгрузкам: та же новая цена (клиента или реализации)
// (±2 ₽ или 0,5%), выгрузка не раньше чем за 30 дней до снимка (позже — можно: правила
// проставляют и задним числом, если цены загрузили раньше выгрузки набора).
function planRule(plans, o, price, date) {
  const t = Date.parse(date), arr = (plans[o] || []).filter(p => Date.parse(p.at) >= t - 30 * 86400e3);
  let best = null;
  for (const p of arr) {
    const dev = Math.min(p.c > 0 ? Math.abs(p.c - price) : Infinity, p.r > 0 ? Math.abs(p.r - price) : Infinity);
    if (dev <= Math.max(2, price * 0.005) && (!best || dev < best.dev || (dev === best.dev && p.at > best.at))) best = { ...p, dev };
  }
  return best ? best.rule : null;
}

// POST /snap-rule { cabinet, snapId, offers: [...], rule } — поменять правило (группу) у артикулов
// уже загруженного снимка; пустое правило — снять (группа считается автоматически).
router.post('/snap-rule', async (req, res) => {
  try {
    const { cabinet, platform, snapId, offers, rule } = req.body || {};
    if (!cabinet || !snapId || !Array.isArray(offers)) return res.status(400).json({ success: false, error: 'Нужны cabinet, snapId и offers' });
    const key = k(cabinet, platform, `snap:${snapId}`), s = await getJson(key, null);
    if (!s) return res.status(404).json({ success: false, error: 'Снимок не найден' });
    const r = cleanRule(rule);
    s.rule = s.rule || {}; s.ruleSrc = s.ruleSrc || {};
    for (const o0 of offers) { const o = String(o0); if (!s.items[o]) continue; if (r) { s.rule[o] = r; s.ruleSrc[o] = 'm'; } else { delete s.rule[o]; delete s.ruleSrc[o]; } }
    await setJson(key, s);
    if (r) await addRules(cabinet, platform, [r]);
    res.json({ success: true, data: s });
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
