const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('Облегчённый импорт Licio читает только выкупы, цены и начисления, сохраняя значения и кабинет',async()=>{
 const tabs=[],writes=[];
 const csv={Buyout:'cabinet,date,offer_id,sku,ordered,delivered,cancelled,in_progress\nlicio,2026-10-26,L1,123,10,8,1,1',Prices:'cabinet,offer_id,pct_fbo,fbo_deliv,acquiring,price\nlicio,L1,30,100,1,1000',Finance:'cabinet,date,sku,name,amount,qty\nlicio,2026-10-26,123,Продажа,8000,8\ndefly,2026-10-26,456,Продажа,99999,9'};
 const mocks={axios:{get:async url=>{const tab=new URL(url).searchParams.get('sheet');tabs.push(tab);if(!csv[tab])throw Error('Лишняя вкладка '+tab);return{data:csv[tab]}}},'../../db':{query:async()=>[]},'../../lib/warehouses':{},'../../lib/adZone':{},'./ozonHttp':{bulkUpsert:async(table,cols,rows)=>{writes.push({table,cols,rows});return rows.length}},'../../lib/rowDiff':{state:()=>null,drop:()=>{}}};
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../src/collectors/ads/sheetSync'),'utf8'),{module,exports:module.exports,require:p=>mocks[p]||require(p),process:{env:{ADS_SHEET_ID:'test'}},console,setTimeout,clearTimeout,URL});
 const r=await module.exports.syncFinanceFromSheet('licio',{coreOnly:true});
 assert.deepEqual(tabs,['Buyout','Prices','Finance']);assert.equal(r.rows,3);assert.ok(writes.every(w=>w.rows.every(r=>r[0]==='licio')));
 const f=writes.find(w=>w.table==='finance_daily');assert.equal(f.rows[0][f.cols.indexOf('amount')],8000);assert.equal(f.rows.length,1);
});
