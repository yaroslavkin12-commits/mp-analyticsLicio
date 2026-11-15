import {shopDaily,prepareShopModel,rangeTotals,calendarPeriod,previousPeriod,comparisonWindow} from './shopsWeekly.js';
const add=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
// Срез сохраняет индексы статей, но пересчитывает индексы дней. Распределение
// общих удержаний выполняет существующая модель P&L внутри каждого периода.
export function sliceReport(raw,from,to){
 if(!raw)return null;
 const indices=new Map(),dates=[];raw.dates.forEach((d,i)=>{if(d>=from&&d<=to){indices.set(i,dates.length);dates.push(d);}});
 const out={...raw,dates};
 for(const key of ['rows','ads','self','taxBase'])if(Array.isArray(raw[key]))out[key]=raw[key].filter(r=>indices.has(r[1])).map(r=>{const v=[...r];v[1]=indices.get(r[1]);return v;});
 if(raw.noSku)out.noSku=raw.noSku.filter(r=>indices.has(r[0])).map(r=>[indices.get(r[0]),...r.slice(1)]);
 if(raw.adNoSku)out.adNoSku=raw.adNoSku.filter((_,i)=>indices.has(i));
 return out;
}
const fields={orders:['ordersRub','ordersQty','expectedQty','expectedPayout'],finance:['revenue','qty','ozonX','payout','cost','tax','profit'],ads:['ads']};
export function historyRange(source,from,to,coverage){
 const daily=shopDaily({...source,sales:sliceReport(source.sales,from,to),pnl:sliceReport(source.pnl,from,to)});
 if(!daily)return null;
 for(const d of daily)for(const [group,keys] of Object.entries(fields))if(!coverage[group]?.from||d.date<coverage[group].from||d.date>coverage[group].to)for(const key of keys)d[key]=null;
 return rangeTotals([daily],from,to);
}
export function historyColumn(source,period,mode,today,coverage,read=(from,to)=>historyRange(source,from,to,coverage)){
 const end=period.end<today?period.end:today,comparisons={};
 for(const group of Object.keys(fields)){
  const c=coverage[group],from=c?.from>period.start?c.from:period.start,to=c?.to<end?c.to:end;
  if(!c?.from||!c?.to||from>to){comparisons[group]=null;continue;}
  const partial=period.end>=today||from!==period.start||to!==period.end;
  const range=comparisonWindow(period,mode,from,to,partial);
  const known=range&&c.from<=range.previousFrom&&c.to>=range.previousTo;
  comparisons[group]={range,partial,through:to,current:range?read(range.from,range.to):null,previous:known?read(range.previousFrom,range.previousTo):null};
 }
 return {...period,current:period.start<=today&&period.end>=today,totals:read(period.start,end),comparisons};
}
export function historyWindow(end,mode,today){
 let p=calendarPeriod(end||today,mode);const periods=[];
 for(let i=0;i<(mode==='months'?2:8);i++){periods.unshift(p);p=previousPeriod(p,mode);}
 return {periods,from:p.start,to:periods.at(-1).end<today?periods.at(-1).end:today,olderThan:add(periods[0].start,-1)};
}

// Кэш живёт только в пределах одного отчёта. Один и тот же диапазон нужен
// для итога, трёх групп показателей и сравнения следующего столбца.
export function historyColumns(source,periods,mode,today,coverage,diagnostics=null){
 const preparedSource={...source,prepared:prepareShopModel(source.coefs,source.shareAt)},ranges=new Map();
 const read=(from,to)=>{const key=from+':'+to;if(!ranges.has(key))ranges.set(key,historyRange(preparedSource,from,to,coverage));return ranges.get(key);};
 const result=periods.map(p=>historyColumn(preparedSource,p,mode,today,coverage,read));
 if(diagnostics)diagnostics.ranges=ranges.size;
 return result;
}
