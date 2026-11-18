const dayjs = require('dayjs');
const { createHash } = require('crypto');
const { query } = require('../db');
const { listCabinets } = require('../config/cabinets');
const { autoPath, OV_SQL, overrideArgs } = require('./categories');
const groups = require('../../../dashboard/src/lib/deflectorGroups.json');
const cached = new Map(), pending = new Map();
const inGroup = (path, group) => path === groups[group].path || path.startsWith(groups[group].path + ' / ');
const shops = () => listCabinets().filter(c => c.family === 'defly' && c.platform === 'ozon').map(c => ({ id: c.id, label: c.label, platform: 'ozon' }));
async function catalogFor(group) {
  const cabinets = shops();
  const [catalog, overrides, wbData] = await Promise.all([
    query(`SELECT cabinet, offer_id, sku, product_name FROM ad_product_catalog WHERE cabinet = ANY($1::text[]) AND platform = 'ozon' ORDER BY updated_at DESC NULLS LAST, cabinet, offer_id`, [cabinets.map(c => c.id)]),
    query(OV_SQL, overrideArgs('defly')),
    listCabinets().some(c => c.id === 'defly_wb' && c.connected) ? require('./wbBridge').read({excludeFinance:true}) : Promise.resolve([]),
  ]);
  const paths = new Map(overrides.map(r => [r.offer_id, r.path]));
  const unique = new Map();
  const remember = (offer, name, path) => {
    const key = offer.toLowerCase();
    if (!unique.has(key)) unique.set(key, { offer, name: name || '', path });
  };
  for (const r of catalog) {
    remember(r.offer_id, r.product_name, paths.get(r.offer_id) || autoPath('defly', r.product_name, r.offer_id).join(' / '));
  }
  const wbCatalog = wbData.find(d => d.kind === 'catalog')?.rows || [];
  const wbPrefs = wbCatalog.length || wbData.some(d => d.kind === 'orders') ? await require('./wbViews').preferences() : null;
  for (const r of wbCatalog) {
    if (r.offer) remember(r.offer, r.name, wbPrefs.categories[r.offer] || paths.get(r.offer) || autoPath('defly', r.name, r.offer).join(' / '));
  }
  const articles = [...unique.values()].filter(a => inGroup(a.path, group))
    .map(({ offer, name }) => ({ offer, name }))
    .sort((a, b) => a.offer.localeCompare(b.offer, 'ru'));
  return { cabinets, catalog, wbData, wbPrefs, articles };
}
async function collect(group) {
  const { buildOzonDemand } = await import('../../../dashboard/src/lib/deflectors2d.mjs');
  const { cabinets, catalog, articles, wbData, wbPrefs } = await catalogFor(group);
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
    for (const r of wbOrders.rows) if (!r.cancelled && !wbPrefs.self[`${r.srid || r.id}|${r.nmId}`]) sales.push({ cabinet: 'defly_wb', date: r.date, offer_id: r.offer || wbCatalog.get(String(r.nmId)), orders_item: 1 });
    for (const [first, last] of require('./wbHistory').coverageRanges(wbOrders.meta)) {
      for (let d = dayjs(first > from ? first : from); d.format('YYYY-MM-DD') <= to && d.format('YYYY-MM-DD') <= last; d = d.add(1, 'day')) {
        coverage.push({ cabinet: 'defly_wb', date: d.format('YYYY-MM-DD') });
      }
    }
  }
  const data = buildOzonDemand({ to, articles, shops: cabinets, sales, coverage });
  data.version = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  data.loadedAt = new Date().toISOString();
  return data;
}
async function demandFor(group, refresh = false) {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
  const hit = cached.get(group);
  if (!refresh && hit && Date.now() - hit.at < 60000 && hit.today === today) return hit.data;
  if (!pending.has(group)) {
    pending.set(group, collect(group).then(data => {
      cached.set(group, { at: Date.now(), today, data });
      return data;
    }).finally(() => pending.delete(group)));
  }
  return pending.get(group);
}
module.exports = { catalogFor, demandFor };
