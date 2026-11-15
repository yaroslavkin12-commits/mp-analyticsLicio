const {test}=require('node:test'),assert=require('node:assert/strict');let run='one',opsReads=0,financeReads=0;
const sale=(id,date)=>({id,rrDate:date,vendorCode:'A',nmId:1,title:'Дефлекторы окон 2D',currency:'RUB',docTypeName:'Продажа',sellerOperName:'Продажа',quantity:1,retailPriceWithDisc:1000,retailAmount:900,forPay:700,acquiringFee:20});
const ledger=[sale('old','2026-09-01'),sale('new','2026-11-10'),{id:'logistics',rrDate:'2026-11-11',deliveryService:30}],ops=[{kind:'catalog',rows:[{id:'a',offer:'A',nmId:1,name:'Дефлекторы окон 2D'}],meta:{}},{kind:'orders',rows:[{id:'o',nmId:1,offer:'A',date:'2026-11-10',price:1000}],meta:{from:'2026-09-01',to:'2026-11-15'}},{kind:'ads',rows:[{date:'2026-10-10',spend:10},{date:'2026-11-10',spend:20}],meta:{from:'2026-09-01',to:'2026-11-15'}}];
const db=require.resolve('../src/db');require.cache[db]={id:db,filename:db,loaded:true,exports:{query:async(sql,p=[])=>{
 if(sql.includes('kind=ANY')){opsReads++;return ops.filter(d=>p[1].includes(d.kind)).map(d=>d.kind==='ads'&&p[2]?{...d,rows:d.rows.filter(r=>r.date>=p[2]&&r.date<=p[3])}:d);}
 const meta={runId:run,from:'2026-09-01',to:'2026-11-15'};
 if(sql.includes('jsonb_array_elements(d.rows)')){financeReads++;assert.ok(sql.includes('WITH ORDINALITY'));assert.ok(sql.includes('OR NOT COALESCE'));assert.ok(!sql.includes('jsonb_agg'));assert.equal(p[3],run);assert.ok(Array.isArray(p[4]));assert.ok(!p[4].includes('bonusTypeName'));return ledger.filter(r=>r.rrDate>=p[1]&&r.rrDate<=p[2]).map(r=>({payload:Object.fromEntries(Object.entries(r).filter(([k])=>!p[4].includes(k)))}));}
 if(sql.includes('SELECT kind, meta, updated_at'))return [{kind:'finance',meta}];
 return [];
}}};
const bridge=require('../src/lib/wbBridge'),V=require('../src/lib/wbViews');
test('Сводка WB читает только каталог и заказы; реклама ограничивается нужными днями',async()=>{
 const a=await bridge.read({kinds:['catalog','orders']});assert.deepEqual(a.map(x=>x.kind),['catalog','orders']);
 await bridge.read({kinds:['orders','catalog']});assert.equal(opsReads,1);
 const ads=await bridge.read({kinds:['ads'],from:'2026-11-01',to:'2026-11-15'});assert.equal(ads[0].rows.length,1);assert.equal(ads[0].meta.from,'2026-09-01');
 const p={from:'2026-11-10',to:'2026-11-10'},summary=require('../src/lib/shopsSummary').wbShopSummary;
 assert.deepEqual(summary(a,{},p),summary(ops,{},p));
});
test('Финансовый срез WB сохраняет все статьи выбранных дней, метаданные покрытия и коэффициенты последних 30 дней',async()=>{
 const p={dateFrom:'2026-11-10',dateTo:'2026-11-11'},[a,b]=await Promise.all([bridge.readFinance(p),bridge.readFinance(p)]);assert.equal(a,b);assert.equal(financeReads,1);assert.equal(a.rows.length,2);assert.equal(a.meta.from,'2026-09-01');
 const whole={kind:'finance',meta:a.meta,rows:ledger},prefs=V.initial(),full=V.build([...ops,whole],prefs,p),sliced=V.build([...ops,a],prefs,p);
 const x=full.pnl(),y=sliced.pnl();for(const key of ['rows','noSku','taxBase','self','available'])assert.deepEqual(y[key],x[key]);
 const latest=await bridge.readFinance({latest:true});assert.equal(latest.rows.length,2);
 assert.deepEqual(V.build([...ops,latest],prefs,p).coefs().coefs,full.coefs().coefs);
 const before=financeReads;run='two';await bridge.readFinance(p);assert.equal(financeReads,before+1);
 await assert.rejects(bridge.readFinance({dateFrom:'не дата',dateTo:'2026-11-15'}));
});
