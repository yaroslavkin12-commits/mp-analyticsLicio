const express = require('express');
const router = express.Router();
const dayjs = require('dayjs');
const { query } = require('../db');
const { getSettings, setSettings } = require('../collectors/ads/discountSettings');

// Вынесено из /api/ads/* в отдельный роут /api/discounts/*: путь, содержащий
// подстроку "/ads/", у части пользователей режется блокировщиками рекламы
// (adblock-листы блокируют любой URL с "/ads" в пути) прямо на уровне
// браузера/сети — запрос до сервера не доходит и падает с 503/Network Error.
// Сам функционал (Соинвест-мониторинг) с рекламой не связан, поэтому вынесен
// на нейтральный путь.

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
        isEstimate: last ? last.source !== 'seller_cabinet' : false,
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
