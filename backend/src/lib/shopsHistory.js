const {query}=require('../db');
const access=require('./categoryAccess');
const models=Promise.all([import('../../../dashboard/src/lib/shopsHistory.js'),import('../../../dashboard/src/lib/buyerShareModel.js')]);
let queue=Promise.resolve();const cache=new Map();
const range=r=>r?.mn&&r?.mx?{from:r.mn,to:r.mx}:null;
async function build(params,ctx){
 const cabinet=params.cabinet||'defly';if(!Object.hasOwn(require('../config/cabinets').CABINETS,cabinet))throw Error('Неизвестный магазин');
 const mode=params.mode==='months'?'months':'weeks';
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date());
 if(params.end&&(!/^\d{4}-\d{2}-\d{2}$/.test(params.end)|| !Number.isFinite(Date.parse(params.end))||new Date(params.end).toISOString().slice(0,10)!==params.end||params.end>today))throw Error('Некорректная дата истории');
 const [{historyWindow,historyColumns},{makeShareAt}]=await models;
 const started=performance.now();
 const window=historyWindow(params.end,mode,today),p={cabinet,dateFrom:window.from,dateTo:window.to};
 const stages={};
 const timed=async(name,fn)=>{const start=performance.now();try{return await fn();}finally{stages[name]=Math.round(performance.now()-start);}};
 let sales,pnl,coefs,bs=null,coverage;
 if(cabinet==='defly_wb'){
  const bridge=require('./wbBridge'),V=require('./wbViews');
  const base=await bridge.read({kinds:['catalog','orders','sales','prices']}),ads=await bridge.read({kinds:['ads','campaigns'],from:p.dateFrom,to:p.dateTo}),ds=[...base,...ads];
  const [fin,latest]=await Promise.all([bridge.readFinance({dateFrom:p.dateFrom,dateTo:p.dateTo}),bridge.readFinance({latest:true})]);
  const prefs=await V.preferences(),m=V.build(fin?[...ds,fin]:ds,prefs,p),costs=await query("SELECT article,cost_price FROM product_costs WHERE cabinet='defly' OR cabinet IS NULL ORDER BY updated_at DESC");
  sales=m.sales();pnl=m.pnl(costs);coefs=V.build(latest?[...ds,latest]:ds,prefs,p).coefs(costs);
  coverage={orders:sales.coverage?.orders,finance:range(pnl.available),ads:sales.coverage?.ads};
 }else{
  const f=require('../routes/finance');
  [sales,pnl]=await Promise.all([timed('sales',()=>require('../routes/sales').loadSales(p,v=>{stages.salesQueries=v;},{ordersOnly:true})),timed('finance',()=>f.loadPnl(p))]);
  [coefs,bs]=await Promise.all([timed('coefficients',()=>f.loadCoefs({cabinet})),timed('buyerShare',()=>f.loadBuyerShare(cabinet))]);
  const [orders,ads]=await timed('coverage',()=>Promise.all([
   query("SELECT MIN(date)::text mn,MAX(date)::text mx FROM product_analytics_daily WHERE cabinet=$1 AND platform='ozon'",[cabinet]),
   query("SELECT MIN(date)::text mn,MAX(date)::text mx FROM ad_stats_daily WHERE cabinet=$1 AND platform='ozon'",[cabinet])]));
  coverage={orders:range(orders[0]),finance:range(pnl.available),ads:range(ads[0])};
  // P&L использует начисленную рекламу, а за ещё не проведённые дни — статистику РК.
  if(coverage.finance){const a=coverage.ads;coverage.ads={from:a?.from<coverage.finance.from?a.from:coverage.finance.from,to:a?.to>coverage.finance.to?a.to:coverage.finance.to};}
 }
 if(ctx){sales=access.projection('/sales/data',sales,ctx);pnl=access.projection('/finance/pnl',pnl,ctx);coefs=access.projection('/finance/coefs',coefs,ctx);if(bs)bs=access.projection('/finance/buyer-share',bs,ctx);}
 const starts=Object.values(coverage).map(c=>c?.from).filter(Boolean).sort(),ends=Object.values(coverage).map(c=>c?.to).filter(Boolean).sort();
 const available={from:starts[0]||null,to:ends.at(-1)||null};
 const tax=(await require('./taxSettings').getTaxSettings(cabinet)).effectiveRate;
 const source={sales,pnl,coefs,tax,category:String(params.category||''),shareAt:makeShareAt(bs,pnl.articles.map(a=>({...a,parts:String(a.cat||'').split(' / ')})))};
 const loadedAt=performance.now(),diagnostics={};
 const periods=historyColumns(source,window.periods.filter(p=>!available.from||p.end>=available.from),mode,today,coverage,diagnostics);
 return {cabinet,mode,available,coverage,periods,olderThan:available.from&&window.olderThan>=available.from?window.olderThan:null,_categoryFiltered:!!ctx,
  _timing:{loadMs:Math.round(loadedAt-started),calculateMs:Math.round(performance.now()-loadedAt),ranges:diagnostics.ranges,sources:stages}};
}
function load(params,ctx){
 const key=JSON.stringify([require('./dataVersion').get(),params.cabinet,params.mode,params.end,params.category,ctx?[...ctx.allowed.keys()].sort():null]);
 const hit=cache.get(key);if(hit&&(!hit.finished||Date.now()-hit.at<300000))return hit.promise;
 const promise=queue.catch(()=>{}).then(()=>build(params,ctx));queue=promise.catch(()=>{});
 const entry={at:Date.now(),promise,finished:false};cache.set(key,entry);promise.then(()=>{entry.finished=true;entry.at=Date.now();},()=>{});while(cache.size>24)cache.delete(cache.keys().next().value);
 promise.catch(()=>cache.delete(key));return promise;
}
module.exports={load};
