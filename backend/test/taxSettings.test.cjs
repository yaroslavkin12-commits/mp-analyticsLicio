const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
function load(file, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve(file), 'utf8'), { module, exports: module.exports, require: p => mocks[p] || require(p), console });
  return module.exports;
}
function service() {
  const values = new Map();
  const query = async (sql, args) => {
    if (sql.includes('INSERT INTO')) { values.set(args[0], args[1]); return []; }
    return values.has(args[0]) ? [{ value: values.get(args[0]) }] : [];
  };
  return load('../src/lib/taxSettings', { '../db': { query }, '../config/cabinets': { CABINETS: { defly: {}, licio: {} } } });
}
test('Отключение налога сохраняет ставку, действует после повторного чтения и не затрагивает другой магазин', async () => {
  const s = service();
  assert.equal((await s.getTaxSettings('defly')).effectiveRate, 6);
  assert.equal((await s.getTaxSettings('defly')).configured, false);
  await s.saveTaxSettings('defly', { enabled: false, rate: 7.5 });
  assert.equal((await s.getTaxSettings('defly')).effectiveRate, 0);
  assert.equal((await s.getTaxSettings('defly')).rate, 7.5);
  assert.equal((await s.getTaxSettings('licio')).effectiveRate, 6);
  await s.saveTaxSettings('defly', { enabled: true, rate: 7.5 });
  assert.equal((await s.getTaxSettings('defly')).effectiveRate, 7.5);
  await s.saveTaxSettings('defly', { enabled: true, rate: 0 });
  assert.equal((await s.getTaxSettings('defly')).effectiveRate, 0);
});
test('Некорректные ставки и неизвестные магазины не сохраняются', async () => {
  const s = service();
  for (const rate of [-1, 101, NaN, Infinity, '6', null]) await assert.rejects(s.saveTaxSettings('defly', { enabled: true, rate }), { status: 400 });
  await assert.rejects(s.saveTaxSettings('defly', { enabled: 'false', rate: 6 }), { status: 400 });
  await assert.rejects(s.getTaxSettings('__proto__'), { status: 400 });
  assert.equal((await s.getTaxSettings('defly')).effectiveRate, 6);
});
test('API налога отдаёт сохранённую настройку, запрещает кэш и возвращает 400 при ошибке', async () => {
  const s = service();
  const router = load('../src/routes/settings', { '../db': { query: async () => [] }, '../scheduler': {}, '../lib/taxSettings': s });
  async function call(method, body = {}, query = {}) {
    let status = 200, result; const headers = {};
    const res = { set: (k, v) => { headers[k] = v; }, status(n) { status = n; return this; }, json(v) { result = v; } };
    const layer = router.stack.find(x => x.route?.path === '/tax' && x.route.methods[method]);
    await layer.route.stack[0].handle({ body, query }, res);
    return { status, result, headers };
  }
  assert.equal((await call('post', { cabinet: 'defly', enabled: false, rate: 6 })).status, 200);
  const r = await call('get', {}, { cabinet: 'defly' });
  assert.equal(r.result.data.effectiveRate, 0); assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.equal((await call('post', { cabinet: 'defly', enabled: true, rate: -1 })).status, 400);
});
test('Telegram-расчёт подчиняется общему отключению, несмотря на старую отдельную ставку', async () => {
  let enabled = true;
  const digest = load('../src/digest', {
    './config/cabinets': { familyOf: c => c },
    './telegram': { sendMessage: () => { throw Error('Тест не должен отправлять сообщения'); } },
    './lib/taxSettings': { getTaxSettings: async () => ({ configured: true, effectiveRate: enabled ? 6 : 0 }) },
    './db': { query: async (sql, args) => sql.includes('SUM(orders_item)::int q') ? [{ d: args[2], q: 1, r: 1000 }] : sql.includes('SELECT value') && args[0].startsWith('morning_digest:') ? [{ value: '{"tax":15}' }] : [] },
  });
  assert.match(await digest.buildMorningDigest('defly'), /<b>432 ₽<\/b>/);
  enabled = false;
  const text = await digest.buildMorningDigest('defly');
  assert.match(text, /<b>480 ₽<\/b>/); assert.match(text, /налог 0%/);
});
