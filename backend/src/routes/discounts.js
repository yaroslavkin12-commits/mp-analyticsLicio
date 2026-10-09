const express = require('express');
const router = express.Router();
const dayjs = require('dayjs');
const { query } = require('../db');
const { getSettings, setSettings } = require('../collectors/ads/discountSettings');
const { notifyDiscountChange, THRESHOLD } = require('../telegram');
const { autoPath } = require('../lib/categories');

// Вынесено из /api/ads/* в отдельный роут /api/discounts/*: путь, содержащий
// подстроку "/ads/", у части пользователей режется блокировщиками рекламы
// (adblock-листы блокируют любой URL с "/ads" в пути) прямо на уровне
// браузера/сети — запрос до сервера не доходит и падает с 503/Network Error.
// Сам функционал (Соинвест-мониторинг) с рекламой не связан, поэтому вынесен
// на нейтральный путь.

// ── Сбор Соинвеста через расширение браузера ────────────────────────────
// Цена на витрине с учётом Соинвеста есть только во внутреннем методе
// кабинета seller.ozon.ru (get-common-prices), а с серверов Ozon такие
// запросы режет антибот. Поэтому цены забирает маленькое расширение в
// браузере, где открыт кабинет: берёт отсюда список товаров (product_id),
// спрашивает цены у кабинета и присылает их сюда.
const COMPANY_IDS = {
  licio: process.env.LICIO_OZON_COMPANY_ID || process.env.OZON_COMPANY_ID || '2863427',
  defly: process.env.DEFLY_OZON_COMPANY_ID || '48694',
};
let latestReady = null;
function ensureLatest() {
  if (!latestReady) {
    latestReady = query(`CREATE TABLE IF NOT EXISTS product_discount_latest (
      cabinet VARCHAR(32) NOT NULL, offer_id VARCHAR(128) NOT NULL, product_id BIGINT,
      price DECIMAL(12,2), old_price DECIMAL(12,2), seller_price DECIMAL(12,2), site_price DECIMAL(12,2), card_price DECIMAL(12,2),
      pct DECIMAL(6,2), checked_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (cabinet, offer_id))`).catch(e => { latestReady = null; throw e; });
  }
  return latestReady;
}
async function productMap(cabinet) {
  // product_id лежит в снимках остатков (колонка sku) — берём самый свежий.
  const rows = await query(`SELECT DISTINCT ON (offer_id) offer_id, sku AS product_id FROM ad_product_stocks
                             WHERE cabinet = $1 AND platform = 'ozon' AND sku IS NOT NULL ORDER BY offer_id, snapshot_date DESC`, [cabinet]);
  return rows.filter(r => r.product_id);
}

// GET /api/discounts/targets — что спросить у кабинета: по каждому кабинету
// его company_id и список product_id.
router.get('/targets', async (req, res) => {
  try {
    const out = [];
    for (const cabinet of Object.keys(COMPANY_IDS)) {
      const items = await productMap(cabinet).catch(() => []);
      out.push({ cabinet, companyId: COMPANY_IDS[cabinet], productIds: items.map(r => String(r.product_id)) });
    }
    res.json({ success: true, data: out });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/discounts/ingest { cabinet, items: [ответ get-common-prices] }
router.post('/ingest', async (req, res) => {
  try {
    await ensureLatest();
    const { cabinet, items } = req.body || {};
    if (!COMPANY_IDS[cabinet] || !Array.isArray(items)) return res.status(400).json({ success: false, error: 'Нужны cabinet и items' });
    const map = await productMap(cabinet);
    const offerByProduct = new Map(map.map(r => [String(r.product_id), r.offer_id]));
    const prevRows = await query(`SELECT DISTINCT ON (offer_id) offer_id, ozon_discount_pct, source FROM product_discount_history
                                   WHERE cabinet = $1 AND platform = 'ozon' ORDER BY offer_id, collected_at DESC`, [cabinet]);
    const prev = new Map(prevRows.map(r => [r.offer_id, r]));
    const n = v => { const x = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(x) ? x : 0; };
    const now = new Date();
    const latest = [], hist = [], changed = [];
    let matched = 0;
    for (const it of items) {
      const pid = String(it.item_id ?? it.itemId ?? it.product_id ?? '');
      const offer = offerByProduct.get(pid);
      if (!offer) continue;
      matched++;
      const price = n(it.price), oldPrice = n(it.old_price ?? it.oldPrice);
      const seller = n(it.marketing_seller_price ?? it.marketingSellerPrice) || price;
      const site = n(it.marketing_price ?? it.marketingPrice) || seller;
      const card = n(it.marketing_oa_price ?? it.marketingOaPrice);
      const pct = seller > 0 ? Math.max(0, Math.round((seller - site) / seller * 10000) / 100) : 0;
      latest.push([cabinet, offer, Number(pid), price, oldPrice, seller, site, card, pct, now]);
      const p = prev.get(offer);
      const pp = p ? Number(p.ozon_discount_pct) : null;
      if (pp === null || p.source !== 'seller_cabinet' || Math.abs(pp - pct) >= 0.1) {
        hist.push([cabinet, 'ozon', offer, Number(pid), price, oldPrice, site, seller, card, pct, 'seller_cabinet', now]);
        if (pp !== null && p.source === 'seller_cabinet' && Math.abs(pp - pct) >= THRESHOLD) changed.push({ offerId: offer, prevPct: pp, pct, marketingPrice: site, price });
      }
    }
    for (let i = 0; i < latest.length; i += 500) {
      const part = latest.slice(i, i + 500);
      const params = [], vals = part.map(r => `(${r.map(v => { params.push(v); return '$' + params.length; }).join(',')})`);
      await query(`INSERT INTO product_discount_latest (cabinet, offer_id, product_id, price, old_price, seller_price, site_price, card_price, pct, checked_at)
                   VALUES ${vals.join(',')} ON CONFLICT (cabinet, offer_id) DO UPDATE SET product_id = EXCLUDED.product_id, price = EXCLUDED.price,
                   old_price = EXCLUDED.old_price, seller_price = EXCLUDED.seller_price, site_price = EXCLUDED.site_price,
                   card_price = EXCLUDED.card_price, pct = EXCLUDED.pct, checked_at = EXCLUDED.checked_at`, params);
    }
    for (let i = 0; i < hist.length; i += 500) {
      const part = hist.slice(i, i + 500);
      const params = [], vals = part.map(r => `(${r.map(v => { params.push(v); return '$' + params.length; }).join(',')})`);
      await query(`INSERT INTO product_discount_history (cabinet, platform, offer_id, product_id, price, old_price, marketing_price, marketing_seller_price,
                   marketing_oa_price, ozon_discount_pct, source, collected_at) VALUES ${vals.join(',')}`, params);
    }
    if (changed.length) await notifyDiscountChange(cabinet, changed).catch(e => console.warn('[Discounts] telegram:', e.message));
    console.log(`[Discounts:${cabinet}] из браузера: ${items.length} цен, сопоставлено ${matched}, изменений ${hist.length}`);
    res.json({ success: true, data: { received: items.length, matched, historyRows: hist.length, alerts: changed.length } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/discounts/overview?cabinet= — текущий Соинвест по всем
// товарам + категория, продажи за 30 дней (для взвешивания) и изменения.
router.get('/overview', async (req, res) => {
  try {
    await ensureLatest();
    const cabinet = req.query.cabinet || 'defly';
    const since30 = dayjs().subtract(30, 'day').format('YYYY-MM-DD');
    const [latest, catalog, overrides, sales, h1, h7] = await Promise.all([
      query(`SELECT * FROM product_discount_latest WHERE cabinet = $1`, [cabinet]),
      query(`SELECT offer_id, sku, product_name FROM ad_product_catalog WHERE cabinet = $1 AND platform = 'ozon'`, [cabinet]),
      query(`SELECT offer_id, path FROM product_category_override WHERE cabinet = $1`, [cabinet]).catch(() => []),
      query(`SELECT offer_id, sku, SUM(orders_item) o, SUM(revenue) r FROM product_analytics_daily WHERE cabinet = $1 AND platform = 'ozon' AND date >= $2 GROUP BY offer_id, sku`, [cabinet, since30]),
      query(`SELECT DISTINCT ON (offer_id) offer_id, ozon_discount_pct pct FROM product_discount_history
              WHERE cabinet = $1 AND source = 'seller_cabinet' AND collected_at <= NOW() - INTERVAL '24 hours' ORDER BY offer_id, collected_at DESC`, [cabinet]),
      query(`SELECT DISTINCT ON (offer_id) offer_id, ozon_discount_pct pct FROM product_discount_history
              WHERE cabinet = $1 AND source = 'seller_cabinet' AND collected_at <= NOW() - INTERVAL '7 days' ORDER BY offer_id, collected_at DESC`, [cabinet]),
    ]);
    const names = new Map(catalog.map(r => [r.offer_id, r.product_name || '']));
    const offerBySku = new Map(catalog.filter(r => r.sku != null).map(r => [String(r.sku), r.offer_id]));
    const ov = new Map(overrides.map(r => [r.offer_id, r.path]));
    const sale = new Map();
    for (const r of sales) { const o = r.offer_id || offerBySku.get(String(r.sku)); if (!o) continue; const x = sale.get(o) || { o: 0, r: 0 }; x.o += Number(r.o) || 0; x.r += Number(r.r) || 0; sale.set(o, x); }
    const d1 = new Map(h1.map(r => [r.offer_id, Number(r.pct)])), d7 = new Map(h7.map(r => [r.offer_id, Number(r.pct)]));
    const items = latest.map(r => {
      const n0 = names.get(r.offer_id) || '';
      const s = sale.get(r.offer_id) || { o: 0, r: 0 };
      return {
        o: r.offer_id, n: n0, cat: ov.get(r.offer_id) || autoPath(cabinet, n0, r.offer_id).join(' / '),
        seller: Number(r.seller_price), site: Number(r.site_price), card: Number(r.card_price), pct: Number(r.pct),
        d1: d1.has(r.offer_id) ? Math.round((Number(r.pct) - d1.get(r.offer_id)) * 100) / 100 : null,
        d7: d7.has(r.offer_id) ? Math.round((Number(r.pct) - d7.get(r.offer_id)) * 100) / 100 : null,
        orders30: s.o, revenue30: Math.round(s.r), checkedAt: r.checked_at,
      };
    });
    const last = latest.reduce((m, r) => (!m || new Date(r.checked_at) > m ? new Date(r.checked_at) : m), null);
    res.json({ success: true, data: { cabinet, items, lastCheckedAt: last } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'licio';
    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 30));
    const since = dayjs().subtract(days, 'day').toDate();

    const rows = await query(
      `SELECT h.offer_id, h.price, h.old_price, h.marketing_price, h.marketing_seller_price,
              h.marketing_oa_price, h.ozon_discount_pct, h.source, h.collected_at, c.product_name
         FROM product_discount_history h
         LEFT JOIN ad_product_catalog c
           ON c.cabinet = h.cabinet AND c.platform = h.platform AND c.offer_id = h.offer_id
        WHERE h.cabinet = $1 AND h.collected_at >= $2
        ORDER BY h.offer_id, h.collected_at ASC`,
      [cabinet, since]);

    const byOffer = new Map();
    for (const r of rows) {
      if (!byOffer.has(r.offer_id)) byOffer.set(r.offer_id, { offerId: r.offer_id, productName: r.product_name, history: [] });
      byOffer.get(r.offer_id).history.push({
        at: r.collected_at, price: Number(r.price), oldPrice: Number(r.old_price),
        marketingPrice: Number(r.marketing_price), sellerMarketingPrice: Number(r.marketing_seller_price),
        ozonCardPrice: Number(r.marketing_oa_price), pct: Number(r.ozon_discount_pct),
        source: r.source,
      });
    }

    const dayAgo = Date.now() - 24 * 3600 * 1000;
    const articles = [...byOffer.values()].map(a => {
      const last = a.history[a.history.length - 1];
      const dayAgoPoint = [...a.history].reverse().find(h => new Date(h.at).getTime() <= dayAgo) || a.history[0];
      const pcts = a.history.map(h => h.pct);
      return {
        offerId: a.offerId,
        productName: a.productName,
        current: last || null,
        isEstimate: last ? last.source !== 'public_page' : false,
        changes24h: last && dayAgoPoint ? Math.round((last.pct - dayAgoPoint.pct) * 100) / 100 : 0,
        minPct: pcts.length ? Math.min(...pcts) : 0,
        maxPct: pcts.length ? Math.max(...pcts) : 0,
        changesCount: a.history.length,
        history: a.history,
      };
    }).sort((x, y) => (y.current?.pct || 0) - (x.current?.pct || 0));

    res.json({ success: true, data: { cabinet, days, articles } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/ads/discounts/summary?cabinet=&days= — средняя скидка покупателя
// по дням за период (для графика над таблицей, как в СПП-мониторе TrueStats).
router.get('/summary', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'licio';
    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 7));
    const since = dayjs().subtract(days, 'day').toDate();

    // Для каждого артикула — последняя запись НА КАЖДЫЙ ДЕНЬ, затем среднее
    // по всем артикулам за день (не среднее по всем строкам — иначе товары
    // с более частыми изменениями перетягивали бы среднее на себя).
    const rows = await query(
      `SELECT DISTINCT ON (offer_id, day) offer_id, day, pct FROM (
         SELECT offer_id, ozon_discount_pct AS pct,
                to_char(collected_at, 'YYYY-MM-DD') AS day, collected_at
           FROM product_discount_history
          WHERE cabinet = $1 AND collected_at >= $2
       ) t
       ORDER BY offer_id, day, collected_at DESC`,
      [cabinet, since]);

    const byDay = new Map();
    for (const r of rows) {
      if (!byDay.has(r.day)) byDay.set(r.day, []);
      byDay.get(r.day).push(Number(r.pct));
    }
    const series = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, pcts]) => ({
        day,
        avgPct: Math.round((pcts.reduce((s, v) => s + v, 0) / pcts.length) * 10) / 10,
        articles: pcts.length,
      }));

    const totalRows = await query(
      `SELECT COUNT(DISTINCT offer_id)::int AS total FROM product_discount_history WHERE cabinet = $1`, [cabinet]);
    const changes24h = await query(
      `SELECT COUNT(*)::int AS n FROM product_discount_history WHERE cabinet = $1 AND collected_at >= NOW() - INTERVAL '24 hours'`,
      [cabinet]);

    res.json({ success: true, data: {
      cabinet, days, series,
      totalArticles: totalRows[0]?.total || 0,
      currentAvgPct: series.length ? series[series.length - 1].avgPct : 0,
      changes24h: changes24h[0]?.n || 0,
    }});
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/ads/discounts/feed?cabinet=&days=&limit= — хронологическая лента
// изменений по всем артикулам сразу (аналог вкладки "Уведомления" в
// СПП-мониторе TrueStats). Каждая строка в product_discount_history и так
// пишется только при реальном изменении, поэтому лента — это просто сама
// история с "было -> стало" внутри одного артикула.
router.get('/feed', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'licio';
    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 30));
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 200));
    const since = dayjs().subtract(days, 'day').toDate();

    const rows = await query(
      `SELECT h.offer_id, h.ozon_discount_pct AS pct, h.marketing_price, h.marketing_oa_price,
              h.collected_at, c.product_name,
              LAG(h.ozon_discount_pct) OVER (PARTITION BY h.offer_id ORDER BY h.collected_at) AS prev_pct
         FROM product_discount_history h
         LEFT JOIN ad_product_catalog c ON c.cabinet = h.cabinet AND c.platform = h.platform AND c.offer_id = h.offer_id
        WHERE h.cabinet = $1 AND h.collected_at >= $2
        ORDER BY h.collected_at DESC
        LIMIT $3`,
      [cabinet, since, limit]);

    const feed = rows
      .filter(r => r.prev_pct !== null) // первая запись артикула — не "изменение", а старт наблюдения
      .map(r => ({
        offerId: r.offer_id,
        productName: r.product_name,
        at: r.collected_at,
        prevPct: Number(r.prev_pct),
        pct: Number(r.ozon_discount_pct ?? r.pct),
        marketingPrice: Number(r.marketing_price),
        ozonCardPrice: Number(r.marketing_oa_price),
      }));

    res.json({ success: true, data: { cabinet, days, feed } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET/POST /api/ads/discounts/settings?cabinet= — настройки уведомлений
// Соинвеста: порог, тихие часы, ежедневный дайджест (см. discountSettings.js).
router.get('/settings', async (req, res) => {
  try {
    const cabinet = req.query.cabinet || 'licio';
    res.json({ success: true, data: await getSettings(cabinet) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/settings', async (req, res) => {
  try {
    const cabinet = req.body.cabinet || 'licio';
    const { thresholdPct, quietEnabled, quietStart, quietEnd, digestEnabled, digestTime, timezone } = req.body;
    const patch = {};
    if (thresholdPct !== undefined) patch.thresholdPct = Math.max(0.1, Math.min(50, Number(thresholdPct) || 1.5));
    if (quietEnabled !== undefined) patch.quietEnabled = !!quietEnabled;
    if (quietStart) patch.quietStart = quietStart;
    if (quietEnd) patch.quietEnd = quietEnd;
    if (digestEnabled !== undefined) patch.digestEnabled = !!digestEnabled;
    if (digestTime) patch.digestTime = digestTime;
    if (timezone) patch.timezone = timezone;
    res.json({ success: true, data: await setSettings(cabinet, patch) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
