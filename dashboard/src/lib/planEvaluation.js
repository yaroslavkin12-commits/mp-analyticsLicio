import { SHOPS } from './cabinets.js';
const shops = SHOPS.filter(s => s.platform === 'ozon');
export const inPlanPath = (p, parent) => !parent || p === parent || p.startsWith(parent + ' / ');
export function planTotal(rows, shop = '') {
  const items = rows.map(r => shop ? r.shops.find(s => s.id === shop) : r).filter(Boolean);
  const qty = items.reduce((s, r) => s + r.qty, 0), amount = items.reduce((s, r) => s + r.amount, 0);
  return { qty, amount, mean: qty > 0 ? amount / qty : null };
}
export function planActual(fact, rows, shop = '', path = '', date = '') {
  const paths = new Set(rows.filter(r => inPlanPath(r.path, path)).map(r => r.path));
  let qty = 0, payout = 0, knownShops = 0;
  const issues = [];
  for (const s of shops.filter(s => !shop || s.id === shop)) {
    const f = fact?.shops?.[s.id];
    if (!f || f.error || f.partial) issues.push(`${s.label}: ${f?.error || 'неполный период финансов'}`);
    if (!f || f.error) continue;
    knownShops++;
    for (const p of paths) {
      const r = f.byPath[p]; if (!r) continue;
      const v = date ? (r.days || []).find(d => d.date === date) : r;
      if (v) { qty += v.qty; payout += v.payout; }
    }
  }
  return { qty: knownShops ? qty : null, payout: knownShops ? payout : null, mean: qty > 0 ? payout / qty : null, issues, complete: !issues.length && !fact?.future };
}
// Все темпы используют один и тот же включённый период. Среднее за выкуп
// сравнивается с целевым средним напрямую, без календарного множителя.
export function evaluatePlan(plan, fact, elapsed, days) {
  const window = Number.isFinite(days) && days > 0 && Number.isFinite(elapsed) && elapsed > 0 && elapsed <= days;
  const known = fact.complete === true;
  const ratio = (a, b) => known && Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a / b * 100 : null;
  const delta = (a, b) => known && Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a - b : null;
  const expected = b => window && Number.isFinite(b) && b > 0 ? b * elapsed / days : null;
  const forecast = (a, b) => window && known && Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a * days / elapsed : null;
  const qtyExpected = expected(plan.qty), amountExpected = expected(plan.amount);
  return {
    qtyMonth: ratio(fact.qty, plan.qty), qtyPace: ratio(fact.qty, qtyExpected), qtyExpected,
    qtyForecast: forecast(fact.qty, plan.qty), qtyDelta: delta(fact.qty, qtyExpected),
    meanRatio: ratio(fact.mean, plan.mean), meanDelta: delta(fact.mean, plan.mean),
    amountMonth: ratio(fact.payout, plan.amount), amountPace: ratio(fact.payout, amountExpected), amountExpected,
    amountForecast: forecast(fact.payout, plan.amount), amountDelta: delta(fact.payout, amountExpected),
  };
}
export const resultTone = ratio => ratio === null || ratio === undefined || !Number.isFinite(ratio) ? '' : ratio >= 100 ? 'op-good' : 'op-bad';
export const resultLabel = ratio => !resultTone(ratio) ? 'Нет оценки' : ratio >= 100 ? 'По плану или выше' : 'Ниже плана';
