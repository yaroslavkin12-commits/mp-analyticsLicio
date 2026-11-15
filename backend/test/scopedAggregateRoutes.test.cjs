const {test}=require('node:test'),assert=require('node:assert/strict');
const path='Дефлекторы / Окна / 2D',other='Чехлы',geoChecks=[];
const ctx={cabinet:'defly',scope:{paths:[path]},allowed:new Map([['A',{path}]])};
require.cache[require.resolve('../src/db')]={exports:{query:async(sql,args=[])=>{
 if(sql.includes('FROM ad_product_catalog'))return [{offer_id:'A',sku:1,product_name:'Дефлекторы окон 2D'},{offer_id:'PRIVATE-COVER',sku:2,product_name:'Чехлы'}];
 if(sql.includes('FROM product_category_override'))return [{offer_id:'A',path},{offer_id:'PRIVATE-COVER',path:other}];
 if(sql.includes('FROM product_analytics_daily'))return [{date:'2026-11-13',sku:1,orders_item:2,revenue:200},{date:'2026-11-13',sku:2,orders_item:999999,revenue:999999}];
 if(sql.includes('GROUP BY date, region, city')){geoChecks.push(args);assert.deepEqual(args[3],['A']);return [{date:'2026-11-13',region:'Москва',city:'',q:2,r:200}];}
 if(sql.includes('GROUP BY offer_id, region, city'))return [{offer_id:'A',region:'Москва',city:'',q:2,r:200},{offer_id:'PRIVATE-COVER',region:'Москва',city:'',q:999999,r:999999}];
 return [];
}}};
require.cache[require.resolve('../src/config/cabinets')]={exports:{CABINETS:{defly:{family:'defly',platform:'ozon'}},familyOf:()=> 'defly',listCabinets:()=>[{id:'defly',label:'Defly',platform:'ozon',connected:true}],isConnected:()=>true}};
require.cache[require.resolve('../src/lib/orderFeed')]={exports:{applyToAnalytics:()=>{},selfByDay:async()=>[]}};
require.cache[require.resolve('../src/routes/finance')]={exports:{meta:async()=>({})}};
require.cache[require.resolve('../src/collectors/ads/sheetSync')]={exports:{ensureFinTables:async()=>{}}};
const router=require('../src/routes/sales'),access=require('../src/lib/categoryAccess');
async function get(path,extra){let out,status=200;const handler=router.stack.find(l=>l.route?.path===path&&l.route.methods.get).route.stack[0].handle;await handler({query:{dateFrom:'2026-11-13',dateTo:'2026-11-13',cabinet:'defly'},...extra},{json(v){out=v;},status(n){status=n;return this;}});assert.equal(status,200);return out.data;}
test('Заказы сводки фильтруются по разрешённым артикулам до расчёта итогов',async()=>{
 const data=await get('/summary',{categoryContexts:{defly:ctx}}),out=access.projection('/sales/summary',data,{contexts:{defly:ctx}});
 assert.equal(out.shops[0].cur.q,2);assert.equal(out.shops[0].cur.r,200);assert.deepEqual(Object.keys(out.shops[0].cur.byCat),['Дефлекторы']);assert.ok(!JSON.stringify(out).includes('999999'));
});
test('Дневная география ограничивает SQL, включая чужие товары в том же регионе',async()=>{
 const data=await get('/geo',{categoryContext:ctx}),out=access.projection('/sales/geo',data,ctx);
 assert.equal(geoChecks.length,1);assert.equal(out.rows.length,1);assert.equal(out.days[0][2],2);assert.equal(out.days[0][3],200);assert.ok(!JSON.stringify(out).includes('999999'));
});
