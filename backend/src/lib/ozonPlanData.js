const dayjs = require('dayjs');
dayjs.extend(require('dayjs/plugin/utc'));
dayjs.extend(require('dayjs/plugin/timezone'));
const { query } = require('../db');
const { CABINETS, isConnected } = require('../config/cabinets');
const { loadPnl, loadCoefs, meta } = require('../routes/finance');
const { loadSales } = require('../routes/sales');
const { SHOPS, taxonomy, leafPath } = require('./ozonPlan');
const models = Promise.all([import('../../../dashboard/src/lib/pnlCalc.js'), import('../../../dashboard/src/pages/unitModel.js')]);
const today = () => dayjs().tz('Europe/Moscow').startOf('day');
// База распределения использует полные дни по вчера. Выполнение ниже включает
// и сегодня: новые начисления уточняют результат при каждом обновлении.
const cutoff = () => today().subtract(1, 'day').format('YYYY-MM-DD');
const validDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && dayjs(v).isValid() && dayjs(v).format('YYYY-MM-DD') === v;
function validMonth(m) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(m || ''); }
function defaultPeriod(month) {
  const prev = dayjs(month + '-01').subtract(1, 'day').format('YYYY-MM-DD');
  const to = prev < cutoff() ? prev : cutoff();
  return { from: dayjs(to).subtract(29, 'day').format('YYYY-MM-DD'), to };
}
async function marketPeriod(month){
  const base=defaultPeriod(month),wb=(await require('./wbBridge').readMeta()).find(d=>d.kind==='finance');
  const to=wb?.meta.to&&wb.meta.to<base.to?wb.meta.to:base.to;
  return {from:dayjs(to).subtract(29,'day').format('YYYY-MM-DD'),to};
}
function checkPeriod(from, to) {
  if (!validDate(from) || !validDate(to) || from > to || dayjs(to).diff(from, 'day') > 91) throw new Error('Период базы: от 1 до 92 дней');
  if (to > cutoff()) throw new Error(`Для базы доступны полные дни по ${cutoff()}; текущий день используется в выполнении предварительно`);
}
async function wbModel(from,to,finance=false){
  const bridge=require('./wbBridge'),views=require('./wbViews');const ds=await bridge.read({excludeFinance:true});
  if(finance){const f=await bridge.readFinance();if(f)ds.push(f);}
  return {model:views.build(ds,await views.preferences(),{dateFrom:from,dateTo:to}),datasets:ds};
}
async function catalogs(ids = SHOPS) {
  const out = {}, errors = {};
  for (const shop of ids) {
    try { out[shop] = shop==='defly_wb'?(await wbModel()).model.articles:(await meta(shop)).articles; }
    catch (e) { out[shop] = []; errors[shop] = e.message; }
  }
  return { out, errors };
}
async function report(shop, from, to, tax, source, frozen, openDay = false) {
  const label = CABINETS[shop].label,platform=CABINETS[shop].platform;
  if (!isConnected(shop)) return { label, error: 'магазин не подключён', byPath: {} };
  try {
    const [{ pnlTotals }, { unitCoefs, unitProfit }] = await models;
    const wb=platform==='wb'?await wbModel(from,to,true):null;
    const data = wb?wb.model.pnl():await loadPnl({ cabinet: shop, dateFrom: from, dateTo: to });
    if(wb&&data._operational)return {label,platform,error:'Финансовый отчёт WB ещё не загружен',byPath:{}};
    const pathOf = a => frozen?.[a.o] || tax.byShop[shop]?.[a.o] || leafPath(a.cat, tax.branches, tax.detailed);
    const result = pnlTotals(data, { tax: 0, groupOf: pathOf, withDays: true });
    const byPath = result.byGroup;
    const available = data.available || {};
    const requiredTo = openDay ? cutoff() : to;
    const partial = !available.mn || available.mn > from || !available.mx || available.mx < requiredTo;
    const [job] = wb?[{last_success_at:wb.datasets.find(d=>d.kind==='finance')?.meta.collectedAt}]:await query(`SELECT last_success_at, last_error FROM ad_job_status WHERE cabinet = $1 AND job = 'finance'`, [shop]);
    let forecastError = null;
    if (source === 'forecast') {
      try {
        const coefs = wb?wb.model.coefs():await loadCoefs({ cabinet: shop });
        const sales = wb?wb.model.sales():await loadSales({ cabinet: shop, dateFrom: from, dateTo: to });
        if(wb&&(!sales.availability.orders||!sales.availability.ads))throw new Error('Для прогноза история заказов и рекламы WB должна покрывать весь период базы. Выберите факт или уточните базу вручную.');
        const arts = coefs.articles.map(a => ({ ...a, parts: String(a.cat || 'Без категории').split(' / ') }));
        const ks = unitCoefs(coefs, arts), byOffer = new Map(arts.map((a, i) => [a.o, ks[i]]));
        const fbs = new Map((coefs.fbsDays || []).filter(r => r[2] > 0).map(([ai, d, o, f]) => [coefs.articles[ai].o + '|' + d, f / o]));
        for (const r of sales.rows) {
          const a = sales.articles[r[0]], path = pathOf(a), k = byOffer.get(a.o);
          const out = byPath[path] || (byPath[path] = { qty: 0, payout: 0, days: [] });
          const fc = out.forecast || (out.forecast = { qty: 0, payout: 0 });
          if (!k) { if (r[5] || r[7] || r[8]) fc.missing = true; continue; }
          const v = unitProfit(k, { ordRub: r[6], ordQty: r[5], ads: (r[7] || 0) + (r[8] || 0) + (r[14] || 0), fbs: fbs.get(a.o + '|' + sales.dates[r[1]]) }, 0);
          fc.qty += v.expQty; fc.payout += v.expRev - v.comm - v.logi - v.acq - v.other - v.ads;
        }
      } catch (e) { forecastError = e.message; }
    }
    return { label, platform, byPath, partial, available, updatedAt: job?.last_success_at || null, collectionError: job?.last_error || null, forecastError };
  } catch (e) { return { label, platform, error: e.message, byPath: {} }; }
}
function addParents(shops){
  for(const shop of Object.values(shops)){
    const leaves=Object.entries(shop.byPath||{}),parents=new Map();
    for(const [path,metric] of leaves){const parts=path.split(' / ');for(let depth=1;depth<parts.length;depth++){const key=parts.slice(0,depth).join(' / ');if(!parents.has(key))parents.set(key,[]);parents.get(key).push(metric);}}
    for(const [path,items] of parents){if(shop.byPath[path])continue;const days=new Map();for(const m of items)for(const d of m.days||[]){const x=days.get(d.date)||{date:d.date,qty:0,payout:0};x.qty+=d.qty??NaN;x.payout+=d.payout??NaN;days.set(d.date,x);}shop.byPath[path]={qty:items.reduce((n,m)=>n+m.qty,0),payout:items.reduce((n,m)=>n+m.payout,0),days:[...days.values()],...(items.some(m=>m.forecast)?{forecast:{qty:items.reduce((n,m)=>n+(m.forecast?.qty||0),0),payout:items.reduce((n,m)=>n+(m.forecast?.payout||0),0),missing:items.some(m=>m.forecast?.missing)}}:{})};}
  }
}
const basisCache = new Map();
// Агрегации пяти кабинетов выполняются последовательно: не держим несколько
// комплектов финансов и заказов одновременно на небольшом сервере Render.
let tail = Promise.resolve();
function serial(fn) { const job = tail.then(fn, fn); tail = job.catch(() => {}); return job; }
async function basis(from, to, source, force = false, ids = SHOPS) {
  checkPeriod(from, to);
  const key = `${ids.join(",")}|${from}|${to}|${source}`;
  const hit = basisCache.get(key);
  if (!force && hit && Date.now() - hit.at < 60000) return hit.promise;
  const promise = serial(async () => {
    const cat = await catalogs(ids), tax = taxonomy(cat.out, [], ids, ids.some(id=>CABINETS[id].platform==='wb')), shops = {};
    for (const shop of ids) {
      shops[shop] = cat.errors[shop] ? { label: CABINETS[shop].label, platform:CABINETS[shop].platform, error: cat.errors[shop], byPath: {} } : await report(shop, from, to, tax, source);
    }
    if(ids.some(id=>CABINETS[id].platform==='wb'))addParents(shops);
    return { hierarchical:ids.some(id=>CABINETS[id].platform==='wb'),from, to, source, asOf: new Date().toISOString(), cutoff: cutoff(), paths: tax.paths, taxonomy: tax.byShop, shops };
  });
  basisCache.set(key, { at: Date.now(), promise });
  if (basisCache.size > 4) basisCache.delete(basisCache.keys().next().value);
  return promise;
}
async function loadExecution(month, snapshot, ids = SHOPS) {
  const now = dayjs().tz('Europe/Moscow'), current = now.format('YYYY-MM-DD');
  const from = month + '-01', end = dayjs(from).endOf('month').format('YYYY-MM-DD'), to = end < current ? end : current;
  if (to < from) return { from, to: null, shops: {}, future: true };
  const cat = await catalogs(ids), tax = taxonomy(cat.out, snapshot?.targets.map(t => t.path) || [], ids, ids.some(id=>CABINETS[id].platform==='wb')), shops = {};
  if(snapshot)for(const offers of Object.values(tax.byShop))for(const [offer,path] of Object.entries(offers))offers[offer]=snapshot.targets.find(t=>path===t.path||path.startsWith(t.path+' / '))?.path||path;
  const provisional = to === current;
  for (const shop of ids) shops[shop] = await report(shop, from, to, tax, 'fact', snapshot?.taxonomy?.[shop], provisional);
  let effectiveTo=to;
  if(ids.some(id=>CABINETS[id].platform==='wb')){
    const ends=Object.values(shops).map(s=>s.available?.mx).filter(Boolean);if(ends.length)effectiveTo=[to,...ends].sort()[0];
    if(effectiveTo<from)for(const s of Object.values(shops)){s.error='Финансы за выбранный месяц ещё не загружены';s.byPath={};}
    if(effectiveTo>=from&&effectiveTo<to)for(const s of Object.values(shops)){if(s.error)continue;for(const r of Object.values(s.byPath)){r.days=(r.days||[]).filter(d=>d.date<=effectiveTo);r.qty=r.days.reduce((n,d)=>n+(d.qty||0),0);r.payout=r.days.reduce((n,d)=>n+(d.payout||0),0);}s.partial=!s.available?.mn||s.available.mn>from||s.available.mx<effectiveTo;}
  }
  const fraction = (now.hour() * 3600 + now.minute() * 60 + now.second()) / 86400;
  const elapsedDays = effectiveTo<from?0:effectiveTo===current?now.date()-1+fraction:dayjs(effectiveTo).date();
  return { from, to:effectiveTo<from?null:effectiveTo, requestedTo:to,shops, asOf: now.toISOString(), future: false, provisional:effectiveTo===current, elapsedDays, evaluatedAtMoscow: now.format('HH:mm') };
}
const execution = (month, snapshot, ids = SHOPS) => serial(() => loadExecution(month, snapshot, ids));
module.exports = { today, cutoff, validMonth, defaultPeriod, marketPeriod, checkPeriod, catalogs, basis, execution };
