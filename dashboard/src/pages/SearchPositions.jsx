import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import dayjs from 'dayjs';
import { getQueries, getQuerySeries, getQueryArticle, saveQueryGroup, getAdsEvents, getAdsStats, latestOnly } from '../api';
import { fmtInt, fmtPct, fmtBy, heatColor, useTip, ChartPane, niceScale, CAT_COLORS } from './AdsStats2';
import { useCats, useGroups, FinHeader, Kpi, Empty, inPath, matchQ, OTHER } from './finShared';
import { QUERY_GROUPS, GROUP_LABEL, productProfile, autoGroup } from '../lib/queryGroups';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// «Позиции в поиске» — по поисковым запросам Ozon (аналитика «Поисковые
// запросы», нужен Premium). Сверху — список товаров (или запросов); по
// клику на товар — его карточка: группы запросов (целевые / модель без
// типа / тип без модели / прочие), таблица по дням как в «Рекламе» и
// позиция по каждому запросу по дням.
// ─────────────────────────────────────────────────────────────────────────

const pos = v => (v === null || v === undefined ? '—' : v.toFixed(v < 10 ? 1 : 0).replace('.', ','));
function PosDelta({ p1, p2 }) {
  if (p1 === null || p2 === null || p1 === undefined || p2 === undefined) return <span className="muted">—</span>;
  const d = p2 - p1; // меньше — лучше
  if (Math.abs(d) < 0.5) return <span className="delta flat">• 0</span>;
  return <span className={`delta ${d < 0 ? 'good' : 'bad'}`} title={`было ${pos(p1)}, стало ${pos(p2)}`}>{d < 0 ? '▲' : '▼'} {Math.abs(d).toFixed(Math.abs(d) < 10 ? 1 : 0).replace('.', ',')}</span>;
}
const pill = p => (p === null ? <span className="muted">—</span> : <span className={`pill ${p <= 10 ? 'g' : p <= 40 ? 'w' : 'm'}`} style={{ minWidth: 44 }}>{pos(p)}</span>);
// Постоянные ориентиры цвета позиции: 1–10 — зелёный, дальше к красному.
const posHeat = v => {
  if (!Number.isFinite(v) || v <= 0) return 'transparent';
  const hue = v <= 10 ? 120 : v <= 30 ? 120 - (v - 10) * 3 : Math.max(0, 60 - (v - 30) * 2);
  return `hsla(${hue}, 62%, 42%, 0.32)`;
};
const STORE = 'sp:offer';
const readStore = () => { try { return localStorage.getItem(STORE) || ''; } catch (e) { return ''; } };
const writeStore = v => { try { if (v) localStorage.setItem(STORE, v); else localStorage.removeItem(STORE); } catch (e) { /* без памяти */ } };

export default function SearchPositions({ cabinet }) {
  const [dateFrom, setDateFrom] = useState(dayjs().subtract(14, 'day').format('YYYY-MM-DD'));
  const [dateTo, setDateTo] = useState(dayjs().subtract(1, 'day').format('YYYY-MM-DD'));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState('arts');
  const [open, setOpen] = useState(null);
  const [minFreq, setMinFreq] = useState(10);
  const [offer, setOfferRaw] = useState(readStore);
  const setOffer = v => { setOfferRaw(v); writeStore(v); };
  const tip = useTip();
  const grp = useGroups(cabinet);

  const load = useCallback(() => {
    setLoading(true); setError(null);
    const ok = latestOnly('queries:' + cabinet);
    getQueries(cabinet, { dateFrom, dateTo }).then(ok(r => setData(r.data.data))).catch(ok(e => setError(e.response?.data?.error || e.message))).finally(ok(() => setLoading(false)));
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
      const x = m.get(r.q) || { q: r.q, freq: 0, best: null, o: 0, rv: 0, ws: 0, wp: 0, w1: 0, s1: 0, w2: 0, s2: 0, arts: [] };
      x.freq = Math.max(x.freq, r.s); x.o += r.o; x.rv += r.rv; x.arts.push(r);
      if (r.p !== null) { if (x.best === null || r.p < x.best) x.best = r.p; x.wp += r.p * Math.max(1, r.s); x.ws += Math.max(1, r.s); }
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
      const x = m.get(r.a.i) || { a: r.a, n: 0, s: 0, o: 0, rv: 0, wp: 0, ws: 0, w1: 0, s1: 0, w2: 0, s2: 0, top: null };
      x.n++; x.s += r.s; x.o += r.o; x.rv += r.rv;
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

  // Если в поле поиска ровно артикул товара с данными — сразу открываем его.
  useEffect(() => {
    if (!q || !data) return;
    const hit = cats.arts.find(a => a.o.toLowerCase() === q);
    if (hit && byArt.some(x => x.a.o === hit.o)) setOffer(hit.o);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !data) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Загрузка…</div></div>;
  if (error && !data) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Не удалось загрузить: {error} <button className="a-btn" onClick={load}>Повторить</button></div></div>;

  const artOptions = byArt.map(x => x.a);
  const offerArt = offer ? cats.arts.find(a => a.o === offer) : null;

  return (
    <div className="mpui sa-page">
      <FinHeader title="Позиции в поиске" cats={cats} sel={sel} setSel={setSel} search={search} setSearch={setSearch} grp={grp}
        dateFrom={dateFrom} dateTo={dateTo} setRange={(f, t) => { setDateFrom(f); setDateTo(t); }} periods={[7, 14, 30]} loading={loading}>
        {!offer && <span className="a-seg">{[['arts', 'По товарам'], ['queries', 'По запросам']].map(([k, l]) => <button key={k} type="button" className={view === k ? 'on' : ''} onClick={() => { setView(k); setOpen(null); }}>{l}</button>)}</span>}
        {!offer && view === 'queries' && (
          <label className="a-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>частота от
            <input className="a-input" type="number" min="0" value={minFreq} onChange={e => setMinFreq(Math.max(0, Number(e.target.value) || 0))} style={{ width: 64, padding: '4px 8px' }} />
          </label>
        )}
      </FinHeader>

      {!data.rows.length ? (
        <Empty><b>Данных по поисковым запросам пока нет.</b><br />Их собирает Google-скрипт (функция <code>syncQueries</code>, вкладка «Queries»; нужна подписка Premium). Вставьте обновлённый скрипт, запустите <code>setupTriggers</code> и один раз <code>syncQueriesFull</code> — заполнит последние 14 дней. Дальше — каждый день за вчера.</Empty>
      ) : offer ? (
        <ArticleView cabinet={cabinet} offer={offer} art={offerArt} options={artOptions} onPick={setOffer} onBack={() => setOffer('')} dateFrom={dateFrom} dateTo={dateTo} tip={tip} />
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
                  <thead><tr><th>Запрос</th><th className="r" title="Сколько людей искали (максимум по нашим товарам)">Частота</th><th className="r">Лучшая позиция</th><th className="r">Средняя</th><th className="r">Динамика</th><th className="r">Заказы</th></tr></thead>
                  <tbody>
                    {byQuery.slice(0, 400).map(x => (
                      <React.Fragment key={x.q}>
                        <tr className={`row ${open === x.q ? 'open' : ''}`} onClick={() => setOpen(open === x.q ? null : x.q)}>
                          <td><div className="a-art"><span className="a-chev">▶</span><b>{x.q}</b></div></td>
                          <td className="n r">{fmtInt(x.freq)}</td><td className="r">{pill(x.best)}</td>
                          <td className="n r">{pos(x.avg)}</td><td className="r"><PosDelta p1={x.p1} p2={x.p2} /></td>
                          <td className="n r">{fmtInt(x.o)}</td>
                        </tr>
                        {open === x.q && <tr className="a-detail"><td colSpan={6}><QueryDetail cabinet={cabinet} rows={x.arts.sort((a, b) => (a.p ?? 1e9) - (b.p ?? 1e9))} query={x.q} tip={tip} onOpenArt={setOffer} /></td></tr>}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="a-t s-tree">
                  <thead><tr><th>Товар</th><th className="r">Запросов</th><th>Главный запрос</th><th className="r">Позиция</th><th className="r">Средняя</th><th className="r">Динамика</th><th className="r">Заказы</th><th className="r">Выручка</th></tr></thead>
                  <tbody>
                    {byArt.slice(0, 400).map(x => (
                      <tr key={x.a.i} className="row" onClick={() => setOffer(x.a.o)} title="Открыть по дням">
                        <td><div className="a-art"><span className="a-chev">▶</span><i className="s-dot" style={{ background: CAT_COLORS[cats.topSlot(x.a.parts[0])] || OTHER }} /><b>{x.a.o}</b> <span className="muted">{x.a.short}</span></div></td>
                        <td className="n r">{x.n}</td><td>{x.top?.q}</td><td className="r">{pill(x.top?.p ?? null)}</td><td className="n r">{pos(x.avg)}</td>
                        <td className="r"><PosDelta p1={x.p1} p2={x.p2} /></td><td className="n r">{fmtInt(x.o)}</td><td className="n r">{fmtInt(x.rv)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          <div className="a-hint">Нажмите на товар — откроется его статистика по дням и по каждому запросу. Данные есть с {data.available?.mn ? dayjs(data.available.mn).format('DD.MM.YYYY') : '—'}. Позиция — средняя за день, как её считает Ozon; динамика — вторая половина периода к первой.</div>
        </>
      )}
      {tip.node}
    </div>
  );
}

// Раскрытый запрос в списке «По запросам»: товары и график позиции по дням.
function QueryDetail({ cabinet, rows, query, tip, onOpenArt }) {
  const [focus, setFocus] = useState(rows[0]?.a?.o);
  const [series, setSeries] = useState(null);
  const [events, setEvents] = useState([]);
  useEffect(() => {
    if (!focus) return;
    setSeries(null);
    getQuerySeries(cabinet, focus, query, 30).then(r => setSeries(r.data.data)).catch(() => setSeries([]));
    getAdsEvents(cabinet, dayjs().subtract(30, 'day').format('YYYY-MM-DD'), dayjs().format('YYYY-MM-DD'))
      .then(r => setEvents((r.data.data || []).filter(e => e.offerId === focus))).catch(() => {});
  }, [cabinet, focus, query]);
  const chart = useMemo(() => {
    if (!series || !series.length) return null;
    const dates = [...new Set(series.map(s => s[0]))].sort();
    const di = new Map(dates.map((d, i) => [d, i]));
    const v = new Array(dates.length).fill(null);
    for (const s of series) if (s[1] === query && s[2] !== null) v[di.get(s[0])] = s[2];
    if (!v.some(x => x !== null)) return null;
    const all = v.filter(x => x !== null);
    const ser = [{ key: query, label: query, fmt: 'pos', kind: 'line', side: 'left', color: 'var(--s-c1)', values: v, scale: niceScale(Math.min(...all), Math.max(...all), true) }];
    return { dates, ser };
  }, [series, query]);
  return (
    <div className="a-dwrap" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.2fr)' }}>
      <div>
        <table className="a-t s-slice">
          <thead><tr><th>Товар</th><th className="r">Частота</th><th className="r">Позиция</th><th className="r">Динамика</th><th className="r">Заказы</th><th /></tr></thead>
          <tbody>{rows.slice(0, 30).map(r => (
            <tr key={r.a.o} className={`row ${focus === r.a.o ? 'open' : ''}`} style={{ cursor: 'pointer' }} onClick={() => setFocus(r.a.o)}>
              <td><span><b>{r.a.o}</b> <span className="muted">{r.a.short}</span></span></td>
              <td className="n r">{fmtInt(r.s)}</td><td className="r">{pill(r.p)}</td><td className="r"><PosDelta p1={r.p1} p2={r.p2} /></td><td className="n r">{fmtInt(r.o)}</td>
              <td className="r"><button type="button" className="a-btn sm" onClick={e => { e.stopPropagation(); onOpenArt(r.a.o); }}>по дням</button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div>
        <div className="a-hint" style={{ marginBottom: 4 }}>Позиция по дням — {focus}: меньше — выше. Точки сверху — записи журнала изменений.</div>
        {series === null ? <div className="a-hint">Загрузка…</div> : chart ? (
          <ChartPane dates={chart.dates} series={chart.ser} events={events.map(e => ({ id: e.id, date: e.date, text: e.text }))} tip={tip} height={220} showX onHover={() => {}} hoverIdx={null} />
        ) : <div className="a-hint">Нет данных по дням.</div>}
      </div>
    </div>
  );
}

// ── Карточка товара ──────────────────────────────────────────────────────
// Сумма по набору запросов за день. «Искали» — сумма по запросам (один
// человек мог искать несколькими запросами), позиция — средняя,
// взвешенная по числу искавших.
function sumDay(list) {
  let s = 0, v = 0, c = 0, o = 0, r = 0, wp = 0, ws = 0;
  for (const x of list) {
    s += x.s; v += x.v; c += x.c; o += x.o; r += x.r;
    if (x.p !== null && x.p > 0) { wp += x.p * Math.max(1, x.s); ws += Math.max(1, x.s); }
  }
  return { s, v, c, o, r, p: ws ? wp / ws : null, reach: s > 0 ? v / s * 100 : null, toCard: v > 0 ? c / v * 100 : null, toOrder: v > 0 ? o / v * 100 : null, n: list.length };
}

const DAY_ROWS = [
  { block: 'Спрос и видимость', tone: 'traffic' },
  { key: 's', label: 'Искали', fmt: 'int', good: 'up', hint: 'Сколько покупателей искали по этим запросам (сумма по запросам: один человек мог искать несколькими)' },
  { key: 'v', label: 'Увидели товар', fmt: 'int', good: 'up', hint: 'Сколько из них увидели наш товар в выдаче' },
  { key: 'reach', label: 'Охват спроса', fmt: 'pct', good: 'up', ratio: ['v', 's'], hint: 'Увидели / искали: какую часть спроса мы забираем' },
  { key: 'p', label: 'Средняя позиция', fmt: 'pos', good: 'down', avgW: true, hint: 'Средняя позиция по запросам, взвешенная по числу искавших. Меньше — выше' },
  { block: 'Конверсии', tone: 'conv' },
  { key: 'toCard', label: 'В карточку', fmt: 'pct', good: 'up', ratio: ['c', 'v'], hint: 'Перешли в карточку / увидели товар' },
  { key: 'toOrder', label: 'В заказ', fmt: 'pct', good: 'up', ratio: ['o', 'v'], hint: 'Заказали / увидели товар — как «Конверсия из поиска в заказ» в отчёте Ozon' },
  { block: 'Заказы из поиска', tone: 'rev' },
  { key: 'o', label: 'Заказы, шт', fmt: 'int', good: 'up', hint: 'Заказано товаров по этим запросам' },
  { key: 'r', label: 'Заказы, ₽', fmt: 'money', good: 'up' },
  { key: 'shareO', label: 'Доля в заказах товара', fmt: 'pct', good: 'up', ratio: ['o', 'adO'], hint: 'Заказы по запросам / все заказы товара за день (из «Рекламы»)' },
  { block: 'Товар целиком — из «Рекламы»', tone: 'spend' },
  { key: 'adR', label: 'Все заказы, ₽', fmt: 'money', good: 'up', hint: 'Все заказы товара (поиск, рекомендации, реклама), без самовыкупов' },
  { key: 'adO', label: 'Все заказы, шт', fmt: 'int', good: 'up', sub: true },
  { key: 'spend', label: 'Расход на рекламу, ₽', fmt: 'money0', good: 'neutral' },
  { key: 'drr', label: 'ДРР', fmt: 'pct', good: 'down', ratio: ['spend', 'adR'], hint: 'Расход / все заказы товара, ₽ — как в «Рекламе»' },
];

function ArticleView({ cabinet, offer, art, options, onPick, onBack, dateFrom, dateTo, tip }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [ads, setAds] = useState(null);
  const [events, setEvents] = useState([]);
  const [groups, setGroups] = useState({});
  const [gsel, setGsel] = useState('target');
  const [openQ, setOpenQ] = useState({});
  const [showAll, setShowAll] = useState(false);
  const [qFilter, setQFilter] = useState('');

  useEffect(() => {
    setData(null); setErr(null); setAds(null); setOpenQ({}); setShowAll(false);
    const ok = latestOnly('sp-art:' + cabinet);
    getQueryArticle(cabinet, offer, { dateFrom, dateTo }).then(ok(r => { setData(r.data.data); setGroups(r.data.data.groups || {}); })).catch(ok(e => setErr(e.response?.data?.error || e.message)));
    getAdsEvents(cabinet, dateFrom, dateTo).then(r => setEvents((r.data.data || []).filter(e => e.offerId === offer))).catch(() => setEvents([]));
    const okAds = latestOnly('sp-ads:' + cabinet);
    getAdsStats(cabinet, { dateFrom, dateTo }).then(okAds(r => setAds((r.data.data?.articles || []).find(a => a.offerId === offer) || {}))).catch(okAds(() => setAds({})));
  }, [cabinet, offer, dateFrom, dateTo]);

  const dates = useMemo(() => {
    const out = [];
    for (let d = dayjs(dateFrom); !d.isAfter(dayjs(dateTo)); d = d.add(1, 'day')) out.push(d.format('YYYY-MM-DD'));
    return out;
  }, [dateFrom, dateTo]);

  const profile = useMemo(() => productProfile(data?.name || art?.n || ''), [data, art]);
  const groupOf = useCallback(q => groups[q] || autoGroup(q, profile), [groups, profile]);

  // Запросы: по каждому — значения по дням и итог за период.
  const queries = useMemo(() => {
    if (!data) return [];
    const m = new Map();
    for (const [d, q, p, s, v, c, o, r] of data.rows) {
      const x = m.get(q) || { q, days: {}, list: [] };
      const day = { p, s, v, c, o, r };
      x.days[d] = day; x.list.push(day);
      m.set(q, x);
    }
    return [...m.values()].map(x => ({ ...x, g: groupOf(x.q), manual: !!groups[x.q], tot: sumDay(x.list) })).sort((a, b) => b.tot.s - a.tot.s || b.tot.o - a.tot.o);
  }, [data, groupOf, groups]);

  const groupStats = useMemo(() => {
    const out = {};
    for (const g of [...QUERY_GROUPS.map(x => x.key), 'all']) out[g] = sumDay(queries.filter(x => g === 'all' || x.g === g).flatMap(x => x.list));
    return out;
  }, [queries]);

  const inGroup = useMemo(() => queries.filter(x => gsel === 'all' || x.g === gsel), [queries, gsel]);
  const byDate = useMemo(() => {
    const out = {};
    for (const d of dates) {
      const day = sumDay(inGroup.map(x => x.days[d]).filter(Boolean));
      const a = ads?.byDate?.[d];
      Object.assign(day, { adR: a ? a.revenue || 0 : null, adO: a ? a.orders || 0 : null, spend: a ? a.spend || 0 : null });
      day.drr = a && day.adR > 0 ? day.spend / day.adR * 100 : null;
      day.shareO = a && day.adO > 0 ? day.o / day.adO * 100 : null;
      out[d] = day;
    }
    return out;
  }, [dates, inGroup, ads]);

  const setGroup = async (q, g) => {
    const prev = groups;
    const next = { ...groups };
    if (g === null) delete next[q]; else next[q] = g;
    setGroups(next);
    try { const r = await saveQueryGroup(cabinet, q, g); setGroups(r.data.data || next); } catch (e) { setGroups(prev); }
  };

  const qf = qFilter.trim().toLowerCase();
  const shownQ = inGroup.filter(x => !qf || x.q.toLowerCase().includes(qf));
  const LIMIT = 40;

  return (
    <>
      <div className="a-card sp-head">
        <button type="button" className="a-btn" onClick={onBack}>← Все товары</button>
        <select className="a-input sp-pick" value={offer} onChange={e => onPick(e.target.value)}>
          {!options.some(a => a.o === offer) && <option value={offer}>{offer}</option>}
          {options.map(a => <option key={a.o} value={a.o}>{a.o} — {a.short}</option>)}
        </select>
        <div className="sp-name">{data?.name || art?.n || ''}</div>
      </div>

      {err ? <Empty>Не удалось загрузить: {err}</Empty> : !data ? <div className="a-hint" style={{ padding: 20 }}>Загрузка…</div> : !queries.length ? (
        <Empty>За выбранный период по этому товару нет данных о поисковых запросах.</Empty>
      ) : (
        <>
          <div className="sp-groups">
            {[...QUERY_GROUPS, { key: 'all', label: 'Все запросы', hint: 'Все запросы товара' }].map(g => {
              const st = groupStats[g.key];
              return (
                <button key={g.key} type="button" className={`sp-g ${gsel === g.key ? 'on' : ''} g-${g.key}`} onClick={() => setGsel(g.key)} title={g.hint}>
                  <span className="t">{g.label} <span className="muted">· {st.n ? queries.filter(x => g.key === 'all' || x.g === g.key).length : 0} запр.</span></span>
                  <span className="big">{fmtInt(st.s)}<small> искали</small></span>
                  <span className="row2">увидели {fmtInt(st.v)} · охват {fmtPct(st.reach)}</span>
                  <span className="row2">позиция {pos(st.p)} · в заказ {fmtPct(st.toOrder)}</span>
                  <span className="row2">заказы {fmtInt(st.o)} шт · {fmtInt(st.r)} ₽</span>
                </button>
              );
            })}
          </div>

          <div className="a-card">
            <div className="sp-tbar">
              <b>По дням — {gsel === 'all' ? 'все запросы' : GROUP_LABEL[gsel].toLowerCase()}</b>
              {ads === null && <span className="a-hint">данные «Рекламы» загружаются…</span>}
            </div>
            <SpDaysTable dates={dates} byDate={byDate} events={events} queries={shownQ.slice(0, showAll ? 1000 : LIMIT)} openQ={openQ}
              toggleQ={q => setOpenQ(v => ({ ...v, [q]: !v[q] }))} setGroup={setGroup} tip={tip}
              qControls={
                <span className="sp-qc">
                  <input className="a-input" placeholder="найти запрос" value={qFilter} onChange={e => setQFilter(e.target.value)} />
                  {shownQ.length > LIMIT && <button type="button" className="a-btn sm" onClick={() => setShowAll(v => !v)}>{showAll ? `только первые ${LIMIT}` : `показать все ${shownQ.length}`}</button>}
                </span>
              } />
          </div>
          <div className="a-hint">
            Группы определяются автоматически по названию товара: <b>целевые</b> — наш тип товара и наша модель; <b>модель без типа</b> — «хавал м6»; <b>тип без модели</b> — «чехлы на сиденья»;
            <b> прочие</b> — чужие модели и мусор. Группу любого запроса можно поменять в таблице — ручной выбор отмечен точкой и действует для всех товаров магазина.
            Сейчас Ozon отдаёт сервису только самые частотные запросы товара (до 15 в день), поэтому часть хвоста может не попасть.
          </div>
        </>
      )}
    </>
  );
}

function SpDaysTable({ dates, byDate, events, queries, openQ, toggleQ, setGroup, tip, qControls }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth; }, [dates.length]);
  const evBy = useMemo(() => {
    const m = {};
    for (const e of events) (m[e.date] ||= []).push(e.text);
    return m;
  }, [events]);
  const total = row => {
    if (row.ratio) {
      const [a, b] = row.ratio;
      let n = 0, d = 0, any = false;
      for (const dt of dates) { const x = byDate[dt]; if (x[a] == null || x[b] == null) continue; any = true; n += x[a]; d += x[b]; }
      return any && d > 0 ? n / d * 100 : null;
    }
    if (row.avgW) {
      let wp = 0, ws = 0;
      for (const dt of dates) { const x = byDate[dt]; if (x.p != null) { wp += x.p * Math.max(1, x.s); ws += Math.max(1, x.s); } }
      return ws ? wp / ws : null;
    }
    let s = 0, any = false;
    for (const dt of dates) { const v = byDate[dt][row.key]; if (v != null) { s += v; any = true; } }
    return any ? s : null;
  };
  const cells = (vals, good, fmt) => {
    const nums = vals.filter(v => v != null && Number.isFinite(v));
    const min = nums.length ? Math.min(...nums) : 0, max = nums.length ? Math.max(...nums) : 0;
    return vals.map((v, i) => <td key={dates[i]} style={{ background: good === 'neutral' ? undefined : heatColor(v, min, max, good) }}>{fmtBy(v, fmt)}</td>);
  };
  return (
    <div className="a-days" ref={ref}>
      <table className="a-dt sp-dt">
        <thead>
          <tr>
            <th className="lbl">Метрика</th>
            <th className="tot">Итого</th>
            {dates.map(d => <th key={d}>{d.slice(8)}.{d.slice(5, 7)}</th>)}
          </tr>
        </thead>
        <tbody>
          {DAY_ROWS.map((row, ri) => {
            if (row.block) return <tr key={'b' + ri} className={`blk tone-${row.tone}`}><td colSpan={dates.length + 2}><span className="blk-l">{row.block}</span></td></tr>;
            const vals = dates.map(d => byDate[d][row.key]);
            return (
              <tr key={row.key} className={row.sub ? 'sub' : ''}>
                <td className="lbl" title={row.hint} style={row.hint ? { textDecoration: 'underline dotted var(--a-line2)', textUnderlineOffset: 3 } : undefined}>{row.sub ? '— ' : ''}{row.label}</td>
                <td className="tot">{fmtBy(total(row), row.fmt)}</td>
                {cells(vals, row.good, row.fmt)}
              </tr>
            );
          })}
          <tr className="blk tone-rev"><td colSpan={dates.length + 2}><span className="blk-l">Журнал изменений</span></td></tr>
          <tr>
            <td className="lbl">Записи</td>
            <td className="tot">{fmtInt(events.length)}</td>
            {dates.map(d => {
              const ev = evBy[d];
              return <td key={d} className={ev ? 'sp-ev' : ''} onMouseEnter={ev ? e => tip.show(e, <div>{ev.map((t, i) => <div key={i}>• {t}</div>)}</div>) : undefined} onMouseLeave={ev ? tip.hide : undefined}>{ev ? `● ${ev.length}` : ''}</td>;
            })}
          </tr>
          <tr className="blk tone-traffic"><td colSpan={dates.length + 2}><span className="blk-l">Позиция по запросам</span>{qControls}</td></tr>
          {queries.map(x => {
            const vals = dates.map(d => x.days[d]?.p ?? null);
            const open = !!openQ[x.q];
            return (
              <React.Fragment key={x.q}>
                <tr className="sp-q">
                  <td className="lbl" title={`${x.q} — искали ${fmtInt(x.tot.s)}, увидели ${fmtInt(x.tot.v)}, заказов ${fmtInt(x.tot.o)}`}>
                    <button type="button" className="a-day-expand" aria-expanded={open} onClick={() => toggleQ(x.q)}><span aria-hidden="true">{open ? '▾' : '▸'}</span> {x.q}</button>
                    <select className={`sp-gsel g-${x.g}`} value={x.g} onChange={e => setGroup(x.q, e.target.value)} title={x.manual ? 'Группа выбрана вручную' : 'Группа определена автоматически — можно поменять'}>
                      {QUERY_GROUPS.map(g => <option key={g.key} value={g.key}>{g.label}</option>)}
                    </select>
                    {x.manual && <button type="button" className="sp-reset" title="Вернуть автоматическую группу" onClick={() => setGroup(x.q, null)}>•</button>}
                  </td>
                  <td className="tot">{fmtBy(x.tot.p, 'pos')}</td>
                  {vals.map((v, i) => <td key={dates[i]} style={{ background: posHeat(v) }}>{fmtBy(v, 'pos')}</td>)}
                </tr>
                {open && [['s', 'искали', 'int', 'up'], ['v', 'увидели', 'int', 'up'], ['o', 'заказы, шт', 'int', 'up'], ['r', 'заказы, ₽', 'money', 'up']].map(([k, l, f, g]) => (
                  <tr key={k} className="sub">
                    <td className="lbl">— {l}</td>
                    <td className="tot">{fmtBy(x.tot[k], f)}</td>
                    {cells(dates.map(d => x.days[d]?.[k] ?? null), g, f)}
                  </tr>
                ))}
              </React.Fragment>
            );
          })}
          {!queries.length && <tr><td className="lbl muted">Нет запросов</td><td className="tot" colSpan={dates.length + 1} /></tr>}
        </tbody>
      </table>
    </div>
  );
}
