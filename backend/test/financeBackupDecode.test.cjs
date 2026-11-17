const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{Readable}=require('node:stream'),{EventEmitter}=require('node:events');
test('Резервная копия: читается только целевая неделя нужных кабинетов, экранирование COPY сохраняется',async()=>{
 const code=fs.readFileSync(require.resolve('../../deploy/yandex/repair-history.cjs'),'utf8'),part=code.slice(code.indexOf('function pgUnescape'),code.indexOf('(async()=>{'));
 const lines=['COPY public.finance_daily (cabinet, date, sku, name, amount, qty) FROM stdin;','defly\t2026-11-02\t123\tПродажа FBO\t100.50\t1','defly\t2026-11-08\t\tНазвание\\tс\\nпереносом\t-20\t0','defly\t2026-11-09\t123\tПродажа FBO\t10\t1','licio\t2026-11-02\t123\tПродажа\t10\t1','\\.'];
 const spawn=()=>{const c=new EventEmitter();c.stdout=Readable.from([lines.join('\n')+'\n']);c.stderr=new EventEmitter();setImmediate(()=>c.emit('exit',0));return c;};
 const ctx={spawn,readline:require('node:readline'),candidateCabinets:['defly'],from:'2026-11-02',to:'2026-11-08',key:r=>JSON.stringify([r.cabinet,r.date,r.sku,r.name]),module:{exports:{}}};
 vm.runInNewContext(part+'\nmodule.exports={pgUnescape,backupRows};',ctx);
 assert.equal(ctx.module.exports.pgUnescape('\\N'),null);
 const rows=await ctx.module.exports.backupRows('pg_restore','test.dump');assert.equal(rows.size,2);assert.equal([...rows.values()][0].amount,100.5);assert.equal([...rows.values()][1].name,'Название\tс\nпереносом');
});
