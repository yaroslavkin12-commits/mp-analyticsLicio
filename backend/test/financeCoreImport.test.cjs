const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('Облегчённый импорт Licio читает только выкупы, цены и начисления, сохраняя значения и кабинет',async()=>{
 const tabs=[],writes=[];
 const csv={Buyout:'cabinet,date,offer_id,sku,ordered,delivered,cancelled,in_progress\nlicio,2026-10-26,L1,123,10,8,1,1',Prices:'cabinet,offer_id,pct_fbo,fbo_deliv,acquiring,price\nlicio,L1,30,100,1,1000',Finance:'cabinet,date,sku,name,amount,qty\nlicio,2026-10-26,123,Продажа,8000,8\nlicio,2026-10-26,,Удержание за услугу,-15,\ndefly,2026-10-26,456,Продажа,99999,9'};
 const mocks={axios:{get:async url=>{const tab=new URL(url).searchParams.get('sheet');tabs.push(tab);if(!csv[tab])throw Error('Лишняя вкладка '+tab);return{data:csv[tab]}}},'../../db':{query:async()=>[]},'../../lib/warehouses':{},'../../lib/adZone':{},'./ozonHttp':{bulkUpsert:async(table,cols,rows)=>{writes.push({table,cols,rows});return rows.length}},'../../lib/historyImport':{importHistory:async(table,cab,rows,cols)=>{writes.push({table,cols,rows});return rows.length}},'../../lib/rowDiff':{state:()=>null,drop:()=>{}}};
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../src/collectors/ads/sheetSync'),'utf8'),{module,exports:module.exports,require:p=>mocks[p]||require(p),process:{env:{ADS_SHEET_ID:'test'}},console,setTimeout,clearTimeout,URL});
 const r=await module.exports.syncFinanceFromSheet('licio',{coreOnly:true});
 assert.deepEqual(tabs,['Buyout','Prices','Finance']);assert.equal(r.rows,4);assert.ok(writes.every(w=>w.rows.every(r=>r[0]==='licio')));
 const f=writes.find(w=>w.table==='finance_daily');assert.equal(f.rows[0][f.cols.indexOf('amount')],8000);assert.equal(f.rows.length,2);assert.equal(f.rows[1][f.cols.indexOf('qty')],0);assert.throws(()=>module.exports.parseCsv('a,b\n1,"оборвано'),/оборвалась/);
});

test('Дневные начисления импортируются, даже когда складской снимок неполный', async () => {
  const tabs = [], writes = [];
  const csv = {
    Finance: 'cabinet,date,sku,name,amount,qty\ndefly,2026-11-24,123,Продажа,8000,8',
    StocksWh: 'cabinet,offer_id,warehouse,cluster,available,reserved,transit\ndefly,A,Склад,Регион,2,0,0',
    Buyout: 'cabinet,date,offer_id,sku,ordered,delivered,cancelled,in_progress\ndefly,2026-11-24,A,123,10,8,1,1',
  };
  const mocks = {
    axios: { get: async url => {
      const tab = new URL(url).searchParams.get('sheet');
      tabs.push(tab);
      return { data: csv[tab] || '' };
    } },
    '../../db': { query: async () => [] },
    '../../lib/warehouses': {},
    '../../lib/adZone': {},
    './ozonHttp': {},
    '../../lib/rowDiff': { state: () => null, drop: () => {} },
    '../../lib/historyImport': { importHistory: async (table, cabinet, rows) => {
      writes.push({ table, cabinet, rows });
      if (table === 'stock_cluster_daily') throw Error('Неполная выгрузка');
      return rows.length;
    } },
  };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/collectors/ads/sheetSync'), 'utf8'), {
    module: mod, exports: mod.exports, require: path => mocks[path] || require(path),
    process: { env: { ADS_SHEET_ID_DEFLY: 'test' } }, console, setTimeout, clearTimeout, URL,
  });
  const result = await mod.exports.syncFinanceFromSheet('defly');
  assert.equal(tabs[0], 'Finance');
  assert.ok(tabs.includes('StocksWh'));
  assert.equal(writes[0].table, 'finance_daily');
  assert.equal(writes[0].rows[0][5], 8);
  assert.ok(writes.some(write => write.table === 'buyout_daily'));
  assert.match(result.warning, /Остатки по складам: Неполная выгрузка/);
});
