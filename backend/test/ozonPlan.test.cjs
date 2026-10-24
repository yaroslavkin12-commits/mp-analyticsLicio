const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SHOPS, allocate, integerShares, taxonomy, validateTargets } = require('../src/lib/ozonPlan');
const path = 'Чехлы / Чехлы на сиденья';
const makeBasis = (qty = [950, 20, 10, 10, 10]) => ({ paths: [path], taxonomy: {}, from: '2026-09-01', to: '2026-09-30', shops: Object.fromEntries(SHOPS.map((id, i) => [id, { label: id, byPath: { [path]: { qty: qty[i], payout: qty[i] * (i ? 1200 : 1000), forecast: { qty: qty[i], payout: qty[i] * (i ? 1400 : 1100) } } } }])) });
const target = (extra = {}) => [{ path, qty: 1000, mean: 1111, ...extra }];

test('Доли категории, точная сумма штук и взвешенная денежная цель', () => {
  const v = allocate(target(), makeBasis());
  assert.deepEqual(v.errors, []);
  const r = v.rows[0];
  assert.deepEqual(r.shops.map(s => s.qty), [950, 20, 10, 10, 10]);
  assert.equal(r.factor, 1.1);
  assert.equal(r.shops[0].mean, 1100);
  assert.equal(r.shops.reduce((s, x) => s + x.amount, 0), 1111000);
  assert.ok(Math.abs(r.shops.reduce((s, x) => s + x.qty * x.mean, 0) / 1000 - 1111) < 1e-9);
});
test('Целочисленное распределение: остатки, нулевой вес, маленькие планы', () => {
  assert.deepEqual(integerShares(2, [1, 1, 1, 0, 0]), [1, 1, 0, 0, 0]);
  for (let n = 1; n < 100; n++) {
    const r = integerShares(n, [0, 0.71, 0.19, 0.09, 0.01]);
    assert.equal(r.reduce((s, q) => s + q, 0), n); assert.equal(r[0], 0);
    assert.ok(r.every(Number.isSafeInteger));
  }
});
test('Распределение разных подкатегорий использует собственные доли', () => {
  const b = makeBasis(); const second = 'Чехлы / Чехлы на подлокотник';
  SHOPS.forEach((id, i) => { b.shops[id].byPath[second] = { qty: i === 1 ? 100 : 0, payout: i === 1 ? 50000 : 0 }; });
  const v = allocate([...target(), { path: second, qty: 101, mean: 600 }], b);
  assert.equal(v.rows[1].shops[1].qty, 101); assert.equal(v.rows[1].shops[0].qty, 0);
  const sumQ = v.rows.reduce((s, x) => s + x.qty, 0), sumA = v.rows.reduce((s, x) => s + x.amount, 0);
  assert.equal(sumQ, 1101); assert.ok(Math.abs(sumA / sumQ - ((1000 * 1111 + 101 * 600) / 1101)) < 1e-9);
});
test('Не ждёт пустые категории; пересекающиеся родители и дубли отклоняются', () => {
  assert.equal(allocate(target(), makeBasis()).rows.length, 1);
  assert.throws(() => validateTargets([...target(), { path: 'Чехлы', qty: 100, mean: 20 }]), /родителя/);
  assert.throws(() => validateTargets([...target(), ...target()]), /уникальными/);
  assert.throws(() => validateTargets(target({ qty: 1.5 })), /целые/);
  assert.throws(() => validateTargets(target({ qty: null })), /целые/);
  assert.throws(() => validateTargets(target({ mean: -1 })), /положительное/);
});
test('Нет истории, неполные/отрицательные данные: нужно явное ручное решение', () => {
  const b = makeBasis(); b.shops.defly.error = 'таймаут';
  assert.ok(allocate(target(), b).errors.some(s => s.includes('долю вручную')));
  const v = allocate(target({ weights: { defly: 0 } }), b);
  assert.equal(v.rows[0].shops[0].qty, 0); assert.equal(v.errors.length, 0); assert.ok(v.warnings.length);
  const none = makeBasis([0, 0, 0, 0, 0]);
  assert.ok(allocate(target(), none).errors.length);
  assert.equal(allocate(target({ weights: { defly: 100 }, means: { defly: 900 } }), none).rows[0].shops[0].mean, 1111);
  const negative = makeBasis([-1, 20, 10, 10, 10]);
  assert.ok(allocate(target(), negative).errors.some(s => s.includes('возвратов')));
  const zeroMean = makeBasis(); zeroMean.shops.defly.byPath[path].payout = -100;
  assert.ok(allocate(target(), zeroMean).errors.some(s => s.includes('среднего')));
});
test('Нулевой план сохраняется явно; ошибка прогноза не превращается в ноль', () => {
  assert.equal(allocate(target({ qty: 0 }), makeBasis([0, 0, 0, 0, 0])).rows[0].qty, 0);
  const b = makeBasis(); b.shops.defly.byPath[path].forecast.missing = true;
  assert.ok(allocate(target(), b, 'forecast').errors.length);
  assert.equal(allocate(target({ means: { defly: 1000 } }), b, 'forecast').errors.length, 0);
});
test('Таксономия общая для пяти магазинов, прямые товары не теряются', () => {
  const t = taxonomy({ defly: [{ o: 'A', cat: 'Чехлы' }], nabauto: [{ o: 'B', cat: path + ' / Жаккард' }] });
  assert.equal(t.byShop.defly.A, 'Чехлы / Без подкатегории');
  assert.equal(t.byShop.nabauto.B, path);
  assert.equal(t.paths.length, 2);
});
test('Разбивка P&L по дням сохраняет прежние итоги, расходы без SKU и свежую рекламу', async () => {
  const { pnlTotals } = await import('../../dashboard/src/lib/pnlCalc.js');
  const data = { dates: ['2026-09-01', '2026-09-02'], articles: [{ o: 'A', cat: path }, { o: 'B', cat: 'Дефлекторы' }], buckets: ['sale', 'return', 'commission', 'ads', 'storage'],
    rows: [[0, 0, 0, 1000, 2], [1, 0, 0, 500, 1], [0, 0, 2, -100, 0], [0, 0, 3, -40, 0], [0, 1, 0, 500, 1], [1, 1, 1, -100, 1]],
    noSku: [[0, 4, -30], [0, 3, -10], [1, 0, 50]], ads: [[0, 0, 40], [1, 0, 10], [0, 1, 60]], adNoSku: [0, 5], self: [], cost: [100, 50] };
  const old = pnlTotals(data, { groupOf: a => a.cat });
  const next = pnlTotals(data, { groupOf: a => a.cat, withDays: true });
  for (const [k, v] of Object.entries(old.total)) assert.equal(next.total[k], v);
  for (const p of Object.keys(old.byGroup)) {
    for (const [k, v] of Object.entries(old.byGroup[p])) assert.equal(next.byGroup[p][k], v);
    assert.ok(Math.abs(next.byGroup[p].days.reduce((s, d) => s + d.payout, 0) - next.byGroup[p].payout) < 1e-9);
  }
  assert.equal(next.total.qty, 3); assert.equal(next.total.payout, 1705);
});
