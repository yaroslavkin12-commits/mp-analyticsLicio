const {test}=require('node:test'),assert=require('node:assert/strict');let reads=0;
const db=require.resolve('../src/db');require.cache[db]={id:db,filename:db,loaded:true,exports:{query:async sql=>{reads++;return sql.includes('ad_product_catalog')?[{offer_id:'A',sku:1,product_name:'Дефлекторы окон 2D'}]:[];}}};
const alias=require.resolve('../src/lib/skuAlias');require.cache[alias]={id:alias,filename:alias,loaded:true,exports:{extend:async m=>m.set('old','A')}};
const {read}=require('../src/lib/catalogSnapshot'),{meta}=require('../src/routes/finance');
test('Одновременные отчёты читают один справочник, сохраняя отдельные индексы архивных артикулов',async()=>{
 const [a,b]=await Promise.all([meta('defly'),meta('defly')]);assert.equal(reads,2);assert.notEqual(a.articles,b.articles);
 a.art('ARCHIVE','Архив');a.offerBySku.set('foreign','ARCHIVE');assert.equal(b.articles.length,1);assert.equal(b.offerBySku.has('foreign'),false);assert.equal(b.offerBySku.get('old'),'A');
 assert.equal((await read('defly')).offerBySku.has('foreign'),false);assert.equal(reads,2);
 require('../src/lib/dataVersion').bump();await meta('defly');assert.equal(reads,4);
 await meta('alex');assert.equal(reads,6);
});
