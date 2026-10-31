const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../../google-apps-script/wb-sheet-sync.gs'),'utf8');
function harness(responses){
 let now=Date.parse('2026-10-30T08:30:00Z'),seq=0;const props=new Map([['WB_TOKEN','secret-only-in-properties'],['CABINET_ID','defly_wb']]),sheets=new Map(),calls=[],logs=[],triggers=[];
 function sheet(){const cells=[];return {cells,getMaxRows:()=>200000,insertRowsAfter(){},getLastRow:()=>cells.length,getRange:(row,col,n,width)=>({setNumberFormat(){return this;},setValues(values){values.forEach((r,i)=>{cells[row-1+i]||=[];r.forEach((v,j)=>cells[row-1+i][col-1+j]=v);});return this;},getValues(){return Array.from({length:n},(_,i)=>Array.from({length:width},(_,j)=>cells[row-1+i]?.[col-1+j]??''));},clearContent(){for(let i=0;i<n;i++)for(let j=0;j<width;j++)if(cells[row-1+i])cells[row-1+i][col-1+j]='';while(cells.length&&!cells.at(-1).some(Boolean))cells.pop();}})};}
 class Clock extends Date{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}}
 const ctx={Date:Clock,SpreadsheetApp:{getActiveSpreadsheet:()=>({getId:()=> '13_54MPKRjkSz49DmDhV5eA4Q0SJoPgAPwXnikKBqoHs',getSheetByName:n=>sheets.get(n),insertSheet:n=>{const s=sheet();sheets.set(n,s);return s;}}),flush(){}},PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)||null,setProperty:(k,v)=>props.set(k,v),deleteProperty:k=>props.delete(k)})},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},Utilities:{getUuid:()=> 'run-finance-'+ ++seq,formatDate:d=>d.toISOString().slice(0,10),sleep:ms=>{assert.ok(ms<=61000);now+=ms;}},Logger:{log:s=>logs.push(s)},ScriptApp:{getProjectTriggers:()=>[...triggers],deleteTrigger:t=>triggers.splice(triggers.indexOf(t),1),newTrigger:name=>({timeBased(){return this;},everyMinutes(){return this;},everyHours(){return this;},create(){triggers.push({getHandlerFunction:()=>name});}})},UrlFetchApp:{fetch:(url,opt)=>{calls.push({url,opt,at:now});const r=responses.shift();assert.ok(r,'Нет тестового ответа');if(typeof r==='function')return r(calls.at(-1),ctx);return {getResponseCode:()=>r.code,getContentText:()=>r.text||''};}}};
 vm.createContext(ctx);vm.runInContext(source,ctx);return {ctx,props,sheets,calls,logs,triggers,advance:ms=>now+=ms,rows:kind=>kind==='status'?(sheets.get('WB_status')?.cells.slice(1)||[]):ctx.wbRead_(kind)};
}
const row=(rrd='9007199254740993')=>'[{"reportId":142382026102312345,"rrdId":'+rrd+',"rrDate":"2026-10-23","nmId":1,"vendorCode":"A","currency":"RUB","docTypeName":"Продажа","bonusTypeName":"Оплата рекламы","forPay":"100.01","retailAmount":"125.55","ppvzSupplierInn":"not-to-save"}]';
test('Финансы WB: точные int64, денежные строки, проекция; короткая страница не завершает отчёт',()=>{
 const h=harness([{code:200,text:row()},{code:204}]);h.ctx.syncWbFinance();
 assert.equal(h.calls.length,2);assert.ok(h.calls[1].at-h.calls[0].at>=61000);
 assert.match(h.calls[1].opt.payload,/"rrdId":9007199254740993,/);assert.equal(JSON.parse(h.calls[0].opt.payload).period,'daily');
 assert.equal(h.rows('finance')[0].id,'142382026102312345|9007199254740993');assert.equal(h.rows('finance')[0].forPay,'100.01');assert.equal(h.rows('finance')[0].ppvzSupplierInn,undefined);assert.equal(h.rows('finance')[0].bonusTypeName,'Оплата рекламы');assert.ok(JSON.parse(h.calls[0].opt.payload).fields.includes('bonusTypeName'));
 assert.equal(h.props.has('WB_FINANCE_JOB'),false);assert.equal(h.rows('status').length,1);assert.ok(!h.logs.join('').includes('secret-only-in-properties'));
});
test('Финансы WB: незавершённые страницы не публикуются, следующий запуск продолжает курсор',()=>{
 const h=harness([{code:200,text:row('9007199254740993')},{code:200,text:row('9007199254740994')},{code:200,text:row('9007199254740995')},{code:204}]);
 h.ctx.syncWbFinance();assert.equal(h.rows('finance').length,0);assert.equal(h.rows('status').length,0);assert.equal(h.rows('finance_pending').length,3);
 h.advance(3600000);h.ctx.syncWbFinance();assert.equal(h.rows('finance').length,3);assert.match(h.calls[3].opt.payload,/"rrdId":9007199254740995,/);
});
test('Финансы WB: отказ доступа и 429 сохраняют прежний отчёт и уже полученные страницы',()=>{
 const h=harness([{code:200,text:row()},{code:403},{code:429},{code:204}]);
 h.ctx.wbSave_('finance',[{id:'old',value:'прежний отчёт'}],'2026-08-01','2026-10-29');
 assert.throws(()=>h.ctx.syncWbFinance(),/HTTP 403/);assert.equal(h.rows('finance')[0].id,'old');assert.equal(h.rows('finance_pending').length,1);
 assert.throws(()=>h.ctx.syncWbFinance(),/HTTP 429/);assert.equal(h.rows('finance')[0].id,'old');
 h.advance(3600000);h.ctx.syncWbFinance();assert.equal(h.rows('finance').length,1);assert.notEqual(h.rows('finance')[0].id,'old');
});
test('Финансы WB: пустой JSON и зацикленный курсор не подтверждают полный снимок',()=>{
 for(const text of ['null','[]','{"error":"no access"}']){const h=harness([{code:200,text}]);assert.throws(()=>h.ctx.syncWbFinance());assert.equal(h.rows('status').length,0);}
 const h=harness([{code:200,text:row()},{code:200,text:row()}]);assert.throws(()=>h.ctx.syncWbFinance(),/не продвинулся/);assert.equal(h.rows('finance').length,0);
});
test('Финансы WB: повтор установки триггеров не дублирует сбор',()=>{
 const h=harness([]);h.ctx.setupWbTriggers();h.ctx.setupWbTriggers();assert.equal(h.triggers.length,4);assert.equal(h.triggers.filter(t=>t.getHandlerFunction()==='syncWbFinance').length,1);
});
test('Статус финансов различает отсутствие и полный пустой отчёт; расчёты не включаются преждевременно',async()=>{
 const bridge=require('../src/lib/wbBridge'),sheetSync=require('../src/collectors/wb/sheetSync'),readMeta=bridge.readMeta,readFinance=bridge.readFinance,sync=sheetSync.sync;
 let meta=[];bridge.readFinance=async()=>meta[0]?{...meta[0],rows:[]}:null;bridge.readMeta=async()=>meta;sheetSync.sync=async()=>({configured:true,error:null});
 try{const route=require('../src/routes/wb').stack.find(x=>x.route?.path==='/finance-status').route.stack[0].handle;
 const call=async(cabinet='defly_wb')=>{let code=200,value;await route({query:{cabinet}},{set(){},status(n){code=n;return this;},json(v){value=v;}});return {code,...value};};
 assert.equal((await call()).data.imported,false);
 meta=[{kind:'finance',meta:{total:0,from:'2026-08-01',to:'2026-10-29',collectedAt:'2026-10-30T08:00:00Z'}}];const r=await call();assert.equal(r.data.imported,true);assert.equal(r.data.rows,0);assert.equal(r.data.calculationsReady,true);assert.equal((await call('licio')).code,400);
 }finally{bridge.readMeta=readMeta;bridge.readFinance=readFinance;sheetSync.sync=sync;}
});
test('Диагностика WB различает запрошенное и отсутствующее поле, не пишет суммы и реквизиты в журнал',()=>{
 const h=harness([{code:200,text:JSON.stringify([{deduction:'123456.78',ppvzSupplierInn:'private-counterparty'}])}]);
 h.ctx.probeWbFinanceFields(); const logs=h.logs.join('\n');
 assert.match(logs,/bonusTypeName запрошен: true/); assert.match(logs,/с полем bonusTypeName: 0; удержаний: 1/);
 assert.ok(!logs.includes('secret-only-in-properties'));assert.ok(!logs.includes('private-counterparty'));assert.ok(!logs.includes('123456.78'));assert.equal(h.sheets.size,0);
});
