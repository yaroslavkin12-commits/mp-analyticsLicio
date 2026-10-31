const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reconcile, pendingMap, mergeTransit } = require('../src/lib/deflectorsTransit');
const batch = (id, quantity, createdAt = '2026-10-01T00:00:00Z', cabinet = 'defly') => ({ id, tracked: true, createdAt, receivingCabinet: cabinet, expectedDate: '2026-10-10', items: [{ offer: 'A', quantity }] });
const event = (id, delta, at = '2026-10-02T00:00:00Z', cabinet = 'defly') => ({ id, at, cabinet, offer_id: 'a', fbo_before: 6, fbo_after: 6 + delta, fbs_before: 0, fbs_after: 0 });
test('Частичная приёмка, FIFO, один и тот же прирост не списывается повторно', () => {
  const original = [batch('second', 50, '2026-10-01T01:00:00Z'), batch('first', 60)];
  const result = reconcile(original, [event('1', 40), event('1', 40)]);
  assert.equal(result[1].remaining, 20); assert.equal(result[0].remaining, 50);
  const next = reconcile(original, [event('1', 40), event('2', 50)]);
  assert.equal(next[1].remaining, 0); assert.equal(next[0].remaining, 20);
  assert.equal(next[0].items[0].receipts[0].quantity, 30);
  assert.equal(pendingMap(next, 'defly').a.q, 20);
  assert.equal(original[0].items[0].received, undefined);
});
test('Не списываем прошлые события, другой кабинет, перемещение без общего прироста и архив', () => {
  const archived = { ...batch('old', 100), tracked: false };
  const list = reconcile([batch('new', 20), archived], [event('1', 40, '2026-09-30'), event('2', 40, undefined, 'alex'), event('3', -5), { ...event('4', 10), fbs_before: 10 }]);
  assert.equal(list[0].remaining, 20); assert.equal(list[1].remaining, null);
  assert.deepEqual(pendingMap(list, 'alex'), {});
});
test('Излишек не переносится на заявку, созданную после события', () => {
  const list = reconcile([batch('first', 20), batch('later', 30, '2026-10-03T00:00:00Z')], [event('1', 100)]);
  assert.equal(list[0].remaining, 0); assert.equal(list[1].remaining, 30);
});
test('Реклама складывает ручное ожидание и открытые заявки, не меняет ручные данные', () => {
  const journal = reconcile([batch('first', 60)], [event('1', 40)]), manual = { A: { q: 10, d: '2026-10-05' }, B: 8 };
  const result = mergeTransit(journal, 'defly', manual);
  assert.equal(result.A.q, 30); assert.equal(result.A.productionQty, 20); assert.equal(result.A.manualQty, 10);
  assert.equal(result.B, 8); assert.equal(manual.A.q, 10);
});
test('Срок поступления увеличивает горизонт потребности; ручной ввод сохраняет приоритет', async () => {
  const { calculate2d } = await import('../../dashboard/src/lib/deflectors2d.mjs');
  const input = { settings: { multiple:10,periodDays:7,leadDays:7,salesDays:30,total:140,stockSource:'live' }, rows:[{offer:'A',sales:300,stock:999,transit:999,manual:null}] };
  const result = calculate2d(input, null, {byOffer:{a:{stock:20,transit:40}}});
  assert.equal(result.rows[0].need, 80); assert.equal(result.rows[0].quantity, 80);
  input.rows[0].manual = 30;
  assert.equal(calculate2d(input,null,{byOffer:{a:{stock:20,transit:40}}}).rows[0].quantity,30);
});
test('Прогноз не использует неподанные заявки и не считает неизвестный остаток нулём', async () => {
  const { buildReplenishmentForecast } = await import('../../dashboard/src/lib/replenishmentForecast.mjs');
  const args={today:'2026-10-30',rows:[{offer:'A',stock:10,rate:2,quantity:999}],history:[],journal:[{tracked:true,expectedDate:'2026-11-01',items:[{offer:'A',remaining:20}]}]};
  const result=buildReplenishmentForecast(args);
  assert.equal(result.points[1].forecast,8);assert.equal(result.points[2].forecast,26);
  const missing=buildReplenishmentForecast({...args,rows:[{offer:'A',stock:null,rate:2}]});
  assert.equal(missing.missing,1);assert.equal(missing.points[0].actual,null);assert.equal(missing.points.length,1);
  assert.equal(buildReplenishmentForecast({...args,journal:[{tracked:true,expectedDate:'2026-10-29',items:[{offer:'A',remaining:20}]}]}).overdue,20);
});

test('Старый черновик сохраняет ручные остатки и в пути без сложения с ручной рекламой', async () => {
  const { calculate2d, validate2d, afterSubmission2d } = await import('../../dashboard/src/lib/deflectors2d.mjs');
  const old = { settings: { multiple:10, periodDays:7, salesDays:30, total:140 }, rows:[{offer:'A',sales:300,stock:15,transit:20,manual:30}] };
  const inv = { byOffer:{a:{stock:999,transit:70,productionTransit:40}} };
  const validated = validate2d(old);
  assert.equal(validated.settings.stockSource,'manual');
  assert.equal(validated.settings.transitSource,'manual');
  const row = calculate2d(old,null,inv).rows[0];
  assert.equal(row.stock,15); assert.equal(row.transit,60);
  assert.equal(row.legacyTransit,20);
  const next = afterSubmission2d(validated,['A']);
  assert.equal(next.rows[0].manual,0); assert.equal(next.rows[0].stock,15); assert.equal(next.rows[0].transit,20);
  assert.equal(calculate2d(next,null,inv).total,0);
  assert.equal(old.rows[0].manual,30);
});
test('Инвентарь: старый снимок не текущий остаток, история и ручная добавка сохраняются', async () => {
  const { inventory } = require('../src/lib/deflectorsTransit');
  const run = async sql => sql.includes('ad_product_stocks') ? [
    {offer_id:'A',date:'2026-10-20',fbo_present:15,fbs_present:2,fresh:false},
    {offer_id:'B',date:'2026-10-31',fbo_present:9,fbs_present:1,fresh:true},
  ] : sql.includes('SELECT value') ? [{value:JSON.stringify({A:20})}] : [];
  const inv = await inventory({journal:[]},'defly',run);
  assert.equal(inv.byOffer.a.stock,null);assert.equal(inv.byOffer.a.stale,true);assert.equal(inv.byOffer.a.transit,20);
  assert.equal(inv.byOffer.b.stock,10);assert.equal(inv.history[0].stock,17);
});

test('Актуальный остаток перекрывает старое ручное значение и не подменяется им при загрузке', async () => {
  const { calculate2d } = await import('../../dashboard/src/lib/deflectors2d.mjs');
  const draft = {settings:{multiple:10,periodDays:7,salesDays:30,total:140,stockSource:'live'},rows:[{offer:'A',sales:300,stock:999,transit:0,manual:null}]};
  assert.equal(calculate2d(draft).rows[0].stock,null);
  assert.equal(calculate2d(draft,null,{byOffer:{a:{stock:17,transit:0}}}).rows[0].stock,17);
  assert.equal(draft.rows[0].stock,999);
});
