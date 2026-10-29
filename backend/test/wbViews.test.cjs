const {test}=require('node:test');
const assert=require('node:assert/strict');
const V=require('../src/lib/wbViews');
const from='2026-10-01',to='2026-10-02';
function fixture(){return Object.entries({
 catalog:[{id:'1',nmId:1,imtId:77,offer:'A',name:'Дефлекторы окон 2D Haval Jolion'},{id:'2',nmId:2,imtId:77,offer:'B',name:'Дефлекторы окон 2D Haval Jolion'}],
 orders:[{id:'o1',date:from,nmId:1,price:100,at:from+'T11:00:00',warehouseType:'Склад продавца',region:'Московская область'},{id:'o2',date:from,nmId:1,price:100,cancelled:true},{id:'o3',date:to,nmId:1,price:200},{id:'o4',date:to,nmId:2,price:500}],
 sales:[{id:'S1',srid:'o1',date:from,nmId:1,price:100,type:'sale'},{id:'S2',srid:'o3',date:to,nmId:1,price:200,type:'sale'},{id:'R1',srid:'o1',date:to,nmId:1,price:100,type:'return'}],
 stocks:[{id:'w',nmId:1,scheme:'wb',quantity:10},{id:'s',nmId:2,scheme:'seller',quantity:20}],
 campaigns:[{id:'cpc',name:'Клики',payment:'cpc',nmIds:[1],status:9,bidType:'manual',search:true},{id:'cpm',name:'Показы',payment:'cpm',nmIds:[2],status:11,bidType:'unified',search:true,recommendations:true}],
 ads:[{id:'a',scope:'sku',campaign:'cpc',date:from,nmId:1,spend:10,clicks:2,views:100,orders:1,orderRub:100,atbs:1,position:5},{id:'b',scope:'campaign',campaign:'cpc',date:from,spend:10,clicks:2,views:100,orders:1,orderRub:100,atbs:1},{id:'c',scope:'sku',campaign:'cpm',date:to,nmId:2,spend:20,clicks:3,views:200,orders:1,orderRub:500,atbs:2},{id:'d',scope:'campaign',campaign:'cpm',date:to,spend:20,clicks:3,views:200,orders:1,orderRub:500,atbs:2}],
 prices:[{id:'1',nmId:1,price:120}]
}).map(([kind,rows])=>({kind,rows,meta:{from:'2026-09-01',to,collectedAt:to+'T12:00:00Z'}}));}
const model=(ds=fixture(),prefs=V.initial(),params={})=>V.build(ds,prefs,{dateFrom:from,dateTo:to,...params});
test('WB: общие страницы получают контракты Ozon, отмены и самовыкупы исключены из заказов',()=>{
 const p=V.initial();p.self['o3|1']=true;const m=model(fixture(),p),s=m.sales();
 assert.equal(s.rows.reduce((v,r)=>v+r[5],0),2);assert.equal(s.rows.reduce((v,r)=>v+r[6],0),600);
 assert.equal(s.self[0][2],1);assert.equal(s.articles[0].cat,'Дефлекторы / Окна / 2D');
 assert.equal(m.ads().articles[0].totals.orders,1);assert.equal(m.geo().rows.reduce((v,r)=>v+r[3],0),1);
 assert.equal(m.clusters().source,'wb');assert.deepEqual(m.clusters().clusters[0].members,['A','B']);
});
test('WB: расходы CPC и CPM не смешиваются и не задваиваются, неизвестный остаток не ноль',()=>{
 const m=model(),s=m.sales(),a=m.ads();
 assert.equal(s.rows.reduce((v,r)=>v+r[7]+r[8]+r[14],0),30);
 assert.equal(a.articles.reduce((v,r)=>v+r.totals.spend,0),30);assert.equal(a.unallocated.cur,0);
 assert.equal(a.articles[0].campaigns[0].paymentType,'CPC');assert.equal(a.articles[1].campaigns[0].paymentType,'CPM');
 assert.equal(a.articles[1].totals.spendCpc,0);assert.equal(a.articles[1].totals.spendOther,20);
 assert.equal(m.stocks().stock[0][2],null);assert.equal(m.coefs()._metadataOnly,true);
 assert.equal(m.calcBase([]).a[0][1],120);assert.equal(m.calcBase([]).a[0][2],null);
});
test('WB: неполный период и цена не превращаются в нули; кампания с несколькими товарами не делится наугад',()=>{
 const ds=fixture();ds.find(x=>x.kind==='orders').rows[0].price=null;
 const m=model(ds,{}, {dateFrom:'2026-08-31'}),s=m.sales();
 assert.equal(s.rows[0][5],null);assert.equal(s.rows.find(r=>r[0]===0&&r[1]===31)[6],null);assert.equal(s.availability.orders,false);
 const ad=ds.find(x=>x.kind==='ads');ad.rows=ad.rows.filter(r=>r.scope==='campaign');ds.find(x=>x.kind==='campaigns').rows[0].nmIds=[1,2];
 const a=model(ds).ads();assert.equal(a.articles[0].totals.spend,0);assert.equal(a.unallocated.cur,10);assert.equal(a.articles[1].totals.spend,20);
 const empty=model([]);assert.equal(empty.sales().availability.orders,false);assert.equal(empty.feed().available,false);assert.equal(empty.ads().availability.ads,false);
});
test('WB: лента сохраняет время и srid, возвраты отдельно от продаж, самовыкупы общие для srid',()=>{
 const prefs=V.initial();prefs.self['o1|1']=true;
 const m=model(fixture(),prefs);assert.equal(m.feed().rows.find(r=>r.p==='o1').at,from+'T11:00:00+03:00');
 const sales=model(fixture(),prefs,{kind:'sales'}).feed();assert.equal(sales.rows.find(r=>r.p==='o1').self,true);
 const returns=model(fixture(),prefs,{kind:'returns'}).feed();assert.equal(returns.rows.length,1);assert.equal(returns.rows[0].st,'returned');
});
test('WB: операционные выкупы не создают прибыль, поступления и налог из отсутствующих финансов',async()=>{
 const {pnlTotals}=await import('../../dashboard/src/lib/pnlCalc.js'),{enrichSalesChart}=await import('../../dashboard/src/lib/salesChartModel.js');
 const pnl=model().pnl(),r=pnlTotals(pnl,{withDays:true,groupOf:()=> 'selected'}).total;
 assert.equal(r.qty,1);assert.equal(r.revenue,200);for(const k of ['payout','profit','tax','cost','ozonX'])assert.equal(r[k],null,k);
 const dates=[from,to],arts=[{o:'A',orders:[1,1],revenue:[100,200],spendCpc:[10,0],spendCpo:[0,0],spendOther:[0,0]}];
 const d=enrichSalesChart(arts,dates,[{key:'all',idx:[0,1]}],{byDate:{all:{orders:2,revenue:300}}},{pnl}).byDate.all;
 assert.equal(d.buyoutQty,1);assert.equal(d.buyoutRub,200);assert.equal(d.payout,null);assert.equal(d.profitActual,null);assert.equal(d.marginActual,null);assert.equal(d.paySale,null);
});
test('WB: группы, порядок, ручные значения и самовыкупы сохраняются отдельно; чужой кабинет отклоняется',async()=>{
 const dbPath=require.resolve('../src/db'),bridgePath=require.resolve('../src/lib/wbBridge'),sheetPath=require.resolve('../src/collectors/wb/sheetSync');
 const previous=[dbPath,bridgePath,sheetPath].map(p=>require.cache[p]);const store=new Map();
 const q=async(sql,args=[])=>{if(sql.includes('SELECT value'))return store.has(args[0])?[{value:store.get(args[0])}]:[];if(sql.includes('INSERT INTO app_settings')){assert.equal(args[0],'wb-ui:defly_wb:v1');store.set(args[0],args[1]);}return [];};
 require.cache[dbPath]={exports:{query:q,getPool:()=>({connect:async()=>({query:async(s,a)=>({rows:await q(s,a)}),release(){}})})}};
 require.cache[bridgePath]={exports:{read:async()=>fixture()}};require.cache[sheetPath]={exports:{sync:async()=>{},status:()=>({})}};
 try{
 const route=require('../src/routes/wbViews').stack[0].handle;
 const call=async(path,method='GET',body={},cabinet='defly_wb')=>{let code=200,out;await route({path,method,body,query:{cabinet,dateFrom:from,dateTo:to}},{set(){},status(n){code=n;return this;},json(x){out=x;return this;}});return {code,...out};};
 const g=(await call('/promo/groups','POST',{name:'Моя группа'})).data.groups[0];
 await call('/promo/groups/assign','POST',{offerId:'A',groupId:g.id});assert.equal((await call('/promo/groups')).data.members.A,g.id);
 await call('/promo/order','POST',{order:['B','A']});assert.deepEqual((await call('/promo/order')).data,['B','A']);
 await call('/promo/manual','POST',{offerId:'A',date:from,metric:'cart',value:3});assert.equal((await call('/promo/stats')).data.articles[0].byDate[from].cart,3);
 assert.equal((await call('/sales/category','POST',{offerIds:['A'],path:'Дефлекторы / Капот'})).data.path,'Дефлекторы / Капот');
 await call('/orders/self','POST',{items:[{p:'o1',sku:'1'}],on:true});assert.equal((await call('/promo/stats')).data.articles[0].totals.orders,1);
 assert.equal((await call('/sales/data','GET',{},'defly')).code,400);assert.equal(store.size,1);
 }finally{[dbPath,bridgePath,sheetPath].forEach((p,i)=>{if(previous[i])require.cache[p]=previous[i];else delete require.cache[p];});}
});
