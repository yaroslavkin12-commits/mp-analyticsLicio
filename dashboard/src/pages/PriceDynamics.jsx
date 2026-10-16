import React, { useState, useEffect, useMemo } from 'react';
import dayjs from 'dayjs';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine } from 'recharts';
import { getPriceDynamics } from '../api';
import { fmtInt } from './AdsStats2';

// ─────────────────────────────────────────────────────────────────────────
// «Динамика цен»: как меняются цена клиента (её держит репрайсер — меняем мы)
// и цена реализации (двигается и от скидки Ozon) по категориям и артикулам.
// Категория — индекс: у каждого артикула цена на первый день = 100%, дальше
// среднее по артикулам. Артикул — сами цены в рублях. Данные копятся каждый
// день (price_daily), поэтому история начинается с момента включения.
// ─────────────────────────────────────────────────────────────────────────
const SEP = ' / ';
const DAYS = [[30, '30 дн'], [90, '90 дн'], [180, '180 дн']];
const pctS = v => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1).replace('.', ',')}%`);
const cls = v => (v > 0.05 ? 's-up' : v < -0.05 ? 's-down' : 'muted');

function LegendDot({ color, dashed, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--a-ink2)' }}>
      <svg width="22" height="8"><line x1="1" y1="4" x2="21" y2="4" stroke={color} strokeWidth="2" strokeDasharray={dashed ? '4 3' : undefined} /></svg>{label}
    </span>
  );
}

export default function PriceDynamics({ cabinet, catOf, snaps }) {
  const [days, setDays] = useState(90);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState(''); // путь категории
  const [art, setArt] = useState(null); // артикул
  const [q, setQ] = useState(''); // поиск артикула — по всем категориям
  useEffect(() => {
    setData(null); setErr('');
    getPriceDynamics(cabinet, days).then(r => setData(r.data.data)).catch(e => setErr(e.response?.data?.error || e.message));
  }, [cabinet, days]);

  // Плотные ряды по дням (с переносом последнего значения вперёд).
  const dense = useMemo(() => {
    if (!data) return null;
    const D = data.days, out = new Map();
    for (const [o, pts] of Object.entries(data.items)) {
      const s = new Array(D).fill(null), c = new Array(D).fill(null);
      let k = 0, ls = null, lc = null;
      for (let d = 0; d < D; d++) {
        while (k < pts.length && pts[k][0] <= d) { if (pts[k][1] !== null) ls = pts[k][1]; if (pts[k][2] !== null) lc = pts[k][2]; k++; }
        s[d] = ls; c[d] = lc;
      }
      out.set(o, { s, c });
    }
    return out;
  }, [data]);
  const dates = useMemo(() => (data ? Array.from({ length: data.days }, (_, i) => dayjs(data.from).add(i, 'day').format('YYYY-MM-DD')) : []), [data]);
  // Первый день, когда есть хоть одна цена — график начинается с него.
  const firstIdx = useMemo(() => {
    if (!dense) return 0;
    let m = Infinity;
    for (const { c, s } of dense.values()) { const i = c.findIndex((v, k) => v !== null || s[k] !== null); if (i >= 0 && i < m) m = i; }
    return Number.isFinite(m) ? m : 0;
  }, [dense]);
  const lastIdx = useMemo(() => {
    if (!dense) return -1;
    let m = -1;
    for (const { c, s } of dense.values()) for (let d = c.length - 1; d > m; d--) if (c[d] !== null || s[d] !== null) { m = d; break; }
    return m;
  }, [dense]);

  const inSel = o => { const c = catOf.get(o) || 'Без категории'; return !sel || c === sel || c.startsWith(sel + SEP); };
  const offers = useMemo(() => (dense ? [...dense.keys()].filter(inSel) : []), [dense, sel, catOf]); // eslint-disable-line react-hooks/exhaustive-deps

  // Изменение за окно: средний % по артикулам, у которых есть цена в начале и в конце.
  const change = (list, key, w) => {
    let sum = 0, n = 0;
    for (const o of list) {
      const arr = dense.get(o)[key];
      const end = arr[lastIdx]; if (!end) continue;
      let i0 = w === 'all' ? 0 : Math.max(0, lastIdx - w);
      while (i0 < lastIdx && arr[i0] === null) i0++;
      const st = arr[i0]; if (!st || i0 >= lastIdx) continue;
      sum += (end / st - 1) * 100; n++;
    }
    return n ? sum / n : null;
  };
  // Сколько артикулов сдвинули цену клиента на ≥ 1,5% за 30 дней (вверх / вниз).
  const moved = list => {
    let up = 0, dn = 0;
    for (const o of list) {
      const c = dense.get(o).c, end = c[lastIdx]; if (!end) continue;
      let i0 = Math.max(0, lastIdx - 30); while (i0 < lastIdx && c[i0] === null) i0++;
      const st = c[i0]; if (!st || i0 >= lastIdx) continue;
      const p = end / st - 1; if (p >= 0.015) up++; else if (p <= -0.015) dn++;
    }
    return { up, dn };
  };

  // Индекс категории по дням.
  const series = useMemo(() => {
    if (!dense || lastIdx < 0) return [];
    if (art) {
      const x = dense.get(art); if (!x) return [];
      return dates.slice(firstIdx, lastIdx + 1).map((d, j) => { const i = j + firstIdx; return { d, c: x.c[i], s: x.s[i] }; });
    }
    const base = new Map();
    for (const o of offers) {
      const x = dense.get(o);
      const ic = x.c.findIndex(v => v !== null), is = x.s.findIndex(v => v !== null);
      base.set(o, { c: ic >= 0 ? x.c[ic] : null, s: is >= 0 ? x.s[is] : null });
    }
    return dates.slice(firstIdx, lastIdx + 1).map((d, j) => {
      const i = j + firstIdx;
      let sc = 0, nc = 0, ss = 0, ns = 0;
      for (const o of offers) {
        const x = dense.get(o), b = base.get(o);
        if (x.c[i] !== null && b.c) { sc += x.c[i] / b.c; nc++; }
        if (x.s[i] !== null && b.s) { ss += x.s[i] / b.s; ns++; }
      }
      return { d, c: nc ? sc / nc * 100 : null, s: ns ? ss / ns * 100 : null, n: nc };
    });
  }, [dense, offers, art, dates, lastIdx, firstIdx]);

  // Строки таблицы: подкатегории или артикулы.
  const rows = useMemo(() => {
    if (!dense || lastIdx < 0) return [];
    const qq = q.trim().toLowerCase();
    if (qq) {
      const found = [...dense.keys()].filter(o => o.toLowerCase().includes(qq)).slice(0, 300);
      return found.map(o => ({ key: o, label: o, list: [o], isArt: true, n: 1,
        c7: change([o], 'c', 7), c30: change([o], 'c', 30), cAll: change([o], 'c', 'all'),
        s7: change([o], 's', 7), s30: change([o], 's', 30), sAll: change([o], 's', 'all'), mv: moved([o]) }));
    }
    const depth = sel ? sel.split(SEP).length : 0;
    const groups = new Map(), leafArts = [];
    for (const o of offers) {
      const c = catOf.get(o) || 'Без категории', parts = c.split(SEP);
      if (parts.length > depth) {
        const key = parts.slice(0, depth + 1).join(SEP);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(o);
      } else leafArts.push(o);
    }
    const mk = (key, label, list, isArt) => ({ key, label, list, isArt, n: list.length,
      c7: change(list, 'c', 7), c30: change(list, 'c', 30), cAll: change(list, 'c', 'all'),
      s7: change(list, 's', 7), s30: change(list, 's', 30), sAll: change(list, 's', 'all'), mv: moved(list) });
    const out = [...groups.entries()].map(([k, l]) => mk(k, k.split(SEP).pop(), l, false)).sort((a, b) => b.n - a.n);
    // На нижнем уровне — артикулы (сначала с наибольшим изменением цены клиента за 30 дней).
    const arts = (groups.size ? leafArts : offers).map(o => mk(o, o, [o], true));
    arts.sort((a, b) => Math.abs(b.c30 ?? 0) - Math.abs(a.c30 ?? 0));
    return groups.size ? [...out, ...arts] : arts;
  }, [dense, offers, sel, catOf, lastIdx, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const [full, setFull] = useState(false);
  useEffect(() => { setFull(false); }, [sel]);

  if (err) return <div className="a-card pr-card"><div className="a-empty" style={{ padding: 20 }}>Не удалось загрузить: {err}</div></div>;
  if (!data || !dense) return <div className="a-card pr-card"><div className="a-empty" style={{ padding: 20, textAlign: 'center' }}>Загрузка…</div></div>;

  const crumbs = sel ? sel.split(SEP) : [];
  const nDays = lastIdx >= 0 ? lastIdx - (series.findIndex(x => x.c !== null || x.s !== null)) + 1 : 0;
  const snapDays = new Set((snaps || []).map(s => s.date));
  const marks = art ? (snaps || []).filter(s => s.date >= dates[0] && s.date <= dates[lastIdx]).map(s => s.date) : [];
  const ttFmt = (v, name) => [art ? `${fmtInt(v)} ₽` : `${v.toFixed(1).replace('.', ',')}%`, name];
  const vis = full ? rows : rows.slice(0, 40);

  return (
    <>
      <div className="a-card pr-card">
        <div className="a-bar" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          <span className="pl-crumbs">
            <button type="button" className={`s-chip ${!sel && !art ? 'on' : ''}`} onClick={() => { setSel(''); setArt(null); }}>Все товары</button>
            {crumbs.map((c, i) => <React.Fragment key={i}><span className="muted">›</span><button type="button" className={`s-chip ${i === crumbs.length - 1 && !art ? 'on' : ''}`} onClick={() => { setSel(crumbs.slice(0, i + 1).join(SEP)); setArt(null); }}>{c}</button></React.Fragment>)}
            {art && <><span className="muted">›</span><span className="s-chip on">{art}</span></>}
          </span>
          <input className="a-input" placeholder="Артикул" value={q} onChange={e => { setQ(e.target.value); setArt(null); }} style={{ minWidth: 180 }} title="Найти артикул по всем категориям" />
          <span className="a-seg" style={{ marginLeft: 'auto' }}>{DAYS.map(([d, t]) => <button key={d} type="button" className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{t}</button>)}</span>
        </div>
        <div className="a-hint" style={{ margin: '0 0 8px' }}>
          {art ? 'Цены артикула по дням. Пунктир по вертикали — загрузки «Журнала цен».'
            : `Индекс цен: у каждого артикула цена в первый день наблюдения = 100%, линия — среднее по ${fmtInt(offers.length)} арт. Цена клиента меняется, когда цену меняем мы (её держит репрайсер); цена реализации двигается и от скидки Ozon.`}
          {nDays > 0 && nDays < 14 ? ` Данных пока ${nDays} дн — цены по дням копятся с ${dayjs(series.find(x => x.c !== null || x.s !== null)?.d).format('DD.MM')}.` : ''}
        </div>
        {lastIdx < 0 ? <div className="a-empty" style={{ padding: 30, textAlign: 'center' }}>Цены по дням ещё не накопились — они записываются при каждой проверке цен на сайте.</div> : (
          <>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={series} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--a-line)" vertical={false} />
                <XAxis dataKey="d" tickFormatter={d => `${d.slice(8)}.${d.slice(5, 7)}`} stroke="var(--a-ink3)" fontSize={11} tickLine={false} axisLine={{ stroke: 'var(--a-line)' }} minTickGap={30} />
                <YAxis stroke="var(--a-ink3)" fontSize={11} tickLine={false} axisLine={false} width={art ? 60 : 48} domain={['auto', 'auto']}
                  tickFormatter={v => (art ? (v >= 1000 ? `${(v / 1000).toFixed(1).replace('.', ',')}k` : Math.round(v)) : `${Math.round(v)}%`)} />
                <Tooltip formatter={ttFmt} labelFormatter={d => dayjs(d).format('DD.MM.YYYY') + (snapDays.has(d) ? ' · журнал цен' : '')}
                  contentStyle={{ background: 'var(--a-panel)', border: '1px solid var(--a-line2)', borderRadius: 8, fontSize: 12 }} />
                {!art && <ReferenceLine y={100} stroke="var(--a-line2)" />}
                {marks.map(d => <ReferenceLine key={d} x={d} stroke="var(--a-ink3)" strokeDasharray="2 3" />)}
                <Line type="stepAfter" dataKey="s" name="Цена реализации" stroke="var(--a-ink3)" strokeWidth={2} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls />
                <Line type="stepAfter" dataKey="c" name="Цена клиента" stroke="var(--accent-oz)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
            <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
              <LegendDot color="var(--accent-oz)" label="Цена клиента" />
              <LegendDot color="var(--a-ink3)" dashed label="Цена реализации" />
            </div>
          </>
        )}
      </div>

      {!art && lastIdx >= 0 && (
        <div className="a-card pr-card">
          <div className="a-scroll">
            <table className="a-t pr-t">
              <thead>
                <tr>
                  <th className="l" rowSpan={2}>{rows.some(r => !r.isArt) ? 'Категория / артикул' : 'Артикул'}</th>
                  <th className="r" rowSpan={2}>Арт.</th>
                  <th colSpan={3} className="r" style={{ borderBottom: 0 }}>Цена клиента</th>
                  <th colSpan={3} className="r" style={{ borderBottom: 0 }}>Цена реализации</th>
                  <th className="r" rowSpan={2} title="Сколько артикулов сдвинули цену клиента на 1,5% и больше за 30 дней">Меняли цену клиента, 30 дн</th>
                </tr>
                <tr><th className="r" style={{ textAlign: "right" }}>7 дн</th><th className="r">30 дн</th><th className="r">с начала</th><th className="r">7 дн</th><th className="r">30 дн</th><th className="r">с начала</th></tr>
              </thead>
              <tbody>
                {vis.map(r => (
                  <tr key={r.key} className="pl-click" onClick={() => (r.isArt ? (setArt(r.key), q && (setQ(''), setSel(catOf.get(r.key) || ''))) : setSel(r.key))}>
                    <td>{r.isArt ? <div className="a-art"><div style={{ minWidth: 0 }}><div className="id">{r.key}</div><div className="model">{(catOf.get(r.key) || '').split(SEP).pop()}</div></div></div> : <b>{r.label} ›</b>}</td>
                    <td className="n r">{r.isArt ? '' : fmtInt(r.n)}</td>
                    <td className="n r"><span className={cls(r.c7)}>{pctS(r.c7)}</span></td>
                    <td className="n r"><span className={cls(r.c30)}>{pctS(r.c30)}</span></td>
                    <td className="n r"><span className={cls(r.cAll)}>{pctS(r.cAll)}</span></td>
                    <td className="n r muted">{pctS(r.s7)}</td>
                    <td className="n r muted">{pctS(r.s30)}</td>
                    <td className="n r muted">{pctS(r.sAll)}</td>
                    <td className="n r">{r.mv.up || r.mv.dn ? <>{r.mv.up ? <span className="s-up">↑{r.mv.up}</span> : null}{r.mv.up && r.mv.dn ? ' ' : ''}{r.mv.dn ? <span className="s-down">↓{r.mv.dn}</span> : null}</> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 40 && <button type="button" className="s-fold" onClick={() => setFull(f => !f)}>{full ? 'Свернуть ▲' : `Показать все ${rows.length} ▼`}</button>}
        </div>
      )}
    </>
  );
}
