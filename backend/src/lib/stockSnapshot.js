const {getPool}=require('../db');
const cols=['cabinet','platform','snapshot_date','sku','offer_id','fbo_present','fbo_reserved','fbs_present','fbs_reserved'];
async function saveStockSnapshot(cabinet,date,rows){
 if(!rows.length)return 0;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||rows.some(r=>r.length!==cols.length||r[0]!==cabinet||r[1]!=='ozon'||r[2]!==date||!r[4]||r.slice(5).some(v=>!Number.isFinite(Number(v)))))throw Error('Некорректная выгрузка остатков');
 const client=await getPool().connect();
 try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['stock:'+cabinet+':'+date]);
  const old=(await client.query('SELECT DISTINCT offer_id FROM ad_product_stocks WHERE cabinet=$1 AND platform=\'ozon\' AND snapshot_date=$2',[cabinet,date])).rows;
  const offers=new Set(rows.map(r=>r[4]));
  if(old.some(r=>!offers.has(r.offer_id)))throw Error('Неполная выгрузка остатков: часть сохранённых артикулов отсутствует. Предыдущий снимок сохранён.');
  await client.query('DELETE FROM ad_product_stocks WHERE cabinet=$1 AND platform=\'ozon\' AND snapshot_date=$2',[cabinet,date]);
  for(let i=0;i<rows.length;i+=1000)await client.query(`INSERT INTO ad_product_stocks (${cols.join(',')}) SELECT ${cols.join(',')} FROM jsonb_populate_recordset(NULL::ad_product_stocks,$1::jsonb)`,[JSON.stringify(rows.slice(i,i+1000).map(r=>Object.fromEntries(cols.map((c,k)=>[c,r[k]]))))]);
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 require('./dataVersion').bump();return rows.length;
}
module.exports={saveStockSnapshot};
