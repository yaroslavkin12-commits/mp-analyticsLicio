const {test}=require('node:test');const assert=require('node:assert/strict');
test('Срочность выше рекламы; внутри уровня реклама, дефицит и рост; неизвестное не равно нулю',async()=>{
 const {priority2d}=await import('../../dashboard/src/lib/deflectors2d.mjs');const s={leadDays:7,periodDays:7};
 const row=(cover,favorite,trend7)=>priority2d({stock:cover*2,transit:0,rate:2,cover,favorite,trend7},s);
 const urgent=row(0,false,100),promoted=row(7,true,50),safe=row(20,true,0);
 assert.equal(urgent.priority,'Срочно');assert.equal(urgent.priorityScore,3090);assert.equal(promoted.priorityScore,2145);assert(urgent.priorityScore>promoted.priorityScore);assert(promoted.priorityScore>safe.priorityScore);
 assert(row(3,true,-20).priorityScore>row(3,false,100).priorityScore);
 assert(row(2,true,100).priorityScore>row(2,true,-20).priorityScore);
 assert.equal(row(2,true,200).priorityScore,row(2,true,100).priorityScore);
 assert.equal(priority2d({stock:null,transit:0,rate:2},s).priorityScore,null);
 assert.equal(priority2d({stock:0,transit:0,rate:0,favorite:false},s).priority,'Хватает');
});
