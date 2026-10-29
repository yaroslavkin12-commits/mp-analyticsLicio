import { pnlTotals } from './pnlCalc.js';
export const FIN_CHART_METRICS = [
  {key:'buyoutRub',label:'Выкупы, ₽',fmt:'int'}, {key:'buyoutQty',label:'Выкупы, шт',fmt:'int'},
  {key:'payout',label:'Поступления на счёт, ₽',fmt:'int'}, {key:'paySale',label:'Ср. поступление за выкуп (факт), ₽',fmt:'money2'},
  {key:'avgBuyout',label:'Ср. чек выкупа, ₽',fmt:'money2'}, {key:'avgOrder',label:'Ср. чек заказа, ₽',fmt:'money2'},
  {key:'profitActual',label:'Прибыль (факт), ₽',fmt:'int'}, {key:'marginActual',label:'Маржа (факт), %',fmt:'pct'},
  {key:'profitForecast',label:'Прибыль (прогноз), ₽',fmt:'int'}, {key:'marginForecast',label:'Маржа (прогноз), %',fmt:'pct'},
  {key:'payForecast',label:'Ср. поступление за выкуп (прогноз), ₽',fmt:'money2'}, {key:'expectedBuyouts',label:'Ожидаемые выкупы, шт',fmt:'int'},
  {key:'adCpo',label:'Цена заказа с рекламы, ₽',fmt:'money2'}, {key:'drrB',label:'ДРР с учётом выкупа, %',fmt:'pct'},
  {key:'adOrders',label:'Заказы с рекламы, шт',fmt:'int'}, {key:'adRevenue',label:'Заказы с рекламы, ₽',fmt:'int'}, {key:'adViews',label:'Показы рекламы',fmt:'int'},
];
export function enrichSalesChart(arts, dates, buckets, model, { pnl, forecast, tax = 6, shareAt, today = new Date().toLocaleDateString('en-CA', {timeZone:'Europe/Moscow'}) } = {}) {
  const chosen = new Set(arts.map(a => a.o));
  const fin = pnl ? pnlTotals(pnl, { tax, shareAt: shareAt ? (o, _, d) => shareAt(o,d) : null, groupOf: a => chosen.has(a.o) ? 'selected' : 'other', withDays: true }).byGroup.selected : null;
  const fd = new Map((fin?.days || []).map(d => [d.date, d]));
  const expected = dates.map((date, i) => {
    let qty = 0, revenue = 0, pay = 0, profit = 0, any = false;
    for (const a of arts) {
      if (!a.orders[i] && !a.spendCpc[i] && !a.spendCpo[i]) continue;
      const r = forecast?.(a.o,date,a.revenue[i],a.orders[i],a.spendCpc[i]+a.spendCpo[i]+(a.spendOther?.[i]??0));
      if (!r || (!a.orders[i] && !a.spendCpc[i] && !a.spendCpo[i])) continue;
      any = true; qty += r.expQty; revenue += r.expRev; profit += r.profit; pay += r.expRev-r.comm-r.logi-r.acq-r.other-r.ads;
    }
    return {qty,revenue,pay,profit,any};
  });
  const byDate = {};
  for (const b of buckets) {
    const base = model.byDate[b.key] || {}, known = b.idx.filter(i => pnl?.available?.mn && dates[i]>=pnl.available.mn && dates[i]<=pnl.available.mx);
    const f = {qty:0,payout:0,revenue:0,profit:0};
    for (const i of known) { const d=fd.get(dates[i]); if(d) for(const k of Object.keys(f)) f[k]+=d[k] == null ? (['payout','profit'].includes(k)?NaN:0) : d[k]; }
    const e = {qty:0,revenue:0,pay:0,profit:0,any:false};
    for (const i of b.idx) { const d=expected[i]; for(const k of ['qty','revenue','pay','profit']) e[k]+=d[k]; e.any ||= d.any; }
    const hasFin = known.length>0;
    byDate[b.key]={...base, _days:b.idx.length, _actualDays:known.length, _provisional:b.idx.some(i=>dates[i]>=today),
      buyoutRub:hasFin?f.revenue:null,buyoutQty:hasFin?f.qty:null,payout:hasFin&&!pnl?._operational?f.payout:null,
      paySale:hasFin&&!pnl?._operational&&f.qty>0?f.payout/f.qty:null,avgBuyout:hasFin&&f.qty>0?f.revenue/f.qty:null,
      avgOrder:base.orders>0?base.revenue/base.orders:null,adCpo:base.adOrders>0?base.spend/base.adOrders:null,drrB:e.revenue>0?base.spend/e.revenue*100:null,profitActual:hasFin&&!pnl?._operational?f.profit:null,marginActual:hasFin&&!pnl?._operational&&f.revenue>0?f.profit/f.revenue*100:null,
      profitForecast:e.any?e.profit:null,marginForecast:e.revenue>0?e.profit/e.revenue*100:null,payForecast:e.qty>0?e.pay/e.qty:null,expectedBuyouts:e.any?e.qty:null};
  }
  return {...model,byDate};
}
