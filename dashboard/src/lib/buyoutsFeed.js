import { buyoutPnlTotals } from './pnlCalc.js';

// Цена берётся из продаж, а возвраты и реклама участвуют в финансовом итоге дня.
export function buildBuyoutsFeed(data, tax, shareAt) {
  const { byGroup } = buyoutPnlTotals(data, { tax, shareAt, groupOf: a => 'offer:' + a.o, withDays: true });
  const selfByDay = new Map((data.self || []).map(([ai, di, qty]) => [ai + ':' + di, qty]));
  const trade = new Map();
  for (const [ai, di, bi, amount, qty] of data.rows) {
    const bucket = data.buckets[bi];
    if (bucket !== 'sale' && bucket !== 'return') continue;
    const key = ai + ':' + di;
    const entry = trade.get(key) || { sold: 0, saleRub: 0, returned: 0, returnRub: 0 };
    if (bucket === 'sale') {
      entry.sold += Math.abs(qty || 0);
      entry.saleRub += amount || 0;
    } else {
      entry.returned += Math.abs(qty || 0);
      entry.returnRub += amount || 0;
    }
    trade.set(key, entry);
  }

  const rows = [];
  data.articles.forEach((article, ai) => {
    const group = byGroup['offer:' + article.o];
    if (!group) return;
    for (const [di, day] of group.days.entries()) {
      const key = ai + ':' + di, sale = trade.get(key);
      const sold = sale?.sold ?? 0, saleRub = sale?.saleRub ?? 0, returned = sale?.returned ?? 0;
      const qty = sold - returned, revenue = saleRub + (sale?.returnRub ?? 0);
      const financial = data.financeSource !== 'wb' || (data.available?.mn && day.date >= data.available.mn && day.date <= data.available.mx);
      const payout = financial ? day.payout : null;
      if (!sold && !returned && !revenue && !payout && !(financial && day.profit)) continue;
      const selfQty = selfByDay.get(key) || 0;
      rows.push({
        o: article.o, n: article.n, cat: article.cat, date: day.date, qty, revenue, sold, saleRub,
        price: sold > 0 && saleRub > 0 ? saleRub / sold : null,
        payout, fees: day.ozonX, ads: day.ads, payoutPerBuyout: payout != null && qty > 0 ? payout / qty : null,
        profit: financial && (qty === selfQty || data.cost?.[ai] > 0) ? day.profit : null,
        selfQty, st: sold > 0 ? (returned > 0 ? 'sold_returned' : 'sold') : returned > 0 ? 'returned' : 'charges',
      });
    }
  });
  rows.sort((a, b) => b.date.localeCompare(a.date) || b.qty - a.qty || a.o.localeCompare(b.o, 'ru'));
  return { rows, through: data.available?.mx, operational: !!data._operational };
}
