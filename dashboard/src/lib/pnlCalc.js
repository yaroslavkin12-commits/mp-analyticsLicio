// Итоги P&L по данным /api/finance/pnl — тем же способом, что страница «P&L»
// (pages/PnL.jsx, calc): удержания без артикула — по доле выручки дня, реклама
// без артикула — по доле расхода кабинета, реклама за дни, которые Ozon ещё не
// провёл, — из рекламного кабинета; налог — по дням от оплаты покупателя;
// себестоимость — без самовыкупов.
const B = ['sale', 'return', 'commission', 'acquiring', 'logistics', 'storage', 'promo', 'other', 'ads'];
const COST_KEYS = ['commission', 'logistics', 'acquiring', 'storage', 'promo', 'other'];
const SEP = ' / ';

export function pnlTotals(data, { tax = 6, shareAt = null, groupOf = null } = {}) {
  const n = data.dates.length;
  const per = data.articles.map(() => null);
  const get = ai => per[ai] || (per[ai] = { b: B.map(() => new Float64Array(n)), qty: new Float64Array(n), ads: new Float64Array(n), self: new Float64Array(n) });
  for (const [ai, d, bi, a, q] of data.rows) {
    const x = get(ai), k = data.buckets[bi], j = B.indexOf(k);
    x.b[j < 0 ? 7 : j][d] += a;
    if (k === 'sale') x.qty[d] += Math.abs(q); else if (k === 'return') x.qty[d] -= Math.abs(q);
  }
  for (const [ai, d, v] of data.ads) get(ai).ads[d] += v;
  for (const [ai, d, q] of data.self || []) get(ai).self[d] += q;
  const iAds = data.buckets.indexOf('ads');
  let lastFin = -1;
  for (const r of data.rows) if (r[2] === iAds && r[3]) lastFin = Math.max(lastFin, r[1]);
  for (const [d, b, a] of data.noSku) if (b === iAds && a) lastFin = Math.max(lastFin, d);
  const netDayAll = new Float64Array(n);
  let adsAll = 0;
  for (const x of per) if (x) for (let i = 0; i < n; i++) { netDayAll[i] += x.b[0][i] + x.b[1][i]; adsAll += x.ads[i]; }
  const totalSale = netDayAll.reduce((s, v) => s + v, 0);

  const calc = (items, share) => {
    const v = {};
    for (const k of B) v[k] = new Float64Array(n);
    v.qty = new Float64Array(n); v.adsRaw = new Float64Array(n); v.costRaw = new Float64Array(n); v.taxBase = new Float64Array(n);
    for (const ai of items) {
      const x = per[ai]; if (!x) continue;
      const a = data.articles[ai], cp = data.cost[ai];
      const parts = String(a.cat || 'Без категории').split(SEP);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < B.length; j++) v[B[j]][i] += x.b[j][i];
        v.qty[i] += x.qty[i]; v.adsRaw[i] += x.ads[i];
        const sh = shareAt ? (shareAt(a.o, parts, data.dates[i]) ?? 1) : 1;
        v.taxBase[i] += (x.b[0][i] + x.b[1][i]) * sh;
        if (cp) v.costRaw[i] += cp * (x.qty[i] - x.self[i]);
      }
    }
    if (share > 0) {
      const shD = Array.from({ length: n }, (_, d) => (share === 1 ? 1 : netDayAll[d] > 0 ? (v.sale[d] + v.return[d]) / netDayAll[d] : share));
      let selAds = 0; for (let i = 0; i < n; i++) selAds += v.adsRaw[i];
      const adSh = share === 1 ? 1 : adsAll > 0 ? selAds / adsAll : null;
      for (const [d, bi, a] of data.noSku) { const k = data.buckets[bi]; v[B.includes(k) ? k : 'other'][d] += a * (k === 'ads' && adSh !== null ? adSh : shD[d]); }
      (data.adNoSku || []).forEach((a, d) => { v.adsRaw[d] += a * shD[d]; });
    }
    const T = { revenue: 0, ozonX: 0, ads: 0, cost: 0, tax: 0, profit: 0, qty: 0, payout: 0 };
    for (let i = 0; i < n; i++) {
      const rev = v.sale[i] + v.return[i];
      const ozX = COST_KEYS.reduce((s, k) => s + v[k][i], 0);
      const ad = i <= lastFin ? v.ads[i] : -v.adsRaw[i];
      const t = v.taxBase[i] > 0 ? -v.taxBase[i] * tax / 100 : 0;
      T.revenue += rev; T.ozonX += ozX; T.ads += ad; T.cost -= v.costRaw[i]; T.tax += t; T.qty += v.qty[i];
      T.payout += rev + ozX + ad; T.profit += rev + ozX + ad - v.costRaw[i] + t;
    }
    return T;
  };
  const all = per.map((x, i) => (x ? i : -1)).filter(i => i >= 0);
  const out = { total: calc(all, 1), byGroup: {} };
  if (groupOf) {
    const g = new Map();
    for (const ai of all) { const k = groupOf(data.articles[ai]); if (!g.has(k)) g.set(k, []); g.get(k).push(ai); }
    for (const [k, items] of g) {
      let s = 0; for (const ai of items) { const x = per[ai]; for (let i = 0; i < n; i++) s += x.b[0][i] + x.b[1][i]; }
      out.byGroup[k] = calc(items, totalSale > 0 ? s / totalSale : 0);
    }
  }
  return out;
}
