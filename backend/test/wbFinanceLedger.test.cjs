const {test}=require('node:test'),assert=require('node:assert/strict');
const {entries}=require('../src/lib/wbFinance');
const row={rrDate:'2026-10-01',sellerOperName:'Продажа',docTypeName:'Продажа',quantity:1,retailPriceWithDisc:'18456',retailAmount:'10512',forPay:'11852.76',acquiringFee:'420.48'};
test('WB: поступление сверяется без повторного вычитания комиссии и эквайринга',()=>{const a=entries([row]);assert.ok(Math.abs(a.reduce((s,r)=>s+r.amount,0)-11852.76)<1e-8);assert.equal(a.find(r=>r.bucket==='commission').amount,-6182.76);});
test('WB: возврат меняет знак, коррекция денег не создаёт выкуп, реклама отделена от Джем',()=>{const a=entries([{...row,sellerOperName:'Возврат',docTypeName:'Возврат'},{rrDate:row.rrDate,sellerOperName:'Коррекция продаж',forPay:'100',quantity:1},{rrDate:row.rrDate,deduction:'200',bonusTypeName:'Оказание услуг «WB Продвижение»'},{rrDate:row.rrDate,deduction:'50',bonusTypeName:'Джем'}]);assert.equal(a.reduce((s,r)=>s+r.qty,0),-1);assert.equal(a.filter(r=>r.bucket==='ads').reduce((s,r)=>s+r.amount,0),-200);assert.ok(Math.abs(a.reduce((s,r)=>s+r.amount,0)-(-11852.76+100-200-50))<1e-8);});
test('WB: отсутствие расшифровки удержания блокирует подтверждение расчёта',()=>assert.throws(()=>entries([{rrDate:row.rrDate,deduction:'10'}]),/расшифровка/));
test('WB: отдельные удержания, возврат кешбэка и внутренние расшифровки не вычитаются дважды',()=>{
 const a=entries([{...row,additionalPayment:'10',deliveryService:'20',deduction:'30',bonusTypeName:'Оказание услуг «WB Продвижение»',rebillLogisticCost:'99',ppvzReward:'88',installmentCofinancingAmount:'77'},{rrDate:row.rrDate,docTypeName:'Возврат',cashbackAmount:'5',cashbackCommissionChange:'2'}]);
 assert.ok(Math.abs(a.reduce((s,r)=>s+r.amount,0)-(11852.76-10-20-30+7))<1e-8);
});
test('WB: P&L, налог, себестоимость, самовыкуп и прогноз получают единый финансовый источник',async()=>{
 const V=require('../src/lib/wbViews'),{pnlTotals}=await import('../../dashboard/src/lib/pnlCalc.js');
 const ds=[{kind:'catalog',meta:{},rows:[{offer:'A',nmId:1,name:'Дефлектор окон 2D'}]},{kind:'finance',meta:{from:'2026-10-01',to:'2026-10-01'},rows:[{...row,id:'1|1',vendorCode:'A',nmId:1,srid:'one',retailPriceWithDisc:'1000',retailAmount:'800',forPay:'700',acquiringFee:'20',deliveryService:'50'},{rrDate:row.rrDate,id:'1|2',deduction:'30',bonusTypeName:'Оказание услуг «WB Продвижение»'}]}];
 const m=V.build(ds,V.initial(),{dateFrom:'2026-10-01',dateTo:'2026-10-02'}),p=m.pnl([{article:'A',cost_price:100}]);
 assert.equal(p.financeSource,'wb');assert.equal(p._operational,undefined);
 const totals=pnlTotals(p,{tax:6,withDays:true}).total;
 assert.equal(totals.revenue,1000);assert.equal(totals.payout,620);assert.equal(totals.tax,-48);assert.equal(totals.cost,-100);assert.equal(totals.profit,472);assert.equal(totals.qty,1);assert.equal(totals.days[1].payout,null);
 const prefs=V.initial();prefs.self['one|1']=true;
 const self=V.build(ds,prefs,{dateFrom:'2026-10-01',dateTo:'2026-10-01'}).pnl([{article:'A',cost_price:100}]);assert.equal(pnlTotals(self,{tax:6}).total.profit,572);
 const c=m.coefs([{article:'A',cost_price:100}]);assert.equal(c._metadataOnly,undefined);assert.equal(c.coefs[0][15],100);assert.ok(Math.abs(c.coefs[0][27]-20)<1e-9);assert.equal(c.noSku.ads,-30);
});
