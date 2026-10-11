import React, { useState, useEffect, useMemo, useCallback } from 'react';
import dayjs from 'dayjs';
import { getQueries, getQuerySeries, getAdsEvents } from '../api';
import { fmtInt, useTip, ChartPane, niceScale, CAT_COLORS } from './AdsStats2';
import { useCats, useGroups, FinHeader, Kpi, Empty, inPath, matchQ, OTHER } from './finShared';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// «Позиции в поиске» — по поисковым запросам Ozon (аналитика «Поисковые
// запросы», нужен Premium): на какой позиции товар показывается по
// запросу, сколько людей ищут, клики и заказы. Динамика — позиция во
// второй половине периода к первой. По клику — график позиции по дням
// с отметками из журнала изменений (ставки, цены, фото…).
// ─────────────────────────────────────────────────────────────────────────

const pos = v => (v === null || v === undefined ? '—' : v.toFixed(v < 10 ? 1 : 0).replace('.', ','));
function PosDelta({ p1, p2 }) {
  if (p1 === null || p2 === null || p1 === undefined || p2 === undefined) return <span className="muted">—</span>;
  const d = p2 - p1; // меньше — лучше
  if (Math.abs(d) < 0.5) return <span className="delta flat">• 0</span>;
  return <span className={`delta ${d < 0 ? 'good' : 'bad'}`} title={`было ${pos(p1)}, стало ${pos(p2)}`}>{d < 0 ? '▲' : '▼'} {Math.abs(d).toFixed(Math.abs(d) < 10 ? 1 : 0).replace('.', ',')}</span>;
}
const pill = p => (p === null ? <span className="muted">—</span> : <span className={`pill ${p <= 10 ? 'g' : p <= 40 ? 'w' : 'm'}`} style={{ minWidth: 44 }}>{pos(p)}</span>);

export default function SearchPositions({ cabinet }) {
  const yday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  const [dateFrom, setDateFrom] = useState(dayjs().subtract(14, 'day').format('YYYY-MM-DD'));
  const [dateTo, setDateTo] = useState(yday);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState('queries');
  const [open, setOpen] = useState(null);
  const [minFreq, setMinFreq] = useState(10);
  const tip = useTip();
  const grp = useGroups(cabinet);

  const load = useCallback(() => {
    setLoading(true); setError(null);
    getQueries(cabinet, { dateFrom, dateTo }).then(r => setData(r.data.data)).catch(e => setError(e.response?.data?.error || e.message)).finally(() => setLoading(false));
  }, [cabinet, dateFrom, dateTo]);
  useEffect(() => { load(); }, [load]);
  const cats = useCats(data?.articles, data?.order);

  const q = search.trim().toLowerCase();
  const rows = useMemo(() => {
    if (!data) return [];
    return data.rows.map(r => ({ a: cats.arts[r[0]], q: data.queries[r[1]], p: r[2], s: r[3], c: r[4], o: r[5], rv: r[6], p1: r[7], p2: r[8] }))
      .filter(r => r.a && inPath(r.a, sel) && grp.test(r.a) && (!q || matchQ(r.a, q) || String(r.q || '').toLowerCase().includes(q)));
  }, [data, cats.arts, sel, grp.test, q]);

  const byQuery = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      const x = m.get(r.q) || { q: r.q, freq: 0, best: null, bestArt: null, n: 0, c: 0, o: 0, rv: 0, ws: 0, wp: 0, w1: 0, s1: 0, w2: 0, s2: 0, arts: [] };
      x.freq = Math.max(x.freq, r.s); x.n++; x.c += r.c; x.o += r.o; x.rv += r.rv; x.arts.push(r);
      if (r.p !== null) { if (x.best === null || r.p < x.best) { x.best = r.p; x.bestArt = r.a; } x.wp += r.p * Math.max(1, r.s); x.ws += Math.max(1, r.s); }
      if (r.p1 !== null) { x.w1 += r.p1 * Math.max(1, r.s); x.s1 += Math.max(1, r.s); }
      if (r.p2 !== null) { x.w2 += r.p2 * Math.max(1, r.s); x.s2 += Math.max(1, r.s); }
      m.set(r.q, x);
    }
    return [...m.values()].map(x => ({ ...x, avg: x.ws ? x.wp / x.ws : null, p1: x.s1 ? x.w1 / x.s1 : null, p2: x.s2 ? x.w2 / x.s2 : null }))
      .filter(x => x.freq >= minFreq).sort((a, b) => b.freq - a.freq);
  }, [rows, minFreq]);
  const byArt = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      const x = m.get(r.a.i) || { a: r.a, n: 0, s: 0, c: 0, o: 0, rv: 0, wp: 0, ws: 0, w1: 0, s1: 0, w2: 0, s2: 0, top: null, list: [] };
      x.n++; x.s += r.s; x.c += r.c; x.o += r.o; x.rv += r.rv; x.list.push(r);
      if (r.p !== null) { x.wp += r.p * Math.max(1, r.s); x.ws += Math.max(1, r.s); }
      if (r.p1 !== null) { x.w1 += r.p1 * Math.max(1, r.s); x.s1 += Math.max(1, r.s); }
      if (r.p2 !== null) { x.w2 += r.p2 * Math.max(1, r.s); x.s2 += Math.max(1, r.s); }
      if (!x.top || r.s > x.top.s) x.top = r;
      m.set(r.a.i, x);
    }
    return [...m.values()].map(x => ({ ...x, avg: x.ws ? x.wp / x.ws : null, p1: x.s1 ? x.w1 / x.s1 : null, p2: x.s2 ? x.w2 / x.s2 : null })).sort((a, b) => b.s - a.s);
  }, [rows]);

  const K = useMemo(() => {
    let ws = 0, wp = 0, top10 = 0, up = 0, down = 0;
    for (const r of rows) {
      if (r.p !== null) { wp += r.p * Math.max(1, r.s); ws += Math.max(1, r.s); if (r.p <= 10) top10 += Math.max(1, r.s); }
      if (r.p1 !== null && r.p2 !== null && r.s >= minFreq) { if (r.p2 <= r.p1 - 3) up++; else if (r.p2 >= r.p1 + 3) down++; }
    }
    return { avg: ws ? wp / ws : null, top10: ws ? top10 / ws * 100 : null, up, down };
  }, [rows, minFreq]);

  if (loading && !data) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Загрузка…</div></div>;
  if (error && !data) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Не удалось загрузить: {error} <button className="a-btn" onClick={load}>Повторить</button></div></div>;

  return (
    <div className="mpui sa-page">
      <FinHeader title="Позиции в поиске" cats={cats} sel={sel} setSel={setSel} search={search} setSearch={setSearch} grp={grp}
        dateFrom={dateFrom} dateTo={dateTo} setRange={(f, t) => { setDateFrom(f); setDateTo(t > yday ? yday : t); }} periods={[7, 14, 30]} loading={loading}>
        <span className="a-seg">{[['queries', 'По запросам'], ['arts', 'По товарам']].map(([k, l]) => <button key={k} type="button" className={view === k ? 'on' : ''} onClick={() => { setView(k); setOpen(null); }}>{l}</button>)}</span>
        <label className="a-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>частота от
          <input className="a-input" type="number" min="0" value={minFreq} onChange={e => setMinFreq(Math.max(0, Number(e.target.value) || 0))} style={{ width: 64, padding: '4px 8px' }} />
        </label>
      </FinHeader>

      {!data.rows.length ? (
        <Empty><b>Данных по поисковым запросам пока нет.</b><br />Их собирает Google-скрипт (функция <code>syncQueries</code>, вкладка «Queries»; нужна подписка Premium). Вставьте обновлённый скрипт, запустите <code>setupTriggers</code> и один раз <code>syncQueriesFull</code> — заполнит последние 14 дней. Дальше — каждый день за вчера.</Empty>
      ) : (
        <>
          <div className="a-kpis s-kpis">
            <Kpi label="Средняя позиция" value={pos(K.avg)} sub="взвешена по частоте запроса · меньше — выше" />
            <Kpi label="Показов в топ-10" value={K.top10 === null ? '—' : `${Math.round(K.top10)}%`} sub="доля частоты, где товар на 1–10 месте" />
            <Kpi label="Поднялись" value={<span className="s-up">{fmtInt(K.up)}</span>} sub="пар «товар × запрос» на 3+ позиции за период" />
            <Kpi label="Опустились" value={<span className="s-down">{fmtInt(K.down)}</span>} sub="на 3+ позиции — посмотрите журнал изменений" />
          </div>

          <div className="a-card">
            <div className="a-scroll">
              {view === 'queries' ? (
                <table className="a-t s-tree">
                  <thead><tr><th>Запрос</th><th className="r" title="Сколько людей искали (максимум по нашим товарам)">Частота</th><th className="r">Лучшая позиция</th><th>Лучший товар</th><th className="r">Товаров</th><th className="r">Средняя</th><th className="r">Динамика</th><th className="r">Клики</th><th className="r">Заказы</th></tr></thead>
                  <tbody>
                    {byQuery.slice(0, 400).map(x => (
                      <React.Fragment key={x.q}>
                        <tr className={`row ${open === x.q ? 'open' : ''}`} onClick={() => setOpen(open === x.q ? null : x.q)}>
                          <td><div className="a-art"><span className="a-chev">▶</span><b>{x.q}</b></div></td>
                          <td className="n r">{fmtInt(x.freq)}</td><td className="r">{pill(x.best)}</td>
                          <td className="muted">{x.bestArt ? `${x.bestArt.o} ${x.bestArt.short}` : '—'}</td>
                          <td className="n r">{x.n}</td><td className="n r">{pos(x.avg)}</td><td className="r"><PosDelta p1={x.p1} p2={x.p2} /></td>
                          <td className="n r">{fmtInt(x.c)}</td><td className="n r">{fmtInt(x.o)}</td>
                        </tr>
                        {open === x.q && <tr className="a-detail"><td colSpan={9}><Detail cabinet={cabinet} rows={x.arts.sort((a, b) => (a.p ?? 1e9) - (b.p ?? 1e9))} mode="query" query={x.q} tip={tip} cats={cats} /></td></tr>}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="a-t s-tree">
                  <thead><tr><th>Товар</th><th className="r">Запросов</th><th>Главный запрос</th><th className="r">Позиция</th><th className="r">Средняя</th><th className="r">Динамика</th><th className="r">Клики</th><th className="r">Заказы</th><th className="r">Выручка</th></tr></thead>
                  <tbody>
                    {byArt.slice(0, 400).map(x => (
                      <React.Fragment key={x.a.i}>
                        <tr className={`row ${open === x.a.i ? 'open' : ''}`} onClick={() => setOpen(open === x.a.i ? null : x.a.i)}>
                          <td><div className="a-art"><span className="a-chev">▶</span><i className="s-dot" style={{ background: CAT_COLORS[cats.topSlot(x.a.parts[0])] || OTHER }} /><b>{x.a.o}</b> <span className="muted">{x.a.short}</span></div></td>
                          <td className="n r">{x.n}</td><td>{x.top?.q}</td><td className="r">{pill(x.top?.p ?? null)}</td><td className="n r">{pos(x.avg)}</td>
                          <td className="r"><PosDelta p1={x.p1} p2={x.p2} /></td><td className="n r">{fmtInt(x.c)}</td><td className="n r">{fmtInt(x.o)}</td><td className="n r">{fmtInt(x.rv)}</td>
                        </tr>
                        {open === x.a.i && <tr className="a-detail"><td colSpan={9}><Detail cabinet={cabinet} rows={x.list.sort((a, b) => b.s - a.s)} mode="art" art={x.a} tip={tip} cats={cats} /></td></tr>}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          <div className="a-hint">Данные есть с {data.available?.mn ? dayjs(data.available.mn).format('DD.MM.YYYY') : '—'}. Позиция — средняя за день, как её считает Ozon; динамика — вторая половина периода к первой.</div>
        </>
      )}
      {tip.node}
    </div>
  );
}

// Раскрытая строка: таблица и график позиции по дням с отметками журнала.
function Detail({ cabinet, rows, mode, query, art, tip }) {
  const [focus, setFocus] = useState(mode === 'art' ? null : rows[0]?.a?.o);
  const [series, setSeries] = useState(null);
  const [events, setEvents] = useState([]);
  const offer = mode === 'art' ? art.o : focus;
  useEffect(() => {
    if (!offer) return;
    setSeries(null);
    getQuerySeries(cabinet, offer, mode === 'query' ? query : undefined, 30).then(r => setSeries(r.data.data)).catch(() => setSeries([]));
    getAdsEvents(cabinet, dayjs().subtract(30, 'day').format('YYYY-MM-DD'), dayjs().format('YYYY-MM-DD'))
      .then(r => setEvents((r.data.data || []).filter(e => e.offerId === offer))).catch(() => {});
  }, [cabinet, offer, mode, query]);
  const chart = useMemo(() => {
    if (!series || !series.length) return null;
    const dates = [...new Set(series.map(s => s[0]))].sort();
    const di = new Map(dates.map((d, i) => [d, i]));
    const top = mode === 'art' ? rows.slice(0, 5).map(r => r.q) : [query];
    const colors = ['var(--s-c1)', 'var(--s-c2)', 'var(--s-c3)', 'var(--s-c4)', 'var(--s-c5)'];
    const ser = top.map((qq, i) => {
      const v = new Array(dates.length).fill(null);
      for (const s of series) if (s[1] === qq && s[2] !== null) v[di.get(s[0])] = s[2];
      return { key: qq, label: qq, fmt: 'pos', kind: 'line', side: 'left', color: colors[i], values: v };
    }).filter(s => s.values.some(v => v !== null));
    const all = ser.flatMap(s => s.values).filter(v => v !== null);
    const sc = niceScale(Math.min(...all), Math.max(...all), true);
    ser.forEach(s => { s.scale = sc; });
    return { dates, ser };
  }, [series, rows, mode, query]);
  return (
    <div className="a-dwrap" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.2fr)' }}>
      <div>
        <table className="a-t s-slice">
          <thead><tr><th>{mode === 'art' ? 'Запрос' : 'Товар'}</th><th className="r">Частота</th><th className="r">Позиция</th><th className="r">Динамика</th><th className="r">Клики</th><th className="r">Заказы</th></tr></thead>
          <tbody>{rows.slice(0, 30).map(r => (
            <tr key={(mode === 'art' ? r.q : r.a.o)} className={`row ${mode === 'query' && focus === r.a.o ? 'open' : ''}`} style={{ cursor: mode === 'query' ? 'pointer' : 'default' }} onClick={() => mode === 'query' && setFocus(r.a.o)}>
              <td>{mode === 'art' ? r.q : <span><b>{r.a.o}</b> <span className="muted">{r.a.short}</span></span>}</td>
              <td className="n r">{fmtInt(r.s)}</td><td className="r">{pill(r.p)}</td><td className="r"><PosDelta p1={r.p1} p2={r.p2} /></td><td className="n r">{fmtInt(r.c)}</td><td className="n r">{fmtInt(r.o)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div>
        <div className="a-hint" style={{ marginBottom: 4 }}>Позиция по дням{mode === 'art' ? ' (топ-5 запросов по частоте)' : ` — ${focus}`}: меньше — выше. Точки сверху — записи журнала изменений.</div>
        {series === null ? <div className="a-hint">Загрузка…</div> : chart ? (
          <>
            <ChartPane dates={chart.dates} series={chart.ser} events={events.map(e => ({ id: e.id, date: e.date, text: e.text }))} tip={tip} height={220} showX onHover={() => {}} hoverIdx={null} />
            <div className="s-legend">{chart.ser.map(s => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}</div>
          </>
        ) : <div className="a-hint">Нет данных по дням.</div>}
      </div>
    </div>
  );
}
