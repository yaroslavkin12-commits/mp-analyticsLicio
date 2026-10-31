const {test}=require('node:test'),assert=require('node:assert/strict');
const {wbShopSummary}=require('../src/lib/shopsSummary');
const ds=()=>[{kind:'catalog',rows:[{offer:'A',nmId:1,name:'Дефлекторы окон 2D'}],meta:{}},{kind:'orders',meta:{from:'2026-10-01',to:'2026-10-10'},rows:[{id:'one',srid:'one',nmId:1,date:'2026-10-10',price:100},{id:'two',nmId:1,date:'2026-10-10',price:200,cancelled:true},{id:'self',srid:'self',nmId:1,date:'2026-10-10',price:300},{id:'previous',nmId:1,date:'2026-10-09',price:50}]}];
test('Сводка WB повторяет аналитику: без отмен и самовыкупов, с категориями и предыдущим периодом',()=>{
 const s=wbShopSummary(ds(),{self:{'self|1':true}},{from:'2026-10-10',to:'2026-10-10'});
 assert.equal(s.platform,'wb');assert.equal(s.cur.q,1);assert.equal(s.cur.r,100);assert.equal(s.prev.q,1);assert.equal(s.prev.r,50);assert.deepEqual(s.cur.byPath['Дефлекторы / Окна / 2D'],[1,100]);
});
test('WB: неполный период и неизвестная цена в сводке не превращаются в нули',()=>{
 const input=ds();input[1].rows[0].price=null;
 const s=wbShopSummary(input,{self:{'self|1':true}},{from:'2026-10-10',to:'2026-10-10'});
 assert.equal(s.cur.q,1);assert.equal(s.cur.r,null);
 const unknown=wbShopSummary(input,{}, {from:'2026-09-30',to:'2026-10-10'});
 assert.equal(unknown.cur.q,null);assert.equal(unknown.cur.r,null);assert.equal(unknown.cur.complete,false);
});
