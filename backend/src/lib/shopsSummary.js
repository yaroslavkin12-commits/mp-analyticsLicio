// Те же заказы WB, что в аналитике: отмены и самовыкупы уже исключены адаптером.
function wbShopSummary(datasets, prefs, { from, to }) {
  const model = require('./wbViews').build(datasets, prefs, { dateFrom: from, dateTo: to });
  const sales = model.sales();
  const dayjs = require('dayjs');
  const days = dayjs(to).diff(from, 'day') + 1;
  const pFrom = dayjs(from).subtract(days, 'day').format('YYYY-MM-DD');
  const pTo = dayjs(from).subtract(1, 'day').format('YYYY-MM-DD');
  const aggregate = (rows, complete) => {
    const blank = () => [complete ? 0 : null, complete ? 0 : null];
    const result = { q: complete ? 0 : null, r: complete ? 0 : null, byCat: {}, byPath: {}, complete };
    for (const a of sales.articles) {
      const parts = String(a.cat || 'Без категории').split(' / ');
      result.byCat[parts[0]] ||= blank();
      for (let d = 1; d <= Math.min(parts.length, 3); d++) result.byPath[parts.slice(0,d).join(' / ')] ||= blank();
    }
    const add = (a,b) => Number.isFinite(a) && Number.isFinite(b) ? a + b : null;
    for (const [ai,q,r] of rows) {
      const parts = String(sales.articles[ai].cat || 'Без категории').split(' / ');
      result.q = add(result.q,q); result.r = add(result.r,r);
      const targets = [result.byCat[parts[0]], ...Array.from({length:Math.min(parts.length,3)},(_,i)=>result.byPath[parts.slice(0,i+1).join(' / ')])];
      for (const t of targets) { t[0] = add(t[0],q); t[1] = add(t[1],r); }
    }
    return result;
  };
  return { id: 'defly_wb', label: 'Defly WB', platform: 'wb', cur: aggregate(sales.rows.map(r=>[r[0],r[5],r[6]]),model.full('orders',from,to)), prev: aggregate(sales.prev.map(r=>[r[0],r[4],r[5]]),model.full('orders',pFrom,pTo)) };
}
module.exports = { wbShopSummary };
