// История в Postgres не зависит от скользящего окна внешней таблицы.
// Нет DELETE диапазона: входящие ключи обновляются атомарно, пропавшие ключи
// уже известного дня считаются неполной выгрузкой и блокируют весь импорт.
const {getPool}=require('../db');
const rowDiff=require('./rowDiff');
const TABLES=new Set(['finance_daily','buyout_daily','sales_geo_daily','stock_cluster_daily','search_query_daily']);
const ident=s=>{if(!/^[a-z_][a-z_0-9]*$/.test(s))throw Error('Некорректное имя колонки');return '"'+s+'"';};
let schema;
async function ensure(){
 if(!schema)schema=(async()=>{
  await getPool().query(`CREATE TABLE IF NOT EXISTS history_import_runs (id BIGSERIAL PRIMARY KEY, table_name TEXT NOT NULL, cabinet TEXT NOT NULL, date_from DATE NOT NULL, date_to DATE NOT NULL, incoming_rows INT NOT NULL, changed_rows INT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await getPool().query(`CREATE TABLE IF NOT EXISTS history_row_revisions (id BIGSERIAL PRIMARY KEY, import_id BIGINT NOT NULL REFERENCES history_import_runs(id), table_name TEXT NOT NULL, cabinet TEXT NOT NULL, row_date DATE NOT NULL, before_row JSONB NOT NULL, after_row JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await getPool().query(`CREATE INDEX IF NOT EXISTS history_row_revisions_lookup ON history_row_revisions(table_name,cabinet,row_date)`);
 })().catch(e=>{schema=null;throw e;});
 return schema;
}
function prepare(table,cabinet,rows,columns,conflict){
 if(!TABLES.has(table)||!columns.includes('cabinet')||!columns.includes('date')||!conflict.includes('date')||!conflict.includes('cabinet'))throw Error('Неизвестный формат истории');
 columns.forEach(ident);conflict.forEach(ident);
 if(conflict.some(c=>!columns.includes(c)))throw Error('Неполный ключ истории');
 const ci=columns.indexOf('cabinet'),di=columns.indexOf('date'),unique=new Map();
 for(const row of rows){
  if(!Array.isArray(row)||row.length!==columns.length||row[ci]!==cabinet||typeof row[di]!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(row[di])||!Number.isFinite(Date.parse(row[di]))||new Date(row[di]).toISOString().slice(0,10)!==row[di])throw Error('Некорректная строка истории: кабинет или дата');
  if(row.some(v=>typeof v==='number'&&!Number.isFinite(v))||conflict.some(c=>row[columns.indexOf(c)]==null))throw Error('Некорректное значение истории');
  const key=JSON.stringify(conflict.map(c=>row[columns.indexOf(c)]));
  if(unique.has(key))throw Error('Повтор ключа в исторической выгрузке');
  unique.set(key,Object.fromEntries(columns.map((c,i)=>[c,row[i]])));
 }
 return [...unique.values()];
}
async function importHistory(table,cabinet,rows,columns,conflict,skip=[],{partial=false}={}){
 const objects=prepare(table,cabinet,rows,columns,conflict);
 if(!objects.length)return 0;
 await ensure();
 const client=await getPool().connect();
 const cols=columns.map(ident).join(','),keys=conflict.map(ident).join(','),join=conflict.map(c=>`t.${ident(c)}=s.${ident(c)}`).join(' AND ');
 const significant=columns.filter(c=>!skip.includes(c)),arr=a=>'jsonb_build_array('+significant.map(c=>`${a}.${ident(c)}`).join(',')+')';
 const dates=objects.map(r=>r.date).sort();
 let changed=0;
 try{
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['history:'+table+':'+cabinet]);
  await client.query(`CREATE TEMP TABLE history_stage (LIKE ${ident(table)} INCLUDING DEFAULTS) ON COMMIT DROP`);
  for(let i=0;i<objects.length;i+=1000)await client.query(`INSERT INTO history_stage (${cols}) SELECT ${cols} FROM jsonb_populate_recordset(NULL::${ident(table)},$1::jsonb)`,[JSON.stringify(objects.slice(i,i+1000))]);
  const missing=(await client.query(`SELECT t.date::text AS date,COUNT(*)::int AS missing FROM ${ident(table)} t WHERE t.cabinet=$1 AND t.date IN (SELECT DISTINCT date FROM history_stage) AND NOT EXISTS (SELECT 1 FROM history_stage s WHERE ${join}) GROUP BY t.date ORDER BY t.date LIMIT 5`,[cabinet])).rows;
  if(!partial&&missing.length)throw Object.assign(Error(`Неполная выгрузка ${table} (${cabinet}): отсутствуют сохранённые строки за ${missing.map(r=>r.date+' ('+r.missing+')').join(', ')}. История не изменена.`),{code:'INCOMPLETE_HISTORY'});
  const run=(await client.query(`INSERT INTO history_import_runs(table_name,cabinet,date_from,date_to,incoming_rows) VALUES($1,$2,$3,$4,$5) RETURNING id`,[table,cabinet,dates[0],dates.at(-1),objects.length])).rows[0].id;
  await client.query(`INSERT INTO history_row_revisions(import_id,table_name,cabinet,row_date,before_row,after_row) SELECT $1,$2,$3,s.date,to_jsonb(t),to_jsonb(s) FROM history_stage s JOIN ${ident(table)} t ON ${join} WHERE ${arr('t')} IS DISTINCT FROM ${arr('s')}`,[run,table,cabinet]);
  const updated=columns.filter(c=>!conflict.includes(c)).map(c=>`${ident(c)}=EXCLUDED.${ident(c)}`).join(',');
  const result=await client.query(`INSERT INTO ${ident(table)} AS t (${cols}) SELECT ${cols} FROM history_stage WHERE true ON CONFLICT (${keys}) DO UPDATE SET ${updated} WHERE ${arr('t')} IS DISTINCT FROM ${arr('EXCLUDED')}`);
  changed=result.rowCount;
  await client.query('UPDATE history_import_runs SET changed_rows=$2 WHERE id=$1',[run,changed]);
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 rowDiff.drop(table+':'+cabinet);
 if(changed)require('./dataVersion').bump();
 return changed;
}
module.exports={importHistory,prepare};
