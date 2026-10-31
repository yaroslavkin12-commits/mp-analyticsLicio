const {test}=require('node:test');const assert=require('node:assert/strict');
test('Неполный период: известные дни складываются, отсутствие всех данных не превращается в ноль',async()=>{
 const {sumAvailable}=await import('../../dashboard/src/lib/availableSum.js');
 assert.equal(sumAvailable([100,200,NaN]),300);assert.equal(sumAvailable([0,NaN]),0);assert.equal(sumAvailable([-100,20,null]),-80);assert(Number.isNaN(sumAvailable([null,undefined,NaN])));assert(Number.isNaN(sumAvailable([])));
});
