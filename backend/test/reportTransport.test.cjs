const {test}=require('node:test'),assert=require('node:assert/strict');let mode='ok',seen=[],native=0;
const driver=require.resolve('@neondatabase/serverless');require.cache[driver]={id:driver,filename:driver,loaded:true,exports:{neon:(url,options)=>{assert.equal(options.types,require('pg').types);return {query:(sql,params)=>({sql,params}),transaction:async(queries,options)=>{assert.equal(options.readOnly,true);seen.push(queries[0]);if(mode==='sql')throw Object.assign(Error('SQL'),{code:'42P01'});if(mode==='network')throw Error('network');return [[{amount:'12.34',qty:2}]];}};}}};
const t=require('../src/lib/reportTransport');
test('Ускоренный транспорт разрешён только для чтения аналитики своего Neon, не для записи, сессий и блокировок',()=>{
 const url='postgres://test:placeholder@ep-test.neon.tech/db';
 assert.equal(t.eligible('SELECT * FROM finance_daily',url),true);
 for(const sql of ['UPDATE finance_daily SET qty=0','SELECT * FROM app_sessions','SELECT * FROM finance_daily FOR UPDATE','SELECT pg_advisory_lock(1) FROM finance_daily'])assert.equal(t.eligible(sql,url),false);
 assert.equal(t.eligible('SELECT * FROM finance_daily','postgres://localhost/db'),false);assert.equal(t.eligible('SELECT * FROM finance_daily',url,'0'),false);
});
test('Чтение сохраняет параметры и типы pg, SQL-ошибки не скрываются, сеть имеет прежний резервный путь',async()=>{
 const saved=process.env.DATABASE_URL;process.env.DATABASE_URL='postgres://test:placeholder@ep-test.neon.tech/db';
 const fallback=async()=>{native++;return [{amount:'legacy'}];};
 try{
  const rows=await t.run('SELECT * FROM finance_daily WHERE cabinet=$1',['defly'],fallback);assert.deepEqual(rows,[{amount:'12.34',qty:2}]);assert.deepEqual(seen[0].params,['defly']);assert.equal(native,0);
  mode='sql';await assert.rejects(t.run('SELECT * FROM finance_daily',[],fallback),e=>e.code==='42P01');assert.equal(native,0);
  mode='network';assert.deepEqual(await t.run('SELECT * FROM finance_daily',[],fallback),[{amount:'legacy'}]);assert.equal(native,1);
  mode='ok';await t.run('SELECT * FROM finance_daily',[],fallback);assert.equal(native,2);assert.equal(t.diagnostics().active,0);
 }finally{if(saved===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=saved;}
});
