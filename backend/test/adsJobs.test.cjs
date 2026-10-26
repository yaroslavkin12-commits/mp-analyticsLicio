const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function scheduler(){
 const calls=[];let active=0,maxActive=0;
 const collect=name=>async (cabinet,options)=>{active++;maxActive=Math.max(maxActive,active);calls.push([cabinet,name,options]);await new Promise(r=>setTimeout(r,2));active--;return{rows:1}};
 const sheet=new Proxy({sheetId:()=> 'configured-sheet'}, {get:(o,k)=>o[k]||collect(k)});
 const mocks={
  '../../db':{query:async(sql,p)=>{if(sql.startsWith('SELECT * FROM ad_job_status'))return [];
   if(sql.startsWith('SELECT COUNT'))return[{n:1}];if(sql.startsWith('SELECT 1'))return[{}];return[]}},
  '../../config/cabinets':{CABINETS:{licio:{},defly:{},nabauto:{sheetOnly:true},off:{sheetOnly:true}},isConnected:id=>id!=='off'},
  './sheetSync':sheet,'./ozonHttp':{mskDate:()=> '2026-10-26'},
  './ozonCatalog':{},'./ozonPerf':{},'./ozonClicks':{},'./ozonProductAnalytics':{},'./ozonProductStocks':{},
  './ozonDiscounts':{},'./discountSettings':{},'../../telegram':{},'../../digest':{},'../trackedOrdersPoll':{},'../../lib/rowDiff':{dropCabinet:()=>{}}
 };
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../src/collectors/ads/jobs'),'utf8'),{module,exports:module.exports,require:p=>Object.hasOwn(mocks,p)?mocks[p]:require(p),console:{log(){},warn(){},error(){}},setTimeout,clearTimeout,setInterval,Date,Map,Set,Promise});
 return{...module.exports,calls,max:()=>maxActive};
}
async function idle(s,ids){for(let i=0;i<300;i++){if(ids.every(c=>!s.currentJob(c)))return;await new Promise(r=>setTimeout(r,5))}throw Error('Очередь не завершилась')}
test('Licio включён в автообновление из таблицы без серверных ключей; финансы используют облегчённый импорт',async()=>{
 const s=scheduler();assert.deepEqual(Array.from(s.adsCabinets()),['licio','defly','nabauto']);
 assert.ok(s.jobsForCabinet('licio').some(j=>j.id==='finance'));assert.ok(s.jobsForCabinet('defly').some(j=>j.id==='finance'));
 s.requestRefresh('licio',30);await idle(s,['licio']);
 for(const name of ['syncCatalogFromSheet','syncStatsFromSheet','syncAnalyticsFromSheet','syncStocksFromSheet','syncAdDetailsFromSheet'])assert.ok(s.calls.some(([c,n])=>c==='licio'&&n===name),name);
 assert.ok(s.calls.some(([c,n,o])=>c==='licio'&&n==='syncFinanceFromSheet'&&o.coreOnly===true));
});
test('Одновременные ручные обновления магазинов выполняются по очереди; Defly сохраняет финансовый импорт',async()=>{
 const s=scheduler();s.requestRefresh('licio',30);s.requestRefresh('defly',30);await idle(s,['licio','defly']);
 const shops=s.calls.map(x=>x[0]);assert.equal(shops.lastIndexOf('licio')<shops.indexOf('defly'),true);
 assert.ok(s.calls.some(([c,n,o])=>c==='defly'&&n==='syncFinanceFromSheet'&&o.coreOnly===false));
 assert.equal(s.max(),4,'Параллельны только четыре части рекламы одного магазина');
});
