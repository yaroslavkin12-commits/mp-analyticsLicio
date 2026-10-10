// Зона показа рекламной кампании Ozon: «поиск» или «поиск + рекомендации».
// Сначала по названию кампании (там обычно так и написано), затем по полю placement.
function zoneOf(camp) {
  if (!camp) return null;
  if (String(camp.payment_type || '').toUpperCase() === 'CPO') return 'оплата за заказ';
  const t = String(camp.title || '').toLowerCase(), p = String(camp.placement || '').toUpperCase();
  if (/рекоменд|полк/.test(t)) return 'поиск + рекомендации';
  if (/поиск/.test(t)) return 'поиск';
  if (p.includes('CATEGORY') || p.includes('RECOMM')) return 'поиск + рекомендации';
  if (p.includes('SEARCH') || p.includes('TOP_PROMOTION')) return 'поиск';
  return null;
}
// «РК 123» → «РК 123 · поиск» (для журнала).
function campLabel(camp, id) {
  const z = zoneOf(camp);
  return `РК ${id}${z ? ` · ${z}` : ''}`;
}
module.exports = { zoneOf, campLabel };
