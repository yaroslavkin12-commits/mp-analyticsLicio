const dayjs = require('dayjs');
const { createHash } = require('crypto');
const { query } = require('../db');
const { listCabinets } = require('../config/cabinets');
const { autoPath, OV_SQL, overrideArgs } = require('./categories');
let cached, pending;
const shops = () => listCabinets().filter(c => c.family === 'defly' && c.platform === 'ozon').map(c => ({ id: c.id, label: c.label, platform: 'ozon' }));
async function catalog2d() {
  const cabinets = shops();
  const [catalog, overrides, wbData] = await Promise.all([
    query(`SELECT cabinet, offer_id, sku, product_name FROM ad_product_catalog WHERE cabinet = ANY($1::text[]) AND platform = 'ozon' ORDER BY updated_at DESC NULLS LAST, cabinet, offer_id`, [cabinets.map(c => c.id)]),
    query(OV_SQL, overrideArgs('defly')),
    listCabinets().some(c => c.id === 'defly_wb' && c.connected) ? require('./wbBridge').read() : Promise.resolve([]),
  ]);
  const paths = new Map(overrides.map(r => [r.offer_id, r.path]));
  const selected = catalog.filter(r => (paths.get(r.offer_id) || autoPath('defly', r.product_name, r.offer_id).join(' / ')).split(' / ').includes('2D'));
  const unique = new Map();
  for (const r of selected) if (!unique.has(r.offer_id.toLowerCase())) unique.set(r.offer_id.toLowerCase(), { offer: r.offer_id, name: r.product_name || '' });
  const wbCatalog = wbData.find(d => d.kind === 'catalog')?.rows || [];
  for (const r of wbCatalog) if (r.offer && autoPath('defly', r.name, r.offer).includes('2D') && !unique.has(r.offer.toLowerCase())) unique.set(r.offer.toLowerCase(), { offer: r.offer, name: r.name || '' });
  return { cabinets, catalog, wbData, articles: [...unique.values()].sort((a, b) => a.offer.localeCompare(b.offer, 'ru')) };
}
async function collect() {
  const { buildOzonDemand } = await import('../../../dashboard/src/lib/deflectors2d.mjs');
  const { cabinets, catalog, articles, wbData } = await catalog2d();
  const to = dayjs(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date())).subtract(1, 'day').format('YYYY-MM-DD');
  const from = dayjs(to).subtract(1, 'year').subtract(29, 'day').format('YYYY-MM-DD');
  const ids = cabinets.map(c => c.id), offers = articles.map(a => a.offer);
  const keys = new Set(offers.map(o => o.toLowerCase()));
  const relevant = catalog.filter(c => keys.has(c.offer_id.toLowerCase()));
  const skus = [...new Set(relevant.filter(c => c.sku != null).map(c => String(c.sku)))];
  const [sales, coverage, self] = await Promise.all([
    query(`SELECT cabinet, date::text date, sku, offer_id, orders_item FROM product_analytics_daily WHERE cabinet = ANY($1::text[]) AND platform = 'ozon' AND date BETWEEN $2 AND $3 AND (offer_id = ANY($4::text[]) OR sku = ANY($5::bigint[])) ORDER BY cabinet, date, sku`, [ids, from, to, relevant.map(c => c.offer_id), skus]),
    query(`SELECT cabinet, date::text date FROM product_analytics_daily WHERE cabinet = ANY($1::text[]) AND platform = 'ozon' AND date BETWEEN $2 AND $3 GROUP BY cabinet, date`, [ids, from, to]),
    query(`SELECT cabinet, sku, order_date::text date, SUM(qty)::int qty FROM self_buyouts WHERE cabinet = ANY($1::text[]) AND order_date BETWEEN $2 AND $3 GROUP BY cabinet, sku, order_date`, [ids, from, to]),
  ]);
  const skuOffer = new Map();
  for (const c of relevant) if (!skuOffer.has(`${c.cabinet}|${c.sku}`)) skuOffer.set(`${c.cabinet}|${c.sku}`, c.offer_id);
  const remaining = new Map(self.map(r => [`${r.cabinet}|${r.sku}|${r.date}`, Number(r.qty)]));
  for (const r of sales) {
    r.offer_id = r.offer_id || skuOffer.get(`${r.cabinet}|${r.sku}`);
    const key = `${r.cabinet}|${r.sku}|${r.date}`, q = Math.max(0, Number(r.orders_item) || 0), take = Math.min(q, remaining.get(key) || 0);
    r.orders_item = q - take; remaining.set(key, (remaining.get(key) || 0) - take);
  }
  const wbOrders = wbData.find(d => d.kind === 'orders');
  if (wbOrders) {
    cabinets.push({ id: 'defly_wb', label: 'Defly WB', platform: 'wb' });
    const wbCatalog = new Map((wbData.find(d => d.kind === 'catalog')?.rows || []).map(r => [String(r.nmId), r.offer]));
    for (const r of wbOrders.rows) if (!r.cancelled) sales.push({ cabinet: 'defly_wb', date: r.date, offer_id: r.offer || wbCatalog.get(String(r.nmId)), orders_item: 1 });
    for (let d = dayjs(wbOrders.meta.from > from ? wbOrders.meta.from : from); d.format('YYYY-MM-DD') <= to && d.format('YYYY-MM-DD') <= wbOrders.meta.to; d = d.add(1, 'day')) coverage.push({ cabinet: 'defly_wb', date: d.format('YYYY-MM-DD') });
  }
  const data = buildOzonDemand({ to, articles, shops: cabinets, sales, coverage });
  data.version = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  data.loadedAt = new Date().toISOString();
  return data;
}
async function demand2d(refresh = false) {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
  if (!refresh && cached && Date.now() - cached.at < 60000 && cached.today === today) return cached.data;
  if (!pending) pending = collect().then(data => { cached = { at: Date.now(), today, data }; return data; }).finally(() => { pending = null; });
  return pending;
}
module.exports = { catalog2d, demand2d };
