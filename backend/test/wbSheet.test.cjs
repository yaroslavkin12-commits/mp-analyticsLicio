const { test } = require('node:test');
const assert = require('node:assert/strict');
const ID = '13_54MPKRjkSz49DmDhV5eA4Q0SJoPgAPwXnikKBqoHs';
process.env.ADS_SHEET_ID_DEFLY_WB = ID;
const saved = [], requests = [], old = new Map();
const header = ['cabinet', 'kind', 'run_id', 'collected_at', 'from', 'to', 'total', 'warning'];
const quote = rows => rows.map(r => r.map(c => '"' + String(c).replaceAll('"', '""') + '"').join(',')).join('\n');
const stamp = new Date().toISOString();
let manifest = quote([header, ['defly_wb', 'orders', 'run-sheet-1', stamp, '2026-10-01', '2026-10-29', 1, '']]);
let table = quote([['id', 'payload', 'run_id'], ['A', JSON.stringify({ id: 'A', price: 100, note: 'Кавычки "тест", перенос\nстроки' }), 'run-sheet-1']]);
require.cache[require.resolve('../node_modules/axios')] = { exports: { get: async url => { requests.push(url); return { data: url.includes('sheet=WB_status') ? manifest : table }; } } };
require.cache[require.resolve('../src/lib/wbBridge')] = { exports: { CABINET: 'defly_wb', KINDS: ['orders', 'sales'], read: async () => [...old.values()], ingest: async p => { saved.push(p); old.set(p.kind, { kind: p.kind, meta: { runId: p.runId } }); return { complete: true }; } } };
const source = require('../src/collectors/wb/sheetSync');
test('WB читает именно ID своего кабинета, CSV с кавычками; секрет не требуется; повтор не качает набор', async () => {
  delete process.env.WB_SYNC_SECRET;
  const s = await source.sync(true); assert.equal(s.error, null); assert.equal(saved.length, 1); assert.equal(saved[0].rows[0].price, 100); assert.match(saved[0].rows[0].note, /перенос\nстроки/);
  assert.ok(requests.every(u => u.includes('/d/' + ID + '/gviz/') && u.includes('cachebust='))); assert.ok(requests.find(u=>u.includes('sheet=WB_orders')).endsWith('cachebust=run-sheet-1'));
  requests.length = 0; await source.sync(true); assert.equal(requests.length, 1); assert.equal(saved.length, 1);
  assert.equal(require('../src/config/cabinets').isConnected('defly_wb'), true);
});
test('WB: нет вкладки, неполный набор, другая версия и неверный payload не перезаписывают данные', async () => {
  const manifestOk = manifest, tableOk = table;
  manifest = ''; assert.match((await source.sync(true)).error, /WB_status/); assert.equal(saved.length, 1);
  manifest = manifestOk.replaceAll('run-sheet-1', 'run-sheet-2');
  assert.match((await source.sync(true)).error, /неполный набор/); assert.equal(saved.length, 1);
  table = tableOk.replaceAll('run-sheet-1', 'run-sheet-2').replace('"A",', '"B",');
  assert.match((await source.sync(true)).error, /ID строки/); assert.equal(saved.length, 1);
  table = tableOk.replaceAll('run-sheet-1', 'run-sheet-2');
  assert.equal((await source.sync(true)).error, null); assert.equal(saved.length, 2);
});

test('Apps Script публикует данные и WB_status с одной версией без секрета и отправки в Render', () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const sheets = new Map(), props = new Map(); let sequence = 0;
  function sheet() {
    const cells = [];
    return { cells, getLastRow: () => cells.length, getMaxRows: () => 1000, getRange: (row, col, count, width) => ({ setNumberFormat() { return this; }, setValues(values) { values.forEach((r, i) => { cells[row - 1 + i] ||= []; r.forEach((v, j) => { cells[row - 1 + i][col - 1 + j] = v; }); }); return this; }, getValues() { return Array.from({ length: count }, (_, i) => Array.from({ length: width }, (_, j) => cells[row - 1 + i]?.[col - 1 + j] ?? '')); }, clearContent() { for (let i = 0; i < count; i++) for (let j = 0; j < width; j++) if (cells[row - 1 + i]) cells[row - 1 + i][col - 1 + j] = ''; } }) };
  }
  const book = { getId: () => ID, getSheetByName: name => sheets.get(name), insertSheet: name => { const s = sheet(); sheets.set(name, s); return s; } };
  const ctx = { SpreadsheetApp: { getActiveSpreadsheet: () => book, flush() {} }, PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k), setProperty: (k, v) => props.set(k, v) }) }, LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) }, Utilities: { getUuid: () => 'run-sheet-' + ++sequence, formatDate: d => d.toISOString().slice(0, 10) }, Logger: { log() {} }, UrlFetchApp: { fetch() { throw new Error('Прямой отправки не должно быть'); } } };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(require.resolve('../../google-apps-script/wb-sheet-sync.gs'), 'utf8'), ctx);
  ctx.wbLock_('test', () => ctx.wbSave_('orders', [{ id: '1' }], '2026-10-01', '2026-10-29'));
  assert.deepEqual(Array.from(sheets.get('WB_orders').cells[0]), ['id', 'payload', 'run_id']);
  assert.equal(sheets.get('WB_orders').cells[1][2], sheets.get('WB_status').cells[1][2]);
  assert.equal(sheets.get('WB_status').cells[1][6], 1); assert.equal(sheets.get('WB_status').cells[1][0], 'defly_wb');
  const originalTime = sheets.get('WB_status').cells[1][3];
  ctx.resendWbData(); assert.equal(sheets.get('WB_status').cells.length, 2); assert.equal(sheets.get('WB_status').cells[1][3], originalTime);
});
test('Google-импорт WB принимает отдельный финансовый набор без изменения заказов',async()=>{
 const bridge=require('../src/lib/wbBridge');bridge.KINDS.push('finance');
 const r={id:'142382026102312345|9007199254740993',reportId:'142382026102312345',rrdId:'9007199254740993',forPay:'100.01'};
 manifest=quote([header,['defly_wb','finance','run-finance-1',stamp,'2026-08-01','2026-10-29',1,'']]);
 table=quote([['id','payload','run_id'],[r.id,JSON.stringify(r),'run-finance-1']]);
 await source.sync(true);await source.waitForFinance();assert.equal(source.status().error,null);assert.equal(saved.at(-1).kind,'finance');assert.equal(saved.at(-1).rows[0].reportId,r.reportId);assert.equal(saved.at(-1).rows[0].forPay,'100.01');assert.ok(old.has('orders'));
});
