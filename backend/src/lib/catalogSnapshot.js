// Один снимок справочника для параллельных финансовых/исторических отчётов.
// Строители отчётов получают новые карты: добавление архивного артикула
// в одном отчёте не изменяет индексы и категории другого.
const {query}=require('../db');
const {OV_SQL,overrideArgs}=require('./categories');
const cache=new Map();
async function read(cabinet){
 const version=require('./dataVersion').get(),hit=cache.get(cabinet);
 if(hit&&hit.version===version&&Date.now()-hit.at<300000)return hit.promise;
 const promise=Promise.all([
  query("SELECT offer_id,sku,product_name FROM ad_product_catalog WHERE cabinet=$1 AND platform='ozon'",[cabinet]),
  query(OV_SQL,overrideArgs(cabinet))
 ]).then(async([catalog,overrides])=>({catalog,overrides,offerBySku:await require('./skuAlias').extend(new Map(catalog.filter(r=>r.sku!=null).map(r=>[String(r.sku),r.offer_id])),cabinet)}));
 const entry={version,at:Date.now(),promise};cache.set(cabinet,entry);while(cache.size>8)cache.delete(cache.keys().next().value);
 promise.catch(()=>{if(cache.get(cabinet)===entry)cache.delete(cabinet);});return promise;
}
module.exports={read};
