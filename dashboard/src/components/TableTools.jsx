import React, { useState, useEffect, useRef, useCallback } from 'react';

// ─────────────────────────────────────────────────────────────────────────
// Сортировка и фильтры для таблиц.
// Заголовок колонки (<ThCtl>): клик по названию — сортировка (по убыванию →
// по возрастанию → как было); маленькая воронка — фильтр «от … до …».
// <ResetCtl> — едва заметная кнопка «сбросить», видна, только когда что-то
// включено. Состояние помнится в браузере для каждой таблицы.
// ─────────────────────────────────────────────────────────────────────────

const load = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };

export function useTableCtl(storeKey, defaultSort = null) {
  const key = storeKey ? `mp-tbl-${storeKey}` : null;
  const init = (key && load(key)) || {};
  const [sort, setSortRaw] = useState(init.sort !== undefined ? init.sort : defaultSort); // { k, dir: -1|1 } | null
  const [filters, setFilters] = useState(init.filters || {}); // k -> { min, max }
  useEffect(() => { if (key) save(key, { sort, filters }); }, [key, sort, filters]);

  const cycleSort = useCallback(k => {
    setSortRaw(s => (!s || s.k !== k) ? { k, dir: -1 } : s.dir === -1 ? { k, dir: 1 } : defaultSort);
  }, [defaultSort]);
  const setSort = useCallback(v => setSortRaw(v), []);
  const setFilter = useCallback((k, f) => setFilters(prev => {
    const n = { ...prev };
    if (!f || (f.min === '' || f.min === undefined || f.min === null) && (f.max === '' || f.max === undefined || f.max === null)) delete n[k];
    else n[k] = f;
    return n;
  }), []);
  const reset = useCallback(() => { setSortRaw(defaultSort); setFilters({}); }, [defaultSort]);
  const changed = Object.keys(filters).length > 0 || JSON.stringify(sort) !== JSON.stringify(defaultSort);

  // Применить к строкам: get(row, k) → число (или null).
  const apply = useCallback((rows, get) => {
    let out = rows;
    const fk = Object.keys(filters);
    if (fk.length) {
      out = out.filter(r => fk.every(k => {
        const v = get(r, k);
        const { min, max } = filters[k];
        if (v === null || v === undefined || Number.isNaN(v)) return false;
        if (min !== '' && min !== undefined && min !== null && v < Number(min)) return false;
        if (max !== '' && max !== undefined && max !== null && v > Number(max)) return false;
        return true;
      }));
    }
    if (sort) {
      const { k, dir } = sort;
      out = [...out].sort((a, b) => {
        const x = get(a, k), y = get(b, k);
        const xn = x === null || x === undefined || Number.isNaN(x), yn = y === null || y === undefined || Number.isNaN(y);
        if (xn && yn) return 0; if (xn) return 1; if (yn) return -1;
        if (typeof x === 'string' || typeof y === 'string') return String(x).localeCompare(String(y), 'ru', { numeric: true }) * dir;
        return (x - y) * dir;
      });
    }
    return out;
  }, [sort, filters]);

  return { sort, setSort, cycleSort, filters, setFilter, reset, changed, apply };
}

function FilterPop({ value, onApply, onClose, unit }) {
  const [min, setMin] = useState(value?.min ?? '');
  const [max, setMax] = useState(value?.max ?? '');
  const ref = useRef(null);
  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    setTimeout(() => document.addEventListener('mousedown', h), 0);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);
  const ok = () => { onApply({ min, max }); onClose(); };
  return (
    <div ref={ref} className="tt-pop" onClick={e => e.stopPropagation()}>
      <div className="tt-row"><span>от</span><input className="a-input" type="number" value={min} autoFocus onChange={e => setMin(e.target.value)} onKeyDown={e => e.key === 'Enter' && ok()} /></div>
      <div className="tt-row"><span>до</span><input className="a-input" type="number" value={max} onChange={e => setMax(e.target.value)} onKeyDown={e => e.key === 'Enter' && ok()} /></div>
      {unit && <div className="tt-unit">{unit}</div>}
      <div className="tt-act">
        <button type="button" className="a-btn ghost" onClick={() => { onApply(null); onClose(); }}>очистить</button>
        <button type="button" className="a-btn" onClick={ok}>применить</button>
      </div>
    </div>
  );
}

// Заголовок колонки. filter=false — только сортировка; sort=false — без сортировки.
export function ThCtl({ ctl, k, children, hint, className = 'r', filter = true, sort = true, unit, style }) {
  const [open, setOpen] = useState(false);
  const s = ctl.sort && ctl.sort.k === k ? ctl.sort.dir : 0;
  const f = ctl.filters[k];
  return (
    <th className={`${className} tt-th ${s ? 'on' : ''}`} style={style} title={hint}>
      <span className="tt-in">
        <span className={sort ? 'tt-lbl' : ''} onClick={sort ? () => ctl.cycleSort(k) : undefined}>
          {children}{s ? (s < 0 ? ' ↓' : ' ↑') : ''}
        </span>
        {filter && (
          <button type="button" className={`tt-f ${f ? 'on' : ''}`} title={f ? `Фильтр: ${f.min !== '' ? 'от ' + f.min : ''} ${f.max !== '' ? 'до ' + f.max : ''}` : 'Фильтр по значению'}
            onClick={e => { e.stopPropagation(); setOpen(o => !o); }}>⏷</button>
        )}
      </span>
      {open && <FilterPop value={f} unit={unit} onApply={v => ctl.setFilter(k, v)} onClose={() => setOpen(false)} />}
    </th>
  );
}

export function ResetCtl({ ctl, style }) {
  if (!ctl.changed) return null;
  return <button type="button" className="tt-reset" style={style} title="Сбросить сортировку и фильтры таблицы" onClick={ctl.reset}>↺ сбросить</button>;
}
