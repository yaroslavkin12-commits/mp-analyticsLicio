import { useState, useEffect, useMemo } from 'react';
import { getBuyerShare } from '../api';

import {buildFn} from '../lib/buyerShareModel';

// Доля цены, которую платит покупатель (база налога, см. backend
// routes/finance.js /buyer-share). Берётся из загруженных в «Сверку» отчётов
// Ozon «Начисления» — по периодам: каждый отчёт хранится за свой период и
// действует на свои дни. Внутри периода: по артикулу (если продаж ≥ 3), иначе
// среднее по категории, иначе по кабинету. День вне всех периодов — ближайший
// период. Нет отчётов — 1 (налог от полной цены).
//   shareOf(o, parts)        — по последнему периоду (прогнозы, цены, юнитка);
//   shareAt(o, parts, date)  — для конкретного дня (P&L).

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
export {makeShareAt} from '../lib/buyerShareModel';
