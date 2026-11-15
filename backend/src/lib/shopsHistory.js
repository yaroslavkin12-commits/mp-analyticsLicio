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
 const [{historyWindow,historyColumn},{makeShareAt}]=await models;
 const window=historyWindow(params.end,mode,today),p={cabinet,dateFrom:window.from,dateTo:window.to};
 let sales,pnl,coefs,bs=null,coverage;
 if(cabinet==='defly_wb'){
  const bridge=require('./wbBridge'),V=require('./wbViews');
  const ds=await bridge.read({excludeFinance:true}),fin=await bridge.readFinance();if(fin)ds.push(fin);
  const m=V.build(ds,await V.preferences(),p),costs=await query("SELECT article,cost_price FROM product_costs WHERE cabinet='defly' OR cabinet IS NULL ORDER BY updated_at DESC");
  sales=m.sales();pnl=m.pnl(costs);coefs=m.coefs(costs);
  coverage={orders:sales.coverage?.orders,finance:range(pnl.available),ads:sales.coverage?.ads};
 }else{
  const f=require('../routes/finance');
  sales=await require('../routes/sales').loadSales(p);pnl=await f.loadPnl(p);coefs=await f.loadCoefs({cabinet});bs=await f.loadBuyerShare(cabinet);
  const [orders,ads]=await Promise.all([
   query("SELECT MIN(date)::text mn,MAX(date)::text mx FROM product_analytics_daily WHERE cabinet=$1 AND platform='ozon'",[cabinet]),
   query("SELECT MIN(date)::text mn,MAX(date)::text mx FROM ad_stats_daily WHERE cabinet=$1 AND platform='ozon'",[cabinet])]);
  coverage={orders:range(orders[0]),finance:range(pnl.available),ads:range(ads[0])};
  // P&L использует начисленную рекламу, а за ещё не проведённые дни — статистику РК.
  if(coverage.finance){const a=coverage.ads;coverage.ads={from:a?.from<coverage.finance.from?a.from:coverage.finance.from,to:a?.to>coverage.finance.to?a.to:coverage.finance.to};}
 }
 if(ctx){sales=access.projection('/sales/data',sales,ctx);pnl=access.projection('/finance/pnl',pnl,ctx);coefs=access.projection('/finance/coefs',coefs,ctx);if(bs)bs=access.projection('/finance/buyer-share',bs,ctx);}
 const starts=Object.values(coverage).map(c=>c?.from).filter(Boolean).sort(),ends=Object.values(coverage).map(c=>c?.to).filter(Boolean).sort();
 const available={from:starts[0]||null,to:ends.at(-1)||null};
 const tax=(await require('./taxSettings').getTaxSettings(cabinet)).effectiveRate;
 const source={sales,pnl,coefs,tax,category:String(params.category||''),shareAt:makeShareAt(bs,pnl.articles.map(a=>({...a,parts:String(a.cat||'').split(' / ')})))};
 return {cabinet,mode,available,coverage,periods:window.periods.filter(p=>!available.from||p.end>=available.from).map(period=>historyColumn(source,period,mode,today,coverage)),olderThan:available.from&&window.olderThan>=available.from?window.olderThan:null,_categoryFiltered:!!ctx};
}
function load(params,ctx){
 const key=JSON.stringify([require('./dataVersion').get(),params.cabinet,params.mode,params.end,params.category,ctx?[...ctx.allowed.keys()].sort():null]);
 const hit=cache.get(key);if(hit&&Date.now()-hit.at<120000)return hit.promise;
 const promise=queue.catch(()=>{}).then(()=>build(params,ctx));queue=promise.catch(()=>{});
 cache.set(key,{at:Date.now(),promise});while(cache.size>24)cache.delete(cache.keys().next().value);
 promise.catch(()=>cache.delete(key));return promise;
}
module.exports={load};
