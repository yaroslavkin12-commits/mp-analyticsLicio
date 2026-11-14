const { test }=require('node:test');const assert=require('node:assert/strict');
const OWN='OWN-2D', OTHER='PRIVATE-COVER', THIRD='OWN-3D', CLOTH='SHIRT', PATH='Дефлекторы / Окна / 2D';
let moved=false, unavailable=false;
const rows=[{offer_id:OWN,sku:101,product_name:'Дефлектор 2D'},{offer_id:OTHER,sku:202,product_name:'Чехол'},{offer_id:THIRD,sku:303,product_name:'Дефлектор 3D'}];
require.cache[require.resolve('../src/db')]={exports:{query:async(sql,args=[])=>{
 if(unavailable)throw Error('private db details');
 if(sql.includes('product_category_override'))return [{offer_id:OWN,path:moved?'Чехлы':PATH},{offer_id:OTHER,path:'Чехлы'},{offer_id:THIRD,path:'Дефлекторы / Окна / 3D'}];
 if(sql.includes('FROM ad_product_catalog'))return args[0]==='licio'?[{offer_id:CLOTH,product_name:'Футболка',sku:404}]:rows;
 if(sql.includes('SELECT rows FROM wb_bridge_data'))return [{rows:rows.map(r=>({offer:r.offer_id,nmId:r.sku,name:r.product_name}))}];
 if(sql.includes('SELECT value FROM app_settings'))return [{value:JSON.stringify({categories:{[OWN]:PATH,[OTHER]:'Чехлы',[THIRD]:'Дефлекторы / Окна / 3D'}})}];
 return [];
}}};
const access=require('../src/lib/categoryAccess');
const scope=access.normalize({paths:[PATH]});
const context={cabinet:'defly',scope,allowed:new Map([[OWN,{path:PATH}]])};
const articles=[{o:OWN,n:'Дефлектор',cat:PATH},{o:OTHER,n:'PRIVATE-COVER',cat:'Чехлы'},{o:THIRD,n:'3D',cat:'Дефлекторы / Окна / 3D'}];
const arrayRows=[[0,0,7,700],[1,0,999999,999999],[2,0,9,900]];
const secret=out=>assert.ok(!JSON.stringify(out).includes('PRIVATE-COVER')&&!JSON.stringify(out).includes('999999'));
async function dispatch(path, method='GET', cabinet='defly', data={articles,rows:arrayRows,stock:[],prev:[],self:[],dates:['2026-11-14']}) {
 let code=200,body,called=false;const headers={};
 const res={statusCode:200,status(n){code=n;this.statusCode=n;return this;},set(k,v){headers[k]=v;return this;},type(){return this;},send(v){body=JSON.parse(v);return this;},json(v){body=v;return this;}};
 await access.middleware()({path,method,query:{cabinet},user:{id:3,role:'user',accessScope:scope}},res,()=>{called=true;res.set('Cache-Control','private,max-age=300');res.json({success:true,data});});
 return {code,body,called,headers};
}
test('Права нормализуются по границам веток, а одежда отделена от автомобильных категорий',()=>{
 assert.deepEqual(access.normalize({paths:['Дефлекторы',' Дефлекторы / Окна / 2D ']}).paths,['Дефлекторы']);
 assert.equal(access.inPath('Дефлекторы / Окна / 2D','Дефлекторы / Окна'),true);
 assert.equal(access.inPath('Дефлекторы / Окна / 2D extra',PATH),false);
 assert.equal(access.cabinets(access.normalize({paths:['Одежда']})).includes('licio'),true);
 assert.equal(access.cabinets(scope).includes('licio'),false);
 assert.deepEqual(access.publicScope({bad:true}).cabinets,[]);
});
test('Отчёты переиндексируют товары и все числовые массивы; исходный общий кэш не меняется',()=>{
 const original={articles,dates:['2026-11-14'],rows:arrayRows,stock:arrayRows,prev:arrayRows,self:arrayRows,unallocated:{cur:999999},secret:'PRIVATE-COVER'};
 const before=JSON.stringify(original),out=access.projection('/sales/data',original,context);
 assert.equal(out.articles.length,1);assert.deepEqual(out.rows,[[0,0,7,700]]);assert.equal(out.unallocated.cur,0);secret(out);assert.equal(JSON.stringify(original),before);
 const shifted=access.projection('/sales/data',{...original,articles:[articles[1],articles[0]],rows:[[1,0,2],[0,0,999999]]},context);
 assert.deepEqual(shifted.rows,[[0,0,2]]);
});
test('Финансы, выкупы, остатки, сезонность и база цен не передают строки других артикулов и общие суммы',()=>{
 const d={articles,dates:['2026-11-14'],rows:arrayRows,coefs:arrayRows,a:arrayRows,ads:arrayRows,taxBase:arrayRows,self:arrayRows,stock:arrayRows,hist:arrayRows,cl:arrayRows,demand:arrayRows,orders:arrayRows,fbs:arrayRows,clHist:arrayRows,prev:arrayRows,fbsDays:arrayRows,cost:[1,999999,3],noSku:[999999],adNoSku:[999999],names:[['PRIVATE-COVER',999999]],totalSale:999999};
 for(const path of ['/finance/pnl','/finance/coefs','/finance/calc-base','/finance/buyout','/stocks/data','/queries/season']){const out=access.projection(path,d,context);secret(out);assert.equal(out.articles.length,1);}
 assert.deepEqual(access.projection('/finance/pnl',d,context).cost,[1]);
});
test('Чужие товары исключены из рекламы, склеек, групп, цен, истории и выгрузочных карт',()=>{
 const ad={dates:['2026-11-14'],articles:[{offerId:OWN,productName:'Дефлектор',totals:{orders:7},byDate:{},associated:[{offerId:OTHER,productName:'PRIVATE-COVER'}],campaigns:[{campaignId:'c',name:'PRIVATE-COVER',budget:999999,status:'active'}]},{offerId:OTHER,productName:'PRIVATE-COVER'}],cpoCharge:[[OWN,'2026-11-14',5],[OTHER,'2026-11-14',999999]],catOfOffer:{[OTHER]:{cat:'Чехлы'}}};
 secret(access.projection('/promo/stats',ad,context));
 const groups=access.projection('/promo/groups',{groups:[{id:'a',name:'Свои'},{id:'b',name:'PRIVATE-COVER'}],members:{[OWN]:'a',[OTHER]:'b'}},context);
 assert.equal(groups.groups.length,1);secret(groups);
 secret(access.projection('/pricelog/dynamics',{items:{[OWN]:[[0,10]],[OTHER]:[[0,999999]]}},context));
 secret(access.projection('/discounts/overview',{items:[{o:OWN,orders30:1},{o:OTHER,orders30:999999}],unknown:'PRIVATE-COVER'},context));
 secret(access.projection('/discounts/history',{rows:[[OWN,0,10],[OTHER,0,999999]],base:[[OTHER,999999]]},context));
 secret(access.projection('/orders/feed',{rows:[{o:OWN,price:100},{o:OTHER,price:999999}],summary:999999},context));
});
test('Прямые обращения к сырым данным WB, общим отчётам, журналу владельца и неизвестным API запрещены',async()=>{
 for(const path of ['/api/wb/data','/api/sales/summary','/api/auth/activity/report','/api/env-check','/api/plan/ozon','/api/settings/costs','/api/anything']){
  const r=await dispatch(path);assert.equal(r.code,403,path);assert.equal(r.called,false);
 }
 for(const path of ['/api/sales/category','/API/ORDERS/self','/api/production'])assert.equal((await dispatch(path,'POST')).code,403);
 assert.equal((await dispatch('/api/sales/data','GET','licio')).code,403);
 assert.equal((await dispatch('/api/sales/data','GET',['defly'])).code,403);
});
test('Регистровые варианты путей сохраняют ограничения; браузерный кэш не хранит данные профиля',async()=>{
 const r=await dispatch('/API/SALES/DATA/');assert.equal(r.code,200);assert.equal(r.called,true);secret(r.body);
 assert.equal(r.headers['Cache-Control'],'no-store');assert.equal(r.headers.Vary,'Cookie');
});
test('Проверка использует актуальную ручную категорию; ошибка источника закрывает доступ вместо выдачи полного отчёта',async()=>{
 moved=true;const r=await dispatch('/api/sales/data');assert.equal(r.code,200);assert.equal(r.body.data.articles.length,0);moved=false;
 unavailable=true;const failed=await dispatch('/api/sales/data');assert.equal(failed.code,503);assert.equal(failed.called,false);assert.ok(!JSON.stringify(failed).includes('private db'));unavailable=false;
});
test('Одежда доступна только в своём направлении, WB обрабатывается теми же правилами категорий',async()=>{
 const clothing=await access.context('licio',access.normalize({paths:['Одежда / Футболки']}));assert.equal(clothing.allowed.has(CLOTH),true);assert.equal(clothing.allowed.has(OWN),false);
 const wb=await access.context('defly_wb',scope);assert.equal(wb.allowed.has(OWN),true);assert.equal(wb.allowed.has(OTHER),false);
});
test('Неизвестный формат успешного ответа не проходит без фильтра',async()=>{
 const r=await dispatch('/api/sales/data','GET','defly',{secret:'PRIVATE-COVER'});assert.equal(r.code,403);assert.ok(!JSON.stringify(r.body).includes('PRIVATE-COVER'));
});
