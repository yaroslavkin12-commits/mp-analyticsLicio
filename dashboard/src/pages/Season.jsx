import React, { useState, useEffect, useMemo } from 'react';
import dayjs from 'dayjs';
import { getSeason } from '../api';
import { fmtInt, useTip, ChartPane, niceScale, CAT_COLORS, Delta } from './AdsStats2';
import { useCats, useGroups, FinHeader, Kpi, Empty, inPath, matchQ, SEP, OTHER } from './finShared';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// «Сезонность» — продажи по месяцам за 2 года (аналитика Ozon).
//   Индекс сезонности месяца = продажи месяца / средний месяц того же
//   года (1,0 — обычный месяц, 1,5 — на 50% выше среднего); если лет
//   несколько — среднее по годам.
//   Сезон — месяцы с индексом ≥ 1,2; «готовиться к» — за месяц до начала.
//   Прогноз на 3 месяца = тот же месяц прошлого года × рост последних
//   3 месяцев к ним же год назад.
// ─────────────────────────────────────────────────────────────────────────

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const YEAR_COLORS = ['var(--a-ink3)', 'var(--s-c2)', 'var(--a-rev)'];

export default function Season({ cabinet }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState('');
  const [search, setSearch] = useState('');
  const [metric, setMetric] = useState('revenue');
  const tip = useTip();
  const grp = useGroups(cabinet);

  useEffect(() => { setData(null); getSeason(cabinet).then(r => setData(r.data.data)).catch(e => setError(e.response?.data?.error || e.message)); }, [cabinet]);
  const cats = useCats(data?.articles, data?.order);
  const months = data?.months || [];
  const curMonth = dayjs().format('YYYY-MM');

  // Ряды по месяцам для набора артикулов.
  const seriesOf = useMemo(() => {
    if (!data) return () => [];
    const byArt = new Map();
    for (const [ai, mi, rv, o] of data.rows) { if (!byArt.has(ai)) byArt.set(ai, []); byArt.get(ai).push([mi, rv, o]); }
    return arts => {
      const v = new Float64Array(months.length);
      for (const a of arts) for (const [mi, rv, o] of byArt.get(a.i) || []) v[mi] += metric === 'revenue' ? rv : o;
      return v;
    };
  }, [data, months.length, metric]);

  const q = search.trim().toLowerCase();
  const arts = useMemo(() => cats.arts.filter(a => inPath(a, sel) && matchQ(a, q) && grp.test(a)), [cats.arts, sel, q, grp.test]);

  const analyze = v => {
    // По годам: { 2025: [12], 2026: [12] }, текущий месяц неполный — помечаем.
    const years = {};
    months.forEach((m, i) => { const y = m.slice(0, 4), k = Number(m.slice(5, 7)) - 1; (years[y] = years[y] || new Array(12).fill(null))[k] = v[i]; });
    const ys = Object.keys(years).sort();
    // Индекс сезонности: по полным годам/месяцам, кроме текущего неполного.
    const idxSum = new Array(12).fill(0), idxN = new Array(12).fill(0);
    for (const y of ys) {
      const vals = years[y].map((x, k) => (`${y}-${String(k + 1).padStart(2, '0')}` >= curMonth ? null : x));
      const known = vals.filter(x => x !== null);
      if (known.length < 6) continue;
      const avg = known.reduce((s, x) => s + x, 0) / known.length; if (!avg) continue;
      vals.forEach((x, k) => { if (x !== null) { idxSum[k] += x / avg; idxN[k]++; } });
    }
    const index = idxSum.map((s, k) => (idxN[k] ? s / idxN[k] : null));
    // Рост к прошлому году: последние 3 полных месяца.
    const mi = m => months.indexOf(m);
    const last3 = [1, 2, 3].map(k => dayjs().subtract(k, 'month').format('YYYY-MM'));
    let cur = 0, ly = 0;
    for (const m of last3) { const a = mi(m), b = mi(dayjs(m + '-01').subtract(1, 'year').format('YYYY-MM')); if (a >= 0 && b >= 0) { cur += v[a]; ly += v[b]; } }
    const growth = ly > 0 ? cur / ly : null;
    const lastFull = last3[0], lfI = mi(lastFull), lfLY = mi(dayjs(lastFull + '-01').subtract(1, 'year').format('YYYY-MM'));
    const yoyMonth = lfI >= 0 && lfLY >= 0 && v[lfLY] > 0 ? (v[lfI] - v[lfLY]) / v[lfLY] * 100 : null;
    // С начала года к тому же периоду прошлого года (только полные месяцы).
    const y0 = dayjs().format('YYYY'), y1 = String(Number(y0) - 1);
    let ytd = 0, ytdLy = 0;
    for (let k = 0; k < dayjs().month(); k++) { ytd += years[y0]?.[k] || 0; ytdLy += years[y1]?.[k] || 0; }
    // Прогноз: следующие 3 месяца (включая текущий).
    const forecast = [0, 1, 2].map(k => {
      const m = dayjs().add(k, 'month'); const b = mi(m.subtract(1, 'year').format('YYYY-MM'));
      return { m: m.format('YYYY-MM'), v: b >= 0 && growth ? v[b] * growth : null, ly: b >= 0 ? v[b] : null };
    });
    // Сезон: месяцы с индексом ≥ 1,2; начало — первый такой месяц после «обычного».
    const peak = index.map((x, k) => [x, k]).filter(([x]) => x !== null && x >= 1.2).map(([, k]) => k);
    let start = null;
    for (const k of peak) { const prev = index[(k + 11) % 12]; if (prev === null || prev < 1.2) { start = k; break; } }
    return { years, ys, index, growth, yoyMonth, ytd: ytdLy > 0 ? (ytd - ytdLy) / ytdLy * 100 : null, forecast, peak, start, lastFull };
  };

  const total = useMemo(() => analyze(seriesOf(arts)), [arts, seriesOf]); // eslint-disable-line react-hooks/exhaustive-deps
  const depth = sel ? sel.split(SEP).length : 0;
  const kids = q ? [] : cats.childrenOf(sel);
  const kidRows = useMemo(() => kids.map((k, i) => {
    const list = arts.filter(a => a.parts[depth] === k);
    return { k, color: depth === 0 ? (CAT_COLORS[cats.topSlot(k)] || OTHER) : (CAT_COLORS[i] || OTHER), path: (sel ? sel + SEP : '') + k, ...analyze(seriesOf(list)) };
  }), [kids.join('|'), arts, seriesOf]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="mpui"><div className="a-empty" style={{ padding: 40 }}>Не удалось загрузить: {error}</div></div>;
  if (!data) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Загрузка…</div></div>;

  const fmtM = v => (v === null || v === undefined || !Number.isFinite(v) ? '—' : metric === 'revenue' ? `${fmtInt(v)} ₽` : fmtInt(v));
  // График: по месяцам года, линия на каждый год + прогноз пунктиром.
  const axis = MONTHS.map((_, k) => `${dayjs().format('YYYY')}-${String(k + 1).padStart(2, '0')}-01`);
  const ser = total.ys.slice(-3).map((y, i, arr) => ({
    key: y, label: y + (y === dayjs().format('YYYY') ? ' (текущий месяц неполный)' : ''), fmt: 'int', kind: 'line', side: 'left',
    color: YEAR_COLORS[YEAR_COLORS.length - arr.length + i] || 'var(--a-rev)', values: total.years[y].map(v => (v === null ? null : v)),
  }));
  const fcVals = new Array(12).fill(null);
  for (const f of total.forecast) if (f.v !== null && f.m.slice(0, 4) === dayjs().format('YYYY')) fcVals[Number(f.m.slice(5, 7)) - 1] = f.v;
  if (fcVals.some(v => v !== null)) ser.push({ key: 'fc', label: 'Прогноз', fmt: 'int', kind: 'line', side: 'left', color: 'var(--a-spend)', values: fcVals });
  const allV = ser.flatMap(s => s.values).filter(v => v !== null && Number.isFinite(v));
  const sc = niceScale(0, allV.length ? Math.max(...allV) : 1, false);
  ser.forEach(s => { s.scale = sc; });
  const heat = v => (v === null ? 'transparent' : v >= 1 ? `color-mix(in srgb, var(--a-good) ${Math.min(70, (v - 1) * 90)}%, transparent)` : `color-mix(in srgb, var(--a-bad) ${Math.min(60, (1 - v) * 90)}%, transparent)`);
  const seasonTxt = r => (r.start === null ? 'ровный спрос' : `сезон с ${MONTHS[r.start]}, готовиться к ${MONTHS[(r.start + 11) % 12]}`);

  return (
    <div className="mpui sa-page">
      <FinHeader title="Сезонность" cats={cats} sel={sel} setSel={setSel} search={search} setSearch={setSearch} grp={grp}>
        <span className="a-seg">{[['revenue', 'Заказы, ₽'], ['orders', 'Заказы, шт']].map(([k, l]) => <button key={k} type="button" className={metric === k ? 'on' : ''} onClick={() => setMetric(k)}>{l}</button>)}</span>
      </FinHeader>

      {!data.rows.length ? (
        <Empty><b>Истории продаж по месяцам пока нет.</b><br />Её собирает Google-скрипт (функция <code>syncMonthly</code>, вкладка «AnalyticsMonthly»). Вставьте обновлённый скрипт, запустите <code>setupTriggers</code> и один раз <code>syncMonthlyFull</code> — заполнит последние 2 года.</Empty>
      ) : (
        <>
          <div className="a-kpis s-kpis">
            <Kpi label={`${MONTHS[Number(total.lastFull.slice(5, 7)) - 1]} к прошлому году`} value={<Delta value={total.yoyMonth} />} sub="последний полный месяц" />
            <Kpi label="С начала года к прошлому" value={<Delta value={total.ytd} />} sub="полные месяцы" />
            <Kpi label="Сезон" value={total.start === null ? 'ровный' : MONTHS[total.start]} sub={total.start === null ? 'выраженного пика нет' : `пик: ${total.peak.map(k => MONTHS[k]).join(', ')}`} />
            <Kpi label="Прогноз на 3 месяца" value={fmtM(total.forecast.reduce((s, f) => s + (f.v || 0), 0))} sub={total.growth ? `прошлый год × ${total.growth.toFixed(2).replace('.', ',')} (рост за 3 мес)` : 'нет данных прошлого года'} />
          </div>

          <div className="a-card s-card">
            <div className="a-bar" style={{ marginBottom: 6 }}><b style={{ fontSize: 14 }}>По месяцам года</b><span className="a-hint">линия на каждый год; оранжевая — прогноз</span></div>
            <ChartPane dates={axis} series={ser} events={[]} tip={tip} height={240} showX={false} onHover={() => {}} hoverIdx={null} />
            <div className="season-x">{MONTHS.map(m => <span key={m}>{m}</span>)}</div>
            <div className="s-legend">{ser.map(s => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}</div>
          </div>

          <div className="a-card">
            <div className="a-bar" style={{ padding: '12px 14px 4px' }}><b style={{ fontSize: 14 }}>Индекс сезонности по категориям</b><span className="a-hint">1,0 — обычный месяц; зелёный — выше среднего, красный — ниже; клик по категории — внутрь</span></div>
            <div className="a-scroll">
              <table className="a-t s-slice season-t">
                <thead><tr><th>Категория</th>{MONTHS.map((m, k) => <th key={m} className={k === dayjs().month() ? 'cur' : ''}>{m}</th>)}<th className="r">Год к году</th><th className="r">С начала года</th><th>Сезон</th></tr></thead>
                <tbody>
                  {[{ k: sel ? sel.split(SEP).slice(-1)[0] + ' — всего' : 'Все товары', ...total, total: true }, ...kidRows].map(r => (
                    <tr key={r.k} className={r.total ? 's-total' : 'row'} style={{ cursor: r.path ? 'pointer' : 'default' }} onClick={() => r.path && setSel(r.path)}>
                      <td>{!r.total && <i className="s-dot" style={{ background: r.color, marginRight: 8 }} />}<b>{r.k}</b></td>
                      {r.index.map((v, k) => <td key={k} className="n" style={{ background: heat(v), textAlign: 'center' }}>{v === null ? '—' : v.toFixed(1).replace('.', ',')}</td>)}
                      <td className="r"><Delta value={r.yoyMonth} /></td><td className="r"><Delta value={r.ytd} /></td><td className="muted">{seasonTxt(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="a-card">
            <div className="a-bar" style={{ padding: '12px 14px 4px' }}><b style={{ fontSize: 14 }}>Прогноз на 3 месяца</b><span className="a-hint">тот же месяц прошлого года × рост последних 3 месяцев к прошлому году</span></div>
            <table className="a-t s-slice">
              <thead><tr><th>Категория</th>{total.forecast.map(f => <th key={f.m} className="r">{MONTHS[Number(f.m.slice(5, 7)) - 1]} {f.m.slice(0, 4)}</th>)}<th className="r">Рост к прошлому году</th></tr></thead>
              <tbody>
                {[{ k: 'Все выбранные', ...total, total: true }, ...kidRows].map(r => (
                  <tr key={r.k} className={r.total ? 's-total' : ''}>
                    <td><b>{r.k}</b></td>
                    {r.forecast.map(f => <td key={f.m} className="n r" title={`год назад: ${fmtM(f.ly)}`}>{fmtM(f.v)}</td>)}
                    <td className="r">{r.growth ? <Delta value={(r.growth - 1) * 100} /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="a-hint">История с {months[0] ? dayjs(months[0] + '-01').format('MM.YYYY') : '—'} по {months.length ? dayjs(months[months.length - 1] + '-01').format('MM.YYYY') : '—'}.</div>
        </>
      )}
      {tip.node}
    </div>
  );
}
