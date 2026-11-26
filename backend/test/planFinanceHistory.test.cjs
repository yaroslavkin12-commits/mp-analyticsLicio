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

test('Сегодняшние начисления Ozon заменяют только полный снимок конкретного кабинета', () => {
 const today = '2026-11-26', yesterday = '2026-11-25';
 const original = [['defly', yesterday, '1', 'Продажа', 150, 1], ['defly', today, '1', 'Продажа', 100, 1],
   ['alex', today, '2', 'Продажа', 200, 1], ['nabauto', today, '3', 'Продажа', 300, 1]];
 let written, released = false, locked = true;
 const ctx = {
   Date, SHEET_NAMES:{finance:'Finance'}, FINANCE_HEADERS: ['cabinet','date','sku','type','amount','qty'],
   mskDate_: days => days ? '2026-07-25' : today,
   getCabinets_: () => ['defly','alex','nabauto'].map(id => ({id})), sellerHeaders_: () => ({}),
   collectFinance_: (cab, days, rows, started, done) => {
     assert.deepEqual(Array.from(days), [today]);
     if (cab.id === 'alex') return; // Неполный ответ.
     done[today] = true;
     if (cab.id === 'defly') rows.row = ['defly', today, '1', 'Продажа', 250, 2];
   },
   LockService: { getDocumentLock: () => ({tryLock: () => locked, releaseLock: () => { released = true; }}) },
   Logger: {log() {}},
   getSheet_: () => ({getLastRow: () => original.length + 1, getRange: () => ({getValues: () => original})}),
   writeRows_: (name, headers, rows) => { written = JSON.parse(JSON.stringify(rows)); },
 };
 vm.createContext(ctx);
 vm.runInContext(source.slice(source.indexOf('function replaceDates_('),source.indexOf('function syncFinancePlanHistory()')),ctx);
 vm.runInContext(source.slice(source.indexOf('function syncFinanceToday()'),source.indexOf('function T_syncStocksWh()')),ctx);
 assert.equal(ctx.syncFinanceToday(),true);
 assert.deepEqual(written,[original[0], original[2], original[3], ['defly',today,'1','Продажа',250,2]]);
 assert.equal(released,true);
 locked = false; written = undefined;
 assert.equal(ctx.syncFinanceToday(),false);
 assert.equal(written,undefined);
});

test('Настройка двухчасового сбора Ozon не создаёт дубликаты и сохраняет текущие триггеры', () => {
 const handlers = ['T_syncFinance', 'T_syncOrders'];
 const ctx = {ScriptApp: {
   getProjectTriggers: () => handlers.map(n => ({getHandlerFunction: () => n})),
   deleteTrigger: t => handlers.splice(handlers.indexOf(t.getHandlerFunction()), 1),
   newTrigger: n => ({timeBased(){return this;},everyHours(h){assert.equal(h,2);return this;},create(){handlers.push(n);}}),
 }};
 vm.createContext(ctx);
 vm.runInContext(source.slice(source.indexOf('function setupFinanceTodayTrigger()'),source.indexOf('function T_syncStocksWh()')),ctx);
 ctx.setupFinanceTodayTrigger();
 ctx.setupFinanceTodayTrigger();
 assert.deepEqual(handlers,['T_syncFinance','T_syncOrders','T_syncFinanceToday']);
});
