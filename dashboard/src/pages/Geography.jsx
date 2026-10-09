import React, { useState, useEffect, useMemo, useCallback } from 'react';
import dayjs from 'dayjs';
import { getSalesGeo } from '../api';
import DateRangePicker from '../components/DateRangePicker';
import { fmtInt, fmtPct, Delta, useTip, naturalCompare, shortModel, CAT_COLORS } from './AdsStats2';
import { StackChart, bucketsOf, ORIGINS, ORIGIN_OF } from './SalesAnalytics';
import './ads2.css';
import './sales.css';
import RU_MAP from '../data/russia-map.json';

// ─────────────────────────────────────────────────────────────────────────
// «География продаж» — куда и что продаётся: федеральные округа → регионы →
// города, доли и их изменение, «индекс» категории в регионе (продаётся ли
// она там лучше, чем в среднем по стране) и разрезы регион × категория /
// страна марки / марка. Данные — заказы Ozon (FBO+FBS) с регионом доставки,
// которые Google-скрипт складывает во вкладку GeoOrders.
// ─────────────────────────────────────────────────────────────────────────

const SEP = ' / ';
const OTHER = 'var(--a-ink3)';
const NO_BRAND = 'Без марки';
const pct1 = v => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : `${v.toFixed(v < 10 ? 1 : 0).replace('.', ',')}%`;

// Индекс: доля региона в выбранных товарах / его доля во всех продажах.
// 1,3 — здесь эти товары покупают на 30% активнее, чем в среднем.
function IndexPill({ v }) {
  if (v === null || v === undefined || !Number.isFinite(v)) return <span className="muted">—</span>;
  const cls = v >= 1.2 ? 'g' : v <= 0.8 ? 'b' : 'm';
  return <span className={`pill ${cls}`} style={{ minWidth: 48 }}>{v.toFixed(2).replace('.', ',')}</span>;
}

// Карта: регионы России (для ориентира) и кружки кластеров доставки Ozon —
// размер и подпись = доля кластера в выбранных продажах. Кружок ставится в
// город-центр кластера; «Москва, МО и Дальние регионы» — в Москву.
function hubOf(name) {
  const n = String(name || '');
  let best = null;
  for (const k of Object.keys(RU_MAP.hubs)) if (n.includes(k) && (!best || k.length > best.length)) best = k;
  if (!best && /спб|сзо|петербург/i.test(n)) best = 'Санкт-Петербург';
  return best ? RU_MAP.hubs[best] : null;
}
function ClusterMap({ regions, tot, metric, tip, selected, onPick }) {
  const placed = regions.filter(g => g.v > 0).map(g => ({ g, p: hubOf(g.name) })).filter(x => x.p);
  const unplaced = regions.filter(g => g.v > 0 && !hubOf(g.name));
  const maxShare = Math.max(1, ...placed.map(x => x.g.share || 0));
  const r = sh => 5 + Math.sqrt((sh || 0) / maxShare) * 34;
  // Крупные кружки рисуем первыми, чтобы мелкие были сверху и кликались.
  const order = [...placed].sort((a, b) => (b.g.share || 0) - (a.g.share || 0));
  return (
    <div className="a-card" style={{ padding: 14 }}>
      <div className="a-bar" style={{ marginBottom: 6 }}>
        <b style={{ fontSize: 14 }}>Карта кластеров доставки</b>
        <span className="a-hint">размер кружка — доля {metric === 'revenue' ? 'суммы заказов' : 'заказов'}; клик — подробности по кластеру</span>
      </div>
      <svg viewBox={`0 0 ${RU_MAP.w} ${RU_MAP.h}`} style={{ width: '100%', height: 'auto', display: 'block' }} onMouseLeave={tip.hide}>
        {RU_MAP.regions.map(rg => (
          <path key={rg.n} d={rg.d} className="g-region" onMouseMove={e => tip.show(e, <div>{rg.n}</div>)} />
        ))}
        {order.map(({ g, p }) => (
          <g key={g.i} style={{ cursor: 'pointer' }} onClick={() => onPick(g)}
            onMouseMove={e => tip.show(e, <div><b>{g.name}</b><div>{pct1(g.share)} · {fmtInt(g.v)} {metric === 'revenue' ? '₽' : 'шт'}</div>{g.delta !== null && <div style={{ color: 'var(--a-ink3)' }}>к прошлому периоду: {g.delta > 0 ? '+' : ''}{g.delta.toFixed(1).replace('.', ',')} п.п.</div>}</div>)}>
            <circle cx={p[0]} cy={p[1]} r={r(g.share)} className={`g-bubble ${selected === g.i ? 'on' : ''}`} />
            {(g.share || 0) >= 2 && <text x={p[0]} y={p[1] + 4} textAnchor="middle" className="g-blabel">{pct1(g.share)}</text>}
          </g>
        ))}
      </svg>
      {unplaced.length > 0 && <div className="a-hint" style={{ marginTop: 6 }}>Без точки на карте: {unplaced.map(g => `${g.name} (${pct1(g.share)})`).join(', ')}</div>}
    </div>
  );
}

export default function Geography({ cabinet }) {
  const today = dayjs().format('YYYY-MM-DD');
  const [dateFrom, setDateFrom] = useState(dayjs().subtract(29, 'day').format('YYYY-MM-DD'));
  const [dateTo, setDateTo] = useState(today);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState('');
  const [brand, setBrand] = useState('');
  const [search, setSearch] = useState('');
  const [metric, setMetric] = useState('revenue');
  const [open, setOpen] = useState(() => new Set());
  const [region, setRegion] = useState(null);
  const [mDim, setMDim] = useState('cat');
  const tip = useTip();

  const load = useCallback(() => {
    setLoading(true); setError(null);
    getSalesGeo(cabinet, { dateFrom, dateTo, compare: 1 })
      .then(r => setData(r.data.data))
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, [cabinet, dateFrom, dateTo]);
  useEffect(() => { load(); }, [load]);

  const arts = useMemo(() => (data?.articles || []).map(a => ({ ...a, parts: a.cat.split(SEP), short: shortModel(a.n) || a.n })), [data]);
  // Категории верхнего уровня в том же порядке и с теми же цветами, что в «Аналитике продаж».
  const topCats = useMemo(() => {
    const rank = new Map((data?.order || []).map((x, i) => [x, i]));
    const names = [...new Set(arts.map(a => a.parts[0]))];
    return names.sort((x, y) => ((rank.has(x) ? rank.get(x) : 1e6) - (rank.has(y) ? rank.get(y) : 1e6)) || naturalCompare(x, y));
  }, [arts, data]);
  const childrenOf = useCallback(path => {
    const depth = path ? path.split(SEP).length : 0;
    const rank = new Map((data?.order || []).map((x, i) => [x, i]));
    const names = new Set();
    for (const a of arts) if (!path || a.cat === path || a.cat.startsWith(path + SEP)) { if (a.parts[depth]) names.add(a.parts[depth]); }
    return [...names].sort((x, y) => ((rank.has(x) ? rank.get(x) : 1e6) - (rank.has(y) ? rank.get(y) : 1e6)) || naturalCompare(x, y));
  }, [arts, data]);

  const val = useCallback(r => metric === 'revenue' ? r[4] : r[3], [metric]);
  const pval = useCallback(r => metric === 'revenue' ? r[3] : r[2], [metric]);

  const view = useMemo(() => {
    if (!data) return null;
    const q = search.trim().toLowerCase();
    const inSel = arts.map(a => (!sel || a.cat === sel || a.cat.startsWith(sel + SEP)) && (!brand || (a.brand || NO_BRAND) === brand)
      && (!q || a.o.toLowerCase().includes(q) || a.n.toLowerCase().includes(q)));
    const filtered = !!(sel || brand || q);
    const R = data.regions.length;
    const cur = new Float64Array(R), all = new Float64Array(R), prev = new Float64Array(R), qty = new Float64Array(R), rev = new Float64Array(R), canc = new Float64Array(R);
    let tot = 0, totAll = 0, totPrev = 0, tq = 0, tr = 0, tc = 0;
    for (const r of data.rows) {
      const v = val(r);
      all[r[1]] += v; totAll += v;
      if (!inSel[r[0]]) continue;
      cur[r[1]] += v; tot += v; qty[r[1]] += r[3]; rev[r[1]] += r[4]; canc[r[1]] += r[5];
      tq += r[3]; tr += r[4]; tc += r[5];
    }
    for (const r of data.prev || []) if (inSel[r[0]]) { prev[r[1]] += pval(r); totPrev += pval(r); }
    const regions = data.regions.map((g, i) => {
      const share = tot ? cur[i] / tot * 100 : null;
      const pshare = totPrev ? prev[i] / totPrev * 100 : null;
      const shareAll = totAll ? all[i] / totAll * 100 : null;
      return {
        i, name: g.name, district: g.district, v: cur[i], qty: qty[i], rev: rev[i], canc: canc[i], share, pshare,
        delta: share !== null && pshare !== null && prev[i] > 0 ? share - pshare : null,
        index: filtered && share !== null && shareAll ? share / shareAll : null,
      };
    }).filter(g => g.v > 0 || g.canc > 0).sort((x, y) => y.v - x.v);
    const byDistrict = new Map();
    for (const g of regions) {
      if (!byDistrict.has(g.district)) byDistrict.set(g.district, { name: g.district, regions: [], v: 0, pv: 0, va: 0, qty: 0, rev: 0, canc: 0 });
      const d = byDistrict.get(g.district);
      d.regions.push(g); d.v += g.v; d.qty += g.qty; d.rev += g.rev; d.canc += g.canc; d.pv += prev[g.i]; d.va += all[g.i];
    }
    const districts = [...byDistrict.values()].map(d => {
      const share = tot ? d.v / tot * 100 : null, pshare = totPrev ? d.pv / totPrev * 100 : null;
      return { ...d, share, pshare, delta: share !== null && pshare !== null && d.pv > 0 ? share - pshare : null, index: filtered && share !== null && totAll ? share / (d.va / totAll * 100) : null };
    }).sort((x, y) => y.v - x.v);
    return { inSel, filtered, regions, districts, tot, totPrev, tq, tr, tc };
  }, [data, arts, sel, brand, search, val, pval]);

  if (loading && !data) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Загрузка…</div></div>;
  if (error && !data) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Не удалось загрузить: {error} <button className="a-btn" onClick={load}>Повторить</button></div></div>;

  const noData = !data.rows.length;
  const crumbsParts = sel ? sel.split(SEP) : [];
  const kidNames = childrenOf(sel);
  const topSlot = name => topCats.indexOf(name);
  const brandsList = (() => {
    const m = new Map();
    for (const r of data.rows) { const a = arts[r[0]]; const b = a.brand || NO_BRAND; m.set(b, (m.get(b) || 0) + r[4]); }
    return [...m.entries()].filter(([b]) => b !== NO_BRAND).sort((x, y) => y[1] - x[1]).map(([b]) => b);
  })();
  const brandRank = new Map(brandsList.slice(0, 6).map((b, i) => [b, i]));

  // ── Разрез «регион × …»: доля каждой колонки в продажах региона ──
  const mCols = (() => {
    if (mDim === 'origin') {
      const list = [...ORIGINS.map(o => o[0]), 'Другие', NO_BRAND];
      return list.map((name, i) => ({ key: name, name, color: CAT_COLORS[i] || OTHER, test: a => (a.brand ? (ORIGIN_OF.get(a.brand) || 'Другие') : NO_BRAND) === name }));
    }
    if (mDim === 'brand') {
      const top = brandsList.filter(b => {
        let s = 0; for (const r of data.rows) if (view.inSel[r[0]] && arts[r[0]].brand === b) s += r[4]; return s > 0;
      }).slice(0, 8);
      const cols = top.map(b => ({ key: b, name: b, color: CAT_COLORS[brandRank.get(b)] || OTHER, test: a => a.brand === b }));
      cols.push({ key: '__rest', name: 'Остальные', color: OTHER, test: a => !top.includes(a.brand) });
      return cols;
    }
    const depth = crumbsParts.length;
    const names = kidNames.length ? kidNames : [crumbsParts[crumbsParts.length - 1] || 'Все'];
    return names.map((name, i) => ({
      key: name, name, color: depth === 0 ? (CAT_COLORS[topSlot(name)] || OTHER) : (CAT_COLORS[i] || OTHER),
      test: a => !kidNames.length || a.parts[depth] === name,
    }));
  })();
  const matrix = (() => {
    const top = view.regions.slice(0, 20);
    const C = mCols.length;
    const cell = new Map(top.map(g => [g.i, new Float64Array(C)]));
    const colTot = new Float64Array(C);
    const artCol = arts.map(a => mCols.findIndex(c => c.test(a)));
    for (const r of data.rows) {
      if (!view.inSel[r[0]]) continue;
      const c = artCol[r[0]]; if (c < 0) continue;
      const v = val(r);
      colTot[c] += v;
      const row = cell.get(r[1]); if (row) row[c] += v;
    }
    const tot = colTot.reduce((s, v) => s + v, 0);
    return { top, cell, colShare: [...colTot].map(v => tot ? v / tot * 100 : 0) };
  })();

  // ── Регион подробно ──
  const regionInfo = region === null ? null : (() => {
    const g = view.regions.find(x => x.i === region) || { name: data.regions[region]?.name, v: 0 };
    const byArt = new Map(), byCity = new Map(), byKid = new Map(), byBrand = new Map();
    const depth = crumbsParts.length;
    for (const r of data.rows) {
      if (r[1] !== region || !view.inSel[r[0]]) continue;
      const v = val(r), a = arts[r[0]];
      byArt.set(r[0], (byArt.get(r[0]) || 0) + v);
      const c = data.cities[r[2]] || 'Город не указан';
      byCity.set(c, (byCity.get(c) || 0) + v);
      const k = a.parts[depth] || a.parts[a.parts.length - 1];
      byKid.set(k, (byKid.get(k) || 0) + v);
      const b = a.brand || NO_BRAND;
      byBrand.set(b, (byBrand.get(b) || 0) + v);
    }
    const sorted = m => [...m.entries()].sort((x, y) => y[1] - x[1]);
    return { g, arts: sorted(byArt).slice(0, 15), cities: sorted(byCity).slice(0, 15), kids: sorted(byKid), brands: sorted(byBrand).slice(0, 10) };
  })();

  // ── Динамика долей по округам (по всему кабинету) ──
  const weekly = (() => {
    if (!data.days.length) return null;
    const buckets = bucketsOf(data.dates, data.dates.length > 45 ? 'week' : 'day');
    const N = data.dates.length;
    const groups = view.districts.slice(0, 6).map((d, i) => {
      const s = { revenue: new Float64Array(N), orders: new Float64Array(N) };
      for (const r of data.days) if (data.regions[r[0]].district === d.name) { s.revenue[r[1]] += r[3]; s.orders[r[1]] += r[2]; }
      return { key: d.name, name: d.name, color: CAT_COLORS[i], ag: { s } };
    });
    return { buckets, groups, gran: data.dates.length > 45 ? 'week' : 'day' };
  })();

  const fmtV = v => metric === 'revenue' ? fmtInt(v) : fmtInt(v);
  const moscow = view.regions.filter(g => /москв/i.test(g.name)).reduce((s, g) => s + g.v, 0);
  const top5 = view.regions.slice(0, 5).reduce((s, g) => s + g.v, 0);
  const periodBtn = n => {
    const f = dayjs().subtract(n - 1, 'day').format('YYYY-MM-DD');
    return <button key={n} type="button" className={dateFrom === f && dateTo === today ? 'on' : ''} onClick={() => { setDateFrom(f); setDateTo(today); }}>{n} дн</button>;
  };
  const toggle = k => setOpen(p => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const regionRow = (g, depth) => (
    <tr key={'r' + g.i} className={`row ${region === g.i ? 'open' : ''}`} onClick={() => setRegion(region === g.i ? null : g.i)}>
      <td><div className="a-art" style={{ paddingLeft: depth * 16 }}><span className="a-chev">▶</span>{g.name}</div></td>
      <td className="n r">{fmtV(g.v)}</td>
      <td className="r"><span className="s-part"><i style={{ width: `${Math.min(100, (g.share || 0) * 3)}%` }} /><b className="n">{pct1(g.share)}</b></span></td>
      <td className="r"><Delta value={g.delta} unit="pp" goodWhen="neutral" title={`Доля в прошлом периоде: ${pct1(g.pshare)}`} /></td>
      <td className="n r">{fmtInt(g.qty)}</td>
      <td className="n r">{g.qty ? fmtInt(g.rev / g.qty) : '—'}</td>
      <td className="n r">{g.qty + g.canc ? pct1(g.canc / (g.qty + g.canc) * 100) : '—'}</td>
      <td className="r">{view.filtered ? <IndexPill v={g.index} /> : <span className="muted">—</span>}</td>
    </tr>
  );

  return (
    <div className="mpui sa-page">
      <div className="page-sticky">
        <div className="a-top">
          <h1>География продаж</h1>
          <span className="a-seg">{[7, 14, 30, 45].map(periodBtn)}</span>
          <DateRangePicker from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t); }} />
          {brandsList.length > 0 && (
            <select className="a-sel" value={brand} onChange={e => setBrand(e.target.value)}>
              <option value="">Все марки авто</option>
              {brandsList.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          )}
          <input className="a-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Артикул или название" style={{ minWidth: 200 }} />
          <span className="a-seg">{[['revenue', 'по сумме'], ['orders', 'по штукам']].map(([k, l]) => <button key={k} type="button" className={metric === k ? 'on' : ''} onClick={() => setMetric(k)}>{l}</button>)}</span>
          {loading && <span className="a-hint">обновляем…</span>}
        </div>
        <div className="a-bar">
          <div className="a-tabs">
            <button type="button" className={`a-tab ${!sel ? 'on' : ''}`} onClick={() => setSel('')}>Все</button>
            {topCats.map(c => (
              <button key={c} type="button" className={`a-tab ${sel === c || sel.startsWith(c + SEP) ? 'on' : ''}`} onClick={() => setSel(c)}>
                <i className="s-dot" style={{ background: CAT_COLORS[topSlot(c)] || OTHER }} />{c}
              </button>
            ))}
          </div>
        </div>
        {sel && (
          <div className="a-bar s-crumbs">
            <button type="button" className="s-crumb" onClick={() => setSel('')}>Все</button>
            {crumbsParts.map((c, i) => (
              <React.Fragment key={i}>
                <span className="a-hint">›</span>
                <button type="button" className={`s-crumb ${i === crumbsParts.length - 1 ? 'on' : ''}`} onClick={() => setSel(crumbsParts.slice(0, i + 1).join(SEP))}>{c}</button>
              </React.Fragment>
            ))}
            {kidNames.length > 0 && <span className="a-hint" style={{ marginLeft: 8 }}>подкатегории:</span>}
            {kidNames.map((k, i) => <button key={k} type="button" className="s-chip" onClick={() => setSel(sel + SEP + k)}><i className="s-dot" style={{ background: CAT_COLORS[i] || OTHER }} />{k}</button>)}
          </div>
        )}
      </div>

      {noData ? (
        <div className="a-card" style={{ padding: 24, lineHeight: 1.6 }}>
          <b>Данных о регионах пока нет.</b><br />
          Регион и город доставки берутся из заказов Ozon. Их собирает Google-скрипт во вкладку «GeoOrders»:
          вставьте обновлённый скрипт, запустите <code>setupTriggers</code> и один раз <code>syncGeoFull</code> (заполнит последние 45 дней).
          Дальше скрипт обновляет данные каждые 3 часа, сервис подхватывает их сам.
        </div>
      ) : (
        <>
          <div className={`a-kpis s-kpis ${loading ? 'a-loading' : ''}`}>
            <div className="a-kpi"><span className="lbl">{metric === 'revenue' ? 'Заказано, ₽' : 'Заказы, шт'}</span><span className="val n">{fmtV(view.tot)}</span>
              <span className="sub"><Delta value={view.totPrev ? (view.tot - view.totPrev) / view.totPrev * 100 : null} /> к прошлому периоду</span></div>
            <div className="a-kpi"><span className="lbl">Кластеров с заказами</span><span className="val n">{view.regions.filter(g => g.v > 0).length}</span>
              <span className="sub">{view.districts.length} округов и стран</span></div>
            <div className="a-kpi"><span className="lbl">Москва и область</span><span className="val n">{pct1(view.tot ? moscow / view.tot * 100 : null)}</span>
              <span className="sub">доля в выбранном</span></div>
            <div className="a-kpi"><span className="lbl">Топ-5 кластеров</span><span className="val n">{pct1(view.tot ? top5 / view.tot * 100 : null)}</span>
              <span className="sub">{view.regions.slice(0, 3).map(g => g.name).join(', ')}</span></div>
          </div>

          <ClusterMap regions={view.regions} tot={view.tot} metric={metric} tip={tip} selected={region}
            onPick={g => { setOpen(p => new Set(p).add(g.district)); setRegion(region === g.i ? null : g.i); }} />

          <div className={`a-card ${loading ? 'a-loading' : ''}`}>
            <div className="a-bar" style={{ padding: '12px 14px 0' }}>
              <b style={{ fontSize: 14 }}>Округа и кластеры доставки</b>
              <span className="a-hint">клик по округу — кластеры, по кластеру — что там покупают{view.filtered ? ' · индекс > 1 — выбранное здесь продаётся лучше, чем в среднем по стране' : ''}</span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button type="button" className="a-btn ghost" onClick={() => setOpen(new Set(view.districts.map(d => d.name)))}>Раскрыть всё</button>
                <button type="button" className="a-btn ghost" onClick={() => setOpen(new Set())}>Свернуть</button>
              </span>
            </div>
            <div className="a-scroll">
              <table className="a-t s-tree">
                <thead><tr>
                  <th>Округ / кластер</th><th className="r">{metric === 'revenue' ? 'Заказано, ₽' : 'Заказы, шт'}</th><th className="r">Доля</th><th className="r">Δ доли</th>
                  <th className="r">Заказы, шт</th><th className="r">Ср. чек</th><th className="r">Отмены</th><th className="r" title="Доля региона в выбранных товарах ÷ его доля во всех продажах">Индекс</th>
                </tr></thead>
                <tbody>
                  {view.districts.map(d => (
                    <React.Fragment key={d.name}>
                      <tr className={`row s-cat d0 ${open.has(d.name) ? 'open' : ''}`} onClick={() => toggle(d.name)}>
                        <td><div className="a-art"><span className="a-chev">▶</span><span className="s-cname">{d.name}</span><span className="a-hint">{d.regions.length}</span></div></td>
                        <td className="n r">{fmtV(d.v)}</td>
                        <td className="r"><span className="s-part"><i style={{ width: `${Math.min(100, d.share || 0)}%` }} /><b className="n">{pct1(d.share)}</b></span></td>
                        <td className="r"><Delta value={d.delta} unit="pp" goodWhen="neutral" /></td>
                        <td className="n r">{fmtInt(d.qty)}</td>
                        <td className="n r">{d.qty ? fmtInt(d.rev / d.qty) : '—'}</td>
                        <td className="n r">{d.qty + d.canc ? pct1(d.canc / (d.qty + d.canc) * 100) : '—'}</td>
                        <td className="r">{view.filtered ? <IndexPill v={d.index} /> : <span className="muted">—</span>}</td>
                      </tr>
                      {open.has(d.name) && d.regions.map(g => (
                        <React.Fragment key={g.i}>
                          {regionRow(g, 1)}
                          {region === g.i && regionInfo && (
                            <tr className="a-detail"><td colSpan={8}>
                              <div className="a-dwrap" style={{ gridTemplateColumns: 'repeat(2, minmax(0,1fr))' }}>
                                {[['Что покупают', regionInfo.kids], ['Марки авто', regionInfo.brands]].map(([title, list]) => (
                                  <div key={title} className="a-box">
                                    <h4>{title}</h4>
                                    {list.map(([name, v]) => (
                                      <div key={name} className="g-line"><span>{name}</span><span className="s-part"><i style={{ width: `${regionInfo.g.v ? Math.min(100, v / regionInfo.g.v * 100) : 0}%` }} /><b className="n">{pct1(regionInfo.g.v ? v / regionInfo.g.v * 100 : null)}</b></span></div>
                                    ))}
                                  </div>
                                ))}
                                <div className="a-box wide">
                                  <h4>Топ артикулов в регионе</h4>
                                  <table className="a-t s-slice"><thead><tr><th>Артикул</th><th>Категория</th><th className="r">{metric === 'revenue' ? 'Заказано, ₽' : 'Заказы, шт'}</th><th className="r">Доля</th></tr></thead>
                                    <tbody>{regionInfo.arts.map(([ai, v]) => (
                                      <tr key={ai}><td><div className="a-art"><div style={{ minWidth: 0 }}><div className="id">{arts[ai].o}</div><div className="model" title={arts[ai].n}>{arts[ai].short}</div></div></div></td>
                                        <td className="a-hint">{arts[ai].cat}</td><td className="n r">{fmtV(v)}</td><td className="n r">{pct1(regionInfo.g.v ? v / regionInfo.g.v * 100 : null)}</td></tr>
                                    ))}</tbody></table>
                                </div>
                              </div>
                            </td></tr>
                          )}
                        </React.Fragment>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="a-card" style={{ padding: 14 }}>
            <div className="a-bar" style={{ marginBottom: 10 }}>
              <b style={{ fontSize: 14 }}>Что где покупают · топ-20 кластеров</b>
              <span className="a-seg">{[['cat', kidNames.length ? 'Подкатегории' : 'Категория'], ['origin', 'Страна марки'], ['brand', 'Марки авто']].filter(([k]) => cabinet === 'defly' || k === 'cat').map(([k, l]) => (
                <button key={k} type="button" className={mDim === k ? 'on' : ''} onClick={() => setMDim(k)}>{l}</button>
              ))}</span>
              <span className="a-hint">в клетке — доля в продажах региона; цвет — выше (зелёный) или ниже (красный) среднего по стране</span>
            </div>
            <div className="a-days">
              <table className="a-dt a-matrix">
                <thead><tr><th className="lbl">Кластер</th><th className="tot">Всего</th>
                  {mCols.map((c, ci) => matrix.colShare[ci] > 0 ? <th key={c.key}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><i className="s-dot" style={{ background: c.color }} />{c.name}</span></th> : null)}
                </tr></thead>
                <tbody>
                  <tr><td className="lbl" style={{ fontWeight: 600 }}>По стране</td><td className="tot">{fmtV(view.tot)}</td>
                    {mCols.map((c, ci) => matrix.colShare[ci] > 0 ? <td key={c.key} style={{ fontWeight: 600 }}>{pct1(matrix.colShare[ci])}</td> : null)}</tr>
                  {matrix.top.map(g => {
                    const row = matrix.cell.get(g.i);
                    const rt = row.reduce((s, v) => s + v, 0);
                    return (
                      <tr key={g.i}>
                        <td className="lbl" style={{ cursor: 'pointer' }} onClick={() => { setOpen(p => new Set(p).add(g.district)); setRegion(g.i); }}>{g.name}</td>
                        <td className="tot">{fmtV(g.v)}</td>
                        {mCols.map((c, ci) => {
                          if (!(matrix.colShare[ci] > 0)) return null;
                          const sh = rt ? row[ci] / rt * 100 : 0;
                          const idx = matrix.colShare[ci] ? sh / matrix.colShare[ci] : 1;
                          const t = Math.max(-1, Math.min(1, Math.log2(idx || 0.01)));
                          const bg = row[ci] ? `hsla(${t > 0 ? 130 : 8}, 60%, 45%, ${Math.abs(t) * 0.38})` : 'transparent';
                          return <td key={c.key} style={{ background: bg }} title={`${c.name} в регионе: ${pct1(sh)} (по стране ${pct1(matrix.colShare[ci])}), индекс ${idx.toFixed(2).replace('.', ',')}`}>{row[ci] ? pct1(sh) : '—'}</td>;
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {weekly && (
            <div className="a-card" style={{ padding: 14 }}>
              <div className="a-bar" style={{ marginBottom: 6 }}>
                <b style={{ fontSize: 14 }}>Доли округов по {weekly.gran === 'week' ? 'неделям' : 'дням'}</b>
                <span className="a-hint">по всему кабинету, без фильтров; каждый столбец — 100%</span>
              </div>
              <StackChart buckets={weekly.buckets} groups={weekly.groups} metric={metric} tip={tip} gran={weekly.gran} normalize />
            </div>
          )}
          {data.available?.min && <div className="a-hint">Данные о регионах есть с {dayjs(data.available.min).format('DD.MM.YYYY')}.</div>}
        </>
      )}
      {tip.node}
    </div>
  );
}
