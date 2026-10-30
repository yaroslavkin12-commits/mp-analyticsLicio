const {test}=require('node:test'),assert=require('node:assert/strict'),{Readable}=require('node:stream');
let body,ingested=[];require.cache[require.resolve('../node_modules/axios')]={exports:{get:async(url,opt)=>{assert.equal(opt.responseType,'stream');assert.ok(url.endsWith('cachebust=run-stream-1'));return {data:body};}}};
require.cache[require.resolve('../src/lib/wbBridge')]={exports:{CABINET:'defly_wb',ingest:async(p,opt)=>{ingested.push({part:p.part,rows:p.rows.length,deferred:!!opt?.deferCommit});}}};
const {csvRows,importFinance}=require('../src/collectors/wb/financeSheet');
const quote=r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',');
const row=(id,run='run-stream-1')=>quote([id,JSON.stringify({id,text:'Строка "с кавычками"\nи переносом'}),run]);
const meta=total=>({total:String(total),run_id:'run-stream-1',from:'2026-08-01',to:'2026-10-29',collected_at:new Date().toISOString()});
test('Потоковый CSV: UTF-8, кавычки и переносы не зависят от границы сетевого пакета',async()=>{
 const s='\uFEFF'+quote(['id','payload','run_id'])+'\r\n'+row('A')+'\r\n';const buffer=Buffer.from(s),out=[];
 for await(const r of csvRows(Readable.from([...buffer].map(b=>Buffer.from([b])))))out.push(r);
 assert.equal(out.length,2);assert.equal(JSON.parse(out[1][1]).text,'Строка "с кавычками"\nи переносом');
 const truncated=Readable.from(['"id","payload","run_id"\n"A","незавершено']);await assert.rejects(async()=>{for await(const r of csvRows(truncated))void r;},/оборван/);
});
test('Финансовый CSV фиксируется только после конца потока, все пакеты до этого промежуточные',async()=>{
 ingested=[];body=Readable.from([quote(['id','payload','run_id'])+'\n',...Array.from({length:1001},(_,i)=>row('R'+i)+'\n')]);
 await importFinance(meta(1001),'test-sheet');assert.deepEqual(ingested,[{part:0,rows:1000,deferred:true},{part:1,rows:1,deferred:true},{part:1,rows:1,deferred:false}]);
});
test('Лишняя строка, смена версии, повтор ID и оборванная сеть не публикуют снимок',async()=>{
 const header=quote(['id','payload','run_id'])+'\n';
 for(const [total,rows] of [[1,[row('A'),row('B')]],[2,[row('A'),row('A')]],[1,[row('A','other-run')]], [2,[row('A')]]]){
  ingested=[];body=Readable.from([header,...rows.map(r=>r+'\n')]);await assert.rejects(()=>importFinance(meta(total),'test-sheet'));assert.ok(ingested.every(p=>p.deferred));
 }
 ingested=[];body=Readable.from((async function*(){yield header;for(let i=0;i<1000;i++)yield row('R'+i)+'\n';throw new Error('Оборвалась сеть');})());
 await assert.rejects(()=>importFinance(meta(1000),'test-sheet'),/Оборвалась сеть/);assert.deepEqual(ingested,[{part:0,rows:1000,deferred:true}]);
});
test('31 175 строк импортируются ограниченными пакетами без сборки всего CSV',async()=>{
 ingested=[];let produced=0,firstStageAt=0;
 body=Readable.from((async function*(){yield quote(['id','payload','run_id'])+'\n';for(let i=0;i<31175;i++){produced++;if(!firstStageAt&&ingested.length)firstStageAt=produced;yield row('R'+i)+'\n';}})());
 await importFinance(meta(31175),'test-sheet');assert.ok(firstStageAt<31175);assert.equal(ingested.length,33);assert.equal(ingested.at(-1).deferred,false);assert.ok(ingested.every(p=>p.rows<=1000));
});
