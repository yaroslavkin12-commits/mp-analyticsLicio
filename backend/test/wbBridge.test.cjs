const { test } = require('node:test');
const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), vm = require('node:vm');
const state = new Map(), parts = new Map(); let before;
const key = a => a.slice(0, 2).join('|');
const client = { release() {}, async query(sql, args = []) {
  if (sql === 'BEGIN') { before = [structuredClone(state), structuredClone(parts)]; return { rows: [] }; }
  if (sql === 'ROLLBACK') { state.clear(); parts.clear(); for (const x of before[0]) state.set(...x); for (const x of before[1]) parts.set(...x); }
  if (sql.includes('SELECT run_id, collected_at')) return { rows: state.has(key(args)) ? [state.get(key(args))] : [] };
  if (sql.includes('SELECT hash')) return { rows: parts.has(args.join('|')) ? [parts.get(args.join('|'))] : [] };
  if (sql.includes('INSERT INTO wb_bridge_parts')) { const k = args.slice(0, 4).join('|'); if (!parts.has(k)) parts.set(k, { cabinet: args[0], kind: args[1], run: args[2], part: args[3], hash: args[4], meta: JSON.parse(args[5]), rows: JSON.parse(args[6]) }); }
  if (sql.includes('SELECT part, meta, rows')) return { rows: [...parts.values()].filter(p => [p.cabinet, p.kind, p.run].join('|') === args.join('|')).sort((a, b) => a.part - b.part) };
  if (sql.includes('INSERT INTO wb_bridge_data')) state.set(key(args), { run_id: args[2], collected_at: args[3], meta: JSON.parse(args[4]), rows: JSON.parse(args[5]) });
  if (sql.startsWith('DELETE FROM wb_bridge_parts WHERE cabinet')) for (const [k, p] of parts) if (p.cabinet === args[0] && p.kind === args[1] && p.run === args[2]) parts.delete(k);
  return { rows: [] };
} };
require.cache[require.resolve('../src/db')] = { exports: { query: async () => [], getPool: () => ({ connect: async () => client }) } };
const bridge = require('../src/lib/wbBridge');
const { buildReport } = require('../src/routes/wb');
test('WB: подпись ограничена временем и телом, чужой кабинет и финансы не принимаются', () => {
  const secret = 'a'.repeat(40), timestamp = String(Date.now()), raw = Buffer.from('{"test":1}'), signature = crypto.createHmac('sha256', secret).update(timestamp + '.' + raw).digest('hex');
  assert.doesNotThrow(() => bridge.verify(raw, timestamp, signature, Date.now(), secret));
  assert.throws(() => bridge.verify(Buffer.from('{}'), timestamp, signature, Date.now(), secret), /недействительна/);
  assert.throws(() => bridge.verify(raw, timestamp, signature, Date.now() + 600000, secret), /недействительна/);
  assert.throws(() => bridge.verify(raw, timestamp, signature, Date.now(), ''), /не настроен/);
  assert.throws(() => bridge.validate({ cabinet: 'licio', kind: 'orders' }), /Неизвестный/);
  assert.throws(() => bridge.validate({ cabinet: 'defly_wb', kind: 'finance' }), /Неизвестный/);
});
test('WB: пакеты заменяют набор только целиком; повтор безопасен, прежние наборы сохраняются', async () => {
  const packet = { cabinet: 'defly_wb', kind: 'orders', runId: 'run-test-1', collectedAt: new Date().toISOString(), from: '2026-10-01', to: '2026-10-29', part: 0, parts: 2, total: 2, rows: [{ id: 'a', cancelled: false }] };
  assert.equal((await bridge.ingest(packet)).complete, false); assert.equal(state.size, 0);
  await bridge.ingest(packet); assert.equal(parts.size, 1);
  await assert.rejects(() => bridge.ingest({ ...packet, rows: [{ id: 'changed' }] }), /отличается/);
  await assert.rejects(() => bridge.ingest({ ...packet, part: 1, rows: [{ id: 'a' }] }), /не совпадают/); assert.equal(state.size, 0); assert.equal(parts.size, 1);
  assert.equal((await bridge.ingest({ ...packet, part: 1, rows: [{ id: 'b' }] })).complete, true); assert.equal(state.get('defly_wb|orders').rows.length, 2); assert.equal(parts.size, 0);
  assert.equal((await bridge.ingest(packet)).duplicate, true);
  await bridge.ingest({ ...packet, kind: 'sales', runId: 'run-sales-2', part: 0, parts: 1, total: 0, rows: [] }); assert.equal(state.get('defly_wb|orders').rows.length, 2);
});
test('WB: отмены не считаются заказами; возвраты отдельно, расходы рекламы не дублируются', () => {
  const dataset = (kind, rows) => ({ kind, rows, meta: { from: '2026-10-01', to: '2026-10-29' } });
  const report = buildReport([
    dataset('catalog', [{ id: '1', nmId: 1, offer: 'A', name: 'Товар' }]),
    dataset('orders', [{ id: '1', date: '2026-10-28', nmId: 1, offer: 'A', price: 100, cancelled: false }, { id: '2', date: '2026-10-28', nmId: 1, offer: 'A', price: 100, cancelled: true }]),
    dataset('sales', [{ id: 'S1', date: '2026-10-28', nmId: 1, offer: 'A', price: 100, type: 'sale' }, { id: 'R1', date: '2026-10-28', nmId: 1, offer: 'A', price: 100, type: 'return' }]),
    dataset('campaigns', [{ id: '1', name: 'РК' }]),
    dataset('ads', [{ id: '1', campaign: '1', date: '2026-10-28', scope: 'campaign', spend: 50, views: 100, clicks: 10, orders: 1, orderRub: 100, atbs: 3 }, { id: '2', campaign: '1', date: '2026-10-28', scope: 'sku', spend: 50 }]),
  ], '2026-10-28', '2026-10-29', true);
  assert.equal(report.summary.orders, 1); assert.equal(report.summary.cancelled, 1); assert.equal(report.summary.sold, 1); assert.equal(report.summary.returned, 1); assert.equal(report.campaigns[0].spend, 50);
  assert.equal(report.articles[0].stockWb, null);
  const missing = buildReport([], '2026-10-01', '2026-10-29', false); assert.equal(missing.summary.orders, null); assert.ok(missing.daily.every(d => d.orders === null));
  const partial = buildReport([dataset('orders', [])], '2026-09-01', '2026-10-29', true); assert.equal(partial.summary.orders, null);
});
test('WB: рабочий скрипт исправляет отмену по srid, хранит S/R и передаёт данные без WB-токена', () => {
  const saved = [], requests = [], secret = 's'.repeat(40), data = { orders: [{ id: 'order-1', date: '2026-10-27', cancelled: false }], sales: [] };
  const props = new Map([['WB_TOKEN', 'wb-secret-must-not-leak'], ['WB_SYNC_SECRET', secret]]);
  const ctx = { PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k), setProperty: (k, v) => props.set(k, v) }) }, Utilities: { formatDate: date => date.toISOString().slice(0, 10), sleep() {}, computeHmacSha256Signature: (value, key) => [...crypto.createHmac('sha256', key).update(value).digest()] }, Logger: { log() {} }, UrlFetchApp: { fetch: (url, options) => { requests.push({ url, options }); return { getResponseCode: () => 200, getContentText: () => '{"success":true,"data":{"complete":true}}' }; } } };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(require.resolve('../../google-apps-script/wb-sheet-sync.gs'), 'utf8'), ctx);
  ctx.WB_JOB_STARTED = Date.now(); ctx.wbRead_ = kind => data[kind]; ctx.wbMeta_ = () => null; ctx.wbSave_ = (...args) => saved.push(args);
  let seen = new Set(); ctx.wbFetch_ = (m, url) => { const kind = url.includes('/orders?') ? 'orders' : 'sales'; if (seen.has(kind)) return []; seen.add(kind); return kind === 'orders' ? [{ srid: 'order-1', date: '2026-10-27', lastChangeDate: '2026-10-29T10:00:00', nmId: 1, supplierArticle: 'A', priceWithDisc: 100, isCancel: true }] : [{ saleID: 'S1', srid: 'order-1', date: '2026-10-28', lastChangeDate: '2026-10-29T10:00:00', nmId: 1, supplierArticle: 'A', priceWithDisc: 100 }, { saleID: 'R1', srid: 'order-1', date: '2026-10-29', lastChangeDate: '2026-10-29T11:00:00', nmId: 1, supplierArticle: 'A', priceWithDisc: 0 }]; };
  ctx.wbStats_('orders'); ctx.wbStats_('sales'); assert.equal(saved[0][1].length, 1); assert.equal(saved[0][1][0].cancelled, true); assert.equal(saved[1][1].length, 2); assert.equal(saved[1][1][1].price, null);
  assert.equal(requests.length, 0); // рабочий сбор больше не отправляет данные напрямую в Render

});
