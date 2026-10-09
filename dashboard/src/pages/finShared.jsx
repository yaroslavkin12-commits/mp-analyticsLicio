import React, { useMemo, useCallback, useRef, useEffect } from 'react';
import dayjs from 'dayjs';
import DateRangePicker from '../components/DateRangePicker';
import { fmtInt, fmtBy, heatColor, naturalCompare, shortModel, CAT_COLORS, Delta } from './AdsStats2';

// ─────────────────────────────────────────────────────────────────────────
// Общие куски для «Юнит-экономики», «P&L» и «% выкупа»: фильтр по
// категориям (те же вкладки и цвета, что в «Аналитике продаж»), поиск,
// таблица «строки × дни» и таблица по категориям/артикулам.
// ─────────────────────────────────────────────────────────────────────────

export const SEP = ' / ';
export const OTHER = 'var(--a-ink3)';
export const pct1 = v => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : `${v.toFixed(Math.abs(v) < 10 ? 1 : 0).replace('.', ',')}%`;

export function useCats(articles, order) {
  const arts = useMemo(() => (articles || []).map((a, i) => ({ ...a, i, parts: (a.cat || 'Без категории').split(SEP), short: shortModel(a.n) || a.n || a.o })), [articles]);
  const rank = useMemo(() => new Map((order || []).map((x, i) => [x, i])), [order]);
  const sortNames = useCallback(names => [...names].sort((x, y) => ((rank.has(x) ? rank.get(x) : 1e6) - (rank.has(y) ? rank.get(y) : 1e6)) || naturalCompare(x, y)), [rank]);
  const topCats = useMemo(() => sortNames(new Set(arts.map(a => a.parts[0]))), [arts, sortNames]);
  const childrenOf = useCallback(path => {
    const depth = path ? path.split(SEP).length : 0;
    const names = new Set();
    for (const a of arts) if (!path || a.cat === path || a.cat.startsWith(path + SEP)) { if (a.parts[depth]) names.add(a.parts[depth]); }
    return sortNames(names);
  }, [arts, sortNames]);
  const topSlot = useCallback(name => topCats.indexOf(name), [topCats]);
  return { arts, topCats, childrenOf, topSlot };
}

export const inPath = (a, sel) => !sel || a.cat === sel || a.cat.startsWith(sel + SEP);
export const matchQ = (a, q) => !q || a.o.toLowerCase().includes(q) || (a.n || '').toLowerCase().includes(q);

// Шапка страницы: заголовок, период, поиск, вкладки категорий и «хлебные крошки».
export function FinHeader({ title, cats, sel, setSel, search, setSearch, dateFrom, dateTo, setRange, periods = [7, 14, 30], loading, children }) {
  const today = dayjs().format('YYYY-MM-DD');
  const crumbs = sel ? sel.split(SEP) : [];
  const kids = cats.childrenOf(sel);
  return (
    <div className="page-sticky">
      <div className="a-top">
        <h1>{title}</h1>
        {setRange && (
          <>
            <span className="a-seg">{periods.map(n => {
              const f = dayjs().subtract(n - 1, 'day').format('YYYY-MM-DD');
              return <button key={n} type="button" className={dateFrom === f && dateTo === today ? 'on' : ''} onClick={() => setRange(f, today)}>{n} дн</button>;
            })}</span>
            <DateRangePicker from={dateFrom} to={dateTo} onChange={setRange} />
          </>
        )}
        <input className="a-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Артикул или название" style={{ minWidth: 200 }} />
        {children}
        {loading && <span className="a-hint">обновляем…</span>}
      </div>
      <div className="a-bar">
        <div className="a-tabs">
          <button type="button" className={`a-tab ${!sel ? 'on' : ''}`} onClick={() => setSel('')}>Все</button>
          {cats.topCats.map(c => (
            <button key={c} type="button" className={`a-tab ${sel === c || sel.startsWith(c + SEP) ? 'on' : ''}`} onClick={() => setSel(c)}>
              <i className="s-dot" style={{ background: CAT_COLORS[cats.topSlot(c)] || OTHER }} />{c}
            </button>
          ))}
        </div>
      </div>
      {sel && (
        <div className="a-bar s-crumbs">
          <button type="button" className="s-crumb" onClick={() => setSel('')}>Все</button>
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              <span className="a-hint">›</span>
              <button type="button" className={`s-crumb ${i === crumbs.length - 1 ? 'on' : ''}`} onClick={() => setSel(crumbs.slice(0, i + 1).join(SEP))}>{c}</button>
            </React.Fragment>
          ))}
          {kids.length > 0 && <span className="a-hint" style={{ marginLeft: 8 }}>подкатегории:</span>}
          {kids.map((k, i) => <button key={k} type="button" className="s-chip" onClick={() => setSel(sel + SEP + k)}><i className="s-dot" style={{ background: CAT_COLORS[i] || OTHER }} />{k}</button>)}
        </div>
      )}
    </div>
  );
}

// Таблица «строки × дни» как в «Рекламе». rows: [{ block, tone } | { key,
// label, fmt, good: 'up'|'down'|'neutral', sub, strong, hint }]; vals[key] —
// массив по дням, totals[key] — итог.
export function RowsTable({ dates, rows, vals, totals, firstCol = 'Статья' }) {
  const ref = useRef(null);
  const today = dayjs().format('YYYY-MM-DD');
  useEffect(() => { if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth; }, [dates.length]);
  return (
    <div className="a-days" ref={ref}>
      <table className="a-dt f-wide">
        <thead>
          <tr>
            <th className="lbl">{firstCol}</th>
            <th className="tot">Итого</th>
            {dates.map(d => <th key={d} className={d === today ? 'today' : ''}>{d.slice(8)}.{d.slice(5, 7)}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => {
            if (row.block) return <tr key={'b' + ri} className={`blk tone-${row.tone || 'rev'}`}><td colSpan={dates.length + 2}><span className="blk-l">{row.block}</span></td></tr>;
            const v = vals[row.key] || [];
            const nums = [...v].filter(x => x !== null && x !== undefined && Number.isFinite(x));
            const min = nums.length ? Math.min(...nums) : 0, max = nums.length ? Math.max(...nums) : 0;
            return (
              <tr key={row.key} className={`${row.sub ? 'sub' : ''} ${row.strong ? 'f-strong' : ''}`}>
                <td className="lbl" title={row.hint || row.label}>{row.sub ? '— ' : ''}{row.label}</td>
                <td className="tot">{fmtBy(totals[row.key], row.fmt)}</td>
                {dates.map((d, i) => {
                  const x = v[i];
                  return <td key={d} style={{ background: heatColor(x, min, max, row.good || 'neutral') }} className={row.signed && x < 0 ? 'f-neg' : ''}>{fmtBy(x, row.fmt)}</td>;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Таблица по категориям: дочерние категории выбранной (клик — внутрь), в
// листовой категории или при поиске — сразу артикулы.
// cols: [{ key, label, fmt, delta?: (agg) => число, deltaUnit, good }]
// aggOf(list) → объект со значениями колонок.
export function CatTable({ cats, sel, setSel, list, cols, aggOf, sortKey, title, hint, onArt }) {
  const q = !!list.q;
  const kids = q ? [] : cats.childrenOf(sel);
  const depth = sel ? sel.split(SEP).length : 0;
  const rows = useMemo(() => {
    if (kids.length) {
      return kids.map((k, i) => {
        const items = list.arts.filter(a => a.parts[depth] === k);
        return { key: k, name: k, color: depth === 0 ? (CAT_COLORS[cats.topSlot(k)] || OTHER) : (CAT_COLORS[i] || OTHER), count: items.length, agg: aggOf(items), path: (sel ? sel + SEP : '') + k };
      }).filter(r => r.count);
    }
    return list.arts.map(a => ({ key: a.o, name: a.short, art: a, agg: aggOf([a]) }))
      .filter(r => (r.agg[sortKey] || 0) !== 0)
      .sort((x, y) => Math.abs(y.agg[sortKey] || 0) - Math.abs(x.agg[sortKey] || 0)).slice(0, 300);
  }, [kids.join('|'), list, aggOf, sortKey, depth, sel]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = useMemo(() => aggOf(list.arts), [list, aggOf]);
  const cell = (c, agg) => (
    <td key={c.key} className="n r">
      {fmtBy(agg[c.key], c.fmt)}
      {c.delta && <span style={{ marginLeft: 6 }}><Delta value={c.delta(agg)} unit={c.deltaUnit || '%'} goodWhen={c.good || 'up'} /></span>}
    </td>
  );
  return (
    <div className="a-card">
      <div className="a-bar" style={{ padding: '12px 14px 0' }}>
        <b style={{ fontSize: 14 }}>{title || (kids.length ? 'По категориям' : 'По артикулам')}</b>
        {hint && <span className="a-hint">{hint}</span>}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="a-t s-slice">
          <thead>
            <tr><th>{kids.length ? 'Категория' : 'Артикул'}</th>{cols.map(c => <th key={c.key} className="r">{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key} className="row" style={{ cursor: r.path || onArt ? 'pointer' : 'default' }} onClick={() => (r.path ? setSel(r.path) : onArt && onArt(r.art))}>
                <td>
                  {r.art ? (
                    <div title={r.art.n}><b>{r.name}</b> <span className="muted" style={{ fontSize: 12 }}>{r.art.o}</span><div className="muted" style={{ fontSize: 11.5 }}>{r.art.parts.slice(-2).join(' › ')}</div></div>
                  ) : (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><i className="s-dot" style={{ background: r.color }} /><b>{r.name}</b> <span className="muted" style={{ fontSize: 12 }}>{r.count} арт.</span></span>
                  )}
                </td>
                {cols.map(c => cell(c, r.agg))}
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={cols.length + 1} className="muted" style={{ padding: 16 }}>Нет данных</td></tr>}
            {rows.length > 1 && <tr className="s-total"><td><b>Итого</b></td>{cols.map(c => cell(c, total))}</tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Kpi({ label, value, sub }) {
  return <div className="a-kpi"><span className="lbl">{label}</span><span className="val n">{value}</span>{sub !== undefined && <span className="sub">{sub}</span>}</div>;
}

export function Empty({ children }) {
  return <div className="a-card" style={{ padding: 24, lineHeight: 1.6 }}>{children}</div>;
}

export const money = v => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : `${fmtInt(v)} ₽`;

// Налог (% от выручки) — у каждого свой режим, храним в браузере.
export function useTax(cabinet) {
  const key = `mp-tax-${cabinet}`;
  const [tax, setTaxState] = React.useState(() => { try { const v = parseFloat(localStorage.getItem(key)); return Number.isFinite(v) ? v : 6; } catch (e) { return 6; } });
  const setTax = v => { setTaxState(v); try { localStorage.setItem(key, String(v)); } catch (e) { /* ignore */ } };
  return [tax, setTax];
}
export function TaxInput({ tax, setTax }) {
  return (
    <label className="a-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      налог
      <input className="a-input" type="number" min="0" max="30" step="0.5" value={tax} onChange={e => setTax(Math.max(0, parseFloat(e.target.value) || 0))} style={{ width: 64, padding: '4px 8px' }} />
      % от выручки
    </label>
  );
}
