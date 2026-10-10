import React, { useState, useEffect, useMemo, useCallback } from 'react';
import dayjs from 'dayjs';
import { getFinancePnl } from '../api';
import { fmtInt, useTip, DualChart, CAT_COLORS } from './AdsStats2';
import { useCats, FinHeader, RowsTable, CatTable, Kpi, Empty, inPath, matchQ, pct1, money, useTax, TaxInput } from './finShared';
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
  { key: 'ozon', label: 'Итого расходы Ozon', fmt: 'money0', good: 'neutral', signed: true, strong: true },
  { key: 'payout', label: 'К перечислению от Ozon', fmt: 'int', good: 'up', hint: 'Выручка минус все удержания Ozon' },
  { block: 'Свои расходы', tone: 'traffic' },
  { key: 'ads', label: 'Реклама (по дню списания)', fmt: 'money0', good: 'neutral', signed: true, hint: 'Из начислений Ozon (оплата за клик / за заказ), если они там есть; иначе — расход из рекламного кабинета' },
  { key: 'cost', label: 'Себестоимость выкупленного', fmt: 'money0', good: 'neutral', signed: true },
  { key: 'tax', label: 'Налог', fmt: 'money0', good: 'neutral', signed: true },
  { block: 'Результат', tone: 'conv' },
  { key: 'profit', label: 'Прибыль, ₽', fmt: 'int', good: 'up', strong: true, signed: true },
  { key: 'margin', label: 'Маржа, %', fmt: 'pct', good: 'up', hint: 'Прибыль / выручка' },
  { key: 'drr', label: 'Доля рекламы, %', fmt: 'pct', good: 'down', hint: 'Реклама / выручка' },
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

export default function PnL({ cabinet }) {
  const today = dayjs().format('YYYY-MM-DD');
  const [dateFrom, setDateFrom] = useState(dayjs().subtract(29, 'day').format('YYYY-MM-DD'));
  const [dateTo, setDateTo] = useState(today);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState('');
  const [search, setSearch] = useState('');
  const [tax, setTax] = useTax(cabinet);
  const tip = useTip();

  const load = useCallback(() => {
    setLoading(true); setError(null);
    getFinancePnl(cabinet, { dateFrom, dateTo })
      .then(r => setData(r.data.data))
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, [cabinet, dateFrom, dateTo]);
  useEffect(() => { load(); }, [load]);

  const cats = useCats(data?.articles, data?.order);
  const n = data?.dates.length || 0;
  const per = useMemo(() => {
    if (!data) return [];
    const P = cats.arts.map(() => null);
    const get = ai => P[ai] || (P[ai] = { b: B.map(() => new Float64Array(n)), qty: new Float64Array(n), ads: new Float64Array(n) });
    for (const [ai, d, bi, a, q] of data.rows) {
      const x = get(ai), k = data.buckets[bi], j = B.indexOf(k);
      x.b[j < 0 ? 7 : j][d] += a;
      if (k === 'sale') x.qty[d] += Math.abs(q); else if (k === 'return') x.qty[d] -= Math.abs(q);
    }
    for (const [ai, d, v] of data.ads) get(ai).ads[d] += v;
    return P;
  }, [data, cats.arts, n]);
  // Реклама: если Ozon списывает её в начислениях (PayPerClick и т. п.) —
  // берём оттуда, это и есть день списания; иначе — из рекламного кабинета.
  const finAds = useMemo(() => {
    if (!data) return false;
    const ai = data.buckets.indexOf('ads');
    // Только если списания привязаны к товарам; без SKU (как сейчас у Ozon) —
    // берём расход по товарам из рекламного кабинета, суммы совпадают.
    return data.rows.some(r => r[2] === ai);
  }, [data, cats.arts, n]);

  const totalSale = useMemo(() => per.reduce((s, x) => { if (x) for (let i = 0; i < n; i++) s += x.b[0][i]; return s; }, 0), [per, n]);
  const q = search.trim().toLowerCase();
  const list = useMemo(() => ({ q, arts: cats.arts.filter(a => per[a.i] && inPath(a, sel) && matchQ(a, q)) }), [cats.arts, per, sel, q]);
  const filtered = !!(sel || q);

  // Строки P&L по дням для набора артикулов. share — доля начислений без
  // артикула, которую относим на этот набор.
  const calc = useCallback((items, share) => {
    const v = {};
    for (const k of B) v[k] = new Float64Array(n);
    v.qty = new Float64Array(n); v.adsRaw = new Float64Array(n); v.costRaw = new Float64Array(n);
    let noCost = 0;
    for (const a of items) {
      const x = per[a.i]; if (!x) continue;
      const cp = data.cost[a.i];
      let sold = 0;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < B.length; j++) v[B[j]][i] += x.b[j][i];
        v.qty[i] += x.qty[i]; v.adsRaw[i] += x.ads[i]; sold += x.qty[i];
        if (cp) v.costRaw[i] += cp * x.qty[i];
      }
      if (!cp && sold > 0) noCost++;
    }
    if (share > 0) {
      for (const [d, bi, a] of data.noSku) { const k = data.buckets[bi]; v[B.includes(k) ? k : 'other'][d] += a * share; }
      if (!finAds) data.adNoSku.forEach((a, d) => { v.adsRaw[d] += a * share; });
    }
    if (finAds) for (let i = 0; i < n; i++) v.adsRaw[i] = -v.ads[i];
    const out = { ...v, revenue: [], ozon: [], payout: [], ads: [], cost: [], tax: [], profit: [], margin: [], drr: [], ozonAbs: [], adsAbs: [] };
    for (let i = 0; i < n; i++) {
      const rev = v.sale[i] + v.return[i];
      const oz = COST_KEYS.reduce((s, k) => s + v[k][i], 0);
      const t = rev > 0 ? -rev * tax / 100 : 0;
      const p = rev + oz - v.adsRaw[i] - v.costRaw[i] + t;
      out.revenue.push(rev); out.ozon.push(oz); out.payout.push(rev + oz + (v.ads[i] || 0)); out.ads.push(-v.adsRaw[i]); out.cost.push(-v.costRaw[i]);
      out.tax.push(t); out.profit.push(p); out.margin.push(rev > 0 ? p / rev * 100 : null); out.drr.push(rev > 0 ? v.adsRaw[i] / rev * 100 : null);
      out.ozonAbs.push(-oz); out.adsAbs.push(v.adsRaw[i]);
    }
    const sum = arr => { let s = 0; for (let i = 0; i < n; i++) s += arr[i] || 0; return s; };
    const T = {};
    for (const k of [...B, 'qty', 'revenue', 'ozon', 'payout', 'ads', 'cost', 'tax', 'profit', 'ozonAbs', 'adsAbs']) T[k] = sum(out[k]);
    T.margin = T.revenue > 0 ? T.profit / T.revenue * 100 : null;
    T.drr = T.revenue > 0 ? -T.ads / T.revenue * 100 : null;
    T.roi = T.cost < 0 ? T.profit / -T.cost * 100 : null;
    return { vals: out, totals: T, noCost };
  }, [per, n, data, tax, finAds]);

  const shareOf = useCallback(items => {
    if (!filtered && items === list.arts) return 1;
    let s = 0; for (const a of items) { const x = per[a.i]; if (x) for (let i = 0; i < n; i++) s += x.b[0][i]; }
    return totalSale > 0 ? s / totalSale : 0;
  }, [filtered, list, per, n, totalSale]);

  const main = useMemo(() => (data ? calc(list.arts, shareOf(list.arts)) : null), [data, calc, list, shareOf]);
  const aggOf = useCallback(items => {
    const { totals: t } = calc(items, shareOf(items));
    return { revenue: t.revenue, ozon: 0 - t.ozon, ozonPct: t.revenue > 0 ? -t.ozon / t.revenue * 100 : null, ads: 0 - t.ads, cost: 0 - t.cost, profit: t.profit, margin: t.margin, qty: t.qty };
  }, [calc, shareOf]);

  if (loading && !data) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Загрузка…</div></div>;
  if (error && !data) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Не удалось загрузить: {error} <button className="a-btn" onClick={load}>Повторить</button></div></div>;

  const dates = data.dates;
  const { vals, totals: T, noCost } = main;
  const byDate = {};
  dates.forEach((d, i) => { byDate[d] = {}; for (const m of METRICS) byDate[d][m.key] = vals[m.key][i]; });
  const strip = [
    ...COST_KEYS.map((k, i) => ({ k, name: LABEL[k], v: -T[k], color: CAT_COLORS[i] || 'var(--a-ink3)' })),
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
      <FinHeader title="P&L" cats={cats} sel={sel} setSel={setSel} search={search} setSearch={setSearch}
        dateFrom={dateFrom} dateTo={dateTo} setRange={(f, t) => { setDateFrom(f); setDateTo(t); }} loading={loading}>
        <TaxInput tax={tax} setTax={setTax} />
      </FinHeader>

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
            <Kpi label="Расходы Ozon" value={money(-T.ozon)} sub={`${pct1(T.revenue > 0 ? -T.ozon / T.revenue * 100 : null)} от выручки`} />
            <Kpi label="Реклама" value={money(-T.ads)} sub={`${pct1(T.drr)} от выручки`} />
            <Kpi label="Прибыль" value={<span className={T.profit < 0 ? 's-down' : ''}>{money(T.profit)}</span>} sub={`маржа ${pct1(T.margin)} · ROI ${pct1(T.roi)}`} />
          </div>
          {noCost > 0 && <div className="c-msg bad">У {noCost} арт. с выкупами нет себестоимости — прибыль по ним завышена. Заполните во вкладке «Себестоимость».</div>}
          {filtered && <div className="a-hint">Начисления без артикула (хранение, подписки и т. п.) и реклама без привязки к товару распределены пропорционально выкупам: на выбранное — {pct1(shareOf(list.arts) * 100)}.</div>}

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
              <b style={{ fontSize: 14 }}>P&L по дням</b>
              <span className="a-hint">по дате начисления в Ozon; данные есть с {data.available?.mn ? dayjs(data.available.mn).format('DD.MM.YYYY') : '—'}</span>
            </div>
            <RowsTable dates={dates} rows={ROWS} vals={vals} totals={T} />
          </div>

          <CatTable cats={cats} sel={sel} setSel={setSel} list={list} cols={cols} aggOf={aggOf} sortKey="revenue" />
        </>
      )}
      {tip.node}
    </div>
  );
}
