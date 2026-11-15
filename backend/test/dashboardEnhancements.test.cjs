const {test}=require('node:test'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const moduleAt=p=>import(pathToFileURL(require('node:path').resolve(__dirname,'../../dashboard/src/'+p)).href);
test('Недельные границы: понедельник–воскресенье, обрезка периода и переход года',async()=>{
 const {calendarWeeks}=await moduleAt('lib/shopsWeekly.js');
 assert.deepEqual(calendarWeeks('2026-12-30','2027-01-06'),[{key:'2026-12-28',from:'2026-12-30',to:'2027-01-03',partial:true},{key:'2027-01-04',from:'2027-01-04',to:'2027-01-06',partial:true}]);
 assert.equal(calendarWeeks('2026-11-09','2026-11-15')[0].partial,false);
});
test('Средние нескольких магазинов взвешены по количеству; неизвестные дни не превращаются в нули',async()=>{
 const {rangeTotals}=await moduleAt('lib/shopsWeekly.js');
 const totals=rangeTotals([[{date:'2026-11-09',qty:1,payout:100,revenue:200,ordersRub:300,ordersQty:1,expectedPayout:120,expectedQty:1}],[{date:'2026-11-09',qty:9,payout:1800,revenue:2700,ordersRub:3600,ordersQty:9,expectedPayout:1800,expectedQty:9},{date:'2026-11-10',qty:null,payout:null}]],'2026-11-09','2026-11-15');
 assert.equal(totals.payActual,190);assert.equal(totals.avgOrder,390);assert.equal(totals.payForecast,192);
 assert.equal(rangeTotals([null],'2026-11-09','2026-11-15').payActual,null);
 assert.equal(rangeTotals([[{date:'2026-11-09',ordersRub:NaN,ordersQty:1}]],'2026-11-09','2026-11-15').avgOrder,null);
});
test('Недельный финансовый факт сохраняет распределение удержаний и совпадает с P&L за период',async()=>{
 const {shopDaily,rangeTotals}=await moduleAt('lib/shopsWeekly.js'),{pnlTotals}=await moduleAt('lib/pnlCalc.js');
 const dates=['2026-11-08','2026-11-09'];
 const articles=[{o:'A',cat:'Дефлекторы / Окна / 2D'},{o:'B',cat:'Чехлы / Сиденья'}];
 const pnl={dates,articles,buckets:['sale','commission','ads'],rows:[[0,0,0,1000,2],[1,0,0,500,1],[0,1,0,3000,6],[1,1,0,1500,3]],ads:[[0,0,60],[0,1,180],[1,0,30],[1,1,90]],noSku:[[0,1,-150],[1,1,-450]],cost:[100,50]};
 const sales={dates,articles,rows:[[0,0,100,30,5,2,1000,60,0],[0,1,300,90,15,6,3000,180,0]]};
 const days=shopDaily({sales,pnl,tax:6,category:'Дефлекторы'}),total=pnlTotals(pnl,{tax:6,groupOf:a=>a.cat.startsWith('Дефлекторы')?'selected':'other'}).byGroup.selected;
 const a=rangeTotals([days],dates[0],dates[0]),b=rangeTotals([days],dates[1],dates[1]);
 for(const k of ['revenue','qty','payout','profit','ozonX','ads','cost','tax'])assert.equal(a[k]+b[k],total[k],k);
 assert.equal(a.revenue,1000);assert.equal(a.ordersQty,2);assert.equal(a.payForecast,null);
});
test('Прогноз поступления использует текущую единую модель по заказам и расходам рекламы',async()=>{
 const {shopDaily,rangeTotals}=await moduleAt('lib/shopsWeekly.js'),{unitCoefs,unitProfit}=await moduleAt('pages/unitModel.js');
 const articles=[{o:'A',cat:'Дефлекторы / Окна',parts:['Дефлекторы','Окна']}],c=Array(28).fill(0);c[0]=0;c[1]=10000;c[2]=10;c[9]=20;c[10]=16;c[11]=4;c[12]=20;c[15]=100;c[5]=-150;
 const coefs={articles,coefs:[c],noSku:{},totalSale:10000},sales={articles,dates:['2026-11-09'],rows:[[0,0,100,20,4,10,10000,300,100]]};
 const k=unitCoefs(coefs,articles)[0],v=unitProfit(k,{ordRub:10000,ordQty:10,ads:400},6),t=rangeTotals([shopDaily({sales,coefs})],'2026-11-09','2026-11-09');
 assert.equal(t.payForecast,(v.expRev-v.comm-v.logi-v.acq-v.other-v.ads)/v.expQty);
});
test('Подсказка помещается у правого и нижнего края, а также на узком экране',async()=>{
 const {floatingPosition}=await moduleAt('lib/floatingPosition.js');
 for(const [x,y,w,h,vw,vh] of [[990,790,260,180,1000,800],[5,5,600,900,320,480],[5,470,260,180,320,480]]){
 const p=floatingPosition({x,y,width:w,height:h,viewportWidth:vw,viewportHeight:vh});assert.ok(p.left>=8&&p.top>=8);assert.ok(p.left+Math.min(w,vw-16)<=vw-8);assert.ok(p.top+Math.min(h,vh-16)<=vh-8);
 }
});

test('Недельные финансы доступны до загрузки заказов, прогноз остаётся неизвестным',async()=>{
 const {shopDaily,rangeTotals}=await moduleAt('lib/shopsWeekly.js');
 const pnl={dates:['2026-11-09'],articles:[{o:'A',cat:'Дефлекторы'}],buckets:['sale'],rows:[[0,0,0,1000,1]],ads:[],noSku:[],cost:[0]};
 const t=rangeTotals([shopDaily({pnl})],'2026-11-09','2026-11-09');assert.equal(t.payActual,1000);assert.equal(t.ordersQty,null);assert.equal(t.payForecast,null);
});
