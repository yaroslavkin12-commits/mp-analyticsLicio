import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import dayjs from 'dayjs';
import { getSalesData, getFinancePnl, getPlan, savePlan } from '../api';
import { fmtInt } from './AdsStats2';
import { useCats, useGroups, pct1, SEP } from './finShared';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// «План / факт» на месяц. План задаётся на весь кабинет, категории,
// подкатегории и свои группы (группы «Рекламы»): штуки и средняя сумма
// поступления на счёт за выкуп. Сверху — сводка с полосами выполнения,
// ниже — по дням выбранной строки: план, факт, выполнение.
//   Штуки: план дня = план месяца / дней в месяце; «к темпу» — факт к плану
//   на прошедшие дни. Поступление — средняя величина: план = целевое значение.
// Набор метрик — конструктор: потом сюда добавятся чистая прибыль и маржа.
// ─────────────────────────────────────────────────────────────────────────

const METRICS = [
  { k: 'salesQty', t: 'Выкупы, шт', short: 'Выкупы', fin: true, sum: true },
  { k: 'orders', t: 'Заказы, шт', short: 'Заказы', sum: true },
  { k: 'payout', t: 'Ср. поступ. на счёт за выкуп, ₽', short: 'Ср. поступ. на счёт', fin: true, rub: true },
  { k: 'profit', t: 'Чистая прибыль, ₽', soon: true },
  { k: 'margin', t: 'Маржинальность, %', soon: true },
];
const MD = Object.fromEntries(METRICS.map(m => [m.k, m]));
const OZ = ['commission', 'logistics', 'acquiring', 'storage', 'promo', 'other', 'ads'];
const ALL = 'Все';
const LS = 'mp-plan-mets';
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const num = v => { const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; };

export default function PlanFact({ cabinet }) {
  const today = dayjs();
  const [month, setMonth] = useState(today.format('YYYY-MM'));
  const [mets, setMets] = useState(() => { try { const v = JSON.parse(localStorage.getItem(LS)); if (Array.isArray(v) && v.length) return v.filter(k => MD[k] && !MD[k].soon); } catch (e) { /* ignore */ } return ['salesQty', 'payout']; });
  useEffect(() => { try { localStorage.setItem(LS, JSON.stringify(mets)); } catch (e) { /* ignore */ } }, [mets]);
  const [sales, setSales] = useState(null);
  const [pnl, setPnl] = useState(null);
  const [plan, setPlanState] = useState({});
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const [selKey, setSelKey] = useState(ALL);
  const [pick, setPick] = useState(false);
  const saveTimer = useRef(null);
  const grp = useGroups(cabinet);

  const mStart = dayjs(month + '-01'), mEnd = mStart.endOf('month');
  const isCur = month === today.format('YYYY-MM');
  const D = mEnd.date();
  const elapsed = isCur ? Math.max(0.5, today.date() - 1 + today.hour() / 24) : (month < today.format('YYYY-MM') ? D : 0);

  useEffect(() => {
    setSales(null); setPnl(null); setError(null);
    const from = mStart.format('YYYY-MM-DD'), to = (isCur ? today : mEnd).format('YYYY-MM-DD');
    Promise.all([getSalesData(cabinet, { dateFrom: from, dateTo: to }), getPlan(cabinet, month)])
      .then(([s, p]) => { setSales(s.data.data); setPlanState(p.data.data || {}); })
      .catch(e => setError(e.response?.data?.error || e.message));
    getFinancePnl(cabinet, { dateFrom: from, dateTo: to }).then(r => setPnl(r.data.data)).catch(() => setPnl(false));
  }, [cabinet, month]); // eslint-disable-line react-hooks/exhaustive-deps

  const cats = useCats(sales?.articles, sales?.order);
  const byOffer = useMemo(() => new Map(cats.arts.map(a => [a.o, a.i])), [cats.arts]);

  // Факт по дням месяца для каждого артикула: { metric: { n: [ai][d], q: [ai][d] } } (q — знаменатель средних).
  const fact = useMemo(() => {
    if (!sales) return null;
    const N = cats.arts.length, mk = () => Array.from({ length: N }, () => new Float64Array(D));
    const out = { orders: { n: mk() }, salesQty: { n: mk() }, payout: { n: mk(), q: mk() } };
    for (const r of sales.rows) { const d = dayjs(sales.dates[r[1]]).date() - 1; if (d >= 0 && d < D) out.orders.n[r[0]][d] += r[5]; }
    if (pnl) {
      const S = mk(), saleDay = new Float64Array(D), noSkuDay = new Float64Array(D);
      for (const [pai, pd, b, a, q] of pnl.rows) {
        const k = pnl.buckets[b], ai = byOffer.get(pnl.articles[pai]?.o), d = dayjs(pnl.dates[pd]).date() - 1;
        if (ai === undefined || d < 0 || d >= D) continue;
        if (k === 'sale' || k === 'return') {
          const qty = (k === 'return' ? -1 : 1) * Math.abs(q || 0);
          out.salesQty.n[ai][d] += qty; out.payout.q[ai][d] += qty;
          out.payout.n[ai][d] += a; S[ai][d] += a; saleDay[d] += a;
        } else if (OZ.includes(k)) out.payout.n[ai][d] += a;
      }
      // Удержания без артикула — по доле выкупов дня (как в «P&L»).
      for (const [pd, b, a] of pnl.noSku || []) { const d = dayjs(pnl.dates[pd]).date() - 1; if (d >= 0 && d < D && OZ.includes(pnl.buckets[b])) noSkuDay[d] += a; }
      for (let i = 0; i < N; i++) for (let d = 0; d < D; d++) if (saleDay[d] > 0 && S[i][d] > 0) out.payout.n[i][d] += noSkuDay[d] * S[i][d] / saleDay[d];
    }
    return out;
  }, [sales, pnl, cats.arts, byOffer, D]);

  // Строки: весь кабинет → категории → подкатегории; отдельно — свои группы.
  const nodes = useMemo(() => {
    const out = [{ key: ALL, name: 'Весь кабинет', depth: 0, arts: cats.arts }];
    const tops = [...cats.topCats].sort((x, y) => (y === 'Чехлы') - (x === 'Чехлы'));
    for (const t of tops) {
      const kids = cats.childrenOf(t);
      out.push({ key: t, name: t, depth: 1, kids: kids.length, arts: cats.arts.filter(a => a.parts[0] === t) });
      for (const k of kids) out.push({ key: t + SEP + k, name: k, depth: 2, parent: t, arts: cats.arts.filter(a => a.parts[0] === t && a.parts[1] === k) });
    }
    const groups = (grp.list || []).map(g => ({ key: 'g:' + g.id, name: g.name, depth: 1, group: true, arts: cats.arts.filter(a => String(grp.members[a.o] || '') === String(g.id)) })).filter(g => g.arts.length);
    return { cats: out, groups };
  }, [cats, grp.list, grp.members]);

  const lastFull = isCur ? today.date() - 1 : D;
  const calc = useCallback((node, k) => {
    const m = MD[k], F = fact?.[k];
    const day = new Float64Array(D), den = new Float64Array(D);
    if (F) for (const a of node.arts) { const s = F.n[a.i]; for (let i = 0; i < D; i++) day[i] += s[i]; if (F.q) { const q = F.q[a.i]; for (let i = 0; i < D; i++) den[i] += q[i]; } }
    const planned = plan[node.key]?.[k] ?? null;
    if (!m.sum) {
      const sn = day.reduce((s, v) => s + v, 0), sd = den.reduce((s, v) => s + v, 0);
      const f = sd > 0 ? sn / sd : null;
      return { day, den, fact: f, planned, done: planned && f !== null ? f / planned * 100 : null, pace: planned && f !== null ? f / planned * 100 : null };
    }
    const f = day.reduce((s, v) => s + v, 0);
    const w = Math.min(7, lastFull);
    const rate = w > 0 ? day.slice(lastFull - w, lastFull).reduce((s, v) => s + v, 0) / w : 0;
    const forecast = isCur ? day.slice(0, lastFull).reduce((s, v) => s + v, 0) + rate * Math.max(0, D - lastFull) : f;
    return {
      day, fact: f, planned, forecast, perDay: planned ? planned / D : null,
      done: planned ? f / planned * 100 : null, pace: planned && elapsed > 0 ? f / (planned * elapsed / D) * 100 : null,
      fc: planned ? forecast / planned * 100 : null, need: planned && isCur && D - elapsed > 0 ? Math.max(0, (planned - f) / (D - elapsed)) : null,
    };
  }, [fact, plan, D, lastFull, isCur, elapsed]);

  const setPlan = (key, k, v) => {
    const n = num(v);
    const next = { ...plan, [key]: { ...(plan[key] || {}) } };
    if (v === '' || n === null) delete next[key][k]; else next[key][k] = n;
    setPlanState(next); setSaved('сохраняю…');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => savePlan(cabinet, month, next).then(() => setSaved('сохранено')).catch(e => setSaved(`ошибка: ${e.message}`)), 700);
  };
  const copyPrev = () => getPlan(cabinet, mStart.subtract(1, 'month').format('YYYY-MM')).then(r => {
    const p = r.data.data || {};
    if (!Object.keys(p).length) { setSaved('в прошлом месяце плана нет'); return; }
    setPlanState(p); savePlan(cabinet, month, p).then(() => setSaved('скопировано из прошлого месяца'));
  });

  if (error && !sales) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Не удалось загрузить: {error}</div></div>;
  if (!sales) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Загрузка…</div></div>;

  const shown = mets.map(k => MD[k]).filter(Boolean);
  const fmtV = (m, v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : m.rub ? `${fmtInt(v)} ₽` : fmtInt(v));
  const cls = p => (p === null || p === undefined ? '' : p >= 100 ? 'g' : p >= 90 ? 'w' : 'b');
  const months = []; for (let i = -3; i <= 2; i++) months.push(today.add(i, 'month').format('YYYY-MM'));
  const finWait = shown.some(m => m.fin) && pnl === null;

  // Полоса выполнения: заливка — факт / план месяца, риска — где нужно быть сегодня.
  const Bar = ({ m, c }) => {
    if (!c.planned) return <span className="muted">план не задан</span>;
    const p = m.sum ? c.done : c.pace;
    const mark = m.sum && isCur ? Math.min(100, elapsed / D * 100) : null;
    const tipText = m.sum ? `Выполнено ${pct1(c.done)} плана месяца · к темпу ${pct1(c.pace)}${c.need !== null && c.need !== undefined ? ` · нужно ${fmtInt(c.need)} в день` : ''} · прогноз на конец месяца ${fmtInt(c.forecast)} (${pct1(c.fc)})` : `Факт ${fmtV(m, c.fact)} при плане ${fmtV(m, c.planned)}`;
    return (
      <div className="pf-bar" title={tipText}>
        <div className="pf-track"><i className={cls(m.sum ? c.pace : p)} style={{ width: `${Math.min(100, Math.max(0, p || 0))}%` }} />{mark !== null && <b style={{ left: `${mark}%` }} />}</div>
        <span className={`pf-pct ${cls(m.sum ? c.pace : p)}`}>{pct1(m.sum ? c.pace : p)}</span>
      </div>
    );
  };

  const row = n => (
    <tr key={n.key} className={`pf-r d${n.depth} ${selKey === n.key ? 'on' : ''}`}>
      <td className="pf-name" onClick={() => setSelKey(n.key)} title="Показать по дням">
        <span style={{ paddingLeft: n.depth === 2 ? 22 : 0 }}>
          {n.depth === 1 && n.kids > 0 && <button type="button" className={`pf-chev ${open.has(n.key) ? 'on' : ''}`} onClick={e => { e.stopPropagation(); setOpen(s => { const x = new Set(s); x.has(n.key) ? x.delete(n.key) : x.add(n.key); return x; }); }}>▶</button>}
          {n.group && <span className="pf-dot" style={{ background: grp.colors?.[n.key.slice(2)] || 'var(--a-accent)' }} />}
          {n.name}<small>{n.arts.length} арт.</small>
        </span>
      </td>
      {shown.map(m => { const c = calc(n, m.k); return (
        <React.Fragment key={m.k}>
          <td className="pf-in"><input inputMode="decimal" value={plan[n.key]?.[m.k] ?? ''} placeholder="план" onChange={e => setPlan(n.key, m.k, e.target.value)} onClick={e => e.stopPropagation()} /></td>
          <td className="n r pf-fact">{finWait && m.fin ? '…' : fmtV(m, c.fact)}</td>
          <td className="pf-barc">{finWait && m.fin ? '' : <Bar m={m} c={c} />}</td>
        </React.Fragment>
      ); })}
    </tr>
  );

  const sel = [...nodes.cats, ...nodes.groups].find(n => n.key === selKey) || nodes.cats[0];
  const days = Array.from({ length: D }, (_, i) => mStart.add(i, 'day'));
  const isFuture = i => isCur ? i >= today.date() : month > today.format('YYYY-MM');

  return (
    <div className="mpui sa-page">
      <div className="page-sticky">
        <div className="a-top">
          <h1>План / факт</h1>
          <span className="a-seg">{months.map(m => <button key={m} type="button" className={month === m ? 'on' : ''} onClick={() => setMonth(m)}>{dayjs(m + '-01').format('MMM YY')}</button>)}</span>
          <span className="tb-tplwrap">
            <button type="button" className="a-btn" onClick={() => setPick(p => !p)}>Метрики · {shown.length} ▾</button>
            {pick && (
              <div className="tb-tplpop" style={{ minWidth: 280 }} onMouseLeave={() => setPick(false)}>
                {METRICS.map(m => (
                  <label key={m.k} className="tb-chk" style={{ display: 'flex', padding: '3px 0', opacity: m.soon ? 0.5 : 1 }} title={m.soon ? 'Добавим позже' : undefined}>
                    <input type="checkbox" disabled={m.soon} checked={mets.includes(m.k)} onChange={e => setMets(x => (e.target.checked ? METRICS.map(y => y.k).filter(k => x.includes(k) || k === m.k) : x.filter(k => k !== m.k)))} />
                    {m.t}{m.soon ? <small className="muted" style={{ marginLeft: 6 }}>скоро</small> : null}
                  </label>
                ))}
              </div>
            )}
          </span>
          <button type="button" className="a-btn ghost" onClick={copyPrev}>Скопировать план прошлого месяца</button>
          {saved && <span className="a-hint" style={{ margin: 0 }}>{saved}</span>}
        </div>
      </div>

      <div className="a-card" style={{ padding: 0 }}>
        <div className="a-scroll">
          <table className="a-t pf-t no-sh">
            <thead>
              <tr>
                <th className="l" rowSpan={2}>Категория / группа</th>
                {shown.map(m => <th key={m.k} colSpan={3} className="pf-mh">{m.t}</th>)}
              </tr>
              <tr>
                {shown.map(m => (
                  <React.Fragment key={m.k}>
                    <th className="r">План {m.sum ? 'на месяц' : ''}</th>
                    <th className="r">Факт {m.sum ? (isCur ? 'на сегодня' : 'за месяц') : ''}</th>
                    <th className="l" title={m.sum ? 'Полоса — доля плана месяца; риска — где нужно быть сегодня; число — выполнение к темпу' : 'Факт к плану'}>{m.sum ? 'Выполнение · к темпу' : 'Выполнение'}</th>
                  </React.Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {nodes.cats.filter(n => n.depth < 2 || open.has(n.parent)).map(row)}
              {nodes.groups.length > 0 && <tr className="pf-sep"><td colSpan={1 + shown.length * 3}>Свои группы (из «Рекламы»)</td></tr>}
              {nodes.groups.map(row)}
            </tbody>
          </table>
        </div>
      </div>
      <div className="a-hint" style={{ margin: '6px 2px 14px' }}>
        Впишите план в ячейки — сохраняется сам. Штуки — на весь месяц, поступление — целевая средняя сумма на счёт за один выкуп. Нажмите на название — ниже откроется по дням.
        {shown.some(m => m.fin) ? ' Выкупы и поступление — по начислениям Ozon (по дню выкупа), за последние 1–2 дня они ещё неполные.' : ''}
      </div>

      <div className="a-card" style={{ padding: 0 }}>
        <div className="a-bar" style={{ padding: '12px 14px 8px' }}><b style={{ fontSize: 14 }}>По дням · {sel.name}</b><span className="a-hint">план дня = план месяца / {D} дн.; факт подсвечен: зелёный — план дня выполнен, жёлтый — 90–100%, красный — меньше</span></div>
        <div className="a-scroll pf-days">
          <table className="a-t pf-dt no-sh">
            <thead><tr>
              <th className="l pf-dm">Метрика</th><th className="r pf-dtot">Месяц</th>
              {days.map((d, i) => <th key={i} className={`r ${d.day() === 0 || d.day() === 6 ? 'we' : ''} ${isCur && i === today.date() - 1 ? 'today' : ''}`}><div>{d.format('DD')}</div><small>{WD[d.day()]}</small></th>)}
            </tr></thead>
            {shown.map(m => {
              const c = calc(sel, m.k);
              const dayPlan = m.sum ? c.perDay : c.planned;
              const dayFact = i => (m.sum ? c.day[i] : c.den[i] > 0 ? c.day[i] / c.den[i] : null);
              const dayPct = i => { const f = dayFact(i); return dayPlan && f !== null ? f / dayPlan * 100 : null; };
              return (
                <tbody key={m.k} className="pf-blk">
                  <tr className="pf-bh"><td colSpan={2 + D}>{m.t}</td></tr>
                  <tr><td className="pf-dm">План</td><td className="n r pf-dtot">{fmtV(m, c.planned)}</td>{days.map((_, i) => <td key={i} className="n r muted">{fmtV(m, dayPlan)}</td>)}</tr>
                  <tr className="pf-factr"><td className="pf-dm">Факт</td><td className="n r pf-dtot">{fmtV(m, c.fact)}</td>
                    {days.map((_, i) => { const p = dayPct(i); const fut = isFuture(i); return <td key={i} className={`n r ${fut ? 'muted' : `pf-c ${cls(p)}`}`}>{fut ? '' : finWait && m.fin ? '…' : fmtV(m, dayFact(i))}</td>; })}</tr>
                  <tr><td className="pf-dm">Выполнение</td><td className={`n r pf-dtot pf-pct ${cls(m.sum ? c.pace : c.done)}`}>{m.sum ? (c.planned ? `${pct1(c.done)} · темп ${pct1(c.pace)}` : '—') : pct1(c.done)}</td>
                    {days.map((_, i) => { const p = dayPct(i); return <td key={i} className={`n r pf-pct ${cls(p)}`}>{isFuture(i) ? '' : pct1(p)}</td>; })}</tr>
                </tbody>
              );
            })}
          </table>
        </div>
      </div>
    </div>
  );
}
