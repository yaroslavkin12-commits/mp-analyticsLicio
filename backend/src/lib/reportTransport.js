// Аналитические SELECT к Neon читаются через его HTTPS SQL API. Запись и
// транзакции сохраняют прежнее соединение pg; типы значений берём из pg.
const {types}=require('pg');
const TABLES=/\b(?:finance_daily|buyout_daily|wb_bridge_data|product_analytics_daily|ad_product_catalog|ad_stats_daily|ad_sku_stats_daily|ad_cpo_orders|ad_product_stocks|product_prices|product_costs|product_discount_latest|product_category_override|sku_alias)\b/i;
function eligible(sql,url=process.env.DATABASE_URL,enabled=process.env.MP_NEON_HTTP_READS){
 if(enabled==='0'||!/^\s*SELECT\b/i.test(sql)||!TABLES.test(sql)||/\bFOR\s+(UPDATE|SHARE)\b|pg_advisory/i.test(sql))return false;
 try{return new URL(url).hostname.endsWith('.neon.tech');}catch{return false;}
}
let client,connection,blockedUntil=0,active=0,used=0,fallbacks=0;const waiting=[];
async function acquire(){if(active>=4)await new Promise(resolve=>waiting.push(resolve));else active++;return()=>{const next=waiting.shift();if(next)next();else active--;};}
async function run(sql,params,native){
 if(!eligible(sql)||Date.now()<blockedUntil)return native();
 const release=await acquire();
 try{
  if(Date.now()<blockedUntil)return native();
  const url=process.env.DATABASE_URL;
  if(!client||connection!==url){client=require('@neondatabase/serverless').neon(url,{types});connection=url;}
  used++;
  const [rows]=await client.transaction([client.query(sql,params)],{readOnly:true,fetchOptions:{signal:AbortSignal.timeout(15000)}});
  return rows;
 }catch(e){
  // Ошибку SQL не повторяем другим способом. При недоступности транспорта
  // SELECT безопасно читается прежним драйвером; дальнейшие попытки ждут.
  if(/^[0-9A-Z]{5}$/.test(e.code||''))throw e;
  blockedUntil=Date.now()+60000;fallbacks++;return native();
 }finally{release();}
}
module.exports={eligible,run,diagnostics:()=>({used,fallbacks,active,waiting:waiting.length,temporarilyDisabled:Date.now()<blockedUntil})};
