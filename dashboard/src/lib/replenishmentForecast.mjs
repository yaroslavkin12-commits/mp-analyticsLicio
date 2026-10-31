// Прогноз только по реально поданным партиям; будущие циклы не выдумываем.
export function buildReplenishmentForecast({ rows, history, journal, today }) {
  const key = s => String(s).toLowerCase(), offers = new Set(rows.map(r => key(r.offer)));
  if (!rows.length) return { points: [], missing: 0, overdue: 0 };
  const byDate = new Map();
  for (const h of history) if (offers.has(key(h.offer)) && h.date < today) { if (!byDate.has(h.date)) byDate.set(h.date, new Map()); byDate.get(h.date).set(key(h.offer), h.stock); }
  const points = [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, map]) => ({ date, actual: map.size === offers.size ? [...map.values()].reduce((n, v) => n + v, 0) : null, forecast: null }));
  const missing = rows.filter(r => r.stock == null || r.rate == null).length;
  const stockKnown = rows.every(r => r.stock != null);
  const current = stockKnown ? rows.reduce((n, r) => n + r.stock, 0) : null;
  points.push({ date: today, actual: current, forecast: !missing ? current : null });
  let overdue = 0; const arrivals = new Map();
  for (const j of journal) if (j.tracked) for (const r of j.items) if (offers.has(key(r.offer)) && r.remaining > 0) {
    if (!j.expectedDate || j.expectedDate <= today) { overdue += r.remaining; continue; }
    if (!arrivals.has(j.expectedDate)) arrivals.set(j.expectedDate, new Map());
    const m = arrivals.get(j.expectedDate); m.set(key(r.offer), (m.get(key(r.offer)) || 0) + r.remaining);
  }
  if (!missing) {
    const inventory = new Map(rows.map(r => [key(r.offer), r.stock]));
    for (let d = 1; d <= 28; d++) {
      const date = new Date(Date.parse(today) + d * 86400000).toISOString().slice(0, 10), arrived = arrivals.get(date);
      for (const r of rows) { const k = key(r.offer); inventory.set(k, Math.max(0, inventory.get(k) - r.rate) + (arrived?.get(k) || 0)); }
      points.push({ date, actual: null, forecast: [...inventory.values()].reduce((n, v) => n + v, 0), arrival: arrived ? [...arrived.values()].reduce((n, v) => n + v, 0) : undefined });
    }
  }
  return { points, missing, overdue };
}
