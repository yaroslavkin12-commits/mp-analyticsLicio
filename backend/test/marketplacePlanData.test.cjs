const {test}=require('node:test'),assert=require('node:assert/strict');
const path='Дефлекторы / Окна / 2D',arts=[{o:'A',cat:path}];
require.cache[require.resolve('../src/db')]={exports:{query:async sql=>sql.includes('SELECT value')?[]:[{last_success_at:'2026-10-31T00:00:00Z'}]}};
require.cache[require.resolve('../src/config/cabinets')]={exports:{CABINETS:{defly:{label:'Defly',platform:'ozon'},defly_wb:{label:'Defly WB',platform:'wb'}},familyOf:()=> 'defly',isConnected:()=>true}};
require.cache[require.resolve('../src/routes/finance')]={exports:{meta:async()=>({articles:arts}),loadCoefs:async()=>null,loadPnl:async p=>{assert.equal(p.cabinet,'defly');const dates=[];for(let d=new Date(p.dateFrom+'T00:00:00Z');d.toISOString().slice(0,10)<=p.dateTo;d.setUTCDate(d.getUTCDate()+1))dates.push(d.toISOString().slice(0,10));return {dates,articles:arts,buckets:['sale','commission'],rows:[[0,0,0,1000,1],[0,0,1,-100,0]],noSku:[],ads:[],adNoSku:dates.map(()=>0),cost:[null],available:{mn:'2026-01-01',mx:'2026-10-31'}};}}};
require.cache[require.resolve('../src/routes/sales')]={exports:{loadSales:async()=>null}};
const ops=[{kind:'catalog',rows:[{offer:'A',nmId:1,name:'Дефлекторы окон 2D'}],meta:{}},{kind:'orders',rows:[],meta:{from:'2026-08-01',to:'2026-10-31'}},{kind:'sales',rows:[],meta:{from:'2026-08-01',to:'2026-10-31'}}],finance={kind:'finance',meta:{from:'2026-08-01',to:'2026-10-30',collectedAt:'2026-10-31T00:00:00Z'},rows:[{id:'f',rrDate:'2026-10-01',vendorCode:'A',nmId:1,sellerOperName:'Продажа',docTypeName:'Продажа',quantity:2,retailPriceWithDisc:'2000',retailAmount:'1800',forPay:'1400',acquiringFee:'20'}]};
require.cache[require.resolve('../src/lib/wbBridge')]={exports:{read:async()=>[...ops],readFinance:async()=>finance,readMeta:async()=>[{kind:'finance',meta:finance.meta}]}};
const data=require('../src/lib/ozonPlanData');
test('Общий план читает реальные финансы WB через мост, отдельно от Ozon; база заканчивается загруженным днём',async()=>{
 const b=await data.basis('2026-10-01','2026-10-07','fact',true,['defly','defly_wb']);assert(b.hierarchical);assert.equal(b.shops.defly.byPath[path].qty,1);assert.equal(b.shops.defly_wb.byPath[path].qty,2);assert.equal(b.shops.defly_wb.byPath[path].payout,1400);assert.equal(b.shops.defly_wb.platform,'wb');assert.equal(b.shops.defly_wb.partial,false);
 const p=await data.marketPeriod('2099-01');assert.equal(p.to,'2026-10-30');assert.equal(p.from,'2026-10-01');
});
test('Выполнение использует общую загруженную дату и соответствующий темп',async()=>{
 const f=await data.execution('2026-10',null,['defly','defly_wb']);assert.equal(f.to,'2026-10-30');assert.equal(f.elapsedDays,30);assert.equal(f.shops.defly_wb.partial,false);assert.equal(f.shops.defly_wb.byPath[path].payout,1400);
});
