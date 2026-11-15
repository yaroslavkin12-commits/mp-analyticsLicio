const {test}=require('node:test'),assert=require('node:assert/strict');
let queries=[];
const products=[{offer_id:'A',sku:'1',product_name:'Дефлекторы окон 2D'},{offer_id:'B',sku:'2',product_name:'Чехлы сиденья'}];
const daily=[{date:'2026-11-10',offer_id:'A',sku:'1',orders_item:2,revenue:2000,hits_view:100,hits_view_pdp:20,hits_tocart:5},{date:'2026-11-11',offer_id:'B',sku:'2',orders_item:0,revenue:0,hits_view:90,hits_view_pdp:10}];
const db=require.resolve('../src/db');require.cache[db]={id:db,filename:db,loaded:true,exports:{query:async sql=>{
 queries.push(sql);
 if(sql.includes('FROM ad_product_catalog'))return products;
 if(sql.includes('FROM product_analytics_daily'))return sql.includes('orders_item <> 0')?daily.filter(r=>r.orders_item||r.revenue).map(({hits_view,hits_view_pdp,hits_tocart,...r})=>({...r})):daily.map(r=>({...r}));
 if(sql.includes('FROM ad_campaigns'))return [{campaign_id:'c1',matched_offer_id:'A',payment_type:'CPC'}];
 if(sql.includes('FROM ad_stats_daily'))return [{date:'2026-11-10',campaign_id:'c1',spend:100,clicks:5}];
 if(sql.includes('FROM ad_product_stocks'))return [{date:'2026-11-10',offer_id:'A',v:30}];
 return [];
}}};
const of=require.resolve('../src/lib/orderFeed');require.cache[of]={id:of,filename:of,loaded:true,exports:{selfByDay:async()=>new Map(),applyToAnalytics:()=>{}}};
const alias=require.resolve('../src/lib/skuAlias');require.cache[alias]={id:alias,filename:alias,loaded:true,exports:{extend:async map=>map}};
const {loadSales}=require('../src/routes/sales');
test('Быстрые входные данные сводки сохраняют заказы и расходы, не читая снимки остатков и просмотры',async()=>{
 const params={cabinet:'defly',dateFrom:'2026-11-10',dateTo:'2026-11-11'};
 const full=await loadSales(params);assert.equal(queries.filter(q=>q.includes('FROM ad_product_stocks')).length,3);
 queries=[];const brief=await loadSales(params,null,{ordersOnly:true});
 assert.equal(queries.filter(q=>q.includes('FROM ad_product_stocks')).length,0);
 assert.ok(queries.some(q=>q.includes('orders_item <> 0')));assert.equal(brief._ordersOnly,true);
 const {shopDaily,rangeTotals}=await import('../../dashboard/src/lib/shopsWeekly.js');
 const coverage=raw=>rangeTotals([shopDaily({sales:raw})],params.dateFrom,params.dateTo);
 assert.deepEqual(coverage(full),coverage(brief));
 const stats=raw=>raw.rows.filter(r=>r[5]||r[6]||r[7]||r[8]).map(r=>[raw.articles[r[0]].o,r[1],...r.slice(5,9)]);
 assert.deepEqual(stats(brief),stats(full));assert.equal(brief.stock.length,0);assert.ok(full.stock.length>0);
});
