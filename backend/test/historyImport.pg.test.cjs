const {test}=require('node:test'),assert=require('node:assert/strict');
const pgPath=process.env.HISTORY_TEST_PGLITE;
test('PostgreSQL: полный импорт, откат сбоя, запрет усечения и сохранение годовой истории', {skip:!pgPath}, async()=>{
 const {PGlite}=require(pgPath),db=await PGlite.create();let fail=false,failStock=false;
 const run=async(sql,args)=>{if(failStock&&sql.startsWith('INSERT INTO ad_product_stocks'))throw Error('Сбой остатков');if(fail&&sql.startsWith('INSERT INTO "finance_daily" AS t'))throw Error('Сбой записи');const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows};};
 const client={query:run,release(){}},pool={query:run,connect:async()=>client};
 require.cache[require.resolve('../src/db')]={exports:{getPool:()=>pool}};
 const {importHistory,prepare}=require('../src/lib/historyImport');
 const cols=['cabinet','date','sku','name','amount','qty'],key=cols.slice(0,4),r=(d,sku,a=100,q=1)=>['defly',d,sku,'Продажа',a,q];
 try{
  await db.exec(`CREATE TABLE finance_daily(cabinet TEXT NOT NULL,date DATE NOT NULL,sku TEXT NOT NULL,name TEXT NOT NULL,amount NUMERIC(14,2),qty NUMERIC(10,2),PRIMARY KEY(cabinet,date,sku,name))`);
  await importHistory('finance_daily','defly',[r('2025-11-02','old'),r('2026-11-02','1'),r('2026-11-02','2')],cols,key);
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM finance_daily')).rows[0].n,3);
  await assert.rejects(importHistory('finance_daily','defly',[r('2026-11-02','1',50)],cols,key),{code:'INCOMPLETE_HISTORY'});
  assert.equal(Number((await db.query("SELECT amount FROM finance_daily WHERE sku='1'")).rows[0].amount),100);
  fail=true;await assert.rejects(importHistory('finance_daily','defly',[r('2026-11-02','1',90),r('2026-11-02','2')],cols,key),/Сбой/);fail=false;
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM history_row_revisions')).rows[0].n,0);
  assert.equal(Number((await db.query("SELECT amount FROM finance_daily WHERE sku='1'")).rows[0].amount),100);
  assert.equal(await importHistory('finance_daily','defly',[r('2026-11-02','1',90),r('2026-11-02','2')],cols,key),1);
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM history_row_revisions')).rows[0].n,1);
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM finance_daily WHERE date='2025-11-02'")).rows[0].n,1);
  assert.equal(await importHistory('finance_daily','defly',[r('2026-11-02','1',90),r('2026-11-02','2')],cols,key),0);
  await importHistory('finance_daily','defly',[r('2026-11-02','1',80)],cols,key,[],{partial:true});
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM finance_daily')).rows[0].n,3);
  assert.throws(()=>prepare('finance_daily','defly',[r('2026-02-31','bad')],cols,key));
  await db.exec(`CREATE TABLE ad_product_stocks(id BIGSERIAL PRIMARY KEY,cabinet TEXT,platform TEXT,snapshot_date DATE,sku BIGINT,offer_id TEXT,fbo_present INT,fbo_reserved INT,fbs_present INT,fbs_reserved INT)`);
  const {saveStockSnapshot}=require('../src/lib/stockSnapshot'),stock=(date,offer,q)=>['defly','ozon',date,null,offer,q,0,0,0];
  await saveStockSnapshot('defly','2025-11-02',[stock('2025-11-02','old',10)]);
  await saveStockSnapshot('defly','2026-11-02',[stock('2026-11-02','own',10)]);
  failStock=true;await assert.rejects(saveStockSnapshot('defly','2026-11-02',[stock('2026-11-02','own',20)]),/Сбой/);failStock=false;
  assert.equal((await db.query("SELECT fbo_present FROM ad_product_stocks WHERE offer_id='own'")).rows[0].fbo_present,10);
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM ad_product_stocks WHERE snapshot_date='2025-11-02'")).rows[0].n,1);
  await assert.rejects(saveStockSnapshot('defly','2026-11-02',[stock('2026-11-02','other',20)]),/Неполная/);
  // Те же SQL-операции накопления WB; предыдущий год остаётся в текущем отчёте.
  await db.exec(`CREATE TABLE wb_bridge_data(cabinet TEXT,kind TEXT,run_id TEXT,collected_at TIMESTAMPTZ,meta JSONB,rows JSONB,PRIMARY KEY(cabinet,kind))`);
  const wh=require('../src/lib/wbHistory');await wh.ensureWbHistory(run);
  const old={cabinet:'defly_wb',kind:'finance',from:'2025-11-01',to:'2025-11-30',total:1},next={...old,from:'2026-11-01',to:'2026-11-16',total:1};
  await run('INSERT INTO wb_bridge_data VALUES($1,$2,$3,$4,$5,$6)',['defly_wb','finance','old','2025-12-01',JSON.stringify(old),JSON.stringify([{id:'old',rrDate:'2025-11-02',quantity:1}])]);
  await run('BEGIN');await wh.captureWbHistory(client,next);
  await run('UPDATE wb_bridge_data SET run_id=$1,collected_at=$2,meta=$3,rows=$4',['new','2026-11-17',JSON.stringify(next),JSON.stringify([{id:'new',rrDate:'2026-11-02',quantity:2}])]);
  await wh.accumulateWbHistory(client,next,{meta:old});await run('COMMIT');
  const accumulated=(await db.query('SELECT meta,rows FROM wb_bridge_data')).rows[0];
  assert.equal(accumulated.rows.length,2);assert.equal(accumulated.meta.from,'2025-11-01');assert.equal(accumulated.meta.total,2);assert.equal(accumulated.meta.sourceTotal,1);
  await run('BEGIN');await run('UPDATE wb_bridge_data SET collected_at=$1,rows=$2',['2026-11-18',JSON.stringify([{id:'old',rrDate:'2025-11-02',quantity:3},{id:'new',rrDate:'2026-11-02',quantity:2}])]);
  await wh.captureWbHistory(client,next);await run('COMMIT');
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM wb_history_revisions')).rows[0].n,1);
  assert.equal((await db.query("SELECT value FROM wb_history_rows WHERE id='old'")).rows[0].value.quantity,3);
 }finally{await db.close();}
});
