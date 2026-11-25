import { isWbCabinet } from '../lib/cabinets';
import CategoryNav from '../components/CategoryNav';
import QuickPeriods from '../components/QuickPeriods';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import dayjs from 'dayjs';
import { getOrderFeed, setSelfBuyout, getFinancePnl, getFinanceCoefs, latestOnly } from '../api';
import DateRangePicker from '../components/DateRangePicker';
import ArtSearch, { artFilter } from '../components/ArtSearch';
import { fmtInt } from './AdsStats2';
import { C, unitCoefs, unitProfit } from './unitModel';
import { buildBuyoutsFeed } from '../lib/buyoutsFeed';
import { useBuyerShare, useTax } from './finShared';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// «Лента заказов» — все отправления Ozon по мере поступления (их каждые
// 5 минут кладёт во вкладку Orders Google-скрипт, сервис копит их в базе).
// Здесь же отмечаются самовыкупы: такие заказы не считаются в заказах
// («Аналитика продаж», РНП, «Реклама»), а в деньгах за них не вычитается
// себестоимость — товар остаётся у нас.
// ─────────────────────────────────────────────────────────────────────────

const ST = { sold:'выкуп', sold_returned:'выкупы и возвраты', charges:'удержания / корректировки', ordered:'заказан', returned:'возврат',
  awaiting_packaging: 'ожидает сборки', awaiting_deliver: 'ожидает отгрузки', delivering: 'доставляется', driver_pickup: 'у водителя',
  delivered: 'доставлен', cancelled: 'отменён', awaiting_registration: 'регистрация', acceptance_in_progress: 'приёмка', not_accepted: 'не принят',
  arbitration: 'спор', client_arbitration: 'спор', awaiting_approve: 'ожидает подтверждения', sent_by_seller: 'отправлен продавцом',
};
const msk = iso => dayjs(new Date(Date.parse(iso) + 3 * 3600e3).toISOString().slice(0, 19));

const PROFIT_LABEL = 'Прогнозируемая прибыль с выкупа';
const PROFIT_HINT = 'Прибыль на одну ожидаемую выкупленную штуку по цене заказа. Учитывает себестоимость, комиссию, логистику, налог и долю расходов на рекламу из финансовой истории.';

const PAYOUT_LABEL = 'Среднее поступление с выкупа (прогноз)';
const ACTUAL_PAYOUT_LABEL = 'Ср. поступление с выкупа (факт)';
const ACTUAL_PAYOUT_HINT = 'Выручка за вычетом возвратов, фактической комиссии, логистики, эквайринга, прочих удержаний и рекламы за день. Сумма делится на число выкупов за вычетом возвратов.';
const PAYOUT_HINT = 'Ожидаемое поступление на счёт на одну выкупленную штуку после удержаний площадки и расходов на рекламу.';

function ForecastCard({ label, hint, metric, eligible }) {
  const value = metric.buyouts > 0 ? metric.total / metric.buyouts : null;
  return <div className="a-kpi" title={hint}>
    <span className="lbl">{label}</span>
    <span className={`val ${value < 0 ? 's-down' : ''}`}>{value == null ? '—' : `${fmtInt(value)} ₽`}</span>
    <span className="sub">{metric.count === 0
      ? 'Нет данных для прогноза'
      : metric.count < eligible
        ? `На 1 шт. · рассчитано для ${fmtInt(metric.count)} из ${fmtInt(eligible)} строк`
        : 'На 1 выкупленную штуку · по фильтрам'}</span>
  </div>;
}

export default function OrdersFeed({ cabinet }) {
  const today = dayjs().format('YYYY-MM-DD');
  const [kind, setKind] = useState('orders');
  const [from, setFrom] = useState(dayjs().subtract(29,'day').format('YYYY-MM-DD'));
  const [to, setTo] = useState(today);
  const [payload, setPayload] = useState(null);
  const isBuyouts = kind === 'sales';
  const isOrders = kind === 'orders';
  const data = payload?.kind === kind && payload?.cabinet === cabinet && payload.from === from && payload.to === to ? payload.data : null;
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [view, setView] = useState('all'); // all | self | real
  const [hideCancel, setHideCancel] = useState(true);
  const [picked, setPicked] = useState(new Set());
  const [limit, setLimit] = useState(200);
  const [pMin, setPMin] = useState('');
  const [pMax, setPMax] = useState('');
  const [cat, setCat] = useState(''); // путь категории: «Чехлы», «Чехлы / Чехлы на сиденья»…

  const load = useCallback(() => {
    const latest = latestOnly('orders-feed');
    setErr('');
    const request = isBuyouts
      ? getFinancePnl(cabinet, { dateFrom: from, dateTo: to, adsBasis: isWbCabinet(cabinet) ? 'activity' : undefined })
      : getOrderFeed(cabinet, from, to, isWbCabinet(cabinet) ? kind : undefined);
    return request.then(latest(r => setPayload({ cabinet, kind, from, to, data: r.data.data })))
      .catch(latest(e => setErr(e.response?.data?.error || e.message)));
  }, [cabinet, from, to, kind, isBuyouts]);
  useEffect(() => { setPayload(null); setPicked(new Set()); load(); }, [load]);
  // Свежие заказы — обновление раз в минуту, пока вкладка открыта.
  useEffect(() => { const t = setInterval(() => { if (!document.hidden) load(); }, 60000); return () => clearInterval(t); }, [load]);

  const [finance, setFinance] = useState(null);
  const [tax] = useTax(cabinet);
  useEffect(() => {
    if (!isOrders) return undefined;
    let current = true;
    getFinanceCoefs(cabinet).then(r => {
      if (current) setFinance({ cabinet, data: r.data.data });
    }).catch(() => {});
    return () => { current = false; };
  }, [cabinet, isOrders]);
  const coefficients = finance?.cabinet === cabinet ? finance.data : null;
  const articles = useMemo(() => ((isBuyouts ? data?.articles : coefficients?.articles) || []).map(a => ({
    o: a.o, parts: String(a.cat || '').split(' / ').filter(Boolean),
  })), [isBuyouts, data?.articles, coefficients]);
  const { shareOf, shareAt } = useBuyerShare(cabinet, articles);
  const d = useMemo(() => data && (isBuyouts ? buildBuyoutsFeed(data, tax, shareAt) : data), [data, isBuyouts, tax, shareAt]);
  const key = r => isBuyouts ? `${r.date}|${r.o}` : `${r.p}|${r.sku}`;
  const inCat = x => !cat || x.cat === cat || String(x.cat || '').startsWith(cat + ' / ');
  const catRows = useMemo(() => (d?.rows || []).filter(inCat), [d, cat]); // eslint-disable-line react-hooks/exhaustive-deps
  // Категории: верхний уровень — вкладками, глубже — списком подкатегорий выбранной.
  const cats = useMemo(() => {
    const top = new Map(), sub = new Map();
    for (const x of d?.rows || []) {
      if (x.st === 'cancelled') continue;
      const parts = String(x.cat || 'Без категории').split(' / ');
      top.set(parts[0], (top.get(parts[0]) || 0) + x.qty);
      for (let i = 2; i <= parts.length; i++) { const k = parts.slice(0, i).join(' / '); sub.set(k, (sub.get(k) || 0) + x.qty); }
    }
    return { top: [...top.entries()].sort((a, b) => (b[0] === 'Чехлы') - (a[0] === 'Чехлы') || b[1] - a[1]), sub }; // «Чехлы» — первыми
  }, [d]);
  const catTop = cat ? cat.split(' / ')[0] : '';
  const subs = useMemo(() => [...cats.sub.entries()].filter(([k]) => catTop && k.startsWith(catTop + ' / ')).sort((a, b) => (a[0] < b[0] ? -1 : 1)), [cats, catTop]);
  const rows = useMemo(() => {
    let r = catRows;
    if (hideCancel) r = r.filter(x => x.st !== 'cancelled');
    if (isOrders && view !== 'all') r = r.filter(x => view === 'self' ? x.self : !x.self);
    // Цена за штуку «от — до» — например, найти самовыкуп по низкой цене.
    const lo = parseFloat(String(pMin).replace(/\s/g, '').replace(',', '.')), hi = parseFloat(String(pMax).replace(/\s/g, '').replace(',', '.'));
    if (Number.isFinite(lo)) r = r.filter(x => x.price != null && x.price >= lo);
    if (Number.isFinite(hi)) r = r.filter(x => x.price != null && x.price <= hi);
    return q.trim() ? artFilter(r, q, x => x.o || '', x => `${x.n || ''} ${x.p || ''}`) : r;
  }, [catRows, q, view, hideCancel, pMin, pMax, isOrders]);
  const profitModel = useMemo(() => {
    if (!coefficients?.coefs?.length || coefficients._metadataOnly) return new Map();
    const units = unitCoefs(coefficients, articles, shareOf);
    const adRates = new Map(coefficients.coefs.map(c => [
      c[0], c[C.sale] > 0 ? Math.max(0, -(c[C.ads] || 0) / c[C.sale]) : 0,
    ]));
    return new Map(articles.map((a, i) => [a.o, { unit: units[i], adRate: adRates.get(i) || 0 }]));
  }, [coefficients, articles, shareOf]);
  const forecast = useMemo(() => {
    const perRow = new Map();
    const payout = { total: 0, buyouts: 0, count: 0 };
    const profit = { total: 0, buyouts: 0, count: 0 };
    let eligible = 0;
    for (const row of rows) {
      if (!isOrders || row.self || row.st === 'cancelled' || row.st === 'returned') continue;
      eligible++;
      const model = profitModel.get(row.o);
      if (!model || !(row.price > 0) || !(row.qty > 0)) continue;
      const ordRub = row.price * row.qty;
      const scheme = String(row.sch || '').toLowerCase();
      const fbs = scheme === 'fbs' || scheme === 'rfbs' ? 1 : scheme === 'fbo' ? 0 : undefined;
      const ads = ordRub * model.unit.buyout * model.adRate;
      const result = unitProfit(model.unit, { ordRub, ordQty: row.qty, fbs, ads }, tax);
      if (!(result.expQty > 0) || !Number.isFinite(result.payout)) continue;
      const values = { payout: result.payout / result.expQty, profit: null };
      payout.total += result.payout;
      payout.buyouts += result.expQty;
      payout.count++;
      if (model.unit.cost && Number.isFinite(result.profit)) {
        values.profit = result.profit / result.expQty;
        profit.total += result.profit;
        profit.buyouts += result.expQty;
        profit.count++;
      }
      perRow.set(row, values);
    }
    return { perRow, payout, profit, eligible };
  }, [rows, profitModel, tax, isOrders]);
  const sum = useMemo(() => {
    const all = catRows.filter(x => x.st !== 'cancelled');
    const s = { n: 0, q: 0, r: 0, sn: 0, sq: 0, sr: 0, c: catRows.length - all.length };
    for (const x of all) { const v = x.price == null ? NaN : x.price * x.qty; if (x.self) { s.sn++; s.sq += x.qty; s.sr += v; } else { s.n++; s.q += x.qty; s.r += v; } }
    if(d?._wb && !d.available) for(const k of Object.keys(s))s[k]=NaN;
    return s;
  }, [catRows,d]);
  const actual = useMemo(() => {
    if (!isBuyouts) return null;
    return rows.reduce((total, row) => {
      total.qty += row.qty;
      total.sold += row.sold;
      total.saleRub += row.saleRub;
      total.revenue += row.revenue || 0;
      if (Number.isFinite(row.payout)) {
        total.payout += row.payout;
        total.payoutQty += row.qty;
      }
      total.profit += row.profit ?? 0;
      total.hasPayout ||= Number.isFinite(row.payout);
      total.hasProfit ||= Number.isFinite(row.profit);
      total.missingProfit ||= Number.isFinite(row.payout) && row.profit == null;
      return total;
    }, { qty: 0, sold: 0, saleRub: 0, revenue: 0, payout: 0, payoutQty: 0, profit: 0, hasPayout: false, hasProfit: false, missingProfit: false });
  }, [rows, isBuyouts]);
  const opts = useMemo(() => { const m = new Map(); for (const x of d?.rows || []) if (x.o && !m.has(x.o)) m.set(x.o, { o: x.o, n: x.n }); return [...m.values()]; }, [d]);

  const mark = async (items, on) => {
    setBusy(true);
    try {
      await setSelfBuyout(cabinet, items.map(x => ({ p: x.p, sku: x.sku })), on);
      setPayload(cur => cur?.kind === 'orders' && cur.cabinet === cabinet
        ? { ...cur, data: { ...cur.data, rows: cur.data.rows.map(x => (items.some(y => key(y) === key(x)) ? { ...x, self: on } : x)) } }
        : cur);
      setPicked(new Set());
    } catch (e) { setErr(e.response?.data?.error || e.message); } finally { setBusy(false); }
  };
  const pickedRows = rows.filter(x => picked.has(key(x)));
  const toggle = x => setPicked(s => { const n = new Set(s); if (n.has(key(x))) n.delete(key(x)); else n.add(key(x)); return n; });
  const modes = [['orders', 'Заказы'], ['sales', 'Выкупы']];
  if (isWbCabinet(cabinet)) modes.push(['returns', 'Возвраты']);
  const changeKind = next => {
    setKind(next);
    setLimit(200);
    setPicked(new Set());
    setQ('');
    setCat('');
  };
  const colSpan = isOrders ? 10 : 9;

  // Разделители по дням.
  let lastDay = '';
  const shown = rows.slice(0, limit);

  return (
    <div className="mpui">
      <div className="page-sticky">
        <div className="a-top">
          <h1>Лента заказов</h1>
          <span className="a-seg" aria-label="Раздел ленты">{modes.map(([mode, label]) =>
            <button type="button" key={mode} className={kind === mode ? 'on' : ''} aria-pressed={kind === mode}
              onClick={() => changeKind(mode)}>{label}</button>)}</span>
          <ArtSearch value={q} onChange={setQ} options={opts} placeholder={isBuyouts ? 'Артикул или название' : 'Артикул, название или номер отправления'} style={{ minWidth: 260 }} />
          <QuickPeriods from={from} to={to} onChange={(f,t)=>{setFrom(f);setTo(t);}} />
          <DateRangePicker from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
        </div>
      </div>
      {err && <div className="c-msg bad" style={{ margin: '10px 0' }}>{err}</div>}
      {!d && !err && <div className="a-empty" style={{ padding: 40, textAlign: 'center' }}>Загрузка…</div>}
      {d && (
        <>
          <CategoryNav tops={cats.top.map(([k])=>k)} value={cat} onChange={setCat} childrenOf={path=>[...new Set([...cats.sub.keys()].filter(k=>k.startsWith(path+' / ')&&k.split(' / ').length===path.split(' / ').length+1).map(k=>k.split(' / ').at(-1)))]} />
          {isOrders && <div className="cl-kpis of-kpis">
            <div className="a-kpi"><span className="lbl">Заказы</span><span className="val">{fmtInt(sum.n)}</span><span className="sub">{fmtInt(sum.q)} шт · {fmtInt(sum.r)} ₽</span></div>
            <div className="a-kpi"><span className="lbl">Самовыкупы</span><span className="val" style={{ color: sum.sn ? 'var(--a-accent)' : undefined }}>{fmtInt(sum.sn)}</span><span className="sub">{fmtInt(sum.sq)} шт · {fmtInt(sum.sr)} ₽ — не в заказах</span></div>
            <div className="a-kpi"><span className="lbl">Средний чек</span><span className="val">{sum.q ? fmtInt(sum.r / sum.q) : '—'}</span><span className="sub">без самовыкупов, ₽ за шт</span></div>
            <div className="a-kpi"><span className="lbl">Отменено</span><span className="val">{fmtInt(sum.c)}</span><span className="sub">за период</span></div>
            <ForecastCard label={PAYOUT_LABEL} hint={PAYOUT_HINT} metric={forecast.payout} eligible={forecast.eligible} />
            <ForecastCard label={PROFIT_LABEL} hint={PROFIT_HINT} metric={forecast.profit} eligible={forecast.eligible} />
          </div>}
          {isBuyouts && <div className="cl-kpis of-kpis">
            {[
              ['Выкупы за вычетом возвратов, шт', actual.qty],
              ['Выкупы, ₽', actual.revenue],
              ['Средняя цена выкупа, ₽', actual.sold > 0 ? actual.saleRub / actual.sold : null],
              [`${ACTUAL_PAYOUT_LABEL}, ₽`, actual.hasPayout && actual.payoutQty > 0 ? actual.payout / actual.payoutQty : null],
              ['Фактическая прибыль, ₽', actual.hasProfit && !actual.missingProfit ? actual.profit : null],
            ].map(([label, value]) => <div key={label} className="a-kpi" title={label.startsWith(ACTUAL_PAYOUT_LABEL) ? ACTUAL_PAYOUT_HINT : undefined}>
              <span className="lbl">{label}</span>
              <span className={`val ${value < 0 ? 's-down' : ''}`}>{fmtInt(value)}</span>
              {label === 'Фактическая прибыль, ₽' && actual.missingProfit && <span className="sub">Не заполнена себестоимость</span>}
            </div>)}
          </div>}
          <div className="a-bar" style={{ gap: 8, flexWrap: 'wrap', margin: '12px 0 8px' }}>
            {isOrders && <><span className="a-seg">{[['all', 'Все'], ['real', 'Заказы'], ['self', `Самовыкупы (${fmtInt(sum.sn)})`]].map(([k, t]) => <button key={k} type="button" className={view === k ? 'on' : ''} onClick={() => setView(k)}>{t}</button>)}</span>
            <button type="button" className="a-toggle" onClick={() => setHideCancel(v => !v)}><span className={`a-sw ${hideCancel ? 'on' : ''}`} />Скрыть отменённые</button></>}
            <span className="of-price" title="Цена за штуку">
              Цена <input inputMode="numeric" value={pMin} onChange={e => setPMin(e.target.value)} placeholder="от" />
              — <input inputMode="numeric" value={pMax} onChange={e => setPMax(e.target.value)} placeholder="до" /> ₽
              {(pMin || pMax) && <button type="button" className="of-x" onClick={() => { setPMin(''); setPMax(''); }} title="Сбросить">×</button>}
            </span>
            {isOrders && pickedRows.length > 0 && (
              <span className="of-bulk">
                Выбрано {pickedRows.length}:
                <button type="button" className="a-btn" disabled={busy || kind !== 'orders'} onClick={() => mark(pickedRows, true)}>Отметить самовыкупом</button>
                <button type="button" className="a-btn ghost" disabled={busy || kind !== 'orders'} onClick={() => mark(pickedRows, false)}>снять отметку</button>
                <button type="button" className="a-btn ghost" onClick={() => setPicked(new Set())}>сбросить выбор</button>
              </span>
            )}
            <span className="a-hint" style={{ margin: '0 0 0 auto' }}>
              {isBuyouts ? (
                d.operational ? 'Финансовый отчёт пока недоступен' : `По дню и артикулу · реклама по дням${d.through ? ` · начисления по ${dayjs(d.through).format('DD.MM.YYYY')}` : ''}`
              ) : `обновляется раз в минуту${d.since ? ` · лента копится с ${msk(d.since).format('DD.MM.YYYY')}` : ''}`}
            </span>
          </div>
          <div className="a-card" style={{ padding: 0 }}>
            <div className="a-scroll">
              <table className="a-t of-t">
                <thead><tr>
                  {isOrders && <th style={{ width: 30 }}><input type="checkbox" checked={shown.length > 0 && shown.every(x => picked.has(key(x)))} onChange={e => setPicked(e.target.checked ? new Set(shown.map(key)) : new Set())} title="Выбрать все показанные" /></th>}
                  <th className="l">{isBuyouts ? 'Дата' : 'Время'}</th>
                  <th className="l">Артикул</th>
                  <th className="r" title={isBuyouts ? 'За вычетом возвратов' : undefined}>Кол-во</th>
                  <th className="r">{isBuyouts ? 'Цена выкупа за шт.' : 'Цена'}</th>
                  <th className="r of-profit" title={isBuyouts ? ACTUAL_PAYOUT_HINT : PAYOUT_HINT}>{isBuyouts ? ACTUAL_PAYOUT_LABEL : PAYOUT_LABEL}, ₽</th>
                  <th className="r of-profit" title={isBuyouts ? 'Начисления после рекламы минус себестоимость и налог' : PROFIT_HINT}>{isBuyouts ? 'Фактическая прибыль' : PROFIT_LABEL}, ₽</th>
                  <th className="l">Схема · склад</th>
                  <th className="l">Статус</th>
                  <th className="l" title="Самовыкуп не считается в заказах, а себестоимость за него не вычитается">Самовыкуп</th>
                </tr></thead>
                <tbody>
                  {!shown.length && <tr><td colSpan={colSpan} className="muted" style={{ padding: 16, textAlign: 'center' }}>{isBuyouts ? 'Нет выкупов и начислений' : kind === 'returns' ? 'Возвратов нет' : 'Заказов нет'}</td></tr>}
                  {shown.map(x => {
                    const t = x.at ? msk(x.at) : null;
                    const day = t ? t.format('YYYY-MM-DD') : x.date || ''; const dateLabel=t || (x.date ? dayjs(x.date):null);
                    const { payout: forecastPayout, profit } = isBuyouts ? x : (forecast.perRow.get(x) || {});
                    const payout = isBuyouts ? x.payoutPerBuyout : forecastPayout;
                    const payoutDetail = isBuyouts && payout != null
                      ? `Выручка после возвратов ${fmtInt(x.revenue)} ₽ · удержания площадки ${fmtInt(x.fees)} ₽ · реклама ${fmtInt(x.ads)} ₽ · выкупов ${fmtInt(x.qty)} шт.`
                      : undefined;
                    const sep = day !== lastDay ? (lastDay = day, true) : false;
                    return (
                      <React.Fragment key={key(x)}>
                        {sep && rows.length && <tr className="of-day"><td colSpan={colSpan}>{dateLabel ? dateLabel.format('dddd, D MMMM').replace(/^./, c => c.toUpperCase()) : '—'}</td></tr>}
                        <tr className={`${x.self ? 'of-self' : ''} ${x.st === 'cancelled' ? 'of-cancel' : ''} ${picked.has(key(x)) ? 'pr-in-order' : ''}`}>
                          {isOrders && <td><input type="checkbox" checked={picked.has(key(x))} onChange={() => toggle(x)} /></td>}
                          <td className="l n">{isBuyouts ? dateLabel?.format('DD.MM') : t ? t.format('HH:mm') : '—'}<small className="of-sub">{x.p}</small></td>
                          <td className="l"><div className="a-art"><div style={{ minWidth: 0 }}><div className="id">{x.o || x.sku}</div><div className="model" title={x.n}>{x.n}</div><div className="of-cat">{String(x.cat || '').split(' / ').slice(-1)[0]}</div></div></div></td>
                          <td className="n r">{x.qty}</td>
                          <td className="n r" title={x.est ? 'Ozon не передал цену в заказе — показана цена продавца на день заказа из истории цен' : undefined}>{x.est ? '≈' : ''}{fmtInt(x.price)}</td>
                          <td className={`n r ${payout < 0 ? 's-down' : ''}`} title={payoutDetail}><b>{fmtInt(payout)}</b></td>
                          <td className={`n r ${profit < 0 ? 's-down' : ''}`}><b>{fmtInt(profit)}</b></td>
                          <td className="l"><span className="of-sch">{x.sch ? String(x.sch).toUpperCase() : '—'}</span> <span className="muted">{x.wh}</span></td>
                          <td className="l">{ST[x.st] || x.st || '—'}</td>
                          <td className="l">
                            {isOrders ? <button type="button" className={`of-self-btn ${x.self ? 'on' : ''}`} disabled={busy || kind !== 'orders'} onClick={() => mark([x], !x.self)}
                              title={x.self ? 'Снять отметку — заказ снова будет считаться обычным' : 'Отметить самовыкупом'}>{x.self ? 'самовыкуп ✓' : 'отметить'}</button> : isBuyouts ? (x.selfQty ? `${x.selfQty} шт.` : '—') : (x.self ? '✓' : '—')}
                          </td>
                        </tr>
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rows.length > limit && <button type="button" className="s-fold" onClick={() => setLimit(l => l + 300)}>Показать ещё {Math.min(300, rows.length - limit)} из {rows.length - limit} ▼</button>}
          </div>
        </>
      )}
    </div>
  );
}
