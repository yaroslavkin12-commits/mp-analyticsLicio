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

test('Ozon: несколько кабинетов складываются, темп учитывает 7/14/30, динамика сравнивает равные периоды', async () => {
  const { buildOzonDemand, calculate2d } = await model;
  const to = '2026-10-28', shops = [{ id: 'defly' }, { id: 'alex' }], coverage = [], sales = [];
  for (let i = 0; i < 400; i++) {
    const date = new Date(Date.parse(to) - i * 86400000).toISOString().slice(0, 10);
    for (const c of shops) { coverage.push({ cabinet: c.id, date }); sales.push({ cabinet: c.id, date, offer_id: 'A', orders_item: i < 7 ? 2 : 1 }); }
  }
  // Посторонний кабинет не может попасть в сумму.
  sales.push({ cabinet: 'licio', date: to, offer_id: 'A', orders_item: 999 });
  const d = buildOzonDemand({ to, articles: [{ offer: 'A' }], shops, sales, coverage });
  const a = d.articles[0];
  assert.equal(a.periods.d7.quantity, 28); assert.equal(a.periods.d14.quantity, 42); assert.equal(a.periods.d30.quantity, 74);
  assert.equal(a.trend7, 100); assert.ok(Math.abs(a.rate - (4 * .5 + 3 * .3 + 74 / 30 * .2)) < 1e-9);
  assert.equal(a.periods.d365.quantity, 744); assert.equal(a.periods.lastYear30.quantity, 60);
  const draft = { settings: { ...settings, source: 'ozon' }, rows: [row('A', 999, 0)], annual: { from: '2025-10-29', to, file: '1c.xlsx', items: { a: 3650 } } };
  const p = calculate2d(draft, d); assert.equal(p.rows[0].annual1c, 3650); assert.equal(p.rows[0].rate, a.rate); assert.equal(p.total, 30);
  assert.equal(calculate2d(draft).rows[0].rate, null); assert.equal(calculate2d(draft).total, 0);
});
test('Ozon: пропуски не нули, неполный кабинет исключает период; веса нормализуются', async () => {
  const { buildOzonDemand } = await model;
  const to = '2026-10-28', shops = [{ id: 'defly' }, { id: 'nabauto' }], coverage = [], sales = [];
  for (let i = 0; i < 30; i++) { const date = new Date(Date.parse(to) - i * 86400000).toISOString().slice(0, 10); for (const c of shops) { if (c.id === 'nabauto' && i === 10) continue; coverage.push({ cabinet: c.id, date }); sales.push({ cabinet: c.id, date, offer_id: 'A', orders_item: 1 }); } }
  const d = buildOzonDemand({ to, shops, articles: [{ offer: 'A' }, { offer: 'B' }], sales, coverage });
  assert.equal(d.articles[0].periods.d7.quantity, 14); assert.equal(d.articles[0].periods.d14.quantity, null); assert.equal(d.articles[0].periods.d30.quantity, null);
  assert.equal(d.articles[0].rate, 2); assert.deepEqual(d.articles[0].ratePeriods, [7]); assert.equal(d.articles[0].trend7, null);
  assert.equal(d.articles[1].periods.d7.quantity, 0); assert.equal(d.articles[1].rate, 0);
  coverage.splice(coverage.findIndex(r => r.cabinet === 'nabauto' && r.date === to), 1);
  const missing = buildOzonDemand({ to, shops, articles: [{ offer: 'A' }], sales, coverage }); assert.equal(missing.articles[0].rate, null);
});
test('1С: выбор колонок, объединение повторов, нули, ошибки и годовой период; Ozon не задваивается', async () => {
  const { parseAnnual2d, validate2d, calculate2d } = await model;
  const p = parseAnnual2d([['Название', 'Количество', 'Артикул'], ['Товар', '1 200', 'Ab'], ['Товар', '300', 'ab'], ['Товар', 0, 'C'], ['Итог', 1500, 'Итого']], 2, 1, 1);
  assert.deepEqual({ ...p.items }, { ab: 1500, c: 0 }); assert.deepEqual(p.rejected, []);
  assert.deepEqual(parseAnnual2d([['A', -1], ['B', ' '], ['C', '1,5'], ['D', 'x']], 0, 1).rejected, [1, 2, 3, 4]);
  const annual = { from: '2025-10-29', to: '2026-10-28', file: '1c.xlsx', items: p.items };
  const draft = { settings, rows: [row('Ab', 30, 0)], annual };
  assert.equal(validate2d(draft).annual.days, 365); assert.equal(calculate2d(draft).rows[0].annual1c, 1500); assert.equal(calculate2d(draft).rows[0].rate, 1);
  assert.throws(() => validate2d({ ...draft, annual: { ...annual, from: '2026-10-01' } }), /330/);
  assert.throws(() => validate2d({ ...draft, annual: { ...annual, to: '2026-02-30' } }), /даты/);
});
