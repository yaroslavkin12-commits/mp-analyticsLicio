import React, { useState, useEffect, useMemo, useCallback } from 'react';
import dayjs from 'dayjs';
import { getSalesData, getFinancePnl, getFinanceCoefs } from '../api';
import { fmtInt, Delta, CAT_COLORS, SparkBars } from './AdsStats2';
import { unitCoefs, unitProfit } from './unitModel';
import { useCats, useGroups, FinHeader, Kpi, inPath, matchQ, pct1, useTax, OTHER } from './finShared';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// ABC / XYZ-анализ.
//   ABC — вклад в выбранную метрику: A — товары, дающие первые 80%
//   (порог меняется), B — следующие до 95%, C — остальное.
//   XYZ — стабильность спроса: коэффициент вариации заказов по неделям
//   (X < 25% — ровный спрос, Y < 50%, Z — скачет или редкий).
//   Уровень: артикулы, модели авто, марки, подкатегории. Для артикулов —
//   класс в прошлом периоде той же длины (видно, кто вырос/выпал).
// ─────────────────────────────────────────────────────────────────────────

const METRICS = [['revenue', 'Заказы, ₽'], ['orders', 'Заказы, шт'], ['sales', 'Выкупы, ₽'], ['profit', 'Прибыль (прогноз)']];
const LEVELS = [['art', 'Артикулы'], ['model', 'Модели'], ['brand', 'Марки авто'], ['cat', 'Подкатегории']];
const CLS = { A: 'g', B: 'w', C: 'b' };
const NO_BRAND = 'Без марки';

function abcOf(items, a, b) {
  const total = items.reduce((s, x) => s + Math.max(0, x.v), 0);
  let acc = 0;
  return items.map(x => {
    const share = total > 0 ? Math.max(0, x.v) / total * 100 : 0;
    const before = acc; acc += share;
    const cls = x.v <= 0 ? 'C' : before < a ? 'A' : before < b ? 'B' : 'C';
    return { ...x, share, cum: acc, cls };
  });
}
function xyzOf(weekly) {
  const n = weekly.length; if (n < 2) return { cv: null, cls: '—' };
  const mean = weekly.reduce((s, v) => s + v, 0) / n;
  if (mean <= 0) return { cv: null, cls: 'Z' };
  const sd = Math.sqrt(weekly.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  const cv = sd / mean;
  return { cv, cls: cv < 0.25 ? 'X' : cv < 0.5 ? 'Y' : 'Z' };
}

export default function Abc({ cabinet }) {
  const today = dayjs().format('YYYY-MM-DD');
  const [dateFrom, setDateFrom] = useState(dayjs().subtract(29, 'day').format('YYYY-MM-DD'));
  const [dateTo, setDateTo] = useState(today);
  const [sales, setSales] = useState(null);
  const [pnl, setPnl] = useState(null);
  const [coefs, setCoefs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState('');
  const [search, setSearch] = useState('');
  const [metric, setMetric] = useState('revenue');
  const [level, setLevel] = useState('art');
  const [thA, setThA] = useState(80);
  const [thB, setThB] = useState(95);
  const [cell, setCell] = useState(null); // 'A', 'AX' …
  const [tax] = useTax(cabinet);
  const grp = useGroups(cabinet);

  const load = useCallback(() => {
    setLoading(true); setError(null);
    getSalesData(cabinet, { dateFrom, dateTo, compare: 1 })
      .then(r => setSales(r.data.data))
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, [cabinet, dateFrom, dateTo]);
  useEffect(() => { load(); }, [load]);
  // Выкупы и прибыль — по требованию.
  useEffect(() => { if (metric === 'sales') getFinancePnl(cabinet, { dateFrom, dateTo }).then(r => setPnl(r.data.data)).catch(() => {}); }, [metric, cabinet, dateFrom, dateTo]);
  useEffect(() => { if (metric === 'profit' && !coefs) getFinanceCoefs(cabinet).then(r => setCoefs(r.data.data)).catch(() => {}); }, [metric, cabinet, coefs]);

  const cats = useCats(sales?.articles, sales?.order);
  const n = sales?.dates.length || 0;
  const weeks = useMemo(() => {
    if (!sales) return [];
    const m = new Map(); sales.dates.forEach((d, i) => { const k = dayjs(d).subtract((dayjs(d).day() + 6) % 7, 'day').format('YYYY-MM-DD'); if (!m.has(k)) m.set(k, []); m.get(k).push(i); });
    return [...m.values()].filter(ix => ix.length >= 4); // неполные недели не берём
  }, [sales]);

  // По артикулу: суммы за период, по неделям, прошлый период.
  const per = useMemo(() => {
    if (!sales) return [];
    const P = cats.arts.map(() => ({ revenue: 0, orders: 0, spend: 0, sales: 0, day: new Float64Array(n), prev: null }));
    for (const r of sales.rows) { const x = P[r[0]]; x.orders += r[5]; x.revenue += r[6]; x.spend += (r[7] || 0) + (r[8] || 0); x.day[r[1]] += r[5]; }
    for (const p of sales.prev || []) P[p[0]].prev = { orders: p[4], revenue: p[5], spend: p[6] };
    if (pnl) {
      const byOffer = new Map(cats.arts.map(a => [a.o, a.i]));
      for (const [pai, , b, a] of pnl.rows) {
        const k = pnl.buckets[b]; if (k !== 'sale' && k !== 'return') continue;
        const ai = byOffer.get(pnl.articles[pai]?.o); if (ai !== undefined) P[ai].sales += a;
      }
    }
    return P;
  }, [sales, pnl, cats.arts, n]);
  const K = useMemo(() => (coefs ? unitCoefs(coefs, cats.arts.map(a => ({ o: a.o, parts: a.parts }))) : null), [coefs, cats.arts]);
  // Сопоставляем коэффициенты по артикулу (порядок articles у coefs свой).
  const kByOffer = useMemo(() => (K ? new Map(cats.arts.map((a, i) => [a.o, K[i]])) : null), [K, cats.arts]);

  const valOf = useCallback((x, a, prev) => {
    const src = prev ? x.prev : x;
    if (!src) return 0;
    if (metric === 'revenue') return src.revenue;
    if (metric === 'orders') return src.orders;
    if (metric === 'sales') return prev ? 0 : x.sales;
    if (metric === 'profit') { const k = kByOffer?.get(a.o); return k ? unitProfit(k, { ordRub: src.revenue, ordQty: src.orders, ads: src.spend || 0 }, tax).profit : 0; }
    return 0;
  }, [metric, kByOffer, tax]);

  const q = search.trim().toLowerCase();
  const arts = useMemo(() => cats.arts.filter(a => inPath(a, sel) && matchQ(a, q) && grp.test(a)), [cats.arts, sel, q, grp.test]);

  // Группировка по уровню.
  const items = useMemo(() => {
    if (!sales) return [];
    const keyOf = a => level === 'art' ? a.o : level === 'model' ? (a.short || a.o) : level === 'brand' ? (a.brand || NO_BRAND) : a.cat;
    const m = new Map();
    for (const a of arts) {
      const x = per[a.i];
      const v = valOf(x, a, false), pv = valOf(x, a, true);
      if (!v && !pv && !x.orders) continue;
      const k = keyOf(a);
      const g = m.get(k) || { key: k, label: k, v: 0, pv: 0, orders: 0, revenue: 0, n: 0, week: weeks.map(() => 0), arts: [], top: a.parts[0], cat: a.cat, name: a.n };
      g.v += v; g.pv += pv; g.orders += x.orders; g.revenue += x.revenue; g.n++; g.arts.push(a);
      weeks.forEach((ix, wi) => { for (const i of ix) g.week[wi] += x.day[i]; });
      m.set(k, g);
    }
    const list = [...m.values()].sort((x, y) => y.v - x.v);
    const cur = abcOf(list, thA, thB);
    const prevCls = new Map(abcOf([...list].sort((x, y) => y.pv - x.pv).map(x => ({ ...x, v: x.pv })), thA, thB).map(x => [x.key, x.pv > 0 ? x.cls : '—']));
    return cur.map(x => ({ ...x, xyz: xyzOf(x.week), prevCls: metric === 'sales' ? null : prevCls.get(x.key), delta: x.pv ? (x.v - x.pv) / Math.abs(x.pv) * 100 : null }));
  }, [sales, arts, per, valOf, level, weeks, thA, thB, metric]);

  const total = items.reduce((s, x) => s + Math.max(0, x.v), 0);
  const stats = ['A', 'B', 'C'].map(c => { const l = items.filter(x => x.cls === c); return { c, n: l.length, v: l.reduce((s, x) => s + Math.max(0, x.v), 0) }; });
  const matrix = {};
  for (const x of items) { const k = x.cls + x.xyz.cls; matrix[k] = matrix[k] || { n: 0, v: 0 }; matrix[k].n++; matrix[k].v += Math.max(0, x.v); }
  const shown = cell ? items.filter(x => (cell.length === 1 ? x.cls === cell : x.cls + x.xyz.cls === cell)) : items;
  const moved = items.filter(x => x.prevCls && x.prevCls !== '—' && x.prevCls !== x.cls);
  const fmtV = v => (metric === 'orders' ? fmtInt(v) : `${fmtInt(v)} ₽`);
  const mLabel = METRICS.find(m => m[0] === metric)[1];

  if (loading && !sales) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Загрузка…</div></div>;
  if (error && !sales) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Не удалось загрузить: {error} <button className="a-btn" onClick={load}>Повторить</button></div></div>;

  return (
    <div className="mpui sa-page">
      <FinHeader title="ABC-анализ" cats={cats} sel={sel} setSel={setSel} search={search} setSearch={setSearch} grp={grp}
        dateFrom={dateFrom} dateTo={dateTo} setRange={(f, t) => { setDateFrom(f); setDateTo(t); }} periods={[30, 60, 90]} loading={loading}>
        <span className="a-seg">{METRICS.map(([k, l]) => <button key={k} type="button" className={metric === k ? 'on' : ''} onClick={() => { setMetric(k); setCell(null); }}>{l}</button>)}</span>
        <span className="a-seg">{LEVELS.map(([k, l]) => <button key={k} type="button" className={level === k ? 'on' : ''} onClick={() => { setLevel(k); setCell(null); }}>{l}</button>)}</span>
        <label className="a-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>A до
          <input className="a-input" type="number" min="50" max="95" value={thA} onChange={e => setThA(Math.min(thB - 1, Math.max(10, Number(e.target.value) || 80)))} style={{ width: 52, padding: '4px 6px' }} />% · B до
          <input className="a-input" type="number" min="60" max="99" value={thB} onChange={e => setThB(Math.max(thA + 1, Math.min(99.9, Number(e.target.value) || 95)))} style={{ width: 52, padding: '4px 6px' }} />%
        </label>
      </FinHeader>

      {(metric === 'sales' && !pnl) || (metric === 'profit' && !coefs) ? <div className="a-hint">Загружаем данные для метрики…</div> : null}

      <div className={`a-kpis s-kpis ${loading ? 'a-loading' : ''}`}>
        {stats.map(s => (
          <button key={s.c} type="button" className={`a-kpi abc-kpi ${cell === s.c ? 'on' : ''}`} onClick={() => setCell(cell === s.c ? null : s.c)}>
            <span className="lbl">Класс {s.c} {s.c === 'A' ? `(первые ${thA}%)` : s.c === 'B' ? `(до ${thB}%)` : '(остальное)'}</span>
            <span className="val n"><span className={`s-cls ${s.c}`} style={{ marginRight: 8 }}>{s.c}</span>{fmtInt(s.n)} <span className="s-of">из {fmtInt(items.length)}</span></span>
            <span className="sub">{pct1(total ? s.v / total * 100 : null)} {mLabel.toLowerCase()} · {pct1(items.length ? s.n / items.length * 100 : null)} позиций</span>
          </button>
        ))}
        <Kpi label="Сменили класс" value={fmtInt(moved.length)} sub={`к прошлому периоду: ↑ ${moved.filter(x => x.cls < x.prevCls).length} · ↓ ${moved.filter(x => x.cls > x.prevCls).length}`} />
      </div>

      <div className="s-two">
        <div className="a-card s-card">
          <div className="a-bar" style={{ marginBottom: 8 }}><b style={{ fontSize: 14 }}>ABC × XYZ</b><span className="a-hint">клик по клетке — эти позиции в таблице</span></div>
          <table className="abc-mx">
            <thead><tr><th /><th title="Ровный спрос (вариация по неделям < 25%)">X · ровный</th><th title="Колеблется (25–50%)">Y · колеблется</th><th title="Скачет или редкий (> 50%)">Z · нестабильный</th></tr></thead>
            <tbody>
              {['A', 'B', 'C'].map(c => (
                <tr key={c}>
                  <th><span className={`s-cls ${c}`}>{c}</span></th>
                  {['X', 'Y', 'Z'].map(z => { const m = matrix[c + z] || { n: 0, v: 0 }; const k = c + z; return (
                    <td key={z} className={`${cell === k ? 'on' : ''} ${m.n ? '' : 'zero'}`} onClick={() => m.n && setCell(cell === k ? null : k)} style={{ background: total ? `color-mix(in srgb, var(--s-c1) ${Math.round(m.v / total * 120)}%, transparent)` : undefined }}>
                      <b className="n">{fmtInt(m.n)}</b><span>{pct1(total ? m.v / total * 100 : null)}</span>
                    </td>
                  ); })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="a-hint" style={{ marginTop: 8, lineHeight: 1.5 }}>AX/AY — основа выручки: держать запас и не допускать дефицита. AZ — важные, но спрос скачет: следить за остатками и рекламой. CZ — кандидаты на вывод или распродажу.</div>
        </div>
        <div className="a-card s-card">
          <div className="a-bar" style={{ marginBottom: 8 }}><b style={{ fontSize: 14 }}>Кривая Парето</b><span className="a-hint">накопленная доля {mLabel.toLowerCase()} по позициям</span></div>
          <Pareto items={items} thA={thA} thB={thB} />
        </div>
      </div>

      <div className="a-card">
        <div className="a-bar" style={{ padding: '12px 14px 4px' }}>
          <b style={{ fontSize: 14 }}>{LEVELS.find(l => l[0] === level)[1]}</b>
          {cell && <span className="pill w">{cell} · {shown.length} <button type="button" className="a-btn ghost" style={{ padding: '0 4px' }} onClick={() => setCell(null)}>×</button></span>}
          <span className="a-hint">{mLabel}; рядом — изменение к прошлому периоду той же длины</span>
        </div>
        <div className="a-scroll">
          <table className="a-t s-slice">
            <thead><tr><th className="r">#</th><th>{LEVELS.find(l => l[0] === level)[1].replace(/ы$/, '').replace(/и$/, 'я')}</th><th>ABC</th><th>XYZ</th><th title="Класс в прошлом периоде">Был</th>
              <th className="r">{mLabel}</th><th className="r">Доля</th><th className="r">Накопл.</th><th className="r">Заказы, шт</th><th className="r">По неделям</th></tr></thead>
            <tbody>
              {shown.slice(0, 500).map(x => {
                const rank = items.indexOf(x) + 1;
                return (
                  <tr key={x.key}>
                    <td className="n r muted">{rank}</td>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><i className="s-dot" style={{ background: CAT_COLORS[cats.topSlot(x.top)] || OTHER }} />
                        {level === 'art' ? <span title={x.name}><b>{x.key}</b> <span className="muted">{x.arts[0].short}</span></span> : <span><b>{level === 'cat' ? x.key.split(' / ').slice(-2).join(' › ') : x.label}</b> <span className="muted">{x.n} арт.</span></span>}
                      </span>
                    </td>
                    <td><span className={`s-cls ${x.cls}`}>{x.cls}</span></td>
                    <td><span className={`pill ${x.xyz.cls === 'X' ? 'g' : x.xyz.cls === 'Y' ? 'w' : 'm'}`} style={{ minWidth: 0 }} title={x.xyz.cv !== null ? `вариация ${Math.round(x.xyz.cv * 100)}%` : ''}>{x.xyz.cls}</span></td>
                    <td>{x.prevCls ? <span className={`muted ${x.prevCls !== x.cls && x.prevCls !== '—' ? (x.prevCls > x.cls ? 's-up' : 's-down') : ''}`}>{x.prevCls}{x.prevCls !== x.cls && x.prevCls !== '—' ? (x.prevCls > x.cls ? ' ↑' : ' ↓') : ''}</span> : '—'}</td>
                    <td className="n r">{fmtV(x.v)} <Delta value={x.delta} /></td>
                    <td className="r"><span className="s-part"><i style={{ width: `${Math.min(100, x.share * 4)}%` }} /><b className="n">{pct1(x.share)}</b></span></td>
                    <td className="n r muted">{pct1(x.cum)}</td>
                    <td className="n r">{fmtInt(x.orders)}</td>
                    <td><SparkBars values={x.week} w={70} h={20} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Pareto({ items, thA, thB }) {
  const w = 600, h = 220, pl = 40, pr = 10, pt = 10, pb = 24;
  const N = items.length || 1;
  const x = i => pl + (i / N) * (w - pl - pr), y = v => pt + (1 - v / 100) * (h - pt - pb);
  let d = `M${pl},${y(0)}`;
  items.forEach((it, i) => { d += `L${x(i + 1).toFixed(1)},${y(Math.min(100, it.cum)).toFixed(1)}`; });
  const iA = items.findIndex(it => it.cls !== 'A'), iB = items.findIndex(it => it.cls === 'C');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      {[0, 25, 50, 75, 100].map(v => <g key={v}><line x1={pl} x2={w - pr} y1={y(v)} y2={y(v)} stroke="var(--a-grid)" /><text x={pl - 6} y={y(v) + 3.5} textAnchor="end" fontSize="10" fill="var(--a-ink3)">{v}%</text></g>)}
      {iA > 0 && <rect x={pl} y={pt} width={x(iA) - pl} height={h - pt - pb} fill="var(--a-good-soft)" />}
      {iB > iA && iA >= 0 && <rect x={x(iA)} y={pt} width={x(iB) - x(iA)} height={h - pt - pb} fill="var(--a-warn-soft)" />}
      <path d={d} fill="none" stroke="var(--a-rev)" strokeWidth="2" />
      {[[thA, 'A'], [thB, 'B']].map(([t, l]) => <text key={l} x={w - pr - 4} y={y(t) - 4} textAnchor="end" fontSize="10" fill="var(--a-ink3)">{l}: {t}%</text>)}
      <text x={pl} y={h - 6} fontSize="10" fill="var(--a-ink3)">1</text>
      {iA > 0 && <text x={x(iA)} y={h - 6} fontSize="10" textAnchor="middle" fill="var(--a-good)">{iA} поз. = A</text>}
      <text x={w - pr} y={h - 6} fontSize="10" textAnchor="end" fill="var(--a-ink3)">{N}</text>
    </svg>
  );
}
