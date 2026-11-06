const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { bulkUpsert } = require('../collectors/ads/ozonHttp');

// ─────────────────────────────────────────────────────────────────────────
// Конкуренты во «Позициях в поиске». Ozon не отдаёт данные о чужих товарах
// по API, поэтому всё приходит из отчётов кабинета, которые владелец
// загружает файлами (разбор — в браузере, сюда приходят готовые строки):
//  • «Аналитика → Товары на Ozon» — окно 7 или 28 дней: заказы, показы,
//    конверсии, доля рекламных расходов… → market_snapshot (снимок «окно
//    на дату отчёта»; по нашему товару — тот же отчёт для сравнения);
//  • «Результаты по запросу» — выдача по запросу в регионе: позиция,
//    ставки, стратегия, отзывы, цена… → serp_snapshot.
// Список конкурентов артикула — search_competitors, фото — sku_photos.
// ─────────────────────────────────────────────────────────────────────────

let ready = false;
async function ensure() {
  if (ready) return;
  await query(`CREATE TABLE IF NOT EXISTS search_competitors (cabinet VARCHAR(32) NOT NULL, offer_id VARCHAR(128) NOT NULL, sku BIGINT NOT NULL,
    label VARCHAR(120), created_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (cabinet, offer_id, sku))`);
  await query(`CREATE TABLE IF NOT EXISTS sku_photos (cabinet VARCHAR(32) NOT NULL, sku BIGINT NOT NULL, photo TEXT, updated_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (cabinet, sku))`);
  await query(`CREATE TABLE IF NOT EXISTS market_snapshot (cabinet VARCHAR(32) NOT NULL, sku BIGINT NOT NULL, report_date DATE NOT NULL, window_days INT NOT NULL,
    name VARCHAR(512), seller VARCHAR(200), brand VARCHAR(200), data JSONB, loaded_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (cabinet, sku, report_date, window_days))`);
  await query(`CREATE TABLE IF NOT EXISTS serp_snapshot (cabinet VARCHAR(32) NOT NULL, date DATE NOT NULL, region VARCHAR(80) NOT NULL, query VARCHAR(200) NOT NULL, sku BIGINT NOT NULL,
    position INT, total INT, name VARCHAR(512), seller VARCHAR(200), status VARCHAR(60), cpc DECIMAL(10,2), strategy VARCHAR(120), cpo VARCHAR(40),
    relevance DECIMAL(8,2), rating DECIMAL(4,2), reviews INT, price DECIMAL(12,2), popularity DECIMAL(8,2), promo VARCHAR(20), delivery VARCHAR(40),
    PRIMARY KEY (cabinet, date, region, query, sku))`);
  // Карточки с витрины Ozon (фото, название, цена, рейтинг) — их собирает
  // браузерное расширение раз в несколько часов; по дню — последнее значение.
  await query(`CREATE TABLE IF NOT EXISTS sku_cards (sku BIGINT NOT NULL, date DATE NOT NULL, photo TEXT, title VARCHAR(512), price DECIMAL(12,2), card_price DECIMAL(12,2),
    rating DECIMAL(4,2), reviews INT, checked_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (sku, date))`);
  ready = true;
}
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const numOrNull = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const cut = (v, n) => (v == null ? null : String(v).slice(0, n));

// GET /api/competitors?cabinet=&offerId= — всё для вкладки «Конкуренты» артикула.
router.get('/', async (req, res) => {
  try {
    await ensure();
    const cabinet = req.query.cabinet || 'defly';
    const offerId = String(req.query.offerId || '');
    const cat = await query(`SELECT sku, product_name FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon' AND offer_id = $2 AND sku IS NOT NULL`, [cabinet, offerId]);
    const ourSkus = cat.map(r => Number(r.sku));
    const comps = await query(`SELECT sku, label, created_at FROM search_competitors WHERE cabinet = $1 AND offer_id = $2 ORDER BY created_at`, [cabinet, offerId]);
    // «Конкурент», который на самом деле наш товар (другая наша карточка) — помечаем.
    const ownComp = comps.length ? new Set((await query(`SELECT sku FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon' AND sku = ANY($2::bigint[])`, [cabinet, comps.map(r => String(r.sku))])).map(r => String(r.sku))) : new Set();
    const all = [...new Set([...ourSkus, ...comps.map(r => Number(r.sku))])];
    const [photos, market, serpQ] = all.length ? await Promise.all([
      query(`SELECT sku, photo FROM sku_photos WHERE cabinet = $1 AND sku = ANY($2::bigint[])`, [cabinet, all]),
      query(`SELECT sku, report_date::text d, window_days w, name, seller, brand, data FROM market_snapshot WHERE cabinet = $1 AND sku = ANY($2::bigint[]) ORDER BY report_date`, [cabinet, all]),
      // Запросы, по которым есть снимки выдачи с нашим товаром или конкурентом.
      // Все загруженные выдачи магазина (раньше — только где есть наши SKU или
      // конкуренты: из-за этого выдача «пропадала», если товара в ней не было).
      query(`SELECT query, region, MAX(date)::text last, COUNT(DISTINCT date)::int n FROM serp_snapshot WHERE cabinet = $1 GROUP BY query, region ORDER BY MAX(date) DESC, query LIMIT 300`, [cabinet]),
    ]) : [[], [], []];
    const cards = all.length ? await query(`SELECT sku, date::text d, photo, title, price, card_price, rating, reviews, checked_at FROM sku_cards WHERE sku = ANY($1::bigint[]) ORDER BY sku, date`, [all]) : [];
    const cardOf = {};
    for (const c of cards) {
      const k = String(c.sku), prev = cardOf[k];
      // Дата смены главного фото — первый день, когда пришло новое фото.
      const changed = prev && prev.photo && c.photo && prev.photo !== c.photo ? c.d : prev?.photoChanged || null;
      cardOf[k] = { photo: c.photo, title: c.title, price: numOrNull(c.price), cardPrice: numOrNull(c.card_price), rating: numOrNull(c.rating), reviews: c.reviews, date: c.d, checkedAt: c.checked_at, photoChanged: changed };
    }
    const names = new Map();
    if (all.length) {
      const sn = await query(`SELECT DISTINCT ON (sku) sku, name, seller FROM serp_snapshot WHERE cabinet = $1 AND sku = ANY($2::bigint[]) ORDER BY sku, date DESC`, [cabinet, all]);
      for (const r of sn) names.set(String(r.sku), { name: r.name, seller: r.seller });
    }
    for (const m of market) if (m.name) names.set(String(m.sku), { name: m.name, seller: m.seller });
    res.json({ success: true, data: {
      our: ourSkus.map(s => ({ sku: String(s), name: cat.find(r => Number(r.sku) === s)?.product_name || '' })),
      competitors: comps.map(r => ({ sku: String(r.sku), label: r.label || '', ours: ownComp.has(String(r.sku)), ...(names.get(String(r.sku)) || {}) })),
      view: await loadView(cabinet, offerId),
      photos: Object.fromEntries(photos.map(r => [String(r.sku), r.photo])),
      cards: cardOf,
      market: market.map(r => ({ sku: String(r.sku), date: r.d, window: Number(r.w), name: r.name, seller: r.seller, brand: r.brand,
        data: r.data && r.data._raw ? { ...mapMarketRaw(r.data._raw), _src: 'ext', _keys: Object.keys(r.data._raw) } : (r.data || {}) })),
      serpQueries: serpQ.map(r => ({ query: r.query, region: r.region, last: r.last, n: r.n })),
    } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// Подписи строк и их порядок в сравнении: app_settings comp_view:<кабинет>:<артикул> = {labels: {sku: подпись}, order: [sku…]}.
async function loadView(cabinet, offerId) {
  const rows = await query(`SELECT value FROM app_settings WHERE key = $1`, [`comp_view:${cabinet}:${offerId}`]).catch(() => []);
  try { const v = JSON.parse(rows[0]?.value || '{}') || {}; return { labels: v.labels || {}, order: Array.isArray(v.order) ? v.order : [] }; } catch (e) { return { labels: {}, order: [] }; }
}
// POST /api/competitors/view {cabinet, offerId, label?: {sku, text}, order?: [sku…]}
router.post('/view', async (req, res) => {
  try {
    const { cabinet = 'defly', offerId, label, order } = req.body || {};
    if (!offerId) return res.status(400).json({ success: false, error: 'Нет артикула' });
    const v = await loadView(cabinet, String(offerId));
    if (label && /^\d{1,15}$/.test(String(label.sku || ''))) {
      const t = String(label.text || '').trim().slice(0, 60);
      if (t) v.labels[String(label.sku)] = t; else delete v.labels[String(label.sku)];
    }
    if (Array.isArray(order)) v.order = order.map(String).filter(x => /^\d{1,15}$/.test(x)).slice(0, 200);
    await query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [`comp_view:${cabinet}:${offerId}`, JSON.stringify(v)]);
    res.json({ success: true, data: v });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/competitors/serp?cabinet=&query=&region= — снимки выдачи по запросу (все даты).
router.get('/serp', async (req, res) => {
  try {
    await ensure();
    const cabinet = req.query.cabinet || 'defly';
    const rows = await query(`SELECT date::text d, sku, position, total, name, seller, status, cpc, strategy, cpo, relevance, rating, reviews, price, popularity, promo, delivery
      FROM serp_snapshot WHERE cabinet = $1 AND query = $2 AND region = $3 ORDER BY date, position NULLS LAST`, [cabinet, String(req.query.query || ''), String(req.query.region || '')]);
    res.json({ success: true, data: rows.map(r => ({ ...r, sku: String(r.sku), cpc: numOrNull(r.cpc), relevance: numOrNull(r.relevance), rating: numOrNull(r.rating), price: numOrNull(r.price), popularity: numOrNull(r.popularity) })) });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/competitors {cabinet, offerId, sku, label} — добавить или переименовать конкурента.
router.post('/', async (req, res) => {
  try {
    await ensure();
    const { cabinet = 'defly', offerId, label } = req.body || {};
    const sku = String(req.body?.sku || '').replace(/\D/g, '');
    if (!offerId || !sku || sku.length > 15) return res.status(400).json({ success: false, error: 'Укажите артикул Ozon (SKU) конкурента — только цифры' });
    await query(`INSERT INTO search_competitors (cabinet, offer_id, sku, label) VALUES ($1, $2, $3, $4)
      ON CONFLICT (cabinet, offer_id, sku) DO UPDATE SET label = EXCLUDED.label`, [cabinet, String(offerId), sku, cut(label, 120) || null]);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// DELETE /api/competitors?cabinet=&offerId=&sku= — убрать конкурента (загруженные отчёты остаются).
router.delete('/', async (req, res) => {
  try {
    await ensure();
    await query(`DELETE FROM search_competitors WHERE cabinet = $1 AND offer_id = $2 AND sku = $3`, [req.query.cabinet || 'defly', String(req.query.offerId || ''), String(req.query.sku || '').replace(/\D/g, '') || '0']);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/competitors/skus — для браузерного расширения: SKU конкурентов и
// наших товаров, у которых есть конкуренты (во всех магазинах).
router.get('/skus', async (req, res) => {
  try {
    await ensure();
    const rows = await query(`SELECT DISTINCT sku FROM search_competitors
      UNION SELECT DISTINCT c.sku FROM ad_product_catalog c JOIN search_competitors s ON s.cabinet = c.cabinet AND s.offer_id = c.offer_id WHERE c.platform = 'ozon' AND c.sku IS NOT NULL`);
    res.json({ success: true, data: rows.map(r => String(r.sku)) });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/competitors/cards {cards: [{sku, photo, title, price, cardPrice, rating, reviews}]} — от расширения.
const priceNum = v => { const t = String(v ?? '').replace(/[^\d,.]/g, '').replace(',', '.'); return t ? numOrNull(t) : null; };
router.post('/cards', async (req, res) => {
  try {
    await ensure();
    const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
    const list = (Array.isArray(req.body?.cards) ? req.body.cards : []).slice(0, 2000)
      .filter(c => /^\d{5,15}$/.test(String(c.sku || '')) && (c.photo || c.title || c.price))
      .map(c => [String(c.sku), date, /^https:\/\/[^\s"'<>]{8,600}$/.test(String(c.photo || '')) ? String(c.photo) : null, cut(c.title, 512),
        priceNum(c.price), priceNum(c.cardPrice), numOrNull(String(c.rating ?? '').replace(',', '.')), numOrNull(String(c.reviews ?? '').replace(/\D/g, '')), new Date()]);
    const n = list.length ? await bulkUpsert('sku_cards', ['sku', 'date', 'photo', 'title', 'price', 'card_price', 'rating', 'reviews', 'checked_at'], list, ['sku', 'date']) : 0;
    res.json({ success: true, data: { saved: n } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/competitors/photo {cabinet, sku, photo} — уменьшенная картинка (data:image/…) или ссылка; пусто — удалить.
router.post('/photo', async (req, res) => {
  try {
    await ensure();
    const { cabinet = 'defly', photo } = req.body || {};
    const sku = String(req.body?.sku || '').replace(/\D/g, '');
    if (!sku) return res.status(400).json({ success: false, error: 'Нет SKU' });
    if (!photo) { await query(`DELETE FROM sku_photos WHERE cabinet = $1 AND sku = $2`, [cabinet, sku]); return res.json({ success: true }); }
    const p = String(photo);
    if (!(/^data:image\/(jpeg|png|webp);base64,/.test(p) || /^https:\/\//.test(p)) || p.length > 400000) return res.status(400).json({ success: false, error: 'Нужна картинка (до ~300 КБ) или ссылка https://' });
    await query(`INSERT INTO sku_photos (cabinet, sku, photo, updated_at) VALUES ($1, $2, $3, NOW())
      ON CONFLICT (cabinet, sku) DO UPDATE SET photo = EXCLUDED.photo, updated_at = NOW()`, [cabinet, sku, p]);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/competitors/import {cabinet, kind: 'market'|'serp', ...} — строки разобранного отчёта.
//  market: {date, window, rows: [{sku, name, seller, brand, data}]}
//  serp:   {date, region, query, total, rows: [{sku, position, name, seller, status, cpc, strategy, cpo, relevance, rating, reviews, price, popularity, promo, delivery}]}
router.post('/import', async (req, res) => {
  try {
    await ensure();
    const b = req.body || {};
    const cabinet = b.cabinet || 'defly';
    if (!isDate(b.date)) return res.status(400).json({ success: false, error: 'Не удалось определить дату отчёта' });
    const rows = Array.isArray(b.rows) ? b.rows.filter(r => /^\d{1,15}$/.test(String(r.sku || ''))) : [];
    if (!rows.length) return res.status(400).json({ success: false, error: 'В отчёте нет товаров' });
    let n = 0;
    if (b.kind === 'market') {
      const w = Number(b.window);
      if (![7, 14, 28, 30].includes(w)) return res.status(400).json({ success: false, error: 'Не удалось определить период отчёта (7 или 28 дней)' });
      n = await bulkUpsert('market_snapshot', ['cabinet', 'sku', 'report_date', 'window_days', 'name', 'seller', 'brand', 'data', 'loaded_at'],
        rows.map(r => [cabinet, String(r.sku), b.date, w, cut(r.name, 512), cut(r.seller, 200), cut(r.brand, 200), JSON.stringify(r.data || {}), new Date()]),
        ['cabinet', 'sku', 'report_date', 'window_days']);
    } else if (b.kind === 'serp') {
      const q = cut(String(b.query || '').trim(), 200), region = cut(String(b.region || '').trim() || '—', 80);
      if (!q) return res.status(400).json({ success: false, error: 'В отчёте не найден запрос' });
      n = await bulkUpsert('serp_snapshot', ['cabinet', 'date', 'region', 'query', 'sku', 'position', 'total', 'name', 'seller', 'status', 'cpc', 'strategy', 'cpo', 'relevance', 'rating', 'reviews', 'price', 'popularity', 'promo', 'delivery'],
        rows.map(r => [cabinet, b.date, region, q, String(r.sku), numOrNull(r.position), numOrNull(b.total), cut(r.name, 512), cut(r.seller, 200), cut(r.status, 60), numOrNull(r.cpc), cut(r.strategy, 120), cut(r.cpo, 40),
          numOrNull(r.relevance), numOrNull(r.rating), numOrNull(r.reviews), numOrNull(r.price), numOrNull(r.popularity), cut(r.promo, 20), cut(r.delivery, 40)]),
        ['cabinet', 'date', 'region', 'query', 'sku']);
    } else return res.status(400).json({ success: false, error: 'Неизвестный тип отчёта' });
    res.json({ success: true, data: { rows: n } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// ── Автосбор расширением: выдача по отслеживаемым запросам и «Товары на Ozon» ──
// Регионы — как в кабинете Ozon («Видимость в поиске → Что влияет на место»).
const REGIONS = [
  ['Москва', '0c5b2444-70a0-4932-980c-b4dc0d3f02b5', 55.728138, 37.425808],
  ['Санкт-Петербург', 'c2deb16a-0330-4f05-821f-1d09c93331e6', 59.939095, 30.315868],
  ['Екатеринбург, Свердловская область', '2763c110-cb8b-416a-9dac-ad28a55b4402', 56.838013, 60.597466],
  ['Пермь, Пермский Край', 'a309e4ce-2f36-4106-b1ca-53e0f48a6d95', 58.010258, 56.234203],
  ['Новосибирск, Новосибирская область', '8dea00e3-9aab-4d8e-887c-ef2aaa546456', 55.030197, 82.920433],
  ['Казань, Татарстан республика', '93b3df57-4c89-44df-ac42-96f05e9cd3b9', 55.796288, 49.108795],
  ['Челябинск, Челябинская область', 'a376e68d-724a-4472-be7c-891bdb09ae32', 55.160263, 61.400806],
  ['Краснодар, Краснодарский Край', '7dfa745e-aa19-4688-b121-b655c11e482f', 45.035469, 38.975311],
  ['Самара, Самарская область', 'bb035cc3-1dc2-4627-9d25-a1bf2d4b936b', 53.195538, 50.101784],
].map(([title, uuid, latitude, longitude]) => ({ title, uuid, latitude, longitude, areaId: '0', fullAddress: false }));
const shortRegion = t => String(t || '').split(',')[0];
const mskDate = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
async function getSetting(key, def) {
  const rows = await query(`SELECT value FROM app_settings WHERE key = $1`, [key]).catch(() => []);
  try { return rows[0] ? JSON.parse(rows[0].value) : def; } catch (e) { return def; }
}
const setSetting = (key, v) => query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(v)]);

// GET /api/competitors/tracking?cabinet=&offerId= — отслеживаемые запросы артикула и регионы магазина.
router.get('/tracking', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'defly';
    res.json({ success: true, data: {
      queries: await getSetting(`serp_track:${cabinet}:${req.query.offerId || ''}`, []),
      regions: await getSetting(`serp_regions:${cabinet}`, ['Москва']),
      allRegions: REGIONS.map(r => shortRegion(r.title)),
    } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
// POST /api/competitors/tracking {cabinet, offerId, query, on} | {cabinet, regions: [...]}
router.post('/tracking', async (req, res) => {
  try {
    const { cabinet = 'defly', offerId, query: q, on, regions } = req.body || {};
    if (Array.isArray(regions)) {
      const ok = regions.map(String).filter(r => REGIONS.some(x => shortRegion(x.title) === r));
      await setSetting(`serp_regions:${cabinet}`, ok.length ? ok : ['Москва']);
    }
    if (offerId && q) {
      const key = `serp_track:${cabinet}:${offerId}`;
      const list = (await getSetting(key, [])).filter(x => x !== q);
      if (on) list.push(String(q).slice(0, 200));
      await setSetting(key, list.slice(0, 50));
      // Отслеживаемые артикулы — чтобы расширение знало, где искать.
      const idx = await getSetting(`serp_track_offers:${cabinet}`, []);
      const next = idx.filter(o => o !== offerId); if (list.length) next.push(offerId);
      await setSetting(`serp_track_offers:${cabinet}`, next);
    }
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/competitors/agent-tasks — что собрать расширению: выдача (запрос × регион) и
// «Товары на Ozon» (SKU конкурентов и наших товаров, у которых они есть).
router.get('/agent-tasks', async (req, res) => {
  try {
    await ensure();
    const ids = await require('./discounts').companyIds();
    const serp = [], market = [];
    for (const [cabinet, companyId] of Object.entries(ids)) {
      const regions = (await getSetting(`serp_regions:${cabinet}`, ['Москва'])).map(r => REGIONS.find(x => shortRegion(x.title) === r)).filter(Boolean);
      for (const offerId of await getSetting(`serp_track_offers:${cabinet}`, [])) {
        const qs = await getSetting(`serp_track:${cabinet}:${offerId}`, []);
        if (!qs.length) continue;
        const skus = (await query(`SELECT sku FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon' AND offer_id = $2 AND sku IS NOT NULL`, [cabinet, offerId])).map(r => String(r.sku));
        for (const q of qs) serp.push({ cabinet, companyId, offerId, query: q, skus, regions });
      }
      const rows = await query(`SELECT DISTINCT sku FROM search_competitors WHERE cabinet = $1
        UNION SELECT DISTINCT c.sku FROM ad_product_catalog c JOIN search_competitors s ON s.cabinet = c.cabinet AND s.offer_id = c.offer_id WHERE c.cabinet = $1 AND c.platform = 'ozon' AND c.sku IS NOT NULL`, [cabinet]);
      if (rows.length) market.push({ cabinet, companyId, skus: rows.map(r => String(r.sku)) });
    }
    res.json({ success: true, data: { serp, market, serpEveryHours: 4, marketHour: 10, date: mskDate() } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/competitors/agent/serp {cabinet, query, region, total, rows: [...]} — выдача от расширения.
router.post('/agent/serp', async (req, res) => {
  try {
    await ensure();
    const b = req.body || {};
    const rows = (Array.isArray(b.rows) ? b.rows : []).filter(r => /^\d{1,15}$/.test(String(r.sku || '')));
    if (!b.query) return res.status(400).json({ success: false, error: 'Нет запроса' });
    // Пустая выдача (по запросу в регионе ничего не нашлось) — не ошибка: просто нечего сохранять.
    if (!rows.length) return res.json({ success: true, data: { rows: 0, empty: true } });
    const date = mskDate(), cabinet = b.cabinet || 'defly', region = cut(shortRegion(b.region) || '—', 80), q = cut(String(b.query).trim(), 200);
    const n = await bulkUpsert('serp_snapshot', ['cabinet', 'date', 'region', 'query', 'sku', 'position', 'total', 'name', 'seller', 'status', 'cpc', 'strategy', 'cpo', 'relevance', 'rating', 'reviews', 'price', 'popularity', 'promo', 'delivery'],
      rows.map(r => [cabinet, date, region, q, String(r.sku), numOrNull(r.position), numOrNull(b.total), cut(r.name, 512), cut(r.seller, 200), cut(r.status, 60), numOrNull(r.cpc), cut(r.strategy, 120), cut(r.cpo, 40),
        numOrNull(r.relevance), numOrNull(r.rating), numOrNull(r.reviews), numOrNull(r.price), numOrNull(r.popularity), cut(r.promo, 20), cut(r.delivery, 40)]),
      ['cabinet', 'date', 'region', 'query', 'sku']);
    // Фото из выдачи — заодно в карточки (если расширение их ещё не собирало сегодня).
    const ph = rows.filter(r => /^https:\/\//.test(String(r.photo || ''))).map(r => [String(r.sku), date, String(r.photo).slice(0, 600), cut(r.name, 512), numOrNull(r.price), new Date()]);
    if (ph.length) await query(`INSERT INTO sku_cards (sku, date, photo, title, price, checked_at) SELECT * FROM UNNEST($1::bigint[], $2::date[], $3::text[], $4::varchar[], $5::numeric[], $6::timestamp[]) ON CONFLICT (sku, date) DO NOTHING`,
      [ph.map(r => r[0]), ph.map(r => r[1]), ph.map(r => r[2]), ph.map(r => r[3]), ph.map(r => r[4]), ph.map(r => r[5])]).catch(e => console.error('serp photos', e.message));
    res.json({ success: true, data: { rows: n } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// «Товары на Ozon» из внутреннего метода кабинета → наши ключи. Сырой ответ
// хранится целиком (data._raw), поэтому сопоставление можно уточнить позже.
const pickRaw = (o, keys) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return numOrNull(o[k]); return null; };
function mapMarketRaw(o) {
  return {
    rev: pickRaw(o, ['gmvSum', 'soldSum']), qty: pickRaw(o, ['soldCount', 'ordersCount']), avgPrice: pickRaw(o, ['avgPrice', 'avgGmv']), minPrice: pickRaw(o, ['minSellerPrice']),
    revDyn: pickRaw(o, ['salesDynamics']), stock: pickRaw(o, ['stock']), lost: pickRaw(o, ['sumMissedGmv']),
    views: pickRaw(o, ['qtyView', 'qtyViews', 'viewsCount', 'hitsView', 'showsCount', 'sumView', 'impressions']),
    searchViews: pickRaw(o, ['qtyViewSearch', 'qtyViewSearchCatalog', 'searchViews', 'hitsViewSearch', 'viewsSearchCatalog']),
    pdp: pickRaw(o, ['qtyViewPdp', 'sessionCount', 'hitsViewPdp']), cartPdp: pickRaw(o, ['pdpToCartConversion', 'convToCartPdp']), cartSearch: pickRaw(o, ['convToCart', 'convToCartSearch']),
    convOrder: pickRaw(o, ['convViewToOrder', 'convToOrder', 'conversionViewToOrder', 'viewToOrderConversion']),
    drr: pickRaw(o, ['drr', 'adsShare', 'advShare', 'promotionShare', 'adRevenueShare', 'advertisingCostShare']),
    buyout: pickRaw(o, ['buyoutPercent', 'redemptionPercent', 'buyoutShare', 'redemptionRate']),
  };
}
router.mapMarketRaw = mapMarketRaw;
// POST /api/competitors/agent/market {cabinet, window, items: [ответ кабинета]}
router.post('/agent/market', async (req, res) => {
  try {
    await ensure();
    const b = req.body || {};
    const w = Number(b.window) === 28 ? 28 : 7;
    const items = (Array.isArray(b.items) ? b.items : []).filter(x => /^\d{1,15}$/.test(String(x.sku || ''))).slice(0, 500);
    // empty — SKU, по которым Ozon вернул пустую строку: заказов за окно не было.
    const empty = (Array.isArray(b.empty) ? b.empty : []).map(String).filter(x => /^\d{1,15}$/.test(x) && !items.some(o => String(o.sku) === x)).slice(0, 500);
    if (!items.length && !empty.length) return res.status(400).json({ success: false, error: 'Пусто' });
    const date = mskDate();
    const n = await bulkUpsert('market_snapshot', ['cabinet', 'sku', 'report_date', 'window_days', 'name', 'seller', 'brand', 'data', 'loaded_at'],
      [...items.map(o => [b.cabinet || 'defly', String(o.sku), date, w, cut(o.name || o.skuName, 512), cut(o.sellerName || o.seller || o.brand, 200), cut(o.brand, 200), JSON.stringify({ ...mapMarketRaw(o), _raw: o, _src: 'ext' }), new Date()]),
       ...empty.map(sku => [b.cabinet || 'defly', sku, date, w, null, null, null, JSON.stringify({ rev: 0, qty: 0, _empty: true, _src: 'ext' }), new Date()])],
      ['cabinet', 'sku', 'report_date', 'window_days']);
    res.json({ success: true, data: { rows: n } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
