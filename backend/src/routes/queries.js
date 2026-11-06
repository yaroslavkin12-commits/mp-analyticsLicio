const express = require('express');
const router = express.Router();
const dayjs = require('dayjs');
const { query } = require('../db');
const { ORDER } = require('../lib/categories');
const { meta } = require('./finance');
const crypto = require('crypto');
const { ensureFinTables } = require('../collectors/ads/sheetSync');
const { bulkUpsert } = require('../collectors/ads/ozonHttp');

const num = v => Number(v) || 0;
const r2 = v => Math.round(v * 100) / 100;

// GET /api/queries/data?cabinet=&dateFrom=&dateTo= — пары «товар × запрос» за
// период: средняя позиция (взвешенная по частоте), частота, клики, заказы,
// выручка; позиция в первой и второй половине периода — для динамики.
router.get('/data', async (req, res) => {
  try {
    await ensureFinTables();
    const cabinet = req.query.cabinet || 'defly';
    const to = req.query.dateTo || dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    const from = req.query.dateFrom || dayjs(to).subtract(13, 'day').format('YYYY-MM-DD');
    const mid = dayjs(from).add(Math.floor(dayjs(to).diff(from, 'day') / 2), 'day').format('YYYY-MM-DD');
    const m = await meta(cabinet);
    const skuToOffer = new Map([...m.offerBySku.entries()]);
    const [rows, range] = await Promise.all([
      query(`SELECT sku, query, SUM(searches)::int s, SUM(clicks)::int c, SUM(orders)::int o, SUM(revenue) r,
                    SUM(position * GREATEST(searches, 1)) / NULLIF(SUM(GREATEST(searches, 1)) FILTER (WHERE position IS NOT NULL), 0) p,
                    SUM(position * GREATEST(searches, 1)) FILTER (WHERE date <= $4) / NULLIF(SUM(GREATEST(searches, 1)) FILTER (WHERE date <= $4 AND position IS NOT NULL), 0) p1,
                    SUM(position * GREATEST(searches, 1)) FILTER (WHERE date > $4) / NULLIF(SUM(GREATEST(searches, 1)) FILTER (WHERE date > $4 AND position IS NOT NULL), 0) p2
               FROM search_query_daily WHERE cabinet = $1 AND date BETWEEN $2 AND $3 GROUP BY sku, query`, [cabinet, from, to, mid]),
      query(`SELECT MIN(date)::text mn, MAX(date)::text mx FROM search_query_daily WHERE cabinet = $1`, [cabinet]),
    ]);
    const queries = [], qi = new Map();
    const out = [];
    for (const r of rows) {
      const o = skuToOffer.get(String(r.sku)); if (!o) continue;
      if (!qi.has(r.query)) { qi.set(r.query, queries.length); queries.push(r.query); }
      out.push([m.art(o), qi.get(r.query), r.p == null ? null : r2(num(r.p)), num(r.s), num(r.c), num(r.o), Math.round(num(r.r)), r.p1 == null ? null : r2(num(r.p1)), r.p2 == null ? null : r2(num(r.p2))]);
    }
    res.json({ success: true, data: { from, to, articles: m.articles, order: ORDER[cabinet] || [], queries, rows: out, available: range[0] || null } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/queries/series?cabinet=&offerId=&query=&days= — по дням: позиция и частота
// (если query не задан — все запросы товара).
router.get('/series', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'defly';
    const days = Math.min(60, Number(req.query.days) || 30);
    const from = dayjs().subtract(days, 'day').format('YYYY-MM-DD');
    const sku = await query(`SELECT sku FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon' AND offer_id = $2 AND sku IS NOT NULL`, [cabinet, req.query.offerId]);
    const skus = sku.map(r => num(r.sku));
    const params = [cabinet, from, skus];
    let cond = '';
    if (req.query.query) { params.push(req.query.query); cond = ' AND query = $4'; }
    const rows = skus.length ? await query(`SELECT date::text d, query, position, searches, clicks, orders FROM search_query_daily
      WHERE cabinet = $1 AND date >= $2 AND sku = ANY($3::bigint[])${cond} ORDER BY date`, params) : [];
    res.json({ success: true, data: rows.map(r => [r.d, r.query, r.position == null ? null : num(r.position), num(r.searches), num(r.clicks), num(r.orders)]) });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/queries/ingest — поисковые запросы напрямую из Google-скрипта,
// минуя Google-таблицу (у неё предел ячеек). Скрипт сам ходит в Ozon, сюда
// присылает готовые строки одного дня частями. Защита — подпись HMAC общим
// секретом QUERIES_SYNC_SECRET (в Render Environment и в свойствах скрипта).
// Тело: {cabinet, date, rows: [[sku, query, position, searches, views, clicks, orders, revenue, conversion], …]}.
// Строки дня дописываются/обновляются по ключу (кабинет, дата, SKU, запрос) и
// хранятся в базе без срока давности.
function verifySync(raw, ts, sig) {
  const secret = process.env.QUERIES_SYNC_SECRET;
  if (!secret || secret.length < 32) throw Object.assign(new Error('На сервере не задан QUERIES_SYNC_SECRET (не короче 32 символов)'), { status: 503 });
  if (!raw || !/^\d{13}$/.test(String(ts || '')) || Math.abs(Date.now() - Number(ts)) > 600000 || !/^[a-f0-9]{64}$/i.test(sig || '')) throw Object.assign(new Error('Неверная подпись'), { status: 401 });
  const expected = crypto.createHmac('sha256', secret).update(String(ts) + '.' + raw.toString('utf8')).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(sig, 'hex'))) throw Object.assign(new Error('Неверная подпись'), { status: 401 });
}
router.post('/ingest', async (req, res) => {
  try {
    verifySync(req.wbRawBody, req.get('X-Sync-Timestamp'), req.get('X-Sync-Signature'));
    await ensureFinTables();
    const { cabinet, date, rows } = req.body || {};
    if (!/^[a-z_]{2,32}$/.test(cabinet || '') || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Array.isArray(rows) || rows.length > 20000) return res.status(400).json({ success: false, error: 'Некорректные данные' });
    const out = [];
    for (const r of rows) {
      if (!Array.isArray(r) || !/^\d{1,15}$/.test(String(r[0])) || !r[1]) continue;
      const pos = Number(r[2]);
      out.push([cabinet, date, String(r[0]), String(r[1]).slice(0, 200), pos > 0 ? Math.round(pos * 100) / 100 : null,
        Math.round(num(r[3])), Math.round(num(r[4])), Math.round(num(r[5])), Math.round(num(r[6])), num(r[7]), r[8] === '' || r[8] == null ? null : num(r[8])]);
    }
    const n = out.length ? await bulkUpsert('search_query_daily', ['cabinet', 'date', 'sku', 'query', 'position', 'searches', 'views', 'clicks', 'orders', 'revenue', 'conversion'], out, ['cabinet', 'date', 'sku', 'query']) : 0;
    if (req.body.sample) await query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [`queries_sample:${cabinet}`, JSON.stringify({ at: new Date().toISOString(), date, sample: String(req.body.sample).slice(0, 1500) })]).catch(() => {});
    require('../lib/dataVersion').bump();
    res.json({ success: true, data: { rows: n } });
  } catch (e) { if (!e.status) console.error(e); res.status(e.status || 500).json({ success: false, error: e.message }); }
});

// GET /api/queries/sample?cabinet= — пример ответа Ozon по запросам (какие поля пришли).
router.get('/sample', async (req, res) => {
  try {
    const rows = await query(`SELECT value FROM app_settings WHERE key = $1`, [`queries_sample:${req.query.cabinet || 'defly'}`]).catch(() => []);
    res.json({ success: true, data: rows[0] ? JSON.parse(rows[0].value) : null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/queries/arts?cabinet=&dateFrom=&dateTo= — товары, у которых есть
// данные по запросам: [индекс артикула, запросов, искали (сумма по
// запросам), увидели, заказы, сумма]. Для выбора артикула.
router.get('/arts', async (req, res) => {
  try {
    await ensureFinTables();
    const cabinet = req.query.cabinet || 'defly';
    const to = req.query.dateTo || dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    const from = req.query.dateFrom || dayjs(to).subtract(13, 'day').format('YYYY-MM-DD');
    const m = await meta(cabinet);
    const rows = await query(`SELECT sku, COUNT(DISTINCT query)::int n, SUM(searches)::int s, SUM(views)::int v, SUM(orders)::int o, SUM(revenue) r
      FROM search_query_daily WHERE cabinet = $1 AND date BETWEEN $2 AND $3 GROUP BY sku`, [cabinet, from, to]);
    const agg = new Map();
    for (const r of rows) {
      const o = m.offerBySku.get(String(r.sku)); if (!o) continue;
      const ai = m.art(o);
      const a = agg.get(ai) || [ai, 0, 0, 0, 0, 0];
      a[1] = Math.max(a[1], num(r.n)); a[2] += num(r.s); a[3] += num(r.v); a[4] += num(r.o); a[5] += Math.round(num(r.r));
      agg.set(ai, a);
    }
    res.json({ success: true, data: { from, to, articles: m.articles, order: ORDER[cabinet] || [], rows: [...agg.values()] } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// Ручные группы запросов: app_settings query_groups:<кабинет> = { запрос: группа }.
const GROUP_KEYS = ['target', 'model', 'type', 'other'];
async function loadGroups(cabinet) {
  const rows = await query(`SELECT value FROM app_settings WHERE key = $1`, [`query_groups:${cabinet}`]).catch(() => []);
  try { return JSON.parse(rows[0]?.value || '{}') || {}; } catch (e) { return {}; }
}

// GET /api/queries/article?cabinet=&offerId=&dateFrom=&dateTo= — все запросы
// товара по дням: [дата, запрос, позиция, искали, увидели, переходы, заказы,
// сумма]. Если у артикула несколько SKU: «искали» — максимум (это одни и те
// же люди), позиция — лучшая, остальное складывается.
router.get('/article', async (req, res) => {
  try {
    await ensureFinTables();
    const cabinet = req.query.cabinet || 'defly';
    const offerId = String(req.query.offerId || '');
    const to = req.query.dateTo || dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    const from = req.query.dateFrom || dayjs(to).subtract(13, 'day').format('YYYY-MM-DD');
    const cat = await query(`SELECT sku, product_name FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon' AND offer_id = $2`, [cabinet, offerId]);
    const skus = cat.filter(r => r.sku != null).map(r => num(r.sku));
    const rows = skus.length ? await query(`SELECT date::text d, query, MIN(position) p, MAX(searches)::int s, SUM(views)::int v, SUM(clicks)::int c, SUM(orders)::int o, SUM(revenue) r
      FROM search_query_daily WHERE cabinet = $1 AND date BETWEEN $2 AND $3 AND sku = ANY($4::bigint[])
      GROUP BY date, query ORDER BY date`, [cabinet, from, to, skus]) : [];
    res.json({ success: true, data: {
      offerId, name: cat.find(r => r.product_name)?.product_name || '', from, to,
      rows: rows.map(r => [r.d, r.query, r.p == null ? null : r2(num(r.p)), num(r.s), num(r.v), num(r.c), num(r.o), Math.round(num(r.r))]),
      groups: await loadGroups(cabinet),
      freq: await loadFreq(cabinet),
    } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// Пороги частотности (искали за 30 дней): app_settings query_freq:<кабинет> = {hi, mid}.
async function loadFreq(cabinet) {
  const rows = await query(`SELECT value FROM app_settings WHERE key = $1`, [`query_freq:${cabinet}`]).catch(() => []);
  try { const v = JSON.parse(rows[0]?.value || 'null'); return v && v.hi > 0 && v.mid > 0 ? v : null; } catch (e) { return null; }
}
// POST /api/queries/freq {cabinet, hi, mid}
router.post('/freq', async (req, res) => {
  try {
    const { cabinet = 'defly' } = req.body || {};
    const hi = Math.round(Number(req.body?.hi)), mid = Math.round(Number(req.body?.mid));
    if (!(hi > 0 && mid > 0 && mid < hi)) return res.status(400).json({ success: false, error: 'Порог ВЧ должен быть больше порога СЧ' });
    await query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [`query_freq:${cabinet}`, JSON.stringify({ hi, mid })]);
    res.json({ success: true, data: { hi, mid } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/queries/groups {cabinet, query, group} — отнести запрос к группе
// вручную; group = null — вернуть автоматическую.
router.post('/groups', async (req, res) => {
  try {
    const { cabinet = 'defly', query: q, group } = req.body || {};
    if (!q || (group != null && !GROUP_KEYS.includes(group))) return res.status(400).json({ success: false, error: 'Нужны запрос и группа' });
    const g = await loadGroups(cabinet);
    if (group == null) delete g[q]; else g[String(q).slice(0, 200)] = group;
    await query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [`query_groups:${cabinet}`, JSON.stringify(g)]);
    res.json({ success: true, data: g });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/queries/season?cabinet= — продажи по месяцам: [ai, monthIdx, revenue, orders].
router.get('/season', async (req, res) => {
  try {
    await ensureFinTables();
    const cabinet = req.query.cabinet || 'defly';
    const m = await meta(cabinet);
    const rows = await query(`SELECT month, sku, revenue, orders FROM analytics_monthly WHERE cabinet = $1 ORDER BY month`, [cabinet]);
    const months = [...new Set(rows.map(r => r.month))].sort();
    const mi = new Map(months.map((x, i) => [x, i]));
    const out = [];
    const agg = new Map();
    for (const r of rows) {
      const o = m.offerBySku.get(String(r.sku)); if (!o) continue;
      const k = m.art(o) + '|' + mi.get(r.month);
      const a = agg.get(k) || [0, 0]; a[0] += num(r.revenue); a[1] += num(r.orders); agg.set(k, a);
    }
    for (const [k, [rv, o]] of agg) { const [ai, i] = k.split('|').map(Number); out.push([ai, i, Math.round(rv), o]); }
    res.json({ success: true, data: { articles: m.articles, order: ORDER[cabinet] || [], months, rows: out } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
