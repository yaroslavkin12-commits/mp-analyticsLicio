const {test}=require('node:test'),assert=require('node:assert/strict');const {activityPnl}=require('../src/lib/wbActivityPnl');
test('P&L по дням рекламы: реальные доли расходов, удержание не задвоено, исходные финансы неизменны',()=>{
 const input={financeSource:'wb',dates:['2026-10-24','2026-10-25'],available:{mn:'2026-10-01',mx:'2026-10-30'},buckets:['sale','ads'],rows:[[0,0,0,1000,1]],noSku:[[1,1,-30]],ads:[],adNoSku:[0,0],adStatistics:{from:'2026-10-24',to:'2026-10-25',rows:[[0,0,10],[0,1,20]],unallocated:[0,0]}};
 const p=activityPnl(input);assert.equal(p.adsBasis,'activity');assert.equal(p.available.mn,'2026-10-24');assert.deepEqual(p.rows.filter(r=>r[2]===1).map(r=>r[3]),[-10,-20]);assert.equal(p.noSku.length,0);assert.equal(p.cashAds.noSku[0][2],-30);assert.equal(input.noSku[0][2],-30);assert.equal(input.rows.length,1);assert(p.managementReady);
});
