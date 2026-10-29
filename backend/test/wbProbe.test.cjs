const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
function run({ countCode = 200, stats = null, financeCode = 204 } = {}) {
  const calls = [], logs = [];
  const groups = [
    { type: 5, status: 7, advert_list: [{ advertId: 1 }] },
    { type: 9, status: 9, advert_list: [{ advertId: 2 }, { advertId: 3 }] },
    { type: 9, status: 11, advert_list: [{ advertId: 4 }] },
    { type: 9, status: 7, advert_list: [{ advertId: 5 }] },
    { type: 9, status: 4, advert_list: [{ advertId: 6 }] },
  ];
  const ctx = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => k === 'WB_TOKEN' ? 'test-secret-never-log' : 'defly_wb' }) },
    Utilities: { formatDate: () => '2026-10-28', sleep() {} },
    Logger: { log: s => logs.push(s) },
    UrlFetchApp: { fetch: (url, options) => {
      calls.push({ url, options });
      let data = [], code = 200;
      if (url.endsWith('/promotion/count')) { data = { adverts: groups }; code = countCode; }
      if (url.includes('/adv/v1/upd?')) data = [{ advertId: 4, updSum: 100 }, { advertId: 5, updSum: 50 }, { advertId: 2, updSum: 20 }];
      if (url.includes('/finance/')) code = financeCode;
      if (url.includes('/adv/v3/fullstats?')) data = stats;
      return { getResponseCode: () => code, getContentText: () => code === 204 ? '' : JSON.stringify(data) };
    } },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(require.resolve('../../google-apps-script/wb-sheet-sync.gs'), 'utf8'), ctx);
  ctx.probeWb();
  return { calls, logs, ctx };
}
test('Проверка WB использует новые методы финансов, остатков и рекламы, не повторяя список кампаний', () => {
  const { calls, logs } = run();
  assert.ok(calls.every(c => !/reportDetailByPeriod|\/supplier\/stocks|\/nm-report\/detail|\/adv\/v1\/promotion\/adverts/.test(c.url)));
  const finance = calls.find(c => c.url.includes('/finance/'));
  assert.equal(finance.options.method, 'post'); assert.equal(JSON.parse(finance.options.payload).rrdId, 0);
  assert.ok(calls.some(c => c.url.includes('/stocks-report/wb-warehouses') && c.options.method === 'post'));
  assert.equal(calls.filter(c => c.url.endsWith('/promotion/count')).length, 1);
  assert.ok(calls.some(c => c.url.endsWith('/api/advert/v2/adverts?ids=2,4,5') && c.options.method === 'get'));
  assert.ok(calls.some(c => c.url.includes('/adv/v3/fullstats?ids=2,4,5&')));
  assert.ok(logs.some(s => s.includes('HTTP 204') && s.includes('данных нет')));
  assert.ok(logs.some(s => s.includes('данных нет (null)')));
  assert.ok(logs.every(s => !s.includes('test-secret-never-log')));
});
test('Отказ списка кампаний не приводит к повторным запросам; отсутствие прав финансов выделено отдельно', () => {
  const { calls, logs } = run({ countCode: 403, financeCode: 403 });
  assert.equal(calls.filter(c => c.url.endsWith('/promotion/count')).length, 1);
  assert.ok(!calls.some(c => c.url.includes('/fullstats?')));
  assert.ok(logs.some(s => s.includes('категорию «Финансы»')));
});
test('Диагностика различает пустой ответ и массив статистики', () => {
  const { ctx } = run({ stats: [{ advertId: 2, views: 10 }] });
  assert.match(ctx.shape_('null'), /данных нет/);
  assert.match(ctx.shape_('[]'), /записей 0/);
  assert.match(ctx.shape_('{"data":{"items":[{"quantity":5}]}}'), /записей 1/);
});
