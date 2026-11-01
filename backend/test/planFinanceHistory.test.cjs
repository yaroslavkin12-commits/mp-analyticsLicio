const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../../google-apps-script/ozon-sheet-sync.gs'),'utf8');
const helpers=source.slice(source.indexOf('function syncFinancePlanHistory()'),source.indexOf('// ---------- Запись в таблицу',source.indexOf('function syncFinancePlanHistory()')));
test('Дозагрузка Ozon берёт три прошлых календарных месяца целиком и не трогает Licio',()=>{
 let dates;const ctx={Date,getCabinets_:()=>[{id:'defly'}],mskDate_:n=>n?'2026-10-31':'2026-11-01',runFinance_:v=>{dates=Array.from(v);}};vm.createContext(ctx);vm.runInContext(helpers,ctx);ctx.syncFinancePlanHistory();assert.equal(dates[0],'2026-08-01');assert.equal(dates.at(-1),'2026-10-31');assert.equal(dates.length,92);ctx.getCabinets_=()=>[{id:'licio'}];assert.throws(()=>ctx.syncFinancePlanHistory(),/Licio/);
});
test('Обычное обновление Finance сохраняет дозагрузку до чтения сервисом; другие вкладки — 45 дней',()=>{
 const fn=source.slice(source.indexOf('function replaceDates_('),source.indexOf('// Каждые 6 часов — последние 5 дней.',source.indexOf('function replaceDates_(')));let written;
 const ctx={Date,SHEET_NAMES:{finance:'Finance'},RETENTION_DAYS:45,Utilities:{formatDate:d=>d.toISOString().slice(0,10)},mskDate_:n=>n===124?'2026-06-30':'2026-09-17',getSheet_:()=>({getLastRow:()=>2,getRange:()=>({getValues:()=>[['2026-08-01',1]]})}),writeRows_:(name,headers,rows)=>{written=rows;}};vm.createContext(ctx);vm.runInContext(fn,ctx);ctx.replaceDates_('Finance',[],[],{},0);assert.equal(written.length,1);ctx.replaceDates_('Other',[],[],{},0);assert.equal(written.length,0);
});
