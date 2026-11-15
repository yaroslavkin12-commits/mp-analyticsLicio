const {test}=require('node:test'),assert=require('node:assert/strict');const {historyRange}=require('../src/lib/discountHistoryRange');
test('Календарь соинвеста разрешает сентябрь и историю длиннее 90 дней',()=>{
 const r=historyRange({dateFrom:'2026-09-01',dateTo:'2026-11-15'});assert.equal(r.dates.length,76);assert.equal(r.dates[0],'2026-09-01');assert.equal(r.dates.at(-1),'2026-11-15');
});
test('Период по умолчанию использует московскую дату и не принимает несуществующие даты',()=>{
 assert.equal(historyRange({},new Date('2026-11-14T22:00:00Z')).to,'2026-11-15');
 for(const q of [{dateFrom:'2026-02-30',dateTo:'2026-03-01'},{dateFrom:'2026-11-16',dateTo:'2026-11-15'},{dateFrom:'2026-09-01'}])assert.throws(()=>historyRange(q),{status:400});
});
