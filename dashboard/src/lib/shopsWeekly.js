import {pnlTotals} from './pnlCalc.js';
import {unitCoefs,unitProfit} from '../pages/unitModel.js';
const SEP=' / ';
const dateAdd=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
export function calendarWeeks(from,to){
 const day=(new Date(from+'T00:00:00Z').getUTCDay()+6)%7,out=[];
 for(let start=dateAdd(from,-day);start<=to;start=dateAdd(start,7)){const end=dateAdd(start,6);out.push({key:start,from:start<from?from:start,to:end>to?to:end,partial:start<from||end>to});}
 return out;
}
const includes=(a,cat)=>!cat||a.cat===cat||String(a.cat||'').startsWith(cat+SEP);
const FIN=['revenue','qty','ozonX','ads','payout','cost','tax','profit'];
// Коэффициенты и доли FBS не зависят от недельного среза. История готовит
// их один раз, обычные страницы сохраняют прежний вызов shopDaily.
export function prepareShopModel(coefs,shareAt=null){
 const ca=(coefs?.articles||[]).map(a=>({...a,parts:String(a.cat||'Без категории').split(SEP)}));
 const ks=coefs&&!coefs._metadataOnly?unitCoefs(coefs,ca,shareAt?(o,p)=>shareAt(o,p):null):null;
 return {ks,kByOffer:new Map(ca.map((a,i)=>[a.o,ks?.[i]])),fbs:new Map((coefs?.fbsDays||[]).filter(r=>r[2]>0).map(([ai,d,q,f])=>[coefs.articles[ai].o+'|'+d,f/q]))};
}
export function shopDaily({sales,coefs,pnl,tax=6,shareAt=null,category='',prepared=null}){
 if(!sales&&!pnl)return null;
 const {ks,kByOffer,fbs}=prepared||prepareShopModel(coefs,shareAt);
 const daily=(sales?.dates||pnl.dates).map(date=>{
  const known=!!sales&&(!sales._wb||!!sales.coverage?.orders&&date>=sales.coverage.orders.from&&date<=sales.coverage.orders.to);
  return {date,ordersRub:known?0:null,ordersQty:known?0:null,expectedQty:ks&&known?0:null,expectedPayout:ks&&known?0:null,...Object.fromEntries(FIN.map(k=>[k,null]))};
 });
 for(const row of sales?.rows||[]){const [ai,di]=row,a=sales.articles[ai],d=daily[di];if(!d||!includes(a,category)||d.ordersQty===null)continue;
  const q=row[5],rub=row[6];d.ordersQty+=q??NaN;d.ordersRub+=rub??NaN;
  if(!ks)continue;
  const ads=(row[7]??NaN)+(row[8]??NaN)+(sales._wb?(row[14]??NaN):0);
  if(!q&&!rub&&!ads)continue;
  const k=kByOffer.get(a.o);if(!k||!Number.isFinite(q)||!Number.isFinite(rub)||!Number.isFinite(ads)){d.expectedQty=NaN;d.expectedPayout=NaN;continue;}
  const v=unitProfit(k,{ordRub:rub,ordQty:q,ads,fbs:fbs.get(a.o+'|'+d.date)},tax);
  d.expectedQty+=v.expQty;d.expectedPayout+=v.expRev-v.comm-v.logi-v.acq-v.other-v.ads;
 }
 if(pnl){
  const f=pnlTotals(pnl,{tax,shareAt,withDays:true,groupOf:category?a=>includes(a,category)?'selected':'other':null});
  const selected=category?f.byGroup.selected:f.total,byDate=new Map((selected?.days||[]).map(d=>[d.date,d]));
  for(const d of daily){const actual=byDate.get(d.date);if(pnl._operational&&pnl.available&&(d.date<pnl.available.mn||d.date>pnl.available.mx))continue;if(actual)for(const k of FIN)d[k]=actual[k]??null;
   else if(!selected&&pnl.dates.includes(d.date)&&(!pnl._wb||pnl.available?.mn<=d.date&&pnl.available?.mx>=d.date))for(const k of FIN)d[k]=pnl._operational&&!['qty','revenue'].includes(k)?null:0;
  }
 }
 return daily;
}
const sumKnown=(days,k)=>{const values=days.map(d=>d[k]).filter(v=>v!==null&&v!==undefined);return values.length&&values.every(Number.isFinite)?values.reduce((a,b)=>a+b,0):null;};
export function rangeTotals(series,from,to){
 if(!series?.length)return null;
 const keys=['ordersRub','ordersQty','expectedQty','expectedPayout',...FIN];
 const totals=series.map(days=>days?Object.fromEntries(keys.map(k=>[k,sumKnown(days.filter(d=>d.date>=from&&d.date<=to),k)])):Object.fromEntries(keys.map(k=>[k,null])));
 return combineTotals(totals);
}
export function combineTotals(totals){
 if(!totals?.length)return null;
 const keys=['ordersRub','ordersQty','expectedQty','expectedPayout',...FIN];
 const t=Object.fromEntries(keys.map(k=>[k,totals.every(s=>Number.isFinite(s[k]))?totals.reduce((n,s)=>n+s[k],0):null]));
 const ratio=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&b>0?Math.round((a/b)*1e8)/1e8:null;
 return {...t,avgOrder:ratio(t.ordersRub,t.ordersQty),avgBuyout:ratio(t.revenue,t.qty),payForecast:ratio(t.expectedPayout,t.expectedQty),payActual:ratio(t.payout,t.qty),margin:ratio(t.profit,t.revenue)===null?null:ratio(t.profit,t.revenue)*100};
}
export const WEEK_METRICS=[
 ['ordersRub','Заказы, ₽','money'],['ordersQty','Заказы, шт','qty'],['revenue','Выручка (выкупы), ₽','money'],['qty','Выкупы, шт','qty'],
 ['avgOrder','Ср. чек · прогноз по заказам','money'],['avgBuyout','Ср. чек · факт по выкупам','money'],['payForecast','Поступление на 1 выкуп · прогноз','money'],['payActual','Поступление на 1 выкуп · факт','money'],
 ['ozonX','Услуги площадки, ₽','expense'],['ads','Реклама, ₽','expense'],['payout','К перечислению, ₽','money'],['cost','Себестоимость, ₽','expense'],['profit','Прибыль, ₽','money'],['margin','Рентабельность, %','pct']
];

export function calendarPeriod(date,mode='weeks'){
 const d=new Date(date+'T00:00:00Z');
 const start=mode==='months'?date.slice(0,7)+'-01':dateAdd(date,-((d.getUTCDay()+6)%7));
 const end=mode==='months'?new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).toISOString().slice(0,10):dateAdd(start,6);
 return {key:start,start,end};
}
export function historyPeriods(from,to,mode='weeks'){
 if(!from||!to||from>to)return [];
 const out=[];for(let p=calendarPeriod(from,mode);p.start<=to;p=calendarPeriod(dateAdd(p.end,1),mode))out.push(p);
 return out;
}
export function previousPeriod(period,mode){return calendarPeriod(dateAdd(period.start,-1),mode);}
export function comparisonWindow(period,mode,from,to,partial){
 const prev=previousPeriod(period,mode);if(!partial)return {from:period.start,to:period.end,previousFrom:prev.start,previousTo:prev.end};
 const offset=Math.max(0,Math.round((Date.parse(from)-Date.parse(period.start))/86400000));
 const count=Math.round((Date.parse(to)-Date.parse(from))/86400000)+1;
 const previousFrom=dateAdd(prev.start,offset);if(previousFrom>prev.end||count<1)return null;
 const previousTo=[dateAdd(previousFrom,count-1),prev.end].sort()[0],days=Math.round((Date.parse(previousTo)-Date.parse(previousFrom))/86400000)+1;
 return {from,to:dateAdd(from,days-1),previousFrom,previousTo};
}
export const historyMetricGroup=key=>['ordersRub','ordersQty','avgOrder','payForecast'].includes(key)?'orders':key==='ads'?'ads':'finance';
export function historyChange(current,previous,type){
 if(!Number.isFinite(current)||!Number.isFinite(previous))return null;
 const delta=current-previous,percent=previous===0?(current===0?0:null):delta/Math.abs(previous)*100;
 const better=type==='expense'?delta<0:delta>0;
 return {percent,fromZero:previous===0&&current!==0,tone:delta===0||percent!==null&&Math.abs(percent)<=5?'flat':better?'up':'down'};
}
