const { test } = require('node:test');
const assert = require('node:assert/strict');
const model = import('../../dashboard/src/lib/deflectors2d.mjs');
const settings = { multiple: 10, periodDays: 7, salesDays: 30, total: 140, fill: false };
const row = (offer, sales, stock, manual = null) => ({ offer, name: offer, sales, stock, transit: 0, manual, enabled: true, note: '' });
test('Период подачи задаёт запас до следующего подсорта; партии идут в дефицит, сумма не превышает лимит', async () => {
  const { calculate2d } = await model;
  const p = calculate2d({ settings, rows: [row('A', 300, 0), row('B', 300, 70), row('C', 300, 100)] });
  assert.equal(p.rows[0].quantity, 70); assert.equal(p.rows[1].quantity, 0); assert.equal(p.total, 70); assert.equal(p.left, 70);
  const fill = calculate2d({ settings: { ...settings, fill: true }, rows: [row('A', 300, 0), row('B', 300, 70)] });
  assert.equal(fill.total, 140); assert.ok(fill.rows.every(r => r.quantity % 10 === 0));
  const limited = calculate2d({ settings: { ...settings, total: 25 }, rows: [row('A', 300, 0), row('B', 300, 0)] });
  assert.equal(limited.total, 20); assert.equal(limited.left, 5); assert.equal(limited.rows[0].quantity, 10); assert.equal(limited.rows[1].quantity, 10);
});
test('Ручные значения резервируют лимит, ноль закрепляется, кратность проверяется; неизвестное не равно нулю', async () => {
  const { calculate2d } = await model;
  const p = calculate2d({ settings: { ...settings, total: 50 }, rows: [row('A', 300, 0, 40), row('B', 300, 0), row('C', 300, 0, 0)] });
  assert.deepEqual(p.rows.map(r => r.quantity), [40, 10, 0]);
  const bad = calculate2d({ settings, rows: [row('A', 300, 0, 15)] }); assert.equal(bad.issues.length, 1);
  const missing = calculate2d({ settings: { ...settings, fill: true }, rows: [row('A', null, 0), row('B', 300, null), { ...row('C', 300, 0), transit: null }, row('D', 0, 0)] });
  assert.equal(missing.total, 0); assert.ok(missing.rows.slice(0, 3).every(r => r.need === null));
  const transit = calculate2d({ settings, rows: [{ ...row('A', 300, 0), transit: 70 }] }); assert.equal(transit.total, 0);
  const excluded = calculate2d({ settings, rows: [{ ...row('A', 300, 0, 40), enabled: false }] }); assert.equal(excluded.total, 0);
});
test('Нулевой лимит, ручное превышение, валидация и большой объём', async () => {
  const { calculate2d, validate2d } = await model;
  assert.equal(calculate2d({ settings: { ...settings, total: 0 }, rows: [row('A', 300, 0)] }).total, 0);
  assert.equal(calculate2d({ settings: { ...settings, total: 20 }, rows: [row('A', 300, 0, 50)] }).over, 30);
  assert.throws(() => validate2d({ settings, rows: [row('A', 1, 0), row('a', 1, 0)] }), /не повторяться/);
  assert.throws(() => validate2d({ settings: { ...settings, multiple: 0 }, rows: [] }), /Кратность/);
  const p = calculate2d({ settings: { ...settings, multiple: 1, total: 100000, fill: true }, rows: Array.from({ length: 100 }, (_, i) => row('A' + i, 300, 0)) });
  assert.equal(p.total, 100000);
});

const store = new Map([['prod:defly:master', '{"unchanged":true}'], ['prod:defly:orders', '[{"id":"old"}]']]);
const query = async (sql, args = []) => sql.includes('SELECT value') ? store.has(args[0]) ? [{ value: store.get(args[0]) }] : [] : [];
const client = { query: async (sql, args = []) => {
  if (sql.includes('SELECT value')) return { rows: await query(sql, args) };
  if (sql.includes('INSERT INTO app_settings')) store.set(args[0], args[1]);
  return { rows: [] };
}, release() {} };
require.cache[require.resolve('../src/db')] = { exports: { query, getPool: () => ({ connect: async () => client }) } };
const router = require('../src/routes/deflectors2d');
async function call(path, body) {
  let status = 200, value;
  const res = { set() {}, status(n) { status = n; return this; }, json(v) { value = v; } };
  const route = router.stack.find(x => x.route?.path === path && x.route.methods.post);
  await route.route.stack[0].handle({ query: {}, body }, res);
  return { status, ...value };
}
test('Черновик и журнал отдельны от чехлов; версия, повтор запроса и неизменность снимка', async () => {
  const draft = { settings, rows: [row('A', 300, 0), row('B', 300, 0)] };
  const save = await call('/draft', { revision: 0, draft }); assert.equal(save.status, 200); assert.equal(save.data.revision, 1);
  const request = { revision: 1, draft, offers: ['A'], requestId: 'test-request-1', date: '2026-10-29', columns: ['offer', 'quantity'], note: 'Подсорт' };
  const fix = await call('/journal', request); assert.equal(fix.status, 200); assert.equal(fix.data.journal.length, 1); assert.equal(fix.data.journal[0].total, 70);
  const changed = structuredClone(draft); changed.rows[0].manual = 10;
  const edit = await call('/draft', { revision: 2, draft: changed }); assert.equal(edit.status, 200); assert.equal(edit.data.journal[0].items[0].quantity, 70);
  const retry = await call('/journal', request); assert.equal(retry.status, 200); assert.equal(retry.data.revision, 3); assert.equal(retry.data.journal.length, 1);
  assert.equal((await call('/draft', { revision: 1, draft })).status, 409);
  assert.equal((await call('/journal', { ...request, note: 'Другое' })).status, 409);
  assert.equal((await call('/journal', { ...request, requestId: 'test-request-2', date: '2026-02-30' })).status, 400);
  assert.equal((await call('/draft', { cabinet: 'licio', revision: 3, draft })).status, 400);
  assert.equal(store.get('prod:defly:master'), '{"unchanged":true}'); assert.equal(store.get('prod:defly:orders'), '[{"id":"old"}]');
});
