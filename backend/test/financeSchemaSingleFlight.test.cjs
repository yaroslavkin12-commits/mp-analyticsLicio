const {test}=require('node:test'),assert=require('node:assert/strict');let calls=0,fail=true;
const db=require.resolve('../src/db');require.cache[db]={id:db,filename:db,loaded:true,exports:{query:async()=>{calls++;await Promise.resolve();if(fail){fail=false;throw Error('Временная ошибка');}return [];}}};
const {ensureFinTables}=require('../src/collectors/ads/sheetSync');
test('Параллельное открытие отчётов и сбор кабинетов проверяют финансовую схему один раз; после ошибки возможен повтор',async()=>{
 await assert.rejects(ensureFinTables());assert.equal(calls,1);
 await Promise.all(Array.from({length:20},()=>ensureFinTables()));assert.equal(calls,9);
 await ensureFinTables();assert.equal(calls,9);
});
