import React, { useState, useEffect, useMemo, useCallback } from 'react';
import dayjs from 'dayjs';
import { getFinancePnl, getFinanceOps, latestOnly } from '../api';
import { fmtInt, useTip, DualChart, CAT_COLORS } from './AdsStats2';
import { useCats, useGroups, FinHeader, RowsTable, CatTable, Kpi, Empty, inPath, matchQ, pct1, money, useTax, TaxInput, useBuyerShare } from './finShared';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// «P&L» — по факту: выкупы и все начисления/списания Ozon по дню операции
// (комиссия, логистика, эквайринг, хранение, баллы и прочее), реклама — по
// дню списания, себестоимость выкупленного и налог. Начисления без
// артикула (хранение, подписки и т. п.) в «Все» идут целиком, в отборе —
// пропорционально доле его выкупов.
// ─────────────────────────────────────────────────────────────────────────

const B = ['sale', 'return', 'commission', 'acquiring', 'logistics', 'storage', 'promo', 'other', 'ads'];
const COST_KEYS = ['commission', 'logistics', 'acquiring', 'storage', 'promo', 'other'];
const LABEL = {
  sale: 'Выкупы', return: 'Возвраты', commission: 'Комиссия Ozon', logistics: 'Логистика', acquiring: 'Эквайринг',
  storage: 'Хранение и размещение', promo: 'Подписки, отзывы, баллы', other: 'Прочие услуги и удержания',
};
const ROWS = [
  { block: 'Выручка', tone: 'rev' },
  { key: 'sale', label: 'Выкупы, ₽', fmt: 'int', good: 'up' },
  { key: 'return', label: 'Возвраты, ₽', fmt: 'money0', good: 'neutral', sub: true, signed: true },
  { key: 'revenue', label: 'Выручка, ₽', fmt: 'int', good: 'up', strong: true },
  { key: 'qty', label: 'Выкуплено, шт', fmt: 'int', good: 'up', sub: true },
  { block: 'Расходы Ozon (по факту списания)', tone: 'spend' },
  ...COST_KEYS.map(k => ({ key: k, label: LABEL[k], fmt: 'money0', good: 'neutral', sub: true, signed: true })),
  { key: 'ads', label: 'Реклама (оплата за клик и за заказ)', fmt: 'money0', good: 'neutral', sub: true, signed: true, hint: 'Ozon удерживает рекламу из перечисления, поэтому она здесь. Сумма — по начислениям Ozon, по дню списания: оплата за заказ списывается в день выкупа заказа (во вкладке «Реклама» она стоит в дне заказа, поэтому по дням суммы не совпадают). За последние дни, которые Ozon ещё не провёл в начислениях (обычно 1–2 дня), — расход из рекламного кабинета' },
  { key: 'ozon', label: 'Итого расходы Ozon', fmt: 'money0', good: 'neutral', signed: true, strong: true },
  { key: 'payout', label: 'К перечислению от Ozon', fmt: 'int', good: 'up', hint: 'Выручка минус все удержания Ozon, включая рекламу' },
  { block: 'Свои расходы', tone: 'traffic' },
  { key: 'cost', label: 'Себестоимость выкупленного', fmt: 'money0', good: 'neutral', signed: true },
  { key: 'taxBase', label: 'Оплачено покупателями (налоговая база), ₽', fmt: 'int', good: 'neutral', sub: true, hint: 'Сколько из выручки заплатили сами покупатели — цена после скидки Ozon (баллов за скидки), за вычетом возвратов. От этой суммы считается налог (письмо ФНС от 02.09.2026 № СД-35-3/11693@). Доля — по отчёту «Начисления», загруженному в «Сверку»' },
  { key: 'tax', label: 'Налог', fmt: 'money0', good: 'neutral', signed: true, hint: 'Ставка × налоговая база' },
  { block: 'Результат', tone: 'conv' },
  { key: 'profit', label: 'Прибыль, ₽', fmt: 'int', good: 'up', strong: true, signed: true },
  { key: 'margin', label: 'Маржа, %', fmt: 'pct', good: 'up', hint: 'Прибыль / выручка' },
  { key: 'drr', label: 'ДРР факт, %', fmt: 'pct', good: 'down', hint: 'ДРР фактический: списания на рекламу (по начислениям Ozon) / выручка по выкупам (выкупы − возвраты). В «Цены и маржа» и калькуляторе — ДРР прогнозный: реклама / (заказы × % выкупа)' },
];
const METRICS = [
  { key: 'revenue', label: 'Выручка, ₽', fmt: 'int' },
  { key: 'profit', label: 'Прибыль, ₽', fmt: 'int', free: true },
  { key: 'margin', label: 'Маржа, %', fmt: 'pct', free: true },
  { key: 'payout', label: 'К перечислению, ₽', fmt: 'int' },
  { key: 'ozonAbs', label: 'Расходы Ozon, ₽', fmt: 'int' },
  { key: 'adsAbs', label: 'Реклама, ₽', fmt: 'int' },
  { key: 'qty', label: 'Выкуплено, шт', fmt: 'int' },
];

// Статьи, которые можно расшифровать до операций Ozon.
const DRILL = new Set(['commission', 'logistics', 'acquiring', 'storage', 'promo', 'other', 'ads', 'return']);
function OpsDrill({ cabinet, drill, dates, dateFrom, dateTo, arts, filtered, selName, shareOf, onClose }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null);
  useEffect(() => {
    setRows(null); setErr('');
    getFinanceOps(cabinet, drill.bucket, { dateFrom, dateTo }).then(r => setRows(r.data.data.rows)).catch(e => setErr(e.response?.data?.error || e.message));
  }, [cabinet, drill.bucket, dateFrom, dateTo]);
  useEffect(() => { const on = e => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on); }, [onClose]);
  const mine = useMemo(() => new Set(arts.map(a => a.o)), [arts]);
  const nameOf = useMemo(() => new Map(arts.map(a => [a.o, a.n])), [arts]);
  const view = useMemo(() => {
    if (!rows) return null;
    const by = new Map();
    let sumArt = 0, sumNo = 0;
    for (const [d, name, o, a] of rows) {
      if (drill.i !== null && d !== drill.i) continue;
      if (o && filtered && !mine.has(o)) continue;
      let x = by.get(name); if (!x) { x = { name, art: 0, no: 0, items: new Map(), days: new Set() }; by.set(name, x); }
      x.days.add(d);
      if (o) { x.art += a; sumArt += a; x.items.set(o, (x.items.get(o) || 0) + a); } else { x.no += a; sumNo += a; }
    }
    return { list: [...by.values()].sort((p, q2) => (p.art + p.no) - (q2.art + q2.no)), sumArt, sumNo };
  }, [rows, drill, filtered, mine]);
  const when = drill.i === null ? `${dayjs(dates[0]).format('DD.MM')}–${dayjs(dates.at(-1)).format('DD.MM')}` : dayjs(dates[drill.i]).format('DD.MM.YYYY');
  const rub = v => `${fmtInt(v)} ₽`;
  return (
    <div className="f-drill-bg" onClick={onClose}>
      <div className="f-drill" onClick={e => e.stopPropagation()}>
        <div className="f-drill-h"><b>{(LABEL[drill.bucket] || '').replaceAll('Ozon',cabinet==='defly_wb'?'WB':'Ozon') || (drill.bucket === 'ads' ? 'Реклама' : drill.bucket === 'return' ? 'Возвраты' : drill.bucket)}</b><span>{when} · {selName}</span><button type="button" className="a-btn ghost" onClick={onClose}>✕</button></div>
        {err && <div className="c-msg bad">{err}</div>}
        {!view && !err && <div className="a-hint">Загрузка операций {cabinet==='defly_wb'?'WB':'Ozon'}…</div>}
        {view && !view.list.length && <div className="a-hint">Операций нет.</div>}
        {view && view.list.length > 0 && (
          <>
            <table className="f-drill-t">
              <thead><tr><th>Операция {cabinet==='defly_wb'?'WB':'Ozon'} (как в начислениях)</th><th className="r">По артикулам</th><th className="r">Без артикула</th><th className="r">Артикулов</th></tr></thead>
              <tbody>
                {view.list.map(x => (
                  <React.Fragment key={x.name}>
                    <tr className={x.items.size ? 'f-click' : ''} onClick={x.items.size ? () => setOpen(open === x.name ? null : x.name) : undefined}>
                      <td>{x.items.size ? <span className="f-chev">{open === x.name ? '▼' : '▶'}</span> : <span className="f-chev" />}{x.name}</td>
                      <td className="r n">{x.art ? rub(x.art) : '—'}</td>
                      <td className="r n">{x.no ? rub(x.no) : '—'}</td>
                      <td className="r n">{x.items.size || '—'}</td>
                    </tr>
                    {open === x.name && [...x.items.entries()].sort((p, q2) => p[1] - q2[1]).slice(0, 60).map(([o, a]) => (
                      <tr key={o} className="f-drill-sub"><td title={nameOf.get(o) || ''}>{o}<span className="muted"> {String(nameOf.get(o) || '').slice(0, 60)}</span></td><td className="r n">{rub(a)}</td><td /><td /></tr>
                    ))}
                  </React.Fragment>
                ))}
              </tbody>
              <tfoot><tr><td>Итого</td><td className="r n">{rub(view.sumArt)}</td><td className="r n">{rub(view.sumNo)}</td><td /></tr></tfoot>
            </table>
            {view.sumNo !== 0 && (
              <div className="a-hint" style={{ marginTop: 8 }}>
                «Без артикула» — {cabinet==='defly_wb'?'WB':'Ozon'} списал на весь кабинет, без привязки к товару. В P&L такие суммы делятся по доле выручки дня{filtered ? `: на «${selName}» за период пришлось ≈${(shareOf * 100).toFixed(1).replace('.', ',')}% — поэтому в выбранной категории статья может вырасти, даже если по её товарам ничего не списывали` : ''}.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function PnL({ cabinet }) {
  const today = dayjs().format('YYYY-MM-DD');
  const [dateFrom, setDateFrom] = useState(dayjs().subtract(29, 'day').format('YYYY-MM-DD'));
  const [dateTo, setDateTo] = useState(today);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState('');
  const [search, setSearch] = useState('');
  const [tax] = useTax(cabinet);
  const tip = useTip();
  // «На 1 выкуп»: все суммы таблицы делятся на число выкупленных штук (за день / за период).
  const [perUnit, setPerUnitRaw] = useState(() => { try { return localStorage.getItem('mp-pnl-perunit') === '1'; } catch (e) { return false; } });
  const setPerUnit = v => { setPerUnitRaw(v); try { localStorage.setItem('mp-pnl-perunit', v ? '1' : '0'); } catch (e) { /* ignore */ } };
  // «В % от выручки»: выручка по выкупам = 100%, каждая статья — её доля (по дням и за период).
  const [pctMode, setPctRaw] = useState(() => { try { return localStorage.getItem('mp-pnl-pct') === '1'; } catch (e) { return false; } });
  const setPct = v => { setPctRaw(v); if (v) setPerUnit(false); try { localStorage.setItem('mp-pnl-pct', v ? '1' : '0'); } catch (e) { /* ignore */ } };
  const setUnit = v => { setPerUnit(v); if (v) setPctRaw(false); };
  const grp = useGroups(cabinet);
  // Расшифровка статьи: из каких операций Ozon она состоит (клик по ячейке).
  const [drill, setDrill] = useState(null);

  const load = useCallback(() => {
    setLoading(true); setError(null);
    const ok = latestOnly('pnl:' + cabinet);
    getFinancePnl(cabinet, { dateFrom, dateTo })
      .then(ok(r => setData(r.data.data)))
      .catch(ok(e => setError(e.response?.data?.error || e.message)))
      .finally(ok(() => setLoading(false)));
  }, [cabinet, dateFrom, dateTo]);
  useEffect(() => { load(); }, [load]);

  const cats = useCats(data?.articles, data?.order);
  const bs = useBuyerShare(cabinet, cats.arts);
  const n = data?.dates.length || 0;
  const per = useMemo(() => {
    if (!data) return [];
    const P = cats.arts.map(() => null);
    const get = ai => P[ai] || (P[ai] = { b: B.map(() => new Float64Array(n)), qty: new Float64Array(n), ads: new Float64Array(n), self: new Float64Array(n), taxBase: new Float64Array(n) });
    for (const [ai, d, bi, a, q] of data.rows) {
      const x = get(ai), k = data.buckets[bi], j = B.indexOf(k);
      x.b[j < 0 ? 7 : j][d] += a;
      if (k === 'sale') x.qty[d] += Math.abs(q); else if (k === 'return') x.qty[d] -= Math.abs(q);
    }
    for (const [ai, d, v] of data.ads) get(ai).ads[d] += v;
    // Самовыкупы — себестоимость за эти штуки не вычитается (товар остаётся у нас).
    for (const [ai, d, q] of data.self || []) get(ai).self[d] += q;
    for(const [ai,d,v] of data.taxBase || []) get(ai).taxBase[d]+=v;
    return P;
  }, [data, cats.arts, n]);
  // Реклама: если Ozon списывает её в начислениях (PayPerClick и т. п.) —
  // берём оттуда, это и есть день списания; иначе — из рекламного кабинета.
  // Последний день, за который Ozon уже провёл рекламу в начислениях. Дальше
  // (обычно 1–2 последних дня) рекламы в начислениях ещё нет — берём расход
  // рекламного кабинета, иначе прибыль за свежие дни завышена.
  const lastFin = useMemo(() => {
    if (!data) return -1;
    const ai = data.buckets.indexOf('ads');
    let m = -1;
    for (const r of data.rows) if (r[2] === ai && r[3]) m = Math.max(m, r[1]);
    for (const [d, b, a] of data.noSku) if (b === ai && a) m = Math.max(m, d);
    return m;
  }, [data]);

  // Выручка (выкупы − возвраты) всех товаров по дням — для деления начислений без артикула.
  const netDayAll = useMemo(() => { const v = new Float64Array(n); for (const x of per) if (x) for (let i = 0; i < n; i++) v[i] += x.b[0][i] + x.b[1][i]; return v; }, [per, n]);
  const totalSale = useMemo(() => netDayAll.reduce((s, v) => s + v, 0), [netDayAll]);
  // Расход рекламного кабинета всех товаров за период — реклама из начислений
  // без артикула делится по нему: сколько артикул реально потратил, столько и несёт.
  const adsAll = useMemo(() => { let s = 0; for (const x of per) if (x) for (let i = 0; i < n; i++) s += x.ads[i]; return s; }, [per, n]);
  const q = search.trim().toLowerCase();
  const list = useMemo(() => ({ q, arts: cats.arts.filter(a => per[a.i] && inPath(a, sel) && matchQ(a, q) && grp.test(a)) }), [cats.arts, per, sel, q, grp.test]);
  const filtered = !!(sel || q || grp.sel);

  // Строки P&L по дням для набора артикулов. share — доля начислений без
  // артикула, которую относим на этот набор.
  const calc = useCallback((items, share) => {
    const v = {};
    for (const k of B) v[k] = new Float64Array(n);
    v.qty = new Float64Array(n); v.adsRaw = new Float64Array(n); v.costRaw = new Float64Array(n); v.taxBase = new Float64Array(n);
    let noCost = 0;
    for (const a of items) {
      const x = per[a.i]; if (!x) continue;
      const cp = data.cost[a.i];
      // База налога — то, что заплатил покупатель (доля цены после скидки Ozon).
      // Доля — по отчёту «Начисления» того периода, куда попадает день.
      const shD = bs.shareAt ? data.dates.map(d => bs.shareAt(a.o, a.parts, d) ?? 1) : null;
      const iSale = B.indexOf('sale'), iRet = B.indexOf('return');
      let sold = 0;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < B.length; j++) v[B[j]][i] += x.b[j][i];
        v.qty[i] += x.qty[i]; v.adsRaw[i] += x.ads[i]; sold += x.qty[i];
        v.taxBase[i] += data.taxBase ? x.taxBase[i] : (x.b[iSale][i] + x.b[iRet][i]) * (shD ? shD[i] : 1);
        if (cp) v.costRaw[i] += cp * (x.qty[i] - x.self[i]);
      }
      if (!cp && sold > 0) noCost++;
    }
    if (share > 0) {
      // Начисления без артикула — по дням, пропорционально выручке дня
      // (как в «Аналитике продаж» и «Среднем чеке»); в день без выручки — по доле за период.
      const sh = share === 1 ? () => 1 : d => (netDayAll[d] > 0 ? (v.sale[d] + v.return[d]) / netDayAll[d] : share);
      const shD = Array.from({ length: n }, (_, d) => sh(d));
      // Реклама без артикула («оплата за клик» и т. п.) — по доле в расходе
      // рекламного кабинета за период (нет рекламы в кабинете — по выручке).
      let selAds = 0; for (let i = 0; i < n; i++) selAds += v.adsRaw[i];
      const adSh = share === 1 ? 1 : adsAll > 0 ? selAds / adsAll : null;
      for (const [d, bi, a] of data.noSku) { const k = data.buckets[bi]; v[B.includes(k) ? k : 'other'][d] += a * (k === 'ads' && adSh !== null ? adSh : shD[d]); }
      data.adNoSku.forEach((a, d) => { v.adsRaw[d] += a * shD[d]; });
    }
    const out = { ...v, revenue: [], ozon: [], ozonX: [], payout: [], ads: [], cost: [], tax: [], profit: [], margin: [], drr: [], ozonAbs: [], adsAbs: [] };
    for (let i = 0; i < n; i++) {
      const rev = v.sale[i] + v.return[i];
      const ozX = COST_KEYS.reduce((s, k) => s + v[k][i], 0);
      // Реклама — часть удержаний Ozon: по начислениям, а за ещё не проведённые дни — из кабинета.
      const ad = data.financeSource === 'wb' || i <= lastFin ? v.ads[i] : -v.adsRaw[i];
      const oz = ozX + ad;
      const t = v.taxBase[i] > 0 ? -v.taxBase[i] * tax / 100 : 0;
      const p = rev + oz - v.costRaw[i] + t;
      out.revenue.push(rev); out.ozon.push(oz); out.ozonX.push(ozX); out.payout.push(rev + oz); out.ads.push(ad); out.cost.push(-v.costRaw[i]);
      out.tax.push(t); out.profit.push(p); out.margin.push(rev > 0 ? p / rev * 100 : null); out.drr.push(rev > 0 ? -ad / rev * 100 : null);
      out.ozonAbs.push(-ozX); out.adsAbs.push(-ad);
    }
    if(data.financeSource === 'wb') data.dates.forEach((date,i)=>{if(date<data.available.mn||date>data.available.mx)for(const a of Object.values(out))if(a.length===n)a[i]=NaN;});
    const sum = arr => { let s = 0; for (let i = 0; i < n; i++) s += arr[i] || 0; return s; };
    const T = {};
    for (const k of [...B, 'qty', 'taxBase', 'revenue', 'ozon', 'ozonX', 'payout', 'ads', 'cost', 'tax', 'profit', 'ozonAbs', 'adsAbs']) T[k] = sum(out[k]);
    T.margin = T.revenue > 0 ? T.profit / T.revenue * 100 : null;
    T.drr = T.revenue > 0 ? -T.ads / T.revenue * 100 : null;
    T.roi = T.cost < 0 ? T.profit / -T.cost * 100 : null;
    return { vals: out, totals: T, noCost };
  }, [per, n, data, tax, lastFin, bs.shareAt, netDayAll, adsAll]);

  const shareOf = useCallback(items => {
    if (!filtered && items === list.arts) return 1;
    let s = 0; for (const a of items) { const x = per[a.i]; if (x) for (let i = 0; i < n; i++) s += x.b[0][i] + x.b[1][i]; }
    return totalSale > 0 ? s / totalSale : 0;
  }, [filtered, list, per, n, totalSale]);

  const main = useMemo(() => (data ? calc(list.arts, shareOf(list.arts)) : null), [data, calc, list, shareOf]);
  const aggOf = useCallback(items => {
    const { totals: t } = calc(items, shareOf(items));
    return { revenue: t.revenue, ozon: 0 - t.ozonX, ozonPct: t.revenue > 0 ? -t.ozonX / t.revenue * 100 : null, ads: 0 - t.ads, cost: 0 - t.cost, profit: t.profit, margin: t.margin, qty: t.qty };
  }, [calc, shareOf]);

  if (loading && !data) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Загрузка…</div></div>;
  if (error && !data) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Не удалось загрузить: {error} <button className="a-btn" onClick={load}>Повторить</button></div></div>;

  const dates = data.dates;
  const { vals, totals: T, noCost } = main;
  const KEEP = new Set(['qty', 'margin', 'drr']);
  const perQ = (v, q) => (v === null || v === undefined || !(q > 0) ? null : v / q);
  const perR = (v, r) => (v === null || v === undefined || !(r > 0) ? null : v / r * 100);
  const shownVals = perUnit ? Object.fromEntries(ROWS.filter(r => r.key).map(r => [r.key, KEEP.has(r.key) ? vals[r.key] : Array.from(vals[r.key] || [], (x, i) => perQ(x, vals.qty[i]))]))
    : pctMode ? Object.fromEntries(ROWS.filter(r => r.key).map(r => [r.key, KEEP.has(r.key) ? vals[r.key] : Array.from(vals[r.key] || [], (x, i) => perR(x, vals.revenue[i]))])) : vals;
  const shownT = perUnit ? Object.fromEntries(ROWS.filter(r => r.key).map(r => [r.key, KEEP.has(r.key) ? T[r.key] : perQ(T[r.key], T.qty)]))
    : pctMode ? Object.fromEntries(ROWS.filter(r => r.key).map(r => [r.key, KEEP.has(r.key) ? T[r.key] : perR(T[r.key], T.revenue)])) : T;
  // В процентах: подписи без «₽», расходы подсвечиваются — меньше доля (ближе к нулю) лучше.
  const formatRows = pctMode ? ROWS.map(r => (!r.key || KEEP.has(r.key) ? r : { ...r, fmt: r.fmt === 'money0' ? 'pct0' : 'pct', label: r.label.replace(/, ₽$/, ', %'), good: r.signed ? 'up' : r.good })) : ROWS;
  const shownRows = data._wb ? formatRows.map(r=>({...r,label:r.label?.replaceAll('Ozon','WB'),block:r.block?.replaceAll('Ozon','WB'),hint:r.key==='ads'?'Списания «WB Продвижение» из ежедневного отчёта. Комиссия и эквайринг повторно не вычитаются.':r.key==='taxBase'?'Оплата покупателями из поля retailAmount, за вычетом возвратов.':r.hint?.replaceAll('Ozon','WB')})) : formatRows;
  const byDate = {};
  dates.forEach((d, i) => { byDate[d] = {}; for (const m of METRICS) byDate[d][m.key] = vals[m.key][i]; });
  const strip = [
    ...COST_KEYS.map((k, i) => ({ k, name: data._wb?LABEL[k].replaceAll('Ozon','WB'):LABEL[k], v: -T[k], color: CAT_COLORS[i] || 'var(--a-ink3)' })),
    { k: 'ads', name: 'Реклама', v: -T.ads, color: 'var(--a-spend)' },
    { k: 'cost', name: 'Себестоимость', v: -T.cost, color: 'var(--a-ink3)' },
    { k: 'tax', name: 'Налог', v: -T.tax, color: 'var(--a-line2)' },
  ].filter(s => s.v > 0);
  const cols = [
    { key: 'revenue', label: 'Выручка', fmt: 'int' },
    { key: 'qty', label: 'Выкуплено, шт', fmt: 'int' },
    { key: 'ozon', label: 'Расходы Ozon', fmt: 'int' },
    { key: 'ozonPct', label: '% от выручки', fmt: 'pct' },
    { key: 'ads', label: 'Реклама', fmt: 'int' },
    { key: 'cost', label: 'Себестоимость', fmt: 'int' },
    { key: 'profit', label: 'Прибыль', fmt: 'int' },
    { key: 'margin', label: 'Маржа', fmt: 'pct' },
  ];

  return (
    <div className="mpui sa-page">
      <FinHeader grp={grp} title="P&L" cats={cats} sel={sel} setSel={setSel} search={search} setSearch={setSearch}
        dateFrom={dateFrom} dateTo={dateTo} setRange={(f, t) => { setDateFrom(f); setDateTo(t); }} loading={loading}>
        <TaxInput tax={tax} cabinet={cabinet} />
      </FinHeader>

      {data.financeSource === 'wb' && <div className="a-hint" style={{margin:'10px 0'}}>Финансы WB по {dayjs(data.available.mx).format('DD.MM.YYYY')} · суммы к перечислению по отчёту, без повторного вычета комиссии и эквайринга. Дни вне выгрузки не входят в итог.</div>}
      {!data.rows.length && !data.noSku.length ? (
        <Empty>
          <b>Финансовых данных пока нет.</b><br />
          Начисления и списания Ozon собирает Google-скрипт во вкладку «Finance»: вставьте обновлённый скрипт,
          запустите <code>setupTriggers</code> и один раз <code>syncFinanceFull</code> (последние 30 дней). Дальше обновление каждые 6 часов.
        </Empty>
      ) : (
        <>
          <div className={`a-kpis s-kpis ${loading ? 'a-loading' : ''}`}>
            <Kpi label="Выручка" value={money(T.revenue)} sub={`${fmtInt(T.qty)} шт выкуплено`} />
            <Kpi label={data._wb?'Расходы WB без рекламы':'Расходы Ozon без рекламы'} value={money(-T.ozonX)} sub={`${pct1(T.revenue > 0 ? -T.ozonX / T.revenue * 100 : null)} от выручки`} />
            <Kpi label="Реклама" value={money(-T.ads)} sub={`${pct1(T.drr)} от выручки`} />
            <Kpi label="Прибыль" value={<span className={T.profit < 0 ? 's-down' : ''}>{money(T.profit)}</span>} sub={`маржа ${pct1(T.margin)} · ROI ${pct1(T.roi)}`} />
          </div>
          {noCost > 0 && <div className="c-msg bad">У {noCost} арт. с выкупами нет себестоимости — прибыль по ним завышена. {cabinet === 'licio' ? 'Заполните в «Настройки → Себестоимость».' : 'Заполните во вкладке «Себестоимость».'}</div>}
          {filtered && <div className="a-hint">Начисления без артикула (хранение, подписки и т. п.) распределены пропорционально выкупам, реклама без привязки к товару — по расходу рекламного кабинета: на выбранное — {pct1(shareOf(list.arts) * 100)}.</div>}

          {T.revenue > 0 && strip.length > 0 && (
            <div className="a-card s-card">
              <div className="a-bar" style={{ marginBottom: 8 }}><b style={{ fontSize: 14 }}>Куда уходит выручка</b><span className="a-hint">доля от выручки; остаток — прибыль {pct1(T.margin)}</span></div>
              <div className="s-strip">
                {strip.map(s => (
                  <div key={s.k} style={{ flex: s.v, background: s.color }} onMouseMove={e => tip.show(e, <div><b>{s.name}</b><div>{money(s.v)} · {pct1(s.v / T.revenue * 100)}</div></div>)} onMouseLeave={tip.hide}>
                    {s.v / T.revenue >= 0.05 && <span>{pct1(s.v / T.revenue * 100)}</span>}
                  </div>
                ))}
                {T.profit > 0 && <div style={{ flex: T.profit, background: 'var(--a-good)' }}><span>{pct1(T.margin)}</span></div>}
              </div>
              <div className="s-legend">{strip.map(s => <span key={s.k}><i style={{ background: s.color }} />{s.name}</span>)}{T.profit > 0 && <span><i style={{ background: 'var(--a-good)' }} />Прибыль</span>}</div>
            </div>
          )}

          <div className={`a-card s-card ${loading ? 'a-loading' : ''}`}>
            <DualChart dates={dates} byDate={byDate} tip={tip} events={[]} metricsList={METRICS} storeKey="mp-pnl-chart" defaults={{ left: 'revenue', right: 'profit', type: 'combo' }} />
          </div>

          <div className="a-card">
            <div className="a-bar" style={{ padding: '12px 14px 8px' }}>
              <b style={{ fontSize: 14 }}>P&L по дням{perUnit ? ' · на 1 выкуп, ₽' : pctMode ? ' · в % от выручки' : ''}</b>
              <label className="sw" title="Показать каждую статью в среднем на одну выкупленную штуку: сумма за день (период) / выкуплено штук за день (период)">
                <input type="checkbox" checked={perUnit} onChange={e => setUnit(e.target.checked)} /><i />на 1 выкуп
              </label>
              <label className="sw" title="Выручка по выкупам (выкупы − возвраты) = 100%; каждая статья — её доля от выручки за день и за период. Цвет: зелёнее — расход меньше обычного">
                <input type="checkbox" checked={pctMode} onChange={e => setPct(e.target.checked)} /><i />в % от выручки
              </label>
              <span className="a-hint">по дате начисления в {data._wb?'WB':'Ozon'}; данные есть с {data.available?.mn ? dayjs(data.available.mn).format('DD.MM.YYYY') : '—'}</span>
            </div>
            <RowsTable dates={dates} rows={shownRows} vals={shownVals} totals={shownT} clickable={DRILL} onCell={(k, i) => setDrill({ bucket: k, i })} />
          </div>

          <CatTable cats={cats} sel={sel} setSel={setSel} list={list} cols={cols} aggOf={aggOf} sortKey="revenue" />
          {drill && <OpsDrill cabinet={cabinet} drill={drill} dates={dates} dateFrom={dateFrom} dateTo={dateTo} arts={list.arts} filtered={filtered}
            selName={sel ? sel.split(' / ').pop() : q ? `поиск «${search}»` : grp.sel ? 'группа' : 'весь кабинет'} shareOf={shareOf(list.arts)} onClose={() => setDrill(null)} />}
        </>
      )}
      {tip.node}
    </div>
  );
}
