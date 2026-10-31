const {test}=require('node:test');
const assert=require('node:assert/strict');
const model=import('../../dashboard/src/lib/chartSignals.js');
test('Столбцы: порог 5%, пропуски, незавершённые дни и направления затрат',async()=>{
 const {barSignals}=await model;
 assert.deepEqual(barSignals([100,106,100,103,null,50],{pending:[false,false,false,false,false,true]}).map(x=>x.status),['pending','good','bad','warn','pending','pending']);
 assert.equal(barSignals([100,80],{metric:'drr'})[1].status,'good');
 assert.equal(barSignals([-100,-80],{metric:'ads'})[1].status,'good');
 assert.equal(barSignals([-100,-120],{metric:'ads'})[1].status,'bad');
 assert.equal(barSignals([0,10])[1].status,'good');
 assert.doesNotThrow(()=>barSignals([1,2],{dates:['январь','февраль']}));
});
test('Сопоставление того же дня недели; объёмы периодов нормализуются, средние — нет',async()=>{
 const {barSignals}=await model;
 const dates=Array.from({length:8},(_,i)=>`2026-10-${String(i+1).padStart(2,'0')}`);
 const s=barSignals([100,100,100,100,100,100,200,110],{dates});
 assert.equal(s[7].status,'good');assert.equal(s[7].base,100);
 assert.match(s[7].text,/прошлой недели/);
 assert.equal(barSignals([700,330],{gran:'week',durations:[7,3],metric:'revenue'})[1].status,'good');
 assert.equal(barSignals([100,100],{gran:'week',durations:[7,3],metric:'avgOrder'})[1].status,'warn');
});
test('Выкупы и поступления на графике используют P&L; средние взвешиваются, неизвестное не равно нулю',async()=>{
 const {enrichSalesChart}=await import('../../dashboard/src/lib/salesChartModel.js');
 const dates=['2026-10-01','2026-10-02','2026-10-03'];
 const a={o:'A',revenue:[100,900,0],orders:[1,3,0],spendCpc:[0,0,0],spendCpo:[0,0,0]};
 const pnl={dates,articles:[{o:'A'}],buckets:['sale','return','commission'],rows:[[0,0,0,100,1],[0,1,0,900,3],[0,1,1,-100,-1],[0,1,2,-90,0]],ads:[],noSku:[],cost:[10],available:{mn:dates[0],mx:dates[1]}};
 const buckets=[{key:'week',idx:[0,1]},{key:'unknown',idx:[2]}];
 const r=enrichSalesChart([a],dates,buckets,{byDate:{week:{orders:4,revenue:1000}}},{pnl,tax:0,today:'2026-10-03'}).byDate;
 assert.equal(r.week.buyoutQty,3);assert.equal(r.week.buyoutRub,900);assert.equal(r.week.payout,810);assert.equal(r.week.paySale,270);assert.equal(r.week.avgBuyout,300);assert.equal(r.week.avgOrder,250);assert.equal(r.week.profitActual,780);
 assert.equal(r.unknown.buyoutQty,null);assert.equal(r.unknown._provisional,true);
 const zero=enrichSalesChart([{...a,o:'B'}],dates,[buckets[0]],{byDate:{}},{pnl}).byDate.week;
 assert.equal(zero.buyoutQty,0);assert.equal(zero.paySale,null);
});
test('Цвет дня относительно среднего выбранного периода; пропуски и незавершённые дни не меняют базу',async()=>{
 const {barSignals}=await model;
 const s=barSignals([50,100,150,null,1000],{baseline:'period',pending:[false,false,false,false,true]});
 assert.deepEqual(s.map(x=>x.status),['bad','warn','good','pending','pending']);assert.equal(s[0].base,100);assert.equal(s[2].base,100);assert.match(s[0].text,/среднему за выбранный период/);
 assert.equal(barSignals([50,100,150],{baseline:'period',metric:'spend'})[0].status,'good');
 assert.equal(barSignals([700,600],{baseline:'period',gran:'week',durations:[7,3],metric:'revenue'})[0].base,130);
 assert.equal(barSignals([100,100],{baseline:'period',durations:[7,3],metric:'avgOrder'})[0].base,100);
 assert.equal(barSignals([100],{baseline:'period'})[0].status,'warn');
});
