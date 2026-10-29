const express = require('express');
const dayjs = require('dayjs');
const bridge = require('../lib/wbBridge');
const router = express.Router();
router.use('/views', require('./wbViews'));
router.post('/import', async (req, res) => {
  try { bridge.verify(req.wbRawBody, req.get('X-WB-Timestamp'), req.get('X-WB-Signature')); res.json({ success: true, data: await bridge.ingest(req.body) }); }
  catch (e) { res.status(e.status || 400).json({ success: false, error: e.message }); }
});
router.get('/data', async (req, res) => {
  try {
    if ((req.query.cabinet || bridge.CABINET) !== bridge.CABINET) return res.status(400).json({ success: false, error: 'Неизвестный кабинет WB' });
    const to = req.query.dateTo || new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
    const from = req.query.dateFrom || dayjs(to).subtract(29, 'day').format('YYYY-MM-DD');
    if (![from, to].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d) || from > to || dayjs(to).diff(from, 'day') > 365) throw new Error('Выберите период не более года');
    const sync = await require('../collectors/wb/sheetSync').sync(req.query.fresh === '1');
    const datasets = await bridge.read();
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: { ...buildReport(datasets, from, to, !!process.env.ADS_SHEET_ID_DEFLY_WB), sync } });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});
const n = v => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
const total = (rows, key) => rows.some(r => n(r[key]) === null) ? null : rows.reduce((s, r) => s + n(r[key]), 0);
function buildReport(datasets, from, to, configured) {
  const data = new Map(datasets.map(d => [d.kind, d]));
  const get = k => data.get(k)?.rows || [];
  const period = r => r.date >= from && r.date <= to;
  const orders = get('orders').filter(period), sales = get('sales').filter(period), ads = get('ads').filter(period);
  const stock = get('stocks'), catalog = get('catalog'), prices = new Map(get('prices').map(r => [String(r.nmId), r]));
  const articles = new Map(), nmOffer = new Map();
  for (const r of catalog) if (r.offer) nmOffer.set(String(r.nmId), r.offer);
  const art = r => {
    const offer = r.offer || nmOffer.get(String(r.nmId)) || `WB ${r.nmId || 'без артикула'}`;
    if (!articles.has(offer)) articles.set(offer, { offer, name: '', nmId: r.nmId, orders: 0, cancelled: 0, orderRub: 0, sold: 0, returned: 0, salesRub: 0, stockWb: 0, stockSeller: 0, toClient: 0, fromClient: 0 });
    return articles.get(offer);
  };
  for (const r of catalog) { const a = art(r); a.name = r.name || ''; a.price = prices.get(String(r.nmId))?.price ?? null; }
  const daily = new Map();
  for (let d = dayjs(from); d.format('YYYY-MM-DD') <= to; d = d.add(1, 'day')) daily.set(d.format('YYYY-MM-DD'), { date: d.format('YYYY-MM-DD'), orders: 0, orderRub: 0, sold: 0, returned: 0, spend: 0 });
  for (const r of orders) { const a = art(r); if (r.cancelled) { a.cancelled++; continue; } a.orders++; a.orderRub = a.orderRub === null || n(r.price) === null ? null : a.orderRub + n(r.price); const d = daily.get(r.date); d.orders++; d.orderRub = d.orderRub === null || n(r.price) === null ? null : d.orderRub + n(r.price); }
  for (const r of sales) { if (!['sale', 'return'].includes(r.type)) continue; const a = art(r), d = daily.get(r.date), isReturn = r.type === 'return'; a[isReturn ? 'returned' : 'sold']++; d[isReturn ? 'returned' : 'sold']++; if (!isReturn) a.salesRub = a.salesRub === null || n(r.price) === null ? null : a.salesRub + n(r.price); }
  for (const r of stock) { const a = art(r); for (const [target, source] of [[r.scheme === 'seller' ? 'stockSeller' : 'stockWb', 'quantity'], ['toClient', 'toClient'], ['fromClient', 'fromClient']]) a[target] = a[target] === null || n(r[source]) === null ? null : a[target] + n(r[source]); }
  const campaigns = new Map(get('campaigns').map(r => [String(r.id), { ...r, spend: 0, views: 0, clicks: 0, orders: 0, orderRub: 0, atbs: 0 }]));
  for (const r of ads.filter(r => r.scope === 'campaign')) { let c = campaigns.get(String(r.campaign)); if (!c) { c = { id: r.campaign, name: `РК ${r.campaign}`, spend: 0, views: 0, clicks: 0, orders: 0, orderRub: 0, atbs: 0 }; campaigns.set(String(r.campaign), c); } for (const k of ['spend', 'views', 'clicks', 'orders', 'orderRub', 'atbs']) c[k] = c[k] === null || n(r[k]) === null ? null : c[k] + n(r[k]); const d = daily.get(r.date); d.spend = d.spend === null || n(r.spend) === null ? null : d.spend + n(r.spend); }
  const available = kind => data.has(kind) && (!['orders', 'sales', 'ads'].includes(kind) || (data.get(kind).meta.from <= from && data.get(kind).meta.to >= to));
  const list = [...articles.values()];
  const sums = { orders: list.reduce((s, a) => s + a.orders, 0), cancelled: list.reduce((s, a) => s + a.cancelled, 0), orderRub: total(list, 'orderRub'), sold: list.reduce((s, a) => s + a.sold, 0), returned: list.reduce((s, a) => s + a.returned, 0), salesRub: total(list, 'salesRub'), unknownSales: sales.filter(r => !['sale', 'return'].includes(r.type)).length };
  for (const a of list) { if (!available('orders')) for (const k of ['orders', 'cancelled', 'orderRub']) a[k] = null; if (!available('sales')) for (const k of ['sold', 'returned', 'salesRub']) a[k] = null; if (!data.has('stocks')) for (const k of ['stockWb', 'stockSeller', 'toClient', 'fromClient']) a[k] = null; }
  for (const d of daily.values()) { if (!available('orders')) d.orders = d.orderRub = null; if (!available('sales')) d.sold = d.returned = null; if (!available('ads')) d.spend = null; }
  if (!available('orders')) for (const k of ['orders', 'cancelled', 'orderRub']) sums[k] = null;
  if (!available('sales')) for (const k of ['sold', 'returned', 'salesRub']) sums[k] = null;
  return { cabinet: bridge.CABINET, from, to, configured, status: bridge.KINDS.map(kind => ({ kind, ...(data.get(kind)?.meta || {}), receivedAt: data.get(kind)?.updated_at || null, available: available(kind) })), summary: sums, daily: [...daily.values()], articles: list, orders, sales, stocks: stock, campaigns: [...campaigns.values()].map(c => ({ ...c, ...(!available('ads') ? { spend: null, views: null, clicks: null, orders: null, orderRub: null, atbs: null } : {}) })), adProducts: ads.filter(r => r.scope === 'sku') };
}
module.exports = router;
module.exports.buildReport = buildReport;
