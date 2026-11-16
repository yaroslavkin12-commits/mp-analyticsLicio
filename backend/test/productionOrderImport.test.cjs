const { test } = require('node:test'), assert = require('node:assert/strict');
const { replaceProductionOrder } = require('../src/lib/productionOrderReplace');
const old = { id:'order1', date:'2026-11-12', savedAt:'2026-11-12T10:00:00Z', shop:'Цех', pcs:20, tasks:2, items:[['A',10,1,5,7,2],['B',10,1,4,8,0]] };
test('Исправление Excel заменяет состав без дубликата, сохраняет дату и исходные остатки', () => {
 const other={...old,id:'order2'};
 const next=replaceProductionOrder([old,other],{id:old.id,expected:old,items:[['A',3,1],['C',10,1]],file:'Правки.xlsx'},{C:{}});
 assert.equal(next.length,2);assert.equal(next[1],other);assert.equal(next[0].savedAt,old.savedAt);assert.equal(next[0].date,old.date);assert.equal(next[0].pcs,13);
 assert.deepEqual(next[0].items,[['A',3,1,5,7,2],['C',10,1,null,null,0]]);assert.equal(old.pcs,20);
});
test('Устаревший, пустой или повреждённый импорт не заменяет заказ', () => {
 const apply=items=>replaceProductionOrder([old],{id:old.id,expected:old,items},{});
 assert.throws(()=>apply([]));assert.throws(()=>apply([['A',-2,1]]));assert.throws(()=>apply([['X',2,1]]));assert.throws(()=>apply([['A',2,1],['A',3,1]]));
 assert.throws(()=>replaceProductionOrder([old],{id:old.id,expected:{...old,pcs:1},items:[['A',2,1]]},{}),{status:409});
});
test('Оба формата выгрузки читаются, нули убираются, неизвестные и дубликаты отклоняются', async()=>{
 const {parseProductionOrder:parse}=await import('../../dashboard/src/lib/productionOrderImport.mjs');
 const known=new Set(['A','B']);
 assert.deepEqual(parse([['Артикул','Наименование','Кол-во, шт','Заданий'],['A','Товар',12,2],['B','Товар',0,0]],known,()=>10),[['A',12,2]]);
 assert.deepEqual(parse([['Артикул','Наименование','Цех','Материал','Кол-во, шт','Кол-во заданий'],['A','Товар','Цех','',12,2]],known,()=>10),[['A',12,2]]);
 assert.deepEqual(parse([['Артикул','Количество'],['A',12]],known,()=>10),[['A',12,2]]);
 assert.throws(()=>parse([['Артикул','Количество'],['X',2]],known,()=>10));
 assert.throws(()=>parse([['Артикул','Количество'],['A',2],['A',3]],known,()=>10));
 assert.throws(()=>parse([['Артикул','Количество'],['A','']],known,()=>10));
});
