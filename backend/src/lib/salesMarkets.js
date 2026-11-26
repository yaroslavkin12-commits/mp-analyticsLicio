const dayjs = require('dayjs');
const { query } = require('../db');
const { listCabinets } = require('../config/cabinets');
const version = require('./dataVersion');

const SEP = ' / ';
const normalize = value => String(value ?? '').trim().toLowerCase();
const cache = new Map();
const known = (ranges, date) => ranges.some(([from,to]) => date >= from && date <= to);
const rangesOf = range => range?.from && range?.to ? (range.ranges || [[range.from, range.to]]) : [];
const financeRanges = pnl => pnl && !pnl._operational ? rangesOf({from:pnl.available?.mn,to:pnl.available?.mx}) : [];
const roll = (a, b) => Number.isFinite(a) && Number.isFinite(b) ? a + b : null;

function compactOrders(sales, ranges) {
  const {dates,articles} = sales;
  const observed = dates.map(d => known(ranges,d));
  const rows = sales.rows.filter(r => observed[r[1]] && (r[5] !== 0 || r[6] !== 0))
    .map(r => [r[0],r[1],r[5],r[6]]);
  return {dates,articles,rows};
}

async function readCabinet(shop, dateFrom, dateTo) {
  const params = { cabinet: shop.id, dateFrom, dateTo };
  if (shop.platform === 'wb') {
    const bridge = require('./wbBridge').forCabinet(shop.id);
    const V = require('./wbViews');
    const [base, prefs, finance] = await Promise.all([
      bridge.read({kinds:['catalog','orders','sales'],projection:'metrics'}),
      V.preferences(shop.id),
      bridge.readFinance({dateFrom,dateTo}).catch(() => null),
    ]);
    const model = V.build(finance ? [...base, finance] : base, prefs, params);
    const sales = model.sales();
    const orderRanges = rangesOf(sales.coverage.orders);
    let pnl = null;
    if (finance) {
      try { pnl = model.pnl(); }
      catch (error) { console.warn('[Аналитика площадок] Финансы', shop.id, error.message); }
    }
    return {sales:compactOrders(sales,orderRanges),pnl,orderRanges};
  }
  const [sales,pnl,coverage] = await Promise.all([
    require('../routes/sales').loadSales(params, undefined, {ordersOnly:true,skipAdvertising:true}),
    require('../routes/finance').loadPnl(params,{buyoutsOnly:true}).catch(() => null),
    query(`SELECT MIN(date)::text AS "from", MAX(date)::text AS "to"
      FROM product_analytics_daily WHERE cabinet=$1 AND platform='ozon'`, [shop.id]),
  ]);
  const orderRanges = rangesOf(coverage[0]);
  return {sales:compactOrders(sales,orderRanges),pnl,orderRanges};
}

function cachedCabinet(shop, from, to) {
  const key = JSON.stringify([shop.id, from, to]), now = Date.now(), ver = version.get();
  const hit = cache.get(key);
  if (hit && (!hit.done || (hit.ver === ver && now - hit.at < hit.ttl))) return hit.promise;
  const entry = {at:now,ver,done:false};
  entry.promise = readCabinet(shop, from, to).then(source => {
    // Ошибку чтения финансов можно повторить при следующем запросе.
    entry.done = true;
    entry.ttl = source.pnl ? 120000 : 15000;
    return source;
  }).catch(error => {
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  });
  cache.delete(key);
  cache.set(key,entry);
  while (cache.size > 24) cache.delete(cache.keys().next().value);
  return entry.promise;
}

function visibleArticles(source, context) {
  return [...source.sales.articles, ...(source.pnl?.articles || [])].flatMap(art => {
    const rule = context?.allowed.get(String(art.o));
    return context && !rule ? [] : [{o:String(art.o),n:art.n,category:rule?.path || art.cat || ''}];
  });
}

function summarize(source, dates, matches) {
  const {sales,pnl,orderRanges} = source;
  const finRanges = financeRanges(pnl);
  const buckets = dates.map(d => [...Array(2).fill(known(orderRanges,d) ? 0 : null), ...Array(2).fill(known(finRanges,d) ? 0 : null)]);
  const plan = new Map(dates.map((d,i) => [d,i]));
  for (const [ai,di,qty,rub] of sales.rows) {
    if (!matches.has(String(sales.articles[ai]?.o))) continue;
    const v = buckets[plan.get(sales.dates[di])];
    if (v) { v[0] = roll(v[0],qty); v[1] = roll(v[1],rub); }
  }
  for (const [ai,di,bi,rub,qty] of pnl?.rows || []) {
    const type = pnl.buckets[bi];
    if (!['sale','return'].includes(type) || !matches.has(String(pnl.articles[ai]?.o))) continue;
    const v = buckets[plan.get(pnl.dates[di])];
    if (v) {
      v[2] = roll(v[2], Number.isFinite(qty) ? Math.abs(qty) * (type === 'return' ? -1 : 1) : null);
      v[3] = roll(v[3],rub);
    }
  }
  return buckets;
}

async function load(params, contexts) {
  const {dateFrom:from,dateTo:to} = params;
  const valid = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && dayjs(d).format('YYYY-MM-DD') === d;
  if (!valid(from) || !valid(to) || from > to || dayjs(to).diff(from,'day') > 92) {
    throw Object.assign(new Error('Выберите период не более 93 дней'), {status:400});
  }
  const text = typeof params.search === 'string' ? normalize(params.search.slice(0,200)) : '';
  const category = typeof params.category === 'string' ? params.category.slice(0,256) : '';
  const dates = Array.from({length:dayjs(to).diff(from,'day')+1}, (_,i) => dayjs(from).add(i,'day').format('YYYY-MM-DD'));
  const shops = listCabinets().filter(s => s.family === 'defly' && s.connected && (!contexts || contexts[s.id]));
  const sources = [];
  for (let i = 0; i < shops.length; i += 3) {
    const batch = await Promise.allSettled(shops.slice(i,i+3).map(s => cachedCabinet(s,from,to)));
    sources.push(...batch.map(r => r.status === 'fulfilled' ? r.value : null));
  }
  const articles = sources.map((s,i) => s ? visibleArticles(s,contexts?.[shops[i].id]) : []);
  const all = articles.flat();
  const exact = text && all.some(a => normalize(a.o) === text);
  const textMatch = a => !text || (exact ? normalize(a.o) === text : normalize(a.o).includes(text) || normalize(a.n).includes(text));
  const categoryMatch = a => !category || a.category === category || a.category.startsWith(category + SEP);
  const selected = articles.map(list => new Set(list.filter(a => textMatch(a) && categoryMatch(a)).map(a => a.o)));
  const options = [...new Map(all.filter(a => text && (normalize(a.o).includes(text) || normalize(a.n).includes(text)))
    .map(a => [normalize(a.o), {o:a.o,n:a.n}])).values()].slice(0,40);
  const categories = [...new Set(all.flatMap(a => {
    const parts = a.category.split(SEP).filter(Boolean);
    return parts.map((_,i) => parts.slice(0,i+1).join(SEP));
  }))];
  return {dates,options,categories,matched:selected.some(set => set.size > 0),_categoryFiltered:!!contexts,
    shops:shops.map(({id,label,platform},i) => ({
      id,label,platform,matched:selected[i].size > 0,
      daily:sources[i] ? summarize(sources[i],dates,selected[i]) : null,
    }))};
}
module.exports = { load };
