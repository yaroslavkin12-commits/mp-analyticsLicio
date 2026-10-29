const { test } = require('node:test');
const assert = require('node:assert/strict');
const dayjs = require('../node_modules/dayjs');
const ids = ['defly', 'nabauto', 'alex', 'fullgas', 'accent'];
const to = dayjs(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date())).subtract(1, 'day').format('YYYY-MM-DD');
const dates = Array.from({ length: 400 }, (_, i) => dayjs(to).subtract(i, 'day').format('YYYY-MM-DD'));
const store = new Map(); let units = 2; const calls = [];
const query = async (sql, args = []) => {
  calls.push([sql, args]);
  if (sql.includes('SELECT value')) return store.has(args[0]) ? [{ value: store.get(args[0]) }] : [];
  if (sql.includes('FROM product_category_override')) return [];
  if (sql.includes('FROM ad_product_catalog')) return ids.map((cabinet, i) => ({ cabinet, offer_id: 'A', sku: String(i + 1), product_name: 'Дефлекторы окон 2D Test' }));
  if (sql.includes('FROM product_analytics_daily')) {
    assert.deepEqual([...args[0]].sort(), [...ids].sort());
    if (sql.includes('GROUP BY cabinet, date')) return ids.flatMap(cabinet => dates.map(date => ({ cabinet, date })));
    return ids.flatMap((cabinet, i) => dates.map(date => ({ cabinet, date, sku: String(i + 1), offer_id: i === 1 ? null : 'A', orders_item: units })));
  }
  if (sql.includes('FROM self_buyouts')) return dates.map(date => ({ cabinet: 'defly', sku: '1', date, qty: 1 }));
  throw new Error('Неожиданный SQL: ' + sql);
};
const client = { query: async (sql, args = []) => {
  if (sql.includes('SELECT value')) return { rows: await query(sql, args) };
  if (sql.includes('INSERT INTO app_settings')) store.set(args[0], args[1]);
  return { rows: [] };
}, release() {} };
require.cache[require.resolve('../src/db')] = { exports: { query, getPool: () => ({ connect: async () => client }) } };
const router = require('../src/routes/deflectors2d');
async function call(path, method = 'get', body = {}) {
  let status = 200, value;
  const route = router.stack.find(x => x.route?.path === path && x.route.methods[method]);
  await route.route.stack[0].handle({ query: { refresh: '1' }, body }, { set() {}, status(n) { status = n; return this; }, json(v) { value = v; } });
  return { status, ...value };
}
test('Адаптер Ozon: все пять кабинетов, SKU, вычет самовыкупов, версия и неизменный журнал с 1С', async () => {
  assert.equal((await call('/')).data.draft.settings.source, 'ozon');
  const catalog = await call('/catalog'); assert.equal(catalog.data.length, 1);
  const first = await call('/demand'); assert.equal(first.status, 200); assert.equal(first.data.shops.length, 5);
  assert.equal(first.data.articles[0].periods.d7.quantity, 63); assert.equal(first.data.articles[0].rate, 9);
  assert.equal((await call('/demand')).data.version, first.data.version); assert.equal(store.size, 0);
  const draft = { settings: { multiple: 10, periodDays: 7, salesDays: 30, total: 140, source: 'ozon' }, rows: [{ offer: 'A', name: 'A', sales: 99999, stock: 0, transit: 0, manual: null }], annual: { from: '2025-10-29', to: '2026-10-28', file: 'Год.xlsx', items: { a: 365 } } };
  const request = { revision: 0, draft, offers: ['A'], date: to, note: '', columns: ['offer', 'quantity', 'q7', 'annual1c'], requestId: 'ozon-journal-1', demandVersion: first.data.version };
  units = 3;
  assert.equal((await call('/journal', 'post', request)).status, 409); assert.equal(store.size, 0);
  units = 2;
  const saved = await call('/journal', 'post', request); assert.equal(saved.status, 200); assert.equal(saved.data.journal.length, 1);
  const snapshot = saved.data.journal[0]; assert.equal(snapshot.total, 70); assert.equal(snapshot.items[0].q7, 63); assert.equal(snapshot.items[0].annual1c, 365); assert.equal(snapshot.demand.shops.length, 5);
  units = 3;
  const repeat = await call('/journal', 'post', request); assert.equal(repeat.status, 200); assert.equal(repeat.data.journal.length, 1);
  const modified = structuredClone(draft); modified.annual.items.a = 999;
  const edit = await call('/draft', 'post', { revision: 1, draft: modified }); assert.equal(edit.status, 200); assert.equal(edit.data.journal[0].items[0].annual1c, 365);
  assert.equal(edit.data.draft.annual.items.a, 999);
  const current = await call('/demand');
  const manual = structuredClone(modified); manual.settings.source = 'manual'; manual.rows[0].sales = 300;
  const manualSnapshot = await call('/journal', 'post', { ...request, draft: manual, revision: 2, requestId: 'manual-journal-2', demandVersion: current.data.version });
  assert.equal(manualSnapshot.status, 200); assert.equal(manualSnapshot.data.journal[0].items[0].q7, 98); assert.equal(manualSnapshot.data.journal[0].items[0].rate, 10);
  const previousSecret = process.env.ADS_SHEET_ID_DEFLY_WB;
  process.env.ADS_SHEET_ID_DEFLY_WB = 'x'.repeat(40);
  const bridge = require('../src/lib/wbBridge'), oldRead = bridge.read;
  try {
    const start = dayjs(to).subtract(6, 'day').format('YYYY-MM-DD');
    bridge.read = async () => [{ kind: 'orders', meta: { from: start, to }, rows: dates.slice(0, 7).map((date, i) => ({ id: String(i), date, offer: 'a', cancelled: false })) }];
    const mixed = await call('/demand'); assert.equal(mixed.status, 200); assert.equal(mixed.data.shops.length, 6); assert.equal(mixed.data.articles[0].periods.d7.quantity, 105); assert.equal(mixed.data.articles[0].rate, 15);
    assert.equal(mixed.data.articles[0].periods.d14.quantity, null);
    bridge.read = async () => [{ kind: 'orders', meta: { from: start, to: dayjs(to).subtract(1, 'day').format('YYYY-MM-DD') }, rows: [] }];
    assert.equal((await call('/demand')).data.articles[0].rate, null);
  } finally { bridge.read = oldRead; if (previousSecret === undefined) delete process.env.ADS_SHEET_ID_DEFLY_WB; else process.env.ADS_SHEET_ID_DEFLY_WB = previousSecret; }
  assert.ok(calls.filter(([sql]) => sql.includes('FROM product_analytics_daily')).every(([, args]) => !args[0].includes('licio')));
});
