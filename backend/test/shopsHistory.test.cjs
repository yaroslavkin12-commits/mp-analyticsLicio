const {test}=require('node:test'),assert=require('node:assert/strict');
const at=p=>import(require('node:url').pathToFileURL(require('node:path').resolve(__dirname,'../../dashboard/src/'+p)).href);
test('История показывает календарные недели целиком и все месяцы, включая февраль високосного года',async()=>{
 const {historyPeriods}=await at('lib/shopsWeekly.js');
 assert.deepEqual(historyPeriods('2026-10-29','2026-11-15').map(p=>[p.start,p.end]),[['2026-10-26','2026-11-01'],['2026-11-02','2026-11-08'],['2026-11-09','2026-11-15']]);
 assert.deepEqual(historyPeriods('2024-01-15','2024-03-04','months').map(p=>p.end),['2024-01-31','2024-02-29','2024-03-31']);
});
test('Частичная неделя сравнивается с теми же днями предыдущей; полный месяц — с полным',async()=>{
 const {comparisonWindow,calendarPeriod}=await at('lib/shopsWeekly.js');
 assert.deepEqual(comparisonWindow(calendarPeriod('2026-11-11'),'weeks','2026-11-09','2026-11-11',true),{from:'2026-11-09',to:'2026-11-11',previousFrom:'2026-11-02',previousTo:'2026-11-04'});
 assert.equal(comparisonWindow(calendarPeriod('2026-03-30','months'),'months','2026-03-01','2026-03-30',true).to,'2026-03-28');
 assert.equal(comparisonWindow(calendarPeriod('2026-03-30','months'),'months','2026-03-01','2026-03-31',false).to,'2026-03-31');
});
test('Загрузка истории не превышает 92 дня и движется назад без пропусков',async()=>{
 const {historyWindow}=await at('lib/shopsHistory.js');
 for(const mode of ['weeks','months']){let end='2026-11-15';for(let i=0;i<18;i++){const w=historyWindow(end,mode,'2026-11-15');assert.ok((Date.parse(w.to)-Date.parse(w.from))/86400000<=92);assert.equal(w.periods.at(-1).key,(await at('lib/shopsWeekly.js')).calendarPeriod(end,mode).key);end=w.olderThan;}}
});
test('Цвета: ±5% жёлтые; снижение расхода зелёное, рост красный; нет деления на ноль',async()=>{
 const {historyChange}=await at('lib/shopsWeekly.js');
 assert.equal(historyChange(105,100,'money').tone,'flat');assert.equal(historyChange(94,100,'money').tone,'down');
 assert.equal(historyChange(90,100,'expense').tone,'up');assert.equal(historyChange(110,100,'expense').tone,'down');
 assert.equal(historyChange(10,0,'money').fromZero,true);assert.equal(historyChange(0,0,'money').percent,0);assert.equal(historyChange(null,0,'money'),null);
});
const fixture=()=>({sales:{dates:['2026-11-01','2026-11-02','2026-11-03'],articles:[{o:'A',cat:'Дефлекторы'}],rows:[[0,0,0,0,0,1,100],[0,1,0,0,0,2,200],[0,2,0,0,0,3,300]]},pnl:{dates:['2026-11-01','2026-11-02','2026-11-03'],articles:[{o:'A',cat:'Дефлекторы'}],rows:[[0,0,0,100,1],[0,1,0,200,2],[0,2,0,300,3]],buckets:['sale'],cost:[10],ads:[],self:[],noSku:[[1,0,10]],adNoSku:[0,0,0]},tax:0});
test('Срез переиндексирует дни и удержания; факт и количество сохраняют смысл',async()=>{
 const {sliceReport,historyRange}=await at('lib/shopsHistory.js');const s=fixture();
 assert.deepEqual(sliceReport(s.pnl,'2026-11-02','2026-11-03').noSku,[[0,0,10]]);
 const coverage={orders:{from:'2026-11-01',to:'2026-11-03'},finance:{from:'2026-11-01',to:'2026-11-02'},ads:{from:'2026-11-01',to:'2026-11-02'}};
 const t=historyRange(s,'2026-11-01','2026-11-03',coverage);assert.equal(t.ordersQty,6);assert.equal(t.qty,3);assert.equal(t.revenue,310);assert.equal(t.cost,-30);
 assert.equal(historyRange(s,'2026-11-03','2026-11-03',coverage).revenue,null);
});
test('Сравнение не выдаёт нулевой предыдущий период, если его история отсутствует',async()=>{
 const {historyColumn}=await at('lib/shopsHistory.js');const s=fixture(),coverage={orders:{from:'2026-11-01',to:'2026-11-03'}};
 const p={key:'2026-11-02',start:'2026-11-02',end:'2026-11-08'};
 const c=historyColumn(s,p,'weeks','2026-11-03',coverage);assert.equal(c.comparisons.orders.previous,null);assert.equal(c.totals.ordersQty,5);assert.equal(c.totals.revenue,null);
});
test('История ограниченного пользователя требует фильтрацию до агрегации',()=>{
 const {projection}=require('../src/lib/categoryAccess');assert.throws(()=>projection('/sales/history',{periods:[]},{allowed:new Map()}));
 assert.deepEqual(projection('/sales/history',{_categoryFiltered:true,periods:[],secret:'нет'},{allowed:new Map()}),{periods:[]});
});
test('Сервер фильтрует артикулы перед итогами истории и разделяет кэш по разрешениям',async()=>{
 const paths=['../src/db','../src/routes/sales','../src/routes/finance','../src/lib/taxSettings'].map(p=>require.resolve(p)),old=paths.map(p=>require.cache[p]);
 const s=fixture();s.pnl.noSku=[];s.sales.articles.push({o:'B',cat:'Чехлы'});s.pnl.articles.push({o:'B',cat:'Чехлы'});s.pnl.cost.push(10);s.sales.rows.push([1,1,0,0,0,100,100000]);s.pnl.rows.push([1,1,0,100000,100]);s.pnl.available={mn:'2026-11-01',mx:'2026-11-03'};
 const mocks=[{query:async()=>[{mn:'2026-11-01',mx:'2026-11-03'}]},{loadSales:async()=>s.sales},{loadPnl:async()=>s.pnl,loadCoefs:async()=>({articles:s.pnl.articles,coefs:[],_metadataOnly:true}),loadBuyerShare:async()=>({periods:[]})},{getTaxSettings:async()=>({effectiveRate:0})}];
 paths.forEach((p,i)=>{require.cache[p]={id:p,filename:p,loaded:true,exports:mocks[i]};});
 try{const service=require('../src/lib/shopsHistory');const restricted=await service.load({cabinet:'defly',mode:'weeks'}, {allowed:new Map([['A',{path:'Дефлекторы'}]])}),full=await service.load({cabinet:'defly',mode:'weeks'});
  const r=restricted.periods.find(p=>p.start==='2026-11-02'),f=full.periods.find(p=>p.start==='2026-11-02');
  assert.equal(r.totals.ordersQty,5);assert.equal(f.totals.ordersQty,105);assert.equal(r.totals.revenue,500);assert.equal(f.totals.revenue,100500);
  assert.equal(restricted._categoryFiltered,true);assert.equal(restricted.available.from,'2026-11-01');
 }finally{paths.forEach((p,i)=>{if(old[i])require.cache[p]=old[i];else delete require.cache[p];});}
});
