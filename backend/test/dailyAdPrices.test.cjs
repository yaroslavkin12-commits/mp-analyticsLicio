const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeDailyPrices } = require('../src/lib/dailyAdPrices');
test('Средние замеров важнее истории и последнего снимка; пропуски не превращаются в нули', () => {
  const base = { offer_id: 'A', d: '2026-11-06' };
  const result = mergeDailyPrices([{ ...base, seller: '150', client: null }],
    [{ ...base, seller: '130', client: '90' }], [{ ...base, seller: '200', client: '100' }]);
  assert.deepEqual(result.get('A|2026-11-06'), { sellerPrice: 150, clientPrice: 90 });
  assert.equal(result.has('A|2026-11-05'), false);
});
test('Дни и артикулы независимы; недействительные цены исключаются', () => {
  const result = mergeDailyPrices([], [], [
    { offer_id: 'A', d: '2026-11-05', seller: 200, client: 100 },
    { offer_id: 'A', d: '2026-11-06', seller: -1, client: 0 },
    { offer_id: 'B', d: '2026-11-06', seller: 'NaN', client: 50 },
  ]);
  assert.deepEqual(result.get('A|2026-11-06'), { sellerPrice: null, clientPrice: null });
  assert.deepEqual(result.get('B|2026-11-06'), { sellerPrice: null, clientPrice: 50 });
});
test('Все замеры дня учитываются: 100, 100, 160 дают среднее 120; нулевая цена не участвует', async () => {
  const vm = require('node:vm'), fs = require('node:fs');
  let sellerSum = 0, sellerCount = 0, clientSum = 0, clientCount = 0;
  const context = { module: { exports: {} }, require: () => ({ query: async (sql, params) => {
    if (sql.startsWith('INSERT')) {
      sellerSum += params[2]; sellerCount += params[3];
      clientSum += params[4]; clientCount += params[5];
    }
    return [];
  } }) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/lib/dailyAdPrices'), 'utf8'), context);
  for (const seller of [100, 100, 160]) await context.module.exports.recordDailyAdPrices('defly', [{ offer: 'A', seller, card: seller === 160 ? 0 : 80 }]);
  assert.equal(sellerSum / sellerCount, 120);
  assert.equal(clientSum / clientCount, 80);
  assert.equal(clientCount, 2);
});
