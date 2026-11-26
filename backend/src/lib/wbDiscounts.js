const { ORDER } = require('./categories');

const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;

module.exports = function wbDiscounts(datasets, articles, dates, prefs) {
  const sources = new Map(datasets.map(source => [source.kind, source]));
  const items = articles.map(({ o, n, cat }) => ({ o, n, cat, sellerNow: null, days: {} }));
  const byOffer = new Map(items.map(item => [item.o.toLowerCase(), item]));
  const bySku = new Map((sources.get('catalog')?.rows || []).map(row => [String(row.nmId), byOffer.get(String(row.offer || '').toLowerCase())]));
  for (const article of articles) if (article.sku && !bySku.has(article.sku)) bySku.set(article.sku, byOffer.get(article.o.toLowerCase()));
  const itemOf = row => bySku.get(String(row.nmId)) || byOffer.get(String(row.offer || '').toLowerCase());

  for (const row of sources.get('prices')?.rows || []) {
    const item = itemOf(row);
    const price = positive(row.price);
    if (item && price !== null) item.sellerNow = Math.min(item.sellerNow ?? price, price);
  }
  for (const row of sources.get('orders')?.rows || []) {
    if (row.date < dates[0] || row.date > dates.at(-1) || row.cancelled || prefs.self[`${row.srid || row.id}|${row.nmId}`]) continue;
    const item = itemOf(row);
    const seller = positive(row.price), buyer = positive(row.customerPrice);
    if (!item || seller === null || buyer === null) continue;
    const day = item.days[row.date] ||= [0, 0, 0];
    day[0] += seller;
    day[1] += buyer;
    day[2]++;
  }
  return { dates, items, order: ORDER.defly, pricesAt: sources.get('prices')?.meta.collectedAt || null };
};
