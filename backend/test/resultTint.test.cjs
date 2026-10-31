const { test } = require('node:test');
const assert = require('node:assert/strict');
test('Итоги: рост прибыли, снижение ДРР, убыток и отсутствие сравнения', async () => {
  const { resultTint } = await import('../../dashboard/src/lib/resultTint.js');
  assert.equal(resultTint(120,100),'var(--a-good-soft)');
  assert.equal(resultTint(-120,-100),'var(--a-bad-soft)');
  assert.equal(resultTint(15,20,'down'),'var(--a-good-soft)');
  assert.equal(resultTint(20,15,'down'),'var(--a-bad-soft)');
  assert.equal(resultTint(0,10),'var(--a-bad-soft)');
  for (const v of [null,undefined,NaN]) assert.equal(resultTint(10,v),undefined);
  assert.equal(resultTint(10,10),undefined);
  assert.equal(resultTint(10,20,'neutral'),undefined);
});
