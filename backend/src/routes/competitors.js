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
    const all = [...new Set([...ourSkus, ...comps.map(r => Number(r.sku))])];
    const [photos, market, serpQ] = all.length ? await Promise.all([
      query(`SELECT sku, photo FROM sku_photos WHERE cabinet = $1 AND sku = ANY($2::bigint[])`, [cabinet, all]),
      query(`SELECT sku, report_date::text d, window_days w, name, seller, brand, data FROM market_snapshot WHERE cabinet = $1 AND sku = ANY($2::bigint[]) ORDER BY report_date`, [cabinet, all]),
      // Запросы, по которым есть снимки выдачи с нашим товаром или конкурентом.
      query(`SELECT query, region, MAX(date)::text last, COUNT(DISTINCT date)::int n FROM serp_snapshot WHERE cabinet = $1 AND sku = ANY($2::bigint[]) GROUP BY query, region ORDER BY MAX(date) DESC, query`, [cabinet, all]),
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
      competitors: comps.map(r => ({ sku: String(r.sku), label: r.label || '', ...(names.get(String(r.sku)) || {}) })),
      photos: Object.fromEntries(photos.map(r => [String(r.sku), r.photo])),
      cards: cardOf,
      market: market.map(r => ({ sku: String(r.sku), date: r.d, window: Number(r.w), name: r.name, seller: r.seller, brand: r.brand, data: r.data || {} })),
      serpQueries: serpQ.map(r => ({ query: r.query, region: r.region, last: r.last, n: r.n })),
    } });
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

module.exports = router;
