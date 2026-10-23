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
// Стратегия кампании (productAutopilotStrategy) — по-русски, как в кабинете Ozon.
const STRATEGY_RU = { TARGET_BIDS: 'средняя стоимость клика', TARGET_CIR: 'целевой расход', TOP_MAX_CLICKS: 'автостратегия', MAX_CLICKS: 'вывод в ТОП' };
function strategyOf(camp) { return STRATEGY_RU[String(camp?.autopilot_strategy || '').toUpperCase()] || null; }
// Целевой ДРР стратегии «Целевой расход» — из сырых полей кампании (колонка extra
// вкладки Campaigns, JSON). Ozon называет поле по-разному — ищем по смыслу ключа.
function targetDrrOf(extra) {
  if (!extra) return null;
  let o; try { o = typeof extra === 'string' ? JSON.parse(extra) : extra; } catch { return null; }
  let found = null;
  const walk = (x, depth) => {
    if (found !== null || !x || typeof x !== 'object' || depth > 4) return;
    for (const [k, v] of Object.entries(x)) {
      if (found !== null) return;
      if (v && typeof v === 'object') { walk(v, depth + 1); continue; }
      if (!/cir|drr|acos|crr|target.?(cost|rate|percent|share|value)/i.test(k)) continue;
      const n = Number(String(v).replace(',', '.'));
      if (!Number.isFinite(n) || n <= 0) continue;
      found = n <= 1 ? Math.round(n * 1000) / 10 : n <= 100 ? n : n >= 1e6 && n / 1e6 <= 100 ? n / 1e6 : null;
    }
  };
  walk(o, 0);
  return found;
}
// «РК 123» → «РК 123 · поиск» (для журнала).
function campLabel(camp, id) {
  const z = zoneOf(camp), st = strategyOf(camp), t = camp?.target_drr ?? targetDrrOf(camp?.extra);
  return `РК ${id}${z ? ` · ${z}` : ''}${st ? ` · ${st}${t ? ` ${t}%` : ''}` : ''}`;
}
module.exports = { zoneOf, campLabel, strategyOf, targetDrrOf };
