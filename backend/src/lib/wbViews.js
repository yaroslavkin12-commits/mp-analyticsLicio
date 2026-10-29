const dayjs = require('dayjs');
const { autoPath, carBrand, ORDER } = require('./categories');
const { districtOf, DISTRICT_ORDER } = require('./regions');
const KEY = 'wb-ui:defly_wb:v1';
const initial = () => ({ groups: [], members: {}, order: [], transit: {}, events: [], categories: {}, manual: {}, self: {}, clusterDecisions: {}, templates: null, sewing: {} });
async function preferences() { const r = await require('../db').query('SELECT value FROM app_settings WHERE key=$1', [KEY]); return { ...initial(), ...(r[0] ? JSON.parse(r[0].value) : {}) }; }
async function update(fn) {
  const c = await require('../db').getPool().connect();
  try { await c.query('BEGIN'); await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [KEY]); const r = await c.query('SELECT value FROM app_settings WHERE key=$1 FOR UPDATE', [KEY]); const p = { ...initial(), ...(r.rows[0] ? JSON.parse(r.rows[0].value) : {}) }; const result = fn(p); await c.query('INSERT INTO app_settings(key,value,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [KEY, JSON.stringify(p)]); await c.query('COMMIT'); require('./dataVersion').bump(); return result; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
const number = v => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
function add(a, b) { return a == null || b == null ? null : a + b; }
const dateRange = (from, to) => { const out = []; for (let d = dayjs(from); d.format('YYYY-MM-DD') <= to; d = d.add(1, 'day')) out.push(d.format('YYYY-MM-DD')); return out; };
function build(datasets, prefs = initial(), params = {}) {
  prefs = { ...initial(), ...prefs };
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
  const to = params.dateTo || today, from = params.dateFrom || dayjs(to).subtract(29, 'day').format('YYYY-MM-DD');
  if (![from, to].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && dayjs(d).format('YYYY-MM-DD') === d) || from > to || dayjs(to).diff(from, 'day') > 399) throw new Error('Укажите период не более 400 дней');
  const dates = dateRange(from, to), prevTo = dayjs(from).subtract(1, 'day').format('YYYY-MM-DD'), prevFrom = dayjs(from).subtract(dates.length, 'day').format('YYYY-MM-DD');
  const ds = new Map(datasets.map(r => [r.kind, r])), get = k => ds.get(k)?.rows || [];
  const covered = (kind, d) => !!ds.get(kind) && (!['orders', 'sales', 'ads', 'funnel'].includes(kind) || (ds.get(kind).meta.from <= d && ds.get(kind).meta.to >= d));
  const full = (kind, f = from, t = to) => covered(kind, f) && covered(kind, t);
  const articles = [], byOffer = new Map(), nm = new Map();
  function art(offer, name, sku) {
    const o = String(offer || (sku ? 'WB ' + sku : 'Без артикула')).trim(), key = o.toLowerCase();
    if (!byOffer.has(key)) { byOffer.set(key, articles.length); articles.push({ o, n: name || '', sku: sku ? String(sku) : null, cat: prefs.categories[o] || autoPath('defly', name, o).join(' / ') || 'Без категории', brand: carBrand(name), st: covered('stocks', today) ? 0 : null }); }
    const a = articles[byOffer.get(key)]; if (!a.n && name) { a.n = name; a.cat = prefs.categories[a.o] || autoPath('defly', name, o).join(' / '); a.brand = carBrand(name); }
    if (sku) nm.set(String(sku), a.o); return byOffer.get(key);
  }
  for (const r of get('catalog')) art(r.offer, r.name, r.nmId);
  const offerOf = r => r.offer || nm.get(String(r.nmId));
  for (const kind of ['orders', 'sales', 'stocks']) for (const r of get(kind)) art(offerOf(r), r.name, r.nmId);
  for (const r of get('ads').filter(r => r.scope === 'sku')) art(offerOf(r), r.name, r.nmId);
  const index = r => art(offerOf(r), r.name, r.nmId);
  const self = r => !!prefs.self[`${r.srid || r.id}|${r.nmId}`];
  const daily = new Map();
  const make = (ai, d, cache = true) => {
    const key = ai + '|' + d;
    if (!daily.has(key)) { const value = { views: null, pdpViews: null, cart: null, orders: covered('orders', d) ? 0 : null, revenue: covered('orders', d) ? 0 : null, spend: covered('ads', d) ? 0 : null, spendCpc: covered('ads', d) ? 0 : null, spendCpo: 0, spendOther: covered('ads', d) ? 0 : null, clicks: covered('ads', d) ? 0 : null, adViews: covered('ads', d) ? 0 : null, adOrders: covered('ads', d) ? 0 : null, adRevenue: covered('ads', d) ? 0 : null, adToCart: covered('ads', d) ? 0 : null, position: null, stock: null, selfQ: 0, selfR: 0, selfFbs: 0, _strict: true }; if(!cache)return value; daily.set(key,value); }
    return daily.get(key);
  };
  for (const r of get('orders')) {
    if (r.cancelled) continue; const ai = index(r), d = make(ai, r.date);
    if (self(r)) { d.selfQ++; d.selfR = add(d.selfR, number(r.price)); if (/продавца/i.test(r.warehouseType || '')) d.selfFbs++; continue; }
    d.orders = add(d.orders, 1); d.revenue = add(d.revenue, number(r.price));
  }
  const campaignById = new Map(get('campaigns').map(r => [String(r.id), r]));
  for (const r of get('ads').filter(r => r.scope === 'sku' && r.date >= prevFrom && r.date <= to)) {
    const d = make(index(r), r.date), c = campaignById.get(String(r.campaign)), payment = c?.payment;
    d.spend = add(d.spend, number(r.spend));
    if (payment === 'cpc') d.spendCpc = add(d.spendCpc, number(r.spend)); else d.spendOther = add(d.spendOther, number(r.spend));
    for (const [k, source] of [['clicks', 'clicks'], ['adViews', 'views'], ['adOrders', 'orders'], ['adRevenue', 'orderRub'], ['adToCart', 'atbs']]) d[k] = add(d[k], number(r[source]));
    if (number(r.position) !== null) {d.positionCount=(d.positionCount||0)+1; d.position=d.positionCount===1?number(r.position):null;}
  }
  // Если у РК один подтверждённый товар, её дневной итог точно относится к нему. Остальное не делим наугад.
  const allocations = new Map();
  for (const r of get('ads').filter(r => r.scope === 'sku')) { const key = r.campaign + '|' + r.date; allocations.set(key, add(allocations.get(key) ?? 0, number(r.spend))); }
  const unallocated = { cur: 0, prev: 0, byDate: {} };
  for (const r of get('ads').filter(r => r.scope === 'campaign' && r.date >= prevFrom && r.date <= to)) {
    const c = campaignById.get(String(r.campaign)), assigned = allocations.get(r.campaign + '|' + r.date), skus = c?.nmIds || [];
    if (assigned === undefined && skus.length === 1 && nm.has(String(skus[0]))) {
      const d = make(art(nm.get(String(skus[0])), '', skus[0]), r.date); d.spend = add(d.spend, number(r.spend)); const costKey = c.payment === 'cpc' ? 'spendCpc' : 'spendOther'; d[costKey] = add(d[costKey], number(r.spend));
      for (const [k, s] of [['clicks', 'clicks'], ['adViews', 'views'], ['adOrders', 'orders'], ['adRevenue', 'orderRub'], ['adToCart', 'atbs']]) d[k] = add(d[k], number(r[s]));
    } else { const rest = number(r.spend) == null || assigned === null ? null : Math.max(0, Number(r.spend) - (assigned || 0)); if (r.date >= from) { unallocated.cur = add(unallocated.cur, rest); unallocated.byDate[r.date] = add(unallocated.byDate[r.date] || 0, rest); } else unallocated.prev = add(unallocated.prev, rest); }
  }
  for (const r of get('stocks')) { const a = articles[index(r)]; a.st = add(a.st, number(r.quantity)); }
  for (const [key, values] of Object.entries(prefs.manual)) { const p = key.lastIndexOf('|'), ai = byOffer.get(key.slice(0, p).toLowerCase()); if (ai == null) continue; const date = key.slice(p + 1); if (date < prevFrom || date > to) continue; const d = make(ai, date); for (const [metric, value] of Object.entries(values)) { if (['views', 'pdpViews', 'cart', 'orders', 'revenue'].includes(metric)) d[metric] = value; } d.manual = values; }
  const sum = (ai, ds0) => {
    const out = { _strict: true }; const keys = ['views', 'pdpViews', 'cart', 'orders', 'revenue', 'spend', 'spendCpc', 'spendCpo', 'spendOther', 'clicks', 'adViews', 'adOrders', 'adRevenue', 'adToCart', 'selfQ', 'selfR', 'selfFbs'];
    for (const key of keys) out[key] = ds0.reduce((v, date) => add(v, make(ai, date, false)[key]), 0);
    return out;
  };
  const stockTotals = new Map();
  for (const r of get('stocks')) { const ai=index(r), x=stockTotals.get(ai) || {fboPresent:0,fbsPresent:0,fboReserved:null,fbsReserved:null}; const k=r.scheme==='seller'?'fbsPresent':'fboPresent'; x[k]=add(x[k],number(r.quantity)); stockTotals.set(ai,x); }
  const stockFor = ai => ds.has('stocks') ? stockTotals.get(ai) || {fboPresent:0,fbsPresent:0,fboReserved:null,fbsReserved:null} : null;
  function sales() {
    const rows = []; for (let ai = 0; ai < articles.length; ai++) dates.forEach((d, di) => { const x = make(ai, d, false); rows.push([ai, di, x.views, x.pdpViews, x.cart, x.orders, x.revenue, x.spendCpc, x.spendCpo, x.clicks, x.adOrders, x.adRevenue, x.position, x.adViews, x.spendOther]); });
    const prevDates = dateRange(prevFrom, prevTo), prev = articles.map((a, ai) => { const p = sum(ai, prevDates); return [ai, p.views, p.pdpViews, p.cart, p.orders, p.revenue, p.spend, p.adOrders]; });
    return { _wb: true, dates, articles, rows, prev, stock: [], self: articles.flatMap((a, ai) => dates.map((d, di) => [ai, di, make(ai, d, false).selfQ, make(ai, d, false).selfR]).filter(r => r[2])), unallocated, order: ORDER.defly, availability: { orders: full('orders'), sales: full('sales'), ads: full('ads') } };
  }
  function ads() {
    const campaignOffers=new Map(), campaignStats=new Map();
    for(const c of get('campaigns')) campaignOffers.set(String(c.id),new Set((c.nmIds||[]).map(n=>nm.get(String(n))?.toLowerCase()).filter(Boolean)));
    for(const r of get('ads')){const id=String(r.campaign);if(r.scope==='sku'){const o=nm.get(String(r.nmId));if(o){if(!campaignOffers.has(id))campaignOffers.set(id,new Set());campaignOffers.get(id).add(o.toLowerCase());}}else if(r.scope==='campaign'&&r.date>=from&&r.date<=to){const x=campaignStats.get(id)||{cost:full('ads')?0:null,rev:full('ads')?0:null,clicks:full('ads')?0:null};x.cost=add(x.cost,number(r.spend));x.rev=add(x.rev,number(r.orderRub));x.clicks=add(x.clicks,number(r.clicks));campaignStats.set(id,x);}}
    const list = articles.map((a, ai) => {
      const campaigns = get('campaigns').filter(c => campaignOffers.get(String(c.id))?.has(a.o.toLowerCase())).map(c => {
        const {cost,rev,clicks}=campaignStats.get(String(c.id))||{cost:full('ads')?0:null,rev:full('ads')?0:null,clicks:full('ads')?0:null};
        return { platform: 'wb', campaignId: String(c.id), title: c.name, state: Number(c.status) === 9 ? 'CAMPAIGN_STATE_RUNNING' : 'CAMPAIGN_STATE_STOPPED', paymentType: c.payment === 'cpc' ? 'CPC' : c.payment === 'cpm' ? 'CPM' : 'UNKNOWN', wbBidType: c.bidType || null, zone: c.search && !c.recommendations ? 'search' : c.search && c.recommendations ? 'rec' : '', strategy: '', totalSpend: cost, adDrr: rev > 0 && cost != null ? cost / rev * 100 : null, avgCpc: clicks > 0 && cost != null ? cost / clicks : null, splitAcross: 1 };
      });
      const stock = stockFor(ai), totals = sum(ai, dates), byDate = Object.fromEntries(dates.map(d => [d, { ...make(ai, d, false), stock: d >= String(ds.get('stocks')?.meta.collectedAt || '').slice(0, 10) && stock ? a.st : null }]));
      return { offerId: a.o, productName: a.n, cat: a.cat, sku: a.sku, campaigns, byDate, totals, prevTotals: sum(ai, dateRange(prevFrom, prevTo)), stock, stockDays: stock && totals.orders > 0 ? a.st / (totals.orders / dates.length) : null, associated: [], cpo: null, _strict: true };
    });
    return { _wb: true, dates, articles: list, availability:{ads:full('ads'),orders:full('orders')}, unallocated, order: ORDER.defly };
  }
  function feed() {
    const kind = params.kind || 'orders', source = kind === 'orders' ? get('orders') : get('sales').filter(r => kind === 'returns' ? r.type === 'return' : r.type === 'sale');
    return { _wb: true, available:full(kind === 'orders'?'orders':'sales'), from, to, since: get('orders').map(r => r.at || r.date).sort()[0] || null, rows: source.filter(r => r.date >= from && r.date <= to).sort((a, b) => String(b.at || b.date).localeCompare(String(a.at || a.date))).map(r => ({ p: r.srid || r.id, sku: String(r.nmId), o: articles[index(r)].o, n: articles[index(r)].n, cat: articles[index(r)].cat, price: number(r.price), qty: 1, st: kind === 'orders' ? (r.cancelled ? 'cancelled' : 'ordered') : kind === 'returns' ? 'returned' : 'delivered', wh: r.warehouse, at: r.at ? r.at + (/Z$|[+-]\d\d:\d\d$/.test(r.at) ? '' : '+03:00') : null, date: r.date, sch: /продавца/i.test(r.warehouseType || '') ? 'fbs' : /WB/i.test(r.warehouseType || '') ? 'fbo' : null, self: self(r) })) };
  }
  function pnl() {
    const rows = []; articles.forEach((a,ai)=>dates.forEach((d,di)=>rows.push([ai,di,0,covered('sales',d)?0:null,covered('sales',d)?0:null]))); for (const r of get('sales')) { if (r.date < from || r.date > to || !['sale', 'return'].includes(r.type)) continue; rows.push([index(r), dates.indexOf(r.date), r.type === 'sale' ? 0 : 1, number(r.price) == null ? null : (r.type === 'return' ? -1 : 1) * r.price, r.type === 'return' ? -1 : 1]); }
    return { _wb: true, _operational: true, dates, articles, rows, cost: articles.map(() => null), noSku: [], buckets: ['sale', 'return'], ads: [], adNoSku: [], self: [], order: ORDER.defly, available: { mn: ds.get('sales')?.meta.from || null, mx: ds.get('sales')?.meta.to || null }, from, to };
  }
  function stocks() {
    const days = Math.max(7, Math.min(60, Number(params.days) || 14)), ds0 = dateRange(dayjs(today).subtract(59, 'day').format('YYYY-MM-DD'), today), di = new Map(ds0.map((d, i) => [d, i]));
    const stock = ds.has('stocks') ? articles.map((a, ai) => { const s = stockFor(ai); return [ai, s.fboPresent, null, s.fbsPresent, null]; }) : [];
    const hist = [], stamp = String(ds.get('stocks')?.meta.collectedAt || '').slice(0, 10); if (di.has(stamp)) for (const row of stock) hist.push([row[0], di.get(stamp), row[1], row[3]]);
    const sellerDays=new Map();
    for(const r of get('orders')) if(!r.cancelled&&!self(r)&&di.has(r.date)){const k=index(r)+'|'+r.date; const x=sellerDays.get(k)||{q:0,unknown:false}; x.unknown ||= !r.warehouseType; if(/продавца/i.test(r.warehouseType||''))x.q++; sellerDays.set(k,x);}
    const orders = [], fbs = []; for (let ai = 0; ai < articles.length; ai++) ds0.forEach((d, i) => { const m = make(ai, d, false), x=sellerDays.get(ai+'|'+d); orders.push([ai, i, m.orders, m.revenue]); fbs.push([ai,i,m.orders,covered('orders',d)&&!x?.unknown?(x?.q||0):null]); });
    return { _wb: true, articles, dates: ds0, days, stock, hist, orders, fbs, cl: [], clHist: [], demand: [], clusters: [], districts: DISTRICT_ORDER, order: ORDER.defly, stockDate: stamp, clusterDate: null };
  }
  function clusters() {
    const groups = new Map(); for (const r of get('catalog')) if (r.imtId && r.offer) { const k = String(r.imtId); if (!groups.has(k)) groups.set(k, { id: k, src: 'wb', name: r.name || r.offer, members: [], manual: [] }); if (!groups.get(k).members.includes(r.offer)) groups.get(k).members.push(r.offer); }
    for (const [offer, id] of Object.entries(prefs.clusterDecisions)) { for (const g of groups.values()) g.members = g.members.filter(o => o !== offer); if (id) { if (!groups.has(id)) groups.set(id, { id, src: 'manual', name: offer, members: [], manual: [] }); groups.get(id).members.push(offer); groups.get(id).manual.push(offer); } }
    return { _wb: true, source: 'wb', items: articles.map((a, i) => ({ ...a, model: get('catalog').find(r=>r.offer===a.o)?.imtId || null, created: get('catalog').find(r=>r.offer===a.o)?.created || null, isNew: (get('catalog').find(r=>r.offer===a.o)?.created || '') >= dayjs(today).subtract(29,'day').format('YYYY-MM-DD'), orders30: sum(i, dates).orders })), clusters: [...groups.values()].filter(g => g.members.length > 1), suggest: [], newGroups: [] };
  }
  function geo() {
    const regions = [], ri = new Map(), out = new Map(), prev = new Map(), byDay = new Map();
    for (const r of get('orders')) { if (self(r) || !r.region || r.date < prevFrom || r.date > to) continue; const ai = index(r); if (!ri.has(r.region)) { ri.set(r.region, regions.length); regions.push({ name: r.region, district: districtOf(r.region) }); } const reg = ri.get(r.region), target = r.date >= from ? out : prev, k = ai + '|' + reg, v = target.get(k) || [ai, reg, 0, 0, 0]; if(r.cancelled)v[4]++;else{v[2]++; v[3] = add(v[3], number(r.price));} target.set(k, v); if (!r.cancelled && r.date >= from) { const k = reg + '|' + r.date, x = byDay.get(k) || [reg, dates.indexOf(r.date), 0, 0]; x[2]++; x[3] = add(x[3], number(r.price)); byDay.set(k, x); } }
    return { _wb: true, dates, articles, regions, cities: [], rows: [...out.values()].map(([a, r, q, v, c]) => [a, r, 0, q, v, c]), days: [...byDay.values()], prev: [...prev.values()], districts: DISTRICT_ORDER, order: ORDER.defly, available: { min: ds.get('orders')?.meta.from || null, max: ds.get('orders')?.meta.to || null } };
  }
  function season() {
    const m = ds.get('orders')?.meta, months = []; if (m) for (let d = dayjs(m.from).startOf('month'); d.format('YYYY-MM') <= String(m.to).slice(0, 7); d = d.add(1, 'month')) { if (d.format('YYYY-MM-DD') >= m.from) months.push(d.format('YYYY-MM')); }
    const byMonth=new Map(); for(const r of get('orders')) if(!r.cancelled&&!self(r)){const k=index(r)+'|'+r.date.slice(0,7),x=byMonth.get(k)||[0,0]; x[0]=add(x[0],number(r.price));x[1]++;byMonth.set(k,x);}
    const rows=[]; articles.forEach((a,ai)=>months.forEach((month,mi)=>{const x=byMonth.get(ai+'|'+month)||[0,0];rows.push([ai,mi,...x]);}));return {_wb:true,articles,order:ORDER.defly,months,rows};
  }
  const coefs = () => ({ _wb: true, _metadataOnly: true, articles, order: ORDER.defly, rows: [], fbsDays: [] });
  const costs = costRows => ({ _wb: true, items: articles.map((a, ai) => { const c = costRows.find(r => r.article === a.o), s = sum(ai, dates); return { offerId: a.o, name: a.n, category: a.cat, cost: c ? number(c.cost_price) : null, updatedAt: c?.updated_at || null, orders30: s.orders, avgPrice30: s.orders > 0 ? s.revenue / s.orders : null }; }), order: ORDER.defly });
  const calcBase = costRows => ({_wb:true,_metadataOnly:true,articles,order:ORDER.defly,a:articles.map((a,ai)=>{const r=new Array(41).fill(null);r[0]=ai;r[1]=number(get('prices').find(p=>String(p.nmId)===a.sku)?.price);r[12]=number(costRows.find(c=>c.article===a.o)?.cost_price);return r;})});
  return { sales, ads, feed, pnl, stocks, clusters, geo, season, coefs, costs, calcBase, articles, covered, prefs, dates, full };
}
module.exports = { build, preferences, update, initial };
