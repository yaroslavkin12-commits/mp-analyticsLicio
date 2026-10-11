import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import dayjs from 'dayjs';
import { getSalesData, getFinanceCoefs, getFinancePnl, getPlan, savePlan } from '../api';
import { fmtInt, CAT_COLORS, useTip } from './AdsStats2';
import { unitCoefs, unitProfit } from './unitModel';
import { useCats, Kpi, pct1, useTax, SEP, OTHER } from './finShared';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// «План / факт» по месяцу: план задаётся на весь кабинет и на категории
// (два уровня), по метрикам: заказы ₽, заказы шт, выкупы ₽, прибыль
// (прогноз от заказов — как в «Юнит-экономике»).
//   Темп — факт к плану, пропорциональному прошедшим дням месяца.
//   Прогноз на конец месяца — факт + средний день последних 7 дней ×
//   оставшиеся дни. «Нужно в день» — чтобы выйти на план.
// ─────────────────────────────────────────────────────────────────────────

const METRICS = [['revenue', 'Заказы, ₽'], ['orders', 'Заказы, шт'], ['sales', 'Выкупы, ₽'], ['salesQty', 'Выкупы, шт'], ['payout', 'Ср. поступление на 1 выкуп, ₽'], ['profit', 'Прогнозируемая прибыль, ₽']];
const FIN = ['sales', 'salesQty', 'payout']; // метрики из финансового отчёта Ozon (по дню выкупа)
const RATIO = { payout: true }; // средние величины: не суммируются, план — целевое значение
const QTY = { orders: true, salesQty: true };
const OZ = ['commission', 'logistics', 'acquiring', 'storage', 'promo', 'other', 'ads'];
const ALL = 'Все';

export default function PlanFact({ cabinet }) {
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'));
  const [metric, setMetric] = useState('revenue');
  const [sales, setSales] = useState(null);
  const [pnl, setPnl] = useState(null);
  const [coefs, setCoefs] = useState(null);
  const [plan, setPlanState] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const [tax] = useTax(cabinet);
  const tip = useTip();
  const saveTimer = useRef(null);

  const mStart = dayjs(month + '-01'), mEnd = mStart.endOf('month');
  const today = dayjs();
  const isCur = month === today.format('YYYY-MM');
  const D = mEnd.date();

  const load = useCallback(() => {
    setLoading(true); setError(null);
    const to = (isCur ? today : mEnd).format('YYYY-MM-DD');
    Promise.all([
      getSalesData(cabinet, { dateFrom: mStart.format('YYYY-MM-DD'), dateTo: to }),
      getPlan(cabinet, month),
    ]).then(([s, p]) => { setSales(s.data.data); setPlanState(p.data.data || {}); })
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, [cabinet, month]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (metric === 'profit' && !coefs) getFinanceCoefs(cabinet).then(r => setCoefs(r.data.data)).catch(() => {}); }, [metric, cabinet, coefs]);
  useEffect(() => {
    if (!FIN.includes(metric)) return;
    const to = (isCur ? today : mEnd).format('YYYY-MM-DD');
    getFinancePnl(cabinet, { dateFrom: mStart.format('YYYY-MM-DD'), dateTo: to }).then(r => setPnl(r.data.data)).catch(() => {});
  }, [metric, cabinet, month]); // eslint-disable-line react-hooks/exhaustive-deps

  const cats = useCats(sales?.articles, sales?.order);
  const K = useMemo(() => (coefs ? unitCoefs(coefs, cats.arts) : null), [coefs, cats.arts]);

  // Факт по дням месяца для каждого артикула и выбранной метрики.
  const dayIdx = useMemo(() => { const m = new Map(); (sales?.dates || []).forEach(d => m.set(d, dayjs(d).date() - 1)); return m; }, [sales]);
  const perArt = useMemo(() => {
    if (!sales) return [];
    const P = cats.arts.map(() => new Float64Array(D));
    if (FIN.includes(metric)) {
      if (!pnl) return P;
      const byOffer = new Map(cats.arts.map(a => [a.o, a.i]));
      // payout: P — поступления (выкупы + удержания Ozon), Q — выкупленные штуки.
      const Q = metric === 'payout' ? cats.arts.map(() => new Float64Array(D)) : null;
      const S = metric === 'payout' ? cats.arts.map(() => new Float64Array(D)) : null;
      const saleDay = new Float64Array(D), noSkuDay = new Float64Array(D);
      for (const [pai, pd, b, a, q] of pnl.rows) {
        const k = pnl.buckets[b];
        const ai = byOffer.get(pnl.articles[pai]?.o), d = dayjs(pnl.dates[pd]).date() - 1;
        if (ai === undefined || d < 0 || d >= D) continue;
        const sign = k === 'return' ? -1 : 1;
        if (k === 'sale' || k === 'return') {
          if (metric === 'sales') P[ai][d] += a;
          else if (metric === 'salesQty') P[ai][d] += sign * Math.abs(q || 0);
          else { P[ai][d] += a; S[ai][d] += a; Q[ai][d] += sign * Math.abs(q || 0); saleDay[d] += a; }
        } else if (metric === 'payout' && OZ.includes(k)) P[ai][d] += a;
      }
      if (metric === 'payout') {
        // Удержания без артикула — пропорционально выкупам дня.
        for (const [pd, b, a] of pnl.noSku || []) { const d = dayjs(pnl.dates[pd]).date() - 1; if (d >= 0 && d < D && OZ.includes(pnl.buckets[b])) noSkuDay[d] += a; }
        for (let i = 0; i < cats.arts.length; i++) for (let d = 0; d < D; d++) {
          if (saleDay[d] > 0 && S[i][d] > 0) P[i][d] += noSkuDay[d] * S[i][d] / saleDay[d];
        }
        P.den = Q;
      }
      return P;
    }
    for (const r of sales.rows) {
      const d = dayIdx.get(sales.dates[r[1]]); if (d === undefined) continue;
      if (metric === 'revenue') P[r[0]][d] += r[6];
      else if (metric === 'orders') P[r[0]][d] += r[5];
      else if (metric === 'profit' && K) P[r[0]][d] += unitProfit(K[r[0]], { ordRub: r[6], ordQty: r[5], ads: (r[7] || 0) + (r[8] || 0) }, tax).profit;
    }
    return P;
  }, [sales, pnl, cats.arts, metric, K, tax, D, dayIdx]);

  // Узлы: Все → категории → подкатегории.
  const nodes = useMemo(() => {
    const out = [{ key: ALL, name: 'Весь кабинет', depth: 0, arts: cats.arts }];
    for (const t of cats.topCats) {
      out.push({ key: t, name: t, depth: 1, top: t, arts: cats.arts.filter(a => a.parts[0] === t) });
      for (const k of cats.childrenOf(t)) out.push({ key: t + SEP + k, name: k, depth: 2, top: t, parent: t, arts: cats.arts.filter(a => a.parts[0] === t && a.parts[1] === k) });
    }
    return out;
  }, [cats]);

  const elapsed = isCur ? Math.max(0.5, today.date() - 1 + today.hour() / 24) : (month < today.format('YYYY-MM') ? D : 0);
  const lastFull = isCur ? today.date() - 1 : D; // полных дней прошло
  const calc = useCallback(node => {
    const day = new Float64Array(D);
    for (const a of node.arts) { const s = perArt[a.i]; if (s) for (let i = 0; i < D; i++) day[i] += s[i]; }
    if (RATIO[metric]) {
      // Средняя величина: факт — среднее за прошедшие дни, прогноз = факт.
      const den = new Float64Array(D);
      for (const a of node.arts) { const q = perArt.den?.[a.i]; if (q) for (let i = 0; i < D; i++) den[i] += q[i]; }
      const sn = day.reduce((s, v) => s + v, 0), sd = den.reduce((s, v) => s + v, 0);
      const fact = sd > 0 ? sn / sd : null;
      const p = plan[node.key]?.[metric];
      const planned = p !== undefined ? p : null;
      const r = planned && fact !== null ? fact / planned * 100 : null;
      return { ratio: true, day, den, fact, forecast: fact, rate: fact, planned, pace: r, done: r, fc: r, need: null };
    }
    const fact = day.reduce((s, v) => s + v, 0);
    const w = Math.min(7, lastFull);
    const rate = w > 0 ? day.slice(lastFull - w, lastFull).reduce((s, v) => s + v, 0) / w : (elapsed > 0 ? fact / elapsed : 0);
    const factFull = day.slice(0, lastFull).reduce((s2, v) => s2 + v, 0);
    const forecast = isCur ? factFull + rate * Math.max(0, D - lastFull) : fact;
    const p = plan[node.key]?.[metric];
    const planned = p !== undefined ? p : null;
    const pace = planned ? fact / (planned * elapsed / D) * 100 : null;
    const need = planned && isCur && D - elapsed > 0 ? Math.max(0, (planned - fact) / (D - elapsed)) : null;
    return { day, fact, forecast, rate, planned, pace, done: planned ? fact / planned * 100 : null, fc: planned ? forecast / planned * 100 : null, need };
  }, [perArt, plan, metric, D, elapsed, lastFull, isCur, today]);

  const rows = useMemo(() => nodes.map(n => ({ ...n, ...calc(n) })), [nodes, calc]);
  const total = rows[0];

  const setPlan = (k, v) => {
    const next = { ...plan, [k]: { ...(plan[k] || {}), [metric]: v === '' ? undefined : Number(String(v).replace(/\s/g, '').replace(',', '.')) } };
    if (v === '') delete next[k][metric];
    setPlanState(next); setSaved('сохраняю…');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => savePlan(cabinet, month, next).then(() => setSaved('сохранено')).catch(e => setSaved(`ошибка: ${e.message}`)), 700);
  };
  const copyPrev = () => {
    getPlan(cabinet, mStart.subtract(1, 'month').format('YYYY-MM')).then(r => {
      const p = r.data.data || {};
      if (!Object.keys(p).length) { setSaved('в прошлом месяце плана нет'); return; }
      setPlanState(p); savePlan(cabinet, month, p).then(() => setSaved('скопировано из прошлого месяца'));
    });
  };
  // Раскидать план «Весь кабинет» по категориям пропорционально факту месяца.
  const spread = () => {
    const tp = plan[ALL]?.[metric]; if (!tp || !total.fact) return;
    const next = { ...plan };
    // Средняя величина (поступление на 1 выкуп) — та же цель для всех категорий.
    for (const r of rows) if (r.depth > 0) next[r.key] = { ...(next[r.key] || {}), [metric]: RATIO[metric] ? tp : Math.round(tp * r.fact / total.fact) };
    setPlanState(next); savePlan(cabinet, month, next).then(() => setSaved('распределено по доле факта'));
  };

  if (loading && !sales) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Загрузка…</div></div>;
  if (error && !sales) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Не удалось загрузить: {error} <button className="a-btn" onClick={load}>Повторить</button></div></div>;

  const fmtM = v => (v === null || v === undefined || !Number.isFinite(v) ? '—' : QTY[metric] ? fmtInt(v) : `${fmtInt(v)} ₽`);
  const pill = v => (v === null ? <span className="muted">—</span> : <span className={`pill ${v >= 100 ? 'g' : v >= 90 ? 'w' : 'b'}`}>{pct1(v)}</span>);
  const months = []; for (let i = -3; i <= 2; i++) months.push(today.add(i, 'month').format('YYYY-MM'));
  const shownRows = rows.filter(r => r.depth < 2 || open.has(r.parent));
  const loadingMetric = (FIN.includes(metric) && !pnl) || (metric === 'profit' && !coefs);

  return (
    <div className="mpui sa-page">
      <div className="page-sticky"><div className="a-top">
        <h1>План / факт</h1>
        <span className="a-seg">{months.map(m => <button key={m} type="button" className={month === m ? 'on' : ''} onClick={() => setMonth(m)}>{dayjs(m + '-01').format('MMM YY')}</button>)}</span>
        <span className="a-seg">{METRICS.map(([k, l]) => <button key={k} type="button" className={metric === k ? 'on' : ''} onClick={() => setMetric(k)}>{l}</button>)}</span>
        {loading || loadingMetric ? <span className="a-hint">обновляем…</span> : saved && <span className="a-hint">{saved}</span>}
      </div></div>

      <div className="a-kpis s-kpis">
        <Kpi label={total.ratio ? 'План (среднее за месяц)' : 'План на месяц'} value={fmtM(total.planned)} sub={total.ratio ? 'целевое значение' : total.planned ? `${D} дн · ${fmtM(total.planned / D)} в день` : 'задайте план в таблице ниже'} />
        <Kpi label={`Факт за ${Math.floor(elapsed)} из ${D} дн`} value={fmtM(total.fact)} sub={<span>выполнено {pill(total.done)}</span>} />
        <Kpi label="Темп" value={total.pace === null ? '—' : pct1(total.pace)} sub={total.ratio ? 'факт к цели' : 'факт к плану на сегодняшний день месяца'} />
        <Kpi label="Прогноз на конец месяца" value={fmtM(total.forecast)} sub={<span>{total.planned ? <>{pill(total.fc)} плана · </> : null}{total.ratio ? 'среднее за прошедшие дни' : total.need !== null ? `нужно ${fmtM(total.need)} в день` : `средний день ${fmtM(total.rate)}`}</span>} />
      </div>

      <div className="a-card s-card">
        <div className="a-bar" style={{ marginBottom: 6 }}><b style={{ fontSize: 14 }}>{total.ratio ? 'Среднее с начала месяца' : 'Нарастающим итогом'}</b><span className="a-hint">{total.ratio ? 'среднее поступление на 1 выкуп с начала месяца и цель' : 'факт, план (ровно по дням) и прогноз по темпу последних 7 дней'}</span></div>
        <Cumulative row={total} D={D} elapsed={elapsed} isCur={isCur} fmtM={fmtM} tip={tip} month={mStart} />
      </div>

      <div className="a-card">
        <div className="a-bar" style={{ padding: '12px 14px 4px' }}>
          <b style={{ fontSize: 14 }}>План по категориям</b>
          <span className="a-hint">введите план в колонке «План» — сохраняется сам</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button type="button" className="a-btn ghost" onClick={copyPrev}>Скопировать прошлый месяц</button>
            <button type="button" className="a-btn ghost" onClick={spread} disabled={!plan[ALL]?.[metric]} title="План «Весь кабинет» раскидать по категориям пропорционально их доле в факте месяца">Распределить по категориям</button>
          </span>
        </div>
        <div className="a-scroll">
          <table className="a-t s-tree">
            <thead><tr><th>Категория</th><th className="r">План</th><th className="r">Факт</th><th className="r">Выполнено</th><th className="r">Темп</th><th className="r">Прогноз</th><th className="r">Прогноз к плану</th><th className="r">Нужно в день</th></tr></thead>
            <tbody>
              {shownRows.map(r => (
                <tr key={r.key} className={`row ${r.depth === 0 ? 's-total' : r.depth === 1 ? 's-cat d0' : ''} ${open.has(r.key) ? 'open' : ''}`}>
                  <td>
                    <div className="a-art" style={{ paddingLeft: r.depth === 2 ? 26 : 0, cursor: r.depth === 1 ? 'pointer' : 'default' }}
                      onClick={() => r.depth === 1 && setOpen(p => { const n = new Set(p); n.has(r.key) ? n.delete(r.key) : n.add(r.key); return n; })}>
                      {r.depth === 1 && <span className="a-chev">▶</span>}
                      {r.depth > 0 && <i className="s-dot" style={{ background: CAT_COLORS[cats.topSlot(r.top)] || OTHER }} />}
                      <span className={r.depth < 2 ? 's-cname' : ''}>{r.name}</span>
                    </div>
                  </td>
                  <td className="r"><input className="pf-in" inputMode="decimal" value={r.planned ?? ''} placeholder="—" onChange={e => setPlan(r.key, e.target.value)} /></td>
                  <td className="n r">{fmtM(r.fact)}</td>
                  <td className="r">{pill(r.done)}</td>
                  <td className="r">{pill(r.pace)}</td>
                  <td className="n r">{fmtM(r.forecast)}</td>
                  <td className="r">{pill(r.fc)}</td>
                  <td className="n r">{r.need !== null ? fmtM(r.need) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {tip.node}
    </div>
  );
}

function Cumulative({ row, D, elapsed, isCur, fmtM, tip, month }) {
  const w = 900, h = 230, pl = 64, pr = 14, pt = 12, pb = 24;
  const cum = []; let s = 0, sd = 0; const last = isCur ? Math.ceil(elapsed) : D;
  // Для средних величин — среднее с начала месяца, план — ровная линия.
  for (let i = 0; i < D; i++) { s += row.day[i]; if (row.ratio) sd += row.den[i]; cum.push(i < last ? (row.ratio ? (sd > 0 ? s / sd : null) : s) : null); }
  const fcEnd = row.ratio ? null : row.forecast;
  const max = Math.max(1, row.planned || 0, fcEnd || 0, ...cum.filter(v => v !== null));
  const x = i => pl + (i + 1) / D * (w - pl - pr), y = v => pt + (1 - v / max) * (h - pt - pb);
  const factPath = cum.map((v, i) => (v === null ? '' : `${i === 0 || cum[i - 1] === null ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join('');
  const lastI = cum.reduce((m, v, i) => (v !== null ? i : m), -1);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => t * max);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 'auto', display: 'block' }} onMouseLeave={tip.hide}>
      {ticks.map(v => <g key={v}><line x1={pl} x2={w - pr} y1={y(v)} y2={y(v)} stroke="var(--a-grid)" /><text x={pl - 6} y={y(v) + 3.5} textAnchor="end" fontSize="10" fill="var(--a-ink3)">{fmtInt(v)}</text></g>)}
      {row.planned ? <line x1={pl} y1={y(row.ratio ? row.planned : 0)} x2={x(D - 1)} y2={y(row.planned)} stroke="var(--a-ink3)" strokeDasharray="5 4" strokeWidth="1.5" /> : null}
      {row.planned ? <text x={x(D - 1)} y={y(row.planned) - 6} textAnchor="end" fontSize="11" fill="var(--a-ink2)">план {fmtM(row.planned)}</text> : null}
      {isCur && !row.ratio && lastI >= 0 && <line x1={x(lastI)} y1={y(cum[lastI])} x2={x(D - 1)} y2={y(fcEnd)} stroke="var(--a-spend)" strokeDasharray="3 3" strokeWidth="2" />}
      {isCur && !row.ratio && lastI >= 0 && <text x={x(D - 1)} y={y(fcEnd) + 14} textAnchor="end" fontSize="11" fill="var(--a-spend)">прогноз {fmtM(fcEnd)}</text>}
      <path d={factPath} fill="none" stroke="var(--a-rev)" strokeWidth="2.5" />
      {cum.map((v, i) => v === null ? null : (
        <rect key={i} x={x(i) - (w - pl - pr) / D / 2} y={pt} width={(w - pl - pr) / D} height={h - pt - pb} fill="transparent"
          onMouseMove={e => tip.show(e, <div><b>{month.date(i + 1).format('DD.MM')}</b>{row.ratio ? <div>среднее с начала месяца: {fmtM(v)}</div> : <><div>за день: {fmtM(row.day[i])}</div><div>с начала месяца: {fmtM(v)}</div></>}{row.planned ? <div className="muted">{row.ratio ? `цель: ${fmtM(row.planned)}` : `план к этому дню: ${fmtM(row.planned * (i + 1) / D)}`}</div> : null}</div>)} />
      ))}
      {[1, 8, 15, 22, D].map(d => <text key={d} x={x(d - 1)} y={h - 6} textAnchor="middle" fontSize="10" fill="var(--a-ink3)">{String(d).padStart(2, '0')}.{month.format('MM')}</text>)}
    </svg>
  );
}
