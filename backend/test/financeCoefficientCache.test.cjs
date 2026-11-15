const {test}=require('node:test'),assert=require('node:assert/strict');
let calls=0;
const db=require.resolve('../src/db');require.cache[db]={id:db,filename:db,loaded:true,exports:{query:async()=>{calls++;return [];}}};
const {loadCoefs}=require('../src/routes/finance'),version=require('../src/lib/dataVersion');
test('Общие коэффициенты: одновременные сводка и история не дублируют запросы; кабинеты и изменения отделены',async()=>{
 const [a,b]=await Promise.all([loadCoefs({cabinet:'defly'}),loadCoefs({cabinet:'defly'})]);assert.equal(a,b);const first=calls;
 assert.equal(await loadCoefs({cabinet:'defly'}),a);assert.equal(calls,first);
 const other=await loadCoefs({cabinet:'alex'});assert.notEqual(other,a);assert.ok(calls>first);
 const before=calls;version.bump();const changed=await loadCoefs({cabinet:'defly'});assert.notEqual(changed,a);assert.ok(calls>before);
});
