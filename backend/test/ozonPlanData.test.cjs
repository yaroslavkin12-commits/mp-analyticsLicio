const { test } = require('node:test');
const assert = require('node:assert/strict');
const realDayjs = require('dayjs');
const { SHOPS } = require('../src/lib/ozonPlan');
const p = 'Чехлы / Чехлы на сиденья';
let concurrent = 0, maxConcurrent = 0, disconnected = false;
const arts = [{ o: 'A', cat: p + ' / Жаккард' }];
require.cache[require.resolve('../src/db')] = { exports: { query: async () => [{ last_success_at: '2026-10-20T00:00:00Z' }] } };
require.cache[require.resolve('../src/config/cabinets')] = { exports: { CABINETS: Object.fromEntries([...SHOPS,'licio'].map(id => [id, { label: id }])), isConnected: id => !(disconnected && id === 'accent') } };
require.cache[require.resolve('../src/routes/finance')] = { exports: {
  meta: async () => ({ articles: arts }),
  loadCoefs: async () => ({ articles: arts, coefs: [], noSku: {}, totalSale: 0, fbsDays: [] }),
  loadPnl: async params => {
    concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise(r => setTimeout(r, 2)); concurrent--;
    const dates = []; for (let d = realDayjs(params.dateFrom); d.format('YYYY-MM-DD') <= params.dateTo; d = d.add(1, 'day')) dates.push(d.format('YYYY-MM-DD'));
    return { dates, articles: arts, buckets: ['sale', 'commission', 'storage', 'ads'], rows: [[0, 0, 0, 1000, 1], [0, 0, 1, -100, 0]], noSku: [[0, 2, -20]], ads: [[0, 0, 10]], adNoSku: dates.map(() => 0), cost: [null], available: { mn: '2020-01-01', mx: '2099-01-01' } };
  },
} };
require.cache[require.resolve('../src/routes/sales')] = { exports: { loadSales: async params => ({ dates: [params.dateFrom], articles: arts, rows: [[0, 0, 100, 20, 5, 1, 1000, 10, 0]] }) } };
const data = require('../src/lib/ozonPlanData');
test('Реальный адаптер: P&L и прогноз используют существующие модели, сохраняется область версии', async () => {
  const b = await data.basis('2026-09-01', '2026-09-30', 'forecast');
  assert.deepEqual(b.paths, [p]);
  assert.equal(b.shops.defly.byPath[p].qty, 1);
  assert.equal(b.shops.defly.byPath[p].payout, 870);
  assert.equal(b.shops.defly.byPath[p].forecast.qty, 0.8);
  assert.equal(b.shops.defly.byPath[p].forecast.payout, 618);
  const e = await data.execution('2026-09', { targets: [{ path: 'Старая категория' }], taxonomy: { defly: { A: 'Старая категория' } } });
  assert.equal(e.shops.defly.byPath['Старая категория'].qty, 1);
  assert.equal(e.shops.defly.byPath[p], undefined);
  assert.equal(e.shops.nabauto.byPath[p].qty, 1);
});
test('Агрегации не выполняются одновременно; отключённый кабинет — ошибка, а не ноль', async () => {
  disconnected = true;
  const [b] = await Promise.all([data.basis('2026-08-01', '2026-08-30', 'fact'), data.execution('2026-08', null)]);
  assert.equal(maxConcurrent, 1);
  assert.equal(b.shops.accent.error, 'магазин не подключён');
  assert.deepEqual(b.shops.accent.byPath, {});
});
test('Проверка периодов не пропускает невозможные даты или свежие незавершённые дни', () => {
  assert.throws(() => data.checkPeriod('2026-02-30', '2026-03-01'));
  assert.throws(() => data.checkPeriod('2026-01-01', '2026-09-01'));
  assert.throws(() => data.checkPeriod(data.cutoff(), realDayjs(data.cutoff()).add(1, 'day').format('YYYY-MM-DD')));
  assert.equal(data.validMonth('2026-13'), false);
});

test('Выполнение включает сегодняшний день, база — вчера, три последних дня не исключаются', async () => {
  disconnected = false;
  const now = realDayjs().tz('Europe/Moscow');
  assert.equal(data.cutoff(), now.subtract(1,'day').format('YYYY-MM-DD'));
  const e = await data.execution(now.format('YYYY-MM'), null);
  assert.equal(e.to, now.format('YYYY-MM-DD'));
  assert.equal(e.provisional, true);
  assert.ok(e.elapsedDays >= now.date()-1 && e.elapsedDays <= now.date());
  assert.equal(e.shops.defly.partial, false);
});

test('Адаптер плана Licio не загружает финансы или каталог других магазинов',async()=>{
 const b=await data.basis('2026-09-01','2026-09-30','fact',true,['licio']);
 assert.deepEqual(Object.keys(b.shops),['licio']);assert.deepEqual(Object.keys(b.taxonomy),['licio']);
 const e=await data.execution('2026-09',null,['licio']);assert.deepEqual(Object.keys(e.shops),['licio']);assert.equal(e.shops.licio.byPath[p].qty,1);
});
