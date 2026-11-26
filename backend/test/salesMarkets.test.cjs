const assert = require('node:assert/strict');
const test = require('node:test');

const dates = ['2026-11-24','2026-11-25'];
const article = (o,n) => ({o,n,cat:'Дефлекторы / Окна'});
const allowed = new Map([['A-1',{path:'Дефлекторы / Окна'}],['AA-1',{path:'Дефлекторы / Окна'}]]);
const articles = [article('A-1','Дефлектор'),article('AA-1','Другой'),article('hidden','Закрытый')];
const sales = {dates,articles,rows:[[0,0,0,0,0,3,300],[1,0,0,0,0,9,900],[2,0,0,0,0,12,1200]]};
const pnl = {dates,articles,available:{mn:dates[0],mx:dates[0]},buckets:['sale','return','commission'],
  rows:[[0,0,0,280,3],[0,0,1,-90,-1],[0,0,2,-60,3],[1,0,0,200,2],[2,0,0,100,1]]};
const mock = (name,exports) => { require.cache[require.resolve(name)] = {exports}; };
mock('../src/db', {query:async()=>[{from:dates[0],to:dates[1]}]});
mock('../src/config/cabinets', {listCabinets:()=>[
  {id:'defly',label:'Defly',platform:'ozon',family:'defly',connected:true},
  {id:'nabauto_wb',label:'NABauto WB',platform:'wb',family:'defly',connected:true},
  {id:'alex',label:'Alex',platform:'ozon',family:'defly',connected:true},
]});
mock('../src/routes/sales', {loadSales:async()=>sales});
mock('../src/routes/finance', {loadPnl:async()=>pnl});
mock('../src/lib/wbBridge', {forCabinet:()=>({read:async()=>[],readFinance:async()=>({})})});
mock('../src/lib/wbViews', {
  preferences:async()=>({}),
  build:()=>({sales:()=>({...sales,rows:[[0,0,0,0,0,2,250]],coverage:{orders:{from:dates[0],to:dates[0]}}}),pnl:()=>pnl}),
});
const {load} = require('../src/lib/salesMarkets');

test('Сравнение суммирует точный артикул отдельно по кабинетам и сохраняет пробелы в истории', async () => {
  const data = await load({dateFrom:dates[0],dateTo:dates[1],search:'a-1'}, {defly:{allowed},nabauto_wb:{allowed}});
  assert.deepEqual(data.shops.map(s=>s.id),['defly','nabauto_wb']);
  assert.deepEqual(data.shops[0].daily,[[3,300,2,190],[0,0,null,null]]);
  assert.deepEqual(data.shops[1].daily,[[2,250,2,190],[null,null,null,null]]);
  assert.equal(data.matched,true);
  assert.equal(data._categoryFiltered,true);
});

test('Артикулы вне разрешённых категорий не попадают в сравнение и подсказки', async () => {
  const data = await load({dateFrom:dates[0],dateTo:dates[1],search:'hidden'}, {defly:{allowed}});
  assert.equal(data.matched,false);
  assert.deepEqual(data.options,[]);
  assert.deepEqual(data.shops[0].daily[0],[0,0,0,0]);
  await assert.rejects(load({dateFrom:'2026-02-31',dateTo:dates[1]}), {status:400});
});
