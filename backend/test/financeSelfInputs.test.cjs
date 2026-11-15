const {test}=require('node:test'),assert=require('node:assert/strict');let selected=null,matched=[];
const db=require.resolve('../src/db');require.cache[db]={id:db,filename:db,loaded:true,exports:{query:async(sql,p=[])=>{
 if(sql.includes('ad_product_catalog'))return [{offer_id:'A',sku:1,product_name:'Дефлекторы окон 2D'}];
 if(sql.includes('SELECT DISTINCT name'))return [{name:'Продажа'},{name:'Продажа FBO'},{name:'Логистика'},{name:'Комиссия'}];
 if(sql.includes('SUM(amount)'))return [];
 if(sql.includes('SUM(qty) q')){selected=p[3];return [{d:'2026-11-10',sku:'1',name:'Продажа',q:2},{d:'2026-11-10',sku:'1',name:'Продажа FBO',q:1}];}
 return [];
}}};
const alias=require.resolve('../src/lib/skuAlias');require.cache[alias]={id:alias,filename:alias,loaded:true,exports:{extend:async m=>m}};
const orders=require.resolve('../src/lib/orderFeed');require.cache[orders]={id:orders,filename:orders,loaded:true,exports:{matchToSales:async(c,s)=>{matched=s;return new Map([['1|2026-11-10',3]]);}}};
test('Сверка самовыкупов получает только названия продаж по существующей классификации, сохраняя все продажи SKU',async()=>{
 const {loadPnl}=require('../src/routes/finance');const result=await loadPnl({cabinet:'defly',dateFrom:'2026-11-10',dateTo:'2026-11-10'});
 assert.deepEqual(selected,['Продажа','Продажа FBO']);assert.equal(matched.reduce((s,r)=>s+r.q,0),3);assert.deepEqual(result.self,[[0,0,3]]);
});
