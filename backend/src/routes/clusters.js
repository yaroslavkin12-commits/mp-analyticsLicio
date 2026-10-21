const express = require('express');
const dayjs = require('dayjs');
const { query } = require('../db');
const { ASSOCIATED_ARTICLES } = require('../config/associatedArticles');
const { autoPath, OV_SQL, overrideArgs } = require('../lib/categories');

// ─────────────────────────────────────────────────────────────────────────
// «Товары → Склейки»: какие артикулы объединены в одну карточку Ozon.
// Источник — model_id из каталога Ozon (скрипт пишет его во вкладку Catalog):
// все артикулы с одним model_id — одна склейка. Пока скрипт не обновлён —
// ручной список из config/associatedArticles.js.
// Сверху — «предполагаемые»: артикул без склейки, у которого тот же корень
// артикула, что у артикулов склейки (Hr50-2 → Hr50-2K, Hr50-2KR), или — для
// новинок — то же название модели. Решения пользователя (добавить / не относится)
// — в app_settings clusters:<cab> = { add: { артикул: id склейки }, ignore: { артикул: [id] },
//   groups: { id: [артикулы] } } (принятые предполагаемые склейки из одиночных артикулов).
// ─────────────────────────────────────────────────────────────────────────
const router = express.Router();
const KEY = c => `clusters:${c}`;
async function getJson(key, def) {
  const r = await query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
  try { return r[0] ? JSON.parse(r[0].value) : def; } catch (e) { return def; }
}
async function setJson(key, v) {
  await query(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key, JSON.stringify(v)]);
}
const num = v => (v === null || v === undefined ? 0 : Number(v) || 0);

// Корень артикула: без суффикса материала (K — экокожа, KR/ZR — ромб, C…): Hr50-2KR → Hr50-2.
const rootOf = o => String(o).replace(/(\d)(KR|ZR|K|R|C)$/i, '$1').toLowerCase();
// Модель из названия: всё, кроме последней части после запятой (обычно материал/цвет):
// «Чехлы на сиденья Ford Focus 3, 2010-2019, жаккард» → «чехлы на сиденья ford focus 3, 2010-2019».
// Название без запятых или слишком общее — не сравниваем.
const baseOf = n => {
  const p = String(n || '').toLowerCase().replace(/\s+/g, ' ').split(',').map(x => x.trim()).filter(Boolean);
  if (p.length < 3) return '';
  const b = p.slice(0, -1).join(', ');
  return b.length >= 25 ? b : '';
};

async function ensureCols() {
  for (const c of ['model_id TEXT', 'model_count INT', 'created_ozon DATE', 'archived BOOLEAN']) {
    await query(`ALTER TABLE ad_product_catalog ADD COLUMN IF NOT EXISTS ${c}`).catch(() => {});
  }
}

async function build(cabinet) {
  await ensureCols();
  const since = dayjs().subtract(30, 'day').format('YYYY-MM-DD');
  const [cat, ov, sales, dec] = await Promise.all([
    query(`SELECT offer_id, sku, product_name, model_id, model_count, created_ozon::text AS created, archived FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon'`, [cabinet]),
    query(OV_SQL, overrideArgs(cabinet)).catch(() => []),
    query(`SELECT offer_id, sku, SUM(orders_item) o FROM product_analytics_daily WHERE cabinet = $1 AND platform = 'ozon' AND date >= $2 GROUP BY offer_id, sku`, [cabinet, since]).catch(() => []),
    getJson(KEY(cabinet), {}),
  ]);
  const add = dec.add || {}, ignore = dec.ignore || {}, groups = dec.groups || {};
  const override = new Map(ov.map(r => [r.offer_id, r.path]));
  const bySku = new Map(cat.filter(r => r.sku != null).map(r => [String(r.sku), r.offer_id]));
  const ord = new Map();
  for (const r of sales) { const o = r.offer_id || bySku.get(String(r.sku)); if (o) ord.set(o, (ord.get(o) || 0) + num(r.o)); }
  const newFrom = dayjs().subtract(30, 'day').format('YYYY-MM-DD');
  const items = new Map();
  for (const r of cat) {
    if (r.archived) continue;
    items.set(r.offer_id, {
      o: r.offer_id, n: r.product_name || '', cat: override.get(r.offer_id) || autoPath(cabinet, r.product_name, r.offer_id).join(' / '),
      model: r.model_id || null, created: r.created || null, isNew: !!(r.created && r.created >= newFrom), orders30: ord.get(r.offer_id) || 0,
    });
  }
  const fromOzon = [...items.values()].some(x => x.model);

  // Склейки: по model_id (с Ozon) или из ручного списка.
  const clusters = new Map(); // id → { id, src, members: Set, manual: Set }
  const of = new Map(); // артикул → id склейки
  const put = (id, src, o, manual) => {
    if (!items.has(o) || of.has(o)) return;
    let c = clusters.get(id); if (!c) { c = { id, src, members: [], manual: [] }; clusters.set(id, c); }
    c.members.push(o); if (manual) c.manual.push(o); of.set(o, id);
  };
  if (fromOzon) {
    const byModel = new Map();
    for (const x of items.values()) if (x.model) { const a = byModel.get(x.model) || []; a.push(x.o); byModel.set(x.model, a); }
    for (const [m, list] of byModel) if (list.length >= 2) for (const o of list) put(`m${m}`, 'ozon', o);
  } else {
    for (const [primary, sib] of Object.entries(ASSOCIATED_ARTICLES[cabinet] || {})) for (const o of [primary, ...sib]) put(`c:${primary}`, 'list', o);
  }
  // Принятые предполагаемые склейки и ручные добавления.
  for (const [id, list] of Object.entries(groups)) for (const o of list) put(id, 'manual', o, true);
  for (const [o, id] of Object.entries(add)) if (clusters.has(id)) put(id, clusters.get(id).src, o, true);

  // Предполагаемые: одиночный артикул → склейка с тем же корнем артикула (или, для новинок, с тем же названием).
  const ign = (o, id) => (ignore[o] || []).includes(id);
  const rootIdx = new Map(), baseIdx = new Map();
  for (const c of clusters.values()) for (const o of c.members) {
    const r = rootOf(o); if (!rootIdx.has(r)) rootIdx.set(r, new Set()); rootIdx.get(r).add(c.id);
    const b = baseOf(items.get(o).n); if (b) { if (!baseIdx.has(b)) baseIdx.set(b, new Map()); const m = baseIdx.get(b); m.set(c.id, (m.get(c.id) || 0) + 1); }
  }
  const singles = [...items.values()].filter(x => !of.has(x.o));
  const suggest = [];
  const taken = new Set();
  for (const x of singles) {
    const byRoot = [...(rootIdx.get(rootOf(x.o)) || [])].filter(id => !ign(x.o, id));
    if (byRoot.length === 1) { suggest.push({ o: x.o, to: byRoot[0], why: 'root' }); taken.add(x.o); continue; }
    if (!x.isNew) continue;
    const bx = baseOf(x.n), m = bx && baseIdx.get(bx);
    if (!m) continue;
    const cand = [...m.entries()].filter(([id]) => !ign(x.o, id)).sort((a, b) => b[1] - a[1]);
    if (cand.length === 1 || (cand.length > 1 && cand[0][1] > cand[1][1])) { suggest.push({ o: x.o, to: cand[0][0], why: 'name' }); taken.add(x.o); }
  }
  // Одиночные артикулы с общим корнем — похоже на одну карточку, которую не склеили.
  const byRootS = new Map();
  for (const x of singles) { if (taken.has(x.o)) continue; const r = rootOf(x.o); const a = byRootS.get(r) || []; a.push(x.o); byRootS.set(r, a); }
  const newGroups = [];
  for (const [r, list] of byRootS) {
    const id = `u:${r}`;
    const left = list.filter(o => !ign(o, id));
    if (left.length >= 2) newGroups.push({ id, members: left.sort() });
  }

  const nameOf = c => {
    const cnt = new Map();
    for (const o of c.members) {
      // Название без материала: первые две части до последней запятой («Чехлы на сиденья Ford Focus 3, 2010-2019»).
      const p = String(items.get(o).n || '').split(',').map(x => x.trim()).filter(Boolean);
      const n = (p.length > 1 ? p.slice(0, -1) : p).slice(0, 2).join(', ');
      if (n && n !== 'x') cnt.set(n, (cnt.get(n) || 0) + 1);
    }
    return [...cnt.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || c.members[0];
  };
  return {
    source: fromOzon ? 'ozon' : 'list',
    items: [...items.values()],
    clusters: [...clusters.values()].map(c => ({ ...c, name: nameOf(c) })),
    suggest,
    newGroups: newGroups.map(g => ({ ...g, name: nameOf(g) })),
  };
}

router.get('/', async (req, res) => {
  try { res.json({ success: true, data: await build(req.query.cabinet || 'defly') }); } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /decide { cabinet, action, offers: [...], id }
//   add    — добавить артикулы в склейку id (или принять предполагаемую u:… целиком);
//   ignore — «не относится» к склейке id;
//   reset  — убрать ручное решение по артикулам.
router.post('/decide', async (req, res) => {
  try {
    const { cabinet, action, offers, id } = req.body || {};
    if (!cabinet || !Array.isArray(offers) || !offers.length || !['add', 'ignore', 'reset'].includes(action)) return res.status(400).json({ success: false, error: 'Нужны cabinet, action и offers' });
    const d = await getJson(KEY(cabinet), {});
    d.add = d.add || {}; d.ignore = d.ignore || {}; d.groups = d.groups || {};
    const os = offers.map(o => String(o).slice(0, 128));
    if (action === 'add') {
      if (!id) return res.status(400).json({ success: false, error: 'Нужен id' });
      if (String(id).startsWith('u:')) { const set = new Set([...(d.groups[id] || []), ...os]); d.groups[id] = [...set]; } else for (const o of os) d.add[o] = id;
    } else if (action === 'ignore') {
      if (!id) return res.status(400).json({ success: false, error: 'Нужен id' });
      for (const o of os) { const a = new Set(d.ignore[o] || []); a.add(id); d.ignore[o] = [...a]; }
    } else {
      for (const o of os) {
        delete d.add[o]; delete d.ignore[o];
        for (const g of Object.keys(d.groups)) { d.groups[g] = d.groups[g].filter(x => x !== o); if (d.groups[g].length < 2) delete d.groups[g]; }
      }
    }
    await setJson(KEY(cabinet), d);
    res.json({ success: true, data: await build(cabinet) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
