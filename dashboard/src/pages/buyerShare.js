import { useState, useEffect, useMemo } from 'react';
import { getBuyerShare } from '../api';

const SEP = ' / ';

// Доля цены, которую платит покупатель (база налога, см. backend
// routes/finance.js /buyer-share). Берётся из загруженного в «Сверку» отчёта
// Ozon «Начисления»: по артикулу (если продаж за период ≥ 3), иначе среднее
// по его категории, иначе по кабинету. Нет отчёта — 1 (налог от полной цены).
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
  const shareOf = useMemo(() => {
    if (!data || !data.total) return null;
    const by = data.byOffer || {};
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
      const p = parts || [];
      for (let d = p.length; d >= 1; d--) { const c = cat.get(p.slice(0, d).join(SEP)); if (c && c[1] >= 5) return c[0] / c[1]; }
      return data.total;
    };
  }, [data, arts]);
  return { data, shareOf };
}
