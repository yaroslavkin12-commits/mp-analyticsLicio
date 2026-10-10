import React, { useState, useEffect, useMemo, useCallback } from 'react';
import dayjs from 'dayjs';
import { getBuyoutData } from '../api';
import { fmtInt, useTip, DualChart, ChartPane, niceScale, CAT_COLORS } from './AdsStats2';
import { useCats, useGroups, FinHeader, RowsTable, CatTable, Kpi, Empty, inPath, matchQ, pct1, SEP, OTHER } from './finShared';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// «% выкупа» — по дню заказа: сколько заказали, сколько уже доставлено,
// отменено/не выкуплено и сколько ещё в пути. % выкупа = доставлено /
// (доставлено + отменено), то есть только по завершённым заказам: свежие
// дни ещё «в пути», их процент предварительный.
// ─────────────────────────────────────────────────────────────────────────

const METRICS = [
  { key: 'ordered', label: 'Заказано, шт', fmt: 'int' },
  { key: 'buyout', label: '% выкупа', fmt: 'pct', free: true },
  { key: 'delivered', label: 'Выкуплено, шт', fmt: 'int' },
  { key: 'cancelled', label: 'Отменено / не выкуплено, шт', fmt: 'int' },
  { key: 'inProgress', label: 'В пути, шт', fmt: 'int' },
  { key: 'done', label: 'Завершено, %', fmt: 'pct', free: true },
];
const ROWS = [
  { block: 'Заказы', tone: 'rev' },
  { key: 'ordered', label: 'Заказано, шт', fmt: 'int', good: 'up' },
  { key: 'delivered', label: 'Выкуплено, шт', fmt: 'int', good: 'up' },
  { key: 'cancelled', label: 'Отменено / не выкуплено', fmt: 'int', good: 'down' },
  { key: 'inProgress', label: 'В пути', fmt: 'int', good: 'neutral' },
  { block: 'Выкуп', tone: 'conv' },
  { key: 'buyout', label: '% выкупа', fmt: 'pct', good: 'up', hint: 'Выкуплено / (выкуплено + отменено) — по завершённым заказам' },
  { key: 'done', label: 'Завершено заказов, %', fmt: 'pct', good: 'neutral', hint: 'Доля заказов дня, которые уже доставлены или отменены' },
];
const rate = (d, c) => (d + c > 0 ? d / (d + c) * 100 : null);

export default function Buyout({ cabinet }) {
  const today = dayjs().format('YYYY-MM-DD');
  const [dateFrom, setDateFrom] = useState(dayjs().subtract(44, 'day').format('YYYY-MM-DD'));
  const [dateTo, setDateTo] = useState(today);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState('');
  const [search, setSearch] = useState('');
  const tip = useTip();
  const grp = useGroups(cabinet);

  const load = useCallback(() => {
    setLoading(true); setError(null);
    getBuyoutData(cabinet, { dateFrom, dateTo })
      .then(r => setData(r.data.data))
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, [cabinet, dateFrom, dateTo]);
  useEffect(() => { load(); }, [load]);

  const cats = useCats(data?.articles, data?.order);
  const n = data?.dates.length || 0;
  // По артикулу: массивы по дням + прошлый период.
  const per = useMemo(() => {
    if (!data) return [];
    const P = cats.arts.map(() => null);
    const get = ai => P[ai] || (P[ai] = { o: new Float64Array(n), d: new Float64Array(n), c: new Float64Array(n), p: new Float64Array(n), prev: null });
    for (const r of data.rows) { const x = get(r[0]); x.o[r[1]] += r[2]; x.d[r[1]] += r[3]; x.c[r[1]] += r[4]; x.p[r[1]] += r[5]; }
    for (const r of data.prev || []) get(r[0]).prev = { o: r[1], d: r[2], c: r[3], p: r[4] };
    return P;
  }, [data, cats.arts, n]);

  const q = search.trim().toLowerCase();
  const list = useMemo(() => ({ q, arts: cats.arts.filter(a => per[a.i] && inPath(a, sel) && matchQ(a, q) && grp.test(a)) }), [cats.arts, per, sel, q, grp.test]);

  const aggOf = useCallback(items => {
    let o = 0, d = 0, c = 0, p = 0, po = 0, pd = 0, pc = 0, hasPrev = false;
    for (const a of items) {
      const x = per[a.i]; if (!x) continue;
      for (let i = 0; i < n; i++) { o += x.o[i]; d += x.d[i]; c += x.c[i]; p += x.p[i]; }
      if (x.prev) { hasPrev = true; po += x.prev.o; pd += x.prev.d; pc += x.prev.c; }
    }
    const buyout = rate(d, c), pbuy = hasPrev ? rate(pd, pc) : null;
    return { ordered: o, delivered: d, cancelled: c, inProgress: p, buyout, pbuy, done: o ? (d + c) / o * 100 : null, prevOrdered: hasPrev ? po : null };
  }, [per, n]);

  const series = useMemo(() => {
    const s = { ordered: new Float64Array(n), delivered: new Float64Array(n), cancelled: new Float64Array(n), inProgress: new Float64Array(n) };
    for (const a of list.arts) { const x = per[a.i]; for (let i = 0; i < n; i++) { s.ordered[i] += x.o[i]; s.delivered[i] += x.d[i]; s.cancelled[i] += x.c[i]; s.inProgress[i] += x.p[i]; } }
    const buyout = [], done = [];
    for (let i = 0; i < n; i++) {
      const dn = s.ordered[i] ? (s.delivered[i] + s.cancelled[i]) / s.ordered[i] * 100 : null;
      // Пока завершено меньше половины заказов дня, % выкупа ещё не показателен.
      buyout.push(dn !== null && dn >= 50 ? rate(s.delivered[i], s.cancelled[i]) : null); done.push(dn);
    }
    return { ...s, buyout, done };
  }, [list, per, n]);

  if (loading && !data) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Загрузка…</div></div>;
  if (error && !data) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Не удалось загрузить: {error} <button className="a-btn" onClick={load}>Повторить</button></div></div>;

  const dates = data.dates;
  const tot = aggOf(list.arts);
  const byDate = {};
  dates.forEach((d, i) => { byDate[d] = {}; for (const m of METRICS) byDate[d][m.key] = series[m.key][i]; });
  const totals = { ordered: tot.ordered, delivered: tot.delivered, cancelled: tot.cancelled, inProgress: tot.inProgress, buyout: tot.buyout, done: tot.done };

  // % выкупа по подкатегориям (линии), только дни с ≥ 5 завершёнными заказами.
  const depth = sel ? sel.split(SEP).length : 0;
  const kids = q ? [] : cats.childrenOf(sel);
  const kidSeries = kids.slice(0, 6).map((k, ki) => {
    const items = list.arts.filter(a => a.parts[depth] === k);
    const vals = dates.map((_, i) => { let d = 0, c = 0; for (const a of items) { d += per[a.i].d[i]; c += per[a.i].c[i]; } return d + c >= 5 ? d / (d + c) * 100 : null; });
    return { key: k, label: k, fmt: 'pct', kind: 'line', side: 'left', values: vals, color: depth === 0 ? (CAT_COLORS[cats.topSlot(k)] || OTHER) : (CAT_COLORS[ki] || OTHER) };
  }).filter(s => s.values.some(v => v !== null));
  const allKid = kidSeries.flatMap(s => s.values).filter(v => v !== null);
  const kScale = niceScale(allKid.length ? Math.min(...allKid) : 0, allKid.length ? Math.max(...allKid) : 100, true);
  kidSeries.forEach(s => { s.scale = kScale; });

  const cols = [
    { key: 'buyout', label: '% выкупа', fmt: 'pct', delta: g => (g.buyout !== null && g.pbuy !== null ? g.buyout - g.pbuy : null), deltaUnit: 'pp' },
    { key: 'ordered', label: 'Заказано', fmt: 'int', delta: g => (g.prevOrdered ? (g.ordered - g.prevOrdered) / g.prevOrdered * 100 : null) },
    { key: 'delivered', label: 'Выкуплено', fmt: 'int' },
    { key: 'cancelled', label: 'Отменено', fmt: 'int' },
    { key: 'inProgress', label: 'В пути', fmt: 'int' },
    { key: 'done', label: 'Завершено', fmt: 'pct' },
  ];

  return (
    <div className="mpui sa-page">
      <FinHeader grp={grp} title="% выкупа" cats={cats} sel={sel} setSel={setSel} search={search} setSearch={setSearch}
        dateFrom={dateFrom} dateTo={dateTo} setRange={(f, t) => { setDateFrom(f); setDateTo(t); }} periods={[14, 30, 45]} loading={loading} />

      {!data.rows.length ? (
        <Empty>
          <b>Данных о выкупе пока нет.</b><br />
          Статусы заказов собирает Google-скрипт во вкладку «Buyout» вместе с географией: вставьте обновлённый скрипт,
          запустите <code>setupTriggers</code> и один раз <code>syncGeoFull</code> — заполнятся последние 45 дней.
        </Empty>
      ) : (
        <>
          <div className={`a-kpis s-kpis ${loading ? 'a-loading' : ''}`}>
            <Kpi label="% выкупа" value={pct1(tot.buyout)} sub={tot.pbuy !== null && tot.buyout !== null ? <span>{tot.buyout >= tot.pbuy ? '▲' : '▼'} {Math.abs(tot.buyout - tot.pbuy).toFixed(1).replace('.', ',')} п.п. к прошлому периоду</span> : 'по завершённым заказам'} />
            <Kpi label="Заказано, шт" value={fmtInt(tot.ordered)} sub={`выкуплено ${fmtInt(tot.delivered)}`} />
            <Kpi label="Отменено / не выкуплено" value={fmtInt(tot.cancelled)} sub={pct1(tot.ordered ? tot.cancelled / tot.ordered * 100 : null) + ' от заказов'} />
            <Kpi label="Ещё в пути" value={fmtInt(tot.inProgress)} sub={`завершено ${pct1(tot.done)} заказов`} />
          </div>

          <div className={`a-card s-card ${loading ? 'a-loading' : ''}`}>
            <DualChart dates={dates} byDate={byDate} tip={tip} events={[]} metricsList={METRICS} storeKey="mp-buyout-chart" defaults={{ left: 'ordered', right: 'buyout', type: 'combo' }} />
            <div className="a-hint" style={{ marginTop: 6 }}>По дню заказа. % выкупа дня показываем, когда по нему завершено больше половины заказов; свежие дни ещё в пути.</div>
          </div>

          {kidSeries.length > 1 && (
            <div className="a-card s-card">
              <div className="a-bar" style={{ marginBottom: 6 }}><b style={{ fontSize: 14 }}>% выкупа по подкатегориям</b><span className="a-hint">дни, где завершено хотя бы 5 заказов</span></div>
              <ChartPane dates={dates} series={kidSeries} events={[]} tip={tip} height={220} showX onHover={() => {}} hoverIdx={null} />
              <div className="s-legend">{kidSeries.map(s => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}</div>
            </div>
          )}

          <CatTable cats={cats} sel={sel} setSel={setSel} list={list} cols={cols} aggOf={aggOf} sortKey="ordered"
            hint="рядом — изменение к прошлому периоду той же длины" />

          <div className="a-card">
            <div className="a-bar" style={{ padding: '12px 14px 8px' }}><b style={{ fontSize: 14 }}>По дням</b></div>
            <RowsTable dates={dates} rows={ROWS} vals={series} totals={totals} firstCol="Показатель" />
          </div>
        </>
      )}
      {tip.node}
    </div>
  );
}
