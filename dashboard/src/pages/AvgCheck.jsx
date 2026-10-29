import React, { useState, useEffect, useMemo, useCallback } from 'react';
import dayjs from 'dayjs';
import { getSalesData, getFinancePnl, latestOnly } from '../api';
import { fmtInt, useTip, ChartPane, niceScale, CAT_COLORS, Delta } from './AdsStats2';
import { bucketsOf } from './SalesAnalytics';
import { useCats, useGroups, FinHeader, RowsTable, CatTable, Kpi, inPath, matchQ, pct1, SEP, OTHER } from './finShared';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// «Средний чек» — три базы:
//   от заказов    — сумма заказов / штуки (аналитика Ozon, по дню заказа);
//   от выкупов    — выручка по выкупам (цена продавца, с баллами Ozon) /
//                   выкупленные штуки (финансы, по дню начисления);
//   поступления   — сколько реально приходит на счёт за 1 выкуп: выручка
//                   минус все удержания Ozon (комиссия, логистика,
//                   эквайринг, хранение, прочее; общие удержания без
//                   артикула — пропорционально выкупам).
// ─────────────────────────────────────────────────────────────────────────

const BASES = [['orders', 'от заказов'], ['sales', 'от выкупов'], ['payout', 'поступления на счёт']];
const OZON = ['commission', 'logistics', 'acquiring', 'storage', 'promo', 'other', 'ads'];
const ROWS = [
  { block: 'Заказы', tone: 'rev' },
  { key: 'oRub', label: 'Заказано, ₽', fmt: 'int', good: 'up' },
  { key: 'oQty', label: 'Заказано, шт', fmt: 'int', good: 'up', sub: true },
  { key: 'orders', label: 'Средний чек заказа, ₽', fmt: 'int', good: 'up', strong: true },
  { block: 'Выкупы', tone: 'conv' },
  { key: 'sRub', label: 'Выручка по выкупам, ₽', fmt: 'int', good: 'up' },
  { key: 'sQty', label: 'Выкуплено, шт', fmt: 'int', good: 'up', sub: true },
  { key: 'sales', label: 'Средний чек выкупа, ₽', fmt: 'int', good: 'up', strong: true },
  { block: 'Поступления на счёт', tone: 'spend' },
  { key: 'pRub', label: 'К перечислению, ₽', fmt: 'int', good: 'up' },
  { key: 'payout', label: 'Поступление на 1 выкуп, ₽', fmt: 'int', good: 'up', strong: true },
  { key: 'share', label: 'Поступления от выручки, %', fmt: 'pct', good: 'up' },
];

export default function AvgCheck({ cabinet }) {
  const today = dayjs().format('YYYY-MM-DD');
  const [dateFrom, setDateFrom] = useState(dayjs().subtract(29, 'day').format('YYYY-MM-DD'));
  const [dateTo, setDateTo] = useState(today);
  const [sales, setSales] = useState(null);
  const [pnl, setPnl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState('');
  const [search, setSearch] = useState('');
  const [base, setBase] = useState('orders');
  const [gran, setGran] = useState('day');
  const [split, setSplit] = useState(true);
  // На графике: одна база по подкатегориям или сразу несколько линий (чек заказа, выкупа, поступление).
  const [multi, setMulti] = useState(false);
  const tip = useTip();
  const grp = useGroups(cabinet);

  const load = useCallback(() => {
    setLoading(true); setError(null);
    const ok = latestOnly('check:' + cabinet);
    Promise.all([getSalesData(cabinet, { dateFrom, dateTo }), getFinancePnl(cabinet, { dateFrom, dateTo })])
      .then(ok(([s, p]) => { setSales(s.data.data); setPnl(p.data.data); }))
      .catch(ok(e => setError(e.response?.data?.error || e.message)))
      .finally(ok(() => setLoading(false)));
  }, [cabinet, dateFrom, dateTo]);
  useEffect(() => { load(); }, [load]);

  const cats = useCats(sales?.articles, sales?.order);
  const dates = sales?.dates || [];
  const n = dates.length;

  // По артикулу и дню: заказы ₽/шт, выкупы ₽/шт, удержания Ozon.
  const per = useMemo(() => {
    if (!sales || !pnl) return [];
    const P = cats.arts.map(() => null);
    const get = ai => P[ai] || (P[ai] = { oRub: new Float64Array(n), oQty: new Float64Array(n), sRub: new Float64Array(n), sQty: new Float64Array(n), oz: new Float64Array(n).fill(pnl._operational ? NaN : 0) });
    for (const r of sales.rows) { if (!sales._wb && !r[5] && !r[6]) continue; const x = get(r[0]); x.oQty[r[1]] += r[5]; x.oRub[r[1]] += r[6]; }
    const byOffer = new Map(cats.arts.map(a => [a.o, a.i]));
    const di = new Map(dates.map((d, i) => [d, i]));
    const pdi = pnl.dates.map(d => di.get(d));
    for (const [pai, pd, b, a, q] of pnl.rows) {
      const ai = byOffer.get(pnl.articles[pai]?.o); const d = pdi[pd];
      if (ai === undefined || d === undefined) continue;
      const k = pnl.buckets[b], x = get(ai);
      if (k === 'sale') { x.sRub[d] += a; x.sQty[d] += Math.abs(q); }
      else if (k === 'return') { x.sRub[d] += a; x.sQty[d] -= Math.abs(q); }
      else if (OZON.includes(k)) x.oz[d] += a;
    }
    // Реклама за дни, которые Ozon ещё не провёл в начислениях, — из кабинета.
    const iAds = pnl.buckets.indexOf('ads');
    let lastFin = -1;
    for (const r of pnl.rows) if (r[2] === iAds && r[3]) lastFin = Math.max(lastFin, r[1]);
    for (const [pd, b, a] of pnl.noSku) if (b === iAds && a) lastFin = Math.max(lastFin, pd);
    for (const [pai, pd, v] of pnl.ads || []) {
      const ai = byOffer.get(pnl.articles[pai]?.o); if (ai === undefined || pdi[pd] === undefined) continue;
      const x = get(ai); x.ad = (x.ad || 0) + v;
      if (pd > lastFin) x.oz[pdi[pd]] -= v;
    }
    if(pnl._operational) for(let ai=0;ai<cats.arts.length;ai++){const x=get(ai);for(let d=0;d<n;d++) if(!pnl.available?.mn||dates[d]<pnl.available.mn||dates[d]>pnl.available.mx){x.sRub[d]=NaN;x.sQty[d]=NaN;}}
    return P;
  }, [sales, pnl, cats.arts, n, dates]);

  // Удержания без артикула по дням — делим пропорционально выкупам.
  const noSkuDay = useMemo(() => {
    const v = new Float64Array(n);
    if (!pnl) return v;
    const di = new Map(dates.map((d, i) => [d, i]));
    for (const [pd, b, a] of pnl.noSku) { const d = di.get(pnl.dates[pd]); if (d !== undefined && OZON.includes(pnl.buckets[b]) && pnl.buckets[b] !== 'ads') v[d] += a; }
    return v;
  }, [pnl, dates, n]);
  // Реклама без артикула — по дням, а делится по доле в расходе рекламного кабинета за период.
  const noSkuAdsDay = useMemo(() => {
    const v = new Float64Array(n);
    if (!pnl) return v;
    const di = new Map(dates.map((d, i) => [d, i]));
    for (const [pd, b, a] of pnl.noSku) { const d = di.get(pnl.dates[pd]); if (d !== undefined && pnl.buckets[b] === 'ads') v[d] += a; }
    return v;
  }, [pnl, dates, n]);
  const adsAll = useMemo(() => { let s = 0; for (const x of per) if (x) s += x.ad || 0; return s; }, [per]);
  const saleDayAll = useMemo(() => { const v = new Float64Array(n); for (const x of per) if (x) for (let i = 0; i < n; i++) v[i] += x.sRub[i]; return v; }, [per, n]);

  const sumOf = useCallback(items => {
    const S = { oRub: new Float64Array(n), oQty: new Float64Array(n), sRub: new Float64Array(n), sQty: new Float64Array(n), oz: new Float64Array(n) };
    for (const a of items) { const x = per[a.i]; if (!x) continue; for (const k of Object.keys(S)) { const s = x[k], t = S[k]; for (let i = 0; i < n; i++) t[i] += s[i]; } }
    // Без артикула — по дням пропорционально выручке дня; в день без выручки — по доле за период.
    let selT = 0, allT = 0; for (let i = 0; i < n; i++) { selT += S.sRub[i]; allT += saleDayAll[i]; }
    const shareAll = allT > 0 ? selT / allT : 0;
    let selAd = 0; for (const a of items) selAd += per[a.i]?.ad || 0;
    const adSh = adsAll > 0 ? selAd / adsAll : shareAll;
    for (let i = 0; i < n; i++) S.oz[i] += noSkuDay[i] * (saleDayAll[i] > 0 ? S.sRub[i] / saleDayAll[i] : shareAll) + noSkuAdsDay[i] * adSh;
    return S;
  }, [per, n, saleDayAll, noSkuDay, noSkuAdsDay, adsAll]);
  const metricsOf = (S, idx) => {
    let oRub = 0, oQty = 0, sRub = 0, sQty = 0, oz = 0;
    for (const i of idx) { oRub += S.oRub[i]; oQty += S.oQty[i]; sRub += S.sRub[i]; sQty += S.sQty[i]; oz += S.oz[i]; }
    if(pnl?._operational && idx.some(i=>!pnl.available?.mn||dates[i]<pnl.available.mn||dates[i]>pnl.available.mx)){sRub=NaN;sQty=NaN;}
    if(sales?._wb && !sales.availability?.orders && !per.some(Boolean)){oRub=NaN;oQty=NaN;}
    const pRub = sRub + oz;
    return { oRub, oQty, sRub, sQty, pRub, orders: oQty > 0 ? oRub / oQty : null, sales: sQty > 0 ? sRub / sQty : null, payout: sQty > 0 ? pRub / sQty : null, share: sRub > 0 ? pRub / sRub * 100 : null };
  };

  const q = search.trim().toLowerCase();
  const list = useMemo(() => ({ q, arts: cats.arts.filter(a => per[a.i] && inPath(a, sel) && matchQ(a, q) && grp.test(a)) }), [cats.arts, per, sel, q, grp.test]);
  const S = useMemo(() => sumOf(list.arts), [sumOf, list]);
  const all = dates.map((_, i) => i);
  // Последние 7 полных дней против 7 до них.
  const last7 = all.filter(i => dates[i] < today).slice(-7), prev7 = all.filter(i => dates[i] < today).slice(-14, -7);
  const T = metricsOf(S, all), L = metricsOf(S, last7), P7 = metricsOf(S, prev7);
  const ch = k => (L[k] && P7[k] ? (L[k] - P7[k]) / P7[k] * 100 : null);

  const aggOf = useCallback(items => {
    const s = sumOf(items), t = metricsOf(s, all), l = metricsOf(s, last7), p = metricsOf(s, prev7);
    return { ...t, dOrders: l.orders && p.orders ? (l.orders - p.orders) / p.orders * 100 : null, dSales: l.sales && p.sales ? (l.sales - p.sales) / p.sales * 100 : null, dPayout: l.payout && p.payout ? (l.payout - p.payout) / p.payout * 100 : null };
  }, [sumOf, all.length, last7.join(), prev7.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !sales) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Загрузка…</div></div>;
  if (error && !sales) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Не удалось загрузить: {error} <button className="a-btn" onClick={load}>Повторить</button></div></div>;

  // График: средний чек выбранной базы по дням/неделям — итог и подкатегории.
  const buckets = bucketsOf(dates, gran);
  const bdates = buckets.map(b => b.key);
  const depth = sel ? sel.split(SEP).length : 0;
  const kids = q ? [] : cats.childrenOf(sel);
  const series = [];
  const mk = (key, label, items, color, s0) => {
    const s = s0 || sumOf(items);
    series.push({ key, label, fmt: 'int', kind: 'line', side: 'left', color, values: buckets.map(b => metricsOf(s, b.idx)[base]) });
  };
  const LINE_COLORS = { orders: 'var(--a-rev)', sales: 'var(--s-c3)', payout: 'var(--a-spend)' };
  if (multi) {
    for (const [k, l] of [['orders', 'Чек заказа'], ['sales', 'Чек выкупа'], ['payout', 'Поступление на 1 выкуп']]) {
      series.push({ key: k, label: l, fmt: 'int', kind: 'line', side: 'left', color: LINE_COLORS[k], values: buckets.map(b => metricsOf(S, b.idx)[k]) });
    }
  } else mk('total', sel ? `${sel.split(SEP).slice(-1)[0]} — всего` : 'Все товары', null, 'var(--a-ink)', S);
  if (split && !multi) kids.slice(0, 6).forEach((k, i) => mk(k, k, list.arts.filter(a => a.parts[depth] === k), depth === 0 ? (CAT_COLORS[cats.topSlot(k)] || OTHER) : (CAT_COLORS[i] || OTHER)));
  const allV = series.flatMap(s => s.values).filter(v => v !== null && Number.isFinite(v));
  const sc = niceScale(allV.length ? Math.min(...allV) : 0, allV.length ? Math.max(...allV) : 1, true);
  series.forEach(s => { s.scale = sc; });

  const vals = {}, totals = {};
  for (const r of ROWS) if (r.key) { vals[r.key] = all.map(i => metricsOf(S, [i])[r.key]); totals[r.key] = T[r.key]; }

  const cols = [
    { key: 'oQty', label: 'Заказано, шт', fmt: 'int' },
    { key: 'orders', label: 'Чек заказа', fmt: 'int', delta: g => g.dOrders },
    { key: 'sQty', label: 'Выкуплено, шт', fmt: 'int' },
    { key: 'sales', label: 'Чек выкупа', fmt: 'int', delta: g => g.dSales },
    { key: 'payout', label: 'Поступление на 1 шт', fmt: 'int', delta: g => g.dPayout },
    { key: 'share', label: 'Поступления, % выручки', fmt: 'pct' },
  ];
  const baseLabel = BASES.find(b => b[0] === base)[1];

  return (
    <div className="mpui sa-page">
      <FinHeader title="Средний чек" cats={cats} sel={sel} setSel={setSel} search={search} setSearch={setSearch} grp={grp}
        dateFrom={dateFrom} dateTo={dateTo} setRange={(f, t) => { setDateFrom(f); setDateTo(t); }} periods={[14, 30, 60]} loading={loading}>
        <span className="a-seg">{BASES.map(([k, l]) => <button key={k} type="button" className={base === k ? 'on' : ''} onClick={() => setBase(k)}>{l}</button>)}</span>
      </FinHeader>

      <div className={`a-kpis s-kpis ${loading ? 'a-loading' : ''}`}>
        <Kpi label="Средний чек заказа" value={T.orders ? `${fmtInt(T.orders)} ₽` : '—'} sub={<span><Delta value={ch('orders')} /> последние 7 дн к 7 до них</span>} />
        <Kpi label="Средний чек выкупа" value={T.sales ? `${fmtInt(T.sales)} ₽` : '—'} sub={<span><Delta value={ch('sales')} /> · {pnl?._operational ? 'цена продавца WB' : 'цена реализации с баллами Ozon'}</span>} />
        <Kpi label="Поступление на счёт за 1 выкуп" value={T.payout ? `${fmtInt(T.payout)} ₽` : '—'} sub={<span><Delta value={ch('payout')} /> · {pnl?._operational ? 'финансы пока не подключены' : 'за вычетом удержаний Ozon'}</span>} />
        <Kpi label="Доходит до счёта" value={pct1(T.share)} sub={`${fmtInt(T.pRub)} ₽ из ${fmtInt(T.sRub)} ₽ выручки`} />
      </div>

      <div className={`a-card s-card ${loading ? 'a-loading' : ''}`}>
        <div className="a-bar" style={{ marginBottom: 8 }}>
          <b style={{ fontSize: 14 }}>{multi ? 'Чек заказа, чек выкупа и поступление на счёт' : `Средний чек ${baseLabel}`}</b>
          <label className="sw" title="Три линии на одном графике: чек заказа, чек выкупа и среднее поступление на счёт"><input type="checkbox" checked={multi} onChange={e => setMulti(e.target.checked)} /><i />все три линии</label>
          {kids.length > 0 && !multi && <label className="sw"><input type="checkbox" checked={split} onChange={e => setSplit(e.target.checked)} /><i />по подкатегориям</label>}
          <span className="a-seg" style={{ marginLeft: 'auto' }}>{[['day', 'Дни'], ['week', 'Недели'], ['month', 'Месяцы']].map(([v, l]) => <button key={v} type="button" className={gran === v ? 'on' : ''} onClick={() => setGran(v)}>{l}</button>)}</span>
        </div>
        <ChartPane dates={bdates} series={series} events={[]} tip={tip} height={240} showX onHover={() => {}} hoverIdx={null} />
        <div className="s-legend">{series.map(s => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}</div>
        <div className="a-hint" style={{ marginTop: 4 }}>{base === 'orders' ? 'По дню заказа.' : 'По дню начисления Ozon (выкуп засчитывается, когда Ozon начислил выручку).'}</div>
      </div>

      <CatTable cats={cats} sel={sel} setSel={setSel} list={list} cols={cols} aggOf={aggOf} sortKey="oQty" hint="Δ — последние 7 дней к 7 дням до них" />

      <div className="a-card">
        <div className="a-bar" style={{ padding: '12px 14px 8px' }}><b style={{ fontSize: 14 }}>По дням</b></div>
        <RowsTable dates={dates} rows={ROWS} vals={vals} totals={totals} firstCol="Показатель" />
      </div>
      {tip.node}
    </div>
  );
}
