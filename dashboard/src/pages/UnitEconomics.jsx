import React, { useState, useEffect, useMemo, useCallback } from 'react';
import dayjs from 'dayjs';
import { getSalesData, getFinanceCoefs } from '../api';
import { fmtInt, fmtMoney2, useTip, DualChart } from './AdsStats2';
import { useCats, FinHeader, RowsTable, CatTable, Kpi, Empty, inPath, matchQ, pct1, money, useTax, TaxInput, SEP } from './finShared';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// «Юнит-экономика» — прогноз прибыли от заказов каждого дня по средним за
// последние 30 дней:
//   ожидаемая выручка = заказы ₽ × средний % выкупа артикула;
//   комиссия и эквайринг — их фактическая доля от выкупов (из финансов
//   Ozon; если продаж мало — % комиссии из карточки / среднее категории);
//   логистика — фактическая логистика на 1 заказанную штуку;
//   хранение и прочие услуги — доля от выкупов (+ общие начисления без
//   артикула пропорционально);
//   реклама — фактический расход этого дня;
//   себестоимость — × ожидаемые выкупленные штуки; налог — % от выручки.
// Если по артикулу мало данных, коэффициент берётся по его категории,
// затем по родительской, затем по всему кабинету.
// ─────────────────────────────────────────────────────────────────────────

// Индексы в строке coefs (после ai).
const C = { sale: 1, saleQty: 2, comm: 3, logi: 4, acq: 5, storage: 6, promo: 7, other: 8, ord: 9, del: 10, canc: 11, pctFbo: 12, acqItem: 13, price: 14, cost: 15 };
const ROWS = [
  { block: 'Заказы', tone: 'rev' },
  { key: 'ordRub', label: 'Заказано, ₽', fmt: 'int', good: 'up' },
  { key: 'ordQty', label: 'Заказано, шт', fmt: 'int', good: 'up', sub: true },
  { key: 'buyout', label: 'Ожидаемый выкуп, %', fmt: 'pct', good: 'up' },
  { key: 'expRev', label: 'Ожидаемая выручка, ₽', fmt: 'int', good: 'up', strong: true },
  { block: 'Прогноз расходов', tone: 'spend' },
  { key: 'comm', label: 'Комиссия Ozon', fmt: 'money0', good: 'neutral', sub: true, signed: true },
  { key: 'logi', label: 'Логистика', fmt: 'money0', good: 'neutral', sub: true, signed: true },
  { key: 'acq', label: 'Эквайринг', fmt: 'money0', good: 'neutral', sub: true, signed: true },
  { key: 'other', label: 'Хранение и прочие услуги', fmt: 'money0', good: 'neutral', sub: true, signed: true },
  { key: 'ads', label: 'Реклама (факт за день)', fmt: 'money0', good: 'neutral', sub: true, signed: true },
  { key: 'cost', label: 'Себестоимость', fmt: 'money0', good: 'neutral', sub: true, signed: true },
  { key: 'tax', label: 'Налог', fmt: 'money0', good: 'neutral', sub: true, signed: true },
  { key: 'exp', label: 'Итого расходы', fmt: 'money0', good: 'neutral', signed: true, strong: true },
  { block: 'Прогноз результата', tone: 'conv' },
  { key: 'profit', label: 'Прогнозная прибыль, ₽', fmt: 'int', good: 'up', strong: true, signed: true },
  { key: 'margin', label: 'Маржа, %', fmt: 'pct', good: 'up', hint: 'Прибыль / ожидаемая выручка' },
  { key: 'perUnit', label: 'Прибыль на 1 выкуп, ₽', fmt: 'int', good: 'up' },
  { key: 'roi', label: 'ROI, %', fmt: 'pct', good: 'up', hint: 'Прибыль / себестоимость' },
  { key: 'drr', label: 'ДРР от заказов, %', fmt: 'pct', good: 'down' },
];
const METRICS = [
  { key: 'profit', label: 'Прогнозная прибыль, ₽', fmt: 'int', free: true },
  { key: 'margin', label: 'Маржа, %', fmt: 'pct', free: true },
  { key: 'ordRub', label: 'Заказано, ₽', fmt: 'int' },
  { key: 'expRev', label: 'Ожидаемая выручка, ₽', fmt: 'int' },
  { key: 'adsAbs', label: 'Реклама, ₽', fmt: 'int' },
  { key: 'drr', label: 'ДРР, %', fmt: 'pct', free: true },
];
const SUM_KEYS = ['ordRub', 'ordQty', 'expRev', 'expQty', 'comm', 'logi', 'acq', 'other', 'ads', 'cost', 'tax'];

export default function UnitEconomics({ cabinet }) {
  const today = dayjs().format('YYYY-MM-DD');
  const [dateFrom, setDateFrom] = useState(dayjs().subtract(13, 'day').format('YYYY-MM-DD'));
  const [dateTo, setDateTo] = useState(today);
  const [sales, setSales] = useState(null);
  const [coefs, setCoefs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState('');
  const [search, setSearch] = useState('');
  const [tax, setTax] = useTax(cabinet);
  const [showNames, setShowNames] = useState(false);
  const tip = useTip();

  const load = useCallback(() => {
    setLoading(true); setError(null);
    Promise.all([getSalesData(cabinet, { dateFrom, dateTo }), getFinanceCoefs(cabinet)])
      .then(([s, c]) => { setSales(s.data.data); setCoefs(c.data.data); })
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, [cabinet, dateFrom, dateTo]);
  useEffect(() => { load(); }, [load]);

  const cats = useCats(sales?.articles, sales?.order);
  const n = sales?.dates.length || 0;

  // Коэффициенты по артикулу с подстраховкой «категория → родитель → кабинет».
  const K = useMemo(() => {
    if (!sales || !coefs) return null;
    const byOffer = new Map(coefs.coefs.map(c => [coefs.articles[c[0]].o, c]));
    const W = 16;
    const groups = new Map(); // path → суммы
    const add = (key, c) => { let g = groups.get(key); if (!g) { g = new Float64Array(W); groups.set(key, g); } for (let i = 1; i < W; i++) if (i !== C.pctFbo && i !== C.acqItem && i !== C.price && i !== C.cost) g[i] += c[i] || 0; };
    for (const a of cats.arts) {
      const c = byOffer.get(a.o); if (!c) continue;
      add('', c);
      for (let d = 1; d <= a.parts.length; d++) add(a.parts.slice(0, d).join(SEP), c);
    }
    const noSkuOther = Object.entries(coefs.noSku || {}).filter(([b]) => !['sale', 'return'].includes(b)).reduce((s, [, v]) => s + v, 0);
    const generalRate = coefs.totalSale > 0 ? Math.max(0, -noSkuOther / coefs.totalSale) : 0;
    const chain = a => [byOffer.get(a.o), ...a.parts.map((_, d) => groups.get(a.parts.slice(0, a.parts.length - d).join(SEP))), groups.get('')].filter(Boolean);
    const pick = (list, ok, val) => { for (const g of list) if (ok(g)) return val(g); return null; };
    return cats.arts.map(a => {
      const L = chain(a), own = byOffer.get(a.o);
      const buyout = pick(L, g => g[C.del] + g[C.canc] >= 10, g => g[C.del] / (g[C.del] + g[C.canc])) ?? 0.8;
      const comm = pick(L, g => g[C.sale] > 0 && g[C.saleQty] >= 3 && g[C.comm] < 0, g => -g[C.comm] / g[C.sale])
        ?? (own && own[C.pctFbo] ? own[C.pctFbo] / 100 : null) ?? 0.2;
      const logi = pick(L, g => g[C.ord] >= 5 && g[C.logi] < 0, g => -g[C.logi] / g[C.ord]) ?? 0;
      const acq = pick(L, g => g[C.sale] > 0 && g[C.saleQty] >= 3, g => Math.max(0, -g[C.acq] / g[C.sale])) ?? 0.015;
      const other = (pick(L, g => g[C.sale] > 0 && g[C.saleQty] >= 3, g => Math.max(0, -(g[C.storage] + g[C.promo] + g[C.other]) / g[C.sale])) ?? 0) + generalRate;
      const ownLevel = own && own[C.del] + own[C.canc] >= 10;
      return { buyout, comm, logi, acq, other, cost: own && own[C.cost] ? own[C.cost] : null, ownLevel };
    });
  }, [sales, coefs, cats.arts]);

  // По артикулу: прогноз по дням.
  const per = useMemo(() => {
    if (!sales || !K) return [];
    const P = cats.arts.map(() => null);
    for (const r of sales.rows) {
      const ai = r[0], d = r[1];
      const ordRub = r[6] || 0, ordQty = r[5] || 0, ads = (r[7] || 0) + (r[8] || 0);
      if (!ordRub && !ordQty && !ads) continue;
      let x = P[ai];
      if (!x) { x = P[ai] = {}; for (const k of SUM_KEYS) x[k] = new Float64Array(n); }
      const k = K[ai];
      const expRev = ordRub * k.buyout, expQty = ordQty * k.buyout;
      x.ordRub[d] += ordRub; x.ordQty[d] += ordQty; x.expRev[d] += expRev; x.expQty[d] += expQty;
      x.comm[d] -= expRev * k.comm; x.logi[d] -= ordQty * k.logi; x.acq[d] -= expRev * k.acq; x.other[d] -= expRev * k.other;
      x.ads[d] -= ads; x.cost[d] -= k.cost ? expQty * k.cost : 0;
    }
    return P;
  }, [sales, K, cats.arts, n]);

  const q = search.trim().toLowerCase();
  const list = useMemo(() => ({ q, arts: cats.arts.filter(a => per[a.i] && inPath(a, sel) && matchQ(a, q)) }), [cats.arts, per, sel, q]);

  const calc = useCallback(items => {
    const v = {};
    for (const k of SUM_KEYS) v[k] = new Float64Array(n);
    let noCost = 0, noCostRub = 0;
    for (const a of items) {
      const x = per[a.i]; if (!x) continue;
      for (const k of SUM_KEYS) { const s = x[k], t = v[k]; for (let i = 0; i < n; i++) t[i] += s[i]; }
      if (!K[a.i].cost) { let s = 0; for (let i = 0; i < n; i++) s += x.ordRub[i]; if (s > 0) { noCost++; noCostRub += s; } }
    }
    const out = { ...v, buyout: [], exp: [], profit: [], margin: [], perUnit: [], roi: [], drr: [], adsAbs: [] };
    const tx = tax / 100;
    for (let i = 0; i < n; i++) {
      v.tax[i] = -v.expRev[i] * tx;
      const e = v.comm[i] + v.logi[i] + v.acq[i] + v.other[i] + v.ads[i] + v.cost[i] + v.tax[i];
      const p = v.expRev[i] + e;
      out.buyout.push(v.ordRub[i] > 0 ? v.expRev[i] / v.ordRub[i] * 100 : null);
      out.exp.push(e); out.profit.push(p); out.margin.push(v.expRev[i] > 0 ? p / v.expRev[i] * 100 : null);
      out.perUnit.push(v.expQty[i] > 0 ? p / v.expQty[i] : null); out.roi.push(v.cost[i] < 0 ? p / -v.cost[i] * 100 : null);
      out.drr.push(v.ordRub[i] > 0 ? -v.ads[i] / v.ordRub[i] * 100 : null); out.adsAbs.push(-v.ads[i]);
    }
    const sum = arr => { let s = 0; for (let i = 0; i < n; i++) s += arr[i] || 0; return s; };
    const T = {};
    for (const k of [...SUM_KEYS, 'exp', 'profit', 'adsAbs']) T[k] = sum(out[k]);
    T.buyout = T.ordRub > 0 ? T.expRev / T.ordRub * 100 : null;
    T.margin = T.expRev > 0 ? T.profit / T.expRev * 100 : null;
    T.perUnit = T.expQty > 0 ? T.profit / T.expQty : null;
    T.roi = T.cost < 0 ? T.profit / -T.cost * 100 : null;
    T.drr = T.ordRub > 0 ? -T.ads / T.ordRub * 100 : null;
    return { vals: out, totals: T, noCost, noCostRub };
  }, [per, n, K, tax]);

  const main = useMemo(() => (K ? calc(list.arts) : null), [K, calc, list]);
  const aggOf = useCallback(items => {
    const { totals: t } = calc(items);
    return {
      ordRub: t.ordRub, buyout: t.buyout, expRev: t.expRev,
      commPct: t.expRev > 0 ? -t.comm / t.expRev * 100 : null, logiUnit: t.ordQty > 0 ? -t.logi / t.ordQty : null,
      ads: 0 - t.ads, cost: 0 - t.cost, profit: t.profit, margin: t.margin, perUnit: t.perUnit,
    };
  }, [calc]);

  if (loading && !sales) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Загрузка…</div></div>;
  if (error && !sales) return <div className="mpui"><div className="a-empty" style={{ textAlign: 'center', padding: 60 }}>Не удалось загрузить: {error} <button className="a-btn" onClick={load}>Повторить</button></div></div>;

  const dates = sales.dates;
  const { vals, totals: T, noCost, noCostRub } = main;
  const byDate = {};
  dates.forEach((d, i) => { byDate[d] = {}; for (const m of METRICS) byDate[d][m.key] = vals[m.key][i]; });
  const finMissing = !coefs.coefs.some(c => c[C.sale] !== 0 || c[C.comm] !== 0);
  const buyMissing = !coefs.coefs.some(c => c[C.del] + c[C.canc] > 0);

  // Средние коэффициенты выбранного (взвешенные по заказам).
  const w = (() => {
    let ord = 0, q2 = 0, b = 0, cm = 0, lg = 0, ac = 0, ot = 0, cs = 0, csq = 0, own = 0;
    for (const a of list.arts) {
      const x = per[a.i], k = K[a.i];
      let r = 0, qq = 0; for (let i = 0; i < n; i++) { r += x.ordRub[i]; qq += x.ordQty[i]; }
      ord += r; q2 += qq; b += r * k.buyout; cm += r * k.comm; ac += r * k.acq; ot += r * k.other; lg += qq * k.logi;
      if (k.cost) { cs += qq * k.cost; csq += qq; }
      if (k.ownLevel) own += r;
    }
    return ord > 0 ? { buyout: b / ord * 100, comm: cm / ord * 100, acq: ac / ord * 100, other: ot / ord * 100, logi: q2 ? lg / q2 : null, cost: csq ? cs / csq : null, check: q2 ? ord / q2 : null, own: own / ord * 100 } : null;
  })();

  const cols = [
    { key: 'ordRub', label: 'Заказано', fmt: 'int' },
    { key: 'buyout', label: 'Выкуп', fmt: 'pct' },
    { key: 'expRev', label: 'Ожид. выручка', fmt: 'int' },
    { key: 'commPct', label: 'Комиссия', fmt: 'pct' },
    { key: 'logiUnit', label: 'Логистика / шт', fmt: 'int' },
    { key: 'ads', label: 'Реклама', fmt: 'int' },
    { key: 'cost', label: 'Себестоимость', fmt: 'int' },
    { key: 'profit', label: 'Прибыль', fmt: 'int' },
    { key: 'margin', label: 'Маржа', fmt: 'pct' },
    { key: 'perUnit', label: 'На 1 выкуп', fmt: 'int' },
  ];
  const todayIdx = dates.indexOf(today);

  return (
    <div className="mpui sa-page">
      <FinHeader title="Юнит-экономика" cats={cats} sel={sel} setSel={setSel} search={search} setSearch={setSearch}
        dateFrom={dateFrom} dateTo={dateTo} setRange={(f, t) => { setDateFrom(f); setDateTo(t); }} loading={loading}>
        <TaxInput tax={tax} setTax={setTax} />
      </FinHeader>

      {(finMissing || buyMissing) && (
        <Empty>
          <b>Для точного прогноза не хватает данных{finMissing && buyMissing ? ' о финансах и выкупе' : finMissing ? ' о финансах' : ' о выкупе'}.</b><br />
          Пока считаем по запасным значениям (выкуп 80%, комиссия из карточки или 20%, эквайринг 1,5%, логистика 0).
          Запустите в Google-скрипте {finMissing && <><code>syncFinanceFull</code> </>}{buyMissing && <><code>syncGeoFull</code> </>}— через час коэффициенты станут фактическими.
        </Empty>
      )}

      <div className={`a-kpis s-kpis ${loading ? 'a-loading' : ''}`}>
        <Kpi label={todayIdx >= 0 ? 'Прибыль от заказов сегодня' : 'Прибыль за последний день'} value={<span className={(vals.profit[todayIdx >= 0 ? todayIdx : n - 1] || 0) < 0 ? 's-down' : ''}>{money(vals.profit[todayIdx >= 0 ? todayIdx : n - 1])}</span>}
          sub={`заказано ${money(vals.ordRub[todayIdx >= 0 ? todayIdx : n - 1])}, маржа ${pct1(vals.margin[todayIdx >= 0 ? todayIdx : n - 1])}`} />
        <Kpi label="Прогнозная прибыль за период" value={<span className={T.profit < 0 ? 's-down' : ''}>{money(T.profit)}</span>} sub={`маржа ${pct1(T.margin)} · ROI ${pct1(T.roi)}`} />
        <Kpi label="Ожидаемая выручка" value={money(T.expRev)} sub={`выкуп ${pct1(T.buyout)} от ${money(T.ordRub)}`} />
        <Kpi label="Прибыль на 1 выкуп" value={money(T.perUnit)} sub={w?.check ? `средний чек ${fmtInt(w.check)} ₽` : ''} />
      </div>
      {noCost > 0 && <div className="c-msg bad">У {noCost} арт. ({pct1(T.ordRub ? noCostRub / T.ordRub * 100 : null)} заказов) нет себестоимости — прибыль по ним завышена. Заполните во вкладке «Себестоимость».</div>}

      <div className={`a-card s-card ${loading ? 'a-loading' : ''}`}>
        <DualChart dates={dates} byDate={byDate} tip={tip} events={[]} metricsList={METRICS} storeKey="mp-unit-chart" defaults={{ left: 'ordRub', right: 'profit', type: 'combo' }} />
      </div>

      <div className="a-card">
        <div className="a-bar" style={{ padding: '12px 14px 8px' }}>
          <b style={{ fontSize: 14 }}>Прогноз по дням заказа</b>
          <span className="a-hint">средние коэффициенты за 30 дней{coefs.since ? ` (с ${dayjs(coefs.since).format('DD.MM')})` : ''}, реклама — факт дня</span>
        </div>
        <RowsTable dates={dates} rows={ROWS} vals={vals} totals={T} />
      </div>

      {w && (
        <div className="a-card s-card">
          <div className="a-bar" style={{ marginBottom: 8 }}>
            <b style={{ fontSize: 14 }}>Средние коэффициенты выбранного</b>
            <span className="a-hint">взвешены по заказам; по собственной истории артикула — {pct1(w.own)} заказов, остальное — по категории</span>
          </div>
          <div className="s-abc">
            {[['Выкуп', pct1(w.buyout)], ['Комиссия', pct1(w.comm)], ['Логистика на 1 заказ', w.logi !== null ? `${fmtMoney2(w.logi)} ₽` : '—'],
              ['Эквайринг', pct1(w.acq)], ['Хранение и прочее', pct1(w.other)], ['Себестоимость 1 шт', w.cost ? `${fmtInt(w.cost)} ₽` : '—'], ['Налог', pct1(tax)]].map(([l, v]) => (
              <div key={l} className="s-abc-i"><span className="muted">{l}</span><b className="n">{v}</b></div>
            ))}
          </div>
          <button type="button" className="a-btn" onClick={() => setShowNames(s => !s)}>{showNames ? 'Скрыть' : 'Показать'} статьи Ozon за 30 дней ({coefs.names.length})</button>
          {showNames && (
            <table className="a-t s-slice" style={{ marginTop: 10 }}>
              <thead><tr><th>Статья в отчёте Ozon</th><th>Куда относим</th><th className="r">Сумма за 30 дней</th></tr></thead>
              <tbody>{coefs.names.map(([nm, b, a]) => <tr key={nm}><td>{nm}</td><td className="muted">{({ sale: 'Выкупы', return: 'Возвраты', commission: 'Комиссия', acquiring: 'Эквайринг', logistics: 'Логистика', storage: 'Хранение', promo: 'Баллы/продвижение', other: 'Прочее' })[b] || b}</td><td className="n r">{fmtInt(a)}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      )}

      <CatTable cats={cats} sel={sel} setSel={setSel} list={list} cols={cols} aggOf={aggOf} sortKey="ordRub" />
      {tip.node}
    </div>
  );
}
