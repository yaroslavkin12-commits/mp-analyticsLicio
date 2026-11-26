const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>o?.[k]!==undefined).map(k=>[k,o[k]]));
const inside=(p,parent)=>p===parent||p.startsWith(parent+' / ');
function snapshot(value,contexts){
 if(!value)return null;
 const canonical=path=>contexts.licio&&!inside(path,'Одежда')?'Одежда / '+path:path;
 const allowed=(path,ctx)=>ctx.scope.allCategories||ctx.scope.paths.some(p=>inside(path,p));
 const rows=(value.rows||[]).filter(r=>Object.values(contexts).some(c=>allowed(canonical(r.path),c))).map(r=>{
  const shops=(r.shops||[]).filter(s=>contexts[s.id]&&allowed(canonical(r.path),contexts[s.id])).map(s=>pick(s,['id','label','platform','qty','amount','mean']));
  const qty=shops.reduce((n,s)=>n+s.qty,0),amount=shops.reduce((n,s)=>n+s.amount,0);
  return {path:canonical(r.path),shops,qty,amount,mean:qty>0?amount/qty:null};
 });
 return {...pick(value,['id','month','createdAt']),rows,targets:rows.map(r=>pick(r,['path','qty','amount','mean'])),taxonomy:Object.fromEntries(Object.entries(contexts).map(([id,c])=>[id,Object.fromEntries([...c.allowed].map(([o,m])=>[o,rows.find(r=>inside(m.path,r.path))?.path||m.path]))]))};
}
function planState(data,contexts){return {...pick(data,['schema','revision','activeId','month','defaultPeriod','cutoff']),shops:(data.shops||[]).filter(s=>contexts[s.id]).map(s=>pick(s,['id','label','platform'])),versions:(data.versions||[]).map(v=>snapshot(v,contexts)),migration:null,legacy:[]};}
function queries(data,ctx,select){
 const s=select(data,ctx),rows=s.rows(data.rows),ids=[...new Set(rows.map(r=>r[1]))],map=new Map(ids.map((id,i)=>[id,i]));
 return {...pick(data,['from','to','_wb']),articles:s.articles,order:[...new Set(s.articles.map(a=>a.cat.split(' / ')[0]))],queries:ids.map(i=>data.queries[i]),rows:rows.map(r=>[r[0],map.get(r[1]),...r.slice(2)])};
}
function geo(data,ctx,select){
 const s=select(data,ctx),rows=s.rows(data.rows),prev=s.rows(data.prev),ids=[...new Set([...rows,...prev].map(r=>r[1]))],map=new Map(ids.map((id,i)=>[id,i]));
 const cities=[...new Set(rows.map(r=>r[2]))],cityMap=new Map(cities.map((id,i)=>[id,i]));
 return {...pick(data,['dates','districts','_wb']),articles:s.articles,order:[...new Set(s.articles.map(a=>a.cat.split(' / ')[0]))],regions:ids.map(i=>data.regions[i]),cities:cities.map(i=>data.cities[i]||''),rows:rows.map(r=>[r[0],map.get(r[1]),cityMap.get(r[2]),...r.slice(3)]),prev:data.prev?prev.map(r=>[r[0],map.get(r[1]),...r.slice(2)]):null,days:(data.days||[]).filter(r=>map.has(r[0])).map(r=>[map.get(r[0]),...r.slice(1)])};
}
module.exports={snapshot,planState,queries,geo};
