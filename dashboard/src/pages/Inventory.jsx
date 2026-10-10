import React, { useState, useEffect, useMemo, useCallback } from 'react';
import dayjs from 'dayjs';
import { getStocksData } from '../api';
import { fmtInt, useTip, DualChart, AreaSpark, Delta, CAT_COLORS } from './AdsStats2';
import { useCats, useGroups, FinHeader, Kpi, Empty, inPath, matchQ, pct1, SEP, OTHER } from './finShared';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// «Остатки»: сколько товара на FBO (по кластерам) и на своём складе (FBS),
// на сколько дней хватит при текущем темпе, где спрос есть, а остатка в
// кластере нет, что залежалось — и сколько куда везти.
//   Темп продаж — заказы за выбранное окно (полные дни, без сегодня).
//   Доля FBS — по статусам заказов (FBO/FBS) за то же окно.
//   Спрос кластера — заказы с доставкой в этот кластер (GeoOrders).
//   Рекомендация поставки в кластер = спрос/день × «держать запас, дней»
//   − доступно − в пути (не меньше нуля).
// ─────────────────────────────────────────────────────────────────────────

const SCHEMES = [['all', 'Всё'], ['fbo', 'FBO'], ['fbs', 'FBS']];
const VIEWS = [['goods', 'Товары'], ['clusters', 'Кластеры'], ['districts', 'Округа']];
const daysTxt = v => (v === null || v === undefined) ? '—' : !Number.isFinite(v) ? '∞' : v >= 365 ? '365+' : String(Math.round(v));
const STATUS = {
  out: ['Закончился', 'b'], crit: ['< 7 дней', 'b'], low: ['7–14 дней', 'w'], ok: ['норма', 'g'], over: ['избыток', 'm'], dead: ['без продаж', 'm'], none: ['нет остатка', 'm'],
};
const SIGNALS = [
  ['out', 'Закончились, но продаются', 'Остатка нет, а заказы за окно были — теряете продажи', 'b'],
  ['crit', 'Хватит меньше чем на 7 дней', 'Срочно пополнить', 'b'],
  ['low', 'Хватит на 7–14 дней', 'Пора планировать поставку', 'w'],
  ['holes', 'Нет в кластере при спросе', 'Заказы в кластер есть, а FBO-остатка там нет — товар везут издалека (дороже логистика, дольше доставка)', 'w'],
  ['grow', 'Продажи растут, запас < 30 дней', 'Темп вырос на 30%+ к прошлому окну — запаса может не хватить', 'w'],
  ['over', 'Избыток (> 90 дней)', 'Запаса больше чем на 3 месяца — замороженные деньги и платное хранение', 'm'],
  ['dead', 'Без продаж с остатком', 'Остаток есть, заказов за окно нет', 'm'],
  ['fbsOnly', 'Продаётся только с FBS', 'FBO-остатка нет, все заказы со своего склада', 'm'],
];

function statusOf(stock, v, sold) {
  if (stock <= 0) return v > 0 ? 'out' : 'none';
  if (v <= 0) return sold ? 'over' : 'dead';
  const c = stock / v;
  return c < 7 ? 'crit' : c < 14 ? 'low' : c > 90 ? 'over' : 'ok';
}

export default function Inventory({ cabinet }) {
  const [days, setDays] = useState(14);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState('');
  const [search, setSearch] = useState('');
  const [scheme, setScheme] = useState('all');
  const [view, setView] = useState('goods');
  const [target, setTarget] = useState(30);
  const [sig, setSig] = useState(null);
  const [open, setOpen] = useState(null);
  const [sortKey, setSortKey] = useState('prio');
  const tip = useTip();
  const grp = useGroups(cabinet);

  const load = useCallback(() => {
    setLoading(true); setError(null);
    getStocksData(cabinet, { days })
      .then(r => setData(r.data.data))
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, [cabinet, days]);
  useEffect(() => { load(); }, [load]);

  const cats = useCats(data?.articles, data?.order);
  const N = data?.dates.length || 0;
  const todayIdx = N - 1;

  // ── По артикулу: остатки, темп, кластеры, история ──
  const per = useMemo(() => {
    if (!data) return [];
    const P = cats.arts.map(a => ({
      a, fbo: 0, fboRes: 0, fbs: 0, fbsRes: 0, transit: 0, win: 0, prev: 0, rev: 0, ordF: 0, ordAll: 0, sold30: 0,
      ord: new Float64Array(N), hFbo: new Array(N).fill(null), hFbs: new Array(N).fill(null), cl: new Map(), any: false,
    }));
    for (const [ai, f, fr, s, sr] of data.stock) { const x = P[ai]; x.fbo = f; x.fboRes = fr; x.fbs = s; x.fbsRes = sr; x.any = true; }
    const w0 = N - 1 - data.days, p0 = N - 1 - 2 * data.days;
    for (const [ai, d, q, r] of data.orders) {
      const x = P[ai]; x.ord[d] += q; x.any = true;
      if (d >= w0 && d < todayIdx) { x.win += q; x.rev += r; } else if (d >= p0 && d < w0) x.prev += q;
      if (d >= N - 31 && d < todayIdx) x.sold30 += q;
    }
    for (const [ai, d, o, f] of data.fbs) if (d >= w0 && d < todayIdx) { P[ai].ordAll += o; P[ai].ordF += f; }
    for (const [ai, d, f, s] of data.hist) { P[ai].hFbo[d] = f; P[ai].hFbs[d] = s; }
    for (const x of P) { // переносим остаток вперёд по дням без снимков
      let f = null, s = null;
      for (let d = 0; d < N; d++) { if (x.hFbo[d] !== null) f = x.hFbo[d]; else x.hFbo[d] = f; if (x.hFbs[d] !== null) s = x.hFbs[d]; else x.hFbs[d] = s; }
    }
    for (const [ai, ci, av, tr] of data.cl) { const c = P[ai].cl.get(ci) || { av: 0, tr: 0, q: 0, p: 0 }; c.av += av; c.tr += tr; P[ai].cl.set(ci, c); P[ai].transit += tr; }
    for (const [ai, ci, q, p] of data.demand) { const c = P[ai].cl.get(ci) || { av: 0, tr: 0, q: 0, p: 0 }; c.q += q; c.p += p; P[ai].cl.set(ci, c); }
    const D = data.days;
    for (const x of P) {
      x.v = x.win / D;
      x.fbsShare = x.ordAll > 0 ? x.ordF / x.ordAll : (x.fbo > 0 ? 0 : x.fbs > 0 ? 1 : 0);
      x.vFbo = x.v * (1 - x.fbsShare); x.vFbs = x.v * x.fbsShare;
      x.trend = x.prev > 0 ? (x.win - x.prev) / x.prev * 100 : (x.win > 0 ? null : null);
      x.price = x.win > 0 ? x.rev / x.win : null;
      let need = 0, holes = 0;
      for (const c of x.cl.values()) {
        c.v = c.q / D;
        c.cover = c.v > 0 ? (c.av + c.tr) / c.v : (c.av > 0 ? Infinity : null);
        c.need = Math.max(0, Math.ceil(c.v * target - c.av - c.tr));
        c.hole = c.q >= 2 && c.av + c.tr <= 0;
        need += c.need; if (c.hole) holes++;
      }
      x.need = need; x.holes = holes;
    }
    return P;
  }, [data, cats.arts, N, todayIdx, target]);

  // Значения по выбранной схеме.
  const pick = useCallback(x => {
    if (scheme === 'fbo') return { stock: x.fbo, v: x.vFbo };
    if (scheme === 'fbs') return { stock: x.fbs, v: x.vFbs };
    return { stock: x.fbo + x.fbs, v: x.v };
  }, [scheme]);

  const q = search.trim().toLowerCase();
  const base = useMemo(() => per.filter(x => x.any && inPath(x.a, sel) && matchQ(x.a, q) && grp.test(x.a)), [per, sel, q, grp.test]);
  const rows = useMemo(() => base.map(x => {
    const { stock, v } = pick(x);
    const st = statusOf(stock, v, x.sold30 > 0);
    const cover = v > 0 ? stock / v : (stock > 0 ? Infinity : null);
    const sigs = new Set([st]);
    if (x.holes) sigs.add('holes');
    if (x.trend !== null && x.trend >= 30 && cover !== null && cover < 30) sigs.add('grow');
    if (x.fbo <= 0 && x.v > 0 && x.fbsShare > 0.8) sigs.add('fbsOnly');
    // Приоритет: сколько денег в день под риском.
    const prio = (st === 'out' ? 1000 : st === 'crit' ? 500 : st === 'low' ? 200 : 0) * (1 + (x.v * (x.price || 0)) / 10000) + x.holes * 10;
    return { x, stock, v, st, cover, sigs, prio };
  }), [base, pick]);
  const shown = useMemo(() => {
    const list = sig ? rows.filter(r => r.sigs.has(sig)) : rows.filter(r => r.stock > 0 || r.v > 0);
    const key = {
      prio: r => -r.prio - r.v * 0.001, cover: r => (r.cover === null ? 1e9 : r.cover), stock: r => -r.stock, v: r => -r.v,
      need: r => -r.x.need, trend: r => -(r.x.trend ?? -1e9),
    }[sortKey];
    return [...list].sort((a, b) => key(a) - key(b)).slice(0, 400);
  }, [rows, sig, sortKey]);

  const sigCount = useMemo(() => {
    const c = {}; for (const [k] of SIGNALS) c[k] = 0;
    for (const r of rows) for (const s of r.sigs) if (c[s] !== undefined) c[s]++;
    return c;
  }, [rows]);

  // Итоги по выборке.
  const T = useMemo(() => {
    let fbo = 0, fbs = 0, tr = 0, v = 0, vF = 0, vS = 0, win = 0, prev = 0, dem = 0, demLocal = 0, need = 0, lost = 0;
    for (const x of base) {
      fbo += x.fbo; fbs += x.fbs; tr += x.transit; v += x.v; vF += x.vFbo; vS += x.vFbs; win += x.win; prev += x.prev; need += x.need;
      for (const c of x.cl.values()) { dem += c.q; if (c.av > 0) demLocal += c.q; }
      const { stock, v: vv } = pick(x); if (stock <= 0 && vv > 0) lost += vv * (x.price || 0);
    }
    const stock = scheme === 'fbo' ? fbo : scheme === 'fbs' ? fbs : fbo + fbs, vv = scheme === 'fbo' ? vF : scheme === 'fbs' ? vS : v;
    return { fbo, fbs, tr, v: vv, cover: vv > 0 ? stock / vv : null, trend: prev > 0 ? (win - prev) / prev * 100 : null, local: dem > 0 ? demLocal / dem * 100 : null, need, lost, stock };
  }, [base, pick, scheme]);

  // История выборки для графика.
  const chart = useMemo(() => {
    if (!data) return null;
    const by = {};
    const from = Math.max(0, N - 45);
    for (let d = from; d < N; d++) by[data.dates[d]] = { fbo: 0, fbs: 0, total: 0, orders: 0 };
    for (const x of base) for (let d = from; d < N; d++) {
      const o = by[data.dates[d]]; o.fbo += x.hFbo[d] || 0; o.fbs += x.hFbs[d] || 0; o.orders += x.ord[d];
    }
    for (const d of Object.keys(by)) { const o = by[d]; o.total = o.fbo + o.fbs; }
    return { dates: data.dates.slice(from), by };
  }, [data, base, N]);

  // Кластеры и округа для выборки.
  const clRows = useMemo(() => {
    if (!data) return [];
    const C = data.clusters.map((c, i) => ({ i, name: c.name, district: c.district, av: 0, tr: 0, q: 0, p: 0, need: 0, holes: 0, arts: [] }));
    for (const x of base) for (const [ci, c] of x.cl) {
      const r = C[ci]; r.av += c.av; r.tr += c.tr; r.q += c.q; r.p += c.p; r.need += c.need; if (c.hole) r.holes++;
      if (c.need > 0 || c.hole || c.av > 0 || c.q > 0) r.arts.push({ x, c });
    }
    const D = data.days;
    return C.map(r => ({ ...r, v: r.q / D, cover: r.q > 0 ? (r.av + r.tr) / (r.q / D) : (r.av > 0 ? Infinity : null), trend: r.p > 0 ? (r.q - r.p) / r.p * 100 : null }))
      .filter(r => r.av || r.q || r.tr).sort((a, b) => b.q - a.q || b.av - a.av);
  }, [data, base]);
  const dRows = useMemo(() => {
    const m = new Map();
    for (const c of clRows) {
      const d = m.get(c.district) || { name: c.district, av: 0, tr: 0, q: 0, p: 0, need: 0, holes: 0, clusters: [] };
      d.av += c.av; d.tr += c.tr; d.q += c.q; d.p += c.p; d.need += c.need; d.holes += c.holes; d.clusters.push(c); m.set(c.district, d);
    }
    const D = data?.days || 14;
    return [...m.values()].map(d => ({ ...d, v: d.q / D, cover: d.q > 0 ? (d.av + d.tr) / (d.q / D) : null, trend: d.p > 0 ? (d.q - d.p) / d.p * 100 : null })).sort((a, b) => b.q - a.q);
  }, [clRows, data]);
  const totQ = clRows.reduce((s, c) => s + c.q, 0), totAv = clRows.reduce((s, c) => s + c.av, 0);

  const exportPlan = () => {
    const lines = [['Артикул', 'Название', 'Кластер', 'Спрос в день', 'Доступно', 'В пути', 'Хватит дней', `Везти (запас ${target} дн)`]];
    for (const x of base) for (const [ci, c] of x.cl) if (c.need > 0) lines.push([x.a.o, (x.a.n || '').replace(/;/g, ','), data.clusters[ci].name, c.v.toFixed(2).replace('.', ','), c.av, c.tr, daysTxt(c.cover), c.need]);
    const csv = '﻿' + lines.map(l => l.join(';')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const el = document.createElement('a'); el.href = url; el.download = `поставка_${dayjs().format('DD.MM')}.csv`; el.click(); URL.revokeObjectURL(url);
  };

  if (loading && !data) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Загрузка…</div></div>;
  if (error && !data) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Не удалось загрузить: {error} <button className="a-btn" onClick={load}>Повторить</button></div></div>;

  const coverPill = (v, st) => {
    const cls = st ? STATUS[st][1] : (v === null ? 'm' : v < 7 ? 'b' : v < 14 ? 'w' : v > 90 ? 'm' : 'g');
    return <span className={`pill ${cls}`}>{daysTxt(v)}</span>;
  };
  const sortTh = (k, l, title) => <th className={`r ${sortKey === k ? 'on' : ''}`} style={{ cursor: 'pointer' }} title={title} onClick={() => setSortKey(k)}>{l}{sortKey === k ? ' ↓' : ''}</th>;
  const clusterTable = list => (
    <table className="a-t s-slice">
      <thead><tr><th>Кластер</th><th className="r">Спрос / день</th><th className="r">Доступно FBO</th><th className="r">В пути</th><th className="r">Хватит, дн</th><th className="r">Везти</th></tr></thead>
      <tbody>
        {list.map(([name, c]) => (
          <tr key={name} className={c.hole ? 's-hole' : ''}>
            <td>{name}{c.hole && <span className="pill b" style={{ marginLeft: 6, minWidth: 0 }}>нет остатка</span>}</td>
            <td className="n r">{c.v ? c.v.toFixed(c.v < 1 ? 2 : 1).replace('.', ',') : '—'}</td><td className="n r">{fmtInt(c.av)}</td><td className="n r">{c.tr ? fmtInt(c.tr) : '—'}</td>
            <td className="r">{coverPill(c.cover)}</td><td className="n r"><b>{c.need ? fmtInt(c.need) : '—'}</b></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  const noData = !data.stock.length && !data.cl.length;

  return (
    <div className="mpui sa-page">
      <FinHeader title="Остатки" cats={cats} sel={sel} setSel={s => { setSel(s); setOpen(null); }} search={search} setSearch={setSearch} grp={grp} loading={loading}>
        <span className="a-seg">{SCHEMES.map(([k, l]) => <button key={k} type="button" className={scheme === k ? 'on' : ''} onClick={() => setScheme(k)}>{l}</button>)}</span>
        <span className="a-seg" title="Окно для темпа продаж">{[7, 14, 30].map(n => <button key={n} type="button" className={days === n ? 'on' : ''} onClick={() => setDays(n)}>темп {n} дн</button>)}</span>
        <label className="a-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>держать запас
          <input className="a-input" type="number" min="7" max="120" value={target} onChange={e => setTarget(Math.max(1, Number(e.target.value) || 30))} style={{ width: 60, padding: '4px 8px' }} /> дн
        </label>
      </FinHeader>

      {noData ? (
        <Empty><b>Остатков пока нет.</b><br />Остатки по складам собирает Google-скрипт (функция <code>syncStocksWh</code>, вкладка «StocksWh») — вставьте обновлённый скрипт, запустите <code>setupTriggers</code> и один раз <code>syncStocksWh</code>.</Empty>
      ) : (
        <>
          <div className={`a-kpis s-kpis ${loading ? 'a-loading' : ''}`}>
            <Kpi label="Остаток, шт" value={fmtInt(T.stock)} sub={<span>FBO {fmtInt(T.fbo)} · FBS {fmtInt(T.fbs)}{T.tr ? ` · в пути ${fmtInt(T.tr)}` : ''}</span>} />
            <Kpi label="Хватит на, дней" value={daysTxt(T.cover)} sub={<span>{T.v.toFixed(1).replace('.', ',')} шт/день <Delta value={T.trend} /> к прошлым {days} дн</span>} />
            <Kpi label="Локализация FBO" value={pct1(T.local)} sub="доля заказов в кластеры, где есть остаток" />
            <Kpi label="Теряем в день" value={T.lost ? `${fmtInt(T.lost)} ₽` : '0 ₽'} sub={`закончилось: ${sigCount.out} арт. · везти ${fmtInt(T.need)} шт`} />
          </div>

          <div className="a-card s-card">
            <div className="a-bar" style={{ marginBottom: 8 }}>
              <b style={{ fontSize: 14 }}>На что обратить внимание</b>
              <span className="a-hint">клик — показать эти товары в таблице{sig ? '' : ''}</span>
              {sig && <button type="button" className="a-btn ghost" onClick={() => setSig(null)}>× показать все</button>}
            </div>
            <div className="i-sigs">
              {SIGNALS.map(([k, l, h, tone]) => (
                <button key={k} type="button" className={`i-sig ${tone} ${sig === k ? 'on' : ''} ${sigCount[k] ? '' : 'zero'}`} title={h} onClick={() => { setSig(sig === k ? null : k); setView('goods'); }}>
                  <b className="n">{fmtInt(sigCount[k])}</b><span>{l}</span>
                </button>
              ))}
            </div>
          </div>

          {chart && (
            <div className="a-card s-card">
              <DualChart dates={chart.dates} byDate={chart.by} tip={tip} events={[]} storeKey="mp-inv-chart"
                metricsList={[{ key: 'total', label: 'Остаток всего, шт', fmt: 'int' }, { key: 'fbo', label: 'Остаток FBO, шт', fmt: 'int' }, { key: 'fbs', label: 'Остаток FBS, шт', fmt: 'int' }, { key: 'orders', label: 'Заказы, шт', fmt: 'int' }]}
                defaults={{ left: 'orders', right: 'total', type: 'combo' }} />
              <div className="a-hint" style={{ marginTop: 4 }}>Остатки — по ежедневным снимкам (последний: {data.stockDate ? dayjs(data.stockDate).format('DD.MM') : '—'}; по кластерам — {data.clusterDate ? dayjs(data.clusterDate).format('DD.MM') : 'ещё нет'}).</div>
            </div>
          )}

          <div className="a-card">
            <div className="a-bar" style={{ padding: '12px 14px 4px' }}>
              <span className="a-seg">{VIEWS.map(([k, l]) => <button key={k} type="button" className={view === k ? 'on' : ''} onClick={() => { setView(k); setOpen(null); }}>{l}</button>)}</span>
              {sig && <span className="pill w">{SIGNALS.find(s => s[0] === sig)[1]} · {shown.length}</span>}
              <button type="button" className="a-btn" style={{ marginLeft: 'auto' }} onClick={exportPlan} title="Все товары выборки, которым нужна поставка, по кластерам">⬇ План поставки (CSV)</button>
            </div>

            {view === 'goods' && (
              <div className="a-scroll">
                <table className="a-t s-tree">
                  <thead><tr>
                    <th>Товар</th><th>Статус</th>
                    {sortTh('stock', scheme === 'all' ? 'Остаток' : `Остаток ${scheme.toUpperCase()}`)}
                    <th className="r">FBO / FBS</th>
                    {sortTh('v', 'Продаж в день')}{sortTh('trend', 'Темп', 'К прошлому окну той же длины')}
                    {sortTh('cover', 'Хватит, дн')}
                    <th className="r" title="Доля заказов со своего склада">FBS</th>
                    <th className="r">Остаток 45 дн</th>
                    {sortTh('need', 'Везти', `Сумма по кластерам, чтобы хватило на ${target} дн`)}
                  </tr></thead>
                  <tbody>
                    {shown.map(r => {
                      const x = r.x, isOpen = open === x.a.i;
                      const top = x.a.parts[0];
                      const spark = x.hFbo.slice(-45).map((f, i) => (f || 0) + (x.hFbs.slice(-45)[i] || 0));
                      return (
                        <React.Fragment key={x.a.i}>
                          <tr className={`row ${isOpen ? 'open' : ''}`} onClick={() => setOpen(isOpen ? null : x.a.i)}>
                            <td><div className="a-art"><span className="a-chev">▶</span><i className="s-dot" style={{ background: CAT_COLORS[cats.topSlot(top)] || OTHER }} />
                              <span title={x.a.n}><b>{x.a.o}</b> <span className="muted">{x.a.short}</span></span></div></td>
                            <td><span className={`pill ${STATUS[r.st][1]}`}>{STATUS[r.st][0]}</span>{x.holes > 0 && <span className="pill w" style={{ marginLeft: 4, minWidth: 0 }} title="Кластеров со спросом без остатка">−{x.holes} кл</span>}</td>
                            <td className="n r"><b>{fmtInt(r.stock)}</b></td>
                            <td className="n r muted">{fmtInt(x.fbo)} / {fmtInt(x.fbs)}{x.transit ? <span title="В пути на склады"> +{fmtInt(x.transit)}</span> : ''}</td>
                            <td className="n r">{r.v ? r.v.toFixed(r.v < 1 ? 2 : 1).replace('.', ',') : '—'}</td>
                            <td className="r"><Delta value={x.trend} /></td>
                            <td className="r">{coverPill(r.cover, r.st === 'out' ? 'out' : null)}</td>
                            <td className="n r muted">{x.v ? pct1(x.fbsShare * 100) : '—'}</td>
                            <td style={{ width: 110 }}><AreaSpark values={spark} color="var(--a-rev)" /></td>
                            <td className="n r"><b>{x.need ? fmtInt(x.need) : '—'}</b></td>
                          </tr>
                          {isOpen && (
                            <tr className="a-detail"><td colSpan={10}>
                              <div className="a-dwrap" style={{ gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr)' }}>
                                <div>
                                  <div className="a-hint" style={{ marginBottom: 6 }}>По кластерам FBO: спрос (заказы с доставкой туда) и остаток на складах кластера</div>
                                  {x.cl.size ? clusterTable([...x.cl.entries()].map(([ci, c]) => [data.clusters[ci].name, c]).sort((a, b) => b[1].q - a[1].q || b[1].av - a[1].av)) : <div className="a-hint">Данных по кластерам пока нет.</div>}
                                </div>
                                <div className="i-facts">
                                  <div><span>Остаток FBO</span><b>{fmtInt(x.fbo)}{x.fboRes ? ` (+${fmtInt(x.fboRes)} в резерве)` : ''}</b></div>
                                  <div><span>Остаток FBS</span><b>{fmtInt(x.fbs)}{x.fbsRes ? ` (+${fmtInt(x.fbsRes)} в резерве)` : ''}</b></div>
                                  <div><span>Хватит FBO</span><b>{daysTxt(x.vFbo > 0 ? x.fbo / x.vFbo : x.fbo > 0 ? Infinity : null)} дн</b></div>
                                  <div><span>Хватит FBS</span><b>{daysTxt(x.vFbs > 0 ? x.fbs / x.vFbs : x.fbs > 0 ? Infinity : null)} дн</b></div>
                                  <div><span>Заказов за {days} дн</span><b>{fmtInt(x.win)} (было {fmtInt(x.prev)})</b></div>
                                  <div><span>Средний чек</span><b>{x.price ? `${fmtInt(x.price)} ₽` : '—'}</b></div>
                                  <div><span>Категория</span><b>{x.a.parts.join(' › ')}</b></div>
                                </div>
                              </div>
                            </td></tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                    {!shown.length && <tr><td colSpan={10} className="muted" style={{ padding: 16 }}>Нет товаров по этому условию</td></tr>}
                  </tbody>
                </table>
              </div>
            )}

            {view === 'clusters' && (
              <div className="a-scroll">
                <table className="a-t s-tree">
                  <thead><tr><th>Кластер</th><th>Округ</th><th className="r">Доля спроса</th><th className="r">Спрос / день</th><th className="r">Темп</th><th className="r">Доступно FBO</th><th className="r">Доля остатка</th><th className="r">В пути</th><th className="r">Хватит, дн</th><th className="r">Товаров без остатка</th><th className="r">Везти, шт</th></tr></thead>
                  <tbody>
                    {clRows.map(c => (
                      <React.Fragment key={c.i}>
                        <tr className={`row ${open === 'c' + c.i ? 'open' : ''}`} onClick={() => setOpen(open === 'c' + c.i ? null : 'c' + c.i)}>
                          <td><div className="a-art"><span className="a-chev">▶</span><b>{c.name}</b></div></td><td className="muted">{c.district}</td>
                          <td className="r"><span className="s-part"><i style={{ width: `${Math.min(100, totQ ? c.q / totQ * 300 : 0)}%` }} /><b className="n">{pct1(totQ ? c.q / totQ * 100 : null)}</b></span></td>
                          <td className="n r">{c.v.toFixed(1).replace('.', ',')}</td><td className="r"><Delta value={c.trend} /></td>
                          <td className="n r">{fmtInt(c.av)}</td><td className="n r muted">{pct1(totAv ? c.av / totAv * 100 : null)}</td><td className="n r">{c.tr ? fmtInt(c.tr) : '—'}</td>
                          <td className="r">{coverPill(c.cover)}</td><td className="n r">{c.holes ? <span className="pill w">{c.holes}</span> : '—'}</td><td className="n r"><b>{c.need ? fmtInt(c.need) : '—'}</b></td>
                        </tr>
                        {open === 'c' + c.i && (
                          <tr className="a-detail"><td colSpan={11}><div style={{ padding: '12px 16px' }}>
                            <div className="a-hint" style={{ marginBottom: 6 }}>Товары кластера, которым нужна поставка (сначала — где спрос есть, а остатка нет)</div>
                            <table className="a-t s-slice">
                              <thead><tr><th>Товар</th><th className="r">Спрос / день</th><th className="r">Доступно</th><th className="r">В пути</th><th className="r">Хватит, дн</th><th className="r">Везти</th></tr></thead>
                              <tbody>{c.arts.filter(({ c: k }) => k.need > 0 || k.hole).sort((a, b) => (b.c.hole - a.c.hole) || b.c.need - a.c.need).slice(0, 60).map(({ x, c: k }) => (
                                <tr key={x.a.i}><td><b>{x.a.o}</b> <span className="muted">{x.a.short}</span></td><td className="n r">{k.v.toFixed(2).replace('.', ',')}</td><td className="n r">{fmtInt(k.av)}</td><td className="n r">{k.tr ? fmtInt(k.tr) : '—'}</td><td className="r">{coverPill(k.cover)}</td><td className="n r"><b>{fmtInt(k.need)}</b></td></tr>
                              ))}</tbody>
                            </table>
                          </div></td></tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {view === 'districts' && (
              <div className="a-scroll">
                <table className="a-t s-tree">
                  <thead><tr><th>Округ / кластер</th><th className="r">Доля спроса</th><th className="r">Спрос / день</th><th className="r">Темп</th><th className="r">Доступно FBO</th><th className="r">Доля остатка</th><th className="r">Хватит, дн</th><th className="r">Товаров без остатка</th><th className="r">Везти, шт</th></tr></thead>
                  <tbody>
                    {dRows.map(d => (
                      <React.Fragment key={d.name}>
                        <tr className={`row s-cat d0 ${open === 'd' + d.name ? 'open' : ''}`} onClick={() => setOpen(open === 'd' + d.name ? null : 'd' + d.name)}>
                          <td><div className="a-art"><span className="a-chev">▶</span><span className="s-cname">{d.name}</span><span className="a-hint">{d.clusters.length}</span></div></td>
                          <td className="r"><span className="s-part"><i style={{ width: `${Math.min(100, totQ ? d.q / totQ * 200 : 0)}%` }} /><b className="n">{pct1(totQ ? d.q / totQ * 100 : null)}</b></span></td>
                          <td className="n r">{d.v.toFixed(1).replace('.', ',')}</td><td className="r"><Delta value={d.trend} /></td><td className="n r">{fmtInt(d.av)}</td>
                          <td className="n r muted">{pct1(totAv ? d.av / totAv * 100 : null)}</td><td className="r">{coverPill(d.cover)}</td><td className="n r">{d.holes || '—'}</td><td className="n r"><b>{d.need ? fmtInt(d.need) : '—'}</b></td>
                        </tr>
                        {open === 'd' + d.name && d.clusters.map(c => (
                          <tr key={c.i} className="row" onClick={() => { setView('clusters'); setOpen('c' + c.i); }}>
                            <td><div className="a-art" style={{ paddingLeft: 22 }}>{c.name}</div></td>
                            <td className="n r">{pct1(totQ ? c.q / totQ * 100 : null)}</td><td className="n r">{c.v.toFixed(1).replace('.', ',')}</td><td className="r"><Delta value={c.trend} /></td>
                            <td className="n r">{fmtInt(c.av)}</td><td className="n r muted">{pct1(totAv ? c.av / totAv * 100 : null)}</td><td className="r">{coverPill(c.cover)}</td><td className="n r">{c.holes || '—'}</td><td className="n r">{c.need ? fmtInt(c.need) : '—'}</td>
                          </tr>
                        ))}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
      {tip.node}
    </div>
  );
}
