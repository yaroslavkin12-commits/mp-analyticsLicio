// Те же заказы WB, что в аналитике: отмены и самовыкупы уже исключены адаптером.
function wbShopSummary(datasets, prefs, { from, to }) {
  const model = require('./wbViews').build(datasets, prefs, { dateFrom: from, dateTo: to });
  const sales = model.sales();
  const dayjs = require('dayjs');
  const days = dayjs(to).diff(from, 'day') + 1;
  const pFrom = dayjs(from).subtract(days, 'day').format('YYYY-MM-DD');
  const pTo = dayjs(from).subtract(1, 'day').format('YYYY-MM-DD');
  const aggregate = (f,t) => {
    const m=require('./wbViews').build(datasets,prefs,{dateFrom:f,dateTo:t}),s=m.sales();
    const coverage=datasets.find(d=>d.kind==='orders')?.meta;
    const known=!!coverage&&coverage.from<=t&&coverage.to>=f,complete=m.full('orders',f,t);
    const blank=()=>[known?0:null,known?0:null];
    const result={q:known?0:null,r:known?0:null,byCat:{},byPath:{},complete,coveredFrom:known?(coverage.from>f?coverage.from:f):null,coveredTo:known?(coverage.to<t?coverage.to:t):null};
    for(const a of s.articles){const parts=String(a.cat||'Без категории').split(' / ');result.byCat[parts[0]]||=blank();for(let d=1;d<=Math.min(parts.length,3);d++)result.byPath[parts.slice(0,d).join(' / ')]||=blank();}
    const add=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)?a+b:null;
    for(const row of s.rows){if(!known||s.dates[row[1]]<result.coveredFrom||s.dates[row[1]]>result.coveredTo)continue;
      const [ai,, ,,,q,r]=row,parts=String(s.articles[ai].cat||'Без категории').split(' / ');
      result.q=add(result.q,q);result.r=add(result.r,r);
      for(const target of [result.byCat[parts[0]],...Array.from({length:Math.min(parts.length,3)},(_,i)=>result.byPath[parts.slice(0,i+1).join(' / ')])]){target[0]=add(target[0],q);target[1]=add(target[1],r);}
    }
    return result;
  };
  return {id:'defly_wb',label:'Defly WB',platform:'wb',cur:aggregate(from,to),prev:aggregate(pFrom,pTo)};
}
module.exports={wbShopSummary};
