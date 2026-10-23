import { useState, useEffect, useMemo } from 'react';
import { getBuyerShare } from '../api';

const SEP = ' / ';

// Доля цены, которую платит покупатель (база налога, см. backend
// routes/finance.js /buyer-share). Берётся из загруженных в «Сверку» отчётов
// Ozon «Начисления» — по периодам: каждый отчёт хранится за свой период и
// действует на свои дни. Внутри периода: по артикулу (если продаж ≥ 3), иначе
// среднее по категории, иначе по кабинету. День вне всех периодов — ближайший
// период. Нет отчётов — 1 (налог от полной цены).
//   shareOf(o, parts)        — по последнему периоду (прогнозы, цены, юнитка);
//   shareAt(o, parts, date)  — для конкретного дня (P&L).
function buildFn(p, arts) {
  const by = p.byOffer || {};
  const cat = new Map();
  for (const a of arts || []) {
    const v = by[a.o]; if (!v) continue;
    const parts = a.parts || [];
    for (let d = 1; d <= parts.length; d++) {
      const k = parts.slice(0, d).join(SEP); const c = cat.get(k) || [0, 0];
      c[0] += v[0] * v[1]; c[1] += v[1]; cat.set(k, c);
    }
  }
  return (o, parts) => {
    const v = by[o];
    if (v && v[1] >= 3) return v[0];
    const pp = parts || [];
    for (let d = pp.length; d >= 1; d--) { const c = cat.get(pp.slice(0, d).join(SEP)); if (c && c[1] >= 5) return c[0] / c[1]; }
    return p.total;
  };
}

export function useBuyerShare(cabinet, arts) {
  const [data, setData] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let off = false;
    getBuyerShare(cabinet).then(r => { if (!off) setData(r.data.data || false); }).catch(() => { if (!off) setData(false); });
    const h = () => setTick(t => t + 1);
    window.addEventListener('mp-buyer-share', h);
    return () => { off = true; window.removeEventListener('mp-buyer-share', h); };
  }, [cabinet, tick]);
  const periods = useMemo(() => (data && Array.isArray(data.periods) ? data.periods.filter(p => p.total > 0).sort((a, b) => (a.from < b.from ? -1 : 1)) : []), [data]);
  const fns = useMemo(() => periods.map(p => buildFn(p, arts)), [periods, arts]);
  const latest = useMemo(() => { let k = -1; periods.forEach((p, i) => { if (k < 0 || p.to > periods[k].to) k = i; }); return k; }, [periods]);
  // Период для дня: содержащий его (при наложении — загруженный позже), иначе ближайший.
  const periodAt = useMemo(() => {
    const cache = new Map();
    return date => {
      if (cache.has(date)) return cache.get(date);
      let k = -1;
      periods.forEach((p, i) => { if (date >= p.from && date <= p.to && (k < 0 || String(p.at) > String(periods[k].at))) k = i; });
      if (k < 0) {
        let best = Infinity;
        periods.forEach((p, i) => { const dd = date < p.from ? Date.parse(p.from) - Date.parse(date) : Date.parse(date) - Date.parse(p.to); if (dd < best) { best = dd; k = i; } });
      }
      cache.set(date, k);
      return k;
    };
  }, [periods]);
  const shareOf = useMemo(() => (latest >= 0 ? fns[latest] : null), [fns, latest]);
  const shareAt = useMemo(() => (periods.length ? (o, parts, date) => { const k = date ? periodAt(date) : latest; return k >= 0 ? fns[k](o, parts) : 1; } : null), [periods, fns, periodAt, latest]);
  return { data, periods, shareOf, shareAt };
}

// То же без хука — для страниц, которые считают сразу по нескольким магазинам.
// raw — ответ /api/finance/buyer-share (data.data), arts — [{ o, parts }].
export function makeShareAt(raw, arts) {
  const periods = raw && Array.isArray(raw.periods) ? raw.periods.filter(p => p.total > 0).sort((a, b) => (a.from < b.from ? -1 : 1)) : [];
  if (!periods.length) return null;
  const fns = periods.map(p => buildFn(p, arts));
  let latest = 0; periods.forEach((p, i) => { if (p.to > periods[latest].to) latest = i; });
  const cache = new Map();
  const periodAt = date => {
    if (cache.has(date)) return cache.get(date);
    let k = -1;
    periods.forEach((p, i) => { if (date >= p.from && date <= p.to && (k < 0 || String(p.at) > String(periods[k].at))) k = i; });
    if (k < 0) { let best = Infinity; periods.forEach((p, i) => { const dd = date < p.from ? Date.parse(p.from) - Date.parse(date) : Date.parse(date) - Date.parse(p.to); if (dd < best) { best = dd; k = i; } }); }
    cache.set(date, k); return k;
  };
  return (o, parts, date) => { const k = date ? periodAt(date) : latest; return k >= 0 ? fns[k](o, parts) : 1; };
}
