const {test}=require('node:test');const assert=require('node:assert/strict');let reads=0;
require.cache[require.resolve('../src/db')]={exports:{query:async(sql)=>{if(sql.includes("kind <> 'finance'")){reads++;await new Promise(resolve=>setTimeout(resolve,5));return [{kind:'orders',meta:{runId:'one'},rows:[{id:'a'}]}];}return [];}}};
const bridge=require('../src/lib/wbBridge');
test('WB: параллельные страницы читают один сохранённый набор; добавление финансов не меняет кэш',async()=>{
 const result=await Promise.all([bridge.read({excludeFinance:true}),bridge.read({excludeFinance:true}),bridge.read({excludeFinance:true})]);assert.equal(reads,1);result[0].push({kind:'finance'});assert.equal((await bridge.read({excludeFinance:true})).length,1);assert.equal(reads,1);
});
