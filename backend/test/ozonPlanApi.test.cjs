const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SHOPS } = require('../src/lib/ozonPlan');
const p = 'Чехлы / Чехлы на сиденья';
const store = new Map([['plan:defly:2026-11', JSON.stringify({ [p]: { salesQty: 120, payout: 1000 } })]]);
const fakeQuery = async (sql, args = []) => {
  if (sql.includes('INSERT INTO app_settings')) { store.set(args[0], args[1]); return []; }
  if (sql.includes('WHERE key = ANY')) return args[0].filter(k => store.has(k)).map(key => ({ key, value: store.get(key) }));
  if (sql.includes('SELECT value FROM app_settings')) return store.has(args[0]) ? [{ value: store.get(args[0]) }] : [];
  return [];
};
const log = [];
let before;
const client = { query: async (sql, args) => {
  log.push(sql);
  if (sql === 'BEGIN') before = new Map(store);
  if (sql === 'ROLLBACK') { store.clear(); for (const [k, v] of before) store.set(k, v); }
  return { rows: await fakeQuery(sql, args) };
}, release() {} };
require.cache[require.resolve('../src/db')] = { exports: { query: fakeQuery, getPool: () => ({ connect: async () => client }) } };
const basis = { paths: [p], taxonomy: { defly: { A: p } }, asOf: '2026-10-20T00:00:00Z', shops: Object.fromEntries(SHOPS.map((id, i) => [id, { label: id, byPath: { [p]: { qty: i ? 0 : 100, payout: i ? 0 : 100000 } }, available: { mn: '2026-01-01', mx: '2026-10-20' } }])) };
require.cache[require.resolve('../src/lib/ozonPlanData')] = { exports: { validMonth: m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m), defaultPeriod: () => ({ from: '2026-09-21', to: '2026-10-20' }), cutoff: () => '2026-10-20', basis: async () => structuredClone(basis), execution: async () => ({ shops: {}, to: null, future: true }) } };
const router = require('../src/routes/ozonPlan');
async function call(method, path, body = {}, query = {}) {
  const layer = router.stack.find(x => x.route?.path === path && x.route.methods[method]);
  let status = 200, payload;
  const res = { status(n) { status = n; return this; }, json(v) { payload = v; } };
  await layer.route.stack[0].handle({ body, query }, res);
  return { status, ...payload };
}
const input = revision => ({ month: '2026-11', from: '2026-09-21', to: '2026-10-20', source: 'fact', expectedRevision: revision, targets: [{ path: p, qty: 1000, mean: 1000 }] });
test('API: общий план, фиксация, история, устаревшее окно и сохранность прежних планов', async () => {
  const legacy = store.get('plan:defly:2026-11');
  const initial = await call('get', '/', {}, { month: '2026-11' });
  assert.equal(initial.data.revision, 0); assert.equal(initial.data.month, '2026-11'); assert.equal(initial.data.legacy.length, 1);
  const first = await call('post', '/preview', input(0));
  const stale = await call('post', '/preview', input(0));
  assert.deepEqual(first.data.errors, []);
  assert.equal(store.has('plan:ozon:v2:2026-11'), false, 'Предпросмотр не сохраняет план');
  const fixed = await call('post', '/fix', { month: '2026-11', previewId: first.data.id });
  assert.equal(fixed.status, 200); assert.equal(fixed.data.revision, 1); assert.equal(fixed.data.versions.length, 1);
  assert.ok(log.some(sql => sql.includes('pg_advisory_xact_lock')));
  assert.ok(log.some(sql => sql.includes('FOR UPDATE')));
  assert.equal((await call('post', '/fix', { month: '2026-11', previewId: stale.data.id })).status, 409);
  assert.equal((await call('post', '/preview', input(0))).status, 409);
  const next = await call('post', '/preview', input(1));
  const second = await call('post', '/fix', { month: '2026-11', previewId: next.data.id, note: 'Пересмотр' });
  assert.equal(second.data.versions.length, 2); assert.equal(second.data.versions[0].id, first.data.id);
  assert.equal(second.data.versions[1].note, 'Пересмотр');
  assert.equal(store.get('plan:defly:2026-11'), legacy);
  assert.equal((await call('post', '/fix', { month: '2026-11', previewId: next.data.id })).status, 400, 'Повторная фиксация исключена');
  assert.equal((await call('post', '/fix', { month: '2026-12', previewId: stale.data.id })).status, 400);
  assert.equal((await call('get', '/', {}, { month: '2026-13' })).status, 400);
  assert.equal((await call('get', '/execution', {}, { month: '2026-11', version: first.data.id })).data.snapshot.id, first.data.id);
});
test('API: предупреждения требуют явного подтверждения', async () => {
  const request = input(2); request.targets[0].mean = 2000;
  const preview = (await call('post', '/preview', request)).data;
  assert.ok(preview.warnings.length);
  assert.equal((await call('post', '/fix', { month: '2026-11', previewId: preview.id })).status, 400);
  assert.equal((await call('post', '/fix', { month: '2026-11', previewId: preview.id, acknowledgeWarnings: true })).status, 200);
});
test('API: план Licio хранится отдельно, предпросмотр нельзя зафиксировать в другой области',async()=>{
 basis.shops.licio={label:'Licio',byPath:{[p]:{qty:100,payout:100000}},available:{mn:'2026-01-01',mx:'2026-10-20'}};
 const common=store.get('plan:ozon:v2:2026-11');
 const preview=await call('post','/preview',{...input(0),scope:'licio'});
 assert.equal(preview.success,true);assert.deepEqual(preview.data.rows[0].shops.map(x=>x.id),['licio']);
 assert.equal((await call('post','/fix',{month:'2026-11',previewId:preview.data.id})).status,400);
 const fixed=await call('post','/fix',{month:'2026-11',scope:'licio',previewId:preview.data.id});
 assert.equal(fixed.success,true);assert.ok(store.has('plan:licio:v2:2026-11'));assert.equal(store.get('plan:ozon:v2:2026-11'),common);
 const state=await call('get','/',{},{month:'2026-11',scope:'licio'});assert.equal(state.data.activeId,preview.data.id);
 assert.equal((await call('get','/',{},{month:'2026-11',scope:'wrong'})).status,400);
});
